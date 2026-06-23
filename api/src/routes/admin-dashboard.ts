import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { requireAdmin } from "../auth.js";
import { localDevelopmentMode } from "../config.js";
import { db } from "../db/client.js";

export async function adminDashboardRoutes(app: FastifyInstance): Promise<void> {
  const getOverview = async () => {
    if (localDevelopmentMode) {
      return {
        totalWorkspaces: 3,
        activeWorkspaces: 2,
        approvedWorkspaces: 2,
        suspendedWorkspaces: 0,
        pendingWorkspaceRequests: 1,
        rejectedWorkspaces: 0,
        totalUsers: 4,
        totalActiveUsers: 3,
        totalFarms: 0,
        pendingFarmDeletionRequests: 0,
        subscriptionRevenue: 0,
        expiringSubscriptions: 0,
        systemHealth: "Healthy",
        recentWorkspaces: [],
        pendingWorkspaces: [],
        suspendedWorkspacesList: [],
        recentActivity: [],
      };
    }
    const result = await db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM workspaces) AS total_workspaces,
        (SELECT count(*)::int FROM workspaces WHERE status = 'approved') AS approved_workspaces,
        (SELECT count(*)::int FROM workspaces WHERE status = 'approved') AS active_workspaces,
        (SELECT count(*)::int FROM workspaces WHERE status = 'suspended') AS suspended_workspaces,
        (SELECT count(*)::int FROM workspaces WHERE status = 'pending') AS pending_workspace_requests,
        (SELECT count(*)::int FROM workspaces WHERE status = 'rejected') AS rejected_workspaces,
        (SELECT count(*)::int FROM users) AS total_users,
        (SELECT count(*)::int FROM users WHERE active = true AND status = 'approved') AS total_active_users,
        (SELECT count(*)::int FROM farms) AS total_farms,
        (SELECT count(*)::int FROM farm_deletion_requests WHERE status = 'pending') AS pending_farm_deletion_requests,
        (SELECT COALESCE(sum(amount), 0)::numeric FROM billing_invoices WHERE status = 'paid') AS subscription_revenue,
        (SELECT count(*)::int FROM workspace_subscriptions
          WHERE status IN ('trial', 'active') AND expires_at <= now() + interval '30 days') AS expiring_subscriptions
    `);
    const row = result.rows[0] as Record<string, string | number>;
    const recentWorkspacesResult = await db.execute(sql`
      SELECT id, name, contact_email, status, created_at, approved_at, updated_at
      FROM workspaces
      ORDER BY created_at DESC
      LIMIT 8
    `);
    const recentActivityResult = await db.execute(sql`
      SELECT
        a.id,
        a.action,
        a.entity_type,
        a.entity_id,
        a.created_at,
        w.name AS workspace_name,
        u.display_name,
        u.email
      FROM audit_logs a
      LEFT JOIN workspaces w ON w.id = a.workspace_id
      LEFT JOIN users u ON u.id = a.user_id
      ORDER BY a.created_at DESC
      LIMIT 12
    `);
    const recentWorkspaces = recentWorkspacesResult.rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      contactEmail: String(row.contact_email),
      status: String(row.status),
      createdAt: String(row.created_at),
      approvedAt: row.approved_at ? String(row.approved_at) : null,
      updatedAt: row.updated_at ? String(row.updated_at) : null,
    }));
    return {
      totalWorkspaces: Number(row.total_workspaces), activeWorkspaces: Number(row.active_workspaces),
      approvedWorkspaces: Number(row.approved_workspaces),
      suspendedWorkspaces: Number(row.suspended_workspaces), pendingWorkspaceRequests: Number(row.pending_workspace_requests),
      rejectedWorkspaces: Number(row.rejected_workspaces),
      totalUsers: Number(row.total_users), totalActiveUsers: Number(row.total_active_users),
      totalFarms: Number(row.total_farms), pendingFarmDeletionRequests: Number(row.pending_farm_deletion_requests),
      subscriptionRevenue: Number(row.subscription_revenue), expiringSubscriptions: Number(row.expiring_subscriptions),
      systemHealth: "Healthy",
      recentWorkspaces,
      pendingWorkspaces: recentWorkspaces.filter((workspace) => workspace.status === "pending"),
      suspendedWorkspacesList: recentWorkspaces.filter((workspace) => workspace.status === "suspended"),
      recentActivity: recentActivityResult.rows.map((activity) => ({
        id: String(activity.id),
        action: String(activity.action),
        entityType: String(activity.entity_type),
        entityId: activity.entity_id ? String(activity.entity_id) : null,
        workspaceName: activity.workspace_name ? String(activity.workspace_name) : null,
        actorName: activity.display_name ? String(activity.display_name) : (activity.email ? String(activity.email) : null),
        createdAt: String(activity.created_at),
      })),
    };
  };

  app.get("/v1/admin/dashboard", { preHandler: requireAdmin }, getOverview);
  app.get("/v1/admin/overview", { preHandler: requireAdmin }, getOverview);
  app.get("/v1/admin/audit-logs", { preHandler: requireAdmin }, async () => {
    if (localDevelopmentMode) return { records: [] };
    const result = await db.execute(sql`
      SELECT
        a.id,
        a.action,
        a.entity_type,
        a.entity_id,
        a.created_at,
        a.details,
        w.name AS workspace_name,
        u.display_name,
        u.email
      FROM audit_logs a
      LEFT JOIN workspaces w ON w.id = a.workspace_id
      LEFT JOIN users u ON u.id = a.user_id
      ORDER BY a.created_at DESC
      LIMIT 100
    `);
    return {
      records: result.rows.map((row) => ({
        id: String(row.id),
        action: String(row.action),
        entityType: String(row.entity_type),
        entityId: row.entity_id ? String(row.entity_id) : null,
        createdAt: String(row.created_at),
        workspaceName: row.workspace_name ? String(row.workspace_name) : null,
        actorName: row.display_name ? String(row.display_name) : (row.email ? String(row.email) : null),
        details: row.details ?? null,
      })),
    };
  });
}
