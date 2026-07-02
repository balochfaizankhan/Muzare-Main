const normalized = (value?: string | null) =>
  value?.trim().toLowerCase().replace(/&/g, " and ").replace(/[_-]+/g, " ").replace(/\s+/g, " ") ?? "";

const categoryAliases: Array<{ aliases: string[]; display: string; accountingGroup: "Operating Expenses" | "Capital Expenditure" | "Labour Accounting" }> = [
  { aliases: ["fuel", "diesel", "pol", "pol fuel oil", "fuel oil", "lubricants", "fuel and lubricants", "fuel lubricants"], display: "Fuel & Lubricants", accountingGroup: "Operating Expenses" },
  { aliases: ["repairs", "maintenance", "repairs maintenance", "repair maintenance"], display: "Repairs & Maintenance", accountingGroup: "Operating Expenses" },
  { aliases: ["kitchen", "groceries", "vegetables", "kitchen camp", "camp", "camp kitchen"], display: "Kitchen & Camp", accountingGroup: "Operating Expenses" },
  { aliases: ["fertilizer", "fertilizers", "fertiliser", "fertilisers", "chemicals", "chemical", "pesticide", "pesticides", "fertilizers chemicals"], display: "Fertilizers & Chemicals", accountingGroup: "Operating Expenses" },
  { aliases: ["utilities", "utility"], display: "Utilities", accountingGroup: "Operating Expenses" },
  { aliases: ["transport", "transportation"], display: "Transport", accountingGroup: "Operating Expenses" },
  { aliases: ["machinery", "machine"], display: "Machinery", accountingGroup: "Capital Expenditure" },
  { aliases: ["equipment", "equipments"], display: "Equipment", accountingGroup: "Capital Expenditure" },
  { aliases: ["buildings", "building"], display: "Buildings", accountingGroup: "Capital Expenditure" },
  { aliases: ["infrastructure"], display: "Infrastructure", accountingGroup: "Capital Expenditure" },
  { aliases: ["labour", "labor", "labour wages", "labor wages"], display: "Labour Wages", accountingGroup: "Labour Accounting" },
  { aliases: ["other", "others", "miscellaneous", "misc"], display: "Miscellaneous", accountingGroup: "Operating Expenses" },
];

function readableFallback(value?: string | null) {
  if (!value) return "";
  return value
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function resolveExpenseCategoryMeta(value?: string | null) {
  const key = normalized(value);
  const match = categoryAliases.find((item) => item.aliases.includes(key));
  return match ?? {
    display: readableFallback(value),
    accountingGroup: "Operating Expenses" as const,
  };
}

export function getCanonicalExpenseCategory(value?: string | null) {
  return resolveExpenseCategoryMeta(value).display;
}

export function getExpenseAccountingGroup(value?: string | null) {
  return resolveExpenseCategoryMeta(value).accountingGroup;
}
