import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { closeDatabaseConnection, db } from "../src/db/client.js";
import {
  farms,
  attendanceImportSessions,
  auditLogs,
  expenseImportSessions,
  operationalRecords,
  seasons,
  userSessions,
  users,
  workspaceApprovals,
  workspaceMemberships,
  workspaces,
} from "../src/db/schema.js";

const now = new Date().toISOString();
const alpha = { workspaceId: randomUUID(), farmId: randomUUID(), seasonId: randomUUID(), userId: randomUUID(), token: `alpha-${randomUUID()}` };
const bravo = { workspaceId: randomUUID(), farmId: randomUUID(), seasonId: randomUUID(), userId: randomUUID(), token: `bravo-${randomUUID()}` };
const supervisor = { userId: randomUUID(), token: `supervisor-${randomUUID()}` };
const operator = { userId: randomUUID(), token: `operator-${randomUUID()}` };
const ids = [alpha.workspaceId, bravo.workspaceId];
let app: Awaited<ReturnType<typeof buildApp>>;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const request = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });
const envelope = (tenant: typeof alpha, entity: string, id = randomUUID(), record: Record<string, unknown> = {}) => ({
  workspaceId: tenant.workspaceId,
  farmId: tenant.farmId,
  seasonId: tenant.seasonId,
  entity,
  record: { id, createdAt: now, updatedAt: now, ...record },
});

before(async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL must point to an isolated migrated integration-test database.");
  await db.insert(workspaces).values([
    { id: alpha.workspaceId, name: "Workspace Alpha", slug: `alpha-${alpha.workspaceId}`, contactEmail: "alpha@example.test", status: "approved" },
    { id: bravo.workspaceId, name: "Workspace Bravo", slug: `bravo-${bravo.workspaceId}`, contactEmail: "bravo@example.test", status: "approved" },
  ]);
  await db.insert(users).values([
    { id: alpha.userId, email: `alpha-${alpha.userId}@example.test`, passwordHash: "test", status: "approved" },
    { id: bravo.userId, email: `bravo-${bravo.userId}@example.test`, passwordHash: "test", status: "approved" },
    { id: supervisor.userId, email: `supervisor-${supervisor.userId}@example.test`, passwordHash: "test", status: "approved" },
    { id: operator.userId, email: `operator-${operator.userId}@example.test`, passwordHash: "test", status: "approved" },
  ]);
  await db.insert(workspaceMemberships).values([
    { workspaceId: alpha.workspaceId, userId: alpha.userId, role: "workspace_owner" },
    { workspaceId: bravo.workspaceId, userId: bravo.userId, role: "workspace_owner" },
    { workspaceId: alpha.workspaceId, userId: supervisor.userId, role: "supervisor" },
    { workspaceId: alpha.workspaceId, userId: operator.userId, role: "operator" },
  ]);
  await db.insert(farms).values([
    { id: alpha.farmId, workspaceId: alpha.workspaceId, name: "Alpha Farm" },
    { id: bravo.farmId, workspaceId: bravo.workspaceId, name: "Bravo Farm" },
  ]);
  await db.insert(seasons).values([
    { id: alpha.seasonId, workspaceId: alpha.workspaceId, farmId: alpha.farmId, name: "Alpha Season", year: 2026, startsOn: "2026-01-01", status: "active" },
    { id: bravo.seasonId, workspaceId: bravo.workspaceId, farmId: bravo.farmId, name: "Bravo Season", year: 2026, startsOn: "2026-01-01", status: "active" },
  ]);
  await db.insert(userSessions).values([
    { userId: alpha.userId, workspaceId: alpha.workspaceId, activeFarmId: alpha.farmId, activeSeasonId: alpha.seasonId, tokenHash: hash(alpha.token), expiresAt: new Date(Date.now() + 60_000) },
    { userId: bravo.userId, workspaceId: bravo.workspaceId, activeFarmId: bravo.farmId, activeSeasonId: bravo.seasonId, tokenHash: hash(bravo.token), expiresAt: new Date(Date.now() + 60_000) },
    { userId: supervisor.userId, workspaceId: alpha.workspaceId, activeFarmId: alpha.farmId, activeSeasonId: alpha.seasonId, tokenHash: hash(supervisor.token), expiresAt: new Date(Date.now() + 60_000) },
    { userId: operator.userId, workspaceId: alpha.workspaceId, activeFarmId: alpha.farmId, activeSeasonId: alpha.seasonId, tokenHash: hash(operator.token), expiresAt: new Date(Date.now() + 60_000) },
  ]);
  app = await buildApp();
});

after(async () => {
  if (app) await app.close();
  await db.delete(attendanceImportSessions).where(inArray(attendanceImportSessions.workspaceId, ids));
  await db.delete(expenseImportSessions).where(inArray(expenseImportSessions.workspaceId, ids));
  await db.delete(auditLogs).where(inArray(auditLogs.workspaceId, ids));
  await db.delete(workspaceApprovals).where(inArray(workspaceApprovals.workspaceId, ids));
  await db.delete(operationalRecords).where(inArray(operationalRecords.workspaceId, ids));
  await db.delete(userSessions).where(inArray(userSessions.userId, [alpha.userId, bravo.userId, supervisor.userId, operator.userId]));
  await db.delete(seasons).where(inArray(seasons.workspaceId, ids));
  await db.delete(farms).where(inArray(farms.workspaceId, ids));
  await db.delete(workspaceMemberships).where(inArray(workspaceMemberships.workspaceId, ids));
  await db.delete(users).where(inArray(users.id, [alpha.userId, bravo.userId, supervisor.userId, operator.userId]));
  await db.delete(workspaces).where(inArray(workspaces.id, ids));
  await closeDatabaseConnection();
});

test("Alpha and Bravo operational records remain isolated", async () => {
  for (const entity of ["voucher", "attendance", "sale", "dispatch"]) {
    const alphaRecord = entity === "voucher" || entity === "sale" ? financialRecord(alpha, entity) : {};
    const bravoRecord = entity === "voucher" || entity === "sale" ? financialRecord(bravo, entity) : {};
    assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, entity, randomUUID(), alphaRecord))).statusCode, 200);
    assert.equal((await request(bravo.token, "POST", "/v1/workspace/operational-records", envelope(bravo, entity, randomUUID(), bravoRecord))).statusCode, 200);
  }
  const alphaAccountId = randomUUID(); const bravoAccountId = randomUUID();
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "account", alphaAccountId, { name: "Alpha Primary", type: "cash" }))).statusCode, 200);
  assert.equal((await request(bravo.token, "POST", "/v1/workspace/operational-records", envelope(bravo, "account", bravoAccountId, { name: "Bravo Primary", type: "cash" }))).statusCode, 200);
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "partnerEntry", randomUUID(), { date: "2026-06-01", partnerName: "Alpha Partner", type: "contribution", amount: 100, accountId: alphaAccountId }))).statusCode, 200);
  assert.equal((await request(bravo.token, "POST", "/v1/workspace/operational-records", envelope(bravo, "partnerEntry", randomUUID(), { date: "2026-06-01", partnerName: "Bravo Partner", type: "contribution", amount: 100, accountId: bravoAccountId }))).statusCode, 200);
  const alphaRecords = (await request(alpha.token, "GET", `/v1/workspace/${alpha.workspaceId}/operational-records`)).json().records;
  const bravoRecords = (await request(bravo.token, "GET", `/v1/workspace/${bravo.workspaceId}/operational-records`)).json().records;
  assert.equal(alphaRecords.length, 6);
  assert.equal(bravoRecords.length, 6);
  assert.ok(alphaRecords.every((record: { workspaceId: string }) => record.workspaceId === alpha.workspaceId));
  assert.ok(bravoRecords.every((record: { workspaceId: string }) => record.workspaceId === bravo.workspaceId));
  assert.equal((await request(alpha.token, "GET", `/v1/workspace/${bravo.workspaceId}/operational-records`)).statusCode, 403);
  assert.equal((await request(bravo.token, "GET", `/v1/workspace/${alpha.workspaceId}/operational-records`)).statusCode, 403);
});

test("CORS preflight and operational error responses allow the configured frontend origin", async () => {
  const origin = "http://localhost:5173";
  const preflight = await app.inject({
    method: "OPTIONS",
    url: "/v1/workspace/operational-records",
    headers: {
      origin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type,authorization,x-workspace-id,x-farm-id,x-season-id,x-requested-with",
    },
  });
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], origin);
  assert.match(String(preflight.headers["access-control-allow-methods"]), /GET, POST, PUT, PATCH, DELETE, OPTIONS/);
  assert.match(String(preflight.headers["access-control-allow-headers"]), /Content-Type, Authorization, X-Workspace-Id, X-Farm-Id, X-Season-Id, X-Requested-With/i);

  const invalidPost = await app.inject({
    method: "POST",
    url: "/v1/workspace/operational-records",
    headers: { origin, authorization: `Bearer ${alpha.token}` },
    payload: {},
  });
  assert.equal(invalidPost.statusCode, 400);
  assert.equal(invalidPost.headers["access-control-allow-origin"], origin);
});

