import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { closeDatabaseConnection, db } from "../src/db/client.js";
import {
  farms,
  attendanceImportSessions,
  auditLogs,
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
  ]);
  await db.insert(workspaceMemberships).values([
    { workspaceId: alpha.workspaceId, userId: alpha.userId, role: "workspace_owner" },
    { workspaceId: bravo.workspaceId, userId: bravo.userId, role: "workspace_owner" },
    { workspaceId: alpha.workspaceId, userId: supervisor.userId, role: "supervisor" },
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
  ]);
  app = await buildApp();
});

after(async () => {
  if (app) await app.close();
  await db.delete(attendanceImportSessions).where(inArray(attendanceImportSessions.workspaceId, ids));
  await db.delete(auditLogs).where(inArray(auditLogs.workspaceId, ids));
  await db.delete(workspaceApprovals).where(inArray(workspaceApprovals.workspaceId, ids));
  await db.delete(operationalRecords).where(inArray(operationalRecords.workspaceId, ids));
  await db.delete(userSessions).where(inArray(userSessions.userId, [alpha.userId, bravo.userId, supervisor.userId]));
  await db.delete(seasons).where(inArray(seasons.workspaceId, ids));
  await db.delete(farms).where(inArray(farms.workspaceId, ids));
  await db.delete(workspaceMemberships).where(inArray(workspaceMemberships.workspaceId, ids));
  await db.delete(users).where(inArray(users.id, [alpha.userId, bravo.userId, supervisor.userId]));
  await db.delete(workspaces).where(inArray(workspaces.id, ids));
  await closeDatabaseConnection();
});

test("Alpha and Bravo operational records remain isolated", async () => {
  for (const entity of ["voucher", "attendance", "sale", "dispatch", "partnerEntry"]) {
    assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, entity))).statusCode, 200);
    assert.equal((await request(bravo.token, "POST", "/v1/workspace/operational-records", envelope(bravo, entity))).statusCode, 200);
  }
  const alphaRecords = (await request(alpha.token, "GET", `/v1/workspace/${alpha.workspaceId}/operational-records`)).json().records;
  const bravoRecords = (await request(bravo.token, "GET", `/v1/workspace/${bravo.workspaceId}/operational-records`)).json().records;
  assert.equal(alphaRecords.length, 5);
  assert.equal(bravoRecords.length, 5);
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

test("foreign farm, season, account, ledger, and approval references are rejected", async () => {
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", {
    ...envelope(alpha, "sale"), farmId: bravo.farmId, seasonId: bravo.seasonId,
  })).statusCode, 403);
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", {
    ...envelope(alpha, "sale"), seasonId: bravo.seasonId,
  })).statusCode, 403);

  const bravoAccount = randomUUID();
  assert.equal((await request(bravo.token, "POST", "/v1/workspace/operational-records", envelope(bravo, "account", bravoAccount))).statusCode, 200);
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "sale", randomUUID(), { accountId: bravoAccount }))).statusCode, 403);

  const bravoLedger = randomUUID();
  assert.equal((await request(bravo.token, "POST", "/v1/workspace/operational-records", envelope(bravo, "partnerEntry", bravoLedger))).statusCode, 200);
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "partnerEntry", randomUUID(), { ledgerId: bravoLedger }))).statusCode, 403);

  const bravoExpense = randomUUID();
  assert.equal((await request(bravo.token, "POST", "/v1/workspace/operational-records", envelope(bravo, "voucher", bravoExpense))).statusCode, 200);
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/approvals", {
    workspaceId: alpha.workspaceId, entityType: "expense", entityId: bravoExpense,
  })).statusCode, 403);
});

test("approval queues remain isolated", async () => {
  const alphaExpense = randomUUID();
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "voucher", alphaExpense))).statusCode, 200);
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

  const fallbackVoucher = await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "voucher"));
  assert.equal(fallbackVoucher.statusCode, 200);
  assert.equal(fallbackVoucher.json().record.category, "Other");
  assert.equal(fallbackVoucher.json().record.subcategory, "Miscellaneous");
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "voucher", randomUUID(), {
    categoryId: randomUUID(), subcategoryId: randomUUID(),
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
    categoryId: fuel.id, subcategoryId: customId,
  }))).statusCode, 200);
  assert.equal((await request(alpha.token, "PATCH", `/v1/workspace/${alpha.workspaceId}/expense-subcategories/${customId}`, { active: false })).statusCode, 200);
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "voucher", randomUUID(), {
    categoryId: fuel.id, subcategoryId: customId,
  }))).statusCode, 403);
});

