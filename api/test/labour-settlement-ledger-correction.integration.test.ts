import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { closeDatabaseConnection, db, pool } from "../src/db/client.js";
import {
  accounts,
  accountTransactions,
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

// Regression coverage for: (1) the canonical rule that a labour due
// recognizes its full expense at creation, not at settlement; (2) the
// generic, idempotent repair migration (database/migrations/
// 0043_labour_settlement_expense_ledger_correction.sql) for historical
// settlement journals misclassified by the since-reverted commit 018f84d5;
// (3) pooled (advanceVoucherId null) applications being correctly counted
// as active, applied, and non-cash rather than "unresolved" or invisible.

const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl ? false : "DATABASE_URL is not configured";

const now = new Date("2026-07-01T00:00:00.000Z").toISOString();
const tenant = {
  workspaceId: randomUUID(),
  farmId: randomUUID(),
  seasonId: randomUUID(),
  userId: randomUUID(),
  token: `ledger-correction-${randomUUID()}`,
};
let app: Awaited<ReturnType<typeof buildApp>>;
let labourerId: string;
let groupId: string;
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

async function fetchFinancials() {
  const response = await request(
    "GET",
    `/v1/workspace/${tenant.workspaceId}/labour-payments/financial-read-model?farmId=${tenant.farmId}&seasonId=${tenant.seasonId}`,
  );
  assertIntegrationResponse(response, 200, "fetch canonical financials");
  return response.json().financials as {
    expenses: Array<{ dueId: string; amount: number; outstandingAmount: number; active: boolean }>;
    advanceApplicationParents: Array<{ dueId: string; status: string; activeAmount: number; description: string }>;
    expenseAccountAttributions: Array<{ dueId: string; accountName: string; amount: number }>;
    summary: { outstandingAdvance: number; totalAdvance: number; activeAdvanceApplied: number };
  };
}

async function createAdvance(amount: number, voucherDate: string) {
  const response = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-payments/advances`, {
    farmId: tenant.farmId, seasonId: tenant.seasonId, idempotencyKey: randomUUID(), voucherDate,
    recipientScope: "INDIVIDUAL", labourerId, receivedByLabourerId: labourerId,
    receivedByNameSnapshot: "Ledger Correction Worker", amount, paymentAccountId, paymentMethod: "cash",
    description: `Ledger correction advance ${amount}`,
  });
  assertIntegrationResponse(response, 201, `create advance ${amount}`);
  return response.json().voucher as { id: string; paymentAmount: string };
}

async function createDue(grossAmount: number, workFromDate: string, workToDate: string) {
  const response = await request("POST", `/v1/workspace/${tenant.workspaceId}/labour-payments/dues`, {
    farmId: tenant.farmId, seasonId: tenant.seasonId, idempotencyKey: randomUUID(), source: "DIRECT",
    recipientScope: "LABOUR_GROUP", labourGroupId: groupId, description: "Ledger correction due",
    workFromDate, workToDate, agreedGrossAmount: grossAmount, authorizedDeductions: 0,
  });
  assertIntegrationResponse(response, 201, `create due ${grossAmount}`);
  return response.json().due as { id: string; dueNumber: string };
}

async function settlePool(dueId: string, amount: number) {
  return request("POST", `/v1/workspace/${tenant.workspaceId}/labour-payments/dues/${dueId}/settle`, {
    farmId: tenant.farmId, seasonId: tenant.seasonId,
    advancePool: { amount, idempotencyKey: randomUUID(), settlementDate: "2026-07-15" },
  });
}

async function repairMigrationSource() {
  return readFile(new URL("../../database/migrations/0043_labour_settlement_expense_ledger_correction.sql", import.meta.url), "utf8");
}

/** Runs the repair migration's raw SQL directly (bypassing the once-only migration-journal gate), so its own idempotent guards can be exercised repeatedly in a test. */
async function runRepairMigration() {
  const sqlText = await repairMigrationSource();
  await pool.query(sqlText);
}

before(async () => {
  if (!databaseUrl) return;
  await db.insert(workspaces).values({ id: tenant.workspaceId, name: "Ledger Correction Workspace", slug: `ledger-correction-${tenant.workspaceId}`, contactEmail: "ledger-correction@example.test", status: "approved" });
  await db.insert(users).values({ id: tenant.userId, email: `ledger-correction-${tenant.userId}@example.test`, passwordHash: "test", status: "approved" });
  await db.insert(workspaceMemberships).values({ workspaceId: tenant.workspaceId, userId: tenant.userId, role: "workspace_owner" });
  await db.insert(farms).values({ id: tenant.farmId, workspaceId: tenant.workspaceId, name: "Ledger Correction Farm" });
  await db.insert(seasons).values({ id: tenant.seasonId, workspaceId: tenant.workspaceId, farmId: tenant.farmId, name: "Ledger Correction Season", year: 2026, startsOn: "2026-01-01", status: "active" });
  await db.insert(userSessions).values({ userId: tenant.userId, workspaceId: tenant.workspaceId, activeFarmId: tenant.farmId, activeSeasonId: tenant.seasonId, tokenHash: hash(tenant.token), expiresAt: new Date(Date.now() + 900_000) });
  app = await buildApp();
  // Advances only exist inside a labour group's aggregate pool, so the
  // worker leads their own group and dues are group dues drawing on it.
  labourerId = randomUUID();
  groupId = randomUUID();
  await setupRequest("create labourer", "POST", "/v1/workspace/operational-records", envelope("labourer", labourerId, { name: "Ledger Correction Worker", active: true, groupId }));
  await setupRequest("create labour group", "POST", "/v1/workspace/operational-records", envelope("labourGroup", groupId, { name: "Ledger Correction Group", active: true, foremanLabourId: labourerId }));
  const [account] = await db.insert(accounts).values({ farmId: tenant.farmId, name: "Ledger Correction Cash Account", accountType: "cash", active: true }).returning({ id: accounts.id });
  assertPersistedUuid(account?.id, "create payment account");
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
  await db.delete(auditLogs).where(eq(auditLogs.workspaceId, tenant.workspaceId));
  await db.delete(operationalRecords).where(eq(operationalRecords.workspaceId, tenant.workspaceId));
  await db.delete(userSessions).where(eq(userSessions.userId, tenant.userId));
  await db.delete(accountTransactions).where(eq(accountTransactions.farmId, tenant.farmId));
  await db.delete(accounts).where(eq(accounts.farmId, tenant.farmId));
  await db.delete(seasons).where(eq(seasons.workspaceId, tenant.workspaceId));
  await db.delete(farms).where(eq(farms.workspaceId, tenant.workspaceId));
  await db.delete(workspaceMemberships).where(eq(workspaceMemberships.workspaceId, tenant.workspaceId));
  await db.update(users).set({ workspaceId: null }).where(eq(users.id, tenant.userId));
  await db.delete(users).where(eq(users.id, tenant.userId));
  await db.delete(workspaces).where(eq(workspaces.id, tenant.workspaceId));
  await closeDatabaseConnection();
});

test("an unpaid due (LD-0004-style) is recognized as labour expense and outstanding payable at creation", { skip }, async () => {
  const due = await createDue(31_500, "2026-07-10", "2026-07-14");
  const financials = await fetchFinancials();
  const row = financials.expenses.find((item) => item.dueId === due.id);
  assert.ok(row, "the unpaid due must appear in the expenses collection");
  assert.equal(row!.amount, 31_500, "an unpaid due still recognizes its full labour expense at creation");
  assert.equal(row!.outstandingAmount, 31_500, "an unpaid due's full amount is outstanding payable");
});

test("settling a due from the pool clears the payable without recognizing expense a second time, and reversal restores the payable without touching the original recognition", { skip }, async () => {
  await createAdvance(9000, "2026-07-01");
  const due = await createDue(7108, "2026-07-10", "2026-07-14");

  const before1 = await fetchFinancials();
  const beforeRow = before1.expenses.find((item) => item.dueId === due.id)!;
  assert.equal(beforeRow.amount, 7108, "recognized expense before settlement");

  const settleResponse = await settlePool(due.id, 7108);
  assertIntegrationResponse(settleResponse, 200, "settle the due from the aggregate pool");

  const settled = await fetchFinancials();
  const settledRow = settled.expenses.find((item) => item.dueId === due.id)!;
  assert.equal(settledRow.amount, 7108, "recognized expense does not change when a due is settled");
  assert.equal(settledRow.outstandingAmount, 0, "outstanding payable clears to zero once settled");

  const parent = settled.advanceApplicationParents.find((item) => item.dueId === due.id);
  assert.ok(parent, "the pooled settlement must appear in the applied-advances history");
  assert.equal(parent!.status, "POSTED", "an active pooled application must not display as reversed");
  assert.equal(parent!.activeAmount, 7108, "the active pooled application must show its real amount, not zero");

  const [pooledApplication] = await db.select().from(labourAdvanceApplications).where(eq(labourAdvanceApplications.dueId, due.id));
  assertPersistedUuid(pooledApplication?.id, "locate the pooled application to reverse");
  const reverseResponse = await request(
    "POST",
    `/v1/workspace/${tenant.workspaceId}/labour-payments/dues/${due.id}/advance-applications/${pooledApplication.id}/reverse?farmId=${tenant.farmId}&seasonId=${tenant.seasonId}`,
    { idempotencyKey: randomUUID(), reason: "ledger correction regression test" },
  );
  assertIntegrationResponse(reverseResponse, 200, "reverse the pooled application");

  const reopened = await fetchFinancials();
  const reopenedRow = reopened.expenses.find((item) => item.dueId === due.id)!;
  assert.equal(reopenedRow.amount, 7108, "reversal restores the payable without removing the original expense recognition");
  assert.equal(reopenedRow.outstandingAmount, 7108, "the due's outstanding payable is restored exactly once, not doubled");
});

test("a pooled application is included in active applied advances and reduces the aggregate available advance balance", { skip }, async () => {
  await createAdvance(5000, "2026-07-01");
  const due = await createDue(3200, "2026-07-10", "2026-07-14");
  const before1 = await fetchFinancials();
  const settleResponse = await settlePool(due.id, 3200);
  assertIntegrationResponse(settleResponse, 200, "settle the due from the aggregate pool");
  const after1 = await fetchFinancials();
  assert.equal(
    after1.summary.activeAdvanceApplied - before1.summary.activeAdvanceApplied,
    3200,
    "active applied advances must include the pooled application",
  );
  assert.equal(
    before1.summary.outstandingAdvance - after1.summary.outstandingAdvance,
    3200,
    "the aggregate available advance balance must decrease by the pooled draw",
  );
});

test("a pooled application attributes to the original funding account — never an unresolved source or a fake pooled/non-cash account", { skip }, async () => {
  await createAdvance(1200, "2026-07-01");
  const due = await createDue(900, "2026-07-10", "2026-07-14");
  const settleResponse = await settlePool(due.id, 900);
  assertIntegrationResponse(settleResponse, 200, "settle the due from the aggregate pool");
  const financials = await fetchFinancials();
  const attribution = financials.expenseAccountAttributions.filter((row) => row.dueId === due.id);
  assert.ok(attribution.length > 0, "the settled due must have a funding attribution row");
  assert.ok(
    attribution.every((row) => row.accountName !== "Unresolved payment source"),
    "a pooled application must never be labelled as an unresolved payment source",
  );
  assert.ok(
    attribution.every((row) => row.accountName !== "Applied advances — pooled/non-cash"),
    "no fake pooled/non-cash payment account may appear in expense reports",
  );
  assert.ok(
    attribution.some((row) => row.accountName === "Ledger Correction Cash Account" && Math.abs(row.amount - 900) < 0.005),
    "the pooled amount is attributed to the account that originally funded the consumed advance",
  );
});

test("LD-0003-style corruption (a settlement journal misclassified as LABOUR_EXPENSE) is corrected exactly once, and the migration is idempotent", { skip }, async () => {
  await createAdvance(7108, "2026-07-01");
  const due = await createDue(7108, "2026-07-10", "2026-07-14");
  const settleResponse = await settlePool(due.id, 7108);
  assertIntegrationResponse(settleResponse, 200, "settle the due from the aggregate pool");

  const [pooledApplication] = await db.select().from(labourAdvanceApplications).where(eq(labourAdvanceApplications.dueId, due.id));
  assertPersistedUuid(pooledApplication?.id, "locate the pooled application");
  const entryBase = `advance-application:${pooledApplication.id}`;

  // Simulate the historical regression: overwrite the correctly-posted
  // settlement pair with the misclassified shape commit 018f84d5 produced.
  await db.update(labourAccountingEntries)
    .set({ ledgerCode: "LABOUR_EXPENSE" })
    .where(and(eq(labourAccountingEntries.workspaceId, tenant.workspaceId), eq(labourAccountingEntries.entryKey, `${entryBase}:debit`)));

  const beforeRepair = await fetchFinancials();
  const beforeRow = beforeRepair.expenses.find((item) => item.dueId === due.id)!;
  assert.equal(beforeRow.outstandingAmount, 0, "the due-level canonical balance is unaffected by the journal-only corruption (it derives from the application row, not the journal)");

  await runRepairMigration();

  const corrected = await db.select().from(labourAccountingEntries).where(and(
    eq(labourAccountingEntries.workspaceId, tenant.workspaceId),
    eq(labourAccountingEntries.dueId, due.id),
  ));
  const originalDebit = corrected.find((row) => row.entryKey === `${entryBase}:debit`);
  const originalCredit = corrected.find((row) => row.entryKey === `${entryBase}:credit`);
  assert.equal(originalDebit?.status, "REVERSED", "the misclassified debit row must be marked REVERSED, not deleted");
  assert.equal(originalCredit?.status, "REVERSED", "its paired credit row must also be reversed");
  const reversalRows = corrected.filter((row) => row.reversalOf === originalDebit?.id || row.reversalOf === originalCredit?.id);
  assert.equal(reversalRows.length, 2, "exactly one reversal row per original row must be inserted, preserving audit history");
  const replacementDebit = corrected.find((row) => row.entryKey === `${entryBase}:ledger-correction:debit`);
  const replacementCredit = corrected.find((row) => row.entryKey === `${entryBase}:ledger-correction:credit`);
  assert.equal(replacementDebit?.ledgerCode, "LABOUR_PAYABLE", "the replacement pair must debit LABOUR_PAYABLE");
  assert.equal(replacementCredit?.ledgerCode, "LABOUR_ADVANCE", "the replacement pair must credit LABOUR_ADVANCE, matching the original intent");
  assert.equal(Number(replacementDebit?.debit), 7108);

  const [dueRow] = await db.select().from(labourDues).where(eq(labourDues.id, due.id));
  assert.equal(dueRow?.paymentStatus, "SETTLED_BY_ADVANCE", "the repair must not change the due's settlement status");
  const [applicationRow] = await db.select().from(labourAdvanceApplications).where(eq(labourAdvanceApplications.id, pooledApplication.id));
  assert.equal(applicationRow?.status, "ACTIVE", "the repair must not change the pooled application's status");

  const rowCountBeforeSecondRun = (await db.select().from(labourAccountingEntries).where(eq(labourAccountingEntries.dueId, due.id))).length;
  await runRepairMigration();
  const rowCountAfterSecondRun = (await db.select().from(labourAccountingEntries).where(eq(labourAccountingEntries.dueId, due.id))).length;
  assert.equal(rowCountAfterSecondRun, rowCountBeforeSecondRun, "running the repair migration again must not insert any further rows");
});

test("a correctly-coded settlement journal (LD-0002/LD-0005-style) is left untouched by the repair migration", { skip }, async () => {
  await createAdvance(4000, "2026-07-01");
  const due = await createDue(2500, "2026-07-10", "2026-07-14");
  const settleResponse = await settlePool(due.id, 2500);
  assertIntegrationResponse(settleResponse, 200, "settle the due from the aggregate pool");

  const beforeRepair = await db.select().from(labourAccountingEntries).where(eq(labourAccountingEntries.dueId, due.id));
  const beforeIds = new Set(beforeRepair.map((row) => row.id));

  await runRepairMigration();

  const afterRepair = await db.select().from(labourAccountingEntries).where(eq(labourAccountingEntries.dueId, due.id));
  assert.equal(afterRepair.length, beforeRepair.length, "an already-correct settlement journal must not gain any reversal or correction rows");
  assert.ok(afterRepair.every((row) => beforeIds.has(row.id)), "an already-correct settlement journal's rows must be untouched by the repair migration");
  assert.ok(afterRepair.every((row) => row.status === "POSTED"), "an already-correct settlement journal must remain POSTED, never marked REVERSED");
});
