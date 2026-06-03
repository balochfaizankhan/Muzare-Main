import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, desc, eq, gt, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { hashPassword, requireUser } from "../auth.js";
import { localDevelopmentMode } from "../config.js";
import { db } from "../db/client.js";
import { auditLogs, users, workspaceMemberships, workspaceTeamInvitations } from "../db/schema.js";
import {
  hasModulePermission,
  roleModulePermissions,
  workspaceModuleActions,
  workspaceModules,
  workspaceRoles,
  type WorkspaceModulePermissions,
} from "../permissions.js";

const workspaceParams = z.object({ workspaceId: z.string().uuid() });
const membershipParams = workspaceParams.extend({ membershipId: z.string().uuid() });
const invitationParams = workspaceParams.extend({ invitationId: z.string().uuid() });
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
const inviteSchema = z.object({
  email: z.string().trim().email(),
  phone: z.string().trim().max(40).optional().nullable(),
  role: roleSchema.default("viewer"),
  permissions: permissionSchema,
});
const membershipUpdateSchema = z.object({
  role: roleSchema,
  active: z.boolean(),
  permissions: permissionSchema,
});
const acceptInvitationSchema = z.object({
  token: z.string().min(20),
  displayName: z.string().trim().min(2).max(120),
  password: z.string().min(8).max(128),
  phone: z.string().trim().max(40).optional().nullable(),
});

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const optional = (value: string | null | undefined) => value?.trim() || null;

