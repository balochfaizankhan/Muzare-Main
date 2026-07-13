# Muzare production audit — 2026-07-13

## Scope and evidence boundary

This report audits the checked-out `dev` branch at `961cc30`, covering the React/Vite PWA, Fastify API, PostgreSQL schema/migrations, IndexedDB queue, service worker, and legacy Android/SQLite/Firestore application. It is a production-readiness audit of source, builds, local runtime behavior, and available tests. It is **not** a reconciliation of live production data: no production database, representative financial export, or two physical devices were supplied.

Evidence used: full repository inventory; route/schema/function traces; `npm run check`; `npm run build`; API test runs; bundle output; local API/PWA interaction at 390 px; login, signup and platform-admin states; PostgreSQL migration/integration attempts; and Android source review. Android tests could not start because no Android SDK path is configured. A dedicated local PostgreSQL database was migrated through migration 0034; its integration runs exposed stale/invalid fixtures described in TEST-001 rather than providing a clean end-to-end settlement verification.

## 1. Executive summary

Muzare has substantial production-minded work already present: tenant/farm/season foreign keys, server-side permission checks, active-record filtering helpers, date-effective wage rates, settlement request idempotency, canonical advance allocations, void/repair endpoints, route-level splitting, IndexedDB queue inspection, and focused accounting regression tests. The canonical partner formula now correctly retains the full partner-funded labour advance while separately reducing labour-side outstanding advances.

It is not production-ready for financial multi-device use. Three confirmed issues dominate the risk:

1. The visible “Repair stale context” queue action can rebind a queued record to the current workspace/farm/season and retry it (P0).
2. Sync uses timestamp last-write-wins and replaces stored JSON with the incoming payload; several entity types have no complete payload schema, so a newer partial record can erase valid fields (P0).
3. The global API error handler sends raw exception messages to clients; a database query failure was reproduced verbatim in the signup UI (P1 security/error handling).

The separate Android application is not part of the PWA/PostgreSQL sync model. It writes per-Firebase-user collections, omits season identity from important remote records, uses integer IDs, and hard-deletes Firestore documents. If it remains an active production client, multi-user workspace and cross-client reconciliation are unsafe without an explicit migration/sync boundary.

| Area | Score / 10 | Assessment |
|---|---:|---|
| Overall application health | 5.5 | Broad product surface, but critical sync and dual-client risks remain. |
| Business logic | 7.0 | Core workflows are represented and wage/settlement logic is unusually well traced. |
| Financial integrity | 6.5 | Canonical partner/advance formula is sound in primary helpers; diagnostics and runtime verification have gaps. |
| Sync integrity | 3.5 | Context guards exist, but manual repair defeats them and payload replacement can lose data. |
| Security | 5.5 | Good server authorization/tenant checks; raw errors and legacy-client boundaries reduce confidence. |
| Performance | 6.0 | Route splitting works; CSS/core chunks, map bundle, and monolithic pages remain heavy. |
| UI / visual design | 6.0 | Cohesive tokens and mobile rules exist; density and component consistency vary widely. |
| UX | 6.0 | Strong workflow coverage and queue feedback, but repair semantics and large forms are risky. |
| Graphic design | 6.0 | Professional direction, undermined by accumulated one-off CSS and native selects. |
| Mobile readiness | 6.5 | Safe-area and narrow breakpoints are extensive; authenticated farm pages were not runtime-verifiable locally. |
| Desktop readiness | 6.5 | Responsive shells/tables exist; very large pages remain visually and cognitively dense. |
| Accessibility | 5.5 | Many labels/focus rules exist; inconsistent ARIA and no automated accessibility suite. |

Production recommendation: do not use the current build for authoritative multi-device financial posting until findings SYNC-001 and SYNC-002 are fixed and exercised against an isolated PostgreSQL database. Decide whether Android is retired/import-only or a supported live client before onboarding real users.

## 2. Application map

