import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyReply, FastifyRequest } from "fastify";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { config, localDevelopmentMode } from "./config.js";
import { db } from "./db/client.js";
import { farms, userSessions, users, workspaceMemberFarms, workspaceMemberships, workspaces } from "./db/schema.js";
import { hasPermission, type AppRole, type Permission, type PlatformRole, type WorkspaceModulePermissions, type WorkspaceRole } from "./permissions.js";
import type { FarmAccessMode } from "./workspace-access.js";

const scrypt = promisify(scryptCallback);

export type WorkspaceMembership = {
  membershipId: string;
  workspaceId: string;
  workspaceName: string;
  role: WorkspaceRole;
  active: boolean;
  permissions: WorkspaceModulePermissions | null;
  farmAccessMode: FarmAccessMode;
  farmIds: string[];
};

const workspaceRolePriority: Record<WorkspaceRole, number> = {
  workspace_owner: 5,
  workspace_manager: 4,
  supervisor: 3,
  accountant: 2,
  operator: 1,
  viewer: 0,
};

function compareMembershipRecency(
  left: WorkspaceMembership & { createdAt: Date | null; updatedAt: Date | null },
  right: WorkspaceMembership & { createdAt: Date | null; updatedAt: Date | null },
) {
  if (left.active !== right.active) return left.active ? -1 : 1;
  const roleDiff = workspaceRolePriority[right.role] - workspaceRolePriority[left.role];
  if (roleDiff !== 0) return roleDiff;
  if (Boolean(left.permissions) !== Boolean(right.permissions)) return left.permissions ? -1 : 1;
  const updatedDiff = (right.updatedAt?.getTime() ?? 0) - (left.updatedAt?.getTime() ?? 0);
  if (updatedDiff !== 0) return updatedDiff;
  const createdDiff = (right.createdAt?.getTime() ?? 0) - (left.createdAt?.getTime() ?? 0);
  if (createdDiff !== 0) return createdDiff;
  return right.membershipId.localeCompare(left.membershipId);
}

type LoadedWorkspaceMembership = WorkspaceMembership & {
  createdAt: Date | null;
  updatedAt: Date | null;
};

export type AccountStatus = "pending" | "approved" | "rejected" | "suspended";
export type AccountBlockCode = "ACCOUNT_PENDING_APPROVAL" | "ACCOUNT_REJECTED" | "ACCOUNT_SUSPENDED";

export type AuthenticatedUser = {
  id: string;
  workspaceId: string | null;
  workspaceName: string | null;
  workspaceSelectionReason?: "explicit_workspace" | "user_preference" | "first_accessible_workspace";
  email: string;
  displayName: string | null;
  role: AppRole;
  platformRole: PlatformRole | null;
  memberships: WorkspaceMembership[];
  status: AccountStatus;
};

function accountBlockCode(account: { status: AccountStatus; active: boolean }): AccountBlockCode | null {
  if (account.status === "pending") return "ACCOUNT_PENDING_APPROVAL";
  if (account.status === "rejected") return "ACCOUNT_REJECTED";
  if (account.status === "suspended" || !account.active) return "ACCOUNT_SUSPENDED";
  return null;
}

