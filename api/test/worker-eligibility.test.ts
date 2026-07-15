import assert from "node:assert/strict";
import { test } from "node:test";
import {
  filterLabourSelectableForAdvance,
  getWorkerWorkingPeriod,
  groupWorkersByStatusPreserveOrder,
  isLabourAvailableForEntry,
  isLabourSelectableForAdvance,
  isWorkerEligibleForAdvancePayment,
  isWorkerEligibleForAttendance,
  isWorkerEligibleForSettlement,
  isWorkerEligibleForWageRatePeriod,
  sortWorkersForDisplay,
} from "../../web/src/lib/workerEligibility.ts";
import { isLabourSelectableForAdvance as isLabourSelectableForAdvanceOnline } from "../src/lib/labour-eligibility.js";

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

test("worker eligibility stays date-aware and hides inactive workers from new entries by default", () => {
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
  assert.equal(isLabourAvailableForEntry(worker, "2026-05-31"), true);
  assert.equal(isLabourAvailableForEntry(worker, "2026-06-15"), false);
  assert.equal(isWorkerEligibleForAdvancePayment(worker, "2026-06-15"), true, "advance eligibility ignores the employment end date");
  assert.equal(isWorkerEligibleForSettlement(worker, "2026-06-15"), false);
});

test("advance eligibility ignores activity and working-period dates but excludes explicit lifecycle actions", () => {
  const base = { createdAt: "2026-01-01T00:00:00.000Z", joinedOn: "2026-01-01", group: "North" };
  const workers = [
    { ...base, id: "saleem", name: "Saleem", active: true },
    { ...base, id: "mumtaz", name: "Mumtaz", active: false, status: "inactive" },
    { ...base, id: "seasonal", name: "Seasonal Worker", active: false, status: "temporarily_unavailable" },
    { ...base, id: "future", name: "Future Joiner", active: false, status: "onboarding", joinedOn: "2026-08-01" },
    { ...base, id: "ended", name: "Karim", endedOn: "2026-06-30" },
    { ...base, id: "left", name: "Bilal", leftDate: "2026-06-30" },
    { ...base, id: "inactive-ended", name: "Old End Date", active: false, status: "inactive", endedOn: "2020-01-01" },
    { ...base, id: "terminated-status", name: "Imported Status", active: false, status: "terminated", endedOn: "2020-01-01" },
    { ...base, id: "zafar", name: "Zafar", active: false, endedOn: "2026-06-30", deactivatedAt: "2026-07-01T00:00:00.000Z" },
    { ...base, id: "aslam", name: "Aslam", active: false, isArchived: true },
    { ...base, id: "archived-at", name: "Archived At", archivedAt: "2026-06-30T00:00:00.000Z" },
    { ...base, id: "karim", name: "Karim", deletedAt: "2026-06-30T00:00:00.000Z" },
    { ...base, id: "deleted-status", name: "Deleted Status", status: "deleted" },
    { ...base, id: "deactivated-status", name: "Deactivated Status", status: "deactivated" },
  ] as any[];

  const eligible = filterLabourSelectableForAdvance(workers, "2026-07-15");
  assert.deepEqual(eligible.map((worker) => worker.id), ["saleem", "mumtaz", "seasonal", "future", "ended", "left", "inactive-ended", "terminated-status"]);
  assert.equal(isLabourSelectableForAdvance(workers[1], "2026-07-15"), true);
  assert.equal(isLabourSelectableForAdvance(workers[4], "2026-07-15"), true, "endedOn is only a working-period field");
  assert.equal(isLabourSelectableForAdvance(workers[5], "2026-07-15"), true, "leftDate is only a working-period field");
  assert.equal(isLabourSelectableForAdvance(workers[8], "2026-06-15"), false, "the explicit deactivation marker excludes even backdated advances");
});

test("advance group and search filtering retain eligible inactive labour and preserve source order", () => {
  const base = { createdAt: "2026-01-01T00:00:00.000Z", joinedOn: "2026-01-01" };
  const workers = [
    { ...base, id: "active-1", name: "Saleem", group: "North", active: true },
    { ...base, id: "inactive-1", name: "Mumtaz", group: "North", active: false, status: "inactive" },
    { ...base, id: "ended", name: "Karim Ended", group: "North", active: false, endedOn: "2020-01-01" },
    { ...base, id: "left", name: "Bilal Left", group: "North", leftDate: "2020-01-01" },
    { ...base, id: "active-2", name: "Bilal", group: "South", active: true },
    { ...base, id: "deactivated", name: "Zafar", group: "North", active: false, endedOn: "2026-07-01", status: "deactivated" },
    { ...base, id: "archived", name: "Aslam", group: "North", isArchived: true },
    { ...base, id: "deleted", name: "Karim", group: "North", deleted: true },
  ] as any[];

  const north = filterLabourSelectableForAdvance(workers, "2026-07-15", "North");
  assert.deepEqual(north.map((worker) => worker.id), ["active-1", "inactive-1", "ended", "left"]);
  assert.deepEqual(north.filter((worker) => worker.name.toLowerCase().includes("mum")).map((worker) => worker.id), ["inactive-1"]);
  assert.deepEqual(north.filter((worker) => worker.name.toLowerCase().includes("ended")).map((worker) => worker.id), ["ended"]);
});

test("online and offline advance eligibility return the same labour set", () => {
  const workers = [
    { id: "active", active: true, createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "inactive", active: false, status: "inactive", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "other", active: false, status: "temporarily_unavailable", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "ended", active: false, endedOn: "2020-01-01", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "left", active: false, leftDate: "2020-01-01", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "deactivated", active: false, endedOn: "2026-07-01", status: "deactivated", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "archived", isArchived: true, createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "deleted", deletedAt: "2026-07-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" },
  ] as any[];
  const offline = workers.filter((worker) => isLabourSelectableForAdvance(worker, "2026-07-15")).map((worker) => worker.id);
  const online = workers.filter((worker) => isLabourSelectableForAdvanceOnline(worker, "2026-07-15")).map((worker) => worker.id);
  assert.deepEqual(online, offline);
  assert.deepEqual(online, ["active", "inactive", "other", "ended", "left"]);
});
