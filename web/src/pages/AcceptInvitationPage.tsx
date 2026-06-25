import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../auth/AuthProvider";
import { acceptWorkspaceInvitation, lookupWorkspaceInvitation } from "../lib/api";
import { getHomePath } from "../lib/permissions";

export function AcceptInvitationPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user, token, login, switchWorkspace, completeSession } = useAuth();
  const [params] = useSearchParams();
  const inviteToken = params.get("token") ?? "";
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const lookup = useQuery({
    queryKey: ["workspace-invitation", inviteToken],
    queryFn: () => lookupWorkspaceInvitation(inviteToken),
    enabled: Boolean(inviteToken),
  });
  const invitation = lookup.data?.invitation;
  const invitedEmail = invitation?.email ?? "";
  useEffect(() => {
    if (invitedEmail) setEmail(invitedEmail);
  }, [invitedEmail]);

  const canUseSession = Boolean(user && token && invitation?.status === "pending");
  const loginLink = useMemo(() => `/login?redirect=${encodeURIComponent(`/accept-invitation?token=${inviteToken}`)}`, [inviteToken]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      if (canUseSession && token) {
        const accepted = await acceptWorkspaceInvitation({ token: inviteToken, mode: "session" }, token);
        await switchWorkspace(accepted.workspaceId);
        navigate("/workspace/dashboard", { replace: true });
        return;
      }
      const accepted = await acceptWorkspaceInvitation(mode === "login"
        ? { token: inviteToken, mode: "login", email, password }
        : { token: inviteToken, mode: "signup", displayName, password, phone });
      if (accepted.token && accepted.user) {
        await completeSession(accepted.token, accepted.user);
        navigate(getHomePath(accepted.user), { replace: true });
        return;
      }
      if (mode === "login") {
        await login(email, password);
        navigate("/workspace/dashboard", { replace: true });
        return;
      }
      setMessage(t("workspaceTeam.accepted"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("workspaceTeam.acceptFailed"));
    }
  };
  if (user && !canUseSession && invitation?.status === "pending" && user.email.toLowerCase() !== invitedEmail.toLowerCase()) {
    return <div className="login-page"><section className="login-panel"><h1>{t("workspaceTeam.acceptTitle")}</h1><p>{t("workspaceTeam.invitedForDifferentEmail")}</p></section></div>;
  }
  if (user && invitation?.status === "accepted") return <Navigate to={getHomePath(user)} replace />;

  return <div className="login-page"><section className="login-panel"><h1>{t("workspaceTeam.acceptTitle")}</h1><p>{t("workspaceTeam.acceptDescription")}</p>
    {lookup.isLoading && <p>{t("workspaceTeam.loadingInvitation")}</p>}
    {lookup.isError && <p className="error">{lookup.error instanceof Error ? lookup.error.message : t("workspaceTeam.acceptFailed")}</p>}
    {invitation && <>
      <div className="invite-share">
        <p><strong>{invitation.workspaceName ?? "Muzare Workspace"}</strong></p>
        <p>{invitedEmail}</p>
        <p>{t(`workspaceTeam.roles.${invitation.role}`)}</p>
        <p>{t("workspaceTeam.invitedByLabel")} {invitation.inviterName ?? invitation.inviterEmail ?? "-"}</p>
      </div>
      {invitation.status !== "pending" ? (
        <p className="error">{invitation.status === "accepted" ? t("workspaceTeam.inviteAlreadyAccepted") : invitation.status === "cancelled" ? t("workspaceTeam.inviteCancelled") : invitation.status === "expired" ? t("workspaceTeam.inviteExpired") : t("workspaceTeam.inviteInvalid")}</p>
      ) : message ? <p className="success">{message}</p> : canUseSession ? (
        <form className="login-form" onSubmit={submit}>
          <button type="submit">{t("workspaceTeam.accept")}</button>
          {error && <p className="error">{error}</p>}
        </form>
      ) : <>
        <div className="record-list__actions">
          <button type="button" className={mode === "login" ? "" : "secondary-button"} onClick={() => setMode("login")}>{t("login")}</button>
          <button type="button" className={mode === "signup" ? "" : "secondary-button"} onClick={() => setMode("signup")}>{t("signup")}</button>
        </div>
        {mode === "login" ? <form className="login-form" onSubmit={submit}>
          <input required type="email" placeholder={t("workspaceTeam.email")} value={email} onChange={(event) => setEmail(event.target.value)} />
          <input required minLength={8} type="password" placeholder={t("workspaceTeam.password")} value={password} onChange={(event) => setPassword(event.target.value)} />
          <button type="submit">{t("workspaceTeam.signInAndAccept")}</button>
          <p><Link to={loginLink}>{t("workspaceTeam.openFullLogin")}</Link></p>
          {error && <p className="error">{error}</p>}
        </form> : <form className="login-form" onSubmit={submit}>
          <input required placeholder={t("workspaceTeam.name")} value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          <input placeholder={t("workspaceTeam.phone")} value={phone} onChange={(event) => setPhone(event.target.value)} />
          <input required minLength={8} type="password" placeholder={t("workspaceTeam.password")} value={password} onChange={(event) => setPassword(event.target.value)} />
          <button type="submit">{t("workspaceTeam.createAccountAndAccept")}</button>
          {error && <p className="error">{error}</p>}
        </form>}
      </>}
    </>}
  </section></div>;
}
