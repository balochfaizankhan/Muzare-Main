import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateLabourWageSettlementTotals, settlementRangesOverlap } from "../src/lib/labour-wage-settlements.js";

test("settlementRangesOverlap detects overlapping inclusive date ranges", () => {
  assert.equal(settlementRangesOverlap("2026-06-01", "2026-06-15", "2026-06-15", "2026-06-30"), true);
  assert.equal(settlementRangesOverlap("2026-06-01", "2026-06-14", "2026-06-15", "2026-06-30"), false);
});

test("calculateLabourWageSettlementTotals carries forward excess advances conservatively", () => {
  assert.deepEqual(calculateLabourWageSettlementTotals(1100, 200, 1400), {
    attendanceWages: 1100,
    pendingLabourEarnings: 200,
    totalEarned: 1300,
    advancesPaid: 1400,
    settledAdvanceAmount: 1300,
    expenseAmount: 1300,
    carryForwardAdvance: 100,
    payableBalance: 0,
  });
});

test("calculateLabourWageSettlementTotals leaves a payable balance when total labour cost exceeds advances", () => {
  assert.deepEqual(calculateLabourWageSettlementTotals(1100, 250, 700), {
    attendanceWages: 1100,
    pendingLabourEarnings: 250,
    totalEarned: 1350,
    advancesPaid: 700,
    settledAdvanceAmount: 700,
    expenseAmount: 1350,
    carryForwardAdvance: 0,
    payableBalance: 650,
  });
});

test("calculateLabourWageSettlementTotals recognizes attendance plus labour work as the wage expense", () => {
  assert.deepEqual(calculateLabourWageSettlementTotals(900, 300, 1200), {
    attendanceWages: 900,
    pendingLabourEarnings: 300,
    totalEarned: 1200,
    advancesPaid: 1200,
    settledAdvanceAmount: 1200,
    expenseAmount: 1200,
    carryForwardAdvance: 0,
    payableBalance: 0,
  });
});
