import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateLabourAdvancePool,
  resolveDueEligibleMembers,
  type LabourAdvancePoolCandidate,
} from "../src/lib/labour-payments.js";

const candidate = (overrides: Partial<LabourAdvancePoolCandidate>): LabourAdvancePoolCandidate => ({
  id: crypto.randomUUID(), voucherNumber: "ADV-L-1", voucherDate: "2026-01-01",
  financialScopeKey: "group:g1", originalAmount: 100, appliedAmount: 0, refundedAmount: 0,
  ...overrides,
});

// ---------------------------------------------------------------------------
// resolveDueEligibleMembers — the single authoritative frozen-membership rule
// ---------------------------------------------------------------------------

test("a direct/lump-sum group due with groupMembers but no memberCalculationSnapshot exposes its full frozen membership", () => {
  const membership = resolveDueEligibleMembers({
    recipientScope: "LABOUR_GROUP",
    recipientSnapshot: {
      groupMembers: [{ id: "m1", name: "Member One" }, { id: "m2", name: "Member Two" }],
      memberCalculationSnapshot: null,
    },
  });
  assert.deepEqual([...membership.memberIds].sort(), ["m1", "m2"]);
  assert.equal(membership.hasMembershipEvidence, true);
  assert.equal(membership.sources.groupMembers, 2);
  assert.equal(membership.sources.memberCalculationSnapshot, 0);
});

test("labour_due_member_snapshots rows are the strongest source and are honoured on their own", () => {
  const membership = resolveDueEligibleMembers({
    recipientScope: "LABOUR_GROUP",
    recipientSnapshot: {},
    memberSnapshotLabourerIds: ["m1", "m2", "", null],
  });
  assert.deepEqual([...membership.memberIds].sort(), ["m1", "m2"]);
  assert.equal(membership.hasMembershipEvidence, true);
  assert.equal(membership.sources.memberSnapshots, 2);
});

test("a member present in all three sources is deduplicated — never counted twice", () => {
  const membership = resolveDueEligibleMembers({
    recipientScope: "LABOUR_GROUP",
    recipientSnapshot: {
      groupMembers: [{ id: "m1", name: "Member One" }],
      memberCalculationSnapshot: [{ labourerId: "m1", grossWage: 100 }],
    },
    memberSnapshotLabourerIds: ["m1"],
  });
  assert.deepEqual(membership.memberIds, ["m1"]);
});

test("the same advance is only ever one pool candidate even when its owner appears in every membership source", () => {
  const plan = calculateLabourAdvancePool({
    dueFinancialScopeKey: "group:g1", dueOutstandingAmount: 1_000,
    eligibleMemberIds: ["m1"],
    memberPayableShares: [{ labourerId: "m1", amount: 100 }],
    candidates: [candidate({ voucherNumber: "MEMBER", financialScopeKey: "individual:m1", labourerId: "m1", originalAmount: 250 })],
  });
  assert.equal(plan.eligibleTotal, 250, "duplicate membership sources must not double-count the advance");
  assert.equal(plan.allocations.length, 1);
});

test("a non-group due has no member pool and no missing-evidence flag", () => {
  const membership = resolveDueEligibleMembers({ recipientScope: "INDIVIDUAL", recipientSnapshot: {} });
  assert.deepEqual(membership.memberIds, []);
  assert.equal(membership.hasMembershipEvidence, true);
});

test("a group due with no preserved membership evidence is flagged for review instead of guessing", () => {
  const membership = resolveDueEligibleMembers({ recipientScope: "LABOUR_GROUP", recipientSnapshot: {} });
  assert.deepEqual(membership.memberIds, []);
  assert.equal(membership.hasMembershipEvidence, false);
});

// ---------------------------------------------------------------------------
// Frozen membership is authoritative over live group membership
// ---------------------------------------------------------------------------