test("attendance can be cleared idempotently only inside the active tenant context", async () => {
  const labourerId = randomUUID();
  const attendanceId = randomUUID();
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "labourer", labourerId, {
    name: "Toggle Worker", group: "General", dailyWage: 90,
  }))).statusCode, 200);
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "attendance", attendanceId, {
    labourerId, date: "2026-05-30", status: "present",
  }))).statusCode, 200);
  const reportPath = `/v1/workspace/${alpha.workspaceId}/attendance/report?farmId=${alpha.farmId}&seasonId=${alpha.seasonId}&from=2026-05-30&to=2026-05-30`;
  assert.equal((await request(alpha.token, "GET", reportPath)).json().records.some((record: { id: string }) => record.id === attendanceId), true);
  const clearPayload = {
    workspaceId: alpha.workspaceId, farmId: alpha.farmId, seasonId: alpha.seasonId, entity: "attendance", recordId: attendanceId,
  };
  assert.equal((await request(bravo.token, "DELETE", "/v1/workspace/operational-records", clearPayload)).statusCode, 403);
  assert.equal((await request(alpha.token, "DELETE", "/v1/workspace/operational-records", clearPayload)).statusCode, 204);
  assert.equal((await request(alpha.token, "DELETE", "/v1/workspace/operational-records", clearPayload)).statusCode, 204);
  const alphaRecords = (await request(alpha.token, "GET", `/v1/workspace/${alpha.workspaceId}/operational-records`)).json().records;
  assert.equal(alphaRecords.some((record: { record: { id: string } }) => record.record.id === attendanceId), false);
  assert.equal((await request(alpha.token, "GET", reportPath)).json().records.some((record: { id: string }) => record.id === attendanceId), false);
});

test("financial sync rejects accountless or invalid advances and soft deletes advances idempotently", async () => {
  const labourerId = randomUUID();
  const accountId = await createAccount(alpha, "Advance Deletion Cash");
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "labourer", labourerId, {
    name: "Deletion Worker", group: "General", dailyWage: 90,
  }))).statusCode, 200);
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "advance", randomUUID(), {
    labourerId, date: "2026-06-01", amount: 50,
  }))).statusCode, 400);
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "advance", randomUUID(), {
    labourerId, accountId, date: "2026-06-01", amount: -50,
  }))).statusCode, 400);
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "sale", randomUUID(), {
    date: "2026-06-01", amount: 50, buyerName: "Accountless Buyer", produceType: "Produce",
  }))).statusCode, 400);
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "voucher", randomUUID(), {
    date: "31/02/2026", amount: 50, accountId, description: "Malformed expense date",
  }))).statusCode, 400);
  const advanceId = randomUUID();
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "advance", advanceId, {
    labourerId, accountId, date: "2026-06-01", amount: 50, source: "manual",
  }))).statusCode, 200);
  const deletion = { workspaceId: alpha.workspaceId, farmId: alpha.farmId, seasonId: alpha.seasonId, entity: "advance", recordId: advanceId };
  assert.equal((await request(alpha.token, "DELETE", "/v1/workspace/operational-records", deletion)).statusCode, 204);
  assert.equal((await request(alpha.token, "DELETE", "/v1/workspace/operational-records", deletion)).statusCode, 204);
  const [stored] = await db.select().from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId, alpha.workspaceId), eq(operationalRecords.entityType, "advance"), eq(operationalRecords.clientRecordId, advanceId),
  ));
  assert.ok(stored?.payload.deletedAt);
  assert.equal((await db.select().from(auditLogs).where(and(
    eq(auditLogs.workspaceId, alpha.workspaceId), eq(auditLogs.action, "labour_advance_deleted"),
  ))).filter((audit) => audit.entityId === stored?.id).length, 1);
});

test("expense voucher deletion is scoped, permission checked, soft, audited, and hidden from search", async () => {
  const accountId = await createAccount(alpha, "Voucher Deletion Cash");
  const voucherId = randomUUID();
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "voucher", voucherId, {
    date: "2026-06-02", amount: 125, accountId, description: "Delete this voucher",
  }))).statusCode, 200);
  const deletion = { workspaceId: alpha.workspaceId, farmId: alpha.farmId, seasonId: alpha.seasonId, entity: "voucher", recordId: voucherId };
  assert.equal((await request(operator.token, "DELETE", "/v1/workspace/operational-records", deletion)).statusCode, 403);
  assert.equal((await request(bravo.token, "DELETE", "/v1/workspace/operational-records", deletion)).statusCode, 403);
  assert.equal((await request(alpha.token, "DELETE", "/v1/workspace/operational-records", deletion)).statusCode, 204);
  assert.equal((await request(alpha.token, "DELETE", "/v1/workspace/operational-records", deletion)).statusCode, 204);
  const [stored] = await db.select().from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId, alpha.workspaceId), eq(operationalRecords.entityType, "voucher"), eq(operationalRecords.clientRecordId, voucherId),
  ));
  assert.ok(stored?.payload.deletedAt);
  const result = await request(alpha.token, "GET", `/v1/workspace/${alpha.workspaceId}/expenses/search?farmId=${alpha.farmId}&seasonId=${alpha.seasonId}&search=delete`);
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().records.some((record: { id: string }) => record.id === voucherId), false);
  assert.equal((await db.select().from(auditLogs).where(and(
    eq(auditLogs.workspaceId, alpha.workspaceId), eq(auditLogs.action, "expense_voucher_deleted"),
  ))).filter((audit) => audit.entityId === stored?.id).length, 1);
});

test("attendance CSV advances require a tenant-owned payment account", async () => {
  const labourerId = randomUUID();
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "labourer", labourerId, {
    name: "Account Required CSV Worker", group: "General", dailyWage: 90,
  }))).statusCode, 200);
  const preview = await request(alpha.token, "POST", `/api/workspaces/${alpha.workspaceId}/attendance-imports/preview`, {
    farmId: alpha.farmId, seasonId: alpha.seasonId, originalFilename: "account-required.csv",
    csvText: ["Labour Name,2026-06-01", "Account Required CSV Worker,P (Adv:500)"].join("\n"),
  });
  assert.equal(preview.statusCode, 201);
  const blocked = await request(alpha.token, "POST", `/api/workspaces/${alpha.workspaceId}/attendance-imports/confirm`, {
    sessionId: preview.json().sessionId, duplicateMode: "missing_only", warningsConfirmed: false, mappings: [],
  });
  assert.equal(blocked.statusCode, 400);
  assert.equal(blocked.json().message, "Payment account is required for imported advances.");
});
const createAccount = async (tenant: typeof alpha, name: string) => {
  const id = randomUUID();
  assert.equal((await request(tenant.token, "POST", "/v1/workspace/operational-records", envelope(tenant, "account", id, { name, type: "cash" }))).statusCode, 200);
  return id;
};
const financialRecord = (tenant: typeof alpha, entity: "sale" | "voucher", record: Record<string, unknown> = {}) => ({
  date: "2026-06-01", amount: 100, accountId: `${tenant.seasonId}:local-cash`,
  ...(entity === "sale" ? { buyerName: "Buyer", produceType: "Produce" } : { description: "Expense" }),
  ...record,
});

test("attendance sync reconciles different offline UUIDs into one tenant-scoped daily record", async () => {
  const labourerId = randomUUID();
  const firstAttendanceId = randomUUID();
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "labourer", labourerId, {
    name: "Offline Reconciliation Worker", group: "General", dailyWage: 90,
  }))).statusCode, 200);
  const first = await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "attendance", firstAttendanceId, {
    labourerId, date: "2026-06-01", status: "present",
  }));
  assert.equal(first.statusCode, 200);
  const second = await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "attendance", randomUUID(), {
    labourerId, date: "2026-06-01", status: "absent", updatedAt: new Date(Date.now() + 1_000).toISOString(),
  }));
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().record.id, firstAttendanceId);
  assert.equal(second.json().record.status, "absent");
  const records = await db.select().from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId, alpha.workspaceId),
    eq(operationalRecords.farmId, alpha.farmId),
    eq(operationalRecords.seasonId, alpha.seasonId),
    eq(operationalRecords.entityType, "attendance"),
  ));
  assert.equal(records.filter((record) => record.payload.labourerId === labourerId && record.payload.date === "2026-06-01").length, 1);
});

test("foreign farm, season, account, ledger, and approval references are rejected", async () => {
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", {
    ...envelope(alpha, "sale", randomUUID(), financialRecord(alpha, "sale")), farmId: bravo.farmId, seasonId: bravo.seasonId,
  })).statusCode, 403);
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", {
    ...envelope(alpha, "sale", randomUUID(), financialRecord(alpha, "sale")), seasonId: bravo.seasonId,
  })).statusCode, 403);

  const bravoAccount = randomUUID();
  assert.equal((await request(bravo.token, "POST", "/v1/workspace/operational-records", envelope(bravo, "account", bravoAccount))).statusCode, 200);
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "sale", randomUUID(), financialRecord(alpha, "sale", { accountId: bravoAccount })))).statusCode, 403);

  const bravoLedger = randomUUID();
  assert.equal((await request(bravo.token, "POST", "/v1/workspace/operational-records", envelope(bravo, "partnerEntry", bravoLedger, { date: "2026-06-01", partnerName: "Bravo Partner", type: "contribution", amount: 100, accountId: bravoAccount }))).statusCode, 200);
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "partnerEntry", randomUUID(), { date: "2026-06-01", partnerName: "Alpha Partner", type: "contribution", amount: 100, accountId: `${alpha.seasonId}:local-cash`, ledgerId: bravoLedger }))).statusCode, 403);

  const bravoExpense = randomUUID();
  assert.equal((await request(bravo.token, "POST", "/v1/workspace/operational-records", envelope(bravo, "voucher", bravoExpense, financialRecord(bravo, "voucher")))).statusCode, 200);
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/approvals", {
    workspaceId: alpha.workspaceId, entityType: "expense", entityId: bravoExpense,
  })).statusCode, 403);
});

