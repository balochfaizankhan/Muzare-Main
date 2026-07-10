import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { accountTransactions, accounts, farms, operationalRecords } from "../db/schema.js";
import { isDeletedOperationalPayload } from "../operational-record-state.js";
import { normalizeLegacyAndroidAccountId } from "./account-identity.js";
import { resolveLabourAdvanceLedger } from "./labour-advance-ledger.js";
import { labourEarningEligibleForSettlement, listLabourEarnings, normalizeLabourEarningPayload } from "./labour-earnings.js";
import { validateLabourSettlementPaymentAccount, type LabourSettlementAccount } from "./labour-settlement-account-validation.js";
import { calculateStatusWage, listWageRateRows, resolveApplicableWageRate } from "./wage-rates.js";

export { validateLabourSettlementPaymentAccount } from "./labour-settlement-account-validation.js";

type DbClient = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type LabourWageSettlementPayload = {
  clientRequestId?: string | null;
  settlementNumber: string;
  linkedVoucherId: string;
  linkedVoucherNumber: string;
  linkedAccountId: string;
  linkedAccountName?: string | null;
  settlementMode?: "individual" | "group";
  foremanId?: string | null;
  groupId?: string | null;
  groupName?: string | null;
  includedLabourIds?: string[];
  includedInactiveLabourIds?: string[];
  includedActiveLabourIds?: string[];
  excludedLabourers?: Array<{
    labourerId: string;
    labourName: string;
    reason: string;
  }>;
  includedLabourRows?: Array<{
    labourerId: string;
    labourName: string;
    currentStatus: "active" | "inactive";
    groupName: string | null;
    presentDays: number;
    halfDayDays: number;
    absentDays: number;
    payableDays: number;
    wageRateLabel: string | null;
    attendanceWage: number;
    labourWorkWage: number;
    grossWage: number;
    advanceAvailable: number;
    advanceAdjustedNow: number;
    advanceCarriedForward: number;
    netPayableBeforePayment: number;
    paidNow: number;
    balanceAfterSettlement: number;
    missingRateDates: string[];
  }>;
  attendanceTotals?: {
    labourers: number;
    present: number;
    halfDay: number;
    absent: number;
    payableDays: number;
  };
  fromDate: string;
  toDate: string;
  settlementDate: string;
  attendanceWages: number;
  individualLabourWorkWages?: number;
  groupLabourWorkWages?: number;
  labourWorkWages?: number;
  pendingLabourEarnings?: number;
  grossWages: number;
  totalEarned?: number;
  totalLabourCost?: number;
  availableAdvanceBalanceBeforeSettlement: number;
  advancesPaid?: number;
  advancesAvailableUpToSettlementDate?: number;
  rawAdvancesUpToSettlementDate?: number;
  previouslySettledAdvances?: number;
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
  paymentAccountCanonicalId?: string | null;
  paymentAccountLegacyId?: string | null;
  paymentAccountName?: string | null;
  paymentAccountType?: string | null;
  settlementVoucherId?: string | null;
  sourceAttendanceIds?: string[];
  sourceLabourWorkIds?: string[];
  includedEarnings?: Array<{
    id: string;
    labourerId: string | null;
    labourName: string;
    labourGroupId: string | null;
    labourGroupName: string | null;
    foremanId: string | null;
    earningScope: "individual" | "group";
    earningDate: string;
    earningType: string;
    description: string;
    amount: number;
  }>;
  advanceAdjustmentAllocations?: Array<{
    settlementId: string;
    advanceId: string;
    adjustedAmount: number;
    workspaceId: string;
    farmId: string;
    seasonId: string;
  }>;
  notes?: string;
  settlementScopeSnapshot?: {
    settlementMode?: "individual" | "group";
    groupId?: string | null;
    groupName?: string | null;
    individualLabourWorkWages?: number;
    groupLabourWorkWages?: number;
    fromDate: string;
    toDate: string;
    includedLabourIds: string[];
    includedInactiveLabourIds: string[];
    attendanceWageTotal: number;
    attendanceCountTotals: {
      labourers: number;
      present: number;
      halfDay: number;
      absent: number;
      payableDays: number;
    };
    advanceAdjustedNow: number;
    netPayable: number;
    paymentAccountId?: string | null;
    paidNow: number;
  };
  status: "posted" | "voided" | "deleted";
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
  voidedAt?: string | null;
  voidedBy?: string | null;
  reversedAt?: string | null;
  rawStatus?: string | null;
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

export type SettlementAccountingIntegrityResult = {
  accountingStatus: "COMPLETE" | "MISSING" | "REPAIR_REQUIRED" | "FAILED";
  accountingMessage: string | null;
  accountId: string | null;
  accountName: string | null;
  accountType: string | null;
  existingTransactions: number;
};

export type SettlementAdvanceDebugRow = {
  labourerId: string;
  labourName: string;
  totalAdvancesToDate: number;
  priorValidSettledAdvances: number;
  excludedVoidedSettledAdvances: number;
  availableAdvance: number;
  grossWages: number;
  currentAdjustment: number;
  carryForward: number;
};

export type SettlementAdvanceReconciliationWarning = {
  code: "LEGACY_UNALLOCATED_ADVANCE_CONSUMPTION";
  message: string;
  affectedSettlementCount: number;
  affectedAmount: number;
};

export type GroupAdvancePoolTotals = {
  grossWages: number;
  totalAdvancesUpToSettlementDate: number;
  previouslySettledAdvances: number;
  availableAdvanceBalanceBeforeSettlement: number;
  advanceAdjustedNow: number;
  remainingAdvanceCarryForward: number;
  netPayableBeforePayment: number;
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

function settlementAdvanceAdjustedAmount(payload: LabourWageSettlementPayload | Record<string, unknown>) {
  const normalized = "advanceAdjustedNow" in payload || "settledAdvanceAmount" in payload
    ? payload
    : normalizeSettlementPayload(payload);
  return numberValue(
    (normalized as Record<string, unknown>).advanceAdjustedNow
      ?? (normalized as Record<string, unknown>).settledAdvanceAmount
      ?? (normalized as Record<string, unknown>).appliedAdvances,
  );
}

function groupScopeKey(args: {
  settlementMode?: "individual" | "group";
  groupId?: string | null;
  foremanId?: string | null;
  includedLabourIds?: string[] | null;
}) {
  if (args.settlementMode !== "group") return "";
  if (typeof args.groupId === "string" && args.groupId.trim()) return `group:${args.groupId.trim()}`;
  if (typeof args.foremanId === "string" && args.foremanId.trim()) return `foreman:${args.foremanId.trim()}`;
  const includedLabourIds = [...new Set((args.includedLabourIds ?? []).filter((value): value is string => typeof value === "string" && value.trim().length > 0))].sort();
  return includedLabourIds.length ? `members:${includedLabourIds.join(",")}` : "";
}

function settlementGroupScopeKey(payload: LabourWageSettlementPayload) {
  return groupScopeKey({
    settlementMode: payload.settlementMode,
    groupId: payload.groupId ?? payload.settlementScopeSnapshot?.groupId ?? null,
    foremanId: payload.foremanId ?? null,
    includedLabourIds: payload.includedLabourIds ?? payload.settlementScopeSnapshot?.includedLabourIds ?? [],
  });
}

export function calculateGroupAdvancePoolTotals(args: {
  grossWages: number;
  totalAdvancesUpToSettlementDate: number;
  previouslySettledAdvances: number;
  manualAdjustment?: number;
}) : GroupAdvancePoolTotals {
  const grossWages = Math.max(0, numberValue(args.grossWages));
  const totalAdvancesUpToSettlementDate = Math.max(0, numberValue(args.totalAdvancesUpToSettlementDate));
  const previouslySettledAdvances = Math.max(0, numberValue(args.previouslySettledAdvances));
  const manualAdjustment = numberValue(args.manualAdjustment);
  const availableAdvanceBalanceBeforeSettlement = Math.max(totalAdvancesUpToSettlementDate - previouslySettledAdvances, 0);
  const adjustableSettlementAmount = Math.max(grossWages + manualAdjustment, 0);
  const advanceAdjustedNow = Math.max(0, Math.min(adjustableSettlementAmount, availableAdvanceBalanceBeforeSettlement));
  const remainingAdvanceCarryForward = Math.max(availableAdvanceBalanceBeforeSettlement - advanceAdjustedNow, 0);
  const netPayableBeforePayment = grossWages + manualAdjustment - advanceAdjustedNow;
  return {
    grossWages,
    totalAdvancesUpToSettlementDate,
    previouslySettledAdvances,
    availableAdvanceBalanceBeforeSettlement,
    advanceAdjustedNow,
    remainingAdvanceCarryForward,
    netPayableBeforePayment,
  };
}

export function normalizeSettlementPayload(payload: Record<string, unknown>): LabourWageSettlementPayload {
  const attendanceWages = numberValue(payload.attendanceWages);
  const labourWorkWages = numberValue(payload.labourWorkWages ?? payload.labourWork ?? payload.pendingLabourEarnings);
  const grossWages = numberValue(payload.grossWages ?? payload.totalEarned ?? payload.totalLabourCost ?? (attendanceWages + labourWorkWages));
  const availableAdvanceBalanceBeforeSettlement = numberValue(payload.availableAdvanceBalanceBeforeSettlement ?? payload.advancesAvailableUpToSettlementDate ?? payload.advancesPaid);
  const rawAdvancesUpToSettlementDate = numberValue(payload.rawAdvancesUpToSettlementDate ?? availableAdvanceBalanceBeforeSettlement);
  const previouslySettledAdvances = numberValue(payload.previouslySettledAdvances);
  const advanceAdjustedNow = numberValue(payload.advanceAdjustedNow ?? payload.settledAdvanceAmount ?? payload.appliedAdvances);
  const remainingAdvanceCarryForward = numberValue(payload.remainingAdvanceCarryForward ?? payload.carryForwardAdvance);
  const manualAdjustment = numberValue(payload.manualAdjustment);
  const netPayableBeforePayment = numberValue(payload.netPayableBeforePayment ?? (grossWages - advanceAdjustedNow + manualAdjustment));
  const paidAmount = numberValue(payload.paidAmount ?? payload.payableBalance ?? payload.cashPayable);
  const balanceAfterPayment = numberValue(payload.balanceAfterPayment ?? (netPayableBeforePayment - paidAmount));
  const settlementMode = payload.settlementMode === "group" ? "group" : "individual";
  const rawStatus = typeof payload.status === "string" ? payload.status.trim().toLowerCase() : "";
  const normalizedStatus = rawStatus === "deleted"
    ? "deleted"
    : rawStatus === "voided" || rawStatus === "cancelled" || rawStatus === "reversed"
      ? "voided"
      : "posted";
  return {
    clientRequestId: typeof payload.clientRequestId === "string" ? payload.clientRequestId : null,
    settlementNumber: typeof payload.settlementNumber === "string" ? payload.settlementNumber : "LW-0001",
    linkedVoucherId: typeof payload.linkedVoucherId === "string" ? payload.linkedVoucherId : "",
    linkedVoucherNumber: typeof payload.linkedVoucherNumber === "string" ? payload.linkedVoucherNumber : "",
    linkedAccountId: typeof payload.linkedAccountId === "string" ? payload.linkedAccountId : "",
    linkedAccountName: typeof payload.linkedAccountName === "string" ? payload.linkedAccountName : typeof payload.paymentAccountName === "string" ? payload.paymentAccountName : null,
    settlementMode,
    foremanId: typeof payload.foremanId === "string" ? payload.foremanId : null,
    groupId: typeof payload.groupId === "string" ? payload.groupId : null,
    groupName: typeof payload.groupName === "string" ? payload.groupName : null,
    includedLabourIds: stringArrayValue(payload.includedLabourIds),
    includedInactiveLabourIds: stringArrayValue(payload.includedInactiveLabourIds),
    includedActiveLabourIds: stringArrayValue(payload.includedActiveLabourIds),
    excludedLabourers: Array.isArray(payload.excludedLabourers)
      ? payload.excludedLabourers.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const row = item as Record<string, unknown>;
        const labourerId = typeof row.labourerId === "string" ? row.labourerId : "";
        const labourName = typeof row.labourName === "string" ? row.labourName : "Labourer";
        const reason = typeof row.reason === "string" ? row.reason : "";
        if (!labourerId || !reason) return [];
        return [{ labourerId, labourName, reason }];
      })
      : [],
    includedLabourRows: Array.isArray(payload.includedLabourRows)
      ? payload.includedLabourRows.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const row = item as Record<string, unknown>;
        const labourerId = typeof row.labourerId === "string" ? row.labourerId : "";
        const labourName = typeof row.labourName === "string" ? row.labourName : "Labourer";
        const currentStatus = row.currentStatus === "inactive" ? "inactive" : "active";
        if (!labourerId) return [];
        return [{
          labourerId,
          labourName,
          currentStatus,
          groupName: typeof row.groupName === "string" ? row.groupName : null,
          presentDays: numberValue(row.presentDays),
          halfDayDays: numberValue(row.halfDayDays),
          absentDays: numberValue(row.absentDays),
          payableDays: numberValue(row.payableDays),
          wageRateLabel: typeof row.wageRateLabel === "string" ? row.wageRateLabel : null,
          attendanceWage: numberValue(row.attendanceWage),
          labourWorkWage: numberValue(row.labourWorkWage),
          grossWage: numberValue(row.grossWage),
          advanceAvailable: numberValue(row.advanceAvailable),
          advanceAdjustedNow: numberValue(row.advanceAdjustedNow),
          advanceCarriedForward: numberValue(row.advanceCarriedForward),
          netPayableBeforePayment: numberValue(row.netPayableBeforePayment),
          paidNow: numberValue(row.paidNow),
          balanceAfterSettlement: numberValue(row.balanceAfterSettlement),
          missingRateDates: stringArrayValue(row.missingRateDates),
        }];
      })
      : [],
    attendanceTotals: payload.attendanceTotals && typeof payload.attendanceTotals === "object"
      ? {
        labourers: numberValue((payload.attendanceTotals as Record<string, unknown>).labourers),
        present: numberValue((payload.attendanceTotals as Record<string, unknown>).present),
        halfDay: numberValue((payload.attendanceTotals as Record<string, unknown>).halfDay),
        absent: numberValue((payload.attendanceTotals as Record<string, unknown>).absent),
        payableDays: numberValue((payload.attendanceTotals as Record<string, unknown>).payableDays),
      }
      : undefined,
    fromDate: typeof payload.fromDate === "string" ? payload.fromDate : "",
    toDate: typeof payload.toDate === "string" ? payload.toDate : "",
    settlementDate: typeof payload.settlementDate === "string" ? payload.settlementDate : "",
    attendanceWages,
    individualLabourWorkWages: numberValue(payload.individualLabourWorkWages ?? payload.individualWorkWages),
    groupLabourWorkWages: numberValue(payload.groupLabourWorkWages ?? payload.groupWorkWages),
    labourWorkWages,
    pendingLabourEarnings: labourWorkWages,
    grossWages,
    totalEarned: grossWages,
    totalLabourCost: grossWages,
    availableAdvanceBalanceBeforeSettlement,
    advancesPaid: availableAdvanceBalanceBeforeSettlement,
    advancesAvailableUpToSettlementDate: availableAdvanceBalanceBeforeSettlement,
    rawAdvancesUpToSettlementDate,
    previouslySettledAdvances,
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
    paymentAccountCanonicalId: typeof payload.paymentAccountCanonicalId === "string"
      ? payload.paymentAccountCanonicalId
      : typeof payload.paymentAccountId === "string"
        ? payload.paymentAccountId
        : typeof payload.linkedAccountId === "string"
          ? payload.linkedAccountId
          : null,
    paymentAccountLegacyId: typeof payload.paymentAccountLegacyId === "string" ? payload.paymentAccountLegacyId : null,
    paymentAccountName: typeof payload.paymentAccountName === "string"
      ? payload.paymentAccountName
      : typeof payload.linkedAccountName === "string"
        ? payload.linkedAccountName
        : null,
    paymentAccountType: typeof payload.paymentAccountType === "string" ? payload.paymentAccountType : null,
    settlementVoucherId: typeof payload.settlementVoucherId === "string" ? payload.settlementVoucherId : typeof payload.linkedVoucherId === "string" ? payload.linkedVoucherId : null,
    sourceAttendanceIds: stringArrayValue(payload.sourceAttendanceIds),
    sourceLabourWorkIds: stringArrayValue(payload.sourceLabourWorkIds),
    includedEarnings: Array.isArray(payload.includedEarnings)
      ? payload.includedEarnings.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const row = item as Record<string, unknown>;
        const id = typeof row.id === "string" ? row.id : "";
        const earningScope = row.earningScope === "group" ? "group" : "individual";
        const earningDate = typeof row.earningDate === "string" ? row.earningDate : "";
        const earningType = typeof row.earningType === "string" ? row.earningType : "other";
        const description = typeof row.description === "string" ? row.description : "";
        if (!id || !earningDate || !description) return [];
        return [{
          id,
          labourerId: typeof row.labourerId === "string" ? row.labourerId : null,
          labourName: typeof row.labourName === "string" ? row.labourName : "Labourer",
          labourGroupId: typeof row.labourGroupId === "string" ? row.labourGroupId : null,
          labourGroupName: typeof row.labourGroupName === "string" ? row.labourGroupName : null,
          foremanId: typeof row.foremanId === "string" ? row.foremanId : null,
          earningScope,
          earningDate,
          earningType,
          description,
          amount: numberValue(row.amount),
        }];
      })
      : undefined,
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
    settlementScopeSnapshot: payload.settlementScopeSnapshot && typeof payload.settlementScopeSnapshot === "object"
      ? {
        settlementMode: (payload.settlementScopeSnapshot as Record<string, unknown>).settlementMode === "group" ? "group" : "individual",
        groupId: typeof (payload.settlementScopeSnapshot as Record<string, unknown>).groupId === "string" ? String((payload.settlementScopeSnapshot as Record<string, unknown>).groupId) : null,
        groupName: typeof (payload.settlementScopeSnapshot as Record<string, unknown>).groupName === "string" ? String((payload.settlementScopeSnapshot as Record<string, unknown>).groupName) : null,
        fromDate: typeof (payload.settlementScopeSnapshot as Record<string, unknown>).fromDate === "string" ? String((payload.settlementScopeSnapshot as Record<string, unknown>).fromDate) : "",
        toDate: typeof (payload.settlementScopeSnapshot as Record<string, unknown>).toDate === "string" ? String((payload.settlementScopeSnapshot as Record<string, unknown>).toDate) : "",
        includedLabourIds: stringArrayValue((payload.settlementScopeSnapshot as Record<string, unknown>).includedLabourIds),
        includedInactiveLabourIds: stringArrayValue((payload.settlementScopeSnapshot as Record<string, unknown>).includedInactiveLabourIds),
        attendanceWageTotal: numberValue((payload.settlementScopeSnapshot as Record<string, unknown>).attendanceWageTotal),
        attendanceCountTotals: {
          labourers: numberValue(((payload.settlementScopeSnapshot as Record<string, unknown>).attendanceCountTotals as Record<string, unknown> | undefined)?.labourers),
          present: numberValue(((payload.settlementScopeSnapshot as Record<string, unknown>).attendanceCountTotals as Record<string, unknown> | undefined)?.present),
          halfDay: numberValue(((payload.settlementScopeSnapshot as Record<string, unknown>).attendanceCountTotals as Record<string, unknown> | undefined)?.halfDay),
          absent: numberValue(((payload.settlementScopeSnapshot as Record<string, unknown>).attendanceCountTotals as Record<string, unknown> | undefined)?.absent),
          payableDays: numberValue(((payload.settlementScopeSnapshot as Record<string, unknown>).attendanceCountTotals as Record<string, unknown> | undefined)?.payableDays),
        },
        advanceAdjustedNow: numberValue((payload.settlementScopeSnapshot as Record<string, unknown>).advanceAdjustedNow),
        netPayable: numberValue((payload.settlementScopeSnapshot as Record<string, unknown>).netPayable),
        paymentAccountId: typeof (payload.settlementScopeSnapshot as Record<string, unknown>).paymentAccountId === "string" ? String((payload.settlementScopeSnapshot as Record<string, unknown>).paymentAccountId) : null,
        paidNow: numberValue((payload.settlementScopeSnapshot as Record<string, unknown>).paidNow),
      }
      : undefined,
    status: normalizedStatus,
    createdBy: typeof payload.createdBy === "string" ? payload.createdBy : undefined,
    createdAt: typeof payload.createdAt === "string" ? payload.createdAt : undefined,
    updatedAt: typeof payload.updatedAt === "string" ? payload.updatedAt : undefined,
    deletedAt: typeof payload.deletedAt === "string" ? payload.deletedAt : null,
    deletedBy: typeof payload.deletedBy === "string" ? payload.deletedBy : null,
    voidedAt: typeof payload.voidedAt === "string" ? payload.voidedAt : null,
    voidedBy: typeof payload.voidedBy === "string" ? payload.voidedBy : null,
    reversedAt: typeof payload.reversedAt === "string" ? payload.reversedAt : null,
    rawStatus: rawStatus || null,
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

