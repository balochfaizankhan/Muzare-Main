# Labour Advance and Account Linkage Fix — 2026-07-21

## Root cause

1. Labour advance consumers were not using one source of truth.
   - The shared labour financial read model exposed canonical advances, but the `/labour-payments/advances` route, Dashboard, Reports, Accounts, and Partner Position were still mixing separate legacy and canonical calculations.
   - Canonical-only advances could disappear from the Advance Report.
   - Legacy-only advances could appear in one screen and not another.
   - Linked canonical/legacy mirrors could be counted twice.

2. Labour Payment voucher funding attribution was incomplete in the UI.
   - The voucher register fell back to local IndexedDB account lookups and then `"Legacy / reconciliation"`.
   - It did not reliably use the canonical payment account id, linked account transaction account id, or preserved stable legacy account identifiers already available from the API/read model.

3. Partner and account breakdowns were reconstructing labour movements independently.
   - Partner Position and account-facing summaries were still starting from legacy partner/account calculators and only partially overlaying canonical Labour Payments values.
   - That let `farmOwesPartner`, `directLabourPayments`, `appliedLabourAdvances`, and `outstandingLabourAdvances` drift apart between screens.

## Files changed

- [api/src/lib/labour-financial-read-model.ts](/E:/Muzare%20VS%20Code/Muzare-Main/Muzare-Main/api/src/lib/labour-financial-read-model.ts)
- [api/src/routes/labour-payments.ts](/E:/Muzare%20VS%20Code/Muzare-Main/Muzare-Main/api/src/routes/labour-payments.ts)
- [api/test/labour-advance-read-model.test.ts](/E:/Muzare%20VS%20Code/Muzare-Main/Muzare-Main/api/test/labour-advance-read-model.test.ts)
- [api/test/labour-advance-outstanding.source.test.ts](/E:/Muzare%20VS%20Code/Muzare-Main/Muzare-Main/api/test/labour-advance-outstanding.source.test.ts)
- [api/test/frontend-isolation.source.test.ts](/E:/Muzare%20VS%20Code/Muzare-Main/Muzare-Main/api/test/frontend-isolation.source.test.ts)
- [web/src/lib/api.ts](/E:/Muzare%20VS%20Code/Muzare-Main/Muzare-Main/web/src/lib/api.ts)
- [web/src/pages/DashboardPage.tsx](/E:/Muzare%20VS%20Code/Muzare-Main/Muzare-Main/web/src/pages/DashboardPage.tsx)
- [web/src/pages/ModulePage.tsx](/E:/Muzare%20VS%20Code/Muzare-Main/Muzare-Main/web/src/pages/ModulePage.tsx)
- [web/src/pages/workspace/Reports.tsx](/E:/Muzare%20VS%20Code/Muzare-Main/Muzare-Main/web/src/pages/workspace/Reports.tsx)
- [web/src/pages/workspace/WorkforceHub.tsx](/E:/Muzare%20VS%20Code/Muzare-Main/Muzare-Main/web/src/pages/workspace/WorkforceHub.tsx)
- [web/src/pages/workspace/WorkforcePayments.tsx](/E:/Muzare%20VS%20Code/Muzare-Main/Muzare-Main/web/src/pages/workspace/WorkforcePayments.tsx)

## Unified advance-source rules

- Canonical advance positions now come from the shared labour financial read model.
- The unified register includes:
  - canonical-only advances
  - legacy operational advances
  - legacy normalized advances
  - canonical advances linked to preserved legacy mirrors
- `sourceClassification` explicitly distinguishes:
  - `CANONICAL`
  - `CANONICAL_LINKED_LEGACY`
  - `LEGACY_OPERATIONAL`
  - `LEGACY_NORMALIZED`
- Active totals are now calculated from one scoped register:

  `total advances = outstanding + applied + recovered`

- Voided advances remain visible in history, but are excluded from active totals.

## Stable deduplication strategy

