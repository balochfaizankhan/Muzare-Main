import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../src/pages/workspace/WorkforcePayments.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("mixed cash and advance settlements render as one user-facing voucher card", () => {
  assert.match(page, /applicationParentByVoucherId/);
  assert.match(page, /voucher\.linkedDueId === parent\.dueId/);
  assert.match(page, /attachedApplicationParentIds\.add\(parent\.id\)/);
  assert.match(page, /\.filter\(\(parent\) => !attachedApplicationParentIds\.has\(parent\.id\)\)/);
  assert.match(page, /cashAmount \+ \(applicationParent\?\.activeAmount \?\? 0\)/);
  assert.match(page, /combinedSettlementDescription/);
  assert.match(page, /workforce-payment-settlement-breakdown/);
});

test("underlying cash and advance reversal actions remain explicit and audit-safe", () => {
  assert.match(page, /reverseCashComponent/);
  assert.match(page, /reverseAdvanceComponent/);
  assert.match(page, /voidVoucher\(row\.voucher\)/);
  assert.match(page, /reverseApplicationParent\(row\.applicationParent!\)/);
});

test("voucher KPI cards use two columns on mobile and keep monetary values on one line", () => {
  assert.match(css, /\.workforce-payment-report-grid \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.workforce-payment-report-grid strong \{[^}]*white-space: nowrap/);
  assert.match(css, /@media \(min-width: 760px\)[\s\S]*\.workforce-payment-report-grid \{ grid-template-columns: repeat\(4, minmax\(0, 1fr\)\); \}/);
});
