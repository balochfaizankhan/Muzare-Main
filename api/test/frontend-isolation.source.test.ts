import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = (relativePath: string) => readFile(new URL(`../../${relativePath}`, import.meta.url), "utf8");

test("logout and workspace switching clear IndexedDB and React Query caches", async () => {
  const auth = await source("web/src/auth/AuthProvider.tsx");
  assert.match(auth, /await clearWorkspaceCache\(\);\s+queryClient\.clear\(\);/);
  assert.match(auth, /const switchWorkspace[\s\S]*await selectWorkspace[\s\S]*await clearWorkspaceCache\(\);[\s\S]*queryClient\.clear\(\);/);
});

test("workspace queries and IndexedDB records carry workspace ownership", async () => {
  const dashboard = await source("web/src/pages/DashboardPage.tsx");
  const offlineDb = await source("web/src/lib/offline-db.ts");
  assert.match(dashboard, /queryKey: \["bootstrap", user\?\.workspaceId, sync\.farmId, sync\.seasonId\]/);
  assert.match(offlineDb, /workspaceId: string;/);
  assert.match(offlineDb, /seasonId\?: string \| null;/);
  assert.match(offlineDb, /table\.where\("workspaceId"\)\.equals\(getActiveWorkspaceId\(\)\)/);
});

test("sync queue uploads only records belonging to the active workspace farm and season", async () => {
  const sync = await source("web/src/services/syncService.ts");
  assert.match(sync, /pendingMutations\.where\("workspaceId"\)\.equals\(context\.workspaceId\)\.sortBy\("createdAt"\)/);
  assert.match(sync, /mutation\.farmId === context!\.farmId && mutation\.seasonId === context!\.seasonId/);
  assert.match(sync, /workspaceId: context\.workspaceId, farmId: mutation\.farmId/);
});

test("farm and season switching scope browser records to the selected context", async () => {
  const offlineDb = await source("web/src/lib/offline-db.ts");
  const dashboard = await source("web/src/pages/DashboardPage.tsx");
  const sync = await source("web/src/services/syncService.ts");
  assert.match(offlineDb, /record\.farmId === activeFarmId/);
  assert.match(offlineDb, /record\.seasonId === activeSeasonId/);
  assert.match(dashboard, /item\.id === query\.data\.activeFarmId/);
  assert.match(dashboard, /item\.id === query\.data\.activeSeasonId/);
  assert.match(sync, /item\.id === bootstrap\.activeFarmId/);
  assert.match(sync, /bootstrap\.activeSeasonId/);
});

test("attendance report query keys include tenant context and date range", async () => {
  const modulePage = await source("web/src/pages/ModulePage.tsx");
  assert.match(modulePage, /queryKey: \["attendance-report", workspaceId, farmId, seasonId, submitted\?\.from, submitted\?\.to, submitted\?\.labourId, submitted\?\.status\]/);
});

test("operational writes queue locally before background sync", async () => {
  const sync = await source("web/src/services/syncService.ts");
  assert.match(sync, /await queueOfflineRecord\(entity, nextRecord\);\s+if \(navigator\.onLine\) void syncPendingRecords\(\);/);
  assert.match(sync, /if \(latest\?\.updatedAt !== mutation\.updatedAt\) continue;/);
});

