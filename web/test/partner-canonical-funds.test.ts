import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getPartnerAccountingSnapshot, mergePartnerPositionWithCanonical, type CanonicalPartnerPosition } from "../src/lib/partnerAccounting.ts";
import type { Account, PartnerEntry } from "../src/lib/offline-db.ts";

const baseAccount = (overrides: Partial<Account> & Pick<Account, "id" | "name" | "type">): Account => ({
  workspaceId: "workspace-1",
  farmId: null,
  seasonId: null,
  createdAt: "2026-07-23T00:00:00.000Z",
  updatedAt: "2026-07-23T00:00:00.000Z",
  ...overrides,
});

const fundsGivenEntry = (overrides: Partial<PartnerEntry> & Pick<PartnerEntry, "id" | "fromAccountId" | "toAccountId" | "amount">): PartnerEntry => ({
  workspaceId: "workspace-1",
  farmId: null,
  seasonId: null,
  createdAt: "2026-07-23T00:00:00.000Z",
  updatedAt: "2026-07-23T00:00:00.000Z",
  date: "2026-07-23",
  type: "settlement",
  notes: "",
  ...overrides,
});

// Scenario mirroring the audited Accounts partner-details bug:
// - the canonical partner account exists in the accounts list;
// - a separate operational/display alias account (same partner, different id)
//   is what the user selects through the accounts UI;
// - funds-given activity is recorded against the canonical identity.
const canonicalPartner = baseAccount({ id: "partner-canonical-id", name: "Partner One", type: "partner" });
const aliasPartner = baseAccount({ id: "partner-operational-alias-id", name: "Partner One", type: "partner", sourceType: "labour_finance" });
const cashAccount = baseAccount({ id: "cash-account-id", name: "Cash", type: "cash" });
const accounts = [aliasPartner, canonicalPartner, cashAccount];
const fundsGivenAmount = 5000;
const entries: PartnerEntry[] = [
  fundsGivenEntry({ id: "transfer-1", fromAccountId: canonicalPartner.id, toAccountId: cashAccount.id, amount: fundsGivenAmount }),
];
const canonicalPosition: CanonicalPartnerPosition = {
  accountId: canonicalPartner.id,
  accountName: canonicalPartner.name,
  farmOwesPartner: 1234,
  ledgerBalance: 1234,
  labourAdvancesPaid: 1234,
  directLabourPayments: 0,
  labourPayments: 0,
  recoveries: 0,
  outstandingLabourAdvances: 0,
  appliedLabourAdvances: 0,
  entryCount: 1,
};

const snapshotFor = (calculationAccount: Account) =>
  getPartnerAccountingSnapshot(calculationAccount, [], [], [], entries, [], accounts, { farmId: null, seasonId: null });

test("calculating the partner snapshot with the alias account id cannot see canonical fund transfers (the audited defect shape)", () => {
  const aliasSnapshot = snapshotFor(aliasPartner);
  assert.equal(aliasSnapshot.transfersOut, 0);
  assert.equal(aliasSnapshot.rowBreakdown.funds.filter((row) => row.included).length, 0);
});

test("calculating with the canonical account resolves Business Funds Given correctly and exactly once, even when selection happened through the alias", () => {
  // This mirrors ModulePage's fixed selectedPartnerSnapshot: selection/display uses the
  // alias, but the calculation account is the canonical Account object.
  const canonicalSnapshot = snapshotFor(canonicalPartner);
  assert.equal(canonicalSnapshot.transfersOut, fundsGivenAmount);
  assert.equal(canonicalSnapshot.transfersIn, 0);
  const includedGivenRows = canonicalSnapshot.rowBreakdown.funds.filter((row) => row.included && row.direction === "given");
  assert.equal(includedGivenRows.length, 1, "the funds-given entry must be counted exactly once");
  assert.equal(includedGivenRows[0]?.amount, fundsGivenAmount);
});

test("Farm Owes Partner is unchanged by alias selection: the canonical merge yields the identical balance for alias-selected and canonical-selected snapshots", () => {
  const canonicalSnapshot = snapshotFor(canonicalPartner);
  // ModulePage preserves the alias's identity on the display snapshot while the
  // calculation ran against the canonical account.
  const aliasSelectedDisplaySnapshot = {
    ...canonicalSnapshot,
    account: aliasPartner,
    key: aliasPartner.id,
    name: aliasPartner.name,
  };
  const mergedViaAlias = mergePartnerPositionWithCanonical(aliasSelectedDisplaySnapshot, canonicalPosition);
  const mergedDirect = mergePartnerPositionWithCanonical(canonicalSnapshot, canonicalPosition);
  assert.equal(mergedViaAlias.currentPartnerBalance, mergedDirect.currentPartnerBalance);
  // Non-labour funds counted once + the canonical labour position, never doubled.
  assert.equal(mergedViaAlias.currentPartnerBalance, fundsGivenAmount + canonicalPosition.farmOwesPartner);
  // Display identity stays on the selected alias account.
  assert.equal(mergedViaAlias.account?.id, aliasPartner.id);
  assert.equal(mergedViaAlias.key, aliasPartner.id);
});

