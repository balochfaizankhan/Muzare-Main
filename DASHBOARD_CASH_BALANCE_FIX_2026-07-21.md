# Dashboard Cash Balance Fix — July 21, 2026

## Scope

Focused only on the Dashboard Cash Balance defect.

Not changed:

- labour advances logic
- partner balances logic
- wage rates
- offline queue design
- unrelated dashboard cards
- production data

## Root cause

The dashboard `Cash Balance` card was not reading the scoped cash-account balance.

It was populated in [DashboardPage.tsx](E:/Muzare VS Code/Muzare-Main/Muzare-Main/web/src/pages/DashboardPage.tsx) from:

- `calculateAvailableBalance(activeAccounts, activeSales, cashAffectingVouchers, activeAdvances, activeEntries, activeSettlements)`
- plus `canonicalFinancials.data?.summary.accountMovement`

That combines:

- non-partner local account movement across account types
- canonical labour account movement

So the dashboard card was effectively showing a broader net position, not the actual cash-account balance. That is the direct source path for the incorrect `SAR 102,330` figure reported in the reproduction.

The Accounts module used a different calculation path:

- per-account `calculateAccountBalance(...)`
- plus canonical `accountEntries` filtered to the exact account id

So Dashboard and Accounts were not reading the same financial fact.

## Fix

Introduced one shared scoped balance path in [web/src/lib/accounting.ts](E:/Muzare VS Code/Muzare-Main/Muzare-Main/web/src/lib/accounting.ts):

- `calculateDisplayedAccountBalance(...)`
- `calculateScopedCashAccountBalance(...)`

New dashboard rule:

- Dashboard Cash Balance = sum of active scoped `cash` accounts only
- plus only canonical account entries linked to those same cash accounts

The dashboard no longer uses:

- `calculateAvailableBalance(...)`
- `canonical summary.accountMovement`

for the cash card.

Also invalidated the old cached dashboard financial snapshot key from `v2` to `v3` so stale incorrect cash snapshots are not rehydrated.

## Files changed

- [web/src/lib/accounting.ts](E:/Muzare VS Code/Muzare-Main/Muzare-Main/web/src/lib/accounting.ts)
- [web/src/pages/DashboardPage.tsx](E:/Muzare VS Code/Muzare-Main/Muzare-Main/web/src/pages/DashboardPage.tsx)
- [web/src/pages/ModulePage.tsx](E:/Muzare VS Code/Muzare-Main/Muzare-Main/web/src/pages/ModulePage.tsx)
- [web/src/lib/dashboardFinancialSnapshot.ts](E:/Muzare VS Code/Muzare-Main/Muzare-Main/web/src/lib/dashboardFinancialSnapshot.ts)
- [web/test/dashboard-financial-summary.source.test.ts](E:/Muzare VS Code/Muzare-Main/Muzare-Main/web/test/dashboard-financial-summary.source.test.ts)
- [web/test/dashboard-cash-balance.test.ts](E:/Muzare VS Code/Muzare-Main/Muzare-Main/web/test/dashboard-cash-balance.test.ts)

## Old vs new behaviour

| Behaviour | Before | After |
| --- | --- | --- |
| Dashboard cash source | broad available-balance helper + canonical labour movement | scoped cash-account balance only |
| Dashboard vs Accounts | could disagree | uses the same shared account-display balance path |
| Mid-load cash label | could show stale/wrong cached value | holds settled snapshot and shows `Updating balance...` while unresolved |
| Cached wrong snapshot | possible | invalidated with new snapshot storage key |

## Verification

### Focused tests

- `web/test/dashboard-financial-snapshot.test.ts`
- `web/test/dashboard-financial-summary.source.test.ts`
- `web/test/dashboard-cash-balance.test.ts`

Result: 7 passed, 0 failed.

### Full web test sweep

Command ran once across all `web/test/*.test.ts`.

Result: 18 passed, 0 failed.

### Type checks and builds

- Web check: passed
- API check: passed
- Web build: passed
- API build: passed

### Full API integration sweep

Ran once as requested for broader regression awareness.

Result: failed on pre-existing unrelated tests outside this dashboard-cash scope, including:

- `partner settlements transfer matching account and partner positions without changing business totals`
- `frontend-isolation.source.test.ts`
- `labour-wage-settlements.integration.test.ts`
- `tenant-isolation.integration.test.ts`

No failing API test pointed to the dashboard cash helper change itself.

### Browser verification

Attempted real PWA verification against local dev servers.

Observed blockers:

1. Initial local API CORS mismatch for `http://127.0.0.1:4174`
2. After correcting local dev CORS, the in-app browser still blocked direct localhost API navigation with:
   - `net::ERR_BLOCKED_BY_CLIENT`
3. Because of that browser-localhost restriction, login could not complete in the in-app browser, so dashboard/account screenshots of the authenticated financial state could not be captured in this thread.

This is a verification blocker, not a claimed pass.

## Commands run

- focused web tests via `tsx --test`
- `npm run check --workspace web`
- `npm run check --workspace api`
- `npm run build --workspace web`
- `npm run build --workspace api`
- full web tests via `tsx --test web/test/*.test.ts`
- full API integration sweep via `npm run test:integration --workspace api`
- `git diff --check`

## Existing-data / production-data note

No production data was touched.

This fix changes only how the dashboard cash card is calculated and cached in the web app.

## Conclusion

The dashboard cash card now reads the scoped cash-account balance instead of a broader net-position calculation, and the shared helper aligns Dashboard with the Accounts balance path.

Browser proof of the authenticated dashboard/account values remains blocked in this thread by the in-app browser’s localhost API restriction.
