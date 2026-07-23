import assert from "node:assert/strict";
import { test } from "node:test";
import { buildLabourPaymentEntries, summarizeLabourPaymentsByAccount } from "../src/lib/labour-financial-read-model.ts";

const baseExpense = (overrides: Partial<{
  dueId: string; dueNumber: string | null; recipientScope: string | null; recipientName: string;
  date: string; status: string; amount: number; paidAmount: number; appliedAdvanceAmount: number; active: boolean;
}>) => ({
  dueId: "due-group-1",
  dueNumber: "DUE-9100",
  recipientScope: "LABOUR_GROUP",
  recipientName: "Group Pooled",
  date: "2026-07-01",
  status: "PARTIALLY_SETTLED",
  amount: 0,
  paidAmount: 0,
  appliedAdvanceAmount: 0,
  active: true,
  ...overrides,
});

const advanceByVoucherId = new Map([
  ["adv-partner-a", { voucherNumber: "LAV-0001", voucherDate: "2026-06-01", fundingAccountId: "acc-partner-a", paymentSourceDisplayName: "Partner A" }],
  ["adv-partner-b", { voucherNumber: "LAV-0002", voucherDate: "2026-06-02", fundingAccountId: "acc-partner-b", paymentSourceDisplayName: "Partner B" }],
  ["adv-cash", { voucherNumber: "LAV-0003", voucherDate: "2026-06-03", fundingAccountId: "acc-cash", paymentSourceDisplayName: "Cash" }],
]);

test("a pooled application with persisted source allocations attributes each portion to the original funding owner", () => {
  const entries = buildLabourPaymentEntries({
    expenses: [baseExpense({ amount: 9_000, appliedAdvanceAmount: 9_000 })],
    allocations: [],
    applications: [{
      dueId: "due-group-1", status: "ACTIVE", amount: 9_000, advanceVoucherId: null,
      sources: [
        { advanceVoucherId: "adv-partner-a", amount: 4_000 },
        { advanceVoucherId: "adv-partner-b", amount: 3_500 },
        { advanceVoucherId: "adv-cash", amount: 1_500 },
      ],
    }],
    voucherById: new Map(),
    fundingByVoucherId: new Map(),
    advanceByVoucherId,
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.appliedAdvances.length, 3, "every consumed advance appears as its own attributed line");
  const totals = summarizeLabourPaymentsByAccount(entries);
  assert.equal(totals.get("acc-partner-a"), 4_000, "Partner A keeps ownership of the portion drawn from their advance");
  assert.equal(totals.get("acc-partner-b"), 3_500, "Partner B keeps ownership of the portion drawn from their advance");
  assert.equal(totals.get("acc-cash"), 1_500);
  assert.equal([...totals.values()].reduce((sum, value) => sum + value, 0), 9_000, "nothing is dropped and nothing is assigned to a payment account that did not fund it");
});

test("a pooled application that predates the source ledger keeps the previous behaviour: excluded, never misattributed", () => {
  const entries = buildLabourPaymentEntries({
    expenses: [baseExpense({ amount: 7_108, appliedAdvanceAmount: 7_108 })],
    allocations: [],
    applications: [{ dueId: "due-group-1", status: "ACTIVE", amount: 7_108, advanceVoucherId: null }],
    voucherById: new Map(),
    fundingByVoucherId: new Map(),
    advanceByVoucherId,
  });
  assert.equal(entries[0]?.appliedAdvances.length, 0);
  assert.equal(summarizeLabourPaymentsByAccount(entries).size, 0);
});

test("a reversed pooled application contributes nothing even though its source allocations remain on record", () => {
  const entries = buildLabourPaymentEntries({
    expenses: [baseExpense({ amount: 5_000, appliedAdvanceAmount: 0 })],
    allocations: [],
    applications: [{
      dueId: "due-group-1", status: "REVERSED", amount: 5_000, advanceVoucherId: null,
      sources: [{ advanceVoucherId: "adv-partner-a", amount: 5_000 }],
    }],
    voucherById: new Map(),
    fundingByVoucherId: new Map(),
    advanceByVoucherId,
  });
  assert.equal(entries.length, 0, "a due with no active paid or applied amount does not appear");
});
