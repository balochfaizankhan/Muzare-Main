import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { SubpageHeader } from "../components/SubpageHeader";

export function NotFoundPage() {
  const { t } = useTranslation();

  return (
    <div className="dashboard-page">
      <SubpageHeader title={t("notFound")} />
      <main className="subpage empty-page">
        <h2>{t("notFound")}</h2>
        <p>{t("notFoundNotice")}</p>
        <Link className="primary-link" to="/">
          {t("backToDashboard")}
        </Link>
      </main>
    </div>
  );
}
