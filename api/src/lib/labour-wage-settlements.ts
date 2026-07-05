import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { accountTransactions, accounts, farms, operationalRecords } from "../db/schema.js";
import { isDeletedOperationalPayload } from "../operational-record-state.js";
import { listLabourEarnings } from "./labour-earnings.js";
import { calculateStatusWage, listWageRateRows, resolveApplicableWageRate } from "./wage-rates.js";

type DbClient = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type LabourWageSettlementPayload = {
  settlementNumber: string;
  linkedVoucherId: string;
  linkedVoucherNumber: string;
  linkedAccountId: string;
  fromDate: string;
  toDate: string;
  settlementDate: string;
  attendanceWages: number;
  pendingLabourEarnings: number;
  labourWork?: number;
  totalEarned: number;
  totalLabourCost?: number;
  advancesPaid: number;
  advancesAvailableUpToSettlementDate?: number;
  settledAdvanceAmount: number;
  appliedAdvances?: number;
  expenseAmount: number;
  carryForwardAdvance: number;
  payableBalance: number;
  cashPayable?: number;
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
type AdvancePayload = { date?: unknown; amount?: unknown };
type CanonicalPaymentAccount = {
  id: string;
  farmId: string;
  name: string;
  accountType: string;
  oldAndroidId: string | null;
  sourceType: string | null;
};

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function legacyAndroidAccountId(value: string) {
  const match = /^android:[^:]+:account:(.+)$/i.exec(value.trim());
  return match?.[1]?.trim() || null;
}

function parseSettlementSequenceNumber(value: string) {
  const match = /^LW-(\d+)$/i.exec(value.trim());
  return match ? Number(match[1]) : null;
}

export function normalizeSettlementPayload(payload: Record<string, unknown>): LabourWageSettlementPayload {
  const attendanceWages = Number(payload.attendanceWages ?? 0);
  const pendingLabourEarnings = Number(payload.pendingLabourEarnings ?? payload.labourWork ?? 0);
  const totalEarned = Number(payload.totalEarned ?? payload.totalLabourCost ?? (attendanceWages + pendingLabourEarnings));
  const advancesPaid = Number(payload.advancesPaid ?? payload.advancesAvailableUpToSettlementDate ?? 0);
  const settledAdvanceAmount = Number(payload.settledAdvanceAmount ?? payload.appliedAdvances ?? 0);
  const expenseAmount = Number(payload.expenseAmount ?? totalEarned);
  const carryForwardAdvance = Number(payload.carryForwardAdvance ?? 0);
  const payableBalance = Number(payload.payableBalance ?? payload.cashPayable ?? 0);
  return {
    settlementNumber: typeof payload.settlementNumber === "string" ? payload.settlementNumber : "LW-0001",
    linkedVoucherId: typeof payload.linkedVoucherId === "string" ? payload.linkedVoucherId : "",
    linkedVoucherNumber: typeof payload.linkedVoucherNumber === "string" ? payload.linkedVoucherNumber : "",
    linkedAccountId: typeof payload.linkedAccountId === "string" ? payload.linkedAccountId : "",
    fromDate: typeof payload.fromDate === "string" ? payload.fromDate : "",
    toDate: typeof payload.toDate === "string" ? payload.toDate : "",
    settlementDate: typeof payload.settlementDate === "string" ? payload.settlementDate : "",
    attendanceWages,
    pendingLabourEarnings,
    labourWork: pendingLabourEarnings,
    totalEarned,
    totalLabourCost: totalEarned,
    advancesPaid,
    advancesAvailableUpToSettlementDate: advancesPaid,
    settledAdvanceAmount,
    appliedAdvances: settledAdvanceAmount,
    expenseAmount,
    carryForwardAdvance,
    payableBalance,
    cashPayable: payableBalance,
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

export function calculateLabourWageSettlementTotals(attendanceWages: number, pendingLabourEarnings: number, advancesPaid: number) {
  const totalEarned = attendanceWages + pendingLabourEarnings;
  const settledAdvanceAmount = Math.min(totalEarned, advancesPaid);
  const carryForwardAdvance = Math.max(advancesPaid - totalEarned, 0);
  const payableBalance = Math.max(totalEarned - advancesPaid, 0);
  const expenseAmount = totalEarned;
  return {
    attendanceWages,
    pendingLabourEarnings,
    totalEarned,
    advancesPaid,
    settledAdvanceAmount,
    expenseAmount,
    carryForwardAdvance,
    payableBalance,
  };
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
  workspaceId: string,
  farmId: string,
  accountId: string,
) {
  const trimmed = accountId.trim();
  const selectFields = {
    id: accounts.id,
    farmId: accounts.farmId,
    name: accounts.name,
    accountType: accounts.accountType,
    oldAndroidId: accounts.oldAndroidId,
    sourceType: accounts.sourceType,
  } as const;

  if (isUuid(trimmed)) {
    const [account] = await tx.select(selectFields).from(accounts)
      .innerJoin(farms, and(eq(farms.id, accounts.farmId), eq(farms.workspaceId, workspaceId)))
      .where(and(
        eq(accounts.active, true),
        eq(accounts.id, trimmed),
        eq(accounts.farmId, farmId),
      ))
      .limit(1);
    return account ?? null;
  }

  const legacyId = legacyAndroidAccountId(trimmed);
  if (!legacyId) return null;

  const matches = await tx.select(selectFields).from(accounts)
    .innerJoin(farms, and(eq(farms.id, accounts.farmId), eq(farms.workspaceId, workspaceId)))
    .where(and(
      eq(accounts.active, true),
      eq(accounts.oldAndroidId, legacyId),
    ));
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

export function settlementAccountingStatus(
  settlement: Pick<LabourWageSettlementPayload, "status">,
  transactionCount: number,
) {
  if (settlement.status === "deleted") return "deleted" as const;
  if (settlement.status === "voided") return "voided" as const;
  return transactionCount > 0 ? "posted" as const : "accounting_missing" as const;
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
  const resolvedAccount = await resolveCanonicalPaymentAccountId(
    tx,
    settlementRecord.workspaceId,
    settlementRecord.farmId ?? "",
    payload.linkedAccountId,
  );
  const accountId = resolvedAccount?.id ?? payload.linkedAccountId;
  const accountType = resolvedAccount?.accountType ?? null;
  if (resolvedAccount && resolvedAccount.id !== payload.linkedAccountId) {
    const updatedPayload = {
      ...payload,
      linkedAccountId: resolvedAccount.id,
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
  const existing = await tx.select({
    id: accountTransactions.id,
  }).from(accountTransactions).where(and(
    eq(accountTransactions.referenceId, settlementRecord.clientRecordId),
    eq(accountTransactions.source, "settlement"),
    eq(accountTransactions.sourceType, "labour_wage_settlement"),
  ));

  if (!settlementRecord.farmId || !settlementRecord.seasonId) {
    throw new Error(`Settlement ${payload.settlementNumber} is missing farm or season context.`);
  }

  if (existing.length) {
    const [first] = existing;
    await tx.update(accountTransactions).set({
      farmId: settlementRecord.farmId,
      seasonId: settlementRecord.seasonId,
      accountId,
      type: accountType === "partner" ? "credit" : "debit",
      amount: String(payload.expenseAmount),
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
      amount: payload.expenseAmount,
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
    amount: String(payload.expenseAmount),
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
    amount: payload.expenseAmount,
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
) {
  const [attendanceRows, advanceRows, labourRows, wageRates, earningRows, allSettlements] = await Promise.all([
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
  ]);
  const activeSettlements = allSettlements.filter((row) => !isDeletedOperationalPayload(row.payload) && row.payload.status !== "voided");
  const existingSettlements = activeSettlements.filter((row) =>
    settlementRangesOverlap(row.payload.fromDate, row.payload.toDate, fromDate, toDate));

  const labourById = new Map(labourRows.map((row) => {
    const payload = row.payload as LabourPayload;
    return [row.clientRecordId, {
      name: typeof payload.name === "string" ? payload.name : "Labourer",
    }] as const;
  }));

  let attendanceWages = 0;
  const unresolvedRows: Array<{ labourerId: string; labourName: string; date: string; status: string }> = [];
  for (const row of attendanceRows) {
    const payload = row.payload as AttendancePayload;
    if (isDeletedOperationalPayload(payload as Record<string, unknown>)) continue;
    const labourerId = typeof payload.labourerId === "string" ? payload.labourerId : typeof payload.labourId === "string" ? payload.labourId : "";
    const date = typeof payload.date === "string" ? payload.date : "";
    const status = typeof payload.status === "string" ? payload.status : "";
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
  }

  const includedEarnings = earningRows
    .filter((row) =>
      row.payload.status === "pending_settlement"
      && !isDeletedOperationalPayload(row.payload)
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
  const pendingLabourEarnings = includedEarnings.reduce((sum, row) => sum + row.amount, 0);

  const advancesUpToSettlementDate = advanceRows.reduce((sum, row) => {
    const payload = row.payload as AdvancePayload;
    if (isDeletedOperationalPayload(payload as Record<string, unknown>)) return sum;
    if (typeof payload.date !== "string" || payload.date > settlementDate) return sum;
    return sum + Number(payload.amount ?? 0);
  }, 0);

  const previouslySettledAdvances = activeSettlements.reduce((sum, row) => {
    if (row.payload.settlementDate > settlementDate) return sum;
    return sum + row.payload.settledAdvanceAmount;
  }, 0);
  const advancesPaid = Math.max(advancesUpToSettlementDate - previouslySettledAdvances, 0);
  const totals = calculateLabourWageSettlementTotals(attendanceWages, pendingLabourEarnings, advancesPaid);

  return {
    ...totals,
    advancesAvailableUpToSettlementDate: advancesPaid,
    rawAdvancesUpToSettlementDate: advancesUpToSettlementDate,
    previouslySettledAdvances,
    settlementDate,
    includedEarnings,
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