| Domain | User-facing modules | Primary implementation / source of truth | Key dependencies |
|---|---|---|---|
| Identity | Login, signup, invitation, session, workspace switch | PostgreSQL users, memberships, sessions; local dev in-memory admin | auth middleware, permissions, selected context |
| Context | Workspace, farm, season, team, approvals | PostgreSQL typed tables | session active farm/season, farm assignments |
| Workforce | Labour profiles, lifecycle, groups, foreman, attendance | Mostly `operational_records` JSON + dedicated reports | eligibility, date ranges, wage rates |
| Labour finance | Advances, work/earnings, wage rates, settlements | `operational_records`; allocation and create-request tables; account transactions | canonical account identity, wage resolver, settlement ledger |
| Expenses | Vouchers, items, categories, imports, attachments | operational JSON plus typed categories/attachments/sequences | voucher uniqueness, accounts, import provenance |
| Accounts/partners | Accounts, account ledger, Partner Position/Status | typed accounts/transactions plus operational vouchers, advances, entries, sales, settlements | canonical account aliases and reconciliation helpers |
| Produce | Dispatch, sales, inventory placeholder | operational JSON; dispatch/sale validation | vehicle/date-type masters, quantity reconciliation |
| Reporting | Dashboard, attendance, advance, workforce, finance, activity | API reports plus cached local records and frontend aggregation | consistent filters, active/void rules, pending records |
| Offline | IndexedDB entity tables, pending mutations, inspector | client cache/queue; PostgreSQL authoritative | context snapshot, retry, server acknowledgment, pruning |
| Platform admin | Workspaces, users, farms, approvals, imports, diagnostics | PostgreSQL | platform authorization, repair tooling |
| Android legacy | Attendance, advances, vouchers, funds, sales, dispatch | local SQLite + per-user Firestore | integer IDs, Firebase Auth; not connected to PWA API |

Important placeholders/limited modules: Inventory and Billing are effectively empty; subscription/reports admin sections are placeholders; archive UI has been removed while soft-delete/void histories remain entity-specific.

## 3. Business-logic map

| Module | Purpose and inputs | Source/output/downstream effect | Lifecycle behavior |
|---|---|---|---|
| Labour | Operational identity, group, status, dates | labour JSON feeds selectors, reports, earnings and settlements | linked labour deactivates; unused labour may hard-delete; historical rows retain names/snapshots variably |
| Attendance | Daily status by labour/date | attendance JSON → dated wage resolver → report/settlement | daily record is idempotently reused; clear deletes; historical wage is recalculated from dated rate, not snapshotted amount |
| Wage rates | Effective dated daily/half-day rates | wage-rate JSON → attendance and settlement preview | overlaps are detected; replacement can split old ranges; deleted/inactive excluded |
| Advances | Money paid to labour from an account | advance JSON → account/partner exposure and labour outstanding | financial delete is soft/audited; settlement allocations reduce labour outstanding only |
| Labour work | Individual or group task earnings | earning JSON with group/foreman snapshots → settlement/report | linked earnings become settled; group records preserve group/foreman identity fields |
| Settlements | Convert attendance/work and advances into posted wage settlement | settlement JSON + allocation rows + account transactions | client request idempotency; overlap checks; posted records require void/reverse when accounting exists |
| Expenses | Record operating purchase/general vouchers | voucher JSON/items → expense totals/account effect | voucher number scoped; imported number helpers preserve provenance; soft deletion for financial records |
| Partner ledger | Contributions, withdrawals, transfers, adjustments | partner-entry JSON → partner positions | edits/deletes audited; transfers should affect two positions, not operating expense |
| Sales/dispatch | Track dispatched and sold produce | dispatch/sale JSON → remaining quantity, receivable/account effect | linked sale validation checks item relationship and remaining quantity; architectural split remains feasible only behind stable IDs/contracts |

Canonical formulas traced:

`Farm Owes Partner = purchase vouchers + funds given - funds received + full partner-funded labour advances + signed adjustments - money returned`

`Outstanding Labour Advances = valid advances - advances applied by active settlements`

