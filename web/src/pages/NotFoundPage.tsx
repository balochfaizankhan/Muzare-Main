import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "../auth/AuthProvider";
import { getHomePath } from "../lib/permissions";

export function NotFoundPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const homePath = user ? getHomePath(user) : "/login";

  return (
    <div className="app-startup-screen app-route-fallback">
      <main className="app-startup-screen__card app-route-fallback__card">
        <strong>{t("notFound")}</strong>
        <p>{t("notFoundNotice")}</p>
        <div className="app-route-fallback__actions">
          <Link className="primary-link" to={homePath}>
            {t("backToDashboard")}
          </Link>
        </div>
      </main>
    </div>
  );
}
