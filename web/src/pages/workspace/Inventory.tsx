import { AdminSection } from "../admin/AdminSection";
import { useTranslation } from "react-i18next";

export function Inventory() {
  const { t } = useTranslation();
  return <AdminSection title={t("inventoryPage.title")} description={t("inventoryPage.description")} />;
}
