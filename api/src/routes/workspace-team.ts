import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, desc, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { authenticateToken, createSession, hashPassword, requireUser, serializeUser, verifyPassword } from "../auth.js";
import { config, localDevelopmentMode } from "../config.js";
import { db } from "../db/client.js";
import { auditLogs, farms, users, workspaceMemberFarms, workspaceMemberships, workspaceTeamInvitations } from "../db/schema.js";
import { sendWorkspaceInvitationEmail } from "../email.js";
import {
  hasModulePermission,
  roleModulePermissions,
  workspaceModuleActions,
  workspaceModules,
  workspaceRoles,
  type WorkspaceModulePermissions,
} from "../permissions.js";
import type { FarmAccessMode } from "../workspace-access.js";

const workspaceParams = z.object({ workspaceId: z.string().uuid() });
const membershipParams = workspaceParams.extend({ membershipId: z.string().uuid() });
const invitationParams = workspaceParams.extend({ invitationId: z.string().uuid() });
const teamQuerySchema = z.object({
  debugEmail: z.string().trim().email().optional(),
});
const invitationLookupQuerySchema = z.object({
  token: z.string().min(20),
});
const permissionSchema = z.record(z.string(), z.record(z.string(), z.boolean())).nullable().optional().superRefine((permissions, context) => {
  if (!permissions) return;
  for (const [module, actions] of Object.entries(permissions)) {
    if (!workspaceModules.includes(module as typeof workspaceModules[number])) context.addIssue({ code: "custom", message: `Unknown module: ${module}` });
    for (const action of Object.keys(actions)) {
      if (!workspaceModuleActions.includes(action as typeof workspaceModuleActions[number])) context.addIssue({ code: "custom", message: `Unknown action: ${action}` });
    }
  }
});
const roleSchema = z.enum(workspaceRoles);
const farmAccessModeSchema = z.enum(["all", "assigned"]);
const inviteSchema = z.object({
  email: z.string().trim().email(),
  phone: z.string().trim().max(40).optional().nullable(),
  role: roleSchema.default("viewer"),
  permissions: permissionSchema,
  farmAccessMode: farmAccessModeSchema.default("all"),
  farmIds: z.array(z.string().uuid()).optional().default([]),
});
const membershipUpdateSchema = z.object({
  role: roleSchema,
  active: z.boolean(),
  permissions: permissionSchema,
  farmAccessMode: farmAccessModeSchema.default("all"),
  farmIds: z.array(z.string().uuid()).optional().default([]),
});
const acceptInvitationSchema = z.object({
  token: z.string().min(20),
  mode: z.enum(["session", "login", "signup"]).optional(),
  email: z.string().trim().email().optional(),
  displayName: z.string().trim().min(2).max(120).optional(),
  password: z.string().min(8).max(128).optional(),
  phone: z.string().trim().max(40).optional().nullable(),
});

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const optional = (value: string | null | undefined) => value?.trim() || null;

function membershipFor(request: FastifyRequest, workspaceId: string) {
  return request.appUser?.memberships.find((membership) => membership.active && membership.workspaceId === workspaceId) ?? null;
}

function canViewTeam(request: FastifyRequest, workspaceId: string) {
  return Boolean(request.appUser && membershipFor(request, workspaceId) && hasModulePermission(request.appUser, workspaceId, "team", "view"));
}

function canManageTeam(request: FastifyRequest, workspaceId: string) {
  return membershipFor(request, workspaceId)?.role === "workspace_owner";
}

async function ownerCount(workspaceId: string, excludeMembershipId?: string) {
  const [result] = await db.select({ count: sql<number>`count(*)::int` }).from(workspaceMemberships).where(and(
    eq(workspaceMemberships.workspaceId, workspaceId),
    eq(workspaceMemberships.role, "workspace_owner"),
    eq(workspaceMemberships.active, true),
    excludeMembershipId ? ne(workspaceMemberships.id, excludeMembershipId) : undefined,
  ));
  return Number(result?.count ?? 0);
}

async function audit(workspaceId: string, userId: string, action: string, entityId: string, details?: Record<string, unknown>) {
  await db.insert(auditLogs).values({ workspaceId, userId, action, entityType: "workspace_membership", entityId, details });
}

