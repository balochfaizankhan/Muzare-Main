# Muzare Release QA Checklist

Use this checklist for a focused manual release pass after the latest smoke-audit findings. This is not a redesign or exploratory audit; it is a release gate for the highest-risk workflows.

## Ship / Hold Decision

Ship only if all of the following sections pass:

- Accounting reconciliation
- Attendance
- Advances
- Expenses
- Sales
- Reports
- Translation / RTL
- Team / Permissions

Hold the release if any critical business flow, reconciliation check, permission rule, or translation/RTL check fails.

## Tester Notes

- Record the environment used: workspace, farm, season, user role, device, browser.
- Use the same date range and filters when comparing summaries to drill-downs.
- For financial checks, always verify the summary, the ledger detail, and the source transaction.
- For mobile checks, test at `320px`, `360px`, `390px`, and `430px` widths where possible.

---

## Accounting Reconciliation

### [ ] Account card balance matches ledger balance
- **Steps**
  1. Open Accounts.
  2. Pick one account with activity.
  3. Note the account card balance.
  4. Open the account ledger / transaction detail.
  5. Compare the ending ledger balance with the card balance.
- **Expected result**
  - The ending ledger balance exactly matches the account card balance.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - Record account name and values checked.

### [ ] Grouped ledger totals reconcile to account balance
- **Steps**
  1. In the same account ledger, expand transaction groups:
     - Expenses
     - Advances
     - Settlements
     - Income / Funds / Sales
     - Other
  2. Sum the visible group totals using the ledger’s sign conventions.
  3. Compare with the displayed account balance.
- **Expected result**
  - Group totals reconcile to the displayed account balance.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - Note any group with missing or suspicious transactions.

### [ ] Expense totals reconcile
- **Steps**
  1. Open Expenses.
  2. Note Total Expenses with no extra filters.
  3. Compare with the sum of visible expense records for the same context.
  4. Apply date and account filters.
  5. Verify the filtered total again.
- **Expected result**
  - Total Expenses always matches the filtered record set.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - Include filters used.

### [ ] Labour advance totals reconcile
- **Steps**
  1. Open Advances.
  2. Note the summary total for the selected date range.
  3. Compare with the visible advance history/log.
  4. Pick one payment account and confirm the account ledger reflects the same outflow.
- **Expected result**
  - Advance summaries match the log and the paying account reflects the same amount.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - Record the account checked.

### [ ] Partner settlement effects reconcile
- **Steps**
  1. Open Partner Ledger / Partner Position.
  2. Pick a partner with settlement activity.
  3. Note settlements sent/received and final balance.
  4. Open the linked account detail for both counterparties.
  5. Verify the settlement appears in both ledgers with opposite effects.
- **Expected result**
  - Settlement effects match in partner position and account ledgers.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - Record both partner/account names.

### [ ] Sales totals reconcile
- **Steps**
  1. Open Sales.
  2. Note total sales for the current filters.
  3. Compare with visible sales records.
  4. Open the payment account for one sale and verify the income entry appears.
- **Expected result**
  - Sales totals match the visible records and linked account ledger entries.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - Mention whether sale is dispatch-linked or direct farm sale.

---

## Partner Ledger

### [ ] Partner summary cards appear once only
- **Steps**
  1. Open Partner Ledger detail for one partner/account.
  2. Review the top summary section.
- **Expected result**
  - Summary items are shown once only, without repeated cards.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - Note any duplicated labels.

### [ ] Direct Expenses Paid card includes voucher and labour advance breakdown
- **Steps**
  1. Open a partner detail with direct expense activity.
  2. Inspect the Direct Expenses Paid card.
- **Expected result**
  - The card shows one total and a small breakdown for Voucher Expenses and Labour Advances.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - Record displayed values.

### [ ] Partner reconciliation formula matches displayed balance
- **Steps**
  1. In partner detail, review the reconciliation panel.
  2. Manually check:
     - Capital Injected
     - Direct Expenses Paid
     - Business Funds Given
     - Business Funds Received
     - Money Paid Back
     - Adjustments
  3. Compare the computed result to Farm Owes Partner.
- **Expected result**
  - The final formula matches the displayed Farm Owes Partner amount.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - If not, note the mismatch amount.

### [ ] Partner transaction groups expand independently
- **Steps**
  1. Expand one transaction group.
  2. Collapse it.
  3. Expand another group.
  4. Verify one group’s state does not unexpectedly affect others.
- **Expected result**
  - Each group has independent expand/collapse behavior.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - Mention any group with missing totals or broken rows.

