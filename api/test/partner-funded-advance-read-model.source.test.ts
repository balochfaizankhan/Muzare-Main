import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path: string) => readFile(new URL(`../src/${path}`, import.meta.url), "utf8");

test("canonical partner read model retains missing original advance events and keeps applications informational", async () => {
  const readModel = await source("lib/labour-financial-read-model.ts");
  assert.match(readModel, /missingOriginalAdvanceEntries/);
  assert.match(readModel, /amount: advance\.originalAmount/);
  assert.match(readModel, /!transactionBackedAdvanceVoucherIds\.has\(advance\.canonicalVoucherId\)/);
  assert.match(readModel, /economicNature: "ADVANCE_APPLICATION"/);
  assert.match(readModel, /balanceEffect: 0/);
  assert.match(readModel, /fundingSources/);
  assert.match(readModel, /expenseAccountAttributions/);
  assert.match(readModel, /const farmOwesPartner = amount\(ledger\.reduce\(\(sum, entry\) => sum \+ entry\.balanceEffect, 0\)\)/);
});

test("expense report includes canonical labour attribution in By Account without adding another expense", async () => {
  const reports = await readFile(new URL("../../web/src/pages/workspace/Reports.tsx", import.meta.url), "utf8");
  assert.match(reports, /canonicalExpenseAccountRows/);
  assert.match(reports, /for \(const item of canonicalExpenseAccountRows\)/);
  assert.match(reports, /expenseAccountTotals\.map/);
  assert.match(reports, /totalRecognizedExpenses = voucherRows\.reduce[\s\S]*canonicalExpenseRows\.reduce/);
  assert.doesNotMatch(reports, /totalRecognizedExpenses[\s\S]{0,160}canonicalExpenseAccountRows\.reduce/);
});
