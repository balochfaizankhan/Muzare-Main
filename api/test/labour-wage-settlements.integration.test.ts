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
  labourCleanupLogs,
  labourCleanupTombstones,
  labourWageSettlementAdvanceAllocations,
  labourWageSettlementCreateRequests,
  labourDues,
  labourDueMemberSnapshots,
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
  await db.delete(labourCleanupLogs).where(eq(labourCleanupLogs.workspaceId, tenant.workspaceId));
  await db.delete(labourCleanupTombstones).where(eq(labourCleanupTombstones.workspaceId, tenant.workspaceId));
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

test("operational account creation atomically normalizes payment accounts and legacy compatibility is stable-id only", async () => {
  const labourerId = randomUUID();
  await setupRequest("create account-normalization labourer", "POST", "/v1/workspace/operational-records", envelope("labourer", labourerId, {
    name: "Account normalization labourer",
    active: true,
  }));

  const accountIds = {
    cash: randomUUID(),
    bank: randomUUID(),
    partner: randomUUID(),
  } as const;
  for (const [type, id] of Object.entries(accountIds)) {
    const response = await request("POST", "/v1/workspace/operational-records", envelope("account", id, {
      name: `P1 ${type} ${id}`,
      type,
      active: true,
    }));
    assertIntegrationResponse(response, 200, `create ${type} operational account`);
    assert.equal(response.json().record.canonicalAccountId, id);
    const [normalized] = await db.select().from(accounts).where(eq(accounts.id, id));
    assert.equal(normalized?.farmId, tenant.farmId);
    assert.equal(normalized?.accountType, type);
    assert.equal(normalized?.sourceType, "operational_account");

    const advance = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-payments/advances`, {
      farmId: tenant.farmId,
      seasonId: tenant.seasonId,
      idempotencyKey: randomUUID(),
      voucherDate: "2026-02-01",
      recipientScope: "INDIVIDUAL",
      labourerId,
      receivedByLabourerId: labourerId,
      receivedByNameSnapshot: "Account normalization labourer",
      amount: 5,
      paymentAccountId: id,
      paymentMethod: type,
      description: `P1 ${type} advance`,
    });
    assertIntegrationResponse(advance, 201, `${type} UI account funds canonical advance`);
    assert.equal(advance.json().voucher.paymentAccountId, id);
  }

  const dueResponse = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-payments/dues`, {
    farmId: tenant.farmId,
    seasonId: tenant.seasonId,
    idempotencyKey: randomUUID(),
    source: "DIRECT",
    recipientScope: "INDIVIDUAL",
    labourerId,
    description: "P1 account normalization due",
    workFromDate: "2026-02-01",
    workToDate: "2026-02-02",
    agreedGrossAmount: 10,
    authorizedDeductions: 0,
  });
  assertIntegrationResponse(dueResponse, 201, "create account-normalization due");
  const directPayment = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-payments/dues/${dueResponse.json().due.id}/settle`, {
    farmId: tenant.farmId,
    seasonId: tenant.seasonId,
    advanceApplications: [],
    payment: {
      idempotencyKey: randomUUID(),
      voucherDate: "2026-02-02",
      amount: 4,
      paymentAccountId: accountIds.partner,
      paymentMethod: "partner",
    },
  });
  assertIntegrationResponse(directPayment, 200, "partner UI account funds direct due payment");

  const compatibilityId = randomUUID();
  await db.insert(operationalRecords).values({
    workspaceId: tenant.workspaceId,
    farmId: tenant.farmId,
    seasonId: tenant.seasonId,
    clientRecordId: compatibilityId,
    entityType: "account",
    sourceType: "account",
    payload: { id: compatibilityId, name: `Compatibility ${compatibilityId}`, type: "cash", active: true },
    recordedBy: tenant.userId,
    clientUpdatedAt: new Date(now),
  });
  const compatibilityAdvance = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-payments/advances`, {
    farmId: tenant.farmId, seasonId: tenant.seasonId, idempotencyKey: randomUUID(), voucherDate: "2026-02-03",
    recipientScope: "INDIVIDUAL", labourerId, receivedByLabourerId: labourerId,
    receivedByNameSnapshot: "Account normalization labourer", amount: 3,
    paymentAccountId: compatibilityId, paymentMethod: "cash", description: "Compatibility advance",
  });
  assertIntegrationResponse(compatibilityAdvance, 201, "operational-only account normalizes on exact stable-id use");
  assert.equal((await db.select().from(accounts).where(eq(accounts.id, compatibilityId)))[0]?.sourceType, "operational_account_compatibility");

  const conflictingName = `Ambiguous ${randomUUID()}`;
  await db.insert(accounts).values({ farmId: tenant.farmId, name: conflictingName, accountType: "cash", active: true });
  const ambiguousId = randomUUID();
  await db.insert(operationalRecords).values({
    workspaceId: tenant.workspaceId, farmId: tenant.farmId, seasonId: tenant.seasonId,
    clientRecordId: ambiguousId, entityType: "account", sourceType: "account",
    payload: { id: ambiguousId, name: conflictingName, type: "cash", active: true },
    recordedBy: tenant.userId, clientUpdatedAt: new Date(now),
  });
  const ambiguousAdvance = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-payments/advances`, {
    farmId: tenant.farmId, seasonId: tenant.seasonId, idempotencyKey: randomUUID(), voucherDate: "2026-02-04",
    recipientScope: "INDIVIDUAL", labourerId, receivedByLabourerId: labourerId,
    receivedByNameSnapshot: "Account normalization labourer", amount: 2,
    paymentAccountId: ambiguousId, paymentMethod: "cash", description: "Ambiguous account advance",
  });
  assert.equal(ambiguousAdvance.statusCode, 400);
  assert.match(ambiguousAdvance.json().message, /ambiguous/i);
  assert.equal((await db.select().from(accounts).where(eq(accounts.id, ambiguousId))).length, 0);
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

test("voided settlement cleanup preview accepts the canonical record id and tolerates missing optional links", async () => {
  const clientRecordId = randomUUID();
  const [record] = await db.insert(operationalRecords).values({
    workspaceId: tenant.workspaceId, farmId: tenant.farmId, seasonId: tenant.seasonId,
    clientRecordId, entityType: "labourWageSettlement", recordedBy: tenant.userId,
    clientUpdatedAt: new Date(now), payload: settlementPayload({ settlementNumber: "LW-PREVIEW-NULL-SAFE", status: "voided", paidAmount: 0, expenseAmount: 75 }),
  }).returning({ id: operationalRecords.id });
  assert.ok(record?.id);

  const payload = { farmId: tenant.farmId, seasonId: tenant.seasonId, targets: [{ entityType: "SETTLEMENT", id: record!.id }] };
  const preview = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-reconciliation/cleanup/preview`, payload);
  assertIntegrationResponse(preview, 200, "preview null-safe voided settlement cleanup");
  assert.equal(preview.json().preview.targets.length, 1);
  assert.equal(preview.json().preview.targets[0].id, record!.id);
  assert.equal(preview.json().preview.targets[0].recipient, null);
  assert.equal(preview.json().preview.targets[0].linkedDue, null);
  assert.equal(preview.json().preview.targets[0].counts.paymentVouchers, 0);
  assert.equal(preview.json().preview.targets[0].classification, "ELIGIBLE");

  const deleted = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-reconciliation/cleanup/execute`, {
    ...payload, mode: "SOURCE_ONLY", reason: "Integration cleanup verification", confirmation: "DELETE LABOUR DATA",
  });
  assertIntegrationResponse(deleted, 200, "delete eligible voided settlement");
  assert.equal(deleted.json().result.deleted[0].id, clientRecordId);
  assert.equal((await db.select({ id: operationalRecords.id }).from(operationalRecords).where(eq(operationalRecords.id, record!.id))).length, 0);
});

test("canonical advance headline summary is independent of pagination and list filters", async () => {
  const endpoint = `/v1/workspace/${tenant.workspaceId}/labour-payments/advances?farmId=${tenant.farmId}&seasonId=${tenant.seasonId}`;
  const before = await request("GET", `${endpoint}&status=OPEN&page=1&pageSize=1`);
  assertIntegrationResponse(before, 200, "load baseline canonical advance summary");

  const inserted = await db.insert(operationalRecords).values([
    {
      workspaceId: tenant.workspaceId, farmId: tenant.farmId, seasonId: tenant.seasonId,
      clientRecordId: randomUUID(), entityType: "advance", recordedBy: tenant.userId,
      clientUpdatedAt: new Date(now), payload: { amount: 101, date: "2026-06-01", labourerId: randomUUID(), labourerName: "Summary individual", status: "posted" },
    },
    {
      workspaceId: tenant.workspaceId, farmId: tenant.farmId, seasonId: tenant.seasonId,
      clientRecordId: randomUUID(), entityType: "advance", recordedBy: tenant.userId,
      clientUpdatedAt: new Date(now), payload: { amount: 202, date: "2026-06-02", labourerId: randomUUID(), labourerName: "Summary receiver", labourGroupId: randomUUID(), labourGroupName: "Summary group", status: "posted" },
    },
    {
      workspaceId: tenant.workspaceId, farmId: null, seasonId: null,
      clientRecordId: randomUUID(), entityType: "advance", recordedBy: tenant.userId,
      clientUpdatedAt: new Date(now), payload: { amount: 303, date: "2026-06-03", labourerId: randomUUID(), labourerName: "Compatible legacy", status: "posted" },
    },
  ]).returning({ id: operationalRecords.id });

  const page = await request("GET", `${endpoint}&status=OPEN&page=1&pageSize=1`);
  const filtered = await request("GET", `${endpoint}&status=OPEN&page=1&pageSize=1&search=does-not-match-any-advance`);
  assertIntegrationResponse(page, 200, "load paginated canonical advance summary");
  assertIntegrationResponse(filtered, 200, "load filtered canonical advance summary");
  assert.equal(page.json().advances.length, 1);
  assert.equal(filtered.json().advances.length, 0);
  assert.equal(page.json().summary.totalOutstanding, before.json().summary.totalOutstanding + 606);
  assert.equal(page.json().summary.openCount, before.json().summary.openCount + 3);
  assert.deepEqual(filtered.json().summary, page.json().summary);

  await db.delete(operationalRecords).where(inArray(operationalRecords.id, inserted.map((row) => row.id)));
});

test("group due atomically applies snapshot-member advances across controlled insert batches", async () => {
  const groupId = randomUUID();
  const memberId = randomUUID();
  const dueId = randomUUID();
  const dueNumber = `LD-POOL-${Date.now()}`;
  const requestKey = randomUUID();
  await db.insert(labourDues).values({
    id: dueId, workspaceId: tenant.workspaceId, farmId: tenant.farmId, seasonId: tenant.seasonId,
    dueNumber, origin: "SETTLEMENT", settlementBasis: "ATTENDANCE", recipientScope: "LABOUR_GROUP",
    financialScopeKey: `group:${groupId}`, labourGroupId: groupId,
    recipientSnapshot: { groupName: "Pool Group", memberCalculationSnapshot: [{ labourerId: memberId, calculatedAmount: 90 }] },
    description: "Group pool persistence", workFromDate: "2026-04-01", workToDate: "2026-04-30",
    grossAmount: "90.00", idempotencyKey: randomUUID(), createdBy: tenant.userId,
  });
  await db.insert(labourDueMemberSnapshots).values({
    workspaceId: tenant.workspaceId, dueId, labourerId: memberId,
    snapshot: { labourerName: "Pool Member" }, calculatedAmount: "90.00",
  });
  const [advanceAccount] = await db.insert(accounts).values({
    farmId: tenant.farmId, name: "Pool advance cash", accountType: "cash", active: true,
  }).returning({ id: accounts.id });
  assert.ok(advanceAccount?.id);
  const advances = await db.insert(labourPaymentVouchers).values(Array.from({ length: 45 }, (_, index) => ({
    workspaceId: tenant.workspaceId, farmId: tenant.farmId, seasonId: tenant.seasonId,
    voucherNumber: `LAV-POOL-${Date.now()}-${index}`, voucherDate: "2026-03-01", nature: "ADVANCE", status: "POSTED",
    recipientScope: "INDIVIDUAL", financialScopeKey: `individual:${memberId}`, labourerId: memberId,
    recipientSnapshot: { recipientName: "Pool Member" }, description: "Member advance", paymentAmount: "2.00",
    paymentAccountId: advanceAccount!.id, paymentMethod: "CASH",
    sourceType: "LABOUR_ADVANCE", idempotencyKey: randomUUID(), createdBy: tenant.userId, postedBy: tenant.userId, postedAt: new Date(now),
  }))).returning({ id: labourPaymentVouchers.id });
  const vouchersBefore = (await db.select({ id: labourPaymentVouchers.id }).from(labourPaymentVouchers).where(eq(labourPaymentVouchers.workspaceId, tenant.workspaceId))).length;
  const payload = { farmId: tenant.farmId, seasonId: tenant.seasonId, advancePool: { amount: 90, idempotencyKey: requestKey, settlementDate: "2026-05-01" }, advanceApplications: [] };

  const settled = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-payments/dues/${dueId}/settle`, payload);
  assertIntegrationResponse(settled, 200, "apply snapshot-member advance pool");
  assert.equal(settled.json().result.settlementSummary.advanceAmountApplied, 90);
  assert.equal(settled.json().result.settlementSummary.advanceVoucherCount, 45);
  assert.equal(settled.json().result.due.outstandingBalance, 0);
  assert.equal(settled.json().result.due.paymentStatus, "SETTLED_BY_ADVANCE");
  const applications = await db.select().from(labourAdvanceApplications).where(eq(labourAdvanceApplications.dueId, dueId));
  assert.equal(applications.length, 45);
  assert.equal(applications.reduce((sum, row) => sum + Number(row.amount), 0), 90);
  assert.equal((await db.select({ id: labourPaymentVouchers.id }).from(labourPaymentVouchers).where(eq(labourPaymentVouchers.workspaceId, tenant.workspaceId))).length, vouchersBefore);

  const retried = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-payments/dues/${dueId}/settle`, payload);
  assertIntegrationResponse(retried, 200, "retry committed snapshot-member pool");
  assert.equal((await db.select().from(labourAdvanceApplications).where(eq(labourAdvanceApplications.dueId, dueId))).length, 45);
  assert.equal(advances.length, 45);
});

test("individual due applies legacy-scoped advances resolved to the same labourer without creating an LPV", async () => {
  const labourerId = randomUUID();
  const dueId = randomUUID();
  const requestKey = randomUUID();
  await db.insert(labourDues).values({
    id: dueId, workspaceId: tenant.workspaceId, farmId: tenant.farmId, seasonId: tenant.seasonId,
    dueNumber: `LD-LEGACY-IND-${Date.now()}`, origin: "DIRECT", recipientScope: "INDIVIDUAL",
    financialScopeKey: `individual:${labourerId}`, labourerId,
    recipientSnapshot: { labourerId, labourerName: "Saleem Nutkani" },
    description: "Individual legacy advance settlement", workFromDate: "2026-06-01", workToDate: "2026-06-01",
    grossAmount: "7108.00", idempotencyKey: randomUUID(), createdBy: tenant.userId,
  });
  const [advanceAccount] = await db.insert(accounts).values({
    farmId: tenant.farmId, name: `Legacy individual advance cash ${Date.now()}`, accountType: "cash", active: true,
  }).returning({ id: accounts.id });
  assert.ok(advanceAccount?.id);
  await db.insert(labourPaymentVouchers).values([
    {
      workspaceId: tenant.workspaceId, farmId: tenant.farmId, seasonId: tenant.seasonId,
      voucherNumber: `LAV-LEGACY-IND-${Date.now()}-1`, voucherDate: "2026-05-01", nature: "ADVANCE", status: "POSTED",
      recipientScope: "INDIVIDUAL", financialScopeKey: `legacy:${randomUUID()}`, labourerId,
      recipientSnapshot: { labourerId, labourerName: "Saleem Nutkani" }, description: "Legacy Saleem advance", paymentAmount: "5000.00",
      paymentAccountId: advanceAccount!.id, paymentMethod: "CASH", sourceType: "LABOUR_ADVANCE",
      idempotencyKey: randomUUID(), createdBy: tenant.userId, postedBy: tenant.userId, postedAt: new Date(now),
    },
    {
      workspaceId: tenant.workspaceId, farmId: tenant.farmId, seasonId: tenant.seasonId,
      voucherNumber: `LAV-LEGACY-IND-${Date.now()}-2`, voucherDate: "2026-05-02", nature: "ADVANCE", status: "POSTED",
      recipientScope: "INDIVIDUAL", financialScopeKey: `legacy:${randomUUID()}`, labourerId: null,
      recipientSnapshot: { recipientLabourerId: labourerId, recipientName: "Saleem Nutkani" }, description: "Legacy Saleem snapshot advance", paymentAmount: "3000.00",
      paymentAccountId: advanceAccount!.id, paymentMethod: "CASH", sourceType: "LABOUR_ADVANCE",
      idempotencyKey: randomUUID(), createdBy: tenant.userId, postedBy: tenant.userId, postedAt: new Date(now),
    },
    {
      workspaceId: tenant.workspaceId, farmId: tenant.farmId, seasonId: tenant.seasonId,
      voucherNumber: `LAV-LEGACY-IND-${Date.now()}-OTHER`, voucherDate: "2026-05-01", nature: "ADVANCE", status: "POSTED",
      recipientScope: "INDIVIDUAL", financialScopeKey: `individual:${randomUUID()}`, labourerId: randomUUID(),
      recipientSnapshot: { recipientName: "Other labourer" }, description: "Other advance", paymentAmount: "9000.00",
      paymentAccountId: advanceAccount!.id, paymentMethod: "CASH", sourceType: "LABOUR_ADVANCE",
      idempotencyKey: randomUUID(), createdBy: tenant.userId, postedBy: tenant.userId, postedAt: new Date(now),
    },
  ]);
  const pool = await request("GET", `/v1/workspace/${tenant.workspaceId}/labour-payments/dues/${dueId}/advance-pool?farmId=${tenant.farmId}&seasonId=${tenant.seasonId}&settlementDate=2026-07-20`);
  assertIntegrationResponse(pool, 200, "load individual legacy advance pool");
  assert.equal(pool.json().pool.eligibleTotal, 8000);
  assert.equal(pool.json().pool.maximumApplicable, 7108);
  assert.ok(pool.json().pool.exclusionTotals.labourersOutsideDue >= 9000);

  const vouchersBefore = (await db.select({ id: labourPaymentVouchers.id }).from(labourPaymentVouchers).where(eq(labourPaymentVouchers.workspaceId, tenant.workspaceId))).length;
  const settled = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-payments/dues/${dueId}/settle`, {
    farmId: tenant.farmId,
    seasonId: tenant.seasonId,
    advancePool: { amount: 7108, idempotencyKey: requestKey, settlementDate: "2026-07-20" },
    advanceApplications: [],
  });
  assertIntegrationResponse(settled, 200, "apply individual legacy advance pool");
  assert.equal(settled.json().result.settlementSummary.advanceAmountApplied, 7108);
  assert.equal(settled.json().result.settlementSummary.cashPaymentPosted, 0);
  assert.equal(settled.json().result.voucher, null);
  assert.equal(settled.json().result.due.outstandingBalance, 0);
  assert.equal(settled.json().result.due.paymentStatus, "SETTLED_BY_ADVANCE");
  assert.equal((await db.select({ id: labourPaymentVouchers.id }).from(labourPaymentVouchers).where(eq(labourPaymentVouchers.workspaceId, tenant.workspaceId))).length, vouchersBefore);
  const applications = await db.select().from(labourAdvanceApplications).where(eq(labourAdvanceApplications.dueId, dueId));
  assert.equal(applications.length, 2);
  assert.equal(applications.reduce((sum, row) => sum + Number(row.amount), 0), 7108);
  const retried = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-payments/dues/${dueId}/settle`, {
    farmId: tenant.farmId,
    seasonId: tenant.seasonId,
    advancePool: { amount: 7108, idempotencyKey: requestKey, settlementDate: "2026-07-20" },
    advanceApplications: [],
  });
  assertIntegrationResponse(retried, 200, "retry individual legacy advance application");
  assert.equal((await db.select().from(labourAdvanceApplications).where(eq(labourAdvanceApplications.dueId, dueId))).length, 2);
});

test("unused Labour Advance Vouchers can be edited or deleted while used advances are blocked", async () => {
  const labourerId = randomUUID();
  const otherLabourerId = randomUUID();
  const [oldPartner] = await db.insert(accounts).values({
    farmId: tenant.farmId, name: `Old partner ${Date.now()}`, accountType: "partner", active: true,
  }).returning({ id: accounts.id });
  const [newPartner] = await db.insert(accounts).values({
    farmId: tenant.farmId, name: `New partner ${Date.now()}`, accountType: "partner", active: true,
  }).returning({ id: accounts.id });
  assert.ok(oldPartner?.id);
  assert.ok(newPartner?.id);
  await db.insert(operationalRecords).values([
    {
      workspaceId: tenant.workspaceId, farmId: tenant.farmId, seasonId: tenant.seasonId,
      clientRecordId: labourerId, entityType: "labourer", recordedBy: tenant.userId,
      clientUpdatedAt: new Date(now), payload: { id: labourerId, name: "Editable Labourer", status: "ACTIVE" },
    },
    {
      workspaceId: tenant.workspaceId, farmId: tenant.farmId, seasonId: tenant.seasonId,
      clientRecordId: otherLabourerId, entityType: "labourer", recordedBy: tenant.userId,
      clientUpdatedAt: new Date(now), payload: { id: otherLabourerId, name: "Moved Labourer", status: "ACTIVE" },
    },
  ]);
  const createPayload = {
    farmId: tenant.farmId, seasonId: tenant.seasonId, idempotencyKey: randomUUID(), voucherDate: "2026-06-01",
    recipientScope: "INDIVIDUAL", labourerId, receivedByLabourerId: labourerId, receivedByNameSnapshot: "Editable Labourer",
    amount: 100, paymentAccountId: oldPartner!.id, paymentMethod: "Partner", description: "Editable advance",
  };
  const created = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-payments/advances`, createPayload);
  assertIntegrationResponse(created, 201, "create editable LAV");
  const voucher = created.json().voucher;
  const originalId = voucher.id;
  const originalNumber = voucher.voucherNumber;
  const originalMovementId = voucher.accountTransactionId;
  assert.ok(originalMovementId);

  const edited = await request("PATCH", `/v1/workspace/${tenant.workspaceId}/labour-payments/advances/${originalId}`, {
    farmId: tenant.farmId, seasonId: tenant.seasonId, voucherDate: "2026-06-02",
    recipientScope: "INDIVIDUAL", labourerId: otherLabourerId, receivedByLabourerId: otherLabourerId, receivedByNameSnapshot: "Moved Labourer",
    amount: 125, paymentAccountId: newPartner!.id, paymentMethod: "Partner", transactionReference: "EDIT-1", description: "Edited advance",
  });
  assertIntegrationResponse(edited, 200, "edit unused LAV");
  assert.equal(edited.json().voucher.id, originalId);
  assert.equal(edited.json().voucher.voucherNumber, originalNumber);
  assert.equal(Number(edited.json().voucher.paymentAmount), 125);
  assert.equal(edited.json().voucher.paymentAccountId, newPartner!.id);
  assert.equal(edited.json().voucher.labourerId, otherLabourerId);
  assert.notEqual(edited.json().voucher.accountTransactionId, originalMovementId);
  assert.equal((await db.select().from(accountTransactions).where(eq(accountTransactions.id, originalMovementId))).length, 0);
  let journal = await db.select().from(labourAccountingEntries).where(eq(labourAccountingEntries.voucherId, originalId));
  assert.equal(journal.filter((row) => row.ledgerCode === "LABOUR_ADVANCE").reduce((sum, row) => sum + Number(row.debit) - Number(row.credit), 0), 125);
  assert.equal(journal.filter((row) => row.ledgerCode === "PARTNER_PAYABLE").reduce((sum, row) => sum + Number(row.credit) - Number(row.debit), 0), 125);

  const deleted = await request("DELETE", `/v1/workspace/${tenant.workspaceId}/labour-payments/advances/${originalId}?farmId=${tenant.farmId}&seasonId=${tenant.seasonId}`);
  assertIntegrationResponse(deleted, 200, "delete unused LAV");
  assert.equal((await db.select().from(labourPaymentVouchers).where(eq(labourPaymentVouchers.id, originalId))).length, 0);
  assert.equal((await db.select().from(labourAccountingEntries).where(eq(labourAccountingEntries.voucherId, originalId))).length, 0);
  assert.equal((await db.select().from(accountTransactions).where(eq(accountTransactions.referenceId, originalId))).length, 0);

  const dueId = randomUUID();
  await db.insert(labourDues).values({
    id: dueId, workspaceId: tenant.workspaceId, farmId: tenant.farmId, seasonId: tenant.seasonId,
    dueNumber: `LD-USED-ADV-${Date.now()}`, origin: "DIRECT", recipientScope: "INDIVIDUAL",
    financialScopeKey: `individual:${labourerId}`, labourerId, recipientSnapshot: { labourerId, labourerName: "Used Labourer" },
    description: "Used advance blocker", workFromDate: "2026-06-01", workToDate: "2026-06-01",
    grossAmount: "25.00", idempotencyKey: randomUUID(), createdBy: tenant.userId,
  });
  const used = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-payments/advances`, {
    ...createPayload, idempotencyKey: randomUUID(), amount: 25, description: "Used advance",
  });
  assertIntegrationResponse(used, 201, "create used LAV");
  const usedVoucher = used.json().voucher;
  await db.insert(labourAdvanceApplications).values({
    workspaceId: tenant.workspaceId, advanceVoucherId: usedVoucher.id, dueId, amount: "5.00", idempotencyKey: randomUUID(), status: "ACTIVE",
  });
  const blockedEdit = await request("PATCH", `/v1/workspace/${tenant.workspaceId}/labour-payments/advances/${usedVoucher.id}`, {
    ...createPayload, amount: 30, paymentAccountId: newPartner!.id, description: "Blocked edit",
  });
  assert.equal(blockedEdit.statusCode, 409);
  assert.match(blockedEdit.json().message, /already been used/i);
  const blockedDelete = await request("DELETE", `/v1/workspace/${tenant.workspaceId}/labour-payments/advances/${usedVoucher.id}?farmId=${tenant.farmId}&seasonId=${tenant.seasonId}`);
  assert.equal(blockedDelete.statusCode, 409);
  assert.match(blockedDelete.json().message, /cannot be deleted/i);
  assert.equal((await db.select().from(labourPaymentVouchers).where(eq(labourPaymentVouchers.id, usedVoucher.id))).length, 1);
});

test("cash, bank, and partner LPVs reconcile funding, payable, retry, and reversal atomically", async () => {
  const cases = [
    { accountType: "cash", transactionType: "debit", ledgerCode: "CASH_CONTROL" },
    { accountType: "bank", transactionType: "debit", ledgerCode: "CASH_CONTROL" },
    { accountType: "partner", transactionType: "credit", ledgerCode: "PARTNER_PAYABLE" },
  ] as const;
  for (const [index, funding] of cases.entries()) {
    const dueId = randomUUID();
    const paymentKey = randomUUID();
    const [account] = await db.insert(accounts).values({
      farmId: tenant.farmId, name: `LPV ${funding.accountType} ${Date.now()} ${index}`,
      accountType: funding.accountType, active: true,
    }).returning({ id: accounts.id });
    assert.ok(account?.id);
    await db.insert(labourDues).values({
      id: dueId, workspaceId: tenant.workspaceId, farmId: tenant.farmId, seasonId: tenant.seasonId,
      dueNumber: `LD-FUND-${Date.now()}-${index}`, origin: "DIRECT", recipientScope: "NO_SPECIFIC_RECIPIENT",
      financialScopeKey: `batch:funding-${index}-${Date.now()}`, crewReference: `Funding crew ${index}`,
      recipientSnapshot: { recipientReference: `Funding crew ${index}` }, description: "Funding-source reconciliation",
      workFromDate: "2026-06-01", workToDate: "2026-06-01", grossAmount: "30.00",
      idempotencyKey: randomUUID(), createdBy: tenant.userId,
    });
    const payload = {
      farmId: tenant.farmId, seasonId: tenant.seasonId, advanceApplications: [],
      payment: { idempotencyKey: paymentKey, voucherDate: "2026-06-02", amount: 30, paymentAccountId: account!.id, paymentMethod: "TRANSFER" },
    };
    const paid = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-payments/dues/${dueId}/settle`, payload);
    assertIntegrationResponse(paid, 200, `pay due from ${funding.accountType}`);
    const voucher = paid.json().result.voucher;
    assert.equal(voucher.paymentAmount, "30.00");
    assert.equal(voucher.linkedDueId, dueId);
    assert.ok(voucher.accountTransactionId);
    assert.equal(paid.json().result.due.outstandingBalance, 0);
    const [movement] = await db.select().from(accountTransactions).where(eq(accountTransactions.id, voucher.accountTransactionId));
    assert.equal(movement?.accountId, account!.id);
    assert.equal(movement?.referenceId, voucher.id);
    assert.equal(movement?.type, funding.transactionType);
    assert.equal(Number(movement?.amount), 30);
    const journal = await db.select().from(labourAccountingEntries).where(eq(labourAccountingEntries.voucherId, voucher.id));
    assert.equal(journal.filter((row) => row.ledgerCode === "LABOUR_PAYABLE").reduce((sum, row) => sum + Number(row.debit) - Number(row.credit), 0), 30);
    assert.equal(journal.filter((row) => row.ledgerCode === funding.ledgerCode).reduce((sum, row) => sum + Number(row.credit) - Number(row.debit), 0), 30);
    assert.equal(journal.some((row) => row.ledgerCode === "LABOUR_EXPENSE"), false);

    const retried = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-payments/dues/${dueId}/settle`, payload);
    assertIntegrationResponse(retried, 200, `retry ${funding.accountType} payment`);
    assert.equal((await db.select().from(labourPaymentVouchers).where(eq(labourPaymentVouchers.idempotencyKey, paymentKey))).length, 1);
    assert.equal((await db.select().from(accountTransactions).where(eq(accountTransactions.referenceId, voucher.id))).length, 1);

    if (funding.accountType === "cash") {
      const reversed = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-payments/vouchers/${voucher.id}/void?farmId=${tenant.farmId}&seasonId=${tenant.seasonId}`, {
        idempotencyKey: randomUUID(), reason: "Funding reconciliation reversal",
      });
      assertIntegrationResponse(reversed, 200, "reverse cash-funded LPV");
      const reversal = reversed.json().result.reversal;
      const [reverseMovement] = await db.select().from(accountTransactions).where(eq(accountTransactions.id, reversal.accountTransactionId));
      assert.equal(reverseMovement?.accountId, account!.id);
      assert.equal(reverseMovement?.type, "credit");
      assert.equal(Number(reverseMovement?.amount), 30);
      const [restoredDue] = await db.select().from(labourDues).where(eq(labourDues.id, dueId));
      assert.equal(restoredDue?.paymentStatus, "UNPAID");
    }
  }
});

