import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  labourAdvanceApplications,
  labourAccountingEntries,
  labourDues,
  labourPaymentAllocations,
  labourPaymentVouchers,
  labourWageSettlementAdvanceAllocations,
  operationalRecords,
  accounts,
} from "../db/schema.js";
import { isDeletedOperationalPayload } from "../operational-record-state.js";

export type LabourRecipientScope = "INDIVIDUAL" | "LABOUR_GROUP" | "CONTRACTOR_FOREMAN" | "TEMPORARY_CREW" | "UNREGISTERED_LABOUR" | "NO_SPECIFIC_RECIPIENT";
export type LabourDuePaymentStatus = "UNPAID" | "PARTIALLY_SETTLED" | "PAID" | "SETTLED_BY_ADVANCE" | "ON_HOLD" | "VOIDED";
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type LabourLedgerCode = "LABOUR_EXPENSE" | "LABOUR_PAYABLE" | "LABOUR_ADVANCE" | "CASH_CONTROL" | "PARTNER_PAYABLE";

const amount = (value: unknown) => {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
};

const stringValue = (value: unknown) => typeof value === "string" ? value.trim() : "";

export function calculateLabourDuePosition(input: {
  grossAmount: unknown;
  adjustmentAmount?: unknown;
  authorizedDeductions?: unknown;
  previousPayments?: unknown;
  advancesApplied?: unknown;
}) {
  const grossAmount = amount(input.grossAmount);
  const adjustmentAmount = amount(input.adjustmentAmount);
  const authorizedDeductions = amount(input.authorizedDeductions);
  const previousPayments = amount(input.previousPayments);
  const advancesApplied = amount(input.advancesApplied);
  const payableAmount = Math.max(grossAmount + adjustmentAmount - authorizedDeductions, 0);
  const outstandingBalance = Math.max(payableAmount - previousPayments - advancesApplied, 0);
  const paymentStatus: Exclude<LabourDuePaymentStatus, "ON_HOLD" | "VOIDED"> = outstandingBalance <= 0.005
    ? previousPayments > 0 ? "PAID" : advancesApplied > 0 ? "SETTLED_BY_ADVANCE" : "PAID"
    : previousPayments > 0 || advancesApplied > 0 ? "PARTIALLY_SETTLED" : "UNPAID";
  return { grossAmount, adjustmentAmount, authorizedDeductions, payableAmount, previousPayments, advancesApplied, outstandingBalance, paymentStatus };
}

export function calculateAdvancePosition(input: { originalAmount: unknown; appliedAmount?: unknown; refundedAmount?: unknown; voided?: boolean }) {
  const originalAmount = Math.max(amount(input.originalAmount), 0);
  const appliedAmount = Math.max(amount(input.appliedAmount), 0);
  const refundedAmount = Math.max(amount(input.refundedAmount), 0);
  const outstandingAmount = Math.max(originalAmount - appliedAmount - refundedAmount, 0);
  const advanceStatus = input.voided ? "VOIDED"
    : outstandingAmount <= 0.005 ? refundedAmount >= originalAmount - 0.005 ? "FULLY_REFUNDED" : "FULLY_APPLIED"
    : appliedAmount > 0 ? "PARTIALLY_APPLIED"
    : refundedAmount > 0 ? "PARTIALLY_REFUNDED"
    : "OUTSTANDING";
  return { originalAmount, appliedAmount, refundedAmount, outstandingAmount, advanceStatus };
}

export type LabourAdvancePoolCandidate = {
  id: string;
  voucherNumber: string;
  voucherDate: string;
  createdAt?: Date | string | null;
  financialScopeKey: string;
  labourerId?: string | null;
  recipientName?: string | null;
  originalAmount: number;
  appliedAmount: number;
  refundedAmount: number;
  appliedToDueAmount?: number;
};

export type LabourAdvancePoolAllocation = LabourAdvancePoolCandidate & {
  ownership: "MEMBER" | "GROUP";
  availableAmount: number;
  proposedAmount: number;
  remainingAmount: number;
  allocationOrder: number;
};

const minor = (value: unknown) => Math.round(amount(value) * 100);
const major = (value: number) => Number((value / 100).toFixed(2));

