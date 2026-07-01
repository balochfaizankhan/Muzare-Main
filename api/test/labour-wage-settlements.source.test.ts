import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateLabourWageSettlementTotals, settlementRangesOverlap } from "../src/lib/labour-wage-settlements.js";

test("settlementRangesOverlap detects overlapping inclusive date ranges", () => {
  assert.equal(settlementRangesOverlap("2026-06-01", "2026-06-15", "2026-06-15", "2026-06-30"), true);
  assert.equal(settlementRangesOverlap("2026-06-01", "2026-06-14", "2026-06-15", "2026-06-30"), false);
});

test("calculateLabourWageSettlementTotals carries forward excess advances conservatively", () => {
  assert.deepEqual(calculateLabourWageSettlementTotals(1100, 1400), {
    attendanceWages: 1100,
    advancesPaid: 1400,
    settledAdvanceAmount: 1100,
    expenseAmount: 1100,
    carryForwardAdvance: 300,
    payableBalance: 0,
  });
});

test("calculateLabourWageSettlementTotals leaves a payable balance when wages exceed advances", () => {
  assert.deepEqual(calculateLabourWageSettlementTotals(1100, 700), {
    attendanceWages: 1100,
    advancesPaid: 700,
    settledAdvanceAmount: 700,
    expenseAmount: 1100,
    carryForwardAdvance: 0,
    payableBalance: 400,
  });
});
