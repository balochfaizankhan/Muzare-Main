import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { requireAdmin, requirePermission } from "../auth.js";
import { localDevelopmentMode } from "../config.js";
import { db } from "../db/client.js";
import { auditLogs, farms, users, workspaceMemberships, workspaces } from "../db/schema.js";

const workspaceSchema = z.object({
  name: z.string().trim().min(2).max(120),
  contactEmail: z.string().email(),
  contactPhone: z.string().trim().max(40).optional(),
});
const workspaceIdSchema = z.object({ workspaceId: z.string().uuid() });
const workspaceStatusSchema = z.object({
  status: z.enum(["pending", "approved", "suspended", "rejected"]),
  note: z.string().trim().max(400).optional(),
});

export async function adminWorkspaceRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/admin/workspaces", { preHandler: requireAdmin }, async () => {
    if (localDevelopmentMode) return { workspaces: [] };
    const result = await db.execute(sql`
      SELECT
        w.id,
        w.name,
        w.slug,
        w.contact_email,
        w.contact_phone,
        w.status,
        w.created_at,
        w.approved_at,
        w.updated_at,
        owner.email AS owner_email,
        owner.display_name AS owner_name,
        COALESCE(member_counts.users_count, 0)::int AS users_count,
        COALESCE(farm_counts.farms_count, 0)::int AS farms_count
      FROM workspaces w
      LEFT JOIN LATERAL (
        SELECT u.email, u.display_name
        FROM workspace_memberships wm
        INNER JOIN users u ON u.id = wm.user_id
        WHERE wm.workspace_id = w.id AND wm.role = 'workspace_owner'
        ORDER BY wm.created_at ASC
        LIMIT 1
      ) owner ON true
      LEFT JOIN (
        SELECT wm.workspace_id, count(*) FILTER (WHERE wm.active = true AND u.active = true AND u.status = 'approved')::int AS users_count
        FROM workspace_memberships wm
        INNER JOIN users u ON u.id = wm.user_id
        GROUP BY wm.workspace_id
      ) member_counts ON member_counts.workspace_id = w.id
      LEFT JOIN (
        SELECT workspace_id, count(*) FILTER (WHERE active = true)::int AS farms_count
        FROM farms
        GROUP BY workspace_id
      ) farm_counts ON farm_counts.workspace_id = w.id
      ORDER BY w.created_at DESC
    `);
    return {
      workspaces: result.rows.map((row) => ({
        id: String(row.id),
        name: String(row.name),
        slug: String(row.slug),
        contactEmail: String(row.contact_email),
        contactPhone: row.contact_phone ? String(row.contact_phone) : null,
        ownerEmail: row.owner_email ? String(row.owner_email) : null,
        ownerName: row.owner_name ? String(row.owner_name) : null,
        status: String(row.status),
        createdAt: String(row.created_at),
        approvedAt: row.approved_at ? String(row.approved_at) : null,
        suspendedAt: row.status === "suspended" && row.updated_at ? String(row.updated_at) : null,
        usersCount: Number(row.users_count ?? 0),
        farmsCount: Number(row.farms_count ?? 0),
      })),
    };
  });

  app.get("/v1/admin/workspaces/:workspaceId", { preHandler: requireAdmin }, async (request, reply) => {
    if (localDevelopmentMode) return { workspace: null };
    const parsed = workspaceIdSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ message: "A valid workspace id is required." });
    const [workspace] = await db.select({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      contactEmail: workspaces.contactEmail,
      contactPhone: workspaces.contactPhone,
      status: workspaces.status,
      createdAt: workspaces.createdAt,
      approvedAt: workspaces.approvedAt,
      updatedAt: workspaces.updatedAt,
    }).from(workspaces).where(eq(workspaces.id, parsed.data.workspaceId)).limit(1);
    if (!workspace) return reply.code(404).send({ message: "Workspace not found." });

    const memberships = await db.select({
      id: workspaceMemberships.id,
      userId: workspaceMemberships.userId,
      role: workspaceMemberships.role,
      active: workspaceMemberships.active,
      userActive: users.active,
      userStatus: users.status,
      email: users.email,
      displayName: users.displayName,
    }).from(workspaceMemberships)
      .innerJoin(users, eq(users.id, workspaceMemberships.userId))
      .where(eq(workspaceMemberships.workspaceId, parsed.data.workspaceId))
      .orderBy(desc(workspaceMemberships.createdAt));

    const history = await db.select({
      id: auditLogs.id,
      action: auditLogs.action,
      entityType: auditLogs.entityType,
      entityId: auditLogs.entityId,
      details: auditLogs.details,
      createdAt: auditLogs.createdAt,
      actorName: users.displayName,
      actorEmail: users.email,
    }).from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.userId))
      .where(eq(auditLogs.workspaceId, parsed.data.workspaceId))
      .orderBy(desc(auditLogs.createdAt))
      .limit(30);

    return {
      workspace: {
        ...workspace,
        members: memberships.map((member) => ({
          ...member,
          displayName: member.displayName?.trim() || member.email || "Unnamed member",
          hasWorkspaceAccess: Boolean(member.active && member.userActive && member.userStatus === "approved"),
        })),
        history,
      },
    };
  });

  app.post("/v1/admin/workspaces", { preHandler: requirePermission("CREATE_WORKSPACE") }, async (request, reply) => {
    const parsed = workspaceSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "Valid workspace details are required." });
    if (localDevelopmentMode) return reply.code(201).send();
    const slug = `${parsed.data.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workspace"}-${randomBytes(3).toString("hex")}`;
    await db.insert(workspaces).values({ ...parsed.data, contactPhone: parsed.data.contactPhone || null, slug, status: "approved", approvedAt: new Date() });
    return reply.code(201).send();
  });

  app.post("/v1/admin/workspaces/:workspaceId/suspend", { preHandler: requirePermission("CREATE_WORKSPACE") }, async (request, reply) => {
    const parsed = workspaceIdSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ message: "A valid workspace id is required." });
    if (!localDevelopmentMode) await db.update(workspaces).set({ status: "suspended", updatedAt: new Date() }).where(eq(workspaces.id, parsed.data.workspaceId));
    return reply.code(204).send();
  });

  app.patch("/v1/admin/workspaces/:workspaceId/status", { preHandler: requirePermission("CREATE_WORKSPACE") }, async (request, reply) => {
    if (localDevelopmentMode) return reply.code(204).send();
    const params = workspaceIdSchema.safeParse(request.params);
    const body = workspaceStatusSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ message: "Valid workspace status details are required." });

    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, params.data.workspaceId)).limit(1);
    if (!workspace) return reply.code(404).send({ message: "Workspace not found." });

    const nextStatus = body.data.status;
    const updatePayload: Partial<typeof workspaces.$inferInsert> = {
      status: nextStatus,
      updatedAt: new Date(),
    };
    if (nextStatus === "approved") {
      updatePayload.approvedAt = new Date();
      updatePayload.approvedBy = request.appUser?.id;
    }
    await db.update(workspaces).set(updatePayload).where(eq(workspaces.id, params.data.workspaceId));
    await db.insert(auditLogs).values({
      workspaceId: params.data.workspaceId,
      userId: request.appUser?.id,
      action: `admin.workspace.status.${nextStatus}`,
      entityType: "workspace",
      entityId: params.data.workspaceId,
      details: {
        previousStatus: workspace.status,
        nextStatus,
        note: body.data.note ?? null,
      },
    });
    return reply.code(204).send();
  });

  app.delete("/v1/admin/workspaces/:workspaceId", { preHandler: requirePermission("DELETE_WORKSPACE") }, async (request, reply) => {
    const parsed = workspaceIdSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ message: "A valid workspace id is required." });
    if (localDevelopmentMode) return reply.code(204).send();
    const [result] = await db.select({ count: sql<number>`count(*)::int` }).from(farms).where(eq(farms.workspaceId, parsed.data.workspaceId));
    if (Number(result?.count) > 0) return reply.code(409).send({ message: "Suspend this workspace instead. Operational farm records must be archived before deletion." });
    await db.delete(workspaces).where(eq(workspaces.id, parsed.data.workspaceId));
    return reply.code(204).send();
  });
}