export const accountBlockMessages: Record<AccountBlockCode, string> = {
  ACCOUNT_PENDING_APPROVAL: "Your account is waiting for platform administrator approval.",
  ACCOUNT_REJECTED: "This account request was not approved.",
  ACCOUNT_SUSPENDED: "This account is suspended. Contact support.",
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

export async function createSession(userId: string, workspaceId?: string | null): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + config.SESSION_DAYS * 24 * 60 * 60 * 1000);
  if (localDevelopmentMode) {
    localSessions.set(hashToken(token), expiresAt);
    return token;
  }
  await db.insert(userSessions).values({ userId, workspaceId, tokenHash: hashToken(token), expiresAt });
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
  const memberships = await db
    .select({
      id: workspaceMemberships.id,
      workspaceId: workspaceMemberships.workspaceId,
      workspaceName: workspaces.name,
      role: workspaceMemberships.role,
      active: workspaceMemberships.active,
      permissions: workspaceMemberships.permissions,
      farmAccessMode: workspaceMemberships.farmAccessMode,
      createdAt: workspaceMemberships.createdAt,
      updatedAt: workspaceMemberships.updatedAt,
    })
    .from(workspaceMemberships)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
    .where(and(eq(workspaceMemberships.userId, userId), eq(workspaces.status, "approved")));
  if (!memberships.length) return [];
  const membershipIds = memberships.map((membership) => membership.id);
  const assignments = await db.select({
    membershipId: workspaceMemberFarms.membershipId,
    farmId: workspaceMemberFarms.farmId,
  }).from(workspaceMemberFarms)
    .where(inArray(workspaceMemberFarms.membershipId, membershipIds));
  const farmIdsByMembership = new Map<string, string[]>();
  for (const assignment of assignments) {
    const list = farmIdsByMembership.get(assignment.membershipId) ?? [];
    list.push(assignment.farmId);
    farmIdsByMembership.set(assignment.membershipId, list);
  }
  const normalized: LoadedWorkspaceMembership[] = memberships.map(({ id, ...membership }) => ({
    membershipId: id,
    ...membership,
    farmAccessMode: membership.farmAccessMode === "assigned" ? "assigned" : "all",
    farmIds: farmIdsByMembership.get(id) ?? [],
  }));

  const byWorkspace = new Map<string, LoadedWorkspaceMembership[]>();
  for (const membership of normalized) {
    const list = byWorkspace.get(membership.workspaceId) ?? [];
    list.push(membership);
    byWorkspace.set(membership.workspaceId, list);
  }

  const deduped: LoadedWorkspaceMembership[] = [];
  for (const [workspaceId, duplicates] of byWorkspace) {
    duplicates.sort(compareMembershipRecency);
    const preferred = duplicates[0]!;
    const mergedFarmIds = [...new Set(duplicates.flatMap((membership) => membership.farmIds))];
    const effectiveFarmAccessMode: FarmAccessMode = duplicates.some((membership) => membership.farmAccessMode === "all")
      ? "all"
      : "assigned";
    if (duplicates.length > 1) {
      console.warn("DUPLICATE_WORKSPACE_MEMBERSHIPS_DETECTED", {
        userId,
        workspaceId,
        membershipIds: duplicates.map((membership) => membership.membershipId),
        chosenMembershipId: preferred.membershipId,
      });
    }
    deduped.push({
      ...preferred,
      farmAccessMode: effectiveFarmAccessMode,
      farmIds: mergedFarmIds,
    });
  }

  return deduped.map(({ createdAt: _createdAt, updatedAt: _updatedAt, ...membership }) => membership);
}

async function visibleFarmCounts(workspaceIds: string[]) {
  if (!workspaceIds.length) return new Map<string, number>();
  const counts = await db.select({
    workspaceId: farms.workspaceId,
    count: sql<number>`count(*)::int`,
  }).from(farms)
    .where(and(
      inArray(farms.workspaceId, workspaceIds),
      isNull(farms.deletedAt),
      eq(farms.active, true),
    ))
    .groupBy(farms.workspaceId);
  return new Map(counts.map((row) => [row.workspaceId, Number(row.count ?? 0)]));
}

async function selectActiveMembership(
  user: typeof users.$inferSelect,
  memberships: WorkspaceMembership[],
  requestedWorkspaceId?: string | null,
): Promise<{ membership: WorkspaceMembership | null; reason: AuthenticatedUser["workspaceSelectionReason"] }> {
  const activeMemberships = memberships.filter((membership) => membership.active);
  if (!activeMemberships.length) return { membership: null, reason: undefined };

  const explicitMembership = requestedWorkspaceId
    ? activeMemberships.find((membership) => membership.workspaceId === requestedWorkspaceId) ?? null
    : null;
  if (explicitMembership) return { membership: explicitMembership, reason: "explicit_workspace" };

  const preferredMembership = user.workspaceId
    ? activeMemberships.find((membership) => membership.workspaceId === user.workspaceId) ?? null
    : null;
  if (preferredMembership) return { membership: preferredMembership, reason: "user_preference" };

  const workspaceIds = activeMemberships.map((membership) => membership.workspaceId);
  const farmCounts = await visibleFarmCounts(workspaceIds);
  const ranked = [...activeMemberships].sort((left, right) => {
    const accessibleLeft = left.farmAccessMode === "all"
      ? (farmCounts.get(left.workspaceId) ?? 0)
      : left.farmIds.length;
    const accessibleRight = right.farmAccessMode === "all"
      ? (farmCounts.get(right.workspaceId) ?? 0)
      : right.farmIds.length;
    if (accessibleRight !== accessibleLeft) return accessibleRight - accessibleLeft;
    const roleDiff = workspaceRolePriority[right.role] - workspaceRolePriority[left.role];
    if (roleDiff !== 0) return roleDiff;
    return left.workspaceName.localeCompare(right.workspaceName);
  });
  return { membership: ranked[0] ?? null, reason: "first_accessible_workspace" };
}

