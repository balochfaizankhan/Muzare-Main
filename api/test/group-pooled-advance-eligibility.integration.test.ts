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

test("advances to the leader and to any member — from several accounts — aggregate into one group pool that settles the due", { skip }, async () => {
  // Partner A funds a leader-level advance; partner B and cash fund advances
  // physically received by different members (recorded as INDIVIDUAL by an
  // old client and auto-elevated to the group pool); the outsider's advance
  // belongs to the other group.
  const leaderAdvance = await createAdvance({ amount: 5_000, voucherDate: "2026-07-01", paymentAccountId: partnerAccountAId, scope: "GROUP", groupId, receivedById: leaderId });
  const memberOneAdvance = await createAdvance({ amount: 9_000, voucherDate: "2026-07-02", paymentAccountId: partnerAccountBId, scope: "MEMBER", labourerId: memberOneId });
  const memberTwoAdvance = await createAdvance({ amount: 6_000, voucherDate: "2026-07-03", paymentAccountId: cashAccountId, scope: "MEMBER", labourerId: memberTwoId });
  await createAdvance({ amount: 2_500, voucherDate: "2026-07-03", paymentAccountId: cashAccountId, scope: "MEMBER", labourerId: outsiderId });
  // Excluded by the settlement-date rule even though it belongs to the group.
  await createAdvance({ amount: 800, voucherDate: "2026-07-20", paymentAccountId: cashAccountId, scope: "MEMBER", labourerId: memberOneId });

  assert.equal(memberOneAdvance.recipientScope, "LABOUR_GROUP", "a member advance is operationally an advance taken by the leader for the group");
  assert.equal(memberOneAdvance.labourGroupId, groupId);
  assert.equal(memberOneAdvance.financialScopeKey, `group:${groupId}`);

  // Membership churn after funding must not change pool ownership: member two
  // moves to the other group; a brand-new labourer joins.
  await setupRequest("member two leaves the live group", "POST", "/v1/workspace/operational-records", envelope("labourer", memberTwoId, { name: "Member Two", active: true, groupId: otherGroupId }));
  const joinedLaterId = randomUUID();
  await setupRequest("new member joins the live group", "POST", "/v1/workspace/operational-records", envelope("labourer", joinedLaterId, { name: "Joined Later", active: true, groupId }));

  const due = await createGroupDue(15_340);
  const preview = await fetchPool(due.id, { amount: 15_340 });
  assert.equal(preview.pool.eligibleTotal, 20_000, "leader 5,000 + member one 9,000 + member two 6,000 (ownership was stamped at funding time)");
  assert.equal(preview.pool.maximumApplicable, 15_340);
  assert.equal(preview.pool.carriedForwardAmount, 4_660);
  assert.equal(preview.pool.remainingAfterAdvances, 0);
  assert.equal(preview.pool.membershipReviewRequired, false);
  assert.equal(preview.pool.groupPool?.labourGroupId, groupId);
  assert.equal(preview.pool.groupPool?.groupLeaderName, "Saleem", "the leader owns the pool");
  assert.equal(preview.pool.groupPool?.totalAdvances, 20_800, "pool totals include the post-settlement-date advance");
  assert.ok((preview.pool.exclusionTotals.otherGroups ?? 0) >= 2_500, "the outsider's advance stays with the other group");
  assert.ok((preview.pool.exclusionTotals.postedAfterSettlementDate ?? 0) >= 800);
  const previewedAllocations = preview.details ?? [];

  const settle = await settlePool(due.id, 15_340);
  assertIntegrationResponse(settle, 200, "settle the full maximum applicable");
  const [application] = await db.select().from(labourAdvanceApplications).where(and(eq(labourAdvanceApplications.dueId, due.id), eq(labourAdvanceApplications.status, "ACTIVE")));
  assertPersistedUuid(application?.id, "locate the pooled application");
  const sources = await db.select().from(labourAdvanceApplicationSources).where(eq(labourAdvanceApplicationSources.applicationId, application!.id));
  assert.equal(sources.reduce((sum, row) => sum + Number(row.amount), 0), 15_340);
  assert.deepEqual(
    sources.map((row) => [row.advanceVoucherId, Number(row.amount)]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    previewedAllocations.map((row) => [row.id, row.proposedAmount]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    "preview and final posting produce the same allocations",
  );

  // Mixed partner funding keeps each original owner.
  const voucherAccount = new Map([
    [leaderAdvance.id, partnerAccountAId],
    [memberOneAdvance.id, partnerAccountBId],
    [memberTwoAdvance.id, cashAccountId],
  ]);
  const byAccount = new Map<string, number>();
  for (const row of sources) {
    const accountId = voucherAccount.get(row.advanceVoucherId)!;
    byAccount.set(accountId, (byAccount.get(accountId) ?? 0) + Number(row.amount));
  }
  assert.equal(byAccount.get(partnerAccountAId), 5_000);
  assert.equal(byAccount.get(partnerAccountBId), 9_000);
  assert.equal(byAccount.get(cashAccountId), 1_340);

  // No duplicate expense, no cash movement, no repeated Farm Owes Partner.
  const applicationEntries = await db.select().from(labourAccountingEntries).where(and(
    eq(labourAccountingEntries.workspaceId, tenant.workspaceId),
    eq(labourAccountingEntries.advanceApplicationId, application!.id),
  ));
  assert.deepEqual(applicationEntries.map((row) => row.ledgerCode).sort(), ["LABOUR_ADVANCE", "LABOUR_PAYABLE"], "an application clears the payable against the advance — never expense, cash, or partner payable");
  const movements = await db.select().from(accountTransactions).where(eq(accountTransactions.farmId, tenant.farmId));
  assert.equal(movements.filter((row) => row.sourceType === "labour_payment_voucher").length, 6, "only the six funding advances moved money; settlement added none");

  const [settledDue] = await db.select().from(labourDues).where(eq(labourDues.id, due.id));
  assert.equal(settledDue?.paymentStatus, "SETTLED_BY_ADVANCE");

  // Idempotent posting: repeating the same idempotency key changes nothing.
  const repeatKey = randomUUID();
  const dueTwo = await createGroupDue(500);
  assertIntegrationResponse(await settlePool(dueTwo.id, 300, repeatKey), 200, "first posting");
  assertIntegrationResponse(await settlePool(dueTwo.id, 300, repeatKey), 200, "idempotent repeat");
  const dueTwoApplications = await db.select().from(labourAdvanceApplications).where(and(eq(labourAdvanceApplications.dueId, dueTwo.id), eq(labourAdvanceApplications.status, "ACTIVE")));
  assert.equal(dueTwoApplications.length, 1, "the repeat posted no second application");

  // Reversal restores the due and the pool availability exactly.
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
  assert.equal(survivingSources.length, sources.length, "the exact source allocations stay on record");
  const restored = await fetchPool(due.id);
  assert.equal(restored.pool.eligibleTotal, 20_000 - 300, "availability returns apart from the still-active 300 on the second due");
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
  const remaining = poolBefore.pool.eligibleTotal;
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

test("a new advance for a labourer with no labour group is blocked — no standalone individual advance pool exists", { skip }, async () => {
  const ungroupedId = randomUUID();
  await setupRequest("create ungrouped labourer", "POST", "/v1/workspace/operational-records", envelope("labourer", ungroupedId, { name: "Ungrouped Worker", active: true }));
  const response = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-payments/advances`, {
    farmId: tenant.farmId, seasonId: tenant.seasonId, idempotencyKey: randomUUID(), voucherDate: "2026-07-04",
    recipientScope: "INDIVIDUAL", labourerId: ungroupedId, amount: 750, paymentAccountId: cashAccountId,
    paymentMethod: "cash", description: "Blocked ungrouped advance",
  });
  assert.equal(response.statusCode, 400, "posting must be blocked, not recorded as an individual advance");
  assert.equal(response.json().message, "Assign this labourer to a labour group before recording an advance.");
  const vouchers = await db.select().from(labourPaymentVouchers).where(and(
    eq(labourPaymentVouchers.workspaceId, tenant.workspaceId),
    eq(labourPaymentVouchers.labourerId, ungroupedId),
  ));
  assert.equal(vouchers.length, 0, "a blocked advance must leave no voucher behind");
});
