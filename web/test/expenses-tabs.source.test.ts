import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const modulePage = readFileSync(new URL("../src/pages/ModulePage.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const layout = readFileSync(new URL("../src/layouts/WorkspaceLayout.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("three distinct Expenses routes exist and all render the same page component (so ?recordId= deep links keep working)", () => {
  assert.match(app, /path="expenses"\s*element=\{routeElement\(<Expenses \/>/);
  assert.match(app, /path="expenses\/new"\s*element=\{routeElement\(<Expenses \/>/);
  assert.match(app, /path="expenses\/vouchers"\s*element=\{routeElement\(<Expenses \/>/);
  assert.match(app, /path="expenses\/summary"\s*element=\{routeElement\(<Expenses \/>/);
});

test("ExpensesModule derives its active tab purely from the URL, mirroring the WorkforcePayments view pattern, and only one view's content mounts at a time", () => {
  assert.match(modulePage, /type ExpensesView = "new" \| "vouchers" \| "summary";/);
  assert.match(modulePage, /const view: ExpensesView = location\.pathname\.endsWith\("\/new"\)/);
  assert.match(modulePage, /\{view === "new" && \(canCreateVouchers/);
  assert.match(modulePage, /\{view === "vouchers" && <>/);
  assert.match(modulePage, /\{view === "summary" && <>/);
});

test("the New Voucher form no longer has a voucher-level Notes / reference input field", () => {
  assert.doesNotMatch(modulePage, /<input value=\{notes\} placeholder=\{t\("expensesPage\.notesOptional"\)\}/);
  assert.doesNotMatch(modulePage, /expense-voucher-form__notes/);
});

test("the sticky Grand Total / Save Voucher bar only exists inside the New Voucher tab's form, never inside Vouchers/Summary", () => {
  const newTabStart = modulePage.indexOf('{view === "new" && (canCreateVouchers');
  const vouchersTabStart = modulePage.indexOf('{view === "vouchers" && <>');
  const summaryTabStart = modulePage.indexOf('{view === "summary" && <>');
  const stickyFooterIndex = modulePage.indexOf("expense-voucher-form__sticky-footer");
  assert.ok(newTabStart > -1 && vouchersTabStart > -1 && summaryTabStart > -1 && stickyFooterIndex > -1);
  assert.ok(stickyFooterIndex > newTabStart, "sticky footer must be after the New Voucher tab opens");
  assert.ok(stickyFooterIndex < vouchersTabStart, "sticky footer must close before the Vouchers tab starts");
  // Only bottom padding sized for the sticky bar is scoped to the New Voucher tab too.
  assert.match(modulePage, /expenses-module--form/);
  assert.match(styles, /\.expenses-module--form \{/);
});

test("category cards show the total once in the header, not duplicated again at the bottom", () => {
  assert.doesNotMatch(modulePage, /<b>\{t\("expensesPage\.categoryTotal"\)\}/);
  assert.match(modulePage, /<strong className="bidi-isolate">\{money\(categoryTotal\)\}<\/strong><\/header>/);
});

test("custom subcategory management is a modal reachable from the Summary tab, not an inline section between the summary cards and recent records", () => {
  assert.match(modulePage, /t\("expensesPage\.manageCategories"\)/);
  assert.match(modulePage, /setShowExpenseSubcategoryManager\(true\)/);
  assert.doesNotMatch(modulePage, /expense-subcategory-manager__toggle/);
});

test("the Vouchers tab has a compact search row with a filter-sheet trigger showing an active-filter count, and quick date chips", () => {
  assert.match(modulePage, /expense-filter-trigger/);
  assert.match(modulePage, /expenseFilterCount/);
  assert.match(modulePage, /reportsPage\.quickToday/);
  assert.match(modulePage, /reportsPage\.quickThisWeek/);
  assert.match(modulePage, /reportsPage\.quickThisMonth/);
});

test("the voucher list uses incremental loading rather than rendering the entire matched history at once", () => {
  assert.match(modulePage, /const \[visibleVoucherCount, setVisibleVoucherCount\] = useState\(20\)/);
  assert.match(modulePage, /visibleFilteredVouchers = useMemo\(\(\) => filteredVouchers\.slice\(0, visibleVoucherCount\)/);
  assert.match(modulePage, /expensesPage\.loadMoreVouchers/);
});

test("editing a voucher from the Vouchers list or its detail dialog jumps to the New Voucher tab, since that's the only place the form is mounted", () => {
  assert.match(modulePage, /if \(view !== "new"\) navigate\("\/workspace\/expenses\/new"\);/);
});

test("the mobile Add-Expense shortcut opens New Voucher directly", () => {
  assert.match(layout, /to: "\/workspace\/expenses\/new", label: t\("dashboard\.newExpense"\)/);
});
