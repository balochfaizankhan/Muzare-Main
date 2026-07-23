import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateLabourAdvancePool,
  resolveAdvancePoolGroupId,
  type LabourAdvancePoolCandidate,
} from "../src/lib/labour-payments.js";

const candidate = (overrides: Partial<LabourAdvancePoolCandidate>): LabourAdvancePoolCandidate => ({
  id: crypto.randomUUID(), voucherNumber: "ADV-L-1", voucherDate: "2026-01-01",
  financialScopeKey: "group:g1", labourGroupId: "g1", originalAmount: 100, appliedAmount: 0, refundedAmount: 0,
  ...overrides,
});

// ---------------------------------------------------------------------------
// One aggregate pool per labour group, owned by the group's leader
// ---------------------------------------------------------------------------

test("an advance paid at group level and advances received by different members all aggregate into one group pool", () => {
  const plan = calculateLabourAdvancePool({
    dueFinancialScopeKey: "group:g1", dueLabourGroupId: "g1", dueOutstandingAmount: 100_000,
    candidates: [
      candidate({ voucherNumber: "LEADER", originalAmount: 4_000 }),
      candidate({ voucherNumber: "MEMBER-A", financialScopeKey: "individual:m1", labourerId: "m1", labourGroupId: "g1", originalAmount: 9_000 }),
      candidate({ voucherNumber: "MEMBER-B", financialScopeKey: "individual:m2", labourerId: "m2", labourGroupId: "g1", originalAmount: 6_000 }),
      candidate({ voucherNumber: "MEMBER-C", labourGroupId: null, recipientName: "Snapshot only", financialScopeKey: "legacy:x", labourerId: "m3", originalAmount: 1_000 }),
    ],
  });
  // Three provable owners aggregate; the snapshotless one stays out for review.
  assert.equal(plan.eligibleTotal, 19_000);
  assert.equal(plan.exclusionTotals.labourersOutsideDue, 1_000);
});

test("no member has a separate open balance: the whole pool is applicable regardless of who received each advance", () => {
  const plan = calculateLabourAdvancePool({
    dueFinancialScopeKey: "group:g1", dueLabourGroupId: "g1", dueOutstandingAmount: 14_000,
    candidates: [
      candidate({ voucherNumber: "M1", financialScopeKey: "individual:m1", labourerId: "m1", labourGroupId: "g1", originalAmount: 8_000 }),
      candidate({ voucherNumber: "M2", financialScopeKey: "individual:m2", labourerId: "m2", labourGroupId: "g1", voucherDate: "2026-01-02", originalAmount: 8_000 }),
    ],
  });
  assert.equal(plan.maximumApplicable, 14_000, "the application crosses member boundaries freely");
  assert.deepEqual(plan.allocations.map((row) => [row.voucherNumber, row.proposedAmount]), [["M1", 8_000], ["M2", 6_000]]);
});

test("memberCalculationSnapshot, attendance and wage entitlement never restrict the pool — only group ownership does", () => {
  // The due carries no member/attendance information at all; the pool is
  // complete because every advance proves the same group.
  const plan = calculateLabourAdvancePool({
    dueFinancialScopeKey: "group:g1", dueLabourGroupId: "g1", dueOutstandingAmount: 50_000,
    candidates: [
      candidate({ voucherNumber: "GROUP", originalAmount: 5_000 }),
      candidate({ voucherNumber: "SNAPSHOT-MEMBER", financialScopeKey: "individual:mx", labourerId: "mx", labourGroupId: null, recipientSnapshot: undefined, originalAmount: 700 }),
      candidate({ voucherNumber: "STAMPED-MEMBER", financialScopeKey: "individual:my", labourerId: "my", labourGroupId: "g1", originalAmount: 300 }),
    ] as LabourAdvancePoolCandidate[],
  });
  assert.equal(plan.eligibleTotal, 5_300);
  assert.equal(plan.exclusionTotals.labourersOutsideDue, 700, "an advance with no group evidence is excluded for review, never guessed in");
});

test("acceptance: total 152,931 with 135,043 applied leaves 17,888 outstanding — including the 7,108 pooled application", () => {
  // The 7,108 application is attributed per voucher (sources) exactly like
  // any other consumption, so the group aggregate includes it.
  const plan = calculateLabourAdvancePool({
    dueFinancialScopeKey: "group:g1", dueLabourGroupId: "g1", dueOutstandingAmount: 1_000_000,
    candidates: [
      candidate({ voucherNumber: "FUNDED-A", originalAmount: 100_000, appliedAmount: 90_000 }),
      candidate({ voucherNumber: "FUNDED-B", voucherDate: "2026-01-02", originalAmount: 52_931, appliedAmount: 37_935 + 7_108 }),
    ],
  });
  const total = 152_931;
  const applied = 135_043;
  assert.equal(plan.eligibleTotal, total - applied);
  assert.equal(plan.eligibleTotal, 17_888);
});

test("acceptance: pool 20,000 vs due 15,340 — apply 15,340, carry 4,660 forward, nothing remains payable", () => {
  const plan = calculateLabourAdvancePool({
    dueFinancialScopeKey: "group:g1", dueLabourGroupId: "g1", dueOutstandingAmount: 15_340,
    candidates: [
      candidate({ voucherNumber: "GROUP", originalAmount: 5_000 }),
      candidate({ voucherNumber: "M1", financialScopeKey: "individual:m1", labourerId: "m1", labourGroupId: "g1", originalAmount: 9_000 }),
      candidate({ voucherNumber: "M2", financialScopeKey: "individual:m2", labourerId: "m2", labourGroupId: "g1", originalAmount: 6_000 }),
    ],
  });
  assert.equal(plan.eligibleTotal, 20_000);
  assert.equal(plan.maximumApplicable, 15_340);
  assert.equal(plan.proposedApplication, 15_340);
  assert.equal(plan.carriedForwardAmount, 4_660);
  assert.equal(plan.remainingAfterAdvances, 0);
});