The primary web helper and API reconciliation helper both preserve full advances in Farm Owes Partner. Settled advances are explanatory/non-cash settlement values and are not added again to partner liability.

## 4. Critical data-flow maps

```text
Attendance entry
→ IndexedDB full record + context-bound mutation
→ API tenant/context/eligibility validation
→ operational_records attendance row (daily identity reconciliation)
→ resolve wage rate by attendance date
→ attendance wages + labour-work earnings
→ settlement preview
→ idempotent settlement create request + transaction
→ settlement record + source links + advance allocations + account transaction
→ reports/dashboard/partner and labour summaries
```

```text
Labour advance
→ payment account validation
→ operational advance record
→ full amount contributes to partner payable/account view
→ advance ledger computes valid amount to settlement cutoff
→ active settlement allocation consumes labour-side balance
→ remaining outstanding advances
→ void excludes allocation and restores availability; partner-funded principal remains owed
```

```text
Offline save
→ local entity row marked pending
→ one deterministic queue key per workspace/entity/record
→ active-context check
→ API last-write-wins upsert
→ server response cached and queue removed
→ server snapshot refresh/prune
```

The unsafe branches are manual stale-context repair (changes ownership context) and newer partial payload replacement (erases omitted fields).

```text
Dispatch master/item
→ dispatch record snapshot
→ sale references dispatch + item
→ API remaining-carton validation
→ payment/account effect
→ sales/dispatch reports
```

PWA extraction boundary: keep accounts, products, customers, farm/season IDs and idempotency contracts shared; move dispatch/sale UI only after the API owns quantity reservation, sale posting and reversal atomically.

## 5. Findings table

