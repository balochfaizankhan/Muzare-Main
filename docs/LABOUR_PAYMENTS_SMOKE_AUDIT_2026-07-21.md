# Labour Payments smoke audit — 2026-07-21

## 1. Executive conclusion

**Major financial integrity risk.**

The canonical create and settlement paths are substantially better protected than the surrounding module: PostgreSQL-backed integration tests prove transactionality, tenant scoping, pooled group/member advance allocation, account funding, and retry idempotency. A controlled mixed settlement also reconciled before reversal.

The module cannot be called fully working. A controlled reversal sequence proved that `labour_accounting_entries` no longer represents the current financial position after reversals, while the reconciliation endpoint continues to return `reconciled: true`. In addition, the Accounts, Partner Position, labour profile ledger, expense report, and recent-activity implementations still calculate from legacy IndexedDB records and do not consistently consume canonical Labour Payment Vouchers (LPVs) and the normalized journal. Thus a correct API transaction can be absent from, or disagree with, another financial screen.

No production data was mutated. All destructive scenarios used a uniquely named local PostgreSQL database and randomized fixture identifiers. No fixes, migrations, commits, or pushes were made.

## 2. Module action inventory

The current route container is `web/src/pages/workspace/WorkforceHub.tsx`; the canonical workflow UI is `web/src/pages/workspace/WorkforcePayments.tsx`.

| Visible action | Route / entry point | State | Evidence |
|---|---|---|---|
| Payments Due | `/workspace/labour-payments/overview` | Partially connected | Canonical dues and settlement API; downstream legacy summaries are incomplete. |
| New Labour Due | `/workspace/labour-payments/direct-due` | Partially connected | Creates canonical `labour_dues`; no edit/delete action, only hold/void. |
| Wage Rates | `/workspace/labour-payments/wage-rates` | Partially connected | CRUD/history UI and API work; JSON storage has no DB overlap constraint, UTC date bug, historical report recomputation risk. |
| Payment Vouchers | `/workspace/labour-payments/vouchers` | Partially connected | Canonical LPV register and void action; reversal journal is incorrect. |
| Outstanding Advances | `/workspace/labour-payments/advances` | Partially connected | Create/edit/delete/refund/view work; used advances are blocked, but posted edit/delete rewrites history. |
| Review and settle | Due detail dialog | Partially connected | Advance application plus cash/bank/partner payment is atomic and idempotent; application reversal has no UI action. |
| Put/remove hold | Due detail dialog | Broken lifecycle rule | API can put a fully paid/settled due on hold without first rejecting active effects. |
| Void labour due | Due detail dialog | Partially connected | API restores balances but normalized journal is wrong after reversal; prompt is weak UX. |
| Void/reverse payment voucher | Voucher register | Partially connected | Account transaction and due position restore; normalized journal/reporting does not. |
| Edit unused advance | Advance register | Partially connected | Totals update; original posted transaction/journal is deleted and recreated in place. |
| Delete unused advance | Advance register | Partially connected | Dependencies block used advances; unused posted history is hard-deleted and a number may become reusable. No dependency-preview UI. |
| Refund/recover advance | Advance register | Fully connected for tested API path | Canonical refund LPV and outstanding calculation are covered by tests. |
| Advance Report | Reports hub | Partially connected | Canonical outstanding/applied data is fetched, but context change can leave stale data. |
| Wage Rate Report | Reports hub | Partially connected | Uses local wage-rate history and current rate resolution; editing can alter historical computed output. |
| Labour Payment Report | — | Unreachable/missing | No dedicated report option. |
| Settlement Report / history | alias redirects to vouchers | Obsolete/unreachable | Current history is voucher-based; legacy settlement history component/API remains registered. |
| Labour/group ledger | Labour profile / legacy reports | Partially connected | Uses legacy earnings/payments/settlements, not canonical dues/LPVs; no complete canonical group ledger. |
| Restore | — | Missing | No canonical restore lifecycle action. |
| Dependency preview | Legacy reconciliation only | Unreachable from current module | Current advance deletion discovers dependencies by failed DELETE; legacy cleanup preview remains registered. |

