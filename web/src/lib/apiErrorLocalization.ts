import i18n from "../i18n";
import { apiErrorCatalog, apiErrorPatternRules } from "../locales/apiErrorCatalog";
import { apiErrorCatalogExtra, apiErrorPatternRulesExtra } from "../locales/apiErrorCatalogExtra";

// Reverse index: exact backend English message -> fully-qualified i18n key. Built once at
// module load. Each catalog resolves under its own namespace so the two files never collide.
const exactMessageIndex = new Map<string, string>([
  ...Object.entries(apiErrorCatalog.en).map(([key, message]) => [message, `apiErrors.catalog.${key}`] as const),
  ...Object.entries(apiErrorCatalogExtra.en).map(([key, message]) => [message, `apiErrors.catalogExtra.${key}`] as const),
]);

const patternRules = [
  ...apiErrorPatternRules.map((rule) => ({ ...rule, i18nKey: `apiErrors.catalog.${rule.key}` })),
  ...apiErrorPatternRulesExtra.map((rule) => ({ ...rule, i18nKey: `apiErrors.catalogExtra.${rule.key}` })),
];

const activeLanguage = () => (i18n.resolvedLanguage ?? i18n.language ?? "en").slice(0, 2);

/**
 * Resolves a raw backend error message to text in the active UI language.
 *
 * - Known messages (exact catalog match or pattern rule) translate through the
 *   apiErrors.catalog.* dictionary in every language.
 * - Unknown messages: English sessions show the backend text verbatim; Urdu/Arabic sessions
 *   get the generic localized failure message instead of leaking English — the original text
 *   is logged so the missing catalog entry can be added.
 */
export function localizeApiErrorMessage(rawMessage: string | null | undefined, statusCode?: number): string {
  const raw = rawMessage?.trim();
  if (!raw) {
    return typeof statusCode === "number"
      ? i18n.t("apiErrors.requestFailedWithStatus", { status: statusCode })
      : i18n.t("apiErrors.requestFailedGeneric");
  }
  const exactKey = exactMessageIndex.get(raw);
  if (exactKey) return i18n.t(exactKey);
  for (const rule of patternRules) {
    const match = raw.match(rule.pattern);
    if (match) return i18n.t(rule.i18nKey, rule.vars?.(match));
  }
  if (activeLanguage() === "en") return raw;
  console.warn(`[i18n] Uncatalogued API error message (add it to locales/apiErrorCatalog.ts): ${raw}`);
  return i18n.t("apiErrors.requestFailedGeneric");
}

/** Localized " Missing or invalid fields: a, b." suffix for validation errors. */
export function localizeMissingFieldsSuffix(fields: string[] | undefined | null): string {
  if (!fields?.length) return "";
  return ` ${i18n.t("apiErrors.missingFields", { fields: fields.join(", ") })}`;
}
