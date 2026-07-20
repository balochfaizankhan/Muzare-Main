import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const route = readFileSync(new URL("../src/routes/labour-reconciliation.ts", import.meta.url), "utf8");
const syncRoute = readFileSync(new URL("../src/routes/operational-sync.ts", import.meta.url), "utf8");
const paymentsRoute = readFileSync(new URL("../src/routes/labour-payments.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../../database/migrations/0037_labour_data_cleanup.sql", import.meta.url), "utf8");
const ui = readFileSync(new URL("../../web/src/pages/workspace/LabourReconciliation.tsx", import.meta.url), "utf8");

test("legacy earnings and settlement history are authoritative paginated queries", () => {
  assert.match(route, /entity_type='labourEarning'/);
  assert.match(route, /entity_type='labourWageSettlement'/);
  assert.match(route, /LEFT JOIN people/);
  assert.match(route, /LEFT JOIN LATERAL/);
  assert.match(route, /LIMIT \$\{query\.pageSize\} OFFSET/);
  assert.match(route, /count\(\*\) OVER\(\)/);
  assert.match(route, /MISSING_RECIPIENT/);
  assert.match(route, /ORPHANED/);
  assert.match(route, /DUPLICATE_CANDIDATE/);
});

test("cleanup preview is server-side and distinguishes unlock, cascade, remain, and blocking dependencies", () => {
  assert.match(route, /cleanup\/preview/);
  for (const state of ["WILL_DELETE", "WILL_UNLOCK", "WILL_REMAIN", "BLOCKS_DELETION", "REQUIRES_CASCADE"]) assert.match(route, new RegExp(state));
  assert.match(route, /sharedVoucherIds/);
  assert.match(route, /A payment voucher also allocates to an unrelated due/);
  assert.match(route, /Attendance is preserved and unlocked/);
  assert.match(route, /Original advance vouchers and their original cash\/account effects remain/);
});

test("hard cleanup is permission-gated, explicitly confirmed, locked, and atomic", () => {
  assert.match(route, /hasModulePermission\(request\.appUser, workspaceId, "wages", action\)/);
  assert.match(route, /db\.transaction/);
  assert.match(route, /pg_advisory_xact_lock/);
  assert.match(route, /DELETE LABOUR DATA/);
  assert.match(route, /DELETE FINANCIAL HISTORY/);
  assert.match(route, /SOURCE_ONLY/);
  assert.match(route, /FULL_CASCADE/);
});

test("full cascade removes the normalized chain in dependency order and restores source eligibility", () => {
  const accounting = route.indexOf("tx.delete(labourAccountingEntries)");
  const allocations = route.indexOf("tx.delete(labourPaymentAllocations)");
  const vouchers = route.indexOf("tx.delete(labourPaymentVouchers)");
  const dues = route.indexOf("tx.delete(labourDues)");
  const sources = route.indexOf("tx.delete(operationalRecords)");
  assert.ok(accounting < allocations && allocations < vouchers && vouchers < dues && dues < sources);
  assert.match(route, /status:"pending_settlement"/);
  assert.match(route, /linkedSettlementId:null/);
  assert.match(route, /labourWageSettlementAdvanceAllocations/);
  assert.match(route, /labourWageSettlementCreateRequests/);
});

test("hard-deleted sources cannot return through sync or migration backfill", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS labour_cleanup_tombstones/);
  assert.match(migration, /UNIQUE \(workspace_id, entity_type, client_record_id\)/);
  assert.match(syncRoute, /labour_cleanup_tombstone/);
  assert.match(syncRoute, /code\(410\)/);
  assert.match(route, /tx\.insert\(labourCleanupTombstones\)/);
});

test("cleanup keeps an immutable trace without recreating financial business records", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS labour_cleanup_logs/);
  assert.match(migration, /cleanup_batch_id/);
  assert.match(migration, /account_effects_removed/);
  assert.match(migration, /advances_restored/);
  assert.match(route, /tx\.insert\(labourCleanupLogs\)/);
});

test("bulk selection is resolved by the server and the UI does not pretend a loaded page is all results", () => {
  assert.match(route, /cleanup\/selection/);
  assert.match(route, /SOURCE_ONLY_ELIGIBLE/);
  assert.match(route, /LIMIT 5000/);
  assert.match(ui, /All matching filters/);
  assert.match(ui, /Current page/);
  assert.match(ui, /More than 5,000 records match/);
});

