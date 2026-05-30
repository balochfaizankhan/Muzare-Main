import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { localDevelopmentMode } from "../config.js";
import { db } from "../db/client.js";
import { farms, userSessions } from "../db/schema.js";
import { hasPermission } from "../permissions.js";

const workspaceParams = z.object({ workspaceId: z.string().uuid() });
const farmParams = workspaceParams.extend({ farmId: z.string().uuid() });
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

function requireSelectedWorkspace(request: FastifyRequest, workspaceId: string) {
  return request.appUser?.workspaceId === workspaceId
    && request.appUser.memberships.some((membership) => membership.active && membership.workspaceId === workspaceId);
}

function canManage(request: FastifyRequest, workspaceId: string) {
  return Boolean(request.appUser && hasPermission(request.appUser, "MANAGE_FARMS", workspaceId));
}

export async function workspaceFarmRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/workspace/:workspaceId/farms", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser) return reply;
    const parsed = workspaceParams.safeParse(request.params);
    if (!parsed.success || !requireSelectedWorkspace(request, parsed.data.workspaceId)) {
      return reply.code(403).send({ message: "Select this workspace before viewing farms." });
    }
    if (localDevelopmentMode) return { farms: [], activeFarmId: null };
    const records = await db.select().from(farms).where(eq(farms.workspaceId, parsed.data.workspaceId)).orderBy(farms.name);
    const [session] = request.sessionId
      ? await db.select({ activeFarmId: userSessions.activeFarmId }).from(userSessions).where(eq(userSessions.id, request.sessionId)).limit(1)
      : [];
    return { farms: records, activeFarmId: session?.activeFarmId ?? null };
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
    }).where(and(eq(farms.id, params.data.farmId), eq(farms.workspaceId, params.data.workspaceId))).returning();
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
      .where(and(eq(farms.id, params.data.farmId), eq(farms.workspaceId, params.data.workspaceId))).returning({ id: farms.id });
    if (!farm) return reply.code(404).send({ message: "Farm not found." });
    await db.update(userSessions).set({ activeFarmId: null, activeSeasonId: null })
      .where(and(eq(userSessions.workspaceId, params.data.workspaceId), eq(userSessions.activeFarmId, params.data.farmId)));
    return reply.code(204).send();
  });

  app.post("/v1/workspace/:workspaceId/farms/:farmId/select", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser || !request.sessionId) return reply.code(401).send({ message: "A database-backed session is required." });
    const params = farmParams.safeParse(request.params);
    if (!params.success || !requireSelectedWorkspace(request, params.data.workspaceId)) {
      return reply.code(403).send({ message: "Select this workspace before selecting a farm." });
    }
    const [farm] = await db.select({ id: farms.id }).from(farms)
      .where(and(eq(farms.id, params.data.farmId), eq(farms.workspaceId, params.data.workspaceId), eq(farms.active, true))).limit(1);
    if (!farm) return reply.code(404).send({ message: "Active farm not found." });
    await db.update(userSessions).set({ activeFarmId: farm.id, activeSeasonId: null }).where(eq(userSessions.id, request.sessionId));
    return reply.code(204).send();
  });
}
