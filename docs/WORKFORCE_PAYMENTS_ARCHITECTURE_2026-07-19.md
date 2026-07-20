# Workforce Payments architecture and migration contract

Date: 19 July 2026  
Branch: `dev`

This document records the repository audit completed before the Workforce Payments redesign. It is the implementation contract for the normalized labour-finance model. Existing attendance wage formulas, labour-work inclusion, group selection, settlement overlap protection, and source-record locking remain authoritative.

## Current behavior

### Settlement calculation and posting

- `api/src/lib/labour-wage-settlements.ts` is the canonical attendance and labour-work calculator. It resolves dated wage rates, selected individual/group scope, attendance rows, pending labour earnings, outstanding advances, and settlement totals.
- `api/src/routes/labour-wage-settlements.ts` recalculates the preview inside a farm/season advisory-locked database transaction, allocates `LW-` references, links attendance and labour-work source rows, and records normalized advance absorption rows.
- A settlement currently accepts `paidAmount` and a payment account during creation. `repairPostedSettlementAccounting` creates the cash/bank/partner account transaction immediately when `paidAmount > 0`.
- Settlement `status = posted` currently means both an approved calculation and an active financial result. Payment state is embedded in `paidAmount`, `balanceAfterPayment`, and `payableBalance`; it is not an independent lifecycle.
- A settlement can only carry one embedded payment amount/account. Multiple partial payments are not normalized.

### Advances

- Advances are `operational_records` JSON rows with `entity_type = advance` and a browser IndexedDB mirror.
- An advance stores labourer, date, amount, and account. Group identity is copied from the labourer where available.
- The Accounts and Partner views reconstruct advance cash effects from operational rows in the browser. A canonical Labour Payment Voucher does not exist.
- `labour_wage_settlement_advance_allocations` safely records partial advance absorption by settlement. Legacy settlements without allocation rows are reconstructed where possible and ambiguous consumption blocks new posting.
- Advance edit/delete is still exposed through the generic operational-sync path. Remaining balance and refund state are derived rather than persisted as a canonical lifecycle.

### Direct payments

- `LabourPayment` is a minimal offline operational type containing labourer, date, amount, method, and notes.
- Its previous form is not routed as an active payment workflow and does not require an account, voucher number, allocation, or server-side financial posting.
- It cannot represent unnamed labour, contractors, crews, group obligations, or a due separated from payment.

### Accounting, partner, reports, and sync

- Posted settlement cash creates an `account_transactions` row. Settlement expense/payable recognition is represented by settlement data and reports, not by a normalized due/payable table.
- Advance and voucher account activity is mostly composed from operational rows on the client. Partner liability correctly retains the full partner-funded advance even after labour-side advance application.
- Generic sync uses deterministic mutation IDs and rejects stale workspace/farm/season payloads, but only settlement creation has a dedicated server idempotency lifecycle.
- Existing settlement voiding reverses linked account transactions, advance allocations, attendance links, and labour-work links. It does not yet order reversals against independent payment vouchers because those do not exist.

## Root integrity gaps

1. Approval/recognition and cash payment are coupled in settlement creation.
2. No normalized labour due/payable exists.
3. No canonical Labour Payment Voucher register exists for advances and final payments.
4. No normalized payment allocation supports multiple partial payments.
5. Payment state is stored as settlement totals instead of derived from active allocations.
6. Advance scope is primarily labourer-based and cannot safely represent unnamed crews or contractor/group ownership.
7. Generic operational rows allow financial state to be reconstructed differently by different screens.
8. Historical settlement cash and advances must be mapped, not replayed, or accounts will be duplicated.

## Target model

### Labour due

`labour_dues` is the authoritative obligation. It stores origin, source reference, recipient scope and immutable snapshots, work period, gross amount, authorized deductions, calculation/approval lifecycle, payment lifecycle, hold/void metadata, and farm/season context.

Settlement approval creates one due linked to the existing settlement operational record. A direct due is stored directly in this model. Creating a due never moves cash.

### Labour Payment Voucher

`labour_payment_vouchers` is the canonical money-movement record. Nature distinguishes advance, final payment, settlement balance payment, direct labour payment, refund/recovery, and reversal. Only `POSTED` vouchers affect accounts. Posted vouchers are immutable; correction requires void/reversal and replacement.

### Allocations

- `labour_payment_allocations` links posted final-payment vouchers to dues.
- `labour_advance_applications` links posted advance vouchers to dues without a new cash movement.
- Allocation/application rows are reversible, non-negative, and included in balances only while active.
- Due outstanding is always derived as gross minus active advance applications, active payment allocations, and authorized deductions.