/** Canonical deterministic plan used by pool preview and final posting. */
export function calculateLabourAdvancePool(input: {
  dueFinancialScopeKey: string;
  dueOutstandingAmount: number;
  settlementDate?: string;
  memberPayableShares?: Array<{ labourerId: string; amount: number }>;
  candidates: LabourAdvancePoolCandidate[];
  requestedAmount?: number;
}) {
  const memberIds = new Set(input.memberPayableShares?.map((row) => row.labourerId) ?? []);
  const exclusions = { otherGroups: 0, labourersOutsideDue: 0, refundedOrVoided: 0, differentFinancialContext: 0, postedAfterSettlementDate: 0, unresolvedOwnership: 0 };
  const eligible = input.candidates.flatMap((candidate) => {
    const availableMinor = Math.max(minor(candidate.originalAmount) - minor(candidate.appliedAmount) - minor(candidate.refundedAmount), 0);
    if (!availableMinor) return [];
    if (input.settlementDate && candidate.voucherDate > input.settlementDate) {
      exclusions.postedAfterSettlementDate += availableMinor;
      return [];
    }
    const isGroup = candidate.financialScopeKey === input.dueFinancialScopeKey;
    const isMember = !isGroup && !!candidate.labourerId && memberIds.has(candidate.labourerId);
    if (!isGroup && !isMember) {
      if (candidate.financialScopeKey.startsWith("group:")) exclusions.otherGroups += availableMinor;
      else if (candidate.labourerId) exclusions.labourersOutsideDue += availableMinor;
      else exclusions.unresolvedOwnership += availableMinor;
      return [];
    }
    return [{ ...candidate, ownership: (isMember ? "MEMBER" : "GROUP") as "MEMBER" | "GROUP", availableMinor }];
  }).sort((left, right) => {
    if (left.ownership !== right.ownership) return left.ownership === "GROUP" ? -1 : 1;
    return left.voucherDate.localeCompare(right.voucherDate)
      || String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? ""))
      || left.id.localeCompare(right.id);
  });

  let groupLevelMinor = 0;
  let memberLevelMinor = 0;
  for (const candidate of eligible) {
    if (candidate.ownership === "GROUP") groupLevelMinor += candidate.availableMinor;
    else memberLevelMinor += candidate.availableMinor;
  }
  const eligibleMinor = groupLevelMinor + memberLevelMinor;
  const maximumMinor = Math.min(minor(input.dueOutstandingAmount), eligibleMinor);
  const requestedMinor = input.requestedAmount == null ? maximumMinor : Math.min(Math.max(minor(input.requestedAmount), 0), maximumMinor);
  let remainingToAllocate = requestedMinor;
  const allocations: LabourAdvancePoolAllocation[] = [];
  for (const candidate of eligible) {
    if (remainingToAllocate <= 0) break;
    const applied = Math.min(candidate.availableMinor, remainingToAllocate);
    if (!applied) continue;
    remainingToAllocate -= applied;
    allocations.push({
      ...candidate,
      availableAmount: major(candidate.availableMinor),
      proposedAmount: major(applied),
      remainingAmount: major(candidate.availableMinor - applied),
      allocationOrder: allocations.length + 1,
    });
  }
  return {
    eligibleTotal: major(eligibleMinor),
    eligibleOpenCount: eligible.length,
    groupLevelAmount: major(groupLevelMinor),
    memberLevelAmount: major(memberLevelMinor),
    maximumApplicable: major(maximumMinor),
    proposedApplication: major(requestedMinor - remainingToAllocate),
    carriedForwardAmount: major(eligibleMinor - (requestedMinor - remainingToAllocate)),
    remainingAfterAdvances: major(Math.max(minor(input.dueOutstandingAmount) - (requestedMinor - remainingToAllocate), 0)),
    allocationPreviewVersion: "GROUP_POOL_FIFO_V2",
    exclusionTotals: Object.fromEntries(Object.entries(exclusions).map(([key, value]) => [key, major(value)])) as Record<keyof typeof exclusions, number>,
    allocations,
  };
}

