import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import { closeDatabaseConnection, db } from "../src/db/client.js";
import { hasModulePermission, hasPermission } from "../src/permissions.js";
import { assertIntegrationResponse } from "./helpers/integration-response.js";
import {
  farms,
  attendanceImportSessions,
  auditLogs,
  expenseImportSessions,
  operationalRecords,
  importBatches,
  importFailures,
  seasons,
  userSessions,
  users,
  workspaceMemberFarms,
  workspaceApprovals,
  workspaceMemberships,
  workspaceTeamInvitations,
  workspaces,
} from "../src/db/schema.js";

const now = new Date("2026-01-01T00:00:00.000Z").toISOString();
const alpha = { workspaceId: randomUUID(), farmId: randomUUID(), seasonId: randomUUID(), userId: randomUUID(), token: `alpha-${randomUUID()}` };
const bravo = { workspaceId: randomUUID(), farmId: randomUUID(), seasonId: randomUUID(), userId: randomUUID(), token: `bravo-${randomUUID()}` };
const alphaSecondary = { farmId: randomUUID(), seasonId: randomUUID() };
const manager = { userId: randomUUID(), token: `manager-${randomUUID()}` };
const supervisor = { userId: randomUUID(), token: `supervisor-${randomUUID()}` };
const accountant = { userId: randomUUID(), token: `accountant-${randomUUID()}` };
const operator = { userId: randomUUID(), token: `operator-${randomUUID()}` };
const viewer = { userId: randomUUID(), token: `viewer-${randomUUID()}` };
const admin = { userId: randomUUID(), token: `admin-${randomUUID()}` };
const alphaCashId = randomUUID();
const bravoCashId = randomUUID();
let alphaExpenseSelection: { categoryId: string; subcategoryId: string };
let bravoExpenseSelection: { categoryId: string; subcategoryId: string };
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
    { id: manager.userId, email: `manager-${manager.userId}@example.test`, passwordHash: "test", status: "approved" },
    { id: supervisor.userId, email: `supervisor-${supervisor.userId}@example.test`, passwordHash: "test", status: "approved" },
    { id: accountant.userId, email: `accountant-${accountant.userId}@example.test`, passwordHash: "test", status: "approved" },
    { id: operator.userId, email: `operator-${operator.userId}@example.test`, passwordHash: "test", status: "approved" },
    { id: viewer.userId, email: `viewer-${viewer.userId}@example.test`, passwordHash: "test", status: "approved" },
    { id: admin.userId, email: `admin-${admin.userId}@example.test`, passwordHash: "test", status: "approved", platformRole: "platform_admin" },
  ]);
  await db.insert(workspaceMemberships).values([
    { workspaceId: alpha.workspaceId, userId: alpha.userId, role: "workspace_owner" },
    { workspaceId: bravo.workspaceId, userId: bravo.userId, role: "workspace_owner" },
    { workspaceId: alpha.workspaceId, userId: manager.userId, role: "workspace_manager" },
    { workspaceId: alpha.workspaceId, userId: supervisor.userId, role: "supervisor" },
    { workspaceId: alpha.workspaceId, userId: accountant.userId, role: "accountant" },
    { workspaceId: alpha.workspaceId, userId: operator.userId, role: "operator" },
    { workspaceId: alpha.workspaceId, userId: viewer.userId, role: "viewer", farmAccessMode: "assigned" },
  ]);
  await db.insert(farms).values([
    { id: alpha.farmId, workspaceId: alpha.workspaceId, name: "Alpha Farm" },
    { id: alphaSecondary.farmId, workspaceId: alpha.workspaceId, name: "Alpha Secondary Farm" },
    { id: bravo.farmId, workspaceId: bravo.workspaceId, name: "Bravo Farm" },
  ]);
  await db.insert(seasons).values([
    { id: alpha.seasonId, workspaceId: alpha.workspaceId, farmId: alpha.farmId, name: "Alpha Season", year: 2026, startsOn: "2026-01-01", status: "active" },
    { id: alphaSecondary.seasonId, workspaceId: alpha.workspaceId, farmId: alphaSecondary.farmId, name: "Alpha Secondary Season", year: 2026, startsOn: "2026-01-01", status: "active" },
    { id: bravo.seasonId, workspaceId: bravo.workspaceId, farmId: bravo.farmId, name: "Bravo Season", year: 2026, startsOn: "2026-01-01", status: "active" },
  ]);
  await db.insert(workspaceMemberFarms).values({
    workspaceId: alpha.workspaceId,
    membershipId: (await db.select({ id: workspaceMemberships.id }).from(workspaceMemberships).where(and(eq(workspaceMemberships.workspaceId, alpha.workspaceId), eq(workspaceMemberships.userId, viewer.userId))).limit(1))[0]!.id,
    farmId: alpha.farmId,
  });
  await db.insert(userSessions).values([
    { userId: alpha.userId, workspaceId: alpha.workspaceId, activeFarmId: alpha.farmId, activeSeasonId: alpha.seasonId, tokenHash: hash(alpha.token), expiresAt: new Date(Date.now() + 60_000) },
    { userId: bravo.userId, workspaceId: bravo.workspaceId, activeFarmId: bravo.farmId, activeSeasonId: bravo.seasonId, tokenHash: hash(bravo.token), expiresAt: new Date(Date.now() + 60_000) },
    { userId: manager.userId, workspaceId: alpha.workspaceId, activeFarmId: alpha.farmId, activeSeasonId: alpha.seasonId, tokenHash: hash(manager.token), expiresAt: new Date(Date.now() + 60_000) },
    { userId: supervisor.userId, workspaceId: alpha.workspaceId, activeFarmId: alpha.farmId, activeSeasonId: alpha.seasonId, tokenHash: hash(supervisor.token), expiresAt: new Date(Date.now() + 60_000) },
    { userId: accountant.userId, workspaceId: alpha.workspaceId, activeFarmId: alpha.farmId, activeSeasonId: alpha.seasonId, tokenHash: hash(accountant.token), expiresAt: new Date(Date.now() + 60_000) },
    { userId: operator.userId, workspaceId: alpha.workspaceId, activeFarmId: alpha.farmId, activeSeasonId: alpha.seasonId, tokenHash: hash(operator.token), expiresAt: new Date(Date.now() + 60_000) },
    { userId: viewer.userId, workspaceId: alpha.workspaceId, activeFarmId: alpha.farmId, activeSeasonId: alpha.seasonId, tokenHash: hash(viewer.token), expiresAt: new Date(Date.now() + 60_000) },
    { userId: admin.userId, workspaceId: alpha.workspaceId, activeFarmId: alpha.farmId, activeSeasonId: alpha.seasonId, tokenHash: hash(admin.token), expiresAt: new Date(Date.now() + 60_000) },
  ]);
  app = await buildApp();
  assertIntegrationResponse(await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "account", alphaCashId, {
    name: "Alpha Fixture Cash",
    type: "cash",
    active: true,
  })), 200, "seed Alpha payment account");
  assertIntegrationResponse(await request(bravo.token, "POST", "/v1/workspace/operational-records", envelope(bravo, "account", bravoCashId, {
    name: "Bravo Fixture Cash",
    type: "cash",
    active: true,
  })), 200, "seed Bravo payment account");
  alphaExpenseSelection = await firstExpenseCategorySelection(alpha);
  bravoExpenseSelection = await firstExpenseCategorySelection(bravo);
});

