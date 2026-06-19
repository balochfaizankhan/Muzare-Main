import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type FormEvent } from "react";
import { Building2, Eye, RefreshCcw, ShieldAlert, UserRoundPlus, X } from "lucide-react";
import { Link } from "react-router-dom";
import { useAuth } from "../../auth/AuthProvider";
import { createAdminWorkspace, deleteAdminWorkspace, fetchAdminWorkspace, fetchAdminWorkspaces, type AdminWorkspace, updateAdminWorkspaceStatus } from "../../lib/api";
import { formatDate, formatNumber } from "../../lib/format";

type WorkspaceStatusFilter = "all" | AdminWorkspace["status"];

export function Workspaces({ defaultStatusFilter = "all" }: { defaultStatusFilter?: WorkspaceStatusFilter }) {
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
      <span className="eyebrow">Platform administration</span>
      <h1>Workspaces</h1>
      <p>Approve pending workspaces, suspend or reactivate customers, and inspect membership and status history.</p>
      <Link className="primary-link" to="/admin/approvals">Review pending requests</Link>
    </section>

    <section className="admin-metric-grid">
      <article><Building2 size={19} /><span>Total workspaces</span><strong>{formatNumber(counts.total)}</strong></article>
      <article><UserRoundPlus size={19} /><span>Pending</span><strong>{formatNumber(counts.pending)}</strong></article>
      <article><ShieldAlert size={19} /><span>Suspended</span><strong>{formatNumber(counts.suspended)}</strong></article>
    </section>

    {canManage && <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>Create workspace</h2>
          <p>Create a new approved workspace directly from the platform console.</p>
        </div>
      </div>
      <form className="compact-form form-grid" onSubmit={submit}>
        <input required placeholder="Workspace name" value={name} onChange={(event) => setName(event.target.value)} />
        <input required type="email" placeholder="Contact email" value={contactEmail} onChange={(event) => setContactEmail(event.target.value)} />
        <button type="submit" disabled={create.isPending}>Create workspace</button>
      </form>
    </section>}

    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>Workspace directory</h2>
          <p>Customer workspaces, ownership, lifecycle status, and account counts.</p>
        </div>
        <div className="admin-filter-chips" role="tablist" aria-label="Workspace status filters">
          {[
            ["all", `All (${counts.total})`],
            ["pending", `Pending (${counts.pending})`],
            ["approved", `Active (${counts.approved})`],
            ["suspended", `Suspended (${counts.suspended})`],
          ].map(([value, label]) => <button key={value} type="button" className={filter === value ? "is-active" : ""} onClick={() => setFilter(value as WorkspaceStatusFilter)}>{label}</button>)}
        </div>
      </div>

      {query.isError && <p className="error">{query.error.message}</p>}
      {!workspaces.length ? <div className="admin-empty-panel"><h2>No workspaces found</h2><p>There are no workspaces in this status yet.</p></div> : <div className="admin-table-card">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Workspace</th>
              <th>Status</th>
              <th>Users</th>
              <th>Farms</th>
              <th>Created</th>
              <th>Actions</th>
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
                  <button type="button" onClick={() => setSelectedWorkspaceId(workspace.id)}><Eye size={15} />View</button>
                  {canManage && workspace.status === "pending" && <button type="button" onClick={() => changeStatus.mutate({ workspaceId: workspace.id, status: "approved" })}>Approve</button>}
                  {canManage && workspace.status === "approved" && <button type="button" onClick={() => changeStatus.mutate({ workspaceId: workspace.id, status: "suspended" })}>Suspend</button>}
                  {canManage && workspace.status === "suspended" && <button type="button" onClick={() => changeStatus.mutate({ workspaceId: workspace.id, status: "approved" })}><RefreshCcw size={15} />Unsuspend</button>}
                  {canManage && workspace.status === "pending" && <button type="button" className="danger-button" onClick={() => changeStatus.mutate({ workspaceId: workspace.id, status: "rejected" })}>Reject</button>}
                  {canManage && <button type="button" className="danger-button" onClick={() => remove.mutate(workspace.id)}>Delete</button>}
                </div>
              </td>
            </tr>)}
          </tbody>
        </table>
      </div>}
    </section>

    {selectedWorkspaceId && <div className="worker-dialog-backdrop worker-action-backdrop" role="presentation" onClick={() => setSelectedWorkspaceId(null)}>
      <section className="worker-action-dialog admin-detail-dialog" role="dialog" aria-modal="true" aria-label="Workspace details" onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <h2>{detail.data?.workspace?.name ?? "Workspace details"}</h2>
            <p>{detail.data?.workspace?.contactEmail ?? "Loading workspace metadata"}</p>
          </div>
          <button type="button" onClick={() => setSelectedWorkspaceId(null)}><X size={18} /></button>
        </header>
        <div className="worker-action-form admin-detail-body">
          {detail.isError && <p className="error">{detail.error.message}</p>}
          {detail.data?.workspace && <>
            <section className="admin-detail-section">
              <dl className="worker-stats admin-detail-stats">
                <div><dt>Status</dt><dd><span className={`status-badge status-badge--${detail.data.workspace.status}`}>{detail.data.workspace.status}</span></dd></div>
                <div><dt>Created</dt><dd>{formatDate(detail.data.workspace.createdAt, { dateStyle: "medium", timeStyle: "short" })}</dd></div>
                <div><dt>Approved</dt><dd>{detail.data.workspace.approvedAt ? formatDate(detail.data.workspace.approvedAt, { dateStyle: "medium", timeStyle: "short" }) : "-"}</dd></div>
                <div><dt>Slug</dt><dd>{detail.data.workspace.slug}</dd></div>
                <div><dt>Phone</dt><dd>{detail.data.workspace.contactPhone ?? "-"}</dd></div>
              </dl>
            </section>

            <section className="admin-detail-section">
              <h3>Members</h3>
              {!detail.data.workspace.members.length ? <p className="activity-empty">No members found for this workspace yet.</p> : <div className="admin-activity-list">
                {detail.data.workspace.members.map((member) => <article key={member.id}>
                  <div>
                    <strong>{member.displayName ?? member.email}</strong>
                    <span>{member.email} • {member.role}</span>
                  </div>
                  <small>{member.hasWorkspaceAccess ? "Active member" : (member.userStatus === "suspended" ? "Suspended user" : "Inactive member")}</small>
                </article>)}
              </div>}
            </section>

            <section className="admin-detail-section">
              <h3>Status history</h3>
              {!detail.data.workspace.history.length ? <p className="activity-empty">No status history has been recorded yet.</p> : <div className="admin-activity-list">
                {detail.data.workspace.history.map((item) => <article key={item.id}>
                  <div>
                    <strong>{humanizeAction(item.action)}</strong>
                    <span>{item.actorName ?? item.actorEmail ?? "System"}</span>
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
  return action
    .replace(/^admin\./, "")
    .replace(/[._]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
