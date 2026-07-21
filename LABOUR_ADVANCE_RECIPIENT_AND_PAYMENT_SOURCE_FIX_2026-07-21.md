## Labour Advance recipient and payment-source correction

Date: July 21, 2026
Branch: `dev`

### Scope

This change corrects missing recipient names and missing payment-source names for Labour Advance records across:

- Advances page
- grouped advance summaries
- advance details
- advance search
- advance reports
- CSV export
- PDF/print export

It does not change:

- advance amounts
- accounting effects
- settlement math
- partner balances
- dashboard cash
- unrelated modules

### Confirmed root causes

1. The shared labour financial read model used snapshot-only fallback logic for `recipientName`, and the terminal fallback was the literal string `Labour`.

2. When that truthy fallback reached the UI, report and log screens treated it as a real resolved name and did not fall back to the linked labourer or labour-group name.

3. Payment-source rendering was inconsistent across surfaces:
   - some views used resolved canonical funding names
   - some views used only `accountId`
   - some grouped summaries ignored `fundingAccountName` / partner-linked source labels and fell back to `Unknown account`

4. The underlying references already existed in the current contract:
   - recipient: `labourerId`, `labourGroupId`, snapshots, linked names
   - payment source: `fundingAccountId`, `fundingAccountName`, `partnerId`, `partnerName`, preserved source snapshots

### Fix

One shared presentation contract now resolves:

- `recipientDisplayName`
- `receivedByDisplayName`
- `paymentSourceDisplayName`
- `paymentSourceId`
- `paymentSourceType`

Resolution precedence:

#### Recipient

1. persisted snapshot
2. current linked labourer/group name
3. deterministic historical preserved fields
4. `Unresolved recipient`

#### Payment source

1. resolved linked partner/account
2. persisted snapshot/source label
3. deterministic historical preserved fields
4. `Unresolved payment source`

### Files changed

- `api/src/lib/labour-financial-read-model.ts`
- `api/src/routes/advance-report.ts`
- `api/src/routes/labour-payments.ts`
- `api/test/labour-advance-outstanding.source.test.ts`
- `web/src/lib/api.ts`
- `web/src/pages/workspace/Reports.tsx`
- `web/src/pages/workspace/WorkforcePayments.tsx`

### Local affected-record check

The isolated database available in this workspace currently contains zero advance rows, so no truthful live affected-record count could be produced from local data.

Local inspection result:

- scopes inspected: 0
- total local advances: 0
- unresolved local recipients: 0
- unresolved local payment sources: 0

This means the code fix was validated structurally and through focused tests/builds, but not against a populated local advance dataset in this workspace.

### Validation

- API type check: passed
- Web type check: passed
- Focused labour-advance source tests: 17 passed, 0 failed
- Full web test suite: 18 passed, 0 failed
- API build: passed
- Web build: passed
- `git diff --check`: passed

### Unresolved records

No unresolved live records could be enumerated from the local isolated database because it currently has no advance records.

The code now labels genuinely unrecoverable cases explicitly as:

- `Unresolved recipient`
- `Unresolved payment source`

instead of misleading generic fallbacks.