| ID | Severity / classification | Module and user symptom | Root cause and evidence | Risk / correction / tests | Confidence |
|---|---|---|---|---|---|
| SYNC-001 | **P0 confirmed defect; sync/data-integrity risk** | Sync inspector “Repair stale context” can post an old queued record into the context currently selected. | `web/src/services/syncService.ts:896-923` rebuilds payload with `context.workspaceId` and fallback current farm/season, then retries; UI exposes action in `WorkspaceLayout.tsx:252`. | Wrong-workspace/farm/season financial posting. Remove generic rebind; allow only safe master-specific repair or require switching back to the immutable original context. Test mismatched workspace, farm, season, deletion and financial records. | High |
| SYNC-002 | **P0 confirmed defect; destructive overwrite risk** | A newer incomplete client copy can silently remove valid server fields. | Generic record schema only requires ID/timestamps (`operational-sync.ts:51-62`); several entities lack complete schemas; update replaces payload at `:1055, :1261, :1270` under timestamp LWW. | Historical/name/link/amount corruption. Merge existing payload before entity normalization and validate required invariants; longer term use revisions/field masks. Test partial attendance/labour/account/group updates and stale/newer devices. | High |
| SEC-001 | **P1 confirmed security/error issue** | Users can see SQL/query/internal exception text. Reproduced signup message: `Failed query: select "id" from "users"...`. | Global handler returns `error.message` at `api/src/app.ts:40-47`. | Information disclosure and poor recovery. Log internal detail with correlation ID; return generic 500 response. Preserve intentional 4xx messages. Test thrown DB error and malformed request. | High |
| DEV-001 | **P2 confirmed defect** | README promises local development behavior, but signup queries PostgreSQL before returning “Configure PostgreSQL.” | `session.ts:48` queries DB before `localDevelopmentMode` check at `:51`. | Broken onboarding audit/dev path and leaked raw error through SEC-001. Move guard before DB query or disable signup UI in local mode. | High |
| ACC-001 | **P1 accounting/reconciliation inconsistency** | Reconciliation trace treats a “decrease” adjustment as a positive increase. | Web canonical helper signs by `adjustmentDirection` (`partnerAccounting.ts:240-242`); API trace drops the field and sums raw amount (`accounting-reconciliation.ts:232-236, 463-477`). | Diagnostics can disagree with Partner Position and mislead repair decisions. Carry direction and apply canonical signed effect. Add increase/decrease trace parity tests. | High |
| ACC-002 | **P1 report/reconciliation inconsistency** | Reconciliation purchase-voucher total can include deleted/voided or wrong-season vouchers. | Voucher rows omit lifecycle and scope in `buildPartnerSnapshot`; `purchaseVouchersPaid` at `accounting-reconciliation.ts:215` filters only voucher purpose and account. | Summary/detail mismatch in diagnostic endpoint. Include farm/season/status/deleted fields and canonical active/scope filter. | High |
| AND-001 | **P1 product/architecture decision; sync risk** | Android users do not share the PWA workspace model and remote records lose season identity. | `FirestoreHelper.kt:10-12` uses Firebase UID as workspace document; attendance/advance/voucher payloads omit season; integer IDs and hard deletes differ from PWA. | Cross-client duplicates, unreconcilable seasons, deletion resurrection and no shared multi-user workspace. Retire to import-only or design a server-mediated migration; do not claim Android/PWA multi-device compatibility. | High |
| TEST-001 | **P1 obsolete/invalid integration fixtures and missing verification** | With a dedicated migrated PostgreSQL database, tenant-isolation runs 34/55 and settlement integration 1/6. Failures cascade from fixtures that create labour against a group before the group exists, use fake account IDs now rejected by tenant/account validation, pass string timestamps where Drizzle expects `Date`, and retain obsolete stale-season expectations. | Individual database-backed integration runs plus response tracing; the complete non-database suite passes 115/115. | Rebuild fixtures in valid creation order, use persisted account IDs and typed dates, assert every prerequisite response, then verify settlement idempotency, void/reversal and replay. Android SDK remains unavailable. | High |
| PERF-001 | **P2 performance/technical debt** | Heavy initial/core assets and large maintenance surface. | Build: 358.69 kB core JS, 285.41 kB CSS, 1.109 MB map chunk, 4.03 MB PWA precache; `styles.css` 16,046 lines; `ModulePage.tsx` 5,188 lines; Reports 2,479. | Cache/update cost, regressions, rerenders. Split CSS by route, defer map assets, extract module domains, virtualize large registers. | High |
| UI-001 | **P2 UI/UX/accessibility issue** | Component behavior is inconsistent; large workflows still use many native selects and page-specific modal/table code. | 17 native selects and 159 buttons in ModulePage; 9 native selects in LabourEarnings; sparse ARIA in several pages; no accessibility test command. | Mobile density, keyboard and visual consistency. Adopt shared picker/dialog/form primitives incrementally and add axe/keyboard checks. | Medium-high |
| UI-002 | **P2 information-architecture issue** | Core domains are concentrated in giant multipurpose pages; primary task and history/report actions compete. | ModulePage implements labour, accounts, partner ledger, sales/expenses/dispatch helpers; settlement page is 1,865 lines. | High cognitive/maintenance load. Extract route-level entry/register/detail components without changing formulas. | High |
| SEC-002 | **P2 security/product decision** | Android app permits OS backup of local financial SQLite data. | `AndroidManifest.xml:9 android:allowBackup="true"`. | Device/cloud backup exposure depends on deployment policy. Disable or explicitly encrypt/exclude financial DB before live use. | Medium |

No confirmed P0 accounting formula defect was found in the canonical partner/advance implementation. No claim is made that live totals reconcile.

## 6. Financial-reconciliation report

Reconciles by source inspection and focused unit tests:

- Dated wage-rate resolver is shared by settlement preview and date-aware wage tests; missing non-absence rates are flagged.
- Full partner-funded labour advances remain in partner liability after settlement.
- Settled plus outstanding advances reconcile to total advances within rounding in canonical helpers.
- Voided/deleted/reversed/cancelled settlements are excluded by canonical advance accounting.
- Group settlement uses pooled group advances and avoids individual allocation rows.
- Settlement create uses client request IDs, advisory locking, allocation foreign keys and a read-only status endpoint.

