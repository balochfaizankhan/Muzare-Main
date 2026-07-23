import assert from "node:assert/strict";
import { test } from "node:test";
import { isDashboardFinancialScope, settleDashboardFinancialSnapshot, type DashboardFinancialSnapshot } from "../src/lib/dashboardFinancialSnapshot";

const scope = {
  workspaceId: "workspace-1",
  farmId: "farm-1",
  seasonId: "season-1",
};

const settled = (overrides: Partial<DashboardFinancialSnapshot> = {}): DashboardFinancialSnapshot => ({
  ...scope,
  snapshotVersion: "v1",
  generatedAt: "2026-07-21T10:00:00.000Z",
  cashBalance: 102330,
  totalExpenses: 653619,
  outstandingLabourAdvances: 22263,
  outstandingLabourPayments: 45000,
  outstandingLabourPaymentsCount: 3,
  overdueLabourPaymentsCount: 1,
  ...overrides,
});

test("dashboard financial snapshot keeps the last settled values until canonical coverage is ready", () => {
  const previous = settled();
  const next = settleDashboardFinancialSnapshot({
    scope,
    previousSnapshot: previous,
    canonicalReady: false,
    generatedAt: "2026-07-21T10:01:00.000Z",
    canonicalVersion: "pending",
    financials: {
      cashBalance: 0,
      totalExpenses: 385046,
      outstandingLabourAdvances: 150198,
      outstandingLabourPayments: 90000,
      outstandingLabourPaymentsCount: 5,
      overdueLabourPaymentsCount: 2,
      inputVersion: "partial",
    },
  });
  assert.deepEqual(next, previous);
});

test("local-first then canonical-second and canonical-first then local-second converge to the same final dashboard totals", () => {
  const canonicalFinal = {
    cashBalance: 102330,
    totalExpenses: 653619,
    outstandingLabourAdvances: 22263,
    outstandingLabourPayments: 45000,
    outstandingLabourPaymentsCount: 3,
    overdueLabourPaymentsCount: 1,
    inputVersion: "accounts:expenses:labour",
  };
  const localFirst = settleDashboardFinancialSnapshot({
    scope,
    previousSnapshot: null,
    canonicalReady: false,
    generatedAt: "2026-07-21T10:02:00.000Z",
    canonicalVersion: "pending",
    financials: {
      cashBalance: 0,
      totalExpenses: 385046,
      outstandingLabourAdvances: 150198,
      outstandingLabourPayments: 90000,
      outstandingLabourPaymentsCount: 5,
      overdueLabourPaymentsCount: 2,
      inputVersion: "partial",
    },
  });
  const localThenCanonical = settleDashboardFinancialSnapshot({
    scope,
    previousSnapshot: localFirst,
    canonicalReady: true,
    generatedAt: "2026-07-21T10:03:00.000Z",
    canonicalVersion: "canonical-ready",
    financials: canonicalFinal,
  });
  const canonicalThenLocal = settleDashboardFinancialSnapshot({
    scope,
    previousSnapshot: settleDashboardFinancialSnapshot({
      scope,
      previousSnapshot: null,
      canonicalReady: true,
      generatedAt: "2026-07-21T10:03:00.000Z",
      canonicalVersion: "canonical-ready",
      financials: canonicalFinal,
    }),
    canonicalReady: false,
    generatedAt: "2026-07-21T10:04:00.000Z",
    canonicalVersion: "late-local",
    financials: {
      cashBalance: 0,
      totalExpenses: 385046,
      outstandingLabourAdvances: 150198,
      outstandingLabourPayments: 90000,
      outstandingLabourPaymentsCount: 5,
      overdueLabourPaymentsCount: 2,
      inputVersion: "late-partial",
    },
  });
  assert.deepEqual(localThenCanonical, canonicalThenLocal);
});

test("dashboard financial snapshot scope guard rejects a stale farm or season snapshot", () => {
  assert.equal(isDashboardFinancialScope(settled({ farmId: "farm-2" }), scope), false);
  assert.equal(isDashboardFinancialScope(settled(), scope), true);
});
