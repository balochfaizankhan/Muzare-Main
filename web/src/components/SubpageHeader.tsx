import { ArrowLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../auth/AuthProvider";
import { useAppBack } from "../hooks/useAppBack";
import { getHomePath } from "../lib/permissions";

export function SubpageHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const back = useAppBack(user ? getHomePath(user) : "/login");

  return (
    <header className="toolbar subpage-toolbar">
      <button type="button" className="back-link" aria-label={t("backToDashboard")} onClick={back}>
        <ArrowLeft size={18} />
        <span>{t("common.dashboard")}</span>
      </button>
      <div className="subpage-toolbar__stack">
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
    </header>
  );
}