export function settlementConsumesAdvanceBalance(
  settlement: Pick<LabourWageSettlementPayload, "status" | "deletedAt" | "voidedAt" | "reversedAt" | "rawStatus"> | Record<string, unknown>,
) {
  const payload = "rawStatus" in settlement || "status" in settlement
    ? settlement as Pick<LabourWageSettlementPayload, "status" | "deletedAt" | "voidedAt" | "reversedAt" | "rawStatus">
    : normalizeSettlementPayload(settlement);
  const rawStatus = String(payload.rawStatus ?? "").trim().toLowerCase();
  return payload.status === "posted"
    && !payload.deletedAt
    && !payload.voidedAt
    && !payload.reversedAt
    && !["voided", "deleted", "cancelled", "reversed"].includes(rawStatus);
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
  const adjustableSettlementAmount = Math.max(grossWages + manualAdjustment, 0);
  const advanceAdjustedNow = Math.max(0, Math.min(
    Number.isFinite(advanceAdjustedNowOverride ?? NaN) ? Number(advanceAdjustedNowOverride) : adjustableSettlementAmount,
    adjustableSettlementAmount,
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
    active: accounts.active,
    oldAndroidId: accounts.oldAndroidId,
    sourceType: accounts.sourceType,
  } as const;

  if (isUuid(trimmed)) {
    const [account] = await tx.select(selectFields).from(accounts)
      .innerJoin(farms, and(eq(farms.id, accounts.farmId), eq(farms.workspaceId, workspaceId)))
      .where(eq(accounts.id, trimmed))
      .limit(1);
    return account ?? null;
  }

  const legacyId = normalizeLegacyAndroidAccountId(trimmed);
  if (!legacyId) return null;

  const matches = await tx.select(selectFields).from(accounts)
    .innerJoin(farms, and(eq(farms.id, accounts.farmId), eq(farms.workspaceId, workspaceId)))
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

type LabourScopeMember = {
  id: string;
  name: string;
  groupId: string | null;
  groupName: string | null;
  active: boolean;
  isArchived: boolean;
};

type LabourScopeResult = {
  labourers: LabourScopeMember[];
  selectedGroupId: string | null;
  selectedGroupName: string | null;
  selectedForemanId: string | null;
};

function normalizeGroupKey(value?: string | null) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

async function resolveSelectedLabourers(
  tx: DbClient,
  workspaceId: string,
  farmId: string,
  seasonId: string,
  selection: LabourWageSettlementSelection = {},
) : Promise<LabourScopeResult> {
  const [labourRows, groupRows] = await Promise.all([
    tx.select({
      clientRecordId: operationalRecords.clientRecordId,
      payload: operationalRecords.payload,
    }).from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, workspaceId),
      eq(operationalRecords.farmId, farmId),
      eq(operationalRecords.seasonId, seasonId),
      eq(operationalRecords.entityType, "labourer"),
    )),
    tx.select({
      clientRecordId: operationalRecords.clientRecordId,
      payload: operationalRecords.payload,
    }).from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, workspaceId),
      eq(operationalRecords.farmId, farmId),
      eq(operationalRecords.entityType, "labourGroup"),
    )),
  ]);
  const groupsById = new Map(groupRows.map((row) => {
    const payload = row.payload as Record<string, unknown>;
    return [row.clientRecordId, {
      id: row.clientRecordId,
      name: typeof payload.name === "string" ? payload.name : "",
      foremanLabourId: typeof payload.foremanLabourId === "string" ? payload.foremanLabourId : typeof payload.foremanId === "string" ? payload.foremanId : null,
    }] as const;
  }));
  const labourers = labourRows.flatMap((row) => {
    const payload = row.payload as Record<string, unknown>;
    if (isDeletedOperationalPayload(payload) || payload.isArchived === true) return [];
    return [{
      id: row.clientRecordId,
      name: typeof payload.name === "string" ? payload.name : "Labourer",
      groupId: typeof payload.groupId === "string" ? payload.groupId : null,
      groupName: typeof payload.group === "string" ? payload.group : null,
      active: payload.active !== false,
      isArchived: payload.isArchived === true,
    }];
  });
  const labourById = new Map(labourers.map((labourer) => [labourer.id, labourer]));
  const explicitIds = (selection.labourIds ?? []).filter((id) => labourById.has(id));
  const selectedGroupId = selection.groupId
    ?? (selection.foremanId ? labourById.get(selection.foremanId)?.groupId ?? null : null);
  const selectedGroupName = selectedGroupId ? groupsById.get(selectedGroupId)?.name ?? null : null;
  const selectedForemanId = selectedGroupId ? groupsById.get(selectedGroupId)?.foremanLabourId ?? null : null;

  if (selection.settlementMode === "group") {
    if (selectedGroupId) {
      const normalizedGroupName = normalizeGroupKey(selectedGroupName);
      const scoped = labourers.filter((labourer) =>
        labourer.groupId === selectedGroupId
        || (normalizedGroupName && normalizeGroupKey(labourer.groupName) === normalizedGroupName)
        || (selection.foremanId && labourer.id === selection.foremanId)
      );
      return {
        labourers: scoped,
        selectedGroupId,
        selectedGroupName,
        selectedForemanId,
      };
    }
    if (selection.foremanId && labourById.has(selection.foremanId)) {
      return {
        labourers: [labourById.get(selection.foremanId)!],
        selectedGroupId: null,
        selectedGroupName: null,
        selectedForemanId: selection.foremanId,
      };
    }
  }
  if (selection.settlementMode === "individual" && selection.labourerId && labourById.has(selection.labourerId)) {
    return {
      labourers: [labourById.get(selection.labourerId)!],
      selectedGroupId: null,
      selectedGroupName: null,
      selectedForemanId: null,
    };
  }
  if (explicitIds.length) {
    return {
      labourers: explicitIds.map((id) => labourById.get(id)!).filter(Boolean),
      selectedGroupId,
      selectedGroupName,
      selectedForemanId,
    };
  }
  return {
    labourers,
    selectedGroupId,
    selectedGroupName,
    selectedForemanId,
  };
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
  const canonicalPaymentAccountId = payload.paymentAccountCanonicalId ?? payload.paymentAccountId ?? payload.linkedAccountId;
  const paymentAccountLookupId = canonicalPaymentAccountId || payload.paymentAccountLegacyId || payload.linkedAccountId;
  const resolvedAccount = await resolveCanonicalPaymentAccountId(
    tx,
    settlementRecord.workspaceId,
    settlementRecord.farmId,
    paymentAccountLookupId,
  );
  const accountValidation = validateLabourSettlementPaymentAccount(resolvedAccount, settlementRecord.farmId, undefined, { allowInactive: true });
  const accountId = resolvedAccount?.id ?? payload.paymentAccountCanonicalId ?? payload.paymentAccountId ?? payload.linkedAccountId;
  const accountType = resolvedAccount?.accountType ?? null;
  if (resolvedAccount && resolvedAccount.id !== canonicalPaymentAccountId) {
    const updatedPayload = {
      ...payload,
      linkedAccountId: resolvedAccount.id,
      paymentAccountId: resolvedAccount.id,
      paymentAccountCanonicalId: resolvedAccount.id,
      paymentAccountLegacyId: resolvedAccount.oldAndroidId ?? payload.paymentAccountLegacyId ?? null,
      paymentAccountName: resolvedAccount.name,
      paymentAccountType: resolvedAccount.accountType,
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

export async function inspectSettlementAccountingIntegrity(
  tx: DbClient,
  settlementRecord: Awaited<ReturnType<typeof listLabourWageSettlements>>[number],
) : Promise<SettlementAccountingIntegrityResult> {
  const payload = settlementRecord.payload;
  const paidAmount = Number(payload.paidAmount ?? payload.payableBalance ?? payload.cashPayable ?? 0);
  const existingTransactions = (await settlementAccountingTransactionCounts(tx, [settlementRecord.clientRecordId])).get(settlementRecord.clientRecordId) ?? 0;
  const canonicalPaymentAccountId = payload.paymentAccountCanonicalId ?? payload.paymentAccountId ?? payload.linkedAccountId;
  const paymentAccountLookupId = canonicalPaymentAccountId || payload.paymentAccountLegacyId || payload.linkedAccountId;
  let resolvedAccount: CanonicalPaymentAccount | null = null;
  let resolutionError: string | null = null;

  if (paymentAccountLookupId) {
    try {
      resolvedAccount = await resolveCanonicalPaymentAccountId(
        tx,
        settlementRecord.workspaceId,
        settlementRecord.farmId ?? "",
        paymentAccountLookupId,
      );
    } catch (error) {
      resolutionError = error instanceof Error ? error.message : "Payment account could not be resolved.";
    }
  }

  if (payload.status === "deleted") {
    return {
      accountingStatus: "COMPLETE",
      accountingMessage: "Settlement deleted.",
      accountId: canonicalPaymentAccountId,
      accountName: payload.paymentAccountName ?? payload.linkedAccountName ?? null,
      accountType: payload.paymentAccountType ?? null,
      existingTransactions,
    };
  }
  if (payload.status === "voided") {
    return {
      accountingStatus: "COMPLETE",
      accountingMessage: "Settlement is voided.",
      accountId: canonicalPaymentAccountId,
      accountName: payload.paymentAccountName ?? payload.linkedAccountName ?? null,
      accountType: payload.paymentAccountType ?? null,
      existingTransactions,
    };
  }
  if (paidAmount <= 0 || existingTransactions > 0) {
    return {
      accountingStatus: "COMPLETE",
      accountingMessage: null,
      accountId: resolvedAccount?.id ?? canonicalPaymentAccountId,
      accountName: resolvedAccount?.name ?? payload.paymentAccountName ?? payload.linkedAccountName ?? null,
      accountType: resolvedAccount?.accountType ?? payload.paymentAccountType ?? null,
      existingTransactions,
    };
  }
  if (!paymentAccountLookupId || !resolvedAccount) {
    return {
      accountingStatus: "REPAIR_REQUIRED",
      accountingMessage: `Settlement ${payload.settlementNumber} was created, but its accounting entry needs repair because the original payment account could not be resolved.`,
      accountId: canonicalPaymentAccountId,
      accountName: payload.paymentAccountName ?? payload.linkedAccountName ?? null,
      accountType: payload.paymentAccountType ?? null,
      existingTransactions,
    };
  }
  const repairValidation = validateLabourSettlementPaymentAccount(resolvedAccount, settlementRecord.farmId ?? "", undefined, { allowInactive: true });
  if (!repairValidation.valid) {
    return {
      accountingStatus: "REPAIR_REQUIRED",
      accountingMessage: repairValidation.message ?? resolutionError ?? `Settlement ${payload.settlementNumber} accounting needs repair.`,
      accountId: resolvedAccount.id,
      accountName: resolvedAccount.name,
      accountType: resolvedAccount.accountType,
      existingTransactions,
    };
  }
  return {
    accountingStatus: "MISSING",
    accountingMessage: `Settlement ${payload.settlementNumber} was created, but its accounting entry has not been posted yet.`,
    accountId: resolvedAccount.id,
    accountName: resolvedAccount.name,
    accountType: resolvedAccount.accountType,
    existingTransactions,
  };
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
  const labourScope = await resolveSelectedLabourers(tx, workspaceId, farmId, seasonId, selection);
  const attendanceRows = await tx.select({
    clientRecordId: operationalRecords.clientRecordId,
    payload: operationalRecords.payload,
  }).from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId, workspaceId),
    eq(operationalRecords.farmId, farmId),
    eq(operationalRecords.seasonId, seasonId),
    eq(operationalRecords.entityType, "attendance"),
  ));
  const wageRates = await listWageRateRows(tx, workspaceId, farmId, seasonId);
  const earningRows = await listLabourEarnings(tx, workspaceId, farmId, seasonId);
  const allSettlements = await listLabourWageSettlements(tx, workspaceId, farmId, seasonId);
  const activeSettlements = allSettlements.filter((row) =>
    row.clientRecordId !== excludeSettlementId
    && !isDeletedOperationalPayload(row.payload)
    && settlementConsumesAdvanceBalance(row.payload));
  const existingSettlements = activeSettlements.filter((row) =>
    typeof row.payload.fromDate === "string"
    && typeof row.payload.toDate === "string"
    && settlementRangesOverlap(row.payload.fromDate, row.payload.toDate, fromDate, toDate));

  const labourById = new Map(labourScope.labourers.map((labourer) => [labourer.id, labourer]));
  const candidateLabourers = labourScope.labourers;
  const candidateIds = new Set(candidateLabourers.map((labourer) => labourer.id));
  const attendanceByLabourer = new Map<string, Array<{ date: string; status: string; rateMissing: boolean }>>();
  const earningsByLabourer = new Map<string, Array<{ id: string; earningDate: string; amount: number }>>();
  const sourceAttendanceIds: string[] = [];
  const unresolvedRows: Array<{ labourerId: string; labourName: string; date: string; status: string }> = [];
  for (const row of attendanceRows) {
    const payload = row.payload as AttendancePayload;
    if (isDeletedOperationalPayload(payload as Record<string, unknown>)) continue;
    const labourerId = typeof payload.labourerId === "string" ? payload.labourerId : typeof payload.labourId === "string" ? payload.labourId : "";
    const date = typeof payload.date === "string" ? payload.date : "";
    const status = typeof payload.status === "string" ? payload.status : "";
    if (!candidateIds.has(labourerId)) continue;
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
    const bucket = attendanceByLabourer.get(labourerId) ?? [];
    bucket.push({ date, status, rateMissing: !rate && status !== "absent" });
    attendanceByLabourer.set(labourerId, bucket);
    sourceAttendanceIds.push(row.clientRecordId);
  }

  const includedEarnings: Array<{
    id: string;
    labourerId: string | null;
    labourName: string;
    labourGroupId: string | null;
    labourGroupName: string | null;
    foremanId: string | null;
    earningScope: "individual" | "group";
    earningDate: string;
    earningType: "lump_sum" | "task" | "bonus" | "incentive" | "adjustment" | "other";
    description: string;
    amount: number;
  }> = [];
  for (const row of earningRows) {
    if (!labourEarningEligibleForSettlement(row.payload, {
      settlementMode: selection.settlementMode ?? "individual",
      labourerId: selection.labourerId ?? null,
      groupId: labourScope.selectedGroupId ?? selection.groupId ?? null,
      foremanId: labourScope.selectedForemanId ?? selection.foremanId ?? null,
      labourIds: candidateLabourers.map((labourer) => labourer.id),
      settlementDate,
    })) {
      continue;
    }

    const payload = normalizeLabourEarningPayload(row.payload as Record<string, unknown>);
    if (payload.earningScope === "group") {
      if (!labourScope.selectedGroupId) continue;
      includedEarnings.push({
        id: row.clientRecordId,
        labourerId: null,
        labourName: labourScope.selectedGroupName ?? payload.labourGroupName ?? "Labour group",
        labourGroupId: payload.labourGroupId ?? labourScope.selectedGroupId,
        labourGroupName: payload.labourGroupName ?? labourScope.selectedGroupName ?? null,
        foremanId: payload.foremanId ?? labourScope.selectedForemanId ?? null,
        earningScope: "group",
        earningDate: payload.earningDate,
        earningType: payload.earningType,
        description: payload.description,
        amount: payload.amount,
      });
      continue;
    }
    if (!payload.labourerId || !candidateIds.has(payload.labourerId)) continue;
    const bucket = earningsByLabourer.get(payload.labourerId) ?? [];
    bucket.push({
      id: row.clientRecordId,
      earningDate: payload.earningDate,
      amount: payload.amount,
    });
    earningsByLabourer.set(payload.labourerId, bucket);
    includedEarnings.push({
      id: row.clientRecordId,
      labourerId: payload.labourerId,
      labourName: labourById.get(payload.labourerId)?.name ?? "Labourer",
      labourGroupId: payload.labourGroupId ?? labourById.get(payload.labourerId)?.groupId ?? null,
      labourGroupName: payload.labourGroupName ?? labourById.get(payload.labourerId)?.groupName ?? null,
      foremanId: payload.foremanId ?? labourScope.selectedForemanId ?? null,
      earningScope: "individual",
      earningDate: payload.earningDate,
      earningType: payload.earningType,
      description: payload.description,
      amount: payload.amount,
    });
  }
  const individualLabourWorkWages = includedEarnings.filter((row) => row.earningScope === "individual").reduce((sum, row) => sum + row.amount, 0);
  const groupLabourWorkWages = includedEarnings.filter((row) => row.earningScope === "group").reduce((sum, row) => sum + row.amount, 0);
  const labourWorkWages = individualLabourWorkWages + groupLabourWorkWages;
  const advanceLedger = await resolveLabourAdvanceLedger(
    tx,
    {
      workspaceId,
      farmId,
      seasonId,
      cutoffDate: settlementDate,
      settlementId: excludeSettlementId ?? null,
      settlementMode: selection.settlementMode ?? "individual",
      groupId: labourScope.selectedGroupId ?? selection.groupId ?? null,
      foremanId: selection.foremanId ?? null,
      labourerId: selection.labourerId ?? null,
      labourIds: labourScope.labourers.map((labourer) => labourer.id),
    },
    labourScope.labourers.map((labourer) => labourer.id),
    {
      groupId: labourScope.selectedGroupId ?? selection.groupId ?? null,
      foremanId: selection.foremanId ?? null,
      groupName: labourScope.selectedGroupName ?? null,
    },
  );
  const advanceDebugTrace: SettlementAdvanceDebugRow[] = advanceLedger.rows.map((row) => ({
    labourerId: row.labourerId ?? "",
    labourName: row.labourerName ?? "Labourer",
    totalAdvancesToDate: row.originalAmount,
    priorValidSettledAdvances: row.previouslyAbsorbedAmount,
    excludedVoidedSettledAdvances: row.voidedOrDeleted ? row.originalAmount : 0,
    availableAdvance: row.remainingAvailableAmount,
    grossWages: 0,
    currentAdjustment: row.includedInPreview ? row.remainingAvailableAmount : 0,
    carryForward: row.remainingAvailableAmount,
  }));
  const includedLabourRows = candidateLabourers.flatMap((labourer) => {
    const attendanceRecords = attendanceByLabourer.get(labourer.id) ?? [];
    const earningRecords = earningsByLabourer.get(labourer.id) ?? [];
    if (!attendanceRecords.length && !earningRecords.length) return [];
    const presentDays = attendanceRecords.filter((record) => record.status === "present").length;
    const halfDayDays = attendanceRecords.filter((record) => record.status === "half_day").length;
    const absentDays = attendanceRecords.filter((record) => record.status === "absent").length;
    const payableDays = presentDays + halfDayDays * 0.5;
    const appliedRates = attendanceRecords.map((record) => ({
      record,
      rate: resolveApplicableWageRate(wageRates, labourer.id, record.date),
    }));
    const attendanceWage = appliedRates.reduce((sum, item) => sum + calculateStatusWage(item.record.status as "present" | "half_day" | "absent", item.rate?.payload ?? null), 0);
    const missingRateDates = attendanceRecords.filter((record) => record.status !== "absent" && !resolveApplicableWageRate(wageRates, labourer.id, record.date)).map((record) => record.date);
    const distinctDailyRates = [...new Set(appliedRates
      .filter((item) => item.rate)
      .map((item) => Number(item.rate?.payload.dailyRate))
      .filter((value) => Number.isFinite(value) && value > 0))];
    const wageRateLabel = distinctDailyRates.length === 0 ? null : distinctDailyRates.length === 1 ? String(distinctDailyRates[0]) : "Mixed";
    const labourWorkWage = earningRecords.reduce((sum, row) => sum + row.amount, 0);
    const grossWage = attendanceWage + labourWorkWage;
    return [{
      labourerId: labourer.id,
      labourName: labourer.name,
      currentStatus: labourer.active === false ? "inactive" as const : "active" as const,
      groupName: labourer.groupName ?? labourScope.selectedGroupName ?? null,
      presentDays,
      halfDayDays,
      absentDays,
      payableDays,
      wageRateLabel,
      attendanceWage,
      labourWorkWage,
      grossWage,
      advanceAvailable: 0,
      advanceAdjustedNow: 0,
      advanceCarriedForward: 0,
      netPayableBeforePayment: grossWage,
      paidNow: 0,
      balanceAfterSettlement: grossWage,
      missingRateDates,
    }];
  });
  const includedLabourIds = includedLabourRows.map((row) => row.labourerId);
  const includedLabourSet = new Set(includedLabourIds);
  const includedInactiveLabourIds = includedLabourRows.filter((labourer) => labourer.currentStatus === "inactive").map((labourer) => labourer.labourerId);
  const includedActiveLabourIds = includedLabourRows.filter((labourer) => labourer.currentStatus === "active").map((labourer) => labourer.labourerId);
  const attendanceTotals = includedLabourRows.reduce<{
    labourers: number;
    present: number;
    halfDay: number;
    absent: number;
    payableDays: number;
  }>((totals, row) => ({
    labourers: totals.labourers + 1,
    present: totals.present + row.presentDays,
    halfDay: totals.halfDay + row.halfDayDays,
    absent: totals.absent + row.absentDays,
    payableDays: totals.payableDays + row.payableDays,
  }), {
    labourers: 0,
    present: 0,
    halfDay: 0,
    absent: 0,
    payableDays: 0,
  });
  const attendanceWages = includedLabourRows.reduce((sum, row) => sum + row.attendanceWage, 0);
  const grossWagesEarned = includedLabourRows.reduce((sum, row) => sum + row.grossWage, 0) + groupLabourWorkWages;
  const rawAdvancesUpToSettlementDate = advanceLedger.totals.totalValidAdvancesToCutoff;
  const availableAdvanceBalanceBeforeSettlement = advanceLedger.totals.availableGroupAdvances;
  const advanceAdjustedNow = selection.settlementMode === "group"
    ? Math.min(grossWagesEarned, availableAdvanceBalanceBeforeSettlement)
    : 0;
  const remainingAdvanceCarryForward = selection.settlementMode === "group"
    ? Math.max(availableAdvanceBalanceBeforeSettlement - advanceAdjustedNow, 0)
    : 0;
  const netPayableBeforePayment = selection.settlementMode === "group"
    ? Math.max(grossWagesEarned - availableAdvanceBalanceBeforeSettlement, 0)
    : grossWagesEarned;
  const balanceAfterPayment = netPayableBeforePayment;
  const previouslySettledAdvances = advanceLedger.totals.previouslyAbsorbedAdvances;
  const excludedVoidedSettledAdvances = advanceDebugTrace.reduce((sum, row) => sum + row.excludedVoidedSettledAdvances, 0);
  const advanceReconciliationWarnings: SettlementAdvanceReconciliationWarning[] =
    advanceLedger.totals.legacyUnallocatedPreviouslyAbsorbedAdvances > 0.005
      ? [{
        code: "LEGACY_UNALLOCATED_ADVANCE_CONSUMPTION",
        message: "One or more historical settlements consumed advances without canonical allocation rows. Review historical settlement allocations before posting a new settlement.",
        affectedSettlementCount: advanceLedger.totals.ambiguousHistoricalSettlementCount,
        affectedAmount: advanceLedger.totals.legacyUnallocatedPreviouslyAbsorbedAdvances,
      }]
      : [];
  const excludedLabourers = candidateLabourers
    .filter((labourer) => !includedLabourSet.has(labourer.id))
    .map((labourer) => {
      const attendanceCount = attendanceByLabourer.get(labourer.id)?.length ?? 0;
      const earningCount = earningsByLabourer.get(labourer.id)?.length ?? 0;
      const reason = labourScope.selectedGroupId
        ? "not in selected group"
        : attendanceCount === 0 && earningCount === 0
          ? "no attendance in selected period"
          : "no payable wage";
      return {
        labourerId: labourer.id,
        labourName: labourer.name,
        reason,
      };
  });
  const advanceAdjustmentAllocations = selection.settlementMode === "group"
    ? []
    : [];

  return {
    attendanceWages,
    individualLabourWorkWages,
    groupLabourWorkWages,
    labourWorkWages,
    pendingLabourEarnings: labourWorkWages,
    grossWages: grossWagesEarned,
    totalEarned: grossWagesEarned,
    totalLabourCost: grossWagesEarned,
    availableAdvanceBalanceBeforeSettlement,
    advancesAvailableUpToSettlementDate: availableAdvanceBalanceBeforeSettlement,
    advancesPaid: availableAdvanceBalanceBeforeSettlement,
    rawAdvancesUpToSettlementDate,
    previouslySettledAdvances,
    legacyUnallocatedPreviouslySettledAdvances: advanceLedger.totals.legacyUnallocatedPreviouslyAbsorbedAdvances,
    excludedVoidedSettledAdvances,
    advanceAdjustedNow,
    settledAdvanceAmount: advanceAdjustedNow,
    appliedAdvances: advanceAdjustedNow,
    remainingAdvanceCarryForward,
    carryForwardAdvance: remainingAdvanceCarryForward,
    manualAdjustment: 0,
    netPayableBeforePayment,
    expenseAmount: grossWagesEarned,
    paidAmount: 0,
    balanceAfterPayment,
    payableBalance: balanceAfterPayment,
    settlementDate,
    settlementMode: selection.settlementMode ?? "individual",
    foremanId: selection.foremanId ?? labourScope.selectedForemanId ?? null,
    groupId: labourScope.selectedGroupId ?? selection.groupId ?? null,
    groupName: labourScope.selectedGroupName ?? null,
    settlementScopeSnapshot: {
      settlementMode: selection.settlementMode ?? "individual",
      groupId: labourScope.selectedGroupId ?? selection.groupId ?? null,
      groupName: labourScope.selectedGroupName ?? null,
      foremanId: selection.foremanId ?? labourScope.selectedForemanId ?? null,
      fromDate,
      toDate,
      includedLabourIds,
      includedInactiveLabourIds,
      attendanceWageTotal: attendanceWages,
      attendanceCountTotals: attendanceTotals,
      advanceAdjustedNow,
      netPayable: netPayableBeforePayment,
      individualLabourWorkWages,
      groupLabourWorkWages,
      paymentAccountId: null,
      paidNow: 0,
    },
    includedLabourIds,
    includedLabourCount: includedLabourIds.length,
    includedInactiveLabourIds,
    includedActiveLabourIds,
    excludedLabourers,
    attendanceTotals,
    includedEarnings,
    includedLabourRows,
    sourceAttendanceIds,
    sourceLabourWorkIds: includedEarnings.map((row) => row.id),
    advanceAdjustmentAllocations,
    advanceDebugTrace,
    advanceReconciliation: advanceLedger.rows,
    advanceReconciliationWarnings,
    ambiguousHistoricalSettlements: advanceLedger.ambiguousHistoricalSettlements,
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
