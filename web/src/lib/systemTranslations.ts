import i18n from "../i18n";

type SystemTranslationDomain =
  | "paymentTypes"
  | "expenseCategories"
  | "expenseSubcategories"
  | "attendanceStatuses"
  | "salesStatuses"
  | "dispatchStatuses"
  | "transactionGroups"
  | "partnerLedgerGroups"
  | "roles"
  | "permissions"
  | "saleTypes";

const canonicalValues: Record<SystemTranslationDomain, Record<string, string>> = {
  paymentTypes: {
    daily_wage: "daily_wage",
    "daily wage": "daily_wage",
    production_based: "production_based",
    "production based": "production_based",
    piece_rate: "production_based",
    "piece rate": "production_based",
    contract_lump_sum: "contract_lump_sum",
    contract: "contract_lump_sum",
    "contract / lump sum": "contract_lump_sum",
    lump_sum: "contract_lump_sum",
    monthly_salary: "monthly_salary",
    "monthly salary": "monthly_salary",
    other: "other",
  },
  expenseCategories: {
    fertilizer: "fertilizer",
    fertiliser: "fertilizer",
    pesticide: "pesticide",
    pesticides: "pesticide",
    labour: "labour",
    labor: "labour",
    diesel: "diesel",
    irrigation: "irrigation",
    machinery: "machinery",
    transport: "transport",
    maintenance: "maintenance",
    other: "other",
  },
  expenseSubcategories: {
    urea: "urea",
    dap: "dap",
    npk: "npk",
    sop: "sop",
    map: "map",
    mop: "mop",
    micronutrients: "micronutrients",
    "micro nutrients": "micronutrients",
    "organic fertilizer": "organic_fertilizer",
    "organic fertiliser": "organic_fertilizer",
    insecticide: "insecticide",
    fungicide: "fungicide",
    miticide: "miticide",
    herbicide: "herbicide",
    miscellaneous: "miscellaneous",
  },
  attendanceStatuses: {
    present: "present",
    absent: "absent",
    half_day: "half_day",
    "half day": "half_day",
    leave: "leave",
  },
  salesStatuses: {
    paid: "paid",
    partial: "partial",
    unpaid: "unpaid",
  },
  dispatchStatuses: {
    pending: "pending",
    dispatched: "dispatched",
    delivered: "delivered",
    sold: "sold",
  },
  transactionGroups: {
    expenses: "expenses",
    expense: "expenses",
    advances: "advances",
    advance: "advances",
    settlements: "settlements",
    settlement: "settlements",
    income: "income",
    "income / funds / sales": "income",
    "income funds sales": "income",
    other: "other",
    uncategorized: "other",
    "other / uncategorized": "other",
  },
  partnerLedgerGroups: {
    capital_injected: "capital_injected",
    "capital injected": "capital_injected",
    direct_expenses_paid: "direct_expenses_paid",
    "direct expenses paid": "direct_expenses_paid",
    transfers_out: "transfers_out",
    "business funds given": "transfers_out",
    transfers_in: "transfers_in",
    "business funds received": "transfers_in",
    money_returned: "money_returned",
    "money paid back": "money_returned",
    adjustments: "adjustments",
    other: "other",
  },
  roles: {
    workspace_owner: "workspace_owner",
    owner: "workspace_owner",
    workspace_manager: "workspace_manager",
    manager: "workspace_manager",
    supervisor: "supervisor",
    accountant: "accountant",
    operator: "operator",
    "operator / data entry": "operator",
    viewer: "viewer",
    admin: "workspace_manager",
  },
  permissions: {
    dashboard: "dashboard",
    workforce: "workforce",
    attendance: "attendance",
    advances: "advances",
    expenses: "expenses",
    sales: "sales",
    dispatch: "dispatch",
    inventory: "inventory",
    harvest: "harvest",
    accounts: "accounts",
    reports: "reports",
    settings: "settings",
    team: "team",
  },
  saleTypes: {
    dispatch_sale: "dispatch_sale",
    "from dispatch": "dispatch_sale",
    farm_direct_sale: "farm_direct_sale",
    "direct farm sale": "farm_direct_sale",
  },
};

function normalizeKey(value: string) {
  return value.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

function readableSystemFallback(value: string) {
  return value
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function resolveSystemValue(domain: SystemTranslationDomain, value?: string | null) {
  if (!value) return null;
  const normalized = normalizeKey(value);
  return canonicalValues[domain][normalized] ?? canonicalValues[domain][value] ?? null;
}

export function translateSystemValue(domain: SystemTranslationDomain, value?: string | null) {
  if (!value) return "";
  const resolved = resolveSystemValue(domain, value);
  if (!resolved) return readableSystemFallback(value);
  const key = `systemValues.${domain}.${resolved}`;
  const translated = i18n.t(key);
  return translated === key ? readableSystemFallback(value) : translated;
}

export const translatePaymentType = (value?: string | null) => translateSystemValue("paymentTypes", value);
export const translateExpenseCategory = (value?: string | null) => translateSystemValue("expenseCategories", value);
export const translateExpenseSubcategory = (value?: string | null) => translateSystemValue("expenseSubcategories", value);
export const translateAttendanceStatus = (value?: string | null) => translateSystemValue("attendanceStatuses", value);
export const translateSalesStatus = (value?: string | null) => translateSystemValue("salesStatuses", value);
export const translateDispatchStatus = (value?: string | null) => translateSystemValue("dispatchStatuses", value);
export const translateTransactionGroup = (value?: string | null) => translateSystemValue("transactionGroups", value);
export const translatePartnerLedgerGroup = (value?: string | null) => translateSystemValue("partnerLedgerGroups", value);
export const translateRole = (value?: string | null) => translateSystemValue("roles", value);
export const translatePermission = (value?: string | null) => translateSystemValue("permissions", value);
export const translateSaleType = (value?: string | null) => translateSystemValue("saleTypes", value);
