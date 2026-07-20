# Labour Payments financial remediation — 2026-07-21

## Outcome

Phases A–F were implemented and verified against disposable PostgreSQL databases. The exact layered scenario now returns every affected ledger code to zero, and the former balanced-but-wrong reversal-of-reversal fixture returns `reconciled: false`.

This report does **not** call the module production-ready and does not formally close the audit's overall Major Financial Integrity Risk. The P1 journal, reconciliation, canonical-read, and report-context paths are corrected and covered; the application-reversal operation still has no visible UI action (the browser verification invoked its authenticated endpoint), and the audit's explicitly deferred lifecycle work remains open.

No production database was connected to or changed.

## Root cause

The former `reverseLabourJournal` selected every `POSTED` row matching loose dimensions such as `voucher_id`, `due_id`, or `advance_application_id`. A reversal row was itself `POSTED` and intentionally preserved those same dimensions. A later source-level reversal therefore selected both the immutable original and an earlier reversal, then inverted both. Marking the original row `REVERSED` made this worse: the earlier reversal remained the only `POSTED` matching row and became the next operation's “original.”

The corrected selector is anchored to the immutable posting identity (`due:<id>`, `voucher:<id>`, or `advance-application:<id>`) and its exact debit/credit entry keys. It requires `reversal_of IS NULL`, checks that exactly two distinct original lines exist, serializes on an advisory lock for that event, and detects an existing complete or partial reversal before inserting anything.

Migration 0041 adds a unique partial index on `reversal_of`, a self-referencing foreign key, and a no-self-reversal check. Existing duplicate/orphan history makes the migration fail safely instead of silently choosing a financial result.

## Reversal convention

- Original rows are immutable financial facts. Their lifecycle status may become `REVERSED`, but amounts and dimensions are not rewritten.
- One `POSTED` reversal row references each original row through `reversal_of`.
- Reversal debit equals original credit, and reversal credit equals original debit.
- Workspace, farm, season, account-derived ledger code, partner, labourer/group snapshot, due, voucher, application, currency precision, and source links come from the original fact.
- Current balances sum original and reversal effects. History shows both. Consumers do not exclude a reversed original while also summing its inverse.
- Routine source voiding never selects a row whose `reversal_of` is populated.
- Repeat and concurrent requests return the already-completed lifecycle result; they do not restore operational balances or insert journal inverses twice.

## Reconciliation correction

The endpoint now evaluates all required groups:

1. journal balance per immutable event;
2. source completeness, classification, amount, and scope dimensions;
3. reversal existence, cardinality, original validity, exact inverse, and dimension equality;
4. due equation and lifecycle status;
5. advance equation and void/application consistency;
6. account transaction existence, account, direction, amount, and no-cash application rule;
7. partner account movement versus `PARTNER_PAYABLE` journal position;
8. wage expense recognition at the due and zero active expense after due void;
9. legacy coverage/review state.

Every group returns `passed`, `checkedCount`, and `failureCount`; individual failures include source IDs, journal IDs where relevant, ledger code, expected/actual/difference, and workspace/farm/season. Any required failure forces `reconciled: false`.

Regression evidence: the intentionally corrupted fixture inserts a balanced reversal of two prior reversal lines. Aggregate journal difference remains `0.00`; `reversal-integrity` fails because a reversal references another reversal; the endpoint returns `reconciled: false`.

## Canonical consumer migration