function invitationUrlFor(request: FastifyRequest, token: string) {
  const baseUrl = config.APP_BASE_URL
    ?? request.headers.origin
    ?? `${String(request.headers["x-forwarded-proto"] ?? "https")}://${String(request.headers["x-forwarded-host"] ?? request.headers.host ?? "localhost")}`;
  return `${baseUrl.replace(/\/+$/, "")}/accept-invitation?token=${encodeURIComponent(token)}`;
}

async function loadInvitationByToken(token: string) {
  const [invitation] = await db.select({
    id: workspaceTeamInvitations.id,
    workspaceId: workspaceTeamInvitations.workspaceId,
    email: workspaceTeamInvitations.email,
    phone: workspaceTeamInvitations.phone,
    role: workspaceTeamInvitations.role,
    permissions: workspaceTeamInvitations.permissions,
    farmAccessMode: workspaceTeamInvitations.farmAccessMode,
    farmIds: workspaceTeamInvitations.farmIds,
    status: workspaceTeamInvitations.status,
    expiresAt: workspaceTeamInvitations.expiresAt,
    acceptedAt: workspaceTeamInvitations.acceptedAt,
    createdAt: workspaceTeamInvitations.createdAt,
    invitedBy: workspaceTeamInvitations.invitedBy,
    workspaceName: sql<string>`(select name from workspaces where workspaces.id = ${workspaceTeamInvitations.workspaceId})`,
    inviterName: sql<string | null>`(select display_name from users where users.id = ${workspaceTeamInvitations.invitedBy})`,
    inviterEmail: sql<string | null>`(select email from users where users.id = ${workspaceTeamInvitations.invitedBy})`,
  }).from(workspaceTeamInvitations)
    .where(eq(workspaceTeamInvitations.tokenHash, hashToken(token)))
    .limit(1);
  return invitation ?? null;
}

type InvitationRecord = NonNullable<Awaited<ReturnType<typeof loadInvitationByToken>>>;

async function respondToInvitationAcceptance(
  invitation: InvitationRecord,
  input: z.infer<typeof acceptInvitationSchema>,
  authenticated: Awaited<ReturnType<typeof authenticateToken>>,
  reply: FastifyReply,
) {
  const mode = input.mode
    ?? (authenticated
      ? "session"
      : input.displayName && input.password
        ? "signup"
        : input.email && input.password
          ? "login"
          : "session");

  if (mode === "session") {
    if (!authenticated) return reply.code(401).send({ code: "auth_required", message: "Please sign in or create an account to accept this invitation." });
    if (authenticated.user.email.toLowerCase() !== invitation.email.toLowerCase()) {
      return reply.code(409).send({ code: "email_mismatch", message: "Sign in with the invited email address to accept this invitation." });
    }
    await acceptInvitationMembership(invitation, authenticated.user.id);
    return reply.code(201).send({ workspaceId: invitation.workspaceId, accepted: true });
  }

  if (mode === "login") {
    if (!input.email || !input.password) return reply.code(400).send({ code: "missing_credentials", message: "Email and password are required to sign in." });
    if (input.email.toLowerCase() !== invitation.email.toLowerCase()) {
      return reply.code(409).send({ code: "email_mismatch", message: "Use the invited email address to accept this invitation." });
    }
    const [existingUser] = await db.select().from(users).where(eq(users.email, invitation.email)).limit(1);
    if (!existingUser || !(await verifyPassword(input.password, existingUser.passwordHash))) {
      return reply.code(401).send({ code: "invalid_credentials", message: "Invalid email or password." });
    }
    await acceptInvitationMembership(invitation, existingUser.id);
    const token = await createSession(existingUser.id, invitation.workspaceId);
    const user = await serializeUser(existingUser, invitation.workspaceId);
    return reply.code(201).send({ workspaceId: invitation.workspaceId, accepted: true, token, user });
  }

  if (!input.displayName || !input.password) {
    return reply.code(400).send({ code: "missing_signup_fields", message: "Name and password are required to create your account." });
  }
  const [existingUser] = await db.select().from(users).where(eq(users.email, invitation.email)).limit(1);
  if (existingUser) {
    return reply.code(409).send({ code: "account_exists", message: "An account already exists for this email. Sign in to accept the invitation." });
  }
  const [user] = await db.insert(users).values({
    email: invitation.email,
    phone: optional(input.phone) ?? invitation.phone,
    displayName: input.displayName,
    passwordHash: await hashPassword(input.password),
    status: "approved",
    active: true,
    approvedAt: new Date(),
  }).returning();
  if (!user) return reply.code(500).send({ code: "user_create_failed", message: "Unable to create invited user." });
  await acceptInvitationMembership(invitation, user.id);
  const token = await createSession(user.id, invitation.workspaceId);
  const serializedUser = await serializeUser(user, invitation.workspaceId);
  return reply.code(201).send({ workspaceId: invitation.workspaceId, accepted: true, token, user: serializedUser });
}