test("a member who left the live group after due creation keeps their advance eligible via the frozen snapshot", () => {
  // Live membership after the departure would be ["m2"] only, but the frozen
  // due-time evidence still names m1 — and live membership is never an input.
  const membership = resolveDueEligibleMembers({
    recipientScope: "LABOUR_GROUP",
    recipientSnapshot: { groupMembers: [{ id: "m1", name: "Departed" }, { id: "m2", name: "Stayed" }] },
  });
  const plan = calculateLabourAdvancePool({
    dueFinancialScopeKey: "group:g1", dueOutstandingAmount: 1_000,
    eligibleMemberIds: membership.memberIds,
    candidates: [candidate({ voucherNumber: "DEPARTED", financialScopeKey: "individual:m1", labourerId: "m1", originalAmount: 300 })],
  });
  assert.equal(plan.eligibleTotal, 300);
});

test("a member who joined the live group after due creation is not retroactively included", () => {
  const membership = resolveDueEligibleMembers({
    recipientScope: "LABOUR_GROUP",
    recipientSnapshot: { groupMembers: [{ id: "m1", name: "Original" }] },
  });
  const plan = calculateLabourAdvancePool({
    dueFinancialScopeKey: "group:g1", dueOutstandingAmount: 1_000,
    eligibleMemberIds: membership.memberIds,
    candidates: [
      candidate({ voucherNumber: "ORIGINAL", financialScopeKey: "individual:m1", labourerId: "m1", originalAmount: 300 }),
      candidate({ voucherNumber: "JOINED_LATER", financialScopeKey: "individual:m9", labourerId: "m9", originalAmount: 500 }),
    ],
  });
  assert.equal(plan.eligibleTotal, 300);
  assert.equal(plan.exclusionTotals.labourersOutsideDue, 500);
});

// ---------------------------------------------------------------------------
// Full group pool composition and the maximum-applicable rule
// ---------------------------------------------------------------------------

test("group-level advances plus every frozen member's individual advances are all eligible together", () => {
  const plan = calculateLabourAdvancePool({
    dueFinancialScopeKey: "group:g1", dueOutstandingAmount: 100_000,
    eligibleMemberIds: ["m1", "m2"],
    candidates: [
      candidate({ voucherNumber: "GROUP-A", originalAmount: 4_000 }),
      candidate({ voucherNumber: "GROUP-B", originalAmount: 1_000, voucherDate: "2026-01-05" }),
      candidate({ voucherNumber: "M1", financialScopeKey: "individual:m1", labourerId: "m1", originalAmount: 9_000 }),
      candidate({ voucherNumber: "M2", financialScopeKey: "individual:m2", labourerId: "m2", originalAmount: 6_000 }),
    ],
  });
  assert.equal(plan.groupLevelAmount, 5_000);
  assert.equal(plan.memberLevelAmount, 15_000);
  assert.equal(plan.eligibleTotal, 20_000);
});

test("an individual advance owned by another group's labourer stays excluded", () => {
  const plan = calculateLabourAdvancePool({
    dueFinancialScopeKey: "group:g1", dueOutstandingAmount: 1_000,
    eligibleMemberIds: ["m1"],
    candidates: [
      candidate({ voucherNumber: "OTHER-GROUP", financialScopeKey: "group:g2", originalAmount: 700 }),
      candidate({ voucherNumber: "OTHER-MEMBER", financialScopeKey: "individual:x1", labourerId: "x1", originalAmount: 400 }),
    ],
  });
  assert.equal(plan.eligibleTotal, 0);
  assert.equal(plan.exclusionTotals.otherGroups, 700);
  assert.equal(plan.exclusionTotals.labourersOutsideDue, 400);
});

test("acceptance: pool 20,000 vs due 15,340 — maximum applicable is the due, 4,660 carries forward, due settles", () => {
  const plan = calculateLabourAdvancePool({
    dueFinancialScopeKey: "group:g1", dueOutstandingAmount: 15_340,
    eligibleMemberIds: ["m1", "m2"],
    candidates: [
      candidate({ voucherNumber: "GROUP", originalAmount: 5_000 }),
      candidate({ voucherNumber: "M1", financialScopeKey: "individual:m1", labourerId: "m1", originalAmount: 9_000 }),
      candidate({ voucherNumber: "M2", financialScopeKey: "individual:m2", labourerId: "m2", originalAmount: 6_000 }),
    ],
  });
  assert.equal(plan.eligibleTotal, 20_000);
  assert.equal(plan.maximumApplicable, 15_340);
  assert.equal(plan.proposedApplication, 15_340);
  assert.equal(plan.carriedForwardAmount, 4_660);
  assert.equal(plan.remainingAfterAdvances, 0);
});

