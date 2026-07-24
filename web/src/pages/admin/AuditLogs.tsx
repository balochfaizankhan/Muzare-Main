import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthProvider";
import { fetchAdminAuditLogs } from "../../lib/api";
import { formatDate } from "../../lib/format";
import { useTranslation } from "react-i18next";
import { translateRecordType } from "../../locales/adminLocalizationBundle";
import i18n from "../../i18n";

export function AuditLogs() {
  const { t } = useTranslation();
  const { token } = useAuth();
  const query = useQuery({
    queryKey: ["admin-audit-logs"],
    queryFn: () => fetchAdminAuditLogs(token!),
    enabled: Boolean(token),
  });

  return <main className="shell-page">
    <section className="shell-page__intro">
      <span className="eyebrow">{t("layout.platformAdministrationEyebrow")}</span>
      <h1>{t("adminAudit.title")}</h1>
      <p>{t("adminAudit.description")}</p>
    </section>

    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>{t("adminAudit.recentRecords")}</h2>
          <p>{t("adminAudit.recentRecordsDescription")}</p>
        </div>
      </div>
      {query.isError && <p className="error">{query.error.message}</p>}
      {!query.data?.records.length ? <div className="admin-empty-panel"><h2>{t("adminAudit.emptyTitle")}</h2><p>{t("adminAudit.emptyDescription")}</p></div> : <div className="admin-table-card">
        <table className="admin-table">
          <thead>
            <tr>
              <th>{t("adminAudit.columns.action")}</th>
              <th>{t("adminAudit.columns.workspace")}</th>
              <th>{t("adminAudit.columns.actor")}</th>
              <th>{t("adminAudit.columns.entity")}</th>
              <th>{t("adminAudit.columns.created")}</th>
            </tr>
          </thead>
          <tbody>
            {query.data.records.map((record) => <tr key={record.id}>
              <td><strong>{humanizeAction(record.action)}</strong></td>
              <td>{record.workspaceName ?? "-"}</td>
              <td>{record.actorName ?? t("common.system")}</td>
              <td>{translateRecordType(t, record.entityType)}{record.entityId ? ` • ${record.entityId.slice(0, 8)}` : ""}</td>
              <td>{formatDate(record.createdAt, { dateStyle: "medium", timeStyle: "short" })}</td>
            </tr>)}
          </tbody>
        </table>
      </div>}
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
