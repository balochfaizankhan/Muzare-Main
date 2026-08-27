import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const labourPaymentsSource = readFileSync(
  new URL("../src/lib/labour-payments.ts", import.meta.url),
  "utf8",
);
const workforcePaymentsSource = readFileSync(
  new URL("../../web/src/pages/workspace/WorkforcePayments.tsx", import.meta.url),
  "utf8",
);
const bottomActionsSource = readFileSync(
  new URL("../../web/src/lib/labourPaymentBottomActions.ts", import.meta.url),
  "utf8",
);
const bottomActionsCss = readFileSync(
  new URL("../../web/src/labour-payment-bottom-actions.css", import.meta.url),
  "utf8",
);

test("read model preserves explicit held and voided due states", () => {
  assert.ok(labourPaymentsSource.includes('due.paymentStatus === "ON_HOLD" || due.paymentStatus === "VOIDED"'));
  assert.ok(labourPaymentsSource.includes('? due.paymentStatus'));
  assert.ok(labourPaymentsSource.includes(': position.paymentStatus'));
  assert.ok(labourPaymentsSource.includes('paymentStatus,'));
});

test("held dues cannot expose advance or cash settlement controls", () => {
  assert.ok(workforcePaymentsSource.includes('due.paymentStatus !== "ON_HOLD" && due.outstandingBalance > 0'));
  assert.ok(workforcePaymentsSource.includes('due.paymentStatus !== "ON_HOLD" && afterAdvances > 0'));
  assert.ok(workforcePaymentsSource.includes('due.paymentStatus === "ON_HOLD" ||'));
});

test("held dues expose the existing remove-hold action", () => {
  assert.ok(workforcePaymentsSource.includes('workforcePaymentsPage.reviewSettle.removeHold'));
  assert.ok(workforcePaymentsSource.includes('hold: due.paymentStatus !== "ON_HOLD"'));
  assert.ok(bottomActionsSource.includes('status-on_hold'));
  assert.ok(bottomActionsSource.includes('is-resume'));
  assert.ok(bottomActionsCss.includes('.workforce-payment-review--on-hold'));
  assert.ok(bottomActionsCss.includes('.workforce-payment-review__secondary-action.is-resume'));
});