Aliases in `web/src/App.tsx` redirect `legacy-earnings`, `earnings`, `labour-work`, `settlement-history`, `direct-payments`, and older top-level labour routes to the five current tabs. Unreachable source remains in `LabourEarnings.tsx`, `LabourWageSettlements.tsx`, and `LabourReconciliation.tsx`. The API still registers `labour-wage-settlements`, `labour-reconciliation`, and admin settlement diagnostics. Half-day wage-rate UI and API support remain active. Temporary accounting diagnostics remain linked from settings/admin surfaces.

### End-to-end implementation map

| Workflow | UI / client | API | Service/helper | Database and guards |
|---|---|---|---|---|
| Wage rate | `WageRates.tsx`; `api.ts` | `routes/wage-rates.ts` GET, overlap validation, bulk, calculate | wage-rate resolver plus duplicated client report resolution | `operational_records` JSON; generic operational constraints only; no wage-rate-specific trigger |
| Advance | `WorkforcePayments.tsx` Advance view | `POST /advances`, `PATCH/DELETE /advances/:voucherId`, refund | `lib/labour-payments.ts` journal/account helpers | `labour_payment_vouchers`, `account_transactions`, `labour_accounting_entries`; scoped FKs and idempotency uniqueness |
| Labour due | Direct/attendance panels in `WorkforcePayments.tsx` | `POST /dues`, attendance preview, GET dues/detail | due position and journal helpers | `labour_dues`, snapshots; unique scoped source/idempotency constraints |
| Apply advance | Due review dialog | `GET /dues/:id/advance-pool`, `POST /dues/:id/settle` | pool selection, position loader, journal helper | `labour_advance_applications`; trigger `labour_advance_application_guard` / function `validate_labour_advance_application` |
| Direct payment | Same settle request, payment sub-object | `POST /dues/:id/settle` | LPV/account/journal creation in one transaction | `labour_payment_vouchers`, `labour_payment_allocations`, `account_transactions`; allocation and payment guards |
| Void/reverse | Due/voucher UI | due void, voucher void, application reverse | `reverseLabourJournal` | reversal rows plus original status updates; this is defective |
| Reports | `Reports.tsx`, reports hub | vouchers, advances, reconciliation APIs | legacy calculators plus canonical augmentations | mixed IndexedDB and PostgreSQL sources |

PostgreSQL enforces workspace/farm/season composite ownership, scoped voucher uniqueness, scoped idempotency keys, positive amounts, valid states, payment-account presence, allocation caps, and group snapshot membership. Migration 0039 permits a group-owned due to consume advances belonging to immutable snapshot members; migration 0040 resolves eligible legacy individual ownership. The API and trigger agree for the tested canonical group and individual cases.

## 3. Smoke-test matrix

Fixture IDs are evidence identifiers only: workspace/farm/season and people/account IDs were randomized; `LD-0001`, `LAV-0001`, and LPV `bb379d47-c005-4b39-8202-e445c679b9ed` existed only in the disposable audit database.

