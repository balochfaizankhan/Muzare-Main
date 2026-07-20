import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = (relativePath: string) => readFile(new URL(`../../${relativePath}`, import.meta.url), "utf8");

test("logout and workspace switching clear IndexedDB and React Query caches", async () => {
  const auth = await source("web/src/auth/AuthProvider.tsx");
  assert.match(auth, /await clearWorkspaceCache\(\);\s+queryClient\.clear\(\);/);
  assert.match(auth, /const switchWorkspace[\s\S]*await selectWorkspace[\s\S]*await clearWorkspaceCache\(\);[\s\S]*queryClient\.clear\(\);/);
});

test("frontend permission helpers expose module-level view, create, edit, delete, export, and team checks", async () => {
  const permissions = await source("web/src/lib/permissions.ts");
  assert.match(permissions, /export const canView =/);
  assert.match(permissions, /export const canCreate =/);
  assert.match(permissions, /export const canEdit =/);
  assert.match(permissions, /export const canDelete =/);
  assert.match(permissions, /export const canExport =/);
  assert.match(permissions, /export const canManageTeam =/);
  assert.match(permissions, /export const canManagePermissions =/);
});

test("accountant role is part of shared frontend role and permission maps", async () => {
  const api = await source("web/src/lib/api.ts");
  const permissions = await source("web/src/lib/permissions.ts");
  const team = await source("web/src/pages/workspace/WorkspaceTeam.tsx");
  assert.match(api, /"workspace_owner" \| "workspace_manager" \| "supervisor" \| "accountant" \| "operator" \| "viewer"/);
  assert.match(permissions, /accountant: \["MANAGE_RECORDS", "SUBMIT_RECORDS", "VIEW_REPORTS"\]/);
  assert.match(team, /"workspace_owner", "workspace_manager", "supervisor", "accountant", "operator", "viewer"/);
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
  assert.match(sync, /if \(mutation\.farmId !== context\.farmId\) return false;\s+if \(isDateTypeMutation\(mutation\)\) return true;\s+return mutation\.seasonId === context\.seasonId;/);
  assert.match(sync, /workspaceId: context\.workspaceId, farmId: mutation\.farmId/);
  assert.match(sync, /function isPermissionDeniedSyncError\(error: unknown\)/);
  assert.match(sync, /status: "stale_context"/);
  assert.match(sync, /"permission_denied"/);
  assert.match(sync, /await tableFor\(mutation\.entity\)\.update\(\(mutation\.payload as LocalRecord\)\.id, \{ pendingSync: false \}\)/);
  assert.match(sync, /assertCanQueueMutation\(entity, operation\)/);
});

test("farm and season switching scope browser records to the selected context", async () => {
  const offlineDb = await source("web/src/lib/offline-db.ts");
  const sync = await source("web/src/services/syncService.ts");
  assert.match(offlineDb, /record\.farmId === activeFarmId/);
  assert.match(offlineDb, /record\.seasonId === activeSeasonId/);
  assert.match(sync, /bootstrap\.activeFarmId/);
  assert.match(sync, /bootstrap\.activeSeasonId/);
});

