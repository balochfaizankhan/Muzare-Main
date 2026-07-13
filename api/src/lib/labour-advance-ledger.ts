import { and, eq, inArray, sql } from "drizzle-orm";
import type { db } from "../db/client.js";
import { labourWageSettlementAdvanceAllocations, operationalRecords, users } from "../db/schema.js";
import { isDeletedOperationalPayload } from "../operational-record-state.js";

type DbClient = Parameters<Parameters<typeof db.transaction>[0]>[0];

type AdvancePayload = {
  labourerId?: unknown;
  labourId?: unknown;
  labourGroupId?: unknown;
  labourGroupName?: unknown;
  date?: unknown;
  advanceDate?: unknown;
  amount?: unknown;
  accountId?: unknown;
  sourceAccountName?: unknown;
  notes?: unknown;
  createdBy?: unknown;
  updatedBy?: unknown;
  deletedAt?: unknown;
  voidedAt?: unknown;
  reversedAt?: unknown;
  status?: unknown;
  source?: unknown;
};

type SettlementPayload = {
  settlementNumber?: unknown;
  advanceAdjustmentAllocations?: Array<{
    advanceId?: unknown;
    adjustedAmount?: unknown;
  }>;
};

type LabourRow = {
  id: string;
  farmId: string;
  name: string;
  groupId: string | null;
  groupName: string | null;
  active: boolean;
  deleted: boolean;
};

type GroupRow = {
  id: string;
  farmId: string;
  name: string;
  foremanLabourId: string | null;
  active: boolean;
  deleted: boolean;
};

export type LabourAdvanceReconciliationRow = {
  advanceId: string;
  advanceRecordId: string;
  sourceAdvanceId: string;
  date: string;
  amount: number;
  labourerId: string | null;
  labourerName: string | null;
  labourGroupId: string | null;
  labourGroupName: string | null;
  farmId: string | null;
  seasonId: string | null;
  workspaceId: string;
  accountId: string | null;
  accountName: string | null;
  recordedById: string | null;
  recordedByName: string | null;
  originalAmount: number;
  previouslyAbsorbedAmount: number;
  remainingAvailableAmount: number;
  includedInPreview: boolean;
  exclusionReason: string | null;
  sourceRecordType: string;
  voidedOrDeleted: boolean;
};

export type LabourAdvanceLedgerTotals = {
  totalValidAdvancesToCutoff: number;
  previouslyAbsorbedAdvances: number;
  availableGroupAdvances: number;
  legacyUnallocatedPreviouslyAbsorbedAdvances: number;
  ambiguousHistoricalSettlementCount: number;
};

export type LabourAdvanceLedgerResult = {
  rows: LabourAdvanceReconciliationRow[];
  totals: LabourAdvanceLedgerTotals;
  includedAdvances: Array<{
    advanceId: string;
    advanceRecordId: string;
    outstandingAmount: number;
    advanceDate: string;
  }>;
  ambiguousHistoricalSettlements: Array<{
    settlementRecordId: string;
    settlementId: string;
    settlementNumber: string | null;
    settlementDate: string;
    unallocatedAbsorbedAmount: number;
  }>;
};

