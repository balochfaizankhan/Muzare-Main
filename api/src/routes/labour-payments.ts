import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { db } from "../db/client.js";
import {
  accountTransactions,
  accounts,
  auditLogs,
  labourAdvanceApplications,
  labourAccountingEntries,
  labourDues,
  labourPaymentAllocations,
  labourPaymentVouchers,
  operationalRecords,
  userSessions,
} from "../db/schema.js";
import {
  allocateLabourDueNumber,
  allocateLabourPaymentVoucherNumber,
  calculateAdvancePosition,
  labourFinancialScopeKey,
  loadLabourDuePosition,
  postLabourAdvanceApplicationJournal,
  postLabourDueRecognition,
  postLabourVoucherJournal,
  refreshLabourDuePaymentStatus,
  reverseLabourJournal,
  type LabourRecipientScope,
} from "../lib/labour-payments.js";
import { resolveCanonicalPaymentAccountId } from "../lib/labour-wage-settlements.js";
import { validateLabourSettlementPaymentAccount } from "../lib/labour-settlement-account-validation.js";
import { hasModulePermission } from "../permissions.js";
import { validateTenantReferences } from "../tenant-ownership.js";
import { hasFarmAccess } from "../workspace-access.js";

const paramsSchema = z.object({ workspaceId: z.string().uuid() });
const dueParamsSchema = paramsSchema.extend({ dueId: z.string().uuid() });
const voucherParamsSchema = paramsSchema.extend({ voucherId: z.string().uuid() });
const advanceApplicationParamsSchema = dueParamsSchema.extend({ applicationId: z.string().uuid() });
const contextSchema = z.object({ farmId: z.string().uuid(), seasonId: z.string().uuid() });
const advanceListQuerySchema = contextSchema.extend({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(160).optional(),
  recipientScope: z.enum(["INDIVIDUAL", "LABOUR_GROUP", "CONTRACTOR_FOREMAN", "TEMPORARY_CREW", "UNREGISTERED_LABOUR", "NO_SPECIFIC_RECIPIENT"]).optional(),
  status: z.enum(["OPEN", "OUTSTANDING", "PARTIALLY_APPLIED", "PARTIALLY_REFUNDED", "FULLY_APPLIED", "FULLY_REFUNDED", "VOIDED", "ALL"]).default("OPEN"),
  accountId: z.string().uuid().optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
});
const recipientScopeSchema = z.enum(["INDIVIDUAL", "LABOUR_GROUP", "CONTRACTOR_FOREMAN", "TEMPORARY_CREW", "UNREGISTERED_LABOUR", "NO_SPECIFIC_RECIPIENT"]);
const directDueSchema = contextSchema.extend({
  idempotencyKey: z.string().uuid(),
  recipientScope: recipientScopeSchema,
  labourerId: z.string().uuid().optional().nullable(),
  labourGroupId: z.string().uuid().optional().nullable(),
  contractorReference: z.string().trim().max(200).optional().nullable(),
  crewReference: z.string().trim().max(200).optional().nullable(),
  manualRecipientName: z.string().trim().max(200).optional().nullable(),
  batchIdentity: z.string().trim().max(200).optional().nullable(),
  description: z.string().trim().min(1).max(500),
  workFromDate: z.string().date(),
  workToDate: z.string().date(),
  grossAmount: z.coerce.number().positive(),
  authorizedDeductions: z.coerce.number().nonnegative().default(0),
  leaderAllowance: z.coerce.number().nonnegative().default(0),
  notes: z.string().trim().max(1000).optional().nullable(),
  costCategory: z.string().trim().max(200).optional().nullable(),
});
const paymentSchema = z.object({
  idempotencyKey: z.string().uuid(),
  voucherDate: z.string().date(),
  amount: z.coerce.number().positive(),
  paymentAccountId: z.string().min(1),
  paymentMethod: z.string().trim().min(1).max(100),
  transactionReference: z.string().trim().max(200).optional().nullable(),
  description: z.string().trim().max(500).optional().nullable(),
});
const settleSchema = contextSchema.extend({
  advanceApplications: z.array(z.object({
    advanceVoucherId: z.string().uuid(),
    amount: z.coerce.number().positive(),
    idempotencyKey: z.string().uuid(),
  })).default([]),
  payment: paymentSchema.optional().nullable(),
});
const advanceSchema = contextSchema.extend({
  idempotencyKey: z.string().uuid(),
  voucherDate: z.string().date(),
  recipientScope: recipientScopeSchema,
  labourerId: z.string().uuid().optional().nullable(),
  labourGroupId: z.string().uuid().optional().nullable(),
  receivedBy: z.string().trim().max(200).optional().nullable(),
  contractorReference: z.string().trim().max(200).optional().nullable(),
  crewReference: z.string().trim().max(200).optional().nullable(),
  manualRecipientName: z.string().trim().max(200).optional().nullable(),
  batchIdentity: z.string().trim().max(200).optional().nullable(),
  amount: z.coerce.number().positive(),
  paymentAccountId: z.string().min(1),
  paymentMethod: z.string().trim().min(1).max(100).default("Cash"),
  transactionReference: z.string().trim().max(200).optional().nullable(),
  description: z.string().trim().min(1).max(500),
});
const holdSchema = z.object({ hold: z.boolean(), reason: z.string().trim().max(500).optional().nullable() });
const voidSchema = z.object({ idempotencyKey: z.string().uuid(), reason: z.string().trim().min(1).max(500) });
const refundSchema = contextSchema.extend({ payment: paymentSchema });

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function validateContext(request: { appUser?: { workspaceId?: string | null }; sessionId?: string }, workspaceId: string, farmId: string, seasonId: string) {
  if (request.appUser?.workspaceId !== workspaceId || !request.sessionId) return false;
  const [session] = await db.select({ farmId: userSessions.activeFarmId, seasonId: userSessions.activeSeasonId })
    .from(userSessions).where(eq(userSessions.id, request.sessionId)).limit(1);
  return session?.farmId === farmId && session.seasonId === seasonId;
}

async function validatedAccount(tx: DbTransaction, workspaceId: string, farmId: string, accountInput: string) {
  const account = await resolveCanonicalPaymentAccountId(tx, workspaceId, farmId, accountInput);
  const validation = validateLabourSettlementPaymentAccount(account, farmId);
  if (!validation.valid || !account) throw new Error(validation.message ?? "Select a valid active payment account for this farm.");
  return account;
}

function recipientSnapshot(input: {
  recipientScope: LabourRecipientScope;
  manualRecipientName?: string | null;
  contractorReference?: string | null;
  crewReference?: string | null;
  batchIdentity?: string | null;
  labourerName?: string | null;
  labourGroupName?: string | null;
  groupLeaderId?: string | null;
  groupLeaderName?: string | null;
  groupMembers?: Array<{ id: string; name: string }>;
  receivedBy?: string | null;
}) {
  return {
    recipientScope: input.recipientScope,
    manualRecipientName: input.manualRecipientName ?? null,
    contractorReference: input.contractorReference ?? null,
    crewReference: input.crewReference ?? null,
    batchIdentity: input.batchIdentity ?? null,
    labourerName: input.labourerName ?? null,
    labourGroupName: input.labourGroupName ?? null,
    groupLeaderId: input.groupLeaderId ?? null,
    groupLeaderName: input.groupLeaderName ?? null,
    groupMembers: input.groupMembers ?? [],
    receivedBy: input.receivedBy ?? null,
  };
}

async function loadRecipient(tx: DbTransaction, workspaceId: string, farmId: string, input: {
  recipientScope: LabourRecipientScope;
  labourerId?: string | null;
  labourGroupId?: string | null;
  receivedBy?: string | null;
  manualRecipientName?: string | null;
  contractorReference?: string | null;
  crewReference?: string | null;
  batchIdentity?: string | null;
}) {
  let labourerName: string | null = null;
  let labourGroupName: string | null = null;
  let groupLeaderId: string | null = null;
  let groupLeaderName: string | null = null;
  let groupMembers: Array<{ id: string; name: string }> = [];
  if (input.recipientScope === "INDIVIDUAL") {
    if (!input.labourerId) throw new Error("Select a labourer for an individual labour due.");
    const [record] = await tx.select({ payload: operationalRecords.payload }).from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, workspaceId), eq(operationalRecords.farmId, farmId),
      eq(operationalRecords.entityType, "labourer"), eq(operationalRecords.clientRecordId, input.labourerId),
    )).limit(1);
    if (!record || record.payload.deletedAt) throw new Error("The selected labourer was not found in this farm.");
    labourerName = typeof record.payload.name === "string" ? record.payload.name : "Labourer";
  }
  if (input.recipientScope === "LABOUR_GROUP") {
    if (!input.labourGroupId) throw new Error("Select a labour group for a group labour due.");
    const [record] = await tx.select({ payload: operationalRecords.payload }).from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, workspaceId), eq(operationalRecords.farmId, farmId),
      eq(operationalRecords.entityType, "labourGroup"), eq(operationalRecords.clientRecordId, input.labourGroupId),
    )).limit(1);
    if (!record || record.payload.deletedAt) throw new Error("The selected labour group was not found in this farm.");
    labourGroupName = typeof record.payload.name === "string" ? record.payload.name : "Labour Group";
    groupLeaderId = typeof record.payload.foremanLabourId === "string" ? record.payload.foremanLabourId : typeof record.payload.foremanId === "string" ? record.payload.foremanId : null;
    const labourRows = await tx.select({ clientRecordId: operationalRecords.clientRecordId, payload: operationalRecords.payload }).from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, workspaceId), eq(operationalRecords.farmId, farmId), eq(operationalRecords.entityType, "labourer"),
    ));
    groupMembers = labourRows.filter((item) => !item.payload.deletedAt && item.payload.groupId === input.labourGroupId).map((item) => ({ id: item.clientRecordId, name: typeof item.payload.name === "string" ? item.payload.name : "Labourer" }));
    const leaderRow = groupLeaderId ? labourRows.find((item) => item.clientRecordId === groupLeaderId) : null;
    groupLeaderName = typeof leaderRow?.payload.name === "string" ? leaderRow.payload.name : null;
  }
  const financialScopeKey = labourFinancialScopeKey(input);
  return {
    financialScopeKey,
    snapshot: recipientSnapshot({ ...input, labourerName, labourGroupName, groupLeaderId, groupLeaderName, groupMembers }),
  };
}