async function postBalancedLabourJournal(tx: DbTransaction, input: {
  workspaceId: string; farmId: string; seasonId: string; key: string;
  eventType: "DUE_RECOGNITION" | "ADVANCE_PAYMENT" | "ADVANCE_APPLICATION" | "DUE_PAYMENT" | "ADVANCE_REFUND" | "REVERSAL";
  debitCode: LabourLedgerCode; creditCode: LabourLedgerCode; amount: number;
  actorId: string; postedAt?: Date; dueId?: string | null; voucherId?: string | null; advanceApplicationId?: string | null;
}) {
  if (!(input.amount > 0)) return;
  const common = {
    workspaceId: input.workspaceId, farmId: input.farmId, seasonId: input.seasonId,
    eventType: input.eventType, dueId: input.dueId, voucherId: input.voucherId,
    advanceApplicationId: input.advanceApplicationId, postedBy: input.actorId,
    postedAt: input.postedAt ?? new Date(), status: "POSTED",
  };
  await tx.insert(labourAccountingEntries).values([
    { ...common, entryKey: `${input.key}:debit`, ledgerCode: input.debitCode, debit: input.amount.toFixed(2), credit: "0" },
    { ...common, entryKey: `${input.key}:credit`, ledgerCode: input.creditCode, debit: "0", credit: input.amount.toFixed(2) },
  ]).onConflictDoNothing();
}

export async function postLabourDueRecognition(tx: DbTransaction, input: {
  workspaceId: string; farmId: string; seasonId: string; dueId: string; amount: number; actorId: string; postedAt?: Date;
}) {
  // Unpaid dues are operational obligations only. Expense is recognized only
  // when a due is settled by a direct payment or an applied advance.
  void tx;
  void input;
}

export async function postLabourVoucherJournal(tx: DbTransaction, input: {
  workspaceId: string; farmId: string; seasonId: string; voucherId: string; nature: "ADVANCE" | "FINAL_PAYMENT" | "SETTLEMENT_BALANCE_PAYMENT" | "DIRECT_LABOUR_PAYMENT" | "REFUND_RECOVERY";
  amount: number; accountType: string; actorId: string; dueId?: string | null; postedAt?: Date;
}) {
  const cashCode: LabourLedgerCode = input.accountType === "partner" ? "PARTNER_PAYABLE" : "CASH_CONTROL";
  if (input.nature === "ADVANCE") return postBalancedLabourJournal(tx, { ...input, key: `voucher:${input.voucherId}`, eventType: "ADVANCE_PAYMENT", debitCode: "LABOUR_ADVANCE", creditCode: cashCode });
  if (input.nature === "REFUND_RECOVERY") return postBalancedLabourJournal(tx, { ...input, key: `voucher:${input.voucherId}`, eventType: "ADVANCE_REFUND", debitCode: cashCode, creditCode: "LABOUR_ADVANCE" });
  return postBalancedLabourJournal(tx, { ...input, key: `voucher:${input.voucherId}`, eventType: "DUE_PAYMENT", debitCode: "LABOUR_EXPENSE", creditCode: cashCode });
}

export async function postLabourAdvanceApplicationJournal(tx: DbTransaction, input: {
  workspaceId: string; farmId: string; seasonId: string; dueId: string; advanceApplicationId: string; amount: number; actorId: string; postedAt?: Date;
}) {
  return postBalancedLabourJournal(tx, { ...input, key: `advance-application:${input.advanceApplicationId}`, eventType: "ADVANCE_APPLICATION", debitCode: "LABOUR_EXPENSE", creditCode: "LABOUR_ADVANCE" });
}

