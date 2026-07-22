import assert from "node:assert/strict";
import test from "node:test";
import { buildCanonicalDisplayAccounts } from "../src/lib/accountDisplay.ts";
import { buildAccountIdentityLookup } from "../src/lib/accountIdentity.ts";
import type { Account } from "../src/lib/offline-db.ts";

const baseAccount = (overrides: Partial<Account> & Pick<Account, "id" | "name" | "type">): Account => ({
  id: overrides.id,
  workspaceId: "workspace-1",
  farmId: "farm-1",
  seasonId: "season-1",
  createdAt: "2026-07-22T00:00:00.000Z",
  updatedAt: "2026-07-22T00:00:00.000Z",
  name: overrides.name,
  type: overrides.type,
  oldAndroidId: overrides.oldAndroidId,
  sourceType: overrides.sourceType,
  deletedAt: overrides.deletedAt,
});

test("display accounts merge canonical partner rows and labour-finance duplicates into one partner card", () => {
  const accounts = [
    baseAccount({ id: "younis-canonical", name: "Younis Khan", type: "partner" }),
    baseAccount({ id: "younis-labour", name: "Younis Khan", type: "partner", sourceType: "labour_finance" }),
    baseAccount({ id: "sajid-canonical", name: "Sajid Khan", type: "partner" }),
    baseAccount({ id: "sajid-labour", name: "Sajid Khan", type: "partner", sourceType: "labour_finance" }),
  ];
  const canonicalPartnerPositions = [
    { accountId: "younis-canonical", accountName: "Younis Khan", farmOwesPartner: 199569.5, ledgerBalance: 199569.5, labourAdvancesPaid: 150881, directLabourPayments: 0, recoveries: 0, outstandingLabourAdvances: 22946, appliedLabourAdvances: 127935, entryCount: 3 },
    { accountId: "sajid-canonical", accountName: "Sajid Khan", farmOwesPartner: 215387, ledgerBalance: 215387, labourAdvancesPaid: 0, directLabourPayments: 102030, recoveries: 0, outstandingLabourAdvances: 0, appliedLabourAdvances: 0, entryCount: 2 },
  ];

  const result = buildCanonicalDisplayAccounts(accounts, buildAccountIdentityLookup(accounts), canonicalPartnerPositions);

  assert.equal(result.length, 2);
  assert.equal(result.find((item) => item.account.name === "Younis Khan")?.account.id, "younis-canonical");
  assert.deepEqual(result.find((item) => item.account.name === "Younis Khan")?.sourceAccountIds.sort(), ["younis-canonical", "younis-labour"]);
  assert.equal(result.find((item) => item.account.name === "Sajid Khan")?.account.id, "sajid-canonical");
  assert.deepEqual(result.find((item) => item.account.name === "Sajid Khan")?.sourceAccountIds.sort(), ["sajid-canonical", "sajid-labour"]);
});

test("zero-value synthetic partner duplicates are excluded when no real account row exists", () => {
  const accounts = [
    baseAccount({ id: "loan-real", name: "Loan", type: "partner" }),
  ];
  const canonicalPartnerPositions = [
    { accountId: "loan-real", accountName: "Loan", farmOwesPartner: 120000, ledgerBalance: 120000, labourAdvancesPaid: 0, directLabourPayments: 0, recoveries: 0, outstandingLabourAdvances: 0, appliedLabourAdvances: 0, entryCount: 1 },
    { accountId: "saloom-synthetic", accountName: "Saloom & Algaith", farmOwesPartner: 0, ledgerBalance: 0, labourAdvancesPaid: 0, directLabourPayments: 0, recoveries: 0, outstandingLabourAdvances: 0, appliedLabourAdvances: 0, entryCount: 0 },
  ];

  const result = buildCanonicalDisplayAccounts(accounts, buildAccountIdentityLookup(accounts), canonicalPartnerPositions);

  assert.equal(result.length, 1);
  assert.equal(result[0]?.account.name, "Loan");
});
