import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { db } from "../db/client.js";
import { operationalRecords } from "../db/schema.js";
import { isDeletedOperationalPayload } from "../operational-record-state.js";

export type WageRateType = "daily" | "half_day" | "monthly" | "custom";

export type WageRatePayload = {
  labourerId: string;
  labourId?: string;
  rateType: WageRateType;
  dailyRate: number;
  halfDayRate: number;
  effectiveFrom: string;
  effectiveTo?: string | null;
  notes?: string;
  active: boolean;
  changeReason?: string;
  adjustedAt?: string;
  adjustedBy?: string;
  supersededAt?: string | null;
  supersededBy?: string | null;
  supersededByRateId?: string | null;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
};

export type WageRateRow = {
  id: string;
  clientRecordId: string;
  workspaceId: string;
  farmId: string | null;
  seasonId: string | null;
  payload: WageRatePayload;
  clientUpdatedAt: Date;
};

type DbClient = Parameters<typeof db.transaction>[0] extends (tx: infer T) => Promise<unknown> ? T : never;

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function numericValue(value: unknown) {
  return typeof value === "number" ? value : Number(value ?? 0);
}

export function normalizeLabourerId(payload: Record<string, unknown>) {
  return cleanText(payload.labourerId) || cleanText(payload.labourId);
}

export function normalizeWageRatePayload(payload: Record<string, unknown>): WageRatePayload {
  const dailyRate = numericValue(payload.dailyRate);
  const halfDayRate = payload.halfDayRate == null || payload.halfDayRate === ""
    ? dailyRate / 2
    : numericValue(payload.halfDayRate);
  return {
    labourerId: normalizeLabourerId(payload),
    labourId: cleanText(payload.labourId) || undefined,
    rateType: (cleanText(payload.rateType) || "daily") as WageRateType,
    dailyRate,
    halfDayRate,
    effectiveFrom: cleanText(payload.effectiveFrom),
    effectiveTo: cleanText(payload.effectiveTo) || null,
    notes: cleanText(payload.notes) || undefined,
    active: payload.active !== false,
    changeReason: cleanText(payload.changeReason) || undefined,
    adjustedAt: cleanText(payload.adjustedAt) || undefined,
    adjustedBy: cleanText(payload.adjustedBy) || undefined,
    supersededAt: cleanText(payload.supersededAt) || null,
    supersededBy: cleanText(payload.supersededBy) || null,
    supersededByRateId: cleanText(payload.supersededByRateId) || null,
    createdBy: cleanText(payload.createdBy) || undefined,
    createdAt: cleanText(payload.createdAt) || undefined,
    updatedAt: cleanText(payload.updatedAt) || undefined,
    deletedAt: cleanText(payload.deletedAt) || null,
  };
}

export function rangesOverlap(
  leftFrom: string,
  leftTo: string | null | undefined,
  rightFrom: string,
  rightTo: string | null | undefined,
) {
  const leftEnd = leftTo && leftTo.length ? leftTo : "9999-12-31";
  const rightEnd = rightTo && rightTo.length ? rightTo : "9999-12-31";
  return leftFrom <= rightEnd && rightFrom <= leftEnd;
}

export function previousDate(date: string) {
  const cursor = new Date(`${date}T00:00:00Z`);
  cursor.setUTCDate(cursor.getUTCDate() - 1);
  return cursor.toISOString().slice(0, 10);
}

export function nextDate(date: string) {
  const cursor = new Date(`${date}T00:00:00Z`);
  cursor.setUTCDate(cursor.getUTCDate() + 1);
  return cursor.toISOString().slice(0, 10);
}

export async function listWageRateRows(
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
    eq(operationalRecords.entityType, "wageRate"),
    labourerId ? sql`coalesce(${operationalRecords.payload}->>'labourerId', ${operationalRecords.payload}->>'labourId', '') = ${labourerId}` : undefined,
  )).orderBy(
    asc(sql`coalesce(${operationalRecords.payload}->>'effectiveFrom', '')`),
    asc(operationalRecords.clientUpdatedAt),
  );
  return rows
    .map((row) => ({
      ...row,
      payload: normalizeWageRatePayload(row.payload as Record<string, unknown>),
    }))
    .filter((row) => row.payload.labourerId);
}

export async function findWageRateOverlaps(
  tx: DbClient,
  args: {
    workspaceId: string;
    farmId: string;
    seasonId: string;
    labourerId: string;
    effectiveFrom: string;
    effectiveTo?: string | null;
    excludeClientRecordId?: string | null;
  },
) {
  const rows = await listWageRateRows(tx, args.workspaceId, args.farmId, args.seasonId, args.labourerId);
  return rows.filter((row) =>
    row.payload.active !== false
    && !isDeletedOperationalPayload(row.payload as Record<string, unknown>)
    && row.clientRecordId !== (args.excludeClientRecordId ?? "")
    && rangesOverlap(row.payload.effectiveFrom, row.payload.effectiveTo, args.effectiveFrom, args.effectiveTo));
}

