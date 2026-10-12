import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const accounts = readFileSync(new URL("../src/pages/ModulePage.tsx", import.meta.url), "utf8");
const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");

test("Accounts recognized expense is derived from canonical wage expense plus voucher expenses only", () => {
  assert.match(accounts, /const labourWageExpense = canonicalAccountsFinancials\?\.summary\.wageExpense \?\? 0/);
  assert.match(accounts, /const totalBusinessExpenses = totalVoucherExpenses \+ labourWageExpense/);
  assert.doesNotMatch(accounts, /totalBusinessExpenses\s*=\s*totalVoucherExpenses\s*\+\s*[^;]*totalAdvances/);
});

test("Accounts payments due uses the canonical due summary", () => {
  assert.match(accounts, /canonicalAccountsFinancials\?\.labourPaymentsDue\.totalOutstanding \?\? 0/);
});

test("outstanding advances remain separately visible and are not treated as recognized expense", () => {
  assert.match(accounts, /const totalAdvances = canonicalAccountsFinancials\?\.summary\.outstandingAdvance \?\? 0/);
  assert.match(accounts, /accountsPage\.availableAdvanceBalanceCard/);
});

test("the DOM-based financial correction layer is no longer installed", () => {
  assert.doesNotMatch(main, /accountsExpenseVisibilityCorrection/);
  assert.doesNotMatch(main, /installAccountsExpenseVisibilityCorrection/);
});
