# Labour Payments complete function audit — 2026-07-21

## 1. Executive conclusion

**Conclusion: Major financial integrity risk.**

The current canonical PostgreSQL posting and exact-reversal path is materially stronger than the surrounding UI: the controlled mixed transaction posted the correct journals, repeated and concurrent reversal tests produced one inverse per original line, and the layered advance/payment/due reversal returned that scenario's ledgers to zero. However, the same live fixture was reported inconsistently by Accounts, Partner Position, the Advance Report, Payment Voucher summary cards, and the hold workflow. A freshly created UI account could not fund a canonical advance until a controlled SQL fixture supplied the missing normalized account row. Those are active financial workflows, so successful builds and balanced journals do not make the module safe as a whole.

This was an audit-only run. No product source, migration, production record, commit, or remote branch was changed. All destructive operations used `muzare_labour_complete_audit_20260721`; automated tests used `muzare_labour_automated_audit_20260721`.

**Wage Rates were excluded by instruction and were not functionally audited.**

The prior blank-page blocker was environmental, not a product render defect: stale processes occupied the expected 5173/3101 ports and the old API returned unhealthy bootstrap responses. Isolated Vite/API ports 5273/3201, an explicit `VITE_API_URL`, a clean database, and a valid owner/farm/season context rendered the application without changing product code.

The answer to “Was every function inside Labour Payments, excluding Wage Rates, individually tested?” is **No**. Every discovered function is inventoried below, but 15 functions remain explicitly `NOT TESTED` because the run had no safe way to simulate browser offline/ambiguous-network state, populate a large paginated fixture, automate native `window.prompt`, or cover every role/source combination without expanding the controlled fixture. Missing and unreachable functions are separately classified rather than being treated as tested.

## 2. Complete function inventory

The current module exposes five navigation items: Payments Due, New Labour Due, the excluded tab, Payment Vouchers, and Outstanding Advances. A separate `/workspace/labour-payments/reports` hub exposes Advance Report and Payments Due links; it is not linked from the module navigation. Route aliases remain for `earnings`, `labour-work`, `legacy-earnings`, `settlements`, `settlement`, `settlement-history`, `legacy-advances`, and old top-level advance URLs.

API inventory in `api/src/routes/labour-payments.ts`: due list/detail, attendance preview, create due, advance pool, settle, hold/remove hold, void due, reverse application, create/edit/delete/list advance, list vouchers, financial read model, reconciliation, refund/recovery, and voucher void/reversal. Current UI source is primarily `web/src/pages/workspace/WorkforcePayments.tsx`; the older `web/src/pages/workspace/LabourAdvances.tsx` remains in source but is not the active module page.

## 3. Master function-result table

Every classification is one of PASS, PARTIAL, FAIL, MISSING, UNREACHABLE, or NOT TESTED.