---

## Attendance

### [ ] Mark Attendance opens the attendance flow directly
- **Steps**
  1. Use the Attendance navigation entry or dashboard attendance action.
  2. Confirm the attendance marking screen opens directly.
- **Expected result**
  - Attendance opens directly and does not land on the labour register first unless intentionally routed there.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - Record the route or entry path used.

### [ ] Previous-day status is correct for the same labourer
- **Steps**
  1. Choose a date where at least two labourers have different previous-day statuses.
  2. Open Mark Attendance for the next day.
  3. Compare each labour card’s previous-day indicator with the actual prior-day records.
- **Expected result**
  - Each labour card shows the previous-day status for the same labour ID and the immediately previous calendar day only.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - Record labour names, selected date, and previous date checked.

### [ ] Group, search, and date filters preserve correct attendance context
- **Steps**
  1. Apply a group filter.
  2. Search for a labourer by name.
  3. Change the attendance date.
  4. Compare visible statuses before and after filtering.
- **Expected result**
  - Filtering changes visibility only; it does not scramble statuses or previous-day indicators.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - Note any mismatch after filtering.

### [ ] Attendance screen remains usable on mobile
- **Steps**
  1. Test the attendance screen at `320px`, `360px`, `390px`, and `430px`.
  2. Open filters and any modal/dialog.
  3. Scroll to the bottom of the labour list.
- **Expected result**
  - No clipped footer, hidden save/close control, or blocked scrolling.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - Note viewport and issue if found.

---

## Advances

### [ ] Record Advance page supports rapid entry
- **Steps**
  1. Open Advances.
  2. Enter one valid advance and save.
  3. Observe whether the form stays open and resets appropriate fields only.
- **Expected result**
  - The form stays open after save, clears labour/amount/notes, and keeps date/group/account as intended.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - Note which fields persisted and which cleared.

### [ ] Labour autocomplete returns useful ranked results
- **Steps**
  1. In Labour search, type:
     - first-letter query
     - first-name prefix
     - surname query
  2. Review suggestion ranking and result count.
- **Expected result**
  - Best matches appear first, suggestions are readable, and the dropdown stays compact.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - Record example queries and results.

### [ ] Group filter limits labour suggestions correctly
- **Steps**
  1. Select a labour group.
  2. Search for labour.
  3. Clear the group and search again.
- **Expected result**
  - Group filter restricts suggestions correctly; All Groups searches across all active labour.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - Mention affected group name.

### [ ] Advance history and account impact update after save
- **Steps**
  1. Record an advance.
  2. Confirm the new record appears in advance history/log.
  3. Open the selected payment account and verify the outflow appears.
- **Expected result**
  - Advance history updates and the linked payment account reflects the transaction.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - Record the advance amount.

---

## Expenses

### [ ] New expense voucher creates successfully
- **Steps**
  1. Open Expenses.
  2. Create a new expense voucher with valid data.
  3. Save it and confirm it appears in recent records.
- **Expected result**
  - The voucher is created and visible in history without requiring a page reload.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - Record voucher number.

### [ ] Editing an expense updates totals and account balance
- **Steps**
  1. Open an existing expense.
  2. Edit amount and/or account.
  3. Save changes.
  4. Recheck totals and linked account ledger.
- **Expected result**
  - Expense totals and account balances update consistently after edit.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - Record old and new values.

### [ ] Expense filters and summary cards stay aligned
- **Steps**
  1. Apply search, date, category, subcategory, and account filters one by one.
  2. Compare summary totals to the visible result set.
  3. Use Clear Filters and confirm default totals return.
- **Expected result**
  - Totals, category cards, and row list all reflect the same filtered dataset.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - Record filter combination tested.

### [ ] Expense filter UI is usable on mobile
- **Steps**
  1. Open Expenses at narrow widths.
  2. Check search, From Date, To Date, Category, Subcategory, and Account controls.
- **Expected result**
  - No blank date boxes, clipped labels, overlapping controls, or unusable clear buttons.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - Note viewport and control affected.

---

## Sales

### [ ] Create sale from dispatch
- **Steps**
  1. Open Sales.
  2. Choose `From Dispatch`.
  3. Select a dispatch item with remaining quantity.
  4. Record a sale and save.
- **Expected result**
  - Sale is created, dispatch remaining quantity is reduced correctly, and sale appears in history/reports.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - Record dispatch reference and quantity sold.

