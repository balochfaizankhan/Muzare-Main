# Labour Payments P1 Consumer Remediation — 2026-07-21

## Conclusion

The four P1 canonical-consumer and account-normalization defects are corrected and verified. Remaining P2, missing, unreachable, and untested functions remain open.

This phase did not redesign the normalized Labour Payments posting/reversal engine, alter production data, or merge to `main`.

## 1. Root causes

### P1-01 — UI-created accounts could not fund canonical vouchers

The Accounts UI persisted an `account` operational record, but that write did not guarantee the same stable identifier existed in normalized `accounts`. Labour Payments correctly resolved `paymentAccountId` against `accounts.id`, so an account visible through the local/operational path could fail at posting time.

Correction: the operational account POST now validates the supported type and atomically upserts the normalized row using the operational record's `clientRecordId` UUID as the canonical account ID. The operational payload stores `canonicalAccountId`. The canonical resolver also provides a scoped compatibility path for existing operational-only accounts by exact stable ID. It does not use names, dates, amounts, or labels; conflicts and ambiguous mappings fail explicitly.

### P1-02 — Partner Position and Accounts breakdown omitted canonical effects

The relevant screens independently reconstructed partner totals from legacy/local records. That calculation counted the original partner advance but neither the canonical direct labour payment nor the active application when calculating the labour-side outstanding advance.

Correction: partner cash funding, partner direct labour payments, advance applications, and reversals now come from the shared canonical financial read model. Partner Position and the partner ledger share the same canonical components. Applying an advance changes outstanding labour advance but does not reduce Farm Owes Partner.

### P1-03 — Advance Report omitted canonical-only advances

The report began with the legacy advance collection and only decorated matching rows with canonical values. A canonical voucher without a legacy twin therefore had no base row and disappeared.

Correction: canonical advance positions are primary report rows. Legacy-only records are appended only when their stable source IDs are not covered by `replacedLegacyRecordIds`/`legacySourceRecordId`.

### P1-04 — Accounts omitted canonical wage expense

Accounts derived expense visibility from payment-oriented/local records. Wage recognition belongs to the Labour Due journal event, not to the funding voucher, so the Expense Report could show 100 while Accounts showed zero.

Correction: `LABOUR_EXPENSE` due-recognition entries are exposed as canonical expenses and consumed by Accounts, Reports, and Dashboard aggregation. Advance creation/application and direct payment do not create wage expense. Due void supplies the exact inverse.

## 2. Files changed

| File | Purpose |
| --- | --- |
| `api/src/routes/operational-sync.ts` | Atomic normalized account creation/upsert from the current operational/UI route; validation and conflict handling. |
| `api/src/lib/labour-wage-settlements.ts` | Exact stable-ID compatibility normalization in `resolveCanonicalPaymentAccountId`. |
| `api/src/lib/labour-financial-read-model.ts` | Canonical economic nature, advance positions, partner components, expenses, and stable legacy replacement links. |
| `api/src/routes/labour-payments.ts` | Reconciliation active-payable handling excludes voided dues. |
| `web/src/lib/api.ts` | Typed canonical read-model fields. |
| `web/src/pages/ModulePage.tsx` | Accounts, account detail, Partner Position, partner ledger, and expense consumers. |
| `web/src/pages/workspace/Reports.tsx` | Canonical-first advances/partner/expense rows, scoped refresh, stable legacy suppression. |
| `web/src/pages/DashboardPage.tsx` | Canonical recognized labour expense inclusion. |
| `api/test/labour-wage-settlements.integration.test.ts` | Account normalization, layered scenario, reversals, consumers, reconciliation regression. |
| `api/test/frontend-isolation.source.test.ts` | Canonical downstream source contract. |
| `api/test/labour-wage-settlements.source.test.ts` | Stable account-resolution contract. |
| `api/test/tenant-isolation.integration.test.ts` | Cross-workspace account rejection. |
| `web/test/labour-financial-context.source.test.ts` | Complete context key, stale-response protection, shared consumer contract. |