test("approval queues remain isolated", async () => {
  const alphaExpense = randomUUID();
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "voucher", alphaExpense, financialRecord(alpha, "voucher")))).statusCode, 200);
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/approvals", {
    workspaceId: alpha.workspaceId, entityType: "expense", entityId: alphaExpense,
  })).statusCode, 201);
  assert.equal((await request(bravo.token, "GET", `/v1/workspace/${alpha.workspaceId}/approvals`)).statusCode, 403);
  assert.equal((await request(alpha.token, "GET", `/v1/workspace/${alpha.workspaceId}/approvals`)).json().approvals.length, 1);
});

test("expense categories seed defaults, protect system values, and isolate workspace custom subcategories", async () => {
  const alphaList = await request(alpha.token, "GET", `/v1/workspace/${alpha.workspaceId}/expense-categories`);
  assert.equal(alphaList.statusCode, 200);
  assert.equal(alphaList.json().categories.length, 10);
  const other = alphaList.json().categories.find((category: { name: string }) => category.name === "Other");
  assert.ok(other.subcategories.some((subcategory: { name: string }) => subcategory.name === "Miscellaneous"));
  const fuel = alphaList.json().categories.find((category: { name: string }) => category.name === "Fuel & POL");
  const diesel = fuel.subcategories.find((subcategory: { name: string }) => subcategory.name === "Diesel");

  const fallbackVoucher = await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "voucher", randomUUID(), financialRecord(alpha, "voucher")));
  assert.equal(fallbackVoucher.statusCode, 200);
  assert.equal(fallbackVoucher.json().record.category, "Other");
  assert.equal(fallbackVoucher.json().record.subcategory, "Miscellaneous");
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "voucher", randomUUID(), {
    ...financialRecord(alpha, "voucher"), categoryId: randomUUID(), subcategoryId: randomUUID(),
  }))).statusCode, 403);

  const created = await request(alpha.token, "POST", `/v1/workspace/${alpha.workspaceId}/expense-subcategories`, {
    categoryId: fuel.id, name: "Generator Fuel",
  });
  assert.equal(created.statusCode, 201);
  const customId = created.json().subcategory.id as string;
  assert.equal((await request(alpha.token, "PATCH", `/v1/workspace/${alpha.workspaceId}/expense-subcategories/${customId}`, { name: "Generator Diesel" })).statusCode, 200);
  assert.equal((await request(alpha.token, "PATCH", `/v1/workspace/${alpha.workspaceId}/expense-subcategories/${diesel.id}`, { active: false })).statusCode, 403);
  assert.equal((await request(bravo.token, "PATCH", `/v1/workspace/${alpha.workspaceId}/expense-subcategories/${customId}`, { active: false })).statusCode, 403);
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "voucher", randomUUID(), {
    ...financialRecord(alpha, "voucher"), categoryId: fuel.id, subcategoryId: customId,
  }))).statusCode, 200);
  assert.equal((await request(alpha.token, "PATCH", `/v1/workspace/${alpha.workspaceId}/expense-subcategories/${customId}`, { active: false })).statusCode, 200);
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "voucher", randomUUID(), {
    ...financialRecord(alpha, "voucher"), categoryId: fuel.id, subcategoryId: customId,
  }))).statusCode, 403);
});

test("expense CSV import resolves unique names once, preserves repeated voucher numbers, and skips duplicate re-imports", async () => {
  const csvText = [
    "Legacy report metadata",
    "Voucher No,Date,Paid From,Expense Category,Details,Value",
    ...Array.from({ length: 52 }, (_, index) =>
      `V-0042,${String(index % 28 + 1).padStart(2, "0")}/05/2026,Historical Cash,Legacy Field Cost,Imported line ${index + 1},${index + 1}`,
    ),
  ].join("\n");
  const input = { farmId: alpha.farmId, seasonId: alpha.seasonId, originalFilename: "historical-expenses.csv", csvText };
  const preview = await request(alpha.token, "POST", `/api/workspaces/${alpha.workspaceId}/expense-imports/preview`, input);
  assert.equal(preview.statusCode, 201);
  assert.equal(preview.json().preview.summary.totalRows, 52);
  assert.deepEqual(preview.json().preview.summary.missingAccounts, ["Historical Cash"]);
  assert.deepEqual(preview.json().preview.summary.missingCategories, ["Legacy Field Cost"]);
  assert.equal(preview.json().preview.summary.grandTotal, 1378);
  assert.equal((await request(bravo.token, "POST", `/api/workspaces/${alpha.workspaceId}/expense-imports/preview`, input)).statusCode, 403);

  const confirmInput = {
    importSessionId: preview.json().sessionId, farmId: alpha.farmId, seasonId: alpha.seasonId, skipDuplicates: true,
    accountMappings: [{ sourceName: "Historical Cash", action: "create" }],
    categoryMappings: [{ sourceName: "Legacy Field Cost", action: "create" }],
  };
  const confirmed = await request(alpha.token, "POST", `/api/workspaces/${alpha.workspaceId}/expense-imports/confirm`, confirmInput);
  assert.equal(confirmed.statusCode, 200);
  assert.deepEqual(confirmed.json().result, { recordsCreated: 52, duplicatesSkipped: 0, grandTotal: 1378 });
  const imported = (await db.select().from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId, alpha.workspaceId), eq(operationalRecords.entityType, "voucher"),
  ))).filter((record) => record.payload.source === "expense_csv_import" && record.payload.originalFilename === "historical-expenses.csv");
  assert.equal(imported.length, 52);
  assert.ok(imported.every((record) => record.payload.voucherNumber === "V-0042"));

  const repeatPreview = await request(alpha.token, "POST", `/api/workspaces/${alpha.workspaceId}/expense-imports/preview`, input);
  assert.equal(repeatPreview.statusCode, 201);
  assert.equal(repeatPreview.json().preview.summary.duplicateRows, 52);
  const repeat = await request(alpha.token, "POST", `/api/workspaces/${alpha.workspaceId}/expense-imports/confirm`, {
    importSessionId: repeatPreview.json().sessionId, farmId: alpha.farmId, seasonId: alpha.seasonId, skipDuplicates: true,
    accountMappings: [], categoryMappings: [],
  });
  assert.equal(repeat.statusCode, 200);
  assert.deepEqual(repeat.json().result, { recordsCreated: 0, duplicatesSkipped: 52, grandTotal: 0 });
});