Does not reconcile / remains unverified after implementation:

- ACC-001 and ACC-002 were corrected and covered by focused tests, but representative ledger parity has not been run against real farm records.
- Full posted settlement → account transaction → partner/labour/report reversal remains unverified because the database integration fixtures fail before reaching valid workflow assertions.
- Pending local records versus server snapshot were not exercised across two devices.
- Legacy null farm/season records are intentionally included by some helpers; this preserves imports but can attribute one legacy record to every selected context. This needs a documented legacy attribution policy and migration diagnostics.
- `capitalInjected` is computed but excluded from the specified `farmOwesPartner` formula; confirm terminology with the product owner because contribution, “funds given,” and transfer direction labels overlap semantically.

## 7. Sync and offline report

Safe mechanisms present: immutable queue context fields, active-context filtering, deterministic mutation IDs, server timestamp conflict response, tenant reference validation, soft deletes for key financial records, server snapshot confirmation before pruning, voucher uniqueness checks, settlement-specific request idempotency, bounded exponential retries, failed-item inspection.

Unsafe mechanisms: generic stale repair rebinding; whole-payload LWW replacement; no base revision/ETag; queue order is chronological but no general parent-child dependency graph; manual resolve can clear pending flags without proving server state; Android is a separate sync universe; foreground refresh before upload can produce complex cache state even though queued IDs are protected.

Recommended safeguards:

1. Never mutate ownership context during queue repair. Show original and active contexts and offer “switch to original context,” discard, or export payload.
2. Merge server record with incoming full/partial updates and add an explicit `baseVersion` or revision token for financial edits.
3. Require idempotency keys for every financial create, not only settlements; client record uniqueness helps but should be an explicit API contract.
4. Add tombstone/version conflict tests: server success/lost acknowledgment, local cleanup failure, older-device active replay after delete/void, parent then child offline, and reinstall.

## 8. UI, UX and graphic-design report

Global strengths: coherent green/neutral tokens; extensive safe-area rules; focus-visible styles on shared controls; route shells and lazy loading; clear labelled login; styled loading shell; mobile-specific bottom/sticky actions in several domains.

Global weaknesses: 16k-line stylesheet with duplicated media/dark-mode blocks; giant page components; native selects mixed with custom pickers; uneven ARIA density; many screens depend on tables/horizontal scrolling; no automated contrast/keyboard/screen-reader verification. The 390 px login DOM was complete and labelled, but the audit browser screenshot surface rendered blank, so graphic judgments are based on DOM/CSS and source rather than reliable pixels. Authenticated farm routes could not be created in database-free local mode.

Page scores (Visual / Hierarchy / Ease / Mobile / Desktop / Accessibility / Consistency / Efficiency / Prevention / SaaS):