No migration was added.

## 3. Account normalization strategy

1. The UI supplies one UUID (`clientRecordId`).
2. The API verifies workspace/farm/season membership and accepts only Labour Payments-supported account types.
3. Within the same database transaction it creates/upserts `accounts.id = clientRecordId` and writes the operational representation with `payload.canonicalAccountId = clientRecordId`.
4. Existing operational-only accounts are normalized on use only where the operational record ID is an exact UUID, the farm/workspace scope is valid, and there is no conflicting normalized identity.
5. A normalized ID belonging to another farm/workspace is rejected. An existing normalized account with conflicting immutable identity is rejected rather than guessed or merged.

This preserves existing account IDs and balances and avoids duplicate rows. No account-name matching exists in the mapping path.

## 4. Canonical read model and legacy coexistence

| Consumer | Previous source | New primary source | Legacy coexistence / duplicate prevention |
| --- | --- | --- | --- |
| Accounts card and ledger | Local account and voucher calculators | Canonical `accountEntries` and `accountBalances` | Append only uncovered legacy records by stable source ID. |
| Accounts breakdown | Legacy advances/payments | Canonical partner components and advance positions | `legacySourceRecordId` and `replacedLegacyRecordIds`; no amount/date/name matching. |
| Partner Position | Page-specific local calculation | Canonical partner position shared with ledger | Legacy-only partner movements remain when no canonical replacement exists. |
| Partner ledger | Mixed operational rows | Canonical partner account entries and reversals | Canonical replacement IDs suppress mirrors. |
| Advance Report | Legacy base rows | Canonical `advancePositions` | Legacy-only append after stable-ID suppression. |
| Expense Report | Mixed expense/local records | Canonical due-recognition expenses | Canonical source/due IDs suppress only their explicit mirrors. |
| Accounts expense summary | Payment/local reconstruction | Canonical `LABOUR_EXPENSE` effects | Non-labour legacy expenses remain. |
| Dashboard expense | Local expense rows | Local non-labour plus canonical labour expense | Canonical labour source IDs prevent mirror counting. |
| Reconciliation | Journal plus source equations | Same canonical sources/read model | Any equation failure remains a reconciliation failure. |

Reports include token, workspace, farm, and season in the request lifecycle. A context change clears canonical state immediately, aborts/discards stale responses, refetches, and reloads matching IndexedDB records after local-data refresh events.

## 5. Numerical evidence

### Before/after defect evidence

| Surface | Before | After posting | Expected | Result |
| --- | ---: | ---: | ---: | --- |
| UI-created partner account can fund advance | Rejected: “Payment account is not mapped” | Accepted as `LAV-0001` | Accepted | PASS |
| Farm Owes Partner | 40 | 90 | 90 | PASS |
| Outstanding Labour Advance | 40 | 10 | 10 | PASS |
| Advance Report paid/applied/outstanding | 0 / 0 / 0 | 40 / 30 / 10 | 40 / 30 / 10 | PASS |
| Accounts wage expense | 0 | 100 | 100 | PASS |

### Posting and reversal checkpoints

| Metric | Initial | After posting | After payment reversal | After application reversal | After advance void | After due void |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Active labour due | 0 | 20 | 70 | 100 | 100 | 0 |
| Outstanding advance | 0 | 10 | 10 | 40 | 0 | 0 |
| Advance applied | 0 | 30 | 30 | 0 | 0 | 0 |
| Active direct payment | 0 | 50 | 0 | 0 | 0 | 0 |
| Net partner account movement | 0 | 90 | 40 | 40 | 0 | 0 |
| Farm Owes Partner | 0 | 90 | 40 | 40 | 0 | 0 |
| Wage expense | 0 | 100 | 100 | 100 | 100 | 0 |
| Labour payable | 0 | 20 | 70 | 100 | 100 | 0 |

