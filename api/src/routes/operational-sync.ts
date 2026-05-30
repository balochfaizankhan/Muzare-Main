import type { FastifyInstance } from "fastify";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { requireUser, type AuthenticatedUser } from "../auth.js";
import { localDevelopmentMode } from "../config.js";
import { db } from "../db/client.js";
import { auditLogs, operationalRecords, userSessions } from "../db/schema.js";
import { hasPermission } from "../permissions.js";
import { validateTenantReferences } from "../tenant-ownership.js";

const entities = ["labourer", "attendance", "account", "advance", "dispatch", "sale", "voucher", "partnerEntry", "inventoryEntry"] as const;
const recordSchema = z.object({
  workspaceId: z.string().uuid(),
  farmId: z.string().uuid().nullable().optional(),
  seasonId: z.string().uuid().nullable().optional(),
  entity: z.enum(entities),
  record: z.object({
    id: z.string().min(1),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  }).passthrough(),
});
const localRecords = new Map<string, z.infer<typeof recordSchema>>();

function requireWorkspaceWrite(user: AuthenticatedUser, workspaceId: string) {
  return hasPermission(user, "SUBMIT_RECORDS", workspaceId);
}

function requireEntityWrite(user: AuthenticatedUser, workspaceId: string, entity: typeof entities[number]) {
  return !["labourer", "account"].includes(entity) || hasPermission(user, "MANAGE_RECORDS", workspaceId);
}

const seasonRequiredEntities = new Set<typeof entities[number]>(["attendance", "advance", "dispatch", "sale", "voucher", "partnerEntry", "inventoryEntry"]);

async function sessionContext(sessionId?: string) {
  if (!sessionId) return null;
  const [session] = await db.select({ activeFarmId: userSessions.activeFarmId, activeSeasonId: userSessions.activeSeasonId })
    .from(userSessions).where(eq(userSessions.id, sessionId)).limit(1);
  return session ?? null;
}

export async function operationalSyncRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/workspace/:workspaceId/operational-records", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser) return reply;
    const parsed = z.object({ workspaceId: z.string().uuid() }).safeParse(request.params);
    if (!parsed.success || request.appUser.workspaceId !== parsed.data.workspaceId
      || !request.appUser.memberships.some((item) => item.active && item.workspaceId === parsed.data.workspaceId)) {
      return reply.code(403).send({ message: "Workspace membership is required." });
    }
    if (localDevelopmentMode) return { records: [...localRecords.values()].filter((item) => item.workspaceId === parsed.data.workspaceId) };
    const selected = await sessionContext(request.sessionId);
    if (!selected?.activeFarmId) return { records: [] };
    const records = await db.select().from(operationalRecords)
      .where(and(
        eq(operationalRecords.workspaceId, parsed.data.workspaceId),
        eq(operationalRecords.farmId, selected.activeFarmId),
        selected.activeSeasonId
          ? or(eq(operationalRecords.seasonId, selected.activeSeasonId), isNull(operationalRecords.seasonId))
          : isNull(operationalRecords.seasonId),
      ))
      .orderBy(desc(operationalRecords.updatedAt));
    return {
      records: records.map((item) => ({
        workspaceId: item.workspaceId, farmId: item.farmId, seasonId: item.seasonId, entity: item.entityType,
        record: { ...item.payload, id: item.clientRecordId, updatedAt: item.clientUpdatedAt.toISOString() },
      })),
    };
  });

  app.post("/v1/workspace/operational-records", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser) return reply;
    const parsed = recordSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "A valid operational record is required." });
    if (!requireWorkspaceWrite(request.appUser, parsed.data.workspaceId)) {
      return reply.code(403).send({ message: "Workspace record submission permission is required." });
    }
    if (!requireEntityWrite(request.appUser, parsed.data.workspaceId, parsed.data.entity)) {
      return reply.code(403).send({ message: "Workspace record management permission is required." });
    }
    if (request.appUser.workspaceId !== parsed.data.workspaceId) {
      return reply.code(403).send({ message: "Select this workspace before submitting records." });
    }
    if (localDevelopmentMode) {
      localRecords.set(`${parsed.data.workspaceId}:${parsed.data.entity}:${parsed.data.record.id}`, parsed.data);
      return { record: parsed.data.record, conflict: false };
    }
    const selected = await sessionContext(request.sessionId);
    const generalFarmExpense = parsed.data.entity === "voucher" && parsed.data.record.generalFarmExpense === true;
    const requiresSeason = seasonRequiredEntities.has(parsed.data.entity) && !generalFarmExpense;
    if (!selected?.activeFarmId || parsed.data.farmId !== selected.activeFarmId) {
      return reply.code(403).send({ message: "Select the active farm before submitting records." });
    }
    if (requiresSeason && (!selected.activeSeasonId || parsed.data.seasonId !== selected.activeSeasonId)) {
      return reply.code(403).send({ message: "Select an active season before submitting operational records." });
    }
    if (generalFarmExpense && parsed.data.seasonId) {
      return reply.code(400).send({ message: "General farm expenses must not specify a season." });
    }
    const ownershipError = await validateTenantReferences(parsed.data.workspaceId, {
      farmId: parsed.data.farmId,
      seasonId: parsed.data.seasonId,
      accountId: parsed.data.record.accountId,
      ledgerId: parsed.data.record.ledgerId,
    });
    if (ownershipError) return reply.code(403).send({ message: ownershipError });
    const [existing] = await db.select().from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, parsed.data.workspaceId),
      eq(operationalRecords.entityType, parsed.data.entity),
      eq(operationalRecords.clientRecordId, parsed.data.record.id),
    )).limit(1);
    const clientUpdatedAt = new Date(parsed.data.record.updatedAt);
    if (existing && existing.clientUpdatedAt > clientUpdatedAt) {
      await db.insert(auditLogs).values({
        workspaceId: parsed.data.workspaceId, userId: request.appUser.id, farmId: parsed.data.farmId,
        action: "sync_conflict_database_won", entityType: parsed.data.entity, entityId: existing.id,
        details: { clientRecordId: parsed.data.record.id, localUpdatedAt: parsed.data.record.updatedAt, databaseUpdatedAt: existing.clientUpdatedAt.toISOString() },
      });
      return { record: { ...existing.payload, id: existing.clientRecordId, updatedAt: existing.clientUpdatedAt.toISOString() }, conflict: true };
    }
    if (existing && existing.clientUpdatedAt.getTime() !== clientUpdatedAt.getTime()) {
      await db.insert(auditLogs).values({
        workspaceId: parsed.data.workspaceId, userId: request.appUser.id, farmId: parsed.data.farmId,
        action: "sync_conflict_newest_client_won", entityType: parsed.data.entity, entityId: existing.id,
        details: { clientRecordId: parsed.data.record.id, clientUpdatedAt: parsed.data.record.updatedAt, databaseUpdatedAt: existing.clientUpdatedAt.toISOString() },
      });
    }
    const values = {
      workspaceId: parsed.data.workspaceId, farmId: parsed.data.farmId, seasonId: parsed.data.seasonId,
      clientRecordId: parsed.data.record.id, entityType: parsed.data.entity, payload: parsed.data.record,
      recordedBy: request.appUser.id, clientUpdatedAt, updatedAt: new Date(),
    };
    const [saved] = existing
      ? await db.update(operationalRecords).set(values).where(eq(operationalRecords.id, existing.id)).returning()
      : await db.insert(operationalRecords).values(values).returning();
    return { record: { ...saved!.payload, id: saved!.clientRecordId, updatedAt: saved!.clientUpdatedAt.toISOString() }, conflict: false };
  });
}
