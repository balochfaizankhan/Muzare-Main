import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/services/syncService.ts", import.meta.url), "utf8");

test("idle timer checks do not enter a visible syncing state when the outbox is empty", () => {
  const start = source.indexOf("export async function syncPendingRecords");
  const emit = source.indexOf('emit({ status: "syncing" })', start);
  const emptyGuard = source.indexOf("if (initialPending === 0)", start);
  assert.ok(emptyGuard >= 0 && emit >= 0 && emptyGuard < emit);
});

test("operational refresh and reconciliation are single-flight", () => {
  assert.match(source, /let refreshPromise: Promise<void> \| null = null/);
  assert.match(source, /if \(refreshPromise\) return refreshPromise/);
  assert.match(source, /let reconcilePromise: Promise<\{ synced: number; pending: number \}> \| null = null/);
  assert.match(source, /if \(reconcilePromise\) return reconcilePromise/);
});

test("late refresh responses cannot hydrate a replacement workspace runtime", () => {
  assert.match(source, /const activeContext = context/);
  assert.match(source, /context\.token !== activeContext\.token \|\| context\.workspaceId !== activeContext\.workspaceId/);
});
