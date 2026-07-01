import { and, eq } from "drizzle-orm";
import type { db } from "../db/client.js";
import { operationalRecords } from "../db/schema.js";
import { isDeletedOperationalPayload } from "../operational-record-state.js";

type DbClient = Parameters<typeof db.transaction>[0] extends (tx: infer T) => Promise<unknown> ? T : never;

export type LabourEarningPayload = {
  labourerId: string;
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

export function normalizeLabourEarningPayload(payload: Record<string, unknown>): LabourEarningPayload {
  return {
    labourerId: text(payload.labourerId) || text(payload.labourId),
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

export async function listLabourEarnings(
  tx: DbClient,
  workspaceId: string,
  farmId: string,
  seasonId: string,
  labourerId?: string,
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
    .filter((row) => !labourerId || row.payload.labourerId === labourerId);
}
