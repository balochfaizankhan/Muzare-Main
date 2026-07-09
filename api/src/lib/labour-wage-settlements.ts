import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { accountTransactions, accounts, farms, operationalRecords } from "../db/schema.js";
import { isDeletedOperationalPayload } from "../operational-record-state.js";
import { normalizeLegacyAndroidAccountId } from "./account-identity.js";
import { listLabourEarnings } from "./labour-earnings.js";
import { validateLabourSettlementPaymentAccount, type LabourSettlementAccount } from "./labour-settlement-account-validation.js";
import { calculateStatusWage, listWageRateRows, resolveApplicableWageRate } from "./wage-rates.js";

export { validateLabourSettlementPaymentAccount } from "./labour-settlement-account-validation.js";

type DbClient = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type LabourWageSettlementPayload = {
  settlementNumber: string;
  linkedVoucherId: string;
  linkedVoucherNumber: string;
  linkedAccountId: string;
  settlementMode?: "individual" | "group";
  foremanId?: string | null;
  groupId?: string | null;
  includedLabourIds?: string[];
  fromDate: string;
  toDate: string;
  settlementDate: string;
  attendanceWages: number;
  labourWorkWages?: number;
  pendingLabourEarnings?: number;
  grossWages: number;
  totalEarned?: number;
  totalLabourCost?: number;
  availableAdvanceBalanceBeforeSettlement: number;
  advancesPaid?: number;
  advancesAvailableUpToSettlementDate?: number;
  advanceAdjustedNow: number;
  settledAdvanceAmount?: number;
  appliedAdvances?: number;
  remainingAdvanceCarryForward: number;
  carryForwardAdvance?: number;
  manualAdjustment: number;
  manualAdjustmentNote?: string | null;
  netPayableBeforePayment: number;
  expenseAmount: number;
  paidAmount: number;
  balanceAfterPayment: number;
  payableBalance?: number;
  cashPayable?: number;
  paymentAccountId?: string | null;
  settlementVoucherId?: string | null;
  sourceAttendanceIds?: string[];
  sourceLabourWorkIds?: string[];
  advanceAdjustmentAllocations?: Array<{
    settlementId: string;
    advanceId: string;
    adjustedAmount: number;
    workspaceId: string;
    farmId: string;
    seasonId: string;
  }>;
  notes?: string;
  status: "posted" | "voided" | "deleted";
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
  voidedAt?: string | null;
  voidedBy?: string | null;
  voidReason?: string | null;
  accountingStatus?: "draft" | "posted" | "accounting_missing" | "voided" | "deleted";
  accountingMessage?: string | null;
  deletedAt?: string | null;
  deletedBy?: string | null;
};

export type SettlementAccountingRepairResult = {
  settlementId: string;
  settlementNumber: string;
  accountingStatus: "posted" | "accounting_missing" | "voided" | "deleted";
  createdTransactions: number;
  existingTransactions: number;
  accountId: string;
  amount: number;
};

type LabourPayload = { name?: unknown };
type AttendancePayload = { labourerId?: unknown; labourId?: unknown; date?: unknown; status?: unknown };
type AdvancePayload = { labourerId?: unknown; labourId?: unknown; date?: unknown; amount?: unknown };
type CanonicalPaymentAccount = {
  id: LabourSettlementAccount["id"];
  farmId: LabourSettlementAccount["farmId"];
  name: LabourSettlementAccount["name"];
  accountType: LabourSettlementAccount["accountType"];
  active: LabourSettlementAccount["active"];
  oldAndroidId: LabourSettlementAccount["oldAndroidId"];
  sourceType: LabourSettlementAccount["sourceType"];
};

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parseSettlementSequenceNumber(value: string) {
  const match = /^LW-(\d+)$/i.exec(value.trim());
  return match ? Number(match[1]) : null;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : Number(value ?? 0);
}

