import i18n from "../i18n";

const currentLocale = () => i18n.resolvedLanguage ?? i18n.language ?? "en";

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
