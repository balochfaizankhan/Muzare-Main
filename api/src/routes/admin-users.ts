import type { FastifyInstance } from "fastify";
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { requireAdmin, requirePermission } from "../auth.js";
import { localDevelopmentMode } from "../config.js";
import { db } from "../db/client.js";
import { auditLogs } from "../db/schema.js";
import { userSessions, users, workspaceMemberships, workspaces } from "../db/schema.js";

const userIdSchema = z.object({ userId: z.string().uuid() });
const userStatusSchema = z.object({
  active: z.boolean(),
});

export async function adminUserRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/admin/users", { preHandler: requireAdmin }, async () => {
    if (localDevelopmentMode) return { users: [] };
    const result = await db.execute(sql`
      SELECT
        u.id,
        u.email,
        u.display_name,
        u.phone,
        u.platform_role,
        u.status,
        u.active,
        u.created_at,
        COALESCE(m.workspace_count, 0)::int AS workspace_count,
        s.last_login_at
      FROM users u
      LEFT JOIN (
        SELECT user_id, count(*) FILTER (WHERE active = true)::int AS workspace_count
        FROM workspace_memberships
        GROUP BY user_id
      ) m ON m.user_id = u.id
      LEFT JOIN (
        SELECT user_id, COALESCE(sum(duplicate_count), 0)::int AS duplicate_membership_count
        FROM (
          SELECT user_id, workspace_id, greatest(count(*) - 1, 0) AS duplicate_count
          FROM workspace_memberships
          GROUP BY user_id, workspace_id
          HAVING count(*) > 1
        ) grouped_duplicates
        GROUP BY user_id
      ) d ON d.user_id = u.id
      LEFT JOIN (
        SELECT user_id, max(created_at) AS last_login_at
        FROM user_sessions
        GROUP BY user_id
      ) s ON s.user_id = u.id
      ORDER BY u.created_at DESC
    `);
    return {
      users: result.rows.map((row) => ({
        id: String(row.id),
        email: String(row.email),
        displayName: row.display_name ? String(row.display_name) : null,
        phone: row.phone ? String(row.phone) : null,
        platformRole: row.platform_role ? String(row.platform_role) : null,
        status: String(row.status),
        active: Boolean(row.active),
        createdAt: String(row.created_at),
        workspaceCount: Number(row.workspace_count ?? 0),
        duplicateMembershipCount: Number(row.duplicate_membership_count ?? 0),
        lastLoginAt: row.last_login_at ? String(row.last_login_at) : null,
      })),
    };
  });

  app.get("/v1/admin/users/:userId", { preHandler: requireAdmin }, async (request, reply) => {
    if (localDevelopmentMode) return { user: null };
    const parsed = userIdSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ message: "A valid user id is required." });

    const [userRow] = await db.select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      phone: users.phone,
      platformRole: users.platformRole,
      status: users.status,
      active: users.active,
      approvedAt: users.approvedAt,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
    }).from(users).where(eq(users.id, parsed.data.userId)).limit(1);
    if (!userRow) return reply.code(404).send({ message: "User not found." });

    const memberships = await db.select({
      id: workspaceMemberships.id,
      workspaceId: workspaceMemberships.workspaceId,
      workspaceName: workspaces.name,
      role: workspaceMemberships.role,
      active: workspaceMemberships.active,
      permissions: workspaceMemberships.permissions,
      farmAccessMode: workspaceMemberships.farmAccessMode,
      createdAt: workspaceMemberships.createdAt,
    }).from(workspaceMemberships)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
      .where(eq(workspaceMemberships.userId, parsed.data.userId))
      .orderBy(desc(workspaceMemberships.createdAt));

    const duplicateMemberships = memberships.reduce<Record<string, number>>((accumulator, membership) => {
      accumulator[membership.workspaceId] = (accumulator[membership.workspaceId] ?? 0) + 1;
      return accumulator;
    }, {});

    const [lastLogin] = await db.select({ createdAt: userSessions.createdAt }).from(userSessions)
      .where(eq(userSessions.userId, parsed.data.userId))
      .orderBy(desc(userSessions.createdAt))
      .limit(1);

    return {
      user: {
        ...userRow,
        lastLoginAt: lastLogin?.createdAt ?? null,
        workspaces: memberships,
        duplicateMemberships: Object.entries(duplicateMemberships)
          .filter(([, count]) => count > 1)
          .map(([workspaceId, count]) => ({ workspaceId, count })),
      },
    };
  });

  app.patch("/v1/admin/users/:userId/status", { preHandler: requirePermission("CREATE_WORKSPACE") }, async (request, reply) => {
    if (localDevelopmentMode) return reply.code(204).send();
    const params = userIdSchema.safeParse(request.params);
    const body = userStatusSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ message: "Valid user status details are required." });

    const [userRow] = await db.select().from(users).where(eq(users.id, params.data.userId)).limit(1);
    if (!userRow) return reply.code(404).send({ message: "User not found." });

    const nextStatus = body.data.active ? "approved" : "suspended";

    await db.update(users).set({
      active: body.data.active,
      status: nextStatus,
      updatedAt: new Date(),
    }).where(eq(users.id, params.data.userId));

    const memberships = await db.select({ workspaceId: workspaceMemberships.workspaceId })
      .from(workspaceMemberships)
      .where(eq(workspaceMemberships.userId, params.data.userId));

    await Promise.all(memberships.map((membership) =>
      db.insert(auditLogs).values({
        workspaceId: membership.workspaceId,
        userId: request.appUser?.id,
        action: body.data.active ? "admin.user.reactivated" : "admin.user.suspended",
        entityType: "user",
        entityId: params.data.userId,
        details: {
          previousActive: userRow.active,
          nextActive: body.data.active,
          previousStatus: userRow.status,
          nextStatus,
        },
      }),
    ));

    return reply.code(204).send();
  });
}
