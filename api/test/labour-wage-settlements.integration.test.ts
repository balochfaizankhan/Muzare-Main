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
  labourWageSettlementAdvanceAllocations,
  labourWageSettlementCreateRequests,
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
import { labourEarningEligibleForSettlement, normalizeLabourEarningPayload } from "../src/lib/labour-earnings.js";
import { normalizeSettlementPayload } from "../src/lib/labour-wage-settlements.js";
import { assertIntegrationResponse, assertPersistedUuid } from "./helpers/integration-response.js";

const now = new Date("2026-01-01T00:00:00.000Z").toISOString();
const tenant = {
  workspaceId: randomUUID(),
  farmId: randomUUID(),
  seasonId: randomUUID(),
  userId: randomUUID(),
  token: `settlement-${randomUUID()}`,
};
const ids = [tenant.workspaceId];
let app: Awaited<ReturnType<typeof buildApp>>;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const request = async (
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  payload?: Record<string, unknown>,
) => app.inject({ method, url, headers: { authorization: `Bearer ${tenant.token}` }, payload });
const setupRequest = async (
  step: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  payload?: Record<string, unknown>,
  expectedStatus = 200,
) => assertIntegrationResponse(await request(method, url, payload), expectedStatus, step);
const envelope = (entity: string, id: string, record: Record<string, unknown>) => ({
  workspaceId: tenant.workspaceId,
  farmId: tenant.farmId,
  seasonId: tenant.seasonId,
  entity,
  record: { id, createdAt: now, updatedAt: now, ...record },
});

const settlementStatusUrl = (clientRequestId: string) => `/v1/workspace/${tenant.workspaceId}/labour-wage-settlements/status?${new URLSearchParams({
  farmId: tenant.farmId,
  seasonId: tenant.seasonId,
  clientRequestId,
}).toString()}`;

const settlementPayload = (overrides: Record<string, unknown>) => ({
  clientRequestId: randomUUID(),
  settlementNumber: "LW-0006",
  fromDate: "2026-04-11",
  toDate: "2026-04-30",
  settlementDate: "2026-05-01",
  status: "posted",
  paidAmount: 150,
  expenseAmount: 150,
  paymentAccountId: null,
  paymentAccountCanonicalId: null,
  paymentAccountLegacyId: null,
  paymentAccountName: null,
  paymentAccountType: null,
  linkedAccountId: null,
  ...overrides,
});

before(async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL must point to an isolated migrated integration-test database.");
  await db.insert(workspaces).values({
    id: tenant.workspaceId,
    name: "Settlement Workspace",
    slug: `settlement-${tenant.workspaceId}`,
    contactEmail: "settlement@example.test",
    status: "approved",
  });
  await db.insert(users).values({
    id: tenant.userId,
    email: `settlement-${tenant.userId}@example.test`,
    passwordHash: "test",
    status: "approved",
  });
  await db.insert(workspaceMemberships).values({
    workspaceId: tenant.workspaceId,
    userId: tenant.userId,
    role: "workspace_owner",
  });
  await db.insert(farms).values({
    id: tenant.farmId,
    workspaceId: tenant.workspaceId,
    name: "Settlement Farm",
  });
  await db.insert(seasons).values({
    id: tenant.seasonId,
    workspaceId: tenant.workspaceId,
    farmId: tenant.farmId,
    name: "Settlement Season",
    year: 2026,
    startsOn: "2026-01-01",
    status: "active",
  });
  await db.insert(userSessions).values({
    userId: tenant.userId,
    workspaceId: tenant.workspaceId,
    activeFarmId: tenant.farmId,
    activeSeasonId: tenant.seasonId,
    tokenHash: hash(tenant.token),
    expiresAt: new Date(Date.now() + 60_000),
  });
  app = await buildApp();
});

