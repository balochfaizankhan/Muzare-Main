import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyReply, FastifyRequest } from "fastify";
import { and, eq, gt, sql } from "drizzle-orm";
import { config, localDevelopmentMode } from "./config.js";
import { db } from "./db/client.js";
import { userSessions, users, workspaceMemberships, workspaces } from "./db/schema.js";
import { hasPermission, type AppRole, type Permission, type PlatformRole, type WorkspaceRole } from "./permissions.js";

const scrypt = promisify(scryptCallback);

export type WorkspaceMembership = {
  workspaceId: string;
  workspaceName: string;
  role: WorkspaceRole;
  active: boolean;
};

export type AuthenticatedUser = {
  id: string;
  workspaceId: string | null;
  workspaceName: string | null;
  email: string;
  displayName: string | null;
  role: AppRole;
  platformRole: PlatformRole | null;
  memberships: WorkspaceMembership[];
  status: "pending" | "approved" | "rejected" | "suspended";
};

const localUser: AuthenticatedUser = {
  id: "00000000-0000-0000-0000-000000000001",
  workspaceId: null,
  workspaceName: null,
  email: config.LOCAL_ADMIN_EMAIL.toLowerCase(),
  displayName: "Local Platform Administrator",
  role: "platform_admin",
  platformRole: "platform_admin",
  memberships: [],
  status: "approved",
};
const localSessions = new Map<string, Date>();

declare module "fastify" {
  interface FastifyRequest {
    appUser?: AuthenticatedUser;
    sessionId?: string;
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${derivedKey.toString("hex")}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [method, salt, hash] = storedHash.split(":");
  if (method !== "scrypt" || !salt || !hash) return false;
  const suppliedKey = (await scrypt(password, salt, 64)) as Buffer;
  const storedKey = Buffer.from(hash, "hex");
  return suppliedKey.length === storedKey.length && timingSafeEqual(suppliedKey, storedKey);
}

export async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + config.SESSION_DAYS * 24 * 60 * 60 * 1000);
  if (localDevelopmentMode) {
    localSessions.set(hashToken(token), expiresAt);
    return token;
  }
  await db.insert(userSessions).values({ userId, tokenHash: hashToken(token), expiresAt });
  return token;
}

export async function revokeSession(token: string): Promise<void> {
  if (localDevelopmentMode) {
    localSessions.delete(hashToken(token));
    return;
  }
  await db.delete(userSessions).where(eq(userSessions.tokenHash, hashToken(token)));
}

export async function ensureBootstrapAdmin(): Promise<void> {
  if (localDevelopmentMode || !config.BOOTSTRAP_ADMIN_EMAIL || !config.BOOTSTRAP_ADMIN_PASSWORD) return;
  const email = config.BOOTSTRAP_ADMIN_EMAIL.toLowerCase();
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing) {
    await db.update(users).set({ platformRole: "platform_admin", status: "approved", active: true }).where(eq(users.id, existing.id));
    await db.delete(workspaceMemberships).where(eq(workspaceMemberships.userId, existing.id));
    await db.execute(sql`UPDATE users SET workspace_id = NULL WHERE id = ${existing.id}`);
    return;
  }
  await db.insert(users).values({
    email,
    passwordHash: await hashPassword(config.BOOTSTRAP_ADMIN_PASSWORD),
    displayName: config.BOOTSTRAP_ADMIN_NAME,
    platformRole: "platform_admin",
    status: "approved",
    approvedAt: new Date(),
  });
}

async function loadMemberships(userId: string): Promise<WorkspaceMembership[]> {
  return db
    .select({
      workspaceId: workspaceMemberships.workspaceId,
      workspaceName: workspaces.name,
      role: workspaceMemberships.role,
      active: workspaceMemberships.active,
    })
    .from(workspaceMemberships)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
    .where(eq(workspaceMemberships.userId, userId));
}

export async function serializeUser(user: typeof users.$inferSelect): Promise<AuthenticatedUser> {
  const memberships = await loadMemberships(user.id);
  const currentMembership = memberships.find((membership) => membership.active) ?? null;
  const role = user.platformRole ?? currentMembership?.role ?? "viewer";
  return {
    id: user.id,
    workspaceId: currentMembership?.workspaceId ?? null,
    workspaceName: currentMembership?.workspaceName ?? null,
    email: user.email,
    displayName: user.displayName,
    role,
    platformRole: user.platformRole,
    memberships,
    status: user.status,
  };
}

