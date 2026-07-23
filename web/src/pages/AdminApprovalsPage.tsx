import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Clock3, Inbox, ShieldCheck, UserCheck, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { SubpageHeader } from "../components/SubpageHeader";
import { approveSignup, fetchApprovals, rejectSignup } from "../lib/api";
import { formatDate } from "../lib/format";

export function AdminApprovalsPage() {
  const { t } = useTranslation();
  const { token } = useAuth();
  const queryClient = useQueryClient();
  const approvals = useQuery({
    queryKey: ["admin-approvals"],
    queryFn: () => fetchApprovals(token!),
    enabled: Boolean(token),
  });
  const approve = useMutation({
    mutationFn: (userId: string) => approveSignup(token!, userId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-approvals"] }),
  });
  const reject = useMutation({
    mutationFn: (userId: string) => rejectSignup(token!, userId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-approvals"] }),
  });

  return (
    <div className="dashboard-page">
      <SubpageHeader title={t("adminApprovals.title")} />
      <main className="subpage admin-workspace">
        <section className="admin-hero">
          <div>
            <span className="eyebrow eyebrow--dark">{t("adminApprovals.accessControl")}</span>
            <h2>{t("adminApprovals.workspaceApprovals")}</h2>
            <p>{t("adminApprovals.subtitle")}</p>
          </div>
          <span className="admin-hero__badge">{t("adminApprovals.adminOnly")}</span>
        </section>

        <section className="approval-summary" aria-label={t("adminApprovals.approvalSummaryAria")}>
          <article>
            <Inbox size={18} />
            <div>
              <span>{t("adminApprovals.pending")}</span>
              <strong>{approvals.data?.requests.length ?? 0}</strong>
            </div>
          </article>
          <article>
            <UserCheck size={18} />
            <div>
              <span>{t("adminApprovals.reviewMode")}</span>
              <strong>{t("adminApprovals.manual")}</strong>
            </div>
          </article>
          <article>
            <ShieldCheck size={18} />
            <div>
              <span>{t("adminApprovals.policy")}</span>
              <strong>{t("adminApprovals.approvalRequired")}</strong>
            </div>
          </article>
        </section>

        {approvals.isLoading && <p className="context-message">{t("adminApprovals.loadingQueue")}</p>}
        {approvals.isError && <p className="error">{approvals.error.message}</p>}
        {approvals.data?.requests.length === 0 && (
          <section className="approval-empty">
            <div className="approval-empty__icon"><ShieldCheck size={32} /></div>
            <h2>{t("adminApprovals.noPending")}</h2>
            <p>{t("adminApprovals.noPendingDescription")}</p>
            <Link className="primary-link" to="/admin/dashboard">{t("common.dashboard")}</Link>
          </section>
        )}

        <section className="approval-list" aria-label={t("adminApprovals.pendingRequestsAria")}>
          {approvals.data?.requests.map((request) => (
            <article className="approval-item" key={request.userId}>
              <div className="approval-item__icon">
                <Clock3 size={20} />
              </div>
              <div className="approval-item__body">
                <strong>{request.workspaceName}</strong>
                <span>{request.ownerName ?? t("adminApprovals.workspaceOwner")} | {request.email}</span>
                <small>{request.phone || t("adminApprovals.noPhone")} | {t("adminApprovals.requestedAt", { date: formatDate(request.createdAt, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }) })}</small>
              </div>
              <div className="approval-actions">
                <button
                  className="icon-action icon-action--approve"
                  type="button"
                  title={t("adminApprovals.approve")}
                  onClick={() => approve.mutate(request.userId)}
                  disabled={approve.isPending || reject.isPending}
                >
                  <Check size={18} />
                </button>
                <button
                  className="icon-action icon-action--reject"
                  type="button"
                  title={t("adminApprovals.reject")}
                  onClick={() => reject.mutate(request.userId)}
                  disabled={approve.isPending || reject.isPending}
                >
                  <X size={18} />
                </button>
              </div>
            </article>
          ))}
        </section>
      </main>
    </div>
  );
}
