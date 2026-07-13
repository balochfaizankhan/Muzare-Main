import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { db } from "../db/client.js";
import { advanceRecords, auditLogs, attendanceEntries, operationalRecords, userSessions } from "../db/schema.js";
import { hasModulePermission } from "../permissions.js";
import { isDeletedOperationalPayload } from "../operational-record-state.js";
import { requireFarmAccess } from "../workspace-access.js";

const paramsSchema = z.object({ workspaceId: z.string().uuid(), labourId: z.string().min(1) });
const deleteSchema = z.object({ confirmation: z.enum(["DELETE", "DEACTIVATE"]), endDate: z.string().date().optional() });

async function selectedFarm(sessionId?: string) {
  if (!sessionId) return null;
  const [session] = await db.select({ activeFarmId: userSessions.activeFarmId }).from(userSessions)
    .where(eq(userSessions.id, sessionId)).limit(1);
  return session?.activeFarmId ?? null;
}

async function scopedLabour(workspaceId: string, labourId: string, farmId: string) {
  const [record] = await db.select().from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId, workspaceId),
    eq(operationalRecords.farmId, farmId),
    eq(operationalRecords.entityType, "labourer"),
    eq(operationalRecords.clientRecordId, labourId),
  )).limit(1);
  return record ?? null;
}

function referencesLabour(payload: Record<string, unknown>, labourId: string) {
  const directValues = [
    payload.labourerId,
    payload.labourId,
    payload.workerId,
    payload.attendanceLabourId,
    payload.paymentLabourId,
    payload.settlementLabourId,
    payload.targetLabourId,
  ];
  if (directValues.some((value) => typeof value === "string" && value === labourId)) return true;
  if (typeof payload.labourerId === "string" && payload.labourerId === labourId) return true;
  if (typeof payload.labourId === "string" && payload.labourId === labourId) return true;
  if (Array.isArray(payload.includedLabourIds) && payload.includedLabourIds.some((value) => value === labourId)) return true;
  if (Array.isArray(payload.includedLabourRows) && payload.includedLabourRows.some((row) => {
    if (!row || typeof row !== "object") return false;
    const entry = row as Record<string, unknown>;
    return entry.labourerId === labourId || entry.labourId === labourId;
  })) return true;
  return false;
}

async function protectedLabourCounts(database: Pick<typeof db, "select">, workspaceId: string, labourId: string, farmId: string) {
  const [typedAttendanceRows, typedAdvanceRows, operationalDependencyRows] = await Promise.all([
    database.select({ id: attendanceEntries.id }).from(attendanceEntries).where(and(
      eq(attendanceEntries.farmId, farmId),
      eq(attendanceEntries.labourerId, labourId),
    )),
    database.select({ id: advanceRecords.id }).from(advanceRecords).where(and(
      eq(advanceRecords.farmId, farmId),
      eq(advanceRecords.labourerId, labourId),
    )),
    database.select({
      entityType: operationalRecords.entityType,
      payload: operationalRecords.payload,
    }).from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, workspaceId),
      eq(operationalRecords.farmId, farmId),
      inArray(operationalRecords.entityType, ["attendance", "advance"]),
    )),
  ]);
  const operationalAttendanceCount = operationalDependencyRows.filter((record) =>
    record.entityType === "attendance"
    && !isDeletedOperationalPayload(record.payload)
    && referencesLabour(record.payload, labourId)).length;
  const operationalAdvanceCount = operationalDependencyRows.filter((record) =>
    record.entityType === "advance"
    && !isDeletedOperationalPayload(record.payload)
    && referencesLabour(record.payload, labourId)).length;
  // A deployment may contain legacy typed rows or current operational rows.
  // Prefer current records when present to avoid double-counting dual-written imports.
  const attendanceCount = operationalAttendanceCount || typedAttendanceRows.length;
  const advanceCount = operationalAdvanceCount || typedAdvanceRows.length;
  const paymentRows = await database.select({
    entityType: operationalRecords.entityType,
    payload: operationalRecords.payload,
  }).from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId, workspaceId),
    eq(operationalRecords.farmId, farmId),
    inArray(operationalRecords.entityType, ["labourPayment", "labourWageSettlement"]),
  ));
  const paymentCount = paymentRows.filter((record) => !isDeletedOperationalPayload(record.payload) && referencesLabour(record.payload, labourId)).length;
  return {
    attendanceCount,
    advanceCount,
    paymentCount,
    protectedRecordCount: attendanceCount + advanceCount + paymentCount,
  };
}

