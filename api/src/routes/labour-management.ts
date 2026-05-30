import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { db } from "../db/client.js";
import { auditLogs, operationalRecords, userSessions } from "../db/schema.js";
import { hasPermission } from "../permissions.js";

const paramsSchema = z.object({ workspaceId: z.string().uuid(), labourId: z.string().min(1) });
const deleteSchema = z.object({ confirmation: z.literal("DELETE"), endDate: z.string().date().optional() });

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

async function linkedRecords(workspaceId: string, labourId: string, farmId: string) {
  const records = await db.select({ payload: operationalRecords.payload }).from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId, workspaceId),
    eq(operationalRecords.farmId, farmId),
    ne(operationalRecords.entityType, "labourer"),
  ));
  return records.filter((record) => record.payload.labourerId === labourId).length;
}

async function lifecycleContext(request: FastifyRequest, workspaceId: string) {
  if (!request.appUser || request.appUser.workspaceId !== workspaceId || !hasPermission(request.appUser, "MANAGE_TEAM", workspaceId)) return null;
  const farmId = await selectedFarm(request.sessionId);
  return farmId ? { user: request.appUser, farmId } : null;
}

export async function labourManagementRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/workspaces/:workspaceId/labour/:labourId/deletion-preview", { preHandler: requireUser }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ message: "A valid labour record is required." });
    const context = await lifecycleContext(request, params.data.workspaceId);
    if (!context) return reply.code(403).send({ message: "Workspace team management permission and an active farm are required." });
    const labour = await scopedLabour(params.data.workspaceId, params.data.labourId, context.farmId);
    if (!labour) return reply.code(404).send({ message: "Labour record was not found in the active workspace farm." });
    const linkedRecordCount = await linkedRecords(params.data.workspaceId, params.data.labourId, context.farmId);
    return { labourId: labour.clientRecordId, labourName: String(labour.payload.name ?? "Labourer"), linkedRecordCount, action: linkedRecordCount ? "deactivate" : "delete" };
  });

  app.delete("/api/workspaces/:workspaceId/labour/:labourId", { preHandler: requireUser }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const body = deleteSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ message: "Type DELETE to confirm this labour action." });
    const context = await lifecycleContext(request, params.data.workspaceId);
    if (!context) return reply.code(403).send({ message: "Workspace team management permission and an active farm are required." });
    const labour = await scopedLabour(params.data.workspaceId, params.data.labourId, context.farmId);
    if (!labour) return reply.code(404).send({ message: "Labour record was not found in the active workspace farm." });
    const linkedRecordCount = await linkedRecords(params.data.workspaceId, params.data.labourId, context.farmId);
    if (!linkedRecordCount) {
      await db.transaction(async (tx) => {
        await tx.delete(operationalRecords).where(eq(operationalRecords.id, labour.id));
        await tx.insert(auditLogs).values({
          workspaceId: params.data.workspaceId, farmId: context.farmId, userId: context.user.id,
          action: "labour_deleted", entityType: "labourer", entityId: labour.id,
          details: { clientRecordId: labour.clientRecordId, labourName: labour.payload.name },
        });
      });
      return { action: "deleted", linkedRecordCount };
    }
    const timestamp = new Date();
    const endDate = body.data.endDate ?? timestamp.toISOString().slice(0, 10);
    const payload = { ...labour.payload, active: false, endedOn: endDate, updatedAt: timestamp.toISOString() };
    await db.transaction(async (tx) => {
      await tx.update(operationalRecords).set({ payload, clientUpdatedAt: timestamp, updatedAt: timestamp }).where(eq(operationalRecords.id, labour.id));
      await tx.insert(auditLogs).values({
        workspaceId: params.data.workspaceId, farmId: context.farmId, userId: context.user.id,
        action: "labour_deactivated", entityType: "labourer", entityId: labour.id,
        details: { clientRecordId: labour.clientRecordId, labourName: labour.payload.name, linkedRecordCount, endDate },
      });
    });
    return { action: "deactivated", linkedRecordCount, record: { ...payload, id: labour.clientRecordId } };
  });
}