The final journal grouped by ledger code netted to zero:

| Ledger code | Debits | Credits | Net |
| --- | ---: | ---: | ---: |
| `LABOUR_ADVANCE` | 70 | 70 | 0 |
| `LABOUR_EXPENSE` | 100 | 100 | 0 |
| `LABOUR_PAYABLE` | 180 | 180 | 0 |
| `PARTNER_PAYABLE` | 90 | 90 | 0 |

### Cross-module reconciliation after posting

| Consumer | Expected economic result | Actual | Difference | Result |
| --- | ---: | ---: | ---: | --- |
| Labour Payments remaining due | 20 | 20 | 0 | PASS |
| Outstanding Advances | 10 | 10 | 0 | PASS |
| Payment Vouchers partner movement | 90 | 90 | 0 | PASS |
| Accounts card | 90 | 90 | 0 | PASS |
| Account ledger closing balance | 90 | 90 | 0 | PASS |
| Accounts breakdown | 90 | 90 | 0 | PASS |
| Partner Position | 90 | 90 | 0 | PASS |
| Partner ledger closing balance | 90 | 90 | 0 | PASS |
| Advance Report paid/applied/outstanding | 40 / 30 / 10 | 40 / 30 / 10 | 0 | PASS |
| Expense Report | 100 | 100 | 0 | PASS |
| Accounts expense summary | 100 | 100 | 0 | PASS |
| Reconciliation active labour payable | 20 | 20 | 0 | PASS |

At final reversal, all active consumer totals above were zero. Historical voucher/activity rows remained and were marked reversed/voided.

## 6. Automated validation

| Validation | Passed | Failed | Skipped | Result |
| --- | ---: | ---: | ---: | --- |
| Focused PostgreSQL Labour Payments integration | 16 | 0 | 0 | PASS |
| Full API/integration/source-contract/tenant suite | 263 | 0 | 1 | PASS |
| Full web source/regression suite | 11 | 0 | 0 | PASS |
| API type check | 1 command | 0 | 0 | PASS |
| Web type check | 1 command | 0 | 0 | PASS |
| API production build | 1 command | 0 | 0 | PASS |
| Web production build | 1 command | 0 | 0 | PASS (existing large-chunk warning only) |
| `git diff --check` | 1 command | 0 | 0 | PASS |

The one skipped API test is `migration-0035.postgres.test.ts`; it is intentionally conditional on `MIGRATION_TEST_DATABASE_URL`. No assertions or contracts were weakened. Source contracts were updated to require the shared canonical source and exact stable account mapping.

Commands included:

```text
npm.cmd run test:integration --workspace api
node_modules/.bin/tsx.cmd --test --test-concurrency=1 api/test/labour-wage-settlements.integration.test.ts
node_modules/.bin/tsx.cmd --test web/test/**/*.test.ts
npm.cmd run check --workspace api
npm.cmd run check --workspace web
npm.cmd run build --workspace api
npm.cmd run build --workspace web
git diff --check
```

## 7. Browser evidence

The real PWA was rendered through Vite at `127.0.0.1:5274` with the API on `127.0.0.1:3202` and disposable PostgreSQL database `muzare_labour_p1_browser_20260721`.

The prior blank view was reproduced as an interrupted/stale development tab while its API process was unavailable; a fresh tab after API/Vite readiness and authentication bootstrap rendered normally. No broad startup change was made.

Through the rendered UI, the audit created the farm, labourer, partner account, advance, due, partial application, and direct payment; then inspected Labour Payments, Accounts, account detail, Partner Position, partner ledger, labour ledger, Advance Report, Expense Report, and Activity. Season creation was performed through the scoped API because the in-app browser driver could not populate the native date control. Reversals used the same scoped API because the product's current reversal action relies on `window.prompt`, which the in-app browser driver does not support. These are test-harness limitations, not hidden as browser coverage.

