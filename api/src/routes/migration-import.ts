import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { requirePermission, requireUser } from "../auth.js";
import { localDevelopmentMode } from "../config.js";
import { db } from "../db/client.js";
import { auditLogs, expenseCategories, expenseSubcategories, farmDeletionRequests, farms, importBatches, importFailures, operationalRecords, seasons, userSessions, workspaces } from "../db/schema.js";
import { visibleFarmWhere } from "../farm-visibility.js";
import { repairDeletedFarmSeasonState, repairWorkspaceContext, resolveWorkspaceContext } from "./workspace-context.js";

const requiredArrays = [
  "farms",
  "seasons",
  "labour",
  "accounts",
  "partners",
  "expenses",
  "expenseItems",
  "advances",
  "dispatches",
  "dispatchItems",
  "sales",
  "settlements",
  "partnerTransfers",
] as const;
const importedEntityArrays = [...requiredArrays, "attendance"] as const;
const androidExportArrays = [
  "farms",
  "seasons",
  "labours",
  "accounts",
  "partners",
  "expenses",
  "expenseItems",
  "fundSources",
  "vouchers",
  "voucherItems",
  "advances",
  "attendance",
  "sales",
  "dispatches",
  "groups",
  "fundEntries",
  "accountTransactions",
  "expCategories",
] as const;
const androidToPwaArrayMap = {
  labours: "labour",
  fundSources: "accounts",
  vouchers: "expenses",
  voucherItems: "expenseItems",
} as const;
const arrayAliases: Partial<Record<typeof requiredArrays[number], readonly string[]>> = {
  labour: ["labours"],
  accounts: ["fundSources"],
  expenses: ["vouchers"],
  expenseItems: ["voucherItems"],
};

const payloadSchema = z.object({
  workspaceId: z.string().uuid(),
  payload: z.record(z.string(), z.unknown()),
  allowSummaryMismatch: z.boolean().default(false),
});

const importSchema = payloadSchema.extend({
  dryRun: z.boolean().default(true),
  allowDatabaseWrite: z.boolean().default(false),
  fileName: z.string().trim().min(1).optional(),
});
const repairSchema = z.object({ workspaceId: z.string().uuid() });
const workspaceParams = z.object({ workspaceId: z.string().uuid() });
const historyQuerySchema = z.object({ workspaceId: z.string().uuid() });
const jobParamsSchema = z.object({ jobId: z.string().uuid() });
const activeJobQuerySchema = z.object({ workspaceId: z.string().uuid() });
const batchActionSchema = z.object({ workspaceId: z.string().uuid(), batchId: z.string().uuid() });
const cleanupPreviewQuerySchema = z.object({ workspaceId: z.string().uuid(), batchId: z.string().uuid() });
const cleanupActionSchema = z.object({
  workspaceId: z.string().uuid(),
  batchId: z.string().uuid(),
  confirmation: z.literal("CLEAN FAILED IMPORT"),
  backupConfirmed: z.literal(true),
  includeEditedImportedRecords: z.boolean().default(false),
});
const batchListQuerySchema = z.object({ workspaceId: z.string().uuid() });

function normalizeImportedName(value: unknown) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function normalizeImportedAccountType(value: unknown, fallback = "cash") {
  const normalized = String(value ?? fallback)
    .trim()
    .replace(/\s+/g, "_")
    .toLowerCase();
  return normalized || fallback;
}

const explicitPaymentAccountTypes = new Set([
  "cash",
  "bank",
  "payment",
  "payment_account",
  "wallet",
  "petty_cash",
  "fund_source",
  "fund",
]);

const paymentNameFragments = ["cash", "bank", "wallet", "fund"];

function booleanValue(record: AndroidRecord, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "yes", "1"].includes(normalized)) return true;
      if (["false", "no", "0"].includes(normalized)) return false;
    }
  }
  return false;
}

function accountNameLooksLikePaymentAccount(name: string) {
  const normalized = normalizeImportedName(name);
  return paymentNameFragments.some((fragment) => normalized.includes(fragment));
}

function isExplicitPaymentAccountSource(source: AndroidRecord, explicitType: string, name: string) {
  if (explicitType && explicitPaymentAccountTypes.has(explicitType)) return true;
  if (booleanValue(source, ["isPaymentAccount", "paymentAccount", "isCashAccount", "isBankAccount", "cashAccount", "bankAccount"])) return true;
  return accountNameLooksLikePaymentAccount(name);
}

function classifyImportedAccountType(source: AndroidRecord, partnerNames: Set<string>) {
  const name = text(source, ["name", "accountName"], "Imported Account");
  const normalizedName = normalizeImportedName(name);
  const explicitType = normalizeImportedAccountType(text(source, ["type", "accountType"], ""), "");
  const normalizedType = explicitType || "cash";
  if (normalizedType === "partner") return "partner";
  if (partnerNames.has(normalizedName) && !isExplicitPaymentAccountSource(source, explicitType, name)) return "partner";
  return normalizedType;
}

function importedAccountGroupKey(payload: Record<string, unknown>) {
  const type = normalizeImportedAccountType(payload.type);
  const name = normalizeImportedName(payload.name);
  return `name:${name}::${type}`;
}

type AndroidRecord = Record<string, unknown>;
type AndroidPayload = z.infer<typeof payloadSchema>["payload"];
type ImportDbExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db;
type ImportIssue = { level: "error" | "warning"; path: string; message: string };
type ImportSummary = {
  exportVersion: string | null;
  exportedAt: string | null;
  source: string | null;
  counts: Record<typeof requiredArrays[number], number>;
  androidCounts: Record<string, number>;
  exportSummaryCounts: Record<string, number>;
  mappedCounts: Array<{ androidKey: string; pwaKey: string; count: number }>;
  importCounts: Array<{ label: string; key: string; count: number }>;
  voucherCount: number;
  voucherItemCount: number;
  totalExpenses: number;
  totalAdvances: number;
  totalSales: number;
  partnerBalances: Array<{ name: string; balance: number }>;
  cashBankBalances: Array<{ name: string; balance: number }>;
};
type ImportCountKey = "farms" | "seasons" | "accounts" | "partners" | "labour" | "expenses" | "expenseItems" | "advances" | "attendance";
type ScopedMaps = { farms: Map<string, string>; seasons: Map<string, string>; labour: Map<string, string>; accounts: Map<string, string>; partners: Map<string, string> };
type AccountDuplicateRepairResult = {
  duplicateGroupsBefore: number;
  duplicateGroupsAfter: number;
  canonicalAccountsKept: number;
  childRecordsRemapped: number;
  duplicateAccountsRemoved: number;
  groupsBefore: Array<{ name: string; type: string; count: number; accountIds: string[]; canonicalAccountId: string | null }>;
  groupsAfter: Array<{ name: string; type: string; count: number; accountIds: string[]; canonicalAccountId: string | null }>;
};
type PostImportAudit = {
  expectedCounts: Record<string, number>;
  tableCounts: {
    farms: number;
    seasons: number;
    importFailures: number;
    failedOrPartialBatches: number;
  };
  duplicateAccountAudit: {
    totalGroups: number;
    groups: Array<{
      logicalKey: string;
      normalizedName: string;
      normalizedType: string;
      count: number;
      canonicalAccountId: string | null;
      childReferenceCount: number;
      accountIds: string[];
    }>;
  };
  operationalRecordsByEntity: Array<{ entityType: string; count: number }>;
  voucherNumberAudit: {
    sourceTotal: number;
    importedTotal: number;
    missingSourceVoucherNumbers: number;
    missingStoredVoucherNumbers: number;
    mismatches: Array<{
      oldExpenseId: string;
      androidVoucherNumber: string;
      storedVoucherNumber: string;
      clientRecordId: string;
    }>;
    duplicateImportedVoucherNumbers: Array<{
      voucherNumber: string;
      count: number;
      clientRecordIds: string[];
    }>;
  };
  relationshipAudit: {
    attendanceTotal: number;
    attendanceLinkedToLabour: number;
    attendanceMissingLabour: number;
    advancesTotal: number;
    advancesLinkedToLabour: number;
    advancesMissingLabour: number;
    advancesLinkedToAccount: number;
    advancesMissingAccount: number;
    vouchersTotal: number;
    vouchersLinkedToPaymentAccount: number;
    vouchersMissingPaymentAccount: number;
    vouchersWithMultipleItems: number;
    voucherItemsStored: number;
    vouchersWithItemMismatch: number;
  };
};
type ImportResult = {
  insertedOperationalRecords: number;
  importCounts: Array<{ label: string; key: ImportCountKey; count: number }>;
  farmImportStats: { created: number; updated: number; skippedDuplicates: number };
  activeFarmId: string;
  activeSeasonId: string;
  attendanceJobId?: string;
  attendanceJob?: AttendanceImportJobStatus;
  importBatchId: string;
  startedAt: string;
  completedAt: string;
  currentStep: string;
  failedRows: number;
  logs: ImportLogEntry[];
  totalExpenses: number;
  totalAdvances: number;
  postImportAudit: PostImportAudit;
};
type ImportLogEntry = {
  step: string;
  status: "started" | "completed" | "failed";
  message?: string;
  sourceRows?: number;
  importedRows?: number;
  updatedRows?: number;
  skippedRows?: number;
  failedRows?: number;
  createdAt: string;
};
type ImportJobStep = {
  name: string;
  status: "pending" | "running" | "completed" | "failed";
  source: number;
  imported: number;
  updated: number;
  skipped: number;
  failed: number;
  processed: number;
  total: number;
  batch?: number;
  batchTotal?: number;
  startedAt?: string;
  completedAt?: string;
  message?: string;
};
type AttendanceImportJobStatus = {
  jobId: string;
  importBatchId: string;
  workspaceId: string;
  status: "queued" | "running" | "completed" | "failed" | "partial_failed" | "rolled_back";
  currentStep: string;
  sourceRows: number;
  totalBatches: number;
  currentBatch: number;
  processedRows: number;
  importedRows: number;
  updatedRows: number;
  skippedRows: number;
  failedRows: number;
  currentRow?: string;
  message?: string;
  startedAt: string;
  lastProgressAt: string;
  completedAt?: string;
  error?: string;
  stack?: string;
  firstFailureMessage?: string;
  steps: ImportJobStep[];
  logs: ImportLogEntry[];
};

type CleanupTarget = {
  batchId: string;
  workspaceId: string;
  fileHash: string;
  source: string;
};

type VisibilityAuditResponse = {
  workspaceId: string;
  latestImport: {
    batchId: string | null;
    fileHash: string | null;
    source: string | null;
    status: string | null;
    startedAt: string | null;
    completedAt: string | null;
  };
  server: {
    farmsImported: number;
    seasonsImported: number;
    operationalRecordsByEntity: Array<{ entityType: string; count: number }>;
  };
  context: {
    activeFarmId: string | null;
    activeSeasonId: string | null;
    activeFarmName: string | null;
    activeSeasonName: string | null;
    contextWarning: string | null;
  };
};

const attendanceImportJobs = new Map<string, AttendanceImportJobStatus>();
const importStepOrder = ["Farms", "Seasons", "Accounts", "Partners", "Labour", "Expenses", "Expense Items", "Advances", "Attendance"] as const;

const importCountKeys: Array<{ label: string; key: ImportCountKey }> = [
  { label: "Farms imported", key: "farms" },
  { label: "Seasons imported", key: "seasons" },
  { label: "Accounts imported", key: "accounts" },
  { label: "Partners imported", key: "partners" },
  { label: "Labour imported", key: "labour" },
  { label: "Expenses imported", key: "expenses" },
  { label: "Expense items imported", key: "expenseItems" },
  { label: "Advances imported", key: "advances" },
  { label: "Attendance imported", key: "attendance" },
];

const previewCountKeys: Array<{ label: string; key: typeof importedEntityArrays[number]; summaryKeys: string[] }> = [
  { label: "Farms count", key: "farms", summaryKeys: ["farms", "farmCount", "farmsCount"] },
  { label: "Seasons count", key: "seasons", summaryKeys: ["seasons", "seasonCount", "seasonsCount"] },
  { label: "Labour count", key: "labour", summaryKeys: ["labours", "labour", "labourCount", "laboursCount"] },
  { label: "Accounts count", key: "accounts", summaryKeys: ["accounts", "accountCount", "accountsCount"] },
  { label: "Expenses count", key: "expenses", summaryKeys: ["expenses", "expenseCount", "expensesCount"] },
  { label: "Expense items count", key: "expenseItems", summaryKeys: ["expenseItems", "expenseItemCount", "expenseItemsCount"] },
  { label: "Advances count", key: "advances", summaryKeys: ["advances", "advanceCount", "advancesCount"] },
  { label: "Attendance count", key: "attendance", summaryKeys: ["attendance", "attendanceCount"] },
  { label: "Sales count", key: "sales", summaryKeys: ["sales", "saleCount", "salesCount"] },
  { label: "Dispatch count", key: "dispatches", summaryKeys: ["dispatches", "dispatchCount", "dispatchesCount"] },
];

const rawArray = (payload: AndroidPayload, key: string) => Array.isArray(payload[key]) ? payload[key] as AndroidRecord[] : [];
const isAndroidV2Export = (payload: AndroidPayload) => payload.source === "muzare_android" && String(payload.exportVersion) === "2.0";
const payloadHash = (payload: AndroidPayload) => createHash("sha256").update(JSON.stringify(payload)).digest("hex");
const asArray = (payload: AndroidPayload, key: typeof importedEntityArrays[number]) => {
  if (isAndroidV2Export(payload)) {
    if (key === "labour") return rawArray(payload, "labours");
    return rawArray(payload, key);
  }
  if (Array.isArray(payload[key])) return payload[key] as AndroidRecord[];
  for (const alias of (key in arrayAliases ? arrayAliases[key as typeof requiredArrays[number]] : undefined) ?? []) {
    if (Array.isArray(payload[alias])) return payload[alias] as AndroidRecord[];
  }
  return [];
};
const hasArray = (payload: AndroidPayload, key: string) => Array.isArray(payload[key]);
const summaryCount = (payload: AndroidPayload, keys: string[]) => {
  const summary = payload.summary && typeof payload.summary === "object" ? payload.summary as Record<string, unknown> : {};
  for (const key of keys) {
    const value = summary[key];
    const count = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (Number.isFinite(count)) return count;
  }
  return undefined;
};
const text = (record: AndroidRecord, keys: string[], fallback = "") => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return fallback;
};
const numberValue = (record: AndroidRecord, keys: string[], fallback = 0) => {
  for (const key of keys) {
    const value = record[key];
    const next = typeof value === "number" ? value : typeof value === "string" ? Number(value.replace(/,/g, "")) : NaN;
    if (Number.isFinite(next)) return next;
  }
  return fallback;
};
const oldId = (record: AndroidRecord) => text(record, ["oldAndroidId", "old_android_id", "android_id", "androidId", "id", "_id"]);
const dateValue = (record: AndroidRecord, keys: string[], fallback = new Date().toISOString().slice(0, 10)) => {
  const raw = text(record, keys);
  if (!raw) return fallback;
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString().slice(0, 10);
};
const relation = (record: AndroidRecord, keys: string[]) => text(record, keys);
const firstMapValue = (map: Map<string, string>) => map.values().next().value as string | undefined;
const nowIso = () => new Date().toISOString();
const sourceTypeFor = (key: typeof requiredArrays[number] | string) => ({
  farms: "farm",
  seasons: "season",
  labour: "labour",
  accounts: "account",
  partners: "partner",
  expenses: "expense",
  expenseItems: "expenseItem",
  advances: "advance",
  dispatches: "dispatch",
  dispatchItems: "dispatchItem",
  sales: "sale",
  settlements: "settlement",
  partnerTransfers: "partnerTransfer",
  attendance: "attendance",
}[key] ?? key);
const farmName = (record: AndroidRecord, index: number) =>
  text(record, ["name", "farmName", "farm_name", "title", "farmTitle", "farm_title", "displayName", "display_name"], `Imported Farm ${index + 1}`);
const farmRef = (record: AndroidRecord) => relation(record, [
  "oldFarmId", "farm_id", "farmId", "farmID", "farm_old_android_id", "farmOldAndroidId", "farm_android_id", "farmAndroidId",
  "farm", "farm_id_fk", "farmIdFk",
]);
const seasonRef = (record: AndroidRecord) => relation(record, [
  "oldSeasonId", "season_id", "seasonId", "seasonID", "season_old_android_id", "seasonOldAndroidId", "season_android_id", "seasonAndroidId",
  "season", "season_id_fk", "seasonIdFk",
]);
const labourRef = (record: AndroidRecord) => relation(record, [
  "oldLabourId", "labour_id", "labourId", "labourID", "labour_old_android_id", "labourOldAndroidId", "labour_android_id", "labourAndroidId",
  "worker_id", "workerId", "employee_id", "employeeId",
]);
const accountRef = (record: AndroidRecord) => relation(record, [
  "oldPaymentAccountId", "oldAccountId", "account_id", "accountId", "payment_account_id", "paymentAccountId", "paid_from_account_id", "paidFromAccountId",
  "fund_source_id", "fundSourceId", "deduction_account_id", "deductionAccountId",
]);
const attendanceStatus = (record: AndroidRecord): "present" | "half_day" | "absent" | "leave" => {
  const raw = text(record, ["status", "attendance", "mark", "value", "state"]).toLowerCase().replace(/\s+/g, "_");
  if (["p", "present", "full", "full_day", "1"].includes(raw)) return "present";
  if (["h", "half", "half_day", "1/2", "0.5"].includes(raw)) return "half_day";
  if (["l", "leave", "on_leave"].includes(raw)) return "leave";
  if (["a", "absent", "0"].includes(raw)) return "absent";
  const numeric = numberValue(record, ["statusValue", "dayValue", "attendanceValue"], NaN);
  if (numeric === 1) return "present";
  if (numeric === 0.5) return "half_day";
  return "absent";
};
const importedActive = (record: AndroidRecord) => {
  const status = text(record, ["status", "state"]).toLowerCase();
  if (status === "archived" || status === "inactive" || status === "deleted") return false;
  if (record.active === false || record.archived === true || record.isArchived === true || record.deleted === true) return false;
  return true;
};

