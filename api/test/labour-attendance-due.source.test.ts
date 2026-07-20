import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const route = readFileSync(new URL("../src/routes/labour-payments.ts", import.meta.url), "utf8");
const calculation = readFileSync(new URL("../src/lib/labour-wage-settlements.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("../../web/src/pages/workspace/WorkforcePayments.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../../web/src/App.tsx", import.meta.url), "utf8");
const hub = readFileSync(new URL("../../web/src/pages/workspace/WorkforceHub.tsx", import.meta.url), "utf8");
const migration = readFileSync(new URL("../../database/migrations/0038_labour_due_attendance_sources.sql", import.meta.url), "utf8");

test("attendance and direct modes create the same canonical labour due", () => {
  assert.match(route, /dues\/attendance-preview/);
  assert.match(route, /source: z\.enum\(\["DIRECT", "ATTENDANCE_PERIOD"\]\)/);
  assert.match(route, /insert\(labourDues\)/);
  assert.match(route, /postLabourDueRecognition/);
  assert.doesNotMatch(route.slice(route.indexOf("dues/attendance-preview"), route.indexOf("dues/:dueId/settle")), /insert\(labourPaymentVouchers\)/);
});

test("attendance source locking is canonical and reversible", () => {
  assert.match(route, /jsonb_build_object\('labourDueId', \$\{created!\.id\}/);
  assert.match(route, /FROM labour_due_attendance_sources s/);
  assert.match(route, /JOIN labour_dues d ON d\.id = s\.due_id/);
  assert.match(route, /payload = payload - 'labourDueId' - 'labourDueNumber' - 'labourDueLockedAt'/);
});

test("canonical attendance dues are visible without a legacy settlement source", () => {
  assert.match(route, /\(!row\.legacy && !row\.sourceRecordId\)/);
  assert.match(route, /"UNPAID",\s*"PARTIALLY_SETTLED",\s*"ON_HOLD"/);
});

test("used attendance reports its valid owner and orphan flags require repair", () => {
  assert.match(route, /excludedOwners/);
  assert.match(route, /orphanedAttendanceCount/);
  assert.match(page, /View labour due/);
  assert.match(page, /No eligible attendance remains for this period/);
  assert.match(page, /preview\.grossWages <= 0/);
});

test("admin integrity repair is scoped and idempotently clears only ownerless due flags", () => {
  assert.match(route, /\/v1\/admin\/labour-due-attendance-integrity/);
  assert.match(route, /preHandler: requireAdmin/);
  assert.match(route, /NOT EXISTS \([\s\S]*labour_due_attendance_sources/);
  assert.match(route, /payload-'labourDueId'-'labourDueNumber'-'labourDueLockedAt'/);
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
  assert.doesNotMatch(hub, /Create Attendance Due/);
  assert.match(hub, /Due → Review → Apply advance or pay → Post/);
});

test("review and settle loads the eligible pool only after a due opens", () => {
  const review = page.slice(page.indexOf("function ReviewSettleDialog"));
  assert.match(review, /fetchLabourDueAdvancePool/);
  assert.doesNotMatch(review, /fetchAllLabourPaymentAdvances/);
  assert.match(review, /Total available for this due/);
  assert.match(page, /fetchLabourPaymentAdvances\(token, workspaceId, farmId, seasonId, \{ pageSize: 1, status: "OPEN" \}\)/);
  assert.match(page, /if \(view === "advances" \|\| view === "direct"\) return/);
});

test("attendance due persistence is set-based and database-enforced", () => {
  assert.match(route, /insert\(labourDueMemberSnapshots\)\.values\(attendancePreview\.includedLabourRows\.map/);
  assert.match(route, /insert\(labourDueAttendanceSources\)\.values\(sourceRows\.map/);
  assert.match(route, /UPDATE operational_records SET payload = payload \|\| jsonb_build_object/);
  assert.doesNotMatch(route, /for \(const row of attendanceRows\).*tx\.update/s);
  assert.match(migration, /UNIQUE \(workspace_id, attendance_record_id\)/);
  assert.match(migration, /REFERENCES labour_dues\(id\) ON DELETE CASCADE/);
});

test("create success is released before background route refresh", () => {
  const form = page.slice(page.indexOf("function DirectDueForm"), page.indexOf("function VoucherRegister"));
  assert.match(form, /setSaving\(false\);[\s\S]*onSaved\(/);
  assert.doesNotMatch(form, /await onSaved/);
  assert.match(form, /timeoutMs: 45_000|createDirectLabourDue/);
});

test("attendance creation does not invoke settlement posting or advance loading", () => {
  const createStart = route.indexOf('app.post(\n    "/v1/workspace/:workspaceId/labour-payments/dues",');
  const createRoute = route.slice(createStart, route.indexOf('app.post(\n    "/v1/workspace/:workspaceId/labour-payments/dues/:dueId/settle"'));
  assert.doesNotMatch(createRoute, /labourWageSettlements|resolveLabourAdvanceLedger|labourPaymentVouchers/);
  assert.match(createRoute, /postLabourDueRecognition/);
  assert.match(createRoute, /db\.transaction/);
});