export async function serializeUser(user: typeof users.$inferSelect, workspaceId?: string | null): Promise<AuthenticatedUser> {
  const memberships = user.platformRole ? [] : await loadMemberships(user.id);
  const { membership: currentMembership, reason } = await selectActiveMembership(user, memberships, workspaceId);
  const role = user.platformRole ?? currentMembership?.role ?? "viewer";
  return {
    id: user.id,
    workspaceId: currentMembership?.workspaceId ?? null,
    workspaceName: currentMembership?.workspaceName ?? null,
    workspaceSelectionReason: reason,
    email: user.email,
    displayName: user.displayName,
    role,
    platformRole: user.platformRole,
    memberships,
    status: user.status,
  };
}

async function loadSessionRow(token: string) {
  const [row] = await db
    .select({ sessionId: userSessions.id, workspaceId: userSessions.workspaceId, user: users })
    .from(userSessions)
    .innerJoin(users, eq(users.id, userSessions.userId))
    .where(and(eq(userSessions.tokenHash, hashToken(token)), gt(userSessions.expiresAt, new Date())))
    .limit(1);
  return row ?? null;
}

/**
 * Authenticates the bearer token regardless of account status (pending,
 * rejected, and suspended accounts included). Only endpoints that a blocked
 * account must still be able to reach — reading its own status and signing
 * out — should use this instead of requireUser.
 */
export async function authenticateRequest(request: FastifyRequest, reply: FastifyReply): Promise<void> {
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
  const row = await loadSessionRow(token);
  if (!row) {
    await reply.code(401).send({ message: "Your session is invalid or expired." });
    return;
  }
  request.sessionId = row.sessionId;
  request.appUser = await serializeUser(row.user, row.workspaceId);
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
  const row = await loadSessionRow(token);
  if (!row) {
    await reply.code(401).send({ message: "Your session is invalid or expired." });
    return;
  }
  const code = accountBlockCode(row.user);
  if (code) {
    await reply.code(403).send({ code, message: accountBlockMessages[code] });
    return;
  }
  request.sessionId = row.sessionId;
  request.appUser = await serializeUser(row.user, row.workspaceId);
}