function stringArrayValue(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

export function normalizeSettlementPayload(payload: Record<string, unknown>): LabourWageSettlementPayload {
  const attendanceWages = numberValue(payload.attendanceWages);
  const labourWorkWages = numberValue(payload.labourWorkWages ?? payload.labourWork ?? payload.pendingLabourEarnings);
  const grossWages = numberValue(payload.grossWages ?? payload.totalEarned ?? payload.totalLabourCost ?? (attendanceWages + labourWorkWages));
  const availableAdvanceBalanceBeforeSettlement = numberValue(payload.availableAdvanceBalanceBeforeSettlement ?? payload.advancesAvailableUpToSettlementDate ?? payload.advancesPaid);
  const advanceAdjustedNow = numberValue(payload.advanceAdjustedNow ?? payload.settledAdvanceAmount ?? payload.appliedAdvances);
  const remainingAdvanceCarryForward = numberValue(payload.remainingAdvanceCarryForward ?? payload.carryForwardAdvance);
  const manualAdjustment = numberValue(payload.manualAdjustment);
  const netPayableBeforePayment = numberValue(payload.netPayableBeforePayment ?? (grossWages - advanceAdjustedNow + manualAdjustment));
  const paidAmount = numberValue(payload.paidAmount ?? payload.payableBalance ?? payload.cashPayable);
  const balanceAfterPayment = numberValue(payload.balanceAfterPayment ?? (netPayableBeforePayment - paidAmount));
  const settlementMode = payload.settlementMode === "group" ? "group" : "individual";
  return {
    settlementNumber: typeof payload.settlementNumber === "string" ? payload.settlementNumber : "LW-0001",
    linkedVoucherId: typeof payload.linkedVoucherId === "string" ? payload.linkedVoucherId : "",
    linkedVoucherNumber: typeof payload.linkedVoucherNumber === "string" ? payload.linkedVoucherNumber : "",
    linkedAccountId: typeof payload.linkedAccountId === "string" ? payload.linkedAccountId : "",
    settlementMode,
    foremanId: typeof payload.foremanId === "string" ? payload.foremanId : null,
    groupId: typeof payload.groupId === "string" ? payload.groupId : null,
    includedLabourIds: stringArrayValue(payload.includedLabourIds),
    fromDate: typeof payload.fromDate === "string" ? payload.fromDate : "",
    toDate: typeof payload.toDate === "string" ? payload.toDate : "",
    settlementDate: typeof payload.settlementDate === "string" ? payload.settlementDate : "",
    attendanceWages,
    labourWorkWages,
    pendingLabourEarnings: labourWorkWages,
    grossWages,
    totalEarned: grossWages,
    totalLabourCost: grossWages,
    availableAdvanceBalanceBeforeSettlement,
    advancesPaid: availableAdvanceBalanceBeforeSettlement,
    advancesAvailableUpToSettlementDate: availableAdvanceBalanceBeforeSettlement,
    advanceAdjustedNow,
    settledAdvanceAmount: advanceAdjustedNow,
    appliedAdvances: advanceAdjustedNow,
    remainingAdvanceCarryForward,
    carryForwardAdvance: remainingAdvanceCarryForward,
    manualAdjustment,
    manualAdjustmentNote: typeof payload.manualAdjustmentNote === "string" ? payload.manualAdjustmentNote : null,
    netPayableBeforePayment,
    expenseAmount: grossWages,
    paidAmount,
    balanceAfterPayment,
    payableBalance: balanceAfterPayment,
    cashPayable: balanceAfterPayment,
    paymentAccountId: typeof payload.paymentAccountId === "string" ? payload.paymentAccountId : typeof payload.linkedAccountId === "string" ? payload.linkedAccountId : null,
    settlementVoucherId: typeof payload.settlementVoucherId === "string" ? payload.settlementVoucherId : typeof payload.linkedVoucherId === "string" ? payload.linkedVoucherId : null,
    sourceAttendanceIds: stringArrayValue(payload.sourceAttendanceIds),
    sourceLabourWorkIds: stringArrayValue(payload.sourceLabourWorkIds),
    advanceAdjustmentAllocations: Array.isArray(payload.advanceAdjustmentAllocations)
      ? payload.advanceAdjustmentAllocations.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const row = item as Record<string, unknown>;
        const settlementId = typeof row.settlementId === "string" ? row.settlementId : "";
        const advanceId = typeof row.advanceId === "string" ? row.advanceId : "";
        const adjustedAmount = numberValue(row.adjustedAmount);
        const workspaceId = typeof row.workspaceId === "string" ? row.workspaceId : "";
        const farmId = typeof row.farmId === "string" ? row.farmId : "";
        const seasonId = typeof row.seasonId === "string" ? row.seasonId : "";
        if (!settlementId || !advanceId || !workspaceId || !farmId || !seasonId || adjustedAmount <= 0) return [];
        return [{ settlementId, advanceId, adjustedAmount, workspaceId, farmId, seasonId }];
      })
      : [],
    notes: typeof payload.notes === "string" ? payload.notes : "",
    status: payload.status === "voided" ? "voided" : payload.status === "deleted" ? "deleted" : "posted",
    createdBy: typeof payload.createdBy === "string" ? payload.createdBy : undefined,
    createdAt: typeof payload.createdAt === "string" ? payload.createdAt : undefined,
    updatedAt: typeof payload.updatedAt === "string" ? payload.updatedAt : undefined,
    deletedAt: typeof payload.deletedAt === "string" ? payload.deletedAt : null,
    deletedBy: typeof payload.deletedBy === "string" ? payload.deletedBy : null,
    voidedAt: typeof payload.voidedAt === "string" ? payload.voidedAt : null,
    voidedBy: typeof payload.voidedBy === "string" ? payload.voidedBy : null,
    voidReason: typeof payload.voidReason === "string" ? payload.voidReason : null,
    accountingStatus: payload.accountingStatus === "accounting_missing"
      ? "accounting_missing"
      : payload.accountingStatus === "draft"
        ? "draft"
        : payload.status === "deleted"
          ? "deleted"
        : payload.status === "voided"
          ? "voided"
          : "posted",
    accountingMessage: typeof payload.accountingMessage === "string" ? payload.accountingMessage : null,
  };
}

