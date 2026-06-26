import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  approveUserAndWorkspace,
  authenticateUser,
  createPendingWorkspaceOwner,
  createRejectedLoginMessage,
  createSession,
  rejectUserAndWorkspace,
  requireAdmin,
  requirePlatformAdmin,
  requireUser,
  revokeSession,
  serializeUser,
} from "../auth.js";
import { localDevelopmentMode } from "../config.js";
import { db } from "../db/client.js";
import { users, userSessions, workspaceMemberships, workspaces } from "../db/schema.js";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const signupSchema = z.object({
  workspaceName: z.string().trim().min(2).max(120),
  ownerName: z.string().trim().min(2).max(120),
  email: z.string().email(),
  phone: z.string().trim().max(40).optional(),
  password: z.string().min(8).max(128),
});

const approvalSchema = z.object({
  userId: z.string().uuid(),
});

const workspaceSelectionSchema = z.object({
  workspaceId: z.string().uuid(),
});

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/auth/signup", { config: { rateLimit: { max: 4, timeWindow: "1 minute" } } }, async (request, reply) => {
    const parsed = signupSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "Please complete all required onboarding fields." });

    if (localDevelopmentMode) {
      return reply.code(202).send({ status: "pending", message: "Your workspace request has been submitted for administrator approval." });
    }

    const email = parsed.data.email.toLowerCase();
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existing) return reply.code(409).send({ message: "An account request already exists for this email." });

    await createPendingWorkspaceOwner({ ...parsed.data, email });
    return reply.code(202).send({ status: "pending", message: "Your workspace request has been submitted for administrator approval." });
  });

  app.post("/v1/auth/login", { config: { rateLimit: { max: 8, timeWindow: "1 minute" } } }, async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "Valid email and password are required." });

    const user = await authenticateUser(parsed.data.email, parsed.data.password);
    if (!user) {
      const message = localDevelopmentMode ? "Invalid email or password." : await createRejectedLoginMessage(parsed.data.email);
      return reply.code(401).send({ message });
    }

    const token = await createSession(user.id, user.workspaceId);
    return {
      token,
      user: {
        ...user,
      },
    };
  });

  app.post("/v1/auth/logout", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser) return reply;
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (token) await revokeSession(token);
    return reply.code(204).send();
  });

  app.get("/v1/session", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser) return reply;

    return {
      user: request.appUser,
      permissions: {
        canWrite: !request.appUser.platformRole && request.appUser.role !== "viewer",
        canAdminister: request.appUser.platformRole === "platform_admin",
      },
    };
  });

  app.post("/v1/session/workspace", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser || !request.sessionId) return reply.code(401).send({ message: "A database-backed session is required." });
    const parsed = workspaceSelectionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "A valid workspace id is required." });
    const membership = request.appUser.memberships.find((item) => item.active && item.workspaceId === parsed.data.workspaceId);
    if (!membership) return reply.code(403).send({ message: "Workspace membership is required." });
    await db.update(userSessions).set({
      workspaceId: parsed.data.workspaceId,
      activeFarmId: null,
      activeSeasonId: null,
    }).where(eq(userSessions.id, request.sessionId));
    await db.update(users).set({
      workspaceId: parsed.data.workspaceId,
    }).where(eq(users.id, request.appUser.id));
    const [user] = await db.select().from(users).where(eq(users.id, request.appUser.id)).limit(1);
    if (!user) return reply.code(404).send({ message: "User not found." });
    return { user: await serializeUser(user, parsed.data.workspaceId) };
  });

  app.get("/v1/admin/approvals", { preHandler: requireAdmin }, async (_request, _reply) => {
    if (localDevelopmentMode) {
      return {
        requests: [{
          userId: "00000000-0000-0000-0000-000000000201",
          workspaceId: "00000000-0000-0000-0000-000000000200",
          workspaceName: "Green Valley Farms",
          ownerName: "Pending Owner",
          email: "owner@example.com",
          phone: "+966 555 0101",
          createdAt: new Date().toISOString(),
        }],
      };
    }

    const requests = await db
      .select({
        userId: users.id,
        workspaceId: workspaces.id,
        workspaceName: workspaces.name,
        ownerName: users.displayName,
        email: users.email,
        phone: workspaces.contactPhone,
        createdAt: users.createdAt,
      })
      .from(users)
      .innerJoin(workspaceMemberships, eq(workspaceMemberships.userId, users.id))
      .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
      .where(eq(users.status, "pending"))
      .orderBy(desc(users.createdAt));

    return { requests };
  });

  app.post("/v1/admin/approvals/approve", { preHandler: requirePlatformAdmin }, async (request, reply) => {
    const parsed = approvalSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "A valid user id is required." });
    if (!request.appUser) return reply;
    if (!localDevelopmentMode) await approveUserAndWorkspace(parsed.data.userId, request.appUser.id);
    return reply.code(204).send();
  });

  app.post("/v1/admin/approvals/reject", { preHandler: requirePlatformAdmin }, async (request, reply) => {
    const parsed = approvalSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "A valid user id is required." });
    if (!request.appUser) return reply;
    if (!localDevelopmentMode) await rejectUserAndWorkspace(parsed.data.userId, request.appUser.id);
    return reply.code(204).send();
  });
}
