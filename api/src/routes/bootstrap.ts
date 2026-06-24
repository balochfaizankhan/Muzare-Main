import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth.js";
import { localDevelopmentMode } from "../config.js";
import { resolveWorkspaceContext } from "./workspace-context.js";

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

    let context;
    try {
      context = await resolveWorkspaceContext(request.appUser.workspaceId, request.sessionId);
    } catch (error) {
      request.log.error({
        err: error,
        workspaceId: request.appUser.workspaceId,
        sessionId: request.sessionId,
      }, "BOOTSTRAP_CONTEXT_RESOLUTION_FAILED");
      return reply.code(200).send({
        user: request.appUser,
        activeFarmId: null,
        activeSeasonId: null,
        farms: [],
        seasons: [],
        needsRepair: true,
        contextWarning: "Workspace context needs repair before farm and season data can load.",
      });
    }

    return {
      user: request.appUser,
      activeFarmId: context.activeFarmId,
      activeSeasonId: context.activeSeasonId,
      farms: context.farms,
      seasons: context.seasons,
      needsRepair: context.needsRepair,
      contextWarning: context.contextWarning,
    };
  });
}