test("partner ledger edits and soft deletes recalculate balances, remain tenant safe, and create audits", async () => {
  const accountA = randomUUID(); const accountB = randomUUID();
  const contributionId = randomUUID(); const withdrawalId = randomUUID();
  const accountPayload = (name: string) => ({ name, type: "cash" });
  const timestamp = (offset: number) => new Date(Date.now() + offset).toISOString();
  const partnerPayload = (id: string, entry: Record<string, unknown>, offset = 0) => ({
    ...envelope(alpha, "partnerEntry", id, entry),
    record: { ...envelope(alpha, "partnerEntry", id, entry).record, updatedAt: timestamp(offset) },
  });
  const readBalances = async () => {
    const records = (await db.select().from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, alpha.workspaceId),
      eq(operationalRecords.entityType, "partnerEntry"),
    ))).filter((record) => [contributionId, withdrawalId].includes(record.clientRecordId) && !record.payload.deletedAt);
    return records.reduce((totals, record) => {
      const amount = Number(record.payload.amount);
      const effect = record.payload.type === "contribution" ? amount : -amount;
      totals.partner += effect;
      totals.accounts[String(record.payload.accountId)] = (totals.accounts[String(record.payload.accountId)] ?? 0) + effect;
      return totals;
    }, { partner: 0, accounts: {} as Record<string, number> });
  };

  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "account", accountA, accountPayload("Partner Cash A")))).statusCode, 200);
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "account", accountB, accountPayload("Partner Cash B")))).statusCode, 200);
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", partnerPayload(contributionId, {
    date: "2026-06-01", partnerName: "Partner A", type: "contribution", amount: 100, accountId: accountA, notes: "Initial capital",
  }, 1_000))).statusCode, 200);
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", partnerPayload(contributionId, {
    date: "2026-06-02", partnerName: "Partner A", type: "contribution", amount: 175, accountId: accountB, notes: "Moved account",
  }, 2_000))).statusCode, 200);
  assert.deepEqual(await readBalances(), { partner: 175, accounts: { [accountB]: 175 } });

  assert.equal((await request(operator.token, "POST", "/v1/workspace/operational-records", partnerPayload(contributionId, {
    date: "2026-06-02", partnerName: "Partner A", type: "contribution", amount: 999, accountId: accountB,
  }, 3_000))).statusCode, 403);
  assert.equal((await request(operator.token, "DELETE", "/v1/workspace/operational-records", {
    workspaceId: alpha.workspaceId, farmId: alpha.farmId, seasonId: alpha.seasonId, entity: "partnerEntry", recordId: contributionId,
  })).statusCode, 403);

  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", partnerPayload(withdrawalId, {
    date: "2026-06-03", partnerName: "Partner B", type: "withdrawal", amount: 80, accountId: accountA,
  }, 4_000))).statusCode, 200);
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", partnerPayload(withdrawalId, {
    date: "2026-06-04", partnerName: "Partner B", type: "withdrawal", amount: 30, accountId: accountB,
  }, 5_000))).statusCode, 200);
  assert.deepEqual(await readBalances(), { partner: 145, accounts: { [accountB]: 145 } });

  assert.equal((await request(bravo.token, "DELETE", "/v1/workspace/operational-records", {
    workspaceId: alpha.workspaceId, farmId: alpha.farmId, seasonId: alpha.seasonId, entity: "partnerEntry", recordId: contributionId,
  })).statusCode, 403);
  assert.equal((await request(alpha.token, "DELETE", "/v1/workspace/operational-records", {
    workspaceId: alpha.workspaceId, farmId: alpha.farmId, seasonId: alpha.seasonId, entity: "partnerEntry", recordId: contributionId, reason: "Correction",
  })).statusCode, 204);
  assert.deepEqual(await readBalances(), { partner: -30, accounts: { [accountB]: -30 } });
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", partnerPayload(contributionId, {
    date: "2026-06-05", partnerName: "Partner A", type: "contribution", amount: 999, accountId: accountA,
  }, 6_000))).statusCode, 409);
  assert.equal((await request(alpha.token, "DELETE", "/v1/workspace/operational-records", {
    workspaceId: alpha.workspaceId, farmId: alpha.farmId, seasonId: alpha.seasonId, entity: "partnerEntry", recordId: withdrawalId, reason: "Correction",
  })).statusCode, 204);
  assert.deepEqual(await readBalances(), { partner: 0, accounts: {} });

  const audits = await db.select().from(auditLogs).where(and(
    eq(auditLogs.workspaceId, alpha.workspaceId),
    inArray(auditLogs.action, ["partner_ledger_updated", "partner_ledger_deleted"]),
  ));
  assert.equal(audits.filter((audit) => audit.action === "partner_ledger_updated").length, 2);
  assert.equal(audits.filter((audit) => audit.action === "partner_ledger_deleted").length, 2);
  assert.equal(audits.find((audit) => audit.action === "partner_ledger_deleted")?.details.reason, "Correction");
});

test("partner settlements move only partner positions and remain idempotent, editable, reversible, and tenant scoped", async () => {
  const settlementId = randomUUID();
  const younisAccountId = randomUUID(); const sajidAccountId = randomUUID();
  const younisName = "Settlement Younis Khan"; const sajidName = "Settlement Sajid Khan";
  const timestamp = (offset: number) => new Date(Date.now() + offset).toISOString();
  const settlementPayload = (id: string, fromAccountId: string, toAccountId: string, fromPartner: string, toPartner: string, amount: number, offset: number) => ({
    ...envelope(alpha, "partnerEntry", id, {
      date: "2026-06-01", type: "settlement", fromAccountId, toAccountId, fromPartner, toPartner, amount, notes: "Share of farm expenses",
    }),
    record: {
      ...envelope(alpha, "partnerEntry", id, {}).record,
      date: "2026-06-01", type: "settlement", fromAccountId, toAccountId, fromPartner, toPartner, amount, notes: "Share of farm expenses", updatedAt: timestamp(offset),
    },
  });
  const operationalTotals = async () => {
    const records = await db.select().from(operationalRecords).where(eq(operationalRecords.workspaceId, alpha.workspaceId));
    const total = (entity: string) => records.filter((record) => record.entityType === entity && !record.payload.deletedAt)
      .reduce((sum, record) => sum + Number(record.payload.amount ?? 0), 0);
    return { vouchers: total("voucher"), sales: total("sale"), advances: total("advance") };
  };
  const positions = async () => {
    const records = (await db.select().from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, alpha.workspaceId),
      eq(operationalRecords.entityType, "partnerEntry"),
      eq(operationalRecords.clientRecordId, settlementId),
    ))).filter((record) => !record.payload.deletedAt);
    return records.reduce((result, record) => {
      const amount = Number(record.payload.amount);
      result[String(record.payload.fromPartner)] = (result[String(record.payload.fromPartner)] ?? 0) - amount;
      result[String(record.payload.toPartner)] = (result[String(record.payload.toPartner)] ?? 0) + amount;
      return result;
    }, {} as Record<string, number>);
  };
  const accountPositions = async () => {
    const accounts = (await db.select().from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, alpha.workspaceId),
      eq(operationalRecords.entityType, "account"),
    ))).filter((record) => [younisAccountId, sajidAccountId].includes(record.clientRecordId));
    const settlements = (await db.select().from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, alpha.workspaceId),
      eq(operationalRecords.entityType, "partnerEntry"),
      eq(operationalRecords.clientRecordId, settlementId),
    ))).filter((record) => !record.payload.deletedAt);
    return Object.fromEntries(accounts.map((account) => {
      const name = String(account.payload.name);
      const amount = settlements.reduce((sum, entry) => sum
        + (String(entry.payload.toAccountId) === account.clientRecordId ? Number(entry.payload.amount) : 0)
        - (String(entry.payload.fromAccountId) === account.clientRecordId ? Number(entry.payload.amount) : 0), 0);
      return [name, amount];
    }));
  };
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "account", younisAccountId, { name: younisName, type: "partner" }))).statusCode, 200);
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "account", sajidAccountId, { name: sajidName, type: "partner" }))).statusCode, 200);
  const totalsBefore = await operationalTotals();

  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", settlementPayload(settlementId, younisAccountId, sajidAccountId, younisName, sajidName, 101_140, 1_000))).statusCode, 200);
  assert.deepEqual(await positions(), { [younisName]: -101_140, [sajidName]: 101_140 });
  assert.deepEqual(await accountPositions(), { [younisName]: -101_140, [sajidName]: 101_140 });
  assert.deepEqual(await operationalTotals(), totalsBefore);

  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", settlementPayload(settlementId, younisAccountId, sajidAccountId, younisName, sajidName, 101_140, 2_000))).statusCode, 200);
  assert.equal((await db.select().from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId, alpha.workspaceId), eq(operationalRecords.entityType, "partnerEntry"), eq(operationalRecords.clientRecordId, settlementId),
  ))).length, 1);
  assert.deepEqual(await positions(), { [younisName]: -101_140, [sajidName]: 101_140 });
  assert.deepEqual(await accountPositions(), await positions());

  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", settlementPayload(settlementId, younisAccountId, sajidAccountId, younisName, sajidName, 90_000, 3_000))).statusCode, 200);
  assert.deepEqual(await positions(), { [younisName]: -90_000, [sajidName]: 90_000 });
  assert.deepEqual(await accountPositions(), await positions());
  assert.deepEqual(await operationalTotals(), totalsBefore);

  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", settlementPayload(randomUUID(), sajidAccountId, sajidAccountId, "Sajid Khan", "sajid khan", 100, 4_000))).statusCode, 400);
  assert.equal((await request(bravo.token, "POST", "/v1/workspace/operational-records", {
    ...settlementPayload(randomUUID(), younisAccountId, sajidAccountId, "Bravo Payer", "Bravo Receiver", 100, 5_000), workspaceId: alpha.workspaceId,
  })).statusCode, 403);

  assert.equal((await request(alpha.token, "DELETE", "/v1/workspace/operational-records", {
    workspaceId: alpha.workspaceId, farmId: alpha.farmId, seasonId: alpha.seasonId, entity: "partnerEntry", recordId: settlementId, reason: "Settlement corrected",
  })).statusCode, 204);
  assert.deepEqual(await positions(), {});
  assert.deepEqual(await accountPositions(), { [younisName]: 0, [sajidName]: 0 });
  assert.deepEqual(await operationalTotals(), totalsBefore);
});

