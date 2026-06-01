import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { requireUser, type AuthenticatedUser } from "../auth.js";
import { db } from "../db/client.js";
import {
  auditLogs,
  expenseCategories,
  expenseImportSessions,
  expenseSubcategories,
  expenseVoucherSequences,
  operationalRecords,
} from "../db/schema.js";
import { hasPermission } from "../permissions.js";
import { validateTenantReferences } from "../tenant-ownership.js";

const paramsSchema = z.object({ workspaceId: z.string().uuid() });
const previewSchema = z.object({
  farmId: z.string().uuid(),
  seasonId: z.string().uuid(),
  originalFilename: z.string().trim().min(1).max(255),
  csvText: z.string().min(1).max(10_000_000),
});
const resolutionSchema = z.object({
  sourceName: z.string().trim().min(1),
  action: z.enum(["map", "create"]),
  targetId: z.string().min(1).optional(),
}).superRefine((resolution, context) => {
  if (resolution.action === "map" && !resolution.targetId) {
    context.addIssue({ code: "custom", path: ["targetId"], message: "Choose an existing value to map." });
  }
});
const confirmSchema = z.object({
  importSessionId: z.string().uuid(),
  farmId: z.string().uuid(),
  seasonId: z.string().uuid(),
  skipDuplicates: z.boolean().default(true),
  categoryMappings: z.array(resolutionSchema).default([]),
  accountMappings: z.array(resolutionSchema).default([]),
});

type CategoryOption = { id: string; categoryId: string; category: string; subcategory: string; label: string };
type AccountOption = { id: string; name: string };
type ExpenseRow = {
  rowIndex: number; voucherNumber: string; date: string; accountName: string; categoryName: string;
  description: string; amount: number; accountId: string | null; subcategoryId: string | null; error: string | null;
  mappingIssue: string | null;
};
type ExpensePayload = { rows: ExpenseRow[]; errors: string[] };

const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
const stableId = (...values: Array<string | number>) => createHash("sha256").update(values.join("|")).digest("hex");
const voucherScopeKey = (farmId: string, seasonId: string) => `season:${seasonId}`;
const aliases = {
  voucher: ["voucher", "voucher no", "voucher number"],
  date: ["date", "expense date"],
  account: ["deduction account", "account", "paid from", "paid-from account"],
  category: ["category", "expense category"],
  description: ["description", "details"],
  amount: ["amount", "value"],
};

function parseCsv(csv: string) {
  const rows: string[][] = [];
  let row: string[] = []; let cell = ""; let quoted = false;
  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index]!; const next = csv[index + 1];
    if (char === "\"" && quoted && next === "\"") { cell += "\""; index += 1; }
    else if (char === "\"") quoted = !quoted;
    else if (char === "," && !quoted) { row.push(cell); cell = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell); cell = "";
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
    } else cell += char;
  }
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

function parseDate(value: string) {
  const input = value.trim();
  const isoMatch = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const match = isoMatch
    ? [input, isoMatch[3]!, isoMatch[2]!, isoMatch[1]!]
    : input.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (!match) return null;
  const day = Number(match[1]); const month = Number(match[2]); const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? date.toISOString().slice(0, 10) : null;
}