after(async () => {
  if (app) await app.close();
  await db.delete(labourAccountingEntries).where(eq(labourAccountingEntries.workspaceId, tenant.workspaceId));
  await db.delete(labourPaymentAllocations).where(eq(labourPaymentAllocations.workspaceId, tenant.workspaceId));
  await db.delete(labourAdvanceApplications).where(eq(labourAdvanceApplications.workspaceId, tenant.workspaceId));
  await db.delete(labourPaymentVouchers).where(eq(labourPaymentVouchers.workspaceId, tenant.workspaceId));
  await db.delete(labourDues).where(eq(labourDues.workspaceId, tenant.workspaceId));
  await db.delete(labourWageSettlementAdvanceAllocations).where(inArray(labourWageSettlementAdvanceAllocations.workspaceId, ids));
  await db.delete(accountTransactions).where(inArray(accountTransactions.farmId, [tenant.farmId]));
  await db.delete(labourWageSettlementCreateRequests).where(eq(labourWageSettlementCreateRequests.workspaceId, tenant.workspaceId));
  await db.delete(auditLogs).where(eq(auditLogs.workspaceId, tenant.workspaceId));
  await db.delete(operationalRecords).where(inArray(operationalRecords.workspaceId, ids));
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

test("labour wage settlement create is idempotent, uses canonical allocation FKs, and void restores linked state", async () => {
  const labourerId = randomUUID();
  const labourGroupId = randomUUID();
  const attendanceId = randomUUID();
  const endAttendanceId = randomUUID();
  const beforeAttendanceId = randomUUID();
  const afterAttendanceId = randomUUID();
  const earningId = randomUUID();
  const advanceId = randomUUID();
  const duringAdvanceId = randomUUID();
  const afterCutoffAdvanceId = randomUUID();
  const clientRequestId = randomUUID();

  const [paymentAccount] = await db.insert(accounts).values({
    farmId: tenant.farmId,
    name: "Settlement Cash Account",
    accountType: "cash",
    active: true,
  }).returning({ id: accounts.id });
  assertPersistedUuid(paymentAccount?.id, "create settlement payment account");
  await setupRequest("persist settlement payment account identity", "POST", "/v1/workspace/operational-records", envelope("account", paymentAccount.id, {
    name: "Settlement Cash Account",
    type: "partner",
    active: true,
  }));

  await setupRequest("create settlement group", "POST", "/v1/workspace/operational-records", envelope("labourGroup", labourGroupId, {
    name: "Settlement Group",
    active: true,
  }));
  assert.equal((await request("POST", "/v1/workspace/operational-records", envelope("labourer", labourerId, {
    name: "Foreman Labourer",
    groupId: labourGroupId,
    group: "Settlement Group",
    active: true,
  }))).statusCode, 200);
  assert.equal((await request("POST", "/v1/workspace/operational-records", envelope("labourGroup", labourGroupId, {
    name: "Settlement Group",
    foremanLabourId: labourerId,
    foremanId: labourerId,
    active: true,
  }))).statusCode, 200);
  assert.equal((await request("POST", `/v1/workspace/${tenant.workspaceId}/wage-rates/bulk`, {
    farmId: tenant.farmId,
    seasonId: tenant.seasonId,
    effectiveFrom: "2026-04-01",
    effectiveTo: "2026-05-31",
    rows: [{ labourerId, dailyRate: 100 }],
  })).statusCode, 200);
  assert.equal((await request("POST", "/v1/workspace/operational-records", envelope("attendance", attendanceId, {
    labourerId,
    date: "2026-04-11",
    status: "present",
  }))).statusCode, 200);
  await setupRequest("create end-boundary settlement attendance", "POST", "/v1/workspace/operational-records", envelope("attendance", endAttendanceId, {
    labourerId,
    date: "2026-04-30",
    status: "half_day",
  }));
  await setupRequest("create pre-period attendance", "POST", "/v1/workspace/operational-records", envelope("attendance", beforeAttendanceId, {
    labourerId,
    date: "2026-04-10",
    status: "present",
  }));
  await setupRequest("create post-period attendance", "POST", "/v1/workspace/operational-records", envelope("attendance", afterAttendanceId, {
    labourerId,
    date: "2026-05-01",
    status: "present",
  }));
  assert.equal((await request("POST", "/v1/workspace/operational-records", envelope("labourEarning", earningId, {
    labourerId,
    earningDate: "2026-04-12",
    amount: 50,
    earningType: "bonus",
    description: "Bonus",
    status: "pending_settlement",
  }))).statusCode, 200);
  await setupRequest("create settlement advance", "POST", "/v1/workspace/operational-records", envelope("advance", advanceId, {
    labourerId,
    labourGroupId,
    labourGroupName: "Settlement Group",
    date: "2026-04-10",
    amount: 120,
    accountId: paymentAccount.id,
    sourceAccountName: "Settlement Cash Account",
  }));
  await setupRequest("create in-period settlement advance", "POST", "/v1/workspace/operational-records", envelope("advance", duringAdvanceId, {
    labourerId,
    labourGroupId,
    labourGroupName: "Settlement Group",
    date: "2026-04-20",
    amount: 10,
    accountId: paymentAccount.id,
    sourceAccountName: "Settlement Cash Account",
  }));
  await setupRequest("create post-cutoff settlement advance", "POST", "/v1/workspace/operational-records", envelope("advance", afterCutoffAdvanceId, {
    labourerId,
    labourGroupId,
    labourGroupName: "Settlement Group",
    date: "2026-05-02",
    amount: 500,
    accountId: paymentAccount.id,
    sourceAccountName: "Settlement Cash Account",
  }));

  const previewResponse = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-wage-settlements/preview`, {
    farmId: tenant.farmId,
    seasonId: tenant.seasonId,
    fromDate: "2026-04-11",
    toDate: "2026-04-30",
    settlementDate: "2026-05-01",
    settlementMode: "group",
    groupId: labourGroupId,
    paidAmount: 0,
    manualAdjustment: 0,
  });
  assert.equal(previewResponse.statusCode, 200);
  const preview = previewResponse.json().preview;
  assert.equal(preview.foremanId, labourerId);
  assert.equal(preview.attendanceWages, 150);
  assert.equal(preview.individualLabourWorkWages, 50);
  assert.equal(preview.groupLabourWorkWages, 0);
  assert.equal(preview.grossWages, 200);
  assert.equal(preview.advanceAdjustedNow, 130);
  assert.equal(preview.availableAdvanceBalanceBeforeSettlement, 130);
  assert.equal(preview.remainingAdvanceCarryForward, 0);
  assert.equal(preview.netPayableBeforePayment, 70);
  assert.equal(preview.includedLabourRows.length, 1);
  assert.deepEqual(new Set(preview.sourceAttendanceIds), new Set([attendanceId, endAttendanceId]));
  assert.deepEqual(preview.sourceLabourWorkIds, [earningId]);
  assert.equal(preview.legacyUnallocatedPreviouslySettledAdvances ?? 0, 0);

  const repeatedPreviewResponse = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-wage-settlements/preview`, {
    farmId: tenant.farmId,
    seasonId: tenant.seasonId,
    fromDate: "2026-04-11",
    toDate: "2026-04-30",
    settlementDate: "2026-05-01",
    settlementMode: "group",
    groupId: labourGroupId,
    paidAmount: 0,
    manualAdjustment: 0,
  });
  assertIntegrationResponse(repeatedPreviewResponse, 200, "repeat read-only settlement preview");
  assert.deepEqual(repeatedPreviewResponse.json().preview, preview);
  assert.equal((await db.select().from(labourWageSettlementAdvanceAllocations)).length, 0);

  const createPayload = {
    farmId: tenant.farmId,
    seasonId: tenant.seasonId,
    fromDate: "2026-04-11",
    toDate: "2026-04-30",
    settlementDate: "2026-05-01",
    settlementMode: "group",
    groupId: labourGroupId,
    paidAmount: 0,
    manualAdjustment: 0,
    clientRequestId,
  };
  const createResponse = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-wage-settlements`, createPayload);
  assert.equal(createResponse.statusCode, 200);
  const createdSettlement = createResponse.json().settlement;
  assert.equal(createdSettlement.foremanId, labourerId);
  assert.equal(createdSettlement.paidAmount, 0);
  assert.equal(createdSettlement.paymentAccountId ?? null, null);

  const duplicateCreateResponse = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-wage-settlements`, createPayload);
  assert.equal(duplicateCreateResponse.statusCode, 200);
  assert.equal(duplicateCreateResponse.json().settlement.id, createdSettlement.id);

  const [settlementRow] = await db.select({
    id: operationalRecords.id,
    clientRecordId: operationalRecords.clientRecordId,
    payload: operationalRecords.payload,
  }).from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId, tenant.workspaceId),
    eq(operationalRecords.entityType, "labourWageSettlement"),
    eq(operationalRecords.clientRecordId, createdSettlement.id),
  )).limit(1);
  assert.ok(settlementRow);
  assert.equal((settlementRow!.payload as Record<string, unknown>).paidAmount, 0);
  assert.equal((settlementRow!.payload as Record<string, unknown>).paymentAccountId ?? null, null);

  const allocationRows = await db.select().from(labourWageSettlementAdvanceAllocations).where(eq(labourWageSettlementAdvanceAllocations.settlementRecordId, settlementRow!.id));
  assert.equal(allocationRows.length, 2);
  assert.equal(allocationRows[0]!.settlementRecordId, settlementRow!.id);

  const [advanceRow] = await db.select({
    id: operationalRecords.id,
  }).from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId, tenant.workspaceId),
    eq(operationalRecords.entityType, "advance"),
    eq(operationalRecords.clientRecordId, advanceId),
  )).limit(1);
  assert.ok(advanceRow);
  const originalAdvanceAllocation = allocationRows.find((row) => row.advanceRecordId === advanceRow!.id);
  assert.ok(originalAdvanceAllocation);
  assert.equal(Number(originalAdvanceAllocation.absorbedAmount), 120);
  assert.equal(allocationRows.reduce((sum, row) => sum + Number(row.absorbedAmount), 0), 130);

  const [attendanceRowAfterCreate] = await db.select({
    payload: operationalRecords.payload,
  }).from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId, tenant.workspaceId),
    eq(operationalRecords.entityType, "attendance"),
    eq(operationalRecords.clientRecordId, attendanceId),
  )).limit(1);
  assert.equal((attendanceRowAfterCreate!.payload as Record<string, unknown>).linkedSettlementId, createdSettlement.id);

  const [earningRowAfterCreate] = await db.select({
    payload: operationalRecords.payload,
  }).from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId, tenant.workspaceId),
    eq(operationalRecords.entityType, "labourEarning"),
    eq(operationalRecords.clientRecordId, earningId),
  )).limit(1);
  assert.equal(normalizeLabourEarningPayload(earningRowAfterCreate!.payload as Record<string, unknown>).status, "settled");
  assert.equal(normalizeLabourEarningPayload(earningRowAfterCreate!.payload as Record<string, unknown>).linkedSettlementId, createdSettlement.id);

  const accountEntriesAfterCreate = await db.select().from(accountTransactions).where(and(
    eq(accountTransactions.referenceId, createdSettlement.id),
    eq(accountTransactions.source, "settlement"),
    eq(accountTransactions.sourceType, "labour_wage_settlement"),
  ));
  assert.equal(accountEntriesAfterCreate.length, 0);

  const [linkedDue] = await db.select().from(labourDues).where(eq(labourDues.sourceRecordId, settlementRow!.id)).limit(1);
  assert.ok(linkedDue);
  assert.equal(linkedDue!.paymentStatus, "PARTIALLY_SETTLED");
  const paymentIdempotencyKey = randomUUID();
  const payResponse = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-payments/dues/${linkedDue!.id}/settle`, {
    farmId: tenant.farmId,
    seasonId: tenant.seasonId,
    advanceApplications: [],
    payment: { idempotencyKey: paymentIdempotencyKey, voucherDate: "2026-05-01", amount: 70, paymentAccountId: paymentAccount.id, paymentMethod: "Cash" },
  });
  assertIntegrationResponse(payResponse, 200, "pay settlement due balance");
  assert.equal(payResponse.json().result.due.outstandingBalance, 0);
  assert.equal(payResponse.json().result.due.due.paymentStatus, "PAID");
  const paymentVoucherId = payResponse.json().result.voucher.id as string;
  const retryPayResponse = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-payments/dues/${linkedDue!.id}/settle`, {
    farmId: tenant.farmId,
    seasonId: tenant.seasonId,
    advanceApplications: [],
    payment: { idempotencyKey: paymentIdempotencyKey, voucherDate: "2026-05-01", amount: 70, paymentAccountId: paymentAccount.id, paymentMethod: "Cash" },
  });
  assertIntegrationResponse(retryPayResponse, 200, "retry settlement due payment after lost acknowledgement");
  assert.equal(retryPayResponse.json().result.voucher.id, paymentVoucherId);
  assert.equal((await db.select().from(labourPaymentVouchers).where(eq(labourPaymentVouchers.idempotencyKey, paymentIdempotencyKey))).length, 1);

  const blockedVoidResponse = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-wage-settlements/${createdSettlement.id}/void`, { voidReason: "Must reverse payment first" });
  assert.equal(blockedVoidResponse.statusCode, 409);
  const voucherVoidResponse = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-payments/vouchers/${paymentVoucherId}/void?${new URLSearchParams({ farmId: tenant.farmId, seasonId: tenant.seasonId })}`, {
    idempotencyKey: randomUUID(), reason: "Integration test payment reversal",
  });
  assertIntegrationResponse(voucherVoidResponse, 200, "reverse settlement Labour Payment Voucher");

  const voidResponse = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-wage-settlements/${createdSettlement.id}/void`, {
    voidReason: "Integration test void",
  });
  assert.equal(voidResponse.statusCode, 200);
  assert.equal(voidResponse.json().status, "voided");

  const duplicateVoidResponse = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-wage-settlements/${createdSettlement.id}/void`, {
    voidReason: "Integration test void",
  });
  assert.equal(duplicateVoidResponse.statusCode, 200);
  assert.equal(duplicateVoidResponse.json().status, "voided");

  const [settlementRowAfterVoid] = await db.select({
    payload: operationalRecords.payload,
  }).from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId, tenant.workspaceId),
    eq(operationalRecords.entityType, "labourWageSettlement"),
    eq(operationalRecords.clientRecordId, createdSettlement.id),
  )).limit(1);
  assert.equal(normalizeSettlementPayload(settlementRowAfterVoid!.payload as Record<string, unknown>).status, "voided");

  const [attendanceRowAfterVoid] = await db.select({
    payload: operationalRecords.payload,
  }).from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId, tenant.workspaceId),
    eq(operationalRecords.entityType, "attendance"),
    eq(operationalRecords.clientRecordId, attendanceId),
  )).limit(1);
  assert.equal((attendanceRowAfterVoid!.payload as Record<string, unknown>).linkedSettlementId ?? null, null);

  const [earningRowAfterVoid] = await db.select({
    payload: operationalRecords.payload,
  }).from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId, tenant.workspaceId),
    eq(operationalRecords.entityType, "labourEarning"),
    eq(operationalRecords.clientRecordId, earningId),
  )).limit(1);
  assert.equal(normalizeLabourEarningPayload(earningRowAfterVoid!.payload as Record<string, unknown>).status, "pending_settlement");
  assert.equal(normalizeLabourEarningPayload(earningRowAfterVoid!.payload as Record<string, unknown>).linkedSettlementId, null);

  const accountEntriesAfterVoid = await db.select().from(accountTransactions).where(and(
    eq(accountTransactions.referenceId, createdSettlement.id),
    eq(accountTransactions.source, "settlement"),
    eq(accountTransactions.sourceType, "labour_wage_settlement"),
  ));
  assert.equal(accountEntriesAfterVoid.length, 0);

  const previewAfterVoidResponse = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-wage-settlements/preview`, {
    farmId: tenant.farmId,
    seasonId: tenant.seasonId,
    fromDate: "2026-04-11",
    toDate: "2026-04-30",
    settlementDate: "2026-05-01",
    settlementMode: "group",
    groupId: labourGroupId,
    paidAmount: 0,
    manualAdjustment: 0,
  });
  assert.equal(previewAfterVoidResponse.statusCode, 200);
  const previewAfterVoid = previewAfterVoidResponse.json().preview;
  assert.equal(previewAfterVoid.previouslySettledAdvances, 0);
  assert.equal(previewAfterVoid.availableAdvanceBalanceBeforeSettlement, 130);
});

test("labour wage settlement creates an unpaid due without requiring a payment account", async () => {
  const labourerId = randomUUID();
  const labourGroupId = randomUUID();
  const clientRequestId = randomUUID();

  await setupRequest("create missing-account settlement group", "POST", "/v1/workspace/operational-records", envelope("labourGroup", labourGroupId, {
    name: "Missing Account Group",
    active: true,
  }));
  assert.equal((await request("POST", "/v1/workspace/operational-records", envelope("labourer", labourerId, {
    name: "Missing Account Foreman",
    groupId: labourGroupId,
    group: "Missing Account Group",
    active: true,
  }))).statusCode, 200);
  assert.equal((await request("POST", "/v1/workspace/operational-records", envelope("labourGroup", labourGroupId, {
    name: "Missing Account Group",
    foremanLabourId: labourerId,
    foremanId: labourerId,
    active: true,
  }))).statusCode, 200);
  assert.equal((await request("POST", `/v1/workspace/${tenant.workspaceId}/wage-rates/bulk`, {
    farmId: tenant.farmId,
    seasonId: tenant.seasonId,
    effectiveFrom: "2026-04-01",
    effectiveTo: "2026-05-31",
    rows: [{ labourerId, dailyRate: 100 }],
  })).statusCode, 200);

  const response = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-wage-settlements`, {
    farmId: tenant.farmId,
    seasonId: tenant.seasonId,
    fromDate: "2026-04-11",
    toDate: "2026-04-30",
    settlementDate: "2026-05-01",
    settlementMode: "group",
    groupId: labourGroupId,
    paidAmount: 0,
    manualAdjustment: 0,
    clientRequestId,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().settlement.paidAmount, 0);

  const [requestRow] = await db.select({
    state: labourWageSettlementCreateRequests.state,
    stage: labourWageSettlementCreateRequests.stage,
    errorCode: labourWageSettlementCreateRequests.errorCode,
    safeToRetry: labourWageSettlementCreateRequests.safeToRetry,
  }).from(labourWageSettlementCreateRequests).where(and(
    eq(labourWageSettlementCreateRequests.workspaceId, tenant.workspaceId),
    eq(labourWageSettlementCreateRequests.clientRequestId, clientRequestId),
    eq(labourWageSettlementCreateRequests.operationType, "labour_wage_settlement_create"),
  )).limit(1);
  assert.ok(requestRow);
  assert.equal(requestRow!.state, "committed");
  assert.equal(requestRow!.stage, "committed");
  assert.equal(requestRow!.errorCode, null);

  const settlementRows = await db.select({
    id: operationalRecords.id,
    payload: operationalRecords.payload,
  }).from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId, tenant.workspaceId),
    eq(operationalRecords.entityType, "labourWageSettlement"),
  ));
  assert.equal(settlementRows.filter((row) => normalizeSettlementPayload(row.payload as Record<string, unknown>).clientRequestId === clientRequestId).length, 1);
});

