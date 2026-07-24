import { AdminSection } from "./AdminSection";
import { BuildDiagnostics } from "../../components/BuildDiagnostics";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
export function Settings() {
  const { t } = useTranslation();
  return <>
    <AdminSection
      title="adminSettings.title"
      description="adminSettings.description"
      emptyTitle="adminSettings.emptyTitle"
      emptyDescription="adminSettings.emptyDescription"
    />
    <main className="shell-page">
      <BuildDiagnostics />
      <section className="record-panel">
        <h2>{t("adminSettings.reconciliationTraceTitle")}</h2>
        <p>{t("adminSettings.reconciliationTraceDescription")}</p>
        <Link to="/admin/accounting-reconciliation-debug">
          {t("adminSettings.reconciliationTraceLink")}
        </Link>
      </section>
    </main>
  </>;
}
