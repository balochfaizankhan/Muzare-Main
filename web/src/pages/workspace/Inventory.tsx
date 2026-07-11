import { AdminSection } from "../admin/AdminSection";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { config } from "../../config";

export function Inventory() {
  const { t } = useTranslation();
  if (!config.featureInventory) {
    return <main className="shell-page">
      <section className="shell-page__intro">
        <span className="eyebrow">{t("layout.farmOperations")}</span>
        <h1>{t("inventoryPage.disabledTitle")}</h1>
        <p>{t("inventoryPage.disabledDescription")}</p>
      </section>
      <section className="panel admin-empty-panel">
        <h2>{t("inventoryPage.disabledTitle")}</h2>
        <p>{t("inventoryPage.disabledDescription")}</p>
        <Link className="inventory-disabled__action" to="/workspace/dashboard" replace>{t("inventoryPage.backToDashboard")}</Link>
      </section>
    </main>;
  }
  return <AdminSection title={t("inventoryPage.title")} description={t("inventoryPage.description")} />;
}