after(async () => {
  if (app) await app.close();
  await db.delete(attendanceImportSessions).where(inArray(attendanceImportSessions.workspaceId, ids));
  await db.delete(expenseImportSessions).where(inArray(expenseImportSessions.workspaceId, ids));
  await db.delete(auditLogs).where(inArray(auditLogs.workspaceId, ids));
  await db.delete(auditLogs).where(inArray(auditLogs.userId, [alpha.userId, bravo.userId, manager.userId, supervisor.userId, accountant.userId, operator.userId, viewer.userId, admin.userId]));
  await db.delete(workspaceApprovals).where(inArray(workspaceApprovals.workspaceId, ids));
  await db.delete(workspaceTeamInvitations).where(inArray(workspaceTeamInvitations.workspaceId, ids));
  await db.delete(importFailures).where(inArray(importFailures.workspaceId, ids));
  await db.delete(importBatches).where(inArray(importBatches.workspaceId, ids));
  await db.delete(operationalRecords).where(inArray(operationalRecords.workspaceId, ids));
  await db.delete(userSessions).where(inArray(userSessions.userId, [alpha.userId, bravo.userId, manager.userId, supervisor.userId, accountant.userId, operator.userId, viewer.userId, admin.userId]));
  await db.delete(seasons).where(inArray(seasons.workspaceId, ids));
  await db.delete(farms).where(inArray(farms.workspaceId, ids));
  await db.delete(workspaceMemberFarms).where(eq(workspaceMemberFarms.workspaceId, alpha.workspaceId));
  await db.delete(workspaceMemberships).where(inArray(workspaceMemberships.workspaceId, ids));
  await db.update(users).set({ workspaceId: null }).where(inArray(users.workspaceId, ids));
  await db.delete(users).where(inArray(users.id, [alpha.userId, bravo.userId, manager.userId, supervisor.userId, accountant.userId, operator.userId, viewer.userId, admin.userId]));
  await db.delete(users).where(eq(users.email, "invited.member@example.test"));
  await db.delete(users).where(inArray(users.email, [
    "security.invited@example.test",
    "repeat.member@example.test",
    "existing.member@example.test",
    "duplicate.membership@example.test",
    "viewer.all@example.test",
  ]));
  await db.delete(workspaces).where(inArray(workspaces.id, ids));
  await closeDatabaseConnection();
});

test("Alpha and Bravo operational records remain isolated", async () => {
  for (const entity of ["voucher", "attendance", "sale"]) {
    const alphaRecord = entity === "voucher" || entity === "sale" ? financialRecord(alpha, entity) : {};
    const bravoRecord = entity === "voucher" || entity === "sale" ? financialRecord(bravo, entity) : {};
    assertIntegrationResponse(await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, entity, randomUUID(), alphaRecord)), 200, `create Alpha ${entity}`);
    assertIntegrationResponse(await request(bravo.token, "POST", "/v1/workspace/operational-records", envelope(bravo, entity, randomUUID(), bravoRecord)), 200, `create Bravo ${entity}`);
  }
  const alphaAccountId = alphaCashId; const bravoAccountId = bravoCashId;
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "partnerEntry", randomUUID(), { date: "2026-06-01", partnerName: "Alpha Partner", type: "contribution", amount: 100, accountId: alphaAccountId }))).statusCode, 200);
  assert.equal((await request(bravo.token, "POST", "/v1/workspace/operational-records", envelope(bravo, "partnerEntry", randomUUID(), { date: "2026-06-01", partnerName: "Bravo Partner", type: "contribution", amount: 100, accountId: bravoAccountId }))).statusCode, 200);
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

test("wage rates block overlapping ranges unless the previous rate is explicitly closed", async () => {
  const labourerId = randomUUID();
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "labourer", labourerId, {
    name: "Rate Worker",
    group: "General",
    dailyWage: 90,
  }))).statusCode, 200);

  const firstRate = await request(alpha.token, "POST", `/v1/workspace/${alpha.workspaceId}/wage-rates/bulk`, {
    farmId: alpha.farmId,
    seasonId: alpha.seasonId,
    effectiveFrom: "2026-06-01",
    effectiveTo: "2026-06-15",
    rows: [{ labourerId, dailyRate: 50 }],
  });
  assert.equal(firstRate.statusCode, 200);

  const overlapPreview = await request(alpha.token, "POST", `/v1/workspace/${alpha.workspaceId}/wage-rates/validate-overlap`, {
    farmId: alpha.farmId,
    seasonId: alpha.seasonId,
    effectiveFrom: "2026-06-10",
    effectiveTo: "2026-06-20",
    rows: [{ labourerId, dailyRate: 55 }],
  });
  assert.equal(overlapPreview.statusCode, 200);
  assert.equal(overlapPreview.json().valid, false);
  assert.equal(overlapPreview.json().overlaps.length, 1);

  const blocked = await request(alpha.token, "POST", `/v1/workspace/${alpha.workspaceId}/wage-rates/bulk`, {
    farmId: alpha.farmId,
    seasonId: alpha.seasonId,
    effectiveFrom: "2026-06-10",
    effectiveTo: "2026-06-20",
    rows: [{ labourerId, dailyRate: 55 }],
  });
  assert.equal(blocked.statusCode, 409);
  assert.match(String(blocked.json().message), /overlap/i);

  const closedPrevious = await request(alpha.token, "POST", `/v1/workspace/${alpha.workspaceId}/wage-rates/bulk`, {
    farmId: alpha.farmId,
    seasonId: alpha.seasonId,
    effectiveFrom: "2026-06-16",
    effectiveTo: "2026-06-30",
    closePrevious: true,
    rows: [{ labourerId, dailyRate: 60 }],
  });
  assert.equal(closedPrevious.statusCode, 200);

  const rates = await request(alpha.token, "GET", `/v1/workspace/${alpha.workspaceId}/wage-rates?farmId=${alpha.farmId}&seasonId=${alpha.seasonId}&labourerId=${labourerId}&includeInactive=true`);
  assert.equal(rates.statusCode, 200);
  assert.equal(rates.json().rates.length, 2);
});

test("wage calculation applies the correct rate by attendance date and flags missing rates", async () => {
  const labourerId = randomUUID();
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "labourer", labourerId, {
    name: "Calculation Worker",
    group: "General",
    dailyWage: 90,
  }))).statusCode, 200);

  assert.equal((await request(alpha.token, "POST", `/v1/workspace/${alpha.workspaceId}/wage-rates/bulk`, {
    farmId: alpha.farmId,
    seasonId: alpha.seasonId,
    effectiveFrom: "2026-06-01",
    effectiveTo: "2026-06-15",
    rows: [{ labourerId, dailyRate: 50 }],
  })).statusCode, 200);

  assert.equal((await request(alpha.token, "POST", `/v1/workspace/${alpha.workspaceId}/wage-rates/bulk`, {
    farmId: alpha.farmId,
    seasonId: alpha.seasonId,
    effectiveFrom: "2026-06-16",
    effectiveTo: "2026-06-30",
    closePrevious: true,
    rows: [{ labourerId, dailyRate: 60, halfDayRate: 35 }],
  })).statusCode, 200);

  const attendanceRows = [
    { id: randomUUID(), date: "2026-06-10", status: "present" },
    { id: randomUUID(), date: "2026-06-20", status: "present" },
    { id: randomUUID(), date: "2026-06-21", status: "half_day" },
    { id: randomUUID(), date: "2026-07-01", status: "present" },
  ];
  for (const row of attendanceRows) {
    assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "attendance", row.id, {
      labourerId,
      date: row.date,
      status: row.status,
    }))).statusCode, 200);
  }

  const response = await request(alpha.token, "GET", `/v1/workspace/${alpha.workspaceId}/wage-rates/calculate?farmId=${alpha.farmId}&seasonId=${alpha.seasonId}&from=2026-06-01&to=2026-07-01&labourIds=${labourerId}`);
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.rows.length, 1);
  assert.equal(body.rows[0].presentDays, 3);
  assert.equal(body.rows[0].halfDays, 1);
  assert.equal(body.rows[0].payableDays, 3.5);
  assert.equal(body.rows[0].totalWage, 145);
  assert.deepEqual(body.rows[0].missingRateDates, ["2026-07-01"]);
  assert.equal(body.unresolved.length, 1);
  assert.equal(body.unresolved[0].date, "2026-07-01");
});

test("viewers can read wage rates but cannot bulk edit them", async () => {
  const labourerId = randomUUID();
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "labourer", labourerId, {
    name: "Viewer Worker",
    group: "General",
    dailyWage: 75,
  }))).statusCode, 200);

  assert.equal((await request(alpha.token, "POST", `/v1/workspace/${alpha.workspaceId}/wage-rates/bulk`, {
    farmId: alpha.farmId,
    seasonId: alpha.seasonId,
    effectiveFrom: "2026-06-01",
    rows: [{ labourerId, dailyRate: 42 }],
  })).statusCode, 200);

  const list = await request(viewer.token, "GET", `/v1/workspace/${alpha.workspaceId}/wage-rates?farmId=${alpha.farmId}&seasonId=${alpha.seasonId}`);
  assert.equal(list.statusCode, 200);
  assert.ok(Array.isArray(list.json().rates));

  const blocked = await request(viewer.token, "POST", `/v1/workspace/${alpha.workspaceId}/wage-rates/bulk`, {
    farmId: alpha.farmId,
    seasonId: alpha.seasonId,
    effectiveFrom: "2026-06-15",
    rows: [{ labourerId, dailyRate: 45 }],
  });
  assert.equal(blocked.statusCode, 403);
});