### [ ] Create direct farm sale without dispatch
- **Steps**
  1. Open Sales.
  2. Choose `Direct Farm Sale`.
  3. Enter product, quantity, rate, payment account, and save.
- **Expected result**
  - Sale is created without requiring a dispatch selection.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - Record product and amount.

### [ ] Edit and delete/cancel sales
- **Steps**
  1. Open a recent sale.
  2. Edit one dispatch-linked sale and one direct sale.
  3. Delete/cancel one sale with confirmation.
  4. Verify account impact updates accordingly.
- **Expected result**
  - Edit opens prefilled data, save updates correctly, and delete/cancel reverses or deactivates accounting safely.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - Record sale types tested.

### [ ] Sales recent records UI is clean on mobile
- **Steps**
  1. Open Sales recent records on mobile widths.
  2. Review date, badge, buyer/product, amount, and action buttons.
- **Expected result**
  - Records appear as readable cards/rows with no raw browser-button styling, clipping, or overflow.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - Mention viewport and issue if found.

---

## Dispatch

### [ ] Manage Vehicles dialog works end-to-end
- **Steps**
  1. Open Dispatch.
  2. Open Manage Vehicles.
  3. Add, edit, disable/enable a vehicle.
  4. Close and reopen the dialog.
- **Expected result**
  - Vehicle CRUD works, the dialog is scrollable, and footer actions remain accessible.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - Record vehicle name tested.

### [ ] Manage Date Types dialog works end-to-end
- **Steps**
  1. Open Manage Types.
  2. Add a type, edit it, toggle active/inactive.
  3. Verify inactive types do not appear in new dispatch entry.
- **Expected result**
  - Date type CRUD behaves correctly and the dialog remains mobile-friendly.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - Record type name tested.

### [ ] Create dispatch with multiple line items
- **Steps**
  1. Select a vehicle.
  2. Add multiple date-type/carton lines.
  3. Save the dispatch.
  4. Review dispatch list/report breakdown.
- **Expected result**
  - One dispatch can store multiple line items and total cartons are calculated correctly.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - Record expected total cartons.

---

## Reports

### [ ] Attendance report uses labour group, not account filter
- **Steps**
  1. Open Attendance Reports.
  2. Review visible filters.
  3. Verify labour group filtering works.
- **Expected result**
  - Attendance reports do not show irrelevant financial account filters; labour group is available.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - Note any irrelevant filter still present.

### [ ] Advances summary and log remain separate
- **Steps**
  1. Open Advances Reports.
  2. Switch between Summary and Log.
  3. Use print/export for each view.
- **Expected result**
  - Summary actions include summary content only; log actions include log content only.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - Record any mixed output.

### [ ] Expense summary and log remain separate
- **Steps**
  1. Open Expense Reports.
  2. Switch between Summary and Log.
  3. Use print/export for each view.
- **Expected result**
  - Summary and log outputs remain separate and correctly labeled.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - Record any mixed output.

### [ ] Report date filters are clear and usable
- **Steps**
  1. Open several report types.
  2. Check From Date / To Date placeholders.
  3. Use quick ranges: Today, This Week, This Month, Clear.
- **Expected result**
  - Date filters clearly indicate purpose and update the report as expected.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - Note any report missing quick ranges or placeholders.

### [ ] Mobile reports avoid giant unreadable tables
- **Steps**
  1. Open summary and log reports at mobile widths.
  2. Check whether reports render as cards when appropriate.
- **Expected result**
  - Mobile avoids unusable wide tables for primary workflows, except where intentionally print/export only.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - Record report name and viewport.

---

## Translation / RTL

### [ ] Language switch updates all visible UI text immediately
- **Steps**
  1. Switch from English to Arabic.
  2. Switch from Arabic to Urdu.
  3. Switch back to English.
  4. Review sidebar, headers, filters, buttons, dialogs, and empty states.
- **Expected result**
  - UI text updates immediately without mixed-language remnants.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - List any untranslated labels.

### [ ] User-entered data does not translate
- **Steps**
  1. Open records with user-entered names/descriptions.
  2. Change languages.
  3. Compare display values before and after.
- **Expected result**
  - User-entered names, notes, descriptions, and identifiers stay unchanged.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - Record affected field if changed unexpectedly.

### [ ] RTL layout remains usable in Arabic and Urdu
- **Steps**
  1. Switch to Arabic and Urdu.
  2. Open dashboard, reports, a form-heavy page, and a modal.
  3. Check alignment, icon placement, and text wrapping.
