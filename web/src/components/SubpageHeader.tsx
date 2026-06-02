import { ArrowLeft, LogOut } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { getHomePath } from "../lib/permissions";

export function SubpageHeader({ title }: { title: string }) {
  const { t } = useTranslation();
  const { user, logout } = useAuth();

  return (
    <header className="toolbar subpage-toolbar">
      <Link className="back-link" to={user ? getHomePath(user) : "/login"} aria-label={t("backToDashboard")}>
        <ArrowLeft size={18} />
        <span>{t("dashboard")}</span>
      </Link>
      <h1>{title}</h1>
      <div className="toolbar__actions">
        <button className="ghost-icon" onClick={() => void logout()} title={t("logout")}>
          <LogOut size={18} />
        </button>
      </div>
    </header>
  );
}
