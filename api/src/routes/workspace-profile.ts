import type { FastifyInstance, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireUser, serializeUser } from "../auth.js";
import { localDevelopmentMode } from "../config.js";
import { db } from "../db/client.js";
import { auditLogs, users, workspaces } from "../db/schema.js";

const workspaceParams = z.object({ workspaceId: z.string().uuid() });
const workspaceProfileInput = z.object({
  name: z.string().trim().min(2).max(120),
  contactEmail: z.string().trim().email(),
  contactPhone: z.string().trim().max(40).optional().nullable(),
});

function optional(value: string | null | undefined) {
  return value?.trim() || null;
}

function selectedMembership(request: FastifyRequest, workspaceId: string) {
  if (request.appUser?.workspaceId !== workspaceId) return null;
  return request.appUser.memberships.find((membership) => membership.active && membership.workspaceId === workspaceId) ?? null;
}

export async function workspaceProfileRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/workspace/:workspaceId/profile", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser) return reply;
    const params = workspaceParams.safeParse(request.params);
    if (!params.success || !selectedMembership(request, params.data.workspaceId)) {
      return reply.code(403).send({ message: "Select this workspace before viewing its profile." });
    }
    if (localDevelopmentMode) return reply.code(503).send({ message: "Configure PostgreSQL to view workspace profiles." });
    const [workspace] = await db.select({
      id: workspaces.id,
      name: workspaces.name,
      contactEmail: workspaces.contactEmail,
      contactPhone: workspaces.contactPhone,
    }).from(workspaces).where(eq(workspaces.id, params.data.workspaceId)).limit(1);
    if (!workspace) return reply.code(404).send({ message: "Workspace not found." });
    return { workspace };
  });

  app.patch("/v1/workspace/:workspaceId/profile", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser) return reply;
    const params = workspaceParams.safeParse(request.params);
    const input = workspaceProfileInput.safeParse(request.body);
    if (!params.success || !input.success) return reply.code(400).send({ message: "Valid workspace profile details are required." });
    const membership = selectedMembership(request, params.data.workspaceId);
    if (!membership || membership.role !== "workspace_owner") {
      return reply.code(403).send({ message: "Only the workspace owner can edit the workspace profile." });
    }
    if (localDevelopmentMode) return reply.code(503).send({ message: "Configure PostgreSQL to manage workspace profiles." });

    const [previous] = await db.select({
      name: workspaces.name,
      contactEmail: workspaces.contactEmail,
      contactPhone: workspaces.contactPhone,
    }).from(workspaces).where(eq(workspaces.id, params.data.workspaceId)).limit(1);
    if (!previous) return reply.code(404).send({ message: "Workspace not found." });

    const [workspace] = await db.update(workspaces).set({
      name: input.data.name,
      contactEmail: input.data.contactEmail.toLowerCase(),
      contactPhone: optional(input.data.contactPhone),
      updatedAt: new Date(),
    }).where(eq(workspaces.id, params.data.workspaceId)).returning({
      id: workspaces.id,
      name: workspaces.name,
      contactEmail: workspaces.contactEmail,
      contactPhone: workspaces.contactPhone,
    });
    if (!workspace) return reply.code(404).send({ message: "Workspace not found." });

    await db.insert(auditLogs).values({
      workspaceId: workspace.id,
      userId: request.appUser.id,
      action: "workspace_profile_updated",
      entityType: "workspace",
      entityId: workspace.id,
      details: { previous, updated: workspace },
    });
    const [user] = await db.select().from(users).where(eq(users.id, request.appUser.id)).limit(1);
    if (!user) return reply.code(404).send({ message: "User not found." });
    return { workspace, user: await serializeUser(user, workspace.id) };
  });
}