| # | Page | Function/action | Test performed | Expected | Actual | Result | Evidence |
| -: | ---- | --------------- | -------------- | -------- | ------ | ------ | -------- |
| 1 | Shell | Load/auth/bootstrap | Owner login, workspace/farm/season bootstrap, refresh and re-login | Render correct scope | Rendered and persisted on isolated ports | PASS | Browser; API health 200 |
| 2 | Shell | Back to workforce | Clicked/navigated and returned | Safe navigation, no resubmit | Correct | PASS | Browser route history |
| 3 | Shell | Module tabs/deep links | Opened every non-excluded current tab and route aliases | Correct current destination | Current tabs work; several legacy aliases redirect | PASS | `web/src/App.tsx`; browser |
| 4 | Payments Due | Initial loading | Cold navigation desktop/mobile | Skeleton then scoped data | Correct | PASS | screenshots 04/05 |
| 5 | Payments Due | Summary cards | Compared cards with visible/database rows | Same scoped totals | Due/advance cards matched final active fixture | PASS | SAR 50 due; SAR 15 advance |
| 6 | Payments Due | Search | Searched known due/recipient | Only matching row | Correct on tested row | PASS | Browser |
| 7 | Payments Due | Status filter | Used default, all, and On Hold | Persisted hold visible in On Hold | Held due disappeared and returned as Unpaid | FAIL | DB `ON_HOLD`; UI Unpaid after refresh |
| 8 | Payments Due | Origin filter | Switched direct/all | Correct direct due filtering | Correct | PASS | Browser |
| 9 | Payments Due | Recipient-scope filter | Switched group/all | Correct group filtering | Correct | PASS | `LD-0002` |
| 10 | Payments Due | From/to date filters | Exercised fixture boundary | Inclusive local dates | Correct for listed due | PASS | Browser |
| 11 | Payments Due | Labour/group-specific filter | Looked for dedicated controls | Expected by audit brief | Only search and recipient scope exist | MISSING | DOM inventory |
| 12 | Payments Due | Sorting | Looked for sort control | Discoverable ordering control | None | MISSING | DOM/source |
| 13 | Payments Due | Pagination/infinite load | Inspected list/source | Stable large-list navigation | No control in tested small fixture | NOT TESTED | Large fixture not created |
| 14 | Payments Due | Open due detail | Opened individual and group cards | Correct detail and amounts | Correct for `LD-0001`, `LD-0002` | PASS | Browser/screenshots |
| 15 | New Due | Direct individual due | Submitted SAR 100 | One due, expense/payable 100, no cash | Correct | PASS | `LD-0001`; journal Dr expense/Cr payable 100 |
| 16 | New Due | Direct group due | Submitted SAR 50 | Immutable group/member snapshot | Correct group name and one-member snapshot | PASS | `LD-0002`; DB snapshot |
| 17 | New Due | Other recipient scopes | Inspected contractor, crew, unregistered, none selectors | Valid stable identity | Controls exist; not submitted | NOT TESTED | Fixture limited to individual/group |
| 18 | New Due | Attendance preview/create | Opened attendance source and inspected validation | Preview then one canonical due | Source/API present; not posted | NOT TESTED | No attendance fixture |
| 19 | New Due | Required/zero/negative validation | Submitted/inspected disabled state | Block invalid amounts/recipient | Button disabled; API schema rejects | PASS | Browser; API tests |
| 20 | New Due | Decimal/large/future date | Inspected schema only | Precise and policy-consistent | Not executed | NOT TESTED | No safe acceptance policy stated |
| 21 | New Due | Duplicate/idempotent create | Full API suite repeats operations | One due per key | Covered by passing source/integration suite | PASS | API suite 262/0/1 |
| 22 | New Due | Edit due | Searched UI/routes | Auditable edit if supported | No edit action | MISSING | UI/API inventory |
| 23 | New Due | Delete due | Searched UI/routes | Delete or explicitly void | No delete; void only | MISSING | UI/API inventory |
| 24 | Due detail | Close/cancel | Closed detail without mutation | No change | Correct | PASS | Browser |
| 25 | Due detail | Put unpaid due on hold | Clicked, queried DB, refreshed | Show `ON_HOLD`; block pay/apply | DB changed, list re-rendered Unpaid | FAIL | `PATCH .../hold`; `LD-0001` |
| 26 | Due detail | Hold partial/paid/voided | Inspected guards/API | Only legal states allowed | Not all state combinations executed | NOT TESTED | Main hold defect blocked reliable UI matrix |
| 27 | Due detail | Remove hold | Repeated API call | Restore calculated status once | API returned Unpaid idempotently; UI action becomes unreachable after refresh | PARTIAL | API 200; UI loses hold |
| 28 | Due detail | Void unpaid due | API void after dependent reversals; repeat | Reverse expense/payable once | Correct and idempotent | PASS | `LD-0001` VOIDED; 2 exact journal inverses |
| 29 | Due detail | Void with active dependencies | Tried lifecycle ordering/source inspection | Block until payment/application reversed | API dependency checks present; all combinations not executed | PARTIAL | route 1852 |
| 30 | Due detail | Void confirmation | Opened UI control | Explain financial reversal | Uses generic prompt; browser automation could not accept native prompt | NOT TESTED | Native prompt blocker |
| 31 | Advances | Initial loading/empty state | Opened list with none and populated | Correct state | Correct | PASS | Browser |
| 32 | Advances | Create partner advance | Submitted SAR 40 | One voucher/account/journal, no expense | Initially failed because UI account lacked normalized mapping; passed only after fixture SQL | FAIL | screenshot 01; `LAV-0001` |
| 33 | Advances | Create cash advance | Submitted SAR 25 | Correct cash movement/advance | Correct after normalized fixture account | PASS | `LAV-0002` |
| 34 | Advances | Create bank advance | Submitted SAR 15 | Correct bank movement/advance | Correct, then deleted | PASS | `LAV-0003` |
| 35 | Advances | Group advance | Searched form | Supported if intended | Recipient is individual labourer only | MISSING | Create dialog |
| 36 | Advances | Inactive/deleted/cross-workspace labour | Source/API test coverage | Historical eligible, invalid foreign/deleted rejected | Automated eligibility/tenant tests pass; no browser fixture | PARTIAL | API suite |
| 37 | Advances | Amount/account validation | Zero/negative/excessive refund, missing account | Block invalid | Create required controls; refund >15 disabled; zero invalid | PASS | Browser |
| 38 | Advances | Same-day/past date | Created same-day then opened pool | Due-date eligible advance included | API classified SAR 40 as posted after settlement due UTC/local boundary | FAIL | advance-pool response |
| 39 | Advances | Duplicate Save/retry | API repeated idempotency | Exactly one voucher | Passing integration suite | PASS | unique workspace/idempotency key |
| 40 | Advances | Search | Searched voucher/labour | Matching records | Correct | PASS | Browser |
| 41 | Advances | Grouped/vouchers view | Toggled both | Same facts, different aggregation | Correct in tested fixture | PASS | Browser |
| 42 | Advances | Status/account/scope filters | Opened Filters and changed tested values | Correct rows/totals | Correct for fixture | PASS | Browser |
| 43 | Advances | Pagination/load more | Inspected small list | Correct next page | Not enough rows to execute | NOT TESTED | Large fixture not created |
| 44 | Advances | View detail | Opened Details | Original/applied/recovered/outstanding/source/status | Correct for active/refunded fixture | PASS | `LAV-0002` showed 25/0/10/15 |
| 45 | Advances | Edit unused advance | Changed date and saved | Persist changed date without corrupting history | Success toast, displayed/DB date unchanged; original journal/accounting timestamps rewritten | FAIL | `LAV-0001` |
| 46 | Advances | Edit applied/refunded/voided | Inspected action guards | Prohibit unsafe edit | Actions removed after refund/application | PASS | Browser/source |
| 47 | Advances | Delete unused advance | Deleted bank advance | Remove current effect but retain auditable history | Source, transaction, and journal hard-deleted | FAIL | `LAV-0003` absent from DB |
| 48 | Advances | Delete dependent advance | Inspected menus/API guards | Block linked/refunded/applied | Edit/delete absent for partially refunded fixture | PASS | `LAV-0002` menu |
| 49 | Advances | Partial recovery | Recovered 10 from 25 | Outstanding 15; inverse account/advance entry | Correct | PASS | `LAR-0002` |
| 50 | Advances | Full/multiple/source recovery | Inspected controls/API | Exact cumulative cap and all accounts | Partial one-source only executed | NOT TESTED | Fixture scope |
| 51 | Advance pool | No eligible advance | Opened group due | Clear empty state | Correct | PASS | `LD-0002` |
| 52 | Advance pool | One/multiple/date eligibility | Opened individual due | Accurate eligible/excluded reasons | Same-day exclusion incorrect; one advance applied after controlled backdate | FAIL | `postedAfterSettlementDate: 40` |
| 53 | Advance pool | Cross-scope isolation | Automated tenant and pool tests | Exclude foreign farm/season/workspace | Passing automated suite | PASS | API suite |
| 54 | Advance pool | Group due/member-owned advance | Schema/migration/source tests | Snapshot member may fund group due | Automated integration passes; not reproduced in browser fixture | PARTIAL | migration 0039; API tests |
| 55 | Review/settle | Quick full/use all/clear/details | Exercised pool and amount controls | Deterministic selections | Worked for one eligible advance | PASS | Browser |
| 56 | Review/settle | Partial advance application | Applied SAR 30 of SAR 40 | Due 70 before payment; advance 10; no cash/expense | Correct | PASS | application ACTIVE 30 |
| 57 | Review/settle | Direct partner payment | Paid SAR 50 in mixed settlement | Due 20; partner liability +50; no second expense | Canonical DB correct | PASS | `LPV-0001` |
| 58 | Review/settle | Mixed settlement submit | Applied 30 + paid 50 | Atomic one response, remaining 20 | Correct | PASS | screenshot 02 |
| 59 | Review/settle | Over/zero/negative payment | Inspected disabled/validation and API tests | Reject | Correct for tested controls | PASS | Browser/API |
| 60 | Review/settle | Hold blocks settlement | Refreshed held due | No settlement controls while held | UI forgot hold and exposed controls | FAIL | hold reproduction |
| 61 | Review/settle | Duplicate/concurrent settlement | Automated repeated/concurrent suite | One application/payment | Pass | PASS | API suite |
| 62 | Application | Reverse application API | Reversed SAR 30; repeated | Restore due/advance once; no cash; partner unchanged | Correct | PASS | application REVERSED; exact inverse |
| 63 | Application | Reverse application UI | Searched detail/voucher/advance screens | Discoverable reversal | No UI action | UNREACHABLE | API route 1987 only |
| 64 | Payment Vouchers | Load/search/nature filter | Opened, searched, filtered | Correct subset | Correct for displayed payment/reversal | PASS | Browser |
| 65 | Payment Vouchers | Status/date/account filters/sort/pagination | Searched controls/source | Required register controls | Not implemented | MISSING | DOM/source |
| 66 | Payment Vouchers | Advance/refund visibility | Compared register to DB | All canonical voucher types visible | Advance/refund omitted by nature/query design | FAIL | DB six vouchers; register showed LPVs |
| 67 | Payment Vouchers | Detail/source/allocation/account navigation | Inspected row actions | Open full provenance | No detail/open links | MISSING | DOM/source |
| 68 | Payment Vouchers | Print/export | Inspected page | Printable voucher/history | No action | MISSING | DOM/source |
| 69 | Payment Vouchers | Void/reverse partner payment | API void, repeat, concurrent suite | One inverse, due restored 50, partner -50 | Correct canonical effect | PASS | `LPV-0002`; screenshot 03 |
| 70 | Payment Vouchers | Void/reverse UI confirmation | Clicked Void/reverse twice | Confirm then execute once | Native prompt auto-dismissed by automation | NOT TESTED | Browser limitation |
| 71 | Payment Vouchers | Summary totals after reversal | Refreshed after void | Active direct payments 0 | “Final labour payments -SAR 50” | FAIL | screenshot 03; lines 1033–1043 |
| 72 | Payment Vouchers | Reversal date | Compared source/local date | Preserve intended business date | Reversal displayed prior UTC calendar date | FAIL | `LPV-0002` 2026-07-20 vs UI 2026-07-21 |
| 73 | Accounts | Canonical account balance | Inspected partner card | 40+50=90 once | SAR 90 | PASS | Browser/DB |
| 74 | Accounts | Account ledger rows/running balance | Opened Audit Partner | LAV 40 + LPV 50 = 90 | Correct rows/running 90 | PASS | Browser |
| 75 | Accounts | Breakdown/reconciliation cards | Compared same ledger | Direct expenses/owes partner 90 | Both reported 40; warning delta 50 | FAIL | Accounts detail |
| 76 | Accounts | Expense visibility | Compared due expense 100 | Show canonical wage expense 100 | Cards showed zero while expense report showed 100 | FAIL | Browser |
| 77 | Partner Position | Canonical position | Opened report after mixed post | Owes 90; outstanding labour advance 10 | Owes 40; outstanding 40 | FAIL | Browser; `Reports.tsx:1326` |
| 78 | Partner ledger | Canonical running balance | Opened account/partner ledger | Equal Partner Position and 90 | Ledger 90; Partner Position 40 | FAIL | Browser |
| 79 | Labour ledger | Canonical event rows | Opened labourer detail | Due, advance, apply, payment with useful amounts | Rows present; advance payment displayed SAR 0 and summary Payments 0 | PARTIAL | `ModulePage.tsx:309` |
| 80 | Group ledger | Group due history | Opened group/member state | Immutable group due/snapshot | Due snapshot verified; complete group ledger lifecycle not executed | NOT TESTED | No member-advance browser fixture |
| 81 | Expense Report | Canonical wage expense | Opened expenditures | Wage expense 100 once; no cash/application duplicates | Correct before due void | PASS | Report total/labour wages 100 |
| 82 | Advance Report | Canonical advances | Opened advances report | LAV 40, applied 30, outstanding 10 | All zeros/no canonical rows | FAIL | `Reports.tsx:1097–1108` |
| 83 | Labour Payment Report | Discoverability | Searched module/report hub | Dedicated report if required | Does not exist | MISSING | Reports hub |
| 84 | Settlement Report/history | Followed aliases/hub | Historical settlement reporting | Alias redirects to voucher register; no dedicated report | UNREACHABLE | App route aliases |
| 85 | Voucher history | Compared all canonical vouchers | Complete chronological history | Register excludes advance/refund; delete removes history | FAIL | Browser/DB |
| 86 | Recent Activity | Inspected after posting/reversal | Posted/applied/paid/reversed/voided states | Canonical events and state labels present | PASS | Browser/read model |
| 87 | Reports | Print/export existing reports | Inspected buttons/source | Print/export for reachable report | Present on Reports; not individually generated in fixture | NOT TESTED | No file-download permission requested |
| 88 | Reports | Farm/season context switching | Automated source-contract test | Clear/refetch/discard stale response | Pass | PASS | web test `labour-financial-context` |
| 89 | Permissions | Viewer reads | Logged in viewer | Read current rows | Correct | PASS | Browser |
| 90 | Permissions | Viewer writes | Opened due/form and API tenant suite | Hidden or disabled; API 403 | Form remains visible but submit disabled; API permission tests pass | PARTIAL | Browser/API suite |
| 91 | Permissions | Owner writes | All principal actions | Allowed in selected scope | Correct | PASS | Browser/API |
| 92 | Permissions | Admin/editor matrix | Source and general tenant suite | Match granted role | Not individually browser-tested | NOT TESTED | Only owner/viewer fixtures created |
| 93 | Security | Cross-workspace/farm/season IDs | Full tenant-isolation suite | 403/404, no foreign mutation | Pass | PASS | API suite |
| 94 | Offline | Open/create/edit/delete offline | Inspected implementation/messages | Explicit safe behavior or canonical queue | Financial actions are online-only; no controlled offline browser capability | NOT TESTED | No offline browser control |
| 95 | Offline | Retry after ambiguous commit/context change | Automated idempotency only | Revalidate and no duplicate | Server idempotency passes; browser/offline queue path not executed | PARTIAL | API suite |
| 96 | Mobile | Navigation/cards/filters | 390×844 viewport | Critical information/actions reachable | Rendered; horizontal tab clipping but scrollable | PASS | screenshots 04/05 |
| 97 | Mobile | Due dialog | Opened group due | Amount/account/status/actions readable | Critical fields visible; lower controls require scrolling | PASS | screenshot 05 |
| 98 | Errors | Account mapping error | Submitted advance with UI-created account | Account usable or remediation clear | Action failed with “Payment account is not mapped” | FAIL | screenshot 01 |
| 99 | Errors | Form retention/retry | Observed mapping failure | Preserve entered data | Dialog retained most data | PASS | Browser |
| 100 | Reconciliation | Structured canonical checks | Queried during mixed fixture and ran corruption regression tests | Eight required groups; any failure false | Current clean fixture passed; automated false-positive regression passes | PASS | `labour-financial-reconciliation.ts` |

