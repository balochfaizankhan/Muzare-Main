import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { closeDatabaseConnection, db } from "../src/db/client.js";
import {
  farms,
  labourWageSettlementCreateRequests,
  operationalRecords,
  seasons,
  userSessions,
  users,
  workspaceMemberships,
  workspaces,
} from "../src/db/schema.js";
import { assertIntegrationResponse } from "./helpers/integration-response.js";

// Attendance wage-settlement CREATION is retired (attendance-generated Labour
// Dues are no longer supported). This suite is the retirement contract: every
// creation/recalculation path rejects with the clear business message, while
// the historical read/void/repair routes stay available. The former
// end-to-end creation suite was removed together with the flow it exercised.

const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl ? false : "DATABASE_URL is not configured";

const RETIREMENT_MESSAGE = "Attendance-based Labour Dues are no longer supported. Create a direct labour group due instead.";

const tenant = {
  workspaceId: randomUUID(),
  farmId: randomUUID(),
  seasonId: randomUUID(),
  userId: randomUUID(),
  token: `settlement-retirement-${randomUUID()}`,
};
let app: Awaited<ReturnType<typeof buildApp>>;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const request = async (method: "GET" | "POST" | "PATCH", url: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${tenant.token}` }, payload });

before(async () => {
  if (!databaseUrl) return;
  await db.insert(workspaces).values({ id: tenant.workspaceId, name: "Settlement Retirement Workspace", slug: `settlement-retirement-${tenant.workspaceId}`, contactEmail: "settlement-retirement@example.test", status: "approved" });
  await db.insert(users).values({ id: tenant.userId, email: `settlement-retirement-${tenant.userId}@example.test`, passwordHash: "test", status: "approved" });
  await db.insert(workspaceMemberships).values({ workspaceId: tenant.workspaceId, userId: tenant.userId, role: "workspace_owner" });
  await db.insert(farms).values({ id: tenant.farmId, workspaceId: tenant.workspaceId, name: "Settlement Retirement Farm" });
  await db.insert(seasons).values({ id: tenant.seasonId, workspaceId: tenant.workspaceId, farmId: tenant.farmId, name: "Settlement Retirement Season", year: 2026, startsOn: "2026-01-01", status: "active" });
  await db.insert(userSessions).values({ userId: tenant.userId, workspaceId: tenant.workspaceId, activeFarmId: tenant.farmId, activeSeasonId: tenant.seasonId, tokenHash: hash(tenant.token), expiresAt: new Date(Date.now() + 60_000) });
  app = await buildApp();
});

after(async () => {
  if (!databaseUrl) return;
  if (app) await app.close();
  await db.delete(labourWageSettlementCreateRequests).where(eq(labourWageSettlementCreateRequests.workspaceId, tenant.workspaceId));
  await db.delete(operationalRecords).where(eq(operationalRecords.workspaceId, tenant.workspaceId));
  await db.delete(userSessions).where(eq(userSessions.userId, tenant.userId));
  await db.delete(seasons).where(eq(seasons.workspaceId, tenant.workspaceId));
  await db.delete(farms).where(eq(farms.workspaceId, tenant.workspaceId));
  await db.delete(workspaceMemberships).where(eq(workspaceMemberships.workspaceId, tenant.workspaceId));
  await db.update(users).set({ workspaceId: null }).where(eq(users.id, tenant.userId));
  await db.delete(users).where(eq(users.id, tenant.userId));
  await db.delete(workspaces).where(eq(workspaces.id, tenant.workspaceId));
  await closeDatabaseConnection();
});

test("settlement creation, preview and recalculation reject with the retirement message and persist nothing", { skip }, async () => {
  const base = {
    farmId: tenant.farmId, seasonId: tenant.seasonId,
    fromDate: "2026-07-01", toDate: "2026-07-05", settlementDate: "2026-07-05",
    settlementMode: "group", groupId: randomUUID(), clientRequestId: randomUUID(),
  };
  const create = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-wage-settlements`, base);
  assert.equal(create.statusCode, 400);
  assert.equal(create.json().message, RETIREMENT_MESSAGE);
  const preview = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-wage-settlements/preview`, base);
  assert.equal(preview.statusCode, 400);
  assert.equal(preview.json().message, RETIREMENT_MESSAGE);
  const patch = await request("PATCH", `/v1/workspace/${tenant.workspaceId}/labour-wage-settlements/${randomUUID()}`, { fromDate: "2026-07-01" });
  assert.equal(patch.statusCode, 400);
  assert.equal(patch.json().message, RETIREMENT_MESSAGE);
  const settlements = await db.select().from(operationalRecords).where(eq(operationalRecords.workspaceId, tenant.workspaceId));
  assert.equal(settlements.filter((row) => row.entityType === "labourWageSettlement").length, 0, "a rejected creation persists no settlement record");
  const requests = await db.select().from(labourWageSettlementCreateRequests).where(eq(labourWageSettlementCreateRequests.workspaceId, tenant.workspaceId));
  assert.equal(requests.length, 0, "a rejected creation queues no create request");
});

test("historical settlement read routes remain available for compatibility", { skip }, async () => {
  const list = await request("GET", `/v1/workspace/${tenant.workspaceId}/labour-wage-settlements?farmId=${tenant.farmId}&seasonId=${tenant.seasonId}`);
  assertIntegrationResponse(list, 200, "historical settlements stay listable");
  const status = await request("GET", `/v1/workspace/${tenant.workspaceId}/labour-wage-settlements/status?farmId=${tenant.farmId}&seasonId=${tenant.seasonId}&clientRequestId=${randomUUID()}`);
  assert.ok([200, 404].includes(status.statusCode), "the create-request status probe still answers for old clients");
});
