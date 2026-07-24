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
let leaderId: string;
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
  scope: "GROUP" | "MEMBER"; labourerId?: string; groupId?: string; receivedById?: string;
}) {
  const payload = input.scope === "GROUP"
    ? { recipientScope: "LABOUR_GROUP", labourGroupId: input.groupId, receivedByLabourerId: input.receivedById ?? null }
    : { recipientScope: "INDIVIDUAL", labourerId: input.labourerId };
  const response = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-payments/advances`, {
    farmId: tenant.farmId, seasonId: tenant.seasonId, idempotencyKey: randomUUID(), voucherDate: input.voucherDate,
    ...payload, amount: input.amount, paymentAccountId: input.paymentAccountId, paymentMethod: "cash",
    description: `Group pool ${input.scope} advance ${input.amount}`,
  });
  assertIntegrationResponse(response, 201, `create ${input.scope} advance ${input.amount}`);
  return response.json().voucher as { id: string; paymentAmount: string; recipientScope: string; labourGroupId: string | null; financialScopeKey: string };
}

async function createGroupDue(grossAmount: number, forGroupId = groupId) {
  const response = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-payments/dues`, {
    farmId: tenant.farmId, seasonId: tenant.seasonId, idempotencyKey: randomUUID(), source: "DIRECT",
    recipientScope: "LABOUR_GROUP", labourGroupId: forGroupId, description: "Direct lump-sum group due",
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
    pool: {
      eligibleTotal: number; maximumApplicable: number; carriedForwardAmount: number; remainingAfterAdvances: number;
      membershipReviewRequired?: boolean; exclusionTotals: Record<string, number>;
      groupPool: { labourGroupId: string; groupLeaderName: string | null; totalAdvances: number; appliedAdvances: number; refundedAdvances: number; outstandingAdvances: number } | null;
    };
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
  leaderId = randomUUID();
  memberOneId = randomUUID();
  memberTwoId = randomUUID();
  outsiderId = randomUUID();
  await setupRequest("create leader", "POST", "/v1/workspace/operational-records", envelope("labourer", leaderId, { name: "Saleem", active: true, groupId }));
  await setupRequest("create labour group", "POST", "/v1/workspace/operational-records", envelope("labourGroup", groupId, { name: "Saleem Group", active: true, foremanLabourId: leaderId }));
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

test("attendance-based dues are rejected while a direct group due works without any attendance", { skip }, async () => {
  const attendanceResponse = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-payments/dues`, {
    farmId: tenant.farmId, seasonId: tenant.seasonId, idempotencyKey: randomUUID(), source: "ATTENDANCE_PERIOD",
    recipientScope: "LABOUR_GROUP", labourGroupId: groupId, description: "Attendance due",
    workFromDate: "2026-07-01", workToDate: "2026-07-05", authorizedDeductions: 0,
  });
  assert.equal(attendanceResponse.statusCode, 400);
  assert.equal(attendanceResponse.json().message, "Attendance-based Labour Dues are no longer supported. Create a direct labour group due instead.");
  const previewResponse = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-payments/dues/attendance-preview`, {
    farmId: tenant.farmId, seasonId: tenant.seasonId, recipientScope: "LABOUR_GROUP", labourGroupId: groupId,
    fromDate: "2026-07-01", toDate: "2026-07-05", recordDate: "2026-07-05",
  });
  assert.equal(previewResponse.statusCode, 400);
  assert.match(previewResponse.json().message, /no longer supported/);
  const settlementCreate = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-wage-settlements`, {
    farmId: tenant.farmId, seasonId: tenant.seasonId, fromDate: "2026-07-01", toDate: "2026-07-05",
    settlementDate: "2026-07-05", settlementMode: "group", groupId,
  });
  assert.equal(settlementCreate.statusCode, 400);
  assert.match(settlementCreate.json().message, /no longer supported/);

  // A brand-new attendance record stays financially unlinked after due creation.
  const attendanceId = randomUUID();
  await setupRequest("create attendance", "POST", "/v1/workspace/operational-records", envelope("attendance", attendanceId, { labourId: memberOneId, date: "2026-07-06", status: "present" }));
  const due = await createGroupDue(1_000);
  assertPersistedUuid(due.id, "direct group due without attendance");
  const [attendanceRecord] = await db.select().from(operationalRecords).where(and(eq(operationalRecords.workspaceId, tenant.workspaceId), eq(operationalRecords.clientRecordId, attendanceId)));
  assert.equal(attendanceRecord?.payload.labourDueId, undefined, "new attendance records are never financially locked");
  assert.equal(attendanceRecord?.payload.labourDueLockedAt, undefined);
});

test("advances to the leader and to CURRENT members — from several accounts — form one combined pool that settles the due", { skip }, async () => {
  // Partner A funds a group-directed advance received by the leader; partner B
  // and cash fund individual advances to members. Each voucher records its
  // ORIGINAL recipient; pool ownership follows current membership.
  await createAdvance({ amount: 5_000, voucherDate: "2026-07-01", paymentAccountId: partnerAccountAId, scope: "GROUP", groupId, receivedById: leaderId });
  const memberOneAdvance = await createAdvance({ amount: 9_000, voucherDate: "2026-07-02", paymentAccountId: partnerAccountBId, scope: "MEMBER", labourerId: memberOneId });
  await createAdvance({ amount: 6_000, voucherDate: "2026-07-03", paymentAccountId: cashAccountId, scope: "MEMBER", labourerId: memberTwoId });
  await createAdvance({ amount: 2_500, voucherDate: "2026-07-03", paymentAccountId: cashAccountId, scope: "MEMBER", labourerId: outsiderId });
  // Excluded by the settlement-date rule even though it belongs to the group.
  await createAdvance({ amount: 800, voucherDate: "2026-07-20", paymentAccountId: cashAccountId, scope: "MEMBER", labourerId: memberOneId });

  assert.equal(memberOneAdvance.recipientScope, "INDIVIDUAL", "the voucher keeps its original recipient identity");
  assert.equal(memberOneAdvance.labourGroupId, null, "no group ownership is stamped onto the voucher");
  assert.equal(memberOneAdvance.financialScopeKey, `individual:${memberOneId}`);

  // Membership churn moves pool ownership WITH the labourer: member two's
  // 6,000 follows them to the other group; a brand-new member joins.
  await setupRequest("member two moves to the other group", "POST", "/v1/workspace/operational-records", envelope("labourer", memberTwoId, { name: "Member Two", active: true, groupId: otherGroupId }));
  const joinedLaterId = randomUUID();
  await setupRequest("new member joins the live group", "POST", "/v1/workspace/operational-records", envelope("labourer", joinedLaterId, { name: "Joined Later", active: true, groupId }));

  const due = await createGroupDue(15_340);
  const preview = await fetchPool(due.id, { amount: 15_340 });
  // Current pool: leader 5,000 (group-directed) + member one 9,000 + the late
  // 800 — member two's 6,000 now belongs to the other group's pool. The
  // settlement-date rule keeps the late 800 out of THIS settlement.
  assert.equal(preview.pool.availableAdvances, 14_000, "leader 5,000 + member one 9,000, date-eligible");
  assert.equal(preview.pool.maximumApplicable, 14_000);
  assert.equal(preview.pool.remainingAfterAdvances, 1_340);
  assert.equal(preview.pool.groupPool?.labourGroupId, groupId);
  assert.equal(preview.pool.groupPool?.groupLeaderName, "Saleem", "the leader owns the pool");
  assert.equal(preview.pool.groupPool?.totalAdvances, 14_800, "pool totals include the post-settlement-date advance");

  const settle = await settlePool(due.id, 14_000);
  assertIntegrationResponse(settle, 200, "settle the full maximum applicable");
  const [application] = await db.select().from(labourAdvanceApplications).where(and(eq(labourAdvanceApplications.dueId, due.id), eq(labourAdvanceApplications.status, "ACTIVE")));
  assertPersistedUuid(application?.id, "locate the pooled application");
  assert.equal(application?.advanceVoucherId, null, "the application is pool-level, not voucher-level");
  const sources = await db.select().from(labourAdvanceApplicationSources).where(eq(labourAdvanceApplicationSources.applicationId, application!.id));
  assert.equal(sources.length, 0, "no per-voucher application allocation is created");

  // No duplicate expense, no cash movement, no repeated Farm Owes Partner.
  const applicationEntries = await db.select().from(labourAccountingEntries).where(and(
    eq(labourAccountingEntries.workspaceId, tenant.workspaceId),
    eq(labourAccountingEntries.advanceApplicationId, application!.id),
  ));
  assert.deepEqual(applicationEntries.map((row) => row.ledgerCode).sort(), ["LABOUR_ADVANCE", "LABOUR_PAYABLE"], "an application clears the payable against the advance — never expense, cash, or partner payable");
  const movements = await db.select().from(accountTransactions).where(eq(accountTransactions.farmId, tenant.farmId));
  assert.equal(movements.filter((row) => row.sourceType === "labour_payment_voucher").length, 5, "only the five funding advances moved money; settlement added none");

  const [settledDue] = await db.select().from(labourDues).where(eq(labourDues.id, due.id));
  assert.equal(settledDue?.paymentStatus, "PARTIALLY_SETTLED", "1,340 remains payable in cash");

  // Idempotent posting: repeating the same idempotency key changes nothing.
  const repeatKey = randomUUID();
  const dueTwo = await createGroupDue(500);
  assertIntegrationResponse(await settlePool(dueTwo.id, 300, repeatKey), 200, "first posting");
  assertIntegrationResponse(await settlePool(dueTwo.id, 300, repeatKey), 200, "idempotent repeat");
  const dueTwoApplications = await db.select().from(labourAdvanceApplications).where(and(eq(labourAdvanceApplications.dueId, dueTwo.id), eq(labourAdvanceApplications.status, "ACTIVE")));
  assert.equal(dueTwoApplications.length, 1, "the repeat posted no second application");

  // Reversal restores the due and the pool availability exactly. The posted
  // settlement itself stayed attached to this group throughout.
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
  const restored = await fetchPool(due.id);
  assert.equal(restored.pool.availableAdvances, 14_000 - 300, "availability returns apart from the still-active 300 on the second due");
  const [reopenedDue] = await db.select().from(labourDues).where(eq(labourDues.id, due.id));
  assert.equal(reopenedDue?.paymentStatus, "UNPAID", "the reversed due is payable again");
});

test("the advance-pools endpoint reports one pool per group and farm-wide totals equal the sum of pools", { skip }, async () => {
  const response = await request("GET", `/v1/workspace/${tenant.workspaceId}/labour-payments/advance-pools?farmId=${tenant.farmId}&seasonId=${tenant.seasonId}`);
  assertIntegrationResponse(response, 200, "list group advance pools");
  const body = response.json() as {
    pools: Array<{ labourGroupId: string; groupName: string; groupLeaderName: string | null; totalAdvances: number; appliedAdvances: number; refundedAdvances: number; outstandingAdvances: number }>;
    reviewAdvances: unknown[];
    farmWide: { totalAdvances: number; appliedAdvances: number; refundedAdvances: number; outstandingAdvances: number };
  };
  const saleemPool = body.pools.find((pool) => pool.labourGroupId === groupId);
  assert.ok(saleemPool, "the Saleem Group pool exists");
  assert.equal(saleemPool!.groupName, "Saleem Group");
  assert.equal(saleemPool!.groupLeaderName, "Saleem");
  assert.equal(
    Number(saleemPool!.outstandingAdvances.toFixed(2)),
    Number((saleemPool!.totalAdvances - saleemPool!.appliedAdvances - saleemPool!.refundedAdvances).toFixed(2)),
  );
  assert.equal(body.reviewAdvances.length, 0, "every advance in this workspace has provable group ownership");
  const summed = body.pools.reduce((sums, pool) => ({
    total: sums.total + pool.totalAdvances,
    applied: sums.applied + pool.appliedAdvances,
    refunded: sums.refunded + pool.refundedAdvances,
  }), { total: 0, applied: 0, refunded: 0 });
  assert.equal(Number(summed.total.toFixed(2)), body.farmWide.totalAdvances);
  assert.equal(Number(summed.applied.toFixed(2)), body.farmWide.appliedAdvances);
  assert.equal(Number(summed.refunded.toFixed(2)), body.farmWide.refundedAdvances);
});

test("two concurrent settlements cannot overspend one group pool", { skip }, async () => {
  const dueOne = await createGroupDue(4_000);
  const dueTwo = await createGroupDue(4_000);
  const poolBefore = await fetchPool(dueOne.id);
  const remaining = poolBefore.pool.availableAdvances;
  assert.ok(remaining > 0, "some availability remains for the concurrency check");
  const half = Math.round((remaining * 0.6 + Number.EPSILON) * 100) / 100;
  const [first, second] = await Promise.all([
    settlePool(dueOne.id, Math.min(half, 4_000)),
    settlePool(dueTwo.id, Math.min(half, 4_000)),
  ]);
  const statuses = [first.statusCode, second.statusCode].sort();
  assert.equal(statuses[0], 200, "one settlement wins");
  const applications = await db.select().from(labourAdvanceApplications).where(and(
    inArray(labourAdvanceApplications.dueId, [dueOne.id, dueTwo.id]),
    eq(labourAdvanceApplications.status, "ACTIVE"),
  ));
  const applied = applications.reduce((sum, row) => sum + Number(row.amount), 0);
  assert.ok(applied <= remaining + 0.005, "combined applications never exceed the pool");
  if (statuses[1] !== 200) assert.equal(statuses[1], 409, "the loser is rejected rather than overspending");
});

test("an ungrouped labourer's advance posts into their individual pool and moves with them when they join a group", { skip }, async () => {
  const ungroupedId = randomUUID();
  await setupRequest("create ungrouped labourer", "POST", "/v1/workspace/operational-records", envelope("labourer", ungroupedId, { name: "Ungrouped Worker", active: true }));
  const response = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-payments/advances`, {
    farmId: tenant.farmId, seasonId: tenant.seasonId, idempotencyKey: randomUUID(), voucherDate: "2026-07-04",
    recipientScope: "INDIVIDUAL", labourerId: ungroupedId, amount: 750, paymentAccountId: cashAccountId,
    paymentMethod: "cash", description: "Individual pool advance",
  });
  assertIntegrationResponse(response, 201, "an ungrouped labourer can receive an advance");
  const poolsResponse = await request("GET", `/v1/workspace/${tenant.workspaceId}/labour-payments/advance-pools?farmId=${tenant.farmId}&seasonId=${tenant.seasonId}`);
  assertIntegrationResponse(poolsResponse, 200, "list pools after the individual advance");
  const withIndividual = poolsResponse.json() as { individualPools: Array<{ labourerId: string; totalAdvances: number; outstandingAdvances: number }> };
  const individual = withIndividual.individualPools.find((pool) => pool.labourerId === ungroupedId);
  assert.equal(individual?.totalAdvances, 750, "the advance forms the labourer's individual pool");

  // Joining a group moves the same voucher into that group's combined pool.
  await setupRequest("labourer joins the group", "POST", "/v1/workspace/operational-records", envelope("labourer", ungroupedId, { name: "Ungrouped Worker", active: true, groupId }));
  const afterJoin = await request("GET", `/v1/workspace/${tenant.workspaceId}/labour-payments/advance-pools?farmId=${tenant.farmId}&seasonId=${tenant.seasonId}`);
  assertIntegrationResponse(afterJoin, 200, "list pools after joining");
  const joined = afterJoin.json() as {
    pools: Array<{ labourGroupId: string; totalAdvances: number }>;
    individualPools: Array<{ labourerId: string }>;
    vouchers: Array<{ labourerId: string | null; currentGroupId: string | null }>;
  };
  assert.equal(joined.individualPools.some((pool) => pool.labourerId === ungroupedId), false, "the individual pool disappears once grouped");
  assert.equal(joined.vouchers.find((voucher) => voucher.labourerId === ungroupedId)?.currentGroupId, groupId, "the voucher context label shows the CURRENT group");
});

