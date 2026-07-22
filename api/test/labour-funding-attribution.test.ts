import assert from "node:assert/strict";
import test from "node:test";
import { attributeLabourExpense, fundingAttributionTotal, groupFundingSources } from "../src/lib/labour-funding-attribution.js";

test("labour expense attribution includes only settled labour wages and keeps unpaid due amounts out of expenses", () => {
  const rows = attributeLabourExpense({
    dueId: "due-1", dueNumber: "LD-0002", date: "2026-07-01", expenseAmount: 268_573,
    parts: [
      { id: "a1", settlementType: "APPLIED_ADVANCE", accountId: "younis", accountName: "Funding owner A", accountType: "partner", amount: 120_000, voucherId: "av-1", advanceApplicationId: "app-1" },
      { id: "a2", settlementType: "APPLIED_ADVANCE", accountId: "younis", accountName: "Funding owner A", accountType: "partner", amount: 7_935, voucherId: "av-2", advanceApplicationId: "app-2" },
      { id: "p1", settlementType: "DIRECT_PAYMENT", accountId: "sajid", accountName: "Payment owner B", accountType: "partner", amount: 102_030, voucherId: "pay-1", advanceApplicationId: null },
    ],
  });
  assert.deepEqual(rows.map((row) => [row.settlementType, row.accountName, row.amount]), [
    ["APPLIED_ADVANCE", "Funding owner A", 127_935],
    ["DIRECT_PAYMENT", "Payment owner B", 102_030],
  ]);
  assert.equal(fundingAttributionTotal(rows), 229_965);
});

test("multi-owner aggregate applications remain split by original funding account", () => {
  const rows = attributeLabourExpense({
    dueId: "due-2", dueNumber: "LD-0003", date: "2026-07-02", expenseAmount: 30_000,
    parts: [
      { id: "1", settlementType: "APPLIED_ADVANCE", accountId: "owner-a", accountName: "Owner A", accountType: "partner", amount: 20_000, voucherId: "av-a", advanceApplicationId: "app-a" },
      { id: "2", settlementType: "APPLIED_ADVANCE", accountId: "owner-b", accountName: "Owner B", accountType: "partner", amount: 7_000, voucherId: "av-b", advanceApplicationId: "app-b" },
      { id: "3", settlementType: "APPLIED_ADVANCE", accountId: "cash", accountName: "Cash", accountType: "cash", amount: 3_000, voucherId: "av-c", advanceApplicationId: "app-c" },
    ],
  });
  assert.equal(rows.length, 3);
  assert.equal(fundingAttributionTotal(rows), 30_000);
});

test("aggregate parent funding sources group many child allocations without creating child vouchers", () => {
  const sources = groupFundingSources([
    { accountId: "partner-a", accountName: "Partner A", accountType: "partner", amount: 12_000 },
    { accountId: "partner-a", accountName: "Partner A", accountType: "partner", amount: 8_000 },
    { accountId: "partner-b", accountName: "Partner B", accountType: "partner", amount: 7_000 },
    { accountId: "cash", accountName: "Cash", accountType: "cash", amount: 3_000 },
  ]);

  assert.deepEqual(sources.map(({ accountName, amount }) => ({ accountName, amount })), [
    { accountName: "Cash", amount: 3_000 },
    { accountName: "Partner A", amount: 20_000 },
    { accountName: "Partner B", amount: 7_000 },
  ]);
  assert.equal(fundingAttributionTotal(sources), 30_000);
});

test("reversed settlement parts are excluded by the caller and no expense is attributed until settlement exists", () => {
  const rows = attributeLabourExpense({ dueId: "due-3", dueNumber: "LD-0004", date: "2026-07-03", expenseAmount: 125, parts: [] });
  assert.deepEqual(rows, []);
});
