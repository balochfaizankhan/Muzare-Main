## Labour advance reconciliation and voucher linkage fix

Date: July 21, 2026
Branch: `dev`

### Root causes

1. Recipient and payment-source presentation diverged across screens. The shared advance read model did not supply one authoritative `recipientDisplayName` / `paymentSourceDisplayName`, so some surfaces fell back to generic values.
2. Partner-funded advance balances were being calculated through different paths. The generic account-balance path suppressed replaced legacy advances once canonical labour data loaded, but it only added back canonical `accountEntries`, not the full merged canonical partner position that still includes linked historical partner-funded advances.
3. Original advance UI surfaces were still exposing source-voucher application lifecycle fields (`Applied`, `Outstanding`, `FULLY_APPLIED`) even though the user-facing model is aggregate advance-pool application.

### Files changed

- [api/src/routes/labour-payments.ts](E:/Muzare%20VS%20Code/Muzare-Main/Muzare-Main/api/src/routes/labour-payments.ts)
- [api/test/frontend-isolation.source.test.ts](E:/Muzare%20VS%20Code/Muzare-Main/Muzare-Main/api/test/frontend-isolation.source.test.ts)
- [api/test/labour-advance-outstanding.source.test.ts](E:/Muzare%20VS%20Code/Muzare-Main/Muzare-Main/api/test/labour-advance-outstanding.source.test.ts)
- [web/src/pages/ModulePage.tsx](E:/Muzare%20VS%20Code/Muzare-Main/Muzare-Main/web/src/pages/ModulePage.tsx)
- [web/src/pages/workspace/Reports.tsx](E:/Muzare%20VS%20Code/Muzare-Main/Muzare-Main/web/src/pages/workspace/Reports.tsx)
- [web/src/pages/workspace/WorkforcePayments.tsx](E:/Muzare%20VS%20Code/Muzare-Main/Muzare-Main/web/src/pages/workspace/WorkforcePayments.tsx)

### Legacy/canonical inclusion rules

- Canonical read-model recipient and payment-source labels now drive advance presentation.
- Partner account balances in Accounts now use one merged partner snapshot for partner accounts instead of mixing local account-balance math with canonical labour overlays.
- Partner labour ledger rows in Accounts now use canonical partner-ledger entries for partner-selected views, so linked historical partner-funded advances are not dropped after replacement-ID suppression.

### Stable duplicate-suppression rules

- Legacy advance rows are still suppressed only by stable replacement IDs from the canonical labour read model.
- The fix does not re-enable name/date/amount matching.
- Historical partner-funded advances remain included through canonical partner positions and canonical partner-ledger entries even when their local legacy mirrors are suppressed.

### Advance reconciliation

Original advance surfaces now show original payment facts only:

- recipient
- recipient type
- date
- paid from
- original advance amount
- original voucher status

Aggregate application facts remain visible only through:

- advance summary totals
- `Applied to labour dues` history
- aggregate advance-application parent voucher history

### Account and partner attribution strategy

- For partner accounts, Accounts balance cards now prefer the merged partner position snapshot.
- The same merged snapshot is used for partner overview/breakdown and partner-ledger reconciliation surfaces.
- Partner-funded original advances continue to contribute their full original amount to `Farm Owes Partner`; aggregate application does not reduce that partner liability.

### Before / after behavior

Before:

- some advances showed `Unresolved recipient`
- some grouped summaries or reports showed missing / generic payment source labels
- original advance views showed per-source application fields
- partner balances could switch when canonical labour data finished loading

After:

- advance recipient and payment source come from one shared normalized presentation contract
- original advance cards/details/logs show simple payment-transaction fields
- report log/export no longer present per-source applied/outstanding lifecycle fields for original advances
- partner account balances and partner labour-ledger views use the same merged partner snapshot and no longer drop replaced historical partner-funded advances during canonical load

### Validation

Focused checks:

- API type check: passed
- Web type check: passed
- Focused regression tests: 63 passed, 0 failed

Builds:

- API build: passed
- Web production build: passed

Full once-only suite:

- `tsx --test api/test/*.test.ts web/test/*.test.ts`
- Result: source/unit coverage passed, but integration/tenant tests requiring an isolated PostgreSQL `DATABASE_URL` failed in this environment before application assertions ran.
- The failing integration set reported environment/setup errors such as:
  - `DATABASE_URL must point to an isolated migrated integration-test database`
  - `client password must be a string`

Quality checks:

- `git diff --check`: passed (CRLF warnings only)

### Browser evidence

Not completed in this workspace for this fix.

Reason:

- the available isolated local database did not contain the populated dev advance dataset needed to truthfully reproduce the named partner-funded history and unresolved-recipient examples in-browser.

### Remaining ambiguous records

This workspace’s isolated local database had no populated advance rows to enumerate unresolved live records. The code now leaves genuinely unrecoverable cases explicitly marked as:

- `Unresolved recipient`
- `Unresolved payment source`

### Git status

- ready to commit on `dev`
- no production data touched
- `main` untouched
