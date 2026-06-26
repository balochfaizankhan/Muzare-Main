import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth.js";
import { localDevelopmentMode } from "../config.js";
import { resolveWorkspaceContext } from "./workspace-context.js";
import { allowedFarmIdsForWorkspace } from "../workspace-access.js";

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

    const membership = request.appUser.memberships.find((item) =>
      item.active && item.workspaceId === request.appUser!.workspaceId);

    const devContextLog = (payload: Record<string, unknown>) => {
      if (!localDevelopmentMode) return;
      request.log.info({
        userId: request.appUser?.id ?? null,
        workspaceId: request.appUser?.workspaceId ?? null,
        role: membership?.role ?? null,
        farmAccessMode: membership?.farmAccessMode ?? null,
        permissionSummary: membership?.permissions ?? null,
        ...payload,
      }, "BOOTSTRAP_CONTEXT_DEBUG");
    };

    let context;
    try {
      context = await resolveWorkspaceContext(request.appUser.workspaceId, request.sessionId, {
        allowedFarmIds: allowedFarmIdsForWorkspace(request.appUser, request.appUser.workspaceId),
      });
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
        workspaceFarmCount: 0,
        accessibleFarmCount: 0,
        accessibleFarmIds: [],
        farmAccessReason: "no_workspace_farms",
        needsRepair: true,
        contextWarning: "Workspace context needs repair before farm and season data can load.",
      });
    }

    devContextLog({
      workspaceFarmCount: context.workspaceFarmCount,
      accessibleFarmCount: context.accessibleFarmCount,
      accessibleFarmIds: context.accessibleFarmIds,
      activeFarmId: context.activeFarmId,
      activeSeasonId: context.activeSeasonId,
      farmAccessReason: context.farmAccessReason,
      needsRepair: context.needsRepair,
    });

    return {
      user: request.appUser,
      activeFarmId: context.activeFarmId,
      activeSeasonId: context.activeSeasonId,
      farms: context.farms,
      seasons: context.seasons,
      workspaceFarmCount: context.workspaceFarmCount,
      accessibleFarmCount: context.accessibleFarmCount,
      accessibleFarmIds: context.accessibleFarmIds,
      farmAccessReason: context.farmAccessReason,
      needsRepair: context.needsRepair,
      contextWarning: context.contextWarning,
    };
  });
}