## 4. Full scenario matrix

| Scenario | Expected | Actual | Result | Evidence |
| --- | --- | --- | --- | --- |
| Create due 100 | Expense/payable 100, no cash | Exact | PASS | `LD-0001` journal |
| Create partner advance 40 | Advance/partner payable 40 | Exact after manual normalized-account fixture | PARTIAL | `LAV-0001`; account mapping defect |
| Apply 30 | Due -30, advance -30, no cash/expense/partner change | Exact | PASS | application row/journal |
| Pay partner 50 | Due -50, partner/account +50, no extra expense | Canonical exact | PASS | `LPV-0001` |
| Mixed remaining | 20 | 20 | PASS | UI/DB |
| Repeated payment void | One operational/journal restoration | One reversal voucher, second response idempotent | PASS | `LPV-0002` |
| Concurrent payment void | One inverse | Pass in integration suite | PASS | automated |
| Reverse application twice | Restore due/advance once | Exact | PASS | application REVERSED |
| Void advance twice | Partner funding/advance reverse once | Exact | PASS | `LAR-0001` |
| Void due twice | Expense/payable reverse once | Exact | PASS | DB/journal |
| Layered reversal-of-reversal | Never select an inverse | 0 reversal-of-reversal rows | PASS | 8 unique reversed originals |
| Partial advance recovery 10/25 | Outstanding 15 | 15 | PASS | `LAR-0002` |
| Recovery 30/15 | Disabled/rejected | Confirm disabled | PASS | Browser |
| Delete unused advance | No current effect; retain audit trail | All canonical rows hard-deleted | FAIL | `LAV-0003` absent |
| Hold/refresh | Remain ON_HOLD | DB ON_HOLD, UI Unpaid | FAIL | Browser/DB |
| Same-day advance pool | Eligible on local due date | Excluded as posted after date | FAIL | API pool reason |
| Account ledger vs position | Both 90 | Ledger 90, position 40 | FAIL | Browser |
| Advance report | 40 paid/30 applied/10 open | 0/0/0 | FAIL | Browser |
| Expense recognition | 100 once | Report 100; Accounts visibility 0 | PARTIAL | two consumers disagree |
| Viewer mutation | Disabled and server denied | UI disabled; tenant/permission suite denies | PASS | Browser/API |
| Farm/season stale response | Old rows cleared/discarded | Source-contract passes | PASS | 11 web tests |
| Offline ambiguous response | Exactly once | Not executable with available browser controls | NOT TESTED | blocker recorded |