| Page/domain | Scores | Evidence-based direction |
|---|---|---|
| Login | 7/7/8/8/7/8/7/8/7/7 | Keep compact labelled form; replace raw API errors with recovery copy. |
| Signup/onboarding | 6/5/6/7/6/7/6/5/5/6 | Remove duplicated H1/intro journey on small screens; show database-disabled state in local mode. |
| Admin dashboard | 7/7/7/7/7/6/7/7/7/7 | Metric/action hierarchy is clear; empty sections can be collapsed. |
| Workspace dashboard/navigation | 7/7/7/7/7/6/7/7/7/7 | Keep quick actions and context visibility; verify bottom-nav overflow at 320 px. |
| Workforce/labour | 6/6/6/6/6/6/5/6/7/6 | Split 5k-line module; prioritize search/name/status and move secondary profile data to detail. |
| Groups | 7/7/7/7/7/7/7/7/8/7 | Keep foreman/group snapshots; use full-height sheet for large member selection. |
| Attendance | 7/8/8/8/7/7/7/8/8/7 | Strong mobile-first pattern; keep date/rate warnings visible and provide explicit offline/pending status. |
| Wage rates | 8/8/8/8/8/8/8/8/8/8 | Recent shared modal/history polish is the strongest domain; keep date-range hierarchy. |
| Advances | 7/7/7/8/7/7/7/8/8/7 | Keep searchable labour/account controls; clearly separate labour outstanding from partner liability. |
| Labour work | 5/6/6/5/6/4/4/6/7/5 | Nine native selects, no ARIA markers in source metrics; replace work-target/group/filter controls with shared pickers. |
| Settlements | 6/6/5/6/6/5/6/5/9/6 | Integrity safeguards are strong; form/register/diagnostics in one 1,865-line screen is dense. Use full-page mobile creation and separate register/detail. |
| Expenses | 6/6/6/6/6/6/5/6/8/6 | Preserve voucher number/import safeguards; compact filters and keep repeat-entry open where safe. |
| Accounts/partner ledger | 6/6/5/6/6/6/5/5/7/6 | Make cards drill-down consistently; explain formula once; separate activity from reconciliation detail. |
| Reports | 6/5/5/6/6/6/5/5/6/6 | 2,479 lines and many report modes; move report selection/filtering to compact sticky toolbar and lazy-load outputs. |
| Sales/dispatch | 6/6/6/6/7/6/5/6/8/6 | Preserve linked-quantity safeguards; prioritize product/quantity/customer/date on mobile. |
| Farms/seasons/team | 6/7/7/7/7/5/6/7/8/6 | Add accessible names/status announcements; distinguish destructive deletion requests. |
| Sync inspector | 5/6/5/6/6/6/6/5/2/5 | Statuses are visible, but “repair” is dangerously ambiguous. Original/current context must be explicit. |

## 9. Page-by-page design recommendations

- Dashboard: retain context and quick actions; compact empty admin sections; make every drill-down card consistently interactive and focusable.
- Workforce: keep search/status/group filters in one compact sticky row; name/status first on mobile; move IDs, remarks and history to detail; use full-height member picker.
- Attendance: keep entry as primary action; reports remain a dedicated destination; date + group can share a row at adequate width; sticky save must clear bottom navigation.
- Wage rates: retain current management/history direction; hide derived half-day value unless custom; keep effective period and state most prominent.
- Advances: show “paid by account,” “applied to settlements,” and “remaining labour advance” as three separate values; never label outstanding as partner payable.
- Labour work: replace native controls with searchable shared pickers; group mode shows immutable foreman/member snapshot before save; use repeated-entry workflow.
- Settlements: creation becomes a full page on mobile; register is separate; preview pins reconciliation totals and unresolved rows; destructive void requires consequence summary.
- Expenses: compact category/subcategory and date/account pairs; keep voucher provenance visible in detail; history search should not push records below the first viewport.
- Accounts/partners: clickable summary cards; formula disclosure in expandable detail; source rows reproduce card totals; preserve long partner names over decorative badges.
- Reports: report picker + date/context filters in a sticky compact toolbar; lazy render heavy tables; clear empty/no-results/offline distinctions.
- Sales/dispatch: separate entry and reconciliation views while keeping shared quantity status; mobile cards show product, quantity, date, customer, amount.
- Modals: long settlement, import and multi-select flows should be full-height sheets/full pages on mobile; retain focus trap, Escape/back and unsaved-change protection.

## 10. Performance report

Build succeeds with route chunks, but the generated PWA precaches 101 files / 4.03 MB. Core JS is 358.69 kB plus 297 kB React chunk; global CSS is 285.41 kB; offline-db is 113 kB; ModulePage 197 kB; Reports 93 kB; FarmOperationsMap is 1.109 MB (298 kB gzip) and triggers the chunk warning. The map is lazy/feature-gated, which limits startup cost, but global CSS and core chunks still affect the shell.

Startup code schedules bootstrap/sync work after the cache shell and avoids awaiting full sync before ready—good. Risks are large cache updates, 30-second polling, full table scans during prune, large unvirtualized reports/labour lists, and rerender pressure from monolithic components.

