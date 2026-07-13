# Muzare PostgreSQL Settlement Readiness Report

Date: 2026-07-13
Scope: PostgreSQL fixtures, tenant isolation, wage-settlement posting, idempotency, void reversal, and reconciliation.

## Outcome

The repaired database verification layer passes on a clean, disposable PostgreSQL database. Migrations 0001 through 0034 apply successfully; tenant isolation passes 55/55; settlement integration passes 7/7; the full API test command passes 171/171; the non-database subset passes 109/109; type checks and both production builds pass.

The settlement suite increased from six to seven tests. No test was removed. The added test strengthens coverage for advance cutoffs, partial application, deleted advances, partner liability, report reconciliation, non-cash voiding, and re-settlement after void.

This branch is ready for controlled financial testing in staging. It is not yet evidence of authoritative production readiness because representative production data, real two-device behavior, Android runtime behavior, and service-worker upgrade behavior were not exercised in this phase.

## Root-cause summary

### Invalid fixture defects

- Fixtures reused fake account identifiers such as season-derived `local-cash` values instead of persisted account records.
- Labourers could be created before their labour group or foreman relationships were valid.
- Direct Drizzle inserts supplied API-style strings where timestamp columns require JavaScript `Date` values.
- Setup calls were allowed to fail without a useful prerequisite assertion, producing misleading cascades.
- Voucher/category and wage-rate prerequisites were absent in scenarios that expected them.
- Several assertions depended on records left by earlier tests rather than measuring rows created by the current request.

### Obsolete expectations

- Session bootstrap formerly expected a null season even when a valid active season exists. Current session behavior intentionally repairs/selects the active context.
- A normal voucher edit formerly expected the prior number to remain displayed. The current contract permits an explicit new voucher number while retaining imported-number provenance separately.
- A voucher-sequence assertion expected a value above 42 because of hidden historical state. It now proves a positive, unique sequence without depending on another test.
- An attendance report fixture expected a stored fallback wage without creating a date-effective wage rate. The valid test now supplies the required wage-rate source of truth.

### Genuine production defects proven by valid PostgreSQL tests

1. An unfiltered labour-earnings lookup returned no group earnings, so group earnings could disappear from preview, posting, and void reopening.
2. Concurrent settlements with different idempotency keys could both post overlapping source records.
3. Zero-cash settlements could not be voided even when they had advance allocations and settlement linkages to reverse.
4. The all-labour advance report omitted allocations by accidentally selecting only ungrouped allocations.
5. The all-labour advance ledger passed no labour IDs to its canonical scope.
6. Labour dependency preview could ignore current operational attendance/advance rows.
7. Farm-scoped dispatch master records were incorrectly rejected by a season validation that the write model intentionally does not store.
8. Voucher provenance fields incorrectly reserved display numbers, preventing a valid current voucher number from being used.

### Environment limitations

- Tests used a local disposable PostgreSQL database, not production or a restored production snapshot.
- No configured lint script exists in the root, API, or web package manifests.
- True network-loss acknowledgement, two physical devices, Android WebView, and service-worker upgrade paths were not exercised.

## Fixture dependency map

```text
Authenticated user
-> Workspace
-> Workspace membership and permissions
-> Farm
-> Season
-> Selected workspace/farm/season session context
-> Persisted operational and typed payment/partner accounts
-> Labour group
-> Labourers and foreman assignment
-> Date-effective wage rates
-> Attendance / individual work / group work / advances
-> Settlement preview
-> Settlement posting
-> Settlement allocations / advance allocations / account transaction
-> Reports / partner position / advance ledger / reconciliation
-> Void / reversal / re-settlement
```

Every repaired helper returns a persisted response and validates the expected status and UUID before a dependent step proceeds. Failed setup diagnostics identify the step and include the safe response body.

## Files changed in this phase

### Test fixtures and cases

- `api/test/tenant-isolation.integration.test.ts`
- `api/test/labour-wage-settlements.integration.test.ts`
- `api/test/labour-wage-settlements.source.test.ts`

### Shared test helpers

- `api/test/helpers/integration-response.ts`

### Production API

- `api/src/lib/labour-advance-ledger.ts`
- `api/src/lib/labour-earnings.ts`
- `api/src/lib/voucher-numbers.ts`
- `api/src/routes/advance-report.ts`
- `api/src/routes/labour-management.ts`
- `api/src/routes/labour-wage-settlements.ts`
- `api/src/routes/operational-sync.ts`