test("history UI lazy-loads one server page, aborts stale requests, and exposes distinct error and empty states", () => {
  assert.match(ui, /pageSize=window\.matchMedia/);
  assert.match(ui, /new AbortController/);
  assert.match(ui, /controller\.abort/);
  assert.match(ui, /Settlement history could not be loaded/);
  assert.match(ui, /error\?null:requestSucceeded&&!rows\.length/);
  assert.match(ui, /No settlement history yet/);
  assert.match(ui, /No settlements match these filters/);
  assert.match(ui, /loading\|\|!summary\?"—"/);
  assert.doesNotMatch(ui, /Selection unavailable/);
  assert.match(ui, /Clear filters/);
  assert.match(ui, /Preview deletion/);
});

test("settlement selection uses canonical database ids and preview errors preserve the loaded list", () => {
  assert.match(route, /SELECT r\.id/);
  assert.match(route, /eq\(operationalRecords\.id,target\.id\)/);
  assert.match(ui, /selected\.has\(row\.recordId\)/);
  assert.match(ui, /rows\.map\(\(row\)=>row\.recordId\)/);
  assert.match(ui, /\[\.\.\.selected\]\.map\(\(id\)=>\(\{entityType:mode,id\}/);
  assert.match(ui, /setPreviewError/);
  assert.doesNotMatch(ui.slice(ui.indexOf("const openPreview"),ui.indexOf("const selectMatching")), /setError\(/);
  assert.match(ui, /The settlement records remain selected/);
  assert.match(ui, />Retry<\/button>/);
  assert.match(ui, /requestSucceeded\?<div className="reconciliation-list"/);
});

test("cleanup preview is null-safe and returns a classification for every selected settlement", () => {
  assert.match(route, /rowDues=dues\.filter/);
  assert.match(route, /recipient:.*\|\|null/);
  assert.match(route, /classification:rowBlocked\?"BLOCKED":rowCascade\?"CASCADE_REQUIRED"/);
  assert.match(route, /linkedDue:rowDues\[0\]\?\.dueNumber\?\?null/);
  assert.match(route, /blockers:rowBlocked/);
  assert.match(route, /preview\.targets\.length!==new Set/);
});

test("preview and deletion have independent loading and error states", () => {
  for(const state of ["previewLoading","previewError","deleting","deletionError","deletionSuccess"]) assert.match(ui,new RegExp(state));
  assert.match(ui, /Review settlement deletion/);
  assert.match(ui, /Delete eligible records/);
  assert.match(ui, /Confirm cascade deletion/);
  assert.match(ui, /Recipient unavailable/);
});

test("settlement history uses compatible accounting types and a duplicate-safe optional due join", () => {
  assert.match(route, /atx\.reference_id::text=s\.client_record_id/);
  assert.doesNotMatch(route, /atx\.reference_id=s\.client_record_id/);
  assert.match(route, /candidate\.workspace_id=s\.workspace_id/);
  assert.match(route, /LIMIT 1/);
  assert.match(route, /settlement_status='reversed' THEN 'REVERSED'/);
  assert.match(route, /s\.farm_id=\$\{query\.farmId\}::uuid OR s\.farm_id IS NULL/);
  assert.match(route, /s\.season_id=\$\{query\.seasonId\}::uuid OR s\.season_id IS NULL/);
});

test("current and legacy classification filters are explicit while blank filters remain omitted", () => {
  assert.match(route, /'CURRENT' AND source_type IS NULL/);
  assert.match(route, /'LEGACY' AND source_type IS NOT NULL/);
  assert.match(ui, /<option value="">Current and legacy<\/option>/);
  assert.match(ui, /<option value="LEGACY">Legacy<\/option>/);
  assert.match(ui, /from:from\|\|undefined,to:to\|\|undefined/);
});

test("Payments Due excludes voided, reversed, deleted, and orphaned settlement sources", () => {
  assert.match(paymentsRoute, /validSettlementSources/);
  assert.match(paymentsRoute, /\["voided", "deleted", "reversed"\]/);
  assert.match(paymentsRoute, /row\.origin !== "SETTLEMENT"/);
});