## 5. Financial reconciliation

Principal partner-funded mixed flow:

| Metric | Before | After action | After payment reversal | After full layered reversal | Expected final | Actual final | Result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Labour due | 0 | 20 | 70 | 0 (due voided) | 0 | 0 | PASS |
| Advance paid | 0 | 40 | 40 | 0 (advance voided) | 0 | 0 | PASS |
| Advance applied | 0 | 30 | 30 | 0 | 0 | 0 | PASS |
| Outstanding advance | 0 | 10 | 10 | 0 | 0 | 0 | PASS |
| Direct payment | 0 | 50 | 0 | 0 | 0 | 0 | PASS |
| Partner account movement | 0 | 90 | 40 | 0 | 0 | 0 | PASS |
| Farm Owes Partner | 0 | 90 | 40 | 0 | 0 | 0 | PASS (canonical DB) |
| Wage expense | 0 | 100 | 100 | 0 | 0 | 0 | PASS |
| LABOUR_PAYABLE journal | 0 | -20 | -70 | 0 | 0 | 0 | PASS |
| LABOUR_ADVANCE journal | 0 | 10 | 10 | 0 | 0 | 0 | PASS |
| PARTNER_PAYABLE journal | 0 | -90 | -40 | 0 | 0 | 0 | PASS |

