import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { closeDatabaseConnection, db } from "../src/db/client.js";
import {
  accountTransactions,
  accounts,
  auditLogs,
  farms,
  labourAccountingEntries,
  labourAdvanceApplications,
  labourAdvanceApplicationSources,
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
  token: `group-pool-${randomUUID()}`,
};
let app: Awaited<ReturnType<typeof buildApp>>;
let groupId: string;
let otherGroupId: string;
let memberOneId: string;
let memberTwoId: string;
let outsiderId: string;
let cashAccountId: string;
let partnerAccountAId: string;
let partnerAccountBId: string;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const request = async (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${tenant.token}` }, payload });
const setupRequest = async (step: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: Record<string, unknown>, expectedStatus = 200) =>
  assertIntegrationResponse(await request(method, url, payload), expectedStatus, step);
const envelope = (entity: string, id: string, record: Record<string, unknown>) => ({
  workspaceId: tenant.workspaceId, farmId: tenant.farmId, seasonId: tenant.seasonId,
  entity, record: { id, createdAt: now, updatedAt: now, ...record },
});

async function createAdvance(input: {
  amount: number; voucherDate: string; paymentAccountId: string;
  scope: "GROUP" | "MEMBER"; labourerId?: string; groupId?: string;
}) {
  const payload = input.scope === "GROUP"
    ? {
        recipientScope: "LABOUR_GROUP", labourGroupId: input.groupId,
        receivedByLabourerId: memberOneId, receivedByNameSnapshot: "Member One",
      }
    : { recipientScope: "INDIVIDUAL", labourerId: input.labourerId, receivedByLabourerId: input.labourerId };
  const response = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-payments/advances`, {
    farmId: tenant.farmId, seasonId: tenant.seasonId, idempotencyKey: randomUUID(), voucherDate: input.voucherDate,
    ...payload, amount: input.amount, paymentAccountId: input.paymentAccountId, paymentMethod: "cash",
    description: `Group pool ${input.scope} advance ${input.amount}`,
  });
  assertIntegrationResponse(response, 201, `create ${input.scope} advance ${input.amount}`);
  return response.json().voucher as { id: string; paymentAmount: string };
}

