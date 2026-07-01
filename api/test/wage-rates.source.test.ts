import assert from "node:assert/strict";
import { test } from "node:test";
import { buildWageRateReplacementMutations, calculateStatusWage, resolveApplicableWageRate, type WageRateRow } from "../src/lib/wage-rates.js";
import { summarizeAttendanceWages } from "../../web/src/lib/wageRates.js";

function wageRateRow(overrides: Partial<WageRateRow["payload"]> & { id?: string; clientRecordId?: string; updatedAt?: string }) {
  return {
    id: overrides.id ?? "row-1",
    clientRecordId: overrides.clientRecordId ?? overrides.id ?? "row-1",
    workspaceId: "workspace-1",
    farmId: "farm-1",
    seasonId: "season-1",
    clientUpdatedAt: new Date(overrides.updatedAt ?? "2026-07-01T00:00:00.000Z"),
    payload: {
      labourerId: "labour-1",
      rateType: "daily",
      dailyRate: 70,
      halfDayRate: 35,
      effectiveFrom: "2026-06-01",
      effectiveTo: "2026-06-15",
      active: true,
      ...overrides,
    },
  } satisfies WageRateRow;
}

test("backdated wage rates apply to existing attendance dates without using fallback wages", () => {
  const summary = summarizeAttendanceWages("labour-1", [
    {
      id: "attendance-1",
      workspaceId: "workspace-1",
      farmId: "farm-1",
      seasonId: "season-1",
      labourerId: "labour-1",
      date: "2026-06-05",
      status: "present",
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:00.000Z",
    },
  ], [
    {
      id: "rate-1",
      workspaceId: "workspace-1",
      farmId: "farm-1",
      seasonId: "season-1",
      labourerId: "labour-1",
      rateType: "daily",
      dailyRate: 70,
      halfDayRate: 35,
      effectiveFrom: "2026-06-01",
      effectiveTo: "2026-06-15",
      active: true,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    },
  ]);
  assert.equal(summary.totalWage, 70);
  assert.deepEqual(summary.missingRateDates, []);
});

test("missing rates stay unresolved instead of silently using a labour default", () => {
  const summary = summarizeAttendanceWages("labour-1", [
    {
      id: "attendance-1",
      workspaceId: "workspace-1",
      farmId: "farm-1",
      seasonId: "season-1",
      labourerId: "labour-1",
      date: "2026-06-05",
      status: "present",
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:00.000Z",
    },
  ], []);
  assert.equal(summary.totalWage, 0);
  assert.deepEqual(summary.missingRateDates, ["2026-06-05"]);
  assert.equal(summary.wageRateLabel, null);
});

test("replacement mutations split an older wage rate around the corrected period", () => {
  const mutations = buildWageRateReplacementMutations({
    overlaps: [wageRateRow({
      id: "existing-rate",
      clientRecordId: "existing-rate",
      effectiveFrom: "2026-06-01",
      effectiveTo: "2026-06-30",
      dailyRate: 60,
      halfDayRate: 30,
    })],
    effectiveFrom: "2026-06-10",
    effectiveTo: "2026-06-20",
    actorUserId: "user-1",
    timestamp: "2026-07-01T12:00:00.000Z",
    replacementRateId: "replacement-rate",
    reason: "Corrected wrong June rate",
  });
  assert.equal(mutations.length, 2);
  assert.deepEqual(mutations.map((item) => item.kind), ["update", "insert"]);
  const left = mutations[0];
  const right = mutations[1];
  assert.equal(left.kind, "update");
  assert.equal(left.payload.effectiveTo, "2026-06-09");
  assert.equal(right.kind, "insert");
  assert.equal(right.payload.effectiveFrom, "2026-06-21");
  assert.equal(right.payload.effectiveTo, "2026-06-30");
});

test("resolveApplicableWageRate prefers the most recently updated rate when date ranges are identical", () => {
  const older = wageRateRow({
    id: "older",
    clientRecordId: "older",
    dailyRate: 60,
    halfDayRate: 30,
    updatedAt: "2026-06-20T00:00:00.000Z",
  });
  const corrected = wageRateRow({
    id: "corrected",
    clientRecordId: "corrected",
    dailyRate: 70,
    halfDayRate: 35,
    updatedAt: "2026-07-01T00:00:00.000Z",
  });
  const resolved = resolveApplicableWageRate([older, corrected], "labour-1", "2026-06-12");
  assert.equal(resolved?.clientRecordId, "corrected");
  assert.equal(calculateStatusWage("half_day", resolved?.payload ?? null), 35);
});