The final aggregate database also contained the intentionally separate active group due (50) and partially recovered cash advance (15), so its final scoped ledger was: `LABOUR_EXPENSE +50`, `LABOUR_PAYABLE -50`, `LABOUR_ADVANCE +15`, `CASH_CONTROL -15`, `PARTNER_PAYABLE 0`. That is not residue from the layered reversal.

Original/reversal evidence for the complete fixture: 22 journal rows; 8 reversal rows; 8 distinct original rows reversed; 0 reversal rows pointing to another reversal. Account transactions were three credits totaling 100 and three debits totaling 115; the -15 net is exactly the separate cash advance after a 10 recovery.

## 6. Cross-module consistency

State immediately after due 100 + partner advance 40 + application 30 + partner payment 50:

| Transaction/consumer | Expected | Actual | Difference | Result |
| --- | ---: | ---: | ---: | --- |
| Labour Payments remaining due | 20 | 20 | 0 | PASS |
| Canonical journal wage expense | 100 | 100 | 0 | PASS |
| Canonical journal advance | 10 | 10 | 0 | PASS |
| Canonical journal partner payable | 90 | 90 | 0 | PASS |
| Accounts top balance | 90 | 90 | 0 | PASS |
| Account detailed running balance | 90 | 90 | 0 | PASS |
| Accounts “Direct Expenses Paid” | 90 | 40 | -50 | FAIL |
| Accounts “Farm Owes Partner reconciliation” | 90 | 40 | -50 | FAIL |
| Partner Position Farm Owes Partner | 90 | 40 | -50 | FAIL |
| Partner ledger running balance | 90 | 90 | 0 | PASS |
| Partner Position outstanding advance | 10 | 40 | +30 | FAIL |
| Labour ledger remaining payable | 20 | 20 | 0 | PASS |
| Labour ledger advance-paid display | 40 | 0 on event row | -40 | FAIL |
| Expense report | 100 | 100 | 0 | PASS |
| Accounts expense visibility | 100 | 0 | -100 | FAIL |
| Advance report outstanding | 10 | 0 | -10 | FAIL |
| Activity | 4 active lifecycle events | 4 with correct statuses | 0 | PASS |
| Reconciliation | true for valid fixture | true; all 8 groups passed | — | PASS |

## 7. Confirmed defects

### LP-CFA-01 — P1 — UI-created accounts cannot fund canonical labour vouchers

- Symptom/reproduction: create cash, bank, or partner account in Accounts; open Record advance; select it; submit. UI reports “Payment account is not mapped. Please repair imported accounts.”
- Expected: a newly created account is immediately a valid canonical payment account.
- Actual/impact: financial posting is blocked. The account exists only in `operational_records`/IndexedDB while the API resolves UUIDs only against `accounts.id`.
- Root cause: account creation remains legacy/offline-first, while `resolveCanonicalPaymentAccountId` (`api/src/lib/labour-wage-settlements.ts:660`) treats a UUID as a normalized `accounts.id` and does not fall back to the operational UUID/old ID.
- UI/API/DB: `web/src/pages/ModulePage.tsx` account creation; `POST /labour-payments/advances` at route 2097; `accounts`, `operational_records`.
- Existing-data risk: every workspace with accounts created only through the legacy operational path may be unable to post canonical labour money.
- Recommended fix/test: atomically normalize account creation or maintain a stable mapping; regression test a UI-created account through all labour voucher sources.

### LP-CFA-02 — P1 — Partner Position and Accounts breakdown omit canonical direct payments

- Reproduction: partner advance 40; due 100; apply 30; partner direct payment 50; open Accounts and Partner Position.
- Expected: Farm Owes Partner 90, outstanding labour advance 10, partner ledger 90.
- Actual: account card/ledger 90, but breakdown and Partner Position report 40; outstanding advance 40.
- Impact: partner liability and labour receivable are materially misstated.
- Root cause: page-specific legacy calculators are merged conditionally with the canonical read model. `Reports.tsx:1326–1328` and `ModulePage.tsx:4110–4126` use different bases; the report's legacy account mapping/coverage prevents canonical position/advance application values from replacing the legacy values.
- API/DB: canonical endpoint at route 2803 was correct; `account_transactions`, `labour_payment_vouchers`, `labour_advance_applications` were correct.
- Existing-data risk: canonical partner-funded payments/applications can already be omitted from these screens.
- Recommended fix/test: consume one canonical per-account position and ledger, with stable source-ID legacy exclusion; assert position equals ledger after advance, apply, pay, and each reversal.

### LP-CFA-03 — P1 — Advance Report drops canonical-only advances

- Reproduction: post `LAV-0001` 40 and apply 30; open Advance Report.
- Expected: total 40, applied 30, outstanding 10.
- Actual: zero totals and no record.
- Impact: operational users cannot rely on the report for recovery balances.
- Root cause: `Reports.tsx:1097–1108` starts from legacy `advanceRows` and only looks up canonical positions for those rows. A canonical-only voucher cannot enter `filteredCanonicalAdvancePositions`; `canonicalAdvanceCoverageComplete` remains false.
- API/DB: canonical read model contained the position; tables were correct.
- Existing-data risk: all new canonical advances without a legacy twin may be missing.
- Recommended fix/test: render canonical positions as primary rows and merge legacy only where no stable replacement ID exists.

### LP-CFA-04 — P1 — Accounts expense visibility disagrees with Expense Report

- Reproduction: create due 100 without paying; compare Accounts expense visibility and Expenditures.
- Expected: both show recognized labour expense 100.
- Actual: Expenditures 100; Accounts visibility cards 0.
- Impact: conflicting expense totals across financial surfaces.
- Root cause: Expense Report uses `canonicalFinancials.data.expenses` (`Reports.tsx:1156`), while the Accounts visibility summary remains legacy-voucher based.
- Existing-data risk: canonical dues are omitted from Accounts expense summaries.
- Recommended fix/test: share the canonical expense aggregation and assert all consumers against journal `LABOUR_EXPENSE`.

### LP-CFA-05 — P2 — Hold status is stored but lost by the list UI