test("ModulePage passes a canonical-id calculation account into getPartnerAccountingSnapshot while preserving the selected account for display identity", () => {
  const source = readFileSync(new URL("../src/pages/ModulePage.tsx", import.meta.url), "utf8");
  assert.match(source, /const canonicalCalculationAccount = selectedAccount\.id === selectedCanonicalAccountId\s*\?\s*selectedAccount\s*:\s*accounts\.find\(\(item\) => item\.id === selectedCanonicalAccountId\) \?\? \{ \.\.\.selectedAccount, id: selectedCanonicalAccountId \}/);
  assert.match(source, /getPartnerAccountingSnapshot\(canonicalCalculationAccount, sales, legacyExpenseVouchers, activeAdvances, activeEntries, activeLabourWageSettlements, accounts, \{ farmId, seasonId \}\)/);
  assert.match(source, /account: selectedAccount,\s*key: selectedAccount\.id,\s*name: selectedAccount\.name,/);
  assert.doesNotMatch(source, /getPartnerAccountingSnapshot\(selectedAccount,/);
});

test("the Accounts partner overview displays every reconciliation field from the authoritative snapshot, including transfersOut (Business Funds Given)", () => {
  const source = readFileSync(new URL("../src/pages/ModulePage.tsx", import.meta.url), "utf8");
  assert.match(source, /overview\.transfersOut = settlementSnapshot\?\.transfersOut \?\? cardPosition\?\.transfersOut \?\? overview\.transfersOut;/);
  assert.match(source, /overview\.transfersIn = settlementSnapshot\?\.transfersIn \?\? cardPosition\?\.transfersIn \?\? overview\.transfersIn;/);
  assert.match(source, /overview\.capitalInjected = settlementSnapshot\?\.capitalInjected \?\? cardPosition\?\.capitalInjected \?\? overview\.capitalInjected;/);
  assert.match(source, /overview\.purchaseVouchersPaid = settlementSnapshot\?\.purchaseVouchersPaid \?\? cardPosition\?\.purchaseVouchersPaid \?\? overview\.purchaseVouchersPaid;/);
  assert.match(source, /overview\.moneyReturned = settlementSnapshot\?\.moneyReturned \?\? cardPosition\?\.moneyReturned \?\? overview\.moneyReturned;/);
  assert.match(source, /overview\.adjustments = settlementSnapshot\?\.adjustments \?\? cardPosition\?\.adjustments \?\? overview\.adjustments;/);
  // Farm Owes Partner (netBalance) still comes from the merged canonical snapshot.
  assert.match(source, /netBalance: settlementSnapshot\?\.farmOwesPartner \?\? calculatePartnerLiabilityBalance\(overview\)/);
});

test("the Accounts overview reconciliation reproduces the Partner Ledger figures when overridden from the canonical snapshot", () => {
  // Mirrors rawPartnerLedgerOverview's snapshot-first overrides against the same
  // alias-selection scenario: the raw ledger-row tally starts at zero for transfers
  // (the defect), and the snapshot override must surface the canonical amounts
  // exactly once with Farm Owes Partner unchanged, so that the reconciliation
  // "direct expenses + funds given - funds received = Farm Owes Partner" holds.
  const canonicalSnapshot = snapshotFor(canonicalPartner);
  const merged = mergePartnerPositionWithCanonical(
    { ...canonicalSnapshot, account: aliasPartner, key: aliasPartner.id, name: aliasPartner.name },
    canonicalPosition,
  );
  const overview = { transfersOut: 0, transfersIn: 0 };
  overview.transfersOut = canonicalSnapshot.transfersOut ?? overview.transfersOut;
  overview.transfersIn = canonicalSnapshot.transfersIn ?? overview.transfersIn;
  assert.equal(overview.transfersOut, fundsGivenAmount, "Business Funds Given must display the canonical amount instead of zero");
  assert.equal(overview.transfersIn, 0, "Business Funds Received must stay correct");
  const directExpensesPaid = canonicalSnapshot.purchaseVouchersPaid + merged.totalLabourAdvancesPaid + merged.labourWageSettlements;
  assert.equal(merged.currentPartnerBalance, directExpensesPaid + overview.transfersOut - overview.transfersIn);
});