const normalizedLabel = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
const itemSortWeight = (record: AndroidRecord, index: number) => {
  for (const key of ["sortOrder", "sort_order", "lineOrder", "line_order", "displayOrder", "display_order", "position", "index"]) {
    const raw = record[key];
    const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return index;
};

type ExpenseCategoryLookup = {
  fallback: { categoryId: string; category: string; subcategoryId: string; subcategory: string };
  byCategory: Map<string, { categoryId: string; category: string }>;
  bySubcategory: Map<string, { categoryId: string; category: string; subcategoryId: string; subcategory: string }>;
};

async function loadExpenseCategoryLookup(
  tx: ImportDbExecutor,
  workspaceId: string,
): Promise<ExpenseCategoryLookup> {
  const [categories, subcategories] = await Promise.all([
    tx.select({
      categoryId: expenseCategories.id,
      category: expenseCategories.name,
      workspaceId: expenseCategories.workspaceId,
    }).from(expenseCategories).where(and(
      eq(expenseCategories.active, true),
      or(eq(expenseCategories.workspaceId, workspaceId), sql`${expenseCategories.workspaceId} IS NULL`),
    )),
    tx.select({
      categoryId: expenseCategories.id,
      category: expenseCategories.name,
      subcategoryId: expenseSubcategories.id,
      subcategory: expenseSubcategories.name,
      categoryWorkspaceId: expenseCategories.workspaceId,
      subcategoryWorkspaceId: expenseSubcategories.workspaceId,
    }).from(expenseSubcategories).innerJoin(expenseCategories, eq(expenseCategories.id, expenseSubcategories.categoryId)).where(and(
      eq(expenseCategories.active, true),
      eq(expenseSubcategories.active, true),
      or(eq(expenseCategories.workspaceId, workspaceId), sql`${expenseCategories.workspaceId} IS NULL`),
      or(eq(expenseSubcategories.workspaceId, workspaceId), sql`${expenseSubcategories.workspaceId} IS NULL`),
    )),
  ]);

  const byCategory = new Map<string, { categoryId: string; category: string }>();
  for (const category of categories) {
    const key = normalizedLabel(category.category);
    if (!byCategory.has(key) || category.workspaceId === workspaceId) {
      byCategory.set(key, { categoryId: category.categoryId, category: category.category });
    }
  }

  const bySubcategory = new Map<string, { categoryId: string; category: string; subcategoryId: string; subcategory: string }>();
  for (const subcategory of subcategories) {
    const key = normalizedLabel(subcategory.subcategory);
    if (!bySubcategory.has(key) || subcategory.subcategoryWorkspaceId === workspaceId || subcategory.categoryWorkspaceId === workspaceId) {
      bySubcategory.set(key, {
        categoryId: subcategory.categoryId,
        category: subcategory.category,
        subcategoryId: subcategory.subcategoryId,
        subcategory: subcategory.subcategory,
      });
    }
  }

  const fallback = bySubcategory.get(normalizedLabel("Miscellaneous"))
    ?? subcategories[0]
    ? {
        categoryId: (bySubcategory.get(normalizedLabel("Miscellaneous")) ?? {
          categoryId: subcategories[0]!.categoryId,
          category: subcategories[0]!.category,
          subcategoryId: subcategories[0]!.subcategoryId,
          subcategory: subcategories[0]!.subcategory,
        }).categoryId,
        category: (bySubcategory.get(normalizedLabel("Miscellaneous")) ?? {
          categoryId: subcategories[0]!.categoryId,
          category: subcategories[0]!.category,
          subcategoryId: subcategories[0]!.subcategoryId,
          subcategory: subcategories[0]!.subcategory,
        }).category,
        subcategoryId: (bySubcategory.get(normalizedLabel("Miscellaneous")) ?? {
          categoryId: subcategories[0]!.categoryId,
          category: subcategories[0]!.category,
          subcategoryId: subcategories[0]!.subcategoryId,
          subcategory: subcategories[0]!.subcategory,
        }).subcategoryId,
        subcategory: (bySubcategory.get(normalizedLabel("Miscellaneous")) ?? {
          categoryId: subcategories[0]!.categoryId,
          category: subcategories[0]!.category,
          subcategoryId: subcategories[0]!.subcategoryId,
          subcategory: subcategories[0]!.subcategory,
        }).subcategory,
      }
    : {
        categoryId: "imported",
        category: "Other",
        subcategoryId: "imported",
        subcategory: "Miscellaneous",
      };

  return { fallback, byCategory, bySubcategory };
}

function resolveImportedExpenseCategory(
  lookup: ExpenseCategoryLookup,
  categoryName: string,
  subcategoryName: string,
) {
  const normalizedCategory = normalizedLabel(categoryName);
  const normalizedSubcategory = normalizedLabel(subcategoryName);
  if (normalizedCategory && normalizedSubcategory) {
    const subcategoryMatch = lookup.bySubcategory.get(normalizedSubcategory);
    if (subcategoryMatch && normalizedLabel(subcategoryMatch.category) === normalizedCategory) return subcategoryMatch;
  }
  if (normalizedSubcategory) {
    const subcategoryMatch = lookup.bySubcategory.get(normalizedSubcategory);
    if (subcategoryMatch) return subcategoryMatch;
  }
  if (normalizedCategory) {
    const subcategoryMatch = lookup.bySubcategory.get(normalizedCategory);
    if (subcategoryMatch) return subcategoryMatch;
    const categoryMatch = lookup.byCategory.get(normalizedCategory);
    if (categoryMatch) {
      return {
        ...categoryMatch,
        subcategoryId: lookup.fallback.subcategoryId,
        subcategory: lookup.fallback.subcategory,
      };
    }
  }
  return lookup.fallback;
}

const inferImportYear = (payload: AndroidPayload) => {
  const candidates = [
    ...asArray(payload, "seasons").map((record) => numberValue(record, ["year"], NaN)),
    ...asArray(payload, "expenses").map((record) => Number(dateValue(record, ["date", "expenseDate"]).slice(0, 4))),
    ...asArray(payload, "attendance").map((record) => Number(dateValue(record, ["date", "attendanceDate", "day"]).slice(0, 4))),
    ...asArray(payload, "advances").map((record) => Number(dateValue(record, ["date", "advanceDate"]).slice(0, 4))),
  ].filter((year) => Number.isInteger(year) && year >= 2000 && year <= 2100);
  return candidates[0] ?? new Date().getFullYear();
};

const scopedWarningLabel = (key: typeof importedEntityArrays[number], count: number) => {
  const labels: Partial<Record<typeof importedEntityArrays[number], [string, string]>> = {
    labour: ["labour record", "labour records"],
    accounts: ["account record", "account records"],
    expenses: ["expense", "expenses"],
    advances: ["advance", "advances"],
    dispatches: ["dispatch", "dispatches"],
    sales: ["sale", "sales"],
    settlements: ["settlement", "settlements"],
    partnerTransfers: ["partner transfer", "partner transfers"],
    attendance: ["attendance record", "attendance records"],
  };
  const [singular, plural] = labels[key] ?? [key, key];
  return `${count} ${count === 1 ? singular : plural}`;
};
const readableImportError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (/duplicate key/i.test(message)) return "duplicate key";
  if (/foreign key/i.test(message)) return "invalid foreign key";
  if (/not-null|null value/i.test(message)) return "missing required value";
  if (/invalid input syntax/i.test(message)) return "invalid value";
  return message.split("\n")[0]?.slice(0, 240) || "unknown import error";
};
const chunks = <T>(items: T[], size = 250) => {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
};

function validatePayload(payload: AndroidPayload, options: { allowSummaryMismatch?: boolean } = {}): { issues: ImportIssue[]; summary: ImportSummary } {
  const issues: ImportIssue[] = [];
  const counts = Object.fromEntries(requiredArrays.map((key) => [key, asArray(payload, key).length])) as ImportSummary["counts"];
  const androidCounts = Object.fromEntries(androidExportArrays.map((key) => [key, rawArray(payload, key).length])) as Record<string, number>;
  const exportSummaryCounts = Object.fromEntries(previewCountKeys.map((item) => [item.key, summaryCount(payload, item.summaryKeys) ?? -1]));
  const mappedCounts = Object.entries(androidToPwaArrayMap).map(([androidKey, pwaKey]) => ({
    androidKey,
    pwaKey,
    count: rawArray(payload, androidKey).length || asArray(payload, pwaKey).length,
  }));

  for (const key of ["exportVersion", "exportedAt", "source"]) {
    if (typeof payload[key] !== "string" || !String(payload[key]).trim()) {
      issues.push({ level: "warning", path: key, message: `${key} is missing or empty.` });
    }
  }
  if (isAndroidV2Export(payload)) {
    for (const item of previewCountKeys) {
      const expected = summaryCount(payload, item.summaryKeys);
      if (expected === undefined) continue;
      const actual = asArray(payload, item.key).length;
      if (actual !== expected) {
        issues.push({
          level: options.allowSummaryMismatch ? "warning" : "error",
          path: `summary.${item.key}`,
          message: `${item.label} mismatch: summary says ${expected}, actual JSON has ${actual}. ${options.allowSummaryMismatch ? "Import allowed by confirmation." : "Confirm summary mismatch before importing."}`,
        });
      }
    }
  }

  const importCounts = importCountKeys.map(({ label, key }) => ({ label, key, count: key === "attendance" ? rawArray(payload, "attendance").length : counts[key] }));

  for (const key of importedEntityArrays) {
    const seenWithinEntity = new Map<string, string>();
    asArray(payload, key).forEach((record, index) => {
      const id = oldId(record);
      if (!id) {
        issues.push({ level: "error", path: `${key}[${index}]`, message: "old_android_id is required." });
        return;
      }
      if (seenWithinEntity.has(id)) {
        issues.push({ level: "error", path: `${key}[${index}].old_android_id`, message: `Duplicate old_android_id '${id}' also appears in ${seenWithinEntity.get(id)}.` });
      }
      seenWithinEntity.set(id, `${key}[${index}]`);
    });
  }

  const farmsByOldId = new Set(asArray(payload, "farms").map(oldId).filter(Boolean));
  const seasonsByOldId = new Set(asArray(payload, "seasons").map(oldId).filter(Boolean));
  const expensesByOldId = new Set(asArray(payload, "expenses").map(oldId).filter(Boolean));
  const dispatchesByOldId = new Set(asArray(payload, "dispatches").map(oldId).filter(Boolean));

  const seasonScopedKeys: Array<typeof importedEntityArrays[number]> = ["labour", "accounts", "expenses", "advances", "dispatches", "sales", "settlements", "partnerTransfers", "attendance"];
  for (const key of seasonScopedKeys) {
    let missingFarmCount = 0;
    let missingSeasonCount = 0;
    const unknownFarmRefs = new Map<string, number>();
    const unknownSeasonRefs = new Map<string, number>();
    asArray(payload, key).forEach((record) => {
      const farmReference = farmRef(record);
      const seasonReference = seasonRef(record);
      if (!farmReference) missingFarmCount += 1;
      if (!seasonReference) missingSeasonCount += 1;
      if (farmReference && !farmsByOldId.has(farmReference)) unknownFarmRefs.set(farmReference, (unknownFarmRefs.get(farmReference) ?? 0) + 1);
      if (seasonReference && !seasonsByOldId.has(seasonReference)) unknownSeasonRefs.set(seasonReference, (unknownSeasonRefs.get(seasonReference) ?? 0) + 1);
    });
    if (missingFarmCount > 0) {
      issues.push({ level: "warning", path: `${key}.*.farm_id`, message: `${scopedWarningLabel(key, missingFarmCount)} had no farm reference and will be assigned to the imported active farm.` });
    }
    if (missingSeasonCount > 0) {
      issues.push({ level: "warning", path: `${key}.*.season_id`, message: `${scopedWarningLabel(key, missingSeasonCount)} had no season reference and will be assigned to the imported active season.` });
    }
    for (const [reference, count] of unknownFarmRefs) {
      issues.push({ level: "warning", path: `${key}.*.farm_id`, message: `${scopedWarningLabel(key, count)} referenced unknown farm '${reference}' and will be assigned to the imported active farm.` });
    }
    for (const [reference, count] of unknownSeasonRefs) {
      issues.push({ level: "warning", path: `${key}.*.season_id`, message: `${scopedWarningLabel(key, count)} referenced unknown season '${reference}' and will be assigned to the imported active season.` });
    }
  }

  asArray(payload, "expenseItems").forEach((record, index) => {
    const expenseRef = relation(record, ["oldExpenseId", "expense_id", "expenseId", "voucher_id", "voucherId", "parent_id", "parentId"]);
    if (!expenseRef || !expensesByOldId.has(expenseRef)) {
      issues.push({ level: "error", path: `expenseItems[${index}].expense_id`, message: `Invalid expense/voucher reference '${expenseRef || "-"}'.` });
    }
  });
  asArray(payload, "dispatchItems").forEach((record, index) => {
    const dispatchRef = relation(record, ["oldDispatchId", "dispatch_id", "dispatchId", "parent_id", "parentId"]);
    if (!dispatchRef || !dispatchesByOldId.has(dispatchRef)) {
      issues.push({ level: "error", path: `dispatchItems[${index}].dispatch_id`, message: `Invalid dispatch reference '${dispatchRef || "-"}'.` });
    }
  });

  const expenseItemsByParent = new Map<string, AndroidRecord[]>();
  for (const item of asArray(payload, "expenseItems")) {
    const parentId = relation(item, ["oldExpenseId", "expense_id", "expenseId", "voucher_id", "voucherId", "parent_id", "parentId"]);
    expenseItemsByParent.set(parentId, [...(expenseItemsByParent.get(parentId) ?? []), item]);
  }
  for (const expense of asArray(payload, "expenses")) {
    const id = oldId(expense);
    const total = numberValue(expense, ["total_amount", "totalAmount", "total", "amount", "voucherTotal"]);
    const itemTotal = (expenseItemsByParent.get(id) ?? []).reduce((sum, item) => sum + numberValue(item, ["amount", "total", "lineTotal"]), 0);
    if ((expenseItemsByParent.get(id)?.length ?? 0) > 0 && Math.abs(total - itemTotal) > 0.01) {
      issues.push({ level: "error", path: `expenses.${id}.total`, message: `Voucher total ${total} does not match item sum ${itemTotal}.` });
    }
  }
  const voucherTotal = asArray(payload, "expenses").reduce((sum, record) => sum + numberValue(record, ["total_amount", "totalAmount", "total", "amount", "voucherTotal"]), 0);
  const voucherItemTotal = asArray(payload, "expenseItems").reduce((sum, record) => sum + numberValue(record, ["amount", "total", "lineTotal"]), 0);
  if (asArray(payload, "expenses").length && asArray(payload, "expenseItems").length && Math.abs(voucherTotal - voucherItemTotal) > 0.01) {
    issues.push({ level: "error", path: "vouchers.total_amount", message: `sum(vouchers.total_amount) ${voucherTotal} does not match sum(voucherItems.amount) ${voucherItemTotal}.` });
  }

  const partnerBalances = new Map<string, number>();
  for (const transfer of asArray(payload, "partnerTransfers")) {
    const from = text(transfer, ["fromPartnerName", "from_partner_name", "fromPartner", "from_partner"]);
    const to = text(transfer, ["toPartnerName", "to_partner_name", "toPartner", "to_partner"]);
    const amount = numberValue(transfer, ["amount"]);
    if (from) partnerBalances.set(from, (partnerBalances.get(from) ?? 0) - amount);
    if (to) partnerBalances.set(to, (partnerBalances.get(to) ?? 0) + amount);
  }

  const cashBankBalances = new Map<string, number>();
  const accountName = (id: string) => text(asArray(payload, "accounts").find((item) => oldId(item) === id) ?? {}, ["name", "accountName"], id || "Unknown");
  for (const expense of asArray(payload, "expenses")) {
    const accountId = relation(expense, ["account_id", "accountId", "paid_from_account_id", "paidFromAccountId"]);
    if (accountId) cashBankBalances.set(accountName(accountId), (cashBankBalances.get(accountName(accountId)) ?? 0) - numberValue(expense, ["total_amount", "totalAmount", "total", "amount", "voucherTotal"]));
  }
  for (const advance of asArray(payload, "advances")) {
    const accountId = relation(advance, ["account_id", "accountId", "payment_account_id", "paymentAccountId"]);
    if (accountId) cashBankBalances.set(accountName(accountId), (cashBankBalances.get(accountName(accountId)) ?? 0) - numberValue(advance, ["amount"]));
  }
  for (const sale of asArray(payload, "sales")) {
    const accountId = relation(sale, ["account_id", "accountId", "payment_account_id", "paymentAccountId"]);
    if (accountId) cashBankBalances.set(accountName(accountId), (cashBankBalances.get(accountName(accountId)) ?? 0) + numberValue(sale, ["total", "totalAmount", "amount"]));
  }

  return {
    issues,
    summary: {
      exportVersion: typeof payload.exportVersion === "string" ? payload.exportVersion : null,
      exportedAt: typeof payload.exportedAt === "string" ? payload.exportedAt : null,
      source: typeof payload.source === "string" ? payload.source : null,
      counts,
      androidCounts,
      exportSummaryCounts,
      mappedCounts,
      importCounts,
      voucherCount: counts.expenses,
      voucherItemCount: counts.expenseItems,
      totalExpenses: voucherTotal,
      totalAdvances: asArray(payload, "advances").reduce((sum, record) => sum + numberValue(record, ["amount"]), 0),
      totalSales: asArray(payload, "sales").reduce((sum, record) => sum + numberValue(record, ["total", "totalAmount", "amount"]), 0),
      partnerBalances: [...partnerBalances.entries()].map(([name, balance]) => ({ name, balance })),
      cashBankBalances: [...cashBankBalances.entries()].map(([name, balance]) => ({ name, balance })),
    },
  };
}

function scopedFarmId(record: AndroidRecord, maps: ScopedMaps, fallbackFarmId: string) {
  return maps.farms.get(farmRef(record)) ?? fallbackFarmId;
}
function scopedSeasonId(record: AndroidRecord, maps: ScopedMaps, fallbackSeasonId: string) {
  return maps.seasons.get(seasonRef(record)) ?? fallbackSeasonId;
}

function operationalRecord(entity: string, record: AndroidRecord, sourceType: string, maps: ScopedMaps, fallbackScope: { farmId: string; seasonId: string }, extra: Record<string, unknown> = {}): typeof operationalRecords.$inferInsert {
  const createdAt = nowIso();
  const id = randomUUID();
  return {
    id,
    workspaceId: "",
    farmId: fallbackScope.farmId,
    seasonId: fallbackScope.seasonId,
    clientRecordId: id as string,
    entityType: entity,
    sourceType: null,
    oldAndroidId: null,
    importBatchId: null,
    sourceFileHash: null,
    payload: { ...record, ...extra, id, source_type: sourceType, old_android_id: oldId(record), createdAt, updatedAt: createdAt },
    recordedBy: "",
    clientUpdatedAt: new Date(createdAt),
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
  };
}

const payloadId = (payload: unknown) => {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>).id;
  return typeof value === "string" && value.trim() ? value : null;
};

const importedAccountReferenceFields = [
  "accountId",
  "paymentAccountId",
  "paidFromAccountId",
  "partnerAccountId",
  "fromAccountId",
  "toAccountId",
] as const;

async function findExistingImportedAccountRecord(
  tx: typeof db,
  workspaceId: string,
  fileHash: string,
  oldAndroidId: string | null,
  normalizedName: string,
  normalizedType: string,
) {
  const exactMatch = oldAndroidId
    ? await tx.select({
      id: operationalRecords.id,
      clientRecordId: operationalRecords.clientRecordId,
      payload: operationalRecords.payload,
    }).from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, workspaceId),
      eq(operationalRecords.entityType, "account"),
      eq(operationalRecords.sourceFileHash, fileHash),
      eq(operationalRecords.oldAndroidId, oldAndroidId),
      sql`${operationalRecords.payload}->>'deletedAt' IS NULL`,
    )).limit(1)
    : [];
  if (exactMatch[0]) return exactMatch[0];

  const fallbackMatch = await tx.select({
    id: operationalRecords.id,
    clientRecordId: operationalRecords.clientRecordId,
    payload: operationalRecords.payload,
  }).from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId, workspaceId),
    eq(operationalRecords.entityType, "account"),
    eq(operationalRecords.sourceFileHash, fileHash),
    sql`${operationalRecords.payload}->>'deletedAt' IS NULL`,
    sql`lower(regexp_replace(coalesce(${operationalRecords.payload}->>'name', ''), '\s+', ' ', 'g')) = ${normalizedName}`,
    sql`lower(replace(coalesce(${operationalRecords.payload}->>'type', 'cash'), ' ', '_')) = ${normalizedType}`,
  )).limit(1);
  return fallbackMatch[0] ?? null;
}

