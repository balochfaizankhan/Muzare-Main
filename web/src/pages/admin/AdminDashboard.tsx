import { Activity, AlertCircle, Building2, CheckCircle2, Clock3, LandPlot, ShieldAlert, UserRoundPlus, Users } from "lucide-react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useEffect } from "react";
import { useAuth } from "../../auth/AuthProvider";
import { fetchAdminOverview } from "../../lib/api";
import { formatDate, formatNumber } from "../../lib/format";
import i18n from "../../i18n";
import { markStartup } from "../../lib/startupPerf";

const actions = [
  ["/admin/approvals", "adminOverview.actions.pendingApprovals", UserRoundPlus],
  ["/admin/workspaces", "adminOverview.actions.reviewWorkspaces", Building2],
  ["/admin/farms", "adminOverview.actions.reviewFarms", LandPlot],
  ["/admin/users", "adminOverview.actions.reviewUsers", Users],
  ["/admin/audit-logs", "adminOverview.actions.auditLogs", Activity],
] as const;

export function AdminDashboard() {
  const { t } = useTranslation();
  const { token, user } = useAuth();
  const overview = useQuery({
    queryKey: ["admin-overview"],
    queryFn: () => fetchAdminOverview(token!),
    enabled: Boolean(token),
  });
  useEffect(() => {
    if (overview.isSuccess) {
      markStartup("admin-overview-ready", { workspaceId: user?.workspaceId ?? null });
    }
  }, [overview.isSuccess, user?.workspaceId]);
  const data = overview.data;

  const metrics = [
    [t("adminOverview.metrics.totalUsers"), data?.totalUsers ?? 0, Users],
    [t("adminOverview.metrics.activeUsers"), data?.totalActiveUsers ?? 0, CheckCircle2],
    [t("adminOverview.metrics.totalWorkspaces"), data?.totalWorkspaces ?? 0, Building2],
    [t("adminOverview.metrics.pendingWorkspaces"), data?.pendingWorkspaceRequests ?? 0, Clock3],
    [t("adminOverview.metrics.activeWorkspaces"), data?.approvedWorkspaces ?? 0, CheckCircle2],
    [t("adminOverview.metrics.suspendedWorkspaces"), data?.suspendedWorkspaces ?? 0, ShieldAlert],
    [t("adminOverview.metrics.totalFarms"), data?.totalFarms ?? 0, LandPlot],
    [t("adminOverview.metrics.pendingFarmDeletionRequests"), data?.pendingFarmDeletionRequests ?? 0, ShieldAlert],
  ] as const;

  return <main className="shell-page">
    <section className="shell-page__intro">
      <span className="eyebrow">{t("adminOverview.eyebrow")}</span>
      <h1>{t("adminOverview.title")}</h1>
      <p>{t("adminOverview.description")}</p>
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
            <h2>{t("adminOverview.adminActions")}</h2>
            <p>{t("adminOverview.adminActionsDescription")}</p>
          </div>
        </div>
        <div className="shell-actions">
          {actions.map(([to, label, Icon]) => <Link to={to} key={label}><Icon size={17} />{t(label)}</Link>)}
        </div>
      </div>

      <div className="panel">
        <div className="panel-heading">
          <div>
            <h2>{t("adminOverview.pendingApprovals")}</h2>
            <p>{t("adminOverview.pendingApprovalsDescription")}</p>
          </div>
          <Link className="primary-link" to="/admin/approvals">{t("adminOverview.openApprovals")}</Link>
        </div>
        {!data?.pendingWorkspaces.length ? <p className="activity-empty">{t("adminOverview.noPendingWorkspaces")}</p> : <div className="admin-activity-list">
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
            <h2>{t("adminOverview.recentWorkspaces")}</h2>
            <p>{t("adminOverview.recentWorkspacesDescription")}</p>
          </div>
          <Link className="primary-link" to="/admin/workspaces">{t("common.viewAll")}</Link>
        </div>
        {!data?.recentWorkspaces.length ? <p className="activity-empty">{t("adminOverview.noWorkspacesYet")}</p> : <div className="admin-activity-list">
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
            <h2>{t("adminOverview.recentActivity")}</h2>
            <p>{t("adminOverview.recentActivityDescription")}</p>
          </div>
          <Link className="primary-link" to="/admin/audit-logs">{t("adminOverview.fullAuditLog")}</Link>
        </div>
        {!data?.recentActivity.length ? <p className="activity-empty">{t("adminOverview.noRecentActivity")}</p> : <div className="admin-activity-list">
          {data.recentActivity.map((item) => <article key={item.id}>
            <div>
              <strong>{humanizeAction(item.action)}</strong>
              <span>{item.workspaceName ?? item.entityType}</span>
            </div>
            <small>{item.actorName ?? t("common.system")} • {formatDate(item.createdAt, { dateStyle: "medium", timeStyle: "short" })}</small>
          </article>)}
        </div>}
      </div>
    </section>

    <section className="shell-grid admin-shell-grid">
      <div className="panel">
        <div className="panel-heading">
          <div>
            <h2>{t("adminOverview.suspendedWorkspaces")}</h2>
            <p>{t("adminOverview.suspendedWorkspacesDescription")}</p>
          </div>
          <Link className="primary-link" to="/admin/suspended">{t("adminOverview.reviewSuspended")}</Link>
        </div>
        {!data?.suspendedWorkspacesList.length ? <p className="activity-empty">{t("adminOverview.noSuspendedWorkspaces")}</p> : <div className="admin-activity-list">
          {data.suspendedWorkspacesList.map((workspace) => <article key={workspace.id}>
            <div>
              <strong>{workspace.name}</strong>
              <span>{workspace.contactEmail}</span>
            </div>
            <div className="admin-activity-list__meta">
              <span className="status-badge status-badge--suspended">{t("common.suspended")}</span>
              <small>{workspace.updatedAt ? formatDate(workspace.updatedAt, { dateStyle: "medium", timeStyle: "short" }) : "-"}</small>
            </div>
          </article>)}
        </div>}
      </div>

      <div className="panel admin-callout-panel">
        <AlertCircle size={20} />
        <div>
          <h2>{t("adminOverview.tenantSafety")}</h2>
          <p>{t("adminOverview.tenantSafetyDescription")}</p>
        </div>
      </div>
    </section>
  </main>;
}

function humanizeAction(action: string) {
  const normalized = action
    .replace(/^admin\./, "")
    .replace(/[._]+/g, " ")
    .trim();
  return i18n.t(`adminAudit.actions.${normalized.replace(/\s+/g, "_")}`, {
    defaultValue: normalized.replace(/\b\w/g, (letter) => letter.toUpperCase()),
  });
}