Priorities: route-scoped CSS; extract ModulePage domains; lazy-load export/JSZip only on export; virtualize registers; batch IndexedDB writes already performed in some imports should become the norm; measure Web Vitals and queue/prune duration before optimizing formulas.

## 11. Security and isolation report

Positive: bearer sessions, server-side auth prehandlers, module permissions, selected workspace/farm/season checks, composite tenant FKs on generic records, farm assignment checks, owner/admin gating, invitation matching tests, CORS allowlist, login/signup rate limits, and no frontend-authoritative settlement posting.

Risks: raw 500 errors (SEC-001); stale repair crosses context (SYNC-001); JSON payload replacement bypasses full entity invariants (SYNC-002); diagnostic transaction query is not initially workspace-scoped and relies on matching settlement references, which should be tightened defensively; Android backup and separate Firebase ownership model; service-worker precache is public application code only, while IndexedDB financial data remains available to the browser origin and must be cleared reliably on logout/workspace switch (a source test covers this).

## 12. Test-gap report

Missing or unavailable evidence: valid end-to-end PostgreSQL settlement create/timeout/status/retry; full void reversal; multi-device edit/delete resurrection; server-success/lost-ack replay; accessibility/contrast; 320/360/375/412/landscape authenticated routes; keyboard-open forms; service-worker upgrade; Android/PWA coexistence; Android migration and instrumentation. Focused tests now cover stale-context repair wiring, partial-payload preservation, signed adjustments, and deleted/season-scoped reconciliation vouchers.

The suite contains many source-string tests. These are useful wiring guards but do not prove calculations, database atomicity, rendering or accessibility. CI should report unit/source tests separately from integration tests and provision a disposable migrated Postgres. Existing tests that require `DATABASE_URL` should fail once at suite setup, not produce dozens of apparent product failures.

## 13. Safe implementation plan

| Phase | Exact scope / likely files | Risk, tests, deployment and rollback |
|---|---|---|
| 1 — P0 integrity | Remove context rebinding in `syncService.ts`/`WorkspaceLayout.tsx`; merge existing server payload before update in `operational-sync.ts` | Low migration risk, high behavioral importance. Unit/source + DB integration for wrong context, partial records, replay and tombstones. Deploy API before web if contract changes; rollback only with queue inspector disabled. |
| 2 — P1 logic | Fix signed adjustments and voucher lifecycle/scope in `accounting-reconciliation.ts`; sanitize global 500 responses | No migration. Add parity and error-envelope tests. Deploy API alone; monitor 4xx/5xx and reconciliation deltas. |
| 3 — reconciliation | Run representative fixture ledger through summaries, details, account transactions and voids | May reveal data repair need; migrations only after dry-run diagnostics and backup. |
| 4 — offline hardening | Add revision/base-version conflicts, universal financial idempotency keys, parent-child ordering, tombstone tests | Possible schema migration for revisions/idempotency; backfill and backward-compatible API required. Staged deployment and queue drain plan. |
| 5 — performance | Route CSS, lazy exports, virtualization, measured IndexedDB batching | No data migration; visual and offline regression tests; deploy independently. |
| 6 — design system | Canonical picker, button, dialog/sheet, state and filter components | Incremental only; screenshot/a11y regression at required viewports. |
| 7 — page UX | Split settlement/register/detail, reports toolbar, labour work controls, partner drill-down | Preserve formulas and route aliases; mobile-first acceptance tests. |
| 8 — accessibility | axe, keyboard, focus trap, announcements, contrast, tap targets | No data risk; automated and manual screen-reader checks. |
| 9 — cleanup | Decide Android active/retired; split monoliths; remove placeholders/retired paths | Product decision required. If Android remains, create explicit server migration architecture before live sync. |

### Migration policy for future schema changes

Every migration must state business and technical reason, dry-run/backfill strategy, legacy null-scope handling, rollback risk, indexes, API/PWA/IndexedDB impacts, sync-version compatibility and tests. The confirmed Phase 1/2 fixes in this report require no database migration.

