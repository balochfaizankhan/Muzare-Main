import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { requireUser } from "../auth.js";
import { localDevelopmentMode } from "../config.js";
import { db } from "../db/client.js";
import { farms, seasons } from "../db/schema.js";

export async function bootstrapRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/bootstrap", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser) return reply;

    if (localDevelopmentMode) {
      return {
        user: request.appUser,
        farms: [{ id: "00000000-0000-0000-0000-000000000010", name: "Main Farm", location: null, owner: null }],
        seasons: [{
          id: "00000000-0000-0000-0000-000000000020",
          farmId: "00000000-0000-0000-0000-000000000010",
          name: "2026 Season",
          year: 2026,
        }],
      };
    }

    const activeFarms = await db.select().from(farms).where(eq(farms.active, true)).orderBy(farms.name);
    const activeSeasons = await db
      .select()
      .from(seasons)
      .where(and(eq(seasons.active, true), eq(seasons.closed, false)))
      .orderBy(desc(seasons.startsOn));

    return {
      user: request.appUser,
      farms: activeFarms,
      seasons: activeSeasons,
    };
  });
}