test("dispatch masters are tenant scoped and used masters remain protected", async () => {
  const alphaVehicleId = randomUUID();
  const bravoVehicleId = randomUUID();
  const alphaTypeOneId = randomUUID();
  const alphaTypeTwoId = randomUUID();
  const bravoTypeId = randomUUID();
  const dispatchId = randomUUID();
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "vehicle", alphaVehicleId, { number: "ABC-123", active: true }))).statusCode, 200);
  assert.equal((await request(bravo.token, "POST", "/v1/workspace/operational-records", envelope(bravo, "vehicle", bravoVehicleId, { number: "BRV-456", active: true }))).statusCode, 200);
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "dateType", alphaTypeOneId, { name: "Mabroom", active: true }))).statusCode, 200);
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "dateType", alphaTypeTwoId, { name: "Ajwa", active: true }))).statusCode, 200);
  assert.equal((await request(bravo.token, "POST", "/v1/workspace/operational-records", envelope(bravo, "dateType", bravoTypeId, { name: "Safawi", active: true }))).statusCode, 200);
  const items = [{ id: randomUUID(), dateTypeId: alphaTypeOneId, cartons: 50 }, { id: randomUUID(), dateTypeId: alphaTypeTwoId, cartons: 30 }];
  assertIntegrationResponse(await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "dispatch", dispatchId, { date: "2026-06-02", vehicleId: alphaVehicleId, items })), 200, "create dispatch with tenant-owned masters");
  assert.equal(items.reduce((sum, item) => sum + item.cartons, 0), 80);
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "dispatch", randomUUID(), {
    date: "2026-06-02", vehicleId: alphaVehicleId, items: [{ id: randomUUID(), dateTypeId: bravoTypeId, cartons: 10 }],
  }))).statusCode, 403);
  assert.equal((await request(alpha.token, "DELETE", "/v1/workspace/operational-records", {
    workspaceId: alpha.workspaceId, farmId: alpha.farmId, seasonId: alpha.seasonId, entity: "dateType", recordId: alphaTypeOneId,
  })).statusCode, 409);
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "vehicle", alphaVehicleId, {
    number: "ABC-123", active: false, updatedAt: new Date(Date.now() + 1000).toISOString(),
  }))).statusCode, 200);
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "dispatch", randomUUID(), {
    date: "2026-06-02", vehicleId: alphaVehicleId, items: [{ id: randomUUID(), dateTypeId: alphaTypeTwoId, cartons: 10 }],
  }))).statusCode, 403);
  assert.equal((await request(alpha.token, "DELETE", "/v1/workspace/operational-records", {
    workspaceId: alpha.workspaceId, farmId: alpha.farmId, seasonId: alpha.seasonId, entity: "dispatch", recordId: dispatchId,
  })).statusCode, 204);
  assert.equal((await request(alpha.token, "DELETE", "/v1/workspace/operational-records", {
    workspaceId: alpha.workspaceId, farmId: alpha.farmId, seasonId: alpha.seasonId, entity: "dateType", recordId: alphaTypeOneId,
  })).statusCode, 204);
});

test("date types ignore stale season context when no active season is selected", async () => {
  const [session] = await db.select({ activeSeasonId: userSessions.activeSeasonId }).from(userSessions)
    .where(eq(userSessions.userId, alpha.userId)).limit(1);
  await db.update(userSessions).set({ activeSeasonId: null }).where(eq(userSessions.userId, alpha.userId));
  const dateTypeId = randomUUID();
  try {
    const bootstrap = await request(alpha.token, "GET", "/v1/bootstrap");
    assert.equal(bootstrap.statusCode, 200);
    assert.equal(bootstrap.json().activeSeasonId, alpha.seasonId);

    const create = await request(alpha.token, "POST", "/v1/workspace/operational-records", {
      workspaceId: alpha.workspaceId,
      farmId: alpha.farmId,
      seasonId: alpha.seasonId,
      entity: "dateType",
      record: { id: dateTypeId, createdAt: now, updatedAt: now, name: "Mabroom", active: true },
    });
    assert.equal(create.statusCode, 200);

    const deletion = await request(alpha.token, "DELETE", "/v1/workspace/operational-records", {
      workspaceId: alpha.workspaceId,
      farmId: alpha.farmId,
      seasonId: alpha.seasonId,
      entity: "dateType",
      recordId: dateTypeId,
    });
    assert.equal(deletion.statusCode, 204);
  } finally {
    await db.update(userSessions).set({ activeSeasonId: session?.activeSeasonId ?? alpha.seasonId }).where(eq(userSessions.userId, alpha.userId));
  }
});

test("dispatch-linked sales enforce remaining cartons and active dispatch references", async () => {
  const accountId = await createAccount(alpha, "Dispatch Sale Cash");
  const vehicleId = randomUUID();
  const dateTypeId = randomUUID();
  const dispatchId = randomUUID();
  const dispatchItemId = randomUUID();
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "vehicle", vehicleId, {
    number: "SAL-101", active: true,
  }))).statusCode, 200);
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "dateType", dateTypeId, {
    name: "Ajwa", active: true,
  }))).statusCode, 200);
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "dispatch", dispatchId, {
    date: "2026-06-03", vehicleId, items: [{ id: dispatchItemId, dateTypeId, cartons: 40 }],
  }))).statusCode, 200);

  const firstSale = await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "sale", randomUUID(), {
    date: "2026-06-03",
    buyerName: "Buyer One",
    produceType: "Ajwa",
    quantity: 25,
    unitPrice: 12,
    amount: 300,
    accountId,
    dispatchId,
    dispatchItemId,
    dispatchDate: "2026-06-03",
    vehicleId,
    vehicleNumber: "SAL-101",
    dateTypeId,
    dateTypeName: "Ajwa",
  }));
  assert.equal(firstSale.statusCode, 200);

  const oversell = await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "sale", randomUUID(), {
    date: "2026-06-04",
    buyerName: "Buyer Two",
    produceType: "Ajwa",
    quantity: 20,
    unitPrice: 12,
    amount: 240,
    accountId,
    dispatchId,
    dispatchItemId,
    dispatchDate: "2026-06-03",
    vehicleId,
    vehicleNumber: "SAL-101",
    dateTypeId,
    dateTypeName: "Ajwa",
  }));
  assert.equal(oversell.statusCode, 409);
  assert.equal(oversell.json().message, "Sale quantity cannot exceed the remaining cartons on the selected dispatch.");

  const beforeDispatch = await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "sale", randomUUID(), {
    date: "2026-06-02",
    buyerName: "Buyer Three",
    produceType: "Ajwa",
    quantity: 5,
    unitPrice: 12,
    amount: 60,
    accountId,
    dispatchId,
    dispatchItemId,
    dispatchDate: "2026-06-03",
    vehicleId,
    vehicleNumber: "SAL-101",
    dateTypeId,
    dateTypeName: "Ajwa",
  }));
  assert.equal(beforeDispatch.statusCode, 409);

  assert.equal((await request(alpha.token, "DELETE", "/v1/workspace/operational-records", {
    workspaceId: alpha.workspaceId, farmId: alpha.farmId, seasonId: alpha.seasonId, entity: "dispatch", recordId: dispatchId,
  })).statusCode, 204);

  const deletedDispatchSale = await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "sale", randomUUID(), {
    date: "2026-06-04",
    buyerName: "Buyer Four",
    produceType: "Ajwa",
    quantity: 5,
    unitPrice: 12,
    amount: 60,
    accountId,
    dispatchId,
    dispatchItemId,
    dispatchDate: "2026-06-03",
    vehicleId,
    vehicleNumber: "SAL-101",
    dateTypeId,
    dateTypeName: "Ajwa",
  }));
  assert.equal(deletedDispatchSale.statusCode, 409);
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
  assertIntegrationResponse(await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "voucher", voucherId, {
    date: "2026-06-02", amount: 125, accountId, description: "Delete this voucher", ...alphaExpenseSelection,
  })), 200, "create voucher for deletion lifecycle");
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
const firstExpenseCategorySelection = async (tenant: typeof alpha) => {
  const response = await request(tenant.token, "GET", `/v1/workspace/${tenant.workspaceId}/expense-categories`);
  assert.equal(response.statusCode, 200);
  const category = response.json().categories.find((item: { name: string }) => item.name === "Other")
    ?? response.json().categories[0];
  assert.ok(category);
  const subcategory = category.subcategories.find((item: { name: string }) => item.name === "Miscellaneous")
    ?? category.subcategories[0];
  assert.ok(subcategory);
  return { categoryId: category.id as string, subcategoryId: subcategory.id as string };
};
const financialRecord = (tenant: typeof alpha, entity: "sale" | "voucher", record: Record<string, unknown> = {}) => ({
  date: "2026-06-01", amount: 100, accountId: tenant.workspaceId === alpha.workspaceId ? alphaCashId : bravoCashId,
  ...(entity === "sale"
    ? { buyerName: "Buyer", produceType: "Produce", quantity: 10, unitPrice: 10 }
    : { description: "Expense", ...(tenant.workspaceId === alpha.workspaceId ? alphaExpenseSelection : bravoExpenseSelection) }),
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
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "partnerEntry", randomUUID(), { date: "2026-06-01", partnerName: "Alpha Partner", type: "contribution", amount: 100, accountId: alphaCashId, ledgerId: bravoLedger }))).statusCode, 403);

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
      result[String(record.payload.fromPartner)] = (result[String(record.payload.fromPartner)] ?? 0) + amount;
      result[String(record.payload.toPartner)] = (result[String(record.payload.toPartner)] ?? 0) - amount;
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
        + (String(entry.payload.fromAccountId) === account.clientRecordId ? Number(entry.payload.amount) : 0)
        - (String(entry.payload.toAccountId) === account.clientRecordId ? Number(entry.payload.amount) : 0), 0);
      return [name, amount];
    }));
  };
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "account", younisAccountId, { name: younisName, type: "partner" }))).statusCode, 200);
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "account", sajidAccountId, { name: sajidName, type: "partner" }))).statusCode, 200);
  const totalsBefore = await operationalTotals();

  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", settlementPayload(settlementId, younisAccountId, sajidAccountId, younisName, sajidName, 101_140, 1_000))).statusCode, 200);
  assert.deepEqual(await positions(), { [younisName]: 101_140, [sajidName]: -101_140 });
  assert.deepEqual(await accountPositions(), { [younisName]: 101_140, [sajidName]: -101_140 });
  assert.deepEqual(await operationalTotals(), totalsBefore);

  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", settlementPayload(settlementId, younisAccountId, sajidAccountId, younisName, sajidName, 101_140, 2_000))).statusCode, 200);
  assert.equal((await db.select().from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId, alpha.workspaceId), eq(operationalRecords.entityType, "partnerEntry"), eq(operationalRecords.clientRecordId, settlementId),
  ))).length, 1);
  assert.deepEqual(await positions(), { [younisName]: 101_140, [sajidName]: -101_140 });
  assert.deepEqual(await accountPositions(), await positions());

  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", settlementPayload(settlementId, younisAccountId, sajidAccountId, younisName, sajidName, 90_000, 3_000))).statusCode, 200);
  assert.deepEqual(await positions(), { [younisName]: 90_000, [sajidName]: -90_000 });
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

