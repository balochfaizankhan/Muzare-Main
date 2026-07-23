import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const select = readFileSync(new URL("../src/components/PaymentAccountSelect.tsx", import.meta.url), "utf8");
const modulePage = readFileSync(new URL("../src/pages/ModulePage.tsx", import.meta.url), "utf8");
const workforcePayments = readFileSync(new URL("../src/pages/workspace/WorkforcePayments.tsx", import.meta.url), "utf8");
const labourAdvances = readFileSync(new URL("../src/pages/workspace/LabourAdvances.tsx", import.meta.url), "utf8");
const labourWageSettlements = readFileSync(new URL("../src/pages/workspace/LabourWageSettlements.tsx", import.meta.url), "utf8");

test("PaymentAccountSelect is selection-only: no search box, no text input, no mobile keyboard", () => {
  // The sheet is self-contained: it must not pull in the searchable picker or any text input.
  assert.doesNotMatch(select, /ResponsiveSelectField/);
  assert.doesNotMatch(select, /SearchInput/);
  assert.doesNotMatch(select, /<input/);
  // The trigger is a read-only button that opens the dialog sheet.
  assert.match(select, /aria-haspopup="dialog"/);
  assert.match(select, /t\("paymentAccountSelect\.required"\)/);
  assert.match(select, /t\("paymentAccountSelect\.empty"\)/);
});

test("AccountSelectionSheet selects on tap with no confirm step, and exposes radio semantics", () => {
  assert.match(select, /role="radiogroup"/);
  assert.match(select, /role="radio"/);
  assert.match(select, /aria-checked=\{selected\}/);
  // Choosing a row fires onChange with the account id and closes immediately — no Apply/Done.
  assert.match(select, /onChange\(accountId\);\s*\n\s*close\(\);/);
  assert.doesNotMatch(select, /common\.apply/);
  // Escape closes and focus returns to the trigger field.
  assert.match(select, /event\.key === "Escape"/);
  assert.match(select, /triggerRef\.current\?\.focus\(\)/);
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
  // Expenses (voucher form + advanced filter), Sales, PartnerLedger (partner/from/to/deposit),
  // the two labour-advance panels, and the attendance-import payment account — at least 9 sites.
  assert.ok(occurrences >= 9, `expected at least 9 <PaymentAccountSelect usages in ModulePage.tsx, found ${occurrences}`);
});

test("the partner ledger no longer uses a typing autocomplete to pick the partner account", () => {
  assert.doesNotMatch(modulePage, /PartnerAccountAutocomplete/);
  assert.match(modulePage, /alsoIncludeId: editing\?\.partnerAccountId/);
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
