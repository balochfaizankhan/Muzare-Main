import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const picker = readFileSync(new URL("../src/components/ResponsivePicker.tsx", import.meta.url), "utf8");
const select = readFileSync(new URL("../src/components/PaymentAccountSelect.tsx", import.meta.url), "utf8");
const modulePage = readFileSync(new URL("../src/pages/ModulePage.tsx", import.meta.url), "utf8");
const workforcePayments = readFileSync(new URL("../src/pages/workspace/WorkforcePayments.tsx", import.meta.url), "utf8");
const labourAdvances = readFileSync(new URL("../src/pages/workspace/LabourAdvances.tsx", import.meta.url), "utf8");
const labourWageSettlements = readFileSync(new URL("../src/pages/workspace/LabourWageSettlements.tsx", import.meta.url), "utf8");

test("ResponsiveSelectField supports opting out of auto-focusing the search box, defaulting to the existing (unchanged) behavior", () => {
  assert.match(picker, /autoFocusSearch\?: boolean/);
  assert.match(picker, /autoFocusSearch = true,/);
  assert.match(picker, /if \(!open \|\| !autoFocusSearch\) return;/);
});

test("PaymentAccountSelect is selection-only: it never lets onChange fire with typed free text, and it suppresses auto-focus", () => {
  assert.match(select, /allowClear=\{false\}/);
  assert.match(select, /autoFocusSearch=\{false\}/);
  // onChange is wired straight from ResponsiveSelectField's onChange, which only ever calls back
  // with an option's own `value` (see choose() in ResponsivePicker.tsx) — never raw query text.
  assert.match(select, /onChange=\{onChange\}/);
  assert.match(select, /t\("paymentAccountSelect\.required"\)/);
});

test("every rollout site imports the shared PaymentAccountSelect instead of a bespoke account control", () => {
  for (const [label, source] of [
    ["ModulePage (Expenses/Sales/PartnerLedger/Labour advance panels/Attendance import)", modulePage],
    ["WorkforcePayments", workforcePayments],
    ["LabourAdvances", labourAdvances],
    ["LabourWageSettlements", labourWageSettlements],
  ] as const) {
    assert.match(source, /PaymentAccountSelect/, `${label} should import/use PaymentAccountSelect`);
  }
});

test("ModulePage rolls PaymentAccountSelect out to Expenses, Sales, PartnerLedger, and the labour advance/attendance-import panels", () => {
  const occurrences = (modulePage.match(/<PaymentAccountSelect/g) ?? []).length;
  // Expenses (voucher form + advanced filter), Sales, PartnerLedger (from/to/deposit), the two
  // labour-advance panels, and the attendance-import payment account — at least 8 call sites.
  assert.ok(occurrences >= 8, `expected at least 8 <PaymentAccountSelect usages in ModulePage.tsx, found ${occurrences}`);
});

test("Expenses voucher form and Sales/PartnerLedger no longer silently default to the first account", () => {
  assert.doesNotMatch(modulePage, /resolvedExpenseAccountId = accountId \|\| selectableExpenseAccounts\[0\]/);
  assert.match(modulePage, /const resolvedExpenseAccountId = accountId;/);
  assert.doesNotMatch(modulePage, /defaultCashAccountId/);
});

test("WorkforcePayments no longer casts accounts through the Labourer type to reuse LabourSelectCombobox for payment accounts", () => {
  assert.doesNotMatch(workforcePayments, /as Labourer\)\),\s*\n\s*\[accounts\]/);
  assert.doesNotMatch(workforcePayments, /const accountOptions = useMemo/);
});

test("LabourAdvances and LabourWageSettlements preserve a historical account when editing (alsoIncludeId), not just when creating new records", () => {
  assert.match(labourAdvances, /alsoIncludeId: advance\.accountId/);
  assert.match(labourWageSettlements, /alsoIncludeId: selectedSettlement\?\.paymentAccountId/);
});
