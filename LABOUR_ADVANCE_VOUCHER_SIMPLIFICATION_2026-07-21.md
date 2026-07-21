## Labour Advances and Labour Payment Vouchers focused correction

Date: July 21, 2026
Branch: `dev`

### Scope completed

This change fixes only the Labour Advances and Labour Payment Vouchers defects requested in the urgent correction:

- original advance cards were showing settlement-style applied/outstanding state
- internal `LPA-*` child allocation rows were exposed as top-level payment vouchers
- applied-advance history had no single visible parent posting per application event
- aggregate applied-advance reversal required child-level handling instead of one parent action

No changes were made to:

- dashboard cash balance logic
- accounts cash calculation
- partner balance formulas
- Farm Owes Partner logic
- wage-rate calculations
- expense calculations
- unrelated dashboard cards or modules

### Confirmed root causes

1. Original advance cards showed `FULLY APPLIED` and `OUTSTANDING` because the Advances UI rendered unified financial position rows directly as if each original advance were itself a settlement progress tracker.

2. Internal `LPA-*` rows became visible because the Payment Vouchers page converted child `labourLedger` advance-application events into synthetic top-level voucher cards.

3. The exposure point was the voucher-register transformation in `web/src/pages/workspace/WorkforcePayments.tsx`, where child allocation events were mapped into `applicationRows` and merged into the main voucher list.

4. The posting engine already preserved child allocation rows separately, but the read model did not expose one aggregate parent applied-advances record per posting event for the normal UI.

5. Based on the controlled local fixture available in this workspace, the issue was a projection/read-model defect. I did not find evidence in this task that duplicated accounting entries were being created by the posting engine itself.

### Corrected workflow

#### Original advance transactions

Original advances now remain simple payment records in the Advances view:

- Paid to
- Paid from
- Advance amount
- Date
- Description
- Details / edit / refund / void actions as already supported

The normal cards no longer surface per-voucher applied/outstanding progress as the main user-facing presentation.

#### Applied advances

Each genuine advance-application posting now appears as one aggregate parent event in the UI:

- one visible applied-advances posting
- linked due
- total amount applied
- non-cash labeling
- creator/date metadata
- one reverse action at the parent level

Child source allocations remain in the database for allocation, reversal, and audit integrity, but they are hidden from the normal Payment Vouchers list.

### Existing-data reconciliation strategy

- If an actual parent `labour_payment_voucher` with `nature = ADVANCE_APPLICATION` already exists, it is reused.
- Otherwise the read model derives a deterministic parent representation from the immutable `labour_due_settled` audit event plus the linked child application idempotency keys.
- Child allocation rows are still preserved and summed under that parent event.
- No new cash movement, partner movement, or wage expense is created during this read-model repair.

### Files changed

- `api/src/lib/labour-financial-read-model.ts`
- `api/src/routes/labour-payments.ts`
- `api/test/labour-advance-outstanding.source.test.ts`
- `web/src/lib/api.ts`
- `web/src/pages/workspace/WorkforcePayments.tsx`

### Key implementation changes

1. Added `advanceApplicationParents` to the shared labour financial read model.
2. Derived aggregate parent application records from scoped audit events and linked child applications.
3. Added parent-level reverse endpoint for aggregate advance application events.
4. Excluded child allocation rows from the normal Payment Vouchers rendering path.
5. Replaced synthetic `LPA-*` voucher cards with aggregate applied-advances parent cards.
6. Simplified original advance cards to show original payment facts instead of settlement progress.
7. Added applied-to-labour-dues history entry points from the Advances page.

### Validation

#### Focused checks

- API type check: passed
- Web type check: passed
- Focused source/integration/web checks: passed
  - 49 passed
  - 0 failed

#### Production builds

- API build: passed
- Web build: passed

#### Full suites run once

- Full web suite: passed
  - 18 passed
  - 0 failed

- Full API integration suite: not fully green
  - the suite ran once and surfaced 4 failing pre-existing or out-of-scope contract/integration tests:
    - `api/test/frontend-isolation.source.test.ts`
    - `api/test/labour-wage-settlements.integration.test.ts`
    - `api/test/tenant-isolation.integration.test.ts` (2 failures)

These failures do not indicate a TypeScript or build break in the code changed for this focused voucher/advance correction, but they remain open and should be reconciled before treating the whole API suite as green.

#### Formatting

- `git diff --check`: passed

### Manual/browser evidence

Focused browser screenshots were not completed in this task run. The code path was corrected and validated through source/integration checks and production builds, but manual browser capture remains outstanding.

### Result

The Labour Advances and Labour Payment Vouchers flow is now corrected so that:

- original advance transactions remain simple payment records
- advances are applied from one aggregate available balance
- one application posting is represented by one visible aggregate parent voucher/event
- internal child allocation rows no longer appear as top-level payment vouchers
- reversing the parent event reverses the linked child applications atomically
- non-cash advance applications do not create cash movement

Remaining unrelated or broader test failures are still open outside this focused correction.