### Labour accounting subledger

`labour_accounting_entries` records balanced, immutable debit/credit lines for due recognition, advance payment, advance application, due payment, advance refund, and reversal. Its ledger codes distinguish Labour Expense, Labour Payable, Labour Advance, Cash Control, and Partner Payable. The existing `account_transactions` table remains the authoritative selected-account cash/bank/partner movement ledger; the labour subledger supplies the missing economic classification and reconciliation boundary.

Database triggers lock and validate payment allocations, advance applications, and advance refunds so totals cannot exceed a voucher, due, or available advance even if a client bypasses UI validation.

### Scope

Every due and voucher receives a financial scope key built from exactly one supported owner: individual labourer, labour group, contractor/foreman snapshot, temporary crew reference, unregistered/manual recipient batch, or no-specific-recipient batch. Advance applications require matching scope keys.

Group dues and group advances belong to the group scope. A leader may be snapshotted as receiver/representative, but the transaction is posted once and is not reclassified as the leader's personal earning.

## Historical migration rules

The migration is additive and idempotent.

1. Every active historical `labourWageSettlement` receives one settlement-origin due, uniquely keyed by its operational source row.
2. Gross due comes from the immutable settlement gross/expense amount. Existing advance allocations are mapped as advance applications.
3. Existing settlement `paidAmount > 0` is mapped to one legacy Labour Payment Voucher and one payment allocation. Its existing `account_transactions` row is linked/reused; no new cash transaction is inserted.
4. A zero-cash settlement receives no payment voucher. Its outstanding status is derived from gross, mapped advance applications, and deductions.
5. Every historical active `advance` receives one `ADVANCE` voucher uniquely linked to its operational source row. No new account transaction is inserted during backfill because current ledgers already reflect the operational advance.
6. Existing voucher/reference values are preserved. Where an old record has no human voucher number, the canonical record is marked `LEGACY` and retains its source ID; an LPV number is assigned only as a registry identifier and never implies a new payment.
7. Deleted/voided/reversed source records map with the same inactive lifecycle and never contribute to balances.
8. Ambiguous legacy advance consumption is not guessed. It is marked for reconciliation and blocks allocation that could double-clear a balance.
9. Existing generic `labourPayment` rows are classified as legacy/unreconciled unless an account and recipient scope can be proven. They are never replayed into cash automatically.
10. Backfill uniqueness constraints make rerunning the migration safe and prevent duplicate source mapping.

## Posting transaction

Server posting runs in one database transaction with a farm/season financial advisory lock:

1. Validate session workspace/farm/season and role permission.
2. Lock and reload the due, selected advance vouchers, and account.
3. Recalculate outstanding and available advances from active normalized allocations.
4. Validate identical financial scope for every advance application.
5. Reserve the idempotency key and LPV number.
6. Insert the voucher and its allocations/applications.
7. Insert exactly one account transaction for an actual movement of money.
8. Recompute and persist due payment status.
9. Insert balanced labour-subledger lines for the economic event.
10. Write audit metadata and commit.

Retries with the same idempotency key return the existing voucher. A different request cannot allocate beyond a locked due or advance balance.

## Voiding order

- A payment voucher void reverses its account transaction and deactivates its payment allocation atomically, then recalculates the due.
- An advance voucher cannot be voided while active advance applications exist. Applications must be reversed first.
- A settlement/due cannot be voided while posted payment vouchers or active advance applications remain. Linked financial effects must be reversed first.
- Originals remain visible with void/reversal metadata.

## Rollout phases

1. Add normalized tables, constraints, backfill, and reconciliation flags.
2. Change settlement creation to create/expose a due and stop immediate cash posting.
3. Add due list/detail, direct-due creation, and transactional posting APIs.
4. Replace the Workforce Payments navigation with Payments Due, New Direct Due, Payment Vouchers, and Outstanding Advances.
5. Integrate normalized records into Accounts, Partner, labour/group history, and reports.
6. Run database-backed idempotency, accounting, group-scope, voiding, historical, and reconciliation tests before deployment.

## Compatibility boundary

- Existing attendance and wage calculations are reused, not copied.
- Existing settlements, advances, operational records, voucher references, account transactions, and audit history are retained.
- New code reads normalized records first and uses explicit legacy mapping only where the migration records a source link.
- No historical cash movement is replayed during migration.