test("Render static site rewrites direct frontend routes to the SPA entry point", async () => {
  const render = await source("render.yaml");
  const vite = await source("web/vite.config.ts");
  assert.match(render, /type: web[\s\S]*name: muzare-main-dev[\s\S]*runtime: static/);
  assert.match(render, /rootDir: web[\s\S]*buildCommand: npm run build[\s\S]*staticPublishPath: dist/);
  assert.match(render, /type: rewrite[\s\S]*source: "\/\*"[\s\S]*destination: "\/index\.html"/);
  assert.doesNotMatch(vite, /base:\s*["']\/workspace\//);
});

test("workspace context auto-selects a usable season for the current session only", async () => {
  const context = await source("api/src/routes/workspace-context.ts");
  const seasons = await source("api/src/routes/workspace-seasons.ts");
  assert.match(context, /records\.find\(\(season\) => season\.status === "active" && usableSeason\(season\)\)/);
  assert.match(context, /records\.find\(\(season\) => currentOpenSeason\(season\)\)/);
  assert.match(context, /records\.find\(\(season\) => usableSeason\(season\)\)/);
  assert.match(context, /missingSeasonSelection = Boolean\(seasonId && session\?\.activeSeasonId !== seasonId\)/);
  assert.match(context, /where\(eq\(userSessions\.id, sessionId\)\)/);
  assert.doesNotMatch(context, /Workspace context needs repair\. No usable season is selected for the active farm\./);
  assert.match(seasons, /set\(\{ activeFarmId: farmId, activeSeasonId: seasonId \}\)\.where\(eq\(userSessions\.id, sessionId\)\)/);
});

test("backend bootstrap truth clears stale cached season context on the client", async () => {
  const sync = await source("web/src/services/syncService.ts");
  assert.match(sync, /localStorage\.removeItem\(operationalContextKey\(workspaceId\)\)/);
  assert.match(sync, /JSON\.stringify\(\{ farmId, seasonId: seasonId \?\? null \}\)/);
  assert.match(sync, /rememberOperationalContext\(workspaceId, farm\?\.id \?\? null, season\?\.id \?\? null\)/);
});

test("bootstrap and dashboard distinguish no farms from no access and hide owner recovery actions for viewers", async () => {
  const bootstrapRoute = await source("api/src/routes/bootstrap.ts");
  const context = await source("api/src/routes/workspace-context.ts");
  const dashboard = await source("web/src/pages/DashboardPage.tsx");
  const api = await source("web/src/lib/api.ts");
  assert.match(api, /workspaceFarmCount\?: number;/);
  assert.match(api, /accessibleFarmCount\?: number;/);
  assert.match(api, /farmAccessReason\?: "all" \| "assigned" \| "no_accessible_farms" \| "no_workspace_farms";/);
  assert.match(context, /workspaceFarmCount: totalWorkspaceFarms/);
  assert.match(context, /accessibleFarmCount,/);
  assert.match(context, /farmAccessReason = totalWorkspaceFarms === 0/);
  assert.match(bootstrapRoute, /accessibleFarmIds: context\.accessibleFarmIds/);
  assert.match(dashboard, /const canManageFarms = Boolean\(user\?\.workspaceId && user && hasPermission\(user, "MANAGE_FARMS", user\.workspaceId\)\)/);
  assert.match(dashboard, /!hasFarm && canManageFarms && <Link className="secondary-button" to="\/workspace\/farms\?create=1">/);
  assert.match(dashboard, /!hasFarm && noAccessibleFarms && <p className="context-message">\{t\("dashboardPage\.noAccessibleFarmMessage"\)\}<\/p>/);
});

test("attendance reports scope cached tenant data and selected date range", async () => {
  const reports = await source("web/src/pages/workspace/Reports.tsx");
  assert.match(reports, /workspaceRecords\(offlineDb\.labourers\)/);
  assert.match(reports, /workspaceRecords\(offlineDb\.attendance\)/);
  assert.match(reports, /buildDateColumns\(from, to, attendanceRows\)/);
  assert.match(reports, /matchesGroup\(labourer\)/);
  assert.match(reports, /matches\(item\.date, \[labourName\(item\.labourerId\), labourer\?\.group, item\.status\]\)/);
});

test("labour work ledger exposes individual and group scopes in the UI and report output", async () => {
  const labourEarnings = await source("web/src/pages/workspace/LabourEarnings.tsx");
  const reports = await source("web/src/pages/workspace/Reports.tsx");
  const api = await source("web/src/lib/api.ts");
  assert.match(labourEarnings, /Labour Earnings/);
  assert.match(labourEarnings, /Individual labour/);
  assert.match(labourEarnings, /Labour group/);
  assert.match(labourEarnings, /Assigned foreman/);
  assert.match(labourEarnings, /Record group earning/);
  assert.match(reports, /Individual earnings/);
  assert.match(reports, /Group earnings/);
  assert.match(reports, /labourEarningScopeLabel/);
  assert.match(api, /individualLabourWorkWages\?: number;/);
  assert.match(api, /groupLabourWorkWages\?: number;/);
});

test("wage rate management is wired through shared permissions, sync storage, and reports", async () => {
  const apiPermissions = await source("api/src/permissions.ts");
  const syncRoute = await source("api/src/routes/operational-sync.ts");
  const syncService = await source("web/src/services/syncService.ts");
  const reports = await source("web/src/pages/workspace/Reports.tsx");
  const wageRatesPage = await source("web/src/pages/workspace/WageRates.tsx");
  assert.match(apiPermissions, /"wages"/);
  assert.match(syncRoute, /"wageRate"/);
  assert.match(syncService, /wageRate: offlineDb\.wageRates/);
  assert.match(reports, /report === "wage-rates"/);
  assert.match(wageRatesPage, /Wage Rate Management/);
  assert.match(wageRatesPage, /Add \/ Update Rates/);
  assert.match(wageRatesPage, /wageRatesPage\.currentRates/);
  assert.match(wageRatesPage, /wageRatesPage\.history/);
  assert.match(wageRatesPage, /wageRatesPage\.searchLabour/);
  assert.match(wageRatesPage, /Apply values/);
  assert.match(wageRatesPage, /wageRatesPage\.saveRates/);
});

test("operational writes queue locally before background sync", async () => {
  const sync = await source("web/src/services/syncService.ts");
  assert.match(sync, /const existing = await tableFor\(entity\)\.get\(record\.id\);[\s\S]*const operation = existing \? "edit" : "create";[\s\S]*await queueOfflineRecord\(entity, nextRecord, operation\);\s+if \(navigator\.onLine\) void syncPendingRecords\(\);/);
  assert.match(sync, /if \(latest\?\.updatedAt !== mutation\.updatedAt\) continue;/);
});

test("voucher display and retry logic preserve explicit voucher numbers instead of restoring audit numbers or auto-renumbering", async () => {
  const vouchers = await source("web/src/lib/vouchers.ts");
  const sync = await source("web/src/services/syncService.ts");
  const modulePage = await source("web/src/pages/ModulePage.tsx");
  const route = await source("api/src/routes/operational-sync.ts");
  assert.match(vouchers, /if \(originalVoucherNumber && voucher\.voucherNumberEdited !== true\) return originalVoucherNumber;/);
  assert.match(vouchers, /return cleanVoucherNumber\(voucher\.voucherNumber\)\s+\|\|\s+originalVoucherNumber\s+\|\|\s+cleanVoucherNumber\(voucher\.legacyVoucherNumber\);/);
  assert.match(sync, /const rawVoucherNumber = typeof payload\.voucherNumber === "string" \? payload\.voucherNumber\.trim\(\) : "";/);
  assert.match(sync, /validateVoucherNumber\(context\.token, context\.workspaceId, \{/);
  assert.match(modulePage, /setCustomVoucherNumberEnabled\(true\);[\s\S]*setCustomVoucherNumber\(getVoucherDisplayNumber\(voucher\) \|\| voucher\.voucherNumber\);/);
  assert.match(modulePage, /const \[savingVoucher, setSavingVoucher\] = useState\(false\);/);
  assert.match(modulePage, /const voucherSubmitLockRef = useRef\(false\);/);
  assert.match(modulePage, /const pendingVoucherRecordIdRef = useRef<string \| null>\(null\);/);
  assert.match(modulePage, /if \(voucherSubmitLockRef\.current\) return;/);
  assert.match(modulePage, /makeLocalRecord\(pendingVoucherRecordIdRef\.current \?\? undefined\)/);
  assert.match(modulePage, /Saving\.\.\./);
  assert.match(modulePage, /voucherNumber: nextVoucherNumber,/);
  assert.match(route, /duplicateVoucherNumberDetails\(parsed\.data\.workspaceId, duplicateVoucherNumber\)/);
  assert.match(route, /resolveVoucherPayloadForWrite/);
  assert.match(route, /createdBy: existing\.payload\.createdBy \?\? request\.appUser!\.id/);
  assert.match(route, /updatedBy: request\.appUser!\.id/);
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
  assert.match(sync, /const nextAttemptAt = retryable && attempts < maxAutomaticAttempts[\s\S]*Date\.now\(\) \+ 1_000 \* 2 \*\* \(attempts - 1\)\)\.toISOString\(\)/);
  assert.match(sync, /if \(\(await getPendingCount\(\)\) === 0\) \{[\s\S]*await refreshOperationalData\(\{ notifySuccess: false \}\);[\s\S]*notify\(i18n\.t\("sync\.databaseSynchronized"\)\)/);
});

test("attendance marking updates local UI immediately, reuses a daily record, and toggles the active status off", async () => {
  const modulePage = await source("web/src/pages/ModulePage.tsx");
  const sync = await source("web/src/services/syncService.ts");
  const api = await source("web/src/lib/api.ts");
  assert.match(modulePage, /attendance\.find\(\(entry\) =>[\s\S]*entry\.labourerId === targetLabourerId[\s\S]*entry\.date === date/);
  assert.match(modulePage, /if \(existing\?\.status === status\) \{[\s\S]*setAttendance\(\(current\) => current\.filter\(\(entry\) => entry\.id !== existing\.id\)\);[\s\S]*await deleteOperationalRecord\("attendance", existing\);/);
  assert.match(modulePage, /setAttendance\(\(current\) => \[record, \.\.\.current\.filter\(\(entry\) => entry\.id !== record\.id\)\]\);\s+await persistOperationalRecord/);
  assert.match(modulePage, /disabled=\{!canWriteAttendance \|\| !markable \|\| markingLabourers\.has\(labourer\.id\)\}/);
  assert.match(sync, /operation: "delete"/);
  assert.match(sync, /if \(mutation\.operation === "delete"\) \{[\s\S]*await deleteOperationalRecordFromApi/);
  assert.match(sync, /pendingDeletes\.has\(`\$\{context\.workspaceId\}:\$\{item\.entity\}:\$\{item\.record\.id\}`\)/);
  assert.match(api, /apiRequest<void>\("\/v1\/workspace\/operational-records", \{ method: "DELETE"/);
});

test("permission context defaults writes to read-only during session refresh and blocks unauthorized queue creation", async () => {
  const auth = await source("web/src/auth/AuthProvider.tsx");
  const permissions = await source("web/src/lib/permissions.ts");
  const sync = await source("web/src/services/syncService.ts");
  assert.match(auth, /setPermissionContextUser\(sessionRefreshing \? null : user\)/);
  assert.match(permissions, /export function canQueueOperationalMutation\(/);
  assert.match(permissions, /if \(!user\?\.workspaceId\) return false;/);
  assert.match(sync, /notify\(i18n\.t\("common\.viewOnlyAccess"\)\);[\s\S]*throw new Error\(i18n\.t\("sync\.permissionDenied"\)\)/);
  assert.match(sync, /"permission_denied"/);
  assert.match(sync, /"stale_context"/);
  assert.match(sync, /resolveSyncQueueItem/);
  assert.match(sync, /discardSyncQueueItem/);
});

test("viewer-facing entry screens gate attendance, expenses, advances, dispatch, sales, partner ledger, and accounts forms by module permissions", async () => {
  const modulePage = await source("web/src/pages/ModulePage.tsx");
  const advances = await source("web/src/pages/workspace/LabourAdvances.tsx");
  const layout = await source("web/src/layouts/WorkspaceLayout.tsx");
  assert.match(modulePage, /const canWriteAttendance = Boolean\(!sessionRefreshing && user\?\.workspaceId && canCreate\(user, "attendance", user\.workspaceId\)\)/);
  assert.match(modulePage, /const canCreateVouchers = Boolean\(!sessionRefreshing && user && workspaceId && canCreate\(user, "expenses", workspaceId\)\)/);
  assert.match(modulePage, /const canCreateDispatch = Boolean\(!sessionRefreshing && user && workspaceId && canCreate\(user, "dispatch", workspaceId\)\)/);
  assert.match(modulePage, /const canCreateSales = Boolean\(!sessionRefreshing && user && workspaceId && canCreate\(user, "sales", workspaceId\)\)/);
  assert.match(modulePage, /const canCreateEntries = Boolean\(!sessionRefreshing && user && workspaceId && canCreate\(user, "accounts", workspaceId\)\)/);
  assert.match(modulePage, /const canCreateAccounts = Boolean\(!sessionRefreshing && user && workspaceId && canCreate\(user, "accounts", workspaceId\)\)/);
  assert.match(advances, /const canRecord = Boolean\(!sessionRefreshing && user && workspaceId && canCreate\(user, "advances", workspaceId\)\)/);
  assert.match(layout, /item\.status === "permission_denied" \? t\("sync\.discardUnauthorizedChange"\) : t\("sync\.discardStaleItem"\)/);
});

test("partner ledger supports audited edits and offline soft deletes without duplicate balance effects", async () => {
  const route = await source("api/src/routes/operational-sync.ts");
  const modulePage = await source("web/src/pages/ModulePage.tsx");
  const offlineDb = await source("web/src/lib/offline-db.ts");
  const sync = await source("web/src/services/syncService.ts");
  assert.match(route, /action: "partner_ledger_updated"/);
  assert.match(route, /parsed\.data\.entity === "partnerEntry" \? "partner_ledger_deleted"/);
  assert.match(route, /deletedAt: deletedAt\.toISOString\(\), deletedBy: request\.appUser\.id, deletionReason/);
  assert.match(route, /hasPermission\(request\.appUser, "MANAGE_RECORDS", parsed\.data\.workspaceId\)/);
  assert.match(offlineDb, /Boolean\(options\.includeDeleted\) \|\| isActiveOperationalRecord\(record as LocalRecord & Record<string, unknown>\)/);
  assert.match(sync, /entity === "partnerEntry" \|\| entity === "advance" \|\| entity === "voucher"/);
  assert.match(modulePage, /const \[showDeleted, setShowDeleted\] = useState\(false\);/);
  assert.match(modulePage, /t\("partnerLedgerPage\.showDeleted"\)/);
  assert.match(modulePage, /t\("partnerLedgerPage\.entryDeleted"\)/);
  assert.match(modulePage, /actions=\{visibleEntries\.map/);
});

test("partner settlements transfer matching account and partner positions without changing business totals", async () => {
  const route = await source("api/src/routes/operational-sync.ts");
  const modulePage = await source("web/src/pages/ModulePage.tsx");
  const offlineDb = await source("web/src/lib/offline-db.ts");
  const accounting = await source("web/src/lib/accounting.ts");
  const partnerAccounting = await source("web/src/lib/partnerAccounting.ts");
  assert.match(route, /type: z\.literal\("settlement"\)/);
  assert.match(route, /record\.fromAccountId !== record\.toAccountId/);
  assert.match(route, /partnerAccountId: z\.string\(\)\.min\(1\)\.optional\(\)/);
  assert.match(offlineDb, /type: "contribution" \| "withdrawal" \| "settlement"/);
  assert.match(accounting, /export function partnerSettlementEffect\(entry: PartnerEntry, accountId: string, accountLookup: AccountIdentityLookup\): number/);
  assert.match(accounting, /\(toAccountId === accountId \? entry\.amount : 0\)/);
  assert.match(accounting, /\(fromAccountId === accountId \? entry\.amount : 0\)/);
  assert.ok(partnerAccounting.includes("getPartnerAccountingSnapshot(account, sales, vouchers, advances, entries, settlements, allAccounts, options)"));
  assert.match(partnerAccounting, /labourSettlementCashPaid/);
  assert.match(partnerAccounting, /labourSettlementNonCashApplied/);
  assert.match(partnerAccounting, /calculateLabourAdvanceBreakdown/);
  assert.match(partnerAccounting, /const farmOwesPartner = purchaseVouchersPaid/);
  assert.match(partnerAccounting, /const currentPartnerBalance = farmOwesPartner;/);
  assert.match(partnerAccounting, /position\.settledAdvances = snapshot\.settledAdvances;/);
  assert.match(partnerAccounting, /position\.outstandingLabourAdvances = snapshot\.outstandingLabourAdvances;/);
  assert.match(partnerAccounting, /position\.currentPartnerBalance = snapshot\.currentPartnerBalance;/);
  assert.match(modulePage, /buildPartnerLiabilityPositions\(accounts, vouchers, advances, activeEntries, sales, labourWageSettlements, \{ farmId, seasonId \}\)/);
  assert.match(modulePage, /Purchase Vouchers/);
  assert.match(modulePage, /Funds Given/);
  assert.match(modulePage, /Funds Received/);
  assert.match(modulePage, /Settled through wages/);
  assert.match(modulePage, /Outstanding Labour Advances/);
  assert.match(modulePage, /Reconciliation/);
  assert.match(modulePage, /t\("partnerLedgerPage\.farmOwesPartner"\)/);
  assert.match(modulePage, /t\("partnerLedgerPage\.partnerHoldsBusinessMoney"\)/);
  assert.match(modulePage, /<option value="settlement">\{t\("partnerLedgerPage\.partnerSettlement"\)\}<\/option>/);
  assert.ok(modulePage.includes("getPartnerAccountingSnapshot(selectedAccount, sales, activeGeneralExpenseVouchers, advances, activeEntries, labourWageSettlements, accounts, { farmId, seasonId })"));
  assert.match(modulePage, /outstandingLabourAdvances/);
});

test("attendance labour directory loads cache-first and keeps cached data during API outages", async () => {
  const auth = await source("web/src/auth/AuthProvider.tsx");
  const sync = await source("web/src/services/syncService.ts");
  const modulePage = await source("web/src/pages/ModulePage.tsx");
  assert.match(auth, /if \(!\(error instanceof ApiError && \[401, 403\]\.includes\(error\.status\)\) && cachedUser\(\)\) \{[\s\S]*setUser\(cachedUser\(\)\);[\s\S]*return;/);
  assert.match(sync, /const cached = restoreOperationalContext\(workspaceId\);\s+applyOperationalContext\(token, workspaceId, cached\?\.farmId \?\? undefined, cached\?\.seasonId \?\? undefined\);/);
  assert.match(sync, /dataSource: "cache"/);
  assert.match(sync, /await cacheRecord\(item\.entity, item\.record, false,[\s\S]*if \(result\.snapshotConfirmed && result\.farmId === context\.farmId && result\.seasonId === context\.seasonId\) \{\s+await pruneSynchronizedCache\(result\.records\);/);
  assert.match(sync, /item\.farmId === context!\.farmId && \(item\.seasonId === context!\.seasonId \|\| item\.seasonId == null\)/);
  assert.match(modulePage, /t\("workforcePage\.offlineCachedLabour"\)/);
  assert.match(modulePage, /t\("workforcePage\.noCachedLabour"\)/);
  assert.match(modulePage, /t\("workforcePage\.lastSynced"\)[\s\S]*readableSyncTime\(sync\.lastSyncTime\)/);
});

test("archive feature removal leaves no active route, menu entry, or archive-center styling", async () => {
  const app = await source("api/src/app.ts");
  const appShell = await source("web/src/App.tsx");
  const workforceHub = await source("web/src/pages/workspace/WorkforceHub.tsx");
  const styles = await source("web/src/styles.css");
  assert.doesNotMatch(app, /labourPeriodArchiveRoutes/);
  assert.doesNotMatch(appShell, /ArchiveCenter/);
  assert.doesNotMatch(appShell, /labour-period-archives/);
  assert.doesNotMatch(workforceHub, /Archive Center/);
  assert.doesNotMatch(workforceHub, /\/workspace\/workforce\/archive/);
  assert.doesNotMatch(styles, /archive-center__/);
});

test("mobile styles contain page overflow and keep navigation scrollable", async () => {
  const modulePage = await source("web/src/pages/ModulePage.tsx");
  const styles = await source("web/src/styles.css");
  const layout = await source("web/src/layouts/WorkspaceLayout.tsx");
  assert.match(styles, /html,\s*body \{[\s\S]*overflow-x: hidden;/);
  assert.match(styles, /#root \{[\s\S]*overflow-x: clip;/);
  assert.match(styles, /\.app-sidebar \{[\s\S]*overflow-x: auto;/);
  assert.match(styles, /\.shell-header \.toolbar__actions \{[\s\S]*flex-wrap: wrap;/);
  assert.match(layout, /<nav className="app-sidebar__desktop-nav">/);
  assert.match(layout, /<nav className="app-mobile-bottom-nav"/);
  assert.doesNotMatch(layout, /<nav className="app-sidebar__mobile-nav"/);
  assert.match(styles, /@media \(max-width: 767px\) \{/);
  assert.match(styles, /@media \(min-width: 768px\) \{/);
  assert.match(styles, /\.app-mobile-sheet-backdrop \{[\s\S]*background: rgba\(2, 16, 30, 0\.35\);[\s\S]*position: fixed;/);
  assert.match(styles, /\.app-mobile-sheet \{[\s\S]*background: var\(--surface\);[\s\S]*opacity: 1;/);
  assert.match(modulePage, /className="partner-position-cards"/);
  assert.match(styles, /\.partner-position-cards \{ display: none; \}/);
  assert.match(styles, /@media \(max-width: 760px\) \{[\s\S]*\.partner-position-table \{\s*display: none;[\s\S]*\.partner-position-cards \{\s*display: grid;/);
  assert.match(styles, /\.record-list article span \{[\s\S]*overflow-wrap: anywhere;/);
  assert.match(styles, /\.partner-ledger-submit \{[\s\S]*color: #fff !important;/);
});

test("reports module stays compact and responsive across desktop and mobile views", async () => {
  const reports = await source("web/src/pages/workspace/Reports.tsx");
  const styles = await source("web/src/styles.css");
  assert.match(reports, /className="subpage module-workspace reports-page"/);
  assert.match(reports, /className="record-panel reports-subtabs"/);
  assert.match(reports, /className="reports-view-header"/);
  assert.match(styles, /\.reports-view-header \{ align-items: flex-start; display: flex;/);
  assert.match(styles, /\.report-wide-table \{ display: none; \}/);
  assert.match(styles, /\.report-mobile-cards \{ display: grid; gap: 8px; \}/);
  assert.match(styles, /\.reports-subtabs \{[\s\S]*flex-wrap: wrap;[\s\S]*overflow-x: auto;[\s\S]*scroll-snap-type: x proximity;/);
  assert.match(styles, /\.report-mobile-cards \{ display: none; \}/);
});

test("attendance reports provide printable register and structured exports from the reports module", async () => {
  const reports = await source("web/src/pages/workspace/Reports.tsx");
  const styles = await source("web/src/styles.css");
  const i18n = await source("web/src/i18n.ts");
  assert.match(reports, /title=\{t\("reportsPage\.attendanceRegister"\)\}/);
  assert.match(reports, /t\("reportsPage\.exportCsv"\)/);
  assert.match(i18n, /registerOnlyPrint: "The full attendance register is prepared for print and export only/);
  assert.match(reports, /const attendanceMark = \(status\?: Attendance\["status"\]\)/);
  assert.match(reports, /function buildDateColumns\(from: string, to: string, rows: Attendance\[\]\)/);
  assert.match(reports, /attendancePayable\(item\.records\.find\(\(record\) => record\.date === date\)\?\.status\)/);
  assert.match(reports, /downloadCsv\("attendance-register\.csv"/);
  assert.match(reports, /printSection\("attendance-register-print"\)/);
  assert.match(reports, /attendance-register-report/);
  assert.match(styles, /@media print \{[\s\S]*\.reports-page \{ display: block; \}/);
  assert.match(styles, /@media print \{[\s\S]*\.report-wide-table \{ display: block !important; \}/);
});

test("expense entry uses dependent searchable category selectors and grouped totals", async () => {
  const modulePage = await source("web/src/pages/ModulePage.tsx");
  assert.match(modulePage, /list=\{`expense-category-options-\$\{item\.id\}`\}/);
  assert.match(modulePage, /list=\{`expense-subcategory-options-\$\{item\.id\}`\}/);
  assert.match(modulePage, /disabled=\{!item\.categoryId\}/);
  assert.match(modulePage, /t\("expensesPage\.expensesByCategory"\)/);
  assert.match(modulePage, /MANAGE_EXPENSE_CATEGORIES/);
});

test("labour settlement form loads canonical payment account uuids and shows LW accounting copy", async () => {
  const settlementPage = await source("web/src/pages/workspace/LabourWageSettlements.tsx");
  const api = await source("web/src/lib/api.ts");
  assert.match(api, /fetchLabourWageSettlementPaymentAccounts/);
  assert.match(api, /fetchLabourWageSettlement/);
  assert.match(api, /updateLabourWageSettlement/);
  assert.match(api, /voidLabourWageSettlement/);
  assert.match(settlementPage, /fetchLabourWageSettlementPaymentAccounts\(token, workspaceId, activeFarmId\)/);
  assert.match(settlementPage, /Settlement accounting is posted under the LW settlement number\./);
  assert.match(settlementPage, /Accounting reference/);
  assert.match(settlementPage, /Edit \/ Update/);
  assert.match(settlementPage, /Void \/ Reverse settlement/);
  assert.match(settlementPage, /Delete settlement/);
  assert.match(settlementPage, /placeholder="Search settlement, voucher, note, labour or group"/);
  assert.match(settlementPage, /Available Group Advances/);
  assert.match(settlementPage, /Advance Absorbed This Settlement/);
  assert.match(settlementPage, /Outstanding Group Advance/);
  assert.doesNotMatch(settlementPage, /Generated voucher|View Generated Voucher/);
  assert.doesNotMatch(settlementPage, /Settlement and voucher are posted together in one transaction\./);
});

test("advance report filters use explicit labels and a visible active-filter summary", async () => {
  const reports = await source("web/src/pages/workspace/Reports.tsx");
  assert.match(reports, /More filters/);
  assert.match(reports, /Select labour group/);
  assert.match(reports, /Select labour/);
  assert.match(reports, /Paid from account/);
  assert.match(reports, /Minimum Amount/);
  assert.match(reports, /Maximum Amount/);
  assert.match(reports, /reportsPage\.dateRange/);
});

test("financial cards and expense category totals use readable tokenized surfaces and compact money", async () => {
  const modulePage = await source("web/src/pages/ModulePage.tsx");
  const format = await source("web/src/lib/format.ts");
  const styles = await source("web/src/styles.css");
  assert.match(format, /minimumFractionDigits: 0,[\s\S]*maximumFractionDigits: 2/);
  assert.match(modulePage, /<header><div><h3>\{category\}<\/h3><small>\{getExpenseAccountingGroup\(category\)\}<\/small><\/div><strong>\{money\(categoryTotal\)\}<\/strong><\/header>/);
  assert.match(modulePage, /getExpenseAccountingGroup\(category\)/);
  assert.match(modulePage, /<b>\{t\("expensesPage\.categoryTotal"\)\} <span>\{money\(categoryTotal\)\}<\/span><\/b>/);
  assert.match(styles, /--text-primary: var\(--text\);[\s\S]*--surface-muted: var\(--surface-soft\);[\s\S]*--accent: var\(--brand-secondary\);/);
  assert.match(styles, /\.summary-card \{[\s\S]*background: var\(--surface\);[\s\S]*border: 1px solid var\(--border\);[\s\S]*color: var\(--text-primary\);/);
  assert.match(styles, /\.expense-category-report header strong,[\s\S]*\.expense-category-report p strong \{[\s\S]*color: var\(--text-primary\);/);
  assert.match(styles, /\.attendance-import-table-wrap thead th \{ background: var\(--surface-soft\); color: var\(--text-primary\);/);
  assert.match(styles, /--background: #f8fafc;/);
});

test("attendance CSV import is owner-gated, online-only, and keeps register overflow inside its preview", async () => {
  const modulePage = await source("web/src/pages/ModulePage.tsx");
  const styles = await source("web/src/styles.css");
  assert.match(modulePage, /Attendance Register CSV Import/);
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
  assert.match(modulePage, /unresolvedLabourRows\.length > 0 \|\| summary\.errors\.length > 0 \|\| \(summary\.dailyAdvances > 0 && !accountId\) \|\| \(summary\.warnings\.length > 0 && !warningsAccepted\)/);
  assert.match(modulePage, /I understand these warnings and want to continue\./);
});

test("labour details actions edit labour and add separate optimistic advances", async () => {
  const modulePage = await source("web/src/pages/ModulePage.tsx");
  const offlineDb = await source("web/src/lib/offline-db.ts");
  const styles = await source("web/src/styles.css");
  assert.match(modulePage, /const canManageLabour = Boolean\(!sessionRefreshing && user\?\.workspaceId && canCreate\(user, "workforce", user\.workspaceId\)\)/);
  assert.match(modulePage, /const canAddAdvance = Boolean\(!sessionRefreshing && user\?\.workspaceId && canCreate\(user, "advances", user\.workspaceId\)\)/);
  assert.match(modulePage, /advances\.filter\(\(entry\) => entry\.labourerId === selectedLabourer\.id\)\.reduce\(\(sum, entry\) => sum \+ entry\.amount, 0\)/);
  assert.match(modulePage, /if \(!canManageLabour\) throw new Error\(t\("common\.viewOnlyAccess"\)\);/);
  assert.match(modulePage, /if \(!canAddAdvance\) throw new Error\(t\("common\.viewOnlyAccess"\)\);/);
  assert.match(modulePage, /setAdvances\(\(current\) => \[record, \.\.\.current\.filter\(\(entry\) => entry\.id !== record\.id\)\]\);\s+await persistOperationalRecord\("advance", record\)/);
  assert.match(modulePage, /await persistOperationalRecord\("labourer", record\)/);
  assert.match(modulePage, /t\("workforcePage\.labourUpdated"\)/);
  assert.match(modulePage, /showToast\(t\("workforcePage\.advanceAdded"\)\)/);
  assert.match(offlineDb, /paymentMethod\?: string;/);
  assert.match(styles, /@media \(max-width: 767px\) \{[\s\S]*\.worker-action-backdrop \{ align-items: flex-end; padding: 0; \}/);
});

test("workforce screen provides add-labour modal and instant labour-register search while advance reporting lives in dedicated modules", async () => {
  const modulePage = await source("web/src/pages/ModulePage.tsx");
  const advances = await source("web/src/pages/workspace/LabourAdvances.tsx");
  assert.match(modulePage, /const \[labourSearch, setLabourSearch\] = useState\(""\);/);
  assert.match(modulePage, /const filteredRegister = sortWorkersForDisplay\(labourers\.filter\(\(labourer\) =>/);
  assert.match(modulePage, /workforcePage\.searchRegister/);
  assert.match(modulePage, /workforcePage\.noLabourFound/);
  assert.match(modulePage, /setShowAddLabour\(true\)/);
  assert.match(modulePage, /function AddLabourPanel\(/);
  assert.match(advances, /recordAdvance/);
  assert.match(advances, /advanceHistory/);
  assert.match(advances, /SearchInput placeholder=\{t\("advancesPage\.searchPlaceholder"\)\}/);
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
  assert.match(api, /timeoutMs: 60_000, debugLabel: "attendance-import-confirm"/);
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
  assert.match(accounting, /const activeSettlements = getActiveLabourWageSettlements\(settlements\)/);
  assert.match(accounting, /getLabourWageSettlementCashPaidAmount\(record\)/);
  assert.match(modulePage, /Payment account \*<\/span><select required value=\{form\.accountId\}/);
  assert.match(advances, /accountById\.get\(advance\.accountId \?\? ""\) \?\? advance\.sourceAccountName \?\? "-"/);
});

test("advance selectors include inactive and deactivated labour while excluding deleted and archived records", async () => {
  const advances = await source("web/src/pages/workspace/LabourAdvances.tsx");
  const payments = await source("web/src/pages/workspace/WorkforcePayments.tsx");
  const selector = await source("web/src/components/LabourSelectCombobox.tsx");
  const multiSelector = await source("web/src/components/LabourMultiSelectFilter.tsx");
  const selectorSheet = await source("web/src/components/LabourSelectorSheet.tsx");
  const eligibility = await source("web/src/lib/workerEligibility.ts");
  const apiEligibility = await source("api/src/lib/labour-eligibility.ts");
  const syncRoute = await source("api/src/routes/operational-sync.ts");
  const labourPaymentsRoute = await source("api/src/routes/labour-payments.ts");
  const labourManagement = await source("api/src/routes/labour-management.ts");
  const migration = await source("api/src/routes/migration-import.ts");

  assert.match(advances, /workspaceRecords\(offlineDb\.labourers, \{ includeDeleted: true \}\)/);
  assert.match(advances, /filterLabourSelectableForAdvance\(selectableLabourers, entryDate, entryGroup\)/);
  assert.match(advances, /includeInactive/);
  assert.match(payments, /sortLabourSelectableForAdvance\(filterLabourSelectableForAdvance\(labourers, date\)\)/);
  assert.match(payments, /options=\{selectableLabourers\}/);
  assert.match(payments, /includeInactive/);
  assert.match(payments, /Deactivated/);
  assert.match(payments, /This labourer is currently inactive\. The advance will still be recorded against their historical labour account\./);
  assert.match(selector, /includeInactive \|\| option\.active !== false \|\| option\.id === value/);
  assert.match(selector, /oldLabourId/);
  assert.match(selector, /labourStatusSearchText/);
  assert.match(selector, /open && !isMobileSelector/);
  assert.match(selector, /<LabourSelectorSheet/);
  assert.match(multiSelector, /<LabourSelectorSheet/);
  assert.match(multiSelector, /applyLabel=\{t\("common\.apply"\)\}/);
  assert.match(selectorSheet, /createPortal/);
  assert.match(selectorSheet, /labour-selector-sheet__cancel/);
  assert.match(selectorSheet, /labour-selector-sheet__apply/);
  const advanceEligibility = eligibility.slice(eligibility.indexOf("export function isLabourSelectableForAdvance"), eligibility.indexOf("export function filterLabourSelectableForAdvance"));
  assert.doesNotMatch(advanceEligibility, /worker\.active === false/);
  assert.doesNotMatch(advanceEligibility, /worker\.endedOn|worker\.leftDate/);
  assert.match(advanceEligibility, /lifecycleStatus === "deleted"/);
  assert.match(advanceEligibility, /lifecycleStatus === "archived"/);
  assert.doesNotMatch(advanceEligibility, /lifecycleStatus === "deactivated"\) return false/);
  const apiAdvanceEligibility = apiEligibility.slice(apiEligibility.indexOf("export function isLabourSelectableForAdvance"));
  assert.doesNotMatch(apiAdvanceEligibility, /worker\.endedOn|worker\.leftDate|worker\.active === false/);
  assert.doesNotMatch(apiAdvanceEligibility, /lifecycleStatus === "deactivated"\) return false/);
  assert.match(syncRoute, /args\.entity === "advance"[\s\S]*isLabourSelectableForAdvance/);
  assert.match(labourPaymentsRoute, /!isLabourSelectableForAdvance\(record\.payload, ""\)/);
  assert.match(labourPaymentsRoute, /isLabourSelectableForAdvance\(item\.payload, ""\)/);
  assert.match(labourManagement, /status: "deactivated"/);
  assert.match(labourManagement, /deactivatedAt: timestamp\.toISOString\(\)/);
  assert.match(migration, /\.\.\.importedLifecycle\(source\)/);
});

test("expense voucher search is debounced online, cache-first offline, and tenant scoped", async () => {
  const app = await source("api/src/app.ts");
  const route = await source("api/src/routes/expense-search.ts");
  const api = await source("web/src/lib/api.ts");
  const modulePage = await source("web/src/pages/ModulePage.tsx");
  const i18n = await source("web/src/i18n.ts");
  const styles = await source("web/src/styles.css");
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
  assert.match(modulePage, /const total = filteredVouchers\.reduce\(\(sum, item\) => sum \+ item\.amount, 0\)/);
  assert.match(modulePage, /const grouped = \[\.\.\.voucherLineItems\.reduce/);
  assert.match(modulePage, /expensesPage\.showingCurrentFilters/);
  assert.match(modulePage, /expensesPage\.clearFilters/);
  assert.match(modulePage, /expensesPage\.dateRange/);
  assert.match(modulePage, /<span><CalendarDays size=\{15\} \/>\{t\("expensesPage\.fromDate"\)\}<\/span>/);
  assert.match(modulePage, /<span><CalendarDays size=\{15\} \/>\{t\("expensesPage\.toDate"\)\}<\/span>/);
  assert.match(modulePage, /expensesPage\.paymentAccount/);
  assert.match(styles, /\.expense-search-filters input\[type="date"\] \{[\s\S]*-webkit-text-fill-color: var\(--text\);/);
  assert.match(styles, /@media \(max-width: 767px\) \{[\s\S]*\.expense-date-range,[\s\S]*\.expense-filter-grid \{[\s\S]*grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(modulePage, /expensesPage\.searchVouchers/);
  assert.match(modulePage, /expensesPage\.showingCurrentFilters/);
  assert.match(i18n, /noExpensesFound: "No expenses found for this search\."/);
});

test("labour lifecycle UI preserves history and hides inactive labour from daily marking by default", async () => {
  const app = await source("api/src/app.ts");
  const route = await source("api/src/routes/labour-management.ts");
  const api = await source("web/src/lib/api.ts");
  const modulePage = await source("web/src/pages/ModulePage.tsx");
  assert.match(app, /labourManagementRoutes/);
  assert.match(route, /attendanceCount/);
  assert.match(route, /advanceCount/);
  assert.match(route, /paymentCount/);
  assert.match(route, /protectedRecordCount/);
  assert.match(route, /Type DELETE or DEACTIVATE to confirm this labour action\./);
  assert.match(route, /Type DEACTIVATE to confirm this labour action\./);
  assert.match(route, /active: false,[\s\S]*endedOn: endDate,[\s\S]*status: "deactivated",[\s\S]*deactivatedAt: timestamp\.toISOString\(\)/);
  assert.match(route, /action: "labour_deleted"/);
  assert.match(route, /action: "labour_deactivated"/);
  assert.match(api, /fetchLabourDeletionPreview/);
  assert.match(api, /deleteOrDeactivateLabour/);
  assert.match(modulePage, /showInactiveLabour \|\| visibleOnSelectedDate/);
  assert.match(modulePage, /workforcePage\.showInactive/);
  assert.match(modulePage, /Delete Labour Permanently/);
  assert.match(modulePage, /Deactivate Labour/);
  assert.match(modulePage, /Checking protected attendance, advance, and payment history/);
  assert.match(modulePage, /Type DELETE to confirm \*/);
  assert.match(modulePage, /Type DEACTIVATE to confirm \*/);
  assert.match(modulePage, /Attendance records/);
  assert.match(modulePage, /Advance records/);
  assert.match(modulePage, /Payment records/);
});

test("labour profile shows only the final payable balance and avoids a conflicting net balance label", async () => {
  const modulePage = await source("web/src/pages/ModulePage.tsx");
  const labourEarnings = await source("web/src/lib/labourEarnings.ts");
  assert.match(modulePage, /selectedLabourLedgerSummary\?\.estimatedPayable \?\? 0/);
  assert.match(modulePage, /<span>Estimated Payable<\/span>/);
  assert.doesNotMatch(modulePage, /labour-profile-balance-card[\s\S]*<span>Net Balance<\/span>/);
  assert.doesNotMatch(modulePage, /Carry forward advance/);
  assert.match(modulePage, /Attendance Wages/);
  assert.match(modulePage, /labour-profile-breakdown-toggle/);
  assert.match(modulePage, /attendanceWageBreakdown\.totalWage/);
  assert.match(labourEarnings, /export function buildAttendanceWageBreakdown\(/);
  assert.match(labourEarnings, /const totalEarned = attendanceSummary\.totalWage \+ totalPendingEarnings;/);
  assert.match(labourEarnings, /const estimatedPayable = totalEarned - advancesPaid - paymentsPaid;/);
});

test("accounts drill-down exposes live ledger totals and source links", async () => {
  const modulePage = await source("web/src/pages/ModulePage.tsx");
  const accounting = await source("web/src/lib/accounting.ts");
  const i18n = await source("web/src/i18n.ts");
  assert.match(modulePage, /className="account-card-clickable"/);
  assert.match(modulePage, /setSelectedAccountId\(account\.id\)/);
  assert.match(modulePage, /openExpenseVisibility\("voucher"\)/);
  assert.match(modulePage, /openExpenseVisibility\("advance"\)/);
  assert.match(modulePage, /openExpenseVisibility\("combined"\)/);
  assert.match(modulePage, /voucherExpensesPaid/);
  assert.match(modulePage, /labourAdvancesPaid/);
  assert.match(modulePage, /settlementsSent/);
  assert.match(modulePage, /settlementsReceived/);
  assert.match(modulePage, /contributions/);
  assert.match(modulePage, /withdrawals/);
  assert.match(modulePage, /accountsPage\.ledgerSearchPlaceholder/);
  assert.match(i18n, /ledgerSearchPlaceholder: "Search voucher\/reference, description, amount, or counterparty"/);
  assert.match(modulePage, /openSource\(row\)/);
  assert.match(modulePage, /source === "expenses"/);
  assert.match(modulePage, /source === "labour_advances"/);
  assert.match(modulePage, /source === "partner_ledger"/);
  assert.match(modulePage, /source === "sales"/);
  assert.match(modulePage, /type: "sale"/);
  assert.match(modulePage, /salesReceived/);
  assert.match(modulePage, /for \(const row of filteredLedgerRows\)/);
  assert.match(accounting, /calculateAccountBalance\(account, sales, vouchers, advances, entries, settlements, accounts\)/);
});

test("financial sync hardening validates money records and preserves soft-deleted sources", async () => {
  const route = await source("api/src/routes/operational-sync.ts");
  const imports = await source("api/src/routes/attendance-imports.ts");
  const sync = await source("web/src/services/syncService.ts");
  assert.match(route, /financialPayloadSchemas/);
  assert.match(route, /positiveAmountSchema/);
  assert.match(route, /entity: z\.enum\(\["partnerEntry", "advance", "voucher"\]\)/);
  assert.match(route, /expense_voucher_deleted/);
  assert.match(route, /labour_advance_deleted/);
  assert.match(imports, /Payment account is required for imported advances\./);
  assert.match(imports, /accountId: body\.data\.accountId/);
  assert.match(sync, /entity === "partnerEntry" \|\| entity === "advance" \|\| entity === "voucher"/);
});
