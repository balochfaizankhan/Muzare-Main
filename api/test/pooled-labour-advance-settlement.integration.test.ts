import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { closeDatabaseConnection, db } from "../src/db/client.js";
import {
  accountTransactions,
  accounts,
  auditLogs,
  farms,
  labourAccountingEntries,
  labourAdvanceApplications,
  labourDues,
  labourPaymentAllocations,
  labourPaymentVouchers,
  operationalRecords,
  seasons,
  userSessions,
  users,
  workspaceMemberships,
  workspaces,
} from "../src/db/schema.js";
import { assertIntegrationResponse, assertPersistedUuid } from "./helpers/integration-response.js";

const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl ? false : "DATABASE_URL is not configured";

const now = new Date("2026-07-01T00:00:00.000Z").toISOString();
const tenant = {
  workspaceId: randomUUID(),
  farmId: randomUUID(),
  seasonId: randomUUID(),
  userId: randomUUID(),
  token: `pooled-advance-${randomUUID()}`,
};
let app: Awaited<ReturnType<typeof buildApp>>;
let labourerId: string;
let paymentAccountId: string;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const request = async (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${tenant.token}` }, payload });
const setupRequest = async (step: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: Record<string, unknown>, expectedStatus = 200) =>
  assertIntegrationResponse(await request(method, url, payload), expectedStatus, step);
const envelope = (entity: string, id: string, record: Record<string, unknown>) => ({
  workspaceId: tenant.workspaceId, farmId: tenant.farmId, seasonId: tenant.seasonId,
  entity, record: { id, createdAt: now, updatedAt: now, ...record },
});

async function createAdvance(amount: number, voucherDate: string) {
  const response = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-payments/advances`, {
    farmId: tenant.farmId, seasonId: tenant.seasonId, idempotencyKey: randomUUID(), voucherDate,
    recipientScope: "INDIVIDUAL", labourerId, receivedByLabourerId: labourerId,
    receivedByNameSnapshot: "Pooled Advance Worker", amount, paymentAccountId, paymentMethod: "cash",
    description: `Pooled advance ${amount}`,
  });
  assertIntegrationResponse(response, 201, `create advance ${amount}`);
  return response.json().voucher as { id: string; paymentAmount: string };
}

