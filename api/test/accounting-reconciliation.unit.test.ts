import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAccountIdentityLookup } from "../src/lib/account-identity.js";
import { buildPartnerSnapshot } from "../src/routes/accounting-reconciliation.js";

const accountId = "11111111-1111-4111-8111-111111111111";
const lookup = buildAccountIdentityLookup([{ id: accountId, name: "Partner", accountType: "partner" }]);

test("reconciliation signs decreasing adjustments and filters voucher lifecycle and season", () => {
  const result = buildPartnerSnapshot({
    selectedAccountId: accountId,
    accountLookup: lookup,
    advances: [],
    settlements: [],
    vouchers: [
      { accountId, amount: 100, isLabourWageSettlementVoucher: false, active: true, farmId: "farm-a", seasonId: "season-a" },
      { accountId, amount: 900, isLabourWageSettlementVoucher: false, active: false, farmId: "farm-a", seasonId: "season-a" },
      { accountId, amount: 800, isLabourWageSettlementVoucher: false, active: true, farmId: "farm-a", seasonId: "season-b" },
    ],
    partnerEntries: [
      {
        type: "adjustment",
        amount: 25,
        adjustmentDirection: "decrease",
        partnerAccountId: accountId,
        fromAccountId: null,
        toAccountId: null,
        fromPartnerId: null,
        toPartnerId: null,
        partnerId: null,
        accountId: null,
        farmId: "farm-a",
        seasonId: "season-a",
      },
    ],
    sales: [],
    farmId: "farm-a",
    seasonId: "season-a",
  });

  assert.equal(result.purchaseVouchersPaid, 100);
  assert.equal(result.adjustments, -25);
  assert.equal(result.farmOwesPartner, 75);
});
