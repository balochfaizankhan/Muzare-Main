import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { buildCanonicalDisplayAccounts } from "../src/lib/accountDisplay.ts";
import { buildAccountIdentityLookup, resolveCanonicalAccountId } from "../src/lib/accountIdentity.ts";
import {
  aggregatePartnerLiabilityPositions,
  buildPartnerLiabilityPositions,
  mergePartnerPositionWithCanonical,
  resolveCanonicalPartnerPosition,
  type CanonicalPartnerPosition,
  type PartnerLiabilityPosition,
} from "../src/lib/partnerAccounting.ts";
import type { Account, PartnerEntry, Voucher } from "../src/lib/offline-db.ts";

const baseAccount = (overrides: Partial<Account> & Pick<Account, "id" | "name" | "type">): Account => ({
  workspaceId: "workspace-1",
  farmId: null,
  seasonId: null,
  createdAt: "2026-07-23T00:00:00.000Z",
  updatedAt: "2026-07-23T00:00:00.000Z",
  ...overrides,
});

const purchaseVoucher = (overrides: Partial<Voucher> & Pick<Voucher, "id" | "accountId" | "amount">): Voucher => ({
  workspaceId: "workspace-1",
  farmId: null,
  seasonId: null,
  createdAt: "2026-07-23T00:00:00.000Z",
  updatedAt: "2026-07-23T00:00:00.000Z",
  voucherNumber: overrides.id,
  date: "2026-07-23",
  category: "Supplies",
  categoryId: "cat-1",
  subcategory: "General",
  subcategoryId: "sub-1",
  description: "Purchase paid by the partner",
  ...overrides,
});

type PartnerStatusCard = { position: PartnerLiabilityPosition; sourceAccountIds: string[] };

// Mirrors the Reports.tsx Partner Status orchestration: collapse every account id,
// alias and canonical partner position into one card per canonical partner.
function buildPartnerStatusCards(
  accounts: Account[],
  vouchers: Voucher[],
  partnerRows: PartnerEntry[],
  canonicalPartnerPositions: CanonicalPartnerPosition[],
): PartnerStatusCard[] {
  const accountLookup = buildAccountIdentityLookup(accounts);
  const legacyPositions = buildPartnerLiabilityPositions(accounts, vouchers, [], partnerRows, [], []);
  const legacyByAccountId = new Map(legacyPositions.map((item) => [item.account?.id ?? item.key, item] as const));
  const canonicalById = new Map(canonicalPartnerPositions.map((item) => [item.accountId, item] as const));

  return buildCanonicalDisplayAccounts(accounts, accountLookup, canonicalPartnerPositions)
    .filter((display) => display.account.type === "partner")
    .map((display) => {
      const memberLegacyPositions = display.sourceAccountIds
        .map((id) => legacyByAccountId.get(id))
        .filter((item): item is PartnerLiabilityPosition => Boolean(item));
      const aggregatedLegacy = aggregatePartnerLiabilityPositions(memberLegacyPositions, {
        account: display.account,
        key: display.canonicalAccountId,
        name: display.account.name,
      });
      const canonical = canonicalById.get(display.canonicalAccountId)
        ?? resolveCanonicalPartnerPosition(display.account, canonicalPartnerPositions, accountLookup);
      const position: PartnerLiabilityPosition = {
        ...mergePartnerPositionWithCanonical(aggregatedLegacy, canonical),
        key: display.canonicalAccountId,
        name: display.account.name,
        account: display.account,
      };
      return { position, sourceAccountIds: display.sourceAccountIds };
    })
    .sort((left, right) => left.position.name.localeCompare(right.position.name));
}