test("settlement status keeps committed settlements with missing accounts in SUCCESS plus REPAIR_REQUIRED", async () => {
  const clientRequestId = randomUUID();
  const settlementId = randomUUID();
  const missingAccountId = randomUUID();

  await db.insert(operationalRecords).values({
    workspaceId: tenant.workspaceId,
    farmId: tenant.farmId,
    seasonId: tenant.seasonId,
    clientRecordId: settlementId,
    entityType: "labourWageSettlement",
    payload: settlementPayload({
      clientRequestId,
      settlementNumber: "LW-0006",
      paymentAccountId: missingAccountId,
      paymentAccountCanonicalId: missingAccountId,
      linkedAccountId: missingAccountId,
      linkedAccountName: "Missing account",
      paidAmount: 150,
      expenseAmount: 150,
    }),
    recordedBy: tenant.userId,
    clientUpdatedAt: new Date(now),
  });

  const [beforeRow] = await db.select({
    payload: operationalRecords.payload,
    updatedAt: operationalRecords.updatedAt,
  }).from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId, tenant.workspaceId),
    eq(operationalRecords.entityType, "labourWageSettlement"),
    eq(operationalRecords.clientRecordId, settlementId),
  )).limit(1);
  assert.ok(beforeRow);

  const response = await request("GET", settlementStatusUrl(clientRequestId));
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().state, "SUCCESS");
  assert.equal(response.json().settlementNumber, "LW-0006");
  assert.equal(response.json().accountingStatus, "REPAIR_REQUIRED");
  assert.equal(response.json().accountingMessage?.includes("cannot be reposted"), false);
  assert.equal(response.json().lifecycleMessage, "Settlement LW-0006 was created successfully.");
  assert.equal(response.json().message, "Settlement LW-0006 was created successfully.");

  const [afterRow] = await db.select({
    payload: operationalRecords.payload,
    updatedAt: operationalRecords.updatedAt,
  }).from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId, tenant.workspaceId),
    eq(operationalRecords.entityType, "labourWageSettlement"),
    eq(operationalRecords.clientRecordId, settlementId),
  )).limit(1);
  assert.deepEqual(afterRow, beforeRow);
});