test("layered labour reversals are exact, idempotent, concurrent-safe, and return every ledger to zero", async () => {
  const labourerId = randomUUID();
  const partnerName = `Layered reversal partner ${Date.now()}`;
  const [partner] = await db.insert(accounts).values({
    farmId: tenant.farmId, name: partnerName, accountType: "partner", active: true,
  }).returning({ id: accounts.id });
  assert.ok(partner?.id);
  await db.insert(operationalRecords).values({
    workspaceId: tenant.workspaceId, farmId: tenant.farmId, seasonId: tenant.seasonId,
    clientRecordId: labourerId, entityType: "labourer", recordedBy: tenant.userId,
    clientUpdatedAt: new Date(now), payload: { id: labourerId, name: "Layered reversal labourer", status: "ACTIVE", active: true },
  });
  const baselineReconciliation = await request("GET", `/v1/workspace/${tenant.workspaceId}/labour-payments/reconciliation?farmId=${tenant.farmId}&seasonId=${tenant.seasonId}`);
  assertIntegrationResponse(baselineReconciliation, 200, "load layered fixture reconciliation baseline");
  const baselineReconciliationResult = baselineReconciliation.json().reconciliation;
  const baselineOutstandingPayables = baselineReconciliationResult.outstandingPayables;
  const baselineFailures = Object.fromEntries(
    baselineReconciliationResult.checks.map((check: { name: string; failureCount: number }) => [check.name, check.failureCount]),
  );
  const advanceResponse = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-payments/advances`, {
    farmId: tenant.farmId, seasonId: tenant.seasonId, idempotencyKey: randomUUID(), voucherDate: "2026-07-01",
    recipientScope: "INDIVIDUAL", labourerId, receivedByLabourerId: labourerId,
    receivedByNameSnapshot: "Layered reversal labourer", amount: 40, paymentAccountId: partner!.id,
    paymentMethod: "Partner", description: "Layered reversal advance",
  });
  assertIntegrationResponse(advanceResponse, 201, "create layered reversal advance");
  const advance = advanceResponse.json().voucher;
  const dueResponse = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-payments/dues`, {
    farmId: tenant.farmId, seasonId: tenant.seasonId, idempotencyKey: randomUUID(), source: "DIRECT",
    recipientScope: "INDIVIDUAL", labourerId, description: "Layered reversal due",
    workFromDate: "2026-07-01", workToDate: "2026-07-05", agreedGrossAmount: 100, authorizedDeductions: 0,
  });
  assertIntegrationResponse(dueResponse, 201, "create layered reversal due");
  const due = dueResponse.json().due;
  const settlementKey = randomUUID();
  const paymentKey = randomUUID();
  const settled = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-payments/dues/${due.id}/settle`, {
    farmId: tenant.farmId, seasonId: tenant.seasonId,
    advancePool: { amount: 30, idempotencyKey: settlementKey, settlementDate: "2026-07-06" },
    advanceApplications: [],
    payment: { idempotencyKey: paymentKey, voucherDate: "2026-07-06", amount: 50, paymentAccountId: partner!.id, paymentMethod: "Partner" },
  });
  assertIntegrationResponse(settled, 200, "post layered mixed settlement");
  assert.equal(settled.json().result.due.outstandingBalance, 20);
  const payment = settled.json().result.voucher;
  const [application] = await db.select().from(labourAdvanceApplications).where(and(
    eq(labourAdvanceApplications.dueId, due.id), eq(labourAdvanceApplications.advanceVoucherId, advance.id),
  ));
  assert.ok(application);
  const postedReadModel = await request("GET", `/v1/workspace/${tenant.workspaceId}/labour-payments/financial-read-model?farmId=${tenant.farmId}&seasonId=${tenant.seasonId}`);
  assertIntegrationResponse(postedReadModel, 200, "load posted canonical labour financial model");
  const postedFinancials = postedReadModel.json().financials;
  assert.equal(postedFinancials.labourLedger.filter((row: { dueId?: string }) => row.dueId === due.id).reduce((sum: number, row: { labourDueEffect: number }) => sum + row.labourDueEffect, 0), 20);
  assert.equal(postedFinancials.advancePositions.find((row: { voucherId: string }) => row.voucherId === advance.id)?.outstandingAmount, 10);
  assert.equal(postedFinancials.expenses.filter((row: { dueId?: string }) => row.dueId === due.id).reduce((sum: number, row: { amount: number }) => sum + row.amount, 0), 100);
  const postedPartnerPosition = postedFinancials.partnerPositions.find((row: { accountId: string }) => row.accountId === partner!.id);
  assert.equal(postedPartnerPosition?.farmOwesPartner, 90);
  assert.equal(postedPartnerPosition?.farmOwesPartner, postedPartnerPosition?.ledgerBalance);
  assert.equal(postedPartnerPosition?.labourAdvancesPaid, 40);
  assert.equal(postedPartnerPosition?.directLabourPayments, 50);
  assert.equal(postedPartnerPosition?.outstandingLabourAdvances, 10);
  assert.equal(postedPartnerPosition?.appliedLabourAdvances, 30);
  const postedAdvancePosition = postedFinancials.advancePositions.find((row: { voucherId: string }) => row.voucherId === advance.id);
  assert.deepEqual({
    voucherNumber: postedAdvancePosition?.voucherNumber,
    original: postedAdvancePosition?.originalAmount,
    applied: postedAdvancePosition?.appliedAmount,
    recovered: postedAdvancePosition?.recoveredAmount,
    outstanding: postedAdvancePosition?.outstandingAmount,
    accountName: postedAdvancePosition?.accountName,
    canonical: postedAdvancePosition?.canonical,
  }, {
    voucherNumber: advance.voucherNumber,
    original: 40,
    applied: 30,
    recovered: 0,
    outstanding: 10,
    accountName: partnerName,
    canonical: true,
  });
  assert.equal(postedFinancials.accountEntries.filter((row: { voucherId: string }) => row.voucherId === advance.id || row.voucherId === payment.id).reduce((sum: number, row: { balanceEffect: number }) => sum + row.balanceEffect, 0), 90);
  assert.ok(postedFinancials.labourLedger.some((row: { advanceApplicationId?: string }) => row.advanceApplicationId === application!.id));
  assert.ok(postedFinancials.activity.some((row: { sourceId?: string }) => row.sourceId === payment.id));

  const [firstPaymentVoid, concurrentPaymentVoid] = await Promise.all([
    request("POST", `/v1/workspace/${tenant.workspaceId}/labour-payments/vouchers/${payment.id}/void?farmId=${tenant.farmId}&seasonId=${tenant.seasonId}`, { idempotencyKey: randomUUID(), reason: "Layered payment reversal" }),
    request("POST", `/v1/workspace/${tenant.workspaceId}/labour-payments/vouchers/${payment.id}/void?farmId=${tenant.farmId}&seasonId=${tenant.seasonId}`, { idempotencyKey: randomUUID(), reason: "Concurrent layered payment reversal" }),
  ]);
  assertIntegrationResponse(firstPaymentVoid, 200, "first concurrent payment reversal");
  assertIntegrationResponse(concurrentPaymentVoid, 200, "second concurrent payment reversal");
  assert.equal((await db.select().from(labourPaymentVouchers).where(and(eq(labourPaymentVouchers.reversalReference, payment.id), eq(labourPaymentVouchers.nature, "REVERSAL")))).length, 1);
  const paymentReversedModel = await request("GET", `/v1/workspace/${tenant.workspaceId}/labour-payments/financial-read-model?farmId=${tenant.farmId}&seasonId=${tenant.seasonId}`);
  assertIntegrationResponse(paymentReversedModel, 200, "load payment-reversed financial model");
  const paymentReversedFinancials = paymentReversedModel.json().financials;
  const paymentReversedLedger = paymentReversedFinancials.labourLedger.filter((row: { dueId?: string; voucherId?: string; advanceApplicationId?: string }) => row.dueId === due.id || row.voucherId === advance.id || row.voucherId === payment.id || row.advanceApplicationId === application!.id);
  assert.equal(paymentReversedLedger.reduce((sum: number, row: { labourDueEffect: number }) => sum + row.labourDueEffect, 0), 70);
  assert.equal(paymentReversedLedger.reduce((sum: number, row: { labourAdvanceEffect: number }) => sum + row.labourAdvanceEffect, 0), 10);
  assert.equal(paymentReversedLedger.reduce((sum: number, row: { expenseEffect: number }) => sum + row.expenseEffect, 0), 100);
  assert.equal(paymentReversedFinancials.advancePositions.find((row: { voucherId: string }) => row.voucherId === advance.id)?.outstandingAmount, 10);
  assert.equal(paymentReversedFinancials.partnerPositions.find((row: { accountId: string }) => row.accountId === partner!.id)?.farmOwesPartner, 40);
  assert.equal(paymentReversedFinancials.partnerPositions.find((row: { accountId: string }) => row.accountId === partner!.id)?.directLabourPayments, 0);

  const applicationVoidKey = randomUUID();
  const applicationUrl = `/v1/workspace/${tenant.workspaceId}/labour-payments/dues/${due.id}/advance-applications/${application!.id}/reverse?farmId=${tenant.farmId}&seasonId=${tenant.seasonId}`;
  assertIntegrationResponse(await request("POST", applicationUrl, { idempotencyKey: applicationVoidKey, reason: "Layered application reversal" }), 200, "reverse layered application");
  assertIntegrationResponse(await request("POST", applicationUrl, { idempotencyKey: applicationVoidKey, reason: "Retry layered application reversal" }), 200, "retry layered application reversal");
  const applicationReversedModel = await request("GET", `/v1/workspace/${tenant.workspaceId}/labour-payments/financial-read-model?farmId=${tenant.farmId}&seasonId=${tenant.seasonId}`);
  assertIntegrationResponse(applicationReversedModel, 200, "load application-reversed financial model");
  const applicationReversedFinancials = applicationReversedModel.json().financials;
  const applicationReversedLedger = applicationReversedFinancials.labourLedger.filter((row: { dueId?: string; voucherId?: string; advanceApplicationId?: string }) => row.dueId === due.id || row.voucherId === advance.id || row.voucherId === payment.id || row.advanceApplicationId === application!.id);
  assert.equal(applicationReversedLedger.reduce((sum: number, row: { labourDueEffect: number }) => sum + row.labourDueEffect, 0), 100);
  assert.equal(applicationReversedLedger.reduce((sum: number, row: { labourAdvanceEffect: number }) => sum + row.labourAdvanceEffect, 0), 40);
  assert.equal(applicationReversedLedger.reduce((sum: number, row: { expenseEffect: number }) => sum + row.expenseEffect, 0), 100);
  assert.equal(applicationReversedFinancials.advancePositions.find((row: { voucherId: string }) => row.voucherId === advance.id)?.outstandingAmount, 40);
  assert.equal(applicationReversedFinancials.partnerPositions.find((row: { accountId: string }) => row.accountId === partner!.id)?.farmOwesPartner, 40);
  assert.equal(applicationReversedFinancials.partnerPositions.find((row: { accountId: string }) => row.accountId === partner!.id)?.outstandingLabourAdvances, 40);

  const advanceVoidUrl = `/v1/workspace/${tenant.workspaceId}/labour-payments/vouchers/${advance.id}/void?farmId=${tenant.farmId}&seasonId=${tenant.seasonId}`;
  assertIntegrationResponse(await request("POST", advanceVoidUrl, { idempotencyKey: randomUUID(), reason: "Layered advance reversal" }), 200, "void layered advance");
  assertIntegrationResponse(await request("POST", advanceVoidUrl, { idempotencyKey: randomUUID(), reason: "Retry layered advance reversal" }), 200, "retry layered advance void");
  const advanceReversedModel = await request("GET", `/v1/workspace/${tenant.workspaceId}/labour-payments/financial-read-model?farmId=${tenant.farmId}&seasonId=${tenant.seasonId}`);
  assertIntegrationResponse(advanceReversedModel, 200, "load advance-reversed financial model");
  const advanceReversedFinancials = advanceReversedModel.json().financials;
  const advanceReversedLedger = advanceReversedFinancials.labourLedger.filter((row: { dueId?: string; voucherId?: string; advanceApplicationId?: string }) => row.dueId === due.id || row.voucherId === advance.id || row.voucherId === payment.id || row.advanceApplicationId === application!.id);
  assert.equal(advanceReversedLedger.reduce((sum: number, row: { labourDueEffect: number }) => sum + row.labourDueEffect, 0), 100);
  assert.equal(advanceReversedLedger.reduce((sum: number, row: { labourAdvanceEffect: number }) => sum + row.labourAdvanceEffect, 0), 0);
  assert.equal(advanceReversedLedger.reduce((sum: number, row: { expenseEffect: number }) => sum + row.expenseEffect, 0), 100);
  assert.equal(advanceReversedFinancials.advancePositions.find((row: { voucherId: string }) => row.voucherId === advance.id)?.outstandingAmount, 0);
  assert.equal(advanceReversedFinancials.partnerPositions.find((row: { accountId: string }) => row.accountId === partner!.id)?.farmOwesPartner, 0);
  assert.equal(advanceReversedFinancials.partnerPositions.find((row: { accountId: string }) => row.accountId === partner!.id)?.labourAdvancesPaid, 0);
  const dueVoidUrl = `/v1/workspace/${tenant.workspaceId}/labour-payments/dues/${due.id}/void?farmId=${tenant.farmId}&seasonId=${tenant.seasonId}`;
  assertIntegrationResponse(await request("POST", dueVoidUrl, { idempotencyKey: randomUUID(), reason: "Layered due reversal" }), 200, "void layered due");
  assertIntegrationResponse(await request("POST", dueVoidUrl, { idempotencyKey: randomUUID(), reason: "Retry layered due reversal" }), 200, "retry layered due void");

  const relevantJournal = (await db.select().from(labourAccountingEntries).where(eq(labourAccountingEntries.workspaceId, tenant.workspaceId))).filter((row) =>
    row.dueId === due.id || row.voucherId === advance.id || row.voucherId === payment.id || row.advanceApplicationId === application!.id,
  );
  const currentByLedger = new Map<string, number>();
  for (const row of relevantJournal) currentByLedger.set(row.ledgerCode, (currentByLedger.get(row.ledgerCode) ?? 0) + Number(row.debit) - Number(row.credit));
  assert.deepEqual(Object.fromEntries([...currentByLedger].sort()), {
    LABOUR_ADVANCE: 0, LABOUR_EXPENSE: 0, LABOUR_PAYABLE: 0, PARTNER_PAYABLE: 0,
  });
  const reversals = relevantJournal.filter((row) => row.reversalOf);
  assert.equal(reversals.length, 8);
  assert.equal(new Set(reversals.map((row) => row.reversalOf)).size, 8);
  assert.equal(reversals.some((row) => relevantJournal.find((candidate) => candidate.id === row.reversalOf)?.reversalOf), false);
  for (const reversal of reversals) {
    const original = relevantJournal.find((row) => row.id === reversal.reversalOf);
    assert.ok(original);
    assert.equal(reversal.ledgerCode, original.ledgerCode);
    assert.equal(Number(reversal.debit), Number(original.credit));
    assert.equal(Number(reversal.credit), Number(original.debit));
    assert.equal(reversal.workspaceId, original.workspaceId);
    assert.equal(reversal.farmId, original.farmId);
    assert.equal(reversal.seasonId, original.seasonId);
    assert.equal(reversal.dueId, original.dueId);
    assert.equal(reversal.voucherId, original.voucherId);
    assert.equal(reversal.advanceApplicationId, original.advanceApplicationId);
  }
  const reversedReadModel = await request("GET", `/v1/workspace/${tenant.workspaceId}/labour-payments/financial-read-model?farmId=${tenant.farmId}&seasonId=${tenant.seasonId}`);
  assertIntegrationResponse(reversedReadModel, 200, "load fully reversed canonical labour financial model");
  const reversedFinancials = reversedReadModel.json().financials;
  const reversedScenarioLedger = reversedFinancials.labourLedger.filter((row: { dueId?: string; voucherId?: string; advanceApplicationId?: string }) => row.dueId === due.id || row.voucherId === advance.id || row.voucherId === payment.id || row.advanceApplicationId === application!.id);
  assert.equal(reversedScenarioLedger.reduce((sum: number, row: { labourDueEffect: number }) => sum + row.labourDueEffect, 0), 0);
  assert.equal(reversedScenarioLedger.reduce((sum: number, row: { labourAdvanceEffect: number }) => sum + row.labourAdvanceEffect, 0), 0);
  assert.equal(reversedScenarioLedger.reduce((sum: number, row: { expenseEffect: number }) => sum + row.expenseEffect, 0), 0);
  assert.equal(reversedFinancials.advancePositions.find((row: { voucherId: string }) => row.voucherId === advance.id)?.outstandingAmount, 0);
  assert.equal(reversedFinancials.accountEntries.filter((row: { voucherId: string; reversalReference?: string }) => row.voucherId === advance.id || row.voucherId === payment.id || row.reversalReference === advance.id || row.reversalReference === payment.id).reduce((sum: number, row: { balanceEffect: number }) => sum + row.balanceEffect, 0), 0);
  assert.equal(reversedFinancials.expenses.filter((row: { dueId?: string }) => row.dueId === due.id).reduce((sum: number, row: { amount: number }) => sum + row.amount, 0), 0);
  assert.ok(reversedFinancials.activity.some((row: { title: string }) => row.title.startsWith("Reversed")));

  const fullyReversedReconciliation = await request("GET", `/v1/workspace/${tenant.workspaceId}/labour-payments/reconciliation?farmId=${tenant.farmId}&seasonId=${tenant.seasonId}`);
  assertIntegrationResponse(fullyReversedReconciliation, 200, "reconcile fully reversed layered fixture");
  const fullyReversedReconciliationResult = fullyReversedReconciliation.json().reconciliation;
  assert.equal(fullyReversedReconciliationResult.outstandingPayables, baselineOutstandingPayables);
  assert.deepEqual(
    Object.fromEntries(fullyReversedReconciliationResult.checks.map((check: { name: string; failureCount: number }) => [check.name, check.failureCount])),
    baselineFailures,
  );
  assert.equal(
    fullyReversedReconciliationResult.reconciled,
    baselineReconciliationResult.reconciled,
    JSON.stringify(fullyReversedReconciliationResult.checks.filter((check: { passed: boolean }) => !check.passed)),
  );

  const paymentReversals = reversals.filter((row) => row.voucherId === payment.id);
  assert.equal(paymentReversals.length, 2);
  await db.insert(labourAccountingEntries).values(paymentReversals.map((row) => ({
    workspaceId: row.workspaceId, farmId: row.farmId, seasonId: row.seasonId,
    entryKey: `intentional-false-positive:${randomUUID()}`, eventType: "REVERSAL", ledgerCode: row.ledgerCode,
    dueId: row.dueId, voucherId: row.voucherId, advanceApplicationId: row.advanceApplicationId,
    debit: row.credit, credit: row.debit, status: "POSTED", reversalOf: row.id,
    postedBy: tenant.userId, postedAt: new Date(now),
  })));
  const corruptedReconciliation = await request("GET", `/v1/workspace/${tenant.workspaceId}/labour-payments/reconciliation?farmId=${tenant.farmId}&seasonId=${tenant.seasonId}`);
  assertIntegrationResponse(corruptedReconciliation, 200, "reconcile intentionally balanced reversal-of-reversal fixture");
  assert.equal(corruptedReconciliation.json().reconciliation.journal.difference, 0);
  assert.equal(corruptedReconciliation.json().reconciliation.reconciled, false);
  assert.equal(corruptedReconciliation.json().reconciliation.checks.find((check: { name: string }) => check.name === "reversal-integrity")?.passed, false);
  assert.ok(corruptedReconciliation.json().reconciliation.failures.some((failure: { detail?: string }) => /reversal-of-reversal/i.test(failure.detail ?? "")));
});