function parseAmount(value: string) {
  const amount = Number(value.replace(/\bSAR\b/gi, "").replaceAll(",", "").trim());
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function findColumn(headers: string[], names: string[]) {
  return headers.findIndex((header) => names.includes(normalize(header)));
}

function matchCategory(name: string, options: CategoryOption[]) {
  const normalized = normalize(name);
  const subcategory = options.find((option) => normalize(option.subcategory) === normalized);
  if (subcategory) return subcategory.id;
  if (normalized === "others" || normalized === "other") return options.find((option) => normalize(option.subcategory) === "miscellaneous")?.id ?? null;
  if (normalized === "salaries") return options.find((option) => normalize(option.subcategory) === "wages")?.id ?? null;
  return null;
}

function buildPreview(csvText: string, categories: CategoryOption[], accounts: AccountOption[]): ExpensePayload {
  const csv = parseCsv(csvText);
  const errors: string[] = [];
  const headerRowIndex = csv.slice(0, 20).findIndex((row) =>
    Object.values(aliases).every((names) => findColumn(row, names) >= 0),
  );
  if (headerRowIndex < 0) return { rows: [], errors: ["Expense CSV header was not found in the first 20 rows."] };
  const headers = csv[headerRowIndex]!;
  const columns = {
    voucher: findColumn(headers, aliases.voucher), date: findColumn(headers, aliases.date),
    account: findColumn(headers, aliases.account), category: findColumn(headers, aliases.category),
    description: findColumn(headers, aliases.description), amount: findColumn(headers, aliases.amount),
  };
  for (const [field, index] of Object.entries(columns)) if (index < 0) errors.push(`${field} column was not found.`);
  if (errors.length) return { rows: [], errors };
  const accountByName = new Map(accounts.map((account) => [normalize(account.name), account.id]));
  const rows = csv.slice(headerRowIndex + 1).flatMap((values, rowIndex): ExpenseRow[] => {
    if (!values.some((value) => value.trim())) return [];
    const voucherNumber = values[columns.voucher]!.trim();
    const accountName = values[columns.account]!.trim();
    const csvCategory = values[columns.category]!.trim();
    const categoryName = csvCategory || "Other";
    const description = values[columns.description]!.trim() || csvCategory || "Imported expense";
    const rawDate = values[columns.date]!.trim();
    const date = parseDate(rawDate) ?? "";
    const rawAmount = values[columns.amount]!.trim();
    const amount = parseAmount(rawAmount);
    const issue = !voucherNumber ? "Voucher number is required."
      : !rawDate ? "Expense date is required."
        : !date ? `Expense date "${rawDate}" is invalid.`
        : !accountName ? "Deduction account is required."
          : !rawAmount ? "Amount is required."
            : amount === null ? `Amount "${rawAmount}" must be greater than zero.` : null;
    const accountId = accountByName.get(normalize(accountName)) ?? null;
    const subcategoryId = matchCategory(categoryName, categories);
    return [{
      rowIndex: headerRowIndex + rowIndex + 2, voucherNumber, date, accountName, categoryName, description, amount: amount ?? 0,
      accountId, subcategoryId, error: issue,
      mappingIssue: !accountId && accountName ? `Deduction account "${accountName}" was not found. Map it or create it before import.`
        : !subcategoryId ? `Category "${categoryName}" was not found. Map it or create it before import.` : null,
    }];
  });
  return { rows, errors };
}

const duplicateKey = (row: ExpenseRow, accountId: string, subcategoryId: string) =>
  [normalize(row.voucherNumber), row.date, row.amount, accountId, subcategoryId, normalize(row.description)].join("|");

function previewSummary(payload: ExpensePayload, existingKeys: Set<string>) {
  const seen = new Set(existingKeys);
  let duplicates = 0;
  for (const row of payload.rows) {
    if (!row.accountId || !row.subcategoryId || row.error) continue;
    const key = duplicateKey(row, row.accountId, row.subcategoryId);
    if (seen.has(key)) duplicates += 1; else seen.add(key);
  }
  const unique = (values: string[]) => [...new Map(values.map((value) => [normalize(value), value])).values()].sort((a, b) => a.localeCompare(b));
  const totals = (key: "accountName" | "categoryName") => [...payload.rows.reduce((map, row) => {
    map.set(row[key], (map.get(row[key]) ?? 0) + row.amount); return map;
  }, new Map<string, number>())].map(([name, total]) => ({ name, total }));
  return {
    totalRows: payload.rows.length,
    readyRows: payload.rows.filter((row) => !row.error && row.accountId && row.subcategoryId).length - duplicates,
    duplicateRows: duplicates,
    missingAccounts: unique(payload.rows.filter((row) => !row.error && !row.accountId && row.accountName).map((row) => row.accountName)),
    missingCategories: unique(payload.rows.filter((row) => !row.error && !row.subcategoryId && row.categoryName).map((row) => row.categoryName)),
    errors: [...payload.errors, ...payload.rows.flatMap((row) => row.error ? [`Row ${row.rowIndex}: ${row.error}`] : [])],
    mappingIssues: payload.rows.flatMap((row) => row.mappingIssue ? [`Row ${row.rowIndex}: ${row.mappingIssue}`] : []),
    totalsByAccount: totals("accountName"), totalsByCategory: totals("categoryName"),
    grandTotal: payload.rows.reduce((total, row) => total + row.amount, 0),
  };
}

async function selectedCategories(workspaceId: string): Promise<CategoryOption[]> {
  return (await db.select({
    id: expenseSubcategories.id, categoryId: expenseCategories.id, category: expenseCategories.name, subcategory: expenseSubcategories.name,
  }).from(expenseSubcategories).innerJoin(expenseCategories, eq(expenseCategories.id, expenseSubcategories.categoryId)).where(and(
    eq(expenseCategories.active, true), eq(expenseSubcategories.active, true),
    or(isNull(expenseCategories.workspaceId), eq(expenseCategories.workspaceId, workspaceId)),
    or(isNull(expenseSubcategories.workspaceId), eq(expenseSubcategories.workspaceId, workspaceId)),
  ))).map((option) => ({ ...option, label: `${option.category} / ${option.subcategory}` }));
}

async function selectedAccounts(workspaceId: string, farmId: string, seasonId: string): Promise<AccountOption[]> {
  return (await db.select().from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId, workspaceId), eq(operationalRecords.farmId, farmId),
    eq(operationalRecords.seasonId, seasonId), eq(operationalRecords.entityType, "account"),
  ))).map((record) => ({ id: record.clientRecordId, name: String(record.payload.name ?? "Account") }));
}

