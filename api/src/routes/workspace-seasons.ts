import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { localDevelopmentMode } from "../config.js";
import { db } from "../db/client.js";
import { farms, seasons, userSessions } from "../db/schema.js";
import { visibleFarmWhere } from "../farm-visibility.js";
import { hasPermission } from "../permissions.js";

const paramsSchema = z.object({ workspaceId: z.string().uuid(), farmId: z.string().uuid() });
const seasonParamsSchema = paramsSchema.extend({ seasonId: z.string().uuid() });
const seasonInput = z.object({
  name: z.string().trim().min(2).max(120),
  cropType: z.string().trim().max(120).optional().nullable(),
  startsOn: z.string().date(),
  expectedEndsOn: z.string().date().optional().nullable().or(z.literal("")),
  actualEndsOn: z.string().date().optional().nullable().or(z.literal("")),
  status: z.enum(["planned", "active", "closed", "archived"]),
  notes: z.string().trim().max(1000).optional().nullable(),
});

const optional = (value: string | null | undefined) => value?.trim() || null;
const year = (date: string) => Number(date.slice(0, 4));

function selectedContext(request: FastifyRequest, workspaceId: string, farmId: string) {
  return request.appUser?.workspaceId === workspaceId
    && request.appUser.memberships.some((membership) => membership.active && membership.workspaceId === workspaceId)
    && request.sessionId;
}

function canManage(request: FastifyRequest, workspaceId: string) {
  return Boolean(request.appUser && hasPermission(request.appUser, "MANAGE_SEASONS", workspaceId));
}

async function activeFarm(sessionId: string, workspaceId: string, farmId: string) {
  const [farm] = await db.select({ id: farms.id }).from(farms)
    .innerJoin(userSessions, and(eq(userSessions.id, sessionId), eq(userSessions.activeFarmId, farms.id)))
    .where(await visibleFarmWhere(workspaceId, { farmId })).limit(1);
  return farm;
}

async function activateSeason(sessionId: string, workspaceId: string, farmId: string, seasonId: string) {
  return db.transaction(async (tx) => {
    const [season] = await tx.select({ id: seasons.id }).from(seasons)
      .where(and(
        eq(seasons.id, seasonId), eq(seasons.workspaceId, workspaceId), eq(seasons.farmId, farmId),
        ne(seasons.status, "archived"),
      )).limit(1);
    if (!season) return null;
    await tx.update(seasons).set({ status: "planned", active: false, updatedAt: new Date() })
      .where(and(eq(seasons.farmId, farmId), eq(seasons.status, "active"), ne(seasons.id, seasonId)));
    await tx.update(seasons).set({ status: "active", active: true, closed: false, actualEndsOn: null, updatedAt: new Date() })
      .where(eq(seasons.id, seasonId));
    await tx.update(userSessions).set({ activeSeasonId: seasonId }).where(eq(userSessions.id, sessionId));
    return season;
  });
}

