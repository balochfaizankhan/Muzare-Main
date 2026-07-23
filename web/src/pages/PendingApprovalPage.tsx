import { Clock3, LogOut, Mail, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { LanguageSwitch } from "../components/LanguageSwitch";

export function PendingApprovalPage() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const location = useLocation();
  const email = (location.state as { email?: string } | null)?.email ?? user?.email ?? null;

  return (
    <main className="onboarding-page">
      <div className="login-language">
        <LanguageSwitch />
      </div>
      <section className="onboarding-shell onboarding-shell--single">
        <section className="onboarding-panel account-status-panel">
          <div className="onboarding-heading">
            <Clock3 size={22} />
            <div>
              <h1>{t("accountStatus.pending.title")}</h1>
              <p>{t("accountStatus.pending.description")}</p>
            </div>
          </div>
          {email && <p className="account-status-panel__email bidi-isolate">{email}</p>}
          <div className="auth-note auth-note--signup">
            <ShieldCheck size={16} />
            <span>{t("accountStatus.pending.awaitingApproval")}</span>
          </div>
          <div className="account-status-panel__actions">
            {user
              ? <button type="button" className="account-status-panel__signout" onClick={() => void logout()}>
                  <LogOut size={16} />
                  {t("accountStatus.signOut")}
                </button>
              : <Link className="primary-link" to="/login">{t("signIn")}</Link>}
          </div>
          <p className="auth-switch account-status-panel__support">
            <Mail size={14} />
            {t("accountStatus.contactSupport")} <a href="mailto:support@muzare.com">support@muzare.com</a>
          </p>
        </section>
      </section>
    </main>
  );
}