test("expense vouchers receive scoped readable numbers and accept an explicit number when edited", async () => {
  const firstId = randomUUID();
  const first = await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "voucher", firstId, {
    ...financialRecord(alpha, "voucher"), date: "2026-05-20", description: "Original expense", amount: 100,
  }));
  assert.equal(first.statusCode, 200);
  assert.match(first.json().record.voucherNumber, /^V-\d{4}$/);
  assert.ok(Number(first.json().record.voucherNumber.slice(2)) > 0);

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
    accountId: alphaCashId,
    date: "2026-05-22",
    description: "Corrected expense",
    amount: 175,
    ...alphaExpenseSelection,
  }));
  assert.equal(edited.statusCode, 200);
  assert.equal(edited.json().record.voucherNumber, "V-9999");
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
    vendor: "Camp Vendor", accountId: alphaAccountId, ...alphaExpenseSelection,
  }));
  assert.equal(alphaVoucher.statusCode, 200);
  assert.equal((await request(bravo.token, "POST", "/v1/workspace/operational-records", envelope(bravo, "voucher", bravoVoucherId, {
    date: "2026-05-30", description: "Labour field supplies", amount: 1683, vendor: "Camp Vendor", accountId: bravoAccountId, ...bravoExpenseSelection,
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
  assertIntegrationResponse(await request(alpha.token, "POST", `/v1/workspace/${alpha.workspaceId}/wage-rates/bulk`, {
    farmId: alpha.farmId,
    seasonId: alpha.seasonId,
    effectiveFrom: "2026-05-01",
    effectiveTo: "2026-05-31",
    rows: [{ labourerId, dailyRate: 120, halfDayRate: 60 }],
  }), 200, "create attendance-report wage rate");
  for (const [date, status] of [["2026-05-01", "present"], ["2026-05-02", "half_day"], ["2026-05-03", "absent"]] as const) {
    assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "attendance", randomUUID(), {
      labourerId, date, status,
    }))).statusCode, 200);
  }
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "advance", randomUUID(), {
    labourerId, accountId: alphaCashId, date: "2026-05-02", amount: 45, notes: "Midweek advance",
  }))).statusCode, 200);
  const path = `/v1/workspace/${alpha.workspaceId}/attendance/report?farmId=${alpha.farmId}&seasonId=${alpha.seasonId}&from=2026-05-01&to=2026-05-03`;
  const report = await request(alpha.token, "GET", path);
  assert.equal(report.statusCode, 200);
  assert.equal(report.json().records.length, 3);
  assert.deepEqual(report.json().advances.map((item: { labourerId: string; date: string; amount: number }) => item), [
    { id: report.json().advances[0].id, labourerId, date: "2026-05-02", amount: 45 },
  ]);
  assert.deepEqual({
    id: report.json().summaries[0].id,
    name: report.json().summaries[0].name,
    presentDays: report.json().summaries[0].presentDays,
    halfDays: report.json().summaries[0].halfDays,
    absentDays: report.json().summaries[0].absentDays,
    payableDays: report.json().summaries[0].payableDays,
    totalWage: report.json().summaries[0].totalWage,
    missingRateDates: report.json().summaries[0].missingRateDates,
  }, {
    id: labourerId, name: "Alpha Worker", presentDays: 1, halfDays: 1, absentDays: 1,
    payableDays: 1.5, totalWage: 180, missingRateDates: [],
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
    labourerId, accountId: alphaCashId, date: "2026-05-04", amount: 120, notes: "Seed cash",
  }))).statusCode, 200);
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "advance", randomUUID(), {
    labourerId, accountId: alphaCashId, date: "2026-05-05", amount: 80, notes: "Food",
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
  assert.deepEqual(unusedPreview.json(), {
    labourId: unusedLabourerId,
    labourName: "Unused Worker",
    attendanceCount: 0,
    advanceCount: 0,
    paymentCount: 0,
    protectedRecordCount: 0,
    action: "delete",
  });
  assert.equal((await request(alpha.token, "DELETE", `/api/workspaces/${alpha.workspaceId}/labour/${unusedLabourerId}`, {})).statusCode, 400);
  const deleted = await request(alpha.token, "DELETE", `/api/workspaces/${alpha.workspaceId}/labour/${unusedLabourerId}`, { confirmation: "DELETE" });
  assert.deepEqual(deleted.json(), {
    action: "deleted",
    attendanceCount: 0,
    advanceCount: 0,
    paymentCount: 0,
    protectedRecordCount: 0,
  });

  const linkedLabourerId = randomUUID();
  const linkedPaymentAccountId = await createAccount(alpha, "Historical Worker Cash");
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "labourer", linkedLabourerId, {
    name: "Historical Worker", group: "General", dailyWage: 95,
  }))).statusCode, 200);
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "attendance", randomUUID(), {
    labourerId: linkedLabourerId, date: "2026-08-01", status: "present",
  }))).statusCode, 200);
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "advance", randomUUID(), {
    labourerId: linkedLabourerId, date: "2026-08-01", amount: 25, accountId: linkedPaymentAccountId,
  }))).statusCode, 200);
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "labourPayment", randomUUID(), {
    labourerId: linkedLabourerId, date: "2026-08-01", amount: 40, paymentMethod: "Cash",
  }))).statusCode, 200);
  assert.equal((await request(bravo.token, "GET", `/api/workspaces/${alpha.workspaceId}/labour/${linkedLabourerId}/deletion-preview`)).statusCode, 403);
  const linkedPreview = await request(alpha.token, "GET", `/api/workspaces/${alpha.workspaceId}/labour/${linkedLabourerId}/deletion-preview`);
  assert.deepEqual(linkedPreview.json(), {
    labourId: linkedLabourerId,
    labourName: "Historical Worker",
    attendanceCount: 1,
    advanceCount: 1,
    paymentCount: 1,
    protectedRecordCount: 3,
    action: "deactivate",
  });
  assert.equal((await request(alpha.token, "DELETE", `/api/workspaces/${alpha.workspaceId}/labour/${linkedLabourerId}`, { confirmation: "DELETE" })).statusCode, 400);
  const deactivated = await request(alpha.token, "DELETE", `/api/workspaces/${alpha.workspaceId}/labour/${linkedLabourerId}`, { confirmation: "DEACTIVATE", endDate: "2026-08-02" });
  const deactivatedBody = deactivated.json();
  assert.deepEqual(deactivatedBody, {
    action: "deactivated",
    attendanceCount: 1,
    advanceCount: 1,
    paymentCount: 1,
    protectedRecordCount: 3,
    record: deactivatedBody.record,
  });
  assert.equal(deactivatedBody.record.active, false);
  assert.equal(deactivatedBody.record.endedOn, "2026-08-02");
  const staleAttendance = await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "attendance", randomUUID(), {
    labourerId: linkedLabourerId, date: "2026-08-03", status: "present",
  }));
  assert.equal(staleAttendance.statusCode, 400);
  assert.match(staleAttendance.json().message, /inactive and cannot be used for new entries/i);
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
  assert.equal(farmsList.farms.some((farm: { id: string }) => farm.id === farmId), false);
  assert.equal(farmsList.historyFarms.find((farm: { id: string }) => farm.id === farmId)?.active, false);
  assert.equal(farmsList.activeFarmId, alpha.farmId);
});