test("Partner Status renders exactly one card per canonical partner, with the labour-finance alias merged in", () => {
  // Sajid: an operational account holding a purchase voucher, plus a labour-finance alias
  // carrying the canonical direct-labour payment. The pre-fix report showed two cards
  // (SAR 215,387 merged and a bare SAR 102,030 canonical); the fix collapses them to one.
  const accounts = [
    baseAccount({ id: "sajid-operational", name: "Sajid Khan", type: "partner", oldAndroidId: "3", sourceType: "operational_account_repair" }),
    baseAccount({ id: "sajid-labour", name: "Sajid Khan", type: "partner", sourceType: "labour_finance" }),
    baseAccount({ id: "younis-canonical", name: "Younis Khan", type: "partner" }),
    baseAccount({ id: "younis-labour", name: "Younis Khan", type: "partner", sourceType: "labour_finance" }),
    baseAccount({ id: "cash", name: "Cash", type: "cash" }),
  ];
  const vouchers = [purchaseVoucher({ id: "PV-sajid", accountId: "sajid-operational", amount: 113357 })];
  const canonicalPartnerPositions: CanonicalPartnerPosition[] = [
    { accountId: "sajid-labour", accountName: "Sajid Khan", farmOwesPartner: 102030, ledgerBalance: 102030, labourAdvancesPaid: 0, directLabourPayments: 102030, labourPayments: 102030, recoveries: 0, outstandingLabourAdvances: 0, appliedLabourAdvances: 0, entryCount: 1 },
    { accountId: "younis-canonical", accountName: "Younis Khan", farmOwesPartner: 199569.5, ledgerBalance: 199569.5, labourAdvancesPaid: 150881, directLabourPayments: 0, labourPayments: 0, recoveries: 0, outstandingLabourAdvances: 22946, appliedLabourAdvances: 127935, entryCount: 3 },
  ];

  const cards = buildPartnerStatusCards(accounts, vouchers, [], canonicalPartnerPositions).map((card) => card.position);

  // One card per partner name — never a duplicate, never a stray zero card.
  assert.equal(cards.length, 2);
  assert.equal(new Set(cards.map((card) => card.name)).size, 2);
  assert.equal(new Set(cards.map((card) => card.key)).size, cards.length);

  const sajid = cards.find((card) => card.name === "Sajid Khan");
  assert.ok(sajid);
  // Non-labour purchase voucher (113,357) + canonical direct labour (102,030) = 215,387.
  assert.equal(sajid!.currentPartnerBalance, 215387);
  assert.equal(sajid!.purchaseVouchersPaid, 113357);
  // The bare canonical position (102,030) must not survive as its own card.
  assert.ok(!cards.some((card) => card !== sajid && card.name === "Sajid Khan"));

  const younis = cards.find((card) => card.name === "Younis Khan");
  assert.ok(younis);
  assert.equal(younis!.currentPartnerBalance, 199569.5);
  assert.equal(younis!.outstandingLabourAdvances, 22946);
});

test("a single-account Partner Status filter resolves an alias id to the canonical card", () => {
  const accounts = [
    baseAccount({ id: "loan-canonical", name: "Loan", type: "partner" }),
    baseAccount({ id: "loan-alias", name: "Loan", type: "partner", sourceType: "labour_finance" }),
    baseAccount({ id: "other", name: "Saloom & Algaith", type: "partner" }),
  ];
  const canonicalPartnerPositions: CanonicalPartnerPosition[] = [
    { accountId: "loan-canonical", accountName: "Loan", farmOwesPartner: 120000, ledgerBalance: 120000, labourAdvancesPaid: 0, directLabourPayments: 0, labourPayments: 0, recoveries: 0, outstandingLabourAdvances: 0, appliedLabourAdvances: 0, entryCount: 1 },
    { accountId: "other", accountName: "Saloom & Algaith", farmOwesPartner: 5000, ledgerBalance: 5000, labourAdvancesPaid: 0, directLabourPayments: 0, labourPayments: 0, recoveries: 0, outstandingLabourAdvances: 0, appliedLabourAdvances: 0, entryCount: 1 },
  ];
  const accountLookup = buildAccountIdentityLookup(accounts);

  const cards = buildPartnerStatusCards(accounts, [], [], canonicalPartnerPositions);
  const loanCard = cards.find((card) => card.position.name === "Loan");
  assert.ok(loanCard);
  assert.equal(loanCard!.position.key, "loan-canonical");
  assert.ok(loanCard!.sourceAccountIds.includes("loan-alias"));

  // Selecting the alias id must resolve to the same canonical card, not an empty result.
  const selectedAccountId = "loan-alias";
  const selectedCanonicalId = resolveCanonicalAccountId(selectedAccountId, accountLookup) ?? selectedAccountId;
  const matched = cards.filter(({ position, sourceAccountIds }) => position.key === selectedCanonicalId
    || position.account?.id === selectedAccountId
    || sourceAccountIds.includes(selectedAccountId));
  assert.equal(matched.length, 1);
  assert.equal(matched[0]?.position.key, "loan-canonical");
});

test("Reports.tsx groups partner cards by canonical account id, not raw ids", () => {
  const source = readFileSync(new URL("../src/pages/workspace/Reports.tsx", import.meta.url), "utf8");
  assert.match(source, /buildCanonicalDisplayAccounts\(accounts, accountLookup, canonicalPartnerPositions\)/);
  assert.match(source, /aggregatePartnerLiabilityPositions\(/);
  // The buggy raw-id represented-account append must be gone.
  assert.doesNotMatch(source, /buildCanonicalPartnerLiabilityPosition/);
  assert.doesNotMatch(source, /representedAccountIds/);
});