- Reproduction: Put `LD-0001` on hold; verify DB `ON_HOLD`; close/reload; filter On Hold.
- Expected: held due remains listed as On Hold and cannot settle.
- Actual: On Hold shows no row; All shows it as Unpaid with settlement actions.
- Root cause: hold route correctly sets `labour_dues.payment_status` (`labour-payments.ts:1806`), but due enrichment/list serialization calculates a financial position and exposes that calculated status instead of preserving `ON_HOLD`. `refreshLabourDuePaymentStatus` itself explicitly preserves hold (`api/src/lib/labour-payments.ts:365`), so frontend/API read behavior is inconsistent.
- Impact: users can unknowingly act on a held obligation.
- Existing-data risk: existing held rows can be hidden/misrepresented.
- Recommended fix/test: retain lifecycle status separately from calculated settlement status; browser test hold/refresh/filter/block/remove.

### LP-CFA-06 — P2 — Advance edit reports success without applying the date and rewrites posting history

- Reproduction: edit unused `LAV-0001` date to the prior day; save; inspect UI/DB/journal.
- Expected: date changes through an auditable correction, or editing is rejected.
- Actual: success toast, date unchanged; original journal identifiers/posting timestamps changed.
- Root cause: PATCH route 2289 reverses/reposts or rebuilds canonical effects while the form's date value did not propagate consistently.
- Impact: misleading success and mutable accounting history.
- Existing-data risk: edited advances may have posting timestamps/history inconsistent with the apparent data.
- Recommended fix/test: compare submitted values, return persisted record, and use reverse-and-replace rather than rewriting facts.

### LP-CFA-07 — P2 — Payment Voucher totals become negative after a normal reversal

- Reproduction: post partner direct payment 50, void it, refresh Payment Vouchers.
- Expected: active final payments 0 (history may show +50/-50).
- Actual: summary “Final labour payments -SAR 50”.
- Root cause: `WorkforcePayments.tsx:1033–1043` excludes the VOIDED original and subtracts the POSTED reversal, mixing a current-position convention with a history-net convention.
- Impact: misleading payment total; canonical journal/account is correct.
- Existing-data risk: every reversed payment can drive the card negative.
- Recommended fix/test: calculate active payment position from normalized original+inverse events or show gross/reversed/net separately.

### LP-CFA-08 — P2 — Same local-calendar-day advance is excluded by UTC date conversion

- Reproduction: in Riyadh on 2026-07-21, create advance dated 2026-07-21; open due dated 2026-07-21.
- Expected: advance is eligible on the due date.
- Actual: pool returned `postedAfterSettlementDate: 40` and eligible zero; serialized voucher dates showed prior-day UTC timestamps.
- Root cause: date-only values are converted through JavaScript `Date`/UTC instead of remaining date-only strings.
- Impact: valid advances cannot be applied at the local date boundary; reversal vouchers also display the previous day.
- Existing-data risk: records near timezone boundaries can be misclassified or misdated.
- Recommended fix/test: use date-only storage/serialization and Riyadh boundary tests for create, pool, reverse, report.

### LP-CFA-09 — P2 — Delete hard-removes posted advance audit history

- Reproduction: create unused bank `LAV-0003` 15, then Delete.
- Expected: no active effect while voucher number and correction history remain auditable.
- Actual: voucher, account transaction, and journal rows were removed; no orphan remained, but the posted fact disappeared.
- Root cause: DELETE route 2420 performs destructive canonical deletion for unused advances.
- Impact: historical voucher sequence/provenance cannot be reconstructed.
- Existing-data risk: previously deleted unused advances are not detectable from canonical tables.
- Recommended fix/test: void/reverse posted advances; reserve physical delete for drafts never posted.

### LP-CFA-10 — P2 — Canonical voucher register is incomplete

- Reproduction: compare six canonical voucher rows (`LAV`, `LAR`, `LPV`) to Payment Vouchers.
- Expected: all voucher types with source/account/allocation detail.
- Actual: payment/reversal rows shown; advances and recovery remain on a separate register and no unified detail exists.
- Root cause: route/UI nature filters and page descriptions narrowly define Payment Vouchers as new-money due payments.
- Impact: voucher history is fragmented; audit users miss source facts.
- Recommended fix/test: define register scope explicitly or provide a linked complete canonical history.

### LP-CFA-11 — P2 — Labour ledger amount semantics are incomplete

- Reproduction: open labourer detail after the mixed post.
- Expected: advance paid 40, application -30, payment -50, due +100, remaining 20.
- Actual: event rows exist and payable is 20, but ADVANCE PAYMENT displays SAR 0 and summary Payments 0.
- Root cause: `ModulePage.tsx:309–336` displays `labourDueEffect` for every event; advance cash is in `labourAdvanceEffect`.
- Impact: detailed labour history is financially confusing despite correct net payable.
- Recommended fix/test: typed event presentation selecting the relevant effect per event and reconciling summary to rows.

### LP-CFA-12 — P3 — Viewer mutation forms remain visible

- Reproduction: login viewer; open New Labour Due and due detail.
- Expected: mutation actions hidden or clearly read-only.
- Actual: full forms/inputs visible; final action disabled. Server enforcement passed.
- Impact: usability/permission ambiguity, not demonstrated unauthorized mutation.
- Recommended fix/test: read-only presentation and explicit permission text; retain server test.

## 8. Missing and unreachable functions

- Missing: due edit, due delete, group-funded advance creation, Payments Due labour/group selector and sort, Payment Voucher status/date/account filters, sorting, pagination, detail/source/allocation navigation, print, dedicated Labour Payment Report, and dedicated Settlement Report.
- Unreachable: application reversal has a working API but no current UI action. The old settlement history/report components survive as aliases or legacy source but redirect to the narrower current voucher/direct-due pages.
- Partially reachable: remove-hold exists in the UI conditionally, but the refreshed list no longer exposes a due as held.
- Obsolete/coexisting code: `web/src/pages/workspace/LabourAdvances.tsx` and legacy settlement/earnings routes remain alongside the current `WorkforcePayments.tsx` implementation. Legacy data calculators remain in Reports, Accounts, Dashboard, and partner pages, making canonical coverage conditional.

