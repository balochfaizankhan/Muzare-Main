import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { requireAdmin } from "../auth.js";
import { localDevelopmentMode } from "../config.js";
import { db } from "../db/client.js";

export async function adminDashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/admin/dashboard", { preHandler: requireAdmin }, async () => {
    if (localDevelopmentMode) {
      return {
        totalWorkspaces: 3, activeWorkspaces: 2, suspendedWorkspaces: 0, pendingWorkspaceRequests: 1,
        totalUsers: 4, totalActiveUsers: 3, subscriptionRevenue: 0, expiringSubscriptions: 0, systemHealth: "Healthy",
      };
    }
    const result = await db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM workspaces) AS total_workspaces,
        (SELECT count(*)::int FROM workspaces WHERE status = 'approved') AS active_workspaces,
        (SELECT count(*)::int FROM workspaces WHERE status = 'suspended') AS suspended_workspaces,
        (SELECT count(*)::int FROM workspaces WHERE status = 'pending') AS pending_workspace_requests,
        (SELECT count(*)::int FROM users) AS total_users,
        (SELECT count(*)::int FROM users WHERE active = true AND status = 'approved') AS total_active_users,
        (SELECT COALESCE(sum(amount), 0)::numeric FROM billing_invoices WHERE status = 'paid') AS subscription_revenue,
        (SELECT count(*)::int FROM workspace_subscriptions
          WHERE status IN ('trial', 'active') AND expires_at <= now() + interval '30 days') AS expiring_subscriptions
    `);
    const row = result.rows[0] as Record<string, string | number>;
    return {
      totalWorkspaces: Number(row.total_workspaces), activeWorkspaces: Number(row.active_workspaces),
      suspendedWorkspaces: Number(row.suspended_workspaces), pendingWorkspaceRequests: Number(row.pending_workspace_requests),
      totalUsers: Number(row.total_users), totalActiveUsers: Number(row.total_active_users),
      subscriptionRevenue: Number(row.subscription_revenue), expiringSubscriptions: Number(row.expiring_subscriptions),
      systemHealth: "Healthy",
    };
  });
}
