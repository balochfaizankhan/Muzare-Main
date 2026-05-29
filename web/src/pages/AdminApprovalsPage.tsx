import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Clock3, ShieldCheck, X } from "lucide-react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { SubpageHeader } from "../components/SubpageHeader";
import { approveSignup, fetchApprovals, rejectSignup } from "../lib/api";

const formatDate = (value: string) =>
  new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" })
    .format(new Date(value));

export function AdminApprovalsPage() {
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
      <SubpageHeader title="Approvals" />
      <main className="subpage admin-workspace">
        <section className="workspace-intro">
          <div>
            <h2>Workspace approvals</h2>
            <p>Review new tenant requests before they can access Muzare.</p>
          </div>
          <span className="local-pill">Admin only</span>
        </section>

        {approvals.isLoading && <p className="context-message">Loading approval queue...</p>}
        {approvals.isError && <p className="error">{approvals.error.message}</p>}
        {approvals.data?.requests.length === 0 && (
          <section className="approval-empty">
            <ShieldCheck size={34} />
            <h2>No pending requests</h2>
            <p>New workspace signups will appear here for approval.</p>
            <Link className="primary-link" to="/">Dashboard</Link>
          </section>
        )}

        <section className="approval-list" aria-label="Pending workspace requests">
          {approvals.data?.requests.map((request) => (
            <article className="approval-item" key={request.userId}>
              <div className="approval-item__icon">
                <Clock3 size={20} />
              </div>
              <div className="approval-item__body">
                <strong>{request.workspaceName}</strong>
                <span>{request.ownerName ?? "Workspace owner"} | {request.email}</span>
                <small>{request.phone || "No phone provided"} | Requested {formatDate(request.createdAt)}</small>
              </div>
              <div className="approval-actions">
                <button
                  className="icon-action icon-action--approve"
                  type="button"
                  title="Approve"
                  onClick={() => approve.mutate(request.userId)}
                  disabled={approve.isPending || reject.isPending}
                >
                  <Check size={18} />
                </button>
                <button
                  className="icon-action icon-action--reject"
                  type="button"
                  title="Reject"
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