test("expense CSV import accepts blank legacy descriptions and reports row-specific mandatory field issues", async () => {
  const accountId = randomUUID();
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "account", accountId, {
    name: "Legacy Validation Cash", type: "cash",
  }))).statusCode, 200);
  const csvText = [
    "Legacy expenditure report",
    "Generated for archive migration",
    "Voucher,Date,Deduction Account,Category,Description,Amount",
    "V-0200,2026-05-01,Legacy Validation Cash,Other,,10",
    "V-0201,2026-05-02,Legacy Validation Cash,,,20",
  ].join("\n");
  const input = { farmId: alpha.farmId, seasonId: alpha.seasonId, originalFilename: "blank-descriptions.csv", csvText };
  const preview = await request(alpha.token, "POST", `/api/workspaces/${alpha.workspaceId}/expense-imports/preview`, input);
  assert.equal(preview.statusCode, 201);
  assert.equal(preview.json().preview.summary.readyRows, 2);
  assert.deepEqual(preview.json().preview.summary.errors, []);
  assert.equal(preview.json().preview.rows[0].description, "Other");
  assert.equal(preview.json().preview.rows[1].description, "Imported expense");
  const confirmed = await request(alpha.token, "POST", `/api/workspaces/${alpha.workspaceId}/expense-imports/confirm`, {
    importSessionId: preview.json().sessionId, farmId: alpha.farmId, seasonId: alpha.seasonId, skipDuplicates: true,
    accountMappings: [], categoryMappings: [],
  });
  assert.equal(confirmed.statusCode, 200);
  assert.equal(confirmed.json().result.recordsCreated, 2);
  const imported = (await db.select().from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId, alpha.workspaceId), eq(operationalRecords.entityType, "voucher"),
  ))).filter((record) => record.payload.originalFilename === "blank-descriptions.csv");
  assert.deepEqual(imported.map((record) => record.payload.description).sort(), ["Imported expense", "Other"]);

  const invalid = await request(alpha.token, "POST", `/api/workspaces/${alpha.workspaceId}/expense-imports/preview`, {
    farmId: alpha.farmId, seasonId: alpha.seasonId, originalFilename: "invalid-legacy-expenses.csv",
    csvText: [
      "Legacy expenditure report",
      "Voucher,Date,Deduction Account,Category,Description,Amount",
      ",2026-05-01,Legacy Validation Cash,Other,No voucher,10",
      "V-0301,,Legacy Validation Cash,Other,No date,11",
      "V-0302,2026-05-03,Legacy Validation Cash,Other,No amount,",
      "V-0303,2026-05-04,Missing Cash,Other,Missing mapped account,12",
      "V-0304,2026-05-05,,Other,Missing deduction account,13",
    ].join("\n"),
  });
  assert.equal(invalid.statusCode, 201);
  assert.deepEqual(invalid.json().preview.summary.missingAccounts, ["Missing Cash"]);
  assert.ok(invalid.json().preview.summary.mappingIssues.includes('Row 6: Deduction account "Missing Cash" was not found. Map it or create it before import.'));
  assert.ok(invalid.json().preview.summary.errors.includes("Row 3: Voucher number is required."));
  assert.ok(invalid.json().preview.summary.errors.includes("Row 4: Expense date is required."));
  assert.ok(invalid.json().preview.summary.errors.includes("Row 5: Amount is required."));
  assert.ok(invalid.json().preview.summary.errors.includes("Row 7: Deduction account is required."));
});

test("expense CSV import normalizes mixed legacy date formats and rejects impossible dates", async () => {
  const accountId = randomUUID();
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "account", accountId, {
    name: "Mixed Date Cash", type: "cash",
  }))).statusCode, 200);
  const preview = await request(alpha.token, "POST", `/api/workspaces/${alpha.workspaceId}/expense-imports/preview`, {
    farmId: alpha.farmId, seasonId: alpha.seasonId, originalFilename: "mixed-expense-dates.csv",
    csvText: [
      "Historical expenditure register",
      "Voucher,Date,Deduction Account,Category,Description,Amount",
      "V-0400,3/31/2026,Mixed Date Cash,Other,US short date,10",
      "V-0401,4/13/2026,Mixed Date Cash,Other,US date,11",
      "V-0402,13/04/2026,Mixed Date Cash,Other,Day first date,12",
      "V-0403,2026-04-16,Mixed Date Cash,Other,ISO date,13",
      "V-0404,2/29/2024,Mixed Date Cash,Other,Leap day,14",
      "V-0405,31-03-2026,Mixed Date Cash,Other,Day first hyphen,15",
      "V-0406,04-30-2026,Mixed Date Cash,Other,US hyphen,16",
      "V-0407,4/5/2026,Mixed Date Cash,Other,Inferred US ambiguous date,17",
      "V-0408,31/02/2026,Mixed Date Cash,Other,Impossible date,18",
    ].join("\n"),
  });
  assert.equal(preview.statusCode, 201);
  assert.deepEqual(preview.json().preview.rows.map((row: { date: string }) => row.date), [
    "2026-03-31", "2026-04-13", "2026-04-13", "2026-04-16", "2024-02-29",
    "2026-03-31", "2026-04-30", "2026-04-05", "",
  ]);
  assert.equal(preview.json().preview.summary.readyRows, 8);
  assert.ok(preview.json().preview.summary.errors.includes(
    "Row 11: Unable to parse date '31/02/2026'. Supported formats: YYYY-MM-DD, DD/MM/YYYY, MM/DD/YYYY.",
  ));
});

test("expense vouchers receive scoped readable numbers and keep them when edited", async () => {
  const firstId = randomUUID();
  const first = await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "voucher", firstId, {
    ...financialRecord(alpha, "voucher"), date: "2026-05-20", description: "Original expense", amount: 100,
  }));
  assert.equal(first.statusCode, 200);
  assert.match(first.json().record.voucherNumber, /^V-\d{4}$/);
  assert.ok(Number(first.json().record.voucherNumber.slice(2)) > 42);

  const [second, third] = await Promise.all([
    request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "voucher", randomUUID(), {
      ...financialRecord(alpha, "voucher"), date: "2026-05-21", description: "Concurrent expense A", amount: 120,
    })),
    request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "voucher", randomUUID(), {
      ...financialRecord(alpha, "voucher"), date: "2026-05-21", description: "Concurrent expense B", amount: 140,
    })),
  ]);
  assert.equal(second.statusCode, 200);
  assert.equal(third.statusCode, 200);
  assert.notEqual(second.json().record.voucherNumber, third.json().record.voucherNumber);

  const edited = await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "voucher", firstId, {
    createdAt: first.json().record.createdAt,
    updatedAt: new Date(Date.now() + 1_000).toISOString(),
    voucherNumber: "V-9999",
    accountId: `${alpha.seasonId}:local-cash`,
    date: "2026-05-22",
    description: "Corrected expense",
    amount: 175,
  }));
  assert.equal(edited.statusCode, 200);
  assert.equal(edited.json().record.voucherNumber, first.json().record.voucherNumber);
  assert.equal(edited.json().record.description, "Corrected expense");
  assert.equal(edited.json().record.amount, 175);
  assert.equal((await db.select().from(auditLogs).where(and(
    eq(auditLogs.workspaceId, alpha.workspaceId),
    eq(auditLogs.action, "expense_voucher_updated"),
  ))).some((item) => item.details && (item.details as { clientRecordId?: string }).clientRecordId === firstId), true);
});

test("expense voucher search matches common fields, composes filters, and stays tenant scoped", async () => {
  const alphaAccountId = randomUUID();
  const bravoAccountId = randomUUID();
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "account", alphaAccountId, {
    name: "Younis Khan Search Account", type: "cash",
  }))).statusCode, 200);
  assert.equal((await request(bravo.token, "POST", "/v1/workspace/operational-records", envelope(bravo, "account", bravoAccountId, {
    name: "Younis Khan Search Account", type: "cash",
  }))).statusCode, 200);
  const alphaVoucherId = randomUUID();
  const bravoVoucherId = randomUUID();
  const alphaVoucher = await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "voucher", alphaVoucherId, {
    date: "2026-05-30", description: "Labour field supplies", notes: "Weekly labour items", amount: 1683,
    vendor: "Camp Vendor", accountId: alphaAccountId,
  }));
  assert.equal(alphaVoucher.statusCode, 200);
  assert.equal((await request(bravo.token, "POST", "/v1/workspace/operational-records", envelope(bravo, "voucher", bravoVoucherId, {
    date: "2026-05-30", description: "Labour field supplies", amount: 1683, vendor: "Camp Vendor", accountId: bravoAccountId,
  }))).statusCode, 200);
  const path = `/v1/workspace/${alpha.workspaceId}/expenses/search?farmId=${alpha.farmId}&seasonId=${alpha.seasonId}`;
  for (const search of [alphaVoucher.json().record.voucherNumber, "younis", "labour", "1683", "05/30"]) {
    const result = await request(alpha.token, "GET", `${path}&search=${encodeURIComponent(search)}`);
    assert.equal(result.statusCode, 200);
    assert.ok(result.json().records.some((record: { id: string }) => record.id === alphaVoucherId));
    assert.ok(result.json().records.every((record: { id: string }) => record.id !== bravoVoucherId));
  }
  const combined = await request(alpha.token, "GET", `${path}&from=2026-05-30&to=2026-05-30&category=Other&subcategory=Miscellaneous&accountId=${alphaAccountId}&vendor=camp`);
  assert.equal(combined.statusCode, 200);
  assert.ok(combined.json().records.some((record: { id: string }) => record.id === alphaVoucherId));
  assert.equal((await request(alpha.token, "GET", `${path}&accountId=${bravoAccountId}`)).statusCode, 403);
  assert.equal((await request(bravo.token, "GET", path)).statusCode, 403);
});