test("workspace owners can update their profile while non-owners and foreign tenants cannot", async () => {
  const originalBravo = await request(bravo.token, "GET", `/v1/workspace/${bravo.workspaceId}/profile`);
  assert.equal(originalBravo.statusCode, 200);

  const updated = await request(alpha.token, "PATCH", `/v1/workspace/${alpha.workspaceId}/profile`, {
    name: "Workspace Alpha Renamed",
    contactEmail: "alpha-renamed@example.test",
    contactPhone: "+966500000099",
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().workspace.name, "Workspace Alpha Renamed");
  assert.equal(updated.json().user.workspaceName, "Workspace Alpha Renamed");
  assert.equal(updated.json().user.memberships.find((membership: { workspaceId: string }) => membership.workspaceId === alpha.workspaceId).workspaceName, "Workspace Alpha Renamed");

  const refreshedSession = await request(alpha.token, "GET", "/v1/session");
  assert.equal(refreshedSession.statusCode, 200);
  assert.equal(refreshedSession.json().user.workspaceName, "Workspace Alpha Renamed");

  assert.equal((await request(supervisor.token, "GET", `/v1/workspace/${alpha.workspaceId}/profile`)).statusCode, 200);
  assert.equal((await request(supervisor.token, "PATCH", `/v1/workspace/${alpha.workspaceId}/profile`, {
    name: "Supervisor Forged Rename",
    contactEmail: "forged@example.test",
  })).statusCode, 403);
  assert.equal((await request(bravo.token, "PATCH", `/v1/workspace/${alpha.workspaceId}/profile`, {
    name: "Foreign Forged Rename",
    contactEmail: "foreign@example.test",
  })).statusCode, 403);

  const bravoProfile = await request(bravo.token, "GET", `/v1/workspace/${bravo.workspaceId}/profile`);
  assert.equal(bravoProfile.statusCode, 200);
  assert.equal(bravoProfile.json().workspace.name, originalBravo.json().workspace.name);
});

test("migration import batches returns 200 with an empty list when no imports exist", async () => {
  const response = await request(admin.token, "GET", `/v1/admin/migration-import/batches?workspaceId=${alpha.workspaceId}`);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { records: [] });
});

test("workspace team invitations, module overrides, and last-owner protection remain tenant scoped", async () => {
  const invitedEmail = `invited.member.${randomUUID()}@example.test`;
  assert.equal((await request(bravo.token, "GET", `/v1/workspace/${alpha.workspaceId}/team`)).statusCode, 403);
  assert.equal((await request(supervisor.token, "POST", `/v1/workspace/${alpha.workspaceId}/team/invitations`, {
    email: "forged.member@example.test", role: "viewer",
  })).statusCode, 403);

  const invitation = await request(alpha.token, "POST", `/v1/workspace/${alpha.workspaceId}/team/invitations`, {
    email: invitedEmail, phone: "+966500000123", role: "operator",
  });
  assert.equal(invitation.statusCode, 201);
  assert.ok(invitation.json().invitationToken);
  assert.equal((await request("", "POST", "/v1/workspace/team/invitations/accept", {
    token: invitation.json().invitationToken,
    displayName: "Invited Member",
    phone: "+966500000123",
    password: "password123",
  })).statusCode, 201);
  const team = await request(alpha.token, "GET", `/v1/workspace/${alpha.workspaceId}/team`);
  assert.equal(team.statusCode, 200);
  assert.ok(team.json().members.some((member: { email: string; role: string }) => member.email === invitedEmail && member.role === "operator"));

  const supervisorMembership = team.json().members.find((member: { userId: string }) => member.userId === supervisor.userId);
  assert.ok(supervisorMembership);
  assert.equal((await request(alpha.token, "PATCH", `/v1/workspace/${alpha.workspaceId}/team/${supervisorMembership.id}`, {
    role: "supervisor", active: true, permissions: { attendance: { view: false } },
  })).statusCode, 200);
  const supervisorSnapshot = await request(supervisor.token, "GET", `/v1/workspace/${alpha.workspaceId}/operational-records`);
  assert.equal(supervisorSnapshot.statusCode, 200);
  assert.ok(supervisorSnapshot.json().records.every((record: { entity: string }) => record.entity !== "attendance"));

  const ownerMembership = team.json().members.find((member: { userId: string }) => member.userId === alpha.userId);
  assert.ok(ownerMembership);
  assert.equal((await request(alpha.token, "DELETE", `/v1/workspace/${alpha.workspaceId}/team/${ownerMembership.id}`)).statusCode, 409);
});

test("farm assignment restricts bootstrap, farm lists, reports, and operational writes to assigned farms only", async () => {
  const bootstrap = await request(viewer.token, "GET", "/v1/bootstrap");
  assert.equal(bootstrap.statusCode, 200);
  assert.equal(bootstrap.json().farms.length, 1);
  assert.equal(bootstrap.json().farms[0].id, alpha.farmId);
  assert.ok(Number(bootstrap.json().workspaceFarmCount ?? 0) >= 2);
  assert.equal(bootstrap.json().accessibleFarmCount, 1);
  assert.deepEqual(bootstrap.json().accessibleFarmIds, [alpha.farmId]);
  assert.equal(bootstrap.json().farmAccessReason, "assigned");

  const farmList = await request(viewer.token, "GET", `/v1/workspace/${alpha.workspaceId}/farms`);
  assert.equal(farmList.statusCode, 200);
  assert.deepEqual(farmList.json().farms.map((farm: { id: string }) => farm.id), [alpha.farmId]);

  const secondaryReport = await request(viewer.token, "GET", `/v1/workspace/${alpha.workspaceId}/attendance/report?farmId=${alphaSecondary.farmId}&seasonId=${alphaSecondary.seasonId}&from=2026-01-01&to=2026-01-02`);
  assert.equal(secondaryReport.statusCode, 403);

  const selectSecondaryFarm = await request(viewer.token, "POST", `/v1/workspace/${alpha.workspaceId}/farms/${alphaSecondary.farmId}/select`);
  assert.equal(selectSecondaryFarm.statusCode, 403);

  const secondaryWrite = await request(viewer.token, "POST", "/v1/workspace/operational-records", {
    ...envelope(alpha, "attendance", randomUUID(), { labourerId: randomUUID(), date: "2026-06-10", status: "present" }),
    farmId: alphaSecondary.farmId,
    seasonId: alphaSecondary.seasonId,
  });
  assert.equal(secondaryWrite.statusCode, 403);
});