## 9. Browser evidence

- Desktop advance/account integration error: [01-advance-account-mapping-failure.png](docs/evidence/labour-payments-complete-function-audit-2026-07-21/01-advance-account-mapping-failure.png)
- Desktop mixed settlement, remaining SAR 20: [02-mixed-settlement.png](docs/evidence/labour-payments-complete-function-audit-2026-07-21/02-mixed-settlement.png)
- Desktop reversal voucher state: [03-layered-reversal-vouchers.png](docs/evidence/labour-payments-complete-function-audit-2026-07-21/03-layered-reversal-vouchers.png)
- Mobile Payments Due at 390×844: [04-mobile-payments-due.png](docs/evidence/labour-payments-complete-function-audit-2026-07-21/04-mobile-payments-due.png)
- Mobile group-due review: [05-mobile-due-review.png](docs/evidence/labour-payments-complete-function-audit-2026-07-21/05-mobile-due-review.png)

Actual UI actions included signup/login/logout, farm/labour/group/account creation, group-member move, all current non-excluded module tabs, new individual/group due, record/edit/delete/view advance, partial recovery, due review, pool selection, mixed settlement, hold, filters/search/toggles, Accounts detail, Partner Position, partner/labour ledger, Expenditures, Advance Report, Activity, refresh/re-login, and viewer disabled states. Native `window.prompt` prevented automation from confirming the Void buttons, so their rendered button click is recorded but the lifecycle execution used the real API endpoint against the same fixture.

No product browser-console exception caused the former blank page. Network/bootstrap succeeded on isolated ports. The initial canonical advance returned a controlled 400 mapping error; later financial requests returned 200/201. Mobile navigation, cards, filters, and dialog were usable; the horizontal tab strip clips at 390px but scrolls.

## 10. Automated evidence

Commands run:

```text
npm run db:init --workspace api
npm run test:integration --workspace api -- --test-concurrency=1
npx tsx --test "web/test/**/*.test.ts"
npm run check --workspace api
npm run check --workspace web
npm run build --workspace api
npm run build --workspace web
git diff --check
```

Results:

| Suite | Pass | Fail | Skip | Notes |
| --- | ---: | ---: | ---: | --- |
| API/source/PostgreSQL/tenant suite | 262 | 0 | 1 | 263 tests; migration-specific test skipped because `MIGRATION_TEST_DATABASE_URL` was intentionally unset |
| Web source-contract suite | 11 | 0 | 0 | Includes canonical downstream consumption and stale farm/season response contract |
| Type checks | 2 | 0 | 0 | API and web |
| Production builds | 2 | 0 | 0 | API and web; Vite emitted only chunk-size warning |
| Clean migrations | 41 | 0 | 0 | `0001` through `0041` on disposable PostgreSQL |
| Rendered browser | 2 viewports | — | — | Desktop plus 390×844 mobile; classifications above retain untested gaps |

These green results do not cover the page-specific accounting defects reproduced in the browser.

## 11. Production-data risk and read-only detection SQL

Existing production records may be affected by duplicate/invalid reversal relationships from older implementations, UI-only accounts, deleted audit history (not recoverable from canonical tables), report omissions, hold misrepresentation, or source/scope mismatch. Run read-only detection first. Substitute explicit parameters; do not omit scope predicates.

