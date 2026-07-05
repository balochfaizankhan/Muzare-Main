import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("temporary reconciliation debug route is gated and linked from settings", () => {
  const source = readFileSync(new URL("../../web/src/pages/admin/AccountingReconciliationDebug.tsx", import.meta.url), "utf8");
  const helperSource = readFileSync(new URL("../../web/src/lib/reconciliationDebug.ts", import.meta.url), "utf8");
  const appSource = readFileSync(new URL("../../web/src/App.tsx", import.meta.url), "utf8");
  const settingsSource = readFileSync(new URL("../../web/src/pages/admin/Settings.tsx", import.meta.url), "utf8");
  assert.ok(helperSource.includes("VITE_APP_ENV"));
  assert.ok(helperSource.includes("VITE_ENABLE_RECONCILIATION_DEBUG"));
  assert.ok(helperSource.includes("hostname.includes(\"muzare-main-dev.onrender.com\")"));
  assert.ok(helperSource.includes("Reconciliation debug panel disabled because VITE_ENABLE_RECONCILIATION_DEBUG is not true and hostname is not recognized as dev."));
  assert.ok(source.includes("platform_admin"));
  assert.ok(source.includes("fetchAccountingReconciliationTrace"));
  assert.ok(source.includes("queryFn: () => fetchAccountingReconciliationTrace(token!, accountName)"));
  assert.ok(source.includes("JSON.stringify(trace.data, null, 2)"));
  assert.ok(appSource.includes("accounting-reconciliation-debug"));
  assert.ok(appSource.includes("/debug/accounting-reconciliation"));
  assert.ok(settingsSource.includes("Accounting Reconciliation Trace"));
});
