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
  assert.match(modulePage, /queryKey: \["attendance-report", workspaceId, farmId, seasonId, submitted\?\.from, submitted\?\.to, submitted\?\.labourIds\?\.join\(","\), submitted\?\.status\]/);
});

test("operational writes queue locally before background sync", async () => {
  const sync = await source("web/src/services/syncService.ts");
  assert.match(sync, /await queueOfflineRecord\(entity, nextRecord\);\s+if \(navigator\.onLine\) void syncPendingRecords\(\);/);
  assert.match(sync, /if \(latest\?\.updatedAt !== mutation\.updatedAt\) continue;/);
});

test("CORS uses ALLOWED_ORIGINS and Sync Now backs off without uploading an empty queue", async () => {
  const config = await source("api/src/config.ts");
  const app = await source("api/src/app.ts");
  const sync = await source("web/src/services/syncService.ts");
  assert.match(config, /ALLOWED_ORIGINS: z\.string\(\)\.default\("http:\/\/localhost:5173"\)/);
  assert.doesNotMatch(config, /FRONTEND_ORIGINS/);
  assert.match(app, /app\.log\.info\(\{ allowedOrigins \}, "CORS allowed origins"\)/);
  assert.match(app, /app\.log\.info\(\{ origin: origin \?\? null, allowed \}, "CORS origin check"\)/);
  assert.match(app, /methods: corsMethods,[\s\S]*allowedHeaders: corsHeaders,[\s\S]*credentials: false/);
  assert.match(sync, /const maxAutomaticAttempts = 3;/);
  assert.match(sync, /nextAttemptAt: new Date\(Date\.now\(\) \+ 1_000 \* 2 \*\* \(attempts - 1\)\)\.toISOString\(\)/);
  assert.match(sync, /if \(\(await getPendingCount\(\)\) === 0\) \{[\s\S]*await refreshOperationalData\(\{ notifySuccess: false \}\);[\s\S]*notify\("Database synchronized\."\)/);
});

test("attendance marking updates local UI immediately, reuses a daily record, and toggles the active status off", async () => {
  const modulePage = await source("web/src/pages/ModulePage.tsx");
  const sync = await source("web/src/services/syncService.ts");
  const api = await source("web/src/lib/api.ts");
  assert.match(modulePage, /attendance\.find\(\(entry\) =>[\s\S]*entry\.labourerId === targetLabourerId[\s\S]*entry\.date === date/);
  assert.match(modulePage, /if \(existing\?\.status === status\) \{[\s\S]*setAttendance\(\(current\) => current\.filter\(\(entry\) => entry\.id !== existing\.id\)\);[\s\S]*await deleteOperationalRecord\("attendance", existing\);/);
  assert.match(modulePage, /setAttendance\(\(current\) => \[record, \.\.\.current\.filter\(\(entry\) => entry\.id !== record\.id\)\]\);\s+await persistOperationalRecord/);
  assert.match(modulePage, /disabled=\{!markable \|\| markingLabourers\.has\(labourer\.id\)\}/);
  assert.match(sync, /operation: "delete"/);
  assert.match(sync, /if \(mutation\.operation === "delete"\) \{[\s\S]*await deleteOperationalRecordFromApi/);
  assert.match(sync, /pendingDeletes\.has\(`\$\{context\.workspaceId\}:\$\{item\.entity\}:\$\{item\.record\.id\}`\)/);
  assert.match(api, /apiRequest<void>\("\/v1\/workspace\/operational-records", \{ method: "DELETE"/);
});

test("partner ledger supports audited edits and offline soft deletes without duplicate balance effects", async () => {
  const route = await source("api/src/routes/operational-sync.ts");
  const modulePage = await source("web/src/pages/ModulePage.tsx");
  const offlineDb = await source("web/src/lib/offline-db.ts");
  const sync = await source("web/src/services/syncService.ts");
  assert.match(route, /action: "partner_ledger_updated"/);
  assert.match(route, /action: "partner_ledger_deleted"/);
  assert.match(route, /deletedAt: deletedAt\.toISOString\(\), deletedBy: request\.appUser\.id, deletionReason/);
  assert.match(route, /hasPermission\(request\.appUser, "MANAGE_RECORDS", parsed\.data\.workspaceId\)/);
  assert.match(offlineDb, /options\.includeDeleted \|\| !record\.deletedAt/);
  assert.match(sync, /entity === "partnerEntry" \? \{ \.\.\.record, deletedAt: queuedAt, pendingSync: true \}/);
  assert.match(modulePage, /Show deleted/);
  assert.match(modulePage, /Partner ledger entry deleted successfully\./);
  assert.match(modulePage, /actions=\{visibleEntries\.map/);
});

test("partner settlements transfer matching account and partner positions without changing business totals", async () => {
  const route = await source("api/src/routes/operational-sync.ts");
  const modulePage = await source("web/src/pages/ModulePage.tsx");
  const dashboard = await source("web/src/pages/DashboardPage.tsx");
  const offlineDb = await source("web/src/lib/offline-db.ts");
  const accounting = await source("web/src/lib/accounting.ts");
  assert.match(route, /type: z\.literal\("settlement"\)/);
  assert.match(route, /record\.fromPartner\.toLowerCase\(\) !== record\.toPartner\.toLowerCase\(\)/);
  assert.match(offlineDb, /type: "contribution" \| "withdrawal" \| "settlement"/);
  assert.match(accounting, /export function partnerSettlementEffect\(entry: PartnerEntry, partnerName: string\): number/);
  assert.match(accounting, /normalizedName\(entry\.toPartner\) === accountName \? entry\.amount : 0/);
  assert.match(accounting, /normalizedName\(entry\.fromPartner\) === accountName \? entry\.amount : 0/);
  assert.match(accounting, /accounts\.reduce\(\(sum, account\) => sum \+ calculateAccountBalance\(account, sales, vouchers, advances, entries\), 0\)/);
  assert.match(modulePage, /const balance = \(account: Account\) => calculateAccountBalance\(account, sales, vouchers, advances, entries\)/);
  assert.match(modulePage, /position\(entry\.fromPartner!\)\.settlementsSent \+= entry\.amount/);
  assert.match(modulePage, /position\(entry\.toPartner!\)\.settlementsReceived \+= entry\.amount/);
  assert.match(modulePage, /<option value="settlement">Partner Settlement<\/option>/);
  assert.match(modulePage, /<option value="settlement">Settlements<\/option>/);
  assert.match(dashboard, /item\.type === "withdrawal" \? -item\.amount : 0/);
  assert.match(dashboard, /netPosition: calculateAvailableBalance\(accounts, sales, vouchers, advances, entries\)/);
});

test("attendance labour directory loads cache-first and keeps cached data during API outages", async () => {
  const auth = await source("web/src/auth/AuthProvider.tsx");
  const sync = await source("web/src/services/syncService.ts");
  const modulePage = await source("web/src/pages/ModulePage.tsx");
  assert.match(auth, /if \(!\(error instanceof ApiError && \[401, 403\]\.includes\(error\.status\)\) && cachedUser\(\)\) \{[\s\S]*setUser\(cachedUser\(\)\);[\s\S]*return;/);
  assert.match(sync, /const cached = restoreOperationalContext\(workspaceId\);\s+applyOperationalContext\(token, workspaceId, cached\?\.farmId, cached\?\.seasonId\);/);
  assert.match(sync, /dataSource: "cache"/);
  assert.match(sync, /await cacheRecord\(item\.entity, item\.record, false,[\s\S]*if \(result\.snapshotConfirmed && result\.farmId === context\.farmId && result\.seasonId === context\.seasonId\) \{\s+await pruneSynchronizedCache\(result\.records\);/);
  assert.match(sync, /item\.farmId === context!\.farmId && \(item\.seasonId === context!\.seasonId \|\| item\.seasonId == null\)/);
  assert.match(modulePage, /Offline mode: showing cached labour\. Attendance will sync later\./);
  assert.match(modulePage, /No labour list is saved on this device\. Connect once to sync labour\./);
  assert.match(modulePage, /Last synced: \{readableSyncTime\(sync\.lastSyncTime\)\}/);
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
  assert.match(modulePage, /aria-label=\{t\("reports\.closeReport"\)\}><X size=\{19\} \/><\/button>/);
  assert.match(modulePage, /attendance-report-cancel" type="button" onClick=\{onClose\}/);
  assert.match(modulePage, /attendance-report-generate" type="submit"/);
  assert.match(styles, /\.attendance-report-dialog \{[\s\S]*max-width: 600px;[\s\S]*width: min\(600px, 95vw\);/);
  assert.match(styles, /@media \(max-width: 767px\) \{[\s\S]*\.attendance-report-filters \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(styles, /\.attendance-report-header/);
});

test("attendance report preview renders a printable register and structured exports", async () => {
  const modulePage = await source("web/src/pages/ModulePage.tsx");
  const styles = await source("web/src/styles.css");
  assert.match(modulePage, /t\("reports\.farmLabourRegister"\)/);
  assert.match(modulePage, /t\("reports\.exportPdf"\)/);
  assert.match(modulePage, /Daily payable total/);
  assert.match(modulePage, /attendanceMark\(status\)/);
  assert.match(modulePage, /Adv \(SAR\)/);
  assert.match(modulePage, /Wages \(SAR\)/);
  assert.match(modulePage, /Net \(SAR\)/);
  assert.match(modulePage, /className="print-summary"/);
  assert.match(modulePage, /compactDate\(date\)/);
  assert.match(modulePage, /compactAdvance\(advance\)/);
  assert.match(modulePage, /t\("reports\.printRangeWarning"\)/);
  assert.match(styles, /@page \{ size: A4 landscape; margin: 5mm; \}/);
  assert.match(styles, /\.print-summary \{ border-bottom: 1px solid #2d862f; display: grid;[\s\S]*max-height: 20mm;/);
  assert.match(styles, /\.attendance-register-table \{ border-collapse: collapse; font-size: 5px; min-width: 0; table-layout: fixed; width: 100%; \}/);
  assert.match(styles, /\.attendance-register-table thead \{ display: table-header-group; \}/);
  assert.match(styles, /\.attendance-register-table tfoot \{ display: table-row-group; \}/);
  assert.match(styles, /\.attendance-register-table tr \{ break-inside: avoid; page-break-inside: avoid; \}/);
  assert.match(styles, /\.attendance-register-table th:nth-child\(n\+9\), \.attendance-register-table td:nth-child\(n\+9\) \{ width: 18px; \}/);
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

test("financial cards and expense category totals use readable tokenized surfaces and compact money", async () => {
  const modulePage = await source("web/src/pages/ModulePage.tsx");
  const format = await source("web/src/lib/format.ts");
  const styles = await source("web/src/styles.css");
  assert.match(format, /minimumFractionDigits: 0,[\s\S]*maximumFractionDigits: 2/);
  assert.match(modulePage, /<header><h3>\{category\}<\/h3><strong>\{money\(categoryTotal\)\}<\/strong><\/header>/);
  assert.match(modulePage, /<b>Category total <span>\{money\(categoryTotal\)\}<\/span><\/b>/);
  assert.match(styles, /--text-primary: var\(--text\);[\s\S]*--surface-muted: var\(--surface-soft\);[\s\S]*--accent: var\(--brand-secondary\);/);
  assert.match(styles, /\.summary-card \{[\s\S]*background: var\(--surface\);[\s\S]*border: 1px solid var\(--border\);[\s\S]*color: var\(--text-primary\);/);
  assert.match(styles, /\.expense-category-report header strong,[\s\S]*\.expense-category-report p strong \{[\s\S]*color: var\(--text-primary\);/);
  assert.match(styles, /\.attendance-import-table-wrap thead th \{ background: var\(--surface-soft\); color: var\(--text-primary\);/);
  assert.match(styles, /--background: #f8fafc;/);
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

test("labour details actions edit labour and add separate optimistic advances", async () => {
  const modulePage = await source("web/src/pages/ModulePage.tsx");
  const offlineDb = await source("web/src/lib/offline-db.ts");
  const styles = await source("web/src/styles.css");
  assert.match(modulePage, /hasPermission\(user, "MANAGE_TEAM", user\.workspaceId\)/);
  assert.match(modulePage, /hasPermission\(user, "MANAGE_RECORDS", user\.workspaceId\)/);
  assert.match(modulePage, /advances\.filter\(\(entry\) => entry\.labourerId === selectedLabourer\.id\)\.reduce\(\(sum, entry\) => sum \+ entry\.amount, 0\)/);
  assert.match(modulePage, /setAdvances\(\(current\) => \[record, \.\.\.current\.filter\(\(entry\) => entry\.id !== record\.id\)\]\);\s+await persistOperationalRecord\("advance", record\)/);
  assert.match(modulePage, /await persistOperationalRecord\("labourer", record\)/);
  assert.match(modulePage, /if \(busy\) return;/);
  assert.match(modulePage, /t\("workforcePage\.labourUpdated"\)/);
  assert.match(modulePage, /t\("workforcePage\.advanceAdded"\)/);
  assert.match(offlineDb, /paymentMethod\?: string;/);
  assert.match(styles, /@media \(max-width: 767px\) \{[\s\S]*\.worker-action-backdrop \{ align-items: flex-end; padding: 0; \}/);
});

test("workforce screen provides add-labour modal, independent advance report, and instant labour-register search", async () => {
  const modulePage = await source("web/src/pages/ModulePage.tsx");
  assert.match(modulePage, /const \[labourSearch, setLabourSearch\] = useState\(""\);/);
  assert.match(modulePage, /const filteredRegister = labourers\.filter\(\(labourer\) =>/);
  assert.match(modulePage, /workforcePage\.searchRegister/);
  assert.match(modulePage, /workforcePage\.noLabourFound/);
  assert.match(modulePage, /setShowAdvanceReport\(true\)/);
  assert.match(modulePage, /setShowAddLabour\(true\)/);
  assert.match(modulePage, /function AddLabourPanel\(/);
  assert.match(modulePage, /function AdvanceReportPanel\(/);
  assert.match(modulePage, /queryKey: \[[\s\S]*"advance-report",[\s\S]*workspaceId,[\s\S]*farmId,[\s\S]*seasonId/);
});

test("attendance import confirmation batches writes and shows bounded progress feedback", async () => {
  const route = await source("api/src/routes/attendance-imports.ts");
  const api = await source("web/src/lib/api.ts");
  const modulePage = await source("web/src/pages/ModulePage.tsx");
  assert.match(route, /const batchSize = 500;/);
  assert.match(route, /values\(batch\)\.onConflictDoUpdate/);
  assert.match(route, /values\(batch\)\.onConflictDoNothing/);
  assert.match(route, /attendance import confirm request received/);
  assert.match(route, /attendance import database transaction completed/);
  assert.match(api, /timeoutMs: 60_000, debugLabel: "attendance-import-confirm"/);
  assert.match(api, /Import is taking longer than expected\. Please check import history or try again\./);
  assert.match(modulePage, /Importing attendance records and advances\. Please wait\.\.\./);
  assert.match(modulePage, /Duplicate advances skipped/);
});

test("attendance CSV advances carry provenance and refresh labour account totals after import", async () => {
  const route = await source("api/src/routes/attendance-imports.ts");
  const modulePage = await source("web/src/pages/ModulePage.tsx");
  assert.match(route, /source: "attendance_csv_import"/);
  assert.match(route, /importSessionId: session\.id/);
  assert.match(route, /originalFilename: session\.originalFilename/);
  assert.match(route, /sourceCellReference/);
  assert.match(route, /existingImportedAdvanceIdentities\.has\(likelyDuplicateIdentity\)/);
  assert.match(modulePage, /Advances to create/);
  assert.match(modulePage, /Total advance imported/);
  assert.match(modulePage, /await refreshOperationalData\(\); await onImported\(\);/);
});

test("labour advance account correction is tenant-scoped, audited, and reflected in account views", async () => {
  const migrations = await source("api/src/db/migrations.ts");
  const migration = await source("database/migrations/0014_labour_advance_younis_account_backfill.sql");
  const modulePage = await source("web/src/pages/ModulePage.tsx");
  const accounting = await source("web/src/lib/accounting.ts");
  const advances = await source("web/src/pages/workspace/LabourAdvances.tsx");
  assert.match(migrations, /0014_labour_advance_younis_account_backfill\.sql/);
  assert.match(migration, /account\.workspace_id = advance\.workspace_id/);
  assert.match(migration, /advance\.entity_type = 'advance'/);
  assert.match(migration, /advance\.payload->>'labourerId'/);
  assert.match(migration, /RAISE WARNING 'Skipping labour advance account correction/);
  assert.match(migration, /muzare_data_migrations WHERE key = '0014_historical_labour_advance_younis_account'/);
  assert.match(migration, /Labour advance account corrected to Younis Khan/);
  assert.match(accounting, /- advances\.filter\(\(record\) => record\.accountId === account\.id\)\.reduce\(\(sum, record\) => sum \+ record\.amount, 0\)/);
  assert.match(modulePage, /Payment account \*<\/span><select required value=\{form\.accountId\}/);
  assert.match(advances, /accountById\.get\(advance\.accountId \?\? ""\) \?\? advance\.sourceAccountName \?\? "-"/);
});

test("expense voucher search is debounced online, cache-first offline, and tenant scoped", async () => {
  const app = await source("api/src/app.ts");
  const route = await source("api/src/routes/expense-search.ts");
  const api = await source("web/src/lib/api.ts");
  const modulePage = await source("web/src/pages/ModulePage.tsx");
  assert.match(app, /expenseSearchRoutes/);
  assert.match(route, /eq\(operationalRecords\.workspaceId, params\.data\.workspaceId\)/);
  assert.match(route, /eq\(operationalRecords\.farmId, query\.data\.farmId\)/);
  assert.match(route, /eq\(operationalRecords\.seasonId, query\.data\.seasonId\)/);
  assert.match(route, /lower\(coalesce\(\$\{operationalRecords\.payload\}->>'voucherNumber', ''\)\) like \$\{term\}/);
  assert.match(route, /account\.workspace_id = \$\{operationalRecords\.workspaceId\}/);
  assert.match(api, /export const searchExpenses/);
  assert.match(modulePage, /window\.setTimeout\(\(\) => setDebouncedVoucherSearch\(voucherSearch\.trim\(\)\), 275\)/);
  assert.match(modulePage, /enabled: Boolean\(token && workspaceId && farmId && seasonId && navigator\.onLine\)/);
  assert.match(modulePage, /const filteredVouchers = useMemo/);
  assert.match(modulePage, /No expenses found for this search\./);
});

test("labour lifecycle UI preserves history and hides inactive labour from daily marking by default", async () => {
  const app = await source("api/src/app.ts");
  const route = await source("api/src/routes/labour-management.ts");
  const api = await source("web/src/lib/api.ts");
  const modulePage = await source("web/src/pages/ModulePage.tsx");
  assert.match(app, /labourManagementRoutes/);
  assert.match(route, /linkedRecordCount \? "deactivate" : "delete"/);
  assert.match(route, /active: false, endedOn: endDate/);
  assert.match(route, /action: "labour_deleted"/);
  assert.match(route, /action: "labour_deactivated"/);
  assert.match(api, /fetchLabourDeletionPreview/);
  assert.match(api, /deleteOrDeactivateLabour/);
  assert.match(modulePage, /showInactiveLabour \|\| canMarkAttendanceOn\(labourer, date\)/);
  assert.match(modulePage, /workforcePage\.showInactive/);
  assert.match(modulePage, /reports\.typeDeleteConfirm/);
  assert.match(modulePage, /errors\.syncPendingBeforeDeactivate/);
});
