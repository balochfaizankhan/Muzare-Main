import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronLeft, ChevronRight, Eye, RefreshCcw, ShieldAlert, UserRoundPlus, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../auth/AuthProvider";
import {
  approveRegistrationRequest,
  fetchRegistrations,
  rejectRegistrationRequest,
  updateAdminUserStatus,
  type RegistrationRequest,
  type RegistrationStatusFilter,
} from "../lib/api";
import { formatDate, formatNumber } from "../lib/format";

const PAGE_SIZE = 20;

export function AdminApprovalsPage() {
  const { t } = useTranslation();
  const { user, token } = useAuth();
  const canManage = user?.platformRole === "platform_admin";
  const client = useQueryClient();

  const [status, setStatus] = useState<RegistrationStatusFilter>("pending");
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<RegistrationRequest | null>(null);
  const [rejecting, setRejecting] = useState<RegistrationRequest | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  const filters = { status, search: search.trim() || undefined, from: from || undefined, to: to || undefined, page, pageSize: PAGE_SIZE };
  const query = useQuery({
    queryKey: ["admin-registrations", filters],
    queryFn: () => fetchRegistrations(token!, filters),
    enabled: Boolean(token),
  });

  const refresh = () => Promise.all([
    client.invalidateQueries({ queryKey: ["admin-registrations"] }),
    client.invalidateQueries({ queryKey: ["admin-overview"] }),
  ]);

  const approve = useMutation({
    mutationFn: (userId: string) => approveRegistrationRequest(token!, userId),
    onSuccess: refresh,
  });
  const reject = useMutation({
    mutationFn: ({ userId, reason }: { userId: string; reason?: string }) => rejectRegistrationRequest(token!, userId, reason),
    onSuccess: async () => {
      setRejecting(null);
      setRejectReason("");
      await refresh();
    },
  });
  const changeActiveStatus = useMutation({
    mutationFn: ({ userId, active }: { userId: string; active: boolean }) => updateAdminUserStatus(token!, userId, { active }),
    onSuccess: refresh,
  });

  const setStatusFilter = (next: RegistrationStatusFilter) => {
    setStatus(next);
    setPage(1);
  };

  const rows = query.data?.registrations ?? [];
  const total = query.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <main className="shell-page">
      <section className="shell-page__intro">
        <span className="eyebrow">{t("layout.platformAdministrationEyebrow")}</span>
        <h1>{t("adminApprovals.title")}</h1>
        <p>{t("adminApprovals.subtitle")}</p>
      </section>

      <section className="admin-metric-grid" aria-label={t("adminApprovals.approvalSummaryAria")}>
        <article><UserRoundPlus size={19} /><span>{t("adminApprovals.resultsInView")}</span><strong>{formatNumber(total)}</strong></article>
        <article><ShieldAlert size={19} /><span>{t("adminApprovals.policy")}</span><strong>{t("adminApprovals.approvalRequired")}</strong></article>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>{t("adminApprovals.workspaceApprovals")}</h2>
            <p>{t("adminApprovals.subtitle")}</p>
          </div>
          <div className="admin-filter-chips" role="tablist" aria-label={t("adminApprovals.statusFilters")}>
            {(["pending", "approved", "rejected", "suspended", "all"] as RegistrationStatusFilter[]).map((value) => (
              <button key={value} type="button" className={status === value ? "is-active" : ""} onClick={() => setStatusFilter(value)}>
                {t(`adminApprovals.filters.${value}`)}
              </button>
            ))}
          </div>
        </div>

        <form className="compact-form form-grid" onSubmit={(event) => { event.preventDefault(); setPage(1); }}>
          <input
            type="search"
            placeholder={t("adminApprovals.searchPlaceholder")}
            value={search}
            onChange={(event) => { setSearch(event.target.value); setPage(1); }}
            aria-label={t("adminApprovals.searchPlaceholder")}
          />
          <input type="date" value={from} onChange={(event) => { setFrom(event.target.value); setPage(1); }} aria-label={t("adminApprovals.fromDate")} />
          <input type="date" value={to} onChange={(event) => { setTo(event.target.value); setPage(1); }} aria-label={t("adminApprovals.toDate")} />
        </form>

        {query.isError && <p className="error">{query.error.message}</p>}
        {!query.isLoading && !rows.length ? (
          <div className="admin-empty-panel">
            <h2>{t("adminApprovals.noPending")}</h2>
            <p>{t("adminApprovals.noPendingDescription")}</p>
          </div>
        ) : (
          <div className="admin-table-card">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>{t("adminApprovals.columns.applicant")}</th>
                  <th>{t("common.status")}</th>
                  <th>{t("adminApprovals.columns.registered")}</th>
                  <th>{t("adminApprovals.columns.language")}</th>
                  <th>{t("reportsPage.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.userId}>
                    <td>
                      <strong>{row.displayName ?? row.email}</strong>
                      <span className="bidi-isolate">{row.email}</span>
                    </td>
                    <td><span className={`status-badge status-badge--${row.status}`}>{t(`status.${row.status}`)}</span></td>
                    <td>{formatDate(row.createdAt, { dateStyle: "medium", timeStyle: "short" })}</td>
                    <td>{row.registrationLanguage ?? "-"}</td>
                    <td>
                      <div className="record-list__actions admin-row-actions">
                        <button type="button" onClick={() => setSelected(row)}><Eye size={15} />{t("common.view")}</button>
                        {canManage && row.status === "pending" && (
                          <button type="button" onClick={() => approve.mutate(row.userId)} disabled={approve.isPending}>
                            <Check size={15} />{t("adminApprovals.approve")}
                          </button>
                        )}
                        {canManage && row.status === "pending" && (
                          <button type="button" className="danger-button" onClick={() => { setRejecting(row); setRejectReason(""); }}>
                            <X size={15} />{t("adminApprovals.reject")}
                          </button>
                        )}
                        {canManage && row.status === "approved" && (
                          <button type="button" className="danger-button" onClick={() => changeActiveStatus.mutate({ userId: row.userId, active: false })}>
                            {t("adminApprovals.suspend")}
                          </button>
                        )}
                        {canManage && row.status === "suspended" && (
                          <button type="button" onClick={() => changeActiveStatus.mutate({ userId: row.userId, active: true })}>
                            <RefreshCcw size={15} />{t("adminApprovals.reactivate")}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="registration-pagination">
          <span>{t("adminApprovals.pageIndicator", { page, totalPages })}</span>
          <div>
            <button type="button" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page <= 1}>
              <ChevronLeft size={15} />{t("common.previous")}
            </button>
            <button type="button" onClick={() => setPage((value) => Math.min(totalPages, value + 1))} disabled={page >= totalPages}>
              {t("common.next")}<ChevronRight size={15} />
            </button>
          </div>
        </div>
      </section>

      {selected && (
        <div className="worker-dialog-backdrop worker-action-backdrop" role="presentation" onClick={() => setSelected(null)}>
          <section className="worker-action-dialog admin-detail-dialog" role="dialog" aria-modal="true" aria-label={t("adminApprovals.registrationDetails")} onClick={(event) => event.stopPropagation()}>
            <header>
              <div>
                <h2>{selected.displayName ?? selected.email}</h2>
                <p className="bidi-isolate">{selected.email}</p>
              </div>
              <button type="button" onClick={() => setSelected(null)}><X size={18} /></button>
            </header>
            <div className="worker-action-form admin-detail-body">
              <section className="admin-detail-section">
                <dl className="worker-stats admin-detail-stats">
                  <div><dt>{t("common.status")}</dt><dd><span className={`status-badge status-badge--${selected.status}`}>{t(`status.${selected.status}`)}</span></dd></div>
                  <div><dt>{t("workspaceTeam.phone")}</dt><dd className="bidi-isolate">{selected.phone ?? "-"}</dd></div>
                  <div><dt>{t("adminApprovals.columns.registered")}</dt><dd>{formatDate(selected.createdAt, { dateStyle: "medium", timeStyle: "short" })}</dd></div>
                  <div><dt>{t("adminApprovals.columns.language")}</dt><dd>{selected.registrationLanguage ?? "-"}</dd></div>
                  <div><dt>{t("adminApprovals.emailVerification")}</dt><dd>{t("adminApprovals.emailVerificationNotApplicable")}</dd></div>
                  {selected.approvedAt && <div><dt>{t("adminWorkspaces.approved")}</dt><dd>{formatDate(selected.approvedAt, { dateStyle: "medium", timeStyle: "short" })}</dd></div>}
                  {selected.rejectedAt && <div><dt>{t("adminApprovals.rejectedAt")}</dt><dd>{formatDate(selected.rejectedAt, { dateStyle: "medium", timeStyle: "short" })}</dd></div>}
                  {selected.suspendedAt && <div><dt>{t("adminApprovals.suspendedAt")}</dt><dd>{formatDate(selected.suspendedAt, { dateStyle: "medium", timeStyle: "short" })}</dd></div>}
                  {selected.internalReviewNote && <div><dt>{t("adminApprovals.internalNote")}</dt><dd>{selected.internalReviewNote}</dd></div>}
                </dl>
              </section>
            </div>
          </section>
        </div>
      )}

      {rejecting && (
        <div className="worker-dialog-backdrop worker-action-backdrop" role="presentation" onClick={() => setRejecting(null)}>
          <section className="worker-action-dialog admin-detail-dialog" role="dialog" aria-modal="true" aria-label={t("adminApprovals.reject")} onClick={(event) => event.stopPropagation()}>
            <header>
              <div>
                <h2>{t("adminApprovals.confirmRejectTitle")}</h2>
                <p className="bidi-isolate">{rejecting.email}</p>
              </div>
              <button type="button" onClick={() => setRejecting(null)}><X size={18} /></button>
            </header>
            <div className="worker-action-form admin-detail-body">
              <p>{t("adminApprovals.confirmRejectDescription")}</p>
              <label>
                <span>{t("adminApprovals.internalNoteOptional")}</span>
                <textarea value={rejectReason} onChange={(event) => setRejectReason(event.target.value)} rows={3} />
              </label>
              {reject.isError && <p className="error">{reject.error.message}</p>}
              <div className="record-list__actions admin-row-actions">
                <button type="button" onClick={() => setRejecting(null)}>{t("common.cancel")}</button>
                <button
                  type="button"
                  className="danger-button"
                  disabled={reject.isPending}
                  onClick={() => reject.mutate({ userId: rejecting.userId, reason: rejectReason.trim() || undefined })}
                >
                  {t("adminApprovals.confirmReject")}
                </button>
              </div>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
