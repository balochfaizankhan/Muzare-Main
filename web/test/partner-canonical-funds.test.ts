import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildPartnerLiabilityPositions, getPartnerAccountingSnapshot, mergePartnerPositionWithCanonical, type CanonicalPartnerPosition } from "../src/lib/partnerAccounting.ts";
import type { Account, PartnerEntry, Voucher } from "../src/lib/offline-db.ts";

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

test("ModulePage sources the non-labour overview fields from cardPosition, never snapshot-first (a numeric 0 from an incomplete snapshot must not win the ?? chain)", () => {
  const source = readFileSync(new URL("../src/pages/ModulePage.tsx", import.meta.url), "utf8");
  assert.match(source, /overview\.transfersOut = cardPosition\?\.transfersOut \?\? overview\.transfersOut;/);
  assert.match(source, /overview\.transfersIn = cardPosition\?\.transfersIn \?\? overview\.transfersIn;/);
  assert.match(source, /overview\.purchaseVouchersPaid = cardPosition\?\.purchaseVouchersPaid \?\? overview\.purchaseVouchersPaid;/);
  assert.doesNotMatch(source, /overview\.(capitalInjected|purchaseVouchersPaid|transfersOut|transfersIn|moneyReturned|adjustments) = settlementSnapshot/);
  // Labour fields still come from the canonical labour snapshot; the reconciliation
  // total is always derived from the displayed components, never the snapshot balance.
  assert.match(source, /overview\.labourAdvancesPaid = settlementSnapshot\?\.totalLabourAdvancesPaid \?\? overview\.labourAdvancesPaid;/);
  assert.match(source, /netBalance: calculatePartnerLiabilityBalance\(overview\)/);
  assert.doesNotMatch(source, /netBalance:\s*settlementSnapshot\?\.farmOwesPartner/);
});

test("a zero from an incomplete legacy snapshot does not erase correct cardPosition totals, while labour fields and Farm Owes Partner stay canonical", () => {
  // Behavioral reproduction of the regression: selectedPartnerSnapshot is calculated
  // from legacyExpenseVouchers, which can exclude valid records, so its non-labour
  // fields can be numeric zero even though the merged card position holds the correct
  // amounts. The overview must preserve the cardPosition values.
  const purchaseVoucherAmount = 700;
  const purchaseVoucher: Voucher = {
    id: "voucher-1",
    workspaceId: "workspace-1",
    farmId: null,
    seasonId: null,
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:00.000Z",
    voucherNumber: "PV-1",
    date: "2026-07-23",
    category: "Supplies",
    categoryId: "cat-1",
    subcategory: "General",
    subcategoryId: "sub-1",
    description: "Purchase paid by the partner",
    amount: purchaseVoucherAmount,
    accountId: canonicalPartner.id,
  };

  // 1. The snapshot the modal holds was computed WITHOUT the voucher (excluded from
  //    legacyExpenseVouchers) -> its purchaseVouchersPaid is numeric zero. Mirror
  //    ModulePage's selectedPartnerSnapshot shape: the legacy snapshot with the
  //    labour fields and final balance replaced from the canonical merge.
  const legacySnapshot = { ...snapshotFor(canonicalPartner), account: aliasPartner, key: aliasPartner.id, name: aliasPartner.name };
  const mergedSnapshot = mergePartnerPositionWithCanonical(legacySnapshot, canonicalPosition);
  const incompleteSnapshot = {
    ...legacySnapshot,
    totalLabourAdvancesPaid: mergedSnapshot.totalLabourAdvancesPaid,
    farmOwesPartner: mergedSnapshot.currentPartnerBalance,
    currentPartnerBalance: mergedSnapshot.currentPartnerBalance,
  };
  assert.equal(incompleteSnapshot.purchaseVouchersPaid, 0, "the incomplete snapshot holds numeric zero, not null");

  // 2. The card position pipeline sees the full voucher list and the fund transfer.
  const legacyPositions = buildPartnerLiabilityPositions(accounts, [purchaseVoucher], [], entries, [], [], { farmId: null, seasonId: null });
  const canonicalLegacyPosition = legacyPositions.find((position) => position.key === canonicalPartner.id);
  assert.ok(canonicalLegacyPosition);
  const cardPosition = mergePartnerPositionWithCanonical(canonicalLegacyPosition!, canonicalPosition);
  assert.equal(cardPosition.purchaseVouchersPaid, purchaseVoucherAmount);
  assert.equal(cardPosition.transfersOut, fundsGivenAmount);
  assert.equal(cardPosition.transfersIn, 0);

  // 3-5. Apply the overview's corrected source hierarchy: cardPosition for non-labour
  //      fields, the canonical snapshot for labour fields and the final balance.
  const overview = { capitalInjected: 0, purchaseVouchersPaid: 0, transfersOut: 0, transfersIn: 0, moneyReturned: 0, adjustments: 0, labourAdvancesPaid: 0 };
  overview.capitalInjected = cardPosition?.capitalInjected ?? overview.capitalInjected;
  overview.purchaseVouchersPaid = cardPosition?.purchaseVouchersPaid ?? overview.purchaseVouchersPaid;
  overview.transfersOut = cardPosition?.transfersOut ?? overview.transfersOut;
  overview.transfersIn = cardPosition?.transfersIn ?? overview.transfersIn;
  overview.moneyReturned = cardPosition?.moneyReturned ?? overview.moneyReturned;
  overview.adjustments = cardPosition?.adjustments ?? overview.adjustments;
  overview.labourAdvancesPaid = incompleteSnapshot?.totalLabourAdvancesPaid ?? overview.labourAdvancesPaid;
  const netBalance = incompleteSnapshot?.farmOwesPartner ?? incompleteSnapshot?.currentPartnerBalance;

  assert.equal(overview.purchaseVouchersPaid, purchaseVoucherAmount, "cardPosition purchase vouchers must survive; the snapshot's zero must not overwrite them");
  assert.equal(overview.transfersOut, fundsGivenAmount, "Business Funds Given must display the cardPosition amount, not zero");
  assert.equal(overview.transfersIn, 0, "Business Funds Received stays correct");
  assert.equal(overview.labourAdvancesPaid, canonicalPosition.labourAdvancesPaid, "labour fields still come from the canonical labour snapshot");

  // 6. Farm Owes Partner is unchanged: still the merged canonical snapshot balance,
  //    unaffected by the overview's non-labour overrides.
  assert.equal(netBalance, incompleteSnapshot.currentPartnerBalance);
  assert.equal(incompleteSnapshot.currentPartnerBalance, fundsGivenAmount + canonicalPosition.farmOwesPartner);

  // 7. Nothing is counted twice: each total equals its single source record exactly.
  assert.equal(overview.transfersOut, fundsGivenAmount);
  assert.notEqual(overview.transfersOut, fundsGivenAmount * 2);
  assert.equal(overview.purchaseVouchersPaid, purchaseVoucherAmount);
  assert.notEqual(overview.purchaseVouchersPaid, purchaseVoucherAmount * 2);
});
