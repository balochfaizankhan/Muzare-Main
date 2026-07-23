import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = readFileSync(new URL("../src/routes/labour-payments.ts", import.meta.url), "utf8");
const ui = readFileSync(new URL("../../web/src/pages/workspace/WorkforcePayments.tsx", import.meta.url), "utf8");
const i18n = readFileSync(new URL("../../web/src/i18n.ts", import.meta.url), "utf8");

test("review uses a narrow aggregate endpoint and lazy allocation details", () => {
  assert.match(route, /dues\/:dueId\/advance-pool/);
  assert.match(route, /query\.data\.amount == null \? undefined/);
  // The review dialog is fully localized; the copy lives in the i18n catalog
  // and the dialog references it by key. Under the group-pool model the
  // dialog shows the aggregate group position — there is no per-voucher
  // allocation or exclusion browser.
  assert.match(ui, /reviewSettle\.totalAvailableForDue/);
  assert.match(ui, /reviewSettle\.groupOutstandingAdvances/);
  assert.match(i18n, /"totalAvailableForDue": "Total available for this due"/);
  assert.doesNotMatch(ui, /reviewSettle\.viewAllocationDetails|reviewSettle\.whyExcluded/);
  assert.doesNotMatch(ui.slice(ui.indexOf("function ReviewSettleDialog")), /fetchAllLabourPaymentAdvances/);
  assert.doesNotMatch(ui.slice(ui.indexOf("function ReviewSettleDialog")), /advanceValues/);
});

test("aggregate settlement uses the pool preview to size the request and does not require a payment", () => {
  assert.match(route, /calculateLabourAdvancePool/);
  assert.match(route, /applicationModel: "AGGREGATE_POOLED"/);
  assert.match(route, /if \(input\.payment\)/);
  assert.match(route, /postLabourAdvanceApplicationJournal/);
});

test("pooled persistence locks the due, persists one canonical application row, and reports safe database diagnostics", () => {
  assert.match(route, /labourDues\.id[\s\S]+\.for\("update"\)/);
  // The aggregate outstanding pool must be applied as ONE row (no source advance
  // voucher, no per-voucher unrolling) — the database trigger
  // (validate_labour_advance_application) is the sole authority for the
  // aggregate-sufficiency check, taking its own row locks at INSERT time.
  assert.match(route, /const \[inserted\] = await tx\.insert\(labourAdvanceApplications\)\.values\(\{\s*workspaceId,\s*advanceVoucherId: null,/);
  assert.doesNotMatch(route, /offset \+= 40/, "the pool branch must no longer batch per-voucher inserts");
  assert.match(route, /labourPaymentDatabaseError/);
  assert.match(route, /sqlState/);
  assert.match(route, /knownPoolValidationMessages/);
  assert.match(route, /No balances were changed\. Reference:/);
  assert.match(route, /settlementSummary/);
  assert.match(route, /await db\.transaction/);
});
