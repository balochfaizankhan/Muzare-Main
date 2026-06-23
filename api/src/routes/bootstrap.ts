import type { FastifyInstance } from "fastify";
import { and, desc, eq, isNull } from "drizzle-orm";
import { requireUser } from "../auth.js";
import { localDevelopmentMode } from "../config.js";
import { db } from "../db/client.js";
import { farms, seasons, userSessions } from "../db/schema.js";

export async function bootstrapRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/bootstrap", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser) return reply;

    if (localDevelopmentMode) {
      if (request.appUser.platformRole) return { user: request.appUser, activeFarmId: null, activeSeasonId: null, farms: [], seasons: [] };
      return {
        user: request.appUser,
        activeFarmId: "00000000-0000-0000-0000-000000000010",
        activeSeasonId: "00000000-0000-0000-0000-000000000020",
        farms: [{ id: "00000000-0000-0000-0000-000000000010", name: "Main Farm", location: null, owner: null }],
        seasons: [{
          id: "00000000-0000-0000-0000-000000000020",
          farmId: "00000000-0000-0000-0000-000000000010",
          name: "2026 Season",
          year: 2026,
        }],
      };
    }

    if (request.appUser.platformRole || !request.appUser.workspaceId) {
      return { user: request.appUser, activeFarmId: null, activeSeasonId: null, farms: [], seasons: [] };
    }

    const activeFarms = await db
      .select()
      .from(farms)
      .where(and(eq(farms.active, true), eq(farms.workspaceId, request.appUser.workspaceId), isNull(farms.deletedAt)))
      .orderBy(farms.name);
    const farmIds = activeFarms.map((farm) => farm.id);
    const [session] = request.sessionId
      ? await db.select({ activeFarmId: userSessions.activeFarmId, activeSeasonId: userSessions.activeSeasonId }).from(userSessions).where(eq(userSessions.id, request.sessionId)).limit(1)
      : [];
    const activeFarmId = session?.activeFarmId && farmIds.includes(session.activeFarmId) ? session.activeFarmId : activeFarms[0]?.id ?? null;
    if (request.sessionId && activeFarmId !== session?.activeFarmId) {
      await db.update(userSessions).set({ activeFarmId }).where(eq(userSessions.id, request.sessionId));
    }
    const farmSeasons = activeFarmId ? await db
      .select()
      .from(seasons)
      .where(and(eq(seasons.workspaceId, request.appUser.workspaceId), eq(seasons.farmId, activeFarmId)))
      .orderBy(desc(seasons.startsOn)) : [];
    const selectedSeason = farmSeasons.find((season) => season.id === session?.activeSeasonId && season.status === "active")
      ?? farmSeasons.find((season) => season.status === "active")
      ?? null;
    const activeSeasonId = selectedSeason?.id ?? null;
    if (request.sessionId && activeSeasonId !== session?.activeSeasonId) {
      await db.update(userSessions).set({ activeSeasonId }).where(eq(userSessions.id, request.sessionId));
    }

    return {
      user: request.appUser,
      activeFarmId,
      activeSeasonId,
      farms: activeFarms,
      seasons: farmSeasons,
    };
  });
}
