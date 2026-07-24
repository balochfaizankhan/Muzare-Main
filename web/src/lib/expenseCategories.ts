import i18n from "../i18n";

const normalized = (value?: string | null) =>
  value
    ?.trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim() ?? "";

// `display` is the canonical English label kept STABLE for storage/matching (records and
// filter comparisons rely on it). `labelKey` selects the localized rendering from the
// expenseCategoryLabels dictionary — only getExpenseCategoryLabel uses it; the canonical
// helpers below keep returning the stable English values.
const categoryAliases: Array<{ aliases: string[]; display: string; labelKey: string; accountingGroup: "Operating Expenses" | "Capital Expenditure" | "Labour Accounting" }> = [
  { aliases: ["fuel", "diesel", "pol", "fuel pol", "fuel and pol", "pol fuel oil", "fuel oil", "lubricants", "fuel and lubricants", "fuel lubricants"], display: "Fuel & Lubricants", labelKey: "fuelLubricants", accountingGroup: "Operating Expenses" },
  { aliases: ["repairs", "maintenance", "repairs maintenance", "repair maintenance", "repairs and maintenance", "maintenance repairs", "maintenance and repairs"], display: "Repairs & Maintenance", labelKey: "repairsMaintenance", accountingGroup: "Operating Expenses" },
  { aliases: ["kitchen", "groceries", "vegetables", "kitchen camp", "kitchen and camp", "camp", "camp kitchen"], display: "Kitchen & Camp", labelKey: "kitchenCamp", accountingGroup: "Operating Expenses" },
  { aliases: ["fertilizer", "fertilizers", "fertiliser", "fertilisers", "chemicals", "chemical", "pesticide", "pesticides", "fertilizers chemicals", "fertilizers and chemicals", "pesticides fertilizers", "pesticides and fertilizers"], display: "Fertilizers & Chemicals", labelKey: "fertilizersChemicals", accountingGroup: "Operating Expenses" },
  { aliases: ["utilities", "utility"], display: "Utilities", labelKey: "utilities", accountingGroup: "Operating Expenses" },
  { aliases: ["transport", "transportation"], display: "Transport", labelKey: "transport", accountingGroup: "Operating Expenses" },
  { aliases: ["machinery", "machine"], display: "Machinery", labelKey: "machinery", accountingGroup: "Capital Expenditure" },
  { aliases: ["equipment", "equipments"], display: "Equipment", labelKey: "equipment", accountingGroup: "Capital Expenditure" },
  { aliases: ["buildings", "building"], display: "Buildings", labelKey: "buildings", accountingGroup: "Capital Expenditure" },
  { aliases: ["infrastructure"], display: "Infrastructure", labelKey: "infrastructure", accountingGroup: "Capital Expenditure" },
  { aliases: ["labour", "labor", "labour related", "labor related", "salaries", "salary", "wages", "labour wages", "labor wages"], display: "Labour Related", labelKey: "labourRelated", accountingGroup: "Labour Accounting" },
  { aliases: ["other", "others", "miscellaneous", "misc"], display: "Miscellaneous", labelKey: "miscellaneous", accountingGroup: "Operating Expenses" },
];

const accountingGroupLabelKeys = {
  "Operating Expenses": "operatingExpenses",
  "Capital Expenditure": "capitalExpenditure",
  "Labour Accounting": "labourAccounting",
} as const;

function readableFallback(value?: string | null) {
  if (!value) return "";
  return value
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function matchCategory(value?: string | null) {
  const key = normalized(value);
  return categoryAliases.find((item) => item.aliases.includes(key));
}

export function resolveExpenseCategoryMeta(value?: string | null) {
  return matchCategory(value) ?? {
    display: readableFallback(value),
    accountingGroup: "Operating Expenses" as const,
  };
}

/** Canonical English category label — STABLE for storage, grouping keys, and filter matching. */
export function getCanonicalExpenseCategory(value?: string | null) {
  return resolveExpenseCategoryMeta(value).display;
}

/** Canonical English accounting group — STABLE for logic; use getExpenseAccountingGroupLabel to render. */
export function getExpenseAccountingGroup(value?: string | null) {
  return resolveExpenseCategoryMeta(value).accountingGroup;
}

/**
 * Localized category label for RENDERING only. Known system categories translate through the
 * expenseCategoryLabels dictionary; unknown (user-defined) category names pass through
 * untranslated — user data is never auto-translated.
 */
export function getExpenseCategoryLabel(value?: string | null) {
  const match = matchCategory(value);
  if (!match) return readableFallback(value);
  return i18n.t(`expenseCategoryLabels.${match.labelKey}`, { defaultValue: match.display });
}

/** Localized accounting group label for RENDERING only. */
export function getExpenseAccountingGroupLabel(value?: string | null) {
  const group = getExpenseAccountingGroup(value);
  return i18n.t(`expenseAccountingGroups.${accountingGroupLabelKeys[group]}`, { defaultValue: group });
}
