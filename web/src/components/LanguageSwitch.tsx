import { Languages } from "lucide-react";
import { useTranslation } from "react-i18next";

export function LanguageSwitch() {
  const { i18n } = useTranslation();

  const setLanguage = async (language: "en" | "ar" | "ur") => {
    await i18n.changeLanguage(language);
    window.localStorage.setItem("muzare-language", language);
  };

  return (
    <label className="language-switch">
      <Languages size={17} aria-hidden="true" />
      <span className="sr-only">Language</span>
      <select
        value={i18n.resolvedLanguage?.slice(0, 2) ?? "en"}
        onChange={(event) => void setLanguage(event.target.value as "en" | "ar" | "ur")}
      >
        <option value="en">English</option>
        <option value="ar">العربية</option>
        <option value="ur">اردو</option>
      </select>
    </label>
  );
}
