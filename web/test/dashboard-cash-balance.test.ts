import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateDisplayedAccountBalance, calculateScopedCashAccountBalance, type CanonicalAccountBalanceEntry } from "../src/lib/accounting";
import type { Account, Advance, LabourWageSettlement, PartnerEntry, Sale, Voucher } from "../src/lib/offline-db";

const baseRecord = {
  workspaceId: "workspace-1",
  createdAt: "2026-07-21T09:00:00.000Z",
  updatedAt: "2026-07-21T09:00:00.000Z",
};

const makeAccount = (id: string, type: Account["type"], name: string): Account => ({
  id,
  name,
  type,
  ...baseRecord,
});

const accounts: Account[] = [
  makeAccount("cash-1", "cash", "Cash"),
  makeAccount("bank-1", "bank", "Bank"),
  makeAccount("partner-1", "partner", "Partner"),
];

const sales: Sale[] = [];
const vouchers: Voucher[] = [];
const advances: Advance[] = [];
const entries: PartnerEntry[] = [];
const settlements: LabourWageSettlement[] = [];

test("scoped dashboard cash balance only uses cash accounts and canonical entries linked to those cash accounts", () => {
  const canonicalEntries: CanonicalAccountBalanceEntry[] = [
    { accountId: "cash-1", balanceEffect: 1200 },
    { accountId: "bank-1", balanceEffect: 800 },
  ];

  assert.equal(
    calculateScopedCashAccountBalance(
      accounts,
      sales,
      vouchers,
      advances,
      entries,
      settlements,
      canonicalEntries,
      { farmId: "farm-1", seasonId: "season-1" },
    ),
    1200,
  );
});

test("displayed account balance matches local account balance plus canonical account entries for the same account only", () => {
  const canonicalEntries: CanonicalAccountBalanceEntry[] = [
    { accountId: "cash-1", balanceEffect: 300 },
    { accountId: "bank-1", balanceEffect: 700 },
  ];

  assert.equal(
    calculateDisplayedAccountBalance(
      accounts[0],
      sales,
      vouchers,
      advances,
      entries,
      settlements,
      accounts,
      canonicalEntries,
      { farmId: "farm-1", seasonId: "season-1" },
    ),
    300,
  );
});