test("attendance marking updates local UI immediately and reuses an existing daily record", async () => {
  const modulePage = await source("web/src/pages/ModulePage.tsx");
  assert.match(modulePage, /attendance\.find\(\(entry\) =>[\s\S]*entry\.labourerId === targetLabourerId[\s\S]*entry\.date === date/);
  assert.match(modulePage, /setAttendance\(\(current\) => \[record, \.\.\.current\.filter\(\(entry\) => entry\.id !== record\.id\)\]\);\s+try \{\s+await persistOperationalRecord/);
  assert.match(modulePage, /disabled=\{markingLabourers\.has\(labourer\.id\)\}/);
});

test("mobile styles contain page overflow and keep navigation scrollable", async () => {
  const styles = await source("web/src/styles.css");
  assert.match(styles, /html,\s*body \{[\s\S]*overflow-x: hidden;/);
  assert.match(styles, /#root \{[\s\S]*overflow-x: clip;/);
  assert.match(styles, /\.app-sidebar \{[\s\S]*overflow-x: auto;/);
  assert.match(styles, /\.shell-header \.toolbar__actions \{[\s\S]*flex-wrap: wrap;/);
});

test("report modal is compact responsive and dark-mode aware", async () => {
  const modulePage = await source("web/src/pages/ModulePage.tsx");
  const styles = await source("web/src/styles.css");
  assert.match(modulePage, /aria-label="Close report"><X size=\{19\} \/><\/button>/);
  assert.match(modulePage, /attendance-report-cancel" type="button" onClick=\{onClose\}>Cancel<\/button>/);
  assert.match(modulePage, /attendance-report-generate" type="submit">Generate Report<\/button>/);
  assert.match(styles, /\.attendance-report-dialog \{[\s\S]*max-width: 600px;[\s\S]*width: min\(600px, 95vw\);/);
  assert.match(styles, /@media \(max-width: 767px\) \{[\s\S]*\.attendance-report-filters \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(styles, /@media \(prefers-color-scheme: dark\) \{[\s\S]*\.attendance-report-dialog/);
});

test("attendance report preview renders a printable register and structured exports", async () => {
  const modulePage = await source("web/src/pages/ModulePage.tsx");
  const styles = await source("web/src/styles.css");
  assert.match(modulePage, /Farm Labour Register/);
  assert.match(modulePage, /Export PDF/);
  assert.match(modulePage, /Daily payable total/);
  assert.match(modulePage, /attendanceMark\(status\)/);
  assert.match(styles, /@page \{ margin: 8mm; size: landscape; \}/);
  assert.match(styles, /\.attendance-register-table thead \{ display: table-header-group; \}/);
  assert.match(styles, /\.register-status--present \{ background: #dff2d7;/);
});

test("expense entry uses dependent searchable category selectors and grouped totals", async () => {
  const modulePage = await source("web/src/pages/ModulePage.tsx");
  assert.match(modulePage, /list="expense-category-options"/);
  assert.match(modulePage, /list="expense-subcategory-options"/);
  assert.match(modulePage, /disabled=\{!categoryId\}/);
  assert.match(modulePage, /Expenses by category/);
  assert.match(modulePage, /MANAGE_EXPENSE_CATEGORIES/);
});

test("attendance CSV import is owner-gated, online-only, and keeps register overflow inside its preview", async () => {
  const modulePage = await source("web/src/pages/ModulePage.tsx");
  const styles = await source("web/src/styles.css");
  assert.match(modulePage, /hasPermission\(user, "IMPORT_ATTENDANCE", user\.workspaceId\)/);
  assert.match(modulePage, /CSV import requires internet connection\./);
  assert.match(modulePage, /Attendance Register CSV Import/);
  assert.match(modulePage, /Import only missing records/);
  assert.match(modulePage, /Daily advances found inside date cells will be imported as separate advance records\./);
  assert.match(styles, /\.attendance-import-table-wrap \{ max-width: 100%; overflow-x: auto; \}/);
  assert.match(styles, /\.attendance-import-dialog \{[\s\S]*max-width: min\(960px, 95vw\);/);
});

test("attendance CSV confirm sends nested confirmation and blocks unresolved labour rows", async () => {
  const api = await source("web/src/lib/api.ts");
  const modulePage = await source("web/src/pages/ModulePage.tsx");
  assert.match(api, /confirmation: \{[\s\S]*warningsAccepted: input\.warningsAccepted,[\s\S]*duplicateHandlingMode: input\.duplicateHandlingMode,[\s\S]*labourMappings: input\.labourMappings/);
  assert.match(modulePage, /unresolvedLabourRows\.length > 0 \|\| summary\.errors\.length > 0 \|\| \(summary\.warnings\.length > 0 && !warningsAccepted\)/);
  assert.match(modulePage, /I understand these warnings and want to continue\./);
});