test("settlement status returns SUCCESS plus COMPLETE when accounting is already posted", async () => {
  const clientRequestId = randomUUID();
  const settlementId = randomUUID();

  const [account] = await db.insert(accounts).values({
    farmId: tenant.farmId,
    name: "Status Test Account",
    accountType: "cash",
    active: true,
  }).returning({ id: accounts.id });
  assertPersistedUuid(account?.id, "create status payment account");

  await db.insert(operationalRecords).values({
    workspaceId: tenant.workspaceId,
    farmId: tenant.farmId,
    seasonId: tenant.seasonId,
    clientRecordId: settlementId,
    entityType: "labourWageSettlement",
    payload: settlementPayload({
      clientRequestId,
      settlementNumber: "LW-0007",
      paymentAccountId: account.id,
      paymentAccountCanonicalId: account.id,
      linkedAccountId: account.id,
      linkedAccountName: "Status Test Account",
      paymentAccountName: "Status Test Account",
      paymentAccountType: "cash",
      paidAmount: 150,
      expenseAmount: 150,
    }),
    recordedBy: tenant.userId,
    clientUpdatedAt: new Date(now),
  });

  await db.insert(accountTransactions).values({
    farmId: tenant.farmId,
    seasonId: tenant.seasonId,
    accountId: account.id,
    source: "settlement",
    sourceType: "labour_wage_settlement",
    referenceId: settlementId,
    type: "debit",
    amount: "150",
    transactionDate: "2026-05-01",
    remarks: "Labour Wage Settlement LW-0007",
    createdBy: tenant.userId,
  });

  const response = await request("GET", settlementStatusUrl(clientRequestId));
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().state, "SUCCESS");
  assert.equal(response.json().settlementNumber, "LW-0007");
  assert.equal(response.json().accountingStatus, "COMPLETE");
  assert.equal(response.json().accountingMessage, null);
  assert.equal(response.json().lifecycleMessage, "Settlement LW-0007 was created successfully.");
});

