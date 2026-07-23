import assert from "node:assert/strict";
import test from "node:test";
import { calculateLabourAdvancePool, resolveAdvancePoolGroupId, type LabourAdvancePoolCandidate } from "../src/lib/labour-payments.js";

const candidate = (overrides: Partial<LabourAdvancePoolCandidate>): LabourAdvancePoolCandidate => ({
  id: crypto.randomUUID(), voucherNumber: "ADV-L-1", voucherDate: "2026-01-01",
  financialScopeKey: "group:g1", labourGroupId: "g1", originalAmount: 100, appliedAmount: 0, refundedAmount: 0,
  ...overrides,
});

test("group pool excludes other groups' advances and allocates oldest first", () => {
  const plan = calculateLabourAdvancePool({
    dueFinancialScopeKey: "group:g1", dueLabourGroupId: "g1", dueOutstandingAmount: 120,
    candidates: [
      candidate({ id: "00000000-0000-4000-8000-000000000002", voucherNumber: "NEW", voucherDate: "2026-02-01", originalAmount: 100 }),
      candidate({ id: "00000000-0000-4000-8000-000000000001", voucherNumber: "OLD", voucherDate: "2026-01-01", originalAmount: 80 }),
      candidate({ financialScopeKey: "group:g2", labourGroupId: "g2", originalAmount: 999 }),
    ],
  });
  assert.equal(plan.eligibleTotal, 180);
  assert.equal(plan.maximumApplicable, 120);
  assert.deepEqual(plan.allocations.map((row) => [row.voucherNumber, row.proposedAmount]), [["OLD", 80], ["NEW", 40]]);
  assert.equal(plan.carriedForwardAmount, 60);
  assert.equal(plan.exclusionTotals.otherGroups, 999);
});

test("an advance received by a member belongs to the group pool with no member wage-share cap", () => {
  const plan = calculateLabourAdvancePool({
    dueFinancialScopeKey: "group:g1", dueLabourGroupId: "g1", dueOutstandingAmount: 200, requestedAmount: 150,
    candidates: [
      candidate({ voucherNumber: "MEMBER", financialScopeKey: "individual:member-1", labourerId: "member-1", labourGroupId: "g1", originalAmount: 90 }),
      candidate({ voucherNumber: "GROUP", originalAmount: 200, voucherDate: "2026-02-01" }),
    ],
  });
  assert.equal(plan.memberLevelAmount, 90);
  assert.equal(plan.groupLevelAmount, 200);
  assert.equal(plan.maximumApplicable, 200);
  assert.deepEqual(plan.allocations.map((row) => [row.ownership, row.proposedAmount]), [["GROUP", 150]]);
  assert.equal(plan.carriedForwardAmount, 140);
});

test("advance dates outside the work period remain eligible up to the settlement date", () => {
  const plan = calculateLabourAdvancePool({
    dueFinancialScopeKey: "group:g1", dueLabourGroupId: "g1", dueOutstandingAmount: 500, settlementDate: "2026-07-01",
    candidates: [
      candidate({ voucherNumber: "BEFORE", voucherDate: "2026-03-01", originalAmount: 25 }),
      candidate({ voucherNumber: "DURING", voucherDate: "2026-04-20", originalAmount: 30 }),
      candidate({ voucherNumber: "AFTER_WORK", voucherDate: "2026-06-15", financialScopeKey: "individual:m1", labourerId: "m1", labourGroupId: "g1", originalAmount: 35 }),
    ],
  });
  assert.equal(plan.eligibleTotal, 90);
  assert.deepEqual(plan.allocations.map((row) => row.voucherNumber), ["BEFORE", "DURING", "AFTER_WORK"]);
});

test("member-received advances continue after group vouchers until a group due is fully covered", () => {
  const plan = calculateLabourAdvancePool({
    dueFinancialScopeKey: "group:g1", dueLabourGroupId: "g1", dueOutstandingAmount: 125,
    candidates: [
      candidate({ voucherNumber: "GROUP", originalAmount: 20 }),
      candidate({ voucherNumber: "MEMBER", financialScopeKey: "individual:m1", labourerId: "m1", labourGroupId: "g1", originalAmount: 150 }),
    ],
  });
  assert.equal(plan.eligibleTotal, 170);
  assert.equal(plan.maximumApplicable, 125);
  assert.equal(plan.proposedApplication, 125);
  assert.equal(plan.remainingAfterAdvances, 0);
  assert.equal(plan.carriedForwardAmount, 45);
  assert.deepEqual(plan.allocations.map((row) => [row.voucherNumber, row.proposedAmount]), [["GROUP", 20], ["MEMBER", 105]]);
});