export type LabourAdvanceLedgerScope = {
  workspaceId: string;
  farmId: string;
  seasonId: string;
  cutoffDate: string;
  settlementId?: string | null;
  settlementMode?: "individual" | "group";
  groupId?: string | null;
  foremanId?: string | null;
  labourerId?: string | null;
  labourIds?: string[];
};

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : Number(value ?? 0);
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeDate(value: unknown) {
  const text = stringValue(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function advanceDate(payload: AdvancePayload) {
  return normalizeDate(payload.date) || normalizeDate(payload.advanceDate);
}

function settleConsumedAmountFromAllocations(rows: Array<{ absorbedAmount: number }>) {
  return rows.reduce((sum, row) => sum + Math.max(0, Number(row.absorbedAmount ?? 0)), 0);
}

function settlementConsumesAdvanceBalance(payload: Record<string, unknown>) {
  const status = String(payload.status ?? "").trim().toLowerCase();
  const rawStatus = String(payload.rawStatus ?? "").trim().toLowerCase();
  return status === "posted" && !payload.deletedAt && !payload.voidedAt && !payload.reversedAt && !["voided", "deleted", "cancelled", "reversed"].includes(rawStatus);
}

function normalizeSettlementPayload(payload: Record<string, unknown>) {
  return {
    settlementMode: payload.settlementMode === "group" ? "group" : "individual",
    groupId: typeof payload.groupId === "string" ? payload.groupId : null,
    groupName: typeof payload.groupName === "string" ? payload.groupName : null,
    foremanId: typeof payload.foremanId === "string" ? payload.foremanId : null,
    settlementDate: typeof payload.settlementDate === "string" ? payload.settlementDate : "",
    settledAdvanceAmount: numberValue(payload.settledAdvanceAmount ?? payload.appliedAdvances ?? payload.advanceAdjustedNow ?? payload.advancesPaid),
    advanceAdjustedNow: numberValue(payload.advanceAdjustedNow ?? payload.settledAdvanceAmount ?? payload.appliedAdvances ?? payload.advancesPaid),
    appliedAdvances: numberValue(payload.appliedAdvances ?? payload.settledAdvanceAmount ?? payload.advanceAdjustedNow ?? payload.advancesPaid),
  };
}

function sameLegacyScope(row: { farmId: string | null; seasonId: string | null }, scope: LabourAdvanceLedgerScope) {
  return (row.farmId === scope.farmId || row.farmId === null)
    && (row.seasonId === scope.seasonId || row.seasonId === null);
}

export async function resolveLabourAdvanceLedger(
  tx: DbClient,
  scope: LabourAdvanceLedgerScope,
  labourFilterIds: string[],
  labourGroupScope: { groupId: string | null; foremanId: string | null; groupName: string | null } = { groupId: null, foremanId: null, groupName: null },
) : Promise<LabourAdvanceLedgerResult> {
  const [advanceRows, labourRows, groupRows, settlementRows, allocationRows, userRows] = await Promise.all([
    tx.select({
      id: operationalRecords.id,
      clientRecordId: operationalRecords.clientRecordId,
      workspaceId: operationalRecords.workspaceId,
      farmId: operationalRecords.farmId,
      seasonId: operationalRecords.seasonId,
      payload: operationalRecords.payload,
    }).from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, scope.workspaceId),
      eq(operationalRecords.entityType, "advance"),
    )),
    tx.select({
      id: operationalRecords.clientRecordId,
      farmId: operationalRecords.farmId,
      payload: operationalRecords.payload,
    }).from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, scope.workspaceId),
      eq(operationalRecords.entityType, "labourer"),
    )),
    tx.select({
      id: operationalRecords.clientRecordId,
      farmId: operationalRecords.farmId,
      payload: operationalRecords.payload,
    }).from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, scope.workspaceId),
      eq(operationalRecords.entityType, "labourGroup"),
    )),
    tx.select({
      id: operationalRecords.id,
      clientRecordId: operationalRecords.clientRecordId,
      workspaceId: operationalRecords.workspaceId,
      farmId: operationalRecords.farmId,
      seasonId: operationalRecords.seasonId,
      payload: operationalRecords.payload,
    }).from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, scope.workspaceId),
      eq(operationalRecords.farmId, scope.farmId),
      eq(operationalRecords.seasonId, scope.seasonId),
      eq(operationalRecords.entityType, "labourWageSettlement"),
    )),
    tx.select({
      settlementRecordId: labourWageSettlementAdvanceAllocations.settlementRecordId,
      advanceRecordId: labourWageSettlementAdvanceAllocations.advanceRecordId,
      absorbedAmount: labourWageSettlementAdvanceAllocations.absorbedAmount,
    }).from(labourWageSettlementAdvanceAllocations).where(eq(labourWageSettlementAdvanceAllocations.workspaceId, scope.workspaceId)),
    tx.select({
      id: users.id,
      displayName: users.displayName,
      email: users.email,
    }).from(users).where(eq(users.workspaceId, scope.workspaceId)),
  ]);

  const labourById = new Map(labourRows.map((row) => {
    const payload = row.payload as Record<string, unknown>;
    const groupId = stringValue(payload.groupId);
    const groupName = stringValue(payload.group);
    return [row.id, {
      id: row.id,
      farmId: row.farmId,
      name: stringValue(payload.name) || "Labourer",
      groupId: groupId || null,
      groupName: groupName || null,
      active: payload.active !== false,
      deleted: isDeletedOperationalPayload(payload),
    }] as const;
  }));
  const groupById = new Map(groupRows.map((row) => {
    const payload = row.payload as Record<string, unknown>;
    return [row.id, {
      id: row.id,
      farmId: row.farmId,
      name: stringValue(payload.name) || "Labour Group",
      foremanLabourId: stringValue(payload.foremanLabourId || payload.foremanId) || null,
      active: payload.active !== false,
      deleted: isDeletedOperationalPayload(payload),
    }] as const;
  }));
  const userById = new Map(userRows.map((row) => [row.id, {
    name: row.displayName?.trim() || row.email,
  }] as const));

  const selectedGroup = labourGroupScope.groupId ? groupById.get(labourGroupScope.groupId) ?? null : null;
  const selectedGroupName = labourGroupScope.groupName ?? selectedGroup?.name ?? null;
  const candidateLabourerIds = new Set(
    labourFilterIds.filter(Boolean),
  );
  if (scope.settlementMode === "group" && scope.groupId) {
    for (const labourer of labourById.values()) {
      if (labourer.farmId !== scope.farmId) continue;
      if (labourer.groupId === scope.groupId || (selectedGroupName && labourer.groupName?.trim().toLowerCase() === selectedGroupName.trim().toLowerCase())) {
        candidateLabourerIds.add(labourer.id);
      }
    }
    if (scope.foremanId) candidateLabourerIds.add(scope.foremanId);
    if (selectedGroup?.foremanLabourId) candidateLabourerIds.add(selectedGroup.foremanLabourId);
  }
  if (scope.settlementMode !== "group" && scope.labourerId) candidateLabourerIds.add(scope.labourerId);

  const settlementById = new Map(settlementRows.map((row) => [row.clientRecordId, row]));
  const advanceByClientRecordId = new Map(advanceRows.map((row) => [row.clientRecordId, row] as const));
  const allocationByAdvanceId = new Map<string, number>();
  const allocationsBySettlementId = new Map<string, Array<{ advanceRecordId: string; absorbedAmount: number }>>();
  const ambiguousHistoricalSettlements: LabourAdvanceLedgerResult["ambiguousHistoricalSettlements"] = [];
  let legacyUnallocatedPreviouslyAbsorbedAdvances = 0;
  for (const allocation of allocationRows) {
    const currentSettlement = allocationsBySettlementId.get(allocation.settlementRecordId) ?? [];
    currentSettlement.push({
      advanceRecordId: allocation.advanceRecordId,
      absorbedAmount: numberValue(allocation.absorbedAmount),
    });
    allocationsBySettlementId.set(allocation.settlementRecordId, currentSettlement);
  }
  for (const settlement of settlementRows) {
    if (!settlementConsumesAdvanceBalance(settlement.payload as Record<string, unknown>) || settlement.payload.status === "deleted" || settlement.payload.status === "voided") continue;
    if (normalizeSettlementPayload(settlement.payload as Record<string, unknown>).settlementDate > scope.cutoffDate) continue;
    if (scope.settlementId && settlement.clientRecordId === scope.settlementId) continue;
    const settlementPayload = settlement.payload as Record<string, unknown> & SettlementPayload;
    const settlementScope = normalizeSettlementPayload(settlementPayload);
    const reportAllLabour = scope.settlementMode === "group"
      && !scope.groupId
      && !scope.foremanId
      && !scope.labourerId;
    const sameGroup = scope.settlementMode === "group"
      && settlementScope.settlementMode === "group"
      && stringValue(settlementScope.groupId) === stringValue(scope.groupId);
    const sameIndividual = scope.settlementMode !== "group" && settlementScope.settlementMode !== "group";
    if (!reportAllLabour && !sameGroup && !sameIndividual) continue;
    const settlementAllocations = allocationsBySettlementId.get(settlement.id) ?? [];
    if (settlementAllocations.length) {
      for (const allocation of settlementAllocations) {
        allocationByAdvanceId.set(
          allocation.advanceRecordId,
          (allocationByAdvanceId.get(allocation.advanceRecordId) ?? 0) + allocation.absorbedAmount,
        );
      }
      continue;
    }
    const fallbackConsumed = numberValue(settlementScope.settledAdvanceAmount ?? settlementScope.advanceAdjustedNow ?? settlementScope.appliedAdvances);
    if (fallbackConsumed <= 0) continue;
    const payloadAllocations = Array.isArray(settlementPayload.advanceAdjustmentAllocations)
      ? settlementPayload.advanceAdjustmentAllocations
        .flatMap((allocation) => {
          const advanceId = stringValue(allocation?.advanceId);
          const adjustedAmount = Math.max(0, numberValue(allocation?.adjustedAmount));
          if (!advanceId || adjustedAmount <= 0) return [];
          const advanceRow = advanceByClientRecordId.get(advanceId);
          if (!advanceRow) return [];
          if (!sameLegacyScope(advanceRow, scope)) return [];
          return [{
            advanceRecordId: advanceRow.id,
            absorbedAmount: adjustedAmount,
          }];
        })
        .filter((allocation) => allocation.absorbedAmount > 0)
      : [];
    const reconstructedAmount = settleConsumedAmountFromAllocations(payloadAllocations);
    for (const allocation of payloadAllocations) {
      allocationByAdvanceId.set(
        allocation.advanceRecordId,
        (allocationByAdvanceId.get(allocation.advanceRecordId) ?? 0) + allocation.absorbedAmount,
      );
    }
    const unresolvedAmount = Math.max(fallbackConsumed - reconstructedAmount, 0);
    if (unresolvedAmount > 0.005) {
      legacyUnallocatedPreviouslyAbsorbedAdvances += unresolvedAmount;
      ambiguousHistoricalSettlements.push({
        settlementRecordId: settlement.id,
        settlementId: settlement.clientRecordId,
        settlementNumber: stringValue((settlement.payload as Record<string, unknown>).settlementNumber) || null,
        settlementDate: settlementScope.settlementDate,
        unallocatedAbsorbedAmount: unresolvedAmount,
      });
    }
  }

  const advanceResults = advanceRows.map((row) => {
    const payload = row.payload as AdvancePayload;
    const date = advanceDate(payload);
    const amount = numberValue(payload.amount);
    const labourerId = stringValue(payload.labourerId) || stringValue(payload.labourId) || null;
    const labourer = labourerId ? labourById.get(labourerId) ?? null : null;
    const labourGroupId = stringValue(payload.labourGroupId) || labourer?.groupId || null;
    const labourGroupName = stringValue(payload.labourGroupName) || labourer?.groupName || null;
    const accountId = stringValue(payload.accountId) || null;
    const accountName = stringValue(payload.sourceAccountName) || null;
    const recordedById = row.workspaceId ? stringValue(payload.createdBy) || stringValue(payload.updatedBy) || null : null;
    const recordedByName = recordedById ? userById.get(recordedById)?.name ?? null : null;
    const voidedOrDeleted = isDeletedOperationalPayload(payload) || stringValue(payload.status).toLowerCase() === "voided" || stringValue(payload.status).toLowerCase() === "reversed" || Boolean(payload.voidedAt || payload.reversedAt);
    const scopeMatchesFarm = sameLegacyScope({ farmId: row.farmId, seasonId: row.seasonId }, scope);
    const scopeMatchesLabour = labourerId ? candidateLabourerIds.has(labourerId) : false;
    const scopeMatchesGroup = scope.settlementMode !== "group"
      ? true
      : labourGroupId === scope.groupId
        || (selectedGroupName && labourGroupName?.trim().toLowerCase() === selectedGroupName.trim().toLowerCase())
        || (labourerId ? candidateLabourerIds.has(labourerId) : false);
    const dateIncluded = Boolean(date) && date <= scope.cutoffDate;
    const excludedReason = (() => {
      if (voidedOrDeleted) return "Advance is voided or deleted.";
      if (!date) return "Advance date is missing.";
      if (!dateIncluded) return "Advance date is after the cutoff.";
      if (!scopeMatchesFarm) return "Advance is outside the selected farm and season scope.";
      if (!labourerId) return "Advance is missing a labourer reference.";
      if (!scopeMatchesLabour) return "Advance labourer is outside the selected labour scope.";
      if (!scopeMatchesGroup) return "Advance does not belong to the selected group scope.";
      return null;
    })();
    const originalAmount = amount;
    const previouslyAbsorbedAmount = allocationByAdvanceId.get(row.id) ?? 0;
    const remainingAvailableAmount = Math.max(originalAmount - previouslyAbsorbedAmount, 0);
    const includedInPreview = excludedReason === null;
    return {
      advanceId: row.clientRecordId,
      advanceRecordId: row.id,
      sourceAdvanceId: row.clientRecordId,
      date,
      amount,
      labourerId,
      labourerName: labourer?.name ?? null,
      labourGroupId,
      labourGroupName,
      farmId: row.farmId,
      seasonId: row.seasonId,
      workspaceId: row.workspaceId,
      accountId,
      accountName,
      recordedById,
      recordedByName,
      originalAmount,
      previouslyAbsorbedAmount,
      remainingAvailableAmount,
      includedInPreview,
      exclusionReason: excludedReason,
      sourceRecordType: String(payload.source ?? "advance"),
      voidedOrDeleted,
    } satisfies LabourAdvanceReconciliationRow;
  });

  const validRows = advanceResults.filter((row) =>
    row.includedInPreview
    && row.date
    && row.date <= scope.cutoffDate
    && sameLegacyScope({ farmId: row.farmId, seasonId: row.seasonId }, scope),
  );
  const totalValidAdvancesToCutoff = validRows.reduce((sum, row) => sum + row.originalAmount, 0);
  const previouslyAbsorbedAdvances = validRows.reduce((sum, row) => sum + row.previouslyAbsorbedAmount, 0) + legacyUnallocatedPreviouslyAbsorbedAdvances;
  const availableGroupAdvances = Math.max(totalValidAdvancesToCutoff - previouslyAbsorbedAdvances, 0);
  const includedAdvances = validRows.map((row) => ({
    advanceId: row.advanceId,
    advanceRecordId: row.advanceRecordId,
    outstandingAmount: row.remainingAvailableAmount,
    advanceDate: row.date,
  })).filter((row) => row.outstandingAmount > 0);

  return {
    rows: advanceResults.sort((left, right) => left.date.localeCompare(right.date) || left.advanceRecordId.localeCompare(right.advanceRecordId)),
    totals: {
      totalValidAdvancesToCutoff,
      previouslyAbsorbedAdvances,
      availableGroupAdvances,
      legacyUnallocatedPreviouslyAbsorbedAdvances,
      ambiguousHistoricalSettlementCount: ambiguousHistoricalSettlements.length,
    },
    includedAdvances,
    ambiguousHistoricalSettlements,
  };
}

export async function listAdvanceLedgerForReport(
  tx: DbClient,
  scope: LabourAdvanceLedgerScope,
  labourFilterIds: string[],
) {
  return resolveLabourAdvanceLedger(tx, scope, labourFilterIds, { groupId: scope.groupId ?? null, foremanId: scope.foremanId ?? null, groupName: null });
}
