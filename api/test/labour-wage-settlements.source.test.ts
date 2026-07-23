import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { calculateGroupAdvancePoolTotals, calculateLabourWageSettlementTotals, normalizeSettlementPayload, settlementAccountingStatus, settlementConsumesAdvanceBalance, settlementRangesOverlap } from "../src/lib/labour-wage-settlements.js";

test("settlementRangesOverlap detects overlapping inclusive date ranges", () => {
  assert.equal(settlementRangesOverlap("2026-06-01", "2026-06-15", "2026-06-15", "2026-06-30"), true);
  assert.equal(settlementRangesOverlap("2026-06-01", "2026-06-14", "2026-06-15", "2026-06-30"), false);
});

test("calculateLabourWageSettlementTotals carries forward excess advances conservatively", () => {
  const totals = calculateLabourWageSettlementTotals(1100, 200, 1400);
  assert.equal(totals.attendanceWages, 1100);
  assert.equal(totals.labourWorkWages, 200);
  assert.equal(totals.grossWages, 1300);
  assert.equal(totals.advanceAdjustedNow, 1300);
  assert.equal(totals.remainingAdvanceCarryForward, 100);
  assert.equal(totals.payableBalance, 0);
});

test("calculateLabourWageSettlementTotals leaves a payable balance when total labour cost exceeds advances", () => {
  const totals = calculateLabourWageSettlementTotals(1100, 250, 700);
  assert.equal(totals.attendanceWages, 1100);
  assert.equal(totals.labourWorkWages, 250);
  assert.equal(totals.grossWages, 1350);
  assert.equal(totals.advanceAdjustedNow, 700);
  assert.equal(totals.remainingAdvanceCarryForward, 0);
  assert.equal(totals.payableBalance, 650);
});

test("calculateLabourWageSettlementTotals recognizes attendance plus labour work as the wage expense", () => {
  const totals = calculateLabourWageSettlementTotals(900, 300, 1200);
  assert.equal(totals.attendanceWages, 900);
  assert.equal(totals.labourWorkWages, 300);
  assert.equal(totals.grossWages, 1200);
  assert.equal(totals.advanceAdjustedNow, 1200);
  assert.equal(totals.remainingAdvanceCarryForward, 0);
  assert.equal(totals.payableBalance, 0);
});

test("calculateGroupAdvancePoolTotals uses pooled group advances instead of labour-wise caps", () => {
  const totals = calculateGroupAdvancePoolTotals({
    grossWages: 127_935,
    totalAdvancesUpToSettlementDate: 136_030,
    previouslySettledAdvances: 0,
  });
  assert.equal(totals.availableAdvanceBalanceBeforeSettlement, 136_030);
  assert.equal(totals.advanceAdjustedNow, 127_935);
  assert.equal(totals.remainingAdvanceCarryForward, 8_095);
  assert.equal(totals.netPayableBeforePayment, 0);
});

test("calculateGroupAdvancePoolTotals leaves a payable balance when pooled advances are smaller than gross wages", () => {
  const totals = calculateGroupAdvancePoolTotals({
    grossWages: 100_000,
    totalAdvancesUpToSettlementDate: 60_000,
    previouslySettledAdvances: 0,
  });
  assert.equal(totals.availableAdvanceBalanceBeforeSettlement, 60_000);
  assert.equal(totals.advanceAdjustedNow, 60_000);
  assert.equal(totals.remainingAdvanceCarryForward, 0);
  assert.equal(totals.netPayableBeforePayment, 40_000);
});

test("calculateGroupAdvancePoolTotals excludes prior voided settlements by using only previously settled valid amounts", () => {
  const totals = calculateGroupAdvancePoolTotals({
    grossWages: 100_000,
    totalAdvancesUpToSettlementDate: 130_000,
    previouslySettledAdvances: 20_000,
  });
  assert.equal(totals.availableAdvanceBalanceBeforeSettlement, 110_000);
  assert.equal(totals.advanceAdjustedNow, 100_000);
  assert.equal(totals.remainingAdvanceCarryForward, 10_000);
});