### Production web

- None in this phase.

### Database and migrations

- None. No schema migration was required.

Other modified files in the working tree belong to the preceding audit phase and were preserved.

## Fixture corrections

- Creation order now follows persisted foreign-key dependencies.
- All reused IDs come from successful persisted responses; fake and placeholder IDs were removed.
- Database timestamps use deterministic JavaScript `Date` values; API calendar dates use deterministic ISO `YYYY-MM-DD` strings.
- The scenarios explicitly select and retain the correct workspace, farm, and season.
- Start-date and end-date inclusivity are tested along with one-day-before and one-day-after exclusions.
- Advances before and during the cutoff are eligible; advances after the cutoff are excluded.
- Wage rates are date-effective, including changes inside the settlement period.
- Prerequisite requests fail immediately with the setup step, expected status, actual status, and response body.
- Test assertions use per-request identifiers and row-count deltas instead of relying on prior test state.

## Settlement verification

| Scenario | Expected result | Actual result | Test file | Result |
| --- | --- | --- | --- | --- |
| Repeated preview | Same totals, no persisted settlement | Deterministic and read-only | `labour-wage-settlements.integration.test.ts` | Pass |
| Posting | Preview totals and source records persist exactly once | Gross, advances, net, allocations, and linkages match | Same | Pass |
| Duplicate request | Same idempotency key returns one posting | One settlement and one account transaction | Same | Pass |
| Lost acknowledgement | Retry recovers committed result | Stable settlement ID; no second posting | Same | Pass |
| Concurrent request | Overlapping different-key request conflicts | One 200 and one 409; no partial duplicate | Same | Pass |
| Advance application | Before/during eligible, after cutoff excluded, partial application supported | Persisted allocation and outstanding balance match | Same | Pass |
| Account effect | Cash payable posts once | Transaction amount matches net payable | Same | Pass |
| Partner effect | Full partner-funded advance remains farm liability | Liability remains 500 before, after posting, and after void | Same | Pass |
| Void | Historical settlement retained but active effects excluded | Status voided; account effect net zero; links reopened | Same | Pass |
| Reversal | Advance allocation and operational linkages reverse | Outstanding advances restore exactly | Same | Pass |
| Re-settlement | Released source records can be settled again | New valid posting succeeds after void | Same | Pass |
| Wrong context | Cross-workspace/farm/season records rejected or excluded | Tenant suite validates direct API boundaries | `tenant-isolation.integration.test.ts` | Pass |
| Deleted records | Deleted advance/source records do not enter active settlement | Deleted advance excluded; lifecycle tests pass | Both integration files | Pass |
| Group history | Current membership/name changes do not rewrite posted meaning | Snapshot remains stable after group rename | `labour-wage-settlements.integration.test.ts` | Pass |

## Deterministic reconciliation

The partial-advance, non-cash scenario uses one partner-funded advance of 500 and gross earnings of 150.

| Value | Before posting | After posting | After void |
| --- | ---: | ---: | ---: |
| Active account-transaction effect | 0 | 0 | 0 |
| Farm owes partner | 500 | 500 | 500 |
| Total valid advances | 500 | 500 | 500 |
| Applied advances | 0 | 150 | 0 |
| Outstanding advances | 500 | 350 | 500 |
| Active settlement gross wages | 0 | 150 | 0 |
| Active settlement net payable | 0 | 0 | 0 |

This proves the required separation: settlement application reduces labour-side outstanding advances but does not erase the farm's liability for the full partner-funded outflow.

A separate cash scenario proves gross earnings of 200, applied advances of 130, net cash payable of 70, a single account transaction of 70, and a net-zero account effect after void. Report detail and summary totals are asserted from persisted rows.

## Production corrections

