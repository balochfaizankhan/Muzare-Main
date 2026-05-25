import { useTranslation } from "react-i18next";

export function Brand({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();

  return (
    <div className={`brand ${compact ? "brand--compact" : ""}`}>
      <img className="brand__mark" src="/muzare-mark.svg" alt="" />
      <div>
        <p className="brand__name">
          <span lang="ar">مُزارع</span> Muzare
        </p>
        <p className="brand__tagline">{t("tagline")}</p>
      </div>
    </div>
  );
}