test("labour wage settlements never reserve expense voucher numbers (creation itself is retired)", () => {
  const source = readFileSync(new URL("../src/routes/labour-wage-settlements.ts", import.meta.url), "utf8");
  assert.ok(!source.includes('import { allocateVoucherNumber } from "../lib/voucher-numbers.js";'));
  assert.ok(!source.includes("voucherPurpose: \"labour_wage_settlement\""));
  assert.ok(!source.includes("nonCashSettlement: true"));
  assert.ok(!source.includes("voucherPayload"));
  assert.ok(!source.includes("const voucherId ="));
  assert.ok(!source.includes("clientRecordId: voucherId"));
  assert.ok(source.includes("ATTENDANCE_DUES_RETIRED_MESSAGE"), "the create route now rejects with the retirement message");
});

test("labour wage settlements resolve canonical payment accounts and accept legacy android account ids", () => {
  const source = readFileSync(new URL("../src/routes/labour-wage-settlements.ts", import.meta.url), "utf8");
  const libSource = readFileSync(new URL("../src/lib/labour-wage-settlements.ts", import.meta.url), "utf8");
  const pageSource = readFileSync(new URL("../../web/src/pages/workspace/LabourWageSettlements.tsx", import.meta.url), "utf8");
  const partnerAccounting = readFileSync(new URL("../../web/src/lib/partnerAccounting.ts", import.meta.url), "utf8");
  const accounting = readFileSync(new URL("../../web/src/lib/accounting.ts", import.meta.url), "utf8");
  assert.ok(source.includes('"/v1/workspace/:workspaceId/labour-wage-settlements/payment-accounts"'));
  assert.ok(source.includes("resolveCanonicalPaymentAccountId"));
  assert.ok(source.includes("validateLabourSettlementPaymentAccount"));
  assert.doesNotMatch(source, /validateTenantReferencesDetailed/);
  assert.ok(libSource.includes("Payment account is not mapped uniquely. Please remap/import accounts."));
  assert.ok(libSource.includes("normalizeLegacyAndroidAccountId"));
  assert.ok(libSource.includes("oldAndroidId"));
  assert.ok(libSource.includes("from(accounts)"));
  assert.ok(libSource.includes('return "posted" as const;'));
  assert.ok(partnerAccounting.includes("getPartnerAccountingSnapshot"));
  assert.ok(accounting.includes("resolveLabourWageSettlementAccountId"));
  assert.ok(pageSource.includes("Pay it later from Payments Due with a Labour Payment Voucher."));
  assert.ok(pageSource.includes("Accounting reference"));
});

test("labour wage settlements repair missing accounting transactions through the settlement id", () => {
  const source = readFileSync(new URL("../src/routes/labour-wage-settlements.ts", import.meta.url), "utf8");
  const libSource = readFileSync(new URL("../src/lib/labour-wage-settlements.ts", import.meta.url), "utf8");
  assert.ok(source.includes('"/v1/workspace/:workspaceId/labour-wage-settlements/:settlementId"'));
  assert.ok(source.includes('"/v1/workspace/:workspaceId/labour-wage-settlements/:settlementId/repair-accounting"'));
  assert.ok(source.includes('"/v1/workspace/:workspaceId/labour-wage-settlements/:settlementId/void"'));
  assert.ok(source.includes("repairPostedSettlementAccounting"));
  assert.ok(source.includes('action: "labour_wage_settlement_accounting_repaired"'));
  assert.ok(source.includes('action: "labour_wage_settlement_voided"'));
  assert.ok(libSource.includes('source: "settlement"'));
  assert.ok(libSource.includes('sourceType: "labour_wage_settlement"'));
  assert.ok(libSource.includes("referenceId: settlementRecord.clientRecordId"));
  assert.ok(libSource.includes('return "posted" as const;'));
});

