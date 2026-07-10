import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { closeDatabaseConnection, db } from "../src/db/client.js";
import {
  accountTransactions,
  accounts,
  farms,
  labourWageSettlementAdvanceAllocations,
  operationalRecords,
  seasons,
  userSessions,
  users,
  workspaceMemberships,
  workspaces,
} from "../src/db/schema.js";
import { normalizeLabourEarningPayload } from "../src/lib/labour-earnings.js";
import { normalizeSettlementPayload } from "../src/lib/labour-wage-settlements.js";

const now = new Date().toISOString();
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
  await db.delete(labourWageSettlementAdvanceAllocations).where(inArray(labourWageSettlementAdvanceAllocations.workspaceId, ids));
  await db.delete(accountTransactions).where(inArray(accountTransactions.farmId, [tenant.farmId]));
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
  const earningId = randomUUID();
  const advanceId = randomUUID();
  const clientRequestId = randomUUID();

  const [paymentAccount] = await db.insert(accounts).values({
    farmId: tenant.farmId,
    name: "Settlement Cash Account",
    accountType: "cash",
    active: true,
  }).returning({ id: accounts.id });
  assert.ok(paymentAccount?.id);

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
  assert.equal((await request("POST", "/v1/workspace/operational-records", envelope("labourEarning", earningId, {
    labourerId,
    earningDate: "2026-04-12",
    amount: 50,
    earningType: "bonus",
    description: "Bonus",
    status: "pending_settlement",
  }))).statusCode, 200);
  assert.equal((await request("POST", "/v1/workspace/operational-records", envelope("advance", advanceId, {
    labourerId,
    labourGroupId,
    labourGroupName: "Settlement Group",
    date: "2026-04-10",
    amount: 120,
    accountId: paymentAccount.id,
    sourceAccountName: "Settlement Cash Account",
  }))).statusCode, 200);

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
  assert.equal(preview.advanceAdjustedNow, 120);
  assert.equal(preview.availableAdvanceBalanceBeforeSettlement, 120);
  assert.equal(preview.legacyUnallocatedPreviouslySettledAdvances ?? 0, 0);

  const createPayload = {
    farmId: tenant.farmId,
    seasonId: tenant.seasonId,
    fromDate: "2026-04-11",
    toDate: "2026-04-30",
    settlementDate: "2026-05-01",
    settlementMode: "group",
    groupId: labourGroupId,
    paymentAccountId: paymentAccount.id,
    paidAmount: 0,
    manualAdjustment: 0,
    clientRequestId,
  };
  const createResponse = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-wage-settlements`, createPayload);
  assert.equal(createResponse.statusCode, 200);
  const createdSettlement = createResponse.json().settlement;
  assert.equal(createdSettlement.foremanId, labourerId);

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

  const allocationRows = await db.select().from(labourWageSettlementAdvanceAllocations).where(eq(labourWageSettlementAdvanceAllocations.settlementRecordId, settlementRow!.id));
  assert.equal(allocationRows.length, 1);
  assert.equal(allocationRows[0]!.settlementRecordId, settlementRow!.id);

  const [advanceRow] = await db.select({
    id: operationalRecords.id,
  }).from(operationalRecords).where(and(
    eq(operationalRecords.workspaceId, tenant.workspaceId),
    eq(operationalRecords.entityType, "advance"),
    eq(operationalRecords.clientRecordId, advanceId),
  )).limit(1);
  assert.ok(advanceRow);
  assert.equal(allocationRows[0]!.advanceRecordId, advanceRow!.id);
  assert.equal(Number(allocationRows[0]!.absorbedAmount), 120);

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
  assert.equal(accountEntriesAfterCreate.length, 1);

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
  assert.equal(accountEntriesAfterVoid.length, 2);

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
  assert.equal(previewAfterVoid.availableAdvanceBalanceBeforeSettlement, 120);
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
    clientUpdatedAt: now,
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
  assert.ok(account?.id);

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
    clientUpdatedAt: now,
  });

  await db.insert(accountTransactions).values({
    farmId: tenant.farmId,
    seasonId: tenant.seasonId,
    accountId: account.id,
    source: "settlement",
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