export function resolveApplicableWageRate(
  rows: Array<Pick<WageRateRow, "clientRecordId" | "payload" | "clientUpdatedAt">>,
  labourerId: string,
  date: string,
) {
  return rows
    .filter((row) =>
      row.payload.active !== false
      && !isDeletedOperationalPayload(row.payload as Record<string, unknown>)
      && row.payload.labourerId === labourerId
      && row.payload.effectiveFrom <= date
      && (!row.payload.effectiveTo || row.payload.effectiveTo >= date))
    .sort((left, right) =>
      right.payload.effectiveFrom.localeCompare(left.payload.effectiveFrom)
      || right.clientUpdatedAt.getTime() - left.clientUpdatedAt.getTime())[0] ?? null;
}

export function calculateStatusWage(
  status: "present" | "half_day" | "absent",
  rate: Pick<WageRatePayload, "dailyRate" | "halfDayRate"> | null,
) {
  if (!rate) return 0;
  if (status === "present") return rate.dailyRate;
  if (status === "half_day") return rate.halfDayRate;
  return 0;
}

export type WageRateReplacementMutation =
  | {
    kind: "update";
    rowId: string;
    clientRecordId: string;
    payload: WageRatePayload;
  }
  | {
    kind: "insert";
    clientRecordId: string;
    payload: WageRatePayload;
  };

function withAdjustmentAudit(
  payload: WageRatePayload,
  actorUserId: string,
  timestamp: string,
  reason: string | undefined,
  supersededByRateId: string,
) {
  return {
    ...payload,
    changeReason: reason || payload.changeReason,
    adjustedAt: timestamp,
    adjustedBy: actorUserId,
    supersededAt: timestamp,
    supersededBy: actorUserId,
    supersededByRateId,
    updatedAt: timestamp,
  } satisfies WageRatePayload;
}

export function buildWageRateReplacementMutations(args: {
  overlaps: WageRateRow[];
  effectiveFrom: string;
  effectiveTo?: string | null;
  actorUserId: string;
  timestamp: string;
  replacementRateId: string;
  reason?: string;
}) {
  const mutations: WageRateReplacementMutation[] = [];
  const replacementEnd = args.effectiveTo && args.effectiveTo.length ? args.effectiveTo : null;
  const replacementEndCursor = replacementEnd ?? "9999-12-31";

  for (const overlap of args.overlaps) {
    const existingFrom = overlap.payload.effectiveFrom;
    const existingEnd = overlap.payload.effectiveTo && overlap.payload.effectiveTo.length ? overlap.payload.effectiveTo : null;
    const existingEndCursor = existingEnd ?? "9999-12-31";

    if (existingFrom < args.effectiveFrom && existingEndCursor > replacementEndCursor && replacementEnd) {
      mutations.push({
        kind: "update",
        rowId: overlap.id,
        clientRecordId: overlap.clientRecordId,
        payload: withAdjustmentAudit({
          ...overlap.payload,
          effectiveTo: previousDate(args.effectiveFrom),
        }, args.actorUserId, args.timestamp, args.reason, args.replacementRateId),
      });
      mutations.push({
        kind: "insert",
        clientRecordId: crypto.randomUUID(),
        payload: {
          ...withAdjustmentAudit(overlap.payload, args.actorUserId, args.timestamp, args.reason, args.replacementRateId),
          effectiveFrom: nextDate(replacementEnd),
          effectiveTo: existingEnd,
          deletedAt: null,
          active: overlap.payload.active !== false,
          createdAt: args.timestamp,
        },
      });
      continue;
    }

    if (existingFrom < args.effectiveFrom && existingEndCursor >= args.effectiveFrom) {
      mutations.push({
        kind: "update",
        rowId: overlap.id,
        clientRecordId: overlap.clientRecordId,
        payload: withAdjustmentAudit({
          ...overlap.payload,
          effectiveTo: previousDate(args.effectiveFrom),
        }, args.actorUserId, args.timestamp, args.reason, args.replacementRateId),
      });
      continue;
    }

    if (replacementEnd && existingFrom <= replacementEnd && existingEndCursor > replacementEndCursor) {
      mutations.push({
        kind: "update",
        rowId: overlap.id,
        clientRecordId: overlap.clientRecordId,
        payload: withAdjustmentAudit({
          ...overlap.payload,
          effectiveFrom: nextDate(replacementEnd),
        }, args.actorUserId, args.timestamp, args.reason, args.replacementRateId),
      });
      continue;
    }

    mutations.push({
      kind: "update",
      rowId: overlap.id,
      clientRecordId: overlap.clientRecordId,
      payload: withAdjustmentAudit({
        ...overlap.payload,
        active: false,
        deletedAt: args.timestamp,
      }, args.actorUserId, args.timestamp, args.reason, args.replacementRateId),
    });
  }

  return mutations;
}