- Deduplication is by stable ids only:
  - canonical `sourceId`
  - canonical `legacySourceRecordId`
  - preserved legacy `clientRecordId`
  - preserved legacy record id
- No name/date/amount/display-text matching is used.
- Similar-looking but unlinked records remain separate.
- Unresolved historical funding mappings are not dropped; they stay visible and are marked `needsReview`.

## Voucher-account mapping strategy

- Voucher and advance funding attribution now resolves in this order:
  1. canonical stored payment account id
  2. linked account transaction account id
  3. preserved stable legacy ids through `resolveAccountIdentity`
  4. fallback display name only as a non-authoritative review state
- Name fallback is not used to auto-bind accounts.
- If no stable mapping exists:
  - the record remains visible
  - `needsReview` is set
  - no guessed partner/account is assigned

## Before / after totals

Controlled browser/API fixture:

- legacy advance: 20
- canonical advance: 40
- advance applied: 30
- direct partner-funded labour payment: 50
- labour due: 100

### Expected canonical state

| Metric | Expected |
| --- | ---: |
| Total advances | 60 |
| Applied to labour dues | 30 |
| Outstanding advances | 30 |
| Recovered / refunded | 0 |
| Wage expense | 100 |
| Direct labour payments | 50 |
| Farm Owes Partner | 110 |
| Remaining labour due | 20 |

### Observed state after fix

| Consumer | Total | Outstanding | Applied | Recovered | Notes |
| --- | ---: | ---: | ---: | ---: | --- |
| Unified API read model | 60 | 30 | 30 | 0 | `summary.totalAdvance/outstandingAdvance/activeAdvanceApplied/recoveredAdvance` |
| Dashboard | — | 30 | — | — | Labour Advances KPI |
| Advances page | 60 | 30 | 30 | 0 | Shows canonical + legacy rows together |
| Advance Report | 60 | 30 | 30 | 0 | 2 transactions, 1 labourer |
| Partner Position | — | 30 | 30 | 0 | `farmOwesPartner = 110`, `directLabourPayments = 50` |
| Accounts | — | — | — | — | partner account card shows `SAR 110`, expense visibility shows `SAR 100` |
| Voucher register | — | — | — | — | direct payment voucher shows real partner account name |

## Cross-module reconciliation

| Surface | Expected | Actual | Result |
| --- | ---: | ---: | --- |
| Dashboard Labour Advances | 30 | 30 | PASS |
| Advances register total | 60 | 60 | PASS |
| Advances register applied | 30 | 30 | PASS |
| Advances register outstanding | 30 | 30 | PASS |
| Advance Report total | 60 | 60 | PASS |
| Advance Report outstanding | 30 | 30 | PASS |
| Wage expense | 100 | 100 | PASS |
| Partner Position Farm Owes Partner | 110 | 110 | PASS |
| Partner Position direct labour payments | 50 | 50 | PASS |
| Partner Position outstanding labour advances | 30 | 30 | PASS |
| Voucher funding account | Fixture partner account | Fixture partner account | PASS |

## Remaining ambiguous records

- None were created in the controlled fixture.
- The implementation keeps ambiguous historical mappings visible with `needsReview` and `reviewReason`; it does not guess.

## Focused test results

Focused tests run before the broad suite:

- `npx.cmd tsx --test api/test/labour-advance-read-model.test.ts` → 5 passed, 0 failed
- `npx.cmd tsx --test api/test/labour-advance-outstanding.source.test.ts` → 14 passed, 0 failed
- `npx.cmd tsx --test api/test/frontend-isolation.source.test.ts` → 43 passed, 0 failed
- `npx.cmd tsx --test web/test/labour-financial-context.source.test.ts` → 2 passed, 0 failed

## Full test and build results

- `npm.cmd run check --workspace api` → PASS
- `npm.cmd run check --workspace web` → PASS
- `npm.cmd run build --workspace api` → PASS
- `npm.cmd run build --workspace web` → PASS
- `npx.cmd tsx --test web/test/*.test.ts` → 11 passed, 0 failed

