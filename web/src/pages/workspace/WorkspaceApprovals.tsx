import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../auth/AuthProvider";
import { SubpageHeader } from "../../components/SubpageHeader";
import { decideWorkspaceApproval, fetchWorkspaceApprovals } from "../../lib/api";
import { formatDate } from "../../lib/format";

export function WorkspaceApprovals() {
  const { t } = useTranslation();
  const { token, user } = useAuth();
  const client = useQueryClient();
  const workspaceId = user?.workspaceId ?? "";
  const [note, setNote] = useState("");
  const approvals = useQuery({ queryKey: ["workspace-approvals", workspaceId], queryFn: () => fetchWorkspaceApprovals(token!, workspaceId), enabled: Boolean(token && workspaceId) });
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: "approved" | "rejected" }) => decideWorkspaceApproval(token!, workspaceId, id, decision, note),
    onSuccess: async () => { setNote(""); await client.invalidateQueries({ queryKey: ["workspace-approvals", workspaceId] }); },
  });
  return <div className="dashboard-page"><SubpageHeader title={t("workspaceApprovals.title")} /><main className="subpage module-workspace"><section className="workspace-intro"><div><h2>{t("workspaceApprovals.heading")}</h2><p>{t("workspaceApprovals.description")}</p></div></section><section className="record-panel">
    <label className="approval-note">{t("workspaceApprovals.note")}<input value={note} onChange={(event) => setNote(event.target.value)} /></label>
    {approvals.isLoading && <p>{t("workspaceApprovals.loading")}</p>}
    {approvals.isError && <p className="error">{approvals.error.message}</p>}
    {approvals.data?.approvals.map((approval) => <article className="team-card" key={approval.id}><div><strong>{t(`workspaceApprovals.types.${approval.entityType}`)}</strong><span>{approval.entityId}</span><small>{formatDate(approval.createdAt, { day: "2-digit", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" })}</small></div><div className="team-card__actions"><button type="button" onClick={() => decide.mutate({ id: approval.id, decision: "approved" })}>{t("workspaceApprovals.approve")}</button><button className="danger-button" type="button" onClick={() => decide.mutate({ id: approval.id, decision: "rejected" })}>{t("workspaceApprovals.reject")}</button></div></article>)}
    {approvals.data?.approvals.length === 0 && <p>{t("workspaceApprovals.empty")}</p>}
  </section></main></div>;
}