test("viewer permissions are enforced server-side for create and delete actions", async () => {
  const labourerId = randomUUID();
  const createAttempt = await request(viewer.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "labourer", labourerId, {
    name: "Viewer Created Worker",
    group: "Restricted",
    dailyWage: 90,
  }));
  assert.equal(createAttempt.statusCode, 403);

  const ownerCreated = await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "labourer", labourerId, {
    name: "Owner Created Worker",
    group: "Allowed",
    dailyWage: 90,
  }));
  assert.equal(ownerCreated.statusCode, 200);

  const deleteAttempt = await request(viewer.token, "DELETE", "/v1/workspace/operational-records", {
    workspaceId: alpha.workspaceId,
    farmId: alpha.farmId,
    seasonId: alpha.seasonId,
    entity: "attendance",
    recordId: labourerId,
  });
  assert.equal(deleteAttempt.statusCode, 403);
});

test("accountant role is finance-scoped and cannot mutate attendance records", async () => {
  const accountId = await createAccount(alpha, "Accountant Cash");
  const voucherAttempt = await request(accountant.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "voucher", randomUUID(), {
    ...financialRecord(alpha, "voucher"),
    accountId,
  }));
  assert.equal(voucherAttempt.statusCode, 200);

  const attendanceAttempt = await request(accountant.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "attendance", randomUUID(), {
    labourerId: randomUUID(),
    date: "2026-06-12",
    status: "present",
  }));
  assert.equal(attendanceAttempt.statusCode, 403);

  const reportAttempt = await request(accountant.token, "GET", `/v1/workspace/${alpha.workspaceId}/expenses/search?farmId=${alpha.farmId}&seasonId=${alpha.seasonId}&from=2026-01-01&to=2026-12-31`);
  assert.equal(reportAttempt.statusCode, 200);
});

test("workspace owner permissions resolve to full voucher create even when duplicate lower-privilege memberships exist", async () => {
  const permissionUser = {
    platformRole: null,
    memberships: [
      {
        workspaceId: alpha.workspaceId,
        role: "viewer" as const,
        active: true,
        permissions: { dashboard: { view: true } },
      },
      {
        workspaceId: alpha.workspaceId,
        role: "workspace_owner" as const,
        active: true,
        permissions: null,
      },
    ],
  };

  assert.equal(hasPermission(permissionUser, "SUBMIT_RECORDS", alpha.workspaceId), true);
  assert.equal(hasPermission(permissionUser, "MANAGE_RECORDS", alpha.workspaceId), true);
  assert.equal(hasModulePermission(permissionUser, alpha.workspaceId, "expenses", "create"), true);
  assert.equal(hasModulePermission(permissionUser, alpha.workspaceId, "expenses", "edit"), true);
});

test("workspace owner can sync voucher create with null permissions and season mismatch returns stale_context details", async () => {
  const accountId = await createAccount(alpha, "Owner Voucher Create Cash");
  const categorySelection = await firstExpenseCategorySelection(alpha);

  const voucherAttempt = await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "voucher", randomUUID(), {
    ...financialRecord(alpha, "voucher"),
    accountId,
    ...categorySelection,
  }));
  assert.equal(voucherAttempt.statusCode, 200);

  const staleSeasonAttempt = await request(alpha.token, "POST", "/v1/workspace/operational-records", {
    ...envelope(alpha, "voucher", randomUUID(), {
      ...financialRecord(alpha, "voucher"),
      accountId,
      ...categorySelection,
    }),
    seasonId: alphaSecondary.seasonId,
  });
  assert.equal(staleSeasonAttempt.statusCode, 403);
  assert.equal(staleSeasonAttempt.json().details?.code, "stale_season_context");
});

test("voucher uniqueness uses current voucherNumber only, not original or legacy audit fields", async () => {
  const accountId = await createAccount(alpha, "Voucher Audit Scope Cash");
  const categorySelection = await firstExpenseCategorySelection(alpha);
  const firstVoucherId = randomUUID();
  const secondVoucherId = randomUUID();

  const firstCreate = await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "voucher", firstVoucherId, {
    ...financialRecord(alpha, "voucher"),
    accountId,
    ...categorySelection,
    voucherNumber: "V-0141",
    originalVoucherNumber: "V-0500",
    legacyVoucherNumber: "V-0500",
  }));
  assert.equal(firstCreate.statusCode, 200);

  const secondCreate = await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "voucher", secondVoucherId, {
    ...financialRecord(alpha, "voucher"),
    accountId,
    ...categorySelection,
    voucherNumber: "V-0500",
    originalVoucherNumber: "V-0999",
    legacyVoucherNumber: "V-0999",
  }));
  assert.equal(secondCreate.statusCode, 200);
  assert.equal(secondCreate.json().record.voucherNumber, "V-0500");
});

test("custom module permissions block expense history APIs even when workspace membership exists", async () => {
  const team = await request(alpha.token, "GET", `/v1/workspace/${alpha.workspaceId}/team`);
  assert.equal(team.statusCode, 200);
  const supervisorMembership = team.json().members.find((member: { userId: string }) => member.userId === supervisor.userId);
  assert.ok(supervisorMembership);
  assert.equal((await request(alpha.token, "PATCH", `/v1/workspace/${alpha.workspaceId}/team/${supervisorMembership.id}`, {
    role: "supervisor",
    active: true,
    permissions: { expenses: { view: false } },
  })).statusCode, 200);

  const accountId = await createAccount(alpha, "Restricted Expense Cash");
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "voucher", randomUUID(), {
    ...financialRecord(alpha, "voucher"),
    accountId,
  }))).statusCode, 200);

  const blockedSearch = await request(supervisor.token, "GET", `/v1/workspace/${alpha.workspaceId}/expenses/search?farmId=${alpha.farmId}&seasonId=${alpha.seasonId}&from=2026-01-01&to=2026-12-31`);
  assert.equal(blockedSearch.statusCode, 403);
});

test("labour lifecycle deletion API requires workforce delete permission instead of coarse team permission", async () => {
  const labourerId = randomUUID();
  assert.equal((await request(alpha.token, "POST", "/v1/workspace/operational-records", envelope(alpha, "labourer", labourerId, {
    name: "Protected Worker",
    group: "General",
    dailyWage: 100,
  }))).statusCode, 200);

  const preview = await request(manager.token, "GET", `/api/workspaces/${alpha.workspaceId}/labour/${labourerId}/deletion-preview`);
  assert.equal(preview.statusCode, 403);

  const deletion = await request(manager.token, "DELETE", `/api/workspaces/${alpha.workspaceId}/labour/${labourerId}`, {
    confirmation: "DELETE",
  });
  assert.equal(deletion.statusCode, 403);
});

test("admin and migration routes reject ordinary workspace users", async () => {
  assert.equal((await request(viewer.token, "GET", "/v1/admin/users")).statusCode, 403);
  assert.equal((await request(alpha.token, "GET", `/v1/admin/migration-import/batches?workspaceId=${alpha.workspaceId}`)).statusCode, 403);
});

test("workspace invitation acceptance enforces invited email matching", async () => {
  const invitedEmail = `security.invited.${randomUUID()}@example.test`;
  const invitation = await request(alpha.token, "POST", `/v1/workspace/${alpha.workspaceId}/team/invitations`, {
    email: invitedEmail,
    role: "viewer",
  });
  assert.equal(invitation.statusCode, 201);
  const invitationToken = invitation.json().invitationToken;
  assert.ok(invitationToken);

  const wrongEmail = await request("", "POST", "/v1/workspace-invitations/accept", {
    token: invitationToken,
    mode: "login",
    email: `alpha-${alpha.userId}@example.test`,
    password: "password123",
  });
  assert.equal(wrongEmail.statusCode, 409);
  assert.equal(wrongEmail.json().code, "email_mismatch");
});

