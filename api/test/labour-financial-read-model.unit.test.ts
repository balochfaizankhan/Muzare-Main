import assert from "node:assert/strict";
import test from "node:test";
import { buildSyntheticVoucherAccountEntry, shouldIncludeExpenseVisibilityRow } from "../src/lib/labour-financial-read-model.js";

test("partner-funded direct labour payments can be backfilled into the partner ledger exactly once when the voucher exists without an account transaction", () => {
  const entry = buildSyntheticVoucherAccountEntry({
    voucher: {
      id: "voucher-1",
      voucherNumber: "LPV-0007",
      sourceId: "source-1",
      legacySourceRecordId: null,
      voucherDate: "2026-07-22",
      nature: "DIRECT_LABOUR_PAYMENT",
      status: "POSTED",
      description: "Payment for LD-0007",
      recipientScope: "INDIVIDUAL",
      labourerId: "labourer-1",
      labourGroupId: null,
      paymentAmount: "102030.00",
      legacy: false,
    },
    account: {
      id: "partner-sajid",
      name: "Sajid Khan",
      accountType: "partner",
    },
    recipientName: "Worker One",
  });

  assert.equal(entry.accountId, "partner-sajid");
  assert.equal(entry.transactionType, "credit");
  assert.equal(entry.balanceEffect, 102030);
  assert.equal(entry.economicNature, "DIRECT_LABOUR_PAYMENT");
  assert.equal(entry.amount, 102030);
  assert.equal(entry.recipientName, "Worker One");
});

test("reversal backfill inverts the missing funding entry for the same voucher source", () => {
  const entry = buildSyntheticVoucherAccountEntry({
    voucher: {
      id: "voucher-2",
      voucherNumber: "LPV-0008-R",
      sourceId: "source-2",
      legacySourceRecordId: null,
      voucherDate: "2026-07-22",
      nature: "REVERSAL",
      status: "POSTED",
      description: "Reverse LPV-0008",
      recipientScope: "INDIVIDUAL",
      labourerId: "labourer-1",
      labourGroupId: null,
      paymentAmount: "102030.00",
      legacy: false,
    },
    account: {
      id: "partner-sajid",
      name: "Sajid Khan",
      accountType: "partner",
    },
    recipientName: "Worker One",
    economicNature: "DIRECT_LABOUR_PAYMENT",
    reverse: true,
  });

  assert.equal(entry.transactionType, "debit");
  assert.equal(entry.balanceEffect, -102030);
  assert.equal(entry.economicNature, "DIRECT_LABOUR_PAYMENT");
});

test("expense visibility keeps active unpaid dues even before any settlement amount is recognized", () => {
  assert.equal(shouldIncludeExpenseVisibilityRow({ amount: 0, outstandingAmount: 38608, active: true }), true);
  assert.equal(shouldIncludeExpenseVisibilityRow({ amount: 0, outstandingAmount: 0, active: false }), false);
});
