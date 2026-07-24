import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ShieldAlert, XCircle } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../auth/AuthProvider";
import type { TFunction } from "i18next";
import { approveAdminFarmDeletionRequest, fetchAdminFarms, rejectAdminFarmDeletionRequest, type AdminFarmDeletionRequest } from "../../lib/api";
import { formatDate, formatNumber } from "../../lib/format";
import { translateRecordType } from "../../locales/adminLocalizationBundle";

function countSummary(t: TFunction, counts: Record<string, number>) {
  return Object.entries(counts).filter(([, value]) => Number(value) > 0).map(([key, value]) => `${translateRecordType(t, key)}: ${value}`).join(" · ");
}

function farmStatusLabel(t: (key: string) => string, status: string) {
  if (status === "active") return t("common.active");
  if (status === "delete_pending") return t("farmsPage.deletionPending");
  if (status === "deleted") return t("adminFarms.deleted");
  return t("seasonsPage.archived");
}

export function AdminFarms() {
  const { t } = useTranslation();
  const { token, user } = useAuth();
  const client = useQueryClient();
  const canManage = user?.platformRole === "platform_admin";
  const [selectedRequest, setSelectedRequest] = useState<AdminFarmDeletionRequest | null>(null);
  const farms = useQuery({
    queryKey: ["admin-farms"],
    queryFn: () => fetchAdminFarms(token!),
    enabled: Boolean(token),
  });
  const refresh = () => Promise.all([
    client.invalidateQueries({ queryKey: ["admin-farms"] }),
    client.invalidateQueries({ queryKey: ["admin-overview"] }),
    client.invalidateQueries({ queryKey: ["admin-workspaces"] }),
  ]);
  const approve = useMutation({
    mutationFn: ({ id, notes }: { id: string; notes?: string }) => approveAdminFarmDeletionRequest(token!, id, { notes }),
    onSuccess: async () => { setSelectedRequest(null); await refresh(); },
  });
  const reject = useMutation({
    mutationFn: ({ id, notes }: { id: string; notes?: string }) => rejectAdminFarmDeletionRequest(token!, id, { notes }),
    onSuccess: async () => { setSelectedRequest(null); await refresh(); },
  });
  const requests = farms.data?.deletionRequests ?? [];
  const rows = farms.data?.farms ?? [];

  return <main className="shell-page">
    <section className="shell-page__intro">
      <span className="eyebrow">{t("layout.platformAdministrationEyebrow")}</span>
      <h1>{t("adminFarms.title")}</h1>
      <p>{t("adminFarms.description")}</p>
    </section>

    <section className="admin-metric-grid">
      <article><CheckCircle2 size={19} /><span>{t("adminFarms.totalFarms")}</span><strong>{formatNumber(rows.length)}</strong></article>
      <article><ShieldAlert size={19} /><span>{t("adminFarms.pendingDeletionRequests")}</span><strong>{formatNumber(requests.length)}</strong></article>
      <article><XCircle size={19} /><span>{t("adminFarms.inactiveFarms")}</span><strong>{formatNumber(rows.filter((farm) => farm.status !== "active").length)}</strong></article>
    </section>

    <section className="panel">
      <div className="panel-heading"><div><h2>{t("adminFarms.deletionRequests")}</h2><p>{t("adminFarms.deletionRequestsDescription")}</p></div></div>
      {!requests.length ? <p className="activity-empty">{t("adminFarms.noDeletionRequests")}</p> : <div className="admin-table-card">
        <table className="admin-table">
          <thead><tr><th>{t("farmsPage.farmName")}</th><th>{t("layout.workspaces")}</th><th>{t("adminFarms.requestedBy")}</th><th>{t("adminFarms.records")}</th><th>{t("adminWorkspaces.columns.created")}</th><th>{t("reportsPage.actions")}</th></tr></thead>
          <tbody>{requests.map((request) => <tr key={request.id}>
            <td><strong>{request.farmName}</strong><span>{request.reason ?? t("adminFarms.noReason")}</span></td>
            <td>{request.workspaceName}</td>
            <td>{request.requestedByEmail}</td>
            <td>{countSummary(t, request.recordCounts) || "0"}</td>
            <td>{formatDate(request.createdAt, { dateStyle: "medium", timeStyle: "short" })}</td>
            <td><div className="record-list__actions admin-row-actions"><button type="button" onClick={() => setSelectedRequest(request)}>{t("common.view")}</button></div></td>
          </tr>)}</tbody>
        </table>
      </div>}
    </section>

    <section className="panel">
      <div className="panel-heading"><div><h2>{t("adminFarms.farmDirectory")}</h2><p>{t("adminFarms.farmDirectoryDescription")}</p></div></div>
      {farms.isError && <p className="error">{farms.error.message}</p>}
      {!rows.length ? <p className="activity-empty">{t("adminFarms.noFarms")}</p> : <div className="admin-table-card">
        <table className="admin-table">
          <thead><tr><th>{t("farmsPage.farmName")}</th><th>{t("layout.workspaces")}</th><th>{t("common.status")}</th><th>{t("adminFarms.records")}</th><th>{t("adminFarms.breakdown")}</th><th>{t("adminWorkspaces.columns.created")}</th></tr></thead>
          <tbody>{rows.map((farm) => <tr key={farm.id}>
            <td><strong>{farm.name}</strong><span>{farm.ownerEmail ?? farm.owner ?? farm.location ?? "-"}</span></td>
            <td>{farm.workspaceName}</td>
            <td><span className={`status-badge status-badge--${farm.status === "delete_pending" ? "pending" : farm.status}`}>{farmStatusLabel(t, farm.status)}</span></td>
            <td>{formatNumber(farm.totalRecords)}</td>
            <td>{Object.entries(farm.counts).map(([key, value]) => `${translateRecordType(t, key)}: ${value}`).join(" · ")}</td>
            <td>{formatDate(farm.createdAt, { dateStyle: "medium" })}</td>
          </tr>)}</tbody>
        </table>
      </div>}
    </section>

    {selectedRequest && <div className="worker-dialog-backdrop worker-action-backdrop" role="presentation" onClick={() => setSelectedRequest(null)}>
      <section className="worker-action-dialog admin-detail-dialog" role="dialog" aria-modal="true" aria-label={t("adminFarms.reviewDeletionRequest")} onClick={(event) => event.stopPropagation()}>
        <header><div><h2>{selectedRequest.farmName}</h2><p>{selectedRequest.workspaceName}</p></div><button type="button" onClick={() => setSelectedRequest(null)}>×</button></header>
        <div className="worker-action-form admin-detail-body">
          <section className="admin-detail-section">
            <h3>{t("adminFarms.recordCounts")}</h3>
            <p>{countSummary(t, selectedRequest.recordCounts) || "0"}</p>
            <p>{selectedRequest.reason ?? t("adminFarms.noReason")}</p>
          </section>
          {canManage && <div className="record-list__actions">
            <button type="button" disabled={approve.isPending} onClick={() => approve.mutate({ id: selectedRequest.id, notes: window.prompt(t("adminFarms.reviewNotes"), "") ?? undefined })}>{t("adminFarms.approveDeletion")}</button>
            <button className="danger-button" type="button" disabled={reject.isPending} onClick={() => reject.mutate({ id: selectedRequest.id, notes: window.prompt(t("adminFarms.reviewNotes"), "") ?? undefined })}>{t("adminFarms.rejectDeletion")}</button>
          </div>}
        </div>
      </section>
    </div>}
  </main>;
}
