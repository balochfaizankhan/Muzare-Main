import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const dashboard = readFileSync(new URL("../src/pages/DashboardPage.tsx", import.meta.url), "utf8");
const snapshotHelper = readFileSync(new URL("../src/lib/dashboardFinancialSnapshot.ts", import.meta.url), "utf8");
const api = readFileSync(new URL("../src/lib/api.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const i18n = readFileSync(new URL("../src/i18n.ts", import.meta.url), "utf8");

test("the Cash Balance card is gone and replaced by a Labour Payments Due card", () => {
  assert.doesNotMatch(dashboard, /label: "Cash Balance"/);
  assert.match(dashboard, /t\("dashboard\.labourPaymentsDue"\)/);
  assert.match(dashboard, /to="\/workspace\/labour-payments\/overview"/);
  // Amber tone, not the aggressive red the spec explicitly rules out for the whole card.
  assert.match(dashboard, /dashboard-kpi-card--amber/);
  assert.doesNotMatch(dashboard, /dashboard-kpi-card--red/);
});

test("Labour Payments Due totals come from the canonical labourPaymentsDue summary, not an independent calculation", () => {
  assert.match(dashboard, /canonicalFinancials\.data\?\.labourPaymentsDue\?\.totalOutstanding/);
  assert.match(dashboard, /canonicalFinancials\.data\?\.labourPaymentsDue\?\.outstandingCount/);
  assert.match(dashboard, /canonicalFinancials\.data\?\.labourPaymentsDue\?\.overdueCount/);
  assert.match(api, /labourPaymentsDue: \{ totalOutstanding: number; outstandingCount: number; overdueCount: number \}/);
});

test("supporting text follows the zero / due / due-and-overdue rule with correct i18n pluralization", () => {
  assert.match(dashboard, /outstandingLabourPaymentsCount <= 0\s*\n\s*\? t\("dashboard\.noOutstandingPayments"\)/);
  assert.match(dashboard, /t\("dashboard\.paymentDue", \{ count: outstandingLabourPaymentsCount \}\)/);
  assert.match(dashboard, /t\("dashboard\.overdue", \{ count: overdueLabourPaymentsCount \}\)/);
  for (const locale of [i18n]) {
    assert.match(locale, /paymentDue_one: /);
    assert.match(locale, /paymentDue_other: /);
    assert.match(locale, /overdue_one: /);
    assert.match(locale, /overdue_other: /);
  }
  // Locale parity: en/ar/ur each define their own labourPaymentsDue block (checked more
  // thoroughly by i18n-locale-parity.source.test.ts).
  assert.equal((i18n.match(/labourPaymentsDue: /g) ?? []).length, 3);
});

test("loading shows a skeleton and never flashes SAR 0; offline shows the last reconciled value with a subtle hint; error shows Unable to load with retry", () => {
  assert.match(dashboard, /labourPaymentsDueSkeleton = !metricsReady && !labourPaymentsDueHasSnapshot/);
  assert.match(dashboard, /dashboard-kpi-card__skeleton--amount/);
  assert.match(dashboard, /dashboard-kpi-card__skeleton--detail/);
  assert.doesNotMatch(dashboard, /labourPaymentsDueSkeleton[\s\S]{0,80}moneyWhole\(0\)/);
  assert.match(dashboard, /sync\.status === "offline" && <span className="dashboard-kpi-card__stale-hint">/);
  assert.match(dashboard, /t\("dashboard\.offlineLastSynced"\)/);
  assert.match(dashboard, /labourPaymentsDueLoadFailed = Boolean\(dashboardLoadError\) && !labourPaymentsDueHasSnapshot/);
  assert.match(dashboard, /t\("dashboard\.unableToLoad"\)/);
  assert.match(dashboard, /onClick=\{retryDashboardLoad\}/);
});

test("an offline-first app open with no in-memory canonical data yet keeps the last reconciled Labour Payments Due value instead of falling back to zero", () => {
  assert.match(
    dashboard,
    /outstandingLabourPayments: canonicalFinancials\.data\?\.labourPaymentsDue\?\.totalOutstanding \?\? financialSnapshotRef\.current\?\.outstandingLabourPayments \?\? 0/,
  );
});

test("a small overdue badge appears only when overdueVoucherCount > 0, and the card is a real focusable link", () => {
  assert.match(dashboard, /overdueLabourPaymentsCount > 0 && \(/);
  assert.match(dashboard, /dashboard-kpi-card__overdue-badge/);
  assert.match(styles, /\.dashboard-kpi-card__overdue-badge \{/);
  assert.match(styles, /\.dashboard-kpi-card--amber \.dashboard-kpi-card__icon \{/);
  assert.match(styles, /\.dashboard-kpi-card:focus-visible \{/);
  assert.match(styles, /a\.dashboard-kpi-card:active \{/);
});

test("card text cannot wrap and break the two-column row height on small screens", () => {
  assert.match(styles, /\.dashboard-kpi-card span \{[^}]*white-space: nowrap;/);
  assert.match(styles, /\.dashboard-kpi-card strong \{[^}]*white-space: nowrap;/);
  assert.match(styles, /\.dashboard-kpi-card small \{[^}]*white-space: nowrap;/);
});

test("dashboardFinancialSnapshot persists the canonical Labour Payments Due fields alongside the existing ones", () => {
  assert.match(snapshotHelper, /outstandingLabourPayments: number/);
  assert.match(snapshotHelper, /outstandingLabourPaymentsCount: number/);
  assert.match(snapshotHelper, /overdueLabourPaymentsCount: number/);
});
