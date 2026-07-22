import assert from "node:assert/strict";
import { test } from "node:test";
import { buildLabourPaymentEntries, summarizeLabourPaymentsByAccount } from "../src/lib/labour-financial-read-model.ts";

const baseExpense = (overrides: Partial<{
  dueId: string; dueNumber: string | null; recipientScope: string | null; recipientName: string;
  date: string; status: string; amount: number; paidAmount: number; appliedAdvanceAmount: number; active: boolean;
}>) => ({
  dueId: "due-pooled-1",
  dueNumber: "DUE-9001",
  recipientScope: "INDIVIDUAL",
  recipientName: "Worker Pooled",
  date: "2026-07-01",
  status: "PARTIALLY_SETTLED",
  amount: 0,
  paidAmount: 0,
  appliedAdvanceAmount: 0,
  active: true,
  ...overrides,
});

test("a pooled advance application (advanceVoucherId null) is excluded from partner Labour Payments attribution rather than misattributed", () => {
  const entries = buildLabourPaymentEntries({
    expenses: [baseExpense({ amount: 7108, paidAmount: 0, appliedAdvanceAmount: 7108 })],
    allocations: [],
    applications: [{ dueId: "due-pooled-1", status: "ACTIVE", amount: 7108, advanceVoucherId: null }],
    voucherById: new Map(),
    fundingByVoucherId: new Map(),
    advanceByVoucherId: new Map([["some-historical-voucher", { voucherNumber: "ADV-0001", voucherDate: "2026-01-01", fundingAccountId: "acc-A", paymentSourceDisplayName: "Partner A" }]]),
  });

  assert.equal(entries.length, 1, "the due still appears (it has an applied amount)");
  assert.equal(entries[0]?.appliedAdvances.length, 0, "a pooled application has no determinable single funding owner and must not appear as an attributed line");
  assert.equal(entries[0]?.appliedAdvanceAmount, 7108, "the due's gross applied-advance total is unaffected by attribution exclusion");
  assert.equal(summarizeLabourPaymentsByAccount(entries).size, 0, "no partner's Labour Payments total is inflated or fabricated for a pooled application");
});

test("a mix of one pooled application and one legacy per-voucher application on different dues still attributes only the per-voucher one", () => {
  const entries = buildLabourPaymentEntries({
    expenses: [
      baseExpense({ dueId: "due-pooled-2", amount: 500, paidAmount: 0, appliedAdvanceAmount: 500 }),
      baseExpense({ dueId: "due-legacy-2", amount: 300, paidAmount: 0, appliedAdvanceAmount: 300 }),
    ],
    allocations: [],
    applications: [
      { dueId: "due-pooled-2", status: "ACTIVE", amount: 500, advanceVoucherId: null },
      { dueId: "due-legacy-2", status: "ACTIVE", amount: 300, advanceVoucherId: "adv-legacy-2" },
    ],
    voucherById: new Map(),
    fundingByVoucherId: new Map(),
    advanceByVoucherId: new Map([["adv-legacy-2", { voucherNumber: "ADV-0002", voucherDate: "2026-01-02", fundingAccountId: "acc-B", paymentSourceDisplayName: "Partner B" }]]),
  });

  const pooledEntry = entries.find((entry) => entry.dueId === "due-pooled-2");
  const legacyEntry = entries.find((entry) => entry.dueId === "due-legacy-2");
  assert.equal(pooledEntry?.appliedAdvances.length, 0);
  assert.equal(legacyEntry?.appliedAdvances.length, 1);
  assert.equal(legacyEntry?.appliedAdvances[0]?.accountId, "acc-B");
  const totals = summarizeLabourPaymentsByAccount(entries);
  assert.equal(totals.get("acc-B"), 300);
  assert.equal(totals.get("acc-A"), undefined);
});