async function insertAccountMovement(tx: DbTransaction, input: {
  farmId: string;
  seasonId: string;
  voucherId: string;
  voucherNumber: string;
  voucherDate: string;
  amount: number;
  account: Awaited<ReturnType<typeof validatedAccount>>;
  actorId: string;
  reverse?: boolean;
}) {
  const normalType = input.account.accountType === "partner" ? "credit" : "debit";
  const type = input.reverse ? normalType === "credit" ? "debit" : "credit" : normalType;
  const [transaction] = await tx.insert(accountTransactions).values({
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
  }).returning({ id: accountTransactions.id });
  return transaction!.id;
}

async function requireRequestScope(request: FastifyRequest, reply: FastifyReply, workspaceId: string, farmId: string, seasonId: string, action: "view" | "create" | "edit" | "delete") {
  if (!request.appUser || !request.sessionId) {
    reply.code(401).send({ message: "A database-backed session is required." });
    return false;
  }
  if (request.appUser.workspaceId !== workspaceId || !hasModulePermission(request.appUser, workspaceId, "wages", action)) {
    reply.code(403).send({ message: "Workforce payment permission is required." });
    return false;
  }
  if (!hasFarmAccess(request.appUser, workspaceId, farmId) || !(await validateContext(request, workspaceId, farmId, seasonId))) {
    reply.code(403).send({ message: "Select this farm and season before managing labour payments." });
    return false;
  }
  const ownershipError = await validateTenantReferences(workspaceId, { farmId, seasonId });
  if (ownershipError) {
    reply.code(403).send({ message: ownershipError });
    return false;
  }
  return true;
}

