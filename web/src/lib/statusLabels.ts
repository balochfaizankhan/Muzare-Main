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

/**
 * Localizes a canonical labour journal event type (DUE_RECOGNITION, ADVANCE_PAYMENT,
 * ADVANCE_APPLICATION, DUE_PAYMENT, ADVANCE_REFUND, REVERSAL) plus the advance-pool activity
 * types (ADVANCE_RECORDED, APPLIED_TO_DUE, APPLICATION_REVERSED, RECOVERY_RECORDED,
 * VOUCHER_REVERSED). A REVERSAL is rendered as "Reversed <original event>" through the
 * labourEvent.reversalOf template so the whole phrase stays in the active language.
 */
export function translateLabourEventType(t: TFunction, eventType: string | null | undefined, originalEventType?: string | null): string {
  if (!eventType) return t("labourEvent.fallback");
  const key = eventType.trim().toUpperCase().replaceAll(" ", "_");
  if (key === "REVERSAL") {
    return t("labourEvent.reversalOf", {
      event: originalEventType ? translateLabourEventType(t, originalEventType) : t("labourEvent.fallback"),
    });
  }
  return t(`labourEvent.${key}`, { defaultValue: t("labourEvent.fallback") });
}

/**
 * Localizes a payment method (cash, bank_transfer, cheque, mobile, other...). Payment methods
 * share the status dictionary today; this alias exists so call sites read correctly and the
 * backing dictionary can be split later without touching consumers.
 */
export function translatePaymentMethod(t: TFunction, method: string | null | undefined): string {
  return translateStatus(t, method);
}

/**
 * Backend fallback/sentinel display strings ("Unresolved recipient", "Partner account", ...)
 * and system-seeded record names ("Cash", "Partner Capital"). These arrive inside data fields
 * (recipientName, accountName, description) where real user-entered values also live, so they
 * are matched EXACTLY and everything else passes through untranslated — user data is never
 * auto-translated.
 */
const backendSentinelKeys: Record<string, string> = {
  "Unresolved recipient": "backendSentinel.unresolvedRecipient",
  "Recipient unavailable": "backendSentinel.recipientUnavailable",
  "Unknown labour recipient": "backendSentinel.unknownLabourRecipient",
  "Unresolved payment source": "backendSentinel.unresolvedPaymentSource",
  "Partner account": "backendSentinel.partnerAccount",
  "Applied advances": "backendSentinel.appliedAdvances",
  "Labour advance": "backendSentinel.labourAdvance",
  "Group advance": "backendSentinel.groupAdvance",
  "Labour financial event": "labourEvent.fallback",
  "Financial reversal": "backendSentinel.financialReversal",
  Cash: "backendSentinel.cashAccount",
  "Partner Capital": "backendSentinel.partnerCapitalAccount",
  "Voided settlement": "backendSentinel.voidedSettlement",
};

// System-generated description templates the backend bakes into read-model rows or stored
// records. Matched by shape; reference numbers and user-entered reasons pass through as
// interpolation values.
const backendSentinelPatterns: Array<{ pattern: RegExp; key: string; vars: (match: RegExpMatchArray) => Record<string, unknown> }> = [
  { pattern: /^Advance applied to Labour Due (.+) — balance effect SAR 0$/, key: "backendSentinel.advanceAppliedToDue", vars: (match) => ({ dueNumber: match[1] }) },
  { pattern: /^Applied advances to (.+)$/, key: "backendSentinel.appliedAdvancesTo", vars: (match) => ({ dueNumber: match[1] }) },
  { pattern: /^Reversal of Labour Wage Settlement (.+)$/, key: "backendSentinel.reversalOfSettlement", vars: (match) => ({ settlementNumber: match[1] }) },
  { pattern: /^Reversal of ([^:]+): (.+)$/, key: "backendSentinel.reversalOfVoucherWithReason", vars: (match) => ({ voucherNumber: match[1], reason: match[2] }) },
  { pattern: /^Labour Wage Settlement (.+)$/, key: "backendSentinel.labourWageSettlement", vars: (match) => ({ settlementNumber: match[1] }) },
];

export function localizeSystemPlaceholder(t: TFunction, value: string | null | undefined): string {
  if (!value) return "";
  const trimmed = value.trim();
  const key = backendSentinelKeys[trimmed];
  if (key) return t(key);
  for (const rule of backendSentinelPatterns) {
    const match = trimmed.match(rule.pattern);
    if (match) return t(rule.key, rule.vars(match)) as string;
  }
  return value;
}

/**
 * Localizes a labour payment voucher nature (ADVANCE, FINAL_PAYMENT,
 * SETTLEMENT_BALANCE_PAYMENT, DIRECT_LABOUR_PAYMENT, ADVANCE_APPLICATION, REFUND_RECOVERY,
 * REVERSAL) through the voucherNature.* dictionary.
 */
export function translateVoucherNature(t: TFunction, nature: string | null | undefined): string {
  if (!nature) return "";
  const key = nature.trim().toUpperCase().replaceAll(" ", "_");
  return t(`voucherNature.${key}`, { defaultValue: translateStatus(t, nature) });
}