test("expense vouchers receive scoped readable numbers and keep them when edited", async () => {
  const firstId = randomUUID();
  const first = await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "voucher", firstId, {
    date: "2026-05-20", description: "Original expense", amount: 100,
  }));
  assert.equal(first.statusCode, 200);
  assert.match(first.json().record.voucherNumber, /^EXP-2026-\d{4}$/);

  const [second, third] = await Promise.all([
    request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "voucher", randomUUID(), {
      date: "2026-05-21", description: "Concurrent expense A", amount: 120,
    })),
    request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "voucher", randomUUID(), {
      date: "2026-05-21", description: "Concurrent expense B", amount: 140,
    })),
  ]);
  assert.equal(second.statusCode, 200);
  assert.equal(third.statusCode, 200);
  assert.notEqual(second.json().record.voucherNumber, third.json().record.voucherNumber);

  const edited = await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "voucher", firstId, {
    createdAt: first.json().record.createdAt,
    updatedAt: new Date(Date.now() + 1_000).toISOString(),
    voucherNumber: "EXP-2099-9999",
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
    labourerId, date: "2026-05-02", amount: 45, notes: "Midweek advance",
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
    labourerId, date: "2026-05-04", amount: 120, notes: "Seed cash",
  }))).statusCode, 200);
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "advance", randomUUID(), {
    labourerId, date: "2026-05-05", amount: 80, notes: "Food",
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
    sessionId, duplicateMode: "missing_only", warningsConfirmed: false, mappings: [],
  });
  assert.equal(confirmed.statusCode, 200);
  assert.deepEqual(confirmed.json().result, { attendanceCreated: 3, attendanceUpdated: 0, attendanceSkipped: 0, advancesCreated: 2, duplicateAdvancesSkipped: 0, totalAdvanceImported: 700, labourersCreated: 0, errors: [] });
  assert.equal((await request(alpha.token, "POST", `/api/workspaces/${alpha.workspaceId}/attendance-imports/confirm`, {
    sessionId, duplicateMode: "missing_only", warningsConfirmed: false, mappings: [],
  })).statusCode, 409);

  const repeatPreview = await request(alpha.token, "POST", `/api/workspaces/${alpha.workspaceId}/attendance-imports/preview`, input);
  assert.equal(repeatPreview.json().preview.summary.duplicateRecords, 3);
  assert.equal(repeatPreview.json().preview.summary.duplicateAdvances, 2);
  assert.equal(repeatPreview.json().preview.summary.advanceRecordsToCreate, 0);
  const repeat = await request(alpha.token, "POST", `/api/workspaces/${alpha.workspaceId}/attendance-imports/confirm`, {
    sessionId: repeatPreview.json().sessionId, duplicateMode: "missing_only", warningsConfirmed: false, mappings: [],
  });
  assert.deepEqual(repeat.json().result, { attendanceCreated: 0, attendanceUpdated: 0, attendanceSkipped: 3, advancesCreated: 0, duplicateAdvancesSkipped: 2, totalAdvanceImported: 0, labourersCreated: 0, errors: [] });
});

test("attendance CSV imports can create unknown labour and import advance-only daily cells", async () => {
  const csvText = ["Labour Name,Advance Total,01/05,02/05", "New CSV Worker,1000,1000,P"].join("\n");
  const preview = await request(alpha.token, "POST", `/api/workspaces/${alpha.workspaceId}/attendance-imports/preview`, {
    farmId: alpha.farmId, seasonId: alpha.seasonId, originalFilename: "new-worker.csv", csvText, from: "2026-05-01", to: "2026-05-02",
  });
  assert.equal(preview.statusCode, 201);
  assert.equal(preview.json().preview.summary.unknownLabourRows, 1);
  assert.equal(preview.json().preview.summary.dailyAdvances, 1);
  const confirmed = await request(alpha.token, "POST", `/api/workspaces/${alpha.workspaceId}/attendance-imports/confirm`, {
    sessionId: preview.json().sessionId, duplicateMode: "missing_only", warningsConfirmed: false,
    mappings: [{ rowIndex: 0, action: "create", dailyWage: 80, group: "Imported" }],
  });
  assert.deepEqual(confirmed.json().result, { attendanceCreated: 1, attendanceUpdated: 0, attendanceSkipped: 0, advancesCreated: 1, duplicateAdvancesSkipped: 0, totalAdvanceImported: 1000, labourersCreated: 1, errors: [] });
});

test("attendance CSV imports detect Android metadata headers and parse parenthesized daily advances", async () => {
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
    sessionId: preview.json().sessionId, duplicateMode: "missing_only", warningsConfirmed: false, mappings: [],
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
    ...envelope(alpha, "sale"), seasonId: secondFarmSeasonId,
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
    ...envelope(alpha, "sale"), seasonId,
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
