import assert from "node:assert/strict";
import { test } from "node:test";
import { buildInclusiveDateKeys, chunkAttendanceDateKeys } from "../src/lib/dateOnly.ts";

test("attendance date keys preserve inclusive local calendar boundaries", () => {
  const dates = buildInclusiveDateKeys("2026-04-11", "2026-05-31");
  assert.equal(dates[0], "2026-04-11");
  assert.equal(dates.at(-1), "2026-05-31");
  assert.equal(dates.includes("2026-04-10"), false);
  assert.equal(dates.includes("2026-05-30"), true);
  assert.equal(dates.length, 51);
});

test("same-day attendance ranges create exactly one date column", () => {
  assert.deepEqual(buildInclusiveDateKeys("2026-04-10", "2026-04-10"), ["2026-04-10"]);
  assert.deepEqual(buildInclusiveDateKeys("2026-05-31", "2026-05-31"), ["2026-05-31"]);
});

test("attendance print chunks contain at most forty inclusive dates", () => {
  const fortyDays = buildInclusiveDateKeys("2026-04-10", "2026-05-19");
  assert.equal(fortyDays.length, 40);
  assert.deepEqual(chunkAttendanceDateKeys(fortyDays).map((chunk) => chunk.length), [40]);

  const fiftyOneDays = buildInclusiveDateKeys("2026-04-11", "2026-05-31");
  assert.deepEqual(chunkAttendanceDateKeys(fiftyOneDays).map((chunk) => chunk.length), [40, 11]);
});
