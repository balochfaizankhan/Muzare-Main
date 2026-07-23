import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  accountBlockMessages,
  authenticateRequest,
  authenticateUser,
  createPendingUser,
  createSession,
  requireUser,
  revokeSession,
  serializeUser,
} from "../auth.js";
import { localDevelopmentMode } from "../config.js";
import { db } from "../db/client.js";
import { users, userSessions } from "../db/schema.js";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const signupSchema = z.object({
  ownerName: z.string().trim().min(2).max(120),
  email: z.string().email(),
  phone: z.string().trim().max(40).optional(),
  password: z.string().min(8).max(128),
  language: z.string().trim().max(10).optional(),
});

const workspaceSelectionSchema = z.object({
  workspaceId: z.string().uuid(),
});

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/auth/signup", { config: { rateLimit: { max: 4, timeWindow: "1 minute" } } }, async (request, reply) => {
    const parsed = signupSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "Please complete all required onboarding fields." });

    const email = parsed.data.email.toLowerCase();
    if (localDevelopmentMode) {
      return reply.code(503).send({ message: "Configure PostgreSQL to create accounts." });
    }

    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existing) return reply.code(409).send({ message: "An account already exists for this email." });

    await createPendingUser({ ...parsed.data, email });
    return reply.code(201).send({
      status: "pending",
      message: "Thanks for registering. A platform administrator will review your request before you can sign in.",
    });
  });

  app.post("/v1/auth/login", { config: { rateLimit: { max: 8, timeWindow: "1 minute" } } }, async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "Valid email and password are required." });

    const outcome = await authenticateUser(parsed.data.email, parsed.data.password);
    if (!outcome.ok) {
      if (outcome.blocked) return reply.code(403).send({ code: outcome.blocked, message: accountBlockMessages[outcome.blocked] });
      return reply.code(401).send({ message: "Invalid email or password." });
    }

    const token = await createSession(outcome.user.id, outcome.user.workspaceId);
    return { token, user: outcome.user };
  });

  app.post("/v1/auth/logout", { preHandler: authenticateRequest }, async (request, reply) => {
    if (!request.appUser) return reply;
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (token) await revokeSession(token);
    return reply.code(204).send();
  });

  app.get("/v1/session", { preHandler: authenticateRequest }, async (request, reply) => {
    if (!request.appUser) return reply;

    return {
      user: request.appUser,
      permissions: {
        canWrite: !request.appUser.platformRole && request.appUser.role !== "viewer" && request.appUser.status === "approved",
        canAdminister: request.appUser.platformRole === "platform_admin" && request.appUser.status === "approved",
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

  app.get("/v1/me", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser) return reply;
    const [user] = await db.select().from(users).where(eq(users.id, request.appUser.id)).limit(1);
    if (!user) return reply.code(404).send({ message: "User not found." });
    return { user: await serializeUser(user, request.appUser.workspaceId) };
  });

  app.patch("/v1/me", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser) return reply;
    const parsed = z.object({
      displayName: z.string().trim().min(2).max(120),
    }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "A valid display name is required." });
    const [user] = await db.update(users).set({
      displayName: parsed.data.displayName,
      updatedAt: new Date(),
    }).where(eq(users.id, request.appUser.id)).returning();
    if (!user) return reply.code(404).send({ message: "User not found." });
    return { user: await serializeUser(user, request.appUser.workspaceId) };
  });
}
