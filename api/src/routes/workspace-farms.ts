import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { localDevelopmentMode } from "../config.js";
import { db } from "../db/client.js";
import { auditLogs, farmDeletionRequests, farms, operationalRecords, seasons, userSessions } from "../db/schema.js";
import { visibleFarmWhere } from "../farm-visibility.js";
import { hasPermission } from "../permissions.js";
import { repairWorkspaceContext, resolveWorkspaceContext } from "./workspace-context.js";

const workspaceParams = z.object({ workspaceId: z.string().uuid() });
const farmParams = workspaceParams.extend({ farmId: z.string().uuid() });
const deleteRequestInput = z.object({ reason: z.string().trim().max(800).optional() });
const farmInput = z.object({
  name: z.string().trim().min(2).max(120),
  location: z.string().trim().max(240).optional().nullable(),
  owner: z.string().trim().max(120).optional().nullable(),
  remarks: z.string().trim().max(1000).optional().nullable(),
  contactName: z.string().trim().max(120).optional().nullable(),
  contactEmail: z.string().trim().email().optional().nullable().or(z.literal("")),
  contactPhone: z.string().trim().max(40).optional().nullable(),
});

function optional(value: string | null | undefined) {
  return value?.trim() || null;
}
function visibleFarm(farm: typeof farms.$inferSelect) {
  const { sourceType: _sourceType, oldAndroidId: _oldAndroidId, importBatchId: _importBatchId, ...visible } = farm;
  void _sourceType;
  void _oldAndroidId;
  void _importBatchId;
  return {
    ...visible,
    remarks: farm.remarks?.startsWith("source_type:") || farm.remarks?.startsWith("old_android_id:") ? null : farm.remarks,
  };
}

function historyFarm(farm: typeof farms.$inferSelect) {
  return {
    ...visibleFarm(farm),
    active: farm.active,
    deletedAt: farm.deletedAt,
  };
}

function requireSelectedWorkspace(request: FastifyRequest, workspaceId: string) {
  return request.appUser?.workspaceId === workspaceId
    && request.appUser.memberships.some((membership) => membership.active && membership.workspaceId === workspaceId);
}

function canManage(request: FastifyRequest, workspaceId: string) {
  return Boolean(request.appUser && hasPermission(request.appUser, "MANAGE_FARMS", workspaceId));
}
function isWorkspaceOwner(request: FastifyRequest, workspaceId: string) {
  return request.appUser?.memberships.some((membership) => membership.workspaceId === workspaceId && membership.active && membership.role === "workspace_owner") === true;
}

