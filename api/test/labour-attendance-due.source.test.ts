import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const route = readFileSync(new URL("../src/routes/labour-payments.ts", import.meta.url), "utf8");
const calculation = readFileSync(new URL("../src/lib/labour-wage-settlements.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("../../web/src/pages/workspace/WorkforcePayments.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../../web/src/App.tsx", import.meta.url), "utf8");
const hub = readFileSync(new URL("../../web/src/pages/workspace/WorkforceHub.tsx", import.meta.url), "utf8");

test("attendance and direct modes create the same canonical labour due", () => {
  assert.match(route, /dues\/attendance-preview/);
  assert.match(route, /source: z\.enum\(\["DIRECT", "ATTENDANCE_PERIOD"\]\)/);
  assert.match(route, /insert\(labourDues\)/);
  assert.match(route, /postLabourDueRecognition/);
  assert.doesNotMatch(route.slice(route.indexOf("dues/attendance-preview"), route.indexOf("dues/:dueId/settle")), /insert\(labourPaymentVouchers\)/);
});

test("attendance source locking is canonical and reversible", () => {
  assert.match(route, /labourDueId: created!\.id/);
  assert.match(route, /row\.payload\.labourDueId \|\| row\.payload\.labourWageSettlementId/);
  assert.match(route, /const \{ labourDueId: _dueId/);
});

test("group calculation includes the configured leader exactly once", () => {
  assert.match(calculation, /selectedForemanId && labourer\.id === selectedForemanId/);
  assert.match(page, /Member wage breakdown/);
  assert.match(page, /preview\.includedLabourRows\.map/);
});

test("legacy settlement creation screen is retired from navigation", () => {
  assert.doesNotMatch(app, /<LabourWageSettlements/);
  assert.match(app, /direct-due\?source=attendance&scope=group/);
  assert.match(hub, /New Labour Due/);
  assert.match(hub, /Create Attendance Due/);
});

test("review and settle loads advances only after a due opens", () => {
  const review = page.slice(page.indexOf("function ReviewSettleDialog"));
  assert.match(review, /fetchAllLabourPaymentAdvances/);
  assert.match(review, /advance\.financialScopeKey === due\.financialScopeKey/);
  assert.match(page, /pageSize: view === "dues" \? 1 : 20/);
});
