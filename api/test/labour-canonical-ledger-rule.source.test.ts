import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = (relativePath: string) => readFile(new URL(`../../${relativePath}`, import.meta.url), "utf8");

// Canonical Muzare rule: an approved labour due recognizes labour expense at
// creation, whether or not it is yet paid. Settlement (direct payment or
// applied advance) only clears the payable it already created — it must
// never debit LABOUR_EXPENSE a second time. Commit 018f84d5 regressed this;
// these tests lock the restored behaviour in place.

test("due creation posts Dr LABOUR_EXPENSE / Cr LABOUR_PAYABLE", async () => {
  const labourPayments = await source("api/src/lib/labour-payments.ts");
  const fn = labourPayments.match(/export async function postLabourDueRecognition\([\s\S]*?\n\}\r?\n/);
  assert.ok(fn, "postLabourDueRecognition should exist");
  assert.doesNotMatch(fn![0], /void tx;\s*\n\s*void input;/, "postLabourDueRecognition must not be a no-op");
  assert.match(fn![0], /debitCode: "LABOUR_EXPENSE", creditCode: "LABOUR_PAYABLE"/);
  assert.match(fn![0], /eventType: "DUE_RECOGNITION"/);
});

test("advance application posts Dr LABOUR_PAYABLE / Cr LABOUR_ADVANCE, never LABOUR_EXPENSE", async () => {
  const labourPayments = await source("api/src/lib/labour-payments.ts");
  const single = labourPayments.match(/export async function postLabourAdvanceApplicationJournal\([\s\S]*?\n\}\r?\n/);
  assert.ok(single, "postLabourAdvanceApplicationJournal should exist");
  assert.match(single![0], /debitCode: "LABOUR_PAYABLE", creditCode: "LABOUR_ADVANCE"/);
  assert.doesNotMatch(single![0], /LABOUR_EXPENSE/);

  const batch = labourPayments.match(/export async function postLabourAdvanceApplicationJournals\([\s\S]*?onConflictDoNothing\(\);\s*\n\s*\}\s*\n\}/);
  assert.ok(batch, "postLabourAdvanceApplicationJournals should exist");
  assert.match(batch![0], /ledgerCode: "LABOUR_PAYABLE"/, "the pooled batch path must use the same corrected ledger codes as the single-application path");
  assert.doesNotMatch(batch![0], /LABOUR_EXPENSE/);
});

test("direct or partner-funded due payment debits LABOUR_PAYABLE, not LABOUR_EXPENSE", async () => {
  const labourPayments = await source("api/src/lib/labour-payments.ts");
  const fn = labourPayments.match(/export async function postLabourVoucherJournal\([\s\S]*?\n\}\r?\n/);
  assert.ok(fn, "postLabourVoucherJournal should exist");
  assert.match(fn![0], /eventType: "DUE_PAYMENT", debitCode: "LABOUR_PAYABLE", creditCode: cashCode/);
  assert.doesNotMatch(fn![0], /debitCode: "LABOUR_EXPENSE"/);
});

test("a pooled application does not require an individual advanceVoucherId (migration 0042, unchanged)", async () => {
  const schema = await source("api/src/db/schema.ts");
  assert.match(
    schema,
    /advanceVoucherId: uuid\("advance_voucher_id"\)\.references\(\(\) => labourPaymentVouchers\.id, \{ onDelete: "cascade" \}\),/,
    "advanceVoucherId must remain nullable so a pooled application (no single source voucher) can be persisted",
  );
});

test("advance-application and payment reversal use the generic ledger-agnostic reversal mechanism", async () => {
  const labourPayments = await source("api/src/lib/labour-payments.ts");
  const reverseFn = labourPayments.match(/export async function reverseLabourJournal\([\s\S]*?\n\}\r?\n/);
  assert.ok(reverseFn, "reverseLabourJournal should exist");
  // The reversal must swap whatever debit/credit the original used — it must
  // not hardcode LABOUR_EXPENSE/LABOUR_ADVANCE/LABOUR_PAYABLE, so it reverses
  // an advance-application pair (Dr Payable / Cr Advance) into its correct
  // inverse (Dr Advance / Cr Payable) and a due-recognition pair just as
  // correctly, without a separate code path per ledger code.
  assert.match(reverseFn![0], /debit: row\.credit, credit: row\.debit/);
  assert.doesNotMatch(reverseFn![0], /LABOUR_EXPENSE|LABOUR_PAYABLE|LABOUR_ADVANCE/);
});
