import assert from "node:assert/strict";
import { test } from "node:test";
import { eligiblePaymentAccounts, isSyntheticLocalAccount } from "../src/components/PaymentAccountSelect";

const cash = { id: "acct-cash", name: "Cash", type: "cash" };
const bank = { id: "acct-bank", name: "Bank", type: "bank" };
const partner = { id: "acct-partner", name: "Partner Co", type: "partner" };
const deletedBank = { id: "acct-deleted", name: "Old Bank", type: "bank", deletedAt: "2026-01-01T00:00:00.000Z" };
const syntheticCash = { id: "season-1:local-cash", name: "Cash", type: "cash" };

test("isSyntheticLocalAccount only flags seeded local placeholder ids", () => {
  assert.equal(isSyntheticLocalAccount("season-1:local-cash"), true);
  assert.equal(isSyntheticLocalAccount("season-1:local-partner"), true);
  assert.equal(isSyntheticLocalAccount("acct-cash"), false);
  assert.equal(isSyntheticLocalAccount(undefined), false);
  assert.equal(isSyntheticLocalAccount(null), false);
});

test("eligiblePaymentAccounts excludes synthetic placeholder accounts and soft-deleted accounts by default", () => {
  const result = eligiblePaymentAccounts([cash, bank, partner, deletedBank, syntheticCash]);
  assert.deepEqual(result.map((account) => account.id), ["acct-cash", "acct-bank", "acct-partner"]);
});

test("eligiblePaymentAccounts preserves a deactivated account only when it is the one already selected on the record being edited", () => {
  const withoutHistoricalPreservation = eligiblePaymentAccounts([cash, bank, deletedBank]);
  assert.equal(withoutHistoricalPreservation.some((account) => account.id === "acct-deleted"), false);

  const editingThatRecord = eligiblePaymentAccounts([cash, bank, deletedBank], { alsoIncludeId: "acct-deleted" });
  assert.equal(editingThatRecord.some((account) => account.id === "acct-deleted"), true);
  // A brand new selection must still exclude it — the exception is scoped to the one historical
  // record whose accountId is being preserved, not a general reactivation.
  const differentNewEntry = eligiblePaymentAccounts([cash, bank, deletedBank], { alsoIncludeId: "acct-bank" });
  assert.equal(differentNewEntry.some((account) => account.id === "acct-deleted"), false);
});

test("eligiblePaymentAccounts can restrict by account type (e.g. cash/bank only, excluding partner)", () => {
  const result = eligiblePaymentAccounts([cash, bank, partner], { types: ["cash", "bank"] });
  assert.deepEqual(result.map((account) => account.id).sort(), ["acct-bank", "acct-cash"]);
});

test("a fully eligible list is returned unchanged (no accidental mutation or reordering)", () => {
  const input = [cash, bank, partner];
  const result = eligiblePaymentAccounts(input);
  assert.deepEqual(result, input);
});