test("non-group dues remain isolated to their exact financial scope", () => {
  const plan = calculateLabourAdvancePool({
    dueFinancialScopeKey: "individual:m1", dueOutstandingAmount: 100,
    candidates: [
      candidate({ financialScopeKey: "individual:m1", labourerId: "m1", labourGroupId: null, originalAmount: 40 }),
      candidate({ financialScopeKey: "individual:m2", labourerId: "m2", labourGroupId: null, originalAmount: 70 }),
    ],
  });
  assert.equal(plan.eligibleTotal, 40);
  assert.equal(plan.maximumApplicable, 40);
  assert.equal(plan.exclusionTotals.labourersOutsideDue, 70);
});

test("a genuinely backdated settlement excludes advances that did not yet exist", () => {
  const plan = calculateLabourAdvancePool({
    dueFinancialScopeKey: "group:g1", dueLabourGroupId: "g1", dueOutstandingAmount: 500, settlementDate: "2026-05-01",
    candidates: [
      candidate({ voucherDate: "2026-04-30", originalAmount: 40 }),
      candidate({ voucherDate: "2026-05-02", originalAmount: 60 }),
    ],
  });
  assert.equal(plan.eligibleTotal, 40);
  assert.equal(plan.exclusionTotals.postedAfterSettlementDate, 60);
});

test("farm-wide outstanding reconciles to eligible plus ownership exclusions", () => {
  const candidates = [
    candidate({ originalAmount: 50 }),
    candidate({ financialScopeKey: "group:other", labourGroupId: "other", originalAmount: 20 }),
    candidate({ financialScopeKey: "individual:outside", labourerId: "outside", labourGroupId: null, originalAmount: 10 }),
  ];
  const plan = calculateLabourAdvancePool({ dueFinancialScopeKey: "group:g1", dueLabourGroupId: "g1", dueOutstandingAmount: 100, candidates });
  const farmWide = candidates.reduce((sum, row) => sum + row.originalAmount - row.appliedAmount - row.refundedAmount, 0);
  assert.equal(farmWide, plan.eligibleTotal + plan.exclusionTotals.otherGroups + plan.exclusionTotals.labourersOutsideDue);
});

test("refunds and prior applications reduce only the available balance", () => {
  const plan = calculateLabourAdvancePool({
    dueFinancialScopeKey: "group:g1", dueLabourGroupId: "g1", dueOutstandingAmount: 100,
    candidates: [candidate({ originalAmount: 100, appliedAmount: 25, refundedAmount: 15 })],
  });
  assert.equal(plan.eligibleTotal, 60);
  assert.equal(plan.proposedApplication, 60);
  assert.equal(plan.carriedForwardAmount, 0);
});

test("a pooled full settlement produces stable allocations across 183 vouchers", () => {
  const candidates = Array.from({ length: 183 }, (_, index) => candidate({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    voucherNumber: `ADV-${String(index + 1).padStart(4, "0")}`,
    voucherDate: `2026-01-${String((index % 28) + 1).padStart(2, "0")}`,
    originalAmount: 10,
  }));
  const first = calculateLabourAdvancePool({ dueFinancialScopeKey: "group:g1", dueLabourGroupId: "g1", dueOutstandingAmount: 1_830, candidates, requestedAmount: 1_830 });
  const retry = calculateLabourAdvancePool({ dueFinancialScopeKey: "group:g1", dueLabourGroupId: "g1", dueOutstandingAmount: 1_830, candidates, requestedAmount: 1_830 });
  assert.equal(first.allocations.length, 183);
  assert.equal(first.proposedApplication, 1_830);
  assert.equal(first.remainingAfterAdvances, 0);
  assert.deepEqual(first.allocations, retry.allocations);
  assert.equal(first.allocations.reduce((sum, row) => sum + row.proposedAmount, 0), 1_830);
});

test("resolveAdvancePoolGroupId proves ownership only from preserved evidence", () => {
  assert.equal(resolveAdvancePoolGroupId({ labourGroupId: "g1" }), "g1");
  assert.equal(resolveAdvancePoolGroupId({ recipientSnapshot: { labourGroupId: "g2" } }), "g2");
  assert.equal(resolveAdvancePoolGroupId({ recipientSnapshot: { groupId: "g3" } }), "g3");
  assert.equal(resolveAdvancePoolGroupId({ financialScopeKey: "group:g4" }), "g4");
  assert.equal(resolveAdvancePoolGroupId({ financialScopeKey: "individual:m1", recipientSnapshot: {} }), null, "no evidence must never be guessed from a worker's current group");
});
