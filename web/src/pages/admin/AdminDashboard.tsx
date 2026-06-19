import { Activity, AlertCircle, Building2, CheckCircle2, Clock3, ShieldAlert, UserRoundPlus, Users } from "lucide-react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthProvider";
import { fetchAdminOverview } from "../../lib/api";
import { formatDate, formatNumber } from "../../lib/format";

const actions = [
  ["/admin/approvals", "Pending approvals", UserRoundPlus],
  ["/admin/workspaces", "Review workspaces", Building2],
  ["/admin/users", "Review users", Users],
  ["/admin/audit-logs", "Audit logs", Activity],
] as const;

export function AdminDashboard() {
  const { token } = useAuth();
  const overview = useQuery({
    queryKey: ["admin-overview"],
    queryFn: () => fetchAdminOverview(token!),
    enabled: Boolean(token),
  });
  const data = overview.data;

  const metrics = [
    ["Total Users", data?.totalUsers ?? 0, Users],
    ["Active Users", data?.totalActiveUsers ?? 0, CheckCircle2],
    ["Total Workspaces", data?.totalWorkspaces ?? 0, Building2],
    ["Pending Workspaces", data?.pendingWorkspaceRequests ?? 0, Clock3],
    ["Active Workspaces", data?.approvedWorkspaces ?? 0, CheckCircle2],
    ["Suspended Workspaces", data?.suspendedWorkspaces ?? 0, ShieldAlert],
  ] as const;

  return <main className="shell-page">
    <section className="shell-page__intro">
      <span className="eyebrow">Platform overview</span>
      <h1>System Admin Dashboard</h1>
      <p>Track platform health, workspace lifecycle, and recent admin activity without entering farm operations.</p>
    </section>

    {overview.isError && <p className="error">{overview.error.message}</p>}

    <section className="admin-metric-grid">
      {metrics.map(([label, value, Icon]) => <article key={label}>
        <Icon size={19} />
        <span>{label}</span>
        <strong>{formatNumber(value)}</strong>
      </article>)}
    </section>

    <section className="shell-grid admin-shell-grid">
      <div className="panel">
        <div className="panel-heading">
          <div>
            <h2>Admin actions</h2>
            <p>Jump straight into the queues that need platform attention.</p>
          </div>
        </div>
        <div className="shell-actions">
          {actions.map(([to, label, Icon]) => <Link to={to} key={label}><Icon size={17} />{label}</Link>)}
        </div>
      </div>

      <div className="panel">
        <div className="panel-heading">
          <div>
            <h2>Pending approvals</h2>
            <p>Latest workspace requests waiting for a decision.</p>
          </div>
          <Link className="primary-link" to="/admin/approvals">Open approvals</Link>
        </div>
        {!data?.pendingWorkspaces.length ? <p className="activity-empty">No pending workspaces right now.</p> : <div className="admin-activity-list">
          {data.pendingWorkspaces.map((workspace) => <article key={workspace.id}>
            <div>
              <strong>{workspace.name}</strong>
              <span>{workspace.contactEmail}</span>
            </div>
            <small>{formatDate(workspace.createdAt, { dateStyle: "medium", timeStyle: "short" })}</small>
          </article>)}
        </div>}
      </div>
    </section>

    <section className="shell-grid admin-shell-grid">
      <div className="panel">
        <div className="panel-heading">
          <div>
            <h2>Recent workspaces</h2>
            <p>Newest workspaces created on the platform.</p>
          </div>
          <Link className="primary-link" to="/admin/workspaces">View all</Link>
        </div>
        {!data?.recentWorkspaces.length ? <p className="activity-empty">No workspaces have been created yet.</p> : <div className="admin-activity-list">
          {data.recentWorkspaces.map((workspace) => <article key={workspace.id}>
            <div>
              <strong>{workspace.name}</strong>
              <span>{workspace.contactEmail}</span>
            </div>
            <div className="admin-activity-list__meta">
              <span className={`status-badge status-badge--${workspace.status}`}>{workspace.status}</span>
              <small>{formatDate(workspace.createdAt, { dateStyle: "medium" })}</small>
            </div>
          </article>)}
        </div>}
      </div>

      <div className="panel">
        <div className="panel-heading">
          <div>
            <h2>Recent activity</h2>
            <p>Platform-level lifecycle actions and audit trail.</p>
          </div>
          <Link className="primary-link" to="/admin/audit-logs">Full audit log</Link>
        </div>
        {!data?.recentActivity.length ? <p className="activity-empty">No recent admin activity has been recorded yet.</p> : <div className="admin-activity-list">
          {data.recentActivity.map((item) => <article key={item.id}>
            <div>
              <strong>{humanizeAction(item.action)}</strong>
              <span>{item.workspaceName ?? item.entityType}</span>
            </div>
            <small>{item.actorName ?? "System"} • {formatDate(item.createdAt, { dateStyle: "medium", timeStyle: "short" })}</small>
          </article>)}
        </div>}
      </div>
    </section>

    <section className="shell-grid admin-shell-grid">
      <div className="panel">
        <div className="panel-heading">
          <div>
            <h2>Suspended workspaces</h2>
            <p>These workspaces are blocked for normal users until reactivated.</p>
          </div>
          <Link className="primary-link" to="/admin/suspended">Review suspended</Link>
        </div>
        {!data?.suspendedWorkspacesList.length ? <p className="activity-empty">No suspended workspaces right now.</p> : <div className="admin-activity-list">
          {data.suspendedWorkspacesList.map((workspace) => <article key={workspace.id}>
            <div>
              <strong>{workspace.name}</strong>
              <span>{workspace.contactEmail}</span>
            </div>
            <div className="admin-activity-list__meta">
              <span className="status-badge status-badge--suspended">Suspended</span>
              <small>{workspace.updatedAt ? formatDate(workspace.updatedAt, { dateStyle: "medium", timeStyle: "short" }) : "-"}</small>
            </div>
          </article>)}
        </div>}
      </div>

      <div className="panel admin-callout-panel">
        <AlertCircle size={20} />
        <div>
          <h2>Tenant safety</h2>
          <p>System admin views should stay at metadata and lifecycle level. Workspace operational records remain behind the normal tenant-scoped modules.</p>
        </div>
      </div>
    </section>
  </main>;
}

function humanizeAction(action: string) {
  return action
    .replace(/^admin\./, "")
    .replace(/[._]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