| Confirmed defect | Root cause | Smallest correction | Regression evidence | Data/migration/rollback impact |
| --- | --- | --- | --- | --- |
| Group earnings absent when listing all earnings | Empty filters were treated as an empty result | Return all normalized earnings for unfiltered calls | Group preview/post/void scenario | No migration; reverting reintroduces omitted earnings |
| Concurrent overlapping posting | Lock was scoped to request ID, not settlement source scope | Acquire a farm/season advisory lock and recompute preview inside the transaction | Concurrent different-key integration request | No data rewrite; revert restores duplicate-posting risk |
| Non-cash settlement could not be voided | Void route incorrectly required an account transaction | Permit void when settlement effects exist without cash | Partial-advance non-cash void and re-settlement | No migration; revert strands allocations/linkages |
| All-labour report omitted applied advances | Empty labour scope selected only ungrouped allocations | Pass all persisted labour IDs to canonical ledger | Reconciliation assertions | No migration |
| Canonical ledger missed grouped allocations in report-all mode | Allocation query constrained `groupId IS NULL` | Include all settlement allocations for report-all scope | Advance totals before/post/void | No migration |
| Dependency preview missed current rows | Only legacy typed stores were considered | Prefer operational attendance/advances, retain legacy fallback without double count | Tenant lifecycle suite | No migration |
| Dispatch master rejected valid season context | Validation required a season the record intentionally does not persist | Validate dispatch masters at farm scope | Tenant integration coverage | No migration |
| Valid voucher number blocked by provenance | Imported/original number fields were included in active uniqueness | Reserve current `voucherNumber` only | Tenant voucher tests | No migration; provenance remains traceable |

## Exact commands and results

| Command | Result |
| --- | --- |
| `createdb.exe -h localhost -U postgres muzare_settlement_readiness_20260713` | Disposable database created |
| `$env:DATABASE_URL='postgresql://postgres:postgres@localhost:5432/muzare_settlement_readiness_20260713'; npm.cmd run db:init --workspace api` | Migrations 0001-0034 applied successfully |
| `$env:DATABASE_URL='postgresql://postgres:postgres@localhost:5432/muzare_settlement_readiness_20260713'; .\\node_modules\\.bin\\tsx.cmd --test api/test/tenant-isolation.integration.test.ts` | 55 tests, 55 passed, 0 failed |
| `$env:DATABASE_URL='postgresql://postgres:postgres@localhost:5432/muzare_settlement_readiness_20260713'; .\\node_modules\\.bin\\tsx.cmd --test api/test/labour-wage-settlements.integration.test.ts` | 7 tests, 7 passed, 0 failed |
| `$files = Get-ChildItem api/test -Recurse -Filter '*.test.ts' \| Where-Object { $_.Name -notlike '*.integration.test.ts' } \| ForEach-Object { $_.FullName }; .\\node_modules\\.bin\\tsx.cmd --test $files` | 109 tests, 109 passed, 0 failed |
| `$env:DATABASE_URL='postgresql://postgres:postgres@localhost:5432/muzare_settlement_readiness_20260713'; npm.cmd run test:integration --workspace api` | 171 tests, 171 passed, 0 failed |
| `npm.cmd run check` | API and web type checks passed |
| `npm.cmd run build --workspace api` | API production build passed |
| `npm.cmd run build --workspace web` | PWA production build passed; 1,926 modules transformed |
| `git diff --check` | Passed |
| Lint | Not configured |

The PWA build retains a pre-existing warning for a map chunk above 500 kB. Performance refactoring was outside this phase.

## Remaining risks

- Real concurrent behavior across two physical devices and adverse mobile networks remains unverified.
- The lost-ack path is proven through same-key replay against a committed database result, but not through an injected TCP disconnect at the server boundary.
- Production or representative restored data was not reconciled; only deterministic integration records were used.
- Android/WebView compatibility and background-sync scheduling were not exercised.
- Service-worker upgrade and stale-client resurrection behavior were not browser-tested in this phase.
- Accessibility and visual behavior were outside this task.
- Existing production rows should be checked for duplicates or stranded non-cash settlements before rollout, because this phase prevents future defects but does not claim to repair unknown live data.

## Deployment recommendation

**Ready for controlled financial testing.**

Recommended order:

1. Deploy to an isolated staging environment with production-equivalent PostgreSQL settings.
2. Run the clean migration and all 171 API tests there.
3. Reconcile a sanitized representative dataset, especially partner-funded advances and historical non-cash settlements.
4. Perform a two-device retry/void/re-settlement smoke test under interrupted connectivity.
5. Promote only after finance users confirm preview, posted voucher, advance ledger, partner position, and post-void reports for the same scenario.

Rollback is application-only because no migration was added. If rolled back after new settlements have been posted, preserve all rows and inspect concurrent/conflicted and non-cash settlement records rather than deleting historical data.
