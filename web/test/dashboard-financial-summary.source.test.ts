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
  assert.match(dashboard, /calculateScopedCashAccountBalance/);
  assert.doesNotMatch(dashboard, /calculateAvailableBalance/);
});

test("dashboard ignores mid-sync local churn and stale scope responses", () => {
  assert.match(dashboard, /window\.addEventListener\("muzare-data-refresh", scheduleDashboardRefresh\)/);
  assert.match(dashboard, /window\.addEventListener\("online", scheduleDashboardRefresh\)/);
  assert.doesNotMatch(dashboard, /window\.addEventListener\("muzare-local-data-change", scheduleDashboardRefresh\)/);
  assert.match(dashboard, /if \(requestId !== dashboardSnapshotSequence\.current \|\| financialScopeKeyRef\.current !== scopeKey\) return/);
  assert.match(helper, /if \(!input\.canonicalReady\)/);
  // The Cash Balance card was replaced by the Labour Payments Due card (see
  // dashboard-labour-payments-due.source.test.ts); it shows a skeleton instead of a "Updating..."
  // string while its snapshot isn't ready yet.
  assert.match(dashboard, /dashboard-kpi-card__skeleton--amount/);
});

test("dashboard waits for an exact workspace, farm, and season context before loading cards and exposes retry on failure", () => {
  assert.match(dashboard, /const contextReady = Boolean\(/);
  assert.match(dashboard, /syncFarmId === bootstrapFarmId/);
  assert.match(dashboard, /syncSeasonId === bootstrapSeasonId/);
  assert.match(dashboard, /queryFn: \(\{ signal \}\) => fetchBootstrap\(token!, signal\)/);
  assert.match(dashboard, /queryKey: \["bootstrap", user\?\.workspaceId\]/);
  assert.match(dashboard, /const \[resolvedContext, setResolvedContext\] = useState<DashboardScope \| null>\(null\)/);
  assert.match(dashboard, /if \(!financialScope\.workspaceId \|\| !financialScope\.farmId \|\| !financialScope\.seasonId\) \{/);
  assert.doesNotMatch(dashboard, /setTotals\(null\);\s+setActivities\(\[\]\);\s+if \(!contextReady\)/);
  assert.match(dashboard, /Dashboard data could not be loaded for the current farm and season\./);
  assert.match(dashboard, /<button className="secondary-button" type="button" onClick=\{retryDashboardLoad\}/);
});