test("attendance reports calculate payable wages and reject foreign workspace or farm labour", async () => {
  const labourerId = randomUUID();
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "labourer", labourerId, {
    name: "Alpha Worker", group: "General", dailyWage: 120,
  }))).statusCode, 200);
  for (const [date, status] of [["2026-05-01", "present"], ["2026-05-02", "half_day"], ["2026-05-03", "absent"]] as const) {
    assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "attendance", randomUUID(), {
      labourerId, date, status,
    }))).statusCode, 200);
  }
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "advance", randomUUID(), {
    labourerId, accountId: `${alpha.seasonId}:local-cash`, date: "2026-05-02", amount: 45, notes: "Midweek advance",
  }))).statusCode, 200);
  const path = `/v1/workspace/${alpha.workspaceId}/attendance/report?farmId=${alpha.farmId}&seasonId=${alpha.seasonId}&from=2026-05-01&to=2026-05-03`;
  const report = await request(alpha.token, "GET", path);
  assert.equal(report.statusCode, 200);
  assert.equal(report.json().records.length, 3);
  assert.deepEqual(report.json().advances.map((item: { labourerId: string; date: string; amount: number }) => item), [
    { id: report.json().advances[0].id, labourerId, date: "2026-05-02", amount: 45 },
  ]);
  assert.deepEqual(report.json().summaries[0], {
    id: labourerId, name: "Alpha Worker", dailyWage: 120, presentDays: 1, halfDays: 1, absentDays: 1,
    payableDays: 1.5, totalWage: 180, records: report.json().summaries[0].records,
  });

  assert.equal((await request(alpha.token, "GET",
    `/v1/workspace/${bravo.workspaceId}/attendance/report?farmId=${bravo.farmId}&seasonId=${bravo.seasonId}&from=2026-05-01&to=2026-05-03`,
  )).statusCode, 403);

  const secondFarmId = randomUUID();
  const foreignLabourerId = randomUUID();
  await db.insert(farms).values({ id: secondFarmId, workspaceId: alpha.workspaceId, name: "Alpha Report Farm" });
  await db.insert(operationalRecords).values({
    workspaceId: alpha.workspaceId, farmId: secondFarmId, clientRecordId: foreignLabourerId,
    entityType: "labourer", payload: { id: foreignLabourerId, name: "Foreign Farm Worker", dailyWage: 90, createdAt: now, updatedAt: now },
    recordedBy: alpha.userId, clientUpdatedAt: new Date(now),
  });
  assert.equal((await request(alpha.token, "GET", `${path}&labourId=${foreignLabourerId}`)).statusCode, 403);
});

test("advance reports return labour-grouped totals and enforce tenant-scoped labour filters", async () => {
  const labourerId = randomUUID();
  const foreignLabourerId = randomUUID();
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "labourer", labourerId, {
    name: "Advance Worker", group: "General", dailyWage: 100,
  }))).statusCode, 200);
  assert.equal((await request(bravo.token, "POST", "/v1/workspace/operational-records", envelope(bravo, "labourer", foreignLabourerId, {
    name: "Bravo Advance Worker", group: "General", dailyWage: 100,
  }))).statusCode, 200);
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "advance", randomUUID(), {
    labourerId, accountId: `${alpha.seasonId}:local-cash`, date: "2026-05-04", amount: 120, notes: "Seed cash",
  }))).statusCode, 200);
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "advance", randomUUID(), {
    labourerId, accountId: `${alpha.seasonId}:local-cash`, date: "2026-05-05", amount: 80, notes: "Food",
  }))).statusCode, 200);
  const path = `/v1/workspace/${alpha.workspaceId}/advance/report?farmId=${alpha.farmId}&seasonId=${alpha.seasonId}&from=2026-05-04&to=2026-05-05`;
  const report = await request(alpha.token, "GET", path);
  assert.equal(report.statusCode, 200);
  assert.equal(report.json().records.length, 2);
  assert.equal(report.json().summaries.length, 1);
  assert.equal(report.json().summaries[0].labourerId, labourerId);
  assert.equal(report.json().summaries[0].total, 200);
  assert.equal(report.json().grandTotal, 200);
  assert.equal((await request(alpha.token, "GET", `${path}&labourIds=${foreignLabourerId}`)).statusCode, 403);
  assert.equal((await request(alpha.token, "GET",
    `/v1/workspace/${bravo.workspaceId}/advance/report?farmId=${bravo.farmId}&seasonId=${bravo.seasonId}&from=2026-05-04&to=2026-05-05`,
  )).statusCode, 403);
});

test("labour advance account backfill maps Younis Khan per workspace, skips missing scopes, and is idempotent", async () => {
  const alphaYounisId = randomUUID();
  const bravoYounisId = randomUUID();
  const alphaCashId = randomUUID();
  const alphaLabourerId = randomUUID();
  const bravoLabourerId = randomUUID();
  const alphaAdvanceId = randomUUID();
  const bravoAdvanceId = randomUUID();
  for (const [tenant, accountId, name] of [
    [alpha, alphaYounisId, "Younis Khan"],
    [alpha, alphaCashId, "Cash"],
    [bravo, bravoYounisId, "  younis KHAN  "],
  ] as const) {
    assert.equal((await request(tenant.token, "POST", "/v1/workspace/operational-records", envelope(tenant, "account", accountId, { name, type: "cash" }))).statusCode, 200);
  }
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "labourer", alphaLabourerId, {
    name: "Alpha Backfill Worker", group: "General", dailyWage: 90,
  }))).statusCode, 200);
  assert.equal((await request(bravo.token, "POST", "/v1/workspace/operational-records", envelope(bravo, "labourer", bravoLabourerId, {
    name: "Bravo Backfill Worker", group: "General", dailyWage: 90,
  }))).statusCode, 200);
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "advance", alphaAdvanceId, {
    labourerId: alphaLabourerId, accountId: alphaCashId, date: "2026-05-06", amount: 300, notes: "Correct this account only",
  }))).statusCode, 200);
  await db.insert(operationalRecords).values({
    workspaceId: bravo.workspaceId, farmId: bravo.farmId, seasonId: bravo.seasonId, clientRecordId: bravoAdvanceId,
    entityType: "advance", payload: { id: bravoAdvanceId, labourerId: bravoLabourerId, date: "2026-05-06", amount: 200, notes: "Historical Bravo scoped account" },
    recordedBy: bravo.userId, clientUpdatedAt: new Date(now),
  });

  const missingFarmId = randomUUID();
  const missingSeasonId = randomUUID();
  const missingAdvanceId = randomUUID();
  await db.insert(farms).values({ id: missingFarmId, workspaceId: alpha.workspaceId, name: "Alpha Missing Account Farm" });
  await db.insert(seasons).values({
    id: missingSeasonId, workspaceId: alpha.workspaceId, farmId: missingFarmId,
    name: "Missing Account Season", year: 2026, startsOn: "2026-01-01", status: "planned",
  });
  await db.insert(operationalRecords).values({
    workspaceId: alpha.workspaceId, farmId: missingFarmId, seasonId: missingSeasonId, clientRecordId: missingAdvanceId,
    entityType: "advance", payload: { id: missingAdvanceId, labourerId: randomUUID(), date: "2026-05-06", amount: 100, notes: "Must remain unmapped" },
    recordedBy: alpha.userId, clientUpdatedAt: new Date(now),
  });
  const nonLabourAdvanceId = randomUUID();
  await db.insert(operationalRecords).values({
    workspaceId: alpha.workspaceId, farmId: alpha.farmId, seasonId: alpha.seasonId, clientRecordId: nonLabourAdvanceId,
    entityType: "advance", payload: { id: nonLabourAdvanceId, date: "2026-05-06", amount: 999, notes: "Not a labour advance" },
    recordedBy: alpha.userId, clientUpdatedAt: new Date(now),
  });

  const migration = await readFile(new URL("../../database/migrations/0014_labour_advance_younis_account_backfill.sql", import.meta.url), "utf8");
  await db.execute("DELETE FROM muzare_data_migrations WHERE key = '0014_historical_labour_advance_younis_account'");
  await db.execute(migration);
  const corrected = await db.select().from(operationalRecords).where(inArray(operationalRecords.clientRecordId, [
    alphaAdvanceId, bravoAdvanceId, missingAdvanceId, nonLabourAdvanceId,
  ]));
  const byId = new Map(corrected.map((record) => [record.clientRecordId, record.payload]));
  assert.equal(byId.get(alphaAdvanceId)?.accountId, alphaYounisId);
  assert.equal(byId.get(bravoAdvanceId)?.accountId, bravoYounisId);
  assert.equal(byId.get(alphaAdvanceId)?.sourceAccountName, "Younis Khan");
  assert.equal(byId.get(missingAdvanceId)?.accountId, undefined);
  assert.equal(byId.get(nonLabourAdvanceId)?.accountId, undefined);

  const audits = await db.select().from(auditLogs).where(and(
    eq(auditLogs.workspaceId, alpha.workspaceId),
    eq(auditLogs.action, "labour_advance_account_corrected"),
  ));
  assert.ok(audits.some((entry) => entry.entityId === corrected.find((record) => record.clientRecordId === alphaAdvanceId)?.id
    && entry.details?.message === "Labour advance account corrected to Younis Khan"));
  const auditCount = (await db.select().from(auditLogs).where(eq(auditLogs.action, "labour_advance_account_corrected"))).length;
  const futureAdvanceId = randomUUID();
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "advance", futureAdvanceId, {
    labourerId: alphaLabourerId, accountId: alphaCashId, date: "2026-05-07", amount: 125, notes: "Future selected account must remain unchanged",
  }))).statusCode, 200);
  await db.execute(migration);
  assert.equal((await db.select().from(auditLogs).where(eq(auditLogs.action, "labour_advance_account_corrected"))).length, auditCount);
  const [futureAdvance] = await db.select().from(operationalRecords).where(eq(operationalRecords.clientRecordId, futureAdvanceId)).limit(1);
  assert.equal(futureAdvance?.payload.accountId, alphaCashId);

  const report = await request(alpha.token, "GET",
    `/v1/workspace/${alpha.workspaceId}/advance/report?farmId=${alpha.farmId}&seasonId=${alpha.seasonId}&from=2026-05-06&to=2026-05-06`,
  );
  assert.equal(report.statusCode, 200);
  assert.equal(report.json().records.find((record: { id: string }) => record.id === alphaAdvanceId).accountName, "Younis Khan");
});

