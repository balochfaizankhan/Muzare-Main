import assert from "node:assert/strict";
import { test } from "node:test";

import { calculateLabourAdvanceAccountingSnapshot } from "../src/lib/partner-labour-advance-accounting.js";

test("canonical labour advance accounting keeps total advances fixed while wage settlements split settled and outstanding amounts", () => {
  const partnerAccountId = "79a51f57-f255-49a6-a9f3-b936c9842927";
  const snapshot = calculateLabourAdvanceAccountingSnapshot({
    selectedAccountId: partnerAccountId,
    advances: [
      {
        amount: 100_000,
        accountId: partnerAccountId,
        farmId: "farm-1",
        seasonId: "season-1",
        status: "posted",
      },
      {
        amount: 12_500,
        accountId: partnerAccountId,
        farmId: "farm-1",
        seasonId: "season-1",
        status: "voided",
      },
      {
        amount: 50_000,
        accountId: "partner-other",
        farmId: "farm-1",
        seasonId: "season-1",
        status: "posted",
      },
    ],
    settlements: [
      {
        linkedAccountId: partnerAccountId,
        advancesApplied: 25_000,
        cashPaid: 0,
        farmId: "farm-1",
        seasonId: "season-1",
        status: "posted",
      },
      {
        linkedAccountId: partnerAccountId,
        advancesApplied: 10_000,
        cashPaid: 0,
        farmId: "farm-1",
        seasonId: "season-1",
        status: "voided",
      },
      {
        linkedAccountId: "partner-other",
        advancesApplied: 9_999,
        cashPaid: 0,
        farmId: "farm-1",
        seasonId: "season-1",
        status: "posted",
      },
    ],
    farmId: "farm-1",
    seasonId: "season-1",
  });

  assert.equal(snapshot.totalLabourAdvancesPaid, 100_000);
  assert.equal(snapshot.settledAdvances, 25_000);
  assert.equal(snapshot.outstandingAdvances, 75_000);
  assert.equal(snapshot.reconciliationDifference, 0);
  assert.equal(snapshot.isConsistent, true);
  assert.equal(snapshot.labourSettlementCashPaid, 0);
  assert.equal(snapshot.labourSettlementNonCashApplied, 25_000);
  assert.equal(snapshot.settlementCount, 1);
});
