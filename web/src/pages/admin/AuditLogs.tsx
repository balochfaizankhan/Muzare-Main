import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthProvider";
import { fetchAdminAuditLogs } from "../../lib/api";
import { formatDate } from "../../lib/format";

export function AuditLogs() {
  const { token } = useAuth();
  const query = useQuery({
    queryKey: ["admin-audit-logs"],
    queryFn: () => fetchAdminAuditLogs(token!),
    enabled: Boolean(token),
  });

  return <main className="shell-page">
    <section className="shell-page__intro">
      <span className="eyebrow">Platform administration</span>
      <h1>Audit Logs</h1>
      <p>Review lifecycle decisions, support interventions, and platform actions with timestamps and actor details.</p>
    </section>

    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>Recent audit records</h2>
          <p>Most recent platform events across workspace and user administration.</p>
        </div>
      </div>
      {query.isError && <p className="error">{query.error.message}</p>}
      {!query.data?.records.length ? <div className="admin-empty-panel"><h2>No audit records yet</h2><p>This page will show platform actions such as approvals, suspensions, and account state changes.</p></div> : <div className="admin-table-card">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Action</th>
              <th>Workspace</th>
              <th>Actor</th>
              <th>Entity</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {query.data.records.map((record) => <tr key={record.id}>
              <td><strong>{humanizeAction(record.action)}</strong></td>
              <td>{record.workspaceName ?? "-"}</td>
              <td>{record.actorName ?? "System"}</td>
              <td>{record.entityType}{record.entityId ? ` • ${record.entityId.slice(0, 8)}` : ""}</td>
              <td>{formatDate(record.createdAt, { dateStyle: "medium", timeStyle: "short" })}</td>
            </tr>)}
          </tbody>
        </table>
      </div>}
    </section>
  </main>;
}

function humanizeAction(action: string) {
  return action
    .replace(/^admin\./, "")
    .replace(/[._]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