async function acceptInvitationMembership(invitation: NonNullable<Awaited<ReturnType<typeof loadInvitationByToken>>>, userId: string) {
  const farmAccessMode = invitation.farmAccessMode === "assigned" ? "assigned" : "all";
  const farmIds = [...new Set(Array.isArray(invitation.farmIds)
    ? invitation.farmIds.filter((farmId): farmId is string => typeof farmId === "string")
    : [])];
  const [membership] = await db.transaction(async (tx) => {
    const [savedMembership] = await tx.insert(workspaceMemberships).values({
      workspaceId: invitation.workspaceId,
      userId,
      role: invitation.role,
      active: true,
      permissions: invitation.permissions,
      farmAccessMode,
    }).onConflictDoUpdate({
      target: [workspaceMemberships.workspaceId, workspaceMemberships.userId],
      set: {
        role: invitation.role,
        active: true,
        permissions: invitation.permissions,
        farmAccessMode,
        updatedAt: new Date(),
      },
    }).returning();
    if (!savedMembership) throw new Error("Unable to save workspace membership.");
    await tx.delete(workspaceMemberFarms).where(eq(workspaceMemberFarms.membershipId, savedMembership.id));
    if (farmAccessMode === "assigned" && farmIds.length) {
      await tx.insert(workspaceMemberFarms).values(farmIds.map((farmId) => ({
        workspaceId: invitation.workspaceId,
        membershipId: savedMembership.id,
        farmId,
      })));
    }
    await tx.update(workspaceTeamInvitations)
      .set({ status: "accepted", acceptedBy: userId, acceptedAt: new Date(), updatedAt: new Date() })
      .where(eq(workspaceTeamInvitations.id, invitation.id));
    await tx.update(users).set({
      workspaceId: invitation.workspaceId,
    }).where(eq(users.id, userId));
    return [savedMembership];
  });
  await audit(invitation.workspaceId, userId, "workspace_invitation_accepted", membership.id, { invitationId: invitation.id, farmAccessMode, farmIds });
  return membership;
}

async function loadFarmAssignments(workspaceId: string, membershipIds: string[]) {
  if (!membershipIds.length) return new Map<string, string[]>();
  const assignments = await db.select({
    membershipId: workspaceMemberFarms.membershipId,
    farmId: workspaceMemberFarms.farmId,
  }).from(workspaceMemberFarms).where(and(
    eq(workspaceMemberFarms.workspaceId, workspaceId),
    inArray(workspaceMemberFarms.membershipId, membershipIds),
  ));
  const farmIdsByMembership = new Map<string, string[]>();
  for (const assignment of assignments) {
    const current = farmIdsByMembership.get(assignment.membershipId) ?? [];
    current.push(assignment.farmId);
    farmIdsByMembership.set(assignment.membershipId, current);
  }
  return farmIdsByMembership;
}

async function ensureAssignableFarms(workspaceId: string, farmIds: string[]) {
  if (!farmIds.length) return;
  const rows = await db.select({ id: farms.id }).from(farms).where(and(
    eq(farms.workspaceId, workspaceId),
    inArray(farms.id, [...new Set(farmIds)]),
    sql`${farms.deletedAt} IS NULL`,
    eq(farms.active, true),
  ));
  if (rows.length !== new Set(farmIds).size) {
    throw new Error("One or more selected farms are invalid, deleted, or outside this workspace.");
  }
}