export async function labourPaymentRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/workspace/:workspaceId/labour-payments/dues", { preHandler: requireUser }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const query = contextSchema.extend({ status: z.string().optional(), origin: z.string().optional(), search: z.string().optional() }).safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ message: "A valid labour due query is required." });
    const { workspaceId } = params.data;
    const { farmId, seasonId } = query.data;
    if (!(await requireRequestScope(request, reply, workspaceId, farmId, seasonId, "view"))) return;
    const rows = await db.select().from(labourDues).where(and(
      eq(labourDues.workspaceId, workspaceId), eq(labourDues.farmId, farmId), eq(labourDues.seasonId, seasonId),
      query.data.status ? eq(labourDues.paymentStatus, query.data.status) : inArray(labourDues.paymentStatus, ["UNPAID", "PARTIALLY_SETTLED", "ON_HOLD"]),
      query.data.origin ? eq(labourDues.origin, query.data.origin) : undefined,
    )).orderBy(desc(labourDues.createdAt));
    const settlementSourceIds = rows.filter((row) => row.origin === "SETTLEMENT").map((row) => row.sourceRecordId).filter((value): value is string => Boolean(value));
    const validSettlementSources = settlementSourceIds.length ? await db.select({ id: operationalRecords.id, payload: operationalRecords.payload }).from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, workspaceId), eq(operationalRecords.entityType, "labourWageSettlement"), inArray(operationalRecords.id, settlementSourceIds),
    )) : [];
    const activeSettlementSourceIds = new Set(validSettlementSources.filter((row) => !row.payload.deletedAt && !["voided", "deleted", "reversed"].includes(String(row.payload.status ?? "").toLowerCase())).map((row) => row.id));
    const validRows = rows.filter((row) => row.origin !== "SETTLEMENT" || (Boolean(row.sourceRecordId) && activeSettlementSourceIds.has(row.sourceRecordId!)));
    const dues = await db.transaction(async (tx) => Promise.all(validRows.map(async (row) => {
      const position = await loadLabourDuePosition(tx, row.id);
      return { ...row, ...position, due: undefined };
    })));
    const term = (query.data.search ?? "").trim().toLowerCase();
    return { dues: term ? dues.filter((due) => [due.dueNumber, due.description, JSON.stringify(due.recipientSnapshot)].join(" ").toLowerCase().includes(term)) : dues };
  });

  app.get("/v1/workspace/:workspaceId/labour-payments/dues/:dueId", { preHandler: requireUser }, async (request, reply) => {
    const params = dueParamsSchema.safeParse(request.params);
    const query = contextSchema.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ message: "A valid labour due is required." });
    if (!(await requireRequestScope(request, reply, params.data.workspaceId, query.data.farmId, query.data.seasonId, "view"))) return;
    const result = await db.transaction(async (tx) => {
      const position = await loadLabourDuePosition(tx, params.data.dueId);
      if (!position || position.due.workspaceId !== params.data.workspaceId || position.due.farmId !== query.data.farmId || position.due.seasonId !== query.data.seasonId) return null;
      const [payments, advances] = await Promise.all([
        tx.select({ allocation: labourPaymentAllocations, voucher: labourPaymentVouchers }).from(labourPaymentAllocations)
          .innerJoin(labourPaymentVouchers, eq(labourPaymentVouchers.id, labourPaymentAllocations.voucherId))
          .where(eq(labourPaymentAllocations.dueId, params.data.dueId)),
        tx.select({ application: labourAdvanceApplications, voucher: labourPaymentVouchers }).from(labourAdvanceApplications)
          .innerJoin(labourPaymentVouchers, eq(labourPaymentVouchers.id, labourAdvanceApplications.advanceVoucherId))
          .where(eq(labourAdvanceApplications.dueId, params.data.dueId)),
      ]);
      return { ...position, payments, advances };
    });
    return result ? { due: result } : reply.code(404).send({ message: "Labour due was not found." });
  });

  app.post("/v1/workspace/:workspaceId/labour-payments/dues", { preHandler: requireUser }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const body = directDueSchema.safeParse(request.body);
    if (!params.success || !body.success || (body.success && (body.data.workFromDate > body.data.workToDate || body.data.authorizedDeductions > body.data.grossAmount + body.data.leaderAllowance))) return reply.code(400).send({ message: "A valid direct labour due is required. Deductions cannot exceed the agreed amount." });
    const { workspaceId } = params.data;
    const input = body.data;
    if (!(await requireRequestScope(request, reply, workspaceId, input.farmId, input.seasonId, "create"))) return;
    try {
      const due = await db.transaction(async (tx) => {
        const [existing] = await tx.select().from(labourDues).where(and(eq(labourDues.workspaceId, workspaceId), eq(labourDues.idempotencyKey, input.idempotencyKey))).limit(1);
        if (existing) return existing;
        const recipient = await loadRecipient(tx, workspaceId, input.farmId, input);
        const dueNumber = await allocateLabourDueNumber(tx, workspaceId, input.farmId);
        const [created] = await tx.insert(labourDues).values({
          workspaceId, farmId: input.farmId, seasonId: input.seasonId, dueNumber,
          origin: "DIRECT", settlementBasis: "MANUAL", recipientScope: input.recipientScope,
          financialScopeKey: recipient.financialScopeKey, labourerId: input.labourerId,
          labourGroupId: input.labourGroupId, contractorReference: input.contractorReference,
          crewReference: input.crewReference, recipientSnapshot: { ...recipient.snapshot, notes: input.notes, costCategory: input.costCategory },
          description: input.description, workFromDate: input.workFromDate, workToDate: input.workToDate,
          grossAmount: input.grossAmount.toFixed(2), adjustmentAmount: input.leaderAllowance.toFixed(2),
          authorizedDeductions: input.authorizedDeductions.toFixed(2), calculationStatus: "APPROVED",
          paymentStatus: "UNPAID", approvedAt: new Date(), approvedBy: request.appUser!.id,
          idempotencyKey: input.idempotencyKey, createdBy: request.appUser!.id,
        }).returning();
        await postLabourDueRecognition(tx, { workspaceId, farmId: input.farmId, seasonId: input.seasonId, dueId: created!.id, amount: Math.max(input.grossAmount + input.leaderAllowance - input.authorizedDeductions, 0), actorId: request.appUser!.id });
        await tx.insert(auditLogs).values({ workspaceId, farmId: input.farmId, userId: request.appUser!.id, actorUserId: request.appUser!.id, action: "labour_due_created", entityType: "labour_due", entityId: created!.id, afterJson: created as unknown as Record<string, unknown> });
        return created!;
      });
      return reply.code(201).send({ due });
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : "Unable to create the labour due." });
    }
  });

  app.post("/v1/workspace/:workspaceId/labour-payments/dues/:dueId/settle", { preHandler: requireUser }, async (request, reply) => {
    const params = dueParamsSchema.safeParse(request.params);
    const body = settleSchema.safeParse(request.body);
    if (!params.success || !body.success || (!body.data.payment && body.data.advanceApplications.length === 0)) return reply.code(400).send({ message: "Select an advance or enter a payment." });
    const { workspaceId, dueId } = params.data;
    const input = body.data;
    if (!(await requireRequestScope(request, reply, workspaceId, input.farmId, input.seasonId, "create"))) return;
    try {
      const result = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${workspaceId}:${input.farmId}:${input.seasonId}:labour-payment-posting`}), 1)`);
        let position = await loadLabourDuePosition(tx, dueId);
        if (!position || position.due.workspaceId !== workspaceId || position.due.farmId !== input.farmId || position.due.seasonId !== input.seasonId) throw new Error("Labour due was not found.");
        if (["VOIDED", "ON_HOLD"].includes(position.due.paymentStatus)) throw new Error("This labour due cannot be settled in its current status.");
        for (const application of input.advanceApplications) {
          const [existingApplication] = await tx.select().from(labourAdvanceApplications).where(and(
            eq(labourAdvanceApplications.workspaceId, workspaceId), eq(labourAdvanceApplications.idempotencyKey, application.idempotencyKey),
          )).limit(1);
          if (existingApplication) {
            if (existingApplication.dueId !== dueId || existingApplication.advanceVoucherId !== application.advanceVoucherId || Math.abs(Number(existingApplication.amount) - application.amount) > 0.005) throw new Error("The advance application idempotency key was already used for a different allocation.");
            continue;
          }
          const [advance] = await tx.select().from(labourPaymentVouchers).where(and(
            eq(labourPaymentVouchers.id, application.advanceVoucherId), eq(labourPaymentVouchers.workspaceId, workspaceId),
            eq(labourPaymentVouchers.farmId, input.farmId), eq(labourPaymentVouchers.seasonId, input.seasonId),
          )).limit(1);
          if (!advance || advance.nature !== "ADVANCE" || advance.status !== "POSTED") throw new Error("The selected advance is not available.");
          if (advance.financialScopeKey !== position.due.financialScopeKey) throw new Error("An advance may only be applied to a due for the same financial scope.");
          const [applied] = await tx.select({ total: sql<number>`coalesce(sum(${labourAdvanceApplications.amount}) filter (where ${labourAdvanceApplications.status} = 'ACTIVE'), 0)::numeric` })
            .from(labourAdvanceApplications).where(eq(labourAdvanceApplications.advanceVoucherId, advance.id));
          const [refunded] = await tx.select({ total: sql<number>`coalesce(sum(${labourPaymentVouchers.paymentAmount}) filter (where ${labourPaymentVouchers.status} = 'POSTED' and ${labourPaymentVouchers.nature} = 'REFUND_RECOVERY'), 0)::numeric` })
            .from(labourPaymentVouchers).where(eq(labourPaymentVouchers.relatedAdvanceVoucherId, advance.id));
          const available = Math.max(Number(advance.paymentAmount) - Number(applied?.total ?? 0) - Number(refunded?.total ?? 0), 0);
          if (application.amount > available + 0.005) throw new Error("Advance application exceeds the available advance balance.");
          if (application.amount > position.outstandingBalance + 0.005) throw new Error("Advance application exceeds the current due balance.");
          const [createdApplication] = await tx.insert(labourAdvanceApplications).values({ workspaceId, advanceVoucherId: advance.id, dueId, amount: application.amount.toFixed(2), idempotencyKey: application.idempotencyKey, status: "ACTIVE" }).returning();
          await postLabourAdvanceApplicationJournal(tx, { workspaceId, farmId: input.farmId, seasonId: input.seasonId, dueId, advanceApplicationId: createdApplication!.id, amount: application.amount, actorId: request.appUser!.id });
          position = (await loadLabourDuePosition(tx, dueId))!;
        }
        let voucher = null;
        if (input.payment) {
          const [existingVoucher] = await tx.select().from(labourPaymentVouchers).where(and(
            eq(labourPaymentVouchers.workspaceId, workspaceId), eq(labourPaymentVouchers.idempotencyKey, input.payment.idempotencyKey),
          )).limit(1);
          if (existingVoucher) {
            if (existingVoucher.linkedDueId !== dueId || Math.abs(Number(existingVoucher.paymentAmount) - input.payment.amount) > 0.005) throw new Error("The payment idempotency key was already used for a different payment.");
            voucher = existingVoucher;
          } else {
            position = (await loadLabourDuePosition(tx, dueId))!;
            if (input.payment.amount > position.outstandingBalance + 0.005) throw new Error("Payment exceeds the current outstanding due balance.");
            const account = await validatedAccount(tx, workspaceId, input.farmId, input.payment.paymentAccountId);
            const voucherNumber = await allocateLabourPaymentVoucherNumber(tx, workspaceId, input.farmId);
            const nature = position.due.origin === "DIRECT" ? "DIRECT_LABOUR_PAYMENT" : "SETTLEMENT_BALANCE_PAYMENT";
            const [created] = await tx.insert(labourPaymentVouchers).values({
              workspaceId, farmId: input.farmId, seasonId: input.seasonId, voucherNumber,
              voucherDate: input.payment.voucherDate, nature, status: "POSTED",
              recipientScope: position.due.recipientScope, financialScopeKey: position.due.financialScopeKey,
              labourerId: position.due.labourerId, labourGroupId: position.due.labourGroupId,
              recipientSnapshot: position.due.recipientSnapshot, description: input.payment.description || `Payment for ${position.due.dueNumber}`,
              paymentAmount: input.payment.amount.toFixed(2), paymentAccountId: account.id,
              paymentMethod: input.payment.paymentMethod, transactionReference: input.payment.transactionReference,
              sourceType: position.due.origin === "DIRECT" ? "DIRECT_DUE" : "SETTLEMENT",
              sourceId: position.due.sourceClientRecordId, linkedDueId: dueId,
              idempotencyKey: input.payment.idempotencyKey, createdBy: request.appUser!.id,
              postedBy: request.appUser!.id, postedAt: new Date(), reconciliationStatus: "RECONCILED",
            }).returning();
            await postLabourVoucherJournal(tx, { workspaceId, farmId: input.farmId, seasonId: input.seasonId, voucherId: created!.id, nature, amount: input.payment.amount, accountType: account.accountType, actorId: request.appUser!.id, dueId });
            const accountTransactionId = await insertAccountMovement(tx, { farmId: input.farmId, seasonId: input.seasonId, voucherId: created!.id, voucherNumber, voucherDate: input.payment.voucherDate, amount: input.payment.amount, account, actorId: request.appUser!.id });
            await tx.update(labourPaymentVouchers).set({ accountTransactionId }).where(eq(labourPaymentVouchers.id, created!.id));
            await tx.insert(labourPaymentAllocations).values({ workspaceId, voucherId: created!.id, dueId, amount: input.payment.amount.toFixed(2), status: "ACTIVE" });
            voucher = { ...created!, accountTransactionId };
          }
        }
        const refreshed = await refreshLabourDuePaymentStatus(tx, dueId);
        await tx.insert(auditLogs).values({ workspaceId, farmId: input.farmId, userId: request.appUser!.id, actorUserId: request.appUser!.id, action: "labour_due_settled", entityType: "labour_due", entityId: dueId, details: { voucherId: voucher?.id ?? null, advanceApplications: input.advanceApplications, outstandingBalance: refreshed.outstandingBalance } });
        return { due: refreshed, voucher };
      });
      return { result };
    } catch (error) {
      return reply.code(409).send({ message: error instanceof Error ? error.message : "Unable to settle the labour due." });
    }
  });

  app.patch("/v1/workspace/:workspaceId/labour-payments/dues/:dueId/hold", { preHandler: requireUser }, async (request, reply) => {
    const params = dueParamsSchema.safeParse(request.params);
    const query = contextSchema.safeParse(request.query);
    const body = holdSchema.safeParse(request.body);
    if (!params.success || !query.success || !body.success) return reply.code(400).send({ message: "A valid hold request is required." });
    if (!(await requireRequestScope(request, reply, params.data.workspaceId, query.data.farmId, query.data.seasonId, "edit"))) return;
    const [due] = await db.update(labourDues).set({ paymentStatus: body.data.hold ? "ON_HOLD" : "UNPAID", holdReason: body.data.hold ? body.data.reason ?? "" : null, updatedAt: new Date() }).where(and(
      eq(labourDues.id, params.data.dueId), eq(labourDues.workspaceId, params.data.workspaceId), eq(labourDues.farmId, query.data.farmId), eq(labourDues.seasonId, query.data.seasonId),
    )).returning();
    if (!due) return reply.code(404).send({ message: "Labour due was not found." });
    if (!body.data.hold) await db.transaction((tx) => refreshLabourDuePaymentStatus(tx, due.id));
    return { due };
  });

  app.post("/v1/workspace/:workspaceId/labour-payments/dues/:dueId/void", { preHandler: requireUser }, async (request, reply) => {
    const params = dueParamsSchema.safeParse(request.params);
    const query = contextSchema.safeParse(request.query);
    const body = voidSchema.safeParse(request.body);
    if (!params.success || !query.success || !body.success) return reply.code(400).send({ message: "A valid due void request is required." });
    if (!(await requireRequestScope(request, reply, params.data.workspaceId, query.data.farmId, query.data.seasonId, "delete"))) return;
    try {
      const due = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${params.data.workspaceId}:${query.data.farmId}:${query.data.seasonId}:labour-payment-posting`}), 1)`);
        const [record] = await tx.select().from(labourDues).where(and(
          eq(labourDues.id, params.data.dueId), eq(labourDues.workspaceId, params.data.workspaceId),
          eq(labourDues.farmId, query.data.farmId), eq(labourDues.seasonId, query.data.seasonId),
        )).limit(1);
        if (!record) throw new Error("Labour due was not found.");
        if (record.paymentStatus === "VOIDED") return record;
        if (record.origin === "SETTLEMENT") throw new Error("Void the source Labour Settlement so attendance, expense, and advance eligibility are restored together.");
        const [activePayment, activeAdvance] = await Promise.all([
          tx.select({ id: labourPaymentAllocations.id }).from(labourPaymentAllocations).where(and(eq(labourPaymentAllocations.dueId, record.id), eq(labourPaymentAllocations.status, "ACTIVE"))).limit(1),
          tx.select({ id: labourAdvanceApplications.id }).from(labourAdvanceApplications).where(and(eq(labourAdvanceApplications.dueId, record.id), eq(labourAdvanceApplications.status, "ACTIVE"))).limit(1),
        ]);
        if (activePayment.length) throw new Error("Void linked payment vouchers before voiding this due.");
        if (activeAdvance.length) throw new Error("Reverse linked advance applications before voiding this due.");
        const now = new Date();
        const [voided] = await tx.update(labourDues).set({ calculationStatus: "VOIDED", paymentStatus: "VOIDED", voidReason: body.data.reason, voidedAt: now, voidedBy: request.appUser!.id, updatedAt: now }).where(eq(labourDues.id, record.id)).returning();
        await reverseLabourJournal(tx, { workspaceId: params.data.workspaceId, farmId: query.data.farmId, seasonId: query.data.seasonId, actorId: request.appUser!.id, reversalKey: `due-void:${record.id}:${body.data.idempotencyKey}`, dueId: record.id });
        await tx.insert(auditLogs).values({ workspaceId: params.data.workspaceId, farmId: query.data.farmId, userId: request.appUser!.id, actorUserId: request.appUser!.id, action: "labour_due_voided", entityType: "labour_due", entityId: record.id, details: { reason: body.data.reason, idempotencyKey: body.data.idempotencyKey } });
        return voided!;
      });
      return { due };
    } catch (error) {
      return reply.code(409).send({ message: error instanceof Error ? error.message : "Unable to void the labour due." });
    }
  });

  app.post("/v1/workspace/:workspaceId/labour-payments/dues/:dueId/advance-applications/:applicationId/reverse", { preHandler: requireUser }, async (request, reply) => {
    const params = advanceApplicationParamsSchema.safeParse(request.params);
    const query = contextSchema.safeParse(request.query);
    const body = voidSchema.safeParse(request.body);
    if (!params.success || !query.success || !body.success) return reply.code(400).send({ message: "A valid advance application reversal is required." });
    if (!(await requireRequestScope(request, reply, params.data.workspaceId, query.data.farmId, query.data.seasonId, "edit"))) return;
    try {
      const result = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${params.data.workspaceId}:${query.data.farmId}:${query.data.seasonId}:labour-payment-posting`}), 1)`);
        const [application] = await tx.select({ application: labourAdvanceApplications, due: labourDues }).from(labourAdvanceApplications)
          .innerJoin(labourDues, eq(labourDues.id, labourAdvanceApplications.dueId))
          .where(and(eq(labourAdvanceApplications.id, params.data.applicationId), eq(labourAdvanceApplications.dueId, params.data.dueId), eq(labourAdvanceApplications.workspaceId, params.data.workspaceId), eq(labourDues.farmId, query.data.farmId), eq(labourDues.seasonId, query.data.seasonId))).limit(1);
        if (!application) throw new Error("Advance application was not found.");
        if (application.application.status === "REVERSED") return { application: application.application, due: await loadLabourDuePosition(tx, params.data.dueId) };
        const now = new Date();
        const [reversed] = await tx.update(labourAdvanceApplications).set({ status: "REVERSED", reversedAt: now, reversedBy: request.appUser!.id, updatedAt: now }).where(eq(labourAdvanceApplications.id, application.application.id)).returning();
        await reverseLabourJournal(tx, { workspaceId: params.data.workspaceId, farmId: query.data.farmId, seasonId: query.data.seasonId, actorId: request.appUser!.id, reversalKey: `advance-application-reversal:${body.data.idempotencyKey}`, advanceApplicationId: application.application.id });
        const due = await refreshLabourDuePaymentStatus(tx, params.data.dueId);
        await tx.insert(auditLogs).values({ workspaceId: params.data.workspaceId, farmId: query.data.farmId, userId: request.appUser!.id, actorUserId: request.appUser!.id, action: "labour_advance_application_reversed", entityType: "labour_advance_application", entityId: application.application.id, details: { reason: body.data.reason, idempotencyKey: body.data.idempotencyKey } });
        return { application: reversed!, due };
      });
      return { result };
    } catch (error) {
      return reply.code(409).send({ message: error instanceof Error ? error.message : "Unable to reverse the advance application." });
    }
  });

  app.post("/v1/workspace/:workspaceId/labour-payments/advances", { preHandler: requireUser }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const body = advanceSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ message: "A valid labour advance is required." });
    const { workspaceId } = params.data;
    const input = body.data;
    if (!(await requireRequestScope(request, reply, workspaceId, input.farmId, input.seasonId, "create"))) return;
    try {
      const voucher = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${workspaceId}:${input.farmId}:${input.seasonId}:labour-payment-posting`}), 1)`);
        const [existing] = await tx.select().from(labourPaymentVouchers).where(and(eq(labourPaymentVouchers.workspaceId, workspaceId), eq(labourPaymentVouchers.idempotencyKey, input.idempotencyKey))).limit(1);
        if (existing) {
          if (existing.nature !== "ADVANCE" || Math.abs(Number(existing.paymentAmount) - input.amount) > 0.005) throw new Error("The idempotency key was already used for a different Labour Payment Voucher.");
          return existing;
        }
        const recipient = await loadRecipient(tx, workspaceId, input.farmId, input);
        const account = await validatedAccount(tx, workspaceId, input.farmId, input.paymentAccountId);
        const clientRecordId = crypto.randomUUID();
        const now = new Date();
        const [sourceRecord] = await tx.insert(operationalRecords).values({
          workspaceId, farmId: input.farmId, seasonId: input.seasonId, clientRecordId,
          entityType: "advance", recordedBy: request.appUser!.id, clientUpdatedAt: now,
          payload: {
            id: clientRecordId, workspaceId, farmId: input.farmId, seasonId: input.seasonId,
            labourerId: input.labourerId ?? null, labourGroupId: input.labourGroupId ?? null,
            labourGroupName: recipient.snapshot.labourGroupName, recipientScope: input.recipientScope,
            financialScopeKey: recipient.financialScopeKey, recipientSnapshot: recipient.snapshot,
            date: input.voucherDate, amount: input.amount, accountId: account.id,
            sourceAccountName: account.name, paymentMethod: input.paymentMethod,
            notes: input.description, status: "posted", createdBy: request.appUser!.id,
            createdAt: now.toISOString(), updatedAt: now.toISOString(),
          },
        }).returning();
        const voucherNumber = await allocateLabourPaymentVoucherNumber(tx, workspaceId, input.farmId);
        const [created] = await tx.insert(labourPaymentVouchers).values({
          workspaceId, farmId: input.farmId, seasonId: input.seasonId, voucherNumber,
          voucherDate: input.voucherDate, nature: "ADVANCE", status: "POSTED",
          recipientScope: input.recipientScope, financialScopeKey: recipient.financialScopeKey,
          labourerId: input.labourerId, labourGroupId: input.labourGroupId,
          recipientSnapshot: recipient.snapshot, description: input.description,
          paymentAmount: input.amount.toFixed(2), paymentAccountId: account.id,
          paymentMethod: input.paymentMethod, transactionReference: input.transactionReference,
          sourceType: "ADVANCE", sourceId: clientRecordId, legacySourceRecordId: sourceRecord!.id,
          idempotencyKey: input.idempotencyKey, createdBy: request.appUser!.id,
          postedBy: request.appUser!.id, postedAt: now, reconciliationStatus: "RECONCILED",
        }).returning();
        await postLabourVoucherJournal(tx, { workspaceId, farmId: input.farmId, seasonId: input.seasonId, voucherId: created!.id, nature: "ADVANCE", amount: input.amount, accountType: account.accountType, actorId: request.appUser!.id });
        const accountTransactionId = await insertAccountMovement(tx, { farmId: input.farmId, seasonId: input.seasonId, voucherId: created!.id, voucherNumber, voucherDate: input.voucherDate, amount: input.amount, account, actorId: request.appUser!.id });
        const [updated] = await tx.update(labourPaymentVouchers).set({ accountTransactionId }).where(eq(labourPaymentVouchers.id, created!.id)).returning();
        await tx.insert(auditLogs).values({ workspaceId, farmId: input.farmId, userId: request.appUser!.id, actorUserId: request.appUser!.id, action: "labour_advance_posted", entityType: "labour_payment_voucher", entityId: created!.id, afterJson: updated as unknown as Record<string, unknown> });
        return updated!;
      });
      return reply.code(201).send({ voucher });
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : "Unable to post the labour advance." });
    }
  });

  app.get("/v1/workspace/:workspaceId/labour-payments/vouchers", { preHandler: requireUser }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const query = contextSchema.extend({ nature: z.string().optional(), status: z.string().optional() }).safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ message: "A valid Labour Payment Voucher query is required." });
    if (!(await requireRequestScope(request, reply, params.data.workspaceId, query.data.farmId, query.data.seasonId, "view"))) return;
    const vouchers = await db.select().from(labourPaymentVouchers).where(and(
      eq(labourPaymentVouchers.workspaceId, params.data.workspaceId), eq(labourPaymentVouchers.farmId, query.data.farmId), eq(labourPaymentVouchers.seasonId, query.data.seasonId),
      query.data.nature ? eq(labourPaymentVouchers.nature, query.data.nature) : undefined,
      query.data.status ? eq(labourPaymentVouchers.status, query.data.status) : undefined,
    )).orderBy(desc(labourPaymentVouchers.voucherDate), desc(labourPaymentVouchers.createdAt));
    return { vouchers };
  });

  app.get("/v1/workspace/:workspaceId/labour-payments/advances", { preHandler: requireUser }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const query = advanceListQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ message: "A valid advance query is required." });
    if (!(await requireRequestScope(request, reply, params.data.workspaceId, query.data.farmId, query.data.seasonId, "view"))) return;
    const startedAt = performance.now();
    const search = query.data.search ? `%${query.data.search.replaceAll("%", "\\%").replaceAll("_", "\\_")}%` : null;
    const offset = (query.data.page - 1) * query.data.pageSize;
    const databaseStartedAt = performance.now();
    const result = await db.execute(sql`
      WITH application_totals AS (
        SELECT advance_voucher_id, sum(amount) FILTER (WHERE status='ACTIVE')::numeric AS applied_amount
        FROM labour_advance_applications WHERE workspace_id=${params.data.workspaceId} GROUP BY advance_voucher_id
      ), refund_totals AS (
        SELECT related_advance_voucher_id, sum(payment_amount) FILTER (WHERE status='POSTED' AND nature='REFUND_RECOVERY')::numeric AS refunded_amount
        FROM labour_payment_vouchers WHERE workspace_id=${params.data.workspaceId} AND related_advance_voucher_id IS NOT NULL GROUP BY related_advance_voucher_id
      ), legacy_application_totals AS (
        SELECT advance_record_id, sum(absorbed_amount)::numeric AS applied_amount
        FROM labour_wage_settlement_advance_allocations WHERE workspace_id=${params.data.workspaceId} GROUP BY advance_record_id
      ), operational_people AS (
        SELECT DISTINCT ON (workspace_id,entity_type,client_record_id) workspace_id,entity_type,client_record_id,payload
        FROM operational_records WHERE workspace_id=${params.data.workspaceId} AND entity_type IN ('labourer','labourGroup')
        ORDER BY workspace_id,entity_type,client_record_id,client_updated_at DESC,updated_at DESC
      ), source_rows AS (
        SELECT voucher.id::text AS id, voucher.id::text AS canonical_id,
          CASE WHEN voucher.voucher_number ~ '^LPV-LA-[0-9a-f]{8}$' THEN COALESCE(NULLIF(source_record.payload->>'voucherNumber',''),NULLIF(source_record.payload->>'voucherNo',''),NULLIF(source_record.payload->>'reference',''),'ADV-L-'||lpad(abs(hashtextextended(COALESCE(voucher.source_id,voucher.id::text),0)%10000000)::text,7,'0')) ELSE voucher.voucher_number END AS display_voucher_number,
          voucher.voucher_date, voucher.created_at, voucher.recipient_scope, voucher.financial_scope_key,
          voucher.labourer_id AS financial_owner_id, voucher.labour_group_id,
          CASE voucher.recipient_scope
            WHEN 'LABOUR_GROUP' THEN COALESCE(NULLIF(voucher.recipient_snapshot->>'labourGroupName',''),NULLIF(group_person.payload->>'name',''),normalized_group.name)
            WHEN 'INDIVIDUAL' THEN COALESCE(NULLIF(voucher.recipient_snapshot->>'labourerName',''),NULLIF(labour_person.payload->>'name',''),normalized_labour.name)
            ELSE COALESCE(NULLIF(voucher.recipient_snapshot->>'manualRecipientName',''),NULLIF(voucher.recipient_snapshot->>'crewReference',''),NULLIF(voucher.recipient_snapshot->>'contractorReference',''),NULLIF(voucher.recipient_snapshot->>'batchIdentity',''))
          END AS financial_owner_name,
          COALESCE(NULLIF(voucher.recipient_snapshot->>'receivedBy',''),NULLIF(voucher.recipient_snapshot->>'recipientName','')) AS received_by_name,
          NULLIF(voucher.recipient_snapshot->>'leaderSnapshot','') AS group_leader_snapshot,
          voucher.description, voucher.payment_amount::numeric AS original_amount,
          COALESCE(applications.applied_amount,0)::numeric AS applied_amount,
          COALESCE(refunds.refunded_amount,0)::numeric AS refunded_amount,
          CASE WHEN voucher.status='VOIDED' THEN voucher.payment_amount ELSE 0 END::numeric AS reversed_amount,
          voucher.status, voucher.payment_account_id::text AS payment_account_id,
          COALESCE(account.name,NULLIF(voucher.recipient_snapshot->>'sourceAccountName','')) AS payment_account_name,
          voucher.payment_method, voucher.transaction_reference, voucher.source_type, voucher.source_id,
          voucher.legacy, voucher.reconciliation_status, voucher.created_by::text AS created_by,
          creator.display_name AS created_by_name, false AS read_only_legacy
        FROM labour_payment_vouchers voucher
        LEFT JOIN application_totals applications ON applications.advance_voucher_id=voucher.id
        LEFT JOIN refund_totals refunds ON refunds.related_advance_voucher_id=voucher.id
        LEFT JOIN accounts account ON account.id=voucher.payment_account_id
        LEFT JOIN operational_records source_record ON source_record.id=voucher.legacy_source_record_id
        LEFT JOIN operational_people labour_person ON labour_person.workspace_id=voucher.workspace_id AND labour_person.entity_type='labourer' AND labour_person.client_record_id=voucher.labourer_id
        LEFT JOIN operational_people group_person ON group_person.workspace_id=voucher.workspace_id AND group_person.entity_type='labourGroup' AND group_person.client_record_id=voucher.labour_group_id
        LEFT JOIN labourers normalized_labour ON normalized_labour.id=CASE WHEN voucher.labourer_id ~* '^[0-9a-f-]{36}$' THEN voucher.labourer_id::uuid END
        LEFT JOIN labour_groups normalized_group ON normalized_group.id=CASE WHEN voucher.labour_group_id ~* '^[0-9a-f-]{36}$' THEN voucher.labour_group_id::uuid END
        LEFT JOIN users creator ON creator.id=voucher.created_by
        WHERE voucher.workspace_id=${params.data.workspaceId} AND voucher.farm_id=${query.data.farmId}::uuid AND voucher.season_id=${query.data.seasonId}::uuid AND voucher.nature='ADVANCE'
        UNION ALL
        SELECT advance.id::text, NULL::text,
          COALESCE(NULLIF(advance.payload->>'voucherNumber',''),NULLIF(advance.payload->>'voucherNo',''),NULLIF(advance.payload->>'reference',''),'ADV-L-'||lpad(abs(hashtextextended(advance.id::text,0)%10000000)::text,7,'0')),
          COALESCE(NULLIF(advance.payload->>'date','')::date,NULLIF(advance.payload->>'advanceDate','')::date,advance.created_at::date), advance.created_at,
          CASE WHEN NULLIF(advance.payload->>'labourGroupId','') IS NOT NULL THEN 'LABOUR_GROUP' ELSE 'INDIVIDUAL' END,
          CASE WHEN NULLIF(advance.payload->>'labourGroupId','') IS NOT NULL THEN 'group:'||(advance.payload->>'labourGroupId') ELSE 'individual:'||COALESCE(NULLIF(advance.payload->>'labourerId',''),NULLIF(advance.payload->>'labourId',''),advance.client_record_id) END,
          COALESCE(NULLIF(advance.payload->>'labourerId',''),NULLIF(advance.payload->>'labourId','')),NULLIF(advance.payload->>'labourGroupId',''),
          CASE WHEN NULLIF(advance.payload->>'labourGroupId','') IS NOT NULL THEN COALESCE(NULLIF(advance.payload->>'labourGroupName',''),NULLIF(group_person.payload->>'name','')) ELSE COALESCE(NULLIF(advance.payload->>'labourerName',''),NULLIF(labour_person.payload->>'name','')) END,
          COALESCE(NULLIF(advance.payload->>'receivedBy',''),NULLIF(advance.payload->>'recipientName','')),NULLIF(advance.payload->>'leaderName',''),
          COALESCE(NULLIF(advance.payload->>'notes',''),'Legacy labour advance'),(advance.payload->>'amount')::numeric,COALESCE(applications.applied_amount,0),0,
          CASE WHEN NULLIF(advance.payload->>'deletedAt','') IS NOT NULL OR lower(COALESCE(advance.payload->>'status','')) IN ('voided','deleted','reversed') OR NULLIF(advance.payload->>'voidedAt','') IS NOT NULL OR NULLIF(advance.payload->>'reversedAt','') IS NOT NULL THEN (advance.payload->>'amount')::numeric ELSE 0 END,
          CASE WHEN NULLIF(advance.payload->>'deletedAt','') IS NOT NULL OR lower(COALESCE(advance.payload->>'status','')) IN ('voided','deleted','reversed') THEN 'VOIDED' ELSE 'POSTED' END,
          CASE WHEN NULLIF(advance.payload->>'accountId','') ~* '^[0-9a-f-]{36}$' THEN advance.payload->>'accountId' ELSE NULL END,
          COALESCE(account.name,NULLIF(advance.payload->>'sourceAccountName','')),NULLIF(advance.payload->>'paymentMethod',''),advance.client_record_id,'LEGACY_OPERATIONAL_ADVANCE',advance.client_record_id,true,'LEGACY_READ_MODEL',advance.recorded_by::text,creator.display_name,true
        FROM operational_records advance
        LEFT JOIN legacy_application_totals applications ON applications.advance_record_id=advance.id
        LEFT JOIN operational_people labour_person ON labour_person.workspace_id=advance.workspace_id AND labour_person.entity_type='labourer' AND labour_person.client_record_id=COALESCE(NULLIF(advance.payload->>'labourerId',''),NULLIF(advance.payload->>'labourId',''))
        LEFT JOIN operational_people group_person ON group_person.workspace_id=advance.workspace_id AND group_person.entity_type='labourGroup' AND group_person.client_record_id=NULLIF(advance.payload->>'labourGroupId','')
        LEFT JOIN accounts account ON account.id::text=NULLIF(advance.payload->>'accountId','')
        LEFT JOIN users creator ON creator.id=advance.recorded_by
        WHERE advance.workspace_id=${params.data.workspaceId} AND advance.entity_type='advance'
          AND NULLIF(advance.payload->>'amount','') ~ '^[0-9]+([.][0-9]+)?$' AND (advance.payload->>'amount')::numeric>0
          AND (advance.farm_id=${query.data.farmId}::uuid OR advance.farm_id IS NULL) AND (advance.season_id=${query.data.seasonId}::uuid OR advance.season_id IS NULL)
          AND NOT EXISTS (SELECT 1 FROM labour_payment_vouchers mapped WHERE mapped.nature='ADVANCE' AND (mapped.legacy_source_record_id=advance.id OR mapped.source_id=advance.client_record_id))
        UNION ALL
        SELECT advance.id::text,NULL::text,COALESCE(NULLIF(advance.old_android_id,''),'ADV-N-'||lpad(abs(hashtextextended(advance.id::text,0)%10000000)::text,7,'0')),
          advance.advance_date,advance.created_at,'INDIVIDUAL','individual:'||advance.labourer_id::text,advance.labourer_id::text,NULL::text,labourer.name,NULL::text,NULL::text,
          COALESCE(NULLIF(advance.description,''),'Legacy labour advance'),advance.amount,0,0,0,'POSTED',advance.account_id::text,account.name,NULL::text,NULLIF(advance.old_android_id,''),'LEGACY_NORMALIZED_ADVANCE',advance.id::text,true,'LEGACY_READ_MODEL',advance.created_by::text,creator.display_name,true
        FROM advance_records advance JOIN farms farm ON farm.id=advance.farm_id
        LEFT JOIN labourers labourer ON labourer.id=advance.labourer_id LEFT JOIN accounts account ON account.id=advance.account_id LEFT JOIN users creator ON creator.id=advance.created_by
        WHERE farm.workspace_id=${params.data.workspaceId} AND advance.farm_id=${query.data.farmId}::uuid AND advance.season_id=${query.data.seasonId}::uuid
          AND NOT EXISTS (SELECT 1 FROM labour_payment_vouchers mapped WHERE mapped.nature='ADVANCE' AND mapped.source_type='LEGACY_ADVANCE_RECORD' AND mapped.source_id=advance.id::text)
          AND NOT EXISTS (SELECT 1 FROM operational_records operational WHERE operational.workspace_id=${params.data.workspaceId} AND operational.entity_type='advance' AND (operational.payload->>'normalizedAdvanceRecordId'=advance.id::text OR operational.payload->>'oldAndroidId'=advance.old_android_id))
      ), positioned AS (
        SELECT *,greatest(original_amount-applied_amount-refunded_amount-reversed_amount,0)::numeric AS outstanding_amount,
          CASE WHEN status='VOIDED' THEN 'VOIDED' WHEN greatest(original_amount-applied_amount-refunded_amount-reversed_amount,0)<=0.005 AND applied_amount>0 THEN 'FULLY_APPLIED' WHEN greatest(original_amount-applied_amount-refunded_amount-reversed_amount,0)<=0.005 AND refunded_amount>0 THEN 'FULLY_REFUNDED' WHEN refunded_amount>0 THEN 'PARTIALLY_REFUNDED' WHEN applied_amount>0 THEN 'PARTIALLY_APPLIED' ELSE 'OUTSTANDING' END AS advance_status,
          (financial_owner_name IS NULL OR payment_account_name IS NULL OR reconciliation_status IN ('NEEDS_REVIEW','LEGACY_UNLINKED')) AS review_required
        FROM source_rows
      ), filtered AS (
        SELECT * FROM positioned WHERE
          (${query.data.status}='ALL' OR (${query.data.status}='OPEN' AND status<>'VOIDED' AND outstanding_amount>0.005) OR advance_status=${query.data.status})
          AND (${query.data.recipientScope ?? null}::text IS NULL OR recipient_scope=${query.data.recipientScope ?? null})
          AND (${query.data.accountId ?? null}::text IS NULL OR payment_account_id=${query.data.accountId ?? null})
          AND (${query.data.from ?? null}::date IS NULL OR voucher_date>=${query.data.from ?? null}::date)
          AND (${query.data.to ?? null}::date IS NULL OR voucher_date<=${query.data.to ?? null}::date)
          AND (${search}::text IS NULL OR concat_ws(' ',display_voucher_number,financial_owner_name,received_by_name,group_leader_snapshot,payment_account_name,description) ILIKE ${search} ESCAPE '\\')
      )
      SELECT *,count(*) OVER()::int AS total_count,coalesce(sum(outstanding_amount) OVER(),0)::numeric AS total_outstanding,
        count(*) FILTER (WHERE advance_status IN ('PARTIALLY_APPLIED','PARTIALLY_REFUNDED')) OVER()::int AS partially_applied_count
      FROM filtered ORDER BY voucher_date DESC,created_at DESC,id DESC LIMIT ${query.data.pageSize} OFFSET ${offset}
    `);
    const databaseMs = performance.now() - databaseStartedAt;
    const rawRows = result.rows as Array<Record<string, unknown>>;
    const advances = rawRows.map((row) => ({
      id: String(row.canonical_id ?? row.id), canonicalId: row.canonical_id ? String(row.canonical_id) : null,
      voucherNumber: String(row.display_voucher_number), displayVoucherNumber: String(row.display_voucher_number), voucherDate: String(row.voucher_date),
      recipientScope: String(row.recipient_scope), financialScopeKey: String(row.financial_scope_key), financialOwnerId: row.financial_owner_id ? String(row.financial_owner_id) : null,
      labourerId: String(row.recipient_scope)==="INDIVIDUAL" && row.financial_owner_id ? String(row.financial_owner_id) : null, labourGroupId: row.labour_group_id ? String(row.labour_group_id) : null,
      financialOwnerName: row.financial_owner_name ? String(row.financial_owner_name) : null, receivedByName: row.received_by_name ? String(row.received_by_name) : null,
      groupLeaderSnapshot: row.group_leader_snapshot ? String(row.group_leader_snapshot) : null,
      recipientSnapshot: {
        ...(String(row.recipient_scope)==="INDIVIDUAL" && row.financial_owner_name ? { labourerName:String(row.financial_owner_name) } : {}),
        ...(String(row.recipient_scope)==="LABOUR_GROUP" && row.financial_owner_name ? { labourGroupName:String(row.financial_owner_name) } : {}),
        ...(!["INDIVIDUAL","LABOUR_GROUP"].includes(String(row.recipient_scope)) && row.financial_owner_name ? { manualRecipientName:String(row.financial_owner_name) } : {}),
        ...(row.received_by_name ? { receivedBy:String(row.received_by_name) } : {}),
      }, description: String(row.description),
      originalAmount:Number(row.original_amount),appliedAmount:Number(row.applied_amount),refundedAmount:Number(row.refunded_amount),reversedAmount:Number(row.reversed_amount),outstandingAmount:Number(row.outstanding_amount),advanceStatus:String(row.advance_status),
      paymentAmount:String(row.original_amount),paymentAccountId:row.payment_account_id?String(row.payment_account_id):null,paymentAccountName:row.payment_account_name?String(row.payment_account_name):null,
      paymentMethod:row.payment_method?String(row.payment_method):null,transactionReference:row.transaction_reference?String(row.transaction_reference):null,status:String(row.status),nature:"ADVANCE",sourceType:String(row.source_type),sourceId:row.source_id?String(row.source_id):null,
      legacy:Boolean(row.legacy),reconciliationStatus:String(row.reconciliation_status),reviewRequired:Boolean(row.review_required),readOnlyLegacy:Boolean(row.read_only_legacy),createdBy:row.created_by?String(row.created_by):null,createdByName:row.created_by_name?String(row.created_by_name):null,createdAt:String(row.created_at),
    }));
    const totalCount=Number(rawRows[0]?.total_count??0); const totalOutstanding=Number(rawRows[0]?.total_outstanding??0); const partiallyAppliedCount=Number(rawRows[0]?.partially_applied_count??0);
    const response={advances,summary:{totalOutstanding,openCount:totalCount,partiallyAppliedCount},pageInfo:{page:query.data.page,pageSize:query.data.pageSize,totalCount,hasMore:offset+advances.length<totalCount},diagnostics:{queryCount:1,databaseMs:Number(databaseMs.toFixed(2)),totalMs:Number((performance.now()-startedAt).toFixed(2))}};
    const payloadBytes=Buffer.byteLength(JSON.stringify(response)); response.diagnostics.totalMs=Number((performance.now()-startedAt).toFixed(2));
    reply.header("Server-Timing",`db;dur=${response.diagnostics.databaseMs}, total;dur=${response.diagnostics.totalMs}`).header("X-Result-Count",String(advances.length)).header("X-Payload-Bytes",String(payloadBytes));
    return response;
  });

  app.get("/v1/workspace/:workspaceId/labour-payments/reconciliation", { preHandler: requireUser }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const query = contextSchema.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ message: "A valid reconciliation query is required." });
    if (!(await requireRequestScope(request, reply, params.data.workspaceId, query.data.farmId, query.data.seasonId, "view"))) return;
    const [journal, vouchers, dues, legacyOperational] = await Promise.all([
      db.select().from(labourAccountingEntries).where(and(eq(labourAccountingEntries.workspaceId, params.data.workspaceId), eq(labourAccountingEntries.farmId, query.data.farmId), eq(labourAccountingEntries.seasonId, query.data.seasonId), eq(labourAccountingEntries.status, "POSTED"))),
      db.select().from(labourPaymentVouchers).where(and(eq(labourPaymentVouchers.workspaceId, params.data.workspaceId), eq(labourPaymentVouchers.farmId, query.data.farmId), eq(labourPaymentVouchers.seasonId, query.data.seasonId))),
      db.select().from(labourDues).where(and(eq(labourDues.workspaceId, params.data.workspaceId), eq(labourDues.farmId, query.data.farmId), eq(labourDues.seasonId, query.data.seasonId))),
      db.select({ id: operationalRecords.id, clientRecordId: operationalRecords.clientRecordId, entityType: operationalRecords.entityType }).from(operationalRecords).where(and(eq(operationalRecords.workspaceId, params.data.workspaceId), eq(operationalRecords.farmId, query.data.farmId), eq(operationalRecords.seasonId, query.data.seasonId), inArray(operationalRecords.entityType, ["advance", "labourPayment"]))),
    ]);
    const debitTotal = journal.reduce((sum, row) => sum + Number(row.debit), 0);
    const creditTotal = journal.reduce((sum, row) => sum + Number(row.credit), 0);
    const positions = await db.transaction(async (tx) => Promise.all(dues.map((due) => loadLabourDuePosition(tx, due.id))));
    const postedCashVouchers = vouchers.filter((voucher) => voucher.status === "POSTED");
    const missingAccountTransactions = postedCashVouchers.filter((voucher) => !voucher.accountTransactionId && !voucher.legacy).map((voucher) => voucher.voucherNumber);
    const legacyNeedsReview = vouchers.filter((voucher) => voucher.reconciliationStatus === "NEEDS_REVIEW" || voucher.reconciliationStatus === "LEGACY_UNLINKED").map((voucher) => voucher.voucherNumber);
    const mappedLegacyIds = new Set(vouchers.map((voucher) => voucher.legacySourceRecordId).filter(Boolean));
    const unmappedLegacyRecords = legacyOperational.filter((record) => !mappedLegacyIds.has(record.id)).map((record) => ({ entityType: record.entityType, clientRecordId: record.clientRecordId }));
    const byLedger = journal.reduce<Record<string, { debit: number; credit: number }>>((result, row) => {
      const current = result[row.ledgerCode] ?? { debit: 0, credit: 0 };
      current.debit += Number(row.debit); current.credit += Number(row.credit); result[row.ledgerCode] = current; return result;
    }, {});
    return {
      reconciliation: {
        journal: { debitTotal, creditTotal, difference: Math.round((debitTotal - creditTotal) * 100) / 100, byLedger },
        outstandingPayables: positions.reduce((sum, position) => sum + (position?.outstandingBalance ?? 0), 0),
        postedVoucherCount: postedCashVouchers.length,
        postedCashAmount: postedCashVouchers.reduce((sum, voucher) => sum + Number(voucher.paymentAmount), 0),
        missingAccountTransactions,
        legacyNeedsReview,
        unmappedLegacyRecords,
        reconciled: Math.abs(debitTotal - creditTotal) < 0.01 && missingAccountTransactions.length === 0 && legacyNeedsReview.length === 0 && unmappedLegacyRecords.length === 0,
      },
    };
  });

  app.post("/v1/workspace/:workspaceId/labour-payments/advances/:voucherId/refund", { preHandler: requireUser }, async (request, reply) => {
    const params = voucherParamsSchema.safeParse(request.params);
    const body = refundSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ message: "A valid advance refund is required." });
    if (!(await requireRequestScope(request, reply, params.data.workspaceId, body.data.farmId, body.data.seasonId, "create"))) return;
    try {
      const voucher = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${params.data.workspaceId}:${body.data.farmId}:${body.data.seasonId}:labour-payment-posting`}), 1)`);
        const [existing] = await tx.select().from(labourPaymentVouchers).where(and(eq(labourPaymentVouchers.workspaceId, params.data.workspaceId), eq(labourPaymentVouchers.idempotencyKey, body.data.payment.idempotencyKey))).limit(1);
        if (existing) {
          if (existing.nature !== "REFUND_RECOVERY" || existing.relatedAdvanceVoucherId !== params.data.voucherId || Math.abs(Number(existing.paymentAmount) - body.data.payment.amount) > 0.005) throw new Error("The idempotency key was already used for a different refund.");
          return existing;
        }
        const [advance] = await tx.select().from(labourPaymentVouchers).where(and(eq(labourPaymentVouchers.id, params.data.voucherId), eq(labourPaymentVouchers.nature, "ADVANCE"), eq(labourPaymentVouchers.status, "POSTED"))).limit(1);
        if (!advance) throw new Error("The advance is not available for refund.");
        const [applied] = await tx.select({ total: sql<number>`coalesce(sum(${labourAdvanceApplications.amount}) filter (where ${labourAdvanceApplications.status} = 'ACTIVE'), 0)::numeric` }).from(labourAdvanceApplications).where(eq(labourAdvanceApplications.advanceVoucherId, advance.id));
        const [refunded] = await tx.select({ total: sql<number>`coalesce(sum(${labourPaymentVouchers.paymentAmount}) filter (where ${labourPaymentVouchers.status} = 'POSTED' and ${labourPaymentVouchers.nature} = 'REFUND_RECOVERY'), 0)::numeric` }).from(labourPaymentVouchers).where(eq(labourPaymentVouchers.relatedAdvanceVoucherId, advance.id));
        const available = Math.max(Number(advance.paymentAmount) - Number(applied?.total ?? 0) - Number(refunded?.total ?? 0), 0);
        if (body.data.payment.amount > available + 0.005) throw new Error("Refund exceeds the outstanding advance balance.");
        const account = await validatedAccount(tx, params.data.workspaceId, body.data.farmId, body.data.payment.paymentAccountId);
        const voucherNumber = await allocateLabourPaymentVoucherNumber(tx, params.data.workspaceId, body.data.farmId);
        const [created] = await tx.insert(labourPaymentVouchers).values({
          workspaceId: params.data.workspaceId, farmId: body.data.farmId, seasonId: body.data.seasonId,
          voucherNumber, voucherDate: body.data.payment.voucherDate, nature: "REFUND_RECOVERY", status: "POSTED",
          recipientScope: advance.recipientScope, financialScopeKey: advance.financialScopeKey,
          labourerId: advance.labourerId, labourGroupId: advance.labourGroupId,
          recipientSnapshot: advance.recipientSnapshot, description: body.data.payment.description || `Advance refund for ${advance.voucherNumber}`,
          paymentAmount: body.data.payment.amount.toFixed(2), paymentAccountId: account.id,
          paymentMethod: body.data.payment.paymentMethod, transactionReference: body.data.payment.transactionReference,
          sourceType: "ADVANCE_REFUND", sourceId: advance.id, relatedAdvanceVoucherId: advance.id,
          idempotencyKey: body.data.payment.idempotencyKey, createdBy: request.appUser!.id,
          postedBy: request.appUser!.id, postedAt: new Date(), reconciliationStatus: "RECONCILED",
        }).returning();
        await postLabourVoucherJournal(tx, { workspaceId: params.data.workspaceId, farmId: body.data.farmId, seasonId: body.data.seasonId, voucherId: created!.id, nature: "REFUND_RECOVERY", amount: body.data.payment.amount, accountType: account.accountType, actorId: request.appUser!.id });
        const accountTransactionId = await insertAccountMovement(tx, { farmId: body.data.farmId, seasonId: body.data.seasonId, voucherId: created!.id, voucherNumber, voucherDate: body.data.payment.voucherDate, amount: body.data.payment.amount, account, actorId: request.appUser!.id, reverse: true });
        const [updated] = await tx.update(labourPaymentVouchers).set({ accountTransactionId }).where(eq(labourPaymentVouchers.id, created!.id)).returning();
        return updated!;
      });
      return { voucher };
    } catch (error) {
      return reply.code(409).send({ message: error instanceof Error ? error.message : "Unable to refund the advance." });
    }
  });

  app.post("/v1/workspace/:workspaceId/labour-payments/vouchers/:voucherId/void", { preHandler: requireUser }, async (request, reply) => {
    const params = voucherParamsSchema.safeParse(request.params);
    const query = contextSchema.safeParse(request.query);
    const body = voidSchema.safeParse(request.body);
    if (!params.success || !query.success || !body.success) return reply.code(400).send({ message: "A valid voucher void request is required." });
    if (!(await requireRequestScope(request, reply, params.data.workspaceId, query.data.farmId, query.data.seasonId, "delete"))) return;
    try {
      const result = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${params.data.workspaceId}:${query.data.farmId}:${query.data.seasonId}:labour-payment-posting`}), 1)`);
        const [voucher] = await tx.select().from(labourPaymentVouchers).where(and(
          eq(labourPaymentVouchers.id, params.data.voucherId), eq(labourPaymentVouchers.workspaceId, params.data.workspaceId),
          eq(labourPaymentVouchers.farmId, query.data.farmId), eq(labourPaymentVouchers.seasonId, query.data.seasonId),
        )).limit(1);
        if (!voucher) throw new Error("Labour Payment Voucher was not found.");
        if (voucher.status === "VOIDED") return { voucher, reversal: null };
        if (voucher.nature === "REVERSAL") throw new Error("A reversal voucher cannot be voided directly.");
        if (voucher.legacy) throw new Error("Legacy mapped vouchers must be reconciled through their original workflow before reversal.");
        if (voucher.nature === "ADVANCE") {
          const activeApplications = await tx.select({ id: labourAdvanceApplications.id }).from(labourAdvanceApplications).where(and(eq(labourAdvanceApplications.advanceVoucherId, voucher.id), eq(labourAdvanceApplications.status, "ACTIVE"))).limit(1);
          if (activeApplications.length) throw new Error("Reverse active advance applications before voiding this advance voucher.");
        }
        const [existingReversal] = await tx.select().from(labourPaymentVouchers).where(and(eq(labourPaymentVouchers.workspaceId, params.data.workspaceId), eq(labourPaymentVouchers.idempotencyKey, body.data.idempotencyKey))).limit(1);
        if (existingReversal) return { voucher, reversal: existingReversal };
        if (!voucher.paymentAccountId) throw new Error("The original voucher payment account is missing and requires reconciliation.");
        const account = await validatedAccount(tx, params.data.workspaceId, query.data.farmId, voucher.paymentAccountId);
        const reversalNumber = await allocateLabourPaymentVoucherNumber(tx, params.data.workspaceId, query.data.farmId);
        const now = new Date();
        const [reversal] = await tx.insert(labourPaymentVouchers).values({
          workspaceId: params.data.workspaceId, farmId: query.data.farmId, seasonId: query.data.seasonId,
          voucherNumber: reversalNumber, voucherDate: now.toISOString().slice(0, 10), nature: "REVERSAL", status: "POSTED",
          recipientScope: voucher.recipientScope, financialScopeKey: voucher.financialScopeKey,
          labourerId: voucher.labourerId, labourGroupId: voucher.labourGroupId,
          recipientSnapshot: voucher.recipientSnapshot, description: `Reversal of ${voucher.voucherNumber}: ${body.data.reason}`,
          paymentAmount: voucher.paymentAmount, paymentAccountId: account.id, paymentMethod: voucher.paymentMethod,
          transactionReference: voucher.transactionReference, sourceType: "VOUCHER_REVERSAL", sourceId: voucher.id,
          linkedDueId: voucher.linkedDueId, reversalReference: voucher.id, idempotencyKey: body.data.idempotencyKey,
          createdBy: request.appUser!.id, postedBy: request.appUser!.id, postedAt: now, reconciliationStatus: "RECONCILED",
        }).returning();
        await reverseLabourJournal(tx, { workspaceId: params.data.workspaceId, farmId: query.data.farmId, seasonId: query.data.seasonId, actorId: request.appUser!.id, reversalKey: `voucher-reversal:${reversal!.id}`, voucherId: voucher.id });
        // Refunds are account inflows. Their reversal must therefore be an
        // outflow; all other supported voucher natures are outflows whose
        // reversal is an inflow.
        const accountTransactionId = await insertAccountMovement(tx, { farmId: query.data.farmId, seasonId: query.data.seasonId, voucherId: reversal!.id, voucherNumber: reversalNumber, voucherDate: now.toISOString().slice(0, 10), amount: Number(voucher.paymentAmount), account, actorId: request.appUser!.id, reverse: voucher.nature !== "REFUND_RECOVERY" });
        await tx.update(labourPaymentVouchers).set({ accountTransactionId }).where(eq(labourPaymentVouchers.id, reversal!.id));
        await tx.update(labourPaymentVouchers).set({ status: "VOIDED", voidReason: body.data.reason, voidedBy: request.appUser!.id, voidedAt: now, reversalReference: reversal!.id, updatedAt: now }).where(eq(labourPaymentVouchers.id, voucher.id));
        if (voucher.nature === "ADVANCE" && voucher.legacySourceRecordId) {
          const [source] = await tx.select().from(operationalRecords).where(eq(operationalRecords.id, voucher.legacySourceRecordId)).limit(1);
          if (source) await tx.update(operationalRecords).set({
            payload: { ...source.payload, status: "voided", deletedAt: now.toISOString(), voidReason: body.data.reason, voidedBy: request.appUser!.id },
            clientUpdatedAt: now,
            updatedAt: now,
          }).where(eq(operationalRecords.id, source.id));
        }
        await tx.update(labourPaymentAllocations).set({ status: "REVERSED", reversedAt: now, reversedBy: request.appUser!.id, updatedAt: now }).where(and(eq(labourPaymentAllocations.voucherId, voucher.id), eq(labourPaymentAllocations.status, "ACTIVE")));
        if (voucher.linkedDueId) await refreshLabourDuePaymentStatus(tx, voucher.linkedDueId);
        await tx.insert(auditLogs).values({ workspaceId: params.data.workspaceId, farmId: query.data.farmId, userId: request.appUser!.id, actorUserId: request.appUser!.id, action: "labour_payment_voucher_voided", entityType: "labour_payment_voucher", entityId: voucher.id, details: { reversalVoucherId: reversal!.id, reason: body.data.reason } });
        return { voucher: { ...voucher, status: "VOIDED" }, reversal: { ...reversal!, accountTransactionId } };
      });
      return { result };
    } catch (error) {
      return reply.code(409).send({ message: error instanceof Error ? error.message : "Unable to void the Labour Payment Voucher." });
    }
  });
}