| Scenario | Expected | Actual | Result | Evidence |
|---|---|---|---|---|
| Create partner-funded advance SAR 40 | One account credit, advance outstanding 40, partner payable 40, no expense | Exact match | PASS | Controlled `LAV-0001`; SQL/API snapshot |
| Create individual due SAR 100 | Expense 100; labour payable 100; no cash | Exact match | PASS | Controlled `LD-0001` |
| Apply SAR 30 advance and pay SAR 50 from partner | Due 20; advance 10; Farm Owes Partner 90; expense stays 100 | Exact canonical DB result | PASS | Controlled mixed fixture |
| Repeat same settlement operation | No duplicate LPV/allocation/journal | Same LPV ID; due remains 20 | PASS | Controlled retry plus unique keys |
| Void SAR 50 payment | Account net returns to 40; due returns to 70 | Operational rows restore; journal codes do not | FAIL | Controlled `PAYMENT_REVERSED` snapshot |
| Reverse SAR 30 application | Due returns to 100; advance outstanding 40 | Positions restore; journal compounds | FAIL | Controlled `APPLICATION_REVERSED` snapshot |
| Void advance then due | All current effects become zero | Account movement nets zero; journal ends with non-zero partner/payable/advance balances | FAIL | Controlled final snapshot; endpoint still `reconciled:true` |
| Cash, bank, partner direct payment | Selected account exactly once; payable reduced; no second expense | Passed for all three funding types | PASS | PostgreSQL integration test |
| Partner-funded advance after application | Farm Owes Partner remains full funded amount | SAR 500 remains payable after SAR 150 applied | PASS | Integration fixture |
| Advance before/during/after work period | Eligible through settlement date; future advance excluded | 100+100 eligible, later 300 excluded at cutoff | PASS | Integration fixture |
| Multiple/partial advances | Apply valid amount only, carry remainder | Passed including SAR 500/150 and refunds | PASS | Integration and pool tests |
| Group due with 45 member advances | Apply all atomically, no cash LPV | 45 applications, SAR 90, retry remains 45 | PASS | PostgreSQL integration test |
| Individual due with two legacy advances | Same-owner advances only | SAR 7,108 applied; unrelated SAR 9,000 excluded | PASS | PostgreSQL integration test |
| Group with configured leader | Count leader once | Passed | PASS | Integration and source contract tests |
| Group with member count only | Persist stable recipient snapshot | Supported by direct due contract | PARTIAL | API/source tests; no browser execution |
| Changed group membership after original advance | Use immutable due snapshot | DB trigger checks snapshot members | PASS | Migration/trigger inspection and integration test |
| Edit unused advance | Update all current effects | Current totals update | PARTIAL | Integration passes; posted audit history is rewritten |
| Delete unused advance | Remove effects without number/history corruption | Hard-deletes canonical financial rows | FAIL | Integration behavior plus route inspection |
| Edit/delete applied advance | Block with dependency | HTTP 409 | PASS | Integration test |
| Edit/delete unpaid due | Supported lifecycle or explicit prohibition | No endpoint/UI edit/delete exists | NOT TESTED | Capability absent; void only |
| Edit/delete partial/paid due | Prohibit unsafe mutation | No edit/delete route; void guarded | PASS | Static/API inspection |
| Put paid due on hold | Reject invalid lifecycle state | API directly writes `ON_HOLD` | FAIL | Route at `labour-payments.ts:1804` |
| Concurrent/double settlement | One financial result | Advisory/row locks and idempotency; same-key retry proven | PASS | Source and PostgreSQL integration tests |
| Duplicate Save click | Button disabled while saving; server idempotent | Guards exist for create/settle | PASS | UI/source and integration evidence |
| Offline create/edit/delete/settle/pay | Queue or clearly unsupported | Canonical UI refuses while offline | PARTIAL | Static UI inspection; no canonical queue |
| Retry after ambiguous network result | Resolve existing operation | Canonical settle keyed; legacy settlement status retry is covered | PARTIAL | Same-key API retry proven; no actual browser timeout injection |
| Cross-workspace/farm/season references | Reject | Rejected | PASS | Tenant-isolation integration tests and scoped FKs |
| Viewer financial mutation | Reject | Rejected | PASS | Tenant/wage-rate integration tests |
| Owner/admin/editor permissions | Match module permissions | API checks current permissions/scope | PARTIAL | Automated coverage; no rendered role walkthrough |
| Wage-rate create/update/overlap | Correct date range; reject overlap | API behavior passes | PASS | Tenant and wage-rate tests |
| Wage-rate historical stability | Posted dues unchanged | Posted due snapshots unchanged; reports may recompute from edited JSON | PARTIAL | Source tracing |
| Wage-rate local date boundary | Riyadh calendar day | UTC date used from 00:00–02:59 Riyadh | FAIL | `WageRates.tsx:15` |
| Inactive/deactivated labour advance | Preserve historical recipient; permit according to current rule | Read model and selector tests pass | PASS | Automated tests |
| Accounts screen after canonical direct payment | Balance/ledger includes LPV once | Main Accounts module never fetches canonical LPVs | FAIL | `ModulePage.tsx:4315-4354` |
| Partner Position after canonical partner payment | Farm Owes Partner rises | Legacy calculator omits canonical LPV | FAIL | `ModulePage.tsx:4098`; `Reports.tsx:1329` |
| Labour ledger after canonical due/payment | Show due, payment, remaining | Labour profile uses legacy earnings/payment stores | FAIL | `ModulePage.tsx:296-303` |
| Expense report after canonical due | Wage expense 100 exactly once | No canonical labour-expense report source | FAIL | Report option/source inspection |
| Advance report | Applied/outstanding accurate | Canonical coverage path exists and tested | PASS | Report/API test |
| Settlement/labour payment report | Dedicated detail and totals | Missing report options | FAIL | `Reports.tsx:113` |
| Farm/season switch while report mounted | Refetch canonical data | Effect dependencies omit farm/season | FAIL | `Reports.tsx:550-565` |
| Actual desktop/mobile browser workflow | Render and interact | In-app browser returned blank document/DOM for local Vite app | NOT TESTED | Blank screenshot, empty DOM/console; builds and source UX tests used instead |

