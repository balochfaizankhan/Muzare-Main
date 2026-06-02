import { ArrowLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { getHomePath } from "../lib/permissions";

export function SubpageHeader({ title }: { title: string }) {
  const { t } = useTranslation();
  const { user } = useAuth();

  return (
    <header className="toolbar subpage-toolbar">
      <Link className="back-link" to={user ? getHomePath(user) : "/login"} aria-label={t("backToDashboard")}>
        <ArrowLeft size={18} />
        <span>{t("common.dashboard")}</span>
      </Link>
      <h1>{title}</h1>
    </header>
  );
}
