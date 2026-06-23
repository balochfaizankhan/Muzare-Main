import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { requirePermission } from "../auth.js";
import { localDevelopmentMode } from "../config.js";
import { db } from "../db/client.js";
import { auditLogs, farms, operationalRecords, seasons, userSessions, workspaces } from "../db/schema.js";

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
});
const repairSchema = z.object({ workspaceId: z.string().uuid() });
const historyQuerySchema = z.object({ workspaceId: z.string().uuid() });

type AndroidRecord = Record<string, unknown>;
type AndroidPayload = z.infer<typeof payloadSchema>["payload"];
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
type ImportResult = {
  insertedOperationalRecords: number;
  importCounts: Array<{ label: string; key: ImportCountKey; count: number }>;
  farmImportStats: { created: number; updated: number; skippedDuplicates: number };
  activeFarmId: string;
  activeSeasonId: string;
  importBatchId: string;
  startedAt: string;
  completedAt: string;
  currentStep: string;
  failedRows: number;
  logs: ImportLogEntry[];
  totalExpenses: number;
  totalAdvances: number;
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

function operationalRecord(entity: string, record: AndroidRecord, sourceType: string, maps: ScopedMaps, fallbackScope: { farmId: string; seasonId: string }, extra: Record<string, unknown> = {}) {
  const createdAt = nowIso();
  const id = randomUUID();
  return {
    id,
    workspaceId: "",
    farmId: fallbackScope.farmId,
    seasonId: fallbackScope.seasonId,
    clientRecordId: id as string,
    entityType: entity,
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

  app.post("/v1/admin/migration-import/import", { preHandler: requirePermission("CREATE_WORKSPACE"), bodyLimit: 50 * 1024 * 1024 }, async (request, reply) => {
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

    const importBatchId = randomUUID();
    const startedAt = new Date().toISOString();
    const logs: ImportLogEntry[] = [];
    let currentStep = "START IMPORT";
    const logStep = async (step: string, status: ImportLogEntry["status"], details: Omit<ImportLogEntry, "step" | "status" | "createdAt"> = {}) => {
      currentStep = step;
      const entry = { step, status, createdAt: new Date().toISOString(), ...details };
      logs.push(entry);
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

      await logStep("CREATE FARM", "started");
      for (const [index, source] of asArray(parsed.data.payload, "farms").entries()) {
        const sourceType = sourceTypeFor("farms");
        const androidId = oldId(source);
        const marker = `source_type:${sourceType};old_android_id:${androidId}`;
        const legacyMarker = `old_android_id:${oldId(source)}`;
        const existingMatches = await tx.select({ id: farms.id, name: farms.name, remarks: farms.remarks }).from(farms).where(and(
          eq(farms.workspaceId, parsed.data.workspaceId),
          or(
            and(eq(farms.sourceType, sourceType), eq(farms.oldAndroidId, androidId)),
            eq(farms.remarks, marker),
            eq(farms.remarks, legacyMarker),
          ),
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
      await logStep("CREATE FARM", "completed", { importedRows: importedCounts.farms, failedRows: 0 });
      const importedFarmIds = [...maps.farms.values()];
      const [activeImportedFarm] = await tx.select({ id: farms.id }).from(farms).where(and(
        eq(farms.workspaceId, parsed.data.workspaceId),
        eq(farms.active, true),
        inArray(farms.id, importedFarmIds),
      )).limit(1);
      if (!activeImportedFarm && importedFarmIds[0]) {
        await tx.update(farms).set({ active: true, updatedAt: new Date() }).where(eq(farms.id, importedFarmIds[0]));
      }
      const defaultFarmId = activeImportedFarm?.id ?? importedFarmIds[0]!;
      const seasonByFarm = new Map<string, string>();
      const farmBySeason = new Map<string, string>();
      await logStep("CREATE SEASON", "started");
      for (const source of asArray(parsed.data.payload, "seasons")) {
        const marker = `source_type:${sourceTypeFor("seasons")};old_android_id:${oldId(source)}`;
        const legacyMarker = `old_android_id:${oldId(source)}`;
        const farmId = maps.farms.get(farmRef(source)) ?? defaultFarmId;
        const [existing] = await tx.select({ id: seasons.id }).from(seasons).where(and(
          eq(seasons.workspaceId, parsed.data.workspaceId),
          or(eq(seasons.notes, marker), eq(seasons.notes, legacyMarker)),
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
            notes: marker,
            active: true,
            createdBy: userId,
          });
          importedCounts.seasons += 1;
        } else {
          await tx.update(seasons).set({ farmId, status: "active", active: true, updatedAt: new Date() }).where(eq(seasons.id, existing.id));
        }
      }
      for (const farmId of importedFarmIds) {
        if (seasonByFarm.has(farmId)) continue;
        const marker = `source_type:season;old_android_id:default:${farmId}`;
        const [existingDefaultSeason] = await tx.select({ id: seasons.id }).from(seasons).where(and(
          eq(seasons.workspaceId, parsed.data.workspaceId),
          eq(seasons.farmId, farmId),
          eq(seasons.notes, marker),
        )).limit(1);
        const fallbackSeasonId = existingDefaultSeason?.id ?? randomUUID();
        if (existingDefaultSeason) {
          await tx.update(seasons).set({ status: "active", active: true, updatedAt: new Date() }).where(eq(seasons.id, existingDefaultSeason.id));
        } else {
          await tx.insert(seasons).values({
            id: fallbackSeasonId,
            workspaceId: parsed.data.workspaceId,
            farmId,
            name: `Imported Season ${importYear}`,
            year: importYear,
            startsOn: `${importYear}-01-01`,
            status: "active",
            notes: marker,
            active: true,
            createdBy: userId,
          });
          importedCounts.seasons += 1;
        }
        maps.seasons.set(`default:${farmId}`, fallbackSeasonId);
        seasonByFarm.set(farmId, fallbackSeasonId);
        farmBySeason.set(fallbackSeasonId, farmId);
      }
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

      const writeRecord = async (entity: string, sourceType: string, source: AndroidRecord, extra: Record<string, unknown> = {}) => {
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
        record.payload = { ...recordPayload, old_android_id: androidId } as typeof record.payload;
        record.clientRecordId = `android:${sourceType}:${androidId}`;
        record.workspaceId = parsed.data.workspaceId;
        record.recordedBy = userId;
        const [existing] = await tx.select({ id: operationalRecords.id, payload: operationalRecords.payload }).from(operationalRecords).where(and(
          eq(operationalRecords.workspaceId, parsed.data.workspaceId),
          eq(operationalRecords.entityType, entity),
          sql`${operationalRecords.payload}->>'source_type' = ${sourceType}`,
          sql`${operationalRecords.payload}->>'old_android_id' = ${androidId}`,
        )).limit(1);
        if (existing) {
          const existingPayload = existing.payload && typeof existing.payload === "object" ? existing.payload as Record<string, unknown> : {};
          const nextPayload = { ...existingPayload, ...record.payload, id: payloadId(existing.payload) ?? payloadId(record.payload) ?? randomUUID() };
          await tx.update(operationalRecords).set({
            farmId: record.farmId,
            seasonId: record.seasonId,
            payload: nextPayload,
            clientUpdatedAt: record.clientUpdatedAt,
            updatedAt: record.updatedAt,
          }).where(eq(operationalRecords.id, existing.id));
          return { inserted: false, updated: true, payloadId: payloadId(nextPayload) };
        }
        await tx.insert(operationalRecords).values(record);
        insertedOperationalRecords += 1;
        return { inserted: true, updated: false, payloadId: payloadId(record.payload) };
      };

      await logStep("IMPORT ACCOUNTS", "started");
      let updatedAccounts = 0;
      let updatedPartners = 0;
      for (const source of asArray(parsed.data.payload, "accounts")) {
        const id = randomUUID();
        const result = await writeRecord("account", sourceTypeFor("accounts"), source, { id, name: text(source, ["name", "accountName"], "Imported Account"), type: text(source, ["type", "accountType"], "cash"), openingBalance: numberValue(source, ["openingBalance", "opening_balance"]), active: importedActive(source) });
        maps.accounts.set(oldId(source), result.payloadId ?? id);
        if (result.inserted) importedCounts.accounts += 1;
        if (result.updated) updatedAccounts += 1;
      }
      for (const source of asArray(parsed.data.payload, "partners")) {
        const id = randomUUID();
        const result = await writeRecord("account", sourceTypeFor("partners"), source, { id, accountId: maps.accounts.get(accountRef(source)), name: text(source, ["name", "partnerName"], "Imported Partner"), type: "partner", openingBalance: numberValue(source, ["balance", "openingBalance", "opening_balance"]), active: importedActive(source) });
        maps.partners.set(oldId(source), result.payloadId ?? id);
        if (result.inserted) importedCounts.partners += 1;
        if (result.updated) updatedPartners += 1;
      }
      await logStep("IMPORT ACCOUNTS", "completed", { sourceRows: asArray(parsed.data.payload, "accounts").length, importedRows: importedCounts.accounts, updatedRows: updatedAccounts, failedRows: 0 });
      await logStep("IMPORT PARTNERS", "completed", { sourceRows: asArray(parsed.data.payload, "partners").length, importedRows: importedCounts.partners, updatedRows: updatedPartners, failedRows: 0 });
      const labourNameMap = new Map<string, string>();
      await logStep("IMPORT LABOUR", "started");
      let updatedLabour = 0;
      for (const source of asArray(parsed.data.payload, "labour")) {
        const id = randomUUID();
        const name = text(source, ["name", "labourName", "workerName", "employeeName"], "Imported Labour");
        const result = await writeRecord("labourer", sourceTypeFor("labour"), source, { id, name, phone: text(source, ["phone", "mobile", "mobileNumber"]), notes: text(source, ["notes", "remarks"]), group: text(source, ["groupName", "group", "paymentGroup"], "Imported"), dailyWage: numberValue(source, ["dailyWage", "dailyRate", "wage"]), paymentType: text(source, ["paymentType"], "daily_wage"), active: importedActive(source) });
        const labourId = result.payloadId ?? id;
        maps.labour.set(oldId(source), labourId);
        labourNameMap.set(name.trim().toLowerCase(), labourId);
        if (result.inserted) importedCounts.labour += 1;
        if (result.updated) updatedLabour += 1;
      }
      await logStep("IMPORT LABOUR", "completed", { sourceRows: asArray(parsed.data.payload, "labour").length, importedRows: importedCounts.labour, updatedRows: updatedLabour, failedRows: 0 });
      const resolveLabourId = (source: AndroidRecord) => maps.labour.get(labourRef(source))
        ?? labourNameMap.get(text(source, ["labourName", "labour_name", "workerName", "worker_name", "employeeName", "name"]).trim().toLowerCase());
      const defaultAccountId = firstMapValue(maps.accounts);

      const expenseItemsByParent = new Map<string, AndroidRecord[]>();
      for (const item of asArray(parsed.data.payload, "expenseItems")) {
        const parentId = relation(item, ["oldExpenseId", "expense_id", "expenseId", "voucher_id", "voucherId", "parent_id", "parentId"]);
        expenseItemsByParent.set(parentId, [...(expenseItemsByParent.get(parentId) ?? []), item]);
      }
      await logStep("IMPORT EXPENSES", "started");
      let updatedExpenses = 0;
      let updatedExpenseItems = 0;
      for (const source of asArray(parsed.data.payload, "expenses")) {
        const items = expenseItemsByParent.get(oldId(source)) ?? [];
        const result = await writeRecord("voucher", sourceTypeFor("expenses"), source, {
          voucherNumber: text(source, ["voucherNumber", "voucher_no", "voucher"], `A-${oldId(source)}`),
          date: dateValue(source, ["date", "voucherDate"]),
          amount: numberValue(source, ["total_amount", "totalAmount", "total", "amount", "voucherTotal"]),
          accountId: maps.accounts.get(accountRef(source)) ?? defaultAccountId,
          categoryId: text(source, ["category_id", "categoryId", "category"], "imported"),
          category: text(source, ["category", "categoryName", "expenseCategory"], "Imported"),
          subcategoryId: text(source, ["subcategory_id", "subcategoryId", "subcategory"], "imported"),
          subcategory: text(source, ["subcategory", "subcategoryName", "expenseSubcategory"], "Imported"),
          paidByPartnerName: text(source, ["paidByPartnerName", "paid_by_partner_name"]),
          description: text(source, ["description", "notes"], "Imported Android voucher"),
          notes: text(source, ["notes"]),
          items: items.map((item) => ({ ...item, description: text(item, ["description", "itemName", "name"]), category: text(item, ["category", "categoryName"]), subcategory: text(item, ["subcategory", "subcategoryName"]), amount: numberValue(item, ["amount", "total", "lineTotal"]), quantity: numberValue(item, ["quantity", "qty"], 1), unit: text(item, ["unit"]), source_type: sourceTypeFor("expenseItems"), old_android_id: oldId(item) })),
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
      await logStep("IMPORT EXPENSES", "completed", { sourceRows: asArray(parsed.data.payload, "expenses").length, importedRows: importedCounts.expenses, updatedRows: updatedExpenses, failedRows: 0 });
      await logStep("IMPORT EXPENSE ITEMS", "completed", { sourceRows: asArray(parsed.data.payload, "expenseItems").length, importedRows: importedCounts.expenseItems, updatedRows: updatedExpenseItems, failedRows: 0 });
      await logStep("IMPORT ADVANCES", "started");
      let updatedAdvances = 0;
      let skippedAdvances = 0;
      const advanceFailures: string[] = [];
      for (const source of asArray(parsed.data.payload, "advances")) {
        const labourerId = resolveLabourId(source);
        if (!labourerId) {
          skippedAdvances += 1;
          advanceFailures.push(`${oldId(source) || "unknown"}: missing mapped labour`);
          continue;
        }
        try {
          const result = await writeRecord("advance", sourceTypeFor("advances"), source, {
            date: dateValue(source, ["date", "advanceDate"]),
            amount: numberValue(source, ["amount"]),
            labourerId,
            accountId: maps.accounts.get(accountRef(source)) ?? defaultAccountId,
            notes: text(source, ["notes", "description"]),
          });
          if (result.inserted) importedCounts.advances += 1;
          if (result.updated) updatedAdvances += 1;
        } catch (error) {
          skippedAdvances += 1;
          advanceFailures.push(`${oldId(source) || "unknown"}: ${readableImportError(error)}`);
        }
      }
      await logStep("IMPORT ADVANCES", "completed", { sourceRows: asArray(parsed.data.payload, "advances").length, importedRows: importedCounts.advances, updatedRows: updatedAdvances, skippedRows: skippedAdvances, failedRows: skippedAdvances, message: advanceFailures.slice(0, 8).join("; ") });
      await logStep("IMPORT ATTENDANCE", "started");
      let skippedAttendanceRows = 0;
      let updatedAttendance = 0;
      const attendanceFailures: string[] = [];
      for (const batch of chunks(asArray(parsed.data.payload, "attendance"), 250)) {
        for (const source of batch) {
          const labourerId = resolveLabourId(source);
          if (!labourerId) {
            skippedAttendanceRows += 1;
            attendanceFailures.push(`${oldId(source) || "unknown"}: missing mapped labour`);
            continue;
          }
          try {
            const result = await writeRecord("attendance", sourceTypeFor("attendance"), source, {
              date: dateValue(source, ["date", "attendanceDate", "day"]),
              labourerId,
              status: attendanceStatus(source),
              remarks: text(source, ["remarks", "notes"]),
              oldFarmId: farmRef(source),
              oldSeasonId: seasonRef(source),
              oldLabourId: labourRef(source),
            });
            if (result.inserted) importedCounts.attendance += 1;
            if (result.updated) updatedAttendance += 1;
          } catch (error) {
            skippedAttendanceRows += 1;
            attendanceFailures.push(`${oldId(source) || "unknown"}: ${readableImportError(error)}`);
          }
        }
      }
      await logStep("IMPORT ATTENDANCE", "completed", { sourceRows: asArray(parsed.data.payload, "attendance").length, importedRows: importedCounts.attendance, updatedRows: updatedAttendance, skippedRows: skippedAttendanceRows, failedRows: skippedAttendanceRows, message: attendanceFailures.slice(0, 8).join("; ") });
      const assertProcessed = (label: string, sourceRows: number, processedRows: number, skippedRows = 0) => {
        if (sourceRows > 0 && processedRows === 0 && skippedRows === 0) {
          throw new Error(`Schema mismatch or mapping failure: ${label} source count ${sourceRows} but imported/updated 0.`);
        }
      };
      assertProcessed("accounts", asArray(parsed.data.payload, "accounts").length, importedCounts.accounts + updatedAccounts);
      assertProcessed("labours", asArray(parsed.data.payload, "labour").length, importedCounts.labour + updatedLabour);
      assertProcessed("expenses", asArray(parsed.data.payload, "expenses").length, importedCounts.expenses + updatedExpenses);
      assertProcessed("advances", asArray(parsed.data.payload, "advances").length, importedCounts.advances + updatedAdvances, skippedAdvances);
      assertProcessed("attendance", asArray(parsed.data.payload, "attendance").length, importedCounts.attendance + updatedAttendance, skippedAttendanceRows);
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
      await logStep("IMPORT COMPLETE", "completed", { message: `Imported ${insertedOperationalRecords} operational records.`, importedRows: insertedOperationalRecords, failedRows: skippedAttendanceRows });
      return {
        insertedOperationalRecords,
        importCounts: importCountKeys.map(({ label, key }) => ({ label, key, count: importedCounts[key] })),
        farmImportStats,
        activeFarmId: defaultFarmId,
        activeSeasonId: selectedImportSeasonId,
        importBatchId,
        startedAt,
        completedAt,
        currentStep: "IMPORT COMPLETE",
        failedRows: skippedAttendanceRows,
        logs,
        totalExpenses: validation.summary.totalExpenses,
        totalAdvances: validation.summary.totalAdvances,
      } satisfies ImportResult;
      })(db);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown import failure.";
      await logStep(currentStep, "failed", { message, failedRows: 1 });
      return reply.code(500).send({ message: `${currentStep} failed: ${message}`, issues: validation.issues, summary: validation.summary, logs });
    }

    return { ...validation, imported: true, dryRun: false, message: "Migration imported successfully.", result };
  });

  app.post("/v1/admin/migration-import/repair-visibility", { preHandler: requirePermission("CREATE_WORKSPACE") }, async (request, reply) => {
    const parsed = repairSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "A workspaceId is required." });
    if (localDevelopmentMode) return { repairedRecords: 0, message: "Local memory mode cannot repair imported visibility. Configure a dev database first." };

    const userId = request.appUser?.id;
    if (!userId) return reply.code(403).send({ message: "Admin user is required." });
    const [workspace] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, parsed.data.workspaceId)).limit(1);
    if (!workspace) return reply.code(404).send({ message: "Workspace not found." });

    const result = await db.transaction(async (tx) => {
      const [importedFarm] = await tx.select({ id: farms.id, name: farms.name }).from(farms).where(and(
        eq(farms.workspaceId, parsed.data.workspaceId),
        eq(farms.sourceType, "farm"),
      )).limit(1);
      if (!importedFarm) return null;

      await tx.update(farms).set({ active: true, updatedAt: new Date() }).where(eq(farms.id, importedFarm.id));

      const [existingSeason] = await tx.select({ id: seasons.id, name: seasons.name }).from(seasons).where(and(
        eq(seasons.workspaceId, parsed.data.workspaceId),
        eq(seasons.farmId, importedFarm.id),
        eq(seasons.status, "active"),
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
}
