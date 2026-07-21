import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { requireAdmin, requireUser } from "../auth.js";
import { db } from "../db/client.js";
import {
  accountTransactions,
  accounts,
  auditLogs,
  labourAdvanceApplications,
  labourAccountingEntries,
  labourDueAttendanceSources,
  labourDueMemberSnapshots,
  labourDues,
  labourPaymentAllocations,
  labourPaymentVouchers,
  labourWageSettlementCreateRequests,
  operationalRecords,
  userSessions,
} from "../db/schema.js";
import {
  allocateLabourDueNumber,
  allocateLabourAdvanceVoucherNumber,
  allocateLabourAdvanceAdjustmentNumber,
  allocateLabourPaymentVoucherNumber,
  calculateLabourAdvancePool,
  calculateAdvancePosition,
  labourFinancialScopeKey,
  loadLabourDuePosition,
  postLabourAdvanceApplicationJournal,
  postLabourAdvanceApplicationJournals,
  postLabourDueRecognition,
  postLabourVoucherJournal,
  refreshLabourDuePaymentStatus,
  reverseLabourJournal,
  type LabourRecipientScope,
} from "../lib/labour-payments.js";
import { previewLabourWageSettlement, resolveCanonicalPaymentAccountId } from "../lib/labour-wage-settlements.js";
import { isLabourSelectableForAdvance } from "../lib/labour-eligibility.js";
import { validateLabourSettlementPaymentAccount } from "../lib/labour-settlement-account-validation.js";
import { hasModulePermission } from "../permissions.js";
import { validateTenantReferences } from "../tenant-ownership.js";
import { hasFarmAccess } from "../workspace-access.js";
import { parseSarMinorUnits, sarFromMinorUnits } from "../lib/money.js";
import { reconcileLabourFinancialScope } from "../lib/labour-financial-reconciliation.js";
import { loadLabourFinancialReadModel } from "../lib/labour-financial-read-model.js";

const firstText = (...values: unknown[]) => {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
};

const asSnapshot = (value: unknown) => (value && typeof value === "object" ? value as Record<string, unknown> : {});

