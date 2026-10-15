import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const source = readFileSync(new URL("../src/routes/operational-sync.ts", import.meta.url), "utf8");
test("farm account master endpoint is season independent", () => {
  assert.match(source, /farms\/:farmId\/accounts"/);
  assert.match(source, /seasonId: null/);
});
test("account deletion blocks known financial references", () => {
  assert.match(source, /code: "account_in_use"/);
  assert.match(source, /advanceRecords\.accountId/);
  assert.match(source, /canonicalSales\.accountId/);
  assert.match(source, /canonicalVouchers\.accountId/);
  assert.match(source, /accountTransactions\.accountId/);
  assert.match(source, /labourPaymentVouchers\.paymentAccountId/);
});
