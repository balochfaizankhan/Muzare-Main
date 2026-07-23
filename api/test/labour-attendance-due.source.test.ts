import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const route = readFileSync(new URL("../src/routes/labour-payments.ts", import.meta.url), "utf8");
const settlementRoutes = readFileSync(new URL("../src/routes/labour-wage-settlements.ts", import.meta.url), "utf8");
const lib = readFileSync(new URL("../src/lib/labour-payments.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("../../web/src/pages/workspace/WorkforcePayments.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../../web/src/App.tsx", import.meta.url), "utf8");
const groupsPage = readFileSync(new URL("../../web/src/pages/workspace/LabourGroups.tsx", import.meta.url), "utf8");
const migration = readFileSync(new URL("../../database/migrations/0046_group_advance_pools_and_attendance_due_retirement.sql", import.meta.url), "utf8");

const RETIREMENT_MESSAGE = "Attendance-based Labour Dues are no longer supported. Create a direct labour group due instead.";

test("ATTENDANCE_PERIOD is rejected for new API requests with the exact business message, never silently converted", () => {
  assert.match(lib, /export const ATTENDANCE_DUES_RETIRED_MESSAGE = "Attendance-based Labour Dues are no longer supported\. Create a direct labour group due instead\.";/);
  assert.match(route, /source: z\.enum\(\["DIRECT", "ATTENDANCE_PERIOD"\]\)/, "the schema still accepts the value so old clients get the clear error, not a parse failure");
  assert.match(route, /if \(input\.source === "ATTENDANCE_PERIOD"\)\s*\n\s*return reply\.code\(400\)\.send\(\{ message: ATTENDANCE_DUES_RETIRED_MESSAGE/);
  assert.equal(route.includes(RETIREMENT_MESSAGE) || lib.includes(RETIREMENT_MESSAGE), true);
});

test("the attendance-due preview endpoint can no longer calculate or seed a financial due", () => {
  const previewStart = route.indexOf("dues/attendance-preview");
  const previewRoute = route.slice(previewStart, route.indexOf('"/v1/workspace/:workspaceId/labour-payments/dues"', previewStart));
  assert.match(previewRoute, /ATTENDANCE_DUES_RETIRED_MESSAGE/);
  assert.doesNotMatch(previewRoute, /previewLabourWageSettlement/);
});

test("new due creation is always DIRECT: no attendance calculation, no member snapshots, no attendance locking", () => {
  const createStart = route.indexOf('"/v1/workspace/:workspaceId/labour-payments/dues"');
  const createRoute = route.slice(createStart, route.indexOf('"/v1/workspace/:workspaceId/labour-payments/dues/:dueId/advance-pool"'));
  assert.match(createRoute, /origin: "DIRECT"/);
  assert.match(createRoute, /settlementBasis: "MANUAL"/);
  assert.match(createRoute, /postLabourDueRecognition/);
  assert.doesNotMatch(createRoute, /previewLabourWageSettlement|includedLabourRows|sourceAttendanceIds|labourDueMemberSnapshots|labourDueAttendanceSources/);
  assert.doesNotMatch(createRoute, /jsonb_build_object\('labourDueId'/, "new attendance records must never be financially locked for due creation");
});

test("the attendance wage-settlement creation flow is retired while historical settlement routes remain", () => {
  assert.match(settlementRoutes, /app\.post\("\/v1\/workspace\/:workspaceId\/labour-wage-settlements\/preview"[\s\S]{0,400}ATTENDANCE_DUES_RETIRED_MESSAGE/);
  assert.match(settlementRoutes, /app\.post\("\/v1\/workspace\/:workspaceId\/labour-wage-settlements"[\s\S]{0,700}ATTENDANCE_DUES_RETIRED_MESSAGE/);
  assert.match(settlementRoutes, /app\.patch\("\/v1\/workspace\/:workspaceId\/labour-wage-settlements\/:settlementId"[\s\S]{0,600}ATTENDANCE_DUES_RETIRED_MESSAGE/);
  // Historical compatibility: read, void, delete and accounting repair stay.
  assert.match(settlementRoutes, /app\.get\("\/v1\/workspace\/:workspaceId\/labour-wage-settlements"/);
  assert.match(settlementRoutes, /app\.post\("\/v1\/workspace\/:workspaceId\/labour-wage-settlements\/:settlementId\/void"/);
  assert.match(settlementRoutes, /app\.post\("\/v1\/workspace\/:workspaceId\/labour-wage-settlements\/:settlementId\/repair-accounting"/);
  assert.match(settlementRoutes, /app\.delete\("\/v1\/workspace\/:workspaceId\/labour-wage-settlements\/:settlementId"/);
});

test("queued attendance-due creation requests are parked for review by migration 0046, never posted", () => {
  assert.match(migration, /UPDATE labour_wage_settlement_create_requests\s*\nSET state = 'rolled_back',\s*\n\s*stage = 'attendance_dues_retired',/);
  assert.match(migration, /WHERE state NOT IN \('committed', 'already_created', 'rolled_back', 'failed'\);/);
});

test("historical attendance dues stay visible, payable and reversible", () => {
  // The Due Payments selector still accepts settlement-origin dues backed by
  // an active historical settlement record.
  assert.match(lib, /row\.origin !== "SETTLEMENT"/);
  assert.match(lib, /activeSettlementSourceIds\.has\(row\.sourceRecordId!\)/);
  // The admin integrity tooling for historical attendance links is untouched.
  assert.match(route, /\/v1\/admin\/labour-due-attendance-integrity/);
  assert.match(route, /payload-'labourDueId'-'labourDueNumber'-'labourDueLockedAt'/);
});

test("no active UI contains a create-due-from-attendance control", () => {
  for (const sourceText of [page, app, groupsPage]) {
    assert.doesNotMatch(sourceText, /source=attendance/);
  }
  assert.doesNotMatch(page, /attendancePeriodTab|previewAttendanceWages|attendanceCalculationPreviewAria|previewLabourAttendanceDue/);
  assert.doesNotMatch(page, /workforcePaymentsPage\.attendanceDue"/);
  // The due form is direct-only: no source tablist remains, visible or hidden.
  assert.doesNotMatch(page, /workforce-due-source/);
  assert.match(page, /source: "DIRECT"/);
});

test("attendance itself remains an independent operational module", () => {
  // The attendance import pipeline and attendance reports are untouched by
  // the retirement: they never created dues and still exist.
  const attendanceImports = readFileSync(new URL("../src/routes/attendance-imports.ts", import.meta.url), "utf8");
  assert.doesNotMatch(attendanceImports, /labourDues|ensureSettlementLabourDue/);
  const attendanceReport = readFileSync(new URL("../src/routes/attendance-report.ts", import.meta.url), "utf8");
  assert.ok(attendanceReport.length > 0);
});