test("labour lifecycle hard deletes unused labour and deactivates linked labour without breaking reports", async () => {
  const unusedLabourerId = randomUUID();
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "labourer", unusedLabourerId, {
    name: "Unused Worker", group: "General", dailyWage: 80,
  }))).statusCode, 200);
  const unusedPreview = await request(alpha.token, "GET", `/api/workspaces/${alpha.workspaceId}/labour/${unusedLabourerId}/deletion-preview`);
  assert.deepEqual(unusedPreview.json(), { labourId: unusedLabourerId, labourName: "Unused Worker", linkedRecordCount: 0, action: "delete" });
  assert.equal((await request(alpha.token, "DELETE", `/api/workspaces/${alpha.workspaceId}/labour/${unusedLabourerId}`, {})).statusCode, 400);
  const deleted = await request(alpha.token, "DELETE", `/api/workspaces/${alpha.workspaceId}/labour/${unusedLabourerId}`, { confirmation: "DELETE" });
  assert.deepEqual(deleted.json(), { action: "deleted", linkedRecordCount: 0 });

  const linkedLabourerId = randomUUID();
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "labourer", linkedLabourerId, {
    name: "Historical Worker", group: "General", dailyWage: 95,
  }))).statusCode, 200);
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "attendance", randomUUID(), {
    labourerId: linkedLabourerId, date: "2026-08-01", status: "present",
  }))).statusCode, 200);
  assert.equal((await request(bravo.token, "GET", `/api/workspaces/${alpha.workspaceId}/labour/${linkedLabourerId}/deletion-preview`)).statusCode, 403);
  const linkedPreview = await request(alpha.token, "GET", `/api/workspaces/${alpha.workspaceId}/labour/${linkedLabourerId}/deletion-preview`);
  assert.deepEqual(linkedPreview.json(), { labourId: linkedLabourerId, labourName: "Historical Worker", linkedRecordCount: 1, action: "deactivate" });
  const deactivated = await request(alpha.token, "DELETE", `/api/workspaces/${alpha.workspaceId}/labour/${linkedLabourerId}`, { confirmation: "DELETE", endDate: "2026-08-02" });
  assert.deepEqual(deactivated.json(), { action: "deactivated", linkedRecordCount: 1, record: deactivated.json().record });
  assert.equal(deactivated.json().record.active, false);
  assert.equal(deactivated.json().record.endedOn, "2026-08-02");
  const report = await request(alpha.token, "GET", `/v1/workspace/${alpha.workspaceId}/attendance/report?farmId=${alpha.farmId}&seasonId=${alpha.seasonId}&from=2026-08-01&to=2026-08-02`);
  assert.equal(report.json().summaries.find((item: { id: string }) => item.id === linkedLabourerId).name, "Historical Worker");
});

test("attendance CSV imports preview safely, enforce owner access, and avoid duplicate attendance or advances", async () => {
  const paymentAccountId = await createAccount(alpha, "Attendance CSV Cash");
  const labourerId = randomUUID();
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "labourer", labourerId, {
    name: "CSV Known Worker", group: "General", dailyWage: 100,
  }))).statusCode, 200);
  const csvText = [
    "Labour Name,P Total,1/2 Total,A Total,Advance Total,01/05,02/05/2026,2026-05-03,04-05-2026",
    'CSV Known Worker,1,1,1,700,"P / 500","½ 200",A,-',
  ].join("\n");
  const input = { farmId: alpha.farmId, seasonId: alpha.seasonId, originalFilename: "old-register.csv", csvText, from: "2026-05-01", to: "2026-05-04" };
  assert.equal((await request(supervisor.token, "POST", `/api/workspaces/${alpha.workspaceId}/attendance-imports/preview`, input)).statusCode, 403);
  assert.equal((await request(alpha.token, "POST", `/api/workspaces/${alpha.workspaceId}/attendance-imports/preview`, { ...input, farmId: bravo.farmId, seasonId: bravo.seasonId })).statusCode, 403);

  const preview = await request(alpha.token, "POST", `/api/workspaces/${alpha.workspaceId}/attendance-imports/preview`, input);
  assert.equal(preview.statusCode, 201);
  assert.deepEqual(preview.json().preview.summary, {
    labourRows: 1, dateColumns: 4, attendanceRecords: 3, dailyAdvances: 2, advanceTotal: 700,
    duplicateRecords: 0, duplicateAdvances: 0, advanceRecordsToCreate: 2, unknownLabourRows: 0, errors: [], warnings: [],
  });
  const sessionId = preview.json().sessionId as string;
  const confirmed = await request(alpha.token, "POST", `/api/workspaces/${alpha.workspaceId}/attendance-imports/confirm`, {
    sessionId, duplicateMode: "missing_only", warningsConfirmed: false, mappings: [], accountId: paymentAccountId,
  });
  assert.equal(confirmed.statusCode, 200);
  assert.deepEqual(confirmed.json().result, { attendanceCreated: 3, attendanceUpdated: 0, attendanceSkipped: 0, advancesCreated: 2, duplicateAdvancesSkipped: 0, totalAdvanceImported: 700, labourersCreated: 0, errors: [] });
  assert.equal((await request(alpha.token, "POST", `/api/workspaces/${alpha.workspaceId}/attendance-imports/confirm`, {
    sessionId, duplicateMode: "missing_only", warningsConfirmed: false, mappings: [], accountId: paymentAccountId,
  })).statusCode, 409);

  const repeatPreview = await request(alpha.token, "POST", `/api/workspaces/${alpha.workspaceId}/attendance-imports/preview`, input);
  assert.equal(repeatPreview.json().preview.summary.duplicateRecords, 3);
  assert.equal(repeatPreview.json().preview.summary.duplicateAdvances, 2);
  assert.equal(repeatPreview.json().preview.summary.advanceRecordsToCreate, 0);
  const repeat = await request(alpha.token, "POST", `/api/workspaces/${alpha.workspaceId}/attendance-imports/confirm`, {
    sessionId: repeatPreview.json().sessionId, duplicateMode: "missing_only", warningsConfirmed: false, mappings: [], accountId: paymentAccountId,
  });
  assert.deepEqual(repeat.json().result, { attendanceCreated: 0, attendanceUpdated: 0, attendanceSkipped: 3, advancesCreated: 0, duplicateAdvancesSkipped: 2, totalAdvanceImported: 0, labourersCreated: 0, errors: [] });
});

test("attendance CSV imports can create unknown labour and import advance-only daily cells", async () => {
  const paymentAccountId = await createAccount(alpha, "Unknown Labour CSV Cash");
  const csvText = ["Labour Name,Advance Total,01/05,02/05", "New CSV Worker,1000,1000,P"].join("\n");
  const preview = await request(alpha.token, "POST", `/api/workspaces/${alpha.workspaceId}/attendance-imports/preview`, {
    farmId: alpha.farmId, seasonId: alpha.seasonId, originalFilename: "new-worker.csv", csvText, from: "2026-05-01", to: "2026-05-02",
  });
  assert.equal(preview.statusCode, 201);
  assert.equal(preview.json().preview.summary.unknownLabourRows, 1);
  assert.equal(preview.json().preview.summary.dailyAdvances, 1);
  const confirmed = await request(alpha.token, "POST", `/api/workspaces/${alpha.workspaceId}/attendance-imports/confirm`, {
    sessionId: preview.json().sessionId, duplicateMode: "missing_only", warningsConfirmed: false, accountId: paymentAccountId,
    mappings: [{ rowIndex: 0, action: "create", dailyWage: 80, group: "Imported" }],
  });
  assert.deepEqual(confirmed.json().result, { attendanceCreated: 1, attendanceUpdated: 0, attendanceSkipped: 0, advancesCreated: 1, duplicateAdvancesSkipped: 0, totalAdvanceImported: 1000, labourersCreated: 1, errors: [] });
});