function membershipFor(request: FastifyRequest, workspaceId: string) {
  if (request.appUser?.workspaceId !== workspaceId) return null;
  return request.appUser.memberships.find((membership) => membership.active && membership.workspaceId === workspaceId) ?? null;
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

export async function workspaceTeamRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/workspace/:workspaceId/team", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser) return reply;
    const params = workspaceParams.safeParse(request.params);
    if (!params.success || !canViewTeam(request, params.data.workspaceId)) return reply.code(403).send({ message: "Workspace team view permission is required." });
    if (localDevelopmentMode) return { members: [], invitations: [], roleDefaults: roleModulePermissions };
    const members = await db.select({
      id: workspaceMemberships.id,
      userId: users.id,
      name: users.displayName,
      email: users.email,
      phone: users.phone,
      role: workspaceMemberships.role,
      active: workspaceMemberships.active,
      permissions: workspaceMemberships.permissions,
      lastActiveAt: sql<Date | null>`(SELECT max(created_at) FROM user_sessions WHERE user_sessions.user_id = ${users.id})`,
    }).from(workspaceMemberships).innerJoin(users, eq(users.id, workspaceMemberships.userId))
      .where(eq(workspaceMemberships.workspaceId, params.data.workspaceId)).orderBy(users.displayName, users.email);
    const invitations = await db.select({
      id: workspaceTeamInvitations.id,
      email: workspaceTeamInvitations.email,
      phone: workspaceTeamInvitations.phone,
      role: workspaceTeamInvitations.role,
      status: workspaceTeamInvitations.status,
      expiresAt: workspaceTeamInvitations.expiresAt,
      createdAt: workspaceTeamInvitations.createdAt,
    }).from(workspaceTeamInvitations).where(and(
      eq(workspaceTeamInvitations.workspaceId, params.data.workspaceId),
      eq(workspaceTeamInvitations.status, "pending"),
    )).orderBy(desc(workspaceTeamInvitations.createdAt));
    return { members, invitations, roleDefaults: roleModulePermissions };
  });

  app.post("/v1/workspace/:workspaceId/team/invitations", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser) return reply;
    const params = workspaceParams.safeParse(request.params);
    const input = inviteSchema.safeParse(request.body);
    if (!params.success || !input.success) return reply.code(400).send({ message: "Valid invitation details are required." });
    if (!canManageTeam(request, params.data.workspaceId)) return reply.code(403).send({ message: "Only the workspace owner can invite team members." });
    if (localDevelopmentMode) return reply.code(503).send({ message: "Configure PostgreSQL to manage workspace invitations." });
    const email = input.data.email.toLowerCase();
    const [existingUser] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existingUser) {
      const [membership] = await db.insert(workspaceMemberships).values({
        workspaceId: params.data.workspaceId, userId: existingUser.id, role: input.data.role, active: true, permissions: input.data.permissions ?? null,
      }).onConflictDoUpdate({
        target: [workspaceMemberships.workspaceId, workspaceMemberships.userId],
        set: { role: input.data.role, active: true, permissions: input.data.permissions ?? null, updatedAt: new Date() },
      }).returning();
      await audit(params.data.workspaceId, request.appUser.id, "workspace_member_added", membership!.id, { userId: existingUser.id, email, role: input.data.role });
      return reply.code(201).send({ membership, memberAdded: true });
    }
    const token = randomBytes(32).toString("base64url");
    const [invitation] = await db.insert(workspaceTeamInvitations).values({
      workspaceId: params.data.workspaceId,
      email,
      phone: optional(input.data.phone),
      role: input.data.role,
      permissions: input.data.permissions ?? null,
      tokenHash: hashToken(token),
      invitedBy: request.appUser.id,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    }).returning({ id: workspaceTeamInvitations.id, email: workspaceTeamInvitations.email, expiresAt: workspaceTeamInvitations.expiresAt });
    await audit(params.data.workspaceId, request.appUser.id, "workspace_member_invited", invitation!.id, { email, role: input.data.role });
    return reply.code(201).send({ invitation, invitationToken: token, memberAdded: false });
  });

  app.post("/v1/workspace/team/invitations/accept", async (request, reply) => {
    const input = acceptInvitationSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ message: "A valid invitation acceptance is required." });
    if (localDevelopmentMode) return reply.code(503).send({ message: "Configure PostgreSQL to accept workspace invitations." });
    const [invitation] = await db.select().from(workspaceTeamInvitations).where(and(
      eq(workspaceTeamInvitations.tokenHash, hashToken(input.data.token)),
      eq(workspaceTeamInvitations.status, "pending"),
      gt(workspaceTeamInvitations.expiresAt, new Date()),
    )).limit(1);
    if (!invitation) return reply.code(404).send({ message: "Invitation is invalid or expired." });
    const [existingUser] = await db.select().from(users).where(eq(users.email, invitation.email)).limit(1);
    const user = existingUser ?? (await db.insert(users).values({
      email: invitation.email,
      phone: optional(input.data.phone) ?? invitation.phone,
      displayName: input.data.displayName,
      passwordHash: await hashPassword(input.data.password),
      status: "approved",
      active: true,
      approvedAt: new Date(),
    }).returning())[0];
    if (!user) return reply.code(500).send({ message: "Unable to create invited user." });
    const [membership] = await db.insert(workspaceMemberships).values({
      workspaceId: invitation.workspaceId, userId: user.id, role: invitation.role, active: true, permissions: invitation.permissions,
    }).onConflictDoUpdate({
      target: [workspaceMemberships.workspaceId, workspaceMemberships.userId],
      set: { role: invitation.role, active: true, permissions: invitation.permissions, updatedAt: new Date() },
    }).returning();
    await db.update(workspaceTeamInvitations).set({ status: "accepted", acceptedBy: user.id, acceptedAt: new Date(), updatedAt: new Date() }).where(eq(workspaceTeamInvitations.id, invitation.id));
    await audit(invitation.workspaceId, user.id, "workspace_invitation_accepted", membership!.id, { invitationId: invitation.id });
    return reply.code(201).send({ workspaceId: invitation.workspaceId });
  });

  app.patch("/v1/workspace/:workspaceId/team/:membershipId", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser) return reply;
    const params = membershipParams.safeParse(request.params);
    const input = membershipUpdateSchema.safeParse(request.body);
    if (!params.success || !input.success) return reply.code(400).send({ message: "Valid member details are required." });
    if (!canManageTeam(request, params.data.workspaceId)) return reply.code(403).send({ message: "Only the workspace owner can update team members." });
    const [existing] = await db.select().from(workspaceMemberships).where(and(eq(workspaceMemberships.id, params.data.membershipId), eq(workspaceMemberships.workspaceId, params.data.workspaceId))).limit(1);
    if (!existing) return reply.code(404).send({ message: "Workspace member not found." });
    if (existing.role === "workspace_owner" && (!input.data.active || input.data.role !== "workspace_owner") && await ownerCount(params.data.workspaceId, existing.id) === 0) {
      return reply.code(409).send({ message: "The last workspace owner cannot be deactivated or demoted." });
    }
    const [membership] = await db.update(workspaceMemberships).set({ ...input.data, permissions: input.data.permissions ?? null, updatedAt: new Date() })
      .where(and(eq(workspaceMemberships.id, existing.id), eq(workspaceMemberships.workspaceId, params.data.workspaceId))).returning();
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
