import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { db } from "../db/client.js";
import { operationalRecords, userSessions } from "../db/schema.js";
import {
  buildWageRateReplacementMutations,
  calculateStatusWage,
  findWageRateOverlaps,
  listWageRateRows,
  normalizeLabourerId,
  normalizeWageRatePayload,
  previousDate,
  resolveApplicableWageRate,
  type WageRateType,
} from "../lib/wage-rates.js";
import { isDeletedOperationalPayload } from "../operational-record-state.js";
import { hasFarmAccess } from "../workspace-access.js";
import { hasModulePermission } from "../permissions.js";
import { validateTenantReferences } from "../tenant-ownership.js";

const paramsSchema = z.object({ workspaceId: z.string().uuid() });
const querySchema = z.object({
  farmId: z.string().uuid(),
  seasonId: z.string().uuid(),
  labourerId: z.string().optional(),
  includeInactive: z.coerce.boolean().optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  labourIds: z.string().optional(),
});

const wageRateRowSchema = z.object({
  id: z.string().optional(),
  labourerId: z.string().min(1),
  rateType: z.enum(["daily", "half_day", "monthly", "custom"]).optional(),
  dailyRate: z.coerce.number().nonnegative(),
  halfDayRate: z.coerce.number().nonnegative().optional(),
  notes: z.string().trim().max(500).optional(),
  active: z.boolean().optional(),
});

const bulkUpsertSchema = z.object({
  farmId: z.string().uuid(),
  seasonId: z.string().uuid(),
  effectiveFrom: z.string().date(),
  effectiveTo: z.string().date().nullable().optional(),
  rateType: z.enum(["daily", "half_day", "monthly", "custom"]).optional(),
  notes: z.string().trim().max(500).optional(),
  closePrevious: z.boolean().optional(),
  replaceExisting: z.boolean().optional(),
  changeReason: z.string().trim().max(500).optional(),
  rows: z.array(wageRateRowSchema).min(1),
});

const overlapValidationSchema = z.object({
  farmId: z.string().uuid(),
  seasonId: z.string().uuid(),
  effectiveFrom: z.string().date(),
  effectiveTo: z.string().date().nullable().optional(),
  replaceExisting: z.boolean().optional(),
  rows: z.array(wageRateRowSchema).min(1),
});

function viewForbidden() {
  return { message: "Workspace wage rate view permission is required." };
}

function editForbidden() {
  return { message: "Workspace wage rate edit permission is required." };
}

function isOverlapError(error: unknown) {
  return error instanceof Error
    && (error.message.includes("Wage rate overlap detected") || error.message.includes("must be adjusted manually"));
}

async function validateContext(
  sessionId: string | undefined,
  workspaceId: string,
  farmId: string,
  seasonId: string,
) {
  const [session] = await db.select({
    activeFarmId: userSessions.activeFarmId,
    activeSeasonId: userSessions.activeSeasonId,
  }).from(userSessions).where(eq(userSessions.id, sessionId ?? "")).limit(1);
  if (session?.activeFarmId !== farmId || session.activeSeasonId !== seasonId) return false;
  return true;
}