async function repairDuplicateImportedAccounts(workspaceId: string): Promise<AccountDuplicateRepairResult> {
  return db.transaction(async (tx) => {
    const accountRows = await tx.select({
      id: operationalRecords.id,
      clientRecordId: operationalRecords.clientRecordId,
      payload: operationalRecords.payload,
      oldAndroidId: operationalRecords.oldAndroidId,
      sourceFileHash: operationalRecords.sourceFileHash,
      createdAt: operationalRecords.createdAt,
    }).from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, workspaceId),
      eq(operationalRecords.entityType, "account"),
      sql`${operationalRecords.payload}->>'deletedAt' IS NULL`,
    ));

    const childRows = await tx.select({
      id: operationalRecords.id,
      entityType: operationalRecords.entityType,
      payload: operationalRecords.payload,
    }).from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, workspaceId),
      sql`${operationalRecords.payload}->>'deletedAt' IS NULL`,
      ne(operationalRecords.entityType, "account"),
    ));

    const childReferenceCounts = new Map<string, number>();
    for (const row of childRows) {
      const payload = row.payload as Record<string, unknown>;
      for (const field of importedAccountReferenceFields) {
        const value = payload[field];
        if (typeof value === "string" && value.trim()) {
          childReferenceCounts.set(value, (childReferenceCounts.get(value) ?? 0) + 1);
        }
      }
    }

    const grouped = new Map<string, typeof accountRows>();
    for (const row of accountRows) {
      const payload = row.payload as Record<string, unknown>;
      const key = `${String(payload.name ?? "").trim()}::${String(payload.type ?? "cash").trim()}`;
      grouped.set(key, [...(grouped.get(key) ?? []), row]);
    }

    const duplicateGroups = [...grouped.entries()]
      .map(([groupKey, rows]) => ({ groupKey, rows }))
      .filter((group) => group.rows.length > 1);
    let childRecordsRemapped = 0;
    let duplicateAccountsRemoved = 0;
    let canonicalAccountsKept = 0;
    const groupsBefore: AccountDuplicateRepairResult["groupsBefore"] = [];

    for (const group of duplicateGroups) {
      const sorted = [...group.rows].sort((a, b) => {
        const aRefCount = childReferenceCounts.get(a.clientRecordId) ?? 0;
        const bRefCount = childReferenceCounts.get(b.clientRecordId) ?? 0;
        const aIsCurrentReferenced = a.sourceFileHash ? aRefCount > 0 : false;
        const bIsCurrentReferenced = b.sourceFileHash ? bRefCount > 0 : false;
        if (aIsCurrentReferenced !== bIsCurrentReferenced) return Number(bIsCurrentReferenced) - Number(aIsCurrentReferenced);
        const refDelta = bRefCount - aRefCount;
        if (refDelta !== 0) return refDelta;
        const hashDelta = Number(Boolean(b.sourceFileHash)) - Number(Boolean(a.sourceFileHash));
        if (hashDelta !== 0) return hashDelta;
        return b.createdAt.getTime() - a.createdAt.getTime();
      });
      const canonical = sorted[0]!;
      const canonicalPayload = canonical.payload as Record<string, unknown>;
      groupsBefore.push({
        name: String(canonicalPayload.name ?? "").trim(),
        type: String(canonicalPayload.type ?? "cash").trim(),
        count: group.rows.length,
        accountIds: group.rows.map((row) => row.clientRecordId),
        canonicalAccountId: canonical.clientRecordId,
      });
      canonicalAccountsKept += 1;
      const duplicateIds = sorted.slice(1).map((row) => row.id);
      const duplicateClientIds = new Set(sorted.slice(1).map((row) => row.clientRecordId));
      if (!duplicateIds.length) continue;

      for (const row of childRows) {
        const payload = row.payload as Record<string, unknown>;
        let changed = false;
        const nextPayload = { ...payload };
        for (const field of importedAccountReferenceFields) {
          const value = nextPayload[field];
          if (typeof value === "string" && duplicateClientIds.has(value)) {
            nextPayload[field] = canonical.clientRecordId;
            changed = true;
          }
        }
        if (changed) {
          await tx.update(operationalRecords).set({
            payload: nextPayload,
            updatedAt: new Date(),
          }).where(eq(operationalRecords.id, row.id));
          childRecordsRemapped += 1;
        }
      }

      const deleted = await tx.delete(operationalRecords)
        .where(inArray(operationalRecords.id, duplicateIds))
        .returning({ id: operationalRecords.id });
      duplicateAccountsRemoved += deleted.length;
    }

    const mixedTypeGroups = new Map<string, typeof accountRows>();
    for (const row of await tx.select({
      id: operationalRecords.id,
      clientRecordId: operationalRecords.clientRecordId,
      payload: operationalRecords.payload,
      oldAndroidId: operationalRecords.oldAndroidId,
      sourceFileHash: operationalRecords.sourceFileHash,
      createdAt: operationalRecords.createdAt,
    }).from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, workspaceId),
      eq(operationalRecords.entityType, "account"),
      sql`${operationalRecords.payload}->>'deletedAt' IS NULL`,
    ))) {
      const payload = row.payload as Record<string, unknown>;
      const nameKey = normalizeImportedName(payload.name);
      mixedTypeGroups.set(nameKey, [...(mixedTypeGroups.get(nameKey) ?? []), row]);
    }

    for (const rows of mixedTypeGroups.values()) {
      if (rows.length < 2) continue;
      const partnerRows = rows.filter((row) => normalizeImportedAccountType((row.payload as Record<string, unknown>).type, "cash") === "partner");
      const nonPartnerRows = rows.filter((row) => normalizeImportedAccountType((row.payload as Record<string, unknown>).type, "cash") !== "partner");
      if (!partnerRows.length || !nonPartnerRows.length) continue;
      const sampleName = String((rows[0]?.payload as Record<string, unknown> | undefined)?.name ?? "").trim();
      if (accountNameLooksLikePaymentAccount(sampleName)) continue;

      const canonicalPartnerRows = [...partnerRows].sort((a, b) => {
        const aRefCount = childReferenceCounts.get(a.clientRecordId) ?? 0;
        const bRefCount = childReferenceCounts.get(b.clientRecordId) ?? 0;
        const refDelta = bRefCount - aRefCount;
        if (refDelta !== 0) return refDelta;
        const hashDelta = Number(Boolean(b.sourceFileHash)) - Number(Boolean(a.sourceFileHash));
        if (hashDelta !== 0) return hashDelta;
        return b.createdAt.getTime() - a.createdAt.getTime();
      });
      const canonical = canonicalPartnerRows[0];
      if (!canonical) continue;
      const duplicateIds = nonPartnerRows.map((row) => row.id);
      const duplicateClientIds = new Set(nonPartnerRows.map((row) => row.clientRecordId));
      if (!duplicateIds.length) continue;

      for (const row of childRows) {
        const payload = row.payload as Record<string, unknown>;
        let changed = false;
        const nextPayload = { ...payload };
        for (const field of importedAccountReferenceFields) {
          const value = nextPayload[field];
          if (typeof value === "string" && duplicateClientIds.has(value)) {
            nextPayload[field] = canonical.clientRecordId;
            changed = true;
          }
        }
        if (changed) {
          await tx.update(operationalRecords).set({
            payload: nextPayload,
            updatedAt: new Date(),
          }).where(eq(operationalRecords.id, row.id));
          childRecordsRemapped += 1;
        }
      }

      const deleted = await tx.delete(operationalRecords)
        .where(inArray(operationalRecords.id, duplicateIds))
        .returning({ id: operationalRecords.id });
      duplicateAccountsRemoved += deleted.length;
    }

    const accountRowsAfter = await tx.select({
      clientRecordId: operationalRecords.clientRecordId,
      payload: operationalRecords.payload,
    }).from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, workspaceId),
      eq(operationalRecords.entityType, "account"),
      sql`${operationalRecords.payload}->>'deletedAt' IS NULL`,
    ));
    const groupedAfter = new Map<string, typeof accountRowsAfter>();
    for (const row of accountRowsAfter) {
      const payload = row.payload as Record<string, unknown>;
      const key = `${String(payload.name ?? "").trim()}::${String(payload.type ?? "cash").trim()}`;
      groupedAfter.set(key, [...(groupedAfter.get(key) ?? []), row]);
    }
    const groupsAfter = [...groupedAfter.values()]
      .filter((rows) => rows.length > 1)
      .map((rows) => {
        const payload = rows[0]?.payload as Record<string, unknown> | undefined;
        return {
          name: String(payload?.name ?? "").trim(),
          type: String(payload?.type ?? "cash").trim(),
          count: rows.length,
          accountIds: rows.map((row) => row.clientRecordId),
          canonicalAccountId: rows[0]?.clientRecordId ?? null,
        };
      });

    await tx.insert(auditLogs).values({
      workspaceId,
      action: "admin.migration_import.repair_duplicate_accounts",
      entityType: "migration_import",
      details: {
        duplicateGroupsBefore: duplicateGroups.length,
        duplicateGroupsAfter: groupsAfter.length,
        canonicalAccountsKept,
        childRecordsRemapped,
        duplicateAccountsRemoved,
        groupsBefore,
        groupsAfter,
      },
    });

    return {
      duplicateGroupsBefore: duplicateGroups.length,
      duplicateGroupsAfter: groupsAfter.length,
      canonicalAccountsKept,
      childRecordsRemapped,
      duplicateAccountsRemoved,
      groupsBefore,
      groupsAfter,
    };
  });
}

async function auditDuplicateImportedAccounts(workspaceId: string, fileHash: string) {
  const [accountRows, childRows] = await Promise.all([
    db.select({
      clientRecordId: operationalRecords.clientRecordId,
      payload: operationalRecords.payload,
      oldAndroidId: operationalRecords.oldAndroidId,
      sourceFileHash: operationalRecords.sourceFileHash,
      createdAt: operationalRecords.createdAt,
    }).from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, workspaceId),
      eq(operationalRecords.entityType, "account"),
      eq(operationalRecords.sourceFileHash, fileHash),
      sql`${operationalRecords.payload}->>'deletedAt' IS NULL`,
    )),
    db.select({
      id: operationalRecords.id,
      payload: operationalRecords.payload,
    }).from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, workspaceId),
      eq(operationalRecords.sourceFileHash, fileHash),
      ne(operationalRecords.entityType, "account"),
      sql`${operationalRecords.payload}->>'deletedAt' IS NULL`,
    )),
  ]);

  const childReferenceCounts = new Map<string, number>();
  for (const row of childRows) {
    const payload = row.payload as Record<string, unknown>;
    for (const field of importedAccountReferenceFields) {
      const value = payload[field];
      if (typeof value === "string" && value.trim()) {
        childReferenceCounts.set(value, (childReferenceCounts.get(value) ?? 0) + 1);
      }
    }
  }

  const grouped = new Map<string, typeof accountRows>();
  for (const row of accountRows) {
    const payload = row.payload as Record<string, unknown>;
    const key = importedAccountGroupKey(payload);
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }

  const duplicateGroups = [...grouped.entries()]
    .map(([logicalKey, rows]) => {
      if (rows.length < 2) return null;
      const sorted = [...rows].sort((a, b) => {
        const aRefCount = childReferenceCounts.get(a.clientRecordId) ?? 0;
        const bRefCount = childReferenceCounts.get(b.clientRecordId) ?? 0;
        const aIsCurrentReferenced = a.sourceFileHash ? aRefCount > 0 : false;
        const bIsCurrentReferenced = b.sourceFileHash ? bRefCount > 0 : false;
        if (aIsCurrentReferenced !== bIsCurrentReferenced) return Number(bIsCurrentReferenced) - Number(aIsCurrentReferenced);
        const refDelta = bRefCount - aRefCount;
        if (refDelta !== 0) return refDelta;
        const hashDelta = Number(Boolean(b.sourceFileHash)) - Number(Boolean(a.sourceFileHash));
        if (hashDelta !== 0) return hashDelta;
        return b.createdAt.getTime() - a.createdAt.getTime();
      });
      const canonical = sorted[0] ?? null;
      const payload = canonical?.payload as Record<string, unknown> | undefined;
      return {
        logicalKey,
        normalizedName: normalizeImportedName(payload?.name),
        normalizedType: normalizeImportedAccountType(payload?.type, "cash"),
        count: rows.length,
        canonicalAccountId: canonical?.clientRecordId ?? null,
        childReferenceCount: canonical ? (childReferenceCounts.get(canonical.clientRecordId) ?? 0) : 0,
        accountIds: rows.map((row) => row.clientRecordId),
      };
    })
    .filter((group): group is NonNullable<typeof group> => Boolean(group));

  return {
    totalGroups: duplicateGroups.length,
    groups: duplicateGroups,
  };
}

async function loadCleanupTarget(workspaceId: string, batchId: string): Promise<CleanupTarget | null> {
  const [batch] = await db.select({
    batchId: importBatches.id,
    workspaceId: importBatches.workspaceId,
    fileHash: importBatches.fileHash,
    source: importBatches.source,
  }).from(importBatches).where(and(
    eq(importBatches.id, batchId),
    eq(importBatches.workspaceId, workspaceId),
  )).limit(1);
  return batch ?? null;
}

async function cleanupPreview(workspaceId: string, batchId: string) {
  const target = await loadCleanupTarget(workspaceId, batchId);
  if (!target) return null;

  const operationalRows = await db.execute(sql`
    SELECT entity_type, count(*)::int AS count
    FROM operational_records
    WHERE workspace_id = ${workspaceId}
      AND (
        import_batch_id = ${batchId}
        OR source_file_hash = ${target.fileHash}
        OR source_type = 'muzare_android'
      )
    GROUP BY entity_type
    ORDER BY entity_type
  `);
  const [batchCounts] = await db.execute(sql`
    SELECT
      count(*)::int AS batches,
      count(*) FILTER (WHERE status IN ('failed', 'partial_failed', 'running'))::int AS open_batches
    FROM import_batches
    WHERE workspace_id = ${workspaceId}
      AND (id = ${batchId} OR file_hash = ${target.fileHash} OR source = 'muzare_android')
  `).then((result) => result.rows as Array<{ batches: number; open_batches: number }>);
  const [failureCounts] = await db.execute(sql`
    SELECT count(*)::int AS failures
    FROM import_failures f
    INNER JOIN import_batches b ON b.id = f.import_batch_id
    WHERE b.workspace_id = ${workspaceId}
      AND (b.id = ${batchId} OR b.file_hash = ${target.fileHash} OR b.source = 'muzare_android')
  `).then((result) => result.rows as Array<{ failures: number }>);
  const [farmCounts] = await db.execute(sql`
    SELECT count(*)::int AS farms
    FROM farms
    WHERE workspace_id = ${workspaceId}
      AND (
        import_batch_id = ${batchId}
        OR source_file_hash = ${target.fileHash}
        OR source_type = 'farm'
      )
  `).then((result) => result.rows as Array<{ farms: number }>);
  const [seasonCounts] = await db.execute(sql`
    SELECT count(*)::int AS seasons
    FROM seasons
    WHERE workspace_id = ${workspaceId}
      AND (
        import_batch_id = ${batchId}
        OR source_file_hash = ${target.fileHash}
        OR source_type = 'season'
      )
  `).then((result) => result.rows as Array<{ seasons: number }>);
  const [editedCounts] = await db.execute(sql`
    SELECT count(*)::int AS edited
    FROM operational_records
    WHERE workspace_id = ${workspaceId}
      AND (
        import_batch_id = ${batchId}
        OR source_file_hash = ${target.fileHash}
        OR source_type = 'muzare_android'
      )
      AND updated_at > created_at + interval '1 second'
  `).then((result) => result.rows as Array<{ edited: number }>);

  return {
    batchId,
    fileHash: target.fileHash,
    source: target.source,
    operationalRecordsByEntity: operationalRows.rows.map((row) => ({
      entityType: String((row as Record<string, unknown>).entity_type),
      count: Number((row as Record<string, unknown>).count ?? 0),
    })),
    importBatches: Number(batchCounts?.batches ?? 0),
    openImportBatches: Number(batchCounts?.open_batches ?? 0),
    importFailures: Number(failureCounts?.failures ?? 0),
    importedFarms: Number(farmCounts?.farms ?? 0),
    importedSeasons: Number(seasonCounts?.seasons ?? 0),
    editedImportedRecords: Number(editedCounts?.edited ?? 0),
  };
}

async function buildPostImportAudit(
  workspaceId: string,
  importBatchId: string,
  fileHash: string,
  payload: AndroidPayload,
): Promise<PostImportAudit> {
  const duplicateAccountAudit = await auditDuplicateImportedAccounts(workspaceId, fileHash);
  const [farmCountRows, seasonCountRows, failedBatchRows, entityRows, failureRows, relationshipRows, importedVoucherRows, duplicateVoucherRows] = await Promise.all([
    db.execute(sql`
      SELECT count(*)::int AS count
      FROM farms
      WHERE workspace_id = ${workspaceId}
        AND source_file_hash = ${fileHash}
    `),
    db.execute(sql`
      SELECT count(*)::int AS count
      FROM seasons
      WHERE workspace_id = ${workspaceId}
        AND source_file_hash = ${fileHash}
    `),
    db.execute(sql`
      SELECT count(*)::int AS count
      FROM import_batches
      WHERE workspace_id = ${workspaceId}
        AND file_hash = ${fileHash}
        AND status IN ('failed', 'partial_failed')
    `),
    db.execute(sql`
      SELECT entity_type, count(*)::int AS count
      FROM operational_records
      WHERE workspace_id = ${workspaceId}
        AND source_file_hash = ${fileHash}
      GROUP BY entity_type
      ORDER BY entity_type
    `),
    db.execute(sql`
      SELECT count(*)::int AS count
      FROM import_failures
      WHERE import_batch_id = ${importBatchId}
    `),
    db.execute(sql`
      WITH imported_labour AS (
        SELECT client_record_id
        FROM operational_records
        WHERE workspace_id = ${workspaceId}
          AND entity_type = 'labourer'
          AND source_file_hash = ${fileHash}
      ),
      imported_accounts AS (
        SELECT client_record_id
        FROM operational_records
        WHERE workspace_id = ${workspaceId}
          AND entity_type = 'account'
          AND source_file_hash = ${fileHash}
      ),
      imported_rows AS (
        SELECT entity_type, payload
        FROM operational_records
        WHERE workspace_id = ${workspaceId}
          AND source_file_hash = ${fileHash}
      )
      SELECT
        count(*) FILTER (WHERE entity_type = 'attendance')::int AS attendance_total,
        count(*) FILTER (
          WHERE entity_type = 'attendance'
            AND EXISTS (
              SELECT 1 FROM imported_labour l
              WHERE l.client_record_id = payload->>'labourerId'
            )
        )::int AS attendance_linked_labour,
        count(*) FILTER (
          WHERE entity_type = 'attendance'
            AND NOT EXISTS (
              SELECT 1 FROM imported_labour l
              WHERE l.client_record_id = payload->>'labourerId'
            )
        )::int AS attendance_missing_labour,
        count(*) FILTER (WHERE entity_type = 'advance')::int AS advances_total,
        count(*) FILTER (
          WHERE entity_type = 'advance'
            AND EXISTS (
              SELECT 1 FROM imported_labour l
              WHERE l.client_record_id = payload->>'labourerId'
            )
        )::int AS advances_linked_labour,
        count(*) FILTER (
          WHERE entity_type = 'advance'
            AND NOT EXISTS (
              SELECT 1 FROM imported_labour l
              WHERE l.client_record_id = payload->>'labourerId'
            )
        )::int AS advances_missing_labour,
        count(*) FILTER (
          WHERE entity_type = 'advance'
            AND EXISTS (
              SELECT 1 FROM imported_accounts a
              WHERE a.client_record_id = payload->>'accountId'
            )
        )::int AS advances_linked_account,
        count(*) FILTER (
          WHERE entity_type = 'advance'
            AND (
              coalesce(payload->>'accountId', '') = ''
              OR NOT EXISTS (
                SELECT 1 FROM imported_accounts a
                WHERE a.client_record_id = payload->>'accountId'
              )
            )
        )::int AS advances_missing_account,
        count(*) FILTER (WHERE entity_type = 'voucher')::int AS vouchers_total,
        count(*) FILTER (
          WHERE entity_type = 'voucher'
            AND EXISTS (
              SELECT 1 FROM imported_accounts a
              WHERE a.client_record_id = payload->>'accountId'
            )
        )::int AS vouchers_linked_account,
        count(*) FILTER (
          WHERE entity_type = 'voucher'
            AND (
              coalesce(payload->>'accountId', '') = ''
              OR NOT EXISTS (
                SELECT 1 FROM imported_accounts a
                WHERE a.client_record_id = payload->>'accountId'
              )
            )
        )::int AS vouchers_missing_account,
        count(*) FILTER (
          WHERE entity_type = 'voucher'
            AND jsonb_typeof(coalesce(payload->'items', '[]'::jsonb)) = 'array'
            AND jsonb_array_length(coalesce(payload->'items', '[]'::jsonb)) > 1
        )::int AS vouchers_multiple_items,
        coalesce(sum(
          CASE
            WHEN entity_type = 'voucher' AND jsonb_typeof(coalesce(payload->'items', '[]'::jsonb)) = 'array'
              THEN jsonb_array_length(coalesce(payload->'items', '[]'::jsonb))
            ELSE 0
          END
        ), 0)::int AS voucher_items_stored,
        count(*) FILTER (
          WHERE entity_type = 'voucher'
            AND jsonb_typeof(coalesce(payload->'items', '[]'::jsonb)) = 'array'
            AND abs(
              coalesce((payload->>'amount')::numeric, 0)
              - coalesce((
                SELECT sum(coalesce((item->>'amount')::numeric, 0))
                FROM jsonb_array_elements(coalesce(payload->'items', '[]'::jsonb)) AS item
              ), 0)
            ) > 0.01
        )::int AS vouchers_item_mismatch
      FROM imported_rows
    `),
    db.execute(sql`
      SELECT
        client_record_id,
        coalesce(payload->>'voucherNumber', '') AS stored_voucher_number,
        coalesce(payload->>'originalVoucherNumber', '') AS original_voucher_number,
        coalesce(payload->>'legacyVoucherNumber', '') AS legacy_voucher_number,
        coalesce(payload->>'oldExpenseId', coalesce(payload->>'old_android_id', old_android_id, '')) AS old_expense_id
      FROM operational_records
      WHERE workspace_id = ${workspaceId}
        AND entity_type = 'voucher'
        AND source_file_hash = ${fileHash}
    `),
    db.execute(sql`
      SELECT
        payload->>'voucherNumber' AS voucher_number,
        count(*)::int AS count,
        array_agg(client_record_id ORDER BY client_record_id) AS client_record_ids
      FROM operational_records
      WHERE workspace_id = ${workspaceId}
        AND entity_type = 'voucher'
        AND source_file_hash = ${fileHash}
        AND nullif(trim(coalesce(payload->>'voucherNumber', '')), '') IS NOT NULL
      GROUP BY payload->>'voucherNumber'
      HAVING count(*) > 1
      ORDER BY payload->>'voucherNumber'
    `),
  ]);
  const relationship = (relationshipRows.rows[0] as Record<string, unknown> | undefined) ?? {};
  const sourceVoucherRows = asArray(payload, "expenses");
  const sourceVoucherNumbers = new Map(sourceVoucherRows.map((record) => [
    oldId(record),
    text(record, ["voucherNumber", "voucher_no", "voucherNo", "voucher"], ""),
  ]));
  const voucherMismatches: PostImportAudit["voucherNumberAudit"]["mismatches"] = [];
  let missingStoredVoucherNumbers = 0;
  for (const row of importedVoucherRows.rows as Array<Record<string, unknown>>) {
    const oldExpenseId = String(row.old_expense_id ?? "");
    const androidVoucherNumber = sourceVoucherNumbers.get(oldExpenseId) ?? "";
    const storedVoucherNumber = String(row.stored_voucher_number ?? row.original_voucher_number ?? row.legacy_voucher_number ?? "");
    if (!storedVoucherNumber.trim()) missingStoredVoucherNumbers += 1;
    if (androidVoucherNumber.trim() && storedVoucherNumber.trim() && androidVoucherNumber !== storedVoucherNumber) {
      voucherMismatches.push({
        oldExpenseId,
        androidVoucherNumber,
        storedVoucherNumber,
        clientRecordId: String(row.client_record_id ?? ""),
      });
    }
  }

  return {
    expectedCounts: {
      labour: asArray(payload, "labour").length,
      accounts: asArray(payload, "accounts").length,
      partners: asArray(payload, "partners").length,
      expenses: asArray(payload, "expenses").length,
      expenseItems: asArray(payload, "expenseItems").length,
      advances: asArray(payload, "advances").length,
      attendance: asArray(payload, "attendance").length,
      sales: asArray(payload, "sales").length,
      dispatches: asArray(payload, "dispatches").length,
    },
    tableCounts: {
      farms: Number((farmCountRows.rows[0] as Record<string, unknown> | undefined)?.count ?? 0),
      seasons: Number((seasonCountRows.rows[0] as Record<string, unknown> | undefined)?.count ?? 0),
      importFailures: Number((failureRows.rows[0] as Record<string, unknown> | undefined)?.count ?? 0),
      failedOrPartialBatches: Number((failedBatchRows.rows[0] as Record<string, unknown> | undefined)?.count ?? 0),
    },
    duplicateAccountAudit,
    operationalRecordsByEntity: entityRows.rows.map((row) => ({
      entityType: String((row as Record<string, unknown>).entity_type ?? ""),
      count: Number((row as Record<string, unknown>).count ?? 0),
    })),
    voucherNumberAudit: {
      sourceTotal: sourceVoucherRows.length,
      importedTotal: Number(relationship.vouchers_total ?? 0),
      missingSourceVoucherNumbers: sourceVoucherRows.filter((record) => !text(record, ["voucherNumber", "voucher_no", "voucherNo", "voucher"], "").trim()).length,
      missingStoredVoucherNumbers,
      mismatches: voucherMismatches,
      duplicateImportedVoucherNumbers: duplicateVoucherRows.rows.map((row) => ({
        voucherNumber: String((row as Record<string, unknown>).voucher_number ?? ""),
        count: Number((row as Record<string, unknown>).count ?? 0),
        clientRecordIds: Array.isArray((row as Record<string, unknown>).client_record_ids)
          ? ((row as Record<string, unknown>).client_record_ids as unknown[]).map((value) => String(value))
          : [],
      })),
    },
    relationshipAudit: {
      attendanceTotal: Number(relationship.attendance_total ?? 0),
      attendanceLinkedToLabour: Number(relationship.attendance_linked_labour ?? 0),
      attendanceMissingLabour: Number(relationship.attendance_missing_labour ?? 0),
      advancesTotal: Number(relationship.advances_total ?? 0),
      advancesLinkedToLabour: Number(relationship.advances_linked_labour ?? 0),
      advancesMissingLabour: Number(relationship.advances_missing_labour ?? 0),
      advancesLinkedToAccount: Number(relationship.advances_linked_account ?? 0),
      advancesMissingAccount: Number(relationship.advances_missing_account ?? 0),
      vouchersTotal: Number(relationship.vouchers_total ?? 0),
      vouchersLinkedToPaymentAccount: Number(relationship.vouchers_linked_account ?? 0),
      vouchersMissingPaymentAccount: Number(relationship.vouchers_missing_account ?? 0),
      vouchersWithMultipleItems: Number(relationship.vouchers_multiple_items ?? 0),
      voucherItemsStored: Number(relationship.voucher_items_stored ?? 0),
      vouchersWithItemMismatch: Number(relationship.vouchers_item_mismatch ?? 0),
    },
  };
}

