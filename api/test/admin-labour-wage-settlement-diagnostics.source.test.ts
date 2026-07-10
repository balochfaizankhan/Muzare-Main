import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("admin labour wage settlement diagnostics route stays read-only and registered", () => {
  const routeSource = readFileSync(new URL("../src/routes/admin-labour-wage-settlement-diagnostics.ts", import.meta.url), "utf8");
  const appSource = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
  const helperSource = readFileSync(new URL("../src/lib/labour-wage-settlement-diagnostics.ts", import.meta.url), "utf8");

  assert.ok(routeSource.includes('/v1/workspace/:workspaceId/admin/labour-wage-settlements/diagnostics'));
  assert.ok(routeSource.includes("preHandler: requireUser"));
  assert.ok(routeSource.includes("platform_admin"));
  assert.ok(routeSource.includes("workspace_owner"));
  assert.ok(appSource.includes("adminLabourWageSettlementDiagnosticsRoutes"));
  assert.ok(helperSource.includes("nameOnlyCandidates"));
  assert.ok(helperSource.includes("resolveLabourWageSettlementDiagnosticsFarmId"));
  assert.ok(helperSource.includes("normalizeDiagnosticsScopeId"));
  assert.ok(routeSource.includes("SETTLEMENT_DIAGNOSTICS_FARM_SCOPE_MISSING"));
  assert.ok(routeSource.includes("eq(accountTransactions.farmId, resolvedFarmId)"));
  assert.ok(!routeSource.includes("repairPostedSettlementAccounting"));
  assert.ok(!routeSource.includes("tx.insert("));
  assert.ok(!routeSource.includes("tx.update("));
  assert.ok(!routeSource.includes("tx.delete("));
  assert.ok(!routeSource.includes("db.insert("));
  assert.ok(!routeSource.includes("db.update("));
  assert.ok(!routeSource.includes("db.delete("));
  assert.ok(!routeSource.includes('farmId, settlementRow?.farmId ?? settlementRows[0]?.farmId ?? ""'));
  assert.ok(!helperSource.includes("resolveAccountIdentity("));
  assert.ok(!helperSource.includes("fallbackName"));
});