test("settlement creation is retired: the route rejects immediately while the status probe still answers old clients", () => {
  const source = readFileSync(new URL("../src/routes/labour-wage-settlements.ts", import.meta.url), "utf8");
  const webSource = readFileSync(new URL("../../web/src/pages/workspace/LabourWageSettlements.tsx", import.meta.url), "utf8");
  const apiSource = readFileSync(new URL("../../web/src/lib/api.ts", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../../database/migrations/0046_group_advance_pools_and_attendance_due_retirement.sql", import.meta.url), "utf8");
  assert.match(source, /app\.post\("\/v1\/workspace\/:workspaceId\/labour-wage-settlements", \{ preHandler: requireUser \}, async \(request, reply\) => \{[\s\S]{0,700}ATTENDANCE_DUES_RETIRED_MESSAGE/);
  assert.doesNotMatch(source, /updateCreateRequestState\("request_received"\)/, "no creation state machine runs any more");
  assert.ok(source.includes('app.get("/v1/workspace/:workspaceId/labour-wage-settlements/status"'));
  assert.ok(webSource.includes("resolveSettlementCreateStatus"));
  assert.ok(apiSource.includes("The request is taking longer than expected. Checking settlement status..."));
  // Anything still queued is parked for review instead of being posted.
  assert.match(migration, /UPDATE labour_wage_settlement_create_requests/);
});

test("historical settlement advance allocations keep canonical advance UUIDs; no route inserts new allocations", () => {
  const routeSource = readFileSync(new URL("../src/routes/labour-wage-settlements.ts", import.meta.url), "utf8");
  const ledgerSource = readFileSync(new URL("../src/lib/labour-advance-ledger.ts", import.meta.url), "utf8");
  assert.ok(ledgerSource.includes("advanceRecordId: row.id"));
  assert.ok(ledgerSource.includes("sourceAdvanceId: row.clientRecordId"));
  assert.ok(ledgerSource.includes("advanceRecordId: row.advanceRecordId"));
  assert.ok(ledgerSource.includes("allocationsBySettlementId.get(settlement.id)"));
  assert.ok(ledgerSource.includes("legacyUnallocatedPreviouslyAbsorbedAdvances"));
  assert.doesNotMatch(ledgerSource, /eligibleAdvances\[0\]/);
  // Creation is retired: nothing in the routes inserts settlement advance
  // allocations any more; the table remains readable for history.
  assert.doesNotMatch(routeSource, /insert\(labourWageSettlementAdvanceAllocations\)/);
});

test("labour wage settlement preview remains read-only and never inserts advance allocations", () => {
  const routeSource = readFileSync(new URL("../src/routes/labour-wage-settlements.ts", import.meta.url), "utf8");
  const previewStart = routeSource.indexOf('app.post("/v1/workspace/:workspaceId/labour-wage-settlements/preview"');
  const createStart = routeSource.indexOf('app.post("/v1/workspace/:workspaceId/labour-wage-settlements"', previewStart + 1);
  assert.ok(previewStart >= 0);
  assert.ok(createStart > previewStart);
  const previewBlock = routeSource.slice(previewStart, createStart);
  assert.doesNotMatch(previewBlock, /labourWageSettlementAdvanceAllocations/);
  assert.doesNotMatch(previewBlock, /tx\.insert\(/);
});

test("non-cash labour settlement stays out of the positive farm owes partner formula", () => {
  const apiSource = readFileSync(new URL("../src/routes/accounting-reconciliation.ts", import.meta.url), "utf8");
  const webPartnerAccounting = readFileSync(new URL("../../web/src/lib/partnerAccounting.ts", import.meta.url), "utf8");
  const webModulePage = readFileSync(new URL("../../web/src/pages/ModulePage.tsx", import.meta.url), "utf8");
  const webReports = readFileSync(new URL("../../web/src/pages/workspace/Reports.tsx", import.meta.url), "utf8");
  assert.ok(!apiSource.includes("+ labourSettlementNonCashApplied"));
  assert.ok(!webPartnerAccounting.includes("+ settlementSnapshot.labourWageSettlements"));
  assert.ok(webPartnerAccounting.includes("+ totalLabourAdvancesPaid"));
  assert.ok(webModulePage.includes("settlementSnapshot?.totalLabourAdvancesPaid ?? byType.labourAdvancesPaid"));
  assert.ok(webModulePage.includes("+ (settlementSnapshot?.labourWageSettlements ?? overview.labourWageSettlements)"));
  assert.ok(!webModulePage.includes("+ settlementSnapshot.labourSettlementNonCashApplied"));
  assert.ok(webReports.includes('if (group.groupKey === "purchase_vouchers_paid") summary.directExpensesPaid += group.totalAmount;'));
  assert.ok(webReports.includes("+ (settlementSnapshot?.labourWageSettlements ?? overview.labourWageSettlements)"));
  assert.ok(!webReports.includes("+ settlementSnapshot.labourSettlementNonCashApplied"));
});

test("deleted labour settlements stay deleted in normalization and accounting status", () => {
  const payload = normalizeSettlementPayload({
    settlementNumber: "LW-0001",
    linkedVoucherId: "voucher-1",
    linkedVoucherNumber: "LW-0001",
    linkedAccountId: "account-1",
    fromDate: "2026-06-01",
    toDate: "2026-06-30",
    settlementDate: "2026-07-01",
    expenseAmount: 250,
    status: "deleted",
    deletedAt: "2026-07-05T10:00:00.000Z",
    deletedBy: "user-1",
  });
  assert.equal(payload.status, "deleted");
  assert.equal(payload.deletedAt, "2026-07-05T10:00:00.000Z");
  assert.equal(settlementAccountingStatus(payload, 0), "deleted");
});

test("voided, cancelled, and reversed settlements do not consume advance balances", () => {
  assert.equal(settlementConsumesAdvanceBalance(normalizeSettlementPayload({
    settlementNumber: "LW-0002",
    linkedVoucherId: "",
    linkedVoucherNumber: "LW-0002",
    linkedAccountId: "account-1",
    fromDate: "2026-06-01",
    toDate: "2026-06-30",
    settlementDate: "2026-07-01",
    expenseAmount: 100,
    status: "posted",
  })), true);
  assert.equal(settlementConsumesAdvanceBalance(normalizeSettlementPayload({
    settlementNumber: "LW-0003",
    linkedVoucherId: "",
    linkedVoucherNumber: "LW-0003",
    linkedAccountId: "account-1",
    fromDate: "2026-06-01",
    toDate: "2026-06-30",
    settlementDate: "2026-07-01",
    expenseAmount: 100,
    status: "voided",
  })), false);
  assert.equal(settlementConsumesAdvanceBalance(normalizeSettlementPayload({
    settlementNumber: "LW-0004",
    linkedVoucherId: "",
    linkedVoucherNumber: "LW-0004",
    linkedAccountId: "account-1",
    fromDate: "2026-06-01",
    toDate: "2026-06-30",
    settlementDate: "2026-07-01",
    expenseAmount: 100,
    status: "cancelled",
  })), false);
  assert.equal(settlementConsumesAdvanceBalance(normalizeSettlementPayload({
    settlementNumber: "LW-0005",
    linkedVoucherId: "",
    linkedVoucherNumber: "LW-0005",
    linkedAccountId: "account-1",
    fromDate: "2026-06-01",
    toDate: "2026-06-30",
    settlementDate: "2026-07-01",
    expenseAmount: 100,
    status: "posted",
    reversedAt: "2026-07-02T08:00:00.000Z",
  })), false);
});

test("labour settlement preview computes prior settled advances separately from current adjustment", () => {
  const source = readFileSync(new URL("../src/lib/labour-wage-settlements.ts", import.meta.url), "utf8");
  assert.ok(source.includes("settlementConsumesAdvanceBalance"));
  assert.ok(source.includes("advanceDebugTrace"));
  assert.ok(source.includes("excludedVoidedSettledAdvances"));
  assert.ok(source.includes("advanceReconciliation"));
  assert.ok(source.includes("const advanceAdjustedNow = selection.settlementMode === \"group\""));
  assert.ok(source.includes("advanceDebugTrace"));
  assert.ok(source.includes("const previouslySettledAdvances = advanceLedger.totals.previouslyAbsorbedAdvances"));
  assert.ok(!source.includes("const previouslySettledAdvances = Math.max(rawAdvancesUpToSettlementDate - availableAdvanceBalanceBeforeSettlement, 0);"));
});

test("pooled group advance totals stay in the calculation library while route-level settlement posting is retired", () => {
  const source = readFileSync(new URL("../src/routes/labour-wage-settlements.ts", import.meta.url), "utf8");
  const libSource = readFileSync(new URL("../src/lib/labour-wage-settlements.ts", import.meta.url), "utf8");
  assert.ok(libSource.includes("calculateGroupAdvancePoolTotals"));
  assert.doesNotMatch(source, /rawAdvancesUpToSettlementDate: preview\.rawAdvancesUpToSettlementDate/, "no route posts a new settlement from an attendance preview");
});

test("settlement create status endpoint reuses the client request id and processing lock", () => {
  const source = readFileSync(new URL("../src/routes/labour-wage-settlements.ts", import.meta.url), "utf8");
  assert.ok(source.includes('app.get("/v1/workspace/:workspaceId/labour-wage-settlements/status"'));
  assert.ok(source.includes("settlementStatusQuerySchema"));
  assert.ok(source.includes("SettlementCreateStatusResponse"));
  assert.ok(source.includes("settlementCreateStatusFromRequest"));
  assert.ok(source.includes("settlementCreateLifecycleMessage"));
  assert.ok(source.includes("inspectSettlementAccountingIntegrity"));
  assert.ok(source.includes("isSettlementRequestProcessing"));
  assert.ok(source.includes("pg_try_advisory_lock"));
  assert.ok(source.includes('state: "FAILED"'));
  assert.ok(source.includes("lifecycleErrorCode"));
  assert.ok(source.includes("lifecycleMessage"));
});

test("settlement status lookup is read-only and does not run accounting repair", () => {
  const source = readFileSync(new URL("../src/routes/labour-wage-settlements.ts", import.meta.url), "utf8");
  const statusStart = source.indexOf('app.get("/v1/workspace/:workspaceId/labour-wage-settlements/status"');
  const paymentAccountsStart = source.indexOf('app.get("/v1/workspace/:workspaceId/labour-wage-settlements/payment-accounts"', statusStart + 1);
  assert.ok(statusStart >= 0);
  assert.ok(paymentAccountsStart > statusStart);
  const statusBlock = source.slice(statusStart, paymentAccountsStart);
  assert.ok(statusBlock.includes("inspectSettlementAccountingIntegrity"));
  assert.doesNotMatch(statusBlock, /repairPostedSettlementAccounting/);
  assert.doesNotMatch(statusBlock, /tx\.update\(/);
  assert.doesNotMatch(statusBlock, /tx\.insert\(/);
  assert.doesNotMatch(statusBlock, /tx\.delete\(/);
});

test("historical settlement payloads keep immutable payment account identity snapshots readable", () => {
  const libSource = readFileSync(new URL("../src/lib/labour-wage-settlements.ts", import.meta.url), "utf8");
  assert.ok(libSource.includes("paymentAccountCanonicalId?: string | null;"));
  assert.ok(libSource.includes("paymentAccountLegacyId?: string | null;"));
  assert.ok(libSource.includes("paymentAccountName?: string | null;"));
  assert.ok(libSource.includes("paymentAccountType?: string | null;"));
});

test("individual labour summaries do not subtract group settlement advance adjustments", () => {
  const source = readFileSync(new URL("../../web/src/lib/labourEarnings.ts", import.meta.url), "utf8");
  assert.ok(source.includes('settlement.settlementMode !== "group"'));
  assert.ok(source.includes("settlement.includedLabourIds?.includes(args.labourerId)"));
});

test("frontend rechecks settlement creation status after timeout before allowing retry", () => {
  const apiSource = readFileSync(new URL("../../web/src/lib/api.ts", import.meta.url), "utf8");
  const pageSource = readFileSync(new URL("../../web/src/pages/workspace/LabourWageSettlements.tsx", import.meta.url), "utf8");
  assert.ok(apiSource.includes("fetchLabourWageSettlementCreateStatus"));
  assert.ok(apiSource.includes("lifecycleErrorCode"));
  assert.ok(apiSource.includes("lifecycleMessage"));
  assert.ok(pageSource.includes("resolveSettlementCreateStatus"));
  assert.ok(pageSource.includes("The request is taking longer than expected. Checking settlement status..."));
  assert.ok(pageSource.includes("Settlement creation is still processing. Do not submit it again."));
  assert.ok(pageSource.includes("Settlement creation is still processing. You may leave this page and check Settlements shortly. Do not create it again."));
  assert.ok(pageSource.includes("window.sessionStorage"));
  assert.ok(pageSource.includes("activeStatusResolverRequestIdRef"));
  assert.ok(pageSource.includes("View Settlements"));
  assert.ok(pageSource.includes("Check Status"));
  assert.ok(pageSource.includes("Settlement in progress..."));
  assert.ok(pageSource.includes("status.lifecycleMessage ?? status.message"));
  assert.ok(pageSource.includes("response.lifecycleMessage ?? response.message"));
  assert.ok(pageSource.includes("status.accountingStatus === \"REPAIR_REQUIRED\" || status.accountingStatus === \"MISSING\" ? status.accountingMessage : null"));
  assert.ok(pageSource.includes("response.accountingStatus === \"REPAIR_REQUIRED\" || response.accountingStatus === \"MISSING\" ? response.accountingMessage : null"));
  assert.ok(pageSource.includes("Settlement could not be created. No changes were saved."));
  assert.doesNotMatch(pageSource, /cannot be reposted because its payment account no longer exists/);
  assert.doesNotMatch(pageSource, /Checking status\.\.\./);
});

test("labour group foreman support and advance report labels are explicit in the UI", () => {
  const groupsPage = readFileSync(new URL("../../web/src/pages/workspace/LabourGroups.tsx", import.meta.url), "utf8");
  const settlementsPage = readFileSync(new URL("../../web/src/pages/workspace/LabourWageSettlements.tsx", import.meta.url), "utf8");
  const reportsPage = readFileSync(new URL("../../web/src/pages/workspace/Reports.tsx", import.meta.url), "utf8");
  assert.ok(groupsPage.includes("Foreman"));
  assert.ok(groupsPage.includes("foremanId"));
  assert.ok(settlementsPage.includes("Available Group Advances"));
  assert.ok(settlementsPage.includes("Advance Absorbed This Settlement"));
  assert.ok(settlementsPage.includes("Outstanding Group Advance"));
  assert.ok(reportsPage.includes("Source / Paid From"));
  assert.ok(reportsPage.includes("Minimum Amount"));
  assert.ok(reportsPage.includes("Maximum Amount"));
});

test("group settlement preview resolves the persisted foreman relation server-side", () => {
  const routeSource = readFileSync(new URL("../src/routes/labour-wage-settlements.ts", import.meta.url), "utf8");
  const settlementsPage = readFileSync(new URL("../../web/src/pages/workspace/LabourWageSettlements.tsx", import.meta.url), "utf8");
  const groupsPage = readFileSync(new URL("../../web/src/pages/workspace/LabourGroups.tsx", import.meta.url), "utf8");
  const syncRoute = readFileSync(new URL("../src/routes/operational-sync.ts", import.meta.url), "utf8");
  assert.ok(settlementsPage.includes("const selectedGroupForemanId = selectedGroup?.foremanLabourId ?? selectedGroup?.foremanId ?? \"\";"));
  assert.ok(settlementsPage.includes("const effectiveGroupForemanId = settlementMode === \"group\""));
  assert.ok(settlementsPage.includes("console.debug(\"labour-settlement-preview\""));
  assert.ok(settlementsPage.includes("groupId: settlementMode === \"group\" ? groupId || undefined : undefined"));
  assert.doesNotMatch(settlementsPage, /foremanId: settlementMode === "group"/);
  assert.ok(routeSource.includes("async function resolveSettlementSelection("));
  assert.ok(routeSource.includes("foremanId: z.unknown().optional().nullable()"));
  assert.ok(routeSource.includes("Select a labour group."));
  assert.ok(routeSource.includes("Selected labour group was not found."));
  assert.ok(routeSource.includes("The selected labour group has no foreman assigned. Assign a foreman in Labour Groups before creating a settlement."));
  assert.ok(routeSource.includes("The assigned foreman record is invalid. Reassign the group foreman."));
  assert.ok(routeSource.includes("The submitted foreman does not match the selected labour group."));
  assert.ok(groupsPage.includes("foremanLabourId: normalizedForemanId"));
  assert.ok(syncRoute.includes("foremanId: foremanLabourId || undefined"));
  assert.ok(syncRoute.includes("foremanLabourId: foremanLabourId || undefined"));
});

test("labour wage settlements can be deleted safely only through the settlement register flow", () => {
  const source = readFileSync(new URL("../src/routes/labour-wage-settlements.ts", import.meta.url), "utf8");
  assert.ok(source.includes('app.delete("/v1/workspace/:workspaceId/labour-wage-settlements/:settlementId"'));
  assert.ok(source.includes("This settlement has accounting entries. Use Void/Reverse instead."));
  assert.ok(source.includes('action: "labour_wage_settlement_deleted"'));
  assert.ok(source.includes('status: "deleted" as const'));
});

test("linked labour settlement vouchers cannot be deleted through operational sync", () => {
  const source = readFileSync(new URL("../src/routes/operational-sync.ts", import.meta.url), "utf8");
  assert.ok(source.includes('payload.voucherPurpose === "labour_wage_settlement"'));
  assert.ok(source.includes('payload.nonCashSettlement === true'));
  assert.ok(source.includes("Void or reverse the settlement instead."));
});
