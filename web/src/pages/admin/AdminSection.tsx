import { useTranslation } from "react-i18next";

export function AdminSection({ title, description, emptyTitle = "No records yet", emptyDescription }: {
  title: string;
  description: string;
  emptyTitle?: string;
  emptyDescription?: string;
}) {
  const { t } = useTranslation();
  return <main className="shell-page">
    <section className="shell-page__intro">
      <span className="eyebrow">{t("layout.platformAdministrationEyebrow")}</span>
      <h1>{title}</h1>
      <p>{description}</p>
    </section>
    <section className="panel admin-empty-panel">
      <h2>{emptyTitle}</h2>
      <p>{emptyDescription ?? description}</p>
    </section>
  </main>;
}
