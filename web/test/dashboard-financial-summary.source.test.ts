import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const dashboard = readFileSync(new URL("../src/pages/DashboardPage.tsx", import.meta.url), "utf8");
const helper = readFileSync(new URL("../src/lib/dashboardFinancialSnapshot.ts", import.meta.url), "utf8");

test("dashboard financial cards now use one settled snapshot contract", () => {
  assert.match(helper, /snapshotVersion: string/);
  assert.match(helper, /generatedAt: string/);
  assert.match(helper, /cashBalance: number/);
  assert.match(helper, /totalExpenses: number/);
  assert.match(helper, /outstandingLabourAdvances: number/);
  assert.match(dashboard, /setFinancialSnapshot\(nextFinancialSnapshot\)/);
  assert.match(dashboard, /dashboardFinancialSnapshotStorageKey/);
  assert.match(dashboard, /financialSnapshotRef\.current/);
});

test("dashboard ignores mid-sync local churn and stale scope responses", () => {
  assert.match(dashboard, /window\.addEventListener\("muzare-data-refresh", scheduleDashboardRefresh\)/);
  assert.doesNotMatch(dashboard, /window\.addEventListener\("muzare-local-data-change", scheduleDashboardRefresh\)/);
  assert.match(dashboard, /if \(requestId !== dashboardSnapshotSequence\.current \|\| financialScopeKeyRef\.current !== scopeKey\) return/);
  assert.match(helper, /if \(!input\.canonicalReady\)/);
});
