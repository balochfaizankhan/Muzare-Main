import { Languages } from "lucide-react";
import { useTranslation } from "react-i18next";

export function LanguageSwitch() {
  const { i18n, t } = useTranslation();

  const setLanguage = async (language: "en" | "ar" | "ur") => {
    await i18n.changeLanguage(language);
    window.localStorage.setItem("muzare-language", language);
  };

  return (
    <label className="language-switch">
      <Languages size={17} aria-hidden="true" />
      <span className="sr-only">{t("language.label")}</span>
      <select
        className="language-switch__select language-switch__select--full"
        aria-label={t("language.label")}
        value={i18n.resolvedLanguage?.slice(0, 2) ?? "en"}
        onChange={(event) => void setLanguage(event.target.value as "en" | "ar" | "ur")}
      >
        <option value="en">{t("language.english")}</option>
        <option value="ar">{t("language.arabic")}</option>
        <option value="ur">{t("language.urdu")}</option>
      </select>
      <select
        className="language-switch__select language-switch__select--compact"
        aria-label={t("language.label")}
        value={i18n.resolvedLanguage?.slice(0, 2) ?? "en"}
        onChange={(event) => void setLanguage(event.target.value as "en" | "ar" | "ur")}
      >
        <option value="en">EN</option>
        <option value="ar">AR</option>
        <option value="ur">UR</option>
      </select>
    </label>
  );
}
