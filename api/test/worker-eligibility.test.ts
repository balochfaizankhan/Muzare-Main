import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getWorkerWorkingPeriod,
  groupWorkersByStatusPreserveOrder,
  isWorkerEligibleForAdvancePayment,
  isWorkerEligibleForAttendance,
  isWorkerEligibleForSettlement,
  isWorkerEligibleForWageRatePeriod,
  sortWorkersForDisplay,
} from "../../web/src/lib/workerEligibility.ts";

test("worker grouping preserves source order within active and inactive groups", () => {
  const workers = [
    { id: "a", name: "Akram", active: false, createdAt: "2026-05-01T00:00:00.000Z" },
    { id: "b", name: "Saleem", active: true, createdAt: "2026-05-02T00:00:00.000Z" },
    { id: "c", name: "Yousaf", active: true, createdAt: "2026-05-03T00:00:00.000Z" },
    { id: "d", name: "Bilal", active: false, createdAt: "2026-05-04T00:00:00.000Z" },
    { id: "e", name: "Rafiq", active: true, createdAt: "2026-05-05T00:00:00.000Z" },
  ] as const;

  assert.deepEqual(groupWorkersByStatusPreserveOrder(workers as any), [
    workers[1],
    workers[2],
    workers[4],
    workers[0],
    workers[3],
  ]);
  assert.deepEqual(sortWorkersForDisplay(workers as any), [
    workers[1],
    workers[2],
    workers[4],
    workers[0],
    workers[3],
  ]);
});

test("worker eligibility stays date-aware for wage rates and keeps inactive workers available for payments and settlements", () => {
  const worker = {
    id: "w1",
    name: "Worker",
    active: false,
    joinedOn: "2026-01-10",
    firstAttendanceDate: "2026-01-10",
    lastAttendanceDate: "2026-05-31",
    createdAt: "2026-01-10T00:00:00.000Z",
  } as any;

  assert.deepEqual(getWorkerWorkingPeriod(worker), {
    workerStart: "2026-01-10",
    workerEnd: "2026-05-31",
  });
  assert.equal(isWorkerEligibleForAttendance(worker, "2026-05-31"), true);
  assert.equal(isWorkerEligibleForAttendance(worker, "2026-06-01"), false);
  assert.equal(isWorkerEligibleForWageRatePeriod(worker, "2026-05-01", "2026-05-31"), true);
  assert.equal(isWorkerEligibleForWageRatePeriod(worker, "2026-06-01", "2026-06-30"), false);
  assert.equal(isWorkerEligibleForAdvancePayment(worker, "2026-06-15"), true);
  assert.equal(isWorkerEligibleForSettlement(worker, "2026-06-15"), true);
});