test("accepting the same invitation twice does not create duplicate workspace memberships", async () => {
  const repeatEmail = `repeat.member.${randomUUID()}@example.test`;
  const invitation = await request(alpha.token, "POST", `/v1/workspace/${alpha.workspaceId}/team/invitations`, {
    email: repeatEmail,
    role: "viewer",
  });
  assert.equal(invitation.statusCode, 201);
  const token = invitation.json().invitationToken;
  assert.ok(token);

  const firstAccept = await request("", "POST", "/v1/workspace/team/invitations/accept", {
    token,
    displayName: "Repeat Member",
    password: "password123",
  });
  assert.equal(firstAccept.statusCode, 201);

  const secondAccept = await request("", "POST", "/v1/workspace/team/invitations/accept", {
    token,
    displayName: "Repeat Member",
    password: "password123",
  });
  assert.equal(secondAccept.statusCode, 409);

  const [repeatUser] = await db.select({ id: users.id }).from(users).where(eq(users.email, repeatEmail)).limit(1);
  assert.ok(repeatUser);
  const [membershipCount] = await db.select({ count: sql<number>`count(*)::int` }).from(workspaceMemberships).where(and(
    eq(workspaceMemberships.workspaceId, alpha.workspaceId),
    eq(workspaceMemberships.userId, repeatUser.id),
  ));
  assert.equal(Number(membershipCount?.count ?? 0), 1);
});

test("normal signup creates an approved user with a single default workspace and active session", async () => {
  const email = `signup-${randomUUID()}@example.test`;
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: {
      ownerName: "Signup Owner",
      email,
      phone: "+966500001111",
      password: "Password123!",
    },
  });
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().status, "approved");
  assert.ok(response.json().token);
  assert.equal(response.json().user.workspaceName, "Default Workspace");

  const [createdUser] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  assert.ok(createdUser);
  assert.equal(createdUser?.workspaceId, response.json().user.workspaceId);

  const memberships = await db.select({
    workspaceId: workspaceMemberships.workspaceId,
    role: workspaceMemberships.role,
  }).from(workspaceMemberships).where(eq(workspaceMemberships.userId, createdUser!.id));
  assert.equal(memberships.length, 1);
  assert.equal(memberships[0]?.role, "workspace_owner");

  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, memberships[0]!.workspaceId)).limit(1);
  assert.equal(workspace?.name, "Default Workspace");
  assert.equal(workspace?.status, "approved");
});

test("invitation signup creates only the invited workspace membership and no default workspace", async () => {
  const invitedEmail = `invited-signup-${randomUUID()}@example.test`;
  const invitation = await request(alpha.token, "POST", `/v1/workspace/${alpha.workspaceId}/team/invitations`, {
    email: invitedEmail,
    role: "viewer",
    farmAccessMode: "all",
  });
  assert.equal(invitation.statusCode, 201);

  const accept = await app.inject({
    method: "POST",
    url: "/v1/workspace-invitations/register-and-accept",
    payload: {
      token: invitation.json().invitationToken,
      displayName: "Invited Signup",
      password: "Password123!",
      phone: "+966500002222",
      mode: "signup",
    },
  });
  assert.equal(accept.statusCode, 201);
  assert.equal(accept.json().workspaceId, alpha.workspaceId);
  assert.equal(accept.json().user.workspaceId, alpha.workspaceId);

  const [invitedUser] = await db.select().from(users).where(eq(users.email, invitedEmail)).limit(1);
  assert.ok(invitedUser);
  assert.equal(invitedUser?.workspaceId, alpha.workspaceId);

  const memberships = await db.select({
    workspaceId: workspaceMemberships.workspaceId,
    role: workspaceMemberships.role,
  }).from(workspaceMemberships).where(eq(workspaceMemberships.userId, invitedUser!.id));
  assert.equal(memberships.length, 1);
  assert.equal(memberships[0]?.workspaceId, alpha.workspaceId);
  assert.equal(memberships[0]?.role, "viewer");

  const ownedDefaultWorkspaces = await db.select({
    workspaceId: workspaces.id,
  }).from(workspaceMemberships)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
    .where(and(
      eq(workspaceMemberships.userId, invitedUser!.id),
      eq(workspaceMemberships.role, "workspace_owner"),
      eq(workspaces.name, "Default Workspace"),
    ));
  assert.equal(ownedDefaultWorkspaces.length, 0);
});

test("users can update only their own display name through /v1/me", async () => {
  const response = await request(alpha.token, "PATCH", "/v1/me", {
    displayName: "Owner Renamed",
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().user.displayName, "Owner Renamed");

  const me = await request(alpha.token, "GET", "/v1/me");
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().user.displayName, "Owner Renamed");

  const [savedUser] = await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, alpha.userId)).limit(1);
  assert.equal(savedUser?.displayName, "Owner Renamed");
});

test("admin repair removes empty default workspaces created alongside an invited workspace", async () => {
  const affectedUserId = randomUUID();
  const emptyWorkspaceId = randomUUID();
  const realWorkspaceId = randomUUID();
  const repairedEmail = `repaired-${affectedUserId}@example.test`;
  await db.insert(workspaces).values([
    { id: emptyWorkspaceId, name: "Default Workspace", slug: `default-${emptyWorkspaceId}`, contactEmail: repairedEmail, status: "approved" },
    { id: realWorkspaceId, name: "Real Invited Workspace", slug: `real-${realWorkspaceId}`, contactEmail: repairedEmail, status: "approved" },
  ]);
  await db.insert(users).values({
    id: affectedUserId,
    email: repairedEmail,
    passwordHash: "test",
    displayName: "Affected Invitee",
    status: "approved",
    active: true,
    workspaceId: emptyWorkspaceId,
  });
  await db.insert(workspaceMemberships).values([
    { workspaceId: emptyWorkspaceId, userId: affectedUserId, role: "workspace_owner", active: true, farmAccessMode: "all" },
    { workspaceId: realWorkspaceId, userId: affectedUserId, role: "viewer", active: true, farmAccessMode: "all" },
  ]);

  const repaired = await request(admin.token, "POST", "/v1/admin/users/repair-invited-default-workspaces");
  assert.equal(repaired.statusCode, 200);
  assert.ok(repaired.json().repairedCount >= 1);

  const [userRow] = await db.select({ workspaceId: users.workspaceId }).from(users).where(eq(users.id, affectedUserId)).limit(1);
  assert.equal(userRow?.workspaceId, realWorkspaceId);
  const remainingMemberships = await db.select().from(workspaceMemberships).where(eq(workspaceMemberships.userId, affectedUserId));
  assert.equal(remainingMemberships.length, 1);
  assert.equal(remainingMemberships[0]?.workspaceId, realWorkspaceId);
  const deletedWorkspace = await db.select().from(workspaces).where(eq(workspaces.id, emptyWorkspaceId));
  assert.equal(deletedWorkspace.length, 0);
});

test("inviting an existing member updates the existing membership instead of creating a duplicate", async () => {
  const memberEmail = `existing.member.${randomUUID()}@example.test`;
  const memberUserId = randomUUID();
  await db.insert(users).values({
    id: memberUserId,
    email: memberEmail,
    passwordHash: "test",
    status: "approved",
    active: true,
  });
  const [existingMembership] = await db.insert(workspaceMemberships).values({
    workspaceId: alpha.workspaceId,
    userId: memberUserId,
    role: "viewer",
    active: true,
    farmAccessMode: "assigned",
  }).returning({ id: workspaceMemberships.id });
  await db.insert(workspaceMemberFarms).values({
    workspaceId: alpha.workspaceId,
    membershipId: existingMembership!.id,
    farmId: alpha.farmId,
  });

  const reinvite = await request(alpha.token, "POST", `/v1/workspace/${alpha.workspaceId}/team/invitations`, {
    email: memberEmail,
    role: "supervisor",
    farmAccessMode: "all",
  });
  assert.equal(reinvite.statusCode, 200);
  assert.equal(reinvite.json().membershipUpdated, true);

  const memberships = await db.select({
    id: workspaceMemberships.id,
    role: workspaceMemberships.role,
    farmAccessMode: workspaceMemberships.farmAccessMode,
  }).from(workspaceMemberships).where(and(
    eq(workspaceMemberships.workspaceId, alpha.workspaceId),
    eq(workspaceMemberships.userId, memberUserId),
  ));
  assert.equal(memberships.length, 1);
  assert.equal(memberships[0]?.role, "supervisor");
  assert.equal(memberships[0]?.farmAccessMode, "all");
});