Desktop and 390×844 mobile layouts were exercised. The successful workflow had no network/product errors. The console retained two explicit `prompt() is not supported` messages from the attempted UI reversal and two transient cached-data bootstrap messages while the development API was deliberately restarted.

Evidence directory: `docs/evidence/labour-payments-p1-2026-07-21/`

- `01-account-created-ui.png`
- `02-partner-advance-40.png`
- `03-mixed-settlement-remaining-20.png`
- `04-accounts-90-expense-100.png`
- `05-accounts-breakdown-90.png`
- `06-partner-position-90-advance-10.png`
- `06b-partner-status-report-90.png`
- `07-partner-ledger-90.png`
- `08-advance-report-40-30-10.png`
- `09-expense-report-100.png`
- `10-accounts-expense-summary-100.png`
- `11-final-reversed-zero.png`
- `12-mobile-390x844-final-zero.png`
- `13-mobile-390x844-advance-history.png`

## 8. Migration evidence

A new disposable database, `muzare_labour_p1_validation_final_20260721`, was created empty. Application startup acquired the migration lock and completed every required schema step from `0001` through `0041_exact_labour_journal_reversals`, then released the lock and listened successfully. No migration was required by this change, so an upgrade-migration test is not applicable.

## 9. Existing-data risk and production-safe detection

No production database was connected to or modified. Controlled browser-fixture results after final reversal:

```text
operational_accounts_missing=0
posted_vouchers_missing_tx=0
journal_nonzero_codes=0
active_due_total=0
```

Existing installations can contain operational-only accounts created before this correction. They are eligible for exact-ID normalization on read/use, but the following read-only preflight should be run before rollout. Replace the three parameters explicitly; never remove the scope predicates for production review.

