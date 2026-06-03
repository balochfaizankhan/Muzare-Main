import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { acceptWorkspaceInvitation } from "../lib/api";

export function AcceptInvitationPage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const [displayName, setDisplayName] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      await acceptWorkspaceInvitation({ token: params.get("token") ?? "", displayName, phone, password });
      setMessage(t("workspaceTeam.accepted"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("workspaceTeam.acceptFailed"));
    }
  };
  return <div className="login-page"><section className="login-panel"><h1>{t("workspaceTeam.acceptTitle")}</h1><p>{t("workspaceTeam.acceptDescription")}</p>{message ? <p className="success">{message}</p> : <form className="login-form" onSubmit={submit}><input required placeholder={t("workspaceTeam.name")} value={displayName} onChange={(event) => setDisplayName(event.target.value)} /><input placeholder={t("workspaceTeam.phone")} value={phone} onChange={(event) => setPhone(event.target.value)} /><input required minLength={8} type="password" placeholder={t("workspaceTeam.password")} value={password} onChange={(event) => setPassword(event.target.value)} /><button type="submit">{t("workspaceTeam.accept")}</button>{error && <p className="error">{error}</p>}</form>}</section></div>;
}