async function buildVisibilityAudit(workspaceId: string, sessionId?: string | null): Promise<VisibilityAuditResponse> {
  const [latestBatch] = await db.select().from(importBatches)
    .where(eq(importBatches.workspaceId, workspaceId))
    .orderBy(sql`${importBatches.startedAt} DESC`)
    .limit(1);
  const fileHash = latestBatch?.fileHash ?? null;

  const context = await resolveWorkspaceContext(workspaceId, sessionId);
  const activeFarm = context.activeFarmId
    ? context.farms.find((farm) => farm.id === context.activeFarmId) ?? null
    : null;
  const activeSeason = context.activeSeasonId
    ? context.seasons.find((season) => season.id === context.activeSeasonId) ?? null
    : null;

  if (!fileHash) {
    return {
      workspaceId,
      latestImport: {
        batchId: null,
        fileHash: null,
        source: null,
        status: null,
        startedAt: null,
        completedAt: null,
      },
      server: {
        farmsImported: 0,
        seasonsImported: 0,
        operationalRecordsByEntity: [],
      },
      context: {
        activeFarmId: context.activeFarmId,
        activeSeasonId: context.activeSeasonId,
        activeFarmName: activeFarm?.name ?? null,
        activeSeasonName: activeSeason?.name ?? null,
        contextWarning: context.contextWarning,
      },
    };
  }

  const [farmRows, seasonRows, entityRows] = await Promise.all([
    db.execute(sql`
      SELECT count(*)::int AS count
      FROM farms
      WHERE workspace_id = ${workspaceId}
        AND source_file_hash = ${fileHash}
    `),
    db.execute(sql`
      SELECT count(*)::int AS count
      FROM seasons
      WHERE workspace_id = ${workspaceId}
        AND source_file_hash = ${fileHash}
    `),
    db.execute(sql`
      SELECT entity_type, count(*)::int AS count
      FROM operational_records
      WHERE workspace_id = ${workspaceId}
        AND source_file_hash = ${fileHash}
      GROUP BY entity_type
      ORDER BY entity_type
    `),
  ]);

  return {
    workspaceId,
    latestImport: {
      batchId: latestBatch!.id,
      fileHash,
      source: latestBatch!.source,
      status: latestBatch!.status,
      startedAt: latestBatch!.startedAt.toISOString(),
      completedAt: latestBatch!.completedAt?.toISOString() ?? null,
    },
    server: {
      farmsImported: Number((farmRows.rows[0] as Record<string, unknown> | undefined)?.count ?? 0),
      seasonsImported: Number((seasonRows.rows[0] as Record<string, unknown> | undefined)?.count ?? 0),
      operationalRecordsByEntity: entityRows.rows.map((row) => ({
        entityType: String((row as Record<string, unknown>).entity_type ?? ""),
        count: Number((row as Record<string, unknown>).count ?? 0),
      })),
    },
    context: {
      activeFarmId: context.activeFarmId,
      activeSeasonId: context.activeSeasonId,
      activeFarmName: activeFarm?.name ?? null,
      activeSeasonName: activeSeason?.name ?? null,
      contextWarning: context.contextWarning,
    },
  };
}

