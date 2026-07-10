import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("labour wage settlement diagnostics UI is admin/owner-only and read-only", () => {
  const pageSource = readFileSync(new URL("../src/pages/workspace/LabourWageSettlements.tsx", import.meta.url), "utf8");
  const apiSource = readFileSync(new URL("../src/lib/api.ts", import.meta.url), "utf8");

  const panelStart = pageSource.indexOf("Admin diagnostics - read only");
  const previewStart = pageSource.indexOf("Settlement preview");
  assert.ok(panelStart >= 0);
  assert.ok(previewStart > panelStart);
  const panelBlock = pageSource.slice(panelStart, previewStart);

  assert.ok(panelBlock.includes("Run Read-Only Diagnostics"));
  assert.ok(panelBlock.includes("Copy Diagnostic JSON"));
  assert.ok(!panelBlock.includes("repairLabourWageSettlementAccounting"));
  assert.ok(!panelBlock.includes("createLabourWageSettlement"));
  assert.ok(!panelBlock.includes("voidLabourWageSettlement"));
  assert.ok(!panelBlock.includes("updateLabourWageSettlement"));
  assert.ok(!panelBlock.includes("deleteLabourWageSettlement"));
  assert.ok(!panelBlock.includes("fetchLabourWageSettlementCreateStatus"));
  assert.ok(!panelBlock.includes("tokenKey"));
  assert.ok(!panelBlock.includes("cookie"));

  assert.ok(apiSource.includes("labour-wage-settlement-diagnostics"));
  assert.ok(apiSource.includes("/admin/labour-wage-settlements/diagnostics"));
  assert.ok(apiSource.includes("fetchLabourWageSettlementDiagnostics"));
  assert.ok(pageSource.includes("fetchLabourWageSettlementDiagnostics"));
  assert.ok(pageSource.includes("settlementNumber: diagnosticsSettlementNumber.trim()"));
  assert.ok(!pageSource.includes("farmId: diagnosticsSettlementNumber"));
  assert.ok(!pageSource.includes("seasonId: diagnosticsSettlementNumber"));
  assert.ok(pageSource.includes("platform_admin"));
  assert.ok(pageSource.includes("workspace_owner"));
  assert.ok(pageSource.includes("navigator.clipboard.writeText"));
});
