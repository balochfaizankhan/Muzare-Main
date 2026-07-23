import type { TFunction } from "i18next";

const titleCase = (value: string) => value
  .toLowerCase()
  .replaceAll("_", " ")
  .replace(/^./, (letter) => letter.toUpperCase());

/**
 * Translates a raw backend status/enum value (e.g. "UNPAID", "half_day", "REVERSED") through the
 * shared `status.*` dictionary so every module renders the same localized label for the same
 * backend value. Falls back to a title-cased rendering of the raw value for statuses that have no
 * dictionary entry yet, so unknown/new enum values never crash or render a raw i18n key.
 */
export function translateStatus(t: TFunction, raw: string | null | undefined): string {
  if (!raw) return "";
  const key = raw.trim().toLowerCase().replaceAll(" ", "_");
  return t(`status.${key}`, { defaultValue: titleCase(raw) });
}