export async function workspaceTeamRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/workspace/:workspaceId/team", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser) return reply;
    const params = workspaceParams.safeParse(request.params);
    const query = teamQuerySchema.safeParse(request.query);
    if (!params.success || !canViewTeam(request, params.data.workspaceId)) return reply.code(403).send({ message: "Workspace team view permission is required." });
    if (localDevelopmentMode) return { members: [], invitations: [], availableFarms: [], roleDefaults: roleModulePermissions };
    if (!query.success) return reply.code(400).send({ message: "A valid team query is required." });
    const members = await db.select({
      id: workspaceMemberships.id,
      userId: users.id,
      name: users.displayName,
      email: users.email,
      phone: users.phone,
      role: workspaceMemberships.role,
      active: workspaceMemberships.active,
      userActive: users.active,
      userStatus: users.status,
      permissions: workspaceMemberships.permissions,
      farmAccessMode: workspaceMemberships.farmAccessMode,
      lastActiveAt: sql<Date | null>`(SELECT max(created_at) FROM user_sessions WHERE user_sessions.user_id = ${users.id})`,
    }).from(workspaceMemberships).innerJoin(users, eq(users.id, workspaceMemberships.userId))
      .where(eq(workspaceMemberships.workspaceId, params.data.workspaceId)).orderBy(users.displayName, users.email);
    const farmIdsByMembership = await loadFarmAssignments(params.data.workspaceId, members.map((member) => member.id));
    const invitations = await db.select({
      id: workspaceTeamInvitations.id,
      email: workspaceTeamInvitations.email,
      phone: workspaceTeamInvitations.phone,
      role: workspaceTeamInvitations.role,
      farmAccessMode: workspaceTeamInvitations.farmAccessMode,
      farmIds: workspaceTeamInvitations.farmIds,
      status: workspaceTeamInvitations.status,
      expiresAt: workspaceTeamInvitations.expiresAt,
      createdAt: workspaceTeamInvitations.createdAt,
    }).from(workspaceTeamInvitations).where(and(
      eq(workspaceTeamInvitations.workspaceId, params.data.workspaceId),
      eq(workspaceTeamInvitations.status, "pending"),
    )).orderBy(desc(workspaceTeamInvitations.createdAt));
    const normalizedMembers = members.map((member) => ({
      ...member,
      displayName: member.name?.trim() || member.email || "Unnamed member",
      hasWorkspaceAccess: Boolean(member.active && member.userActive && member.userStatus === "approved"),
      farmAccessMode: member.farmAccessMode === "assigned" ? "assigned" : "all",
      farmIds: farmIdsByMembership.get(member.id) ?? [],
    }));
    const availableFarms = await db.select({ id: farms.id, name: farms.name }).from(farms).where(and(
      eq(farms.workspaceId, params.data.workspaceId),
      sql`${farms.deletedAt} IS NULL`,
      eq(farms.active, true),
    )).orderBy(farms.name);

    const debugEmail = query.data.debugEmail?.toLowerCase();
    const debugMember = debugEmail
      ? normalizedMembers.find((member) => member.email.toLowerCase() === debugEmail) ?? null
      : null;
    const debugInvitation = debugEmail
      ? invitations.find((invitation) => invitation.email.toLowerCase() === debugEmail) ?? null
      : null;

    return {
      members: normalizedMembers,
      invitations,
      availableFarms,
      roleDefaults: roleModulePermissions,
      diagnostics: debugEmail ? {
        email: debugEmail,
        workspaceId: params.data.workspaceId,
        member: debugMember ? {
          membershipId: debugMember.id,
          userId: debugMember.userId,
          role: debugMember.role,
          membershipActive: debugMember.active,
          userActive: debugMember.userActive,
          userStatus: debugMember.userStatus,
          hasWorkspaceAccess: debugMember.hasWorkspaceAccess,
        } : null,
        invitation: debugInvitation ? {
          invitationId: debugInvitation.id,
          status: debugInvitation.status,
          role: debugInvitation.role,
          expiresAt: debugInvitation.expiresAt,
        } : null,
      } : undefined,
    };
  });

  app.post("/v1/workspace/:workspaceId/team/invitations", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser) return reply;
    const params = workspaceParams.safeParse(request.params);
    const input = inviteSchema.safeParse(request.body);
    if (!params.success || !input.success) return reply.code(400).send({ message: "Valid invitation details are required." });
    if (!canManageTeam(request, params.data.workspaceId)) return reply.code(403).send({ message: "Only the workspace owner can invite team members." });
    if (localDevelopmentMode) return reply.code(503).send({ message: "Configure PostgreSQL to manage workspace invitations." });
    try {
      await ensureAssignableFarms(params.data.workspaceId, input.data.farmIds);
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : "Invalid farm assignments." });
    }
    const farmAccessMode: FarmAccessMode = input.data.role === "workspace_owner" ? "all" : input.data.farmAccessMode;
    const farmIds = farmAccessMode === "assigned" ? [...new Set(input.data.farmIds)] : [];
    const email = input.data.email.toLowerCase();
    const [existingUser] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existingUser) {
      const [existingMembership] = await db.select().from(workspaceMemberships).where(and(
        eq(workspaceMemberships.workspaceId, params.data.workspaceId),
        eq(workspaceMemberships.userId, existingUser.id),
      )).limit(1);
      if (existingMembership) {
        const [savedMembership] = await db.transaction(async (tx) => {
          const [membership] = await tx.update(workspaceMemberships).set({
            role: input.data.role,
            active: true,
            permissions: input.data.permissions ?? null,
            farmAccessMode,
            updatedAt: new Date(),
          }).where(eq(workspaceMemberships.id, existingMembership.id)).returning();
          if (!membership) return [];
          await tx.delete(workspaceMemberFarms).where(eq(workspaceMemberFarms.membershipId, existingMembership.id));
          if (farmAccessMode === "assigned" && farmIds.length) {
            await tx.insert(workspaceMemberFarms).values(farmIds.map((farmId) => ({
              workspaceId: params.data.workspaceId,
              membershipId: existingMembership.id,
              farmId,
            })));
          }
          return [membership];
        });
        await audit(params.data.workspaceId, request.appUser.id, "workspace_member_reinvited_updated", existingMembership.id, {
          email,
          role: input.data.role,
          farmAccessMode,
          farmIds,
        });
        return reply.code(200).send({
          memberAdded: true,
          alreadyHasAccess: true,
          membershipUpdated: true,
          membershipId: savedMembership?.id ?? existingMembership.id,
          emailSent: false,
          warning: "existing_membership_updated",
        });
      }
    }
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const [existingPending] = await db.select({ id: workspaceTeamInvitations.id }).from(workspaceTeamInvitations).where(and(
      eq(workspaceTeamInvitations.workspaceId, params.data.workspaceId),
      eq(workspaceTeamInvitations.email, email),
      eq(workspaceTeamInvitations.status, "pending"),
    )).orderBy(desc(workspaceTeamInvitations.createdAt)).limit(1);
    const [invitation] = existingPending
      ? await db.update(workspaceTeamInvitations).set({
        phone: optional(input.data.phone),
        role: input.data.role,
        permissions: input.data.permissions ?? null,
        farmAccessMode,
        farmIds,
        tokenHash: hashToken(token),
        invitedBy: request.appUser.id,
        expiresAt,
        updatedAt: new Date(),
      }).where(eq(workspaceTeamInvitations.id, existingPending.id))
        .returning({ id: workspaceTeamInvitations.id, email: workspaceTeamInvitations.email, expiresAt: workspaceTeamInvitations.expiresAt })
      : await db.insert(workspaceTeamInvitations).values({
        workspaceId: params.data.workspaceId,
        email,
        phone: optional(input.data.phone),
        role: input.data.role,
        permissions: input.data.permissions ?? null,
        farmAccessMode,
        farmIds,
        tokenHash: hashToken(token),
        invitedBy: request.appUser.id,
        expiresAt,
      }).returning({ id: workspaceTeamInvitations.id, email: workspaceTeamInvitations.email, expiresAt: workspaceTeamInvitations.expiresAt });
    await audit(params.data.workspaceId, request.appUser.id, "workspace_member_invited", invitation!.id, { email, role: input.data.role, farmAccessMode, farmIds });
    const invitationUrl = invitationUrlFor(request, token);
    const emailResult = await sendWorkspaceInvitationEmail({
      to: email,
      workspaceName: request.appUser.workspaceName ?? "Muzare Workspace",
      inviterName: request.appUser.displayName || request.appUser.email,
      inviterEmail: request.appUser.email,
      roleLabel: input.data.role,
      invitationUrl,
      expiresAt,
    });
    return reply.code(201).send({
      invitation,
      invitationToken: token,
      invitationUrl,
      memberAdded: false,
      alreadyHasAccess: false,
      emailSent: emailResult.sent,
      emailConfigured: emailResult.configured,
      warning: "warning" in emailResult ? emailResult.warning : null,
    });
  });

  app.get("/v1/workspace-invitations/lookup", async (request, reply) => {
    const query = invitationLookupQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ message: "A valid invitation token is required." });
    if (localDevelopmentMode) return reply.code(503).send({ message: "Configure PostgreSQL to inspect workspace invitations." });
    const invitation = await loadInvitationByToken(query.data.token);
    if (!invitation) return reply.code(404).send({ status: "invalid", message: "Invitation not found." });
    const now = new Date();
    const status = invitation.status !== "pending"
      ? invitation.status
      : invitation.expiresAt <= now
        ? "expired"
        : "pending";
    const [existingUser] = await db.select({ id: users.id }).from(users).where(eq(users.email, invitation.email)).limit(1);
    return {
      invitation: {
        workspaceId: invitation.workspaceId,
        workspaceName: invitation.workspaceName,
        email: invitation.email,
        phone: invitation.phone,
        role: invitation.role,
        permissions: invitation.permissions,
        farmAccessMode: invitation.farmAccessMode === "assigned" ? "assigned" : "all",
        farmIds: Array.isArray(invitation.farmIds) ? invitation.farmIds.filter((farmId): farmId is string => typeof farmId === "string") : [],
        status,
        expiresAt: invitation.expiresAt.toISOString(),
        acceptedAt: invitation.acceptedAt?.toISOString() ?? null,
        inviterName: invitation.inviterName,
        inviterEmail: invitation.inviterEmail,
        accountExists: Boolean(existingUser),
      },
    };
  });

  const acceptInvitationHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const input = acceptInvitationSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ message: "A valid invitation acceptance is required." });
    if (localDevelopmentMode) return reply.code(503).send({ message: "Configure PostgreSQL to accept workspace invitations." });
    const invitation = await loadInvitationByToken(input.data.token);
    if (!invitation) return reply.code(404).send({ code: "invalid", message: "Invitation is invalid." });
    if (invitation.status === "cancelled") return reply.code(409).send({ code: "cancelled", message: "This invitation was cancelled." });
    if (invitation.status === "accepted") return reply.code(409).send({ code: "accepted", message: "This invitation was already accepted." });
    if (invitation.expiresAt <= new Date()) return reply.code(410).send({ code: "expired", message: "This invitation has expired." });

    const authHeader = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    const authenticated = authHeader ? await authenticateToken(authHeader) : null;
    return respondToInvitationAcceptance(invitation, input.data, authenticated, reply);
  };

  app.post("/v1/workspace-invitations/accept", acceptInvitationHandler);
  app.post("/v1/workspace/team/invitations/accept", acceptInvitationHandler);
  app.post("/v1/workspace-invitations/register-and-accept", async (request, reply) => {
    const input = acceptInvitationSchema.safeParse({ ...(request.body as Record<string, unknown> ?? {}), mode: "signup" });
    if (!input.success) return reply.code(400).send({ message: "A valid invitation registration is required." });
    if (localDevelopmentMode) return reply.code(503).send({ message: "Configure PostgreSQL to accept workspace invitations." });
    const invitation = await loadInvitationByToken(input.data.token);
    if (!invitation) return reply.code(404).send({ code: "invalid", message: "Invitation is invalid." });
    if (invitation.status === "cancelled") return reply.code(409).send({ code: "cancelled", message: "This invitation was cancelled." });
    if (invitation.status === "accepted") return reply.code(409).send({ code: "accepted", message: "This invitation was already accepted." });
    if (invitation.expiresAt <= new Date()) return reply.code(410).send({ code: "expired", message: "This invitation has expired." });
    return respondToInvitationAcceptance(invitation, input.data, null, reply);
  });

  app.patch("/v1/workspace/:workspaceId/team/:membershipId", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser) return reply;
    const params = membershipParams.safeParse(request.params);
    const input = membershipUpdateSchema.safeParse(request.body);
    if (!params.success || !input.success) return reply.code(400).send({ message: "Valid member details are required." });
    if (!canManageTeam(request, params.data.workspaceId)) return reply.code(403).send({ message: "Only the workspace owner can update team members." });
    try {
      await ensureAssignableFarms(params.data.workspaceId, input.data.farmIds);
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : "Invalid farm assignments." });
    }
    const [existing] = await db.select().from(workspaceMemberships).where(and(eq(workspaceMemberships.id, params.data.membershipId), eq(workspaceMemberships.workspaceId, params.data.workspaceId))).limit(1);
    if (!existing) return reply.code(404).send({ message: "Workspace member not found." });
    if (existing.role === "workspace_owner" && (!input.data.active || input.data.role !== "workspace_owner") && await ownerCount(params.data.workspaceId, existing.id) === 0) {
      return reply.code(409).send({ message: "The last workspace owner cannot be deactivated or demoted." });
    }
    const farmAccessMode: FarmAccessMode = input.data.role === "workspace_owner" ? "all" : input.data.farmAccessMode;
    const farmIds = farmAccessMode === "assigned" ? [...new Set(input.data.farmIds)] : [];
    const [membership] = await db.transaction(async (tx) => {
      const [savedMembership] = await tx.update(workspaceMemberships).set({
        role: input.data.role,
        active: input.data.active,
        permissions: input.data.permissions ?? null,
        farmAccessMode,
        updatedAt: new Date(),
      }).where(and(eq(workspaceMemberships.id, existing.id), eq(workspaceMemberships.workspaceId, params.data.workspaceId))).returning();
      if (!savedMembership) return [];
      await tx.delete(workspaceMemberFarms).where(eq(workspaceMemberFarms.membershipId, existing.id));
      if (farmAccessMode === "assigned" && farmIds.length) {
        await tx.insert(workspaceMemberFarms).values(farmIds.map((farmId) => ({
          workspaceId: params.data.workspaceId,
          membershipId: existing.id,
          farmId,
        })));
      }
      return [savedMembership];
    });
    await audit(params.data.workspaceId, request.appUser.id, "workspace_member_updated", existing.id, { previous: existing, updated: membership });
    return { membership };
  });

  app.delete("/v1/workspace/:workspaceId/team/:membershipId", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser) return reply;
    const params = membershipParams.safeParse(request.params);
    if (!params.success || !canManageTeam(request, params.data.workspaceId)) return reply.code(403).send({ message: "Only the workspace owner can remove team members." });
    const [existing] = await db.select().from(workspaceMemberships).where(and(eq(workspaceMemberships.id, params.data.membershipId), eq(workspaceMemberships.workspaceId, params.data.workspaceId))).limit(1);
    if (!existing) return reply.code(204).send();
    if (existing.role === "workspace_owner" && await ownerCount(params.data.workspaceId, existing.id) === 0) return reply.code(409).send({ message: "The last workspace owner cannot be removed." });
    await db.delete(workspaceMemberships).where(and(eq(workspaceMemberships.id, existing.id), eq(workspaceMemberships.workspaceId, params.data.workspaceId)));
    await audit(params.data.workspaceId, request.appUser.id, "workspace_member_removed", existing.id, { userId: existing.userId, role: existing.role });
    return reply.code(204).send();
  });

  app.delete("/v1/workspace/:workspaceId/team/invitations/:invitationId", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser) return reply;
    const params = invitationParams.safeParse(request.params);
    if (!params.success || !canManageTeam(request, params.data.workspaceId)) return reply.code(403).send({ message: "Only the workspace owner can cancel invitations." });
    await db.update(workspaceTeamInvitations).set({ status: "cancelled", updatedAt: new Date() }).where(and(
      eq(workspaceTeamInvitations.id, params.data.invitationId),
      eq(workspaceTeamInvitations.workspaceId, params.data.workspaceId),
      eq(workspaceTeamInvitations.status, "pending"),
    ));
    return reply.code(204).send();
  });

  app.get("/v1/workspace/:workspaceId/team/:membershipId/activity", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser) return reply;
    const params = membershipParams.safeParse(request.params);
    if (!params.success || !canManageTeam(request, params.data.workspaceId)) return reply.code(403).send({ message: "Only the workspace owner can view member activity." });
    const [membership] = await db.select().from(workspaceMemberships).where(and(eq(workspaceMemberships.id, params.data.membershipId), eq(workspaceMemberships.workspaceId, params.data.workspaceId))).limit(1);
    if (!membership) return reply.code(404).send({ message: "Workspace member not found." });
    const activity = await db.select().from(auditLogs).where(and(eq(auditLogs.workspaceId, params.data.workspaceId), eq(auditLogs.userId, membership.userId))).orderBy(desc(auditLogs.createdAt)).limit(50);
    return { activity };
  });
}
