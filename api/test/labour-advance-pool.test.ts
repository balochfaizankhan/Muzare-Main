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

test("group due uses the complete member pool without member wage-share caps", () => {
  const plan = calculateLabourAdvancePool({
    dueFinancialScopeKey: "group:g1", dueOutstandingAmount: 200, requestedAmount: 150,
    memberPayableShares: [{ labourerId: "member-1", amount: 40 }],
    candidates: [
      candidate({ voucherNumber: "MEMBER", financialScopeKey: "individual:member-1", labourerId: "member-1", originalAmount: 90 }),
      candidate({ voucherNumber: "GROUP", originalAmount: 200, voucherDate: "2026-02-01" }),
    ],
  });
  assert.equal(plan.memberLevelAmount, 90);
  assert.equal(plan.groupLevelAmount, 200);
  assert.equal(plan.maximumApplicable, 200);
  assert.deepEqual(plan.allocations.map((row) => [row.ownership, row.proposedAmount]), [["GROUP", 150]]);
  assert.equal(plan.carriedForwardAmount, 140);
});

test("advance dates outside the work period remain eligible up to settlement date", () => {
  const plan = calculateLabourAdvancePool({
    dueFinancialScopeKey: "group:g1", dueOutstandingAmount: 500, settlementDate: "2026-07-01",
    memberPayableShares: [{ labourerId: "m1", amount: 500 }],
    candidates: [
      candidate({ voucherNumber: "BEFORE", voucherDate: "2026-03-01", originalAmount: 25 }),
      candidate({ voucherNumber: "DURING", voucherDate: "2026-04-20", originalAmount: 30 }),
      candidate({ voucherNumber: "AFTER_WORK", voucherDate: "2026-06-15", financialScopeKey: "individual:m1", labourerId: "m1", originalAmount: 35 }),
    ],
  });
  assert.equal(plan.eligibleTotal, 90);
  assert.deepEqual(plan.allocations.map((row) => row.voucherNumber), ["BEFORE", "DURING", "AFTER_WORK"]);
});

test("member advances continue after group advances until a group due is fully covered", () => {
  const plan = calculateLabourAdvancePool({
    dueFinancialScopeKey: "group:g1", dueOutstandingAmount: 125,
    memberPayableShares: [{ labourerId: "m1", amount: 10 }],
    candidates: [
      candidate({ voucherNumber: "GROUP", originalAmount: 20 }),
      candidate({ voucherNumber: "MEMBER", financialScopeKey: "individual:m1", labourerId: "m1", originalAmount: 150 }),
    ],
  });
  assert.equal(plan.eligibleTotal, 170);
  assert.equal(plan.maximumApplicable, 125);
  assert.equal(plan.proposedApplication, 125);
  assert.equal(plan.remainingAfterAdvances, 0);
  assert.equal(plan.carriedForwardAmount, 45);
  assert.deepEqual(plan.allocations.map((row) => [row.voucherNumber, row.proposedAmount]), [["GROUP", 20], ["MEMBER", 105]]);
});

test("individual dues remain isolated to their own financial scope", () => {
  const plan = calculateLabourAdvancePool({
    dueFinancialScopeKey: "individual:m1", dueOutstandingAmount: 100,
    candidates: [
      candidate({ financialScopeKey: "individual:m1", labourerId: "m1", originalAmount: 40 }),
      candidate({ financialScopeKey: "individual:m2", labourerId: "m2", originalAmount: 70 }),
    ],
  });
  assert.equal(plan.eligibleTotal, 40);
  assert.equal(plan.maximumApplicable, 40);
  assert.equal(plan.exclusionTotals.labourersOutsideDue, 70);
});

test("a genuinely backdated settlement excludes advances that did not yet exist", () => {
  const plan = calculateLabourAdvancePool({
    dueFinancialScopeKey: "group:g1", dueOutstandingAmount: 500, settlementDate: "2026-05-01",
    candidates: [
      candidate({ voucherDate: "2026-04-30", originalAmount: 40 }),
      candidate({ voucherDate: "2026-05-02", originalAmount: 60 }),
    ],
  });
  assert.equal(plan.eligibleTotal, 40);
  assert.equal(plan.exclusionTotals.postedAfterSettlementDate, 60);
});

test("farm-wide outstanding reconciles to eligible and ownership exclusions", () => {
  const candidates = [
    candidate({ originalAmount: 50 }),
    candidate({ financialScopeKey: "group:other", originalAmount: 20 }),
    candidate({ financialScopeKey: "individual:outside", labourerId: "outside", originalAmount: 10 }),
  ];
  const plan = calculateLabourAdvancePool({ dueFinancialScopeKey: "group:g1", dueOutstandingAmount: 100, candidates });
  const farmWide = candidates.reduce((sum, row) => sum + row.originalAmount - row.appliedAmount - row.refundedAmount, 0);
  assert.equal(farmWide, plan.eligibleTotal + plan.exclusionTotals.otherGroups + plan.exclusionTotals.labourersOutsideDue);
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
