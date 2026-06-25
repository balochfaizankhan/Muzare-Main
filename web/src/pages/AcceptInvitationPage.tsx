import { LockKeyhole, LogIn, Mail, ShieldCheck, UserPlus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../auth/AuthProvider";
import { acceptWorkspaceInvitation, lookupWorkspaceInvitation, registerAndAcceptWorkspaceInvitation } from "../lib/api";
import { getHomePath } from "../lib/permissions";

const pendingInvitationTokenKey = "muzare-pending-invitation-token";

export function AcceptInvitationPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user, token, logout, switchWorkspace, completeSession } = useAuth();
  const [params] = useSearchParams();
  const paramToken = params.get("token")?.trim() ?? "";
  const autoAccept = params.get("autoAccept") === "1";
  const [persistedToken, setPersistedToken] = useState(() => window.localStorage.getItem(pendingInvitationTokenKey) ?? "");
  const inviteToken = paramToken || persistedToken;
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState<"accept" | "login" | "signup" | "logout" | null>(null);

  useEffect(() => {
    if (!paramToken) return;
    window.localStorage.setItem(pendingInvitationTokenKey, paramToken);
    setPersistedToken(paramToken);
  }, [paramToken]);

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

  useEffect(() => {
    if (invitation?.status && invitation.status !== "pending") {
      window.localStorage.removeItem(pendingInvitationTokenKey);
      setPersistedToken("");
    }
  }, [invitation?.status]);

  const canUseSession = Boolean(user && token && invitation?.status === "pending" && user.email.toLowerCase() === invitedEmail.toLowerCase());
  const accountExists = Boolean(invitation?.accountExists);
  const loginLink = useMemo(() => `/login?redirect=${encodeURIComponent(`/accept-invitation?token=${inviteToken}&autoAccept=1`)}`, [inviteToken]);
  const sameEmailLoggedIn = Boolean(user && invitedEmail && user.email.toLowerCase() === invitedEmail.toLowerCase());
  const differentEmailLoggedIn = Boolean(user && invitedEmail && user.email.toLowerCase() !== invitedEmail.toLowerCase());

  const finishAcceptance = useCallback(async (accepted: { token?: string; user?: Parameters<typeof completeSession>[1]; workspaceId: string }) => {
    window.localStorage.removeItem(pendingInvitationTokenKey);
    setPersistedToken("");
    if (accepted.token && accepted.user) {
      await completeSession(accepted.token, accepted.user);
      navigate(getHomePath(accepted.user), { replace: true });
      return;
    }
    await switchWorkspace(accepted.workspaceId);
    navigate("/workspace/dashboard", { replace: true });
  }, [completeSession, navigate, switchWorkspace]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setMessage("");
    try {
      if (!inviteToken) {
        setError(t("workspaceTeam.missingTokenDescription"));
        return;
      }
      if (canUseSession && token) {
        setSubmitting("accept");
        const accepted = await acceptWorkspaceInvitation({ token: inviteToken, mode: "session" }, token);
        await finishAcceptance(accepted);
        return;
      }

      if (accountExists) {
        setSubmitting("login");
        const accepted = await acceptWorkspaceInvitation({ token: inviteToken, mode: "login", email, password });
        await finishAcceptance(accepted);
      } else {
        if (password !== confirmPassword) {
          setError(t("workspaceTeam.passwordMismatch"));
          return;
        }
        setSubmitting("signup");
        const accepted = await registerAndAcceptWorkspaceInvitation({ token: inviteToken, displayName, password, phone });
        await finishAcceptance(accepted);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("workspaceTeam.acceptFailed"));
    } finally {
      setSubmitting(null);
    }
  };

  useEffect(() => {
    if (!autoAccept || !canUseSession || !token || submitting) return;
    void (async () => {
      try {
        setError("");
        setSubmitting("accept");
        const accepted = await acceptWorkspaceInvitation({ token: inviteToken, mode: "session" }, token);
        await finishAcceptance(accepted);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : t("workspaceTeam.acceptFailed"));
      } finally {
        setSubmitting(null);
      }
    })();
  }, [autoAccept, canUseSession, finishAcceptance, inviteToken, submitting, t, token]);

  if (user && invitation?.status === "accepted") return <Navigate to={getHomePath(user)} replace />;

  const invitationStatusMessage = invitation?.status === "accepted"
    ? t("workspaceTeam.inviteAlreadyAccepted")
    : invitation?.status === "cancelled"
      ? t("workspaceTeam.inviteCancelled")
      : invitation?.status === "expired"
        ? t("workspaceTeam.inviteExpired")
        : t("workspaceTeam.inviteInvalid");

  return (
    <main className="login-page">
      <section className="login-hero" aria-label={t("workspaceTeam.acceptTitle")}>
        <div className="login-brand-lockup">
          <span className="auth-logo" role="img" aria-label="Muzare" />
          <div>
            <strong>Muzare</strong>
            <span>مزارع</span>
          </div>
        </div>
        <div className="login-hero__copy">
          <span className="auth-kicker">{t("workspaceTeam.inviteKicker")}</span>
          <h1>{t("workspaceTeam.acceptTitle")}</h1>
          <p>{t("workspaceTeam.acceptDescription")}</p>
        </div>
      </section>

      <section className="login-panel" aria-label={t("workspaceTeam.acceptTitle")}>
        <section className="login-card invite-card">
          <div className="login-card__header">
            <span className="auth-logo" role="img" aria-label="Muzare" />
            <div>
              <h2>{t("workspaceTeam.acceptTitle")}</h2>
              <p>{t("workspaceTeam.acceptPanelDescription")}</p>
            </div>
          </div>

          {!inviteToken ? (
            <div className="invite-status-card">
              <p className="error">{t("workspaceTeam.missingTokenDescription")}</p>
              <Link className="login-secondary" to="/login">{t("login")}</Link>
            </div>
          ) : lookup.isLoading ? (
            <div className="invite-status-card">
              <div className="auth-note">
                <ShieldCheck size={16} />
                <span>{t("workspaceTeam.loadingInvitation")}</span>
              </div>
            </div>
          ) : lookup.isError ? (
            <div className="invite-status-card">
              <p className="error">{lookup.error instanceof Error ? lookup.error.message : t("workspaceTeam.acceptFailed")}</p>
              <button className="secondary-button invite-action-button" type="button" onClick={() => void lookup.refetch()}>
                {t("workspaceTeam.retry")}
              </button>
            </div>
          ) : invitation ? (
            <>
              <div className="invite-share invite-share--detail">
                <p><strong>{invitation.workspaceName ?? "Muzare Workspace"}</strong></p>
                <p>{invitedEmail}</p>
                <p>{t(`workspaceTeam.roles.${invitation.role}`)}</p>
                <p>{t("workspaceTeam.invitedByLabel")} {invitation.inviterName ?? invitation.inviterEmail ?? "-"}</p>
              </div>

              {invitation.status !== "pending" ? (
                <div className="invite-status-card">
                  <p className="error">{invitationStatusMessage}</p>
                  <Link className="login-secondary" to="/login">{t("login")}</Link>
                </div>
              ) : message ? (
                <p className="success">{message}</p>
              ) : differentEmailLoggedIn ? (
                <div className="invite-status-card">
                  <p className="error">{t("workspaceTeam.invitedForDifferentEmail")}</p>
                  <div className="record-list__actions">
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => {
                        setSubmitting("logout");
                        void logout().finally(() => setSubmitting(null));
                      }}
                      disabled={submitting === "logout"}
                    >
                      {submitting === "logout" ? t("workspaceTeam.signingOut") : t("logout")}
                    </button>
                    <Link className="login-secondary invite-inline-link" to={loginLink}>{t("workspaceTeam.openFullLogin")}</Link>
                  </div>
                </div>
              ) : canUseSession || sameEmailLoggedIn ? (
                <form className="login-form" onSubmit={submit}>
                  <div className="auth-note">
                    <ShieldCheck size={16} />
                    <span>{t("workspaceTeam.readyToJoin")}</span>
                  </div>
                  <button type="submit" disabled={submitting === "accept"}>
                    <ShieldCheck size={17} />
                    <span>{submitting === "accept" ? t("workspaceTeam.acceptingInvitation") : t("workspaceTeam.accept")}</span>
                  </button>
                  {error && <p className="error">{error}</p>}
                </form>
              ) : accountExists ? (
                <form className="login-form" onSubmit={submit}>
                  <div className="auth-note">
                    <LogIn size={16} />
                    <span>{t("workspaceTeam.signInDescription")}</span>
                  </div>
                  <label className="login-field">
                    <span>{t("workspaceTeam.email")}</span>
                    <div className="login-input-wrap">
                      <Mail size={18} />
                      <input type="email" value={email} readOnly aria-readonly="true" />
                    </div>
                  </label>
                  <label className="login-field">
                    <span>{t("workspaceTeam.password")}</span>
                    <div className="login-input-wrap">
                      <LockKeyhole size={18} />
                      <input required minLength={8} type="password" autoComplete="current-password" placeholder={t("workspaceTeam.password")} value={password} onChange={(event) => setPassword(event.target.value)} />
                    </div>
                  </label>
                  <button type="submit" disabled={submitting === "login"}>
                    <LogIn size={17} />
                    <span>{submitting === "login" ? t("workspaceTeam.signingIn") : t("workspaceTeam.signInAndAccept")}</span>
                  </button>
                  <p className="auth-switch">
                    <Link to={loginLink}>{t("workspaceTeam.openFullLogin")}</Link>
                  </p>
                  {error && <p className="error">{error}</p>}
                </form>
              ) : (
                <form className="login-form" onSubmit={submit}>
                  <div className="auth-note">
                    <UserPlus size={16} />
                    <span>{t("workspaceTeam.createPasswordDescription")}</span>
                  </div>
                  <label className="login-field">
                    <span>{t("workspaceTeam.email")}</span>
                    <div className="login-input-wrap">
                      <Mail size={18} />
                      <input type="email" value={email} readOnly aria-readonly="true" />
                    </div>
                  </label>
                  <label className="login-field">
                    <span>{t("workspaceTeam.name")}</span>
                    <div className="login-input-wrap">
                      <UserPlus size={18} />
                      <input required value={displayName} placeholder={t("workspaceTeam.name")} onChange={(event) => setDisplayName(event.target.value)} />
                    </div>
                  </label>
                  <label className="login-field">
                    <span>{t("workspaceTeam.phone")}</span>
                    <div className="login-input-wrap">
                      <Mail size={18} />
                      <input value={phone} placeholder={t("workspaceTeam.phone")} onChange={(event) => setPhone(event.target.value)} />
                    </div>
                  </label>
                  <label className="login-field">
                    <span>{t("workspaceTeam.createPassword")}</span>
                    <div className="login-input-wrap">
                      <LockKeyhole size={18} />
                      <input required minLength={8} type="password" autoComplete="new-password" placeholder={t("workspaceTeam.createPassword")} value={password} onChange={(event) => setPassword(event.target.value)} />
                    </div>
                  </label>
                  <label className="login-field">
                    <span>{t("workspaceTeam.confirmPassword")}</span>
                    <div className="login-input-wrap">
                      <LockKeyhole size={18} />
                      <input required minLength={8} type="password" autoComplete="new-password" placeholder={t("workspaceTeam.confirmPassword")} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
                    </div>
                  </label>
                  <button type="submit" disabled={submitting === "signup"}>
                    <UserPlus size={17} />
                    <span>{submitting === "signup" ? t("workspaceTeam.creatingAccount") : t("workspaceTeam.createAccountAndAccept")}</span>
                  </button>
                  {error && <p className="error">{error}</p>}
                </form>
              )}
            </>
          ) : (
            <div className="invite-status-card">
              <p className="error">{t("workspaceTeam.inviteInvalid")}</p>
            </div>
          )}
        </section>
      </section>
    </main>
  );
}
