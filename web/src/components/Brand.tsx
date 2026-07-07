import { useTranslation } from "react-i18next";

export function Brand({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();

  return (
    <div className={`brand ${compact ? "brand--compact" : ""}`}>
      <img className="brand__logo" src="/assets/muzare-logo.png" alt="Muzare" />
      {!compact && <p className="brand__tagline">{t("tagline")}</p>}
    </div>
  );
}