```sql
-- Required parameters: :workspace_id, :farm_id, :season_id

-- More than one reversal per original.
SELECT reversal_of AS original_journal_id, count(*) AS reversal_count
FROM labour_accounting_entries
WHERE workspace_id = :workspace_id AND farm_id = :farm_id AND season_id = :season_id
  AND reversal_of IS NOT NULL
GROUP BY reversal_of HAVING count(*) > 1;

-- Reversal of another reversal, or missing original.
SELECT r.id AS reversal_id, r.reversal_of, o.event_type AS original_event_type,
       o.reversal_of AS original_is_itself_reversal
FROM labour_accounting_entries r
LEFT JOIN labour_accounting_entries o ON o.id = r.reversal_of
WHERE r.workspace_id = :workspace_id AND r.farm_id = :farm_id AND r.season_id = :season_id
  AND r.reversal_of IS NOT NULL
  AND (o.id IS NULL OR o.reversal_of IS NOT NULL OR o.event_type = 'REVERSAL');

-- Original plus reversal not zero by code/dimension.
WITH pairs AS (
  SELECT o.id original_id, o.ledger_code, o.workspace_id, o.farm_id, o.season_id,
         o.due_id, o.voucher_id, o.advance_application_id,
         (o.debit - o.credit) + COALESCE(sum(r.debit - r.credit), 0) AS net
  FROM labour_accounting_entries o
  LEFT JOIN labour_accounting_entries r ON r.reversal_of = o.id
  WHERE o.workspace_id = :workspace_id AND o.farm_id = :farm_id AND o.season_id = :season_id
    AND o.reversal_of IS NULL
  GROUP BY o.id
)
SELECT * FROM pairs WHERE net <> 0 AND EXISTS
  (SELECT 1 FROM labour_accounting_entries r WHERE r.reversal_of = pairs.original_id);

-- Operationally void/reversed source retaining a current journal effect.
WITH effect AS (
  SELECT o.voucher_id,
         sum(o.debit-o.credit) + COALESCE(sum(r.debit-r.credit),0) AS net
  FROM labour_accounting_entries o
  LEFT JOIN labour_accounting_entries r ON r.reversal_of=o.id
  WHERE o.workspace_id=:workspace_id AND o.farm_id=:farm_id AND o.season_id=:season_id
    AND o.reversal_of IS NULL AND o.voucher_id IS NOT NULL
  GROUP BY o.voucher_id
)
SELECT v.id, v.voucher_number, v.status, e.net
FROM labour_payment_vouchers v JOIN effect e ON e.voucher_id=v.id
WHERE v.workspace_id=:workspace_id AND v.farm_id=:farm_id AND v.season_id=:season_id
  AND v.status='VOIDED' AND e.net<>0;

-- Due equation mismatch.
SELECT d.id, d.due_number, d.payment_status,
       (d.gross_amount+d.adjustment_amount-d.authorized_deductions
        -COALESCE(a.applied,0)-COALESCE(p.paid,0)) AS expected_remaining
FROM labour_dues d
LEFT JOIN (SELECT due_id,sum(amount) applied FROM labour_advance_applications
           WHERE status='ACTIVE' GROUP BY due_id) a ON a.due_id=d.id
LEFT JOIN (SELECT due_id,sum(amount) paid FROM labour_payment_allocations
           WHERE status='ACTIVE' GROUP BY due_id) p ON p.due_id=d.id
WHERE d.workspace_id=:workspace_id AND d.farm_id=:farm_id AND d.season_id=:season_id
  AND ((d.payment_status='VOIDED' AND (COALESCE(a.applied,0)<>0 OR COALESCE(p.paid,0)<>0))
       OR (d.payment_status='PAID' AND d.gross_amount+d.adjustment_amount-d.authorized_deductions-COALESCE(a.applied,0)-COALESCE(p.paid,0)<>0));

-- Advance equation mismatch/over-application.
SELECT v.id, v.voucher_number, v.payment_amount,
       COALESCE(a.applied,0) applied, COALESCE(r.recovered,0) recovered,
       v.payment_amount-COALESCE(a.applied,0)-COALESCE(r.recovered,0) outstanding
FROM labour_payment_vouchers v
LEFT JOIN (SELECT advance_voucher_id,sum(amount) applied FROM labour_advance_applications
           WHERE status='ACTIVE' GROUP BY advance_voucher_id) a ON a.advance_voucher_id=v.id
LEFT JOIN (SELECT related_advance_voucher_id,sum(payment_amount) recovered FROM labour_payment_vouchers
           WHERE nature='REFUND_RECOVERY' AND status='POSTED' GROUP BY related_advance_voucher_id) r
  ON r.related_advance_voucher_id=v.id
WHERE v.workspace_id=:workspace_id AND v.farm_id=:farm_id AND v.season_id=:season_id
  AND v.nature='ADVANCE'
  AND (v.payment_amount-COALESCE(a.applied,0)-COALESCE(r.recovered,0)<0
       OR (v.status='VOIDED' AND COALESCE(a.applied,0)<>0));

-- Posted canonical voucher missing/wrong account transaction.
SELECT v.id, v.voucher_number, v.payment_account_id, v.account_transaction_id,
       t.account_id, t.amount, t.type
FROM labour_payment_vouchers v
LEFT JOIN account_transactions t ON t.id=v.account_transaction_id
WHERE v.workspace_id=:workspace_id AND v.farm_id=:farm_id AND v.season_id=:season_id
  AND NOT v.legacy AND v.status='POSTED'
  AND (t.id IS NULL OR t.reference_id<>v.id OR t.account_id<>v.payment_account_id
       OR t.amount<>v.payment_amount);

-- Cross-scope source/journal mismatch.
SELECT j.id journal_id, j.entry_key, j.workspace_id, j.farm_id, j.season_id,
       COALESCE(v.workspace_id,d.workspace_id,a.workspace_id) source_workspace_id,
       COALESCE(v.farm_id,d.farm_id) source_farm_id,
       COALESCE(v.season_id,d.season_id) source_season_id
FROM labour_accounting_entries j
LEFT JOIN labour_payment_vouchers v ON v.id=j.voucher_id
LEFT JOIN labour_dues d ON d.id=j.due_id
LEFT JOIN labour_advance_applications a ON a.id=j.advance_application_id
WHERE j.workspace_id=:workspace_id AND j.farm_id=:farm_id AND j.season_id=:season_id
  AND (COALESCE(v.workspace_id,d.workspace_id,a.workspace_id)<>j.workspace_id
       OR COALESCE(v.farm_id,d.farm_id)<>j.farm_id
       OR COALESCE(v.season_id,d.season_id)<>j.season_id);

-- UI-created operational account without normalized account mapping.
SELECT o.id, o.client_record_id, o.farm_id, o.season_id,
       o.payload->>'name' account_name
FROM operational_records o
LEFT JOIN accounts a ON a.id=o.client_record_id OR a.old_android_id=o.payload->>'oldAndroidId'
WHERE o.workspace_id=:workspace_id AND o.farm_id=:farm_id AND o.season_id=:season_id
  AND o.entity_type='account' AND o.deleted_at IS NULL AND a.id IS NULL;
```

No destructive repair SQL is supplied. If results are found, preserve the original source and journal, add an explicit corrective journal linked to the original, retain voucher numbering/reversal relationships, and rebuild reports from the canonical read model.

## 12. Final answers

No, every function was not individually executed. The precise classifications are in the 100-row master table: 51 PASS, 7 PARTIAL, 18 FAIL, 9 MISSING, 2 UNREACHABLE, and 13 NOT TESTED. (The counts include navigation/read-only controls as independent functions and exclude the instructed-out area.)

The functions proven correct include canonical due recognition, mixed posting, advance application, payment/application/advance/due reversals, idempotent exact journal inversion, account ledger movement, expense report recognition, activity state, current farm/season query contract, tenant isolation, and the tested mobile layout. Partially correct functions include viewer presentation, group/member flows covered only by integration tests, removal of hold, labour ledger presentation, dependency matrices, and retry behavior. Broken functions are the UI-account mapping, hold persistence in reads, advance edit/history, destructive delete history, same-day eligibility, Payment Voucher totals/date/completeness, Accounts breakdown/expense visibility, Partner Position, partner-position equality, labour event amount presentation, and Advance Report. Missing/unreachable and untested functions are enumerated in sections 3 and 8 with their exact blockers.

Therefore the evidence does **not** prove that every create/edit/delete/hold/apply/pay/refund/void/reverse action remains consistent in every downstream consumer. It proves the normalized posting/reversal core for the principal controlled scenario, and simultaneously proves that several live consumers and lifecycle surfaces do not reconcile with that core.