export async function requireUser(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token) {
    await reply.code(401).send({ message: "Authentication token is required." });
    return;
  }
  if (localDevelopmentMode) {
    const expiry = localSessions.get(hashToken(token));
    if (!expiry || expiry <= new Date()) {
      await reply.code(401).send({ message: "Your session is invalid or expired." });
      return;
    }
    request.appUser = localUser;
    return;
  }
  const [row] = await db
    .select({ sessionId: userSessions.id, user: users })
    .from(userSessions)
    .innerJoin(users, eq(users.id, userSessions.userId))
    .where(and(eq(userSessions.tokenHash, hashToken(token)), gt(userSessions.expiresAt, new Date())))
    .limit(1);
  if (!row || !row.user.active || row.user.status !== "approved") {
    await reply.code(401).send({ message: "Your session is invalid or expired." });
    return;
  }
  request.sessionId = row.sessionId;
  request.appUser = await serializeUser(row.user);
}

export function requirePermission(permission: Permission, workspaceId?: (request: FastifyRequest) => string | undefined) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await requireUser(request, reply);
    if (reply.sent || !request.appUser) return;
    if (!hasPermission(request.appUser, permission, workspaceId?.(request))) {
      await reply.code(403).send({ message: "You do not have permission to perform this action." });
    }
  };
}

export const requireAdmin = requirePermission("VIEW_WORKSPACES");
export const requirePlatformAdmin = requirePermission("CREATE_WORKSPACE");

export async function createRejectedLoginMessage(email: string): Promise<string> {
  const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  if (!user) return "Invalid email or password.";
  if (user.status === "pending") return "Your account request is waiting for platform approval.";
  if (user.status === "rejected") return "This account request was not approved.";
  if (user.status === "suspended") return "This account is suspended. Contact support.";
  if (!user.active) return "This account is inactive.";
  return "Invalid email or password.";
}

export async function approveUserAndWorkspace(userId: string, approvedBy: string): Promise<void> {
  const [membership] = await db.select().from(workspaceMemberships).where(eq(workspaceMemberships.userId, userId)).limit(1);
  if (!membership) throw new Error("Workspace owner membership not found.");
  const now = new Date();
  await db.update(workspaces).set({ status: "approved", approvedAt: now, approvedBy }).where(eq(workspaces.id, membership.workspaceId));
  await db.update(users).set({ status: "approved", active: true, approvedAt: now, approvedBy }).where(eq(users.id, userId));
}

export async function rejectUserAndWorkspace(userId: string, approvedBy: string): Promise<void> {
  const [membership] = await db.select().from(workspaceMemberships).where(eq(workspaceMemberships.userId, userId)).limit(1);
  if (!membership) throw new Error("Workspace owner membership not found.");
  const now = new Date();
  await db.update(workspaces).set({ status: "rejected", approvedAt: now, approvedBy }).where(eq(workspaces.id, membership.workspaceId));
  await db.update(users).set({ status: "rejected", active: false, approvedAt: now, approvedBy }).where(eq(users.id, userId));
}

export async function createPendingWorkspaceOwner(input: {
  workspaceName: string; ownerName: string; email: string; password: string; phone?: string;
}): Promise<void> {
  const email = input.email.toLowerCase();
  const baseSlug = input.workspaceName.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workspace";
  const [workspace] = await db.insert(workspaces).values({
    name: input.workspaceName.trim(),
    slug: `${baseSlug}-${randomBytes(3).toString("hex")}`,
    contactEmail: email,
    contactPhone: input.phone?.trim() || null,
    status: "pending",
  }).returning();
  if (!workspace) throw new Error("Unable to create workspace request.");
  const [user] = await db.insert(users).values({
    email,
    passwordHash: await hashPassword(input.password),
    displayName: input.ownerName.trim(),
    status: "pending",
    active: true,
  }).returning({ id: users.id });
  if (!user) throw new Error("Unable to create workspace owner.");
  await db.insert(workspaceMemberships).values({ workspaceId: workspace.id, userId: user.id, role: "workspace_owner" });
}

export async function authenticateUser(email: string, password: string): Promise<AuthenticatedUser | null> {
  if (localDevelopmentMode) {
    return email.toLowerCase() === localUser.email && password === config.LOCAL_ADMIN_PASSWORD ? localUser : null;
  }
  const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  if (!user || !user.active || user.status !== "approved" || !(await verifyPassword(password, user.passwordHash))) return null;
  return serializeUser(user);
}