export function settlementRangesOverlap(fromA: string, toA: string, fromB: string, toB: string) {
  return fromA <= toB && fromB <= toA;
}

export function calculateLabourWageSettlementTotals(
  attendanceWages: number,
  labourWorkWages: number,
  availableAdvanceBalanceBeforeSettlement: number,
  paidAmount = 0,
  manualAdjustment = 0,
  advanceAdjustedNowOverride?: number | null,
) {
  const grossWages = attendanceWages + labourWorkWages;
  const advanceAdjustedNow = Math.max(0, Math.min(
    Number.isFinite(advanceAdjustedNowOverride ?? NaN) ? Number(advanceAdjustedNowOverride) : grossWages,
    grossWages,
    availableAdvanceBalanceBeforeSettlement,
  ));
  const remainingAdvanceCarryForward = Math.max(availableAdvanceBalanceBeforeSettlement - advanceAdjustedNow, 0);
  const netPayableBeforePayment = grossWages - advanceAdjustedNow + manualAdjustment;
  const balanceAfterPayment = netPayableBeforePayment - paidAmount;
  return {
    attendanceWages,
    labourWorkWages,
    pendingLabourEarnings: labourWorkWages,
    grossWages,
    totalEarned: grossWages,
    advancesPaid: availableAdvanceBalanceBeforeSettlement,
    availableAdvanceBalanceBeforeSettlement,
    advanceAdjustedNow,
    settledAdvanceAmount: advanceAdjustedNow,
    appliedAdvances: advanceAdjustedNow,
    expenseAmount: grossWages,
    remainingAdvanceCarryForward,
    carryForwardAdvance: remainingAdvanceCarryForward,
    manualAdjustment,
    netPayableBeforePayment,
    paidAmount,
    balanceAfterPayment,
    payableBalance: balanceAfterPayment,
  };
}

export type AdvanceAllocation = {
  settlementId: string;
  advanceId: string;
  adjustedAmount: number;
  workspaceId: string;
  farmId: string;
  seasonId: string;
};

export function allocateAdvanceAdjustments(args: {
  settlementId: string;
  workspaceId: string;
  farmId: string;
  seasonId: string;
  grossWages: number;
  advances: Array<{ advanceId: string; outstandingAmount: number; advanceDate: string }>;
}) {
  let remaining = Math.max(0, args.grossWages);
  const allocations: AdvanceAllocation[] = [];
  for (const advance of [...args.advances].sort((left, right) => left.advanceDate.localeCompare(right.advanceDate) || left.advanceId.localeCompare(right.advanceId))) {
    if (remaining <= 0) break;
    const adjustedAmount = Math.min(remaining, Math.max(0, advance.outstandingAmount));
    if (adjustedAmount <= 0) continue;
    allocations.push({
      settlementId: args.settlementId,
      advanceId: advance.advanceId,
      adjustedAmount,
      workspaceId: args.workspaceId,
      farmId: args.farmId,
      seasonId: args.seasonId,
    });
    remaining -= adjustedAmount;
  }
  return { allocations, advanceAdjustedNow: allocations.reduce((sum, item) => sum + item.adjustedAmount, 0) };
}

