import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { calculatePartnerLiabilityBalance } from "../src/lib/partnerAccounting.ts";

// Audited defect (Younis Khan): the Accounts modal displayed the correct reconciliation
// components, but the section's final "Farm Owes Partner" total was overridden by a
// stale settlementSnapshot.farmOwesPartner (152,931) instead of being derived from the
// displayed components (191,619.5).
const displayedComponents = {
  openingBalance: 0,
  capitalInjected: 0,
  directExpensesPaid: 203_479.5,
  transfersOut: 101_140,
  transfersIn: 113_000,
  moneyReturned: 0,
  adjustments: 0,
};
const staleSnapshot = { farmOwesPartner: 152_931 };

test("the reconciliation total is calculated from the displayed components even when the settlement snapshot holds a stale farmOwesPartner", () => {
  // The pre-fix derivation preferred the snapshot, so a stale value won:
  const buggyTotal = staleSnapshot?.farmOwesPartner ?? calculatePartnerLiabilityBalance(displayedComponents);
  assert.equal(buggyTotal, 152_931, "sanity: a stale snapshot wins the old ?? chain");
  // The fixed derivation ignores the snapshot and reconciles the section with itself.
  const reconciliationTotal = calculatePartnerLiabilityBalance(displayedComponents);
  assert.equal(reconciliationTotal, 191_619.5);
  assert.notEqual(reconciliationTotal, staleSnapshot.farmOwesPartner);
});

test("the reconciliation total equals capital + direct expenses + funds given - funds received - money returned + adjustments", () => {
  const expected = displayedComponents.capitalInjected
    + displayedComponents.directExpensesPaid
    + displayedComponents.transfersOut
    - displayedComponents.transfersIn
    - displayedComponents.moneyReturned
    + displayedComponents.adjustments;
  assert.equal(calculatePartnerLiabilityBalance(displayedComponents), expected);
  assert.equal(expected, 191_619.5);
});

test("ModulePage never sources a partner reconciliation netBalance from settlementSnapshot.farmOwesPartner", () => {
  const source = readFileSync(new URL("../src/pages/ModulePage.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /netBalance:\s*settlementSnapshot\?\.farmOwesPartner/);
  assert.match(source, /netBalance: calculatePartnerLiabilityBalance\(overview\)/);
});