```sql
-- :workspace_id, :farm_id and :season_id are mandatory review parameters.
WITH scoped_operational_accounts AS (
  SELECT o.workspace_id, o.farm_id, o.season_id, o.client_record_id,
         o.payload->>'canonicalAccountId' AS declared_canonical_id,
         o.payload->>'name' AS account_name,
         o.payload->>'type' AS account_type
  FROM operational_records o
  WHERE o.entity_type = 'account'
    AND o.workspace_id = :workspace_id::uuid
    AND o.farm_id = :farm_id::uuid
    AND (o.season_id = :season_id::uuid OR o.season_id IS NULL)
)
SELECT s.*
FROM scoped_operational_accounts s
LEFT JOIN accounts a
  ON a.id::text = COALESCE(NULLIF(s.declared_canonical_id, ''), s.client_record_id)
 AND a.farm_id = s.farm_id
WHERE a.id IS NULL;

-- Stable-ID conflicts/ambiguity: any result requires manual review; do not name-match.
SELECT o.workspace_id, o.farm_id, o.client_record_id,
       o.payload->>'canonicalAccountId' AS declared_canonical_id,
       a.id, a.farm_id AS normalized_farm_id, a.name, a.account_type
FROM operational_records o
JOIN accounts a
  ON a.id::text = COALESCE(NULLIF(o.payload->>'canonicalAccountId', ''), o.client_record_id)
WHERE o.entity_type = 'account'
  AND o.workspace_id = :workspace_id::uuid
  AND o.farm_id = :farm_id::uuid
  AND (o.season_id = :season_id::uuid OR o.season_id IS NULL)
  AND a.farm_id <> o.farm_id;

-- Funded posted canonical vouchers missing their normalized account transaction.
SELECT v.id, v.voucher_number, v.nature, v.payment_account_id,
       v.account_transaction_id, v.workspace_id, v.farm_id, v.season_id
FROM labour_payment_vouchers v
LEFT JOIN account_transactions t ON t.id = v.account_transaction_id
WHERE v.workspace_id = :workspace_id::uuid
  AND v.farm_id = :farm_id::uuid
  AND v.season_id = :season_id::uuid
  AND v.status = 'POSTED'
  AND v.nature IN ('ADVANCE', 'DIRECT_PAYMENT', 'ADVANCE_REFUND')
  AND v.payment_account_id IS NOT NULL
  AND t.id IS NULL;

-- Explicit canonical/legacy mirrors linked by stable IDs (no heuristic matching).
SELECT v.id AS canonical_voucher_id, v.voucher_number, v.legacy_source_record_id,
       o.client_record_id, o.entity_type
FROM labour_payment_vouchers v
JOIN operational_records o ON o.id = v.legacy_source_record_id
WHERE v.workspace_id = :workspace_id::uuid
  AND v.farm_id = :farm_id::uuid
  AND v.season_id = :season_id::uuid;

-- Partner account-transaction balance; compare with canonical Partner Position output.
SELECT t.account_id,
       ROUND(SUM(CASE WHEN t.type = 'credit' THEN t.amount ELSE -t.amount END), 2) AS partner_ledger_balance
FROM account_transactions t
JOIN accounts a ON a.id = t.account_id
JOIN farms f ON f.id = t.farm_id
WHERE f.workspace_id = :workspace_id::uuid
  AND t.farm_id = :farm_id::uuid
  AND t.season_id = :season_id::uuid
  AND a.account_type = 'partner'
GROUP BY t.account_id;

-- Current due equation mismatches.
WITH active_applications AS (
  SELECT due_id, SUM(amount) AS amount
  FROM labour_advance_applications
  WHERE workspace_id = :workspace_id::uuid AND status = 'ACTIVE'
  GROUP BY due_id
), active_payments AS (
  SELECT p.due_id, SUM(p.amount) AS amount
  FROM labour_payment_allocations p
  JOIN labour_payment_vouchers v ON v.id = p.voucher_id
  WHERE p.workspace_id = :workspace_id::uuid
    AND p.status = 'ACTIVE' AND v.status = 'POSTED'
  GROUP BY p.due_id
)
SELECT d.id, d.due_number,
       d.gross_amount - d.authorized_deductions + d.adjustment_amount
         - COALESCE(a.amount, 0) - COALESCE(p.amount, 0) AS expected_remaining,
       d.payment_status
FROM labour_dues d
LEFT JOIN active_applications a ON a.due_id = d.id
LEFT JOIN active_payments p ON p.due_id = d.id
WHERE d.workspace_id = :workspace_id::uuid
  AND d.farm_id = :farm_id::uuid
  AND d.season_id = :season_id::uuid
  AND d.voided_at IS NULL;

-- Journal dimensions outside their source scope.
SELECT e.id, e.entry_key, e.workspace_id, e.farm_id, e.season_id,
       v.workspace_id AS voucher_workspace_id, v.farm_id AS voucher_farm_id,
       v.season_id AS voucher_season_id
FROM labour_accounting_entries e
JOIN labour_payment_vouchers v ON v.id = e.voucher_id
WHERE e.workspace_id = :workspace_id::uuid
  AND e.farm_id = :farm_id::uuid
  AND e.season_id = :season_id::uuid
  AND (e.workspace_id, e.farm_id, e.season_id)
      IS DISTINCT FROM (v.workspace_id, v.farm_id, v.season_id);
```

These queries are detection-only. No automatic repair script is included.

## 10. Deferred defects

- Hold status lifecycle
- Posted advance edit/reverse-and-replace
- Advance delete/void conversion
- Voucher-number reservation
- Same-day Riyadh wage-rate date issue
- Reversal display date
- Negative voucher summary after reversal
- Labour-ledger event presentation
- Unified voucher register
- Advance-application reversal UI
- Dedicated Labour Payment Report
- Dedicated Settlement Report
- Canonical offline financial queue
- Missing sorting, pagination, print, and filters
- Viewer UI cleanup
- Legacy route/component cleanup

## 11. Git status

Implementation branch: `dev`. The commit hash and push result accompany the final delivery. `main` and production data were untouched.
