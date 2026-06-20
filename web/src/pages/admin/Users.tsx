import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, ShieldCheck, UserX, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../auth/AuthProvider";
import { fetchAdminUser, fetchAdminUsers, updateAdminUserStatus } from "../../lib/api";
import { formatDate, formatNumber } from "../../lib/format";

export function Users() {
  const { t } = useTranslation();
  const { user, token } = useAuth();
  const canManage = user?.platformRole === "platform_admin";
  const client = useQueryClient();
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["admin-users"],
    queryFn: () => fetchAdminUsers(token!),
    enabled: Boolean(token),
  });
  const detail = useQuery({
    queryKey: ["admin-user", selectedUserId],
    queryFn: () => fetchAdminUser(token!, selectedUserId!),
    enabled: Boolean(token && selectedUserId),
  });
  const changeStatus = useMutation({
    mutationFn: ({ userId, active }: { userId: string; active: boolean }) => updateAdminUserStatus(token!, userId, { active }),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ["admin-users"] }),
        client.invalidateQueries({ queryKey: ["admin-user", selectedUserId] }),
        client.invalidateQueries({ queryKey: ["admin-overview"] }),
      ]);
    },
  });

  const users = query.data?.users ?? [];
  const activeUsers = users.filter((item) => item.active).length;

  return <main className="shell-page">
    <section className="shell-page__intro">
      <span className="eyebrow">{t("layout.platformAdministrationEyebrow")}</span>
      <h1>{t("adminUsers.title")}</h1>
      <p>{t("adminUsers.description")}</p>
    </section>

    <section className="admin-metric-grid">
      <article><ShieldCheck size={19} /><span>{t("adminUsers.metrics.totalUsers")}</span><strong>{formatNumber(users.length)}</strong></article>
      <article><ShieldCheck size={19} /><span>{t("adminUsers.metrics.activeUsers")}</span><strong>{formatNumber(activeUsers)}</strong></article>
      <article><UserX size={19} /><span>{t("adminUsers.metrics.inactiveUsers")}</span><strong>{formatNumber(users.length - activeUsers)}</strong></article>
    </section>

    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>{t("adminUsers.platformUsers")}</h2>
          <p>{t("adminUsers.platformUsersDescription")}</p>
        </div>
      </div>

      {query.isError && <p className="error">{query.error.message}</p>}
      {!users.length ? <div className="admin-empty-panel"><h2>{t("adminUsers.emptyTitle")}</h2><p>{t("adminUsers.emptyDescription")}</p></div> : <div className="admin-table-card">
        <table className="admin-table">
          <thead>
            <tr>
              <th>{t("adminUsers.columns.user")}</th>
              <th>{t("adminUsers.columns.role")}</th>
              <th>{t("adminUsers.columns.workspaces")}</th>
              <th>{t("common.status")}</th>
              <th>{t("adminUsers.columns.created")}</th>
              <th>{t("adminUsers.columns.lastLogin")}</th>
              <th>{t("reportsPage.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {users.map((item) => <tr key={item.id}>
              <td>
                <strong>{item.displayName ?? item.email}</strong>
                <span>{item.email}</span>
              </td>
              <td>{item.platformRole ?? t("adminUsers.workspaceUser")}</td>
              <td>{formatNumber(item.workspaceCount)}</td>
              <td><span className={`status-badge status-badge--${item.active ? "approved" : "suspended"}`}>{item.active ? t("common.active") : item.status}</span></td>
              <td>{formatDate(item.createdAt, { dateStyle: "medium" })}</td>
              <td>{item.lastLoginAt ? formatDate(item.lastLoginAt, { dateStyle: "medium", timeStyle: "short" }) : t("adminUsers.never")}</td>
              <td>
                <div className="record-list__actions admin-row-actions">
                  <button type="button" onClick={() => setSelectedUserId(item.id)}><Eye size={15} />{t("common.view")}</button>
                  {canManage && item.active && <button type="button" className="danger-button" onClick={() => changeStatus.mutate({ userId: item.id, active: false })}>{t("adminUsers.deactivate")}</button>}
                  {canManage && !item.active && <button type="button" onClick={() => changeStatus.mutate({ userId: item.id, active: true })}>{t("adminUsers.activate")}</button>}
                </div>
              </td>
            </tr>)}
          </tbody>
        </table>
      </div>}
    </section>

    {selectedUserId && <div className="worker-dialog-backdrop worker-action-backdrop" role="presentation" onClick={() => setSelectedUserId(null)}>
      <section className="worker-action-dialog admin-detail-dialog" role="dialog" aria-modal="true" aria-label={t("adminUsers.userDetails")} onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <h2>{detail.data?.user?.displayName ?? detail.data?.user?.email ?? t("adminUsers.userDetails")}</h2>
            <p>{detail.data?.user?.email ?? t("adminUsers.loadingUserProfile")}</p>
          </div>
          <button type="button" onClick={() => setSelectedUserId(null)}><X size={18} /></button>
        </header>
        <div className="worker-action-form admin-detail-body">
          {detail.isError && <p className="error">{detail.error.message}</p>}
          {detail.data?.user && <>
            <section className="admin-detail-section">
              <dl className="worker-stats admin-detail-stats">
                <div><dt>{t("common.status")}</dt><dd><span className={`status-badge status-badge--${detail.data.user.active ? "approved" : "suspended"}`}>{detail.data.user.active ? t("common.active") : detail.data.user.status}</span></dd></div>
                <div><dt>{t("adminUsers.columns.role")}</dt><dd>{detail.data.user.platformRole ?? "-"}</dd></div>
                <div><dt>{t("workspaceTeam.phone")}</dt><dd>{detail.data.user.phone ?? "-"}</dd></div>
                <div><dt>{t("adminUsers.columns.created")}</dt><dd>{formatDate(detail.data.user.createdAt, { dateStyle: "medium", timeStyle: "short" })}</dd></div>
                <div><dt>{t("adminUsers.columns.lastLogin")}</dt><dd>{detail.data.user.lastLoginAt ? formatDate(detail.data.user.lastLoginAt, { dateStyle: "medium", timeStyle: "short" }) : t("adminUsers.never")}</dd></div>
              </dl>
            </section>

            <section className="admin-detail-section">
              <h3>{t("adminUsers.workspaceMemberships")}</h3>
              {!detail.data.user.workspaces.length ? <p className="activity-empty">{t("adminUsers.noWorkspaceMemberships")}</p> : <div className="admin-activity-list">
                {detail.data.user.workspaces.map((workspace) => <article key={workspace.id}>
                  <div>
                    <strong>{workspace.workspaceName}</strong>
                    <span>{workspace.role}</span>
                  </div>
                  <small>{workspace.active ? t("adminUsers.activeMembership") : t("adminUsers.inactiveMembership")}</small>
                </article>)}
              </div>}
            </section>
          </>}
        </div>
      </section>
    </div>}
  </main>;
}