export async function postLabourAdvanceApplicationJournals(tx: DbTransaction, input: {
  workspaceId: string; farmId: string; seasonId: string; actorId: string;
  applications: Array<{ id: string; dueId: string; amount: number }>;
}) {
  if (!input.applications.length) return;
  const postedAt = new Date();
  for (let offset = 0; offset < input.applications.length; offset += 40) {
    const batch = input.applications.slice(offset, offset + 40);
    await tx.insert(labourAccountingEntries).values(batch.flatMap((application) => {
      const common = {
        workspaceId: input.workspaceId, farmId: input.farmId, seasonId: input.seasonId,
        eventType: "ADVANCE_APPLICATION", dueId: application.dueId, advanceApplicationId: application.id,
        voucherId: null, postedBy: input.actorId, postedAt, status: "POSTED",
      };
      return [
        { ...common, entryKey: `advance-application:${application.id}:debit`, ledgerCode: "LABOUR_EXPENSE", debit: application.amount.toFixed(2), credit: "0" },
        { ...common, entryKey: `advance-application:${application.id}:credit`, ledgerCode: "LABOUR_ADVANCE", debit: "0", credit: application.amount.toFixed(2) },
      ];
    })).onConflictDoNothing();
  }
}

export async function reverseLabourJournal(tx: DbTransaction, input: {
  workspaceId: string; farmId: string; seasonId: string; actorId: string; reversalKey: string;
  originalEventKey: string;
  ignoreMissing?: boolean;
}) {
  // Journal convention: originals remain historical facts (status may become
  // REVERSED), one POSTED inverse references each original, and current
  // balances sum both original and reversal rows. Routine business voiding is
  // anchored to the immutable posting key and can never select a reversal row.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${input.workspaceId}:labour-journal:${input.originalEventKey}`}), 1)`);
  const originalKeys = [`${input.originalEventKey}:debit`, `${input.originalEventKey}:credit`];
  const rows = await tx.select().from(labourAccountingEntries).where(and(
    eq(labourAccountingEntries.workspaceId, input.workspaceId),
    eq(labourAccountingEntries.farmId, input.farmId),
    eq(labourAccountingEntries.seasonId, input.seasonId),
    inArray(labourAccountingEntries.entryKey, originalKeys),
    isNull(labourAccountingEntries.reversalOf),
  ));
  if (!rows.length) {
    if (input.ignoreMissing) return { originalRows: [], alreadyReversed: false, ignoredMissing: true };
    throw new Error(`Original labour journal event ${input.originalEventKey} was not found.`);
  }
  if (rows.length !== originalKeys.length || new Set(rows.map((row) => row.entryKey)).size !== originalKeys.length)
    throw new Error(`Original labour journal event ${input.originalEventKey} is incomplete or duplicated.`);
  const existing = await tx.select({ reversalOf: labourAccountingEntries.reversalOf }).from(labourAccountingEntries).where(and(
    eq(labourAccountingEntries.workspaceId, input.workspaceId),
    inArray(labourAccountingEntries.reversalOf, rows.map((row) => row.id)),
  ));
  if (existing.length) {
    if (new Set(existing.map((row) => row.reversalOf)).size !== rows.length)
      throw new Error(`Original labour journal event ${input.originalEventKey} has a partial reversal.`);
    return { originalRows: rows, alreadyReversed: true };
  }
  const now = new Date();
  for (const row of rows) {
    await tx.insert(labourAccountingEntries).values({
      workspaceId: input.workspaceId, farmId: input.farmId, seasonId: input.seasonId,
      entryKey: `${input.reversalKey}:${row.id}`, eventType: "REVERSAL", ledgerCode: row.ledgerCode,
      dueId: row.dueId, voucherId: row.voucherId, advanceApplicationId: row.advanceApplicationId,
      debit: row.credit, credit: row.debit, status: "POSTED", reversalOf: row.id,
      postedBy: input.actorId, postedAt: now,
    }).onConflictDoNothing();
  }
  if (rows.length) await tx.update(labourAccountingEntries).set({ status: "REVERSED", updatedAt: now }).where(and(
    eq(labourAccountingEntries.workspaceId, input.workspaceId),
    inArray(labourAccountingEntries.id, rows.map((row) => row.id)),
  ));
  return { originalRows: rows, alreadyReversed: false };
}