test("acceptance: pool 5,975 vs due 15,340 — maximum applicable is the full pool and 9,365 stays payable", () => {
  const plan = calculateLabourAdvancePool({
    dueFinancialScopeKey: "group:g1", dueOutstandingAmount: 15_340,
    eligibleMemberIds: ["m1"],
    candidates: [
      candidate({ voucherNumber: "GROUP", originalAmount: 5_000 }),
      candidate({ voucherNumber: "M1", financialScopeKey: "individual:m1", labourerId: "m1", originalAmount: 975 }),
    ],
  });
  assert.equal(plan.eligibleTotal, 5_975);
  assert.equal(plan.maximumApplicable, 5_975);
  assert.equal(plan.proposedApplication, 5_975);
  assert.equal(plan.carriedForwardAmount, 0);
  assert.equal(plan.remainingAfterAdvances, 9_365);
});

test("'use all available' (no requested amount) applies exactly min(group pool, due balance) and never exceeds the due", () => {
  const overDue = calculateLabourAdvancePool({
    dueFinancialScopeKey: "group:g1", dueOutstandingAmount: 100,
    eligibleMemberIds: ["m1"],
    candidates: [candidate({ financialScopeKey: "individual:m1", labourerId: "m1", originalAmount: 500 })],
  });
  assert.equal(overDue.maximumApplicable, 100);
  assert.equal(overDue.proposedApplication, 100, "the default application is the maximum applicable");
  const underDue = calculateLabourAdvancePool({
    dueFinancialScopeKey: "group:g1", dueOutstandingAmount: 900,
    eligibleMemberIds: ["m1"],
    candidates: [candidate({ financialScopeKey: "individual:m1", labourerId: "m1", originalAmount: 500 })],
  });
  assert.equal(underDue.maximumApplicable, 500);
  assert.equal(underDue.proposedApplication, 500);
  const clamped = calculateLabourAdvancePool({
    dueFinancialScopeKey: "group:g1", dueOutstandingAmount: 100, requestedAmount: 400,
    eligibleMemberIds: ["m1"],
    candidates: [candidate({ financialScopeKey: "individual:m1", labourerId: "m1", originalAmount: 500 })],
  });
  assert.equal(clamped.proposedApplication, 100, "a request above the due balance is clamped to the due");
});

test("member advances posted after the settlement date stay excluded from the group pool", () => {
  const plan = calculateLabourAdvancePool({
    dueFinancialScopeKey: "group:g1", dueOutstandingAmount: 10_000, settlementDate: "2026-06-30",
    eligibleMemberIds: ["m1"],
    candidates: [
      candidate({ voucherNumber: "IN-TIME", financialScopeKey: "individual:m1", labourerId: "m1", voucherDate: "2026-06-30", originalAmount: 200 }),
      candidate({ voucherNumber: "TOO-LATE", financialScopeKey: "individual:m1", labourerId: "m1", voucherDate: "2026-07-01", originalAmount: 300 }),
    ],
  });
  assert.equal(plan.eligibleTotal, 200);
  assert.equal(plan.exclusionTotals.postedAfterSettlementDate, 300);
});

test("unattributed legacy pooled consumption reduces availability FIFO, matching the database guard's arithmetic", () => {
  const plan = calculateLabourAdvancePool({
    dueFinancialScopeKey: "group:g1", dueOutstandingAmount: 10_000,
    eligibleMemberIds: ["m1"],
    candidates: [
      candidate({ voucherNumber: "OLD-GROUP", voucherDate: "2026-01-01", originalAmount: 400 }),
      candidate({ voucherNumber: "M1", financialScopeKey: "individual:m1", labourerId: "m1", voucherDate: "2026-01-02", originalAmount: 600 }),
    ],
    unattributedPooledConsumption: 500,
  });
  assert.equal(plan.eligibleTotal, 500, "1,000 available minus 500 already consumed by a pre-ledger pooled application");
  assert.equal(plan.groupLevelAmount, 0, "FIFO consumption drains the oldest (group) voucher first");
  assert.equal(plan.memberLevelAmount, 500);
  assert.equal(plan.eligibleOpenCount, 1);
});
