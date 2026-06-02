import i18n from "../i18n";

const localeMap: Record<string, string> = {
  en: "en",
  ur: "ur-PK",
  ar: "ar-SA",
};

const currentLocale = () => localeMap[i18n.resolvedLanguage?.slice(0, 2) ?? i18n.language?.slice(0, 2) ?? "en"] ?? "en";

export const formatMoney = (amount: number) =>
  new Intl.NumberFormat(currentLocale(), {
    style: "currency",
    currency: "SAR",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount);

export const formatNumber = (value: number, options?: Intl.NumberFormatOptions) =>
  new Intl.NumberFormat(currentLocale(), options).format(value);

export const formatDate = (value: Date | string, options?: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(currentLocale(), options).format(typeof value === "string" ? new Date(value) : value);