export function labourFinancialScopeKey(input: {
  recipientScope: LabourRecipientScope;
  labourerId?: string | null;
  labourGroupId?: string | null;
  contractorReference?: string | null;
  crewReference?: string | null;
  manualRecipientName?: string | null;
  batchIdentity?: string | null;
  recipientReference?: string | null;
}) {
  if (input.recipientScope === "INDIVIDUAL" && input.labourerId) return `individual:${input.labourerId}`;
  if (input.recipientScope === "LABOUR_GROUP" && input.labourGroupId) return `group:${input.labourGroupId}`;
  if (input.recipientScope === "CONTRACTOR_FOREMAN" && (input.recipientReference || input.contractorReference)) return `contractor:${(input.recipientReference || input.contractorReference)!.trim().toLowerCase()}`;
  if (input.recipientScope === "TEMPORARY_CREW" && (input.recipientReference || input.crewReference)) return `crew:${(input.recipientReference || input.crewReference)!.trim().toLowerCase()}`;
  if (input.recipientScope === "UNREGISTERED_LABOUR") {
    const identity = input.recipientReference || input.crewReference || input.contractorReference || input.batchIdentity || input.manualRecipientName;
    if (identity) return `unregistered:${identity.trim().toLowerCase()}`;
  }
  if (input.recipientScope === "NO_SPECIFIC_RECIPIENT" && (input.recipientReference || input.batchIdentity)) return `batch:${(input.recipientReference || input.batchIdentity)!.trim().toLowerCase()}`;
  throw new Error("A stable recipient, group, contractor, crew, or batch identity is required for this labour financial scope.");
}

export async function allocateLabourDueNumber(tx: DbTransaction, workspaceId: string, farmId: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${workspaceId}:${farmId}:labour-due-number`}), 1)`);
  const rows = await tx.select({ dueNumber: labourDues.dueNumber }).from(labourDues).where(and(
    eq(labourDues.workspaceId, workspaceId),
    eq(labourDues.farmId, farmId),
  ));
  const next = rows.reduce((maximum, row) => {
    const match = /^LD-(\d+)$/i.exec(row.dueNumber);
    return Math.max(maximum, match ? Number(match[1]) : 0);
  }, 0) + 1;
  return `LD-${String(next).padStart(4, "0")}`;
}

export async function allocateLabourPaymentVoucherNumber(tx: DbTransaction, workspaceId: string, farmId: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${workspaceId}:${farmId}:labour-payment-voucher-number`}), 1)`);
  const rows = await tx.select({ voucherNumber: labourPaymentVouchers.voucherNumber }).from(labourPaymentVouchers).where(and(
    eq(labourPaymentVouchers.workspaceId, workspaceId),
    eq(labourPaymentVouchers.farmId, farmId),
  ));
  const next = rows.reduce((maximum, row) => {
    const match = /^LPV-(\d+)$/i.exec(row.voucherNumber);
    return Math.max(maximum, match ? Number(match[1]) : 0);
  }, 0) + 1;
  return `LPV-${String(next).padStart(4, "0")}`;
}

export async function allocateLabourAdvanceVoucherNumber(tx: DbTransaction, workspaceId: string, farmId: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${workspaceId}:${farmId}:labour-advance-voucher-number`}), 1)`);
  const rows = await tx.select({ voucherNumber: labourPaymentVouchers.voucherNumber }).from(labourPaymentVouchers).where(and(
    eq(labourPaymentVouchers.workspaceId, workspaceId),
    eq(labourPaymentVouchers.farmId, farmId),
    eq(labourPaymentVouchers.nature, "ADVANCE"),
  ));
  const next = rows.reduce((maximum, row) => {
    const match = /^LAV-(\d+)$/i.exec(row.voucherNumber);
    return Math.max(maximum, match ? Number(match[1]) : 0);
  }, 0) + 1;
  return `LAV-${String(next).padStart(4, "0")}`;
}

export async function allocateLabourAdvanceAdjustmentNumber(tx: DbTransaction, workspaceId: string, farmId: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${workspaceId}:${farmId}:labour-advance-adjustment-number`}), 1)`);
  const rows = await tx.select({ voucherNumber: labourPaymentVouchers.voucherNumber }).from(labourPaymentVouchers).where(and(
    eq(labourPaymentVouchers.workspaceId, workspaceId),
    eq(labourPaymentVouchers.farmId, farmId),
    sql`${labourPaymentVouchers.nature} in ('REFUND_RECOVERY', 'REVERSAL')`,
  ));
  const next = rows.reduce((maximum, row) => {
    const match = /^LAR-(\d+)$/i.exec(row.voucherNumber);
    return Math.max(maximum, match ? Number(match[1]) : 0);
  }, 0) + 1;
  return `LAR-${String(next).padStart(4, "0")}`;
}