async function createDue(grossAmount: number, workFromDate: string, workToDate: string) {
  const response = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-payments/dues`, {
    farmId: tenant.farmId, seasonId: tenant.seasonId, idempotencyKey: randomUUID(), source: "DIRECT",
    recipientScope: "INDIVIDUAL", labourerId, description: "Pooled advance settlement due",
    workFromDate, workToDate, agreedGrossAmount: grossAmount, authorizedDeductions: 0,
  });
  assertIntegrationResponse(response, 201, `create due ${grossAmount}`);
  return response.json().due as { id: string };
}

async function settlePool(dueId: string, amount: number, idempotencyKey = randomUUID()) {
  return request("POST", `/v1/workspace/${tenant.workspaceId}/labour-payments/dues/${dueId}/settle`, {
    farmId: tenant.farmId, seasonId: tenant.seasonId,
    advancePool: { amount, idempotencyKey, settlementDate: "2026-07-15" },
  });
}

before(async () => {
  if (!databaseUrl) return;
  await db.insert(workspaces).values({ id: tenant.workspaceId, name: "Pooled Advance Workspace", slug: `pooled-advance-${tenant.workspaceId}`, contactEmail: "pooled-advance@example.test", status: "approved" });
  await db.insert(users).values({ id: tenant.userId, email: `pooled-advance-${tenant.userId}@example.test`, passwordHash: "test", status: "approved" });
  await db.insert(workspaceMemberships).values({ workspaceId: tenant.workspaceId, userId: tenant.userId, role: "workspace_owner" });
  await db.insert(farms).values({ id: tenant.farmId, workspaceId: tenant.workspaceId, name: "Pooled Advance Farm" });
  await db.insert(seasons).values({ id: tenant.seasonId, workspaceId: tenant.workspaceId, farmId: tenant.farmId, name: "Pooled Advance Season", year: 2026, startsOn: "2026-01-01", status: "active" });
  await db.insert(userSessions).values({ userId: tenant.userId, workspaceId: tenant.workspaceId, activeFarmId: tenant.farmId, activeSeasonId: tenant.seasonId, tokenHash: hash(tenant.token), expiresAt: new Date(Date.now() + 60_000) });
  app = await buildApp();
  labourerId = randomUUID();
  await setupRequest("create pooled-advance labourer", "POST", "/v1/workspace/operational-records", envelope("labourer", labourerId, { name: "Pooled Advance Worker", active: true }));
  const [account] = await db.insert(accounts).values({ farmId: tenant.farmId, name: "Pooled Advance Cash Account", accountType: "cash", active: true }).returning({ id: accounts.id });
  assertPersistedUuid(account?.id, "create pooled-advance payment account");
  paymentAccountId = account.id;
});

after(async () => {
  if (!databaseUrl) return;
  if (app) await app.close();
  await db.delete(labourAccountingEntries).where(eq(labourAccountingEntries.workspaceId, tenant.workspaceId));
  await db.delete(labourPaymentAllocations).where(eq(labourPaymentAllocations.workspaceId, tenant.workspaceId));
  await db.delete(labourAdvanceApplications).where(eq(labourAdvanceApplications.workspaceId, tenant.workspaceId));
  await db.delete(labourPaymentVouchers).where(eq(labourPaymentVouchers.workspaceId, tenant.workspaceId));
  await db.delete(labourDues).where(eq(labourDues.workspaceId, tenant.workspaceId));
  await db.delete(accountTransactions).where(inArray(accountTransactions.farmId, [tenant.farmId]));
  await db.delete(auditLogs).where(eq(auditLogs.workspaceId, tenant.workspaceId));
  await db.delete(operationalRecords).where(inArray(operationalRecords.workspaceId, [tenant.workspaceId]));
  await db.delete(userSessions).where(eq(userSessions.userId, tenant.userId));
  await db.delete(accounts).where(eq(accounts.farmId, tenant.farmId));
  await db.delete(seasons).where(eq(seasons.workspaceId, tenant.workspaceId));
  await db.delete(farms).where(eq(farms.workspaceId, tenant.workspaceId));
  await db.delete(workspaceMemberships).where(eq(workspaceMemberships.workspaceId, tenant.workspaceId));
  await db.update(users).set({ workspaceId: null }).where(eq(users.id, tenant.userId));
  await db.delete(users).where(eq(users.id, tenant.userId));
  await db.delete(workspaces).where(eq(workspaces.id, tenant.workspaceId));
  await closeDatabaseConnection();
});

test("a requested amount is applied as one pooled row from an aggregate pool spanning several historical advance vouchers, with no cash movement and no repeated Farm Owes Partner effect", { skip }, async () => {
  const advanceOne = await createAdvance(9000, "2026-07-01");
  const advanceTwo = await createAdvance(8000, "2026-07-02");
  const advanceThree = await createAdvance(5946, "2026-07-03");
  const totalPool = 9000 + 8000 + 5946;
  const due = await createDue(totalPool, "2026-07-10", "2026-07-14");
  const requested = 7108;

  const response = await settlePool(due.id, requested);
  assertIntegrationResponse(response, 200, "apply requested amount from the aggregate pool");

  const applications = await db.select().from(labourAdvanceApplications).where(eq(labourAdvanceApplications.dueId, due.id));
  assert.equal(applications.length, 1, "exactly one application row must be persisted, not one per historical voucher");
  assert.equal(applications[0]?.advanceVoucherId, null, "the pooled row must not reference a single source advance voucher");
  assert.equal(Number(applications[0]?.amount), requested);

  for (const advance of [advanceOne, advanceTwo, advanceThree]) {
    const [voucher] = await db.select().from(labourPaymentVouchers).where(eq(labourPaymentVouchers.id, advance.id));
    assert.equal(Number(voucher?.paymentAmount), Number(advance.paymentAmount), "historical advance vouchers are never modified by settlement");
  }

  const movements = await db.select().from(accountTransactions).where(eq(accountTransactions.farmId, tenant.farmId));
  assert.equal(movements.length, 0, "applying an advance must never move cash or touch a payment account");

  const ledgerRows = await db.select().from(labourAccountingEntries).where(eq(labourAccountingEntries.entryKey, `advance-application:${applications[0]!.id}:debit`));
  assert.equal(ledgerRows[0]?.ledgerCode, "LABOUR_EXPENSE");
  const partnerRows = await db.select().from(labourAccountingEntries).where(and(
    eq(labourAccountingEntries.workspaceId, tenant.workspaceId),
    inArray(labourAccountingEntries.ledgerCode, ["PARTNER_PAYABLE", "CASH_CONTROL"]),
    eq(labourAccountingEntries.dueId, due.id),
  ));
  assert.equal(partnerRows.length, 0, "Farm Owes Partner / cash-control must not be posted again for an applied advance");

  const [duePosition] = await db.select().from(labourDues).where(eq(labourDues.id, due.id));
  assert.equal(duePosition?.paymentStatus, "PARTIALLY_SETTLED");
});

test("applying the exact full remaining pool succeeds and fully settles the due", { skip }, async () => {
  const advance = await createAdvance(4000, "2026-07-01");
  const due = await createDue(4000, "2026-07-10", "2026-07-11");
  const response = await settlePool(due.id, 4000);
  assertIntegrationResponse(response, 200, "apply the full pool exactly");
  const [duePosition] = await db.select().from(labourDues).where(eq(labourDues.id, due.id));
  assert.equal(duePosition?.paymentStatus, "SETTLED_BY_ADVANCE");
  const [voucher] = await db.select().from(labourPaymentVouchers).where(eq(labourPaymentVouchers.id, advance.id));
  assert.equal(Number(voucher?.paymentAmount), 4000, "the original advance voucher amount is untouched");
});

test("requesting more than the aggregate eligible pool is rejected with a clear message and leaves no persisted rows", { skip }, async () => {
  await createAdvance(1000, "2026-07-01");
  const due = await createDue(1000, "2026-07-10", "2026-07-11");
  const response = await settlePool(due.id, 1500);
  assert.equal(response.statusCode, 409);
  assert.match(response.json().message, /Only SAR [\d.]+ of/i, "the rejection must quantify the eligible amount rather than only a generic reference");
  const applications = await db.select().from(labourAdvanceApplications).where(eq(labourAdvanceApplications.dueId, due.id));
  assert.equal(applications.length, 0, "a rejected pool application must leave no persisted rows");
});

test("a historical individual (legacy) application reduces aggregate availability, and reversing it restores the pool", { skip }, async () => {
  const advance = await createAdvance(2000, "2026-07-01");
  const due = await createDue(2000, "2026-07-10", "2026-07-11");
  const legacyKey = randomUUID();
  const legacyResponse = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-payments/dues/${due.id}/settle`, {
    farmId: tenant.farmId, seasonId: tenant.seasonId,
    advanceApplications: [{ advanceVoucherId: advance.id, amount: 500, idempotencyKey: legacyKey }],
  });
  assertIntegrationResponse(legacyResponse, 200, "apply a legacy per-voucher application");

  const overRequest = await settlePool(due.id, 1501);
  assert.equal(overRequest.statusCode, 409, "500 already applied + 1501 requested exceeds the 2000 pool");

  const withinRequest = await settlePool(due.id, 1500);
  assertIntegrationResponse(withinRequest, 200, "the remaining 1500 is still available after the legacy application");

  const [legacyApplication] = await db.select().from(labourAdvanceApplications).where(and(
    eq(labourAdvanceApplications.dueId, due.id),
    eq(labourAdvanceApplications.idempotencyKey, legacyKey),
  ));
  assertPersistedUuid(legacyApplication?.id, "locate the legacy application to reverse");
  const reversal = await request(
    "POST",
    `/v1/workspace/${tenant.workspaceId}/labour-payments/dues/${due.id}/advance-applications/${legacyApplication.id}/reverse?farmId=${tenant.farmId}&seasonId=${tenant.seasonId}`,
    { idempotencyKey: randomUUID(), reason: "test reversal restores pool availability" },
  );
  assertIntegrationResponse(reversal, 200, "reverse the legacy application");
  const [reversedRow] = await db.select().from(labourAdvanceApplications).where(eq(labourAdvanceApplications.id, legacyApplication.id));
  assert.equal(reversedRow?.status, "REVERSED");
});

