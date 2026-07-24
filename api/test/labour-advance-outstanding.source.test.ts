import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const route = readFileSync(new URL("../src/routes/labour-payments.ts", import.meta.url), "utf8");
const readModel = readFileSync(new URL("../src/lib/labour-financial-read-model.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("../../web/src/pages/workspace/WorkforcePayments.tsx", import.meta.url), "utf8");
const modulePage = readFileSync(new URL("../../web/src/pages/ModulePage.tsx", import.meta.url), "utf8");
const reports = readFileSync(new URL("../../web/src/pages/workspace/Reports.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../../web/src/styles.css", import.meta.url), "utf8");
const hub = readFileSync(new URL("../../web/src/pages/workspace/WorkforceHub.tsx", import.meta.url), "utf8");
const workspaceLayout = readFileSync(new URL("../../web/src/layouts/WorkspaceLayout.tsx", import.meta.url), "utf8");
const paymentService = readFileSync(new URL("../src/lib/labour-payments.ts", import.meta.url), "utf8");

test("advances endpoint uses the shared read model to combine canonical and both legacy stores without replaying accounting", () => {
  assert.match(route, /const financials = await loadLabourFinancialReadModel\(/);
  assert.match(readModel, /db\.select\(\)\.from\(operationalRecords\)\.where\(and\(eq\(operationalRecords\.workspaceId, input\.workspaceId\), eq\(operationalRecords\.entityType, "advance"\)\)\)/);
  assert.match(readModel, /db\.select\(\)\.from\(advanceRecords\)\.where\(and\(eq\(advanceRecords\.farmId, input\.farmId\), eq\(advanceRecords\.seasonId, input\.seasonId\)\)\)/);
  assert.match(readModel, /sourceClassification: advance\.legacySourceRecordId \|\| sourceByClientId\.has\(advance\.sourceId \?\? ""\) \? "CANONICAL_LINKED_LEGACY" : "CANONICAL"/);
  assert.match(readModel, /mergeAdvancePositions\(canonicalAdvances, \[\.\.\.legacyOperationalRows\.map\(legacyAdvancePosition\), \.\.\.legacyNormalizedRows\.map\(legacyAdvancePosition\)\]\)/);
  assert.doesNotMatch(route.slice(route.indexOf('app.get("\/v1\/workspace\/:workspaceId\/labour-payments\/advances"'), route.indexOf('app.get("\/v1\/workspace\/:workspaceId\/labour-payments\/reconciliation"')), /insertAccountMovement|postLabourVoucherJournal/);
});

const i18n = readFileSync(new URL("../../web/src/i18n.ts", import.meta.url), "utf8");

test("the advances tab distinguishes loading, request failure, retry, and genuine empty", () => {
  assert.match(page, /advancesView\.loadingAdvances/);
  assert.match(page, /errors\.unableLoadAdvances/);
  assert.match(page, /workforcePaymentsPage\.retry/);
  assert.match(page, /advancesView\.noMatchingAdvancesTitle/);
  assert.match(i18n, /"loadingAdvances": "Loading advances"/);
  assert.match(i18n, /"unableLoadAdvances": "Unable to load advances\."/);
  assert.match(i18n, /"noMatchingAdvancesTitle": "No matching advances"/);
});

test("the advances endpoint paginates, summarizes, filters, and serves one shared register projection", () => {
  const endpoint = advanceEndpointSource();
  assert.match(route, /pageSize: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(50\)\.default\(20\)/);
  assert.match(endpoint, /financials\.advancePositions/);
  assert.match(endpoint, /query\.data\.status === "OPEN"/);
  assert.match(endpoint, /row\.fundingAccountName/);
  assert.match(endpoint, /recipientDisplayName: row\.recipientDisplayName/);
  assert.match(endpoint, /paymentSourceDisplayName: row\.paymentSourceDisplayName/);
  assert.match(endpoint, /row\.partnerName/);
  assert.match(endpoint, /reviewReason/);
  assert.match(endpoint, /totalOriginal: financials\.summary\.totalAdvance/);
  assert.match(endpoint, /totalRecovered: financials\.summary\.recoveredAdvance/);
  assert.match(endpoint, /diagnostics:\s*\{\s*queryCount:\s*1/);
  assert.equal((endpoint.match(/loadLabourFinancialReadModel\(/g) ?? []).length, 1);
  assert.doesNotMatch(endpoint, /await db\.execute/);
});

test("recipient display names never fall back from a group to its leader", () => {
  assert.match(readModel, /resolveRecipientDisplayName/);
  assert.match(readModel, /snapshot\.labourGroupName/);
  assert.match(readModel, /snapshot\.labourerName/);
  assert.doesNotMatch(readModel, /groupLeaderName|leaderName/i);
  assert.match(page, /recipientUnavailable/);
});

test("mobile advance UX loads twenty rows, debounces search, aborts stale requests, and uses compact pool-level actions", () => {
  assert.match(page, /pageSize: 20/);
  assert.match(page, /setTimeout\(\(\) => setSearch\(searchInput\.trim\(\)\), 320\)/);
  assert.match(page, /new AbortController\(\)/);
  assert.match(page, /workforcePaymentsPage\.loadMore/);
  // Developer-like pagination copy ("N of M advances loaded") is gone.
  assert.doesNotMatch(page, /Showing \{rows\.length\} of \{pageInfo\.totalCount\}/);
  // Recovery is pool-level only: the sheet is bounded by the pool's available
  // balance, never by a single voucher's outstanding amount.
  assert.match(page, /max=\{Math\.max\(recoveryTarget\.available, 0\)\}/);
  assert.doesNotMatch(page, /refundAdvance\.outstandingAmount/);
  // Primary views are Group pools / Individual / All vouchers.
  assert.match(page, /advancesView\.groupPoolsTab/);
  assert.match(page, /advancesView\.allVouchersTab/);
  assert.match(styles, /--mobile-nav-height, 96px/);
});

test("human references, account review states, and all mobile payment tabs remain explicit", () => {
  assert.match(readModel, /sourceClassification: "CANONICAL" \| "CANONICAL_LINKED_LEGACY" \| "LEGACY_OPERATIONAL" \| "LEGACY_NORMALIZED"/);
  assert.match(route, /paymentAccountName: row\.paymentSourceDisplayName/);
  assert.match(route, /needsReview: row\.needsReview/);
  assert.match(page, /unresolvedPaymentSource/);
  assert.match(i18n, /"unresolvedPaymentSource": "Unresolved payment source"/);
  assert.doesNotMatch(page.slice(page.indexOf("function AdvancesView"), page.indexOf("function ReviewSettleDialog")), /Legacy account/);
  assert.match(hub, /paymentsDueTab/);
  assert.match(hub, /newLabourDueTab/);
  assert.match(hub, /paymentVouchersTab/);
  assert.match(hub, /layout\.advances/);
  assert.match(hub, /scrollIntoView/);
});

test("record advance uses searchable selectors and valid-state posting", () => {
  const advances = page.slice(page.indexOf("function AdvancesView"), page.indexOf("function ReviewSettleDialog"));
  assert.match(advances, /<LabourSelectCombobox/);
  assert.match(advances, /advancesView\.searchLabourersPlaceholder/);
  assert.match(advances, /includeInactive/);
  assert.match(advances, /renderAdvanceLabourOption\(t, option\)/);
  assert.match(advances, /PaymentAccountSelect/);
  assert.match(advances, /disabled=\{saving \|\| !formValid\}/);
  assert.match(advances, /advancesView\.recordMoneyPaidBeforeSettlement/);
  // An ungrouped labourer can receive an advance; the form previews the
  // destination pool instead of blocking on group membership.
  assert.match(advances, /advancesView\.individualPoolNote/);
  assert.doesNotMatch(advances, /assignGroupBeforeAdvance/);
  assert.match(styles, /env\(safe-area-inset-bottom\)/);
});

test("advance voucher cards keep recipient and amount primary with one overflow menu and no application states", () => {
  assert.match(page, /resolveAdvanceCardIdentity\(advance, labourerById\)/);
  assert.match(page, /workforce-advance-card__amount/);
  assert.match(page, /workforce-advance-actions-menu/);
  assert.match(page, /advancesView\.paidTo/);
  assert.match(page, /advancesView\.recipientTypeLabel/);
  const advances = page.slice(page.indexOf("function AdvancesView"), page.indexOf("function ReviewSettleDialog"));
  assert.doesNotMatch(advances, /appliedLabel|outstandingLabel/, "voucher cards and details never show applied/outstanding voucher states");
  assert.doesNotMatch(advances, /advancesView\.recover"|advancesView\.recover\b/, "no voucher-level Recover action exists");
});

test("payment and advance registers remain separate business documents", () => {
  const voucherRegister = page.slice(page.indexOf("function VoucherRegister"), page.indexOf("function AdvancesView"));
  const advanceRegister = page.slice(page.indexOf("function AdvancesView"), page.indexOf("function ReviewSettleDialog"));
  assert.doesNotMatch(voucherRegister, /<option value="ADVANCE">/);
  assert.doesNotMatch(voucherRegister, /<option value="REFUND_RECOVERY">/);
  assert.doesNotMatch(voucherRegister, /LPA-\$\{/);
  assert.match(voucherRegister, /canonicalSummary\?\.activeAdvanceApplied/);
  assert.match(voucherRegister, /canonicalSummary\?\.wageExpense/);
  assert.match(voucherRegister, /onViewAdvances/);
  assert.match(advanceRegister, /advancesView\.advanceAmountLabel/);
  assert.match(advanceRegister, /advancesView\.availableAdvanceBalance/);
  assert.match(advanceRegister, /advancesView\.appliedToLabourDues/);
  assert.doesNotMatch(advanceRegister, /<span>Outstanding<\/span>/);
  assert.doesNotMatch(advanceRegister, /Original \{money\(advance\.originalAmount\)\}/);
});

test("aggregate applied-advance history is derived from posting events while child allocations stay internal", () => {
  assert.match(readModel, /aggregateApplicationVoucherNumber/);
  assert.match(readModel, /action === "labour_due_settled"/);
  assert.match(readModel, /advanceApplicationParents/);
  assert.match(page, /applicationParents=\{canonicalFinancials\.data\?\.advanceApplicationParents \?\? \[\]\}/);
  assert.match(page, /kind: "application_parent"/);
  assert.match(page, /advanceAppliedNonCash/);
  assert.match(i18n, /"advanceAppliedNonCash": "Advance applied to due — Non-cash"/);
  assert.doesNotMatch(page, /sourceAdvanceVoucherNumber \?\? "Advance reference unavailable"/);
});

test("aggregate applied-advance reversal targets the parent event instead of individual child rows", () => {
  assert.match(route, /advance-application-events\/:eventId\/reverse/);
  assert.match(route, /labour_advance_application_event_reversed/);
  assert.match(page, /reverseLabourAdvanceApplicationEvent/);
  assert.match(page, /voucherRegister\.voidReverse/);
  assert.match(i18n, /"voidReverse": "Void \/ reverse"/);
  assert.doesNotMatch(page, /APPLICATION_REVERSAL/);
});

test("dashboard quick add deep-links into the canonical record advance dialog", () => {
  const advances = page.slice(page.indexOf("function AdvancesView"), page.indexOf("function ReviewSettleDialog"));
  assert.match(workspaceLayout, /\/workspace\/labour-payments\/advances\?action=record-advance/);
  assert.match(workspaceLayout, /setMobileSheet\(null\); navigate\(item\.to\)/);
  assert.match(advances, /new URLSearchParams\(location\.search\)\.get\("action"\)/);
  assert.match(advances, /action !== "record-advance"/);
  assert.match(advances, /openRecordAdvance\(true\)/);
  assert.match(advances, /window\.history\.replaceState/);
  assert.match(advances, /window\.history\.pushState/);
  assert.match(advances, /window\.history\.back\(\)/);
  assert.match(advances, /window\.addEventListener\("popstate", handlePopState\)/);
  assert.match(advances, /resetRecordAdvanceForm/);
  assert.match(advances, /recordAdvanceDialogRef\.current\?\.querySelector<HTMLElement>\("input, select"\)/);
  assert.match(advances, /aria-labelledby="record-advance-title"/);
  assert.match(advances, /dialog\.querySelectorAll<HTMLElement>/);
  assert.equal((advances.match(/postLabourAdvanceVoucher\(/g) ?? []).length, 1, "both launch paths use one submit handler");
  assert.match(advances, /pageSize: 20/);
});

test("advance creation and recovery use separate canonical identity contracts", () => {
  assert.match(route, /receivedByLabourerId: z/);
  assert.match(route, /path: \["receivedByLabourerId"\]/);
  assert.match(route, /Check the highlighted advance fields/);
  assert.match(route, /app\.post\(\s*"\/v1\/workspace\/:workspaceId\/labour-payments\/advances"/);
  assert.match(route, /app\.post\(\s*"\/v1\/workspace\/:workspaceId\/labour-payments\/advances\/:voucherId\/refund"/);
  assert.doesNotMatch(advanceSchemaSource(), /labourAdvanceId/);
  assert.match(page, /receivedByLabourerId:/);
  assert.match(page, /postLabourAdvanceVoucher/);
});

test("the shared read model resolves historical receivers without current group-leader fallback", () => {
  const endpoint = advanceEndpointSource();
  assert.match(readModel, /receivedByNameSnapshot/);
  assert.match(readModel, /receivedBy/);
  assert.match(readModel, /resolveReceivedByDisplayName/);
  assert.match(endpoint, /receivedByName: row\.receivedByDisplayName/);
  assert.doesNotMatch(readModel, /receivedByName[^;]+groupLeaderName/i);
  assert.match(paymentService, /receivedByLabourerId: advanceLabourerId/);
  assert.match(paymentService, /receivedByNameSnapshot: advancePayload\.labourerName/);
});

test("advance reports and exports use the same resolved recipient and payment-source labels", () => {
  assert.match(reports, /advanceRecipientName/);
  assert.match(reports, /advancePaymentSourceName/);
  assert.match(reports, /paymentSourceDisplayName: item\.paymentSourceDisplayName/);
  assert.match(reports, /recipientDisplayName: item\.recipientDisplayName/);
  assert.match(reports, /item\.active/);
  assert.match(reports, /Multiple payment sources/);
  assert.match(reports, /advancePaymentSourceName\(item\)/);
  assert.match(reports, /advanceRecipientName\(item\)/);
  assert.match(reports, /"Labour \/ Group"/);
  assert.match(reports, /"Source \/ Paid From"/);
  assert.match(reports, /"Advance Amount SAR"/);
  assert.doesNotMatch(reports, /"Applied SAR"/);
  assert.doesNotMatch(reports, /"Outstanding SAR"/);
  assert.match(reports, /"Advance amount"/);
  assert.doesNotMatch(reports, /"Fully applied"/i);
});

test("payments due uses canonical summary and review loads a due-specific aggregate", () => {
  const overview = page.slice(page.indexOf("export function WorkforcePaymentsPage"), page.indexOf("function AdvancesView"));
  const review = page.slice(page.indexOf("function ReviewSettleDialog"));
  assert.match(review, /fetchLabourDueAdvancePool/);
  assert.doesNotMatch(review, /fetchAllLabourPaymentAdvances/);
  assert.match(overview, /pageSize: 1, status: "OPEN"/);
  assert.match(overview, /setAdvanceSummary\(advanceResponse\.summary\)/);
  assert.match(overview, /advanceSummary\.totalOutstanding/);
  assert.match(overview, /advanceSummary\.openCount/);
  assert.doesNotMatch(overview, /const outstandingAdvances\s*=\s*advances\.reduce/);
  assert.match(page, /muzare:advance-list:v3:\$\{workspaceId\}:\$\{farmId\}:\$\{seasonId\}/);
});

test("accounts expense visibility uses outstanding advance balance and keeps active unpaid dues in the canonical snapshot", () => {
  assert.match(readModel, /export function shouldIncludeExpenseVisibilityRow/);
  assert.match(readModel, /\.filter\(shouldIncludeExpenseVisibilityRow\)/);
  assert.match(modulePage, /summary\.outstandingAdvance/);
  assert.match(modulePage, /Available advance balance/);
  assert.match(modulePage, /totalBusinessExpenses = totalVoucherExpenses \+ settledLabourWages \+ totalAdvances/);
  assert.doesNotMatch(modulePage, /totalBusinessExpenses = totalVoucherExpenses \+ settledLabourWages;/);
});

test("the canonical read model can backfill a missing direct-payment funding entry without duplicating original partner advances", () => {
  assert.match(readModel, /export function buildSyntheticVoucherAccountEntry/);
  assert.match(readModel, /const syntheticFundedVoucherEntries = vouchers/);
  assert.match(readModel, /voucher\.status === "POSTED" && voucher\.nature !== "ADVANCE_APPLICATION"/);
  assert.match(readModel, /if \(economicNature === "ADVANCE" && account\.accountType === "partner"\) return \[\];/);
  assert.match(readModel, /\[\.\.\.transactionBackedAccountEntries, \.\.\.syntheticFundedVoucherEntries, \.\.\.missingOriginalAdvanceEntries\]/);
});

test("accounts partner cards and ledgers resolve canonical labour entries through account identity aliases", () => {
  assert.match(modulePage, /const canonicalAccountId = resolveCanonicalAccountId\(account\.id, accountLookup\) \?\? account\.id/);
  assert.match(modulePage, /const selectedCanonicalAccountId = resolveCanonicalAccountId\(selectedAccount\.id, accountLookup\) \?\? selectedAccount\.id/);
  assert.match(modulePage, /entry\.accountId === selectedCanonicalAccountId \|\| entry\.accountId === selectedAccount\.id/);
});

function advanceSchemaSource() {
  return route.slice(route.indexOf("const advanceSchema"), route.indexOf("const settleSchema"));
}

function advanceEndpointSource() {
  const path = '"/v1/workspace/:workspaceId/labour-payments/advances"';
  const createRoute = route.indexOf(path);
  return route.slice(
    route.indexOf(path, createRoute + path.length),
    // Bounded to just the GET list route — the P1C detail route
    // ("/labour-payments/advances/:advanceId") that follows also calls
    // loadLabourFinancialReadModel once (by design, see labour-financial-read-model.ts's
    // coalesceInFlight), which would double-count against this list-only assertion otherwise.
    route.indexOf('"/v1/workspace/:workspaceId/labour-payments/advances/:advanceId"'),
  );
}

test("mobile tabs and cards avoid clipped or oversized controls", () => {
  assert.match(styles, /scroll-snap-type:x mandatory/);
  assert.match(styles, /\.workforce-shell-panel::after \{ content:none; \}/);
  assert.match(styles, /\.workforce-advance-group-actions/);
  assert.match(styles, /\.workforce-advance-view-toggle/);
});
