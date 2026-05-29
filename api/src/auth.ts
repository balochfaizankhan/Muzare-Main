import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyReply, FastifyRequest } from "fastify";
import { and, eq, gt } from "drizzle-orm";
import { config, localDevelopmentMode } from "./config.js";
import { db } from "./db/client.js";
import { userSessions, users, workspaces } from "./db/schema.js";

const scrypt = promisify(scryptCallback);
const localUser: AuthenticatedUser = {
  id: "00000000-0000-0000-0000-000000000001",
  workspaceId: "00000000-0000-0000-0000-000000000100",
  workspaceName: "Local Workspace",
  email: config.LOCAL_ADMIN_EMAIL.toLowerCase(),
  displayName: "Local Administrator",
  role: "admin",
  status: "approved",
};
const localSessions = new Map<string, Date>();

export type AuthenticatedUser = {
  id: string;
  workspaceId: string | null;
  workspaceName: string | null;
  email: string;
  displayName: string | null;
  role: "admin" | "operator" | "viewer";
  status: "pending" | "approved" | "rejected" | "suspended";
};

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
  if (localDevelopmentMode) return;
  if (!config.BOOTSTRAP_ADMIN_EMAIL || !config.BOOTSTRAP_ADMIN_PASSWORD) return;

  const email = config.BOOTSTRAP_ADMIN_EMAIL.toLowerCase();
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing) return;

  const slug = "muzare-administration";
  const [workspace] = await db
    .insert(workspaces)
    .values({
      name: "Muzare Administration",
      slug,
      contactEmail: email,
      status: "approved",
      approvedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: workspaces.slug,
      set: { status: "approved", approvedAt: new Date() },
    })
    .returning();
  if (!workspace) throw new Error("Unable to create administration workspace.");

  const [admin] = await db.insert(users).values({
    workspaceId: workspace.id,
    email,
    passwordHash: await hashPassword(config.BOOTSTRAP_ADMIN_PASSWORD),
    displayName: config.BOOTSTRAP_ADMIN_NAME,
    role: "admin",
    status: "approved",
    approvedAt: new Date(),
  }).returning({ id: users.id });
  if (!admin) throw new Error("Unable to create bootstrap administrator.");

  await db.update(workspaces).set({ approvedBy: admin.id }).where(eq(workspaces.id, workspace.id));
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireUser(request, reply);
  if (reply.sent) return;
  if (request.appUser?.role !== "admin") {
    await reply.code(403).send({ message: "Administrator access is required." });
  }
}

export async function serializeUser(user: typeof users.$inferSelect, workspaceName: string | null): Promise<AuthenticatedUser> {
  return {
    id: user.id,
    workspaceId: user.workspaceId,
    workspaceName,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
  };
}

export function assertApproved(user: Pick<AuthenticatedUser, "status">): boolean {
  return user.status === "approved";
}

export async function createApprovedSessionUser(userId: string): Promise<AuthenticatedUser | null> {
  const [row] = await db
    .select({ user: users, workspaceName: workspaces.name })
    .from(users)
    .leftJoin(workspaces, eq(workspaces.id, users.workspaceId))
    .where(eq(users.id, userId))
    .limit(1);

  if (!row || !row.user.active || row.user.status !== "approved") return null;
  return serializeUser(row.user, row.workspaceName);
}

export async function createLocalSessionUser(): Promise<AuthenticatedUser> {
  return localUser;
}

export async function createRejectedLoginMessage(email: string): Promise<string> {
  const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  if (!user) return "Invalid email or password.";
  if (user.status === "pending") return "Your account request is waiting for administrator approval.";
  if (user.status === "rejected") return "This account request was not approved.";
  if (user.status === "suspended") return "This account is suspended. Contact an administrator.";
  if (!user.active) return "This account is inactive.";
  return "Invalid email or password.";
}

export async function approveUserAndWorkspace(userId: string, approvedBy: string): Promise<void> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new Error("User not found.");
  const now = new Date();
  if (user.workspaceId) {
    await db.update(workspaces).set({ status: "approved", approvedAt: now, approvedBy }).where(eq(workspaces.id, user.workspaceId));
  }
  await db.update(users).set({ status: "approved", active: true, approvedAt: now, approvedBy }).where(eq(users.id, userId));
}

export async function rejectUserAndWorkspace(userId: string, approvedBy: string): Promise<void> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new Error("User not found.");
  const now = new Date();
  if (user.workspaceId) {
    await db.update(workspaces).set({ status: "rejected", approvedAt: now, approvedBy }).where(eq(workspaces.id, user.workspaceId));
  }
  await db.update(users).set({ status: "rejected", active: false, approvedAt: now, approvedBy }).where(eq(users.id, userId));
}

export async function createPendingWorkspaceOwner(input: {
  workspaceName: string;
  ownerName: string;
  email: string;
  password: string;
  phone?: string;
}): Promise<void> {
  const email = input.email.toLowerCase();
  const baseSlug = input.workspaceName.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workspace";
  const slug = `${baseSlug}-${randomBytes(3).toString("hex")}`;
  const [workspace] = await db.insert(workspaces).values({
    name: input.workspaceName.trim(),
    slug,
    contactEmail: email,
    contactPhone: input.phone?.trim() || null,
    status: "pending",
  }).returning();
  if (!workspace) throw new Error("Unable to create workspace request.");

  await db.insert(users).values({
    workspaceId: workspace.id,
    email,
    passwordHash: await hashPassword(input.password),
    displayName: input.ownerName.trim(),
    role: "admin",
    status: "pending",
    active: true,
  });
}

export async function authenticateUser(email: string, password: string): Promise<AuthenticatedUser | null> {
  if (localDevelopmentMode) {
    return email.toLowerCase() === localUser.email && password === config.LOCAL_ADMIN_PASSWORD ? localUser : null;
  }

  const [row] = await db
    .select({ user: users, workspaceName: workspaces.name })
    .from(users)
    .leftJoin(workspaces, eq(workspaces.id, users.workspaceId))
    .where(eq(users.email, email.toLowerCase()))
    .limit(1);
  if (!row || !row.user.active || row.user.status !== "approved" || !(await verifyPassword(password, row.user.passwordHash))) return null;
  return serializeUser(row.user, row.workspaceName);
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
    .select({ sessionId: userSessions.id, user: users, workspaceName: workspaces.name })
    .from(userSessions)
    .innerJoin(users, eq(users.id, userSessions.userId))
    .leftJoin(workspaces, eq(workspaces.id, users.workspaceId))
    .where(and(eq(userSessions.tokenHash, hashToken(token)), gt(userSessions.expiresAt, new Date())))
    .limit(1);

  if (!row || !row.user.active || row.user.status !== "approved") {
    await reply.code(401).send({ message: "Your session is invalid or expired." });
    return;
  }

  request.sessionId = row.sessionId;
  request.appUser = await serializeUser(row.user, row.workspaceName);
}