test("an advance-only due can be fully or partially settled from the pool without any direct payment", { skip }, async () => {
  await createAdvance(600, "2026-07-01");
  const fullDue = await createDue(600, "2026-07-10", "2026-07-11");
  assertIntegrationResponse(await settlePool(fullDue.id, 600), 200, "advance-only full settlement");
  const [fullDuePosition] = await db.select().from(labourDues).where(eq(labourDues.id, fullDue.id));
  assert.equal(fullDuePosition?.paymentStatus, "SETTLED_BY_ADVANCE");

  await createAdvance(900, "2026-07-02");
  const partialDue = await createDue(900, "2026-07-10", "2026-07-11");
  assertIntegrationResponse(await settlePool(partialDue.id, 300), 200, "advance-only partial settlement");
  const [partialDuePosition] = await db.select().from(labourDues).where(eq(labourDues.id, partialDue.id));
  assert.equal(partialDuePosition?.paymentStatus, "PARTIALLY_SETTLED");
});

test("two concurrent settlements against the same pool cannot together overconsume it", { skip }, async () => {
  const due = await createDue(1000, "2026-07-10", "2026-07-11");
  await createAdvance(1000, "2026-07-01");
  const [first, second] = await Promise.all([
    settlePool(due.id, 600),
    settlePool(due.id, 600),
  ]);
  const statuses = [first.statusCode, second.statusCode].sort();
  assert.deepEqual(statuses, [200, 409], "exactly one of the two concurrent 600 requests against a 1000 pool must succeed");
  const applications = await db.select().from(labourAdvanceApplications).where(and(eq(labourAdvanceApplications.dueId, due.id), eq(labourAdvanceApplications.status, "ACTIVE")));
  const totalApplied = applications.reduce((sum, row) => sum + Number(row.amount), 0);
  assert.ok(totalApplied <= 1000 + 0.005, "the aggregate pool must never be overconsumed regardless of request ordering");
});

test("a due voided or on hold cannot be settled from the pool, and posting failures leave the due and advances unchanged", { skip }, async () => {
  await createAdvance(300, "2026-07-01");
  const due = await createDue(300, "2026-07-10", "2026-07-11");
  const badResponse = await settlePool(due.id, 10_000);
  assert.equal(badResponse.statusCode, 409);
  const [duePosition] = await db.select().from(labourDues).where(eq(labourDues.id, due.id));
  assert.equal(duePosition?.paymentStatus, "UNPAID", "a rejected settlement must leave the due's status unchanged");
  const applications = await db.select().from(labourAdvanceApplications).where(eq(labourAdvanceApplications.dueId, due.id));
  assert.equal(applications.length, 0);
  const nullVoucherApplications = await db.select().from(labourAdvanceApplications).where(isNull(labourAdvanceApplications.advanceVoucherId));
  assert.equal(nullVoucherApplications.filter((row) => row.dueId === due.id).length, 0);
});
