import { AlertTriangle, LogOut, Mail } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { LanguageSwitch } from "../components/LanguageSwitch";

export function AccountSuspendedPage() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();

  return (
    <main className="onboarding-page">
      <div className="login-language">
        <LanguageSwitch />
      </div>
      <section className="onboarding-shell onboarding-shell--single">
        <section className="onboarding-panel account-status-panel">
          <div className="onboarding-heading">
            <AlertTriangle size={22} />
            <div>
              <h1>{t("accountStatus.suspended.title")}</h1>
              <p>{t("accountStatus.suspended.description")}</p>
            </div>
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
