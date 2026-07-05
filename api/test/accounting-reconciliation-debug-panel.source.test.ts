import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("temporary reconciliation debug panel is dev-only and admin-gated", () => {
  const source = readFileSync(new URL("../../web/src/components/AccountingReconciliationDebugPanel.tsx", import.meta.url), "utf8");
  const settingsSource = readFileSync(new URL("../../web/src/pages/admin/Settings.tsx", import.meta.url), "utf8");
  assert.ok(source.includes("import.meta.env.DEV"));
  assert.ok(source.includes("platform_admin"));
  assert.ok(source.includes("fetchAccountingReconciliationTrace"));
  assert.ok(source.includes("queryFn: () => fetchAccountingReconciliationTrace(token!, accountName)"));
  assert.ok(source.includes("JSON.stringify(trace.data, null, 2)"));
  assert.ok(settingsSource.includes("AccountingReconciliationDebugPanel"));
});
