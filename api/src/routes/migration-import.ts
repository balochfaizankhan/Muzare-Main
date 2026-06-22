import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, eq, or, sql } from "drizzle-orm";
import { z } from "zod";
import { requirePermission } from "../auth.js";
import { localDevelopmentMode } from "../config.js";
import { db } from "../db/client.js";
import { auditLogs, farms, operationalRecords, seasons, workspaces } from "../db/schema.js";

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

const rawArray = (payload: AndroidPayload, key: string) => Array.isArray(payload[key]) ? payload[key] as AndroidRecord[] : [];
const asArray = (payload: AndroidPayload, key: typeof requiredArrays[number]) => {
  if (Array.isArray(payload[key])) return payload[key] as AndroidRecord[];
  for (const alias of arrayAliases[key] ?? []) {
    if (Array.isArray(payload[alias])) return payload[alias] as AndroidRecord[];
  }
  return [];
};
const hasArray = (payload: AndroidPayload, key: string) => Array.isArray(payload[key]);
const hasCanonicalOrAliasArray = (payload: AndroidPayload, key: typeof requiredArrays[number]) =>
  hasArray(payload, key) || (arrayAliases[key] ?? []).some((alias) => hasArray(payload, alias));
const acceptedSourceArray = (payload: AndroidPayload, androidKey: typeof androidExportArrays[number]) => {
  if (hasArray(payload, androidKey)) return true;
  const pwaKey = androidToPwaArrayMap[androidKey as keyof typeof androidToPwaArrayMap];
  return pwaKey ? hasArray(payload, pwaKey) : false;
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
const oldId = (record: AndroidRecord) => text(record, ["old_android_id", "oldAndroidId", "android_id", "androidId", "id", "_id"]);
const dateValue = (record: AndroidRecord, keys: string[], fallback = new Date().toISOString().slice(0, 10)) => {
  const raw = text(record, keys);
  if (!raw) return fallback;
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString().slice(0, 10);
};
const relation = (record: AndroidRecord, keys: string[]) => text(record, keys);
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
}[key] ?? key);

