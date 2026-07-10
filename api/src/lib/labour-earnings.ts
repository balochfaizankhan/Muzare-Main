import { and, eq } from "drizzle-orm";
import type { db } from "../db/client.js";
import { operationalRecords } from "../db/schema.js";
import { isDeletedOperationalPayload } from "../operational-record-state.js";

type DbClient = Parameters<typeof db.transaction>[0] extends (tx: infer T) => Promise<unknown> ? T : never;

export type LabourEarningPayload = {
  earningScope: "individual" | "group";
  labourerId: string | null;
  labourGroupId: string | null;
  labourGroupName: string | null;
  foremanId: string | null;
  earningDate: string;
  amount: number;
  earningType: "lump_sum" | "task" | "bonus" | "incentive" | "adjustment" | "other";
  description: string;
  notes?: string;
  status: "pending_settlement" | "settled" | "voided";
  linkedSettlementId?: string | null;
  linkedVoucherId?: string | null;
  settlementDate?: string | null;
  createdBy?: string;
  updatedBy?: string;
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
};

export type LabourEarningSettlementFilter = {
  settlementMode?: "individual" | "group";
  labourerId?: string | null;
  groupId?: string | null;
  foremanId?: string | null;
  labourIds?: string[];
  settlementDate?: string;
};

export type LabourEarningRow = {
  id: string;
  clientRecordId: string;
  workspaceId: string;
  farmId: string | null;
  seasonId: string | null;
  payload: LabourEarningPayload;
  clientUpdatedAt: Date;
};

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function amount(value: unknown) {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function scope(value: unknown, payload: Record<string, unknown>) {
  const explicit = text(value).toLowerCase();
  if (explicit === "group" || explicit === "individual") return explicit as LabourEarningPayload["earningScope"];
  if (text(payload.labourGroupId)) return "group";
  return "individual";
}

export function normalizeLabourEarningPayload(payload: Record<string, unknown>): LabourEarningPayload {
  const earningScope = scope(payload.earningScope, payload);
  const labourerId = text(payload.labourerId) || null;
  const labourGroupId = text(payload.labourGroupId) || null;
  const labourGroupName = text(payload.labourGroupName) || null;
  const foremanId = text(payload.foremanId) || null;
  return {
    earningScope,
    labourerId: earningScope === "group" ? null : labourerId || text(payload.labourId) || null,
    labourGroupId: earningScope === "group" ? labourGroupId : labourGroupId || (earningScope === "individual" ? null : labourGroupId),
    labourGroupName: labourGroupName || null,
    foremanId: earningScope === "group" ? foremanId || null : foremanId || null,
    earningDate: text(payload.earningDate) || text(payload.date),
    amount: amount(payload.amount),
    earningType: (text(payload.earningType) || "other") as LabourEarningPayload["earningType"],
    description: text(payload.description),
    notes: text(payload.notes) || undefined,
    status: (text(payload.status) || "pending_settlement") as LabourEarningPayload["status"],
    linkedSettlementId: text(payload.linkedSettlementId) || null,
    linkedVoucherId: text(payload.linkedVoucherId) || null,
    settlementDate: text(payload.settlementDate) || null,
    createdBy: text(payload.createdBy) || undefined,
    updatedBy: text(payload.updatedBy) || undefined,
    createdAt: text(payload.createdAt) || undefined,
    updatedAt: text(payload.updatedAt) || undefined,
    deletedAt: text(payload.deletedAt) || null,
  };
}

export function isPendingLabourEarningPayload(payload: LabourEarningPayload | Record<string, unknown>) {
  return !isDeletedOperationalPayload(payload)
    && normalizeLabourEarningPayload(payload as Record<string, unknown>).status === "pending_settlement";
}

export function labourEarningMatchesSettlementScope(
  payload: LabourEarningPayload | Record<string, unknown>,
  filter: LabourEarningSettlementFilter,
) {
  const normalized = normalizeLabourEarningPayload(payload as Record<string, unknown>);
  if (normalized.earningScope === "group") {
    if (filter.settlementMode !== "group") return false;
    if (filter.groupId) return normalized.labourGroupId === filter.groupId;
    if (filter.foremanId) return normalized.foremanId === filter.foremanId;
    return false;
  }
  if (filter.settlementMode === "group") {
    if (!normalized.labourerId) return false;
    return filter.labourIds?.length ? filter.labourIds.includes(normalized.labourerId) : true;
  }
  if (filter.settlementMode === "individual") {
    if (!filter.labourerId) return false;
    return normalized.labourerId === filter.labourerId;
  }
  return true;
}

export function labourEarningEligibleForSettlement(
  payload: LabourEarningPayload | Record<string, unknown>,
  filter: LabourEarningSettlementFilter,
) {
  const normalized = normalizeLabourEarningPayload(payload as Record<string, unknown>);
  if (!isPendingLabourEarningPayload(normalized)) return false;
  if (filter.settlementDate && normalized.earningDate > filter.settlementDate) return false;
  return labourEarningMatchesSettlementScope(normalized, filter);
}

export async function listLabourEarnings(
  tx: DbClient,
  workspaceId: string,
  farmId: string,
  seasonId: string,
  filter: LabourEarningSettlementFilter = {},
) {
  const rows = await tx.select({
    id: operationalRecords.id,
    clientRecordId: operationalRecords.clientRecordId,
    workspaceId: operationalRecords.workspaceId,
    farmId: operationalRecords.farmId,
    seasonId: operationalRecords.seasonId,
    payload: operationalRecords.payload,
    clientUpdatedAt: operationalRecords.clientUpdatedAt,
  }).from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId, workspaceId),
    eq(operationalRecords.farmId, farmId),
    eq(operationalRecords.seasonId, seasonId),
    eq(operationalRecords.entityType, "labourEarning"),
  ));
  return rows
    .map((row) => ({
      ...row,
      payload: normalizeLabourEarningPayload(row.payload as Record<string, unknown>),
    }))
    .filter((row) => labourEarningMatchesSettlementScope(row.payload, filter));
}
