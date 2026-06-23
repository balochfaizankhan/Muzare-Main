import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { requireAdmin, requirePermission } from "../auth.js";
import { localDevelopmentMode } from "../config.js";
import { db } from "../db/client.js";
import { auditLogs, farmDeletionRequests, farms, userSessions, users, workspaceMemberships, workspaces } from "../db/schema.js";

const workspaceSchema = z.object({
  name: z.string().trim().min(2).max(120),
  contactEmail: z.string().email(),
  contactPhone: z.string().trim().max(40).optional(),
});
const workspaceIdSchema = z.object({ workspaceId: z.string().uuid() });
const farmIdSchema = z.object({ farmId: z.string().uuid() });
const requestIdSchema = z.object({ requestId: z.string().uuid() });
const workspaceStatusSchema = z.object({
  status: z.enum(["pending", "approved", "suspended", "rejected"]),
  note: z.string().trim().max(400).optional(),
});
const reviewSchema = z.object({ notes: z.string().trim().max(800).optional() });

async function adminFarmRows(workspaceId?: string) {
  const where = workspaceId ? sql`WHERE f.workspace_id = ${workspaceId}` : sql``;
  const result = await db.execute(sql`
    SELECT
      f.id,
      f.workspace_id,
      f.name,
      f.location,
      f.owner,
      f.active,
      f.deleted_at,
      f.created_at,
      w.name AS workspace_name,
      owner.email AS owner_email,
      COALESCE(record_counts.total_records, 0)::int AS total_records,
      COALESCE(record_counts.labour, 0)::int AS labour,
      COALESCE(record_counts.attendance, 0)::int AS attendance,
      COALESCE(record_counts.advances, 0)::int AS advances,
      COALESCE(record_counts.expenses, 0)::int AS expenses,
      COALESCE(record_counts.sales, 0)::int AS sales,
      COALESCE(record_counts.dispatch, 0)::int AS dispatch,
      pending.status AS deletion_request_status
    FROM farms f
    INNER JOIN workspaces w ON w.id = f.workspace_id
    LEFT JOIN LATERAL (
      SELECT u.email
      FROM workspace_memberships wm
      INNER JOIN users u ON u.id = wm.user_id
      WHERE wm.workspace_id = f.workspace_id AND wm.role = 'workspace_owner'
      ORDER BY wm.created_at ASC
      LIMIT 1
    ) owner ON true
    LEFT JOIN LATERAL (
      SELECT
        count(*)::int AS total_records,
        count(*) FILTER (WHERE entity_type IN ('labourer', 'labourGroup'))::int AS labour,
        count(*) FILTER (WHERE entity_type = 'attendance')::int AS attendance,
        count(*) FILTER (WHERE entity_type IN ('advance', 'labourPayment'))::int AS advances,
        count(*) FILTER (WHERE entity_type = 'voucher')::int AS expenses,
        count(*) FILTER (WHERE entity_type = 'sale')::int AS sales,
        count(*) FILTER (WHERE entity_type = 'dispatch')::int AS dispatch
      FROM operational_records r
      WHERE r.workspace_id = f.workspace_id AND r.farm_id = f.id
    ) record_counts ON true
    LEFT JOIN LATERAL (
      SELECT status
      FROM farm_deletion_requests fdr
      WHERE fdr.workspace_id = f.workspace_id AND fdr.farm_id = f.id AND fdr.status = 'pending'
      ORDER BY fdr.created_at DESC
      LIMIT 1
    ) pending ON true
    ${where}
    ORDER BY f.created_at DESC
  `);
  return result.rows.map((row) => ({
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    workspaceName: String(row.workspace_name),
    name: String(row.name),
    location: row.location ? String(row.location) : null,
    owner: row.owner ? String(row.owner) : null,
    ownerEmail: row.owner_email ? String(row.owner_email) : null,
    active: Boolean(row.active),
    status: row.deleted_at ? "deleted" : (row.deletion_request_status ? "delete_pending" : (row.active ? "active" : "archived")),
    createdAt: String(row.created_at),
    totalRecords: Number(row.total_records ?? 0),
    counts: {
      labour: Number(row.labour ?? 0),
      attendance: Number(row.attendance ?? 0),
      advances: Number(row.advances ?? 0),
      expenses: Number(row.expenses ?? 0),
      sales: Number(row.sales ?? 0),
      dispatch: Number(row.dispatch ?? 0),
    },
    deletionRequestStatus: row.deletion_request_status ? String(row.deletion_request_status) : null,
  }));
}