const paramsSchema = z.object({ workspaceId: z.string().uuid() });
const dueParamsSchema = paramsSchema.extend({ dueId: z.string().uuid() });
const voucherParamsSchema = paramsSchema.extend({
  voucherId: z.string().uuid(),
});
const advanceApplicationParamsSchema = dueParamsSchema.extend({
  applicationId: z.string().uuid(),
});
const advanceApplicationEventParamsSchema = paramsSchema.extend({
  eventId: z.string().uuid(),
});
const contextSchema = z.object({
  farmId: z.string().uuid(),
  seasonId: z.string().uuid(),
});
const advancePoolQuerySchema = contextSchema.extend({
  amount: z.coerce.number().min(0).optional(),
  settlementDate: z.string().date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
const advanceListQuerySchema = contextSchema.extend({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(160).optional(),
  recipientScope: z
    .enum([
      "INDIVIDUAL",
      "LABOUR_GROUP",
      "CONTRACTOR_FOREMAN",
      "TEMPORARY_CREW",
      "UNREGISTERED_LABOUR",
      "NO_SPECIFIC_RECIPIENT",
    ])
    .optional(),
  status: z
    .enum([
      "OPEN",
      "OUTSTANDING",
      "PARTIALLY_APPLIED",
      "PARTIALLY_REFUNDED",
      "FULLY_APPLIED",
      "FULLY_REFUNDED",
      "VOIDED",
      "ALL",
    ])
    .default("OPEN"),
  accountId: z.string().uuid().optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
});
const recipientScopeSchema = z.enum([
  "INDIVIDUAL",
  "LABOUR_GROUP",
  "CONTRACTOR_FOREMAN",
  "TEMPORARY_CREW",
  "UNREGISTERED_LABOUR",
  "NO_SPECIFIC_RECIPIENT",
]);
const moneyMinorUnitsSchema = z.any().transform((raw, context) => {
  const result = parseSarMinorUnits(raw);
  if (!result.success) { context.addIssue({ code: "custom", message: result.message }); return z.NEVER; }
  return result.minorUnits;
});
const directDueSchema = contextSchema.extend({
  source: z.enum(["DIRECT", "ATTENDANCE_PERIOD"]).default("DIRECT"),
  idempotencyKey: z.string().uuid(),
  recipientScope: recipientScopeSchema,
  labourerId: z.string().trim().min(1).max(200).optional().nullable(),
  labourGroupId: z.string().trim().min(1).max(200).optional().nullable(),
  contractorReference: z.string().trim().max(200).optional().nullable(),
  crewReference: z.string().trim().max(200).optional().nullable(),
  manualRecipientName: z.string().trim().max(200).optional().nullable(),
  batchIdentity: z.string().trim().max(200).optional().nullable(),
  recipientReference: z.string().trim().max(200).optional().nullable(),
  contactPerson: z.string().trim().max(200).optional().nullable(),
  description: z.string().trim().min(1).max(500),
  workFromDate: z.string().date(),
  workToDate: z.string().date(),
  agreedGrossAmount: moneyMinorUnitsSchema.optional(),
  authorizedDeductions: moneyMinorUnitsSchema.default(0),
  notes: z.string().trim().max(1000).optional().nullable(),
  costCategory: z.string().trim().max(200).optional().nullable(),
}).superRefine((value, context) => {
  if (value.workToDate < value.workFromDate) context.addIssue({ code: "custom", path: ["workToDate"], message: "Work-to date cannot be before work-from date." });
  if (value.recipientScope === "INDIVIDUAL" && !value.labourerId) context.addIssue({ code: "custom", path: ["labourerId"], message: "Select a valid labourer." });
  if (value.recipientScope === "LABOUR_GROUP" && !value.labourGroupId) context.addIssue({ code: "custom", path: ["labourGroupId"], message: "Select a valid labour group." });
  if (["CONTRACTOR_FOREMAN", "TEMPORARY_CREW", "UNREGISTERED_LABOUR", "NO_SPECIFIC_RECIPIENT"].includes(value.recipientScope)) {
    const identity = value.recipientReference || value.crewReference || value.contractorReference || value.batchIdentity;
    if (!identity) context.addIssue({ code: "custom", path: ["recipientReference"], message: "Enter a crew or reference name." });
  }
  if (value.source === "DIRECT" && (value.agreedGrossAmount == null || value.agreedGrossAmount <= 0)) context.addIssue({ code: "custom", path: ["agreedGrossAmount"], message: "Enter an amount greater than zero." });
  if (value.authorizedDeductions < 0) context.addIssue({ code: "custom", path: ["authorizedDeductions"], message: "Deductions cannot be negative." });
  if (value.source === "DIRECT" && value.agreedGrossAmount != null && value.authorizedDeductions > value.agreedGrossAmount) context.addIssue({ code: "custom", path: ["authorizedDeductions"], message: "Deductions cannot exceed the agreed amount." });
}).transform((value) => ({
  ...value,
  recipientReference: value.recipientReference || value.crewReference || value.contractorReference || value.batchIdentity || null,
  contactPerson: value.contactPerson || value.manualRecipientName || null,
  agreedGrossAmountMinor: value.agreedGrossAmount ?? null,
  authorizedDeductionsMinor: value.authorizedDeductions,
  agreedGrossAmount: value.agreedGrossAmount == null ? undefined : sarFromMinorUnits(value.agreedGrossAmount),
  authorizedDeductions: sarFromMinorUnits(value.authorizedDeductions),
}));
const attendanceDuePreviewSchema = contextSchema.extend({
  recipientScope: z.enum(["INDIVIDUAL", "LABOUR_GROUP"]),
  labourerId: z.string().uuid().optional().nullable(),
  labourGroupId: z.string().uuid().optional().nullable(),
  fromDate: z.string().date(),
  toDate: z.string().date(),
  recordDate: z.string().date(),
});
const sarAmountSchema = z.coerce.number().positive().refine(
  (value) => Math.abs(value * 100 - Math.round(value * 100)) < 0.000001,
  "Use no more than two decimal places for SAR amounts.",
);
const paymentSchema = z.object({
  idempotencyKey: z.string().uuid(),
  voucherDate: z.string().date(),
  amount: sarAmountSchema,
  paymentAccountId: z.string().min(1),
  paymentMethod: z.string().trim().min(1).max(100),
  transactionReference: z.string().trim().max(200).optional().nullable(),
  description: z.string().trim().max(500).optional().nullable(),
});
const settleSchema = contextSchema.extend({
  advancePool: z.object({
    amount: sarAmountSchema,
    idempotencyKey: z.string().uuid(),
    settlementDate: z.string().date().optional(),
  }).optional().nullable(),
  advanceApplications: z
    .array(
      z.object({
        advanceVoucherId: z.string().uuid(),
        amount: sarAmountSchema,
        idempotencyKey: z.string().uuid(),
      }),
    )
    .default([]),
  payment: paymentSchema.optional().nullable(),
});
const advanceSchema = contextSchema
  .extend({
    idempotencyKey: z.string().uuid(),
    voucherDate: z.string().date(),
    recipientScope: recipientScopeSchema,
    labourerId: z.string().trim().min(1).max(200).optional().nullable(),
    labourGroupId: z.string().trim().min(1).max(200).optional().nullable(),
    receivedByLabourerId: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .nullable(),
    receivedByNameSnapshot: z.string().trim().max(200).optional().nullable(),
    contractorReference: z.string().trim().max(200).optional().nullable(),
    crewReference: z.string().trim().max(200).optional().nullable(),
    manualRecipientName: z.string().trim().max(200).optional().nullable(),
    batchIdentity: z.string().trim().max(200).optional().nullable(),
    amount: z.coerce.number().positive(),
    paymentAccountId: z.string().min(1),
    paymentMethod: z.string().trim().min(1).max(100).default("Cash"),
    transactionReference: z.string().trim().max(200).optional().nullable(),
    description: z.string().trim().min(1).max(500),
  })
  .superRefine((value, context) => {
    if (value.recipientScope === "INDIVIDUAL" && !value.labourerId)
      context.addIssue({
        code: "custom",
        path: ["labourerId"],
        message: "Select a labourer for this advance.",
      });
    if (value.recipientScope === "LABOUR_GROUP" && !value.labourGroupId)
      context.addIssue({
        code: "custom",
        path: ["labourGroupId"],
        message: "Select a labour group for this advance.",
      });
    if (value.recipientScope === "LABOUR_GROUP" && !value.receivedByLabourerId)
      context.addIssue({
        code: "custom",
        path: ["receivedByLabourerId"],
        message: "Select the labourer who received this group advance.",
      });
    if (
      [
        "CONTRACTOR_FOREMAN",
        "TEMPORARY_CREW",
        "UNREGISTERED_LABOUR",
        "NO_SPECIFIC_RECIPIENT",
      ].includes(value.recipientScope) &&
      !value.contractorReference &&
      !value.crewReference &&
      !value.batchIdentity
    )
      context.addIssue({
        code: "custom",
        path: ["recipientReference"],
        message: "Enter a stable recipient or crew reference.",
      });
  });
const advanceEditSchema = contextSchema
  .extend({
    voucherDate: z.string().date(),
    recipientScope: recipientScopeSchema,
    labourerId: z.string().trim().min(1).max(200).optional().nullable(),
    labourGroupId: z.string().trim().min(1).max(200).optional().nullable(),
    receivedByLabourerId: z.string().trim().min(1).max(200).optional().nullable(),
    receivedByNameSnapshot: z.string().trim().max(200).optional().nullable(),
    contractorReference: z.string().trim().max(200).optional().nullable(),
    crewReference: z.string().trim().max(200).optional().nullable(),
    manualRecipientName: z.string().trim().max(200).optional().nullable(),
    batchIdentity: z.string().trim().max(200).optional().nullable(),
    amount: z.coerce.number().positive(),
    paymentAccountId: z.string().min(1),
    paymentMethod: z.string().trim().min(1).max(100).default("Cash"),
    transactionReference: z.string().trim().max(200).optional().nullable(),
    description: z.string().trim().min(1).max(500),
  })
  .superRefine((value, context) => {
    if (value.recipientScope === "INDIVIDUAL" && !value.labourerId)
      context.addIssue({ code: "custom", path: ["labourerId"], message: "Select a labourer for this advance." });
    if (value.recipientScope === "LABOUR_GROUP" && !value.labourGroupId)
      context.addIssue({ code: "custom", path: ["labourGroupId"], message: "Select a labour group for this advance." });
    if (value.recipientScope === "LABOUR_GROUP" && !value.receivedByLabourerId)
      context.addIssue({ code: "custom", path: ["receivedByLabourerId"], message: "Select the labourer who received this group advance." });
    if (["CONTRACTOR_FOREMAN", "TEMPORARY_CREW", "UNREGISTERED_LABOUR", "NO_SPECIFIC_RECIPIENT"].includes(value.recipientScope) && !value.contractorReference && !value.crewReference && !value.batchIdentity)
      context.addIssue({ code: "custom", path: ["recipientReference"], message: "Enter a stable recipient or crew reference." });
  });
const holdSchema = z.object({
  hold: z.boolean(),
  reason: z.string().trim().max(500).optional().nullable(),
});
const voidSchema = z.object({
  idempotencyKey: z.string().uuid(),
  reason: z.string().trim().min(1).max(500),
});
const refundSchema = contextSchema.extend({ payment: paymentSchema });

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

type PostgreSqlErrorLike = { code?: unknown; constraint?: unknown; detail?: unknown; table?: unknown; column?: unknown; message?: unknown; cause?: unknown };
function labourPaymentDatabaseError(error: unknown) {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const value = current as PostgreSqlErrorLike;
    const info = {
      sqlState: typeof value.code === "string" ? value.code : null,
      constraint: typeof value.constraint === "string" ? value.constraint : null,
      detail: typeof value.detail === "string" ? value.detail : null,
      table: typeof value.table === "string" ? value.table : null,
      column: typeof value.column === "string" ? value.column : null,
      message: typeof value.message === "string" ? value.message : null,
    };
    if (info.sqlState || info.constraint || info.detail || info.table || info.column) return info;
    current = value.cause;
  }
  return null;
}

function allocationIdempotencyKey(poolKey: string, voucherId: string) {
  const bytes = crypto.createHash("sha256").update(`${poolKey}:${voucherId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function dueMemberPayableShares(due: typeof labourDues.$inferSelect) {
  const snapshot = due.recipientSnapshot as Record<string, unknown>;
  const rows = Array.isArray(snapshot.memberCalculationSnapshot) ? snapshot.memberCalculationSnapshot : [];
  return rows.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const row = value as Record<string, unknown>;
    const labourerId = typeof row.labourerId === "string" ? row.labourerId : "";
    const amount = Number(row.grossWage ?? row.calculatedAmount ?? row.attendanceWage ?? 0);
    return labourerId && Number.isFinite(amount) && amount >= 0 ? [{ labourerId, amount }] : [];
  });
}

async function loadDueAdvancePool(tx: DbTransaction, due: typeof labourDues.$inferSelect, requestedAmount?: number, settlementDate?: string) {
  const candidates = await tx.select({
    id: labourPaymentVouchers.id,
    voucherNumber: labourPaymentVouchers.voucherNumber,
    voucherDate: labourPaymentVouchers.voucherDate,
    createdAt: labourPaymentVouchers.createdAt,
    financialScopeKey: labourPaymentVouchers.financialScopeKey,
    labourerId: labourPaymentVouchers.labourerId,
    labourGroupId: labourPaymentVouchers.labourGroupId,
    recipientSnapshot: labourPaymentVouchers.recipientSnapshot,
    originalAmount: labourPaymentVouchers.paymentAmount,
    appliedAmount: sql<number>`coalesce((select sum(a.amount) from labour_advance_applications a where a.advance_voucher_id = ${labourPaymentVouchers.id} and a.status = 'ACTIVE'), 0)::numeric`,
    refundedAmount: sql<number>`coalesce((select sum(r.payment_amount) from labour_payment_vouchers r where r.related_advance_voucher_id = ${labourPaymentVouchers.id} and r.nature = 'REFUND_RECOVERY' and r.status = 'POSTED'), 0)::numeric`,
    appliedToDueAmount: sql<number>`coalesce((select sum(a.amount) from labour_advance_applications a where a.advance_voucher_id = ${labourPaymentVouchers.id} and a.due_id = ${due.id} and a.status = 'ACTIVE'), 0)::numeric`,
  }).from(labourPaymentVouchers).where(and(
    eq(labourPaymentVouchers.workspaceId, due.workspaceId),
    eq(labourPaymentVouchers.farmId, due.farmId),
    eq(labourPaymentVouchers.seasonId, due.seasonId),
    eq(labourPaymentVouchers.nature, "ADVANCE"),
    eq(labourPaymentVouchers.status, "POSTED"),
  ));
  const normalized = candidates.map((row) => {
    const snapshot = row.recipientSnapshot as Record<string, unknown>;
    const historicalLabourerId = row.labourerId
      || (typeof snapshot.labourerId === "string" ? snapshot.labourerId : null)
      || (typeof snapshot.advanceLabourerId === "string" ? snapshot.advanceLabourerId : null)
      || (typeof snapshot.recipientLabourerId === "string" ? snapshot.recipientLabourerId : null);
    const historicalGroupId = row.labourGroupId
      || (typeof snapshot.labourGroupId === "string" ? snapshot.labourGroupId : null)
      || (typeof snapshot.groupId === "string" ? snapshot.groupId : null);
    return {
      ...row,
      labourerId: historicalLabourerId,
      financialScopeKey: historicalGroupId && row.financialScopeKey.startsWith("legacy:") ? `group:${historicalGroupId}`
        : historicalLabourerId && row.financialScopeKey.startsWith("legacy:") ? `individual:${historicalLabourerId}`
        : row.financialScopeKey,
      recipientName: typeof snapshot.receivedByNameSnapshot === "string" ? snapshot.receivedByNameSnapshot
        : typeof snapshot.labourerName === "string" ? snapshot.labourerName
        : typeof snapshot.recipientName === "string" ? snapshot.recipientName : null,
      originalAmount: Number(row.originalAmount),
      appliedAmount: Number(row.appliedAmount),
      refundedAmount: Number(row.refundedAmount),
      appliedToDueAmount: Number(row.appliedToDueAmount),
    };
  });
  const pool = calculateLabourAdvancePool({
    dueFinancialScopeKey: due.financialScopeKey,
    dueOutstandingAmount: (await loadLabourDuePosition(tx, due.id))?.outstandingBalance ?? 0,
    settlementDate,
    memberPayableShares: due.recipientScope === "LABOUR_GROUP" ? dueMemberPayableShares(due) : [],
    candidates: normalized,
    requestedAmount,
  });
  const globalOutstanding = normalized.reduce((sum, row) => sum + Math.max(row.originalAmount - row.appliedAmount - row.refundedAmount, 0), 0);
  return { ...pool, globalOutstanding: Number(globalOutstanding.toFixed(2)) };
}

async function validateContext(
  request: { appUser?: { workspaceId?: string | null }; sessionId?: string },
  workspaceId: string,
  farmId: string,
  seasonId: string,
) {
  if (request.appUser?.workspaceId !== workspaceId || !request.sessionId)
    return false;
  const [session] = await db
    .select({
      farmId: userSessions.activeFarmId,
      seasonId: userSessions.activeSeasonId,
    })
    .from(userSessions)
    .where(eq(userSessions.id, request.sessionId))
    .limit(1);
  return session?.farmId === farmId && session.seasonId === seasonId;
}

async function validatedAccount(
  tx: DbTransaction,
  workspaceId: string,
  farmId: string,
  accountInput: string,
) {
  const account = await resolveCanonicalPaymentAccountId(
    tx,
    workspaceId,
    farmId,
    accountInput,
  );
  const validation = validateLabourSettlementPaymentAccount(account, farmId);
  if (!validation.valid || !account)
    throw new Error(
      validation.message ??
        "Select a valid active payment account for this farm.",
    );
  return account;
}

function recipientSnapshot(input: {
  recipientScope: LabourRecipientScope;
  manualRecipientName?: string | null;
  contractorReference?: string | null;
  crewReference?: string | null;
  batchIdentity?: string | null;
  recipientReference?: string | null;
  contactPerson?: string | null;
  labourerName?: string | null;
  labourGroupName?: string | null;
  groupLeaderId?: string | null;
  groupLeaderName?: string | null;
  groupMembers?: Array<{ id: string; name: string }>;
  receivedByLabourerId?: string | null;
  receivedByNameSnapshot?: string | null;
}) {
  return {
    recipientScope: input.recipientScope,
    manualRecipientName: input.manualRecipientName ?? null,
    contractorReference: input.contractorReference ?? null,
    crewReference: input.crewReference ?? null,
    batchIdentity: input.batchIdentity ?? null,
    recipientReference: input.recipientReference ?? null,
    contactPerson: input.contactPerson ?? null,
    labourerName: input.labourerName ?? null,
    labourGroupName: input.labourGroupName ?? null,
    groupLeaderId: input.groupLeaderId ?? null,
    groupLeaderName: input.groupLeaderName ?? null,
    groupMembers: input.groupMembers ?? [],
    receivedByLabourerId: input.receivedByLabourerId ?? null,
    receivedByNameSnapshot: input.receivedByNameSnapshot ?? null,
    receivedBy: input.receivedByNameSnapshot ?? null,
  };
}

async function loadRecipient(
  tx: DbTransaction,
  workspaceId: string,
  farmId: string,
  input: {
    recipientScope: LabourRecipientScope;
    labourerId?: string | null;
    labourGroupId?: string | null;
    receivedByLabourerId?: string | null;
    receivedByNameSnapshot?: string | null;
    manualRecipientName?: string | null;
    contractorReference?: string | null;
    crewReference?: string | null;
    batchIdentity?: string | null;
    recipientReference?: string | null;
    contactPerson?: string | null;
    requireReceivedBy?: boolean;
  },
) {
  let labourerName: string | null = null;
  let labourGroupName: string | null = null;
  let groupLeaderId: string | null = null;
  let groupLeaderName: string | null = null;
  let groupMembers: Array<{ id: string; name: string }> = [];
  if (input.recipientScope === "INDIVIDUAL") {
    if (!input.labourerId)
      throw new Error("Select a labourer for an individual labour due.");
    const [record] = await tx
      .select({ payload: operationalRecords.payload })
      .from(operationalRecords)
      .where(
        and(
          eq(operationalRecords.workspaceId, workspaceId),
          eq(operationalRecords.farmId, farmId),
          eq(operationalRecords.entityType, "labourer"),
          eq(operationalRecords.clientRecordId, input.labourerId),
        ),
      )
      .limit(1);
    if (!record || !isLabourSelectableForAdvance(record.payload, ""))
      throw new Error("The selected labourer was not found in this farm.");
    labourerName =
      typeof record.payload.name === "string"
        ? record.payload.name
        : "Labourer";
  }
  if (input.recipientScope === "LABOUR_GROUP") {
    if (!input.labourGroupId)
      throw new Error("Select a labour group for a group labour due.");
    const [record] = await tx
      .select({ payload: operationalRecords.payload })
      .from(operationalRecords)
      .where(
        and(
          eq(operationalRecords.workspaceId, workspaceId),
          eq(operationalRecords.farmId, farmId),
          eq(operationalRecords.entityType, "labourGroup"),
          eq(operationalRecords.clientRecordId, input.labourGroupId),
        ),
      )
      .limit(1);
    if (!record || record.payload.deletedAt)
      throw new Error("The selected labour group was not found in this farm.");
    labourGroupName =
      typeof record.payload.name === "string"
        ? record.payload.name
        : "Labour Group";
    groupLeaderId =
      typeof record.payload.foremanLabourId === "string"
        ? record.payload.foremanLabourId
        : typeof record.payload.foremanId === "string"
          ? record.payload.foremanId
          : null;
    const labourRows = await tx
      .select({
        clientRecordId: operationalRecords.clientRecordId,
        payload: operationalRecords.payload,
      })
      .from(operationalRecords)
      .where(
        and(
          eq(operationalRecords.workspaceId, workspaceId),
          eq(operationalRecords.farmId, farmId),
          eq(operationalRecords.entityType, "labourer"),
        ),
      );
    groupMembers = labourRows
      .filter(
        (item) =>
          isLabourSelectableForAdvance(item.payload, "") &&
          item.payload.groupId === input.labourGroupId,
      )
      .map((item) => ({
        id: item.clientRecordId,
        name:
          typeof item.payload.name === "string"
            ? item.payload.name
            : "Labourer",
      }));
    const leaderRow = groupLeaderId
      ? labourRows.find((item) => item.clientRecordId === groupLeaderId)
      : null;
    groupLeaderName =
      typeof leaderRow?.payload.name === "string"
        ? leaderRow.payload.name
        : null;
    if (input.requireReceivedBy && !input.receivedByLabourerId)
      throw new Error("Select the labourer who received this group advance.");
    if (input.receivedByLabourerId) {
      const receiverRow = labourRows.find(
        (item) =>
          item.clientRecordId === input.receivedByLabourerId &&
          isLabourSelectableForAdvance(item.payload, ""),
      );
      if (!receiverRow)
        throw new Error(
          "The selected receiving labourer was not found in this farm.",
        );
      input.receivedByNameSnapshot =
        typeof receiverRow.payload.name === "string"
          ? receiverRow.payload.name
          : input.receivedByNameSnapshot;
    }
  }
  if (input.recipientScope === "INDIVIDUAL") {
    input.receivedByLabourerId = input.labourerId;
    input.receivedByNameSnapshot = labourerName;
  }
  const financialScopeKey = labourFinancialScopeKey(input);
  return {
    financialScopeKey,
    snapshot: recipientSnapshot({
      ...input,
      labourerName,
      labourGroupName,
      groupLeaderId,
      groupLeaderName,
      groupMembers,
    }),
  };
}

async function insertAccountMovement(
  tx: DbTransaction,
  input: {
    farmId: string;
    seasonId: string;
    voucherId: string;
    voucherNumber: string;
    voucherDate: string;
    amount: number;
    account: Awaited<ReturnType<typeof validatedAccount>>;
    actorId: string;
    reverse?: boolean;
  },
) {
  const normalType =
    input.account.accountType === "partner" ? "credit" : "debit";
  const type = input.reverse
    ? normalType === "credit"
      ? "debit"
      : "credit"
    : normalType;
  const [transaction] = await tx
    .insert(accountTransactions)
    .values({
      farmId: input.farmId,
      seasonId: input.seasonId,
      accountId: input.account.id,
      source: "settlement",
      sourceType: "labour_payment_voucher",
      referenceId: input.voucherId,
      type,
      amount: input.amount.toFixed(2),
      transactionDate: input.voucherDate,
      remarks: `Labour Payment Voucher ${input.voucherNumber}`,
      createdBy: input.actorId,
    })
    .returning({ id: accountTransactions.id });
  return transaction!.id;
}

async function loadEditableAdvance(tx: DbTransaction, input: {
  workspaceId: string;
  farmId: string;
  seasonId: string;
  voucherId: string;
}) {
  const [advance] = await tx
    .select()
    .from(labourPaymentVouchers)
    .where(
      and(
        eq(labourPaymentVouchers.id, input.voucherId),
        eq(labourPaymentVouchers.workspaceId, input.workspaceId),
        eq(labourPaymentVouchers.farmId, input.farmId),
        eq(labourPaymentVouchers.seasonId, input.seasonId),
      ),
    )
    .for("update")
    .limit(1);
  if (!advance || advance.nature !== "ADVANCE")
    throw new Error("Labour Advance Voucher was not found.");
  const [position] = await tx
    .select({
      appliedAmount: sql<number>`coalesce(sum(${labourAdvanceApplications.amount}) filter (where ${labourAdvanceApplications.status} = 'ACTIVE'), 0)::numeric`,
      applicationCount: sql<number>`count(*) filter (where ${labourAdvanceApplications.status} = 'ACTIVE')::int`,
    })
    .from(labourAdvanceApplications)
    .where(eq(labourAdvanceApplications.advanceVoucherId, advance.id));
  const [refunds] = await tx
    .select({
      refundedAmount: sql<number>`coalesce(sum(${labourPaymentVouchers.paymentAmount}) filter (where ${labourPaymentVouchers.status} = 'POSTED' and ${labourPaymentVouchers.nature} = 'REFUND_RECOVERY'), 0)::numeric`,
      refundCount: sql<number>`count(*) filter (where ${labourPaymentVouchers.status} = 'POSTED' and ${labourPaymentVouchers.nature} = 'REFUND_RECOVERY')::int`,
    })
    .from(labourPaymentVouchers)
    .where(eq(labourPaymentVouchers.relatedAdvanceVoucherId, advance.id));
  const [reversal] = await tx
    .select({ id: labourPaymentVouchers.id })
    .from(labourPaymentVouchers)
    .where(
      and(
        eq(labourPaymentVouchers.reversalReference, advance.id),
        eq(labourPaymentVouchers.status, "POSTED"),
      ),
    )
    .limit(1);
  if (
    advance.status !== "POSTED" ||
    advance.linkedDueId ||
    Number(position?.appliedAmount ?? 0) > 0 ||
    Number(position?.applicationCount ?? 0) > 0 ||
    Number(refunds?.refundedAmount ?? 0) > 0 ||
    Number(refunds?.refundCount ?? 0) > 0 ||
    reversal
  )
    throw new Error("This advance has already been used and its financial details cannot be edited.");
  if (advance.legacy && (!advance.accountTransactionId || advance.reconciliationStatus !== "RECONCILED"))
    throw new Error("This legacy advance cannot be changed because its linked accounting effect is not uniquely identified.");
  return advance;
}

async function requireRequestScope(
  request: FastifyRequest,
  reply: FastifyReply,
  workspaceId: string,
  farmId: string,
  seasonId: string,
  action: "view" | "create" | "edit" | "delete",
) {
  if (!request.appUser || !request.sessionId) {
    reply.code(401).send({ message: "A database-backed session is required." });
    return false;
  }
  if (
    request.appUser.workspaceId !== workspaceId ||
    !hasModulePermission(request.appUser, workspaceId, "wages", action)
  ) {
    reply
      .code(403)
      .send({ message: "Workforce payment permission is required." });
    return false;
  }
  if (
    !hasFarmAccess(request.appUser, workspaceId, farmId) ||
    !(await validateContext(request, workspaceId, farmId, seasonId))
  ) {
    reply
      .code(403)
      .send({
        message: "Select this farm and season before managing labour payments.",
      });
    return false;
  }
  const ownershipError = await validateTenantReferences(workspaceId, {
    farmId,
    seasonId,
  });
  if (ownershipError) {
    reply.code(403).send({ message: ownershipError });
    return false;
  }
  return true;
}

export async function labourPaymentRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/v1/admin/labour-due-attendance-integrity",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const query = contextSchema.extend({ workspaceId: z.string().uuid() }).safeParse(request.query);
      if (!query.success) return reply.code(400).send({ message: "A valid workspace, farm, and season are required." });
      const { workspaceId, farmId, seasonId } = query.data;
      const result = await db.execute(sql`
        WITH context_attendance AS (
          SELECT * FROM operational_records
          WHERE workspace_id=${workspaceId} AND farm_id=${farmId} AND season_id=${seasonId} AND entity_type='attendance'
        ), valid_links AS (
          SELECT s.attendance_record_id, s.due_id FROM labour_due_attendance_sources s
          JOIN labour_dues d ON d.id=s.due_id
          WHERE s.workspace_id=${workspaceId} AND s.farm_id=${farmId} AND s.season_id=${seasonId}
            AND d.calculation_status='APPROVED' AND d.payment_status NOT IN ('VOIDED','CANCELLED')
        )
        SELECT
          (SELECT count(*)::int FROM labour_due_attendance_sources s LEFT JOIN labour_dues d ON d.id=s.due_id WHERE s.workspace_id=${workspaceId} AND s.farm_id=${farmId} AND s.season_id=${seasonId} AND d.id IS NULL) AS links_missing_due,
          (SELECT count(*)::int FROM context_attendance a LEFT JOIN valid_links v ON v.attendance_record_id=a.id WHERE v.due_id IS NULL AND (a.payload ? 'labourDueId' OR a.payload ? 'labourDueNumber')) AS consumed_without_due_link,
          (SELECT count(*)::int FROM (SELECT d.id FROM labour_dues d LEFT JOIN labour_due_attendance_sources s ON s.due_id=d.id WHERE d.workspace_id=${workspaceId} AND d.farm_id=${farmId} AND d.season_id=${seasonId} AND d.settlement_basis='ATTENDANCE' AND d.calculation_status='APPROVED' GROUP BY d.id HAVING count(s.id)=0) missing) AS dues_without_attendance,
          (SELECT count(*)::int FROM labour_wage_settlement_create_requests r LEFT JOIN operational_records o ON o.id=r.settlement_operational_record_id WHERE r.workspace_id=${workspaceId} AND r.farm_id=${farmId} AND r.season_id=${seasonId} AND r.state='completed' AND o.id IS NULL) AS completed_requests_missing_result,
          (SELECT count(*)::int FROM labour_wage_settlement_create_requests r WHERE r.workspace_id=${workspaceId} AND r.farm_id=${farmId} AND r.season_id=${seasonId} AND r.state='pending' AND r.updated_at < now()-interval '15 minutes') AS abandoned_pending_requests,
          (SELECT count(*)::int FROM labour_accounting_entries e LEFT JOIN labour_dues d ON d.id=e.due_id WHERE e.workspace_id=${workspaceId} AND e.farm_id=${farmId} AND e.season_id=${seasonId} AND e.due_id IS NOT NULL AND d.id IS NULL) AS accounting_missing_due,
          (SELECT count(*)::int FROM labour_dues d WHERE d.workspace_id=${workspaceId} AND d.farm_id=${farmId} AND d.season_id=${seasonId} AND d.payment_status IN ('UNPAID','PARTIALLY_SETTLED','ON_HOLD') AND d.origin='SETTLEMENT' AND NOT d.legacy AND d.source_record_id IS NULL) AS canonical_attendance_dues
      `);
      const owners = await db.execute(sql`
        SELECT d.id, d.due_number, d.payment_status, d.origin, d.settlement_basis,
               d.gross_amount, d.workspace_id, d.farm_id, d.season_id, d.labour_group_id,
               d.recipient_snapshot, d.idempotency_key, d.created_at,
               count(DISTINCT s.id)::int AS attendance_count,
               count(DISTINCT m.id)::int AS member_snapshot_count,
               count(DISTINCT e.id)::int AS accounting_entry_count
        FROM labour_dues d
        LEFT JOIN labour_due_attendance_sources s ON s.due_id=d.id
        LEFT JOIN labour_due_member_snapshots m ON m.due_id=d.id
        LEFT JOIN labour_accounting_entries e ON e.due_id=d.id AND e.status='POSTED'
        WHERE d.workspace_id=${workspaceId} AND d.farm_id=${farmId} AND d.season_id=${seasonId}
          AND d.settlement_basis='ATTENDANCE'
        GROUP BY d.id ORDER BY d.created_at DESC
      `);
      const createRequests = await db.select().from(labourWageSettlementCreateRequests).where(and(eq(labourWageSettlementCreateRequests.workspaceId, workspaceId), eq(labourWageSettlementCreateRequests.farmId, farmId), eq(labourWageSettlementCreateRequests.seasonId, seasonId)));
      return { integrity: result.rows[0], attendanceDues: owners.rows, legacyCreateRequests: createRequests };
    },
  );

  app.post(
    "/v1/admin/labour-due-attendance-integrity/repair",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const body = contextSchema.extend({ workspaceId: z.string().uuid() }).safeParse(request.body);
      if (!body.success) return reply.code(400).send({ message: "A valid workspace, farm, and season are required." });
      const { workspaceId, farmId, seasonId } = body.data;
      const repaired = await db.transaction(async (tx) => {
        const rows = await tx.execute(sql`
          UPDATE operational_records a
          SET payload=payload-'labourDueId'-'labourDueNumber'-'labourDueLockedAt', updated_at=now()
          WHERE a.workspace_id=${workspaceId} AND a.farm_id=${farmId} AND a.season_id=${seasonId} AND a.entity_type='attendance'
            AND (a.payload ? 'labourDueId' OR a.payload ? 'labourDueNumber')
            AND NOT EXISTS (
              SELECT 1 FROM labour_due_attendance_sources s JOIN labour_dues d ON d.id=s.due_id
              WHERE s.attendance_record_id=a.id AND s.workspace_id=a.workspace_id
                AND d.calculation_status='APPROVED' AND d.payment_status NOT IN ('VOIDED','CANCELLED')
            )
          RETURNING a.id
        `);
        const legacyRows = await tx.execute(sql`
          UPDATE operational_records a
          SET payload=payload-'linkedSettlementId'-'labourWageSettlementId'-'settlementDate', updated_at=now()
          WHERE a.workspace_id=${workspaceId} AND a.farm_id=${farmId} AND a.season_id=${seasonId} AND a.entity_type='attendance'
            AND (a.payload ? 'linkedSettlementId' OR a.payload ? 'labourWageSettlementId')
            AND NOT EXISTS (
              SELECT 1 FROM operational_records s
              WHERE s.workspace_id=a.workspace_id AND s.entity_type='labourWageSettlement'
                AND (s.client_record_id=coalesce(a.payload->>'linkedSettlementId',a.payload->>'labourWageSettlementId') OR s.id::text=coalesce(a.payload->>'linkedSettlementId',a.payload->>'labourWageSettlementId'))
                AND s.payload->>'deletedAt' IS NULL
                AND lower(coalesce(s.payload->>'status','posted')) NOT IN ('voided','deleted','reversed')
            )
          RETURNING a.id
        `);
        await tx.update(labourWageSettlementCreateRequests).set({ state: "failed", stage: "integrity_repair", safeToRetry: true, errorCode: "ABANDONED_REQUEST", message: "The abandoned request was released for retry." }).where(and(eq(labourWageSettlementCreateRequests.workspaceId, workspaceId), eq(labourWageSettlementCreateRequests.farmId, farmId), eq(labourWageSettlementCreateRequests.seasonId, seasonId), eq(labourWageSettlementCreateRequests.state, "pending"), sql`${labourWageSettlementCreateRequests.updatedAt} < now() - interval '15 minutes'`));
        return rows.rows.length + legacyRows.rows.length;
      });
      return { repairedAttendanceCount: repaired, retryable: true };
    },
  );
  app.get(
    "/v1/workspace/:workspaceId/labour-payments/dues",
    { preHandler: requireUser },
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      const query = contextSchema
        .extend({
          status: z.string().optional(),
          origin: z.string().optional(),
          search: z.string().optional(),
        })
        .safeParse(request.query);
      if (!params.success || !query.success)
        return reply
          .code(400)
          .send({ message: "A valid labour due query is required." });
      const { workspaceId } = params.data;
      const { farmId, seasonId } = query.data;
      if (
        !(await requireRequestScope(
          request,
          reply,
          workspaceId,
          farmId,
          seasonId,
          "view",
        ))
      )
        return;
      const rows = await db
        .select()
        .from(labourDues)
        .where(
          and(
            eq(labourDues.workspaceId, workspaceId),
            eq(labourDues.farmId, farmId),
            eq(labourDues.seasonId, seasonId),
            query.data.status
              ? eq(labourDues.paymentStatus, query.data.status)
              : inArray(labourDues.paymentStatus, [
                  "UNPAID",
                  "PARTIALLY_SETTLED",
                  "ON_HOLD",
                ]),
            query.data.origin
              ? eq(labourDues.origin, query.data.origin)
              : undefined,
          ),
        )
        .orderBy(desc(labourDues.createdAt));
      const settlementSourceIds = rows
        .filter((row) => row.origin === "SETTLEMENT")
        .map((row) => row.sourceRecordId)
        .filter((value): value is string => Boolean(value));
      const validSettlementSources = settlementSourceIds.length
        ? await db
            .select({
              id: operationalRecords.id,
              payload: operationalRecords.payload,
            })
            .from(operationalRecords)
            .where(
              and(
                eq(operationalRecords.workspaceId, workspaceId),
                eq(operationalRecords.entityType, "labourWageSettlement"),
                inArray(operationalRecords.id, settlementSourceIds),
              ),
            )
        : [];
      const activeSettlementSourceIds = new Set(
        validSettlementSources
          .filter(
            (row) =>
              !row.payload.deletedAt &&
              !["voided", "deleted", "reversed"].includes(
                String(row.payload.status ?? "").toLowerCase(),
              ),
          )
          .map((row) => row.id),
      );
      const validRows = rows.filter(
        (row) =>
          row.origin !== "SETTLEMENT" ||
          (!row.legacy && !row.sourceRecordId) ||
          (Boolean(row.sourceRecordId) &&
            activeSettlementSourceIds.has(row.sourceRecordId!)),
      );
      const dues = await db.transaction(async (tx) =>
        Promise.all(
          validRows.map(async (row) => {
            const position = await loadLabourDuePosition(tx, row.id);
            return { ...row, ...position, due: undefined };
          }),
        ),
      );
      const term = (query.data.search ?? "").trim().toLowerCase();
      return {
        dues: term
          ? dues.filter((due) =>
              [
                due.dueNumber,
                due.description,
                JSON.stringify(due.recipientSnapshot),
              ]
                .join(" ")
                .toLowerCase()
                .includes(term),
            )
          : dues,
      };
    },
  );

  app.get(
    "/v1/workspace/:workspaceId/labour-payments/dues/:dueId",
    { preHandler: requireUser },
    async (request, reply) => {
      const params = dueParamsSchema.safeParse(request.params);
      const query = contextSchema.safeParse(request.query);
      if (!params.success || !query.success)
        return reply
          .code(400)
          .send({ message: "A valid labour due is required." });
      if (
        !(await requireRequestScope(
          request,
          reply,
          params.data.workspaceId,
          query.data.farmId,
          query.data.seasonId,
          "view",
        ))
      )
        return;
      const result = await db.transaction(async (tx) => {
        const position = await loadLabourDuePosition(tx, params.data.dueId);
        if (
          !position ||
          position.due.workspaceId !== params.data.workspaceId ||
          position.due.farmId !== query.data.farmId ||
          position.due.seasonId !== query.data.seasonId
        )
          return null;
        const [payments, advances] = await Promise.all([
          tx
            .select({
              allocation: labourPaymentAllocations,
              voucher: labourPaymentVouchers,
            })
            .from(labourPaymentAllocations)
            .innerJoin(
              labourPaymentVouchers,
              eq(labourPaymentVouchers.id, labourPaymentAllocations.voucherId),
            )
            .where(eq(labourPaymentAllocations.dueId, params.data.dueId)),
          tx
            .select({
              application: labourAdvanceApplications,
              voucher: labourPaymentVouchers,
            })
            .from(labourAdvanceApplications)
            .innerJoin(
              labourPaymentVouchers,
              eq(
                labourPaymentVouchers.id,
                labourAdvanceApplications.advanceVoucherId,
              ),
            )
            .where(eq(labourAdvanceApplications.dueId, params.data.dueId)),
        ]);
        return { ...position, payments, advances };
      });
      return result
        ? { due: result }
        : reply.code(404).send({ message: "Labour due was not found." });
    },
  );

  app.post(
    "/v1/workspace/:workspaceId/labour-payments/dues/attendance-preview",
    { preHandler: requireUser },
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      const body = attendanceDuePreviewSchema.safeParse(request.body);
      if (!params.success || !body.success || body.data.fromDate > body.data.toDate)
        return reply.code(400).send({ message: "Select a valid recipient and attendance period." });
      const { workspaceId } = params.data;
      const input = body.data;
      if (!(await requireRequestScope(request, reply, workspaceId, input.farmId, input.seasonId, "view"))) return;
      try {
        const selection = input.recipientScope === "LABOUR_GROUP"
          ? { settlementMode: "group" as const, groupId: input.labourGroupId ?? undefined }
          : { settlementMode: "individual" as const, labourerId: input.labourerId ?? undefined };
        const unfiltered = await db.transaction((tx) => previewLabourWageSettlement(
          tx, workspaceId, input.farmId, input.seasonId, input.fromDate, input.toDate,
          input.recordDate, undefined, selection, { includeAdvances: false },
        ));
        const sourceIds = unfiltered.sourceAttendanceIds;
        const ownershipRows = sourceIds.length ? await db.execute(sql`
          SELECT s.attendance_client_record_id AS attendance_id,
                 d.id::text AS owner_id, d.due_number AS owner_number,
                 'LABOUR_DUE'::text AS owner_type, d.payment_status AS owner_status,
                 d.work_from_date::text AS from_date, d.work_to_date::text AS to_date,
                 d.gross_amount::text AS amount
          FROM labour_due_attendance_sources s
          JOIN labour_dues d ON d.id = s.due_id
          WHERE s.workspace_id = ${workspaceId} AND s.farm_id = ${input.farmId}
            AND s.season_id = ${input.seasonId}
            AND s.attendance_client_record_id IN (${sql.join(sourceIds.map((id) => sql`${id}`), sql`, `)})
            AND d.calculation_status = 'APPROVED'
            AND d.payment_status NOT IN ('VOIDED', 'CANCELLED')
          UNION ALL
          SELECT a.client_record_id AS attendance_id,
                 s.id::text AS owner_id,
                 coalesce(s.payload->>'settlementNumber', s.client_record_id) AS owner_number,
                 'HISTORICAL_SETTLEMENT'::text AS owner_type,
                 coalesce(s.payload->>'status', 'posted') AS owner_status,
                 s.payload->>'fromDate' AS from_date, s.payload->>'toDate' AS to_date,
                 coalesce(s.payload->>'grossWagesEarned', s.payload->>'grossAmount', '0') AS amount
          FROM operational_records a
          JOIN operational_records s ON s.workspace_id = a.workspace_id
            AND s.entity_type = 'labourWageSettlement'
            AND (s.client_record_id = coalesce(a.payload->>'linkedSettlementId', a.payload->>'labourWageSettlementId')
              OR s.id::text = coalesce(a.payload->>'linkedSettlementId', a.payload->>'labourWageSettlementId'))
          WHERE a.workspace_id = ${workspaceId} AND a.farm_id = ${input.farmId}
            AND a.season_id = ${input.seasonId} AND a.entity_type = 'attendance'
            AND a.client_record_id IN (${sql.join(sourceIds.map((id) => sql`${id}`), sql`, `)})
            AND s.payload->>'deletedAt' IS NULL
            AND lower(coalesce(s.payload->>'status', 'posted')) NOT IN ('voided', 'deleted', 'reversed')
        `) : { rows: [] };
        const ownership = ownershipRows.rows as Array<Record<string, unknown>>;
        const lockedIds = new Set(ownership.map((row) => String(row.attendance_id)));
        const preview = lockedIds.size
          ? await db.transaction((tx) => previewLabourWageSettlement(
              tx, workspaceId, input.farmId, input.seasonId, input.fromDate, input.toDate,
              input.recordDate, undefined, selection,
              { includeAdvances: false, excludedAttendanceClientIds: lockedIds },
            ))
          : unfiltered;
        const ownerMap = new Map<string, { ownerId: string; ownerNumber: string; ownerType: string; ownerStatus: string; fromDate: string | null; toDate: string | null; amount: number; attendanceCount: number }>();
        for (const row of ownership) {
          const key = `${row.owner_type}:${row.owner_id}`;
          const current = ownerMap.get(key);
          if (current) current.attendanceCount += 1;
          else ownerMap.set(key, { ownerId: String(row.owner_id), ownerNumber: String(row.owner_number), ownerType: String(row.owner_type), ownerStatus: String(row.owner_status), fromDate: row.from_date ? String(row.from_date) : null, toDate: row.to_date ? String(row.to_date) : null, amount: Number(row.amount ?? 0), attendanceCount: 1 });
        }
        const flagged = sourceIds.length ? await db.select({ clientRecordId: operationalRecords.clientRecordId, payload: operationalRecords.payload }).from(operationalRecords).where(and(eq(operationalRecords.workspaceId, workspaceId), inArray(operationalRecords.clientRecordId, sourceIds))) : [];
        const orphanedAttendanceCount = flagged.filter((row) => Boolean(row.payload.labourDueId || row.payload.labourWageSettlementId || row.payload.linkedSettlementId) && !lockedIds.has(row.clientRecordId)).length;
        return { preview: { ...preview, excludedAttendanceCount: lockedIds.size, excludedOwners: [...ownerMap.values()], orphanedAttendanceCount } };
      } catch (error) {
        return reply.code(400).send({ message: error instanceof Error ? error.message : "Unable to calculate attendance wages." });
      }
    },
  );

  app.post(
    "/v1/workspace/:workspaceId/labour-payments/dues",
    { preHandler: requireUser },
    async (request, reply) => {
      const requestStartedAt = performance.now();
      const phases: Record<string, number> = {};
      const validationStartedAt = performance.now();
      const params = paramsSchema.safeParse(request.params);
      const body = directDueSchema.safeParse(request.body);
      phases.requestValidation = performance.now() - validationStartedAt;
      if (!params.success) return reply.code(400).send({ message: "A valid workspace is required." });
      if (!body.success) {
        const errors = Object.fromEntries(body.error.issues.map((issue) => [String(issue.path[0] ?? "form"), issue.message]));
        const raw = request.body && typeof request.body === "object"
          ? request.body as Record<string, unknown>
          : {};
        request.log.info({
          event: "labour_due_create_validation_failed",
          values: {
            source: raw.source,
            recipientScope: raw.recipientScope,
            labourerId: raw.labourerId,
            labourGroupId: raw.labourGroupId,
            recipientReference: raw.recipientReference,
            recipientReferenceType: typeof raw.recipientReference,
            contactPerson: raw.contactPerson,
            legacyBatchIdentity: raw.batchIdentity,
            workFromDate: raw.workFromDate,
            workToDate: raw.workToDate,
            agreedGrossAmount: raw.agreedGrossAmount,
            agreedGrossAmountType: typeof raw.agreedGrossAmount,
            authorizedDeductions: raw.authorizedDeductions,
            authorizedDeductionsType: typeof raw.authorizedDeductions,
            farmId: raw.farmId,
            seasonId: raw.seasonId,
            idempotencyKey: raw.idempotencyKey,
          },
          errors,
        });
        return reply.code(400).send({ message: "Please correct the highlighted fields.", errors });
      }
      const { workspaceId } = params.data;
      const input = body.data;
      request.log.info({ event: "labour_due_create_contract", values: {
        source: input.source, recipientScope: input.recipientScope,
        labourerId: input.labourerId ?? null, labourGroupId: input.labourGroupId ?? null,
        recipientReference: input.recipientReference ?? null, contactPerson: input.contactPerson ?? null,
        descriptionLength: input.description.length, workFromDate: input.workFromDate, workToDate: input.workToDate,
        agreedGrossAmount: input.agreedGrossAmount ?? null, agreedGrossAmountMinor: input.agreedGrossAmountMinor,
        authorizedDeductions: input.authorizedDeductions, authorizedDeductionsMinor: input.authorizedDeductionsMinor,
        calculatedAmountDueMinor: Math.max((input.agreedGrossAmountMinor ?? 0) - input.authorizedDeductionsMinor, 0),
        farmId: input.farmId, seasonId: input.seasonId, idempotencyKey: input.idempotencyKey,
      } });
      if (
        !(await requireRequestScope(
          request,
          reply,
          workspaceId,
          input.farmId,
          input.seasonId,
          "create",
        ))
      )
        return;
      try {
        let attendanceCount = 0;
        let memberCount = 0;
        const transactionStartedAt = performance.now();
        const due = await db.transaction(async (tx) => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${workspaceId}:${input.idempotencyKey}:labour-due-create`}), 1)`);
          const [existing] = await tx
            .select()
            .from(labourDues)
            .where(
              and(
                eq(labourDues.workspaceId, workspaceId),
                eq(labourDues.idempotencyKey, input.idempotencyKey),
              ),
            )
            .limit(1);
          if (existing) return existing;
          const recipient = await loadRecipient(
            tx,
            workspaceId,
            input.farmId,
            input,
          );
          const revalidationStartedAt = performance.now();
          const attendancePreview = input.source === "ATTENDANCE_PERIOD"
            ? await previewLabourWageSettlement(tx, workspaceId, input.farmId, input.seasonId, input.workFromDate, input.workToDate, input.workToDate, undefined,
                input.recipientScope === "LABOUR_GROUP" ? { settlementMode: "group", groupId: input.labourGroupId ?? undefined } : { settlementMode: "individual", labourerId: input.labourerId ?? undefined }, { includeAdvances: false })
            : null;
          phases.attendanceRevalidation = performance.now() - revalidationStartedAt;
          if (attendancePreview?.unresolvedRows.length) throw new Error("Add wage rates for all included attendance before creating the due.");
          const sourceAttendanceIds = attendancePreview?.sourceAttendanceIds ?? [];
          attendanceCount = sourceAttendanceIds.length;
          memberCount = attendancePreview?.includedLabourCount ?? 0;
          let sourceRows: Array<{ id: string; clientRecordId: string; payload: Record<string, unknown> }> = [];
          if (sourceAttendanceIds.length) {
            const sourceCheckStartedAt = performance.now();
            sourceRows = await tx.select({ id: operationalRecords.id, clientRecordId: operationalRecords.clientRecordId, payload: operationalRecords.payload }).from(operationalRecords).where(and(eq(operationalRecords.workspaceId, workspaceId), eq(operationalRecords.farmId, input.farmId), eq(operationalRecords.seasonId, input.seasonId), eq(operationalRecords.entityType, "attendance"), inArray(operationalRecords.clientRecordId, sourceAttendanceIds)));
            if (sourceRows.length !== sourceAttendanceIds.length) throw new Error("Some previewed attendance records are no longer available. Refresh the preview.");
            const owned = await tx.execute(sql`
              SELECT s.attendance_client_record_id
              FROM labour_due_attendance_sources s
              JOIN labour_dues d ON d.id = s.due_id
              WHERE s.workspace_id = ${workspaceId}
                AND s.attendance_client_record_id IN (${sql.join(sourceAttendanceIds.map((id) => sql`${id}`), sql`, `)})
                AND d.calculation_status = 'APPROVED'
                AND d.payment_status NOT IN ('VOIDED', 'CANCELLED')
              UNION
              SELECT a.client_record_id
              FROM operational_records a
              JOIN operational_records s ON s.workspace_id = a.workspace_id
                AND s.entity_type = 'labourWageSettlement'
                AND (s.client_record_id = coalesce(a.payload->>'linkedSettlementId', a.payload->>'labourWageSettlementId')
                  OR s.id::text = coalesce(a.payload->>'linkedSettlementId', a.payload->>'labourWageSettlementId'))
              WHERE a.workspace_id = ${workspaceId}
                AND a.client_record_id IN (${sql.join(sourceAttendanceIds.map((id) => sql`${id}`), sql`, `)})
                AND s.payload->>'deletedAt' IS NULL
                AND lower(coalesce(s.payload->>'status', 'posted')) NOT IN ('voided', 'deleted', 'reversed')
            `);
            if (owned.rows.length) throw new Error("Some attendance records are already included in another due or settlement. Refresh the preview.");
            phases.sourceValidation = performance.now() - sourceCheckStartedAt;
          }
          const grossAmount = attendancePreview?.grossWages ?? input.agreedGrossAmount ?? 0;
          if (grossAmount <= 0) throw new Error("No payable attendance is available for this due.");
          const dueNumber = await allocateLabourDueNumber(
            tx,
            workspaceId,
            input.farmId,
          );
          const dueInsertStartedAt = performance.now();
          const [created] = await tx
            .insert(labourDues)
            .values({
              workspaceId,
              farmId: input.farmId,
              seasonId: input.seasonId,
              dueNumber,
              origin: input.source === "ATTENDANCE_PERIOD" ? "SETTLEMENT" : "DIRECT",
              settlementBasis: input.source === "ATTENDANCE_PERIOD" ? "ATTENDANCE" : "MANUAL",
              recipientScope: input.recipientScope,
              financialScopeKey: recipient.financialScopeKey,
              labourerId: input.labourerId,
              labourGroupId: input.labourGroupId,
              contractorReference: input.recipientScope === "CONTRACTOR_FOREMAN" ? input.recipientReference : input.contractorReference,
              crewReference: ["TEMPORARY_CREW", "UNREGISTERED_LABOUR", "NO_SPECIFIC_RECIPIENT"].includes(input.recipientScope) ? input.recipientReference : input.crewReference,
              recipientSnapshot: {
                ...recipient.snapshot,
                notes: input.notes,
                costCategory: input.costCategory,
                dueSource: input.source,
                groupName: attendancePreview?.groupName ?? null,
                foremanId: attendancePreview?.foremanId ?? null,
                foremanName: attendancePreview?.includedLabourRows.find((row) => row.labourerId === attendancePreview.foremanId)?.labourName ?? null,
                memberCount: attendancePreview?.includedLabourCount ?? null,
                attendanceTotals: attendancePreview?.attendanceTotals ?? null,
                memberCalculationSnapshot: attendancePreview?.includedLabourRows ?? null,
                sourceAttendanceIds,
                calculationRules: input.source === "ATTENDANCE_PERIOD" ? "daily wage rate by attendance date; half day = 0.5; leader counted once by labourer ID" : "manual agreed amount",
              },
              description: input.description,
              workFromDate: input.workFromDate,
              workToDate: input.workToDate,
              grossAmount: grossAmount.toFixed(2),
              adjustmentAmount: "0.00",
              authorizedDeductions: input.authorizedDeductions.toFixed(2),
              calculationStatus: "APPROVED",
              paymentStatus: "UNPAID",
              approvedAt: new Date(),
              approvedBy: request.appUser!.id,
              idempotencyKey: input.idempotencyKey,
              createdBy: request.appUser!.id,
            })
            .returning();
          phases.dueInsert = performance.now() - dueInsertStartedAt;
          if (attendancePreview?.includedLabourRows.length) {
            const memberInsertStartedAt = performance.now();
            await tx.insert(labourDueMemberSnapshots).values(attendancePreview.includedLabourRows.map((row) => ({
              workspaceId,
              dueId: created!.id,
              labourerId: row.labourerId,
              snapshot: row as unknown as Record<string, unknown>,
              calculatedAmount: row.grossWage.toFixed(2),
            })));
            phases.memberSnapshotInsert = performance.now() - memberInsertStartedAt;
          }
          if (sourceRows.length) {
            const sourceLinkStartedAt = performance.now();
            try {
              await tx.insert(labourDueAttendanceSources).values(sourceRows.map((row) => ({
                workspaceId,
                farmId: input.farmId,
                seasonId: input.seasonId,
                dueId: created!.id,
                attendanceRecordId: row.id,
                attendanceClientRecordId: row.clientRecordId,
              })));
            } catch (error) {
              if (error instanceof Error && /unique|duplicate/i.test(error.message)) throw new Error("Some attendance records were already consumed by another labour due. Refresh the preview.");
              throw error;
            }
            phases.attendanceSourceInsert = performance.now() - sourceLinkStartedAt;
          }
          const accountingStartedAt = performance.now();
          await postLabourDueRecognition(tx, {
            workspaceId,
            farmId: input.farmId,
            seasonId: input.seasonId,
            dueId: created!.id,
            amount: Math.max(
              grossAmount - input.authorizedDeductions,
              0,
            ),
            actorId: request.appUser!.id,
          });
          phases.accountingPosting = performance.now() - accountingStartedAt;
          await tx
            .insert(auditLogs)
            .values({
              workspaceId,
              farmId: input.farmId,
              userId: request.appUser!.id,
              actorUserId: request.appUser!.id,
              action: "labour_due_created",
              entityType: "labour_due",
              entityId: created!.id,
              afterJson: created as unknown as Record<string, unknown>,
            });
          if (sourceRows.length) {
            const attendanceLockStartedAt = performance.now();
            await tx.execute(sql`UPDATE operational_records SET payload = payload || jsonb_build_object('labourDueId', ${created!.id}, 'labourDueNumber', ${dueNumber}, 'labourDueLockedAt', ${new Date().toISOString()}), updated_at = now() WHERE workspace_id = ${workspaceId} AND id IN (${sql.join(sourceRows.map((row) => sql`${row.id}::uuid`), sql`, `)})`);
            phases.attendanceBulkLock = performance.now() - attendanceLockStartedAt;
          }
          return created!;
        });
        phases.transaction = performance.now() - transactionStartedAt;
        const position = await db.transaction((tx) => loadLabourDuePosition(tx, due.id));
        const responseDue = position
          ? { ...due, ...position, due: undefined }
          : { ...due, outstandingBalance: Math.max(Number(due.grossAmount) - Number(due.authorizedDeductions), 0), previousPayments: 0, advancesApplied: 0 };
        const total = performance.now() - requestStartedAt;
        reply.header("Server-Timing", Object.entries(phases).map(([name, duration]) => `${name};dur=${duration.toFixed(1)}`).concat(`total;dur=${total.toFixed(1)}`).join(", "));
        request.log.info({ event: "labour_due_create_timing", dueId: due.id, source: input.source, memberCount, attendanceCount, phases, totalMs: total, sqlShape: "fixed-set-based" });
        return reply.code(201).send({ due: responseDue, performance: { totalMs: total, transactionMs: phases.transaction, attendanceCount, memberCount, sqlShape: "fixed-set-based" } });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to create the labour due.";
        const recipientField = /labourer/i.test(message) ? "labourerId" : /group/i.test(message) ? "labourGroupId" : /recipient|crew|contractor|batch identity/i.test(message) ? "recipientReference" : null;
        return reply
          .code(400)
          .send({
            message: recipientField ? "Please correct the highlighted fields." : message,
            errors: recipientField ? { [recipientField]: message } : undefined,
          });
      }
    },
  );

  app.get(
    "/v1/workspace/:workspaceId/labour-payments/dues/:dueId/advance-pool",
    { preHandler: requireUser },
    async (request, reply) => {
      const params = dueParamsSchema.safeParse(request.params);
      const query = advancePoolQuerySchema.safeParse(request.query);
      if (!params.success || !query.success) return reply.code(400).send({ message: "A valid advance-pool request is required." });
      if (!(await requireRequestScope(request, reply, params.data.workspaceId, query.data.farmId, query.data.seasonId, "view"))) return;
      const [due] = await db.select().from(labourDues).where(and(
        eq(labourDues.id, params.data.dueId),
        eq(labourDues.workspaceId, params.data.workspaceId),
        eq(labourDues.farmId, query.data.farmId),
        eq(labourDues.seasonId, query.data.seasonId),
      )).limit(1);
      if (!due) return reply.code(404).send({ message: "Labour due was not found." });
      const pool = await db.transaction((tx) => loadDueAdvancePool(tx, due, query.data.amount, query.data.settlementDate ?? new Date().toISOString().slice(0, 10)));
      const start = (query.data.page - 1) * query.data.pageSize;
      const details = query.data.amount == null ? undefined : pool.allocations.slice(start, start + query.data.pageSize);
      return {
        pool: {
          globalOutstanding: pool.globalOutstanding,
          eligibleTotal: pool.eligibleTotal,
          eligibleOpenCount: pool.eligibleOpenCount,
          groupLevelAmount: pool.groupLevelAmount,
          memberLevelAmount: pool.memberLevelAmount,
          maximumApplicable: pool.maximumApplicable,
          defaultApplyAmount: pool.maximumApplicable,
          proposedApplication: pool.proposedApplication,
          carriedForwardAmount: pool.carriedForwardAmount,
          remainingAfterAdvances: pool.remainingAfterAdvances,
          allocationPreviewVersion: pool.allocationPreviewVersion,
          proposedAllocationCount: pool.allocations.length,
          exclusionTotals: pool.exclusionTotals,
        },
        ...(details ? { details, pageInfo: { page: query.data.page, pageSize: query.data.pageSize, totalCount: pool.allocations.length, hasMore: start + query.data.pageSize < pool.allocations.length } } : {}),
      };
    },
  );

  app.post(
    "/v1/workspace/:workspaceId/labour-payments/dues/:dueId/settle",
    { preHandler: requireUser },
    async (request, reply) => {
      const params = dueParamsSchema.safeParse(request.params);
      const body = settleSchema.safeParse(request.body);
      if (
        !params.success ||
        !body.success ||
        (!body.data.payment && !body.data.advancePool && body.data.advanceApplications.length === 0)
      )
        return reply
          .code(400)
          .send({ message: "Select an advance or enter a payment." });
      const { workspaceId, dueId } = params.data;
      const input = body.data;
      if (
        !(await requireRequestScope(
          request,
          reply,
          workspaceId,
          input.farmId,
          input.seasonId,
          "create",
        ))
      )
        return;
      const persistence = {
        endpoint: "POST /v1/workspace/:workspaceId/labour-payments/dues/:dueId/settle",
        operation: "transaction_start",
        allocationCount: input.advanceApplications.length,
        requestedAdvanceAmount: input.advancePool?.amount ?? input.advanceApplications.reduce((sum, item) => sum + item.amount, 0),
      };
      try {
        const result = await db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtext(${`${workspaceId}:${input.farmId}:${input.seasonId}:labour-payment-posting`}), 1)`,
          );
          await tx.select({ id: labourDues.id }).from(labourDues).where(and(
            eq(labourDues.id, dueId),
            eq(labourDues.workspaceId, workspaceId),
          )).for("update");
          let position = await loadLabourDuePosition(tx, dueId);
          if (
            !position ||
            position.due.workspaceId !== workspaceId ||
            position.due.farmId !== input.farmId ||
            position.due.seasonId !== input.seasonId
          )
            throw new Error("Labour due was not found.");
          if (input.advancePool) {
            const [completed] = await tx.select().from(auditLogs).where(and(
              eq(auditLogs.workspaceId, workspaceId),
              eq(auditLogs.action, "labour_due_settled"),
              eq(auditLogs.entityId, dueId),
              sql`${auditLogs.details}->'advancePool'->>'idempotencyKey' = ${input.advancePool.idempotencyKey}`,
            )).limit(1);
            if (completed) {
              const details = completed.details as Record<string, unknown>;
              const poolDetails = details.advancePool as Record<string, unknown> | undefined;
              if (Math.abs(Number(poolDetails?.requestedAmount ?? 0) - input.advancePool.amount) > 0.005)
                throw new Error("The settlement idempotency key was already used for a different amount.");
              const voucherId = typeof details.voucherId === "string" ? details.voucherId : null;
              const [existingVoucher] = voucherId ? await tx.select().from(labourPaymentVouchers).where(eq(labourPaymentVouchers.id, voucherId)).limit(1) : [];
              return { due: position, voucher: existingVoucher ?? null, settlementSummary: details.settlementSummary ?? null };
            }
          }
          if (["VOIDED", "ON_HOLD"].includes(position.due.paymentStatus))
            throw new Error(
              "This labour due cannot be settled in its current status.",
            );
          let requestedApplications = input.advanceApplications;
          let aggregatePlan: ReturnType<typeof calculateLabourAdvancePool> | null = null;
          if (input.advancePool) {
            aggregatePlan = await loadDueAdvancePool(tx, position.due, input.advancePool.amount, input.advancePool.settlementDate ?? new Date().toISOString().slice(0, 10));
            if (input.advancePool.amount > aggregatePlan.maximumApplicable + 0.005)
              throw new Error("Advance application exceeds the eligible advance pool or current due balance.");
            if (Math.abs(aggregatePlan.proposedApplication - input.advancePool.amount) > 0.005)
              throw new Error("The requested advance amount could not be allocated to eligible vouchers.");
            requestedApplications = aggregatePlan.allocations.map((allocation) => ({
              advanceVoucherId: allocation.id,
              amount: allocation.proposedAmount,
              idempotencyKey: allocationIdempotencyKey(input.advancePool!.idempotencyKey, allocation.id),
            }));
            persistence.allocationCount = requestedApplications.length;
            if (requestedApplications.length) {
              const locked = await tx.select({ id: labourPaymentVouchers.id }).from(labourPaymentVouchers).where(and(
                eq(labourPaymentVouchers.workspaceId, workspaceId),
                eq(labourPaymentVouchers.farmId, input.farmId),
                eq(labourPaymentVouchers.seasonId, input.seasonId),
                inArray(labourPaymentVouchers.id, requestedApplications.map((application) => application.advanceVoucherId)),
              )).for("update");
              if (locked.length !== requestedApplications.length)
                throw new Error("One or more selected advances are no longer structurally valid.");
              aggregatePlan = await loadDueAdvancePool(tx, position.due, input.advancePool.amount, input.advancePool.settlementDate ?? new Date().toISOString().slice(0, 10));
              if (Math.abs(aggregatePlan.proposedApplication - input.advancePool.amount) > 0.005)
                throw new Error("The usable advance pool changed while posting. Review the refreshed allocation before retrying.");
              requestedApplications = aggregatePlan.allocations.map((allocation) => ({
                advanceVoucherId: allocation.id,
                amount: allocation.proposedAmount,
                idempotencyKey: allocationIdempotencyKey(input.advancePool!.idempotencyKey, allocation.id),
              }));
            }
          }
          const memberIds = new Set(dueMemberPayableShares(position.due).map((row) => row.labourerId));
          if (input.advancePool && requestedApplications.length) {
            const createdApplications: Array<typeof labourAdvanceApplications.$inferSelect> = [];
            for (let offset = 0; offset < requestedApplications.length; offset += 40) {
              const batch = requestedApplications.slice(offset, offset + 40);
              persistence.operation = `advance_application_insert_batch_${Math.floor(offset / 40) + 1}`;
              const inserted = await tx.insert(labourAdvanceApplications).values(batch.map((application) => ({
                workspaceId,
                advanceVoucherId: application.advanceVoucherId,
                dueId,
                amount: application.amount.toFixed(2),
                idempotencyKey: application.idempotencyKey,
                status: "ACTIVE",
              }))).returning();
              createdApplications.push(...inserted);
            }
            persistence.operation = "advance_application_accounting";
            await postLabourAdvanceApplicationJournals(tx, {
              workspaceId, farmId: input.farmId, seasonId: input.seasonId, actorId: request.appUser!.id,
              applications: createdApplications.map((application) => ({ id: application.id, dueId, amount: Number(application.amount) })),
            });
            position = (await loadLabourDuePosition(tx, dueId))!;
          }
          for (const application of input.advancePool ? [] : requestedApplications) {
            const [existingApplication] = await tx
              .select()
              .from(labourAdvanceApplications)
              .where(
                and(
                  eq(labourAdvanceApplications.workspaceId, workspaceId),
                  eq(
                    labourAdvanceApplications.idempotencyKey,
                    application.idempotencyKey,
                  ),
                ),
              )
              .limit(1);
            if (existingApplication) {
              if (
                existingApplication.dueId !== dueId ||
                existingApplication.advanceVoucherId !==
                  application.advanceVoucherId ||
                Math.abs(
                  Number(existingApplication.amount) - application.amount,
                ) > 0.005
              )
                throw new Error(
                  "The advance application idempotency key was already used for a different allocation.",
                );
              continue;
            }
            const [advance] = await tx
              .select()
              .from(labourPaymentVouchers)
              .where(
                and(
                  eq(labourPaymentVouchers.id, application.advanceVoucherId),
                  eq(labourPaymentVouchers.workspaceId, workspaceId),
                  eq(labourPaymentVouchers.farmId, input.farmId),
                  eq(labourPaymentVouchers.seasonId, input.seasonId),
                ),
              )
              .limit(1);
            if (
              !advance ||
              advance.nature !== "ADVANCE" ||
              advance.status !== "POSTED"
            )
              throw new Error("The selected advance is not available.");
            if (advance.financialScopeKey !== position.due.financialScopeKey && !(position.due.recipientScope === "LABOUR_GROUP" && advance.labourerId && memberIds.has(advance.labourerId)))
              throw new Error(
                "An advance may only be applied to a due for the same financial scope.",
              );
            const [applied] = await tx
              .select({
                total: sql<number>`coalesce(sum(${labourAdvanceApplications.amount}) filter (where ${labourAdvanceApplications.status} = 'ACTIVE'), 0)::numeric`,
              })
              .from(labourAdvanceApplications)
              .where(
                eq(labourAdvanceApplications.advanceVoucherId, advance.id),
              );
            const [refunded] = await tx
              .select({
                total: sql<number>`coalesce(sum(${labourPaymentVouchers.paymentAmount}) filter (where ${labourPaymentVouchers.status} = 'POSTED' and ${labourPaymentVouchers.nature} = 'REFUND_RECOVERY'), 0)::numeric`,
              })
              .from(labourPaymentVouchers)
              .where(
                eq(labourPaymentVouchers.relatedAdvanceVoucherId, advance.id),
              );
            const available = Math.max(
              Number(advance.paymentAmount) -
                Number(applied?.total ?? 0) -
                Number(refunded?.total ?? 0),
              0,
            );
            if (application.amount > available + 0.005)
              throw new Error(
                "Advance application exceeds the available advance balance.",
              );
            if (application.amount > position.outstandingBalance + 0.005)
              throw new Error(
                "Advance application exceeds the current due balance.",
              );
            const [createdApplication] = await tx
              .insert(labourAdvanceApplications)
              .values({
                workspaceId,
                advanceVoucherId: advance.id,
                dueId,
                amount: application.amount.toFixed(2),
                idempotencyKey: application.idempotencyKey,
                status: "ACTIVE",
              })
              .returning();
            await postLabourAdvanceApplicationJournal(tx, {
              workspaceId,
              farmId: input.farmId,
              seasonId: input.seasonId,
              dueId,
              advanceApplicationId: createdApplication!.id,
              amount: application.amount,
              actorId: request.appUser!.id,
            });
            position = (await loadLabourDuePosition(tx, dueId))!;
          }
          let voucher = null;
          if (input.payment) {
            persistence.operation = "payment_idempotency_check";
            const [existingVoucher] = await tx
              .select()
              .from(labourPaymentVouchers)
              .where(
                and(
                  eq(labourPaymentVouchers.workspaceId, workspaceId),
                  eq(
                    labourPaymentVouchers.idempotencyKey,
                    input.payment.idempotencyKey,
                  ),
                ),
              )
              .limit(1);
            if (existingVoucher) {
              if (
                existingVoucher.linkedDueId !== dueId ||
                Math.abs(
                  Number(existingVoucher.paymentAmount) - input.payment.amount,
                ) > 0.005
              )
                throw new Error(
                  "The payment idempotency key was already used for a different payment.",
                );
              voucher = existingVoucher;
            } else {
              position = (await loadLabourDuePosition(tx, dueId))!;
              if (input.payment.amount > position.outstandingBalance + 0.005)
                throw new Error(
                  "Payment exceeds the current outstanding due balance.",
                );
              const account = await validatedAccount(
                tx,
                workspaceId,
                input.farmId,
                input.payment.paymentAccountId,
              );
              const voucherNumber = await allocateLabourPaymentVoucherNumber(
                tx,
                workspaceId,
                input.farmId,
              );
              const nature =
                position.due.origin === "DIRECT"
                  ? "DIRECT_LABOUR_PAYMENT"
                  : "SETTLEMENT_BALANCE_PAYMENT";
              persistence.operation = "lpv_insert";
              const [created] = await tx
                .insert(labourPaymentVouchers)
                .values({
                  workspaceId,
                  farmId: input.farmId,
                  seasonId: input.seasonId,
                  voucherNumber,
                  voucherDate: input.payment.voucherDate,
                  nature,
                  status: "POSTED",
                  recipientScope: position.due.recipientScope,
                  financialScopeKey: position.due.financialScopeKey,
                  labourerId: position.due.labourerId,
                  labourGroupId: position.due.labourGroupId,
                  recipientSnapshot: position.due.recipientSnapshot,
                  description:
                    input.payment.description ||
                    `Payment for ${position.due.dueNumber}`,
                  paymentAmount: input.payment.amount.toFixed(2),
                  paymentAccountId: account.id,
                  paymentMethod: input.payment.paymentMethod,
                  transactionReference: input.payment.transactionReference,
                  sourceType:
                    position.due.origin === "DIRECT"
                      ? "DIRECT_DUE"
                      : "SETTLEMENT",
                  sourceId: position.due.sourceClientRecordId,
                  linkedDueId: dueId,
                  idempotencyKey: input.payment.idempotencyKey,
                  createdBy: request.appUser!.id,
                  postedBy: request.appUser!.id,
                  postedAt: new Date(),
                  reconciliationStatus: "RECONCILED",
                })
                .returning();
              persistence.operation = "lpv_accounting";
              await postLabourVoucherJournal(tx, {
                workspaceId,
                farmId: input.farmId,
                seasonId: input.seasonId,
                voucherId: created!.id,
                nature,
                amount: input.payment.amount,
                accountType: account.accountType,
                actorId: request.appUser!.id,
                dueId,
              });
              persistence.operation = "funding_account_movement";
              const accountTransactionId = await insertAccountMovement(tx, {
                farmId: input.farmId,
                seasonId: input.seasonId,
                voucherId: created!.id,
                voucherNumber,
                voucherDate: input.payment.voucherDate,
                amount: input.payment.amount,
                account,
                actorId: request.appUser!.id,
              });
              await tx
                .update(labourPaymentVouchers)
                .set({ accountTransactionId })
                .where(eq(labourPaymentVouchers.id, created!.id));
              persistence.operation = "due_payment_allocation";
              await tx
                .insert(labourPaymentAllocations)
                .values({
                  workspaceId,
                  voucherId: created!.id,
                  dueId,
                  amount: input.payment.amount.toFixed(2),
                  status: "ACTIVE",
                });
              voucher = { ...created!, accountTransactionId };
            }
          }
          persistence.operation = "due_status_refresh";
          const refreshed = await refreshLabourDuePaymentStatus(tx, dueId);
          persistence.operation = "settlement_audit";
          const settlementSummary = {
            dueId,
            dueNumber: refreshed.due.dueNumber,
            grossDue: Number(refreshed.due.grossAmount),
            advanceAmountApplied: input.advancePool?.amount ?? requestedApplications.reduce((sum, application) => sum + application.amount, 0),
            advanceVoucherCount: requestedApplications.length,
            fullyConsumedAdvanceCount: aggregatePlan?.allocations.filter((allocation) => allocation.remainingAmount <= 0.005).length ?? 0,
            partiallyConsumedAdvanceCount: aggregatePlan?.allocations.filter((allocation) => allocation.remainingAmount > 0.005).length ?? 0,
            advanceAmountCarriedForward: aggregatePlan?.carriedForwardAmount ?? 0,
            cashPaymentPosted: input.payment?.amount ?? 0,
            remainingDue: refreshed.outstandingBalance,
            finalStatus: refreshed.paymentStatus,
          };
          await tx
            .insert(auditLogs)
            .values({
              workspaceId,
              farmId: input.farmId,
              userId: request.appUser!.id,
              actorUserId: request.appUser!.id,
              action: "labour_due_settled",
              entityType: "labour_due",
              entityId: dueId,
              details: {
                voucherId: voucher?.id ?? null,
                advancePool: input.advancePool ? {
                  idempotencyKey: input.advancePool.idempotencyKey,
                  requestedAmount: input.advancePool.amount,
                  allocationPolicy: "GROUP_OLDEST_FIRST_THEN_MEMBER_OLDEST_FIRST",
                  allocations: aggregatePlan?.allocations.map((allocation) => ({ voucherId: allocation.id, amount: allocation.proposedAmount, order: allocation.allocationOrder, ownership: allocation.ownership })) ?? [],
                } : null,
                advanceApplications: requestedApplications,
                outstandingBalance: refreshed.outstandingBalance,
                settlementSummary,
              },
            });
          return { due: refreshed, voucher, settlementSummary };
        });
        return { result };
      } catch (error) {
        const database = labourPaymentDatabaseError(error);
        if (database) request.log.error({
          event: "labour_advance_pool_persistence_failed",
          requestId: request.id,
          workspaceId,
          farmId: input.farmId,
          seasonId: input.seasonId,
          dueId,
          ...persistence,
          database,
        }, "Labour advance pool persistence failed and was rolled back");
        return reply
          .code(409)
          .send({
            message: database
              ? input.payment
                ? `Labour Due settlement was not posted. No balances were changed. Reference: ${request.id}.`
                : `Advances were not applied. No balances were changed. Reference: ${request.id}.`
              : error instanceof Error ? error.message : "Unable to settle the labour due.",
            requestId: request.id,
          });
      }
    },
  );

  app.patch(
    "/v1/workspace/:workspaceId/labour-payments/dues/:dueId/hold",
    { preHandler: requireUser },
    async (request, reply) => {
      const params = dueParamsSchema.safeParse(request.params);
      const query = contextSchema.safeParse(request.query);
      const body = holdSchema.safeParse(request.body);
      if (!params.success || !query.success || !body.success)
        return reply
          .code(400)
          .send({ message: "A valid hold request is required." });
      if (
        !(await requireRequestScope(
          request,
          reply,
          params.data.workspaceId,
          query.data.farmId,
          query.data.seasonId,
          "edit",
        ))
      )
        return;
      const [due] = await db
        .update(labourDues)
        .set({
          paymentStatus: body.data.hold ? "ON_HOLD" : "UNPAID",
          holdReason: body.data.hold ? (body.data.reason ?? "") : null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(labourDues.id, params.data.dueId),
            eq(labourDues.workspaceId, params.data.workspaceId),
            eq(labourDues.farmId, query.data.farmId),
            eq(labourDues.seasonId, query.data.seasonId),
          ),
        )
        .returning();
      if (!due)
        return reply.code(404).send({ message: "Labour due was not found." });
      if (!body.data.hold)
        await db.transaction((tx) => refreshLabourDuePaymentStatus(tx, due.id));
      return { due };
    },
  );

  app.post(
    "/v1/workspace/:workspaceId/labour-payments/dues/:dueId/void",
    { preHandler: requireUser },
    async (request, reply) => {
      const params = dueParamsSchema.safeParse(request.params);
      const query = contextSchema.safeParse(request.query);
      const body = voidSchema.safeParse(request.body);
      if (!params.success || !query.success || !body.success)
        return reply
          .code(400)
          .send({ message: "A valid due void request is required." });
      if (
        !(await requireRequestScope(
          request,
          reply,
          params.data.workspaceId,
          query.data.farmId,
          query.data.seasonId,
          "delete",
        ))
      )
        return;
      try {
        const due = await db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtext(${`${params.data.workspaceId}:${query.data.farmId}:${query.data.seasonId}:labour-payment-posting`}), 1)`,
          );
          const [record] = await tx
            .select()
            .from(labourDues)
            .where(
              and(
                eq(labourDues.id, params.data.dueId),
                eq(labourDues.workspaceId, params.data.workspaceId),
                eq(labourDues.farmId, query.data.farmId),
                eq(labourDues.seasonId, query.data.seasonId),
              ),
            )
            .limit(1);
          if (!record) throw new Error("Labour due was not found.");
          if (record.paymentStatus === "VOIDED") return record;
          if (record.origin === "SETTLEMENT" && record.sourceRecordId)
            throw new Error(
              "Void the source Labour Settlement so attendance, expense, and advance eligibility are restored together.",
            );
          const [activePayment, activeAdvance] = await Promise.all([
            tx
              .select({ id: labourPaymentAllocations.id })
              .from(labourPaymentAllocations)
              .where(
                and(
                  eq(labourPaymentAllocations.dueId, record.id),
                  eq(labourPaymentAllocations.status, "ACTIVE"),
                ),
              )
              .limit(1),
            tx
              .select({ id: labourAdvanceApplications.id })
              .from(labourAdvanceApplications)
              .where(
                and(
                  eq(labourAdvanceApplications.dueId, record.id),
                  eq(labourAdvanceApplications.status, "ACTIVE"),
                ),
              )
              .limit(1),
          ]);
          if (activePayment.length)
            throw new Error(
              "Void linked payment vouchers before voiding this due.",
            );
          if (activeAdvance.length)
            throw new Error(
              "Reverse linked advance applications before voiding this due.",
            );
          const now = new Date();
          const [voided] = await tx
            .update(labourDues)
            .set({
              calculationStatus: "VOIDED",
              paymentStatus: "VOIDED",
              voidReason: body.data.reason,
              voidedAt: now,
              voidedBy: request.appUser!.id,
              updatedAt: now,
            })
            .where(eq(labourDues.id, record.id))
            .returning();
          await reverseLabourJournal(tx, {
            workspaceId: params.data.workspaceId,
            farmId: query.data.farmId,
            seasonId: query.data.seasonId,
            actorId: request.appUser!.id,
            reversalKey: `due-void:${record.id}:${body.data.idempotencyKey}`,
            originalEventKey: `due:${record.id}`,
          });
          const snapshot = record.recipientSnapshot as Record<string, unknown>;
          const sourceAttendanceIds = Array.isArray(snapshot.sourceAttendanceIds)
            ? snapshot.sourceAttendanceIds.filter((value): value is string => typeof value === "string")
            : [];
          if (sourceAttendanceIds.length) {
            await tx.delete(labourDueAttendanceSources).where(eq(labourDueAttendanceSources.dueId, record.id));
            await tx.execute(sql`UPDATE operational_records SET payload = payload - 'labourDueId' - 'labourDueNumber' - 'labourDueLockedAt', updated_at = now() WHERE workspace_id = ${params.data.workspaceId} AND client_record_id IN (${sql.join(sourceAttendanceIds.map((id) => sql`${id}`), sql`, `)}) AND payload->>'labourDueId' = ${record.id}`);
          }
          await tx
            .insert(auditLogs)
            .values({
              workspaceId: params.data.workspaceId,
              farmId: query.data.farmId,
              userId: request.appUser!.id,
              actorUserId: request.appUser!.id,
              action: "labour_due_voided",
              entityType: "labour_due",
              entityId: record.id,
              details: {
                reason: body.data.reason,
                idempotencyKey: body.data.idempotencyKey,
              },
            });
          return voided!;
        });
        return { due };
      } catch (error) {
        return reply
          .code(409)
          .send({
            message:
              error instanceof Error
                ? error.message
                : "Unable to void the labour due.",
          });
      }
    },
  );

  app.post(
    "/v1/workspace/:workspaceId/labour-payments/dues/:dueId/advance-applications/:applicationId/reverse",
    { preHandler: requireUser },
    async (request, reply) => {
      const params = advanceApplicationParamsSchema.safeParse(request.params);
      const query = contextSchema.safeParse(request.query);
      const body = voidSchema.safeParse(request.body);
      if (!params.success || !query.success || !body.success)
        return reply
          .code(400)
          .send({
            message: "A valid advance application reversal is required.",
          });
      if (
        !(await requireRequestScope(
          request,
          reply,
          params.data.workspaceId,
          query.data.farmId,
          query.data.seasonId,
          "edit",
        ))
      )
        return;
      try {
        const result = await db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtext(${`${params.data.workspaceId}:${query.data.farmId}:${query.data.seasonId}:labour-payment-posting`}), 1)`,
          );
          const [application] = await tx
            .select({ application: labourAdvanceApplications, due: labourDues })
            .from(labourAdvanceApplications)
            .innerJoin(
              labourDues,
              eq(labourDues.id, labourAdvanceApplications.dueId),
            )
            .where(
              and(
                eq(labourAdvanceApplications.id, params.data.applicationId),
                eq(labourAdvanceApplications.dueId, params.data.dueId),
                eq(
                  labourAdvanceApplications.workspaceId,
                  params.data.workspaceId,
                ),
                eq(labourDues.farmId, query.data.farmId),
                eq(labourDues.seasonId, query.data.seasonId),
              ),
            )
            .limit(1);
          if (!application)
            throw new Error("Advance application was not found.");
          if (application.application.status === "REVERSED")
            return {
              application: application.application,
              due: await loadLabourDuePosition(tx, params.data.dueId),
            };
          const now = new Date();
          const [reversed] = await tx
            .update(labourAdvanceApplications)
            .set({
              status: "REVERSED",
              reversedAt: now,
              reversedBy: request.appUser!.id,
              updatedAt: now,
            })
            .where(eq(labourAdvanceApplications.id, application.application.id))
            .returning();
          await reverseLabourJournal(tx, {
            workspaceId: params.data.workspaceId,
            farmId: query.data.farmId,
            seasonId: query.data.seasonId,
            actorId: request.appUser!.id,
            reversalKey: `advance-application-reversal:${body.data.idempotencyKey}`,
            originalEventKey: `advance-application:${application.application.id}`,
          });
          const due = await refreshLabourDuePaymentStatus(
            tx,
            params.data.dueId,
          );
          await tx
            .insert(auditLogs)
            .values({
              workspaceId: params.data.workspaceId,
              farmId: query.data.farmId,
              userId: request.appUser!.id,
              actorUserId: request.appUser!.id,
              action: "labour_advance_application_reversed",
              entityType: "labour_advance_application",
              entityId: application.application.id,
              details: {
                reason: body.data.reason,
                idempotencyKey: body.data.idempotencyKey,
              },
            });
          return { application: reversed!, due };
        });
        return { result };
      } catch (error) {
        return reply
          .code(409)
          .send({
            message:
              error instanceof Error
                ? error.message
                : "Unable to reverse the advance application.",
          });
      }
    },
  );

  app.post(
    "/v1/workspace/:workspaceId/labour-payments/advance-application-events/:eventId/reverse",
    { preHandler: requireUser },
    async (request, reply) => {
      const params = advanceApplicationEventParamsSchema.safeParse(request.params);
      const query = contextSchema.safeParse(request.query);
      const body = voidSchema.safeParse(request.body);
      if (!params.success || !query.success || !body.success)
        return reply.code(400).send({ message: "A valid aggregate advance application reversal is required." });
      if (!(await requireRequestScope(request, reply, params.data.workspaceId, query.data.farmId, query.data.seasonId, "edit"))) return;
      try {
        const result = await db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtext(${`${params.data.workspaceId}:${query.data.farmId}:${query.data.seasonId}:labour-payment-posting`}), 1)`,
          );
          const [eventLog] = await tx
            .select()
            .from(auditLogs)
            .where(
              and(
                eq(auditLogs.id, params.data.eventId),
                eq(auditLogs.workspaceId, params.data.workspaceId),
                eq(auditLogs.farmId, query.data.farmId),
                eq(auditLogs.action, "labour_due_settled"),
                eq(auditLogs.entityType, "labour_due"),
              ),
            )
            .limit(1);
          if (!eventLog?.entityId) throw new Error("Aggregate advance application event was not found.");
          const details = asSnapshot(eventLog.details);
          const advancePool = asSnapshot(details.advancePool);
          if (!firstText(advancePool.idempotencyKey)) throw new Error("This event does not contain an aggregate advance application.");
          const applicationSpecs = Array.isArray(details.advanceApplications) ? details.advanceApplications : [];
          const applicationKeys = applicationSpecs
            .map((value) => (value && typeof value === "object" && typeof (value as Record<string, unknown>).idempotencyKey === "string" ? (value as Record<string, unknown>).idempotencyKey as string : null))
            .filter((value): value is string => Boolean(value));
          const [due] = await tx
            .select()
            .from(labourDues)
            .where(
              and(
                eq(labourDues.id, eventLog.entityId),
                eq(labourDues.workspaceId, params.data.workspaceId),
                eq(labourDues.farmId, query.data.farmId),
                eq(labourDues.seasonId, query.data.seasonId),
              ),
            )
            .limit(1);
          if (!due) throw new Error("The related labour due was not found.");
          const childApplications = applicationKeys.length
            ? await tx
              .select()
              .from(labourAdvanceApplications)
              .where(
                and(
                  eq(labourAdvanceApplications.workspaceId, params.data.workspaceId),
                  eq(labourAdvanceApplications.dueId, due.id),
                  inArray(labourAdvanceApplications.idempotencyKey, applicationKeys),
                ),
              )
            : [];
          const activeChildren = childApplications.filter((application) => application.status === "ACTIVE");
          if (activeChildren.length) {
            const now = new Date();
            for (const application of activeChildren) {
              await tx
                .update(labourAdvanceApplications)
                .set({
                  status: "REVERSED",
                  reversedAt: now,
                  reversedBy: request.appUser!.id,
                  updatedAt: now,
                })
                .where(eq(labourAdvanceApplications.id, application.id));
              await reverseLabourJournal(tx, {
                workspaceId: params.data.workspaceId,
                farmId: query.data.farmId,
                seasonId: query.data.seasonId,
                actorId: request.appUser!.id,
                reversalKey: `advance-application-event-reversal:${params.data.eventId}:${body.data.idempotencyKey}:${application.id}`,
                originalEventKey: `advance-application:${application.id}`,
              });
            }
          }
          const duePosition = await refreshLabourDuePaymentStatus(tx, due.id);
          const [existingParentVoucher] = await tx
            .select()
            .from(labourPaymentVouchers)
            .where(
              and(
                eq(labourPaymentVouchers.workspaceId, params.data.workspaceId),
                eq(labourPaymentVouchers.linkedDueId, due.id),
                eq(labourPaymentVouchers.nature, "ADVANCE_APPLICATION"),
                eq(labourPaymentVouchers.sourceId, String(advancePool.idempotencyKey)),
              ),
            )
            .limit(1);
          if (existingParentVoucher && existingParentVoucher.status !== "VOIDED") {
            await tx
              .update(labourPaymentVouchers)
              .set({
                status: "VOIDED",
                voidReason: body.data.reason,
                voidedAt: new Date(),
                voidedBy: request.appUser!.id,
                updatedAt: new Date(),
              })
              .where(eq(labourPaymentVouchers.id, existingParentVoucher.id));
          }
          await tx.insert(auditLogs).values({
            workspaceId: params.data.workspaceId,
            farmId: query.data.farmId,
            userId: request.appUser!.id,
            actorUserId: request.appUser!.id,
            action: "labour_advance_application_event_reversed",
            entityType: "labour_advance_application_event",
            entityId: params.data.eventId,
            details: {
              reason: body.data.reason,
              idempotencyKey: body.data.idempotencyKey,
              parentEventId: params.data.eventId,
              reversedApplicationIds: activeChildren.map((application) => application.id),
            },
          });
          return {
            eventId: params.data.eventId,
            reversedApplicationCount: activeChildren.length,
            due: duePosition,
          };
        });
        return { result };
      } catch (error) {
        return reply.code(409).send({
          message: error instanceof Error ? error.message : "Unable to reverse the aggregate advance application.",
        });
      }
    },
  );

  app.post(
    "/v1/workspace/:workspaceId/labour-payments/advances",
    { preHandler: requireUser },
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      const body = advanceSchema.safeParse(request.body);
      if (!params.success)
        return reply
          .code(400)
          .send({ message: "A valid workspace is required." });
      if (!body.success)
        return reply
          .code(400)
          .send({
            message: "Check the highlighted advance fields.",
            fields: Object.keys(body.error.flatten().fieldErrors),
            details: body.error.flatten().fieldErrors,
          });
      const { workspaceId } = params.data;
      const input = body.data;
      if (
        !(await requireRequestScope(
          request,
          reply,
          workspaceId,
          input.farmId,
          input.seasonId,
          "create",
        ))
      )
        return;
      try {
        const voucher = await db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtext(${`${workspaceId}:${input.farmId}:${input.seasonId}:labour-payment-posting`}), 1)`,
          );
          const [existing] = await tx
            .select()
            .from(labourPaymentVouchers)
            .where(
              and(
                eq(labourPaymentVouchers.workspaceId, workspaceId),
                eq(labourPaymentVouchers.idempotencyKey, input.idempotencyKey),
              ),
            )
            .limit(1);
          if (existing) {
            if (
              existing.nature !== "ADVANCE" ||
              Math.abs(Number(existing.paymentAmount) - input.amount) > 0.005
            )
              throw new Error(
                "The idempotency key was already used for a different Labour Payment Voucher.",
              );
            return existing;
          }
          const recipient = await loadRecipient(tx, workspaceId, input.farmId, {
            ...input,
            requireReceivedBy: true,
          });
          const account = await validatedAccount(
            tx,
            workspaceId,
            input.farmId,
            input.paymentAccountId,
          );
          const clientRecordId = crypto.randomUUID();
          const now = new Date();
          const [sourceRecord] = await tx
            .insert(operationalRecords)
            .values({
              workspaceId,
              farmId: input.farmId,
              seasonId: input.seasonId,
              clientRecordId,
              entityType: "advance",
              recordedBy: request.appUser!.id,
              clientUpdatedAt: now,
              payload: {
                id: clientRecordId,
                workspaceId,
                farmId: input.farmId,
                seasonId: input.seasonId,
                labourerId: input.labourerId ?? null,
                labourGroupId: input.labourGroupId ?? null,
                receivedByLabourerId: input.receivedByLabourerId ?? null,
                receivedByNameSnapshot: recipient.snapshot.receivedByNameSnapshot,
                labourGroupName: recipient.snapshot.labourGroupName,
                recipientScope: input.recipientScope,
                financialScopeKey: recipient.financialScopeKey,
                recipientSnapshot: recipient.snapshot,
                date: input.voucherDate,
                amount: input.amount,
                accountId: account.id,
                sourceAccountName: account.name,
                paymentMethod: input.paymentMethod,
                notes: input.description,
                status: "posted",
                createdBy: request.appUser!.id,
                createdAt: now.toISOString(),
                updatedAt: now.toISOString(),
              },
            })
            .returning();
          const voucherNumber = await allocateLabourAdvanceVoucherNumber(
            tx,
            workspaceId,
            input.farmId,
          );
          const [created] = await tx
            .insert(labourPaymentVouchers)
            .values({
              workspaceId,
              farmId: input.farmId,
              seasonId: input.seasonId,
              voucherNumber,
              voucherDate: input.voucherDate,
              nature: "ADVANCE",
              status: "POSTED",
              recipientScope: input.recipientScope,
              financialScopeKey: recipient.financialScopeKey,
              labourerId: input.labourerId,
              labourGroupId: input.labourGroupId,
              recipientSnapshot: recipient.snapshot,
              description: input.description,
              paymentAmount: input.amount.toFixed(2),
              paymentAccountId: account.id,
              paymentMethod: input.paymentMethod,
              transactionReference: input.transactionReference,
              sourceType: "ADVANCE",
              sourceId: clientRecordId,
              legacySourceRecordId: sourceRecord!.id,
              idempotencyKey: input.idempotencyKey,
              createdBy: request.appUser!.id,
              postedBy: request.appUser!.id,
              postedAt: now,
              reconciliationStatus: "RECONCILED",
            })
            .returning();
          await postLabourVoucherJournal(tx, {
            workspaceId,
            farmId: input.farmId,
            seasonId: input.seasonId,
            voucherId: created!.id,
            nature: "ADVANCE",
            amount: input.amount,
            accountType: account.accountType,
            actorId: request.appUser!.id,
          });
          const accountTransactionId = await insertAccountMovement(tx, {
            farmId: input.farmId,
            seasonId: input.seasonId,
            voucherId: created!.id,
            voucherNumber,
            voucherDate: input.voucherDate,
            amount: input.amount,
            account,
            actorId: request.appUser!.id,
          });
          const [updated] = await tx
            .update(labourPaymentVouchers)
            .set({ accountTransactionId })
            .where(eq(labourPaymentVouchers.id, created!.id))
            .returning();
          await tx
            .insert(auditLogs)
            .values({
              workspaceId,
              farmId: input.farmId,
              userId: request.appUser!.id,
              actorUserId: request.appUser!.id,
              action: "labour_advance_posted",
              entityType: "labour_payment_voucher",
              entityId: created!.id,
              afterJson: updated as unknown as Record<string, unknown>,
            });
          return updated!;
        });
        return reply.code(201).send({ voucher });
      } catch (error) {
        return reply
          .code(400)
          .send({
            message:
              error instanceof Error
                ? error.message
                : "Unable to post the labour advance.",
          });
      }
    },
  );

  app.patch(
    "/v1/workspace/:workspaceId/labour-payments/advances/:voucherId",
    { preHandler: requireUser },
    async (request, reply) => {
      const params = voucherParamsSchema.safeParse(request.params);
      const body = advanceEditSchema.safeParse(request.body);
      if (!params.success)
        return reply.code(400).send({ message: "A valid Labour Advance Voucher is required." });
      if (!body.success)
        return reply.code(400).send({
          message: "Check the highlighted advance fields.",
          fields: Object.keys(body.error.flatten().fieldErrors),
          details: body.error.flatten().fieldErrors,
        });
      const input = body.data;
      if (!(await requireRequestScope(request, reply, params.data.workspaceId, input.farmId, input.seasonId, "edit"))) return;
      try {
        const voucher = await db.transaction(async (tx) => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${params.data.workspaceId}:${input.farmId}:${input.seasonId}:labour-payment-posting`}), 1)`);
          const advance = await loadEditableAdvance(tx, {
            workspaceId: params.data.workspaceId,
            farmId: input.farmId,
            seasonId: input.seasonId,
            voucherId: params.data.voucherId,
          });
          const recipient = await loadRecipient(tx, params.data.workspaceId, input.farmId, { ...input, requireReceivedBy: true });
          const account = await validatedAccount(tx, params.data.workspaceId, input.farmId, input.paymentAccountId);
          if (advance.accountTransactionId) {
            await tx.update(labourPaymentVouchers).set({ accountTransactionId: null }).where(eq(labourPaymentVouchers.id, advance.id));
            await tx.delete(accountTransactions).where(eq(accountTransactions.id, advance.accountTransactionId));
          }
          await tx.delete(labourAccountingEntries).where(eq(labourAccountingEntries.voucherId, advance.id));
          const [updated] = await tx
            .update(labourPaymentVouchers)
            .set({
              voucherDate: input.voucherDate,
              recipientScope: input.recipientScope,
              financialScopeKey: recipient.financialScopeKey,
              labourerId: input.recipientScope === "INDIVIDUAL" ? input.labourerId : null,
              labourGroupId: input.recipientScope === "LABOUR_GROUP" ? input.labourGroupId : null,
              recipientSnapshot: recipient.snapshot,
              description: input.description,
              paymentAmount: input.amount.toFixed(2),
              paymentAccountId: account.id,
              paymentMethod: input.paymentMethod,
              transactionReference: input.transactionReference,
              updatedAt: new Date(),
              reconciliationStatus: "RECONCILED",
            })
            .where(eq(labourPaymentVouchers.id, advance.id))
            .returning();
          if (!updated) throw new Error("Unable to update the advance voucher.");
          await postLabourVoucherJournal(tx, {
            workspaceId: params.data.workspaceId,
            farmId: input.farmId,
            seasonId: input.seasonId,
            voucherId: updated.id,
            nature: "ADVANCE",
            amount: input.amount,
            accountType: account.accountType,
            actorId: request.appUser!.id,
          });
          const accountTransactionId = await insertAccountMovement(tx, {
            farmId: input.farmId,
            seasonId: input.seasonId,
            voucherId: updated.id,
            voucherNumber: updated.voucherNumber,
            voucherDate: input.voucherDate,
            amount: input.amount,
            account,
            actorId: request.appUser!.id,
          });
          const [finalVoucher] = await tx
            .update(labourPaymentVouchers)
            .set({ accountTransactionId, updatedAt: new Date() })
            .where(eq(labourPaymentVouchers.id, updated.id))
            .returning();
          if (advance.legacySourceRecordId) {
            const [sourceRecord] = await tx
              .select({ payload: operationalRecords.payload })
              .from(operationalRecords)
              .where(eq(operationalRecords.id, advance.legacySourceRecordId))
              .limit(1);
            await tx.update(operationalRecords).set({
              payload: {
                ...((sourceRecord?.payload as Record<string, unknown> | undefined) ?? {}),
                id: updated.sourceId ?? advance.sourceId,
                workspaceId: params.data.workspaceId,
                farmId: input.farmId,
                seasonId: input.seasonId,
                labourerId: input.recipientScope === "INDIVIDUAL" ? input.labourerId ?? null : null,
                labourGroupId: input.recipientScope === "LABOUR_GROUP" ? input.labourGroupId ?? null : null,
                receivedByLabourerId: input.receivedByLabourerId ?? null,
                receivedByNameSnapshot: recipient.snapshot.receivedByNameSnapshot,
                labourGroupName: recipient.snapshot.labourGroupName,
                recipientScope: input.recipientScope,
                financialScopeKey: recipient.financialScopeKey,
                recipientSnapshot: recipient.snapshot,
                date: input.voucherDate,
                amount: input.amount,
                accountId: account.id,
                sourceAccountName: account.name,
                paymentMethod: input.paymentMethod,
                notes: input.description,
                status: "posted",
                updatedAt: new Date().toISOString(),
              },
              clientUpdatedAt: new Date(),
              updatedAt: new Date(),
            }).where(eq(operationalRecords.id, advance.legacySourceRecordId));
          }
          await tx.insert(auditLogs).values({
            workspaceId: params.data.workspaceId,
            farmId: input.farmId,
            userId: request.appUser!.id,
            actorUserId: request.appUser!.id,
            action: "labour_advance_updated",
            entityType: "labour_payment_voucher",
            entityId: advance.id,
            beforeJson: advance as unknown as Record<string, unknown>,
            afterJson: finalVoucher as unknown as Record<string, unknown>,
          });
          return finalVoucher!;
        });
        return { voucher };
      } catch (error) {
        return reply.code(409).send({ message: error instanceof Error ? error.message : "Unable to update the advance." });
      }
    },
  );

  app.delete(
    "/v1/workspace/:workspaceId/labour-payments/advances/:voucherId",
    { preHandler: requireUser },
    async (request, reply) => {
      const params = voucherParamsSchema.safeParse(request.params);
      const query = contextSchema.safeParse(request.query);
      if (!params.success || !query.success)
        return reply.code(400).send({ message: "A valid Labour Advance Voucher is required." });
      if (!(await requireRequestScope(request, reply, params.data.workspaceId, query.data.farmId, query.data.seasonId, "delete"))) return;
      try {
        const result = await db.transaction(async (tx) => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${params.data.workspaceId}:${query.data.farmId}:${query.data.seasonId}:labour-payment-posting`}), 1)`);
          const advance = await loadEditableAdvance(tx, {
            workspaceId: params.data.workspaceId,
            farmId: query.data.farmId,
            seasonId: query.data.seasonId,
            voucherId: params.data.voucherId,
          });
          if (advance.accountTransactionId) {
            await tx.update(labourPaymentVouchers).set({ accountTransactionId: null }).where(eq(labourPaymentVouchers.id, advance.id));
            await tx.delete(accountTransactions).where(eq(accountTransactions.id, advance.accountTransactionId));
          }
          await tx.delete(labourAccountingEntries).where(eq(labourAccountingEntries.voucherId, advance.id));
          await tx.delete(labourPaymentVouchers).where(eq(labourPaymentVouchers.id, advance.id));
          if (advance.legacySourceRecordId) {
            await tx.delete(operationalRecords).where(eq(operationalRecords.id, advance.legacySourceRecordId));
          }
          await tx.insert(auditLogs).values({
            workspaceId: params.data.workspaceId,
            farmId: query.data.farmId,
            userId: request.appUser!.id,
            actorUserId: request.appUser!.id,
            action: "labour_advance_deleted",
            entityType: "labour_payment_voucher",
            entityId: advance.id,
            beforeJson: advance as unknown as Record<string, unknown>,
          });
          return { deleted: true, voucherId: advance.id, voucherNumber: advance.voucherNumber };
        });
        return { result };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to delete the advance.";
        return reply.code(409).send({
          message: message.includes("financial details cannot be edited")
            ? "This advance has already been used and cannot be deleted."
            : message,
        });
      }
    },
  );

  app.get(
    "/v1/workspace/:workspaceId/labour-payments/vouchers",
    { preHandler: requireUser },
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      const query = contextSchema
        .extend({
          nature: z.string().optional(),
          status: z.string().optional(),
        })
        .safeParse(request.query);
      if (!params.success || !query.success)
        return reply
          .code(400)
          .send({
            message: "A valid Labour Payment Voucher query is required.",
          });
      if (
        !(await requireRequestScope(
          request,
          reply,
          params.data.workspaceId,
          query.data.farmId,
          query.data.seasonId,
          "view",
        ))
      )
        return;
      const vouchers = await db
        .select()
        .from(labourPaymentVouchers)
        .where(
          and(
            eq(labourPaymentVouchers.workspaceId, params.data.workspaceId),
            eq(labourPaymentVouchers.farmId, query.data.farmId),
            eq(labourPaymentVouchers.seasonId, query.data.seasonId),
            query.data.nature
              ? eq(labourPaymentVouchers.nature, query.data.nature)
              : undefined,
            query.data.status
              ? eq(labourPaymentVouchers.status, query.data.status)
              : undefined,
            sql`${labourPaymentVouchers.nature} not in ('ADVANCE', 'REFUND_RECOVERY')`,
            sql`(${labourPaymentVouchers.nature} <> 'REVERSAL' or not exists (
              select 1 from labour_payment_vouchers original
              where original.id = ${labourPaymentVouchers.reversalReference}
                and original.nature in ('ADVANCE', 'REFUND_RECOVERY')
            ))`,
          ),
        )
        .orderBy(
          desc(labourPaymentVouchers.voucherDate),
          desc(labourPaymentVouchers.createdAt),
        );
      const financials = await loadLabourFinancialReadModel({
        workspaceId: params.data.workspaceId,
        farmId: query.data.farmId,
        seasonId: query.data.seasonId,
      });
      const transactionIds = vouchers.map((voucher) => voucher.accountTransactionId).filter((value): value is string => Boolean(value));
      const [scopeAccounts, scopeTransactions] = await Promise.all([
        db.select().from(accounts).where(eq(accounts.farmId, query.data.farmId)),
        transactionIds.length
          ? db.select().from(accountTransactions).where(inArray(accountTransactions.id, transactionIds))
          : Promise.resolve([]),
      ]);
      const accountById = new Map(scopeAccounts.map((row) => [row.id, row]));
      const transactionById = new Map(scopeTransactions.map((row) => [row.id, row]));
      const accountEntryByVoucherId = new Map(financials.accountEntries.map((entry) => [entry.voucherId, entry]));
      const advanceByVoucherId = new Map(financials.advancePositions.filter((row) => row.canonicalVoucherId).map((row) => [row.canonicalVoucherId!, row]));
      return {
        vouchers: vouchers.map((voucher) => {
          const transaction = voucher.accountTransactionId ? transactionById.get(voucher.accountTransactionId) : undefined;
          const canonicalEntry = accountEntryByVoucherId.get(voucher.id);
          const canonicalAdvance = advanceByVoucherId.get(voucher.id);
          const account = (canonicalEntry?.accountId ? accountById.get(canonicalEntry.accountId) : undefined)
            ?? (canonicalAdvance?.fundingAccountId ? accountById.get(canonicalAdvance.fundingAccountId) : undefined)
            ?? (voucher.paymentAccountId ? accountById.get(voucher.paymentAccountId) : undefined)
            ?? (transaction?.accountId ? accountById.get(transaction.accountId) : undefined);
          return {
            ...voucher,
            paymentAccountId: account?.id ?? voucher.paymentAccountId,
            paymentAccountName: account?.name ?? firstText(
              asSnapshot(voucher.recipientSnapshot).sourceAccountName,
              asSnapshot(voucher.recipientSnapshot).paymentAccountName,
            ),
          };
        }),
      };
    },
  );

  app.get(
    "/v1/workspace/:workspaceId/labour-payments/advances",
    { preHandler: requireUser },
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      const query = advanceListQuerySchema.safeParse(request.query);
      if (!params.success || !query.success)
        return reply
          .code(400)
          .send({ message: "A valid advance query is required." });
      if (
        !(await requireRequestScope(
          request,
          reply,
          params.data.workspaceId,
          query.data.farmId,
          query.data.seasonId,
          "view",
        ))
      )
        return;
      const startedAt = performance.now();
      const financials = await loadLabourFinancialReadModel({
        workspaceId: params.data.workspaceId,
        farmId: query.data.farmId,
        seasonId: query.data.seasonId,
      });
      const searchTerm = query.data.search?.trim().toLowerCase() ?? "";
      const filtered = financials.advancePositions
        .filter((row) => {
          if (query.data.status === "ALL") return true;
          if (query.data.status === "OPEN") return row.status !== "VOIDED" && row.outstandingAmount > 0.005;
          return row.status === query.data.status;
        })
        .filter((row) => !query.data.recipientScope || row.recipientScope === query.data.recipientScope)
        .filter((row) => !query.data.accountId || row.fundingAccountId === query.data.accountId)
        .filter((row) => !query.data.from || row.advanceDate >= query.data.from)
        .filter((row) => !query.data.to || row.advanceDate <= query.data.to)
        .filter((row) => !searchTerm || [
          row.voucherNumber,
          row.recipientName,
          row.labourerName,
          row.labourGroupName,
          row.fundingAccountName,
          row.partnerName,
          row.description,
          row.reviewReason,
        ].filter(Boolean).join(" ").toLowerCase().includes(searchTerm))
        .sort((left, right) => right.advanceDate.localeCompare(left.advanceDate) || right.voucherNumber.localeCompare(left.voucherNumber));
      const offset = (query.data.page - 1) * query.data.pageSize;
      const advances = filtered.slice(offset, offset + query.data.pageSize).map((row) => ({
        id: row.canonicalVoucherId ?? row.advancePositionId,
        advancePositionId: row.advancePositionId,
        canonicalId: row.canonicalVoucherId,
        canonicalVoucherId: row.canonicalVoucherId,
        legacySourceRecordId: row.legacySourceRecordId,
        sourceClassification: row.sourceClassification,
        voucherNumber: row.voucherNumber,
        displayVoucherNumber: row.voucherNumber,
        voucherDate: row.voucherDate,
        advanceDate: row.advanceDate,
        recipientScope: row.recipientScope,
        financialScopeKey: `${row.recipientScope}:${row.labourGroupId ?? row.labourerId ?? row.recipientName}`,
        financialOwnerId: row.labourGroupId ?? row.labourerId,
        labourerId: row.labourerId,
        labourerName: row.labourerName,
        labourGroupId: row.labourGroupId,
        labourGroupName: row.labourGroupName,
        recipientDisplayName: row.recipientDisplayName,
        financialOwnerName: row.recipientDisplayName,
        receivedByLabourerId: row.labourerId,
        receivedByName: row.receivedByDisplayName,
        groupLeaderSnapshot: row.labourGroupName,
        recipientSnapshot: {
          ...(row.labourerName ? { labourerName: row.labourerName } : {}),
          ...(row.labourGroupName ? { labourGroupName: row.labourGroupName } : {}),
          ...(row.receivedByDisplayName ? { receivedByNameSnapshot: row.receivedByDisplayName, receivedBy: row.receivedByDisplayName } : {}),
        },
        description: row.description,
        originalAmount: row.originalAmount,
        appliedAmount: row.appliedAmount,
        refundedAmount: row.recoveredAmount,
        recoveredAmount: row.recoveredAmount,
        reversedAmount: row.status === "VOIDED" ? row.originalAmount : 0,
        outstandingAmount: row.outstandingAmount,
        advanceStatus: row.status,
        paymentAmount: String(row.originalAmount),
        paymentAccountId: row.fundingAccountId,
        fundingAccountId: row.fundingAccountId,
        paymentSourceId: row.paymentSourceId,
        paymentSourceType: row.paymentSourceType,
        paymentSourceDisplayName: row.paymentSourceDisplayName,
        paymentAccountName: row.paymentSourceDisplayName,
        fundingAccountName: row.paymentSourceDisplayName,
        paymentMethod: row.fundingType,
        transactionReference: row.sourceId,
        status: row.status,
        nature: "ADVANCE",
        sourceType: row.sourceClassification,
        sourceId: row.sourceId,
        partnerId: row.partnerId,
        partnerName: row.partnerName,
        legacy: row.legacy,
        reconciliationStatus: row.needsReview ? "NEEDS_REVIEW" : "RECONCILED",
        reviewRequired: row.needsReview,
        needsReview: row.needsReview,
        reviewReason: row.reviewReason,
        readOnlyLegacy: row.legacy,
        createdBy: null,
        createdByName: null,
        createdAt: `${row.advanceDate}T00:00:00.000Z`,
      }));
      const response = {
        advances,
        summary: {
          totalOutstanding: financials.summary.outstandingAdvance,
          openCount: financials.advancePositions.filter((row) => row.status !== "VOIDED" && row.outstandingAmount > 0.005).length,
          partiallyAppliedCount: financials.advancePositions.filter((row) => row.status === "PARTIALLY_APPLIED" || row.status === "PARTIALLY_REFUNDED").length,
          totalOriginal: financials.summary.totalAdvance,
          totalApplied: financials.summary.activeAdvanceApplied,
          totalRecovered: financials.summary.recoveredAdvance,
          totalReversed: financials.advancePositions.filter((row) => row.status === "VOIDED").reduce((sum, row) => sum + row.originalAmount, 0),
          reviewRequiredCount: financials.advancePositions.filter((row) => row.needsReview).length,
          legacyCount: financials.advancePositions.filter((row) => row.legacy).length,
          currentCount: financials.advancePositions.filter((row) => row.canonical).length,
        },
        pageInfo: {
          page: query.data.page,
          pageSize: query.data.pageSize,
          totalCount: filtered.length,
          hasMore: offset + advances.length < filtered.length,
        },
        diagnostics: {
          queryCount: 1,
          databaseMs: 0,
          totalMs: Number((performance.now() - startedAt).toFixed(2)),
        },
      };
      const payloadBytes = Buffer.byteLength(JSON.stringify(response));
      reply
        .header("Server-Timing", `total;dur=${response.diagnostics.totalMs}`)
        .header("X-Result-Count", String(advances.length))
        .header("X-Payload-Bytes", String(payloadBytes));
      return response;
    },
  );

  app.get(
    "/v1/workspace/:workspaceId/labour-payments/financial-read-model",
    { preHandler: requireUser },
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      const query = contextSchema.safeParse(request.query);
      if (!params.success || !query.success) return reply.code(400).send({ message: "A valid Labour Payments financial scope is required." });
      if (!(await requireRequestScope(request, reply, params.data.workspaceId, query.data.farmId, query.data.seasonId, "view"))) return;
      return { financials: await loadLabourFinancialReadModel({ workspaceId: params.data.workspaceId, farmId: query.data.farmId, seasonId: query.data.seasonId }) };
    },
  );

  app.get(
    "/v1/workspace/:workspaceId/labour-payments/reconciliation",
    { preHandler: requireUser },
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      const query = contextSchema.safeParse(request.query);
      if (!params.success || !query.success)
        return reply
          .code(400)
          .send({ message: "A valid reconciliation query is required." });
      if (
        !(await requireRequestScope(
          request,
          reply,
          params.data.workspaceId,
          query.data.farmId,
          query.data.seasonId,
          "view",
        ))
      )
        return;
      const [journal, vouchers, dues, applications, allocations, scopeAccounts, scopeTransactions, legacyOperational] = await Promise.all([
        db
          .select()
          .from(labourAccountingEntries)
          .where(
            and(
              eq(labourAccountingEntries.workspaceId, params.data.workspaceId),
              eq(labourAccountingEntries.farmId, query.data.farmId),
              eq(labourAccountingEntries.seasonId, query.data.seasonId),
            ),
          ),
        db
          .select()
          .from(labourPaymentVouchers)
          .where(
            and(
              eq(labourPaymentVouchers.workspaceId, params.data.workspaceId),
              eq(labourPaymentVouchers.farmId, query.data.farmId),
              eq(labourPaymentVouchers.seasonId, query.data.seasonId),
            ),
          ),
        db
          .select()
          .from(labourDues)
          .where(
            and(
              eq(labourDues.workspaceId, params.data.workspaceId),
              eq(labourDues.farmId, query.data.farmId),
              eq(labourDues.seasonId, query.data.seasonId),
            ),
          ),
        db.select().from(labourAdvanceApplications).where(eq(labourAdvanceApplications.workspaceId, params.data.workspaceId)),
        db.select().from(labourPaymentAllocations).where(eq(labourPaymentAllocations.workspaceId, params.data.workspaceId)),
        db.select().from(accounts).where(eq(accounts.farmId, query.data.farmId)),
        db.select().from(accountTransactions).where(and(eq(accountTransactions.farmId, query.data.farmId), eq(accountTransactions.seasonId, query.data.seasonId))),
        db
          .select({
            id: operationalRecords.id,
            clientRecordId: operationalRecords.clientRecordId,
            entityType: operationalRecords.entityType,
          })
          .from(operationalRecords)
          .where(
            and(
              eq(operationalRecords.workspaceId, params.data.workspaceId),
              eq(operationalRecords.farmId, query.data.farmId),
              eq(operationalRecords.seasonId, query.data.seasonId),
              inArray(operationalRecords.entityType, [
                "advance",
                "labourPayment",
              ]),
            ),
          ),
      ]);
      const debitTotal = journal.reduce(
        (sum, row) => sum + Number(row.debit),
        0,
      );
      const creditTotal = journal.reduce(
        (sum, row) => sum + Number(row.credit),
        0,
      );
      const positions = await db.transaction(async (tx) =>
        Promise.all(
          dues
            .filter((due) => due.paymentStatus !== "VOIDED" && due.calculationStatus !== "VOIDED")
            .map((due) => loadLabourDuePosition(tx, due.id)),
        ),
      );
      const postedCashVouchers = vouchers.filter(
        (voucher) => voucher.status === "POSTED" && voucher.nature !== "ADVANCE_APPLICATION",
      );
      const missingAccountTransactions = postedCashVouchers
        .filter((voucher) => !voucher.accountTransactionId && !voucher.legacy)
        .map((voucher) => voucher.voucherNumber);
      const legacyNeedsReview = vouchers
        .filter(
          (voucher) =>
            voucher.reconciliationStatus === "NEEDS_REVIEW" ||
            voucher.reconciliationStatus === "LEGACY_UNLINKED",
        )
        .map((voucher) => voucher.voucherNumber);
      const mappedLegacyIds = new Set(
        vouchers.map((voucher) => voucher.legacySourceRecordId).filter(Boolean),
      );
      const unmappedLegacyRecords = legacyOperational
        .filter((record) => !mappedLegacyIds.has(record.id))
        .map((record) => ({
          entityType: record.entityType,
          clientRecordId: record.clientRecordId,
        }));
      const byLedger = journal.reduce<
        Record<string, { debit: number; credit: number }>
      >((result, row) => {
        const current = result[row.ledgerCode] ?? { debit: 0, credit: 0 };
        current.debit += Number(row.debit);
        current.credit += Number(row.credit);
        result[row.ledgerCode] = current;
        return result;
      }, {});
      const structured = reconcileLabourFinancialScope({
        workspaceId: params.data.workspaceId,
        farmId: query.data.farmId,
        seasonId: query.data.seasonId,
        accounts: scopeAccounts,
        accountTransactions: scopeTransactions,
        journal,
        applications: applications.filter((row) => dues.some((due) => due.id === row.dueId)),
        dues,
        allocations: allocations.filter((row) => dues.some((due) => due.id === row.dueId)),
        vouchers,
      });
      const legacyCoveragePassed = legacyNeedsReview.length === 0 && unmappedLegacyRecords.length === 0;
      return {
        reconciliation: {
          journal: {
            debitTotal,
            creditTotal,
            difference: Math.round((debitTotal - creditTotal) * 100) / 100,
            byLedger,
          },
          outstandingPayables: positions.reduce(
            (sum, position) => sum + (position?.outstandingBalance ?? 0),
            0,
          ),
          postedVoucherCount: postedCashVouchers.length,
          postedCashAmount: postedCashVouchers.reduce(
            (sum, voucher) => sum + Number(voucher.paymentAmount),
            0,
          ),
          missingAccountTransactions,
          legacyNeedsReview,
          unmappedLegacyRecords,
          checks: [
            ...structured.checks,
            { name: "legacy-coverage", passed: legacyCoveragePassed, checkedCount: legacyOperational.length, failureCount: legacyNeedsReview.length + unmappedLegacyRecords.length },
          ],
          failures: structured.failures,
          reconciled: structured.reconciled && legacyCoveragePassed,
        },
      };
    },
  );

  app.post(
    "/v1/workspace/:workspaceId/labour-payments/advances/:voucherId/refund",
    { preHandler: requireUser },
    async (request, reply) => {
      const params = voucherParamsSchema.safeParse(request.params);
      const body = refundSchema.safeParse(request.body);
      if (!params.success || !body.success)
        return reply
          .code(400)
          .send({ message: "A valid advance refund is required." });
      if (
        !(await requireRequestScope(
          request,
          reply,
          params.data.workspaceId,
          body.data.farmId,
          body.data.seasonId,
          "create",
        ))
      )
        return;
      try {
        const voucher = await db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtext(${`${params.data.workspaceId}:${body.data.farmId}:${body.data.seasonId}:labour-payment-posting`}), 1)`,
          );
          const [existing] = await tx
            .select()
            .from(labourPaymentVouchers)
            .where(
              and(
                eq(labourPaymentVouchers.workspaceId, params.data.workspaceId),
                eq(
                  labourPaymentVouchers.idempotencyKey,
                  body.data.payment.idempotencyKey,
                ),
              ),
            )
            .limit(1);
          if (existing) {
            if (
              existing.nature !== "REFUND_RECOVERY" ||
              existing.relatedAdvanceVoucherId !== params.data.voucherId ||
              Math.abs(
                Number(existing.paymentAmount) - body.data.payment.amount,
              ) > 0.005
            )
              throw new Error(
                "The idempotency key was already used for a different refund.",
              );
            return existing;
          }
          const [advance] = await tx
            .select()
            .from(labourPaymentVouchers)
            .where(
              and(
                eq(labourPaymentVouchers.id, params.data.voucherId),
                eq(labourPaymentVouchers.nature, "ADVANCE"),
                eq(labourPaymentVouchers.status, "POSTED"),
              ),
            )
            .limit(1);
          if (!advance)
            throw new Error("The advance is not available for refund.");
          const [applied] = await tx
            .select({
              total: sql<number>`coalesce(sum(${labourAdvanceApplications.amount}) filter (where ${labourAdvanceApplications.status} = 'ACTIVE'), 0)::numeric`,
            })
            .from(labourAdvanceApplications)
            .where(eq(labourAdvanceApplications.advanceVoucherId, advance.id));
          const [refunded] = await tx
            .select({
              total: sql<number>`coalesce(sum(${labourPaymentVouchers.paymentAmount}) filter (where ${labourPaymentVouchers.status} = 'POSTED' and ${labourPaymentVouchers.nature} = 'REFUND_RECOVERY'), 0)::numeric`,
            })
            .from(labourPaymentVouchers)
            .where(
              eq(labourPaymentVouchers.relatedAdvanceVoucherId, advance.id),
            );
          const available = Math.max(
            Number(advance.paymentAmount) -
              Number(applied?.total ?? 0) -
              Number(refunded?.total ?? 0),
            0,
          );
          if (body.data.payment.amount > available + 0.005)
            throw new Error("Refund exceeds the outstanding advance balance.");
          const account = await validatedAccount(
            tx,
            params.data.workspaceId,
            body.data.farmId,
            body.data.payment.paymentAccountId,
          );
          const voucherNumber = await allocateLabourAdvanceAdjustmentNumber(
            tx,
            params.data.workspaceId,
            body.data.farmId,
          );
          const [created] = await tx
            .insert(labourPaymentVouchers)
            .values({
              workspaceId: params.data.workspaceId,
              farmId: body.data.farmId,
              seasonId: body.data.seasonId,
              voucherNumber,
              voucherDate: body.data.payment.voucherDate,
              nature: "REFUND_RECOVERY",
              status: "POSTED",
              recipientScope: advance.recipientScope,
              financialScopeKey: advance.financialScopeKey,
              labourerId: advance.labourerId,
              labourGroupId: advance.labourGroupId,
              recipientSnapshot: advance.recipientSnapshot,
              description:
                body.data.payment.description ||
                `Advance refund for ${advance.voucherNumber}`,
              paymentAmount: body.data.payment.amount.toFixed(2),
              paymentAccountId: account.id,
              paymentMethod: body.data.payment.paymentMethod,
              transactionReference: body.data.payment.transactionReference,
              sourceType: "ADVANCE_REFUND",
              sourceId: advance.id,
              relatedAdvanceVoucherId: advance.id,
              idempotencyKey: body.data.payment.idempotencyKey,
              createdBy: request.appUser!.id,
              postedBy: request.appUser!.id,
              postedAt: new Date(),
              reconciliationStatus: "RECONCILED",
            })
            .returning();
          await postLabourVoucherJournal(tx, {
            workspaceId: params.data.workspaceId,
            farmId: body.data.farmId,
            seasonId: body.data.seasonId,
            voucherId: created!.id,
            nature: "REFUND_RECOVERY",
            amount: body.data.payment.amount,
            accountType: account.accountType,
            actorId: request.appUser!.id,
          });
          const accountTransactionId = await insertAccountMovement(tx, {
            farmId: body.data.farmId,
            seasonId: body.data.seasonId,
            voucherId: created!.id,
            voucherNumber,
            voucherDate: body.data.payment.voucherDate,
            amount: body.data.payment.amount,
            account,
            actorId: request.appUser!.id,
            reverse: true,
          });
          const [updated] = await tx
            .update(labourPaymentVouchers)
            .set({ accountTransactionId })
            .where(eq(labourPaymentVouchers.id, created!.id))
            .returning();
          return updated!;
        });
        return { voucher };
      } catch (error) {
        return reply
          .code(409)
          .send({
            message:
              error instanceof Error
                ? error.message
                : "Unable to refund the advance.",
          });
      }
    },
  );

  app.post(
    "/v1/workspace/:workspaceId/labour-payments/vouchers/:voucherId/void",
    { preHandler: requireUser },
    async (request, reply) => {
      const params = voucherParamsSchema.safeParse(request.params);
      const query = contextSchema.safeParse(request.query);
      const body = voidSchema.safeParse(request.body);
      if (!params.success || !query.success || !body.success)
        return reply
          .code(400)
          .send({ message: "A valid voucher void request is required." });
      if (
        !(await requireRequestScope(
          request,
          reply,
          params.data.workspaceId,
          query.data.farmId,
          query.data.seasonId,
          "delete",
        ))
      )
        return;
      try {
        const result = await db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtext(${`${params.data.workspaceId}:${query.data.farmId}:${query.data.seasonId}:labour-payment-posting`}), 1)`,
          );
          const [voucher] = await tx
            .select()
            .from(labourPaymentVouchers)
            .where(
              and(
                eq(labourPaymentVouchers.id, params.data.voucherId),
                eq(labourPaymentVouchers.workspaceId, params.data.workspaceId),
                eq(labourPaymentVouchers.farmId, query.data.farmId),
                eq(labourPaymentVouchers.seasonId, query.data.seasonId),
              ),
            )
            .limit(1);
          if (!voucher)
            throw new Error("Labour Payment Voucher was not found.");
          if (voucher.status === "VOIDED") return { voucher, reversal: null };
          if (voucher.nature === "REVERSAL")
            throw new Error("A reversal voucher cannot be voided directly.");
          if (voucher.legacy)
            throw new Error(
              "Legacy mapped vouchers must be reconciled through their original workflow before reversal.",
            );
          if (voucher.nature === "ADVANCE") {
            const activeApplications = await tx
              .select({ id: labourAdvanceApplications.id })
              .from(labourAdvanceApplications)
              .where(
                and(
                  eq(labourAdvanceApplications.advanceVoucherId, voucher.id),
                  eq(labourAdvanceApplications.status, "ACTIVE"),
                ),
              )
              .limit(1);
            if (activeApplications.length)
              throw new Error(
                "Reverse active advance applications before voiding this advance voucher.",
              );
          }
          const [existingReversal] = await tx
            .select()
            .from(labourPaymentVouchers)
            .where(
              and(
                eq(labourPaymentVouchers.workspaceId, params.data.workspaceId),
                eq(
                  labourPaymentVouchers.idempotencyKey,
                  body.data.idempotencyKey,
                ),
              ),
            )
            .limit(1);
          if (existingReversal) return { voucher, reversal: existingReversal };
          if (!voucher.paymentAccountId)
            throw new Error(
              "The original voucher payment account is missing and requires reconciliation.",
            );
          const account = await validatedAccount(
            tx,
            params.data.workspaceId,
            query.data.farmId,
            voucher.paymentAccountId,
          );
          const reversalNumber = voucher.nature === "ADVANCE" || voucher.nature === "REFUND_RECOVERY"
            ? await allocateLabourAdvanceAdjustmentNumber(tx, params.data.workspaceId, query.data.farmId)
            : await allocateLabourPaymentVoucherNumber(tx, params.data.workspaceId, query.data.farmId);
          const now = new Date();
          const [reversal] = await tx
            .insert(labourPaymentVouchers)
            .values({
              workspaceId: params.data.workspaceId,
              farmId: query.data.farmId,
              seasonId: query.data.seasonId,
              voucherNumber: reversalNumber,
              voucherDate: now.toISOString().slice(0, 10),
              nature: "REVERSAL",
              status: "POSTED",
              recipientScope: voucher.recipientScope,
              financialScopeKey: voucher.financialScopeKey,
              labourerId: voucher.labourerId,
              labourGroupId: voucher.labourGroupId,
              recipientSnapshot: voucher.recipientSnapshot,
              description: `Reversal of ${voucher.voucherNumber}: ${body.data.reason}`,
              paymentAmount: voucher.paymentAmount,
              paymentAccountId: account.id,
              paymentMethod: voucher.paymentMethod,
              transactionReference: voucher.transactionReference,
              sourceType: "VOUCHER_REVERSAL",
              sourceId: voucher.id,
              linkedDueId: voucher.linkedDueId,
              reversalReference: voucher.id,
              idempotencyKey: body.data.idempotencyKey,
              createdBy: request.appUser!.id,
              postedBy: request.appUser!.id,
              postedAt: now,
              reconciliationStatus: "RECONCILED",
            })
            .returning();
          await reverseLabourJournal(tx, {
            workspaceId: params.data.workspaceId,
            farmId: query.data.farmId,
            seasonId: query.data.seasonId,
            actorId: request.appUser!.id,
            reversalKey: `voucher-reversal:${reversal!.id}`,
            originalEventKey: `voucher:${voucher.id}`,
          });
          // Refunds are account inflows. Their reversal must therefore be an
          // outflow; all other supported voucher natures are outflows whose
          // reversal is an inflow.
          const accountTransactionId = await insertAccountMovement(tx, {
            farmId: query.data.farmId,
            seasonId: query.data.seasonId,
            voucherId: reversal!.id,
            voucherNumber: reversalNumber,
            voucherDate: now.toISOString().slice(0, 10),
            amount: Number(voucher.paymentAmount),
            account,
            actorId: request.appUser!.id,
            reverse: voucher.nature !== "REFUND_RECOVERY",
          });
          await tx
            .update(labourPaymentVouchers)
            .set({ accountTransactionId })
            .where(eq(labourPaymentVouchers.id, reversal!.id));
          await tx
            .update(labourPaymentVouchers)
            .set({
              status: "VOIDED",
              voidReason: body.data.reason,
              voidedBy: request.appUser!.id,
              voidedAt: now,
              reversalReference: reversal!.id,
              updatedAt: now,
            })
            .where(eq(labourPaymentVouchers.id, voucher.id));
          if (voucher.nature === "ADVANCE" && voucher.legacySourceRecordId) {
            const [source] = await tx
              .select()
              .from(operationalRecords)
              .where(eq(operationalRecords.id, voucher.legacySourceRecordId))
              .limit(1);
            if (source)
              await tx
                .update(operationalRecords)
                .set({
                  payload: {
                    ...source.payload,
                    status: "voided",
                    deletedAt: now.toISOString(),
                    voidReason: body.data.reason,
                    voidedBy: request.appUser!.id,
                  },
                  clientUpdatedAt: now,
                  updatedAt: now,
                })
                .where(eq(operationalRecords.id, source.id));
          }
          await tx
            .update(labourPaymentAllocations)
            .set({
              status: "REVERSED",
              reversedAt: now,
              reversedBy: request.appUser!.id,
              updatedAt: now,
            })
            .where(
              and(
                eq(labourPaymentAllocations.voucherId, voucher.id),
                eq(labourPaymentAllocations.status, "ACTIVE"),
              ),
            );
          if (voucher.linkedDueId)
            await refreshLabourDuePaymentStatus(tx, voucher.linkedDueId);
          await tx
            .insert(auditLogs)
            .values({
              workspaceId: params.data.workspaceId,
              farmId: query.data.farmId,
              userId: request.appUser!.id,
              actorUserId: request.appUser!.id,
              action: "labour_payment_voucher_voided",
              entityType: "labour_payment_voucher",
              entityId: voucher.id,
              details: {
                reversalVoucherId: reversal!.id,
                reason: body.data.reason,
              },
            });
          return {
            voucher: { ...voucher, status: "VOIDED" },
            reversal: { ...reversal!, accountTransactionId },
          };
        });
        return { result };
      } catch (error) {
        return reply
          .code(409)
          .send({
            message:
              error instanceof Error
                ? error.message
                : "Unable to void the Labour Payment Voucher.",
          });
      }
    },
  );
}
