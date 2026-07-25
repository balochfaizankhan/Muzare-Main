# Muzare Performance Audit — 2026-07-25

Scope: full application (web PWA + api). Goal: make Muzare *feel* like a fast, premium SaaS
product while preserving all existing business logic (financial, accounting, labour payments,
settlements, reports, tenant isolation, offline, sync).

This document separates what is **already done well**, the **safe change applied in this pass**,
and a **prioritized backlog** of remaining opportunities. Each backlog item is rated by
**impact** (perceived speed), **effort**, and **risk** to the protected systems above. Items
rated **Risk: Medium/High** are intentionally *not* applied here — they need explicit sign-off
because they touch sync, IndexedDB access, or i18n init.

---

## Already strong (no action needed)

- **Route-level code splitting** — every page in `web/src/App.tsx` is `lazy()`-loaded; heavy
  pages (Reports 100 kB, ModulePage 212 kB, FarmOperationsMap/maplibre 1.1 MB) never load at
  startup. This is the single biggest startup lever and it is already in place.
- **Instant shell + skeletons** — `StartupScreen` in `App.tsx` renders a sidebar/card skeleton
  immediately; auth/workspace gates show it instead of a white screen.
- **Deferred service-worker registration** — `main.tsx` registers the SW via
  `scheduleBackgroundTask(..., { timeoutMs: 3000 })` using `requestIdleCallback`, so PWA
  registration never blocks first paint.
- **Dashboard streams asynchronously** — `DashboardPage` renders the shell, then loads metrics
  in a background task (`scheduleDashboardRefresh`) with per-card skeletons; expensive financial
  aggregation does not block render.
- **Sync event coalescing** — `eventCoalescing.ts` collapses many mutations in a pass into a
  single `muzare-local-data-change` event (covered by tests), avoiding refresh storms.

The new **Harvest Performance** module follows all of these patterns: its own lazy chunk
(~25 kB), a self-contained dashboard section that loads in a background task and hides itself
until adopted, and pure metric helpers (`lib/harvestPerformance.ts`) kept out of the render path.

---

## Applied in this pass (Safe, shipped)

### 1. Split translation resources out of the main entry chunk — DONE
`web/vite.config.ts` `manualChunks` now routes `src/i18n.ts` + `src/locales/*` into a dedicated
`i18n-resources` chunk.

- **Before:** `index` chunk = **893 kB** (227 kB gzip) — dominated by ~10.5k lines of `en/ar/ur`
  translations bundled with app logic.
- **After:** `index` (app logic) = **157 kB** (42 kB gzip); `i18n-resources` = **737 kB**
  (185 kB gzip), cached independently.
- **Why safe:** pure chunk-boundary change, zero runtime/behaviour difference. App-logic code
  (which changes every deploy) is no longer re-downloaded just because it was glued to
  translations, and vice-versa.