export async function listLabourWageSettlements(
  tx: DbClient,
  workspaceId: string,
  farmId: string,
  seasonId: string,
) {
  const rows = await tx.select({
    id: operationalRecords.id,
    clientRecordId: operationalRecords.clientRecordId,
    workspaceId: operationalRecords.workspaceId,
    farmId: operationalRecords.farmId,
    seasonId: operationalRecords.seasonId,
    clientUpdatedAt: operationalRecords.clientUpdatedAt,
    payload: operationalRecords.payload,
  }).from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId, workspaceId),
    eq(operationalRecords.farmId, farmId),
    eq(operationalRecords.seasonId, seasonId),
    eq(operationalRecords.entityType, "labourWageSettlement"),
  ));
  return rows.map((row) => ({
    ...row,
    payload: normalizeSettlementPayload(row.payload as Record<string, unknown>),
  }));
}

export async function listCanonicalPaymentAccounts(
  tx: DbClient,
  workspaceId: string,
  farmId: string,
) {
  return tx.select({
    id: accounts.id,
    farmId: accounts.farmId,
    name: accounts.name,
    accountType: accounts.accountType,
    active: accounts.active,
    oldAndroidId: accounts.oldAndroidId,
    sourceType: accounts.sourceType,
  }).from(accounts)
    .innerJoin(farms, and(eq(farms.id, accounts.farmId), eq(farms.workspaceId, workspaceId)))
    .where(and(
      eq(accounts.farmId, farmId),
      eq(accounts.active, true),
    ))
    .orderBy(
      asc(sql`case ${accounts.accountType} when 'cash' then 0 when 'bank' then 1 when 'partner' then 2 else 9 end`),
      asc(accounts.name),
    );
}

export async function resolveCanonicalPaymentAccountId(
  tx: DbClient,
  _workspaceId: string,
  farmId: string,
  accountId: string,
) {
  const trimmed = accountId.trim();
  const selectFields = {
    id: accounts.id,
    farmId: accounts.farmId,
    name: accounts.name,
    accountType: accounts.accountType,
    active: accounts.active,
    oldAndroidId: accounts.oldAndroidId,
    sourceType: accounts.sourceType,
  } as const;

  if (isUuid(trimmed)) {
    const [account] = await tx.select(selectFields).from(accounts)
      .where(eq(accounts.id, trimmed))
      .limit(1);
    return account ?? null;
  }

  const legacyId = normalizeLegacyAndroidAccountId(trimmed);
  if (!legacyId) return null;

  const matches = await tx.select(selectFields).from(accounts)
    .where(eq(accounts.oldAndroidId, legacyId));
  if (!matches.length) return null;
  const farmMatches = matches.filter((account: CanonicalPaymentAccount) => account.farmId === farmId);
  if (farmMatches.length === 1) return farmMatches[0] ?? null;
  if (farmMatches.length > 1) {
    throw new Error("Payment account is mapped more than once in this farm. Please repair imported accounts before posting labour settlements.");
  }
  if (matches.length === 1) {
    throw new Error("Payment account is mapped to another farm. Please remap/import accounts for this farm.");
  }
  throw new Error("Payment account is not mapped uniquely. Please remap/import accounts.");
}

export async function findOverlappingLabourWageSettlements(
  tx: DbClient,
  workspaceId: string,
  farmId: string,
  seasonId: string,
  fromDate: string,
  toDate: string,
) {
  const rows = await listLabourWageSettlements(tx, workspaceId, farmId, seasonId);
  return rows.filter((row) =>
    !isDeletedOperationalPayload(row.payload)
    && row.payload.status !== "voided"
    && settlementRangesOverlap(row.payload.fromDate, row.payload.toDate, fromDate, toDate));
}