## 4. Accounting reconciliation

### Controlled mixed scenario before reversal

| Metric | Expected | Labour Payments / DB | Accounts UI | Partner Position | Labour ledger | Reports | Result |
|---|---:|---:|---:|---:|---:|---:|---|
| Original labour due | 100 | 100 | n/a | n/a | legacy source | not dedicated | PARTIAL |
| Advance paid | 40 | 40 | legacy-only view risk | 40 canonical liability | legacy source | canonical advance report 40 | PARTIAL |
| Advance applied | 30 | 30 | no cash event | must not reduce 90 | legacy source | 30 | PARTIAL |
| Outstanding advance | 10 | 10 | n/a | n/a | legacy source | 10 | PARTIAL |
| Direct labour payment | 50 | 50 | canonical LPV omitted | canonical liability should add 50 | legacy source | account-ledger augmentation only | FAIL |
| Remaining labour due | 20 | 20 | n/a | n/a | legacy source | Payments Due 20 | PARTIAL |
| Wage expense recognized | 100 | 100 | n/a | n/a | journal 100 | expenditure report omits canonical journal | FAIL |
| Farm owes partner | 90 | journal credit 90 | legacy view risk | legacy calculator omits canonical payment | n/a | inconsistent paths | FAIL |

The canonical source rows before reversal are mathematically correct: partner payable Cr 90; labour payable Cr 100/Dr 80 (20 remaining); labour expense Dr 100; labour advance Dr 40/Cr 30 (10 outstanding); account cash effects Cr 90. No extra cash event is created for the SAR 30 advance application.

After all reversals, account transactions net to zero and the due is `VOIDED`, but the endpoint's POSTED-only journal shows partner payable Dr 40/Cr 50, labour payable Dr 180, labour expense Cr 100, and labour advance Cr 70. It nevertheless reports `reconciled: true` because total debits still equal total credits; balance alone cannot detect misclassified/compounded ledger effects.

## 5. Confirmed defects

### LP-01 — P1: reversal journal produces false current ledger balances

- **Symptom:** void/reverse restores due and account movement rows but leaves nonsensical active normalized subledger balances; reconciliation says success.
- **Financial impact:** partner payable, labour payable, advance, and expense reporting can all be wrong after a reversal.
- **Reproduction:** create partner advance 40; due 100; apply 30 and partner-pay 50; void payment; reverse application; void advance; void due; query POSTED journal and reconciliation.
- **Expected:** each reversal cancels only the original economic posting and current ledgers return to zero after all sources are void.
- **Actual:** reversal inserts opposite POSTED entries and marks originals REVERSED; subsequent due-level reversals select earlier POSTED reversal rows and reverse them again. Final current ledgers remain non-zero while `reconciled:true`.
- **Root cause:** `reverseLabourJournal` selects all matching POSTED rows without excluding reversal rows or using a stable event boundary; reconciliation reads only POSTED status and validates only total debit-credit equality.
- **Frontend:** `web/src/pages/workspace/WorkforcePayments.tsx`, voucher/due void handlers.
- **API:** `api/src/routes/labour-payments.ts`, due/application/voucher reversal handlers and reconciliation route around 2801.
- **DB:** `labour_accounting_entries`; no constraint prevents reversal-of-reversal compounding or enforces event-level balance.
- **Existing-data risk:** yes, any canonical void/reversal may be affected.
- **Safe correction:** define one current-balance convention, exclude reversal entries from later source reversal selection, reverse immutable original event keys exactly once, and strengthen reconciliation by expected ledger-code positions.
- **Regression:** run the full mixed reversal sequence and assert every ledger code, not only total debit=credit.