Broad API suite:

- `npm.cmd run test:integration --workspace api` was run once, per instruction.
- That run exercised source/unit coverage successfully, but the suite as a whole failed before clean completion because the environment was missing the isolated PostgreSQL integration-test variables expected by:
  - `api/test/labour-wage-settlements.integration.test.ts`
  - `api/test/tenant-isolation.integration.test.ts`
  - `api/test/migration-0035.postgres.test.ts` (`MIGRATION_TEST_DATABASE_URL`)
- After that single broad run, I initialized a separate disposable DB only for browser verification and did not rerun the full API suite again.

## Browser evidence

Controlled browser fixture database:

- `postgresql://postgres:postgres@localhost:5432/muzare_labour_browser_fix_20260721`

Verified browser facts:

- PWA rendered successfully; no blank-app condition remained.
- Console warnings/errors on exercised pages: none.
- Desktop verification completed on:
  - Dashboard
  - Labour Payments → Advances
  - Reports → Advances
  - Accounts
  - Labour Payments → Payment Vouchers
  - Partner Ledger / Partner Position
- Mobile verification completed at `390×844` on the Advances register.

Captured screenshots:

- [Dashboard Labour Advances](/E:/Muzare%20VS%20Code/Muzare-Main/Muzare-Main/tmp/browser-check/screenshots/01-dashboard-labour-advances.png)
- [Advances register](/E:/Muzare%20VS%20Code/Muzare-Main/Muzare-Main/tmp/browser-check/screenshots/02-advances-register.png)
- [Advance Report](/E:/Muzare%20VS%20Code/Muzare-Main/Muzare-Main/tmp/browser-check/screenshots/03-advance-report.png)
- [Accounts breakdown](/E:/Muzare%20VS%20Code/Muzare-Main/Muzare-Main/tmp/browser-check/screenshots/04-accounts-breakdown.png)
- [Payment voucher register](/E:/Muzare%20VS%20Code/Muzare-Main/Muzare-Main/tmp/browser-check/screenshots/05-payment-voucher-register.png)
- [Partner Position](/E:/Muzare%20VS%20Code/Muzare-Main/Muzare-Main/tmp/browser-check/screenshots/06-partner-position.png)
- [Mobile Advances register](/E:/Muzare%20VS%20Code/Muzare-Main/Muzare-Main/tmp/browser-check/screenshots/07-mobile-advances-register.png)

## Migration evidence

Disposable browser-fixture DB initialized cleanly from:

- `0001_initial.sql`
- through `0041_exact_labour_journal_reversals.sql`

Command:

- `$env:DATABASE_URL='postgresql://postgres:postgres@localhost:5432/muzare_labour_browser_fix_20260721'; npm.cmd run db:init --workspace api`

Result:

- clean migration pass completed successfully

## Existing-data risk

- Historical records with preserved stable ids now reconcile more safely because canonical/legacy deduplication no longer depends on incomplete page-specific coverage.
- Historical records without stable funding-account mappings are intentionally left under review rather than auto-attributed.
- No production data was modified.

## Remaining deferred defects

Still deferred by scope:

- hold workflow
- advance edit/delete lifecycle
- date/timezone defects
- offline queue
- other missing reports
- voucher printing
- sorting/pagination redesign
- labour due edit/delete
- application-reversal UI
- general UI redesign
- legacy route cleanup

## Git status

- Branch target: `dev`
- `main` was not touched
- Production data was not touched
- Controlled browser fixture used a disposable local PostgreSQL database only

## Conclusion

The unified Advances position now includes legacy and canonical records without double counting, all advance consumers use the same scoped totals, and Labour Payment vouchers with proven account mappings appear in the correct account and Partner Position. Ambiguous historical mappings remain explicitly flagged for review.