export async function wageRateRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/workspace/:workspaceId/wage-rates", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser || !request.sessionId) return reply.code(401).send({ message: "A valid session is required." });
    const params = paramsSchema.safeParse(request.params);
    const query = querySchema.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ message: "A valid wage-rate request is required." });
    const { workspaceId } = params.data;
    const { farmId, seasonId, labourerId, includeInactive } = query.data;
    if (request.appUser.workspaceId !== workspaceId) return reply.code(403).send({ message: "Select this workspace before loading wage rates." });
    if (!hasModulePermission(request.appUser, workspaceId, "wages", "view")) return reply.code(403).send(viewForbidden());
    if (!hasFarmAccess(request.appUser, workspaceId, farmId)) return reply.code(403).send({ message: "You do not have access to this farm." });
    if (!(await validateContext(request.sessionId, workspaceId, farmId, seasonId))) {
      return reply.code(403).send({ message: "Select this farm and season before viewing wage rates." });
    }
    const ownershipError = await validateTenantReferences(workspaceId, { farmId, seasonId, labourerId });
    if (ownershipError) return reply.code(403).send({ message: ownershipError });
    const rows = await db.transaction((tx) => listWageRateRows(tx, workspaceId, farmId, seasonId, labourerId));
    const rates = rows
      .filter((row) => includeInactive || (row.payload.active !== false && !isDeletedOperationalPayload(row.payload)))
      .map((row) => ({
        id: row.clientRecordId,
        workspaceId: row.workspaceId,
        farmId: row.farmId!,
        seasonId: row.seasonId!,
        ...row.payload,
        updatedAt: row.clientUpdatedAt.toISOString(),
      }));
    return { rates };
  });

  app.post("/v1/workspace/:workspaceId/wage-rates/validate-overlap", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser || !request.sessionId) return reply.code(401).send({ message: "A valid session is required." });
    const params = paramsSchema.safeParse(request.params);
    const parsed = overlapValidationSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ message: "A valid overlap validation request is required." });
    const { workspaceId } = params.data;
    if (request.appUser.workspaceId !== workspaceId) return reply.code(403).send({ message: "Select this workspace before validating wage rates." });
    if (!hasModulePermission(request.appUser, workspaceId, "wages", "create") && !hasModulePermission(request.appUser, workspaceId, "wages", "edit")) {
      return reply.code(403).send(editForbidden());
    }
    const { farmId, seasonId, effectiveFrom, effectiveTo, rows } = parsed.data;
    if (!hasFarmAccess(request.appUser, workspaceId, farmId)) return reply.code(403).send({ message: "You do not have access to this farm." });
    if (!(await validateContext(request.sessionId, workspaceId, farmId, seasonId))) {
      return reply.code(403).send({ message: "Select this farm and season before validating wage rates." });
    }
    const ownershipError = await validateTenantReferences(workspaceId, { farmId, seasonId });
    if (ownershipError) return reply.code(403).send({ message: ownershipError });
    const [labourRows, attendanceRows] = await Promise.all([
      db.select({
        id: operationalRecords.clientRecordId,
        payload: operationalRecords.payload,
      }).from(operationalRecords).where(and(
        eq(operationalRecords.workspaceId, workspaceId),
        eq(operationalRecords.farmId, farmId),
        eq(operationalRecords.entityType, "labourer"),
      )),
      db.select({
        payload: operationalRecords.payload,
      }).from(operationalRecords).where(and(
        eq(operationalRecords.workspaceId, workspaceId),
        eq(operationalRecords.farmId, farmId),
        eq(operationalRecords.seasonId, seasonId),
        eq(operationalRecords.entityType, "attendance"),
      )),
    ]);
    const labourNames = new Map(labourRows.map((row) => [row.id, String((row.payload as Record<string, unknown>).name ?? "Labourer")]));
    const attendanceCounts = new Map<string, number>();
    for (const row of attendanceRows) {
      const payload = row.payload as Record<string, unknown>;
      if (isDeletedOperationalPayload(payload)) continue;
      const labourerId = normalizeLabourerId(payload);
      const date = String(payload.date ?? "");
      const status = String(payload.status ?? "");
      if (!labourerId || !date || date < effectiveFrom || (effectiveTo && date > effectiveTo)) continue;
      if (!["present", "half_day", "absent"].includes(status)) continue;
      attendanceCounts.set(labourerId, (attendanceCounts.get(labourerId) ?? 0) + 1);
    }
    const overlaps = await db.transaction(async (tx) => {
      const result: Array<{
        labourerId: string;
        labourName?: string;
        affectedFrom: string;
        affectedTo?: string | null;
        affectedAttendanceCount: number;
        overlaps: Array<{ id: string; effectiveFrom: string; effectiveTo?: string | null; dailyRate: number; halfDayRate: number; notes?: string }>;
      }> = [];
      for (const row of rows) {
        const existing = await findWageRateOverlaps(tx, {
          workspaceId,
          farmId,
          seasonId,
          labourerId: row.labourerId,
          effectiveFrom,
          effectiveTo,
          excludeClientRecordId: row.id ?? null,
        });
        if (!existing.length) continue;
        result.push({
          labourerId: row.labourerId,
          labourName: labourNames.get(row.labourerId),
          affectedFrom: effectiveFrom,
          affectedTo: effectiveTo ?? null,
          affectedAttendanceCount: attendanceCounts.get(row.labourerId) ?? 0,
          overlaps: existing.map((item) => ({
            id: item.clientRecordId,
            effectiveFrom: item.payload.effectiveFrom,
            effectiveTo: item.payload.effectiveTo,
            dailyRate: item.payload.dailyRate,
            halfDayRate: item.payload.halfDayRate,
            notes: item.payload.notes,
          })),
        });
      }
      return result;
    });
    return { valid: overlaps.length === 0, overlaps };
  });

  app.post("/v1/workspace/:workspaceId/wage-rates/bulk", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser || !request.sessionId) return reply.code(401).send({ message: "A valid session is required." });
    const params = paramsSchema.safeParse(request.params);
    const parsed = bulkUpsertSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ message: "A valid wage-rate payload is required." });
    const { workspaceId } = params.data;
    if (request.appUser.workspaceId !== workspaceId) return reply.code(403).send({ message: "Select this workspace before saving wage rates." });
    if (!hasModulePermission(request.appUser, workspaceId, "wages", "create") && !hasModulePermission(request.appUser, workspaceId, "wages", "edit")) {
      return reply.code(403).send(editForbidden());
    }
    const { farmId, seasonId, effectiveFrom, effectiveTo, rateType, notes, closePrevious, replaceExisting, changeReason, rows } = parsed.data;
    if (!hasFarmAccess(request.appUser, workspaceId, farmId)) return reply.code(403).send({ message: "You do not have access to this farm." });
    if (!(await validateContext(request.sessionId, workspaceId, farmId, seasonId))) {
      return reply.code(403).send({ message: "Select this farm and season before saving wage rates." });
    }
    const ownershipError = await validateTenantReferences(workspaceId, { farmId, seasonId });
    if (ownershipError) return reply.code(403).send({ message: ownershipError });
    if (replaceExisting && !changeReason?.trim()) {
      return reply.code(400).send({ message: "Provide a reason before replacing an existing wage rate period." });
    }
    const timestamp = new Date();
    try {
      const savedRates = await db.transaction(async (tx) => {
        const saved: Array<Record<string, unknown>> = [];
        for (const row of rows) {
          const labourerId = row.labourerId;
          const labourOwnership = await validateTenantReferences(workspaceId, { farmId, seasonId, labourerId });
          if (labourOwnership) throw new Error(labourOwnership);
          const overlaps = await findWageRateOverlaps(tx, {
            workspaceId,
            farmId,
            seasonId,
            labourerId,
            effectiveFrom,
            effectiveTo,
            excludeClientRecordId: row.id ?? null,
          });
          if (overlaps.length) {
            if (!closePrevious && !replaceExisting) {
              throw new Error(`Wage rate overlap detected for labour ${labourerId}.`);
            }
            if (replaceExisting) {
              const replacementRateId = row.id ?? crypto.randomUUID();
              const mutations = buildWageRateReplacementMutations({
                overlaps,
                effectiveFrom,
                effectiveTo,
                actorUserId: request.appUser!.id,
                timestamp: timestamp.toISOString(),
                replacementRateId,
                reason: changeReason,
              });
              for (const mutation of mutations) {
                if (mutation.kind === "update") {
                  await tx.update(operationalRecords).set({
                    payload: mutation.payload,
                    clientUpdatedAt: timestamp,
                    updatedAt: timestamp,
                  }).where(eq(operationalRecords.id, mutation.rowId));
                  continue;
                }
                await tx.insert(operationalRecords).values({
                  workspaceId,
                  farmId,
                  seasonId,
                  clientRecordId: mutation.clientRecordId,
                  entityType: "wageRate",
                  payload: {
                    ...mutation.payload,
                    id: mutation.clientRecordId,
                    createdAt: mutation.payload.createdAt ?? timestamp.toISOString(),
                    updatedAt: timestamp.toISOString(),
                  },
                  recordedBy: request.appUser!.id,
                  clientUpdatedAt: timestamp,
                  updatedAt: timestamp,
                  createdAt: timestamp,
                });
              }
              row.id = replacementRateId;
            } else {
              for (const overlap of overlaps) {
                if (overlap.payload.effectiveFrom >= effectiveFrom) {
                  throw new Error(`Existing wage rate for labour ${labourerId} must be adjusted manually before this range can start.`);
                }
                const nextPayload = {
                  ...overlap.payload,
                  effectiveTo: previousDate(effectiveFrom),
                  updatedAt: timestamp.toISOString(),
                };
                await tx.update(operationalRecords).set({
                  payload: nextPayload,
                  clientUpdatedAt: timestamp,
                  updatedAt: timestamp,
                }).where(eq(operationalRecords.id, overlap.id));
              }
            }
          }
          const payload = normalizeWageRatePayload({
            id: row.id,
            labourerId,
            labourId: labourerId,
            rateType: row.rateType ?? rateType ?? "daily",
            dailyRate: row.dailyRate,
            halfDayRate: row.halfDayRate,
            effectiveFrom,
            effectiveTo,
            notes: row.notes ?? notes,
            active: row.active ?? true,
            changeReason,
            adjustedAt: changeReason ? timestamp.toISOString() : undefined,
            adjustedBy: changeReason ? request.appUser!.id : undefined,
            createdBy: request.appUser!.id,
            createdAt: timestamp.toISOString(),
            updatedAt: timestamp.toISOString(),
          });
          const clientRecordId = row.id ?? crypto.randomUUID();
          const [existing] = await tx.select({
            id: operationalRecords.id,
            payload: operationalRecords.payload,
          }).from(operationalRecords).where(and(
            eq(operationalRecords.workspaceId, workspaceId),
            eq(operationalRecords.entityType, "wageRate"),
            eq(operationalRecords.clientRecordId, clientRecordId),
          )).limit(1);
          if (existing) {
            await tx.update(operationalRecords).set({
              payload: {
                ...(existing.payload as Record<string, unknown>),
                ...payload,
              },
              clientUpdatedAt: timestamp,
              updatedAt: timestamp,
            }).where(eq(operationalRecords.id, existing.id));
          } else {
            await tx.insert(operationalRecords).values({
              workspaceId,
              farmId,
              seasonId,
              clientRecordId,
              entityType: "wageRate",
              payload: {
                ...payload,
                id: clientRecordId,
                createdAt: payload.createdAt ?? timestamp.toISOString(),
                updatedAt: timestamp.toISOString(),
              },
              recordedBy: request.appUser!.id,
              clientUpdatedAt: timestamp,
              updatedAt: timestamp,
              createdAt: timestamp,
            });
          }
          saved.push({
            id: clientRecordId,
            workspaceId,
            farmId,
            seasonId,
            ...payload,
            createdAt: payload.createdAt ?? timestamp.toISOString(),
            updatedAt: timestamp.toISOString(),
          });
        }
        return saved;
      });
      return { rates: savedRates };
    } catch (error) {
      if (isOverlapError(error)) {
        return reply.code(409).send({ message: (error as Error).message });
      }
      if (error instanceof Error) {
        return reply.code(400).send({ message: error.message });
      }
      throw error;
    }
  });

  app.get("/v1/workspace/:workspaceId/wage-rates/calculate", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser || !request.sessionId) return reply.code(401).send({ message: "A valid session is required." });
    const params = paramsSchema.safeParse(request.params);
    const query = querySchema.safeParse(request.query);
    if (!params.success || !query.success || !query.data.from || !query.data.to) {
      return reply.code(400).send({ message: "A valid wage calculation date range is required." });
    }
    const { workspaceId } = params.data;
    const { farmId, seasonId, from, to, labourIds } = query.data;
    if (request.appUser.workspaceId !== workspaceId) return reply.code(403).send({ message: "Select this workspace before calculating wages." });
    if (!hasModulePermission(request.appUser, workspaceId, "wages", "view") && !hasModulePermission(request.appUser, workspaceId, "reports", "view")) {
      return reply.code(403).send(viewForbidden());
    }
    if (!hasFarmAccess(request.appUser, workspaceId, farmId)) return reply.code(403).send({ message: "You do not have access to this farm." });
    if (!(await validateContext(request.sessionId, workspaceId, farmId, seasonId))) {
      return reply.code(403).send({ message: "Select this farm and season before calculating wages." });
    }
    const ownershipError = await validateTenantReferences(workspaceId, { farmId, seasonId });
    if (ownershipError) return reply.code(403).send({ message: ownershipError });
    const selectedLabourIds = new Set((labourIds ?? "").split(",").map((item) => item.trim()).filter(Boolean));
    const [attendanceRows, labourRows, wageRates] = await Promise.all([
      db.select({
        id: operationalRecords.clientRecordId,
        payload: operationalRecords.payload,
      }).from(operationalRecords).where(and(
        eq(operationalRecords.workspaceId, workspaceId),
        eq(operationalRecords.farmId, farmId),
        eq(operationalRecords.seasonId, seasonId),
        eq(operationalRecords.entityType, "attendance"),
      )),
      db.select({
        id: operationalRecords.clientRecordId,
        payload: operationalRecords.payload,
      }).from(operationalRecords).where(and(
        eq(operationalRecords.workspaceId, workspaceId),
        eq(operationalRecords.farmId, farmId),
        eq(operationalRecords.entityType, "labourer"),
      )),
      db.transaction((tx) => listWageRateRows(tx, workspaceId, farmId, seasonId)),
    ]);
    const labourById = new Map(labourRows.map((row) => [row.id, String((row.payload as Record<string, unknown>).name ?? "Labourer")]));
    const results = new Map<string, {
      labourerId: string;
      labourName: string;
      presentDays: number;
      halfDays: number;
      absentDays: number;
      payableDays: number;
      totalWage: number;
      missingRateDates: string[];
    }>();
    const unresolved: Array<{ labourerId: string; labourName: string; date: string; status: "present" | "half_day" | "absent" }> = [];
    for (const row of attendanceRows) {
      const payload = row.payload as Record<string, unknown>;
      if (isDeletedOperationalPayload(payload)) continue;
      const labourerId = normalizeLabourerId(payload);
      const date = String(payload.date ?? "");
      const status = String(payload.status ?? "") as "present" | "half_day" | "absent";
      if (!labourerId || !date || date < from || date > to || !["present", "half_day", "absent"].includes(status)) continue;
      if (selectedLabourIds.size > 0 && !selectedLabourIds.has(labourerId)) continue;
      const labourName = labourById.get(labourerId) ?? "Labourer";
      const summary = results.get(labourerId) ?? {
        labourerId,
        labourName,
        presentDays: 0,
        halfDays: 0,
        absentDays: 0,
        payableDays: 0,
        totalWage: 0,
        missingRateDates: [],
      };
      if (status === "present") {
        summary.presentDays += 1;
        summary.payableDays += 1;
      } else if (status === "half_day") {
        summary.halfDays += 1;
        summary.payableDays += 0.5;
      } else {
        summary.absentDays += 1;
      }
      const rate = resolveApplicableWageRate(wageRates, labourerId, date);
      if (!rate && status !== "absent") {
        summary.missingRateDates.push(date);
        unresolved.push({ labourerId, labourName, date, status });
      }
      summary.totalWage += calculateStatusWage(status, rate?.payload ?? null);
      results.set(labourerId, summary);
    }
    return { rows: [...results.values()], unresolved };
  });
}