async function assertImportAccess(workspaceId: string, farmId: string, seasonId: string, user: AuthenticatedUser) {
  if (user.workspaceId !== workspaceId || !hasPermission(user, "MANAGE_RECORDS", workspaceId)) return "Workspace record management permission is required.";
  return validateTenantReferences(workspaceId, { farmId, seasonId });
}

async function existingDuplicateKeys(workspaceId: string, farmId: string, seasonId: string) {
  return new Set((await db.select().from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId, workspaceId), eq(operationalRecords.farmId, farmId),
    eq(operationalRecords.seasonId, seasonId), eq(operationalRecords.entityType, "voucher"),
  ))).map((record) => {
    const payload = record.payload;
    return duplicateKey({
      rowIndex: 0, voucherNumber: String(payload.voucherNumber ?? ""), date: String(payload.date ?? ""),
      accountName: "", categoryName: "", description: String(payload.description ?? ""), amount: Number(payload.amount) || 0,
      accountId: null, subcategoryId: null, error: null, mappingIssue: null,
    }, String(payload.accountId ?? ""), String(payload.subcategoryId ?? ""));
  }));
}

export async function expenseImportRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/workspaces/:workspaceId/expense-imports/preview", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser) return reply;
    const params = paramsSchema.safeParse(request.params); const body = previewSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ message: "A valid expense CSV import is required." });
    const accessError = await assertImportAccess(params.data.workspaceId, body.data.farmId, body.data.seasonId, request.appUser);
    if (accessError) return reply.code(403).send({ message: accessError });
    const categories = await selectedCategories(params.data.workspaceId);
    const accounts = await selectedAccounts(params.data.workspaceId, body.data.farmId, body.data.seasonId);
    const parsedPayload = buildPreview(body.data.csvText, categories, accounts);
    const validationSummary = previewSummary(parsedPayload, await existingDuplicateKeys(params.data.workspaceId, body.data.farmId, body.data.seasonId));
    const [session] = await db.insert(expenseImportSessions).values({
      workspaceId: params.data.workspaceId, farmId: body.data.farmId, seasonId: body.data.seasonId,
      uploadedBy: request.appUser.id, originalFilename: body.data.originalFilename, fileHash: stableId(body.data.csvText),
      parsedPayload, validationSummary,
    }).returning();
    return reply.code(201).send({ sessionId: session!.id, preview: { ...parsedPayload, summary: validationSummary, categories, accounts } });
  });

  app.post("/api/workspaces/:workspaceId/expense-imports/confirm", { preHandler: requireUser }, async (request, reply) => {
    if (!request.appUser) return reply;
    const params = paramsSchema.safeParse(request.params); const body = confirmSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ message: "A valid expense import confirmation is required." });
    const [session] = await db.select().from(expenseImportSessions).where(and(
      eq(expenseImportSessions.id, body.data.importSessionId), eq(expenseImportSessions.workspaceId, params.data.workspaceId),
      eq(expenseImportSessions.uploadedBy, request.appUser.id),
    )).limit(1);
    if (!session) return reply.code(404).send({ message: "Expense import session was not found." });
    if (session.status === "confirmed") return reply.code(409).send({ message: "Expense import session has already been confirmed." });
    if (session.farmId !== body.data.farmId || session.seasonId !== body.data.seasonId) return reply.code(403).send({ message: "Import confirmation must match the preview farm and season." });
    const accessError = await assertImportAccess(params.data.workspaceId, session.farmId, session.seasonId, request.appUser);
    if (accessError) return reply.code(403).send({ message: accessError });
    const parsed = session.parsedPayload as unknown as ExpensePayload;
    const categories = await selectedCategories(params.data.workspaceId); const accounts = await selectedAccounts(params.data.workspaceId, session.farmId, session.seasonId);
    const categoryMappings = new Map(body.data.categoryMappings.map((item) => [normalize(item.sourceName), item]));
    const accountMappings = new Map(body.data.accountMappings.map((item) => [normalize(item.sourceName), item]));
    const inputErrors = [...parsed.errors, ...parsed.rows.flatMap((row) => row.error ? [`Row ${row.rowIndex}: ${row.error}`] : [])];
    if (inputErrors.length) return reply.code(400).send({ message: "Resolve CSV validation errors before importing.", errors: inputErrors });
    const categoryIds = new Set(categories.map((item) => item.id)); const accountIds = new Set(accounts.map((item) => item.id));
    const missingCategories = [...new Set(parsed.rows.filter((row) => !row.subcategoryId).map((row) => row.categoryName))];
    const missingAccounts = [...new Set(parsed.rows.filter((row) => !row.accountId).map((row) => row.accountName))];
    const invalidCategory = missingCategories.find((name) => {
      const mapping = categoryMappings.get(normalize(name)); return !mapping || (mapping.action === "map" && !categoryIds.has(mapping.targetId!));
    });
    if (invalidCategory) return reply.code(400).send({ message: `Resolve missing category: ${invalidCategory}` });
    const invalidAccount = missingAccounts.find((name) => {
      const mapping = accountMappings.get(normalize(name)); return !mapping || (mapping.action === "map" && !accountIds.has(mapping.targetId!));
    });
    if (invalidAccount) return reply.code(400).send({ message: `Resolve missing account: ${invalidAccount}` });
    const result = await db.transaction(async (tx) => {
      const categoryById = new Map(categories.map((item) => [item.id, item])); const accountById = new Map(accounts.map((item) => [item.id, item]));
      const categoryByName = new Map<string, CategoryOption>(); const accountByName = new Map<string, AccountOption>();
      for (const option of categories) categoryByName.set(normalize(option.subcategory), option);
      for (const option of accounts) accountByName.set(normalize(option.name), option);
      const [other] = await tx.select().from(expenseCategories).where(and(isNull(expenseCategories.workspaceId), eq(expenseCategories.name, "Other"))).limit(1);
      for (const row of parsed.rows) {
        if (!row.subcategoryId && !categoryByName.has(normalize(row.categoryName))) {
          const resolution = categoryMappings.get(normalize(row.categoryName));
          if (!resolution) throw new Error(`Resolve missing category: ${row.categoryName}`);
          if (resolution.action === "map") {
            const target = categoryById.get(resolution.targetId!);
            if (!target) throw new Error(`Category mapping does not belong to this workspace: ${row.categoryName}`);
            categoryByName.set(normalize(row.categoryName), target);
          }
          else {
            const [created] = await tx.insert(expenseSubcategories).values({ categoryId: other!.id, workspaceId: params.data.workspaceId, name: row.categoryName }).returning();
            const option = { id: created!.id, categoryId: other!.id, category: "Other", subcategory: created!.name, label: `Other / ${created!.name}` };
            categoryById.set(option.id, option); categoryByName.set(normalize(row.categoryName), option);
          }
        }
        if (!row.accountId && !accountByName.has(normalize(row.accountName))) {
          const resolution = accountMappings.get(normalize(row.accountName));
          if (!resolution) throw new Error(`Resolve missing account: ${row.accountName}`);
          if (resolution.action === "map") {
            const target = accountById.get(resolution.targetId!);
            if (!target) throw new Error(`Account mapping does not belong to this workspace farm and season: ${row.accountName}`);
            accountByName.set(normalize(row.accountName), target);
          }
          else {
            const timestamp = new Date(); const id = randomUUID(); const account = { id, name: row.accountName };
            await tx.insert(operationalRecords).values({
              workspaceId: params.data.workspaceId, farmId: session.farmId, seasonId: session.seasonId, clientRecordId: id, entityType: "account",
              payload: { id, name: row.accountName, type: "cash", source: "expense_csv_import", createdAt: timestamp.toISOString(), updatedAt: timestamp.toISOString() },
              recordedBy: request.appUser!.id, clientUpdatedAt: timestamp,
            });
            accountById.set(id, account); accountByName.set(normalize(row.accountName), account);
          }
        }
      }
      const seen = await existingDuplicateKeys(params.data.workspaceId, session.farmId, session.seasonId);
      const writes: Array<typeof operationalRecords.$inferInsert> = []; let duplicatesSkipped = 0; let grandTotal = 0; let maxImportedNumber = 0;
      for (const row of parsed.rows) {
        if (row.error) throw new Error(`Row ${row.rowIndex}: ${row.error}`);
        const category = row.subcategoryId ? categoryById.get(row.subcategoryId) : categoryByName.get(normalize(row.categoryName));
        const account = row.accountId ? accountById.get(row.accountId) : accountByName.get(normalize(row.accountName));
        if (!category || !account) throw new Error(`Resolve mappings for row ${row.rowIndex}.`);
        const key = duplicateKey(row, account.id, category.id);
        if (seen.has(key)) {
          if (!body.data.skipDuplicates) throw new Error(`Duplicate expense row detected for voucher ${row.voucherNumber}.`);
          duplicatesSkipped += 1; continue;
        }
        seen.add(key); const timestamp = new Date(); const id = `csv-expense-${stableId(session.id, row.rowIndex)}`;
        const number = /^V-(\d+)$/.exec(row.voucherNumber); if (number) maxImportedNumber = Math.max(maxImportedNumber, Number(number[1]));
        writes.push({
          workspaceId: params.data.workspaceId, farmId: session.farmId, seasonId: session.seasonId, clientRecordId: id, entityType: "voucher",
          payload: {
            id, voucherNumber: row.voucherNumber, date: row.date, accountId: account.id, categoryId: category.categoryId, category: category.category,
            subcategoryId: category.id, subcategory: category.subcategory, description: row.description, amount: row.amount,
            source: "expense_csv_import", sourceImportSessionId: session.id, originalFilename: session.originalFilename,
            createdAt: timestamp.toISOString(), updatedAt: timestamp.toISOString(), createdBy: request.appUser!.id, updatedBy: request.appUser!.id,
          }, recordedBy: request.appUser!.id, clientUpdatedAt: timestamp,
        });
        grandTotal += row.amount;
      }
      if (writes.length) await tx.insert(operationalRecords).values(writes);
      if (maxImportedNumber) await tx.insert(expenseVoucherSequences).values({
        workspaceId: params.data.workspaceId, scopeKey: voucherScopeKey(session.farmId, session.seasonId), lastNumber: maxImportedNumber,
      }).onConflictDoUpdate({
        target: [expenseVoucherSequences.workspaceId, expenseVoucherSequences.scopeKey],
        set: { lastNumber: sql`GREATEST(${expenseVoucherSequences.lastNumber}, excluded.last_number)`, updatedAt: new Date() },
      });
      await tx.update(expenseImportSessions).set({ status: "confirmed", confirmedAt: new Date() }).where(eq(expenseImportSessions.id, session.id));
      await tx.insert(auditLogs).values({
        workspaceId: params.data.workspaceId, farmId: session.farmId, userId: request.appUser!.id, action: "expense_csv_import_confirmed",
        entityType: "expense_import", entityId: session.id, details: { originalFilename: session.originalFilename, recordsCreated: writes.length, duplicatesSkipped, grandTotal },
      });
      return { recordsCreated: writes.length, duplicatesSkipped, grandTotal };
    });
    return { sessionId: session.id, result };
  });
}