async function lifecycleContext(request: FastifyRequest, workspaceId: string) {
  if (!request.appUser || request.appUser.workspaceId !== workspaceId) return null;
  const farmId = await selectedFarm(request.sessionId);
  if (!farmId || !requireFarmAccess(request.appUser, workspaceId, farmId)) return null;
  if (!hasModulePermission(request.appUser, workspaceId, "workforce", "delete")) return null;
  return { user: request.appUser, farmId };
}

export async function labourManagementRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/workspaces/:workspaceId/labour/:labourId/deletion-preview", { preHandler: requireUser }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ message: "A valid labour record is required." });
    const context = await lifecycleContext(request, params.data.workspaceId);
    if (!context) return reply.code(403).send({ message: "Workspace team management permission and an active farm are required." });
    const labour = await scopedLabour(params.data.workspaceId, params.data.labourId, context.farmId);
    if (!labour) return reply.code(404).send({ message: "Labour record was not found in the active workspace farm." });
    const counts = await protectedLabourCounts(db, params.data.workspaceId, params.data.labourId, context.farmId);
    return {
      labourId: labour.clientRecordId,
      labourName: String(labour.payload.name ?? "Labourer"),
      ...counts,
      action: counts.protectedRecordCount ? "deactivate" : "delete",
    };
  });

  app.delete("/api/workspaces/:workspaceId/labour/:labourId", { preHandler: requireUser }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const body = deleteSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ message: "Type DELETE or DEACTIVATE to confirm this labour action." });
    const context = await lifecycleContext(request, params.data.workspaceId);
    if (!context) return reply.code(403).send({ message: "Workspace team management permission and an active farm are required." });
    const labour = await scopedLabour(params.data.workspaceId, params.data.labourId, context.farmId);
    if (!labour) return reply.code(404).send({ message: "Labour record was not found in the active workspace farm." });
    const result = await db.transaction(async (tx) => {
      const txCounts = await protectedLabourCounts(tx, params.data.workspaceId, params.data.labourId, context.farmId);
      if (!txCounts.protectedRecordCount) {
        if (body.data.confirmation !== "DELETE") {
          reply.code(400).send({ message: "Type DELETE to confirm this labour action." });
          return null;
        }
        const dependentGroups = await tx.select({ id: operationalRecords.id, clientRecordId: operationalRecords.clientRecordId, payload: operationalRecords.payload }).from(operationalRecords).where(and(
          eq(operationalRecords.workspaceId, params.data.workspaceId),
          eq(operationalRecords.farmId, context.farmId),
          eq(operationalRecords.entityType, "labourGroup"),
        ));
        for (const group of dependentGroups) {
          const payload = group.payload as Record<string, unknown>;
          if (payload.foremanId !== labour.clientRecordId && payload.foremanLabourId !== labour.clientRecordId) continue;
          const nextPayload = {
            ...payload,
            foremanId: null,
            foremanLabourId: null,
            updatedAt: new Date().toISOString(),
          };
          await tx.update(operationalRecords).set({ payload: nextPayload, clientUpdatedAt: new Date(), updatedAt: new Date() }).where(eq(operationalRecords.id, group.id));
        }
        await tx.delete(operationalRecords).where(eq(operationalRecords.id, labour.id));
        await tx.insert(auditLogs).values({
          workspaceId: params.data.workspaceId, farmId: context.farmId, userId: context.user.id,
          action: "labour_deleted", entityType: "labourer", entityId: labour.id,
          details: { clientRecordId: labour.clientRecordId, labourName: labour.payload.name, ...txCounts },
        });
        return { action: "deleted", ...txCounts };
      }
      if (body.data.confirmation !== "DEACTIVATE") {
        reply.code(400).send({ message: "Type DEACTIVATE to confirm this labour action." });
        return null;
      }
      if (!body.data.endDate) {
        reply.code(400).send({ message: "End date is required to deactivate labour." });
        return null;
      }
      const timestamp = new Date();
      const endDate = body.data.endDate;
      const payload = { ...labour.payload, active: false, endedOn: endDate, updatedAt: timestamp.toISOString() };
      await tx.update(operationalRecords).set({ payload, clientUpdatedAt: timestamp, updatedAt: timestamp }).where(eq(operationalRecords.id, labour.id));
      await tx.insert(auditLogs).values({
        workspaceId: params.data.workspaceId, farmId: context.farmId, userId: context.user.id,
        action: "labour_deactivated", entityType: "labourer", entityId: labour.id,
        details: { clientRecordId: labour.clientRecordId, labourName: labour.payload.name, ...txCounts, endDate },
      });
      return { action: "deactivated", ...txCounts, record: { ...payload, id: labour.clientRecordId } };
    });
    if (!result) return;
    return result;
  });
}