export async function workspaceSeasonRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/workspace/:workspaceId/farms/:farmId/seasons", { preHandler: requireUser }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!request.appUser || !params.success || !selectedContext(request, params.data.workspaceId, params.data.farmId)) {
      return reply.code(403).send({ message: "Select this workspace and farm before viewing seasons." });
    }
    if (localDevelopmentMode) return { seasons: [], activeSeasonId: null };
    if (!(await activeFarm(request.sessionId!, params.data.workspaceId, params.data.farmId))) {
      return reply.code(403).send({ message: "Select this farm before viewing seasons." });
    }
    const records = await db.select().from(seasons)
      .where(and(eq(seasons.workspaceId, params.data.workspaceId), eq(seasons.farmId, params.data.farmId)))
      .orderBy(seasons.startsOn);
    const [session] = await db.select({ activeSeasonId: userSessions.activeSeasonId }).from(userSessions)
      .where(eq(userSessions.id, request.sessionId!)).limit(1);
    return { seasons: records, activeSeasonId: session?.activeSeasonId ?? null };
  });

  app.post("/v1/workspace/:workspaceId/farms/:farmId/seasons", { preHandler: requireUser }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const input = seasonInput.safeParse(request.body);
    if (!request.appUser || !params.success || !input.success) return reply.code(400).send({ message: "Valid crop-cycle details are required." });
    if (!selectedContext(request, params.data.workspaceId, params.data.farmId) || !canManage(request, params.data.workspaceId)
      || !(await activeFarm(request.sessionId!, params.data.workspaceId, params.data.farmId))) {
      return reply.code(403).send({ message: "Workspace season management permission is required for the selected farm." });
    }
    const [season] = await db.insert(seasons).values({
      workspaceId: params.data.workspaceId, farmId: params.data.farmId, name: input.data.name,
      cropType: optional(input.data.cropType), year: year(input.data.startsOn), startsOn: input.data.startsOn,
      expectedEndsOn: optional(input.data.expectedEndsOn), actualEndsOn: optional(input.data.actualEndsOn),
      status: input.data.status === "active" ? "planned" : input.data.status, notes: optional(input.data.notes),
      active: false, closed: input.data.status === "closed" || input.data.status === "archived", createdBy: request.appUser.id,
    }).returning();
    if (season && input.data.status === "active") await activateSeason(request.sessionId!, params.data.workspaceId, params.data.farmId, season.id);
    return reply.code(201).send({ season: season && input.data.status === "active" ? { ...season, status: "active", active: true } : season });
  });

  app.patch("/v1/workspace/:workspaceId/farms/:farmId/seasons/:seasonId", { preHandler: requireUser }, async (request, reply) => {
    const params = seasonParamsSchema.safeParse(request.params);
    const input = seasonInput.safeParse(request.body);
    if (!request.appUser || !params.success || !input.success) return reply.code(400).send({ message: "Valid crop-cycle details are required." });
    if (!selectedContext(request, params.data.workspaceId, params.data.farmId) || !canManage(request, params.data.workspaceId)
      || !(await activeFarm(request.sessionId!, params.data.workspaceId, params.data.farmId))) {
      return reply.code(403).send({ message: "Workspace season management permission is required for the selected farm." });
    }
    const status = input.data.status === "active" ? "planned" : input.data.status;
    const [season] = await db.update(seasons).set({
      name: input.data.name, cropType: optional(input.data.cropType), year: year(input.data.startsOn), startsOn: input.data.startsOn,
      expectedEndsOn: optional(input.data.expectedEndsOn), actualEndsOn: optional(input.data.actualEndsOn), status,
      notes: optional(input.data.notes), active: false, closed: status === "closed" || status === "archived", updatedAt: new Date(),
    }).where(and(eq(seasons.id, params.data.seasonId), eq(seasons.workspaceId, params.data.workspaceId), eq(seasons.farmId, params.data.farmId))).returning();
    if (!season) return reply.code(404).send({ message: "Season not found." });
    if (input.data.status === "active") await activateSeason(request.sessionId!, params.data.workspaceId, params.data.farmId, season.id);
    else await db.update(userSessions).set({ activeSeasonId: null }).where(eq(userSessions.activeSeasonId, season.id));
    return { season: input.data.status === "active" ? { ...season, status: "active", active: true } : season };
  });

  app.post("/v1/workspace/:workspaceId/farms/:farmId/seasons/:seasonId/select", { preHandler: requireUser }, async (request, reply) => {
    const params = seasonParamsSchema.safeParse(request.params);
    if (!request.appUser || !params.success || !selectedContext(request, params.data.workspaceId, params.data.farmId)
      || !(await activeFarm(request.sessionId!, params.data.workspaceId, params.data.farmId))) {
      return reply.code(403).send({ message: "Select this workspace and farm before selecting a season." });
    }
    if (!(await activateSeason(request.sessionId!, params.data.workspaceId, params.data.farmId, params.data.seasonId))) {
      return reply.code(404).send({ message: "Selectable season not found." });
    }
    return reply.code(204).send();
  });

  app.post("/v1/workspace/:workspaceId/farms/:farmId/seasons/:seasonId/archive", { preHandler: requireUser }, async (request, reply) => {
    const params = seasonParamsSchema.safeParse(request.params);
    if (!request.appUser || !params.success || !selectedContext(request, params.data.workspaceId, params.data.farmId)
      || !canManage(request, params.data.workspaceId)) {
      return reply.code(403).send({ message: "Workspace season management permission is required." });
    }
    const [season] = await db.update(seasons).set({ status: "archived", active: false, closed: true, updatedAt: new Date() })
      .where(and(eq(seasons.id, params.data.seasonId), eq(seasons.workspaceId, params.data.workspaceId), eq(seasons.farmId, params.data.farmId))).returning({ id: seasons.id });
    if (!season) return reply.code(404).send({ message: "Season not found." });
    await db.update(userSessions).set({ activeSeasonId: null }).where(eq(userSessions.activeSeasonId, season.id));
    return reply.code(204).send();
  });
}
