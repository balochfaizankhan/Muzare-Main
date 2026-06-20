import { useTranslation } from "react-i18next";

export function AdminSection({ title, description, emptyTitle, emptyDescription }: {
  title: string;
  description: string;
  emptyTitle?: string;
  emptyDescription?: string;
}) {
  const { t } = useTranslation();
  return <main className="shell-page">
    <section className="shell-page__intro">
      <span className="eyebrow">{t("layout.platformAdministrationEyebrow")}</span>
      <h1>{t(title)}</h1>
      <p>{t(description)}</p>
    </section>
    <section className="panel admin-empty-panel">
      <h2>{t(emptyTitle || "adminShared.noRecordsYet")}</h2>
      <p>{t(emptyDescription ?? description)}</p>
    </section>
  </main>;
}