export async function allocateSettlementNumber(
  tx: DbClient,
  workspaceId: string,
  farmId: string,
) {
  const scopeKey = `${workspaceId}:${farmId}:labour-wage-settlement`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${scopeKey}), 1)`);
  const rows = await tx.select({
    payload: operationalRecords.payload,
  }).from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId, workspaceId),
    eq(operationalRecords.farmId, farmId),
    eq(operationalRecords.entityType, "labourWageSettlement"),
  ));
  const next = rows.reduce((max, row) => {
    const current = parseSettlementSequenceNumber(String((row.payload as Record<string, unknown>).settlementNumber ?? ""));
    return Math.max(max, current ?? 0);
  }, 0) + 1;
  return `LW-${String(next).padStart(4, "0")}`;
}

export async function settlementAccountingTransactionCounts(
  tx: DbClient,
  settlementIds: string[],
) {
  if (!settlementIds.length) return new Map<string, number>();
  const rows = await tx.select({
    referenceId: accountTransactions.referenceId,
    count: sql<number>`count(*)::int`,
  }).from(accountTransactions).where(and(
    inArray(accountTransactions.referenceId, settlementIds),
    eq(accountTransactions.source, "settlement"),
    eq(accountTransactions.sourceType, "labour_wage_settlement"),
  )).groupBy(accountTransactions.referenceId);
  return new Map(rows.map((row) => [row.referenceId ?? "", row.count]));
}

export type LabourWageSettlementSelection = {
  settlementMode?: "individual" | "group";
  labourerId?: string | null;
  foremanId?: string | null;
  groupId?: string | null;
  labourIds?: string[];
};

async function resolveSelectedLabourers(
  tx: DbClient,
  workspaceId: string,
  farmId: string,
  seasonId: string,
  selection: LabourWageSettlementSelection = {},
) {
  const labourRows = await tx.select({
    clientRecordId: operationalRecords.clientRecordId,
    payload: operationalRecords.payload,
  }).from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId, workspaceId),
    eq(operationalRecords.farmId, farmId),
    eq(operationalRecords.seasonId, seasonId),
    eq(operationalRecords.entityType, "labourer"),
  ));
  const labourers = labourRows.map((row) => {
    const payload = row.payload as Record<string, unknown>;
    return {
      id: row.clientRecordId,
      name: typeof payload.name === "string" ? payload.name : "Labourer",
      groupId: typeof payload.groupId === "string" ? payload.groupId : null,
      active: payload.active !== false,
    };
  });
  const labourById = new Map(labourers.map((labourer) => [labourer.id, labourer]));
  const explicitIds = (selection.labourIds ?? []).filter((id) => labourById.has(id));
  if (selection.settlementMode === "group") {
    const groupId = selection.groupId
      ?? (selection.foremanId ? labourById.get(selection.foremanId)?.groupId ?? null : null);
    if (groupId) {
      return labourers.filter((labourer) => labourer.active && labourer.groupId === groupId).map((labourer) => labourer.id);
    }
    if (selection.foremanId && labourById.has(selection.foremanId)) {
      return [selection.foremanId];
    }
  }
  if (selection.settlementMode === "individual" && selection.labourerId && labourById.has(selection.labourerId)) {
    return [selection.labourerId];
  }
  if (explicitIds.length) return explicitIds;
  return labourers.filter((labourer) => labourer.active).map((labourer) => labourer.id);
}

export function settlementAccountingStatus(
  settlement: Pick<LabourWageSettlementPayload, "status">,
  transactionCount: number,
) {
  if (settlement.status === "deleted") return "deleted" as const;
  if (settlement.status === "voided") return "voided" as const;
  return "posted" as const;
}

export async function repairPostedSettlementAccounting(
  tx: DbClient,
  settlementRecord: Awaited<ReturnType<typeof listLabourWageSettlements>>[number],
  actorUserId: string,
) {
  const payload = settlementRecord.payload;
  if (payload.status === "deleted" || isDeletedOperationalPayload(payload)) {
    return {
      settlementId: settlementRecord.clientRecordId,
      settlementNumber: payload.settlementNumber,
      accountingStatus: "deleted",
      createdTransactions: 0,
      existingTransactions: 0,
      accountId: payload.linkedAccountId,
      amount: payload.expenseAmount,
    } satisfies SettlementAccountingRepairResult;
  }
  if (payload.status === "voided") {
    return {
      settlementId: settlementRecord.clientRecordId,
      settlementNumber: payload.settlementNumber,
      accountingStatus: "voided",
      createdTransactions: 0,
      existingTransactions: 0,
      accountId: payload.linkedAccountId,
      amount: payload.expenseAmount,
    } satisfies SettlementAccountingRepairResult;
  }
  if (!settlementRecord.farmId || !settlementRecord.seasonId) {
    throw new Error(`Settlement ${payload.settlementNumber} is missing farm or season context.`);
  }
  const resolvedAccount = await resolveCanonicalPaymentAccountId(
    tx,
    settlementRecord.workspaceId,
    settlementRecord.farmId,
    payload.linkedAccountId,
  );
  const accountValidation = validateLabourSettlementPaymentAccount(resolvedAccount, settlementRecord.farmId);
  const accountId = resolvedAccount?.id ?? payload.paymentAccountId ?? payload.linkedAccountId;
  const accountType = resolvedAccount?.accountType ?? null;
  if (resolvedAccount && resolvedAccount.id !== (payload.paymentAccountId ?? payload.linkedAccountId)) {
    const updatedPayload = {
      ...payload,
      linkedAccountId: resolvedAccount.id,
      paymentAccountId: resolvedAccount.id,
      linkedAccountName: resolvedAccount.name,
      updatedAt: new Date().toISOString(),
    };
    await tx.update(operationalRecords).set({
      payload: updatedPayload,
      updatedAt: new Date(),
    }).where(eq(operationalRecords.id, settlementRecord.id));
    settlementRecord.payload = normalizeSettlementPayload(updatedPayload);
  }
  if (!resolvedAccount) {
    throw new Error(`Settlement ${payload.settlementNumber} cannot be reposted because its payment account no longer exists.`);
  }
  if (!accountValidation.valid) {
    throw new Error(accountValidation.message ?? `Settlement ${payload.settlementNumber} cannot be reposted because its payment account is invalid.`);
  }
  const paidAmount = Number(payload.paidAmount ?? payload.payableBalance ?? payload.cashPayable ?? 0);
  if (paidAmount <= 0) {
    return {
      settlementId: settlementRecord.clientRecordId,
      settlementNumber: payload.settlementNumber,
      accountingStatus: "posted",
      createdTransactions: 0,
      existingTransactions: 0,
      accountId: accountId ?? payload.linkedAccountId,
      amount: 0,
    } satisfies SettlementAccountingRepairResult;
  }
  const existing = await tx.select({
    id: accountTransactions.id,
  }).from(accountTransactions).where(and(
    eq(accountTransactions.referenceId, settlementRecord.clientRecordId),
    eq(accountTransactions.source, "settlement"),
    eq(accountTransactions.sourceType, "labour_wage_settlement"),
  ));

  if (existing.length) {
    const [first] = existing;
    await tx.update(accountTransactions).set({
      farmId: settlementRecord.farmId,
      seasonId: settlementRecord.seasonId,
      accountId,
      type: accountType === "partner" ? "credit" : "debit",
      amount: String(paidAmount),
      transactionDate: payload.settlementDate,
      remarks: `Labour Wage Settlement ${payload.settlementNumber}`,
      createdBy: actorUserId,
      sourceType: "labour_wage_settlement",
    }).where(eq(accountTransactions.id, first!.id));
    if (existing.length > 1) {
      await tx.delete(accountTransactions).where(and(
        eq(accountTransactions.referenceId, settlementRecord.clientRecordId),
        eq(accountTransactions.source, "settlement"),
        eq(accountTransactions.sourceType, "labour_wage_settlement"),
        sql`${accountTransactions.id} <> ${first!.id}`,
      ));
    }
    return {
      settlementId: settlementRecord.clientRecordId,
      settlementNumber: payload.settlementNumber,
      accountingStatus: "posted",
      createdTransactions: 0,
      existingTransactions: existing.length,
      accountId: payload.linkedAccountId,
      amount: paidAmount,
    } satisfies SettlementAccountingRepairResult;
  }

  const insertValues: typeof accountTransactions.$inferInsert = {
    farmId: settlementRecord.farmId,
    seasonId: settlementRecord.seasonId,
    accountId,
    source: "settlement",
    sourceType: "labour_wage_settlement",
    referenceId: settlementRecord.clientRecordId,
    type: accountType === "partner" ? "credit" : "debit",
    amount: String(paidAmount),
    transactionDate: payload.settlementDate,
    remarks: `Labour Wage Settlement ${payload.settlementNumber}`,
    createdBy: actorUserId,
  };
  await tx.insert(accountTransactions).values(insertValues);

  return {
    settlementId: settlementRecord.clientRecordId,
    settlementNumber: payload.settlementNumber,
    accountingStatus: "posted",
    createdTransactions: 1,
    existingTransactions: 0,
    accountId: payload.linkedAccountId,
    amount: paidAmount,
  } satisfies SettlementAccountingRepairResult;
}

export async function previewLabourWageSettlement(
  tx: DbClient,
  workspaceId: string,
  farmId: string,
  seasonId: string,
  fromDate: string,
  toDate: string,
  settlementDate: string,
  excludeSettlementId?: string,
  selection: LabourWageSettlementSelection = {},
) {
  const [attendanceRows, advanceRows, labourRows, wageRates, earningRows, allSettlements, includedLabourIds] = await Promise.all([
    tx.select({
      clientRecordId: operationalRecords.clientRecordId,
      payload: operationalRecords.payload,
    }).from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, workspaceId),
      eq(operationalRecords.farmId, farmId),
      eq(operationalRecords.seasonId, seasonId),
      eq(operationalRecords.entityType, "attendance"),
    )),
    tx.select({
      clientRecordId: operationalRecords.clientRecordId,
      payload: operationalRecords.payload,
    }).from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, workspaceId),
      eq(operationalRecords.farmId, farmId),
      eq(operationalRecords.seasonId, seasonId),
      eq(operationalRecords.entityType, "advance"),
    )),
    tx.select({
      clientRecordId: operationalRecords.clientRecordId,
      payload: operationalRecords.payload,
    }).from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, workspaceId),
      eq(operationalRecords.farmId, farmId),
      eq(operationalRecords.entityType, "labourer"),
    )),
    listWageRateRows(tx, workspaceId, farmId, seasonId),
    listLabourEarnings(tx, workspaceId, farmId, seasonId),
    listLabourWageSettlements(tx, workspaceId, farmId, seasonId),
    resolveSelectedLabourers(tx, workspaceId, farmId, seasonId, selection),
  ]);
  const activeSettlements = allSettlements.filter((row) => !isDeletedOperationalPayload(row.payload) && row.payload.status !== "voided" && row.clientRecordId !== excludeSettlementId);
  const existingSettlements = activeSettlements.filter((row) =>
    settlementRangesOverlap(row.payload.fromDate, row.payload.toDate, fromDate, toDate));

  const labourById = new Map(labourRows.map((row) => {
    const payload = row.payload as LabourPayload;
    return [row.clientRecordId, {
      name: typeof payload.name === "string" ? payload.name : "Labourer",
    }] as const;
  }));

  const includedLabourSet = new Set(includedLabourIds);
  let attendanceWages = 0;
  const sourceAttendanceIds: string[] = [];
  const unresolvedRows: Array<{ labourerId: string; labourName: string; date: string; status: string }> = [];
  for (const row of attendanceRows) {
    const payload = row.payload as AttendancePayload;
    if (isDeletedOperationalPayload(payload as Record<string, unknown>)) continue;
    const labourerId = typeof payload.labourerId === "string" ? payload.labourerId : typeof payload.labourId === "string" ? payload.labourId : "";
    const date = typeof payload.date === "string" ? payload.date : "";
    const status = typeof payload.status === "string" ? payload.status : "";
    if (!includedLabourSet.has(labourerId)) continue;
    if (!labourerId || !date || date < fromDate || date > toDate) continue;
    if (!["present", "half_day", "absent"].includes(status)) continue;
    const labour = labourById.get(labourerId);
    const rate = resolveApplicableWageRate(wageRates, labourerId, date);
    if (!rate && status !== "absent") {
      unresolvedRows.push({
        labourerId,
        labourName: labour?.name ?? "Labourer",
        date,
        status,
      });
    }
    attendanceWages += calculateStatusWage(status as "present" | "half_day" | "absent", rate?.payload ?? null);
    sourceAttendanceIds.push(row.clientRecordId);
  }

  const includedEarnings = earningRows
    .filter((row) =>
      row.payload.status === "pending_settlement"
      && !isDeletedOperationalPayload(row.payload)
      && includedLabourSet.has(row.payload.labourerId)
      && row.payload.earningDate <= settlementDate)
    .map((row) => ({
      id: row.clientRecordId,
      labourerId: row.payload.labourerId,
      labourName: labourById.get(row.payload.labourerId)?.name ?? "Labourer",
      earningDate: row.payload.earningDate,
      earningType: row.payload.earningType,
      description: row.payload.description,
      amount: row.payload.amount,
    }));
  const labourWorkWages = includedEarnings.reduce((sum, row) => sum + row.amount, 0);

  const rawIncludedAdvances = advanceRows
    .filter((row) => {
      const payload = row.payload as AdvancePayload;
      if (isDeletedOperationalPayload(payload as Record<string, unknown>)) return false;
      if (!includedLabourSet.has(typeof payload.labourerId === "string" ? payload.labourerId : "")) return false;
      return typeof payload.date === "string" && payload.date <= settlementDate;
    })
    .map((row) => ({
      advanceId: row.clientRecordId,
      labourerId: typeof (row.payload as AdvancePayload).labourerId === "string" ? String((row.payload as AdvancePayload).labourerId) : "",
      advanceDate: String((row.payload as AdvancePayload).date ?? ""),
      outstandingAmount: Number((row.payload as AdvancePayload).amount ?? 0),
    }));
  const previouslySettledAdvances = activeSettlements
    .filter((row) => row.payload.settlementDate <= settlementDate)
    .reduce((sum, row) => sum + numberValue(row.payload.advanceAdjustedNow ?? row.payload.settledAdvanceAmount ?? row.payload.appliedAdvances), 0);
  let consumedHistoricalAdvances = previouslySettledAdvances;
  const includedAdvances = rawIncludedAdvances.map((advance) => {
    const consumed = Math.min(advance.outstandingAmount, Math.max(consumedHistoricalAdvances, 0));
    consumedHistoricalAdvances = Math.max(consumedHistoricalAdvances - consumed, 0);
    return {
      ...advance,
      outstandingAmount: Math.max(advance.outstandingAmount - consumed, 0),
    };
  });
  const rawAdvancesUpToSettlementDate = rawIncludedAdvances.reduce((sum, row) => sum + row.outstandingAmount, 0);
  const availableAdvanceBalanceBeforeSettlement = includedAdvances.reduce((sum, row) => sum + row.outstandingAmount, 0);

  const baseTotals = calculateLabourWageSettlementTotals(
    attendanceWages,
    labourWorkWages,
    availableAdvanceBalanceBeforeSettlement,
    0,
    0,
  );
  const allocationResult = allocateAdvanceAdjustments({
    settlementId: excludeSettlementId ?? crypto.randomUUID(),
    workspaceId,
    farmId,
    seasonId,
    grossWages: baseTotals.grossWages,
    advances: includedAdvances,
  });
  const advanceAdjustedNow = allocationResult.advanceAdjustedNow;
  const remainingAdvanceCarryForward = Math.max(availableAdvanceBalanceBeforeSettlement - advanceAdjustedNow, 0);
  const netPayableBeforePayment = baseTotals.grossWages - advanceAdjustedNow + baseTotals.manualAdjustment;
  const balanceAfterPayment = netPayableBeforePayment;

  return {
    ...baseTotals,
    labourWorkWages,
    pendingLabourEarnings: labourWorkWages,
    grossWages: baseTotals.grossWages,
    totalEarned: baseTotals.grossWages,
    availableAdvanceBalanceBeforeSettlement,
    advancesAvailableUpToSettlementDate: availableAdvanceBalanceBeforeSettlement,
    rawAdvancesUpToSettlementDate,
    previouslySettledAdvances,
    advanceAdjustedNow,
    settledAdvanceAmount: advanceAdjustedNow,
    appliedAdvances: advanceAdjustedNow,
    remainingAdvanceCarryForward,
    carryForwardAdvance: remainingAdvanceCarryForward,
    netPayableBeforePayment,
    paidAmount: 0,
    balanceAfterPayment,
    payableBalance: balanceAfterPayment,
    settlementDate,
    settlementMode: selection.settlementMode ?? "individual",
    foremanId: selection.foremanId ?? null,
    groupId: selection.groupId ?? null,
    includedLabourIds,
    includedLabourCount: includedLabourIds.length,
    includedEarnings,
    sourceAttendanceIds,
    sourceLabourWorkIds: includedEarnings.map((row) => row.id),
    advanceAdjustmentAllocations: allocationResult.allocations,
    unresolvedRows,
    overlappingSettlements: existingSettlements.map((row) => ({
      id: row.clientRecordId,
      settlementNumber: row.payload.settlementNumber,
      fromDate: row.payload.fromDate,
      toDate: row.payload.toDate,
      settlementDate: row.payload.settlementDate,
      expenseAmount: row.payload.expenseAmount,
      settledAdvanceAmount: row.payload.settledAdvanceAmount,
      status: row.payload.status,
    })),
  };
}
