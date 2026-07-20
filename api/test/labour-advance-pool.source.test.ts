import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = readFileSync(new URL("../src/routes/labour-payments.ts", import.meta.url), "utf8");
const ui = readFileSync(new URL("../../web/src/pages/workspace/WorkforcePayments.tsx", import.meta.url), "utf8");

test("review uses a narrow aggregate endpoint and lazy allocation details", () => {
  assert.match(route, /dues\/:dueId\/advance-pool/);
  assert.match(route, /query\.data\.amount == null \? undefined/);
  assert.match(ui, /Total available for this due/);
  assert.match(ui, /View allocation details/);
  assert.match(ui, /Why are some advances excluded\?/);
  assert.match(ui, /regardless of the Labour Due work period/);
  assert.doesNotMatch(ui.slice(ui.indexOf("function ReviewSettleDialog")), /fetchAllLabourPaymentAdvances/);
  assert.doesNotMatch(ui.slice(ui.indexOf("function ReviewSettleDialog")), /advanceValues/);
});

test("aggregate settlement retains voucher allocations and does not require a payment", () => {
  assert.match(route, /calculateLabourAdvancePool/);
  assert.match(route, /allocationPolicy: "GROUP_OLDEST_FIRST_THEN_MEMBER_OLDEST_FIRST"/);
  assert.match(route, /if \(input\.payment\)/);
  assert.match(route, /postLabourAdvanceApplicationJournal/);
});

test("pooled persistence locks rows, batches writes, and reports safe database diagnostics", () => {
  assert.match(route, /labourDues\.id[\s\S]+\.for\("update"\)/);
  assert.match(route, /labourPaymentVouchers\.id[\s\S]+\.for\("update"\)/);
  assert.match(route, /offset \+= 40/);
  assert.match(route, /labourPaymentDatabaseError/);
  assert.match(route, /sqlState/);
  assert.match(route, /No balances were changed\. Reference:/);
  assert.match(route, /settlementSummary/);
  assert.match(route, /await db\.transaction/);
});