- **Expected result**
  - RTL layout is aligned, readable, and free of overlaps/clipping.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - Mention page and component if broken.

---

## Mobile Responsiveness

### [ ] No critical dialog is clipped or unscrollable
- **Steps**
  1. Open high-risk dialogs:
     - Labour detail / edit
     - Attendance
     - Advance filters/forms
     - Team permission editor
     - Dispatch management dialogs
  2. Scroll each dialog fully.
  3. Check footer actions.
- **Expected result**
  - All dialogs are scrollable and footer actions remain reachable.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - Record dialog name and viewport if broken.

### [ ] No page content is hidden behind mobile navigation
- **Steps**
  1. Open dashboard and long list pages on mobile.
  2. Scroll to the bottom.
  3. Check final cards, rows, and buttons.
- **Expected result**
  - Bottom navigation does not cover actionable content.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - Record affected page.

### [ ] Search, filter, and action rows remain readable
- **Steps**
  1. Open Workforce, Attendance, Advances, Expenses, and Reports on mobile widths.
  2. Inspect top filter/action rows.
- **Expected result**
  - No overlapping inputs, clipped labels, or inaccessible buttons.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - Note module and viewport.

---

## Team / Permissions

### [ ] Team page shows all expected members
- **Steps**
  1. Open Workspace Team / Users.
  2. Compare the list with known workspace members from admin/workspace records.
- **Expected result**
  - All active members with access to the workspace appear correctly.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - Record missing or duplicated members.

### [ ] Edit Member Access modal scrolls fully
- **Steps**
  1. Open Edit Member Access for one user.
  2. Scroll to the bottom of permissions.
  3. Verify Save and Cancel are always reachable.
- **Expected result**
  - The modal body scrolls independently, header/footer remain visible, and all permission sections are reachable.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - Record viewport and any clipped section.

### [ ] Role restrictions are enforced
- **Steps**
  1. Test with owner and one restricted role.
  2. Attempt a protected action such as permission editing, delete, or approval-only workflow.
- **Expected result**
  - Restricted users cannot perform owner-only actions; UI and server behavior both enforce restrictions.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - Record role tested and blocked action.

---

## Hidden Modules

### [ ] Inventory stays hidden from daily navigation
- **Steps**
  1. Review sidebar, dashboard module cards, mobile navigation, and quick-entry surfaces.
  2. Look for Inventory.
- **Expected result**
  - Inventory is not shown in normal operational navigation.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - Mention where it appeared if visible.

### [ ] Inventory direct route is disabled gracefully
- **Steps**
  1. Manually open `/inventory`.
  2. Observe the result.
- **Expected result**
  - A disabled message appears with a safe way back to the dashboard.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - Record exact message shown.

### [ ] Farm Map stays hidden from daily navigation
- **Steps**
  1. Review sidebar, dashboard, and related operations menus.
  2. Look for Farm Map / Operations Map.
- **Expected result**
  - Farm Map is hidden from daily operational UI when disabled.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - Mention where it appeared if visible.

---

## Workspace / Farm / Season Isolation

### [ ] Workspace switch does not leak data
- **Steps**
  1. Open one workspace and note visible records in two modules.
  2. Switch to another workspace.
  3. Recheck the same modules.
- **Expected result**
  - Records are replaced by the new workspace context; no previous-workspace data remains visible.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - Record modules checked.

### [ ] Farm switch does not leak data
- **Steps**
  1. Within one workspace, switch farm.
  2. Check dashboard, attendance, expenses, and dispatch/sales if applicable.
- **Expected result**
  - Data updates to the selected farm only.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - Record farm names used.

### [ ] Season switch does not leak data
- **Steps**
  1. Switch season within the same farm.
  2. Review expenses, reports, sales, and partner/account summaries.
- **Expected result**
  - Only selected-season data is shown where season scoping applies.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - Record season names/years used.

### [ ] Role-based access respects workspace context
- **Steps**
  1. Login as a restricted role in one workspace.
  2. Attempt owner-only or manager-only actions.
  3. Repeat in another workspace if available.
- **Expected result**
  - Permissions are enforced per workspace membership and do not leak across contexts.
- **Pass/Fail**
  - [ ] Pass
  - [ ] Fail
- **Notes**
  - Record roles and blocked actions.

---

## Final Release Decision

- [ ] **SHIP**: All required gate sections passed.
- [ ] **HOLD**: One or more required gate sections failed.

### Release notes
- **Blocking failures**
  - 
- **Non-blocking observations**
  - 
- **Tester name / date**
  - 
