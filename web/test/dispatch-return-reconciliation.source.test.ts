import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function source(path: string) {
  return readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
}

test("dispatch availability caps returned cartons after sales", () => {
  const dispatchSource = source("lib/dispatch-sales.ts");
  assert.ok(dispatchSource.includes("reconcileDispatchItemQuantities"));
  assert.ok(dispatchSource.includes("const returnCapacity = Math.max(dispatched - sold, 0);"));
  assert.ok(dispatchSource.includes("const returned = Math.min(recordedReturned, returnCapacity);"));
});

test("return action refreshes current availability before persisting", () => {
  const salesSource = source("pages/workspace/Sales.tsx");
  assert.ok(salesSource.includes("loadFreshAvailabilityItem"));
  assert.ok(!salesSource.includes("button.dataset.returnBound"));
  assert.ok(salesSource.includes("cartons: current.remainingCartons"));
  assert.ok(salesSource.includes("count: current.remainingCartons"));
});

test("returned-to-farm report caps legacy oversized returns", () => {
  const reportSource = source("lib/returnedToFarmReport.ts");
  assert.ok(reportSource.includes("soldQuantityByDispatchItem"));
  assert.ok(reportSource.includes("Math.min(recordedCartons, capacity)"));
});
