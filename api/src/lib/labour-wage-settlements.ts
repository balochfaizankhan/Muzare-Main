import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { operationalRecords } from "../db/schema.js";
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
  totalEarned: number;
  advancesPaid: number;
  settledAdvanceAmount: number;
  expenseAmount: number;
  carryForwardAdvance: number;
  payableBalance: number;
  notes?: string;
  status: "posted" | "voided";
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
  voidedAt?: string | null;
  voidedBy?: string | null;
  voidReason?: string | null;
};

type LabourPayload = { name?: unknown };
type AttendancePayload = { labourerId?: unknown; labourId?: unknown; date?: unknown; status?: unknown };
type AdvancePayload = { date?: unknown; amount?: unknown };

function parseSettlementSequenceNumber(value: string) {
  const match = /^LW-(\d+)$/i.exec(value.trim());
  return match ? Number(match[1]) : null;
}

export function normalizeSettlementPayload(payload: Record<string, unknown>): LabourWageSettlementPayload {
  return {
    settlementNumber: typeof payload.settlementNumber === "string" ? payload.settlementNumber : "LW-0001",
    linkedVoucherId: typeof payload.linkedVoucherId === "string" ? payload.linkedVoucherId : "",
    linkedVoucherNumber: typeof payload.linkedVoucherNumber === "string" ? payload.linkedVoucherNumber : "",
    linkedAccountId: typeof payload.linkedAccountId === "string" ? payload.linkedAccountId : "",
    fromDate: typeof payload.fromDate === "string" ? payload.fromDate : "",
    toDate: typeof payload.toDate === "string" ? payload.toDate : "",
    settlementDate: typeof payload.settlementDate === "string" ? payload.settlementDate : "",
    attendanceWages: Number(payload.attendanceWages ?? 0),
    pendingLabourEarnings: Number(payload.pendingLabourEarnings ?? 0),
    totalEarned: Number(payload.totalEarned ?? (Number(payload.attendanceWages ?? 0) + Number(payload.pendingLabourEarnings ?? 0))),
    advancesPaid: Number(payload.advancesPaid ?? 0),
    settledAdvanceAmount: Number(payload.settledAdvanceAmount ?? 0),
    expenseAmount: Number(payload.expenseAmount ?? 0),
    carryForwardAdvance: Number(payload.carryForwardAdvance ?? 0),
    payableBalance: Number(payload.payableBalance ?? 0),
    notes: typeof payload.notes === "string" ? payload.notes : "",
    status: payload.status === "voided" ? "voided" : "posted",
    createdBy: typeof payload.createdBy === "string" ? payload.createdBy : undefined,
    createdAt: typeof payload.createdAt === "string" ? payload.createdAt : undefined,
    updatedAt: typeof payload.updatedAt === "string" ? payload.updatedAt : undefined,
    voidedAt: typeof payload.voidedAt === "string" ? payload.voidedAt : null,
    voidedBy: typeof payload.voidedBy === "string" ? payload.voidedBy : null,
    voidReason: typeof payload.voidReason === "string" ? payload.voidReason : null,
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

export async function previewLabourWageSettlement(
  tx: DbClient,
  workspaceId: string,
  farmId: string,
  seasonId: string,
  fromDate: string,
  toDate: string,
  settlementDate: string,
) {
  const [attendanceRows, advanceRows, labourRows, wageRates, earningRows, existingSettlements] = await Promise.all([
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
    findOverlappingLabourWageSettlements(tx, workspaceId, farmId, seasonId, fromDate, toDate),
  ]);

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

  const previouslySettledAdvances = existingSettlements.reduce((sum, row) => {
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