test("rolled-back settlement status normalizes accounting repair text into a safe lifecycle failure", async () => {
  const clientRequestId = randomUUID();

  await db.insert(labourWageSettlementCreateRequests).values({
    workspaceId: tenant.workspaceId,
    farmId: tenant.farmId,
    seasonId: tenant.seasonId,
    clientRequestId,
    operationType: "labour_wage_settlement_create",
    state: "rolled_back",
    stage: "rolled_back",
    errorCode: "SETTLEMENT_ACCOUNTING_REPAIR_FAILED",
    safeToRetry: true,
    message: "Settlement LW-0006 cannot be reposted because its payment account no longer exists.",
    correlationId: "status-normalization-test",
    completedAt: new Date(),
  });

  const response = await request("GET", settlementStatusUrl(clientRequestId));
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().state, "FAILED");
  assert.equal(response.json().message, "Settlement could not be created. No changes were saved.");
  assert.equal(response.json().lifecycleMessage, "Settlement could not be created. No changes were saved.");
  assert.equal(response.json().accountingStatus, null);
  assert.equal(response.json().accountingMessage, null);
  assert.equal(response.json().errorCode, "SETTLEMENT_ACCOUNTING_REPAIR_FAILED");
  assert.equal(response.json().lifecycleErrorCode, "SETTLEMENT_ACCOUNTING_REPAIR_FAILED");
  assert.notEqual(response.json().message, "Settlement LW-0006 cannot be reposted because its payment account no longer exists.");
});

