import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { buildSyntheticVoucherAccountEntry, coalesceInFlight, shouldIncludeExpenseVisibilityRow } from "../src/lib/labour-financial-read-model.js";

const readModelSource = readFileSync(new URL("../src/lib/labour-financial-read-model.ts", import.meta.url), "utf8");

test("partner-funded direct labour payments can be backfilled into the partner ledger exactly once when the voucher exists without an account transaction", () => {
  const entry = buildSyntheticVoucherAccountEntry({
    voucher: {
      id: "voucher-1",
      voucherNumber: "LPV-0007",
      sourceId: "source-1",
      legacySourceRecordId: null,
      voucherDate: "2026-07-22",
      nature: "DIRECT_LABOUR_PAYMENT",
      status: "POSTED",
      description: "Payment for LD-0007",
      recipientScope: "INDIVIDUAL",
      labourerId: "labourer-1",
      labourGroupId: null,
      paymentAmount: "102030.00",
      legacy: false,
    },
    account: {
      id: "partner-sajid",
      name: "Sajid Khan",
      accountType: "partner",
    },
    recipientName: "Worker One",
  });

  assert.equal(entry.accountId, "partner-sajid");
  assert.equal(entry.transactionType, "credit");
  assert.equal(entry.balanceEffect, 102030);
  assert.equal(entry.economicNature, "DIRECT_LABOUR_PAYMENT");
  assert.equal(entry.amount, 102030);
  assert.equal(entry.recipientName, "Worker One");
});

test("reversal backfill inverts the missing funding entry for the same voucher source", () => {
  const entry = buildSyntheticVoucherAccountEntry({
    voucher: {
      id: "voucher-2",
      voucherNumber: "LPV-0008-R",
      sourceId: "source-2",
      legacySourceRecordId: null,
      voucherDate: "2026-07-22",
      nature: "REVERSAL",
      status: "POSTED",
      description: "Reverse LPV-0008",
      recipientScope: "INDIVIDUAL",
      labourerId: "labourer-1",
      labourGroupId: null,
      paymentAmount: "102030.00",
      legacy: false,
    },
    account: {
      id: "partner-sajid",
      name: "Sajid Khan",
      accountType: "partner",
    },
    recipientName: "Worker One",
    economicNature: "DIRECT_LABOUR_PAYMENT",
    reverse: true,
  });

  assert.equal(entry.transactionType, "debit");
  assert.equal(entry.balanceEffect, -102030);
  assert.equal(entry.economicNature, "DIRECT_LABOUR_PAYMENT");
});

test("expense visibility keeps active unpaid dues even before any settlement amount is recognized", () => {
  assert.equal(shouldIncludeExpenseVisibilityRow({ amount: 0, outstandingAmount: 38608, active: true }), true);
  assert.equal(shouldIncludeExpenseVisibilityRow({ amount: 0, outstandingAmount: 0, active: false }), false);
});

test("loadLabourFinancialReadModel is wired through the real coalesceInFlight helper (not a private copy of it)", () => {
  assert.match(readModelSource, /async function loadLabourFinancialReadModelUncached\(/, "the real query fan-out must be split out from the exported dedup wrapper");
  assert.match(
    readModelSource,
    /export function loadLabourFinancialReadModel\(input: \{ workspaceId: string; farmId: string; seasonId: string \}\) \{\s*\n\s*const key = `\$\{input\.workspaceId\}:\$\{input\.farmId\}:\$\{input\.seasonId\}`;\s*\n\s*return coalesceInFlight\(inFlightLoads, key, \(\) => loadLabourFinancialReadModelUncached\(input\)\);/,
    "the exported entry point must delegate to coalesceInFlight keyed on workspaceId+farmId+seasonId, not reimplement its own map/finally logic",
  );
});

// coalesceInFlight is the exact, exported helper loadLabourFinancialReadModel calls above.
// These tests exercise the real function with a fake counting factory — no DB/network — so
// they prove the actual coalescing behavior, not a re-implementation of it.
test("backend coalescing: five simultaneous calls with the same key invoke the factory exactly once and all five settle to the same result", async () => {
  const cache = new Map<string, Promise<{ id: number }>>();
  let invocations = 0;
  const factory = () => {
    invocations += 1;
    return new Promise<{ id: number }>((resolve) => setTimeout(() => resolve({ id: invocations }), 5));
  };
  const calls = Array.from({ length: 5 }, () => coalesceInFlight(cache, "ws:farm:season", factory));
  const results = await Promise.all(calls);
  assert.equal(invocations, 1, "the underlying computation must run exactly once for five concurrent identical-key calls");
  for (const result of results) assert.equal(result, results[0], "every caller must receive the identical resolved value/reference — no copying or recomputation");
});

test("backend coalescing: the in-flight entry is removed after resolution so it is not retained", async () => {
  const cache = new Map<string, Promise<string>>();
  const first = coalesceInFlight(cache, "scope-a", async () => "ok");
  assert.equal(cache.size, 1, "the entry must exist while the call is pending");
  await first;
  assert.equal(cache.size, 0, "a completed (resolved) result must not be retained in the map");
});

test("backend coalescing: the in-flight entry is removed after rejection, and the next call for that key runs fresh and can succeed", async () => {
  const cache = new Map<string, Promise<string>>();
  let attempt = 0;
  const factory = () => {
    attempt += 1;
    return attempt === 1 ? Promise.reject(new Error("transient failure")) : Promise.resolve("recovered");
  };
  await assert.rejects(() => coalesceInFlight(cache, "scope-b", factory), /transient failure/);
  assert.equal(cache.size, 0, "a rejected result must not be retained in the map");
  const recovered = await coalesceInFlight(cache, "scope-b", factory);
  assert.equal(recovered, "recovered", "a later request after a rejection must run the factory again and can succeed");
  assert.equal(attempt, 2, "the retried call must be a fresh factory invocation, not the rejected promise reused");
});

test("backend coalescing: different workspace/farm/season keys never share a computation", async () => {
  const cache = new Map<string, Promise<string>>();
  let invocations = 0;
  const factory = () => {
    invocations += 1;
    return Promise.resolve(`result-${invocations}`);
  };
  const [a, b, c] = await Promise.all([
    coalesceInFlight(cache, "ws1:farmA:seasonX", factory),
    coalesceInFlight(cache, "ws1:farmB:seasonX", factory),
    coalesceInFlight(cache, "ws2:farmA:seasonX", factory),
  ]);
  assert.equal(invocations, 3, "distinct scope keys must each run their own computation");
  assert.notEqual(a, b);
  assert.notEqual(b, c);
});