async function adminDeletionRequests(status = "pending") {
  const result = await db.execute(sql`
    SELECT
      fdr.id,
      fdr.workspace_id,
      fdr.farm_id,
      fdr.reason,
      fdr.record_counts_json,
      fdr.status,
      fdr.review_notes,
      fdr.created_at,
      fdr.reviewed_at,
      f.name AS farm_name,
      w.name AS workspace_name,
      requester.email AS requested_by_email,
      reviewer.email AS reviewed_by_email
    FROM farm_deletion_requests fdr
    INNER JOIN farms f ON f.id = fdr.farm_id
    INNER JOIN workspaces w ON w.id = fdr.workspace_id
    INNER JOIN users requester ON requester.id = fdr.requested_by
    LEFT JOIN users reviewer ON reviewer.id = fdr.reviewed_by
    WHERE ${status === "all" ? sql`true` : sql`fdr.status = ${status}`}
    ORDER BY fdr.created_at DESC
  `);
  return result.rows.map((row) => ({
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    farmId: String(row.farm_id),
    workspaceName: String(row.workspace_name),
    farmName: String(row.farm_name),
    requestedByEmail: String(row.requested_by_email),
    reason: row.reason ? String(row.reason) : null,
    recordCounts: row.record_counts_json ?? {},
    status: String(row.status),
    reviewedByEmail: row.reviewed_by_email ? String(row.reviewed_by_email) : null,
    reviewedAt: row.reviewed_at ? String(row.reviewed_at) : null,
    reviewNotes: row.review_notes ? String(row.review_notes) : null,
    createdAt: String(row.created_at),
  }));
}

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
        SELECT workspace_id, count(*) FILTER (WHERE active = true AND deleted_at IS NULL)::int AS farms_count
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
    const workspaceFarms = await adminFarmRows(parsed.data.workspaceId);
    const deletionRequests = (await adminDeletionRequests("all")).filter((item) => item.workspaceId === parsed.data.workspaceId);

    return {
      workspace: {
        ...workspace,
        members: memberships.map((member) => ({
          ...member,
          displayName: member.displayName?.trim() || member.email || "Unnamed member",
          hasWorkspaceAccess: Boolean(member.active && member.userActive && member.userStatus === "approved"),
        })),
        history,
        farms: workspaceFarms,
        deletionRequests,
      },
    };
  });

  app.get("/v1/admin/farms", { preHandler: requireAdmin }, async () => {
    if (localDevelopmentMode) return { farms: [], deletionRequests: [] };
    return { farms: await adminFarmRows(), deletionRequests: await adminDeletionRequests("pending") };
  });

  app.get("/v1/admin/farms/:farmId", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = farmIdSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ message: "A valid farm id is required." });
    const farmsList = await adminFarmRows();
    const farm = farmsList.find((item) => item.id === parsed.data.farmId);
    if (!farm) return reply.code(404).send({ message: "Farm not found." });
    const activity = await db.select({
      id: auditLogs.id,
      action: auditLogs.action,
      entityType: auditLogs.entityType,
      entityId: auditLogs.entityId,
      createdAt: auditLogs.createdAt,
      actorName: users.displayName,
      actorEmail: users.email,
      details: auditLogs.details,
    }).from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.userId))
      .where(eq(auditLogs.farmId, parsed.data.farmId))
      .orderBy(desc(auditLogs.createdAt))
      .limit(40);
    return { farm, activity };
  });

  app.get("/v1/admin/farm-deletion-requests", { preHandler: requireAdmin }, async () => {
    if (localDevelopmentMode) return { requests: [] };
    return { requests: await adminDeletionRequests("pending") };
  });

  app.post("/v1/admin/farm-deletion-requests/:requestId/reject", { preHandler: requirePermission("CREATE_WORKSPACE") }, async (request, reply) => {
    const params = requestIdSchema.safeParse(request.params);
    const body = reviewSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ message: "Valid review details are required." });
    const [requestRow] = await db.select().from(farmDeletionRequests).where(eq(farmDeletionRequests.id, params.data.requestId)).limit(1);
    if (!requestRow) return reply.code(404).send({ message: "Farm deletion request not found." });
    if (requestRow.status !== "pending") return reply.code(409).send({ message: "This farm deletion request has already been reviewed." });
    await db.transaction(async (tx) => {
      await tx.update(farmDeletionRequests).set({
        status: "rejected",
        reviewedBy: request.appUser?.id,
        reviewedAt: new Date(),
        reviewNotes: body.data.notes ?? null,
        updatedAt: new Date(),
      }).where(eq(farmDeletionRequests.id, params.data.requestId));
      await tx.update(farms).set({ active: true, updatedAt: new Date() }).where(and(eq(farms.id, requestRow.farmId), eq(farms.workspaceId, requestRow.workspaceId)));
      await tx.insert(auditLogs).values({
        workspaceId: requestRow.workspaceId,
        farmId: requestRow.farmId,
        userId: request.appUser?.id,
        actorUserId: request.appUser?.id,
        action: "farm.delete.rejected",
        entityType: "farm_deletion_request",
        entityId: requestRow.id,
        notes: body.data.notes ?? null,
        details: { requestId: requestRow.id },
      });
    });
    return reply.code(204).send();
  });

  app.post("/v1/admin/farm-deletion-requests/:requestId/approve", { preHandler: requirePermission("CREATE_WORKSPACE") }, async (request, reply) => {
    const params = requestIdSchema.safeParse(request.params);
    const body = reviewSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ message: "Valid review details are required." });
    const [requestRow] = await db.select().from(farmDeletionRequests).where(eq(farmDeletionRequests.id, params.data.requestId)).limit(1);
    if (!requestRow) return reply.code(404).send({ message: "Farm deletion request not found." });
    if (requestRow.status !== "pending") return reply.code(409).send({ message: "This farm deletion request has already been reviewed." });
    const [farm] = await db.select().from(farms).where(and(eq(farms.id, requestRow.farmId), eq(farms.workspaceId, requestRow.workspaceId))).limit(1);
    const reviewedAt = new Date();
    await db.transaction(async (tx) => {
      await tx.update(farmDeletionRequests).set({
        status: "approved",
        reviewedBy: request.appUser?.id,
        reviewedAt,
        reviewNotes: body.data.notes ?? null,
        updatedAt: reviewedAt,
      }).where(eq(farmDeletionRequests.id, params.data.requestId));
      await tx.update(farms).set({
        active: false,
        deletedAt: reviewedAt,
        deletedBy: request.appUser?.id,
        deletionApprovedAt: reviewedAt,
        deletionApprovedBy: request.appUser?.id,
        updatedAt: reviewedAt,
      }).where(and(eq(farms.id, requestRow.farmId), eq(farms.workspaceId, requestRow.workspaceId)));
      await tx.update(userSessions).set({ activeFarmId: null, activeSeasonId: null })
        .where(and(eq(userSessions.workspaceId, requestRow.workspaceId), eq(userSessions.activeFarmId, requestRow.farmId)));
      await tx.insert(auditLogs).values({
        workspaceId: requestRow.workspaceId,
        farmId: requestRow.farmId,
        userId: request.appUser?.id,
        actorUserId: request.appUser?.id,
        action: "farm.delete.approved",
        entityType: "farm_deletion_request",
        entityId: requestRow.id,
        beforeJson: farm ?? null,
        afterJson: { status: "deleted", deletedAt: reviewedAt.toISOString(), deletionApprovedBy: request.appUser?.id },
        notes: body.data.notes ?? null,
        details: { requestId: requestRow.id, recordCounts: requestRow.recordCountsJson },
      });
    });
    return reply.code(204).send();
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