| Consumer | Previous source | New source | Legacy coexistence and double-count prevention |
| --- | --- | --- | --- |
| Accounts summary/ledger | IndexedDB vouchers, advances, settlements, and page calculators | canonical `account_transactions` exposed as shared `accountEntries` | linked `source_id` / `legacy_source_record_id` suppresses only the explicit legacy mirror |
| Partner Position | local partner/account calculators | shared `partnerPositions` from canonical account movements | legacy partner entries remain only when their stable source ID has no canonical replacement |
| Partner ledger | local partner entries and inferred settlement rows | shared canonical partner account entries, including reversal rows | no date/amount/name matching; stable source IDs prevent double count |
| Labour ledger | legacy earnings/settlement reconstructions | normalized journal events in `labourLedger` | new canonical events are authoritative; legacy-only history remains available |
| Expense report | local general-expense vouchers | canonical due-recognition `expenses` plus unrelated legacy expenses | advance, application, and due payment are not wage expenses; linked mirrors are suppressed |
| Activity/Dashboard | local operational activity builders | canonical journal lifecycle `activity` merged with unrelated local activity | original payment/application states become `VOIDED`/`REVERSED`, with explicit reversal events |
| Reconciliation | aggregate posted debit/credit plus missing transactions | shared source-aware structured reconciliation | all journal history is considered; legacy coverage remains a separate required check |

The shared endpoint is `GET /v1/workspace/:workspaceId/labour-payments/financial-read-model`. It is server-scoped and permission checked. The web hook query key contains token, workspace, farm, and season and passes an abort signal.

## Report context correction

Canonical report data now follows the reactive sync context rather than a one-time module-global farm/season read. A context change creates a new complete query key, immediately exposes no previous-key placeholder, and aborts/sequence-rejects stale requests. This also fixed a browser-reproduced startup race where a fresh reload could miss the initial context event and show canonical expense/activity as zero.

The web source-contract regression covers the complete key, reactive farm/season state, abort signal, explicit stale-data clearing, request sequence guard, and canonical downstream consumers.

## Numerical evidence

The table uses journal debit-minus-credit signs. The “partial reversal” point is after reversing the direct payment while the 30 application remains active.

| Metric | Initial | After posting | After partial reversal | After full reversal | Expected final |
| --- | ---: | ---: | ---: | ---: | ---: |
| Labour due | 0 | 20 | 70 | 0 | 0 |
| Outstanding advance | 0 | 10 | 10 | 0 | 0 |
| Advance applied | 0 | 30 | 30 | 0 | 0 |
| Direct payment | 0 | 50 | 0 | 0 | 0 |
| Account movement | 0 | 90 | 40 | 0 | 0 |
| Farm Owes Partner | 0 | 90 | 40 | 0 | 0 |
| Wage expense | 0 | 100 | 100 | 0 | 0 |
| Labour payable journal | 0 | -20 | -70 | 0 | 0 |
| Labour advance journal | 0 | 10 | 10 | 0 | 0 |
| Partner payable journal | 0 | -90 | -40 | 0 | 0 |

Additional controlled checkpoints:

| Checkpoint | Due | Outstanding advance | Farm Owes Partner | Wage expense |
| --- | ---: | ---: | ---: | ---: |
| posted advance 40 + due 100 + application 30 + payment 50 | 20 | 10 | 90 | 100 |
| payment reversed | 70 | 10 | 40 | 100 |
| application reversed | 100 | 40 | 40 | 100 |
| original advance voided | 100 | 0 | 0 | 100 |
| original due voided | 0 | 0 | 0 | 0 |

Browser fixture after payment and application reversal:

| Consumer | Expected | Actual | Difference | Result |
| --- | ---: | ---: | ---: | --- |
| Canonical journal — due / advance / partner / expense | 100 / 40 / 40 / 100 | 100 / 40 / 40 / 100 | 0 / 0 / 0 / 0 | PASS |
| Accounts | 40 | 40 | 0 | PASS |
| Partner Position | 40 | 40 | 0 | PASS |
| Partner ledger | 40 | 40 | 0 | PASS |
| Labour ledger — due / advance | 100 / 40 | 100 / 40 | 0 / 0 | PASS |
| Expense report | 100 | 100 | 0 | PASS |
| Activity | VOIDED payment; REVERSED application | VOIDED payment; REVERSED application | — | PASS |
| Reconciliation | `true`, all nine groups pass | `true`, all nine groups pass | — | PASS |

