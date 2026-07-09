import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { calculateLabourWageSettlementTotals, normalizeSettlementPayload, settlementAccountingStatus, settlementRangesOverlap } from "../src/lib/labour-wage-settlements.js";

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

test("labour wage settlements use settlement numbering instead of reserving expense voucher numbers", () => {
  const source = readFileSync(new URL("../src/routes/labour-wage-settlements.ts", import.meta.url), "utf8");
  assert.ok(!source.includes('import { allocateVoucherNumber } from "../lib/voucher-numbers.js";'));
  assert.ok(!source.includes("voucherPurpose: \"labour_wage_settlement\""));
  assert.ok(!source.includes("nonCashSettlement: true"));
  assert.ok(!source.includes("voucherPayload"));
  assert.ok(!source.includes("const voucherId ="));
  assert.ok(!source.includes("clientRecordId: voucherId"));
  assert.ok(source.includes('linkedVoucherId: ""'));
  assert.ok(source.includes("linkedVoucherNumber: settlementNumber"));
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
  assert.ok(pageSource.includes("Payment account"));
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
  assert.ok(source.includes('action: "labour_wage_settlement_updated"'));
  assert.ok(source.includes('action: "labour_wage_settlement_voided"'));
  assert.ok(libSource.includes('source: "settlement"'));
  assert.ok(libSource.includes('sourceType: "labour_wage_settlement"'));
  assert.ok(libSource.includes("referenceId: settlementRecord.clientRecordId"));
  assert.ok(libSource.includes('return "posted" as const;'));
});

test("non-cash labour settlement stays out of the positive farm owes partner formula", () => {
  const apiSource = readFileSync(new URL("../src/routes/accounting-reconciliation.ts", import.meta.url), "utf8");
  const webPartnerAccounting = readFileSync(new URL("../../web/src/lib/partnerAccounting.ts", import.meta.url), "utf8");
  const webModulePage = readFileSync(new URL("../../web/src/pages/ModulePage.tsx", import.meta.url), "utf8");
  const webReports = readFileSync(new URL("../../web/src/pages/workspace/Reports.tsx", import.meta.url), "utf8");
  assert.ok(!apiSource.includes("+ labourSettlementNonCashApplied"));
  assert.ok(!webPartnerAccounting.includes("+ settlementSnapshot.labourWageSettlements"));
  assert.ok(webPartnerAccounting.includes("carryForwardAdvances"));
  assert.ok(webModulePage.includes("settlementSnapshot?.totalLabourAdvancesPaid ?? byType.labourAdvancesPaid"));
  assert.ok(webModulePage.includes("overview.directExpensesPaid = overview.purchaseVouchersPaid + (settlementSnapshot?.totalLabourAdvancesPaid ?? overview.labourAdvancesPaid);"));
  assert.ok(webReports.includes("summary.directExpensesPaid += group.totalAmount;"));
  assert.ok(webReports.includes('if (group.groupKey === "purchase_vouchers_paid") summary.directExpensesPaid += group.totalAmount;'));
  assert.ok(webReports.includes("overview.directExpensesPaid = overview.purchaseVouchersPaid + (settlementSnapshot?.totalLabourAdvancesPaid ?? overview.labourAdvancesPaid);"));
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