function validatePayload(payload: AndroidPayload): { issues: ImportIssue[]; summary: ImportSummary } {
  const issues: ImportIssue[] = [];
  const counts = Object.fromEntries(requiredArrays.map((key) => [key, asArray(payload, key).length])) as ImportSummary["counts"];
  const androidCounts = Object.fromEntries(androidExportArrays.map((key) => [key, rawArray(payload, key).length])) as Record<string, number>;
  const mappedCounts = Object.entries(androidToPwaArrayMap).map(([androidKey, pwaKey]) => ({
    androidKey,
    pwaKey,
    count: rawArray(payload, androidKey).length || asArray(payload, pwaKey).length,
  }));
  const hasAndroidShape = androidExportArrays.some((key) => hasArray(payload, key));
  if (hasAndroidShape) {
    for (const key of androidExportArrays) {
      if (!acceptedSourceArray(payload, key)) issues.push({ level: "error", path: key, message: `Required Android export array '${key}' is missing.` });
    }
  }
  for (const key of requiredArrays) {
    if (!hasAndroidShape && !hasCanonicalOrAliasArray(payload, key)) {
      const aliases = arrayAliases[key]?.length ? ` or ${arrayAliases[key]!.join("/")}` : "";
      issues.push({ level: "error", path: key, message: `Required array '${key}'${aliases} is missing.` });
    }
  }

  for (const key of ["exportVersion", "exportedAt", "source"]) {
    if (typeof payload[key] !== "string" || !String(payload[key]).trim()) {
      issues.push({ level: "warning", path: key, message: `${key} is missing or empty.` });
    }
  }

  const importCountKeys: Array<{ label: string; key: typeof requiredArrays[number] }> = [
    { label: "Farms imported", key: "farms" },
    { label: "Seasons imported", key: "seasons" },
    { label: "Labour imported", key: "labour" },
    { label: "Accounts imported", key: "accounts" },
    { label: "Expenses imported", key: "expenses" },
    { label: "Expense Items imported", key: "expenseItems" },
  ];
  const importCounts = importCountKeys.map(({ label, key }) => ({ label, key, count: counts[key] }));

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

  const seasonScopedKeys: Array<typeof requiredArrays[number]> = ["expenses", "advances", "dispatches", "sales", "settlements", "partnerTransfers"];
  for (const key of seasonScopedKeys) {
    asArray(payload, key).forEach((record, index) => {
      const farmRef = relation(record, ["farm_id", "farmId", "farm_old_android_id", "farmOldAndroidId"]);
      const seasonRef = relation(record, ["season_id", "seasonId", "season_old_android_id", "seasonOldAndroidId"]);
      if (!farmRef) issues.push({ level: "error", path: `${key}[${index}].farm_id`, message: "farm_id is required for operational records." });
      if (!seasonRef) issues.push({ level: "error", path: `${key}[${index}].season_id`, message: "season_id is required for operational records." });
      if (farmRef && !farmsByOldId.has(farmRef)) issues.push({ level: "error", path: `${key}[${index}].farm_id`, message: `Unknown farm reference '${farmRef}'.` });
      if (seasonRef && !seasonsByOldId.has(seasonRef)) issues.push({ level: "error", path: `${key}[${index}].season_id`, message: `Unknown season reference '${seasonRef}'.` });
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

function operationalRecord(entity: string, record: AndroidRecord, sourceType: string, maps: { farms: Map<string, string>; seasons: Map<string, string>; labour: Map<string, string>; accounts: Map<string, string>; partners: Map<string, string> }, extra: Record<string, unknown> = {}) {
  const createdAt = nowIso();
  const id = randomUUID();
  return {
    id,
    workspaceId: "",
    farmId: maps.farms.get(relation(record, ["farm_id", "farmId", "farm_old_android_id", "farmOldAndroidId"])) ?? null,
    seasonId: maps.seasons.get(relation(record, ["season_id", "seasonId", "season_old_android_id", "seasonOldAndroidId"])) ?? null,
    clientRecordId: id,
    entityType: entity,
    payload: { ...record, ...extra, id, source_type: sourceType, old_android_id: oldId(record), createdAt, updatedAt: createdAt },
    recordedBy: "",
    clientUpdatedAt: new Date(createdAt),
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
  };
}

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
      const maps = { farms: new Map<string, string>(), seasons: new Map<string, string>(), labour: new Map<string, string>(), accounts: new Map<string, string>(), partners: new Map<string, string>() };
      let insertedOperationalRecords = 0;

      for (const source of asArray(parsed.data.payload, "farms")) {
        const marker = `source_type:${sourceTypeFor("farms")};old_android_id:${oldId(source)}`;
        const legacyMarker = `old_android_id:${oldId(source)}`;
        const [existing] = await tx.select({ id: farms.id }).from(farms).where(and(
          eq(farms.workspaceId, parsed.data.workspaceId),
          or(eq(farms.remarks, marker), eq(farms.remarks, legacyMarker)),
        )).limit(1);
        const id = existing?.id ?? randomUUID();
        maps.farms.set(oldId(source), id);
        if (!existing) {
          await tx.insert(farms).values({
            id,
            workspaceId: parsed.data.workspaceId,
            name: text(source, ["name", "farmName"], "Imported Farm"),
            location: text(source, ["location", "address"]) || null,
            owner: text(source, ["owner"]) || null,
            remarks: marker,
            active: source.active !== false,
            createdBy: userId,
          });
        }
      }
      for (const source of asArray(parsed.data.payload, "seasons")) {
        const marker = `source_type:${sourceTypeFor("seasons")};old_android_id:${oldId(source)}`;
        const legacyMarker = `old_android_id:${oldId(source)}`;
        const farmId = maps.farms.get(relation(source, ["farm_id", "farmId", "farm_old_android_id", "farmOldAndroidId"]));
        if (!farmId) continue;
        const [existing] = await tx.select({ id: seasons.id }).from(seasons).where(and(
          eq(seasons.workspaceId, parsed.data.workspaceId),
          or(eq(seasons.notes, marker), eq(seasons.notes, legacyMarker)),
        )).limit(1);
        const id = existing?.id ?? randomUUID();
        maps.seasons.set(oldId(source), id);
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
        }
      }

      const writeRecord = async (entity: string, sourceType: string, source: AndroidRecord, extra: Record<string, unknown> = {}) => {
        const androidId = oldId(source);
        const [existing] = await tx.select({ id: operationalRecords.id }).from(operationalRecords).where(and(
          eq(operationalRecords.workspaceId, parsed.data.workspaceId),
          eq(operationalRecords.entityType, entity),
          sql`${operationalRecords.payload}->>'source_type' = ${sourceType}`,
          sql`${operationalRecords.payload}->>'old_android_id' = ${androidId}`,
        )).limit(1);
        if (existing) return;
        const record = operationalRecord(entity, source, sourceType, maps, extra);
        if (!record.farmId) return;
        record.workspaceId = parsed.data.workspaceId;
        record.recordedBy = userId;
        await tx.insert(operationalRecords).values(record);
        insertedOperationalRecords += 1;
      };

      for (const source of asArray(parsed.data.payload, "accounts")) {
        const id = randomUUID();
        maps.accounts.set(oldId(source), id);
        await writeRecord("account", sourceTypeFor("accounts"), source, { id, name: text(source, ["name", "accountName"], "Imported Account"), type: text(source, ["type", "accountType"], "cash") });
      }
      for (const source of asArray(parsed.data.payload, "partners")) {
        const id = randomUUID();
        maps.partners.set(oldId(source), id);
        await writeRecord("account", sourceTypeFor("partners"), source, { id, name: text(source, ["name", "partnerName"], "Imported Partner"), type: "partner" });
      }
      for (const source of asArray(parsed.data.payload, "labour")) {
        const id = randomUUID();
        maps.labour.set(oldId(source), id);
        await writeRecord("labourer", sourceTypeFor("labour"), source, { id, name: text(source, ["name", "labourName"], "Imported Labour"), dailyWage: numberValue(source, ["dailyWage", "dailyRate", "wage"]), paymentType: text(source, ["paymentType"], "daily_wage"), active: source.active !== false });
      }

      const expenseItemsByParent = new Map<string, AndroidRecord[]>();
      for (const item of asArray(parsed.data.payload, "expenseItems")) {
        const parentId = relation(item, ["expense_id", "expenseId", "voucher_id", "voucherId", "parent_id", "parentId"]);
        expenseItemsByParent.set(parentId, [...(expenseItemsByParent.get(parentId) ?? []), item]);
      }
      for (const source of asArray(parsed.data.payload, "expenses")) {
        const items = expenseItemsByParent.get(oldId(source)) ?? [];
        await writeRecord("voucher", sourceTypeFor("expenses"), source, {
          voucherNumber: text(source, ["voucherNumber", "voucher_no", "voucher"], `A-${oldId(source)}`),
          date: dateValue(source, ["date", "voucherDate"]),
          amount: numberValue(source, ["total_amount", "totalAmount", "total", "amount", "voucherTotal"]),
          accountId: maps.accounts.get(relation(source, ["account_id", "accountId", "paid_from_account_id", "paidFromAccountId"])),
          description: text(source, ["description", "notes"], "Imported Android voucher"),
          items: items.map((item) => ({ ...item, source_type: sourceTypeFor("expenseItems"), old_android_id: oldId(item) })),
        });
      }
      for (const source of asArray(parsed.data.payload, "advances")) {
        await writeRecord("advance", sourceTypeFor("advances"), source, {
          date: dateValue(source, ["date", "advanceDate"]),
          amount: numberValue(source, ["amount"]),
          labourerId: maps.labour.get(relation(source, ["labour_id", "labourId", "labour_old_android_id", "labourOldAndroidId"])),
          accountId: maps.accounts.get(relation(source, ["account_id", "accountId", "payment_account_id", "paymentAccountId"])),
          notes: text(source, ["notes", "description"]),
        });
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
        await writeRecord("sale", sourceTypeFor("sales"), source, { date: dateValue(source, ["date", "saleDate"]), buyerName: text(source, ["buyerName", "buyer"], "Imported Buyer"), amount: numberValue(source, ["total", "totalAmount", "amount"]), accountId: maps.accounts.get(relation(source, ["account_id", "accountId", "payment_account_id", "paymentAccountId"])) });
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
        details: { source: validation.summary.source, exportedAt: validation.summary.exportedAt, insertedOperationalRecords },
      });
      return { insertedOperationalRecords };
    });

    return { ...validation, imported: true, dryRun: false, result };
  });
}