This also exposes the highest-value remaining startup win (item #2 below).

---

## Prioritized backlog (needs sign-off)

### 2. Lazy-load non-active locales — Impact: High · Effort: Medium · Risk: Medium
**Finding:** All three languages (`en`, `ar`, `ur`) load at startup for every user —
**737 kB / 185 kB gzip** parsed up front, ~2/3 of it never used by a given user.

**Recommendation:** Initialise i18next with `en` only (or the persisted language), then
`addResourceBundle` the others on demand via dynamic `import()` when the user switches language.

**Risk / blocker:** `test/i18n-locale-parity.source.test.ts` imports the assembled `resources`
object directly, and several runtime guards assume all locales are present. Restructuring how
`resources` is assembled must keep that export intact for the test while deferring the *bundle
download*. Feasible, but it is a real refactor of i18n init, not a config tweak — hence deferred.

**Expected win:** ~120–150 kB gzip off startup for English users; noticeably faster first
interaction on cold loads / slow networks.

### 3. Incremental (delta) operational sync — Impact: High · Effort: High · Risk: High
**Finding:** `refreshOperationalData` (client) calls
`GET /v1/workspace/:id/operational-records`, and the server
(`api/src/routes/operational-sync.ts`) returns **every** record for the active farm/season on
each pull, then filters by permission in JS. There is no `updatedAt`/`since` cursor — the whole
dataset is transferred and re-`put` into Dexie on every refresh, on startup, on reconnect, and
after each successful push.

**Recommendation:** Add a `?since=<timestamp>` cursor. Server already orders by
`operationalRecords.updatedAt` and has an index (`operational_records_workspace_updated_idx`);
return only rows with `updated_at > since` (plus tombstones). Client persists the high-water mark
and merges deltas.

**Risk:** This is the core of correctness/offline/tenant-isolation. Requires careful handling of
deletes/soft-deletes, clock skew, conflict resolution (currently last-writer-wins by
`clientUpdatedAt`), and the existing "snapshotConfirmed/needsRepair" flow. High reward, but must
be designed and tested deliberately (ideally behind a flag with a full-pull fallback).

### 4. Replace the 30 s sync poll with event/backoff scheduling — Impact: Medium · Effort: Medium · Risk: Medium
**Finding:** `startSyncService` runs `setInterval(syncPendingRecords, 30_000)` unconditionally
while the app is open, even with an empty queue and hidden tab.

**Recommendation:** Drive syncing off (a) queue-not-empty, (b) `online` events, (c)
`visibilitychange` (pause when `document.hidden`), with exponential backoff when idle. Keep a long
safety-net interval (e.g. 5 min) rather than a fixed 30 s.

**Risk:** Medium — must not delay propagation of user edits; needs testing of the offline→online
transition and multi-tab behaviour.

### 5. Use Dexie compound indexes instead of JS `.filter` scans — Impact: Medium (scales with data) · Effort: Medium · Risk: Medium
**Finding:** `workspaceRecords`/`workspaceConfigRecords` in `web/src/lib/offline-db.ts` do
`table.where("workspaceId").equals(id).filter(record => farmId/seasonId/active match ...)`. The
`.filter` runs in JS over every row in the workspace — an O(workspace) scan per read, and these
run on almost every page load and refresh event.

**Recommendation:** Add compound indexes (e.g. `[workspaceId+farmId+seasonId]`) in a new Dexie
version and query with `.where("[workspaceId+farmId+seasonId]").equals([...])`. Keep the
soft-delete/active predicate in JS (small residual).

**Risk:** Medium — requires a new Dexie schema version (additive, like the v12 added for harvest)
and careful equivalence testing of the query results, since these helpers feed financial screens.
The harvest tables already declare `farmId`/`seasonId` indexes and would benefit too.

### 6. Trim the app-logic entry chunk further — Impact: Low/Medium · Effort: Low · Risk: Low
**Finding:** After item #1, `index` is 157 kB (42 kB gzip). `lib/api.ts` (2.4k lines) and several
`lib/*` financial helpers are imported eagerly through the provider/dashboard path.

**Recommendation:** Audit eager imports in `main.tsx` → `AuthProvider` → `query-client` for
modules only needed post-login; lazy-import the heaviest `lib` helpers behind the routes that use
them. The 4 eager CSS files in `main.tsx` can also be consolidated.

**Risk:** Low, but verify no provider needs the deferred module during first render.

### 7. Virtualize long lists — Impact: Medium (large tenants) · Effort: Medium · Risk: Low
**Finding:** Reports, WorkforcePayments, ModulePage render full record lists/tables without
windowing. Fine for small datasets; jank grows with row count.

**Recommendation:** Introduce a light virtualization helper for the largest tables
(attendance history, vouchers, daily history) — additive and low-risk since it is presentation
only.

### 8. PWA cache strategy review — Impact: Low/Medium · Effort: Low · Risk: Low/Medium
**Finding:** `vite.config.ts` uses `registerType: "autoUpdate"` and precaches
`**/*.{js,css,html,svg,png,webp,woff2}` (103 entries, ~4.7 MB). API calls under `/v1/` are
`NetworkOnly` (correct — no stale financial data).

**Recommendation:** Keep `/v1/` NetworkOnly. Consider (a) not precaching the 1.1 MB maplibre map
chunk unless the farm-map feature is enabled, and (b) confirming `autoUpdate` doesn't force a
disruptive reload mid-session (prefer prompt-on-next-navigation). Low risk; measure precache size
after item #1/#2.

---

## Explicitly out of scope / do not touch without cause
- Financial input derivation, accounting reconciliation, settlement math, partner ledger,
  advance-pool resolution — correctness-critical and already consolidated. No perf change should
  reach into these.
- `/v1/` runtime caching must stay `NetworkOnly`.
- Last-writer-wins conflict semantics must be preserved unless item #3 deliberately revisits them.

## Suggested order
1. ✅ #1 chunk split (done)
2. #6 trim entry chunk (safe, quick) and #2 lazy locales (biggest startup win) — behind review
3. #4 sync scheduling + #5 Dexie indexes (scale/perceived responsiveness)
4. #3 delta sync (largest effort; design + flag + tests)
5. #7 virtualization, #8 PWA — polish