### LP-02 — P1: canonical transactions are not consistently consumed by Accounts, Partner Position, labour ledger, expense report, and activity

- **Symptom:** the Labour Payments API succeeds but related screens can omit the transaction.
- **Financial impact:** users can see conflicting cash, Farm Owes Partner, labour balance, and expense totals.
- **Reproduction:** post a canonical direct partner payment; open Accounts, Partner Position, labour profile ledger, expense report, and recent activity.
- **Expected:** the same canonical event appears exactly once everywhere.
- **Actual:** the main calculations load legacy IndexedDB accounts/vouchers/advances/settlements; canonical LPVs are only partly added inside Reports account-ledger logic.
- **Root cause:** dual read models and duplicate calculators (`calculateAccountBalance`, `buildPartnerLiabilityPositions`, `buildLabourEarningsProfileSummary`) have not been replaced or consistently augmented with canonical API data.
- **Frontend:** `ModulePage.tsx:296-303`, `4098`, `4315-4354`; `Reports.tsx:1287-1437`; `workspaceActivity.ts:197-198`.
- **API/DB:** canonical LPV, account transaction, and journal rows exist; no unified cross-screen read endpoint.
- **Existing-data risk:** yes; canonical records may already be under-reported in those screens without source-row loss.
- **Safe correction:** make one canonical read model feed all summaries/ledgers, retaining explicit legacy coverage without double counting.
- **Regression:** one fixture must assert identical voucher breakdown and totals in every screen/API.

### LP-03 — P1: report data can remain scoped to the previous farm/season

- **Symptom:** changing context while Reports stays mounted can leave canonical vouchers/advances from the old context.
- **Financial impact:** wrong-farm financial data can be displayed (not proven as API disclosure; it is stale authorized client state).
- **Reproduction:** open Reports, switch active farm or season without remounting, inspect canonical rows.
- **Expected:** clear and refetch for the new context.
- **Actual:** fetch reads active farm/season but effect dependencies are only token/workspace.
- **Root cause:** missing farm/season dependencies at `Reports.tsx:550-565`.
- **Production risk:** yes, transient misreporting.
- **Safe correction/regression:** use explicit context state/query keys and test an in-place context switch.

### LP-04 — P2: posted advance edit/delete is not an auditable correction

- **Symptom:** editing deletes and recreates original movement/journal; deleting removes the posted voucher and its financial rows.
- **Financial impact:** current totals may be correct, but voucher history and audit trace no longer represent immutable accounting events; the highest deleted number may be reused.
- **Reproduction:** post an unused advance, edit it, inspect original transaction/journal; then delete it and inspect canonical rows/next number.
- **Expected:** immutable correction/reversal or an explicitly documented draft-only lifecycle.
- **Actual:** hard delete/rewrite; audit log is the only remaining trace.
- **Frontend:** Advance editor/delete dialog in `WorkforcePayments.tsx`.
- **API:** `labour-payments.ts:2287` PATCH and `2418` DELETE.
- **DB:** cascades from `labour_payment_vouchers`; scoped number uniqueness protects only existing rows.
- **Production risk:** yes, historical edits/deletes may exist in audit logs.
- **Safe correction/regression:** reverse-and-replace posted vouchers; never recycle issued numbers; assert old and corrective records remain linked.