## Existing-data risk and detection

Existing records may already contain multiple reversals, reversal-of-reversal rows, non-inverse dimensions, or operationally reversed sources with active effects. They require detection before deployment because the unique reversal index intentionally refuses duplicate history.

Production-safe, read-only SQL is in [LABOUR_PAYMENTS_REMEDIATION_DETECTION_QUERIES.sql](./LABOUR_PAYMENTS_REMEDIATION_DETECTION_QUERIES.sql). It requires explicit `workspace_id`, `farm_id`, and `season_id` psql variables and runs in `BEGIN TRANSACTION READ ONLY`.

Controlled browser-fixture result after valid reversals:

- 0 duplicate reversals;
- 0 reversal-of-reversal rows;
- 0 orphan reversals;
- 0 non-zero original/reversal pairs;
- 0 reversed payments or applications with active financial effects;
- 0 missing account transactions;
- 0 partner-position/ledger, due-equation, advance-equation, or scope mismatches;
- 1 explicitly linked canonical/legacy advance representation, correctly suppressed by stable source IDs.

No destructive repair is included. The corrective strategy is documented in [LABOUR_PAYMENTS_CORRECTIVE_JOURNAL_DESIGN_2026-07-21.md](./LABOUR_PAYMENTS_CORRECTIVE_JOURNAL_DESIGN_2026-07-21.md): preserve original source and journal rows, append a uniquely related corrective journal, retain voucher numbering, and record the correction audit trail.

## Browser evidence

The previous “blank” result was not a React render failure. A clean Vite server rendered the login application. Using `127.0.0.1:5173` caused the API preflight to be rejected because the configured allowed origin was `http://localhost:5173`; using the configured host plus a valid fixture session rendered the workspace. No broad startup change was required.

The controlled fixture used workspace `ebd194ca-4864-4994-b208-55491d5f2ef7`, farm `6e62f584-c2ce-4b61-9fc7-860f87832ec9`, season `5304e73a-eb4c-443a-89dd-901fcc285f10`, due `e90931f4-bf70-4c75-b644-9cf1a455a046` (`LD-0001`), advance `ef878728-1f49-495b-a6bf-21e0e023eea5` (`LAV-0001`), application `1e46f13f-da40-4efa-a2e1-f1f790b76308`, and payment `297af768-391a-4315-8084-e9a52d260af2` (`LPV-0001`). All are disposable test records.

Exercised in the rendered app: signup/auth bootstrap, farm/season context, labourer and partner account setup, partner-funded advance, direct labour due, application 30, payment 50, Payments Due, Payment Vouchers, Outstanding Advances, Accounts, Partner Position/ledger, labour profile ledger, expenditure report, activity, payment void, refresh persistence, desktop, and 390×844 mobile. The application reversal was invoked from the authenticated browser session against its canonical endpoint because the current UI has no application-reversal action; that UI lifecycle remains deferred.

Evidence:

- [posted due state](./labour-remediation-browser-posted.png)
- [due state after reversals](./labour-remediation-browser-reversed.png)
- [mobile state after reversals](./labour-remediation-browser-mobile-after-reversals.png)
- [partner position after reversals](./labour-remediation-browser-partner-after-reversals.png)
- [expense report after reversals](./labour-remediation-browser-expense-after-reversals.png)
- [activity after reversals](./labour-remediation-browser-activity-after-reversals.png)

Browser console errors on the final clean-context report pass: 0. Refresh retained the expected due 100 / advance 40 / partner 40 / expense 100 state.

## Verification and tests

