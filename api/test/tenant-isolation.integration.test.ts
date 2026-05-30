import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { closeDatabaseConnection, db } from "../src/db/client.js";
import {
  farms,
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
  ]);
  await db.insert(workspaceMemberships).values([
    { workspaceId: alpha.workspaceId, userId: alpha.userId, role: "workspace_owner" },
    { workspaceId: bravo.workspaceId, userId: bravo.userId, role: "workspace_owner" },
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
  ]);
  app = await buildApp();
});

after(async () => {
  if (app) await app.close();
  await db.delete(workspaceApprovals).where(inArray(workspaceApprovals.workspaceId, ids));
  await db.delete(operationalRecords).where(inArray(operationalRecords.workspaceId, ids));
  await db.delete(userSessions).where(inArray(userSessions.userId, [alpha.userId, bravo.userId]));
  await db.delete(seasons).where(inArray(seasons.workspaceId, ids));
  await db.delete(farms).where(inArray(farms.workspaceId, ids));
  await db.delete(workspaceMemberships).where(inArray(workspaceMemberships.workspaceId, ids));
  await db.delete(users).where(inArray(users.id, [alpha.userId, bravo.userId]));
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
