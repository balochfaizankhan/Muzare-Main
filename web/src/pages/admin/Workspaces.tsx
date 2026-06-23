import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type FormEvent } from "react";
import { Building2, Eye, RefreshCcw, ShieldAlert, UserRoundPlus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useAuth } from "../../auth/AuthProvider";
import { createAdminWorkspace, deleteAdminWorkspace, fetchAdminWorkspace, fetchAdminWorkspaces, type AdminWorkspace, updateAdminWorkspaceStatus } from "../../lib/api";
import { formatDate, formatNumber } from "../../lib/format";
import i18n from "../../i18n";

type WorkspaceStatusFilter = "all" | AdminWorkspace["status"];

function farmStatusLabel(t: (key: string) => string, status: string) {
  if (status === "active") return t("common.active");
  if (status === "delete_pending") return t("farmsPage.deletionPending");
  if (status === "deleted") return t("adminFarms.deleted");
  return t("seasonsPage.archived");
}

export function Workspaces({ defaultStatusFilter = "all" }: { defaultStatusFilter?: WorkspaceStatusFilter }) {
  const { t } = useTranslation();
  const { user, token } = useAuth();
  const canManage = user?.platformRole === "platform_admin";
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [filter, setFilter] = useState<WorkspaceStatusFilter>(defaultStatusFilter);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["admin-workspaces"],
    queryFn: () => fetchAdminWorkspaces(token!),
    enabled: Boolean(token),
  });
  const detail = useQuery({
    queryKey: ["admin-workspace", selectedWorkspaceId],
    queryFn: () => fetchAdminWorkspace(token!, selectedWorkspaceId!),
    enabled: Boolean(token && selectedWorkspaceId),
  });

  const refresh = () => Promise.all([
    client.invalidateQueries({ queryKey: ["admin-workspaces"] }),
    client.invalidateQueries({ queryKey: ["admin-overview"] }),
    client.invalidateQueries({ queryKey: ["admin-workspace", selectedWorkspaceId] }),
  ]);

  const create = useMutation({
    mutationFn: () => createAdminWorkspace(token!, { name, contactEmail }),
    onSuccess: async () => {
      setName("");
      setContactEmail("");
      await refresh();
    },
  });
  const changeStatus = useMutation({
    mutationFn: ({ workspaceId, status }: { workspaceId: string; status: AdminWorkspace["status"] }) =>
      updateAdminWorkspaceStatus(token!, workspaceId, { status }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteAdminWorkspace(token!, id),
    onSuccess: refresh,
  });

  const workspaces = useMemo(() => {
    const rows = query.data?.workspaces ?? [];
    return filter === "all" ? rows : rows.filter((workspace) => workspace.status === filter);
  }, [filter, query.data?.workspaces]);

  const counts = useMemo(() => {
    const rows = query.data?.workspaces ?? [];
    return {
      total: rows.length,
      pending: rows.filter((workspace) => workspace.status === "pending").length,
      approved: rows.filter((workspace) => workspace.status === "approved").length,
      suspended: rows.filter((workspace) => workspace.status === "suspended").length,
    };
  }, [query.data?.workspaces]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };

  return <main className="shell-page">
    <section className="shell-page__intro">
      <span className="eyebrow">{t("layout.platformAdministrationEyebrow")}</span>
      <h1>{t("adminWorkspaces.title")}</h1>
      <p>{t("adminWorkspaces.description")}</p>
      <Link className="primary-link" to="/admin/approvals">{t("adminWorkspaces.reviewPendingRequests")}</Link>
    </section>

    <section className="admin-metric-grid">
      <article><Building2 size={19} /><span>{t("adminWorkspaces.metrics.totalWorkspaces")}</span><strong>{formatNumber(counts.total)}</strong></article>
      <article><UserRoundPlus size={19} /><span>{t("adminWorkspaces.metrics.pending")}</span><strong>{formatNumber(counts.pending)}</strong></article>
      <article><ShieldAlert size={19} /><span>{t("adminWorkspaces.metrics.suspended")}</span><strong>{formatNumber(counts.suspended)}</strong></article>
    </section>

    {canManage && <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>{t("adminWorkspaces.createWorkspace")}</h2>
          <p>{t("adminWorkspaces.createWorkspaceDescription")}</p>
        </div>
      </div>
      <form className="compact-form form-grid" onSubmit={submit}>
        <input required placeholder={t("workspaceProfile.name")} value={name} onChange={(event) => setName(event.target.value)} />
        <input required type="email" placeholder={t("workspaceProfile.contactEmail")} value={contactEmail} onChange={(event) => setContactEmail(event.target.value)} />
        <button type="submit" disabled={create.isPending}>{t("adminWorkspaces.createWorkspace")}</button>
      </form>
    </section>}

    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>{t("adminWorkspaces.directoryTitle")}</h2>
          <p>{t("adminWorkspaces.directoryDescription")}</p>
        </div>
        <div className="admin-filter-chips" role="tablist" aria-label={t("adminWorkspaces.statusFilters")}>
          {[
            ["all", `${t("adminWorkspaces.filters.all")} (${counts.total})`],
            ["pending", `${t("adminWorkspaces.filters.pending")} (${counts.pending})`],
            ["approved", `${t("adminWorkspaces.filters.active")} (${counts.approved})`],
            ["suspended", `${t("adminWorkspaces.filters.suspended")} (${counts.suspended})`],
          ].map(([value, label]) => <button key={value} type="button" className={filter === value ? "is-active" : ""} onClick={() => setFilter(value as WorkspaceStatusFilter)}>{label}</button>)}
        </div>
      </div>

      {query.isError && <p className="error">{query.error.message}</p>}
      {!workspaces.length ? <div className="admin-empty-panel"><h2>{t("adminWorkspaces.emptyTitle")}</h2><p>{t("adminWorkspaces.emptyDescription")}</p></div> : <div className="admin-table-card">
        <table className="admin-table">
          <thead>
            <tr>
              <th>{t("adminWorkspaces.columns.workspace")}</th>
              <th>{t("common.status")}</th>
              <th>{t("adminWorkspaces.columns.users")}</th>
              <th>{t("farms")}</th>
              <th>{t("adminWorkspaces.columns.created")}</th>
              <th>{t("reportsPage.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {workspaces.map((workspace) => <tr key={workspace.id}>
              <td>
                <strong>{workspace.name}</strong>
                <span>{workspace.ownerEmail ?? workspace.contactEmail}</span>
              </td>
              <td><span className={`status-badge status-badge--${workspace.status}`}>{workspace.status}</span></td>
              <td>{formatNumber(workspace.usersCount)}</td>
              <td>{formatNumber(workspace.farmsCount)}</td>
              <td>{formatDate(workspace.createdAt, { dateStyle: "medium" })}</td>
              <td>
                <div className="record-list__actions admin-row-actions">
                  <button type="button" onClick={() => setSelectedWorkspaceId(workspace.id)}><Eye size={15} />{t("common.view")}</button>
                  {canManage && workspace.status === "pending" && <button type="button" onClick={() => changeStatus.mutate({ workspaceId: workspace.id, status: "approved" })}>{t("adminApprovals.approve")}</button>}
                  {canManage && workspace.status === "approved" && <button type="button" onClick={() => changeStatus.mutate({ workspaceId: workspace.id, status: "suspended" })}>{t("adminWorkspaces.suspend")}</button>}
                  {canManage && workspace.status === "suspended" && <button type="button" onClick={() => changeStatus.mutate({ workspaceId: workspace.id, status: "approved" })}><RefreshCcw size={15} />{t("adminWorkspaces.unsuspend")}</button>}
                  {canManage && workspace.status === "pending" && <button type="button" className="danger-button" onClick={() => changeStatus.mutate({ workspaceId: workspace.id, status: "rejected" })}>{t("adminApprovals.reject")}</button>}
                  {canManage && <button type="button" className="danger-button" onClick={() => remove.mutate(workspace.id)}>{t("common.delete")}</button>}
                </div>
              </td>
            </tr>)}
          </tbody>
        </table>
      </div>}
    </section>

    {selectedWorkspaceId && <div className="worker-dialog-backdrop worker-action-backdrop" role="presentation" onClick={() => setSelectedWorkspaceId(null)}>
      <section className="worker-action-dialog admin-detail-dialog" role="dialog" aria-modal="true" aria-label={t("adminWorkspaces.workspaceDetails")} onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <h2>{detail.data?.workspace?.name ?? t("adminWorkspaces.workspaceDetails")}</h2>
            <p>{detail.data?.workspace?.contactEmail ?? t("adminWorkspaces.loadingWorkspaceMetadata")}</p>
          </div>
          <button type="button" onClick={() => setSelectedWorkspaceId(null)}><X size={18} /></button>
        </header>
        <div className="worker-action-form admin-detail-body">
          {detail.isError && <p className="error">{detail.error.message}</p>}
          {detail.data?.workspace && <>
            <section className="admin-detail-section">
              <dl className="worker-stats admin-detail-stats">
                <div><dt>{t("common.status")}</dt><dd><span className={`status-badge status-badge--${detail.data.workspace.status}`}>{detail.data.workspace.status}</span></dd></div>
                <div><dt>{t("adminWorkspaces.columns.created")}</dt><dd>{formatDate(detail.data.workspace.createdAt, { dateStyle: "medium", timeStyle: "short" })}</dd></div>
                <div><dt>{t("adminWorkspaces.approved")}</dt><dd>{detail.data.workspace.approvedAt ? formatDate(detail.data.workspace.approvedAt, { dateStyle: "medium", timeStyle: "short" }) : "-"}</dd></div>
                <div><dt>{t("adminWorkspaces.slug")}</dt><dd>{detail.data.workspace.slug}</dd></div>
                <div><dt>{t("workspaceTeam.phone")}</dt><dd>{detail.data.workspace.contactPhone ?? "-"}</dd></div>
              </dl>
            </section>

            <section className="admin-detail-section">
              <h3>{t("workspaceTeam.members")}</h3>
              {!detail.data.workspace.members.length ? <p className="activity-empty">{t("adminWorkspaces.noMembers")}</p> : <div className="admin-activity-list">
                {detail.data.workspace.members.map((member) => <article key={member.id}>
                  <div>
                    <strong>{member.displayName ?? member.email}</strong>
                    <span>{member.email} • {member.role}</span>
                  </div>
                  <small>{member.hasWorkspaceAccess ? t("adminWorkspaces.activeMember") : (member.userStatus === "suspended" ? t("adminWorkspaces.suspendedUser") : t("adminWorkspaces.inactiveMember"))}</small>
                </article>)}
              </div>}
            </section>

            <section className="admin-detail-section">
              <h3>{t("adminFarms.farmDirectory")}</h3>
              {!detail.data.workspace.farms?.length ? <p className="activity-empty">{t("adminFarms.noFarms")}</p> : <div className="admin-activity-list">
                {detail.data.workspace.farms.map((farm) => <article key={farm.id}>
                  <div>
                    <strong>{farm.name}</strong>
                    <span>{farmStatusLabel(t, farm.status)} • {t("adminFarms.records")}: {formatNumber(farm.totalRecords)}</span>
                  </div>
                  <small>{Object.entries(farm.counts).map(([key, value]) => `${key}: ${value}`).join(" · ")}</small>
                </article>)}
              </div>}
            </section>

            <section className="admin-detail-section">
              <h3>{t("adminFarms.deletionRequests")}</h3>
              {!detail.data.workspace.deletionRequests?.length ? <p className="activity-empty">{t("adminFarms.noDeletionRequests")}</p> : <div className="admin-activity-list">
                {detail.data.workspace.deletionRequests.map((request) => <article key={request.id}>
                  <div>
                    <strong>{request.farmName}</strong>
                    <span>{request.status} • {request.requestedByEmail}</span>
                  </div>
                  <small>{formatDate(request.createdAt, { dateStyle: "medium", timeStyle: "short" })}</small>
                </article>)}
              </div>}
            </section>

            <section className="admin-detail-section">
              <h3>{t("adminWorkspaces.statusHistory")}</h3>
              {!detail.data.workspace.history.length ? <p className="activity-empty">{t("adminWorkspaces.noStatusHistory")}</p> : <div className="admin-activity-list">
                {detail.data.workspace.history.map((item) => <article key={item.id}>
                  <div>
                    <strong>{humanizeAction(item.action)}</strong>
                    <span>{item.actorName ?? item.actorEmail ?? t("common.system")}</span>
                  </div>
                  <small>{formatDate(item.createdAt, { dateStyle: "medium", timeStyle: "short" })}</small>
                </article>)}
              </div>}
            </section>
          </>}
        </div>
      </section>
    </div>}
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
