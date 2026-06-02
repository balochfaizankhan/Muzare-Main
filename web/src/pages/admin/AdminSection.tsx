import { useTranslation } from "react-i18next";

export function AdminSection({ title, description }: { title: string; description: string }) {
  const { t } = useTranslation();
  return <main className="shell-page"><section className="shell-page__intro"><span className="eyebrow">{t("layout.platformAdministrationEyebrow")}</span><h1>{title}</h1><p>{description}</p></section></main>;
}
