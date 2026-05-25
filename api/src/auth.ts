import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyReply, FastifyRequest } from "fastify";
import { and, eq, gt } from "drizzle-orm";
import { config, localDevelopmentMode } from "./config.js";
import { db } from "./db/client.js";
import { userSessions, users } from "./db/schema.js";

const scrypt = promisify(scryptCallback);
const localUser: AuthenticatedUser = {
  id: "00000000-0000-0000-0000-000000000001",
  email: config.LOCAL_ADMIN_EMAIL.toLowerCase(),
  displayName: "Local Administrator",
  role: "admin",
};
const localSessions = new Map<string, Date>();

export type AuthenticatedUser = {
  id: string;
  email: string;
  displayName: string | null;
  role: "admin" | "operator" | "viewer";
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

  await db.insert(users).values({
    email,
    passwordHash: await hashPassword(config.BOOTSTRAP_ADMIN_PASSWORD),
    displayName: config.BOOTSTRAP_ADMIN_NAME,
    role: "admin",
  });
}

export async function authenticateUser(email: string, password: string): Promise<AuthenticatedUser | null> {
  if (localDevelopmentMode) {
    return email.toLowerCase() === localUser.email && password === config.LOCAL_ADMIN_PASSWORD ? localUser : null;
  }

  const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  if (!user || !user.active || !(await verifyPassword(password, user.passwordHash))) return null;
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
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

  if (!row || !row.user.active) {
    await reply.code(401).send({ message: "Your session is invalid or expired." });
    return;
  }

  request.sessionId = row.sessionId;
  request.appUser = {
    id: row.user.id,
    email: row.user.email,
    displayName: row.user.displayName,
    role: row.user.role,
  };
}