test("group labour work is counted once in group settlement preview and posting", async () => {
  const foremanId = randomUUID();
  const workerId = randomUUID();
  const groupId = randomUUID();
  const earningId = randomUUID();
  const attendanceId = randomUUID();
  const clientRequestId = randomUUID();
  const concurrentRequestId = randomUUID();

  const [paymentAccount] = await db.insert(accounts).values({
    farmId: tenant.farmId,
    name: "Group Settlement Cash",
    accountType: "cash",
    active: true,
  }).returning({ id: accounts.id });
  assertPersistedUuid(paymentAccount?.id, "create group settlement payment account");
  await setupRequest("persist group settlement payment account identity", "POST", "/v1/workspace/operational-records", envelope("account", paymentAccount.id, {
    name: "Group Settlement Cash",
    type: "cash",
    active: true,
  }));

  await setupRequest("create group-settlement group", "POST", "/v1/workspace/operational-records", envelope("labourGroup", groupId, {
    name: "Group Alpha",
    active: true,
  }));
  await setupRequest("create group foreman", "POST", "/v1/workspace/operational-records", envelope("labourer", foremanId, {
    name: "Group Foreman",
    groupId,
    group: "Group Alpha",
    active: true,
  }));
  await setupRequest("create group worker", "POST", "/v1/workspace/operational-records", envelope("labourer", workerId, {
    name: "Group Worker",
    groupId,
    group: "Group Alpha",
    active: true,
  }));
  await setupRequest("assign group foreman", "POST", "/v1/workspace/operational-records", envelope("labourGroup", groupId, {
    name: "Group Alpha",
    foremanLabourId: foremanId,
    foremanId,
    active: true,
  }));
  await setupRequest("create group worker wage rate", "POST", `/v1/workspace/${tenant.workspaceId}/wage-rates/bulk`, {
    farmId: tenant.farmId,
    seasonId: tenant.seasonId,
    effectiveFrom: "2026-06-01",
    effectiveTo: "2026-06-30",
    rows: [{ labourerId: workerId, dailyRate: 100 }],
  });
  await setupRequest("create group attendance", "POST", "/v1/workspace/operational-records", envelope("attendance", attendanceId, {
    labourerId: workerId,
    date: "2026-06-15",
    status: "present",
  }));
  const groupEarningResponse = await setupRequest("create group labour earning", "POST", "/v1/workspace/operational-records", envelope("labourEarning", earningId, {
    earningScope: "group",
    labourGroupId: groupId,
    labourGroupName: "Group Alpha",
    foremanId,
    earningDate: "2026-06-16",
    amount: 75,
    earningType: "bonus",
    description: "Group bonus",
    status: "pending_settlement",
  }));
  const persistedGroupEarning = normalizeLabourEarningPayload((groupEarningResponse.json() as { record: Record<string, unknown> }).record);
  assert.equal(persistedGroupEarning.earningScope, "group");
  assert.equal(persistedGroupEarning.labourGroupId, groupId);
  assert.equal(persistedGroupEarning.status, "pending_settlement");
  assert.equal(labourEarningEligibleForSettlement(persistedGroupEarning, {
    settlementMode: "group",
    groupId,
    foremanId,
    labourIds: [foremanId, workerId],
    settlementDate: "2026-07-01",
  }), true);
  const [storedGroupEarning] = await db.select({
    farmId: operationalRecords.farmId,
    seasonId: operationalRecords.seasonId,
    payload: operationalRecords.payload,
  }).from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId, tenant.workspaceId),
    eq(operationalRecords.entityType, "labourEarning"),
    eq(operationalRecords.clientRecordId, earningId),
  )).limit(1);
  assert.ok(storedGroupEarning, "group labour earning was not persisted");
  assert.equal(storedGroupEarning.farmId, tenant.farmId);
  assert.equal(storedGroupEarning.seasonId, tenant.seasonId);
  assert.equal(labourEarningEligibleForSettlement(storedGroupEarning.payload, {
    settlementMode: "group",
    groupId,
    foremanId,
    labourIds: [foremanId, workerId],
    settlementDate: "2026-07-01",
  }), true);

  const previewResponse = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-wage-settlements/preview`, {
    farmId: tenant.farmId,
    seasonId: tenant.seasonId,
    fromDate: "2026-06-01",
    toDate: "2026-06-30",
    settlementDate: "2026-07-01",
    settlementMode: "group",
    groupId,
    paidAmount: 0,
    manualAdjustment: 0,
  });
  assert.equal(previewResponse.statusCode, 200);
  const preview = previewResponse.json().preview;
  assert.equal(preview.groupLabourWorkWages, 75);
  assert.equal(preview.individualLabourWorkWages ?? 0, 0);
  assert.equal(preview.includedEarnings.length, 1);
  assert.equal(preview.includedEarnings[0].earningScope, "group");
  assert.equal(preview.includedEarnings[0].labourGroupId, groupId);
  assert.equal(preview.attendanceWages, 100);
  assert.equal(preview.grossWages, 175);
  assert.equal(preview.netPayableBeforePayment, 175);
  assert.equal(preview.balanceAfterPayment, 175);

  const createPayload = {
    farmId: tenant.farmId,
    seasonId: tenant.seasonId,
    fromDate: "2026-06-01",
    toDate: "2026-06-30",
    settlementDate: "2026-07-01",
    settlementMode: "group",
    groupId,
    paidAmount: 0,
    manualAdjustment: 0,
    clientRequestId,
  };
  const concurrentPayload = { ...createPayload, clientRequestId: concurrentRequestId };
  const concurrentResponses = await Promise.all([
    request("POST", `/v1/workspace/${tenant.workspaceId}/labour-wage-settlements`, createPayload),
    request("POST", `/v1/workspace/${tenant.workspaceId}/labour-wage-settlements`, concurrentPayload),
  ]);
  assert.deepEqual(concurrentResponses.map((response) => response.statusCode).sort(), [200, 409]);
  const createResponse = concurrentResponses.find((response) => response.statusCode === 200)!;
  const winningClientRequestId = createResponse.json().clientRequestId as string;
  const winningPayload = winningClientRequestId === clientRequestId ? createPayload : concurrentPayload;
  const settlement = createResponse.json().settlement;
  assert.equal(settlement.groupLabourWorkWages, 75);
  assert.equal(settlement.individualLabourWorkWages ?? 0, 0);
  assert.equal(settlement.grossWages, preview.grossWages);
  assert.equal(settlement.paidAmount, preview.paidAmount);
  assert.equal(settlement.balanceAfterPayment, preview.balanceAfterPayment);

  const lostAcknowledgementRetry = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-wage-settlements`, winningPayload);
  assertIntegrationResponse(lostAcknowledgementRetry, 200, "retry committed group settlement after lost acknowledgement");
  assert.equal(lostAcknowledgementRetry.json().settlement.id, settlement.id);

  const groupSettlementRows = (await db.select({
    clientRecordId: operationalRecords.clientRecordId,
    payload: operationalRecords.payload,
  }).from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId, tenant.workspaceId),
    eq(operationalRecords.entityType, "labourWageSettlement"),
  ))).filter((row) => normalizeSettlementPayload(row.payload).fromDate === "2026-06-01");
  assert.equal(groupSettlementRows.length, 1);
  const groupAccountEntries = await db.select().from(accountTransactions).where(and(
    eq(accountTransactions.referenceId, settlement.id),
    eq(accountTransactions.sourceType, "labour_wage_settlement"),
  ));
  assert.equal(groupAccountEntries.length, 0);

  const [earningRow] = await db.select({
    payload: operationalRecords.payload,
  }).from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId, tenant.workspaceId),
    eq(operationalRecords.entityType, "labourEarning"),
    eq(operationalRecords.clientRecordId, earningId),
  )).limit(1);
  assert.ok(earningRow);
  assert.equal((earningRow.payload as Record<string, unknown>).status, "settled");
  assert.equal((earningRow.payload as Record<string, unknown>).linkedSettlementId, settlement.id);

  await setupRequest("rename group after settlement", "POST", "/v1/workspace/operational-records", envelope("labourGroup", groupId, {
    name: "Group Alpha Renamed",
    foremanLabourId: foremanId,
    foremanId,
    active: true,
  }));
  const historicalSettlementResponse = await request("GET", `/v1/workspace/${tenant.workspaceId}/labour-wage-settlements/${settlement.id}`);
  assertIntegrationResponse(historicalSettlementResponse, 200, "load historical group settlement after group edit");
  assert.equal(historicalSettlementResponse.json().settlement.groupName, "Group Alpha");
  assert.deepEqual(historicalSettlementResponse.json().settlement.includedLabourIds, [workerId]);
  assert.equal(historicalSettlementResponse.json().settlement.foremanId, foremanId);

  const voidResponse = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-wage-settlements/${settlement.id}/void`, {
    voidReason: "Concurrent lifecycle verification",
  });
  assertIntegrationResponse(voidResponse, 200, "void concurrent group settlement");
  const repeatedVoid = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-wage-settlements/${settlement.id}/void`, {
    voidReason: "Concurrent lifecycle verification retry",
  });
  assertIntegrationResponse(repeatedVoid, 200, "retry concurrent group settlement void");
  const groupAccountEntriesAfterVoid = await db.select().from(accountTransactions).where(and(
    eq(accountTransactions.referenceId, settlement.id),
    eq(accountTransactions.sourceType, "labour_wage_settlement"),
  ));
  assert.equal(groupAccountEntriesAfterVoid.length, 0);
  const [earningAfterVoid] = await db.select({ payload: operationalRecords.payload }).from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId, tenant.workspaceId),
    eq(operationalRecords.entityType, "labourEarning"),
    eq(operationalRecords.clientRecordId, earningId),
  )).limit(1);
  assert.equal(normalizeLabourEarningPayload(earningAfterVoid!.payload).status, "pending_settlement");
});