### LP-05 — P2: incomplete due/application lifecycle in the UI

- **Symptom:** unpaid due has no edit/delete; an applied advance has an API reversal route but no discoverable UI action, while due void instructs the user to reverse applications first.
- **Impact:** a valid correction can be impossible from the current module.
- **Root cause:** API/UI capability mismatch.
- **API:** application reverse at `labour-payments.ts:1985`; due has hold/void but no edit/delete.
- **Safe correction/regression:** expose the existing reversal safely, or make due void orchestrate it transactionally; define draft versus posted editing rules.

### LP-06 — P2: hold endpoint permits invalid paid/settled state transition

- **Symptom:** a paid/settled due can be written as `ON_HOLD`.
- **Impact:** summary/report state can temporarily contradict active payment/allocation rows.
- **Root cause:** `labour-payments.ts:1804-1829` writes status without validating current position; UI exposes hold from due detail.
- **Safe correction/regression:** reject hold when active clearing exists and audit valid transitions.

### LP-07 — P2: wage-rate history and date behavior are not financially stable

- **Symptom:** early-morning Riyadh defaults can use yesterday; editing a rate overwrites JSON history and recalculated attendance reports can change.
- **Impact:** a historical attendance wage report can differ from its earlier output, although posted due snapshots remain unchanged.
- **Root cause:** `new Date().toISOString().slice(0,10)` at `WageRates.tsx:15`; operational JSON update rather than immutable effective-dated revisions; duplicate rate resolution logic.
- **DB:** no wage-rate-specific constraint/trigger.
- **Safe correction/regression:** use the application business timezone, immutable effective-dated revisions, and snapshot/reference posted calculations.

### LP-08 — P2: canonical financial operations have no offline queue

- **Symptom:** create/edit/delete/settle/pay/void handlers reject while offline even though legacy entity queues still exist.
- **Impact:** advertised offline behavior is inconsistent and stale legacy queues increase duplicate-path risk.
- **Root cause:** canonical handlers explicitly check `navigator.onLine`; generic sync still handles legacy financial entities.
- **Safe correction/regression:** either clearly declare canonical financial posting online-only and retire legacy mutation paths, or add server-revalidated idempotent canonical operations.

### LP-09 — P2: dedicated labour payment and settlement reports are absent

- **Symptom:** reports offer attendance, advances, wage rates, expenditures, sales, dispatch, partner position, and account ledger only.
- **Impact:** no authoritative voucher-level labour payment/settlement report; canonical wage expense is not in the general expenditure source.
- **Evidence:** `Reports.tsx:113`; reports hub has only advance, wage-rate, and Payments Due links.

### LP-10 — P3: source contracts and normal UI contain stale/remnant behavior

- **Symptom:** three API tests fail because navigation/report expectations drifted; half-day rate remains; legacy earnings/settlement/reconciliation and temporary diagnostics remain in code/routes.
- **Impact:** maintenance and user-language inconsistency; not direct proven monetary corruption.
- **Safe correction:** decide which remnants are intentional, update/remove routes and tests together, and keep diagnostics admin-only.

## 6. Loose ends and technical debt

- Duplicate business calculators across canonical API journal, legacy IndexedDB accounting, Reports augmentations, partner snapshot helpers, and labour earnings summary.
- No database-level event-balance constraint for `labour_accounting_entries`; API code is trusted to create balanced pairs.
- Legacy settlement creation/status/repair/void routes and hard-cleanup reconciliation routes remain registered after the current UI retired them.
- Unreachable `LabourEarnings`, `LabourWageSettlements`, and `LabourReconciliation` UI files remain.
- Temporary diagnostics routes/settings and fallback tracing remain intentionally gated but not cleaned up.
- `half_day` rate type and half-day attendance calculations remain active despite removal expectations.
- Canonical operations use idempotency and locks, but advance PATCH and DELETE do not provide retry-equivalent lifecycle semantics.
- Advance deletion has no dependency preview UI.
- Due edit/delete/restore and application reversal UI are missing.
- Wage-rate rules are TypeScript/API-only over generic JSON storage.
- Reconciliation proves only aggregate debit=credit, not ledger classification, source completeness, or expected balances.
- Three source-contract tests are stale/failing, and there is no browser E2E suite exercising the rendered module in this environment.

