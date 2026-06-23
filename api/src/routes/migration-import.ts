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
  "labours",
  "fundSources",
  "vouchers",
  "voucherItems",
  "advances",
  "attendance",
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
});

const importSchema = payloadSchema.extend({
  dryRun: z.boolean().default(true),
  allowDatabaseWrite: z.boolean().default(false),
});

type AndroidRecord = Record<string, unknown>;
type AndroidPayload = z.infer<typeof payloadSchema>["payload"];
type ImportIssue = { level: "error" | "warning"; path: string; message: string };
type ImportSummary = {
  exportVersion: string | null;
  exportedAt: string | null;
  source: string | null;
  counts: Record<typeof requiredArrays[number], number>;
  androidCounts: Record<string, number>;
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
type ImportCountKey = "farms" | "seasons" | "labour" | "accounts" | "expenses" | "expenseItems" | "advances" | "attendance";
type ScopedMaps = { farms: Map<string, string>; seasons: Map<string, string>; labour: Map<string, string>; accounts: Map<string, string>; partners: Map<string, string> };
type ImportResult = {
  insertedOperationalRecords: number;
  importCounts: Array<{ label: string; key: ImportCountKey; count: number }>;
  farmImportStats: { created: number; updated: number; skippedDuplicates: number };
  totalExpenses: number;
  totalAdvances: number;
};

const importCountKeys: Array<{ label: string; key: ImportCountKey }> = [
  { label: "Farms imported", key: "farms" },
  { label: "Seasons imported", key: "seasons" },
  { label: "Labour imported", key: "labour" },
  { label: "Accounts imported", key: "accounts" },
  { label: "Expenses imported", key: "expenses" },
  { label: "Expense items imported", key: "expenseItems" },
  { label: "Advances imported", key: "advances" },
  { label: "Attendance imported", key: "attendance" },
];

const rawArray = (payload: AndroidPayload, key: string) => Array.isArray(payload[key]) ? payload[key] as AndroidRecord[] : [];
const asArray = (payload: AndroidPayload, key: typeof importedEntityArrays[number]) => {
  if (Array.isArray(payload[key])) return payload[key] as AndroidRecord[];
  for (const alias of (key in arrayAliases ? arrayAliases[key as typeof requiredArrays[number]] : undefined) ?? []) {
    if (Array.isArray(payload[alias])) return payload[alias] as AndroidRecord[];
  }
  return [];
};
const hasArray = (payload: AndroidPayload, key: string) => Array.isArray(payload[key]);
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
const oldId = (record: AndroidRecord) => text(record, ["old_android_id", "oldAndroidId", "android_id", "androidId", "id", "_id"]);
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
  "farm_id", "farmId", "farmID", "farm_old_android_id", "farmOldAndroidId", "farm_android_id", "farmAndroidId",
  "farm", "farm_id_fk", "farmIdFk",
]);
const seasonRef = (record: AndroidRecord) => relation(record, [
  "season_id", "seasonId", "seasonID", "season_old_android_id", "seasonOldAndroidId", "season_android_id", "seasonAndroidId",
  "season", "season_id_fk", "seasonIdFk",
]);
const labourRef = (record: AndroidRecord) => relation(record, [
  "labour_id", "labourId", "labourID", "labour_old_android_id", "labourOldAndroidId", "labour_android_id", "labourAndroidId",
  "worker_id", "workerId", "employee_id", "employeeId",
]);
const accountRef = (record: AndroidRecord) => relation(record, [
  "account_id", "accountId", "payment_account_id", "paymentAccountId", "paid_from_account_id", "paidFromAccountId",
  "fund_source_id", "fundSourceId", "deduction_account_id", "deductionAccountId",
]);
const attendanceStatus = (record: AndroidRecord): "present" | "half_day" | "absent" => {
  const raw = text(record, ["status", "attendance", "mark", "value", "state"]).toLowerCase().replace(/\s+/g, "_");
  if (["p", "present", "full", "full_day", "1"].includes(raw)) return "present";
  if (["h", "half", "half_day", "1/2", "0.5"].includes(raw)) return "half_day";
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

function validatePayload(payload: AndroidPayload): { issues: ImportIssue[]; summary: ImportSummary } {
  const issues: ImportIssue[] = [];
  const counts = Object.fromEntries(requiredArrays.map((key) => [key, asArray(payload, key).length])) as ImportSummary["counts"];
  const androidCounts = Object.fromEntries(androidExportArrays.map((key) => [key, rawArray(payload, key).length])) as Record<string, number>;
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

  const importCounts = importCountKeys.map(({ label, key }) => ({ label, key, count: key === "attendance" ? rawArray(payload, "attendance").length : counts[key] }));

  for (const key of requiredArrays) {
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
    asArray(payload, key).forEach((record, index) => {
      const farmReference = farmRef(record);
      const seasonReference = seasonRef(record);
      if (!farmReference) issues.push({ level: "warning", path: `${key}[${index}].farm_id`, message: "No farm reference found. This row will use the first imported active farm." });
      if (!seasonReference) issues.push({ level: "warning", path: `${key}[${index}].season_id`, message: "No season reference found. This row will use the imported active season." });
      if (farmReference && !farmsByOldId.has(farmReference)) issues.push({ level: "warning", path: `${key}[${index}].farm_id`, message: `Unknown farm reference '${farmReference}'. This row will use the first imported active farm.` });
      if (seasonReference && !seasonsByOldId.has(seasonReference)) issues.push({ level: "warning", path: `${key}[${index}].season_id`, message: `Unknown season reference '${seasonReference}'. This row will use the imported active season.` });
    });
  }

  asArray(payload, "expenseItems").forEach((record, index) => {
    const expenseRef = relation(record, ["expense_id", "expenseId", "voucher_id", "voucherId", "parent_id", "parentId"]);
    if (!expenseRef || !expensesByOldId.has(expenseRef)) {
      issues.push({ level: "error", path: `expenseItems[${index}].expense_id`, message: `Invalid expense/voucher reference '${expenseRef || "-"}'.` });
    }
  });
  asArray(payload, "dispatchItems").forEach((record, index) => {
    const dispatchRef = relation(record, ["dispatch_id", "dispatchId", "parent_id", "parentId"]);
    if (!dispatchRef || !dispatchesByOldId.has(dispatchRef)) {
      issues.push({ level: "error", path: `dispatchItems[${index}].dispatch_id`, message: `Invalid dispatch reference '${dispatchRef || "-"}'.` });
    }
  });

  const expenseItemsByParent = new Map<string, AndroidRecord[]>();
  for (const item of asArray(payload, "expenseItems")) {
    const parentId = relation(item, ["expense_id", "expenseId", "voucher_id", "voucherId", "parent_id", "parentId"]);
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
    farmId: scopedFarmId(record, maps, fallbackScope.farmId),
    seasonId: scopedSeasonId(record, maps, fallbackScope.seasonId),
    clientRecordId: id,
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
    const validation = validatePayload(parsed.data.payload);
    return { ...validation, canImport: validation.issues.every((issue) => issue.level !== "error"), dryRunRecommended: true };
  });

  app.post("/v1/admin/migration-import/import", { preHandler: requirePermission("CREATE_WORKSPACE"), bodyLimit: 50 * 1024 * 1024 }, async (request, reply) => {
    const parsed = importSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "A valid migration import request is required." });
    const validation = validatePayload(parsed.data.payload);
    const hasErrors = validation.issues.some((issue) => issue.level === "error");
    if (hasErrors) return reply.code(400).send({ message: "Resolve validation errors before importing.", ...validation });
    if (parsed.data.dryRun || localDevelopmentMode) return { ...validation, imported: false, dryRun: true, message: localDevelopmentMode ? "Local memory mode cannot write migration data. Configure a dev database first." : "Dry run completed. No data was written." };
    if (!parsed.data.allowDatabaseWrite) return reply.code(403).send({ message: "Database writes are blocked. Enable explicit database write confirmation to import." });

    const userId = request.appUser?.id;
    if (!userId) return reply.code(403).send({ message: "Admin user is required." });
    const [workspace] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, parsed.data.workspaceId)).limit(1);
    if (!workspace) return reply.code(404).send({ message: "Workspace not found." });

    const result = await db.transaction(async (tx) => {
      const importBatchId = randomUUID();
      const maps = { farms: new Map<string, string>(), seasons: new Map<string, string>(), labour: new Map<string, string>(), accounts: new Map<string, string>(), partners: new Map<string, string>() };
      let insertedOperationalRecords = 0;
      const farmImportStats = { created: 0, updated: 0, skippedDuplicates: 0 };
      const importedCounts: Record<ImportCountKey, number> = {
        farms: 0,
        seasons: 0,
        labour: 0,
        accounts: 0,
        expenses: 0,
        expenseItems: 0,
        advances: 0,
        attendance: 0,
      };

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
        if (!existing) {
          await tx.insert(seasons).values({
            id,
            workspaceId: parsed.data.workspaceId,
            farmId,
            name: text(source, ["name", "seasonName"], `Season ${numberValue(source, ["year"], new Date().getFullYear())}`),
            cropType: text(source, ["cropType", "crop_type"]) || null,
            year: numberValue(source, ["year"], new Date().getFullYear()),
            startsOn: dateValue(source, ["startsOn", "starts_on", "startDate"], `${new Date().getFullYear()}-01-01`),
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
        const fallbackYear = new Date().getFullYear();
        if (existingDefaultSeason) {
          await tx.update(seasons).set({ status: "active", active: true, updatedAt: new Date() }).where(eq(seasons.id, existingDefaultSeason.id));
        } else {
          await tx.insert(seasons).values({
            id: fallbackSeasonId,
            workspaceId: parsed.data.workspaceId,
            farmId,
            name: `Season ${fallbackYear}`,
            year: fallbackYear,
            startsOn: `${fallbackYear}-01-01`,
            status: "active",
            notes: marker,
            active: true,
            createdBy: userId,
          });
          importedCounts.seasons += 1;
        }
        maps.seasons.set(`default:${farmId}`, fallbackSeasonId);
        seasonByFarm.set(farmId, fallbackSeasonId);
      }
      const defaultSeasonId = firstMapValue(maps.seasons)!;
      await tx.update(userSessions).set({
        activeFarmId: defaultFarmId,
        activeSeasonId: seasonByFarm.get(defaultFarmId) ?? defaultSeasonId,
      }).where(and(
        eq(userSessions.workspaceId, parsed.data.workspaceId),
        sql`${userSessions.activeFarmId} IS NULL`,
      ));

      const writeRecord = async (entity: string, sourceType: string, source: AndroidRecord, extra: Record<string, unknown> = {}) => {
        const targetFarmId = scopedFarmId(source, maps, defaultFarmId);
        const targetSeasonId = maps.seasons.get(seasonRef(source)) ?? seasonByFarm.get(targetFarmId) ?? defaultSeasonId;
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
          return { inserted: false, payloadId: payloadId(nextPayload) };
        }
        await tx.insert(operationalRecords).values(record);
        insertedOperationalRecords += 1;
        return { inserted: true, payloadId: payloadId(record.payload) };
      };

      for (const source of asArray(parsed.data.payload, "accounts")) {
        const id = randomUUID();
        const result = await writeRecord("account", sourceTypeFor("accounts"), source, { id, name: text(source, ["name", "accountName"], "Imported Account"), type: text(source, ["type", "accountType"], "cash") });
        maps.accounts.set(oldId(source), result.payloadId ?? id);
        if (result.inserted) importedCounts.accounts += 1;
      }
      for (const source of asArray(parsed.data.payload, "partners")) {
        const id = randomUUID();
        const result = await writeRecord("account", sourceTypeFor("partners"), source, { id, name: text(source, ["name", "partnerName"], "Imported Partner"), type: "partner" });
        maps.partners.set(oldId(source), result.payloadId ?? id);
      }
      const labourNameMap = new Map<string, string>();
      for (const source of asArray(parsed.data.payload, "labour")) {
        const id = randomUUID();
        const name = text(source, ["name", "labourName", "workerName", "employeeName"], "Imported Labour");
        const result = await writeRecord("labourer", sourceTypeFor("labour"), source, { id, name, group: text(source, ["group", "groupName"], "Imported"), dailyWage: numberValue(source, ["dailyWage", "dailyRate", "wage"]), paymentType: text(source, ["paymentType"], "daily_wage"), active: source.active !== false });
        const labourId = result.payloadId ?? id;
        maps.labour.set(oldId(source), labourId);
        labourNameMap.set(name.trim().toLowerCase(), labourId);
        if (result.inserted) importedCounts.labour += 1;
      }
      const resolveLabourId = (source: AndroidRecord) => maps.labour.get(labourRef(source))
        ?? labourNameMap.get(text(source, ["labourName", "labour_name", "workerName", "worker_name", "employeeName", "name"]).trim().toLowerCase());
      const defaultAccountId = firstMapValue(maps.accounts);

      const expenseItemsByParent = new Map<string, AndroidRecord[]>();
      for (const item of asArray(parsed.data.payload, "expenseItems")) {
        const parentId = relation(item, ["expense_id", "expenseId", "voucher_id", "voucherId", "parent_id", "parentId"]);
        expenseItemsByParent.set(parentId, [...(expenseItemsByParent.get(parentId) ?? []), item]);
      }
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
          description: text(source, ["description", "notes"], "Imported Android voucher"),
          items: items.map((item) => ({ ...item, source_type: sourceTypeFor("expenseItems"), old_android_id: oldId(item) })),
        });
        if (result.inserted) {
          importedCounts.expenses += 1;
          importedCounts.expenseItems += items.length;
        }
      }
      for (const source of asArray(parsed.data.payload, "advances")) {
        const result = await writeRecord("advance", sourceTypeFor("advances"), source, {
          date: dateValue(source, ["date", "advanceDate"]),
          amount: numberValue(source, ["amount"]),
          labourerId: resolveLabourId(source),
          accountId: maps.accounts.get(accountRef(source)) ?? defaultAccountId,
          notes: text(source, ["notes", "description"]),
        });
        if (result.inserted) importedCounts.advances += 1;
      }
      for (const source of asArray(parsed.data.payload, "attendance")) {
        const labourerId = resolveLabourId(source);
        if (!labourerId) continue;
        const result = await writeRecord("attendance", sourceTypeFor("attendance"), source, {
          date: dateValue(source, ["date", "attendanceDate", "day"]),
          labourerId,
          status: attendanceStatus(source),
        });
        if (result.inserted) importedCounts.attendance += 1;
      }
      const dispatchItemsByParent = new Map<string, AndroidRecord[]>();
      for (const item of asArray(parsed.data.payload, "dispatchItems")) {
        const parentId = relation(item, ["dispatch_id", "dispatchId", "parent_id", "parentId"]);
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
      for (const source of asArray(parsed.data.payload, "sales")) {
        await writeRecord("sale", sourceTypeFor("sales"), source, { date: dateValue(source, ["date", "saleDate"]), buyerName: text(source, ["buyerName", "buyer"], "Imported Buyer"), amount: numberValue(source, ["total", "totalAmount", "amount"]), accountId: maps.accounts.get(accountRef(source)) ?? defaultAccountId });
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
      return {
        insertedOperationalRecords,
        importCounts: importCountKeys.map(({ label, key }) => ({ label, key, count: importedCounts[key] })),
        farmImportStats,
        totalExpenses: validation.summary.totalExpenses,
        totalAdvances: validation.summary.totalAdvances,
      } satisfies ImportResult;
    });

    return { ...validation, imported: true, dryRun: false, message: "Migration imported successfully.", result };
  });
}