export async function authenticateToken(token: string): Promise<{ user: AuthenticatedUser; sessionId: string | null } | null> {
  if (!token) return null;
  if (localDevelopmentMode) {
    const expiry = localSessions.get(hashToken(token));
    if (!expiry || expiry <= new Date()) return null;
    return { user: localUser, sessionId: null };
  }
  const row = await loadSessionRow(token);
  if (!row || !row.user.active || row.user.status !== "approved") return null;
  return {
    user: await serializeUser(row.user, row.workspaceId),
    sessionId: row.sessionId,
  };
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
export const requireRegistrationAdmin = requirePermission("MANAGE_REGISTRATIONS");

/**
 * Approves a pending registration. Idempotent: calling this a second time on
 * an already-approved account is a safe no-op (alreadyApproved: true) rather
 * than a duplicate side effect. The pending -> approved transition is done
 * as a single conditional UPDATE (WHERE status = 'pending') so concurrent
 * approval requests for the same account can never both "win".
 */
export async function approveRegistration(userId: string, approvedBy: string): Promise<{ alreadyApproved: boolean }> {
  const now = new Date();
  const [updated] = await db.update(users).set({
    status: "approved",
    active: true,
    approvedAt: now,
    approvedBy,
    updatedAt: now,
  }).where(and(eq(users.id, userId), eq(users.status, "pending"))).returning({ id: users.id });

  if (!updated) {
    const [existing] = await db.select({ status: users.status }).from(users).where(eq(users.id, userId)).limit(1);
    if (!existing) throw new Error("User not found.");
    if (existing.status !== "approved") throw new Error(`Cannot approve a registration with status "${existing.status}".`);
    return { alreadyApproved: true };
  }

  // Legacy compatibility: earlier builds paired a pending user with a pending
  // workspace-ownership request. New pending registrations never have one,
  // but if this account still does, keep the two in sync.
  const [membership] = await db.select({ workspaceId: workspaceMemberships.workspaceId })
    .from(workspaceMemberships).where(eq(workspaceMemberships.userId, userId)).limit(1);
  if (membership) {
    await db.update(workspaces).set({ status: "approved", approvedAt: now, approvedBy })
      .where(and(eq(workspaces.id, membership.workspaceId), eq(workspaces.status, "pending")));
  }
  return { alreadyApproved: false };
}

/**
 * Rejects a pending registration. Idempotent for the same reasons as
 * approveRegistration. The account row is never deleted.
 */
export async function rejectRegistration(userId: string, rejectedBy: string, reason?: string | null): Promise<{ alreadyRejected: boolean }> {
  const now = new Date();
  const [updated] = await db.update(users).set({
    status: "rejected",
    active: false,
    rejectedAt: now,
    rejectedBy,
    internalReviewNote: reason?.trim() || null,
    updatedAt: now,
  }).where(and(eq(users.id, userId), eq(users.status, "pending"))).returning({ id: users.id });

  if (!updated) {
    const [existing] = await db.select({ status: users.status }).from(users).where(eq(users.id, userId)).limit(1);
    if (!existing) throw new Error("User not found.");
    if (existing.status !== "rejected") throw new Error(`Cannot reject a registration with status "${existing.status}".`);
    return { alreadyRejected: true };
  }

  const [membership] = await db.select({ workspaceId: workspaceMemberships.workspaceId })
    .from(workspaceMemberships).where(eq(workspaceMemberships.userId, userId)).limit(1);
  if (membership) {
    await db.update(workspaces).set({ status: "rejected", approvedAt: now, approvedBy: rejectedBy })
      .where(and(eq(workspaces.id, membership.workspaceId), eq(workspaces.status, "pending")));
  }
  return { alreadyRejected: false };
}

/**
 * Public self-registration: creates only the account row, in PENDING_APPROVAL
 * (status "pending"). No workspace, membership, farm, or season is created —
 * those only happen once a platform administrator approves the account and
 * the user completes onboarding.
 */
export async function createPendingUser(input: {
  ownerName: string; email: string; password: string; phone?: string; language?: string;
}): Promise<{ id: string }> {
  const email = input.email.toLowerCase();
  const [user] = await db.insert(users).values({
    email,
    passwordHash: await hashPassword(input.password),
    displayName: input.ownerName.trim(),
    phone: input.phone?.trim() || null,
    status: "pending",
    active: true,
    registrationSource: "self_service",
    registrationLanguage: input.language?.trim().slice(0, 10) || null,
  }).returning({ id: users.id });
  if (!user) throw new Error("Unable to create account request.");
  return user;
}

export async function authenticateUser(email: string, password: string): Promise<
  | { ok: true; user: AuthenticatedUser }
  | { ok: false; blocked: AccountBlockCode | null }
> {
  if (localDevelopmentMode) {
    const ok = email.toLowerCase() === localUser.email && password === config.LOCAL_ADMIN_PASSWORD;
    return ok ? { ok: true, user: localUser } : { ok: false, blocked: null };
  }
  const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  if (!user || !(await verifyPassword(password, user.passwordHash))) return { ok: false, blocked: null };
  const code = accountBlockCode(user);
  if (code) return { ok: false, blocked: code };
  return { ok: true, user: await serializeUser(user) };
}