async function farmRecordCounts(workspaceId: string, farmId: string) {
  const records = await db.execute(sql`
    SELECT entity_type, count(*)::int AS count
    FROM operational_records
    WHERE workspace_id = ${workspaceId} AND farm_id = ${farmId}
    GROUP BY entity_type
  `);
  const counts = {
    labour: 0,
    attendance: 0,
    advances: 0,
    expenses: 0,
    sales: 0,
    dispatch: 0,
    accounts: 0,
    partners: 0,
    importedRecords: 0,
    operationalRecords: 0,
    seasons: 0,
  };
  for (const row of records.rows) {
    const entity = String(row.entity_type);
    const count = Number(row.count ?? 0);
    counts.operationalRecords += count;
    if (entity === "labourer" || entity === "labourGroup") counts.labour += count;
    else if (entity === "attendance") counts.attendance += count;
    else if (entity === "advance" || entity === "labourPayment") counts.advances += count;
    else if (entity === "voucher") counts.expenses += count;
    else if (entity === "sale") counts.sales += count;
    else if (entity === "dispatch") counts.dispatch += count;
    else if (entity === "account") counts.accounts += count;
    else if (entity === "partnerEntry") counts.partners += count;
  }
  const [seasonCount] = await db.select({ count: sql<number>`count(*)::int` }).from(seasons).where(and(eq(seasons.workspaceId, workspaceId), eq(seasons.farmId, farmId)));
  counts.seasons = Number(seasonCount?.count ?? 0);
  counts.importedRecords = counts.operationalRecords;
  return counts;
}
function totalFarmRecords(counts: Record<string, number>) {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

export async function workspaceFarmRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/workspace/:workspaceId/farms", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser) return reply;
    const parsed = workspaceParams.safeParse(request.params);
    if (!parsed.success || !requireSelectedWorkspace(request, parsed.data.workspaceId)) {
      return reply.code(403).send({ message: "Select this workspace before viewing farms." });
    }
    if (localDevelopmentMode) return { farms: [], activeFarmId: null };
    const activeRecords = await db.select().from(farms).where(await visibleFarmWhere(parsed.data.workspaceId)).orderBy(farms.name);
    const historyRecords = await db.select().from(farms).where(and(
      eq(farms.workspaceId, parsed.data.workspaceId),
      sql`(${farms.deletedAt} IS NOT NULL OR ${farms.active} = false)`,
    )).orderBy(sql`${farms.deletedAt} DESC NULLS LAST`, farms.name);
    const context = await resolveWorkspaceContext(parsed.data.workspaceId, request.sessionId);
    const pendingRequests = await db.select({
      farmId: farmDeletionRequests.farmId,
      status: farmDeletionRequests.status,
    }).from(farmDeletionRequests).where(and(
      eq(farmDeletionRequests.workspaceId, parsed.data.workspaceId),
      eq(farmDeletionRequests.status, "pending"),
    ));
    const pendingByFarm = new Map(pendingRequests.map((request) => [request.farmId, request.status]));
    return {
      farms: activeRecords.map((farm) => ({ ...visibleFarm(farm), deletionRequestStatus: pendingByFarm.get(farm.id) ?? null })),
      historyFarms: historyRecords.map((farm) => ({ ...historyFarm(farm), deletionRequestStatus: pendingByFarm.get(farm.id) ?? null })),
      activeFarmId: context.activeFarmId,
      needsRepair: context.needsRepair,
      contextWarning: context.contextWarning,
    };
  });

  app.post("/v1/workspace/:workspaceId/repair-context", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser) return reply;
    const parsed = workspaceParams.safeParse(request.params);
    if (!parsed.success || !requireSelectedWorkspace(request, parsed.data.workspaceId)) {
      return reply.code(403).send({ message: "Select this workspace before repairing context." });
    }
    if (!canManage(request, parsed.data.workspaceId) && !hasPermission(request.appUser, "MANAGE_SEASONS", parsed.data.workspaceId) && !hasPermission(request.appUser, "MANAGE_RECORDS", parsed.data.workspaceId)) {
      return reply.code(403).send({ message: "Workspace management permission is required to repair workspace context." });
    }
    if (localDevelopmentMode) return reply.code(503).send({ message: "Configure PostgreSQL to repair workspace context." });
    const result = await repairWorkspaceContext(parsed.data.workspaceId, request.appUser.id, request.sessionId);
    return result;
  });

  app.post("/v1/workspace/:workspaceId/farms", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser) return reply;
    const params = workspaceParams.safeParse(request.params);
    const input = farmInput.safeParse(request.body);
    if (!params.success || !input.success) return reply.code(400).send({ message: "Valid farm details are required." });
    if (!requireSelectedWorkspace(request, params.data.workspaceId) || !canManage(request, params.data.workspaceId)) {
      return reply.code(403).send({ message: "Workspace farm management permission is required." });
    }
    if (localDevelopmentMode) return reply.code(503).send({ message: "Configure PostgreSQL to manage farms." });
    const [farm] = await db.insert(farms).values({
      workspaceId: params.data.workspaceId,
      name: input.data.name,
      location: optional(input.data.location),
      owner: optional(input.data.owner),
      remarks: optional(input.data.remarks),
      contactName: optional(input.data.contactName),
      contactEmail: optional(input.data.contactEmail),
      contactPhone: optional(input.data.contactPhone),
      createdBy: request.appUser.id,
    }).returning();
    if (request.sessionId && farm) {
      const [session] = await db.select({ activeFarmId: userSessions.activeFarmId }).from(userSessions).where(eq(userSessions.id, request.sessionId)).limit(1);
      if (!session?.activeFarmId) await db.update(userSessions).set({ activeFarmId: farm.id, activeSeasonId: null }).where(eq(userSessions.id, request.sessionId));
    }
    return reply.code(201).send({ farm });
  });

  app.patch("/v1/workspace/:workspaceId/farms/:farmId", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser) return reply;
    const params = farmParams.safeParse(request.params);
    const input = farmInput.safeParse(request.body);
    if (!params.success || !input.success) return reply.code(400).send({ message: "Valid farm details are required." });
    if (!requireSelectedWorkspace(request, params.data.workspaceId) || !canManage(request, params.data.workspaceId)) {
      return reply.code(403).send({ message: "Workspace farm management permission is required." });
    }
    if (localDevelopmentMode) return reply.code(503).send({ message: "Configure PostgreSQL to manage farms." });
    const [farm] = await db.update(farms).set({
      name: input.data.name,
      location: optional(input.data.location),
      owner: optional(input.data.owner),
      remarks: optional(input.data.remarks),
      contactName: optional(input.data.contactName),
      contactEmail: optional(input.data.contactEmail),
      contactPhone: optional(input.data.contactPhone),
      updatedAt: new Date(),
    }).where(and(eq(farms.id, params.data.farmId), eq(farms.workspaceId, params.data.workspaceId), isNull(farms.deletedAt))).returning();
    if (!farm) return reply.code(404).send({ message: "Farm not found." });
    return { farm };
  });

  app.post("/v1/workspace/:workspaceId/farms/:farmId/archive", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser) return reply;
    const params = farmParams.safeParse(request.params);
    if (!params.success || !requireSelectedWorkspace(request, params.data.workspaceId) || !canManage(request, params.data.workspaceId)) {
      return reply.code(403).send({ message: "Workspace farm management permission is required." });
    }
    if (localDevelopmentMode) return reply.code(503).send({ message: "Configure PostgreSQL to manage farms." });
    const [farm] = await db.update(farms).set({ active: false, updatedAt: new Date() })
      .where(and(eq(farms.id, params.data.farmId), eq(farms.workspaceId, params.data.workspaceId), isNull(farms.deletedAt))).returning({ id: farms.id });
    if (!farm) return reply.code(404).send({ message: "Farm not found." });
    await db.update(userSessions).set({ activeFarmId: null, activeSeasonId: null })
      .where(and(eq(userSessions.workspaceId, params.data.workspaceId), eq(userSessions.activeFarmId, params.data.farmId)));
    return reply.code(204).send();
  });

  app.delete("/v1/workspace/:workspaceId/farms/:farmId", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser) return reply;
    const params = farmParams.safeParse(request.params);
    if (!params.success || !requireSelectedWorkspace(request, params.data.workspaceId) || !canManage(request, params.data.workspaceId)) {
      return reply.code(403).send({ message: "Workspace farm management permission is required." });
    }
    if (localDevelopmentMode) return reply.code(503).send({ message: "Configure PostgreSQL to manage farms." });
    const [farm] = await db.select({ id: farms.id }).from(farms).where(and(eq(farms.id, params.data.farmId), eq(farms.workspaceId, params.data.workspaceId), isNull(farms.deletedAt))).limit(1);
    if (!farm) return reply.code(404).send({ message: "Farm not found." });
    const counts = await farmRecordCounts(params.data.workspaceId, params.data.farmId);
    if (totalFarmRecords(counts) > 0) {
      return reply.code(409).send({ message: "This farm has records. Deletion requires system admin approval." });
    }
    await db.delete(farms).where(and(eq(farms.id, params.data.farmId), eq(farms.workspaceId, params.data.workspaceId)));
    await db.update(userSessions).set({ activeFarmId: null, activeSeasonId: null })
      .where(and(eq(userSessions.workspaceId, params.data.workspaceId), eq(userSessions.activeFarmId, params.data.farmId)));
    return reply.code(204).send();
  });

  app.post("/v1/workspace/:workspaceId/farms/:farmId/delete-request", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser) return reply;
    const params = farmParams.safeParse(request.params);
    const body = deleteRequestInput.safeParse(request.body ?? {});
    if (!params.success || !body.success || !requireSelectedWorkspace(request, params.data.workspaceId) || !isWorkspaceOwner(request, params.data.workspaceId)) {
      return reply.code(403).send({ message: "Only the workspace owner can request farm deletion." });
    }
    if (localDevelopmentMode) return reply.code(202).send();
    const [farm] = await db.select().from(farms).where(and(eq(farms.id, params.data.farmId), eq(farms.workspaceId, params.data.workspaceId), isNull(farms.deletedAt))).limit(1);
    if (!farm) return reply.code(404).send({ message: "Farm not found." });
    const counts = await farmRecordCounts(params.data.workspaceId, params.data.farmId);
    if (totalFarmRecords(counts) === 0) return reply.code(409).send({ message: "This farm is empty and can be deleted directly." });
    const [existing] = await db.select().from(farmDeletionRequests).where(and(
      eq(farmDeletionRequests.workspaceId, params.data.workspaceId),
      eq(farmDeletionRequests.farmId, params.data.farmId),
      eq(farmDeletionRequests.status, "pending"),
    )).limit(1);
    if (existing) return { request: existing };
    const [created] = await db.transaction(async (tx) => {
      const [requestRow] = await tx.insert(farmDeletionRequests).values({
        workspaceId: params.data.workspaceId,
        farmId: params.data.farmId,
        requestedBy: request.appUser!.id,
        reason: body.data.reason ?? null,
        recordCountsJson: counts,
      }).returning();
      await tx.update(farms).set({ active: false, updatedAt: new Date() }).where(and(eq(farms.id, params.data.farmId), eq(farms.workspaceId, params.data.workspaceId)));
      await tx.insert(auditLogs).values({
        workspaceId: params.data.workspaceId,
        farmId: params.data.farmId,
        userId: request.appUser!.id,
        actorUserId: request.appUser!.id,
        action: "farm.delete.requested",
        entityType: "farm",
        entityId: params.data.farmId,
        beforeJson: farm,
        afterJson: { status: "delete_pending", recordCounts: counts },
        notes: body.data.reason ?? null,
        details: { recordCounts: counts },
      });
      return [requestRow];
    });
    return reply.code(202).send({ request: created });
  });

  app.post("/v1/workspace/:workspaceId/farms/:farmId/select", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser || !request.sessionId) return reply.code(401).send({ message: "A database-backed session is required." });
    const params = farmParams.safeParse(request.params);
    if (!params.success || !requireSelectedWorkspace(request, params.data.workspaceId)) {
      return reply.code(403).send({ message: "Select this workspace before selecting a farm." });
    }
    const [farm] = await db.select({ id: farms.id }).from(farms)
      .where(await visibleFarmWhere(params.data.workspaceId, { farmId: params.data.farmId })).limit(1);
    if (!farm) return reply.code(404).send({ message: "Active farm not found." });
    await db.update(userSessions).set({ activeFarmId: farm.id, activeSeasonId: null }).where(eq(userSessions.id, request.sessionId));
    return reply.code(204).send();
  });

  app.post("/v1/workspace/:workspaceId/farms/:farmId/restore", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser) return reply;
    const params = farmParams.safeParse(request.params);
    if (!params.success || !requireSelectedWorkspace(request, params.data.workspaceId) || !canManage(request, params.data.workspaceId)) {
      return reply.code(403).send({ message: "Workspace farm management permission is required." });
    }
    if (localDevelopmentMode) return reply.code(503).send({ message: "Configure PostgreSQL to manage farms." });

    const [farm] = await db.update(farms).set({
      active: true,
      deletedAt: null,
      deletedBy: null,
      updatedAt: new Date(),
    }).where(and(eq(farms.id, params.data.farmId), eq(farms.workspaceId, params.data.workspaceId))).returning();
    if (!farm) return reply.code(404).send({ message: "Farm not found." });

    if (request.sessionId) {
      const [session] = await db.select({ activeFarmId: userSessions.activeFarmId }).from(userSessions).where(eq(userSessions.id, request.sessionId)).limit(1);
      if (!session?.activeFarmId) {
        await db.update(userSessions).set({ activeFarmId: farm.id, activeSeasonId: null }).where(eq(userSessions.id, request.sessionId));
      }
    }
    return { farm: visibleFarm(farm) };
  });
}