export async function loadLabourDuePosition(tx: DbTransaction, dueId: string) {
  const [due] = await tx.select().from(labourDues).where(eq(labourDues.id, dueId)).limit(1);
  if (!due) return null;
  const [paymentTotals] = await tx.select({
    total: sql<number>`coalesce(sum(${labourPaymentAllocations.amount}) filter (where ${labourPaymentAllocations.status} = 'ACTIVE'), 0)::numeric`,
  }).from(labourPaymentAllocations).where(eq(labourPaymentAllocations.dueId, dueId));
  const [advanceTotals] = await tx.select({
    total: sql<number>`coalesce(sum(${labourAdvanceApplications.amount}) filter (where ${labourAdvanceApplications.status} = 'ACTIVE'), 0)::numeric`,
  }).from(labourAdvanceApplications).where(eq(labourAdvanceApplications.dueId, dueId));
  const position = calculateLabourDuePosition({
    grossAmount: due.grossAmount,
    adjustmentAmount: due.adjustmentAmount,
    authorizedDeductions: due.authorizedDeductions,
    previousPayments: paymentTotals?.total,
    advancesApplied: advanceTotals?.total,
  });
  return {
    due,
    ...position,
  };
}

export async function refreshLabourDuePaymentStatus(tx: DbTransaction, dueId: string) {
  const position = await loadLabourDuePosition(tx, dueId);
  if (!position) throw new Error("Labour due was not found.");
  if (position.due.paymentStatus === "VOIDED" || position.due.paymentStatus === "ON_HOLD") return position;
  const paymentStatus: LabourDuePaymentStatus = position.paymentStatus;
  if (paymentStatus !== position.due.paymentStatus) {
    await tx.update(labourDues).set({ paymentStatus, updatedAt: new Date() }).where(eq(labourDues.id, dueId));
    position.due.paymentStatus = paymentStatus;
  }
  return position;
}

