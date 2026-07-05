import type { FastifyInstance } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { requireAdmin } from "../auth.js";
import { db } from "../db/client.js";
import { farms, seasons } from "../db/schema.js";

const paramsSchema = z.object({ workspaceId: z.string().uuid(), farmId: z.string().uuid() });

export async function adminWorkspaceSeasonRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/admin/workspaces/:workspaceId/farms/:farmId/seasons", { preHandler: requireAdmin }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ message: "A valid workspace and farm id are required." });
    const [farm] = await db.select({ id: farms.id }).from(farms).where(and(eq(farms.id, params.data.farmId), eq(farms.workspaceId, params.data.workspaceId), isNull(farms.deletedAt))).limit(1);
    if (!farm) return reply.code(404).send({ message: "Farm not found." });
    const records = await db.select().from(seasons)
      .where(and(eq(seasons.workspaceId, params.data.workspaceId), eq(seasons.farmId, params.data.farmId)))
      .orderBy(seasons.startsOn);
    const activeSeason = records.find((season) => season.active) ?? records.find((season) => season.status === "active") ?? null;
    return {
      seasons: records,
      activeSeasonId: activeSeason?.id ?? null,
    };
  });
}
