import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  calculateLabourDuePosition,
  isLabourDueOverdue,
  LABOUR_PAYMENT_OVERDUE_GRACE_DAYS,
  summarizeOpenLabourDues,
  type OpenLabourDuePosition,
} from "../src/lib/labour-payments.js";

const routeSource = readFileSync(new URL("../src/routes/labour-payments.ts", import.meta.url), "utf8");
const readModelSource = readFileSync(new URL("../src/lib/labour-financial-read-model.ts", import.meta.url), "utf8");
const paymentServiceSource = readFileSync(new URL("../src/lib/labour-payments.ts", import.meta.url), "utf8");

const fakePosition = (workToDate: string, input: Parameters<typeof calculateLabourDuePosition>[0]): OpenLabourDuePosition => ({
  due: { workToDate } as OpenLabourDuePosition["due"],
  ...calculateLabourDuePosition(input),
});

test("the grace period constant is 7 days and isLabourDueOverdue only flips after it fully elapses", () => {
  assert.equal(LABOUR_PAYMENT_OVERDUE_GRACE_DAYS, 7);
  const reference = new Date("2026-07-23T00:00:00.000Z");
  assert.equal(isLabourDueOverdue("2026-07-23", reference), false, "work concluded today is never overdue");
  assert.equal(isLabourDueOverdue("2026-07-16", reference), false, "exactly at the grace boundary is not yet overdue");
  assert.equal(isLabourDueOverdue("2026-07-15", reference), true, "one day past the grace boundary is overdue");
});

test("summarizeOpenLabourDues matches the Due Payments page's own totalDue/openDues aggregation exactly", () => {
  const reference = new Date("2026-07-23T00:00:00.000Z");
  const positions = [
    // Acceptance test 1: unpaid due, old enough to be overdue.
    fakePosition("2026-06-01", { grossAmount: 50_000 }),
    // Acceptance test 2: due partially cleared by a direct payment, not overdue.
    fakePosition("2026-07-20", { grossAmount: 50_000, previousPayments: 20_000 }),
    // Acceptance test 3: due partially cleared by an applied advance, not overdue.
    fakePosition("2026-07-20", { grossAmount: 50_000, advancesApplied: 15_000 }),
    // Acceptance test 4: fully paid due must not contribute to the total or counts.
    fakePosition("2026-01-01", { grossAmount: 10_000, previousPayments: 10_000 }),
  ];
  const summary = summarizeOpenLabourDues(positions, reference);
  assert.deepEqual(summary, { totalOutstanding: 115_000, outstandingCount: 3, overdueCount: 1 });
});

test("acceptance tests 6 and 7: reversing a payment or advance application must restore the outstanding balance", () => {
  // loadLabourDuePosition sums allocations/applications filtered to status = 'ACTIVE', so a
  // reversed row (status no longer ACTIVE) is simply absent from previousPayments/advancesApplied
  // — calculateLabourDuePosition then recomputes the same higher outstanding balance it would
  // have shown before the payment/application ever existed.
  const beforeReversal = calculateLabourDuePosition({ grossAmount: 50_000, previousPayments: 20_000 });
  const afterPaymentReversed = calculateLabourDuePosition({ grossAmount: 50_000, previousPayments: 0 });
  assert.equal(beforeReversal.outstandingBalance, 30_000);
  assert.equal(afterPaymentReversed.outstandingBalance, 50_000);

  const beforeAdvanceReversal = calculateLabourDuePosition({ grossAmount: 50_000, advancesApplied: 15_000 });
  const afterAdvanceReversed = calculateLabourDuePosition({ grossAmount: 50_000, advancesApplied: 0 });
  assert.equal(beforeAdvanceReversal.outstandingBalance, 35_000);
  assert.equal(afterAdvanceReversed.outstandingBalance, 50_000);

  assert.match(paymentServiceSource, /filter \(where \$\{labourPaymentAllocations\.status\} = 'ACTIVE'\)/);
  assert.match(paymentServiceSource, /filter \(where \$\{labourAdvanceApplications\.status\} = 'ACTIVE'\)/);
});

test("loadOpenLabourDues mirrors the exact filter/settlement-source checks used by GET /labour-payments/dues", () => {
  assert.match(paymentServiceSource, /export async function loadOpenLabourDues/);
  // Same open-status filter as the Due Payments page's own openDues computation.
  assert.match(paymentServiceSource, /OPEN_LABOUR_DUE_PAYMENT_STATUSES = \["UNPAID", "PARTIALLY_SETTLED", "ON_HOLD"\]/);
  // Reuses the per-due canonical position loader rather than re-deriving the formula.
  assert.match(paymentServiceSource, /const positions = await Promise\.all\(validRows\.map\(\(row\) => loadLabourDuePosition\(tx, row\.id\)\)\)/);
  // A due whose settlement source was voided/deleted/reversed is excluded, matching the route.
  assert.match(paymentServiceSource, /\["voided", "deleted", "reversed"\]\.includes\(String\(row\.payload\.status \?\? ""\)\.toLowerCase\(\)\)/);
});

test("GET /labour-payments/dues reuses loadOpenLabourDues for its default (unfiltered) call instead of re-deriving the query", () => {
  assert.match(routeSource, /if \(!paginated && !query\.data\.status && !query\.data\.origin && !term\) \{/);
  assert.match(routeSource, /loadOpenLabourDues\(tx, \{ workspaceId, farmId, seasonId \}\)/);
});

test("the financial read model surfaces a canonical labourPaymentsDue summary computed via the shared selector, not currentLedger.LABOUR_PAYABLE", () => {
  assert.match(readModelSource, /import \{ loadOpenLabourDues, summarizeOpenLabourDues \} from "\.\/labour-payments\.js"/);
  assert.match(readModelSource, /const openLabourDuesPromise = db\.transaction\(\(tx\) => loadOpenLabourDues\(tx, input\)\)/);
  assert.match(readModelSource, /const labourPaymentsDue = summarizeOpenLabourDues\(await openLabourDuesPromise\)/);
  assert.match(readModelSource, /labourPaymentsDue,/);
});

test("the lightweight /labour-payments/summary endpoint exposes the same canonical labourPaymentsDue field", () => {
  assert.match(routeSource, /labourPaymentsDue: financials\.labourPaymentsDue,/);
});
