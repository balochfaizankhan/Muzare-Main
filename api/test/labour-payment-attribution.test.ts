import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { buildLabourPaymentEntries, summarizeLabourPaymentsByAccount } from "../src/lib/labour-financial-read-model.ts";

const source = (relativePath: string) => readFile(new URL(`../../${relativePath}`, import.meta.url), "utf8");

const baseExpense = (overrides: Partial<{
  dueId: string; dueNumber: string | null; recipientScope: string | null; recipientName: string;
  date: string; status: string; amount: number; paidAmount: number; appliedAdvanceAmount: number; active: boolean;
}>) => ({
  dueId: "due-1",
  dueNumber: "DUE-0001",
  recipientScope: "INDIVIDUAL",
  recipientName: "Worker A",
  date: "2026-07-01",
  status: "PAID",
  amount: 0,
  paidAmount: 0,
  appliedAdvanceAmount: 0,
  active: true,
  ...overrides,
});

test("direct-only labour payment is attributed to the account that actually paid the direct amount", () => {
  const entries = buildLabourPaymentEntries({
    expenses: [baseExpense({ dueId: "due-1", amount: 1000, paidAmount: 1000, appliedAdvanceAmount: 0 })],
    allocations: [{ dueId: "due-1", status: "ACTIVE", amount: 1000, voucherId: "v-direct-1" }],
    applications: [],
    voucherById: new Map([["v-direct-1", { id: "v-direct-1", voucherNumber: "LPV-0001", voucherDate: "2026-07-01", status: "POSTED" }]]),
    fundingByVoucherId: new Map([["v-direct-1", { accountId: "acc-A", accountName: "Partner A" }]]),
    advanceByVoucherId: new Map(),
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.directPayments.length, 1);
  assert.equal(entries[0]?.directPayments[0]?.accountId, "acc-A");
  assert.equal(entries[0]?.directPayments[0]?.amount, 1000);
  assert.equal(entries[0]?.appliedAdvances.length, 0);
  assert.equal(entries[0]?.grossAmount, 1000);
  assert.deepEqual([...summarizeLabourPaymentsByAccount(entries).entries()], [["acc-A", 1000]]);
});

test("advance-only labour payment is attributed to the account that originally funded the advance", () => {
  const entries = buildLabourPaymentEntries({
    expenses: [baseExpense({ dueId: "due-2", amount: 500, paidAmount: 0, appliedAdvanceAmount: 500 })],
    allocations: [],
    applications: [{ dueId: "due-2", status: "ACTIVE", amount: 500, advanceVoucherId: "adv-1" }],
    voucherById: new Map(),
    fundingByVoucherId: new Map(),
    advanceByVoucherId: new Map([["adv-1", { voucherNumber: "ADV-0001", voucherDate: "2026-06-01", fundingAccountId: "acc-B", paymentSourceDisplayName: "Partner B" }]]),
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.directPayments.length, 0);
  assert.equal(entries[0]?.appliedAdvances.length, 1);
  assert.equal(entries[0]?.appliedAdvances[0]?.accountId, "acc-B");
  assert.equal(entries[0]?.appliedAdvances[0]?.amount, 500);
  assert.deepEqual([...summarizeLabourPaymentsByAccount(entries).entries()], [["acc-B", 500]]);
});

test("mixed direct and advance payment splits ownership between the payer and the original advance funder", () => {
  const entries = buildLabourPaymentEntries({
    expenses: [baseExpense({ dueId: "due-3", amount: 500, paidAmount: 300, appliedAdvanceAmount: 200 })],
    allocations: [{ dueId: "due-3", status: "ACTIVE", amount: 300, voucherId: "v-3" }],
    applications: [{ dueId: "due-3", status: "ACTIVE", amount: 200, advanceVoucherId: "adv-3" }],
    voucherById: new Map([["v-3", { id: "v-3", voucherNumber: "LPV-0003", voucherDate: "2026-07-03", status: "POSTED" }]]),
    fundingByVoucherId: new Map([["v-3", { accountId: "acc-A", accountName: "Partner A" }]]),
    advanceByVoucherId: new Map([["adv-3", { voucherNumber: "ADV-0003", voucherDate: "2026-06-03", fundingAccountId: "acc-B", paymentSourceDisplayName: "Partner B" }]]),
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.grossAmount, 500);
  assert.equal(entries[0]?.directPayments[0]?.accountId, "acc-A");
  assert.equal(entries[0]?.directPayments[0]?.amount, 300);
  assert.equal(entries[0]?.appliedAdvances[0]?.accountId, "acc-B");
  assert.equal(entries[0]?.appliedAdvances[0]?.amount, 200);
  const totals = summarizeLabourPaymentsByAccount(entries);
  assert.equal(totals.get("acc-A"), 300);
  assert.equal(totals.get("acc-B"), 200);
});

test("one voucher/due funded by advances from different partners is split across both funding owners, not assigned to the settler", () => {
  const entries = buildLabourPaymentEntries({
    expenses: [baseExpense({ dueId: "due-4", amount: 700, paidAmount: 0, appliedAdvanceAmount: 700 })],
    allocations: [],
    applications: [
      { dueId: "due-4", status: "ACTIVE", amount: 300, advanceVoucherId: "adv-4a" },
      { dueId: "due-4", status: "ACTIVE", amount: 400, advanceVoucherId: "adv-4b" },
    ],
    voucherById: new Map(),
    fundingByVoucherId: new Map(),
    advanceByVoucherId: new Map([
      ["adv-4a", { voucherNumber: "ADV-0004A", voucherDate: "2026-06-04", fundingAccountId: "acc-A", paymentSourceDisplayName: "Partner A" }],
      ["adv-4b", { voucherNumber: "ADV-0004B", voucherDate: "2026-06-05", fundingAccountId: "acc-C", paymentSourceDisplayName: "Partner C" }],
    ]),
  });

  assert.equal(entries[0]?.appliedAdvances.length, 2);
  const totals = summarizeLabourPaymentsByAccount(entries);
  assert.equal(totals.get("acc-A"), 300);
  assert.equal(totals.get("acc-C"), 400);
  assert.equal(totals.get("acc-B"), undefined);
});

test("an advance that has not yet been applied never appears in Labour Payments", () => {
  const entries = buildLabourPaymentEntries({
    expenses: [baseExpense({ dueId: "due-5", amount: 0, paidAmount: 0, appliedAdvanceAmount: 0 })],
    allocations: [],
    applications: [],
    voucherById: new Map(),
    fundingByVoucherId: new Map(),
    advanceByVoucherId: new Map([["adv-5", { voucherNumber: "ADV-0005", voucherDate: "2026-06-06", fundingAccountId: "acc-A", paymentSourceDisplayName: "Partner A" }]]),
  });

  assert.equal(entries.length, 0);
  assert.equal(summarizeLabourPaymentsByAccount(entries).size, 0);
});

test("an unpaid labour due (no direct payment and no applied advance) is excluded", () => {
  const entries = buildLabourPaymentEntries({
    expenses: [baseExpense({ dueId: "due-6", status: "UNPAID", amount: 0, paidAmount: 0, appliedAdvanceAmount: 0, active: true })],
    allocations: [],
    applications: [],
    voucherById: new Map(),
    fundingByVoucherId: new Map(),
    advanceByVoucherId: new Map(),
  });

  assert.equal(entries.length, 0);
});

test("a voided payment (reversed allocation) is excluded even if a stale gross amount is present", () => {
  const entries = buildLabourPaymentEntries({
    expenses: [baseExpense({ dueId: "due-7", amount: 1000, paidAmount: 1000, appliedAdvanceAmount: 0 })],
    allocations: [{ dueId: "due-7", status: "REVERSED", amount: 1000, voucherId: "v-7" }],
    applications: [],
    voucherById: new Map([["v-7", { id: "v-7", voucherNumber: "LPV-0007", voucherDate: "2026-07-07", status: "VOIDED" }]]),
    fundingByVoucherId: new Map([["v-7", { accountId: "acc-A", accountName: "Partner A" }]]),
    advanceByVoucherId: new Map(),
  });

  assert.equal(entries[0]?.directPayments.length, 0, "a REVERSED allocation must never be attributed to any funding owner");
  assert.equal(summarizeLabourPaymentsByAccount(entries).get("acc-A"), undefined);
});

test("a voided due (inactive) is excluded from Labour Payments entirely", () => {
  const entries = buildLabourPaymentEntries({
    expenses: [baseExpense({ dueId: "due-7b", status: "VOIDED", amount: 1000, paidAmount: 1000, appliedAdvanceAmount: 0, active: false })],
    allocations: [{ dueId: "due-7b", status: "ACTIVE", amount: 1000, voucherId: "v-7b" }],
    applications: [],
    voucherById: new Map([["v-7b", { id: "v-7b", voucherNumber: "LPV-0007B", voucherDate: "2026-07-07", status: "POSTED" }]]),
    fundingByVoucherId: new Map([["v-7b", { accountId: "acc-A", accountName: "Partner A" }]]),
    advanceByVoucherId: new Map(),
  });

  assert.equal(entries.length, 0);
});

test("Outstanding Labour Advances is computed from advance positions independently of Labour Payments attribution", async () => {
  const readModel = await source("api/src/lib/labour-financial-read-model.ts");
  assert.match(
    readModel,
    /const outstandingLabourAdvances = amount\(advancePositions\.filter\(\(advance\) => advance\.partnerId === account\.id\)\.reduce\(\(sum, advance\) => sum \+ advance\.outstandingAmount, 0\)\)/,
    "outstandingLabourAdvances must still be summed straight from advancePositions.outstandingAmount (original minus applied minus recovered), untouched by the new Labour Payments attribution",
  );
  const outstandingAmount = (originalAmount: number, appliedAmount: number, recoveredAmount: number) => Math.max(originalAmount - appliedAmount - recoveredAmount, 0);
  assert.equal(outstandingAmount(1000, 0, 0), 1000);
  assert.equal(outstandingAmount(1000, 400, 0), 600, "applying an advance must reduce its outstanding balance");
});

test("applied advances feed Labour Payments as an additive display total, never folded back into Farm Owes Partner", async () => {
  const readModel = await source("api/src/lib/labour-financial-read-model.ts");
  assert.match(
    readModel,
    /const farmOwesPartner = amount\(ledger\.reduce\(\(sum, entry\) => sum \+ entry\.balanceEffect, 0\)\)/,
    "farmOwesPartner must remain a straight sum of ledger balanceEffect, unmodified by the new Labour Payments column",
  );
  assert.match(
    readModel,
    /const partnerPositionsWithLabourPayments = partnerPositions\.map\(\(position\) => \(\{\s*\.\.\.position,\s*labourPayments: amount\(labourPaymentsByAccount\.get\(position\.accountId\) \?\? 0\),\s*\}\)\);/,
    "labourPayments must be spread onto the existing position as an additive field, not merged into farmOwesPartner itself",
  );
  assert.match(readModel, /balanceEffect: 0,[\s\S]{0,120}economicNature: "ADVANCE_APPLICATION" as const,/, "advance-application audit entries must keep a zero balance effect so Farm Owes Partner is not double-counted");
});

test("partner rows remain isolated: each account's Labour Payments total reflects only its own attributed parts across multiple dues", () => {
  const entriesA = buildLabourPaymentEntries({
    expenses: [baseExpense({ dueId: "due-8a", amount: 500, paidAmount: 300, appliedAdvanceAmount: 200 })],
    allocations: [{ dueId: "due-8a", status: "ACTIVE", amount: 300, voucherId: "v-8a" }],
    applications: [{ dueId: "due-8a", status: "ACTIVE", amount: 200, advanceVoucherId: "adv-8a" }],
    voucherById: new Map([["v-8a", { id: "v-8a", voucherNumber: "LPV-0008A", voucherDate: "2026-07-08", status: "POSTED" }]]),
    fundingByVoucherId: new Map([["v-8a", { accountId: "acc-A", accountName: "Partner A" }]]),
    advanceByVoucherId: new Map([["adv-8a", { voucherNumber: "ADV-0008A", voucherDate: "2026-06-08", fundingAccountId: "acc-B", paymentSourceDisplayName: "Partner B" }]]),
  });
  const entriesB = buildLabourPaymentEntries({
    expenses: [baseExpense({ dueId: "due-8b", amount: 400, paidAmount: 0, appliedAdvanceAmount: 400 })],
    allocations: [],
    applications: [{ dueId: "due-8b", status: "ACTIVE", amount: 400, advanceVoucherId: "adv-8b" }],
    voucherById: new Map(),
    fundingByVoucherId: new Map(),
    advanceByVoucherId: new Map([["adv-8b", { voucherNumber: "ADV-0008B", voucherDate: "2026-06-09", fundingAccountId: "acc-C", paymentSourceDisplayName: "Partner C" }]]),
  });

  const totals = summarizeLabourPaymentsByAccount([...entriesA, ...entriesB]);
  assert.equal(totals.get("acc-A"), 300);
  assert.equal(totals.get("acc-B"), 200);
  assert.equal(totals.get("acc-C"), 400);
  assert.equal(totals.size, 3, "no cross-contamination between partner rows");
});