export async function ensureSettlementLabourDue(tx: DbTransaction, settlementRecord: {
  id: string;
  clientRecordId: string;
  workspaceId: string;
  farmId: string | null;
  seasonId: string | null;
  payload: Record<string, unknown>;
  recordedBy?: string;
  createdAt?: Date;
}) {
  if (!settlementRecord.farmId || !settlementRecord.seasonId) throw new Error("Settlement farm and season context are required.");
  const [existing] = await tx.select().from(labourDues).where(eq(labourDues.sourceRecordId, settlementRecord.id)).limit(1);
  if (existing) return refreshLabourDuePaymentStatus(tx, existing.id);
  const payload = settlementRecord.payload;
  const settlementMode = payload.settlementMode === "group" ? "group" : "individual";
  const groupId = stringValue(payload.groupId) || null;
  const labourerId = stringValue(payload.labourerId)
    || (Array.isArray(payload.includedLabourIds) ? stringValue(payload.includedLabourIds[0]) : "")
    || null;
  const recipientScope: LabourRecipientScope = settlementMode === "group" ? "LABOUR_GROUP" : "INDIVIDUAL";
  const financialScopeKey = labourFinancialScopeKey({
    recipientScope,
    labourerId,
    labourGroupId: groupId,
    batchIdentity: settlementRecord.clientRecordId,
  });
  const attendanceWages = amount(payload.attendanceWages);
  const labourWorkWages = amount(payload.labourWorkWages ?? payload.pendingLabourEarnings);
  const settlementBasis = attendanceWages > 0 && labourWorkWages > 0 ? "MIXED" : labourWorkWages > 0 ? "LABOUR_WORK" : "ATTENDANCE";
  const createdAt = settlementRecord.createdAt ?? new Date();
  const actorId = settlementRecord.recordedBy ?? stringValue(payload.createdBy);
  if (!actorId) throw new Error("Settlement creator is required to create its labour due.");
  const [due] = await tx.insert(labourDues).values({
    workspaceId: settlementRecord.workspaceId,
    farmId: settlementRecord.farmId,
    seasonId: settlementRecord.seasonId,
    dueNumber: stringValue(payload.settlementNumber) || await allocateLabourDueNumber(tx, settlementRecord.workspaceId, settlementRecord.farmId),
    origin: "SETTLEMENT",
    settlementBasis,
    sourceRecordId: settlementRecord.id,
    sourceClientRecordId: settlementRecord.clientRecordId,
    recipientScope,
    financialScopeKey,
    labourerId,
    labourGroupId: groupId,
    recipientSnapshot: {
      groupName: payload.groupName ?? null,
      foremanId: payload.foremanId ?? null,
      includedLabourRows: payload.includedLabourRows ?? [],
      includedLabourIds: payload.includedLabourIds ?? [],
    },
    description: stringValue(payload.notes) || `Labour wage settlement ${stringValue(payload.settlementNumber)}`,
    workFromDate: stringValue(payload.fromDate),
    workToDate: stringValue(payload.toDate),
    grossAmount: String(Math.max(amount(payload.expenseAmount ?? payload.grossWages ?? payload.totalEarned), 0)),
    adjustmentAmount: String(amount(payload.manualAdjustment)),
    authorizedDeductions: "0",
    calculationStatus: "APPROVED",
    paymentStatus: "UNPAID",
    approvedAt: createdAt,
    approvedBy: actorId,
    legacy: false,
    reconciliationStatus: "RECONCILED",
    idempotencyKey: settlementRecord.clientRecordId,
    createdBy: actorId,
    createdAt,
    updatedAt: createdAt,
  }).returning();
  await postLabourDueRecognition(tx, {
    workspaceId: settlementRecord.workspaceId, farmId: settlementRecord.farmId, seasonId: settlementRecord.seasonId,
    dueId: due!.id, amount: Math.max(amount(payload.expenseAmount ?? payload.grossWages ?? payload.totalEarned) + amount(payload.manualAdjustment), 0), actorId, postedAt: createdAt,
  });

  const allocationRows = await tx.select({
    id: labourWageSettlementAdvanceAllocations.id,
    advanceRecordId: labourWageSettlementAdvanceAllocations.advanceRecordId,
    amount: labourWageSettlementAdvanceAllocations.absorbedAmount,
  }).from(labourWageSettlementAdvanceAllocations).where(eq(labourWageSettlementAdvanceAllocations.settlementRecordId, settlementRecord.id));
  for (const allocation of allocationRows) {
    let [advanceVoucher] = await tx.select().from(labourPaymentVouchers).where(and(
      eq(labourPaymentVouchers.legacySourceRecordId, allocation.advanceRecordId),
      eq(labourPaymentVouchers.nature, "ADVANCE"),
    )).limit(1);
    if (!advanceVoucher) {
      const [advanceRecord] = await tx.select().from(operationalRecords).where(eq(operationalRecords.id, allocation.advanceRecordId)).limit(1);
      if (advanceRecord) {
        const advancePayload = advanceRecord.payload as Record<string, unknown>;
        const oldAccountId = stringValue(advancePayload.accountId);
        const validAccount = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(oldAccountId)
          ? (await tx.select({ id: accounts.id, accountType: accounts.accountType }).from(accounts).where(and(eq(accounts.id, oldAccountId), eq(accounts.farmId, settlementRecord.farmId))).limit(1))[0] ?? null
          : null;
        const advanceLabourerId = stringValue(advancePayload.labourerId) || null;
        const advanceGroupId = stringValue(advancePayload.labourGroupId) || null;
        const advanceScope: LabourRecipientScope = advanceGroupId ? "LABOUR_GROUP" : advanceLabourerId ? "INDIVIDUAL" : "UNREGISTERED_LABOUR";
        const advanceAmount = Math.max(amount(advancePayload.amount), 0);
        if (advanceAmount > 0) {
          [advanceVoucher] = await tx.insert(labourPaymentVouchers).values({
            workspaceId: settlementRecord.workspaceId, farmId: settlementRecord.farmId, seasonId: settlementRecord.seasonId,
            voucherNumber: `LPV-LA-${advanceRecord.id.slice(0, 8)}`, voucherDate: stringValue(advancePayload.date || advancePayload.advanceDate) || advanceRecord.createdAt.toISOString().slice(0, 10),
            nature: "ADVANCE", status: isDeletedOperationalPayload(advancePayload) ? "VOIDED" : "POSTED",
            recipientScope: advanceScope, financialScopeKey: advanceGroupId ? `group:${advanceGroupId}` : advanceLabourerId ? `individual:${advanceLabourerId}` : `unregistered:${advanceRecord.clientRecordId}`,
            labourerId: advanceLabourerId, labourGroupId: advanceGroupId,
            recipientSnapshot: {
              labourerName: advancePayload.labourerName ?? null,
              labourGroupName: advancePayload.labourGroupName ?? null,
              receivedByLabourerId: advanceLabourerId,
              receivedByNameSnapshot: advancePayload.labourerName ?? null,
              receivedBy: advancePayload.labourerName ?? null,
              sourceAccountName: advancePayload.sourceAccountName ?? null,
              legacyOperationalRecord: true,
            },
            description: stringValue(advancePayload.notes) || "Legacy labour advance", paymentAmount: advanceAmount.toFixed(2), paymentAccountId: validAccount?.id ?? null,
            paymentMethod: stringValue(advancePayload.paymentMethod) || null, transactionReference: advanceRecord.clientRecordId,
            sourceType: "LEGACY_ADVANCE", sourceId: advanceRecord.clientRecordId, legacySourceRecordId: advanceRecord.id,
            idempotencyKey: advanceRecord.id, createdBy: advanceRecord.recordedBy, postedBy: advanceRecord.recordedBy,
            postedAt: advanceRecord.createdAt, legacy: true, reconciliationStatus: validAccount ? "RECONCILED" : "NEEDS_REVIEW",
            createdAt: advanceRecord.createdAt, updatedAt: advanceRecord.updatedAt,
          }).onConflictDoNothing().returning();
          if (advanceVoucher && validAccount) await postLabourVoucherJournal(tx, {
            workspaceId: settlementRecord.workspaceId, farmId: settlementRecord.farmId, seasonId: settlementRecord.seasonId,
            voucherId: advanceVoucher.id, nature: "ADVANCE", amount: advanceAmount, accountType: validAccount.accountType,
            actorId: advanceRecord.recordedBy, postedAt: advanceRecord.createdAt,
          });
          if (!advanceVoucher) [advanceVoucher] = await tx.select().from(labourPaymentVouchers).where(and(eq(labourPaymentVouchers.legacySourceRecordId, advanceRecord.id), eq(labourPaymentVouchers.nature, "ADVANCE"))).limit(1);
        }
      }
    }
    if (!advanceVoucher) continue;
    const [application] = await tx.insert(labourAdvanceApplications).values({
      workspaceId: settlementRecord.workspaceId,
      advanceVoucherId: advanceVoucher.id,
      dueId: due!.id,
      amount: allocation.amount,
      idempotencyKey: allocation.id,
      status: advanceVoucher.status === "POSTED" ? "ACTIVE" : "REVERSED",
      createdAt,
      updatedAt: createdAt,
    }).onConflictDoNothing().returning();
    if (application) await postLabourAdvanceApplicationJournal(tx, {
      workspaceId: settlementRecord.workspaceId, farmId: settlementRecord.farmId, seasonId: settlementRecord.seasonId,
      dueId: due!.id, advanceApplicationId: application.id, amount: Number(allocation.amount), actorId, postedAt: createdAt,
    });
  }
  return refreshLabourDuePaymentStatus(tx, due!.id);
}

export async function findOperationalSourceRecord(tx: DbTransaction, workspaceId: string, clientRecordId: string, entityType: string) {
  const [record] = await tx.select().from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId, workspaceId),
    eq(operationalRecords.clientRecordId, clientRecordId),
    eq(operationalRecords.entityType, entityType),
  )).limit(1);
  return record ?? null;
}
