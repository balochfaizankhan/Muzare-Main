import assert from "node:assert/strict";
import test from "node:test";
import { calculateLabourAdvancePool, type LabourAdvancePoolCandidate } from "../src/lib/labour-payments.js";

const candidate = (overrides: Partial<LabourAdvancePoolCandidate>): LabourAdvancePoolCandidate => ({
  id: crypto.randomUUID(), voucherNumber: "ADV-L-1", voucherDate: "2026-01-01",
  financialScopeKey: "group:g1", originalAmount: 100, appliedAmount: 0, refundedAmount: 0,
  ...overrides,
});

test("group pool excludes unrelated advances and allocates oldest first", () => {
  const plan = calculateLabourAdvancePool({
    dueFinancialScopeKey: "group:g1", dueOutstandingAmount: 120,
    candidates: [
      candidate({ id: "00000000-0000-4000-8000-000000000002", voucherNumber: "NEW", voucherDate: "2026-02-01", originalAmount: 100 }),
      candidate({ id: "00000000-0000-4000-8000-000000000001", voucherNumber: "OLD", voucherDate: "2026-01-01", originalAmount: 80 }),
      candidate({ financialScopeKey: "group:g2", originalAmount: 999 }),
    ],
  });
  assert.equal(plan.eligibleTotal, 180);
  assert.equal(plan.maximumApplicable, 120);
  assert.deepEqual(plan.allocations.map((row) => [row.voucherNumber, row.proposedAmount]), [["OLD", 80], ["NEW", 40]]);
  assert.equal(plan.carriedForwardAmount, 60);
});

test("member advances are capped to that member share before group advances", () => {
  const plan = calculateLabourAdvancePool({
    dueFinancialScopeKey: "group:g1", dueOutstandingAmount: 200, requestedAmount: 150,
    memberPayableShares: [{ labourerId: "member-1", amount: 40 }],
    candidates: [
      candidate({ voucherNumber: "MEMBER", financialScopeKey: "individual:member-1", labourerId: "member-1", originalAmount: 90 }),
      candidate({ voucherNumber: "GROUP", originalAmount: 200, voucherDate: "2026-02-01" }),
    ],
  });
  assert.equal(plan.memberLevelAmount, 40);
  assert.equal(plan.groupLevelAmount, 200);
  assert.deepEqual(plan.allocations.map((row) => [row.ownership, row.proposedAmount]), [["MEMBER", 40], ["GROUP", 110]]);
  assert.equal(plan.carriedForwardAmount, 90);
});

test("refunds and prior applications reduce only the available balance", () => {
  const plan = calculateLabourAdvancePool({
    dueFinancialScopeKey: "group:g1", dueOutstandingAmount: 100,
    candidates: [candidate({ originalAmount: 100, appliedAmount: 25, refundedAmount: 15 })],
  });
  assert.equal(plan.eligibleTotal, 60);
  assert.equal(plan.proposedApplication, 60);
  assert.equal(plan.carriedForwardAmount, 0);
});
