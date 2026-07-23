import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireUser, serializeUser } from "../auth.js";
import { localDevelopmentMode } from "../config.js";
import { db } from "../db/client.js";
import { auditLogs, users, workspaceMemberships, workspaces } from "../db/schema.js";

const onboardingSchema = z.object({
  name: z.string().trim().min(2).max(120),
  contactPhone: z.string().trim().max(40).optional(),
});

/**
 * Self-service creation of an approved user's FIRST workspace. This is the
 * only workspace-creation path a regular user can reach after their account
 * is approved; public registration never creates a workspace automatically.
 * requireUser already guarantees the caller's account status is "approved",
 * so a pending/rejected/suspended account cannot reach this endpoint.
 */
export async function workspaceOnboardingRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/workspace/onboarding", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser) return reply;
    if (request.appUser.platformRole) {
      return reply.code(403).send({ message: "Platform administrators do not use self-service workspace onboarding." });
    }
    const parsed = onboardingSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "A workspace name is required." });
    if (localDevelopmentMode) return reply.code(503).send({ message: "Configure PostgreSQL to create a workspace." });

    if (request.appUser.memberships.some((membership) => membership.active)) {
      return reply.code(409).send({ message: "You already belong to a workspace." });
    }

    const baseSlug = parsed.data.name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workspace";
    const now = new Date();
    const [workspace] = await db.insert(workspaces).values({
      name: parsed.data.name.trim(),
      slug: `${baseSlug}-${randomBytes(3).toString("hex")}`,
      contactEmail: request.appUser.email,
      contactPhone: parsed.data.contactPhone?.trim() || null,
      status: "approved",
      approvedAt: now,
    }).returning();
    if (!workspace) return reply.code(500).send({ message: "Unable to create workspace." });

    await db.insert(workspaceMemberships).values({
      workspaceId: workspace.id,
      userId: request.appUser.id,
      role: "workspace_owner",
      active: true,
      farmAccessMode: "all",
    });
    await db.update(users).set({ workspaceId: workspace.id, updatedAt: now }).where(eq(users.id, request.appUser.id));
    await db.insert(auditLogs).values({
      workspaceId: workspace.id,
      userId: request.appUser.id,
      action: "workspace.onboarding_created",
      entityType: "workspace",
      entityId: workspace.id,
    });

    const [user] = await db.select().from(users).where(eq(users.id, request.appUser.id)).limit(1);
    if (!user) return reply.code(404).send({ message: "User not found." });
    return reply.code(201).send({ user: await serializeUser(user, workspace.id) });
  });
}