test("advance cutoff, partial allocation, report reconciliation, void restoration, and re-settlement remain consistent", async () => {
  const groupId = randomUUID();
  const labourerId = randomUUID();
  const attendanceId = randomUUID();
  const earningId = randomUUID();
  const beforeAdvanceId = randomUUID();
  const duringAdvanceId = randomUUID();
  const afterCutoffAdvanceId = randomUUID();
  const deletedAdvanceId = randomUUID();

  const [paymentAccount] = await db.insert(accounts).values({
    farmId: tenant.farmId,
    name: "Partial Advance Settlement Cash",
    accountType: "cash",
    active: true,
  }).returning({ id: accounts.id });
  assertPersistedUuid(paymentAccount?.id, "create partial-advance settlement payment account");
  await setupRequest("persist partial-advance partner identity", "POST", "/v1/workspace/operational-records", envelope("account", paymentAccount.id, {
    name: "Partner Funded Advances",
    type: "partner",
    active: true,
  }));
  await setupRequest("create partial-advance group", "POST", "/v1/workspace/operational-records", envelope("labourGroup", groupId, {
    name: "Partial Advance Group",
    active: true,
  }));
  await setupRequest("create partial-advance foreman", "POST", "/v1/workspace/operational-records", envelope("labourer", labourerId, {
    name: "Partial Advance Foreman",
    groupId,
    group: "Partial Advance Group",
    active: true,
  }));
  await setupRequest("assign partial-advance foreman", "POST", "/v1/workspace/operational-records", envelope("labourGroup", groupId, {
    name: "Partial Advance Group",
    foremanLabourId: labourerId,
    foremanId: labourerId,
    active: true,
  }));
  await setupRequest("create partial-advance wage rate", "POST", `/v1/workspace/${tenant.workspaceId}/wage-rates/bulk`, {
    farmId: tenant.farmId,
    seasonId: tenant.seasonId,
    effectiveFrom: "2026-08-01",
    effectiveTo: "2026-08-31",
    rows: [{ labourerId, dailyRate: 100 }],
  });
  await setupRequest("create partial-advance attendance", "POST", "/v1/workspace/operational-records", envelope("attendance", attendanceId, {
    labourerId,
    date: "2026-08-10",
    status: "present",
  }));
  await setupRequest("create partial-advance labour earning", "POST", "/v1/workspace/operational-records", envelope("labourEarning", earningId, {
    labourerId,
    earningDate: "2026-08-11",
    amount: 50,
    earningType: "task",
    description: "Harvest task",
    status: "pending_settlement",
  }));
  for (const [step, id, date, amount] of [
    ["create pre-period advance", beforeAdvanceId, "2026-07-31", 100],
    ["create in-period advance", duringAdvanceId, "2026-08-15", 100],
    ["create post-cutoff advance", afterCutoffAdvanceId, "2026-09-02", 300],
    ["create deleted advance", deletedAdvanceId, "2026-08-20", 999],
  ] as const) {
    await setupRequest(step, "POST", "/v1/workspace/operational-records", envelope("advance", id, {
      labourerId,
      labourGroupId: groupId,
      labourGroupName: "Partial Advance Group",
      date,
      amount,
      accountId: paymentAccount.id,
      sourceAccountName: "Partner Funded Advances",
    }));
  }
  assertIntegrationResponse(await request("DELETE", "/v1/workspace/operational-records", {
    workspaceId: tenant.workspaceId,
    farmId: tenant.farmId,
    seasonId: tenant.seasonId,
    entity: "advance",
    recordId: deletedAdvanceId,
  }), 204, "delete excluded advance");

  const previewPayload = {
    farmId: tenant.farmId,
    seasonId: tenant.seasonId,
    fromDate: "2026-08-01",
    toDate: "2026-08-31",
    settlementDate: "2026-09-01",
    settlementMode: "group",
    groupId,
    paidAmount: 0,
    manualAdjustment: 0,
  };
  const firstPreviewResponse = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-wage-settlements/preview`, previewPayload);
  assertIntegrationResponse(firstPreviewResponse, 200, "preview partial-advance settlement");
  const preview = firstPreviewResponse.json().preview;
  assert.equal(preview.attendanceWages, 100);
  assert.equal(preview.individualLabourWorkWages, 50);
  assert.equal(preview.grossWages, 150);
  assert.equal(preview.rawAdvancesUpToSettlementDate, 200);
  assert.equal(preview.availableAdvanceBalanceBeforeSettlement, 200);
  assert.equal(preview.advanceAdjustedNow, 150);
  assert.equal(preview.remainingAdvanceCarryForward, 50);
  assert.equal(preview.netPayableBeforePayment, 0);
  assert.equal(preview.advanceReconciliation.some((row: { advanceId: string }) => row.advanceId === afterCutoffAdvanceId), true);
  assert.equal(preview.advanceReconciliation.find((row: { advanceId: string }) => row.advanceId === afterCutoffAdvanceId).includedInPreview, false);
  assert.equal(preview.advanceReconciliation.find((row: { advanceId: string }) => row.advanceId === deletedAdvanceId).includedInPreview, false);
  const secondPreviewResponse = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-wage-settlements/preview`, previewPayload);
  assertIntegrationResponse(secondPreviewResponse, 200, "repeat partial-advance preview");
  assert.deepEqual(secondPreviewResponse.json().preview, preview);

  const reconciliationUrl = `/v1/debug/accounting-reconciliation?workspaceId=${tenant.workspaceId}&farmId=${tenant.farmId}&seasonId=${tenant.seasonId}&accountId=${paymentAccount.id}`;
  const reconciliationBeforePosting = await request("GET", reconciliationUrl);
  assertIntegrationResponse(reconciliationBeforePosting, 200, "reconcile partner advances before settlement");
  assert.equal(reconciliationBeforePosting.json().labourWageSettlements.sourceOfTruthSnapshot.labourAdvancesPaid, 500);
  assert.equal(reconciliationBeforePosting.json().labourWageSettlements.sourceOfTruthSnapshot.settledAdvances, 0);
  assert.equal(reconciliationBeforePosting.json().labourWageSettlements.sourceOfTruthSnapshot.outstandingLabourAdvances, 500);
  assert.equal(reconciliationBeforePosting.json().labourWageSettlements.sourceOfTruthSnapshot.farmOwesPartner, 500);

  const createPayload = {
    ...previewPayload,
    paymentAccountId: paymentAccount.id,
    clientRequestId: randomUUID(),
  };
  const createResponse = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-wage-settlements`, createPayload);
  assertIntegrationResponse(createResponse, 200, "post partial-advance settlement");
  const settlement = createResponse.json().settlement;
  assert.equal(settlement.grossWages, preview.grossWages);
  assert.equal(settlement.advanceAdjustedNow, preview.advanceAdjustedNow);
  assert.equal(settlement.netPayableBeforePayment, preview.netPayableBeforePayment);

  const [settlementRecord] = await db.select({ id: operationalRecords.id }).from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId, tenant.workspaceId),
    eq(operationalRecords.entityType, "labourWageSettlement"),
    eq(operationalRecords.clientRecordId, settlement.id),
  )).limit(1);
  assert.ok(settlementRecord);
  const allocations = await db.select().from(labourWageSettlementAdvanceAllocations).where(
    eq(labourWageSettlementAdvanceAllocations.settlementRecordId, settlementRecord.id),
  );
  assert.equal(allocations.length, 2);
  assert.equal(allocations.reduce((sum, row) => sum + Number(row.absorbedAmount), 0), 150);
  assert.deepEqual(allocations.map((row) => Number(row.absorbedAmount)).sort((a, b) => a - b), [50, 100]);
  assert.equal((await db.select().from(accountTransactions).where(eq(accountTransactions.referenceId, settlement.id))).length, 0);

  const advanceReportUrl = `/v1/workspace/${tenant.workspaceId}/advance/report?farmId=${tenant.farmId}&seasonId=${tenant.seasonId}&from=2026-07-01&to=2026-09-02&labourIds=${labourerId}`;
  const advancesAfterPosting = await request("GET", advanceReportUrl);
  assertIntegrationResponse(advancesAfterPosting, 200, "reconcile advances after settlement posting");
  assert.equal(advancesAfterPosting.json().grandTotal, 500);
  assert.equal(advancesAfterPosting.json().settledAdvances, 150);
  assert.equal(advancesAfterPosting.json().outstandingAdvances, 350);
  const reconciliationAfterPosting = await request("GET", reconciliationUrl);
  assertIntegrationResponse(reconciliationAfterPosting, 200, "reconcile partner advances after settlement");
  assert.equal(reconciliationAfterPosting.json().labourWageSettlements.sourceOfTruthSnapshot.labourAdvancesPaid, 500);
  assert.equal(reconciliationAfterPosting.json().labourWageSettlements.sourceOfTruthSnapshot.settledAdvances, 150);
  assert.equal(reconciliationAfterPosting.json().labourWageSettlements.sourceOfTruthSnapshot.outstandingLabourAdvances, 350);
  assert.equal(reconciliationAfterPosting.json().labourWageSettlements.sourceOfTruthSnapshot.farmOwesPartner, 500);

  const voidResponse = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-wage-settlements/${settlement.id}/void`, {
    voidReason: "Restore partially allocated advances",
  });
  assertIntegrationResponse(voidResponse, 200, "void partial-advance settlement");
  const advancesAfterVoid = await request("GET", advanceReportUrl);
  assertIntegrationResponse(advancesAfterVoid, 200, "reconcile advances after settlement void");
  assert.equal(advancesAfterVoid.json().grandTotal, 500);
  assert.equal(advancesAfterVoid.json().settledAdvances, 0);
  assert.equal(advancesAfterVoid.json().outstandingAdvances, 500);
  const reconciliationAfterVoid = await request("GET", reconciliationUrl);
  assertIntegrationResponse(reconciliationAfterVoid, 200, "reconcile partner advances after settlement void");
  assert.equal(reconciliationAfterVoid.json().labourWageSettlements.sourceOfTruthSnapshot.labourAdvancesPaid, 500);
  assert.equal(reconciliationAfterVoid.json().labourWageSettlements.sourceOfTruthSnapshot.settledAdvances, 0);
  assert.equal(reconciliationAfterVoid.json().labourWageSettlements.sourceOfTruthSnapshot.outstandingLabourAdvances, 500);
  assert.equal(reconciliationAfterVoid.json().labourWageSettlements.sourceOfTruthSnapshot.farmOwesPartner, 500);

  const reSettlementResponse = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-wage-settlements`, {
    ...createPayload,
    clientRequestId: randomUUID(),
  });
  assertIntegrationResponse(reSettlementResponse, 200, "re-settle sources after void");
  assert.notEqual(reSettlementResponse.json().settlement.id, settlement.id);
  assert.equal(reSettlementResponse.json().settlement.advanceAdjustedNow, 150);
  assertIntegrationResponse(await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-wage-settlements/${reSettlementResponse.json().settlement.id}/void`, {
    voidReason: "Clean up re-settlement verification",
  }), 200, "void re-settlement verification");
});