export async function migrationImportRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/admin/migration-import/validate", { preHandler: requirePermission("CREATE_WORKSPACE"), bodyLimit: 50 * 1024 * 1024 }, async (request, reply) => {
    const parsed = payloadSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "A workspaceId and Android export JSON payload are required." });
    const [workspace] = localDevelopmentMode ? [{ id: parsed.data.workspaceId }] : await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, parsed.data.workspaceId)).limit(1);
    if (!workspace) return reply.code(404).send({ message: "Workspace not found." });
    const validation = validatePayload(parsed.data.payload, { allowSummaryMismatch: parsed.data.allowSummaryMismatch });
    return { ...validation, canImport: validation.issues.every((issue) => issue.level !== "error"), dryRunRecommended: true };
  });

  app.get("/v1/admin/migration-import/history", { preHandler: requirePermission("CREATE_WORKSPACE") }, async (request, reply) => {
    const parsed = historyQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ message: "A workspaceId is required." });
    if (localDevelopmentMode) return { records: [] };
    const records = await db.select({
      id: auditLogs.id,
      action: auditLogs.action,
      details: auditLogs.details,
      createdAt: auditLogs.createdAt,
    }).from(auditLogs).where(and(
      eq(auditLogs.workspaceId, parsed.data.workspaceId),
      sql`${auditLogs.action} LIKE 'admin.migration_import.%'`,
    )).orderBy(sql`${auditLogs.createdAt} DESC`).limit(80);
    return {
      records: records.map((record) => ({
        id: record.id,
        action: record.action,
        details: record.details,
        createdAt: record.createdAt.toISOString(),
      })),
    };
  });

  app.get("/v1/admin/migration-import/batches", { preHandler: requirePermission("CREATE_WORKSPACE") }, async (request, reply) => {
    const parsed = batchListQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ message: "A workspaceId is required." });
    try {
      const workspaceId = parsed.data.workspaceId;
      const normalizeJsonField = (value: unknown, field: "payload_json" | "summary_json" | "error_json") => {
        console.log("FETCH_BATCHES_PARSE_START", { workspaceId, field });
        if (value === null || value === undefined) return { value: null, parseError: false };
        if (typeof value === "object" && !Array.isArray(value)) {
          console.log("FETCH_BATCHES_PARSE_RESULT", { workspaceId, field, parseError: false });
          return { value, parseError: false };
        }
        console.log("FETCH_BATCHES_PARSE_RESULT", { workspaceId, field, parseError: true });
        return { value: null, parseError: true };
      };
      const requiredColumns = [
        "id",
        "workspace_id",
        "source",
        "export_version",
        "file_name",
        "file_hash",
        "status",
        "started_by",
        "started_at",
        "completed_at",
        "payload_json",
        "summary_json",
        "error_json",
        "created_at",
        "updated_at",
      ];
      console.log("FETCH_BATCHES_START", {
        workspaceId,
        fileHash: null,
        query: "information_schema.columns/import_batches",
      });
      const columnRows = await db.execute(sql`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'import_batches'
      `);
      console.log("FETCH_BATCHES_RESULT", {
        workspaceId,
        fileHash: null,
        query: "information_schema.columns/import_batches",
        count: columnRows.rows.length,
      });
      const availableColumns = new Set(columnRows.rows.map((row) => String((row as Record<string, unknown>).column_name)));
      if (!availableColumns.size) {
        return reply.code(500).send({
          success: false,
          message: "Import history unavailable",
          details: "The import_batches table is missing from the current database schema.",
        });
      }
      const missingColumns = requiredColumns.filter((column) => !availableColumns.has(column));
      if (missingColumns.length) {
        return reply.code(500).send({
          success: false,
          message: "Import history unavailable",
          details: `The import_batches table is missing required columns: ${missingColumns.join(", ")}.`,
        });
      }

      console.log("FETCH_BATCHES_START", {
        workspaceId,
        fileHash: null,
        query: "import_batches/select",
      });
      const records = await db.select({
        id: importBatches.id,
        source: importBatches.source,
        exportVersion: importBatches.exportVersion,
        fileName: importBatches.fileName,
        fileHash: importBatches.fileHash,
        status: importBatches.status,
        startedAt: importBatches.startedAt,
        completedAt: importBatches.completedAt,
        payloadJson: importBatches.payloadJson,
        summaryJson: importBatches.summaryJson,
        errorJson: importBatches.errorJson,
      }).from(importBatches)
        .where(eq(importBatches.workspaceId, workspaceId))
        .orderBy(sql`${importBatches.startedAt} DESC`)
        .limit(20);
      console.log("FETCH_BATCHES_RESULT", {
        workspaceId,
        fileHash: null,
        query: "import_batches/select",
        count: records.length,
      });

      return {
        records: records.map((record) => {
          const payloadJson = normalizeJsonField(record.payloadJson, "payload_json");
          const summaryJson = normalizeJsonField(record.summaryJson, "summary_json");
          const errorJson = normalizeJsonField(record.errorJson, "error_json");
          const parseErrors = [
            ...(payloadJson.parseError ? ["payload_json"] : []),
            ...(summaryJson.parseError ? ["summary_json"] : []),
            ...(errorJson.parseError ? ["error_json"] : []),
          ];
          return {
            id: record.id,
            source: record.source,
            exportVersion: record.exportVersion,
            fileName: record.fileName,
            fileHash: record.fileHash,
            status: record.status,
            startedAt: record.startedAt.toISOString(),
            completedAt: record.completedAt?.toISOString() ?? null,
            payloadJson: payloadJson.value,
            summaryJson: summaryJson.value,
            errorJson: errorJson.value,
            parseError: parseErrors.length > 0,
            parseErrorFields: parseErrors,
          };
        }),
      };
    } catch (error) {
      const details = error as {
        message?: string;
        code?: string;
        detail?: string;
        hint?: string;
        table?: string;
        column?: string;
        constraint?: string;
        stack?: string;
      };
      console.error("MIGRATION_BATCHES_ERROR", {
        message: details.message,
        code: details.code,
        detail: details.detail,
        hint: details.hint,
        table: details.table,
        column: details.column,
        constraint: details.constraint,
        stack: details.stack,
      });
      throw error;
    }
  });

  app.get("/v1/admin/migration-imports/:jobId", { preHandler: requirePermission("CREATE_WORKSPACE") }, async (request, reply) => {
    const parsed = jobParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ message: "A valid import job id is required." });
    const [batch] = await db.select().from(importBatches).where(eq(importBatches.id, parsed.data.jobId)).limit(1);
    if (!batch) return reply.code(404).send({ message: "Import job not found." });
    const failures = await db.select().from(importFailures)
      .where(eq(importFailures.importBatchId, parsed.data.jobId))
      .orderBy(sql`${importFailures.createdAt} ASC`)
      .limit(500);
    const liveJob = attendanceImportJobs.get(parsed.data.jobId);
    const summary = batch.summaryJson && typeof batch.summaryJson === "object" ? batch.summaryJson as Record<string, unknown> : {};
    const job = liveJob ?? (summary.job && typeof summary.job === "object" ? summary.job as AttendanceImportJobStatus : null);
    return {
      jobId: batch.id,
      status: liveJob?.status ?? batch.status,
      currentStep: liveJob?.currentStep ?? job?.currentStep ?? "Unknown",
      message: liveJob?.message ?? job?.message ?? ((batch.errorJson && typeof batch.errorJson === "object" ? (batch.errorJson as Record<string, unknown>).message : null) as string | null) ?? "",
      error: liveJob?.error ?? job?.error ?? ((batch.errorJson && typeof batch.errorJson === "object" ? (batch.errorJson as Record<string, unknown>).error : null) as string | null) ?? "",
      stack: liveJob?.stack ?? job?.stack ?? ((batch.errorJson && typeof batch.errorJson === "object" ? (batch.errorJson as Record<string, unknown>).stack : null) as string | null) ?? "",
      failedRows: liveJob?.failedRows ?? job?.failedRows ?? failures.length,
      importedRows: liveJob?.importedRows ?? job?.importedRows ?? 0,
      updatedRows: liveJob?.updatedRows ?? job?.updatedRows ?? 0,
      skippedRows: liveJob?.skippedRows ?? job?.skippedRows ?? 0,
      firstFailureMessage: liveJob?.firstFailureMessage ?? job?.firstFailureMessage ?? failures[0]?.errorMessage ?? "",
      startedAt: liveJob?.startedAt ?? job?.startedAt ?? batch.startedAt.toISOString(),
      completedAt: liveJob?.completedAt ?? job?.completedAt ?? batch.completedAt?.toISOString() ?? null,
      steps: liveJob?.steps ?? job?.steps ?? ((summary.steps as ImportJobStep[] | undefined) ?? []),
      failures: failures.map((failure) => ({
        id: failure.id,
        step: failure.step,
        sourceRow: failure.sourceRow,
        errorMessage: failure.errorMessage,
        createdAt: failure.createdAt.toISOString(),
      })),
    };
  });

  app.get("/v1/admin/migration-imports/:jobId/failures.csv", { preHandler: requirePermission("CREATE_WORKSPACE") }, async (request, reply) => {
    const parsed = jobParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ message: "A valid import job id is required." });
    const failures = await db.select().from(importFailures)
      .where(eq(importFailures.importBatchId, parsed.data.jobId))
      .orderBy(sql`${importFailures.createdAt} ASC`);
    const csv = [
      "sourceRow,step,reason",
      ...failures.map((failure) => [
        JSON.stringify(failure.sourceRow ?? ""),
        JSON.stringify(failure.step),
        JSON.stringify(failure.errorMessage),
      ].join(",")),
    ].join("\n");
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename=\"migration-import-failures-${parsed.data.jobId}.csv\"`);
    return csv;
  });

  app.get("/v1/admin/migration-import/imports/status/:jobId", { preHandler: requirePermission("CREATE_WORKSPACE") }, async (request, reply) => {
    const parsed = jobParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ message: "A valid import job id is required." });
    const job = attendanceImportJobs.get(parsed.data.jobId);
    if (!job) return reply.code(404).send({ message: "Import job not found." });
    return { job };
  });
  app.get("/v1/admin/migration-imports/:jobId/status", { preHandler: requirePermission("CREATE_WORKSPACE") }, async (request, reply) => {
    const parsed = jobParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ message: "A valid import job id is required." });
    const job = attendanceImportJobs.get(parsed.data.jobId);
    if (!job) return reply.code(404).send({ message: "Import job not found." });
    return { job };
  });

  app.get("/v1/admin/migration-import/imports/active", { preHandler: requirePermission("CREATE_WORKSPACE") }, async (request, reply) => {
    const parsed = activeJobQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ message: "A workspaceId is required." });
    const activeJob = [...attendanceImportJobs.values()]
      .filter((job) => job.workspaceId === parsed.data.workspaceId)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .find((job) => job.status === "queued" || job.status === "running");
    return { job: activeJob ?? null };
  });

  app.get("/v1/admin/migration-import/cleanup-preview", { preHandler: requirePermission("CREATE_WORKSPACE") }, async (request, reply) => {
    const parsed = cleanupPreviewQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ message: "A workspaceId and batchId are required." });
    const preview = await cleanupPreview(parsed.data.workspaceId, parsed.data.batchId);
    if (!preview) return reply.code(404).send({ message: "Import batch not found." });
    return { preview };
  });
  app.get("/v1/admin/migration-imports/active", { preHandler: requirePermission("CREATE_WORKSPACE") }, async (request, reply) => {
    const parsed = activeJobQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ message: "A workspaceId is required." });
    const activeJob = [...attendanceImportJobs.values()]
      .filter((job) => job.workspaceId === parsed.data.workspaceId)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .find((job) => job.status === "queued" || job.status === "running");
    return { job: activeJob ?? null };
  });

  app.get("/v1/workspace/:workspaceId/import-visibility-audit", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser) return reply;
    const parsed = workspaceParams.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ message: "A valid workspaceId is required." });
    const canAccess = Boolean(
      request.appUser.platformRole
      || request.appUser.workspaceId === parsed.data.workspaceId
      || request.appUser.memberships.some((membership) => membership.active && membership.workspaceId === parsed.data.workspaceId),
    );
    if (!canAccess) return reply.code(403).send({ message: "Workspace membership is required." });
    const audit = await buildVisibilityAudit(
      parsed.data.workspaceId,
      request.appUser.platformRole ? null : request.sessionId,
    );
    return audit;
  });

  const buildScopedMapsFromDb = async (workspaceId: string) => {
    const [farmRows, seasonRows, labourRows, accountRows, partnerRows] = await Promise.all([
      db.select().from(farms).where(eq(farms.workspaceId, workspaceId)),
      db.select().from(seasons).where(eq(seasons.workspaceId, workspaceId)),
      db.select().from(operationalRecords).where(and(eq(operationalRecords.workspaceId, workspaceId), eq(operationalRecords.entityType, "labourer"))),
      db.select().from(operationalRecords).where(and(eq(operationalRecords.workspaceId, workspaceId), eq(operationalRecords.entityType, "account"))),
      db.select().from(operationalRecords).where(and(eq(operationalRecords.workspaceId, workspaceId), eq(operationalRecords.entityType, "account"), sql`coalesce(${operationalRecords.payload}->>'type', '') = 'partner'`)),
    ]);
    return {
      farms: new Map(farmRows.filter((row) => row.oldAndroidId).map((row) => [String(row.oldAndroidId), row.id])),
      seasons: new Map(seasonRows.filter((row) => row.oldAndroidId).map((row) => [String(row.oldAndroidId), row.id])),
      labour: new Map(labourRows.filter((row) => row.oldAndroidId).map((row) => [String(row.oldAndroidId), row.clientRecordId])),
      accounts: new Map(accountRows.filter((row) => row.oldAndroidId).map((row) => [String(row.oldAndroidId), row.clientRecordId])),
      partners: new Map(partnerRows.filter((row) => row.oldAndroidId).map((row) => [String(row.oldAndroidId), row.clientRecordId])),
    };
  };

  const handleMigrationImport = async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = importSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "A valid migration import request is required." });
    const validation = validatePayload(parsed.data.payload, { allowSummaryMismatch: parsed.data.allowSummaryMismatch });
    const hasErrors = validation.issues.some((issue) => issue.level === "error");
    if (hasErrors) return reply.code(400).send({ message: "Resolve validation errors before importing.", ...validation });
    if (parsed.data.dryRun || localDevelopmentMode) return { ...validation, imported: false, dryRun: true, message: localDevelopmentMode ? "Local memory mode cannot write migration data. Configure a dev database first." : "Dry run completed. No data was written." };
    if (!parsed.data.allowDatabaseWrite) return reply.code(403).send({ message: "Database writes are blocked. Enable explicit database write confirmation to import." });

    const userId = request.appUser?.id;
    if (!userId) return reply.code(403).send({ message: "Admin user is required." });
    const [workspace] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, parsed.data.workspaceId)).limit(1);
    if (!workspace) return reply.code(404).send({ message: "Workspace not found." });
    const fileHash = payloadHash(parsed.data.payload);
    const [existingBatchForFile] = await db.select().from(importBatches).where(and(
      eq(importBatches.workspaceId, parsed.data.workspaceId),
      eq(importBatches.fileHash, fileHash),
    )).limit(1);
    const existingRunningJob = [...attendanceImportJobs.values()]
      .filter((job) => job.workspaceId === parsed.data.workspaceId)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .find((job) => job.status === "queued" || job.status === "running");
    if (existingRunningJob) {
      return reply.code(409).send({
        message: "An import is already running for this workspace.",
        job: existingRunningJob,
      });
    }
    if (existingBatchForFile && ["partial_failed", "failed", "running"].includes(existingBatchForFile.status)) {
      return reply.code(409).send({
        message: "This file has a failed or in-progress import batch. Finish cleanup, retry attendance, or repair visibility before starting a fresh import.",
        existingBatch: {
          id: existingBatchForFile.id,
          status: existingBatchForFile.status,
          startedAt: existingBatchForFile.startedAt.toISOString(),
          completedAt: existingBatchForFile.completedAt?.toISOString() ?? null,
          fileHash: existingBatchForFile.fileHash,
        },
      });
    }

    const importBatchId = existingBatchForFile?.id ?? randomUUID();
    const startedAt = new Date().toISOString();
    const logs: ImportLogEntry[] = [];
    let currentStep = "START IMPORT";
    const buildStep = (name: typeof importStepOrder[number], source = 0): ImportJobStep => ({
      name,
      status: "pending",
      source,
      imported: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      processed: 0,
      total: source,
    });
    const importJob: AttendanceImportJobStatus = {
      jobId: importBatchId,
      importBatchId,
      workspaceId: parsed.data.workspaceId,
      status: "running",
      currentStep: "START IMPORT",
      sourceRows: asArray(parsed.data.payload, "attendance").length,
      totalBatches: Math.ceil(asArray(parsed.data.payload, "attendance").length / 100),
      currentBatch: 0,
      processedRows: 0,
      importedRows: 0,
      updatedRows: 0,
      skippedRows: 0,
      failedRows: 0,
      startedAt,
      lastProgressAt: startedAt,
      steps: [
        buildStep("Farms", asArray(parsed.data.payload, "farms").length),
        buildStep("Seasons", asArray(parsed.data.payload, "seasons").length),
        buildStep("Accounts", asArray(parsed.data.payload, "accounts").length),
        buildStep("Partners", asArray(parsed.data.payload, "partners").length),
        buildStep("Labour", asArray(parsed.data.payload, "labour").length),
        buildStep("Expenses", asArray(parsed.data.payload, "expenses").length),
        buildStep("Expense Items", asArray(parsed.data.payload, "expenseItems").length),
        buildStep("Advances", asArray(parsed.data.payload, "advances").length),
        buildStep("Attendance", asArray(parsed.data.payload, "attendance").length),
      ],
      logs: [],
    };
    if (existingBatchForFile) {
      await db.delete(importFailures).where(eq(importFailures.importBatchId, importBatchId));
      await db.update(importBatches).set({
        source: validation.summary.source ?? "unknown",
        exportVersion: validation.summary.exportVersion,
        fileName: parsed.data.fileName ?? null,
        status: "running",
        startedBy: userId,
        startedAt: new Date(startedAt),
        completedAt: null,
        payloadJson: parsed.data.payload,
        summaryJson: { summary: validation.summary, steps: importJob.steps, job: importJob },
        errorJson: {},
        updatedAt: new Date(),
      }).where(eq(importBatches.id, importBatchId));
    } else {
      await db.insert(importBatches).values({
        id: importBatchId,
        workspaceId: parsed.data.workspaceId,
        source: validation.summary.source ?? "unknown",
        exportVersion: validation.summary.exportVersion,
        fileName: parsed.data.fileName ?? null,
        fileHash,
        status: "running",
        startedBy: userId,
        startedAt: new Date(startedAt),
        payloadJson: parsed.data.payload,
        summaryJson: { summary: validation.summary, steps: importJob.steps, job: importJob },
        errorJson: {},
      });
    }
    const updateJob = (patch: Partial<AttendanceImportJobStatus>) => {
      Object.assign(importJob, patch, { lastProgressAt: new Date().toISOString() });
      attendanceImportJobs.set(importJob.jobId, importJob);
    };
    const persistBatch = async (statusOverride?: string, errorJson?: Record<string, unknown>) => {
      await db.update(importBatches).set({
        status: statusOverride ?? importJob.status,
        completedAt: importJob.completedAt ? new Date(importJob.completedAt) : null,
        summaryJson: {
          summary: validation.summary,
          steps: importJob.steps,
          job: importJob,
          importCounts: importCountKeys.map(({ label, key }) => ({ label, key, count: key === "attendance" ? importJob.importedRows : 0 })),
        },
        errorJson: errorJson ?? null,
        updatedAt: new Date(),
      }).where(eq(importBatches.id, importBatchId));
    };
    const updateJobStep = (name: string, patch: Partial<ImportJobStep>) => {
      const step = importJob.steps.find((entry) => entry.name === name);
      if (!step) return;
      Object.assign(step, patch);
      updateJob({});
    };
    const recordFailure = async (step: string, sourceRow: string | null | undefined, errorMessage: string) => {
      if (!importJob.firstFailureMessage) updateJob({ firstFailureMessage: errorMessage, error: errorMessage });
      await db.insert(importFailures).values({
        importBatchId,
        workspaceId: parsed.data.workspaceId,
        step,
        sourceRow: sourceRow ?? null,
        errorMessage,
      }).onConflictDoNothing({
        target: [importFailures.importBatchId, importFailures.step, importFailures.sourceRow],
      }).catch((error) => console.error(`[MIGRATION IMPORT ${importBatchId}] failed to persist import failure`, error));
    };
    attendanceImportJobs.set(importJob.jobId, importJob);
    const logStep = async (step: string, status: ImportLogEntry["status"], details: Omit<ImportLogEntry, "step" | "status" | "createdAt"> = {}) => {
      currentStep = step;
      updateJob({ currentStep: step });
      const entry = { step, status, createdAt: new Date().toISOString(), ...details };
      logs.push(entry);
      importJob.logs = logs.slice(-80);
      updateJob({});
      const message = `[MIGRATION IMPORT ${importBatchId}] ${status.toUpperCase()} ${step}${details.message ? ` - ${details.message}` : ""}`;
      if (status === "failed") console.error(message);
      else console.info(message);
      await db.insert(auditLogs).values({
        workspaceId: parsed.data.workspaceId,
        userId,
        action: `admin.migration_import.${status}`,
        entityType: "migration_import",
        details: { importBatchId, ...entry },
      }).catch((error) => console.error(`[MIGRATION IMPORT ${importBatchId}] failed to persist import log`, error));
      await persistBatch(status === "failed" ? "failed" : undefined, status === "failed" ? { message: details.message ?? step, step } : undefined)
        .catch((error) => console.error(`[MIGRATION IMPORT ${importBatchId}] failed to persist batch status`, error));
    };

    await logStep("START IMPORT", "started", { message: "Android JSON import started." });

    let result: ImportResult;
    try {
      result = await (async (tx: typeof db) => {
      const importYear = inferImportYear(parsed.data.payload);
      const maps = { farms: new Map<string, string>(), seasons: new Map<string, string>(), labour: new Map<string, string>(), accounts: new Map<string, string>(), partners: new Map<string, string>() };
      let insertedOperationalRecords = 0;
      const farmImportStats = { created: 0, updated: 0, skippedDuplicates: 0 };
      const importedCounts: Record<ImportCountKey, number> = {
        farms: 0,
        seasons: 0,
        accounts: 0,
        partners: 0,
        labour: 0,
        expenses: 0,
        expenseItems: 0,
        advances: 0,
        attendance: 0,
      };

      updateJobStep("Farms", { status: "running", startedAt: new Date().toISOString(), message: "Importing farms." });
      await logStep("CREATE FARM", "started");
      for (const [index, source] of asArray(parsed.data.payload, "farms").entries()) {
        const sourceType = sourceTypeFor("farms");
        const androidId = oldId(source);
        const existingMatches = await tx.select({ id: farms.id, name: farms.name, remarks: farms.remarks }).from(farms).where(and(
          eq(farms.workspaceId, parsed.data.workspaceId),
          eq(farms.sourceType, sourceType),
          eq(farms.oldAndroidId, androidId),
          eq(farms.sourceFileHash, fileHash),
          sql`${farms.deletedAt} IS NULL`,
          eq(farms.active, true),
        ));
        const existing = existingMatches[0];
        if (existingMatches.length > 1) {
          farmImportStats.skippedDuplicates += existingMatches.length - 1;
        }
        const id = existing?.id ?? randomUUID();
        maps.farms.set(oldId(source), id);
        const nextFarm = {
          name: farmName(source, index),
          location: text(source, ["location", "address", "farmLocation", "farm_location"]) || null,
          owner: text(source, ["owner", "ownerName", "manager", "operator"]) || null,
          remarks: existing?.remarks?.startsWith("source_type:") || existing?.remarks?.startsWith("old_android_id:") ? null : existing?.remarks ?? (text(source, ["remarks", "notes", "description"]) || null),
          sourceType,
          oldAndroidId: androidId,
          importBatchId,
          sourceFileHash: fileHash,
          active: importedActive(source),
          updatedAt: new Date(),
        };
        if (!existing) {
          await tx.insert(farms).values({
            id,
            workspaceId: parsed.data.workspaceId,
            ...nextFarm,
            createdBy: userId,
          });
          importedCounts.farms += 1;
          farmImportStats.created += 1;
        } else {
          await tx.update(farms).set(nextFarm).where(eq(farms.id, existing.id));
          farmImportStats.updated += 1;
          for (const duplicate of existingMatches.slice(1)) {
            await tx.update(farms).set({
              active: false,
              remarks: null,
              updatedAt: new Date(),
            }).where(eq(farms.id, duplicate.id));
          }
        }
      }
      if (!maps.farms.size) {
        const fallbackId = randomUUID();
        await tx.insert(farms).values({
          id: fallbackId,
          workspaceId: parsed.data.workspaceId,
          name: "Imported Farm 1",
          sourceType: "farm",
          oldAndroidId: "default",
          importBatchId,
          active: true,
          createdBy: userId,
        });
        maps.farms.set("default", fallbackId);
        importedCounts.farms += 1;
        farmImportStats.created += 1;
      }
      updateJobStep("Farms", {
        status: "completed",
        imported: importedCounts.farms,
        processed: asArray(parsed.data.payload, "farms").length,
        completedAt: new Date().toISOString(),
        message: `Processed ${asArray(parsed.data.payload, "farms").length} farm rows.`,
      });
      await logStep("CREATE FARM", "completed", { importedRows: importedCounts.farms, failedRows: 0 });
      const importedFarmIds = [...maps.farms.values()];
      const [activeImportedFarm] = await tx.select({ id: farms.id }).from(farms).where(and(
        await visibleFarmWhere(parsed.data.workspaceId),
        inArray(farms.id, importedFarmIds),
      )).limit(1);
      if (!activeImportedFarm && importedFarmIds[0]) {
        await tx.update(farms).set({ active: true, updatedAt: new Date() }).where(eq(farms.id, importedFarmIds[0]));
      }
      const defaultFarmId = activeImportedFarm?.id ?? importedFarmIds[0]!;
      const seasonByFarm = new Map<string, string>();
      const farmBySeason = new Map<string, string>();
      updateJobStep("Seasons", { status: "running", startedAt: new Date().toISOString(), message: "Importing seasons." });
      await logStep("CREATE SEASON", "started");
      for (const source of asArray(parsed.data.payload, "seasons")) {
        const farmId = maps.farms.get(farmRef(source)) ?? defaultFarmId;
        const [existing] = await tx.select({ id: seasons.id }).from(seasons).where(and(
          eq(seasons.workspaceId, parsed.data.workspaceId),
          eq(seasons.farmId, farmId),
          eq(seasons.sourceType, sourceTypeFor("seasons")),
          eq(seasons.oldAndroidId, oldId(source)),
          eq(seasons.sourceFileHash, fileHash),
          eq(seasons.active, true),
          ne(seasons.status, "archived"),
          sql`EXISTS (
            SELECT 1
            FROM farms f
            WHERE f.id = ${seasons.farmId}
              AND f.workspace_id = ${seasons.workspaceId}
              AND f.deleted_at IS NULL
              AND f.active = true
          )`,
        )).limit(1);
        const id = existing?.id ?? randomUUID();
        maps.seasons.set(oldId(source), id);
        seasonByFarm.set(farmId, id);
        farmBySeason.set(id, farmId);
        if (!existing) {
          const seasonYear = numberValue(source, ["year"], importYear);
          await tx.insert(seasons).values({
            id,
            workspaceId: parsed.data.workspaceId,
            farmId,
            name: text(source, ["name", "seasonName"], `Imported Season ${seasonYear}`),
            cropType: text(source, ["cropType", "crop_type"]) || null,
            year: seasonYear,
            startsOn: dateValue(source, ["startsOn", "starts_on", "startDate"], `${seasonYear}-01-01`),
            endsOn: text(source, ["endsOn", "ends_on", "endDate"]) || null,
            status: "active",
            notes: `source_type:${sourceTypeFor("seasons")};old_android_id:${oldId(source)}`,
            sourceType: sourceTypeFor("seasons"),
            oldAndroidId: oldId(source),
            importBatchId,
            sourceFileHash: fileHash,
            active: true,
            createdBy: userId,
          });
          importedCounts.seasons += 1;
        } else {
          await tx.update(seasons).set({
            farmId,
            status: "active",
            active: true,
            sourceType: sourceTypeFor("seasons"),
            oldAndroidId: oldId(source),
            importBatchId,
            sourceFileHash: fileHash,
            updatedAt: new Date(),
          }).where(eq(seasons.id, existing.id));
        }
      }
      for (const farmId of importedFarmIds) {
        if (seasonByFarm.has(farmId)) continue;
        const [existingDefaultSeason] = await tx.select({ id: seasons.id }).from(seasons).where(and(
          eq(seasons.workspaceId, parsed.data.workspaceId),
          eq(seasons.farmId, farmId),
          eq(seasons.sourceType, "season"),
          eq(seasons.oldAndroidId, `default:${farmId}`),
          eq(seasons.sourceFileHash, fileHash),
          eq(seasons.active, true),
          ne(seasons.status, "archived"),
        )).limit(1);
        const fallbackSeasonId = existingDefaultSeason?.id ?? randomUUID();
        if (existingDefaultSeason) {
          await tx.update(seasons).set({
            status: "active",
            active: true,
            closed: false,
            updatedAt: new Date(),
          }).where(eq(seasons.id, existingDefaultSeason.id));
        } else {
          await tx.insert(seasons).values({
            id: fallbackSeasonId,
            workspaceId: parsed.data.workspaceId,
            farmId,
            name: `Imported Season ${importYear}`,
            year: importYear,
            startsOn: `${importYear}-01-01`,
            status: "active",
            notes: `source_type:season;old_android_id:default:${farmId}`,
            sourceType: "season",
            oldAndroidId: `default:${farmId}`,
            importBatchId,
            sourceFileHash: fileHash,
            active: true,
            createdBy: userId,
          });
          importedCounts.seasons += 1;
        }
        maps.seasons.set(`default:${farmId}`, fallbackSeasonId);
        seasonByFarm.set(farmId, fallbackSeasonId);
        farmBySeason.set(fallbackSeasonId, farmId);
      }
      updateJobStep("Seasons", {
        status: "completed",
        imported: importedCounts.seasons,
        processed: importJob.steps.find((step) => step.name === "Seasons")?.source ?? 0,
        completedAt: new Date().toISOString(),
        message: `Processed ${importJob.steps.find((step) => step.name === "Seasons")?.source ?? 0} season rows.`,
      });
      await logStep("CREATE SEASON", "completed", { importedRows: importedCounts.seasons, failedRows: 0 });
      const defaultSeasonId = firstMapValue(maps.seasons)!;
      const selectedImportSeasonId = seasonByFarm.get(defaultFarmId) ?? defaultSeasonId;
      await logStep("ACTIVATE FARM", "started", { message: defaultFarmId });
      await tx.update(userSessions).set({
        activeFarmId: defaultFarmId,
        activeSeasonId: selectedImportSeasonId,
      }).where(eq(userSessions.workspaceId, parsed.data.workspaceId));
      await logStep("ACTIVATE FARM", "completed", { message: defaultFarmId });
      await logStep("ACTIVATE SEASON", "completed", { message: selectedImportSeasonId });

      const writeRecord = async (
        entity: string,
        sourceType: string,
        source: AndroidRecord,
        extra: Record<string, unknown> = {},
        options?: { existingMatch?: { id: string; clientRecordId: string; payload: Record<string, unknown> } | null },
      ) => {
        const referencedSeasonId = maps.seasons.get(seasonRef(source));
        const targetFarmId = referencedSeasonId ? farmBySeason.get(referencedSeasonId) ?? scopedFarmId(source, maps, defaultFarmId) : scopedFarmId(source, maps, defaultFarmId);
        const targetSeasonId = referencedSeasonId ?? seasonByFarm.get(targetFarmId) ?? defaultSeasonId;
        const record = operationalRecord(entity, source, sourceType, maps, { farmId: targetFarmId, seasonId: targetSeasonId }, extra);
        const recordPayload = record.payload as Record<string, unknown>;
        const androidId = oldId(source) || [
          entity,
          recordPayload.labourerId,
          recordPayload.date,
          recordPayload.amount,
          recordPayload.name,
          record.farmId,
          record.seasonId,
        ].filter((value) => value !== undefined && value !== null && value !== "").join(":") || randomUUID();
        record.clientRecordId = `android:${fileHash}:${sourceType}:${androidId}`;
        record.payload = {
          ...recordPayload,
          id: record.clientRecordId,
          clientRecordId: record.clientRecordId,
          old_android_id: androidId,
        } as typeof record.payload;
        record.workspaceId = parsed.data.workspaceId;
        record.recordedBy = userId;
        record.sourceType = sourceType;
        record.oldAndroidId = androidId;
        record.importBatchId = importBatchId;
        record.sourceFileHash = fileHash;
        const [queriedExisting] = await tx.select({ id: operationalRecords.id, payload: operationalRecords.payload, clientRecordId: operationalRecords.clientRecordId }).from(operationalRecords).where(and(
          eq(operationalRecords.workspaceId, parsed.data.workspaceId),
          eq(operationalRecords.entityType, entity),
          eq(operationalRecords.sourceFileHash, fileHash),
          or(
            and(eq(operationalRecords.sourceType, sourceType), eq(operationalRecords.oldAndroidId, androidId)),
            and(
              sql`${operationalRecords.payload}->>'source_type' = ${sourceType}`,
              sql`${operationalRecords.payload}->>'old_android_id' = ${androidId}`,
            ),
          ),
          or(
            sql`${operationalRecords.farmId} IS NULL`,
            sql`EXISTS (
              SELECT 1
              FROM farms f
              WHERE f.id = ${operationalRecords.farmId}
                AND f.workspace_id = ${operationalRecords.workspaceId}
                AND f.deleted_at IS NULL
                AND f.active = true
            )`,
          ),
          or(
            sql`${operationalRecords.seasonId} IS NULL`,
            sql`EXISTS (
              SELECT 1
              FROM seasons s
              JOIN farms f ON f.id = s.farm_id AND f.workspace_id = s.workspace_id
              WHERE s.id = ${operationalRecords.seasonId}
                AND s.workspace_id = ${operationalRecords.workspaceId}
                AND s.active = true
                AND s.status <> 'archived'
                AND f.deleted_at IS NULL
                AND f.active = true
            )`,
          ),
        )).limit(1);
        const existing = options?.existingMatch ?? queriedExisting ?? null;
        if (existing) {
          const existingPayload = existing.payload && typeof existing.payload === "object" ? existing.payload as Record<string, unknown> : {};
          const nextPayload = {
            ...existingPayload,
            ...record.payload,
            id: existing.clientRecordId ?? record.clientRecordId,
            clientRecordId: existing.clientRecordId ?? record.clientRecordId,
          };
          await tx.update(operationalRecords).set({
            farmId: record.farmId,
            seasonId: record.seasonId,
            sourceType,
            oldAndroidId: androidId,
            importBatchId,
            sourceFileHash: fileHash,
            payload: nextPayload,
            clientUpdatedAt: record.clientUpdatedAt,
            updatedAt: record.updatedAt,
          }).where(eq(operationalRecords.id, existing.id));
          return { inserted: false, updated: true, payloadId: payloadId(nextPayload), clientRecordId: existing.clientRecordId };
        }
        await tx.insert(operationalRecords).values(record);
        insertedOperationalRecords += 1;
        return { inserted: true, updated: false, payloadId: payloadId(record.payload), clientRecordId: record.clientRecordId };
      };

      updateJobStep("Accounts", { status: "running", startedAt: new Date().toISOString(), message: "Importing accounts." });
      updateJobStep("Partners", { status: "running", startedAt: new Date().toISOString(), message: "Importing partners." });
      await logStep("IMPORT ACCOUNTS", "started");
      let updatedAccounts = 0;
      let updatedPartners = 0;
      const importedPartnerNames = new Set(
        asArray(parsed.data.payload, "partners")
          .map((source) => normalizeImportedName(text(source, ["name", "partnerName"], "")))
          .filter(Boolean),
      );
      for (const source of asArray(parsed.data.payload, "accounts")) {
        const id = randomUUID();
        const accountName = text(source, ["name", "accountName"], "Imported Account");
        const accountType = classifyImportedAccountType(source, importedPartnerNames);
        const existingAccount = await findExistingImportedAccountRecord(
          tx,
          parsed.data.workspaceId,
          fileHash,
          oldId(source),
          normalizeImportedName(accountName),
          accountType,
        );
        const result = await writeRecord("account", sourceTypeFor("accounts"), source, {
          id: existingAccount?.clientRecordId ?? id,
          name: accountName,
          type: accountType,
          openingBalance: numberValue(source, ["openingBalance", "opening_balance"]),
          active: importedActive(source),
        }, { existingMatch: existingAccount });
        maps.accounts.set(oldId(source), result.clientRecordId ?? result.payloadId ?? id);
        if (result.inserted) importedCounts.accounts += 1;
        if (result.updated) updatedAccounts += 1;
      }
      for (const source of asArray(parsed.data.payload, "partners")) {
        const linkedAccountId = maps.accounts.get(accountRef(source));
        if (linkedAccountId) {
          maps.partners.set(oldId(source), linkedAccountId);
          updatedPartners += 1;
          continue;
        }
        const id = randomUUID();
        const partnerName = text(source, ["name", "partnerName"], "Imported Partner");
        const existingPartner = await findExistingImportedAccountRecord(
          tx,
          parsed.data.workspaceId,
          fileHash,
          oldId(source),
          normalizeImportedName(partnerName),
          "partner",
        );
        const result = await writeRecord("account", sourceTypeFor("partners"), source, {
          id: existingPartner?.clientRecordId ?? id,
          accountId: maps.accounts.get(accountRef(source)),
          name: partnerName,
          type: "partner",
          openingBalance: numberValue(source, ["balance", "openingBalance", "opening_balance"]),
          active: importedActive(source),
        }, { existingMatch: existingPartner });
        maps.partners.set(oldId(source), result.clientRecordId ?? result.payloadId ?? id);
        if (result.inserted) importedCounts.partners += 1;
        if (result.updated) updatedPartners += 1;
      }
      updateJobStep("Accounts", {
        status: "completed",
        imported: importedCounts.accounts,
        updated: updatedAccounts,
        processed: asArray(parsed.data.payload, "accounts").length,
        completedAt: new Date().toISOString(),
      });
      updateJobStep("Partners", {
        status: "completed",
        imported: importedCounts.partners,
        updated: updatedPartners,
        processed: asArray(parsed.data.payload, "partners").length,
        completedAt: new Date().toISOString(),
      });
      await logStep("IMPORT ACCOUNTS", "completed", { sourceRows: asArray(parsed.data.payload, "accounts").length, importedRows: importedCounts.accounts, updatedRows: updatedAccounts, failedRows: 0 });
      await logStep("IMPORT PARTNERS", "completed", { sourceRows: asArray(parsed.data.payload, "partners").length, importedRows: importedCounts.partners, updatedRows: updatedPartners, failedRows: 0 });
      const labourNameMap = new Map<string, string>();
      updateJobStep("Labour", { status: "running", startedAt: new Date().toISOString(), message: "Importing labour." });
      await logStep("IMPORT LABOUR", "started");
      let updatedLabour = 0;
      for (const source of asArray(parsed.data.payload, "labour")) {
        const id = randomUUID();
        const name = text(source, ["name", "labourName", "workerName", "employeeName"], "Imported Labour");
        const result = await writeRecord("labourer", sourceTypeFor("labour"), source, { id, name, phone: text(source, ["phone", "mobile", "mobileNumber"]), notes: text(source, ["notes", "remarks"]), group: text(source, ["groupName", "group", "paymentGroup"], "Imported"), dailyWage: numberValue(source, ["dailyWage", "dailyRate", "wage"]), paymentType: text(source, ["paymentType"], "daily_wage"), active: importedActive(source) });
        const labourId = result.clientRecordId ?? result.payloadId ?? id;
        maps.labour.set(oldId(source), labourId);
        labourNameMap.set(name.trim().toLowerCase(), labourId);
        if (result.inserted) importedCounts.labour += 1;
        if (result.updated) updatedLabour += 1;
      }
      updateJobStep("Labour", {
        status: "completed",
        imported: importedCounts.labour,
        updated: updatedLabour,
        processed: asArray(parsed.data.payload, "labour").length,
        completedAt: new Date().toISOString(),
      });
      await logStep("IMPORT LABOUR", "completed", { sourceRows: asArray(parsed.data.payload, "labour").length, importedRows: importedCounts.labour, updatedRows: updatedLabour, failedRows: 0 });
      const resolveLabourId = (source: AndroidRecord) => maps.labour.get(labourRef(source))
        ?? labourNameMap.get(text(source, ["labourName", "labour_name", "workerName", "worker_name", "employeeName", "name"]).trim().toLowerCase());
      const defaultAccountId = firstMapValue(maps.accounts);
      const expenseCategoryLookup = await loadExpenseCategoryLookup(tx, parsed.data.workspaceId);

      const expenseItemsByParent = new Map<string, AndroidRecord[]>();
      asArray(parsed.data.payload, "expenseItems").forEach((item, index) => {
        const parentId = relation(item, ["oldExpenseId", "expense_id", "expenseId", "voucher_id", "voucherId", "parent_id", "parentId"]);
        const next = [...(expenseItemsByParent.get(parentId) ?? []), { ...item, __importIndex: index }];
        next.sort((left, right) => itemSortWeight(left, Number(left.__importIndex ?? 0)) - itemSortWeight(right, Number(right.__importIndex ?? 0)));
        expenseItemsByParent.set(parentId, next);
      });
      updateJobStep("Expenses", { status: "running", startedAt: new Date().toISOString(), message: "Importing expenses." });
      updateJobStep("Expense Items", { status: "running", startedAt: new Date().toISOString(), message: "Importing expense items." });
      await logStep("IMPORT EXPENSES", "started");
      let updatedExpenses = 0;
      let updatedExpenseItems = 0;
      for (const source of asArray(parsed.data.payload, "expenses")) {
        const items = expenseItemsByParent.get(oldId(source)) ?? [];
        const normalizedItems = items.length
          ? items.map((item, index) => {
            const importedCategoryName = text(item, ["category", "categoryName"], "");
            const importedSubcategoryName = text(item, ["subcategory", "subcategoryName"], "");
            const resolvedCategory = resolveImportedExpenseCategory(
              expenseCategoryLookup,
              importedCategoryName,
              importedSubcategoryName,
            );
            return {
              id: `android:${fileHash}:expense-item:${oldId(item) || `${oldId(source)}:${index + 1}`}`,
              oldExpenseItemId: oldId(item),
              oldAndroidId: oldId(item),
              oldExpenseId: relation(item, ["oldExpenseId", "expense_id", "expenseId", "voucher_id", "voucherId", "parent_id", "parentId"]) || oldId(source),
              categoryId: resolvedCategory.categoryId,
              category: importedCategoryName || resolvedCategory.category,
              categoryName: importedCategoryName || resolvedCategory.category,
              subcategoryId: resolvedCategory.subcategoryId,
              subcategory: importedSubcategoryName,
              subcategoryName: importedSubcategoryName,
              rawCategory: importedCategoryName,
              rawSubcategory: importedSubcategoryName,
              amount: numberValue(item, ["amount", "total", "lineTotal"]),
              description: text(item, ["description", "itemName", "name"]),
              remarks: text(item, ["remarks", "notes"]),
              quantity: numberValue(item, ["quantity", "qty"], 1),
              unit: text(item, ["unit"]),
              sortOrder: itemSortWeight(item, index),
              source_type: sourceTypeFor("expenseItems"),
              old_android_id: oldId(item),
            };
          })
          : (() => {
            const importedCategoryName = text(source, ["category", "categoryName", "expenseCategory"], "Other");
            const importedSubcategoryName = text(source, ["subcategory", "subcategoryName", "expenseSubcategory"], "");
            const resolvedCategory = resolveImportedExpenseCategory(
              expenseCategoryLookup,
              importedCategoryName,
              importedSubcategoryName,
            );
            return [{
              id: `android:${fileHash}:expense-item:fallback:${oldId(source)}`,
              oldExpenseId: oldId(source),
              categoryId: resolvedCategory.categoryId,
              category: importedCategoryName || resolvedCategory.category,
              categoryName: importedCategoryName || resolvedCategory.category,
              subcategoryId: resolvedCategory.subcategoryId,
              subcategory: importedSubcategoryName,
              subcategoryName: importedSubcategoryName,
              rawCategory: importedCategoryName,
              rawSubcategory: importedSubcategoryName,
              amount: numberValue(source, ["total_amount", "totalAmount", "total", "amount", "voucherTotal"]),
              description: text(source, ["description", "notes"], "Imported Android voucher"),
              remarks: text(source, ["notes"]),
              quantity: 1,
              unit: "",
              sortOrder: 0,
              source_type: sourceTypeFor("expenseItems"),
            }];
          })();
        const itemTotal = normalizedItems.reduce((sum, item) => sum + numberValue(item, ["amount"]), 0);
        const headerCategory = normalizedItems[0];
        const androidVoucherNumber = text(source, ["voucherNumber", "voucher_no", "voucherNo", "voucher"], "");
        const preservedVoucherNumber = androidVoucherNumber || `A-${oldId(source)}`;
        const result = await writeRecord("voucher", sourceTypeFor("expenses"), source, {
          voucherNumber: preservedVoucherNumber,
          originalVoucherNumber: preservedVoucherNumber,
          legacyVoucherNumber: preservedVoucherNumber,
          date: dateValue(source, ["date", "voucherDate"]),
          amount: itemTotal || numberValue(source, ["total_amount", "totalAmount", "total", "amount", "voucherTotal"]),
          accountId: maps.accounts.get(accountRef(source)) ?? defaultAccountId,
          paymentAccountId: maps.accounts.get(accountRef(source)) ?? defaultAccountId,
          paidFromAccountId: maps.accounts.get(accountRef(source)) ?? defaultAccountId,
          oldPaymentAccountId: accountRef(source),
          categoryId: headerCategory?.categoryId ?? text(source, ["category_id", "categoryId", "category"], "imported"),
          category: headerCategory?.category ?? text(source, ["category", "categoryName", "expenseCategory"], "Imported"),
          subcategoryId: headerCategory?.subcategoryId ?? text(source, ["subcategory_id", "subcategoryId", "subcategory"], "imported"),
          subcategory: headerCategory?.subcategory ?? text(source, ["subcategory", "subcategoryName", "expenseSubcategory"], "Imported"),
          paidByPartnerName: text(source, ["paidByPartnerName", "paid_by_partner_name"]),
          description: text(source, ["description", "notes"], "Imported Android voucher"),
          notes: text(source, ["notes"]),
          oldExpenseId: oldId(source),
          items: normalizedItems,
        });
        if (result.inserted) {
          importedCounts.expenses += 1;
          importedCounts.expenseItems += items.length;
        }
        if (result.updated) {
          updatedExpenses += 1;
          updatedExpenseItems += items.length;
        }
      }
      updateJobStep("Expenses", {
        status: "completed",
        imported: importedCounts.expenses,
        updated: updatedExpenses,
        processed: asArray(parsed.data.payload, "expenses").length,
        completedAt: new Date().toISOString(),
      });
      updateJobStep("Expense Items", {
        status: "completed",
        imported: importedCounts.expenseItems,
        updated: updatedExpenseItems,
        processed: asArray(parsed.data.payload, "expenseItems").length,
        completedAt: new Date().toISOString(),
      });
      await logStep("IMPORT EXPENSES", "completed", { sourceRows: asArray(parsed.data.payload, "expenses").length, importedRows: importedCounts.expenses, updatedRows: updatedExpenses, failedRows: 0 });
      await logStep("IMPORT EXPENSE ITEMS", "completed", { sourceRows: asArray(parsed.data.payload, "expenseItems").length, importedRows: importedCounts.expenseItems, updatedRows: updatedExpenseItems, failedRows: 0 });
      updateJobStep("Advances", { status: "running", startedAt: new Date().toISOString(), message: "Importing advances." });
      await logStep("IMPORT ADVANCES", "started");
      let updatedAdvances = 0;
      let skippedAdvances = 0;
      const advanceFailures: string[] = [];
      for (const source of asArray(parsed.data.payload, "advances")) {
        const labourerId = resolveLabourId(source);
        if (!labourerId) {
          skippedAdvances += 1;
          const message = `${oldId(source) || "unknown"}: missing mapped labour`;
          advanceFailures.push(message);
          await recordFailure("IMPORT ADVANCES", String(oldId(source) || "unknown"), message);
          continue;
        }
        try {
          const result = await writeRecord("advance", sourceTypeFor("advances"), source, {
            date: dateValue(source, ["date", "advanceDate"]),
            amount: numberValue(source, ["amount"]),
            labourerId,
            labourId: labourerId,
            workerId: labourerId,
            oldLabourId: labourRef(source),
            accountId: maps.accounts.get(accountRef(source)) ?? defaultAccountId,
            paymentAccountId: maps.accounts.get(accountRef(source)) ?? defaultAccountId,
            paidFromAccountId: maps.accounts.get(accountRef(source)) ?? defaultAccountId,
            oldPaymentAccountId: accountRef(source),
            sourceAccountName: text(source, ["paymentAccountName", "accountName", "sourceAccountName"]),
            notes: text(source, ["notes", "description"]),
          });
          if (result.inserted) importedCounts.advances += 1;
          if (result.updated) updatedAdvances += 1;
        } catch (error) {
          skippedAdvances += 1;
          const message = `${oldId(source) || "unknown"}: ${readableImportError(error)}`;
          advanceFailures.push(message);
          await recordFailure("IMPORT ADVANCES", String(oldId(source) || "unknown"), message);
        }
      }
      updateJobStep("Advances", {
        status: skippedAdvances ? "failed" : "completed",
        imported: importedCounts.advances,
        updated: updatedAdvances,
        skipped: skippedAdvances,
        failed: skippedAdvances,
        processed: asArray(parsed.data.payload, "advances").length,
        completedAt: new Date().toISOString(),
        message: advanceFailures.slice(0, 8).join("; ") || "Advances imported.",
      });
      await logStep("IMPORT ADVANCES", "completed", { sourceRows: asArray(parsed.data.payload, "advances").length, importedRows: importedCounts.advances, updatedRows: updatedAdvances, skippedRows: skippedAdvances, failedRows: skippedAdvances, message: advanceFailures.slice(0, 8).join("; ") });
      const attendanceRows = asArray(parsed.data.payload, "attendance");
      const attendanceJobId = importJob.jobId;
      updateJob({
        status: attendanceRows.length ? "running" : "completed",
        currentStep: attendanceRows.length ? "Base import completed. Attendance is processing in the background." : "IMPORT COMPLETE",
        currentBatch: 0,
        totalBatches: Math.ceil(attendanceRows.length / 100),
        completedAt: attendanceRows.length ? undefined : new Date().toISOString(),
        message: attendanceRows.length ? "Base import completed. Attendance is processing in the background." : "Import complete.",
      });
      updateJobStep("Attendance", {
        status: attendanceRows.length ? "running" : "completed",
        startedAt: new Date().toISOString(),
        source: attendanceRows.length,
        total: attendanceRows.length,
        batch: 0,
        batchTotal: Math.ceil(attendanceRows.length / 100),
        message: attendanceRows.length ? "Queued for background processing." : "No attendance rows found.",
        processed: 0,
        imported: 0,
        updated: 0,
        skipped: 0,
        failed: 0,
        completedAt: attendanceRows.length ? undefined : new Date().toISOString(),
      });

      const runAttendanceJob = async () => {
        if (!attendanceRows.length) return;
        let lastHangingLogAt = Date.now();
        updateJob({ status: "running", currentStep: "IMPORT ATTENDANCE", message: "Attendance is processing in the background." });
        updateJobStep("Attendance", { status: "running", startedAt: new Date().toISOString(), message: "Attendance import started." });
        await logStep("IMPORT ATTENDANCE", "started", { sourceRows: attendanceRows.length, message: `Attendance import job ${attendanceJobId} started.` });
        for (const [batchIndex, batch] of chunks(attendanceRows, 100).entries()) {
          const batchNumber = batchIndex + 1;
          updateJob({ currentBatch: batchNumber, currentStep: `Attendance batch ${batchNumber}/${importJob.totalBatches}`, message: `Attendance batch ${batchNumber}/${importJob.totalBatches} running.` });
          updateJobStep("Attendance", { batch: batchNumber, batchTotal: importJob.totalBatches, message: `Attendance batch ${batchNumber}/${importJob.totalBatches} running.` });
          const batchStartedAt = Date.now();
          await logStep("IMPORT ATTENDANCE BATCH", "started", {
            sourceRows: attendanceRows.length,
            importedRows: importJob.importedRows,
            updatedRows: importJob.updatedRows,
            skippedRows: importJob.skippedRows,
            failedRows: importJob.failedRows,
            message: `Attendance batch ${batchNumber}/${importJob.totalBatches}. Processed ${importJob.processedRows}/${attendanceRows.length}.`,
          });
          for (const source of batch) {
            const currentRow = String(oldId(source) || `${importJob.processedRows + 1}`);
            updateJob({ currentRow });
            const labourerId = resolveLabourId(source);
            if (!labourerId) {
              const failureMessage = `${currentRow}: missing mapped labour`;
              updateJob({
                processedRows: importJob.processedRows + 1,
                skippedRows: importJob.skippedRows + 1,
                failedRows: importJob.failedRows + 1,
                message: failureMessage,
              });
              await recordFailure("IMPORT ATTENDANCE", currentRow, failureMessage);
              updateJobStep("Attendance", {
                processed: importJob.processedRows,
                skipped: importJob.skippedRows,
                failed: importJob.failedRows,
                message: failureMessage,
              });
              continue;
            }
            try {
              const result = await writeRecord("attendance", sourceTypeFor("attendance"), source, {
                date: dateValue(source, ["date", "attendanceDate", "day"]),
                labourerId,
                labourId: labourerId,
                workerId: labourerId,
                status: attendanceStatus(source),
                remarks: text(source, ["remarks", "notes"]),
                oldFarmId: farmRef(source),
                oldSeasonId: seasonRef(source),
                oldLabourId: labourRef(source),
              });
              updateJob({
                processedRows: importJob.processedRows + 1,
                importedRows: importJob.importedRows + (result.inserted ? 1 : 0),
                updatedRows: importJob.updatedRows + (result.updated ? 1 : 0),
              });
              updateJobStep("Attendance", {
                processed: importJob.processedRows,
                imported: importJob.importedRows,
                updated: importJob.updatedRows,
              });
            } catch (error) {
              const failureMessage = `${currentRow}: ${readableImportError(error)}`;
              updateJob({
                processedRows: importJob.processedRows + 1,
                skippedRows: importJob.skippedRows + 1,
                failedRows: importJob.failedRows + 1,
                message: failureMessage,
              });
              await recordFailure("IMPORT ATTENDANCE", currentRow, failureMessage);
              updateJobStep("Attendance", {
                processed: importJob.processedRows,
                skipped: importJob.skippedRows,
                failed: importJob.failedRows,
                message: failureMessage,
              });
            }
            if (Date.now() - lastHangingLogAt > 30_000) {
              lastHangingLogAt = Date.now();
              await logStep("IMPORT ATTENDANCE PROGRESS", "started", {
                sourceRows: attendanceRows.length,
                importedRows: importJob.importedRows,
                updatedRows: importJob.updatedRows,
                skippedRows: importJob.skippedRows,
                failedRows: importJob.failedRows,
                message: `Current attendance row ${currentRow}; processed ${importJob.processedRows}/${attendanceRows.length}; mappedLabourId ${labourerId}; mappedSeasonId ${maps.seasons.get(seasonRef(source)) ?? "fallback"}.`,
              });
            }
          }
          const elapsedSeconds = Math.round((Date.now() - batchStartedAt) / 100) / 10;
          const batchLog: ImportLogEntry = {
            step: "IMPORT ATTENDANCE BATCH",
            status: "completed",
            createdAt: new Date().toISOString(),
            sourceRows: attendanceRows.length,
            importedRows: importJob.importedRows,
            updatedRows: importJob.updatedRows,
            skippedRows: importJob.skippedRows,
            failedRows: importJob.failedRows,
            message: `Attendance batch ${batchNumber}/${importJob.totalBatches} completed in ${elapsedSeconds}s. Processed ${importJob.processedRows}/${attendanceRows.length}.`,
          };
          importJob.logs = [...importJob.logs.slice(-79), batchLog];
          updateJobStep("Attendance", {
            batch: batchNumber,
            batchTotal: importJob.totalBatches,
            processed: importJob.processedRows,
            imported: importJob.importedRows,
            updated: importJob.updatedRows,
            skipped: importJob.skippedRows,
            failed: importJob.failedRows,
            message: batchLog.message,
          });
          await logStep(batchLog.step, batchLog.status, batchLog);
        }
        const completedAt = new Date().toISOString();
        updateJob({
          status: importJob.failedRows ? "failed" : "completed",
          currentStep: "IMPORT ATTENDANCE completed",
          completedAt,
          message: importJob.failedRows
            ? `Attendance import completed with ${importJob.failedRows} failed/skipped rows.`
            : "Import Complete",
        });
        const finalLog: ImportLogEntry = {
          step: "IMPORT ATTENDANCE",
          status: importJob.failedRows ? "failed" : "completed",
          createdAt: completedAt,
          sourceRows: attendanceRows.length,
          importedRows: importJob.importedRows,
          updatedRows: importJob.updatedRows,
          skippedRows: importJob.skippedRows,
          failedRows: importJob.failedRows,
          message: importJob.message,
        };
        updateJobStep("Attendance", {
          status: importJob.failedRows ? "failed" : "completed",
          imported: importJob.importedRows,
          updated: importJob.updatedRows,
          skipped: importJob.skippedRows,
          failed: importJob.failedRows,
          processed: importJob.processedRows,
          completedAt,
          message: finalLog.message,
        });
        importJob.logs = [...importJob.logs.slice(-79), finalLog];
        await logStep(finalLog.step, finalLog.status, finalLog);
      };
      void runAttendanceJob().catch(async (error) => {
        const message = error instanceof Error ? error.message : "Unknown attendance import failure.";
        updateJob({ status: "failed", currentStep: "IMPORT ATTENDANCE failed", completedAt: new Date().toISOString(), message, error: message, stack: error instanceof Error ? error.stack : undefined });
        await recordFailure("IMPORT ATTENDANCE", importJob.currentRow, message);
        updateJobStep("Attendance", { status: "failed", completedAt: new Date().toISOString(), message });
        await logStep("IMPORT ATTENDANCE", "failed", {
          sourceRows: attendanceRows.length,
          importedRows: importJob.importedRows,
          updatedRows: importJob.updatedRows,
          skippedRows: importJob.skippedRows,
          failedRows: importJob.failedRows + 1,
          message,
        });
      });
      const assertProcessed = (label: string, sourceRows: number, processedRows: number, skippedRows = 0) => {
        if (sourceRows > 0 && processedRows === 0 && skippedRows === 0) {
          throw new Error(`Schema mismatch or mapping failure: ${label} source count ${sourceRows} but imported/updated 0.`);
        }
      };
      assertProcessed("accounts", asArray(parsed.data.payload, "accounts").length, importedCounts.accounts + updatedAccounts);
      assertProcessed("labours", asArray(parsed.data.payload, "labour").length, importedCounts.labour + updatedLabour);
      assertProcessed("expenses", asArray(parsed.data.payload, "expenses").length, importedCounts.expenses + updatedExpenses);
      assertProcessed("advances", asArray(parsed.data.payload, "advances").length, importedCounts.advances + updatedAdvances, skippedAdvances);
      for (const source of asArray(parsed.data.payload, "sales")) {
        await writeRecord("sale", sourceTypeFor("sales"), source, { date: dateValue(source, ["date", "saleDate"]), buyerName: text(source, ["buyerName", "buyer"], "Imported Buyer"), amount: numberValue(source, ["total", "totalAmount", "amount"]), accountId: maps.accounts.get(accountRef(source)) ?? defaultAccountId });
      }
      const dispatchItemsByParent = new Map<string, AndroidRecord[]>();
      for (const item of asArray(parsed.data.payload, "dispatchItems")) {
        const parentId = relation(item, ["oldDispatchId", "dispatch_id", "dispatchId", "parent_id", "parentId"]);
        dispatchItemsByParent.set(parentId, [...(dispatchItemsByParent.get(parentId) ?? []), item]);
      }
      for (const source of asArray(parsed.data.payload, "dispatches")) {
        await writeRecord("dispatch", sourceTypeFor("dispatches"), source, {
          date: dateValue(source, ["date", "dispatchDate"]),
          vehicleNumber: text(source, ["vehicleNumber", "vehicle", "truck"]),
          serialNumber: text(source, ["serialNumber", "dispatchNumber"], `ANDROID-${oldId(source)}`),
          items: (dispatchItemsByParent.get(oldId(source)) ?? []).map((item) => ({ id: randomUUID(), source_type: sourceTypeFor("dispatchItems"), old_android_id: oldId(item), dateTypeName: text(item, ["dateTypeName", "type", "variety"], "Imported"), cartons: numberValue(item, ["cartons", "quantity", "cartonCount"]) })),
        });
      }
      for (const source of asArray(parsed.data.payload, "settlements")) {
        await writeRecord("partnerEntry", sourceTypeFor("settlements"), source, { date: dateValue(source, ["date"]), type: "settlement", amount: numberValue(source, ["amount"]), notes: text(source, ["notes", "description"]) });
      }
      for (const source of asArray(parsed.data.payload, "partnerTransfers")) {
        await writeRecord("partnerEntry", sourceTypeFor("partnerTransfers"), source, { date: dateValue(source, ["date"]), type: "settlement", amount: numberValue(source, ["amount"]), notes: text(source, ["notes", "description"]) });
      }
      await tx.insert(auditLogs).values({
        workspaceId: parsed.data.workspaceId,
        userId,
        action: "admin.migration_import.completed",
        entityType: "migration_import",
        details: { source: validation.summary.source, exportedAt: validation.summary.exportedAt, insertedOperationalRecords, farmImportStats },
      });
      const completedAt = new Date().toISOString();
      await logStep("IMPORT COMPLETE", "completed", {
        message: attendanceRows.length
          ? `Base import completed. Attendance job ${attendanceJobId} is running in the background.`
          : `Imported ${insertedOperationalRecords} operational records.`,
        importedRows: insertedOperationalRecords,
        failedRows: 0,
      });
      return {
        insertedOperationalRecords,
        importCounts: importCountKeys.map(({ label, key }) => ({ label, key, count: importedCounts[key] })),
        farmImportStats,
        activeFarmId: defaultFarmId,
        activeSeasonId: selectedImportSeasonId,
        attendanceJobId,
        attendanceJob: importJob,
        importBatchId,
        startedAt,
        completedAt,
        currentStep: "IMPORT COMPLETE",
        failedRows: 0,
        logs,
        totalExpenses: validation.summary.totalExpenses,
        totalAdvances: validation.summary.totalAdvances,
        postImportAudit: {
          expectedCounts: {
            labour: asArray(parsed.data.payload, "labour").length,
            accounts: asArray(parsed.data.payload, "accounts").length,
            partners: asArray(parsed.data.payload, "partners").length,
            expenses: asArray(parsed.data.payload, "expenses").length,
            expenseItems: asArray(parsed.data.payload, "expenseItems").length,
            advances: asArray(parsed.data.payload, "advances").length,
            attendance: asArray(parsed.data.payload, "attendance").length,
            sales: asArray(parsed.data.payload, "sales").length,
            dispatches: asArray(parsed.data.payload, "dispatches").length,
          },
          tableCounts: {
            farms: maps.farms.size,
            seasons: maps.seasons.size,
            importFailures: 0,
            failedOrPartialBatches: 0,
          },
        duplicateAccountAudit: {
          totalGroups: 0,
          groups: [],
        },
        operationalRecordsByEntity: [],
        voucherNumberAudit: {
          sourceTotal: 0,
          importedTotal: 0,
          missingSourceVoucherNumbers: 0,
          missingStoredVoucherNumbers: 0,
          mismatches: [],
          duplicateImportedVoucherNumbers: [],
        },
        relationshipAudit: {
            attendanceTotal: 0,
            attendanceLinkedToLabour: 0,
            attendanceMissingLabour: 0,
            advancesTotal: 0,
            advancesLinkedToLabour: 0,
            advancesMissingLabour: 0,
            advancesLinkedToAccount: 0,
            advancesMissingAccount: 0,
            vouchersTotal: 0,
            vouchersLinkedToPaymentAccount: 0,
            vouchersMissingPaymentAccount: 0,
            vouchersWithMultipleItems: 0,
            voucherItemsStored: 0,
            vouchersWithItemMismatch: 0,
          },
        },
      } satisfies ImportResult;
      })(db);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown import failure.";
      updateJob({ status: "failed", currentStep, completedAt: new Date().toISOString(), message, error: message, stack: error instanceof Error ? error.stack : undefined });
      await recordFailure(currentStep, null, message);
      await logStep(currentStep, "failed", { message, failedRows: 1 });
      return reply.code(500).send({ message: `${currentStep} failed: ${message}`, issues: validation.issues, summary: validation.summary, logs });
    }

    result.postImportAudit = await buildPostImportAudit(
      parsed.data.workspaceId,
      result.importBatchId,
      fileHash,
      parsed.data.payload,
    );

    if (result.postImportAudit.duplicateAccountAudit.totalGroups > 0) {
      const duplicateSummary = result.postImportAudit.duplicateAccountAudit.groups
        .slice(0, 5)
        .map((group) => `${group.normalizedName || group.logicalKey} (${group.normalizedType}) x${group.count}`)
        .join(", ");
      return reply.code(500).send({
        message: `Import audit failed: duplicate logical imported accounts detected after import. ${duplicateSummary}`,
        issues: validation.issues,
        summary: validation.summary,
        result,
      });
    }

    return {
      ...validation,
      imported: true,
      dryRun: false,
      message: result.attendanceJob?.status === "running"
        ? "Import is still running. Attendance is processing in the background."
        : "Migration imported successfully.",
      result,
    };
  };

  app.post("/v1/admin/migration-import/import", { preHandler: requirePermission("CREATE_WORKSPACE"), bodyLimit: 50 * 1024 * 1024 }, handleMigrationImport);
  app.post("/v1/admin/migration-import/imports/start", { preHandler: requirePermission("CREATE_WORKSPACE"), bodyLimit: 50 * 1024 * 1024 }, handleMigrationImport);
  app.post("/v1/admin/migration-imports/start", { preHandler: requirePermission("CREATE_WORKSPACE"), bodyLimit: 50 * 1024 * 1024 }, handleMigrationImport);

  app.post("/v1/admin/migration-import/retry-attendance", { preHandler: requirePermission("CREATE_WORKSPACE") }, async (request, reply) => {
    const parsed = batchActionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "A workspaceId and batchId are required." });
    const [batch] = await db.select().from(importBatches).where(and(
      eq(importBatches.id, parsed.data.batchId),
      eq(importBatches.workspaceId, parsed.data.workspaceId),
    )).limit(1);
    if (!batch) return reply.code(404).send({ message: "Import batch not found." });
    if (!batch.payloadJson || typeof batch.payloadJson !== "object") return reply.code(400).send({ message: "This import batch does not have retry payload data." });
    const runningJob = attendanceImportJobs.get(batch.id);
    if (runningJob && (runningJob.status === "queued" || runningJob.status === "running")) return { job: runningJob };

    const payload = batch.payloadJson as AndroidPayload;
    const maps = await buildScopedMapsFromDb(parsed.data.workspaceId);
    const importedFarmIds = [...maps.farms.values()];
    const importedSeasonRows = await db.select().from(seasons).where(and(eq(seasons.workspaceId, parsed.data.workspaceId), inArray(seasons.id, [...maps.seasons.values()])));
    const farmBySeason = new Map(importedSeasonRows.map((row) => [row.id, row.farmId]));
    const seasonByFarm = new Map(importedSeasonRows.map((row) => [row.farmId, row.id]));
    const defaultFarmId = importedFarmIds[0];
    const defaultSeasonId = importedSeasonRows[0]?.id;
    if (!defaultFarmId || !defaultSeasonId) return reply.code(400).send({ message: "Retry requires imported farm and season mappings." });

    const attendanceRows = asArray(payload, "attendance");
    const job: AttendanceImportJobStatus = {
      jobId: batch.id,
      importBatchId: batch.id,
      workspaceId: parsed.data.workspaceId,
      status: "running",
      currentStep: "IMPORT ATTENDANCE",
      sourceRows: attendanceRows.length,
      totalBatches: Math.ceil(attendanceRows.length / 100),
      currentBatch: 0,
      processedRows: 0,
      importedRows: 0,
      updatedRows: 0,
      skippedRows: 0,
      failedRows: 0,
      startedAt: new Date().toISOString(),
      lastProgressAt: new Date().toISOString(),
      completedAt: undefined,
      currentRow: undefined,
      steps: importStepOrder.map((name) => ({
        name,
        status: name === "Attendance" ? "running" : "completed",
        source: name === "Attendance" ? attendanceRows.length : 0,
        imported: 0,
        updated: 0,
        skipped: 0,
        failed: 0,
        processed: 0,
        total: name === "Attendance" ? attendanceRows.length : 0,
        batchTotal: name === "Attendance" ? Math.ceil(attendanceRows.length / 100) : undefined,
        startedAt: new Date().toISOString(),
        message: name === "Attendance" ? "Retrying attendance only." : "Already imported.",
      })) as ImportJobStep[],
      logs: [],
      message: "Retrying attendance only.",
    };
    attendanceImportJobs.set(job.jobId, job);
    await db.update(importBatches).set({
      status: "running",
      completedAt: null,
      summaryJson: { ...(batch.summaryJson && typeof batch.summaryJson === "object" ? batch.summaryJson : {}), job, steps: job.steps },
      errorJson: null,
      updatedAt: new Date(),
    }).where(eq(importBatches.id, batch.id));

    const fileHash = batch.fileHash;
    const resolveLabourId = (source: AndroidRecord) => maps.labour.get(labourRef(source))
      ?? undefined;
    const updateJob = async () => {
      await db.update(importBatches).set({
        status: job.status,
        completedAt: job.completedAt ? new Date(job.completedAt) : null,
        summaryJson: { ...(batch.summaryJson && typeof batch.summaryJson === "object" ? batch.summaryJson : {}), job, steps: job.steps },
        errorJson: job.status === "failed" ? { message: job.message } : null,
        updatedAt: new Date(),
      }).where(eq(importBatches.id, batch.id));
      attendanceImportJobs.set(job.jobId, job);
    };

    void (async () => {
      for (const [batchIndex, rows] of chunks(attendanceRows, 100).entries()) {
        job.currentBatch = batchIndex + 1;
        job.currentStep = `Attendance batch ${job.currentBatch}/${job.totalBatches}`;
        const attendanceStep = job.steps.find((step) => step.name === "Attendance");
        if (attendanceStep) {
          attendanceStep.batch = job.currentBatch;
          attendanceStep.message = job.currentStep;
        }
        await updateJob();
        for (const source of rows) {
          const androidId = oldId(source);
          const labourerId = resolveLabourId(source);
          job.currentRow = androidId;
          if (!labourerId) {
            job.processedRows += 1;
            job.skippedRows += 1;
            job.failedRows += 1;
            if (attendanceStep) {
              attendanceStep.processed = job.processedRows;
              attendanceStep.skipped = job.skippedRows;
              attendanceStep.failed = job.failedRows;
              attendanceStep.message = `${androidId}: missing mapped labour`;
            }
            continue;
          }
          const targetSeasonId = maps.seasons.get(seasonRef(source)) ?? seasonByFarm.get(maps.farms.get(farmRef(source)) ?? defaultFarmId) ?? defaultSeasonId;
          const targetFarmId = farmBySeason.get(targetSeasonId) ?? maps.farms.get(farmRef(source)) ?? defaultFarmId;
          const payloadRecord = operationalRecord("attendance", source, sourceTypeFor("attendance"), maps, { farmId: targetFarmId, seasonId: targetSeasonId }, {
            date: dateValue(source, ["date", "attendanceDate", "day"]),
            labourerId,
            labourId: labourerId,
            workerId: labourerId,
            status: attendanceStatus(source),
            remarks: text(source, ["remarks", "notes"]),
            oldFarmId: farmRef(source),
            oldSeasonId: seasonRef(source),
            oldLabourId: labourRef(source),
          });
          const nextPayload = {
            ...(payloadRecord.payload as Record<string, unknown>),
            old_android_id: androidId,
          };
          const [existing] = await db.select({ id: operationalRecords.id }).from(operationalRecords).where(and(
            eq(operationalRecords.workspaceId, parsed.data.workspaceId),
            eq(operationalRecords.entityType, "attendance"),
            eq(operationalRecords.sourceFileHash, fileHash),
            or(
              and(eq(operationalRecords.sourceType, sourceTypeFor("attendance")), eq(operationalRecords.oldAndroidId, androidId)),
              and(sql`${operationalRecords.payload}->>'source_type' = ${sourceTypeFor("attendance")}`, sql`${operationalRecords.payload}->>'old_android_id' = ${androidId}`),
            ),
            or(
              sql`${operationalRecords.farmId} IS NULL`,
              sql`EXISTS (
                SELECT 1
                FROM farms f
                WHERE f.id = ${operationalRecords.farmId}
                  AND f.workspace_id = ${operationalRecords.workspaceId}
                  AND f.deleted_at IS NULL
                  AND f.active = true
              )`,
            ),
            or(
              sql`${operationalRecords.seasonId} IS NULL`,
              sql`EXISTS (
                SELECT 1
                FROM seasons s
                JOIN farms f ON f.id = s.farm_id AND f.workspace_id = s.workspace_id
                WHERE s.id = ${operationalRecords.seasonId}
                  AND s.workspace_id = ${operationalRecords.workspaceId}
                  AND s.active = true
                  AND s.status <> 'archived'
                  AND f.deleted_at IS NULL
                  AND f.active = true
              )`,
            ),
          )).limit(1);
          if (existing) {
            await db.update(operationalRecords).set({
              farmId: targetFarmId,
              seasonId: targetSeasonId,
              sourceType: sourceTypeFor("attendance"),
              oldAndroidId: androidId,
              importBatchId: batch.id,
              sourceFileHash: fileHash,
              payload: nextPayload,
              clientUpdatedAt: payloadRecord.clientUpdatedAt,
              updatedAt: payloadRecord.updatedAt,
            }).where(eq(operationalRecords.id, existing.id));
            job.updatedRows += 1;
          } else {
            await db.insert(operationalRecords).values({
              ...payloadRecord,
              workspaceId: parsed.data.workspaceId,
              recordedBy: request.appUser!.id,
              clientRecordId: `android:${fileHash}:${sourceTypeFor("attendance")}:${androidId}`,
              sourceType: sourceTypeFor("attendance"),
              oldAndroidId: androidId,
              importBatchId: batch.id,
              sourceFileHash: fileHash,
              payload: { ...nextPayload, id: `android:${fileHash}:${sourceTypeFor("attendance")}:${androidId}`, clientRecordId: `android:${fileHash}:${sourceTypeFor("attendance")}:${androidId}` },
            });
            job.importedRows += 1;
          }
          job.processedRows += 1;
          if (attendanceStep) {
            attendanceStep.processed = job.processedRows;
            attendanceStep.imported = job.importedRows;
            attendanceStep.updated = job.updatedRows;
            attendanceStep.skipped = job.skippedRows;
            attendanceStep.failed = job.failedRows;
            attendanceStep.message = `Processed ${job.processedRows}/${attendanceRows.length}`;
          }
        }
        await updateJob();
      }
      job.status = job.failedRows ? "partial_failed" : "completed";
      job.currentStep = "IMPORT ATTENDANCE completed";
      job.completedAt = new Date().toISOString();
      const attendanceStep = job.steps.find((step) => step.name === "Attendance");
      if (attendanceStep) {
        attendanceStep.status = job.failedRows ? "failed" : "completed";
        attendanceStep.completedAt = job.completedAt;
        attendanceStep.message = job.failedRows ? `${job.failedRows} rows failed/skipped.` : "Attendance retry completed.";
      }
      await db.update(importBatches).set({
        status: job.failedRows ? "partial_failed" : "completed",
        completedAt: new Date(job.completedAt),
        summaryJson: { ...(batch.summaryJson && typeof batch.summaryJson === "object" ? batch.summaryJson : {}), job, steps: job.steps },
        errorJson: job.failedRows ? { failedRows: job.failedRows, message: "Attendance retry completed with warnings." } : null,
        updatedAt: new Date(),
      }).where(eq(importBatches.id, batch.id));
      attendanceImportJobs.set(job.jobId, job);
    })().catch(async (error) => {
      job.status = "failed";
      job.currentStep = "IMPORT ATTENDANCE failed";
      job.completedAt = new Date().toISOString();
      job.message = error instanceof Error ? error.message : "Attendance retry failed.";
      await db.update(importBatches).set({
        status: "failed",
        completedAt: new Date(job.completedAt),
        summaryJson: { ...(batch.summaryJson && typeof batch.summaryJson === "object" ? batch.summaryJson : {}), job, steps: job.steps },
        errorJson: { message: job.message },
        updatedAt: new Date(),
      }).where(eq(importBatches.id, batch.id));
      attendanceImportJobs.set(job.jobId, job);
    });

    return { job };
  });

  app.post("/v1/admin/migration-import/rollback", { preHandler: requirePermission("CREATE_WORKSPACE") }, async (request, reply) => {
    const parsed = batchActionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "A workspaceId and batchId are required." });
    const [batch] = await db.select().from(importBatches).where(and(eq(importBatches.id, parsed.data.batchId), eq(importBatches.workspaceId, parsed.data.workspaceId))).limit(1);
    if (!batch) return reply.code(404).send({ message: "Import batch not found." });
    const result = await db.transaction(async (tx) => {
      const deletedOperational = await tx.delete(operationalRecords).where(and(
        eq(operationalRecords.workspaceId, parsed.data.workspaceId),
        eq(operationalRecords.importBatchId, parsed.data.batchId),
      )).returning({ id: operationalRecords.id });
      const deletedSeasons = await tx.delete(seasons).where(and(
        eq(seasons.workspaceId, parsed.data.workspaceId),
        eq(seasons.importBatchId, parsed.data.batchId),
      )).returning({ id: seasons.id });
      const deletedFarms = await tx.delete(farms).where(and(
        eq(farms.workspaceId, parsed.data.workspaceId),
        eq(farms.importBatchId, parsed.data.batchId),
      )).returning({ id: farms.id });
      await tx.update(importBatches).set({
        status: "rolled_back",
        completedAt: new Date(),
        errorJson: null,
        updatedAt: new Date(),
      }).where(eq(importBatches.id, parsed.data.batchId));
      return {
        operationalRecords: deletedOperational.length,
        seasons: deletedSeasons.length,
        farms: deletedFarms.length,
      };
    });
    return { message: "Import batch rolled back.", result };
  });

  app.post("/v1/admin/migration-import/cleanup-failed", { preHandler: requirePermission("CREATE_WORKSPACE") }, async (request, reply) => {
    const parsed = cleanupActionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        message: "Backup confirmation and exact cleanup confirmation are required.",
      });
    }
    const preview = await cleanupPreview(parsed.data.workspaceId, parsed.data.batchId);
    if (!preview) return reply.code(404).send({ message: "Import batch not found." });
    if (preview.editedImportedRecords > 0 && !parsed.data.includeEditedImportedRecords) {
      return reply.code(409).send({
        message: `Cleanup found ${preview.editedImportedRecords} imported records that were later edited. Confirm edited-record cleanup explicitly before removing them.`,
      });
    }

    const target = await loadCleanupTarget(parsed.data.workspaceId, parsed.data.batchId);
    if (!target) return reply.code(404).send({ message: "Import batch not found." });

    const result = await db.transaction(async (tx) => {
      const importedOperationalFilter = sql`
        workspace_id = ${parsed.data.workspaceId}
        AND (
          import_batch_id = ${parsed.data.batchId}
          OR source_file_hash = ${target.fileHash}
          OR source_type = 'muzare_android'
        )
        ${parsed.data.includeEditedImportedRecords
          ? sql``
          : sql`AND updated_at <= created_at + interval '1 second'`}
      `;

      const deletedOperational = await tx.execute(sql`
        WITH deleted AS (
          DELETE FROM operational_records
          WHERE ${importedOperationalFilter}
          RETURNING id
        )
        SELECT count(*)::int AS count FROM deleted
      `);

      const deletedFailures = await tx.execute(sql`
        WITH deleted AS (
          DELETE FROM import_failures f
          USING import_batches b
          WHERE b.id = f.import_batch_id
            AND b.workspace_id = ${parsed.data.workspaceId}
            AND (b.id = ${parsed.data.batchId} OR b.file_hash = ${target.fileHash} OR b.source = 'muzare_android')
          RETURNING f.id
        )
        SELECT count(*)::int AS count FROM deleted
      `);

      const deletedBatches = await tx.execute(sql`
        WITH deleted AS (
          DELETE FROM import_batches
          WHERE workspace_id = ${parsed.data.workspaceId}
            AND (id = ${parsed.data.batchId} OR file_hash = ${target.fileHash} OR source = 'muzare_android')
          RETURNING id
        )
        SELECT count(*)::int AS count FROM deleted
      `);

      const deletedSeasons = await tx.execute(sql`
        WITH candidate_seasons AS (
          SELECT s.id
          FROM seasons s
          WHERE s.workspace_id = ${parsed.data.workspaceId}
            AND (
              s.import_batch_id = ${parsed.data.batchId}
              OR s.source_file_hash = ${target.fileHash}
              OR s.source_type = 'season'
            )
            AND NOT EXISTS (
              SELECT 1
              FROM operational_records r
              WHERE r.workspace_id = s.workspace_id
                AND r.season_id = s.id
            )
        ),
        deleted AS (
          DELETE FROM seasons s
          USING candidate_seasons c
          WHERE s.id = c.id
          RETURNING s.id
        )
        SELECT count(*)::int AS count FROM deleted
      `);

      const candidateFarmIdsResult = await tx.execute(sql`
        SELECT f.id
        FROM farms f
        WHERE f.workspace_id = ${parsed.data.workspaceId}
          AND (
            f.import_batch_id = ${parsed.data.batchId}
            OR f.source_file_hash = ${target.fileHash}
            OR (f.source_type = 'farm' AND f.old_android_id IS NOT NULL)
          )
      `);
      const candidateFarmIds = candidateFarmIdsResult.rows
        .map((row) => String((row as Record<string, unknown>).id ?? ""))
        .filter(Boolean);

      const detachedAuditLogRows = candidateFarmIds.length
        ? await tx.update(auditLogs)
          .set({ farmId: null })
          .where(and(
            eq(auditLogs.workspaceId, parsed.data.workspaceId),
            inArray(auditLogs.farmId, candidateFarmIds),
          ))
          .returning({ id: auditLogs.id })
        : [];
      const detachedAuditLogs = detachedAuditLogRows.length;

      const farmDeletionRequestsRows = candidateFarmIds.length
        ? await tx.select({ id: sql<string>`cast(${farms.id} as text)` })
          .from(farmDeletionRequests)
          .innerJoin(farms, eq(farms.id, farmDeletionRequests.farmId))
          .where(and(
            eq(farmDeletionRequests.workspaceId, parsed.data.workspaceId),
            inArray(farmDeletionRequests.farmId, candidateFarmIds),
          ))
        : [];
      const farmDeletionRequestsCount = farmDeletionRequestsRows.length;

      const candidateFarmsWithoutPrimaryRefs = candidateFarmIds.length
        ? await tx.select({ id: farms.id })
          .from(farms)
          .where(and(
            inArray(farms.id, candidateFarmIds),
            sql`NOT EXISTS (
              SELECT 1 FROM operational_records r
              WHERE r.workspace_id = ${farms.workspaceId}
                AND r.farm_id = ${farms.id}
            )`,
            sql`NOT EXISTS (
              SELECT 1 FROM seasons s
              WHERE s.workspace_id = ${farms.workspaceId}
                AND s.farm_id = ${farms.id}
            )`,
            sql`NOT EXISTS (
              SELECT 1 FROM farm_deletion_requests fdr
              WHERE fdr.workspace_id = ${farms.workspaceId}
                AND fdr.farm_id = ${farms.id}
            )`,
          ))
        : [];
      const hardDeleteCandidateIds = candidateFarmsWithoutPrimaryRefs.map((row) => row.id);

      let hardDeletedFarms = 0;
      let softDeletedFarms = 0;
      let skippedFarms = 0;
      let cleanupFarmMessage: string | null = null;

      if (hardDeleteCandidateIds.length) {
        try {
          const deletedFarms = await tx.delete(farms)
            .where(inArray(farms.id, hardDeleteCandidateIds))
            .returning({ id: farms.id });
          hardDeletedFarms = deletedFarms.length;
        } catch (error) {
          const readable = readableImportError(error);
          cleanupFarmMessage = "Cleanup could not hard-delete imported farms because references remain. Farms were soft-deleted instead.";
          console.warn("CLEANUP_FAILED_IMPORT_FARM_HARD_DELETE_BLOCKED", {
            workspaceId: parsed.data.workspaceId,
            batchId: parsed.data.batchId,
            reason: readable,
          });
        }
      }

      const remainingFarmIds = candidateFarmIds.filter((id) => !hardDeleteCandidateIds.includes(id));
      const fallbackSoftDeleteIds = cleanupFarmMessage ? candidateFarmIds : remainingFarmIds;
      if (fallbackSoftDeleteIds.length) {
        const existingSoftDeleteRows = await tx.select({ id: farms.id, remarks: farms.remarks })
          .from(farms)
          .where(inArray(farms.id, fallbackSoftDeleteIds));
        const softDeleteRemark = "Cleanup soft-delete after failed Android import.";
        for (const farm of existingSoftDeleteRows) {
          await tx.update(farms).set({
            active: false,
            deletedAt: new Date(),
            remarks: !farm.remarks || farm.remarks === ""
              ? softDeleteRemark
              : farm.remarks.includes(softDeleteRemark)
                ? farm.remarks
                : `${farm.remarks} | ${softDeleteRemark}`,
            updatedAt: new Date(),
          }).where(eq(farms.id, farm.id));
        }
        softDeletedFarms = existingSoftDeleteRows.length;
      }
      if (candidateFarmIds.length) {
        await tx.update(seasons).set({
          active: false,
          status: "archived",
          closed: true,
          updatedAt: new Date(),
        }).where(and(
          eq(seasons.workspaceId, parsed.data.workspaceId),
          inArray(seasons.farmId, candidateFarmIds),
        ));
      }
      skippedFarms = Math.max(candidateFarmIds.length - hardDeletedFarms - softDeletedFarms, 0);

      await tx.execute(sql`
        UPDATE user_sessions us
        SET active_farm_id = NULL,
            active_season_id = NULL
        WHERE us.workspace_id = ${parsed.data.workspaceId}
          AND (
            (us.active_farm_id IS NOT NULL AND NOT EXISTS (
              SELECT 1
              FROM farms f
              WHERE f.id = us.active_farm_id
                AND f.workspace_id = us.workspace_id
                AND f.deleted_at IS NULL
                AND f.active = true
            ))
            OR
            (us.active_season_id IS NOT NULL AND NOT EXISTS (
              SELECT 1
              FROM seasons s
              JOIN farms f ON f.id = s.farm_id AND f.workspace_id = s.workspace_id
              WHERE s.id = us.active_season_id
                AND s.workspace_id = us.workspace_id
                AND s.active = true
                AND s.status <> 'archived'
                AND f.deleted_at IS NULL
                AND f.active = true
            ))
          )
      `);

      await tx.insert(auditLogs).values({
        workspaceId: parsed.data.workspaceId,
        userId: request.appUser?.id,
        actorUserId: request.appUser?.id,
        action: "admin.migration_import.cleanup_failed",
        entityType: "migration_import",
        entityId: parsed.data.batchId,
        details: {
          batchId: parsed.data.batchId,
          fileHash: target.fileHash,
          backupConfirmed: parsed.data.backupConfirmed,
          includeEditedImportedRecords: parsed.data.includeEditedImportedRecords,
          deletedOperationalRecords: Number((deletedOperational.rows[0] as Record<string, unknown> | undefined)?.count ?? 0),
          deletedImportFailures: Number((deletedFailures.rows[0] as Record<string, unknown> | undefined)?.count ?? 0),
          deletedImportBatches: Number((deletedBatches.rows[0] as Record<string, unknown> | undefined)?.count ?? 0),
          deletedSeasons: Number((deletedSeasons.rows[0] as Record<string, unknown> | undefined)?.count ?? 0),
          detachedAuditLogs,
          farmDeletionRequestsRemaining: farmDeletionRequestsCount,
          hardDeletedFarms,
          softDeletedFarms,
          skippedFarms,
          cleanupFarmMessage,
        },
      });

      return {
        operationalRecords: Number((deletedOperational.rows[0] as Record<string, unknown> | undefined)?.count ?? 0),
        importFailures: Number((deletedFailures.rows[0] as Record<string, unknown> | undefined)?.count ?? 0),
        importBatches: Number((deletedBatches.rows[0] as Record<string, unknown> | undefined)?.count ?? 0),
        seasons: Number((deletedSeasons.rows[0] as Record<string, unknown> | undefined)?.count ?? 0),
        farmsHardDeleted: hardDeletedFarms,
        farmsSoftDeleted: softDeletedFarms,
        auditLogsDetached: detachedAuditLogs,
        skippedFarms,
        farmCleanupMessage: cleanupFarmMessage,
      };
    });

    let contextRepair: { activeFarmId: string | null; activeSeasonId: string | null; message: string } | null = null;
    try {
      await repairDeletedFarmSeasonState(parsed.data.workspaceId);
      contextRepair = await repairWorkspaceContext(parsed.data.workspaceId, request.appUser!.id, request.sessionId);
    } catch {
      contextRepair = null;
    }

    return {
      message: result.farmCleanupMessage
        ?? "Failed Android import dump data was cleaned. Repair workspace context next if needed.",
      result: {
        ...result,
        activeFarmId: contextRepair?.activeFarmId ?? null,
        activeSeasonId: contextRepair?.activeSeasonId ?? null,
        contextMessage: contextRepair?.message ?? null,
      },
    };
  });

  app.post("/v1/admin/migration-import/mark-closed", { preHandler: requirePermission("CREATE_WORKSPACE") }, async (request, reply) => {
    const parsed = batchActionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "A workspaceId and batchId are required." });
    await db.update(importBatches).set({
      status: "partial_failed",
      completedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(eq(importBatches.id, parsed.data.batchId), eq(importBatches.workspaceId, parsed.data.workspaceId)));
    return { message: "Failed import batch marked closed." };
  });

  app.post("/v1/admin/migration-import/repair-visibility", { preHandler: requirePermission("CREATE_WORKSPACE") }, async (request, reply) => {
    const parsed = repairSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "A workspaceId is required." });
    if (localDevelopmentMode) return { repairedRecords: 0, message: "Local memory mode cannot repair imported visibility. Configure a dev database first." };

    const userId = request.appUser?.id;
    if (!userId) return reply.code(403).send({ message: "Admin user is required." });
    const [workspace] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, parsed.data.workspaceId)).limit(1);
    if (!workspace) return reply.code(404).send({ message: "Workspace not found." });

    await repairDeletedFarmSeasonState(parsed.data.workspaceId);

    const result = await db.transaction(async (tx) => {
      const [importedFarm] = await tx.select({ id: farms.id, name: farms.name }).from(farms).where(and(
        eq(farms.workspaceId, parsed.data.workspaceId),
        eq(farms.sourceType, "farm"),
        sql`${farms.deletedAt} IS NULL`,
      )).limit(1);
      if (!importedFarm) return null;

      await tx.update(farms).set({ active: true, updatedAt: new Date() }).where(eq(farms.id, importedFarm.id));

      const [existingSeason] = await tx.select({ id: seasons.id, name: seasons.name }).from(seasons).where(and(
        eq(seasons.workspaceId, parsed.data.workspaceId),
        eq(seasons.farmId, importedFarm.id),
        eq(seasons.status, "active"),
        eq(seasons.active, true),
      )).limit(1);
      const importYear = new Date().getFullYear();
      let activeSeason = existingSeason;
      if (!activeSeason) {
        const fallbackSeasonId = randomUUID();
        activeSeason = { id: fallbackSeasonId, name: `Imported Season ${importYear}` };
        await tx.insert(seasons).values({
          id: fallbackSeasonId,
          workspaceId: parsed.data.workspaceId,
          farmId: importedFarm.id,
          name: activeSeason.name,
          year: importYear,
          startsOn: `${importYear}-01-01`,
          status: "active",
          notes: `source_type:season;old_android_id:repair:${importedFarm.id}`,
          active: true,
          createdBy: userId,
        });
      }

      const brokenCountResult = await tx.execute(sql`
        SELECT count(*)::int AS count
        FROM operational_records r
        WHERE r.workspace_id = ${parsed.data.workspaceId}
          AND r.payload ? 'source_type'
          AND (
            r.farm_id IS NULL
            OR r.season_id IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM farms f
              WHERE f.id = r.farm_id
                AND f.workspace_id = r.workspace_id
                AND f.deleted_at IS NULL
            )
            OR NOT EXISTS (
              SELECT 1 FROM seasons s
              WHERE s.id = r.season_id
                AND s.workspace_id = r.workspace_id
                AND s.farm_id = r.farm_id
                AND s.status = 'active'
            )
          )
      `);
      const repairedRecords = Number((brokenCountResult.rows[0] as Record<string, unknown> | undefined)?.count ?? 0);

      await tx.execute(sql`
        UPDATE operational_records r
        SET farm_id = ${importedFarm.id},
            season_id = ${activeSeason.id},
            updated_at = now()
        WHERE r.workspace_id = ${parsed.data.workspaceId}
          AND r.payload ? 'source_type'
          AND (
            r.farm_id IS NULL
            OR r.season_id IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM farms f
              WHERE f.id = r.farm_id
                AND f.workspace_id = r.workspace_id
                AND f.deleted_at IS NULL
            )
            OR NOT EXISTS (
              SELECT 1 FROM seasons s
              WHERE s.id = r.season_id
                AND s.workspace_id = r.workspace_id
                AND s.farm_id = r.farm_id
                AND s.status = 'active'
            )
          )
      `);

      await tx.update(userSessions).set({
        activeFarmId: importedFarm.id,
        activeSeasonId: activeSeason.id,
      }).where(eq(userSessions.workspaceId, parsed.data.workspaceId));

      await tx.insert(auditLogs).values({
        workspaceId: parsed.data.workspaceId,
        userId,
        action: "admin.migration_import.visibility_repaired",
        entityType: "migration_import",
        details: { farmId: importedFarm.id, seasonId: activeSeason.id, repairedRecords },
      });

      return {
        repairedRecords,
        activeFarmId: importedFarm.id,
        activeSeasonId: activeSeason.id,
        activeFarmName: importedFarm.name,
        activeSeasonName: activeSeason.name,
      };
    });

    if (!result) return reply.code(404).send({ message: "No imported farm was found for this workspace." });
    return { ...result, message: "Imported farm and season are active. Imported records with missing or invalid season links were repaired." };
  });

  app.post("/v1/admin/migration-import/repair-deleted-state", { preHandler: requirePermission("CREATE_WORKSPACE") }, async (request, reply) => {
    const parsed = repairSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "A workspaceId is required." });
    if (localDevelopmentMode) return { message: "Local memory mode cannot repair deleted farm/season state. Configure a dev database first." };

    const userId = request.appUser?.id;
    if (!userId) return reply.code(403).send({ message: "Admin user is required." });

    const cleanup = await repairDeletedFarmSeasonState(parsed.data.workspaceId);
    const context = await repairWorkspaceContext(parsed.data.workspaceId, userId, request.sessionId);

    await db.insert(auditLogs).values({
      workspaceId: parsed.data.workspaceId,
      userId,
      actorUserId: userId,
      action: "admin.migration_import.repair_deleted_state",
      entityType: "migration_import",
      details: {
        farmsDeactivated: cleanup.farmsDeactivated,
        seasonsDeactivated: cleanup.seasonsDeactivated,
        sessionsCleared: cleanup.sessionsCleared,
        activeFarmId: context.activeFarmId,
        activeSeasonId: context.activeSeasonId,
      },
    });

    return {
      ...cleanup,
      activeFarmId: context.activeFarmId,
      activeSeasonId: context.activeSeasonId,
      contextWarning: context.contextWarning,
      message: cleanup.farmsDeactivated || cleanup.seasonsDeactivated || cleanup.sessionsCleared
        ? "Deleted farm and season state was repaired."
        : "Deleted farm and season state was already clean.",
    };
  });

  app.post("/v1/admin/migration-import/repair-duplicate-accounts", { preHandler: requirePermission("CREATE_WORKSPACE") }, async (request, reply) => {
    const parsed = repairSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "A workspaceId is required." });
    if (localDevelopmentMode) return { message: "Local memory mode cannot repair duplicate imported accounts. Configure a dev database first." };

    const result = await repairDuplicateImportedAccounts(parsed.data.workspaceId);
    return {
      ...result,
      message: result.duplicateGroupsBefore
        ? "Duplicate imported accounts were repaired."
        : "No duplicate imported accounts were found.",
    };
  });
}