## Audit limitations

- No live or representative farm ledger was accessed; totals above are formula/source assessments only.
- Valid database workflow integration, multi-device, physical mobile keyboard, Android instrumentation and service-worker upgrade paths remain unverified.
- The in-app browser visually returned a blank screenshot despite a complete DOM; pixel-level scores are therefore conservative and based on layout/style implementation plus DOM inspection.
- Local development exposes only a platform-admin in-memory session when PostgreSQL is absent, so authenticated operational pages could not be exercised interactively.

## 14. Implementation and final verification result

Implementation followed the plan above and was limited to confirmed P0/P1 corrections plus the directly related local-development defect. No schema migration was added.

### Confirmed fixes

| Finding | Correction | Verification |
|---|---|---|
| SYNC-001 | Generic stale-context repair now rejects the operation and never rewrites queued workspace/farm/season ownership. The UI exposes repair only for the narrowly safe date-type repair. | Focused source test, type check, non-database suite and production build pass. Multi-device runtime remains outstanding. |
| SYNC-002 | Operational-sync updates merge the stored payload with incoming fields instead of replacing the complete JSON payload with an incomplete newer copy. | Focused source test, type check and build pass. Revision/ETag conflict handling remains a Phase 4 safeguard. |
| SEC-001 | Intentional 4xx errors remain visible; unexpected 5xx responses return a generic message and request ID while full detail stays server-side. | Focused source test; local signup no longer exposes SQL and returns the intended 503 database-configuration message. |
| DEV-001 | Local-development signup checks database availability before querying users. | Local API/PWA reproduction changed from raw SQL error to `503 Configure PostgreSQL to create accounts.` |
| ACC-001 | Reconciliation carries adjustment direction and subtracts partner decreases. | Focused unit test passes. |
| ACC-002 | Reconciliation voucher totals now apply lifecycle, farm and season filtering compatible with the canonical client definition. | Focused unit test passes. |

Three obsolete source/accounting expectations were updated only where repository evidence proved current behavior: current wage-settlement labels/formula guards, current labour-work copy, and the partner fixture total implied by its supplied records. Production formulas were not changed to satisfy those tests.

### Commands and results

- `npm run check`: pass.
- Focused audit-integrity and reconciliation tests: 5/5 pass.
- Complete non-database API suite: 115/115 pass.
- `npm run build`: API and PWA pass. The build still warns about the 1,108.63 kB map chunk; core JS is 358.69 kB, CSS 285.41 kB, and the PWA precache is 4,027.34 KiB across 101 entries.
- Dedicated PostgreSQL database initialization: pass; migrations 0001–0034 applied.
- Tenant-isolation integration file: 34/55 pass; 21 fail, primarily from invalid/stale prerequisites described in TEST-001.
- Settlement integration file: 1/6 pass; 5 fail from the same fixture-order/account-ID issues plus string timestamp typing.
- Android Gradle tests: not started because `ANDROID_HOME`/`local.properties` is unavailable.
- `git diff --check`: pass; only line-ending conversion warnings were reported by status/diff inspection.

### Completion status

- Remaining confirmed P0: none in the implemented scope. The fixed sync paths still require multi-device and lost-ack runtime verification before production approval.
- Remaining P1: Android/PWA architecture decision (AND-001), stale database integration fixtures and unverified end-to-end settlement/void/replay behavior (TEST-001), and production-like ledger reconciliation.
- Remaining P2/P3: performance, monolithic UI/CSS, component consistency, accessibility automation and page-level visual refinements listed above.
- Recommended deployment order: API fixes first, focused smoke/reconciliation run, then PWA sync-inspector change. Do not deploy Android as a compatible live client until its role is decided.
- Rollback: these fixes have no data migration. Roll back API and PWA together only if monitoring exposes a regression; never restore context rebinding or whole-payload replacement as a queue-recovery shortcut.