test("settlement history returns current, voided legacy, and isolates an explicitly different context", async () => {
  const currentId = randomUUID();
  const legacyVoidedId = randomUUID();
  const otherId = randomUUID();
  const otherFarmId = randomUUID();
  const otherSeasonId = randomUUID();
  await db.insert(farms).values({ id: otherFarmId, workspaceId: tenant.workspaceId, name: "Other Settlement Farm" });
  await db.insert(seasons).values({
    id: otherSeasonId, workspaceId: tenant.workspaceId, farmId: otherFarmId, name: "Other Settlement Season",
    year: 2026, startsOn: "2026-01-01", status: "active",
  });
  await db.insert(operationalRecords).values([
    {
      workspaceId: tenant.workspaceId, farmId: tenant.farmId, seasonId: tenant.seasonId,
      clientRecordId: currentId, entityType: "labourWageSettlement", recordedBy: tenant.userId,
      clientUpdatedAt: new Date(now), payload: settlementPayload({ settlementNumber: "LW-HISTORY-ACTIVE", paidAmount: 0, expenseAmount: 120 }),
    },
    {
      workspaceId: tenant.workspaceId, farmId: null, seasonId: null, sourceType: "old_android",
      clientRecordId: legacyVoidedId, entityType: "labourWageSettlement", recordedBy: tenant.userId,
      clientUpdatedAt: new Date(now), payload: settlementPayload({ settlementNumber: "LW-HISTORY-VOIDED", status: "voided", paidAmount: 0, expenseAmount: 80 }),
    },
    {
      workspaceId: tenant.workspaceId, farmId: otherFarmId, seasonId: otherSeasonId,
      clientRecordId: otherId, entityType: "labourWageSettlement", recordedBy: tenant.userId,
      clientUpdatedAt: new Date(now), payload: settlementPayload({ settlementNumber: "LW-HISTORY-OTHER", paidAmount: 0, expenseAmount: 60 }),
    },
  ]);

  const baseUrl = `/v1/workspace/${tenant.workspaceId}/labour-reconciliation/settlements?farmId=${tenant.farmId}&seasonId=${tenant.seasonId}&page=1&pageSize=100`;
  const response = await request("GET", baseUrl);
  assertIntegrationResponse(response, 200, "load settlement history");
  const body = response.json();
  const idsReturned = body.settlements.map((row: { id: string }) => row.id);
  assert.ok(idsReturned.includes(currentId));
  assert.ok(idsReturned.includes(legacyVoidedId));
  assert.ok(!idsReturned.includes(otherId));
  assert.equal(body.settlements.find((row: { id: string }) => row.id === legacyVoidedId)?.integrityStatus, "VOIDED");
  assert.ok(body.summary.totalCount >= body.settlements.length);

  const legacyResponse = await request("GET", `${baseUrl}&source=LEGACY`);
  assertIntegrationResponse(legacyResponse, 200, "filter legacy settlement history");
  assert.ok(legacyResponse.json().settlements.some((row: { id: string }) => row.id === legacyVoidedId));
  assert.ok(!legacyResponse.json().settlements.some((row: { id: string }) => row.id === currentId));
});