test("attendance CSV imports detect Android metadata headers and parse parenthesized daily advances", async () => {
  const paymentAccountId = await createAccount(alpha, "Android CSV Cash");
  const labourerId = randomUUID();
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "labourer", labourerId, {
    name: "Android CSV Worker", group: "General", dailyWage: 90,
  }))).statusCode, 200);
  const csvText = [
    "Labour Attendance Report",
    "From:,2026-06-01,To:,2026-06-04",
    "",
    "#,Labour Name,P,1/2,A,Adv (SAR),2026-06-01,2026-06-02,2026-06-03,2026-06-04",
    "1,Android CSV Worker,1,1,1,2700,P (Adv:1000),A (Adv:500),H (Adv:200),- (Adv:1000)",
  ].join("\n");
  const preview = await request(alpha.token, "POST", `/api/workspaces/${alpha.workspaceId}/attendance-imports/preview`, {
    farmId: alpha.farmId, seasonId: alpha.seasonId, originalFilename: "29-05 attendance.csv", csvText,
  });
  assert.equal(preview.statusCode, 201);
  assert.deepEqual(preview.json().preview.summary, {
    labourRows: 1, dateColumns: 4, attendanceRecords: 3, dailyAdvances: 4, advanceTotal: 2700,
    duplicateRecords: 0, duplicateAdvances: 0, advanceRecordsToCreate: 4, unknownLabourRows: 0, errors: [], warnings: [],
  });
  assert.deepEqual(preview.json().preview.rows[0].cells.map((cell: { status: string | null; advanceAmount: number | null }) => cell), [
    { column: "2026-06-01", date: "2026-06-01", raw: "P (Adv:1000)", status: "present", advanceAmount: 1000 },
    { column: "2026-06-02", date: "2026-06-02", raw: "A (Adv:500)", status: "absent", advanceAmount: 500 },
    { column: "2026-06-03", date: "2026-06-03", raw: "H (Adv:200)", status: "half_day", advanceAmount: 200 },
    { column: "2026-06-04", date: "2026-06-04", raw: "- (Adv:1000)", status: null, advanceAmount: 1000 },
  ]);
  const confirmed = await request(alpha.token, "POST", `/api/workspaces/${alpha.workspaceId}/attendance-imports/confirm`, {
    sessionId: preview.json().sessionId, duplicateMode: "missing_only", warningsConfirmed: false, mappings: [], accountId: paymentAccountId,
  });
  assert.deepEqual(confirmed.json().result, { attendanceCreated: 3, attendanceUpdated: 0, attendanceSkipped: 0, advancesCreated: 4, duplicateAdvancesSkipped: 0, totalAdvanceImported: 2700, labourersCreated: 0, errors: [] });
  const importedAdvances = (await db.select().from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId, alpha.workspaceId), eq(operationalRecords.farmId, alpha.farmId),
    eq(operationalRecords.seasonId, alpha.seasonId), eq(operationalRecords.entityType, "advance"),
  ))).filter((record) => record.payload.source === "attendance_csv_import" && record.payload.importSessionId === preview.json().sessionId);
  assert.equal(importedAdvances.length, 4);
  assert.equal(importedAdvances.reduce((total, record) => total + Number(record.payload.amount), 0), 2700);
  assert.ok(importedAdvances.every((record) => record.payload.originalFilename === "29-05 attendance.csv" && record.payload.advanceDate && record.payload.sourceCellReference));
});

test("attendance CSV import confirmation accepts nested payloads after warnings are acknowledged", async () => {
  const labourerId = randomUUID();
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "labourer", labourerId, {
    name: "Warning CSV Worker", group: "General", dailyWage: 75,
  }))).statusCode, 200);
  const preview = await request(alpha.token, "POST", `/api/workspaces/${alpha.workspaceId}/attendance-imports/preview`, {
    farmId: alpha.farmId, seasonId: alpha.seasonId, originalFilename: "warning-register.csv",
    csvText: ["#,Labour Name,P,1/2,A,Adv (SAR),2026-07-01", "1,Warning CSV Worker,2,0,0,0,P"].join("\n"),
  });
  assert.equal(preview.statusCode, 201);
  assert.equal(preview.json().preview.summary.warnings.length, 1);
  const confirmation = {
    importSessionId: preview.json().sessionId, farmId: alpha.farmId, seasonId: alpha.seasonId,
    confirmation: { warningsAccepted: false, duplicateHandlingMode: "import_missing_only", labourMappings: [] },
  };
  assert.equal((await request(alpha.token, "POST", `/api/workspaces/${alpha.workspaceId}/attendance-imports/confirm`, confirmation)).statusCode, 400);
  const confirmed = await request(alpha.token, "POST", `/api/workspaces/${alpha.workspaceId}/attendance-imports/confirm`, {
    ...confirmation, confirmation: { ...confirmation.confirmation, warningsAccepted: true },
  });
  assert.equal(confirmed.statusCode, 200);
  assert.deepEqual(confirmed.json().result, { attendanceCreated: 1, attendanceUpdated: 0, attendanceSkipped: 0, advancesCreated: 0, duplicateAdvancesSkipped: 0, totalAdvanceImported: 0, labourersCreated: 0, errors: [] });

  const malformed = await request(alpha.token, "POST", `/api/workspaces/${alpha.workspaceId}/attendance-imports/confirm`, {});
  assert.equal(malformed.statusCode, 400);
  assert.ok(malformed.json().fields.length > 0);
});

test("season lifecycle persists active selection and rejects cross-farm or archived references", async () => {
  const secondFarmId = randomUUID();
  const secondFarmSeasonId = randomUUID();
  await db.insert(farms).values({ id: secondFarmId, workspaceId: alpha.workspaceId, name: "Alpha Second Farm" });
  await db.insert(seasons).values({
    id: secondFarmSeasonId, workspaceId: alpha.workspaceId, farmId: secondFarmId,
    name: "Second Farm Season", year: 2026, startsOn: "2026-01-01", status: "active",
  });
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", {
    ...envelope(alpha, "sale", randomUUID(), financialRecord(alpha, "sale")), seasonId: secondFarmSeasonId,
  })).statusCode, 403);

  const created = await request(alpha.token, "POST", `/v1/workspace/${alpha.workspaceId}/farms/${alpha.farmId}/seasons`, {
    name: "Alpha Crop Cycle", cropType: "Wheat", startsOn: "2026-03-01",
    expectedEndsOn: "2026-08-01", status: "planned", notes: "Integration cycle",
  });
  assert.equal(created.statusCode, 201);
  const seasonId = created.json().season.id as string;

  assert.equal((await request(alpha.token, "POST", `/v1/workspace/${alpha.workspaceId}/farms/${alpha.farmId}/seasons/${seasonId}/select`)).statusCode, 204);
  assert.equal((await request(alpha.token, "GET", "/v1/bootstrap")).json().activeSeasonId, seasonId);
  const active = await db.select().from(seasons).where(and(eq(seasons.farmId, alpha.farmId), eq(seasons.status, "active")));
  assert.equal(active.length, 1);
  assert.equal(active[0]?.id, seasonId);

  assert.equal((await request(alpha.token, "POST", `/v1/workspace/${alpha.workspaceId}/farms/${alpha.farmId}/seasons/${seasonId}/archive`)).statusCode, 204);
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", {
    ...envelope(alpha, "sale", randomUUID(), financialRecord(alpha, "sale")), seasonId,
  })).statusCode, 403);

  assert.equal((await request(alpha.token, "POST", `/v1/workspace/${alpha.workspaceId}/farms/${alpha.farmId}/seasons/${alpha.seasonId}/select`)).statusCode, 204);
});

test("workspace farm CRUD and active selection remain tenant scoped", async () => {
  const created = await request(alpha.token, "POST", `/v1/workspace/${alpha.workspaceId}/farms`, {
    name: "Alpha Orchard", location: "North Field", owner: "Owner A",
    contactName: "Manager A", contactEmail: "manager-a@example.test", contactPhone: "+966500000001",
  });
  assert.equal(created.statusCode, 201);
  const farmId = created.json().farm.id as string;

  assert.equal((await request(bravo.token, "GET", `/v1/workspace/${alpha.workspaceId}/farms`)).statusCode, 403);
  assert.equal((await request(bravo.token, "PATCH", `/v1/workspace/${alpha.workspaceId}/farms/${farmId}`, { name: "Forged Update" })).statusCode, 403);

  assert.equal((await request(alpha.token, "POST", `/v1/workspace/${alpha.workspaceId}/farms/${farmId}/select`)).statusCode, 204);
  const bootstrap = (await request(alpha.token, "GET", "/v1/bootstrap")).json();
  assert.equal(bootstrap.activeFarmId, farmId);

  const updated = await request(alpha.token, "PATCH", `/v1/workspace/${alpha.workspaceId}/farms/${farmId}`, {
    name: "Alpha Orchard Updated", location: "South Field", owner: "Owner A",
    contactName: "Manager A", contactEmail: "manager-a@example.test", contactPhone: "+966500000001",
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().farm.name, "Alpha Orchard Updated");

  assert.equal((await request(alpha.token, "POST", `/v1/workspace/${alpha.workspaceId}/farms/${farmId}/archive`)).statusCode, 204);
  const farmsList = (await request(alpha.token, "GET", `/v1/workspace/${alpha.workspaceId}/farms`)).json();
  assert.equal(farmsList.farms.find((farm: { id: string }) => farm.id === farmId).active, false);
  assert.equal(farmsList.activeFarmId, null);
});