test("acceptance: pool 5,975 vs due 15,340 — apply the whole pool and 9,365 stays payable another way", () => {
  const plan = calculateLabourAdvancePool({
    dueFinancialScopeKey: "group:g1", dueLabourGroupId: "g1", dueOutstandingAmount: 15_340,
    candidates: [
      candidate({ voucherNumber: "GROUP", originalAmount: 5_000 }),
      candidate({ voucherNumber: "M1", financialScopeKey: "individual:m1", labourerId: "m1", labourGroupId: "g1", originalAmount: 975 }),
    ],
  });
  assert.equal(plan.eligibleTotal, 5_975);
  assert.equal(plan.maximumApplicable, 5_975);
  assert.equal(plan.proposedApplication, 5_975);
  assert.equal(plan.remainingAfterAdvances, 9_365);
});

test("'use all available' (no requested amount) applies exactly min(group outstanding, due outstanding)", () => {
  const poolLarger = calculateLabourAdvancePool({
    dueFinancialScopeKey: "group:g1", dueLabourGroupId: "g1", dueOutstandingAmount: 100,
    candidates: [candidate({ originalAmount: 500 })],
  });
  assert.equal(poolLarger.proposedApplication, 100);
  const dueLarger = calculateLabourAdvancePool({
    dueFinancialScopeKey: "group:g1", dueLabourGroupId: "g1", dueOutstandingAmount: 900,
    candidates: [candidate({ originalAmount: 500 })],
  });
  assert.equal(dueLarger.proposedApplication, 500);
  const clamped = calculateLabourAdvancePool({
    dueFinancialScopeKey: "group:g1", dueLabourGroupId: "g1", dueOutstandingAmount: 100, requestedAmount: 400,
    candidates: [candidate({ originalAmount: 500 })],
  });
  assert.equal(clamped.proposedApplication, 100, "the applied amount never exceeds the remaining Labour Due");
});

test("the due's work period never restricts the pool; only the settlement-date rule excludes future-dated funding", () => {
  const plan = calculateLabourAdvancePool({
    dueFinancialScopeKey: "group:g1", dueLabourGroupId: "g1", dueOutstandingAmount: 10_000, settlementDate: "2026-06-30",
    candidates: [
      candidate({ voucherNumber: "YEARS-BEFORE", voucherDate: "2024-01-01", originalAmount: 100 }),
      candidate({ voucherNumber: "AFTER-WORK-PERIOD", voucherDate: "2026-06-29", originalAmount: 200 }),
      candidate({ voucherNumber: "AFTER-SETTLEMENT", voucherDate: "2026-07-01", originalAmount: 400 }),
    ],
  });
  assert.equal(plan.eligibleTotal, 300);
  assert.equal(plan.exclusionTotals.postedAfterSettlementDate, 400);
});

test("group totals follow the transaction formulas, never per-voucher OPEN/PARTIALLY_APPLIED statuses", () => {
  // total 1,000; applied 350 (250 per-voucher + 100 legacy pooled); refunded 150.
  const plan = calculateLabourAdvancePool({
    dueFinancialScopeKey: "group:g1", dueLabourGroupId: "g1", dueOutstandingAmount: 10_000,
    candidates: [
      candidate({ voucherNumber: "A", originalAmount: 600, appliedAmount: 250, refundedAmount: 150 }),
      candidate({ voucherNumber: "B", voucherDate: "2026-01-02", originalAmount: 400 }),
    ],
    unattributedPooledConsumption: 100,
  });
  assert.equal(plan.eligibleTotal, 1_000 - 350 - 150);
});

test("farm-wide totals equal the sum of group pools when every advance has provable group ownership", () => {
  const groups = ["g1", "g2", "g3"];
  const candidates = groups.flatMap((groupId, index) => [
    candidate({ financialScopeKey: `group:${groupId}`, labourGroupId: groupId, originalAmount: 1_000 * (index + 1) }),
    candidate({ financialScopeKey: `individual:m-${groupId}`, labourerId: `m-${groupId}`, labourGroupId: groupId, originalAmount: 500 }),
  ]);
  const perGroup = groups.map((groupId) => calculateLabourAdvancePool({
    dueFinancialScopeKey: `group:${groupId}`, dueLabourGroupId: groupId, dueOutstandingAmount: 1_000_000, candidates,
  }).eligibleTotal);
  const farmWide = candidates.reduce((sum, row) => sum + row.originalAmount, 0);
  assert.equal(perGroup.reduce((sum, value) => sum + value, 0), farmWide);
});

test("ownership is proved from the funding transaction's own evidence, in priority order", () => {
  assert.equal(resolveAdvancePoolGroupId({ labourGroupId: "stored", recipientSnapshot: { groupId: "snap" }, financialScopeKey: "group:scope" }), "stored");
  assert.equal(resolveAdvancePoolGroupId({ recipientSnapshot: { labourGroupId: "snap" }, financialScopeKey: "group:scope" }), "snap");
  assert.equal(resolveAdvancePoolGroupId({ financialScopeKey: "group:scope" }), "scope");
  assert.equal(resolveAdvancePoolGroupId({ financialScopeKey: "legacy:x", recipientSnapshot: {} }), null);
});