## 7. Production-data risk assessment

Existing records may require read-only reconciliation. Do not update them until the reversal convention and canonical reporting source are agreed. Run these against a backup/read replica or in a read-only transaction, with explicit workspace/farm/season predicates added.

```sql
-- Reversals that can participate in the POSTED-only current-ledger defect.
SELECT o.workspace_id, o.farm_id, o.season_id, o.id AS original_id,
       o.event_type AS original_event, o.status AS original_status,
       r.id AS reversal_id, r.voucher_id, r.due_id, r.advance_application_id,
       r.ledger_code, r.debit, r.credit
FROM labour_accounting_entries o
JOIN labour_accounting_entries r ON r.reversal_of = o.id
WHERE o.status = 'REVERSED' AND r.status = 'POSTED'
ORDER BY o.workspace_id, o.farm_id, o.season_id, r.posted_at;

-- Compare POSTED-only and full-history ledger-code nets. Review every non-zero delta.
SELECT workspace_id, farm_id, season_id, ledger_code,
       SUM(debit-credit) FILTER (WHERE status='POSTED') AS posted_net,
       SUM(debit-credit) AS all_row_net,
       COUNT(*) FILTER (WHERE reversal_of IS NOT NULL) AS reversal_rows
FROM labour_accounting_entries
GROUP BY workspace_id, farm_id, season_id, ledger_code
HAVING COUNT(*) FILTER (WHERE reversal_of IS NOT NULL) > 0;

-- Posted non-legacy vouchers missing their cash/account movement.
SELECT id, workspace_id, farm_id, season_id, voucher_number, nature, payment_amount
FROM labour_payment_vouchers
WHERE status='POSTED' AND legacy=false AND account_transaction_id IS NULL;

-- Due equation mismatches from active allocations and applications.
WITH paid AS (
  SELECT due_id, COALESCE(SUM(allocated_amount),0) amount
  FROM labour_payment_allocations WHERE status='ACTIVE' GROUP BY due_id
), applied AS (
  SELECT due_id, COALESCE(SUM(applied_amount),0) amount
  FROM labour_advance_applications WHERE status='ACTIVE' GROUP BY due_id
)
SELECT d.id, d.due_number, d.gross_amount, d.authorized_deductions,
       COALESCE(a.amount,0) applied, COALESCE(p.amount,0) paid,
       d.payment_status,
       d.gross_amount-d.authorized_deductions-COALESCE(a.amount,0)-COALESCE(p.amount,0) expected_remaining
FROM labour_dues d
LEFT JOIN paid p ON p.due_id=d.id
LEFT JOIN applied a ON a.due_id=d.id
WHERE d.payment_status <> 'VOIDED'
  AND d.gross_amount-d.authorized_deductions-COALESCE(a.amount,0)-COALESCE(p.amount,0) < 0;

-- Deleted advance audit traces and possible later reuse of the same voucher number.
SELECT al.workspace_id, al.created_at, al.before_json->>'voucherNumber' deleted_number,
       live.id AS reused_live_voucher_id
FROM audit_logs al
LEFT JOIN labour_payment_vouchers live
  ON live.workspace_id=al.workspace_id
 AND live.voucher_number=al.before_json->>'voucherNumber'
WHERE al.action='labour_advance_deleted';

-- Overlapping active wage-rate JSON ranges for the same scoped labour/rate type.
SELECT a.workspace_id, a.farm_id, a.season_id, a.id a_id, b.id b_id,
       a.payload->>'labourerId' labourer_id, a.payload->>'rateType' rate_type
FROM operational_records a
JOIN operational_records b ON b.entity_type='wageRate' AND b.id>a.id
 AND b.workspace_id=a.workspace_id
 AND b.farm_id IS NOT DISTINCT FROM a.farm_id
 AND b.season_id IS NOT DISTINCT FROM a.season_id
 AND b.payload->>'labourerId'=a.payload->>'labourerId'
 AND b.payload->>'rateType'=a.payload->>'rateType'
WHERE a.entity_type='wageRate'
 AND COALESCE(a.payload->>'deletedAt','')=''
 AND COALESCE(b.payload->>'deletedAt','')=''
 AND (a.payload->>'effectiveFrom')::date <= COALESCE(NULLIF(b.payload->>'effectiveTo','')::date,'infinity'::date)
 AND (b.payload->>'effectiveFrom')::date <= COALESCE(NULLIF(a.payload->>'effectiveTo','')::date,'infinity'::date);

-- Legacy rows whose nullable context requires an explicit migration/reporting policy.
SELECT entity_type, COUNT(*)
FROM operational_records
WHERE entity_type IN ('advance','labourPayment','labourEarning','labourWageSettlement','wageRate')
  AND (farm_id IS NULL OR season_id IS NULL)
GROUP BY entity_type;
```