test("duplicate membership repair migration leaves one membership row and preserves farm assignments", async () => {
  const duplicateEmail = `duplicate.membership.${randomUUID()}@example.test`;
  const duplicateUserId = randomUUID();
  await db.insert(users).values({
    id: duplicateUserId,
    email: duplicateEmail,
    passwordHash: "test",
    status: "approved",
    active: true,
  });

  await db.execute(sql.raw("ALTER TABLE workspace_memberships DROP CONSTRAINT IF EXISTS workspace_memberships_workspace_id_user_id_key"));
  await db.execute(sql.raw("DROP INDEX IF EXISTS workspace_memberships_workspace_user_uidx"));
  const [staleMembership] = await db.insert(workspaceMemberships).values({
    workspaceId: alpha.workspaceId,
    userId: duplicateUserId,
    role: "viewer",
    active: true,
    farmAccessMode: "assigned",
    permissions: null,
  }).returning({ id: workspaceMemberships.id });
  const [preferredMembership] = await db.insert(workspaceMemberships).values({
    workspaceId: alpha.workspaceId,
    userId: duplicateUserId,
    role: "viewer",
    active: true,
    farmAccessMode: "all",
    permissions: { dashboard: { view: true } },
  }).returning({ id: workspaceMemberships.id });

  await db.insert(workspaceMemberFarms).values({
    workspaceId: alpha.workspaceId,
    membershipId: staleMembership!.id,
    farmId: alpha.farmId,
  });

  const migrationSql = await readFile(new URL("../../database/migrations/0031_workspace_membership_dedup.sql", import.meta.url), "utf8");
  await db.execute(sql.raw(migrationSql));

  const repairedMemberships = await db.select({
    id: workspaceMemberships.id,
    permissions: workspaceMemberships.permissions,
    farmAccessMode: workspaceMemberships.farmAccessMode,
  }).from(workspaceMemberships).where(and(
    eq(workspaceMemberships.workspaceId, alpha.workspaceId),
    eq(workspaceMemberships.userId, duplicateUserId),
  ));
  assert.equal(repairedMemberships.length, 1);
  assert.equal(repairedMemberships[0]?.id, preferredMembership!.id);
  assert.equal(repairedMemberships[0]?.farmAccessMode, "all");
  assert.ok(repairedMemberships[0]?.permissions);

  const repairedAssignments = await db.select({ farmId: workspaceMemberFarms.farmId })
    .from(workspaceMemberFarms)
    .where(eq(workspaceMemberFarms.membershipId, preferredMembership!.id));
  assert.deepEqual(repairedAssignments.map((assignment) => assignment.farmId), [alpha.farmId]);

  const [duplicateCount] = await db.select({ count: sql<number>`count(*)::int` }).from(workspaceMemberships).where(and(
    eq(workspaceMemberships.workspaceId, alpha.workspaceId),
    eq(workspaceMemberships.userId, duplicateUserId),
  ));
  assert.equal(Number(duplicateCount?.count ?? 0), 1);
});

test("viewer with all-farm access sees active farms read-only", async () => {
  const viewerAllEmail = `viewer.all.${randomUUID()}@example.test`;
  const viewerAllUserId = randomUUID();
  const viewerAllToken = `viewer-all-${randomUUID()}`;
  await db.insert(users).values({
    id: viewerAllUserId,
    email: viewerAllEmail,
    passwordHash: "test",
    status: "approved",
    active: true,
  });
  await db.insert(workspaceMemberships).values({
    workspaceId: alpha.workspaceId,
    userId: viewerAllUserId,
    role: "viewer",
    active: true,
    farmAccessMode: "all",
    permissions: { dashboard: { view: true } },
  });
  await db.insert(userSessions).values({
    userId: viewerAllUserId,
    workspaceId: alpha.workspaceId,
    activeFarmId: alpha.farmId,
    activeSeasonId: alpha.seasonId,
    tokenHash: hash(viewerAllToken),
    expiresAt: new Date(Date.now() + 60_000),
  });

  const bootstrap = await request(viewerAllToken, "GET", "/v1/bootstrap");
  assert.equal(bootstrap.statusCode, 200);
  const visibleFarmIds = bootstrap.json().farms.map((farm: { id: string }) => farm.id);
  assert.ok(visibleFarmIds.includes(alpha.farmId));
  assert.ok(visibleFarmIds.includes(alphaSecondary.farmId));
  assert.ok(Number(bootstrap.json().workspaceFarmCount ?? 0) >= 2);
  assert.equal(bootstrap.json().accessibleFarmCount, bootstrap.json().farms.length);
  assert.equal(bootstrap.json().farmAccessReason, "all");

  const createAttempt = await request(viewerAllToken, "POST", "/v1/workspace/operational-records", envelope(alpha, "attendance", randomUUID(), {
    labourerId: randomUUID(),
    date: "2026-06-20",
    status: "present",
  }));
  assert.equal(createAttempt.statusCode, 403);
});

test("login picks the active populated workspace first and workspace switching persists the preference", async () => {
  const emptyWorkspaceId = randomUUID();
  const populatedWorkspaceId = randomUUID();
  const populatedFarmId = randomUUID();
  const populatedSeasonId = randomUUID();
  const memberUserId = randomUUID();
  const email = `multi-workspace-${memberUserId}@example.test`;
  const password = "Password123!";

  await db.insert(workspaces).values([
    { id: emptyWorkspaceId, name: "Default Workspace", slug: `default-${emptyWorkspaceId}`, contactEmail: email, status: "approved" },
    { id: populatedWorkspaceId, name: "مزارع العوشزية", slug: `active-${populatedWorkspaceId}`, contactEmail: email, status: "approved" },
  ]);
  await db.insert(users).values({
    id: memberUserId,
    email,
    passwordHash: await hashPassword(password),
    status: "approved",
    active: true,
    workspaceId: null,
  });
  await db.insert(workspaceMemberships).values([
    { workspaceId: emptyWorkspaceId, userId: memberUserId, role: "viewer", active: true, farmAccessMode: "all" },
    { workspaceId: populatedWorkspaceId, userId: memberUserId, role: "viewer", active: true, farmAccessMode: "all" },
  ]);
  await db.insert(farms).values({ id: populatedFarmId, workspaceId: populatedWorkspaceId, name: "Imported Active Farm" });
  await db.insert(seasons).values({
    id: populatedSeasonId,
    workspaceId: populatedWorkspaceId,
    farmId: populatedFarmId,
    name: "2026 Season",
    year: 2026,
    startsOn: "2026-01-01",
    status: "active",
  });

  try {
    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email, password },
    });
    assert.equal(login.statusCode, 200);
    assert.equal(login.json().user.workspaceId, populatedWorkspaceId);
    assert.equal(login.json().user.workspaceSelectionReason, "first_accessible_workspace");

    const switched = await app.inject({
      method: "POST",
      url: "/v1/session/workspace",
      headers: { authorization: `Bearer ${login.json().token}` },
      payload: { workspaceId: emptyWorkspaceId },
    });
    assert.equal(switched.statusCode, 200);
    assert.equal(switched.json().user.workspaceId, emptyWorkspaceId);
    assert.equal(switched.json().user.workspaceSelectionReason, "explicit_workspace");

    const [updatedUser] = await db.select({ workspaceId: users.workspaceId }).from(users).where(eq(users.id, memberUserId)).limit(1);
    assert.equal(updatedUser?.workspaceId, emptyWorkspaceId);

    const session = await app.inject({
      method: "GET",
      url: "/v1/session",
      headers: { authorization: `Bearer ${login.json().token}` },
    });
    assert.equal(session.statusCode, 200);
    assert.equal(session.json().user.workspaceId, emptyWorkspaceId);

    const bootstrap = await app.inject({
      method: "GET",
      url: "/v1/bootstrap",
      headers: { authorization: `Bearer ${login.json().token}` },
    });
    assert.equal(bootstrap.statusCode, 200);
    assert.equal(bootstrap.json().activeWorkspaceId, emptyWorkspaceId);
    assert.equal(bootstrap.json().availableWorkspaces.length, 2);
    assert.equal(bootstrap.json().workspaceFarmCount, 0);
    assert.equal(bootstrap.json().accessibleFarmCount, 0);
    assert.equal(bootstrap.json().farmAccessReason, "no_workspace_farms");
  } finally {
    await db.delete(userSessions).where(eq(userSessions.userId, memberUserId));
    await db.delete(workspaceMemberships).where(eq(workspaceMemberships.userId, memberUserId));
    await db.delete(seasons).where(inArray(seasons.workspaceId, [emptyWorkspaceId, populatedWorkspaceId]));
    await db.delete(farms).where(inArray(farms.workspaceId, [emptyWorkspaceId, populatedWorkspaceId]));
    await db.delete(users).where(eq(users.id, memberUserId));
    await db.delete(workspaces).where(inArray(workspaces.id, [emptyWorkspaceId, populatedWorkspaceId]));
  }
});