test("pool-level recovery reduces the combined balance without touching any voucher", { skip }, async () => {
  const before = await request("GET", `/v1/workspace/${tenant.workspaceId}/labour-payments/advance-pools?farmId=${tenant.farmId}&seasonId=${tenant.seasonId}`);
  assertIntegrationResponse(before, 200, "pools before recovery");
  const beforePool = (before.json() as { pools: Array<{ labourGroupId: string; outstandingAdvances: number; refundedAdvances: number }> }).pools.find((pool) => pool.labourGroupId === groupId);
  assert.ok(beforePool && beforePool.outstandingAdvances >= 100, "some balance is available to recover");
  const recover = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-payments/advance-pools/recover`, {
    farmId: tenant.farmId, seasonId: tenant.seasonId, labourGroupId: groupId,
    payment: { idempotencyKey: randomUUID(), voucherDate: "2026-07-16", amount: 100, paymentAccountId: cashAccountId, paymentMethod: "Recovery" },
  });
  assertIntegrationResponse(recover, 201, "record a pool-level recovery");
  const recoveryVoucher = recover.json().voucher as { nature: string; relatedAdvanceVoucherId: string | null; labourGroupId: string | null };
  assert.equal(recoveryVoucher.nature, "REFUND_RECOVERY");
  assert.equal(recoveryVoucher.relatedAdvanceVoucherId, null, "the recovery attaches to the pool, never to a voucher");
  assert.equal(recoveryVoucher.labourGroupId, groupId);
  const after = await request("GET", `/v1/workspace/${tenant.workspaceId}/labour-payments/advance-pools?farmId=${tenant.farmId}&seasonId=${tenant.seasonId}`);
  const afterPool = (after.json() as { pools: Array<{ labourGroupId: string; outstandingAdvances: number; refundedAdvances: number }> }).pools.find((pool) => pool.labourGroupId === groupId);
  assert.equal(Number((afterPool!.refundedAdvances - beforePool!.refundedAdvances).toFixed(2)), 100);
  assert.equal(Number((beforePool!.outstandingAdvances - afterPool!.outstandingAdvances).toFixed(2)), 100);
});