| Validation | Pass | Fail | Skip | Result |
| --- | ---: | ---: | ---: | --- |
| Focused layered reversal/reconciliation integration | 1 | 0 | 0 | PASS |
| Full API/integration/source-contract/tenant suite | 262 | 0 | 1 | PASS |
| Web tests | 11 | 0 | 0 | PASS |
| API type check | 1 command | 0 | 0 | PASS |
| Web type check | 1 command | 0 | 0 | PASS |
| API production build | 1 command | 0 | 0 | PASS |
| Web production build | 1 command | 0 | 0 | PASS; existing >500 kB chunk warning |
| Clean PostgreSQL migrations 0001–0041 | 41 files | 0 | 0 | PASS |
| Startup/upgrade migration 0041 | 1 | 0 | 0 | PASS |
| Read-only detection SQL | 13 query groups | 0 SQL errors | 0 | PASS |
| `git diff --check` | 1 | 0 | 0 | PASS |

The three previously failing source contracts were not weakened: they were replaced with stricter canonical-source assertions for the canonical labour ledger, retired attendance-due entry path, lazy advance review flow, partner read model, and stable legacy suppression.

Commands executed:

```text
npm.cmd run test:integration --workspace api
node_modules/.bin/tsx.cmd --test --test-name-pattern="layered labour reversals" api/test/labour-wage-settlements.integration.test.ts
node_modules/.bin/tsx.cmd --test web/test/**/*.test.ts
npm.cmd run check --workspace api
npm.cmd run check --workspace web
npm.cmd run build --workspace api
npm.cmd run build --workspace web
npm.cmd run db:init --workspace api
node_modules/.bin/tsx.cmd -e "import { ensureWorkspaceSchema } ..."
psql -v workspace_id=... -v farm_id=... -v season_id=... -f docs/LABOUR_PAYMENTS_REMEDIATION_DETECTION_QUERIES.sql
git diff --check
```

`npm run db:migrate --workspace api` was also attempted against an empty disposable database and failed because that script invokes Drizzle's separate `api/drizzle` journal, not the repository's ordered `database/migrations/*.sql` runner. The documented/custom SQL runner (`db:init`) and application startup upgrader (`ensureWorkspaceSchema`) both passed through 0041; no migration failure was hidden.

## Changed files

Core API/database:

- `api/src/db/migrations.ts`
- `api/src/db/schema.ts`
- `api/src/lib/labour-payments.ts`
- `api/src/lib/labour-financial-reconciliation.ts`
- `api/src/lib/labour-financial-read-model.ts`
- `api/src/routes/labour-payments.ts`
- `api/src/routes/labour-wage-settlements.ts`
- `database/migrations/0041_exact_labour_journal_reversals.sql`

Web consumers/context:

- `web/src/hooks/useCanonicalLabourFinancials.ts`
- `web/src/lib/api.ts`
- `web/src/lib/workspaceActivity.ts`
- `web/src/pages/DashboardPage.tsx`
- `web/src/pages/ModulePage.tsx`
- `web/src/pages/workspace/ActivityLog.tsx`
- `web/src/pages/workspace/Reports.tsx`

Tests and evidence:

- `api/test/labour-wage-settlements.integration.test.ts`
- `api/test/frontend-isolation.source.test.ts`
- `api/test/labour-attendance-due.source.test.ts`
- `web/test/labour-financial-context.source.test.ts`
- this report, detection SQL, corrective design, deferred list, and six screenshots in `docs/`

## Deferred work

The separate prioritized list is [LABOUR_PAYMENTS_DEFERRED_TASKS_2026-07-21.md](./LABOUR_PAYMENTS_DEFERRED_TASKS_2026-07-21.md). It retains the requested exclusions: posted advance replace lifecycle, voucher reservation, due edit/delete, application-reversal UI redesign, hold redesign, wage-rate revisions/date decision, half-day decision, offline canonical queue, dedicated reports, and legacy/diagnostic cleanup.

## Git status

Implementation commits are `3a3643c` (exact reversal, structured reconciliation, API read model, migration, integration coverage) and `9232caa` (canonical web consumers and scoped context). The evidence commit and push result are recorded in the final handoff. Work is on `dev`; `main` and production data were untouched.