## 8. Recommended correction order

1. Fix reversal event selection and strengthen reconciliation to assert expected balances by ledger code and source.
2. Make canonical LPVs/journal/positions the shared source for Accounts, Partner Position, labour/group ledger, expenses, activity, and reports.
3. Convert posted advance edits/deletes to immutable reversal/correction semantics and guarantee permanent voucher-number reservation.
4. Add context keys to report queries; retain server-side tenant/farm/season/permission revalidation.
5. Add canonical Labour Payment and Settlement reports with voucher-level reconciliation.
6. Complete the due/application lifecycle and dependency preview; reject invalid hold transitions.
7. Decide and document online-only versus queued financial posting, then remove the conflicting legacy mutation path or implement canonical offline idempotency.
8. Fix Riyadh date handling and immutable wage-rate revisions; decide whether half-day remains supported.
9. Improve void/delete consequence dialogs, account labels, retry states, and mobile browser coverage.
10. Remove or formally retain legacy earnings/settlement/reconciliation routes, dead components, diagnostics, and stale tests.

## 9. Verification evidence

### Commands and results

- `npm run db:init --workspace api` against `muzare_labour_audit_20260721`: migrations 0001 through 0040 applied successfully from a clean database.
- `npm run test:integration --workspace api`: 262 tests; 258 passed, 3 failed, 1 skipped. All PostgreSQL labour-payment and tenant-isolation integration cases shown above passed. The three failures are source-contract drift: labour work report wiring, retired navigation label, and advance-pool fetch expectation.
- Web tests: 9/9 passed.
- `npm run check`: API and web TypeScript checks passed.
- API production build: passed.
- Web production build: passed; 1,925 modules and PWA output generated. Non-labour warning: `FarmOperationsMap` chunk approximately 1,108.63 kB exceeds the 500 kB warning threshold.
- No lint script exists.
- Direct `pg_catalog` inspection: confirmed financial-scope composite FKs, scoped unique keys, allocation/application guards, payment/refund guards, and migration-trigger installation.
- Controlled API/SQL smoke script: created the randomized mixed fixture, retried it, reversed each layer, queried source rows and `/labour-payments/reconciliation`, and cleaned its fixture rows.
- The disposable `muzare_labour_audit_20260721` database was dropped after evidence capture.

### Browser evidence and limitation

The local API and Vite application started successfully. The in-app browser opened the local application, but the page produced a blank screenshot and empty accessibility/DOM snapshots with no console error. Consequently, no claim is made for live mouse/keyboard workflows, responsive layout, focus behavior, confirmation dialogs, or role-specific rendered controls. Static UI inspection and source-level UI tests are evidence, but not a substitute for the missing browser session.

### Final-standard answer

**No.** Create and pre-reversal settlement consistency can be proved for the canonical database path, including cash/bank/partner funding, group/member allocation, tenant scope, and retry idempotency. It cannot currently be proved across every named screen and lifecycle action: reversal corrupts the active normalized journal view, several related screens use legacy data/calculators, canonical offline mutations are unsupported, and required browser workflows could not render in the audit environment.
