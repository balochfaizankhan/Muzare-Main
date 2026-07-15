import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("labour wage settlement diagnostics are not exposed in the production PWA", () => {
  const pageSource = readFileSync(new URL("../src/pages/workspace/LabourWageSettlements.tsx", import.meta.url), "utf8");
  const apiSource = readFileSync(new URL("../src/lib/api.ts", import.meta.url), "utf8");

  const previewStart = pageSource.indexOf("Settlement preview");
  const formEnd = pageSource.lastIndexOf("</form>", previewStart);
  assert.ok(formEnd >= 0);
  assert.ok(previewStart > formEnd);
  assert.match(
    pageSource.slice(formEnd + "</form>".length, previewStart),
    /^\s*<\/section>\s*<section className="record-panel labour-settlement-preview-panel">\s*<div className="advances-heading">\s*<h2>$/,
  );

  assert.ok(!pageSource.includes("Admin diagnostics - read only"));
  assert.ok(!pageSource.includes("Run Read-Only Diagnostics"));
  assert.ok(!pageSource.includes("Copy Diagnostic JSON"));
  assert.ok(!pageSource.includes("fetchLabourWageSettlementDiagnostics"));
  assert.ok(!pageSource.includes("diagnosticsSettlementNumber"));
  assert.ok(!pageSource.includes("navigator.clipboard.writeText"));
  assert.ok(!apiSource.includes("LabourWageSettlementDiagnostics"));
  assert.ok(!apiSource.includes("labour-wage-settlement-diagnostics"));
  assert.ok(!apiSource.includes("/admin/labour-wage-settlements/diagnostics"));

  assert.ok(pageSource.includes("previewLabourWageSettlement"));
  assert.ok(pageSource.includes("createLabourWageSettlement"));
  assert.ok(pageSource.includes("openSettlement(settlement)"));
  assert.ok(pageSource.includes("onClick={() => window.print()}"));
  assert.ok(pageSource.includes("onClick={exportRegister}"));
  assert.ok(pageSource.includes("Labour settlement register"));
});