async function createGroupDue(grossAmount: number) {
  const response = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-payments/dues`, {
    farmId: tenant.farmId, seasonId: tenant.seasonId, idempotencyKey: randomUUID(), source: "DIRECT",
    recipientScope: "LABOUR_GROUP", labourGroupId: groupId, description: "Direct lump-sum group due",
    workFromDate: "2026-07-05", workToDate: "2026-07-09", agreedGrossAmount: grossAmount, authorizedDeductions: 0,
  });
  assertIntegrationResponse(response, 201, `create group due ${grossAmount}`);
  return response.json().due as { id: string };
}

async function fetchPool(dueId: string, options: { amount?: number; settlementDate?: string } = {}) {
  const query = new URLSearchParams({ farmId: tenant.farmId, seasonId: tenant.seasonId, pageSize: "100" });
  if (options.amount != null) query.set("amount", String(options.amount));
  query.set("settlementDate", options.settlementDate ?? "2026-07-15");
  const response = await request("GET", `/v1/workspace/${tenant.workspaceId}/labour-payments/dues/${dueId}/advance-pool?${query}`);
  assertIntegrationResponse(response, 200, `fetch pool for ${dueId}`);
  return response.json() as {
    pool: { eligibleTotal: number; maximumApplicable: number; groupLevelAmount: number; memberLevelAmount: number; carriedForwardAmount: number; remainingAfterAdvances: number; membershipReviewRequired?: boolean; exclusionTotals: Record<string, number> };
    details?: Array<{ id: string; proposedAmount: number; allocationOrder: number }>;
  };
}

async function settlePool(dueId: string, amount: number, idempotencyKey = randomUUID()) {
  return request("POST", `/v1/workspace/${tenant.workspaceId}/labour-payments/dues/${dueId}/settle`, {
    farmId: tenant.farmId, seasonId: tenant.seasonId,
    advancePool: { amount, idempotencyKey, settlementDate: "2026-07-15" },
  });
}

before(async () => {
  if (!databaseUrl) return;
  await db.insert(workspaces).values({ id: tenant.workspaceId, name: "Group Pool Workspace", slug: `group-pool-${tenant.workspaceId}`, contactEmail: "group-pool@example.test", status: "approved" });
  await db.insert(users).values({ id: tenant.userId, email: `group-pool-${tenant.userId}@example.test`, passwordHash: "test", status: "approved" });
  await db.insert(workspaceMemberships).values({ workspaceId: tenant.workspaceId, userId: tenant.userId, role: "workspace_owner" });
  await db.insert(farms).values({ id: tenant.farmId, workspaceId: tenant.workspaceId, name: "Group Pool Farm" });
  await db.insert(seasons).values({ id: tenant.seasonId, workspaceId: tenant.workspaceId, farmId: tenant.farmId, name: "Group Pool Season", year: 2026, startsOn: "2026-01-01", status: "active" });
  await db.insert(userSessions).values({ userId: tenant.userId, workspaceId: tenant.workspaceId, activeFarmId: tenant.farmId, activeSeasonId: tenant.seasonId, tokenHash: hash(tenant.token), expiresAt: new Date(Date.now() + 60_000) });
  app = await buildApp();
  groupId = randomUUID();
  otherGroupId = randomUUID();
  memberOneId = randomUUID();
  memberTwoId = randomUUID();
  outsiderId = randomUUID();
  await setupRequest("create labour group", "POST", "/v1/workspace/operational-records", envelope("labourGroup", groupId, { name: "Pool Group", active: true }));
  await setupRequest("create other labour group", "POST", "/v1/workspace/operational-records", envelope("labourGroup", otherGroupId, { name: "Other Group", active: true }));
  await setupRequest("create member one", "POST", "/v1/workspace/operational-records", envelope("labourer", memberOneId, { name: "Member One", active: true, groupId }));
  await setupRequest("create member two", "POST", "/v1/workspace/operational-records", envelope("labourer", memberTwoId, { name: "Member Two", active: true, groupId }));
  await setupRequest("create outsider", "POST", "/v1/workspace/operational-records", envelope("labourer", outsiderId, { name: "Outsider", active: true, groupId: otherGroupId }));
  const [cash] = await db.insert(accounts).values({ farmId: tenant.farmId, name: "Group Pool Cash", accountType: "cash", active: true }).returning({ id: accounts.id });
  const [partnerA] = await db.insert(accounts).values({ farmId: tenant.farmId, name: "Group Pool Partner A", accountType: "partner", active: true }).returning({ id: accounts.id });
  const [partnerB] = await db.insert(accounts).values({ farmId: tenant.farmId, name: "Group Pool Partner B", accountType: "partner", active: true }).returning({ id: accounts.id });
  assertPersistedUuid(cash?.id, "create cash account");
  assertPersistedUuid(partnerA?.id, "create partner account A");
  assertPersistedUuid(partnerB?.id, "create partner account B");
  cashAccountId = cash!.id;
  partnerAccountAId = partnerA!.id;
  partnerAccountBId = partnerB!.id;
});

after(async () => {
  if (!databaseUrl) return;
  if (app) await app.close();
  await db.delete(labourAccountingEntries).where(eq(labourAccountingEntries.workspaceId, tenant.workspaceId));
  await db.delete(labourAdvanceApplicationSources).where(eq(labourAdvanceApplicationSources.workspaceId, tenant.workspaceId));
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

test("a direct/lump-sum group due exposes group-level AND member-owned advances, excludes other groups, freezes membership, matches preview to posting, preserves funding owners, and reverses cleanly", { skip }, async () => {
  // Mixed funding: partner A funds the group advance, partner B and cash fund
  // the members', and the outsider's advance must never become eligible.
  const groupAdvance = await createAdvance({ amount: 5_000, voucherDate: "2026-07-01", paymentAccountId: partnerAccountAId, scope: "GROUP", groupId });
  const memberOneAdvance = await createAdvance({ amount: 9_000, voucherDate: "2026-07-02", paymentAccountId: partnerAccountBId, scope: "MEMBER", labourerId: memberOneId });
  const memberTwoAdvance = await createAdvance({ amount: 6_000, voucherDate: "2026-07-03", paymentAccountId: cashAccountId, scope: "MEMBER", labourerId: memberTwoId });
  await createAdvance({ amount: 2_500, voucherDate: "2026-07-03", paymentAccountId: cashAccountId, scope: "MEMBER", labourerId: outsiderId });
  // Posted after the settlement date used by every preview/settlement below —
  // must stay excluded even though it belongs to a frozen member.
  await createAdvance({ amount: 800, voucherDate: "2026-07-20", paymentAccountId: cashAccountId, scope: "MEMBER", labourerId: memberOneId });

  const due = await createGroupDue(15_340);
  const [persistedDue] = await db.select().from(labourDues).where(eq(labourDues.id, due.id));
  const dueSnapshot = persistedDue!.recipientSnapshot as Record<string, unknown>;
  assert.ok(Array.isArray(dueSnapshot.groupMembers) && dueSnapshot.groupMembers.length === 2, "the direct due froze the group membership at creation");
  assert.equal(dueSnapshot.memberCalculationSnapshot, null, "a direct/lump-sum due has no wage-calculation rows");

  // Membership changes AFTER due creation must not affect the frozen pool:
  // member two leaves the live group, a brand-new member joins it.
  await setupRequest("member two leaves the live group", "POST", "/v1/workspace/operational-records", {
    ...envelope("labourer", memberTwoId, { name: "Member Two", active: true, groupId: otherGroupId }),
    record: { id: memberTwoId, createdAt: now, updatedAt: new Date("2026-07-10T00:00:00.000Z").toISOString(), name: "Member Two", active: true, groupId: otherGroupId },
  });
  const joinedLaterId = randomUUID();
  await setupRequest("new member joins the live group", "POST", "/v1/workspace/operational-records", envelope("labourer", joinedLaterId, { name: "Joined Later", active: true, groupId }));
  await createAdvance({ amount: 1_200, voucherDate: "2026-07-04", paymentAccountId: cashAccountId, scope: "MEMBER", labourerId: joinedLaterId });

  // Acceptance: 20,000 valid pool vs 15,340 due.
  const preview = await fetchPool(due.id, { amount: 15_340 });
  assert.equal(preview.pool.eligibleTotal, 20_000, "group advances (5,000) + member one (9,000) + departed-but-frozen member two (6,000)");
  assert.equal(preview.pool.groupLevelAmount, 5_000);
  assert.equal(preview.pool.memberLevelAmount, 15_000);
  assert.equal(preview.pool.maximumApplicable, 15_340);
  assert.equal(preview.pool.carriedForwardAmount, 4_660);
  assert.equal(preview.pool.remainingAfterAdvances, 0);
  assert.equal(preview.pool.membershipReviewRequired, false);
  assert.ok((preview.pool.exclusionTotals.labourersOutsideDue ?? 0) >= 2_500 + 1_200, "the outsider and the joined-later member stay excluded");
  assert.ok((preview.pool.exclusionTotals.postedAfterSettlementDate ?? 0) >= 800, "an advance posted after the settlement date stays excluded");
  const previewedAllocations = preview.details ?? [];
  assert.ok(previewedAllocations.length >= 3, "the preview allocates across group and member vouchers");

  // Preview and posting must match: the persisted source allocations are the
  // exact allocations the preview showed.
  const settle = await settlePool(due.id, 15_340);
  assertIntegrationResponse(settle, 200, "settle the full maximum applicable");
  const [application] = await db.select().from(labourAdvanceApplications).where(and(eq(labourAdvanceApplications.dueId, due.id), eq(labourAdvanceApplications.status, "ACTIVE")));
  assertPersistedUuid(application?.id, "locate the pooled application");
  const sources = await db.select().from(labourAdvanceApplicationSources).where(eq(labourAdvanceApplicationSources.applicationId, application!.id));
  assert.equal(
    sources.reduce((sum, row) => sum + Number(row.amount), 0),
    15_340,
    "the persisted source allocations account for the entire applied amount",
  );
  assert.deepEqual(
    sources.map((row) => [row.advanceVoucherId, Number(row.amount)]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    previewedAllocations.map((row) => [row.id, row.proposedAmount]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    "posting persisted exactly the allocations the preview proposed",
  );

  // Pooled attribution: each consumed portion stays with its original funder.
  const voucherAccount = new Map([
    [groupAdvance.id, partnerAccountAId],
    [memberOneAdvance.id, partnerAccountBId],
    [memberTwoAdvance.id, cashAccountId],
  ]);
  const byAccount = new Map<string, number>();
  for (const row of sources) {
    const accountId = voucherAccount.get(row.advanceVoucherId)!;
    byAccount.set(accountId, (byAccount.get(accountId) ?? 0) + Number(row.amount));
  }
  assert.equal(byAccount.get(partnerAccountAId), 5_000, "Partner A's group advance is fully consumed and stays attributed to Partner A");
  assert.equal(byAccount.get(partnerAccountBId), 9_000, "Partner B's member advance stays attributed to Partner B");
  assert.equal(byAccount.get(cashAccountId), 1_340, "the FIFO remainder draws from the cash-funded advance");

  // Applying an advance never moves cash and never re-credits a partner:
  // the only account movements are the original advance payments themselves.
  const movements = await db.select().from(accountTransactions).where(eq(accountTransactions.farmId, tenant.farmId));
  assert.equal(movements.filter((row) => row.sourceType === "labour_payment_voucher").length, 6, "six advances were paid; settlement added no movement");

  const [settledDue] = await db.select().from(labourDues).where(eq(labourDues.id, due.id));
  assert.equal(settledDue?.paymentStatus, "SETTLED_BY_ADVANCE");

  // Reversal restores the exact availability; the source rows remain on
  // record attached to the reversed application.
  const [settledEvent] = await db.select().from(auditLogs).where(and(
    eq(auditLogs.workspaceId, tenant.workspaceId),
    eq(auditLogs.action, "labour_due_settled"),
    eq(auditLogs.entityId, due.id),
  ));
  assertPersistedUuid(settledEvent?.id, "locate the settlement event");
  const reversal = await request(
    "POST",
    `/v1/workspace/${tenant.workspaceId}/labour-payments/advance-application-events/${settledEvent!.id}/reverse?farmId=${tenant.farmId}&seasonId=${tenant.seasonId}`,
    { idempotencyKey: randomUUID(), reason: "group pool reversal restores availability" },
  );
  assertIntegrationResponse(reversal, 200, "reverse the pooled settlement");
  const [reversedApplication] = await db.select().from(labourAdvanceApplications).where(eq(labourAdvanceApplications.id, application!.id));
  assert.equal(reversedApplication?.status, "REVERSED");
  const survivingSources = await db.select().from(labourAdvanceApplicationSources).where(eq(labourAdvanceApplicationSources.applicationId, application!.id));
  assert.equal(survivingSources.length, sources.length, "reversal keeps the exact source allocations on record");
  const restored = await fetchPool(due.id);
  assert.equal(restored.pool.eligibleTotal, 20_000, "the full group availability is restored after reversal");
});

test("when the eligible group pool is smaller than the due, the full pool applies and the remainder stays payable", { skip }, async () => {
  // Fresh scope: a second due against what remains for this group after the
  // reversal above restored the 20,000 pool. Consume it down to a known
  // small pool first, then verify the pool-limited settlement.
  const due = await createGroupDue(40_000);
  const preview = await fetchPool(due.id);
  const available = preview.pool.eligibleTotal;
  assert.ok(available > 0 && available < 40_000, "the pool is genuinely smaller than the due");
  assert.equal(preview.pool.maximumApplicable, available, "maximum applicable equals the full group pool");
  const overRequest = await settlePool(due.id, available + 1);
  assert.equal(overRequest.statusCode, 409, "requesting more than the pool is rejected");
  const settle = await settlePool(due.id, available);
  assertIntegrationResponse(settle, 200, "apply the complete pool");
  const [settledDue] = await db.select().from(labourDues).where(eq(labourDues.id, due.id));
  assert.equal(settledDue?.paymentStatus, "PARTIALLY_SETTLED", "the remainder of the due stays payable by cash or another method");
});

test("two concurrent settlements cannot consume the same group availability", { skip }, async () => {
  await createAdvance({ amount: 2_000, voucherDate: "2026-07-05", paymentAccountId: cashAccountId, scope: "MEMBER", labourerId: memberOneId });
  const dueOne = await createGroupDue(4_000);
  const dueTwo = await createGroupDue(4_000);
  const poolBefore = await fetchPool(dueOne.id);
  const remaining = poolBefore.pool.eligibleTotal;
  assert.ok(remaining > 0, "some availability remains for the concurrency check");
  const half = Math.round((remaining * 0.6 + Number.EPSILON) * 100) / 100;
  const [first, second] = await Promise.all([
    settlePool(dueOne.id, Math.min(half, 4_000)),
    settlePool(dueTwo.id, Math.min(half, 4_000)),
  ]);
  const statuses = [first.statusCode, second.statusCode].sort();
  assert.equal(statuses[0], 200, "one settlement wins");
  if (statuses[1] === 200) {
    // Both fit only if together they do not exceed the pool.
    const applications = await db.select().from(labourAdvanceApplications).where(and(
      inArray(labourAdvanceApplications.dueId, [dueOne.id, dueTwo.id]),
      eq(labourAdvanceApplications.status, "ACTIVE"),
    ));
    const applied = applications.reduce((sum, row) => sum + Number(row.amount), 0);
    assert.ok(applied <= remaining + 0.005, "combined applications never exceed the available pool");
  } else {
    assert.equal(statuses[1], 409, "the loser is rejected rather than overconsuming");
  }
});
