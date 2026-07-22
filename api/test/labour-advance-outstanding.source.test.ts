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

test("the advances tab distinguishes loading, request failure, retry, and genuine empty", () => {
  assert.match(page, /Loading advances/);
  assert.match(page, /Unable to load advances/);
  assert.match(page, />\s*Retry\s*</);
  assert.match(page, /No advances match these filters/);
});

test("the advances endpoint paginates, summarizes, filters, and serves one shared register projection", () => {
  const endpoint = advanceEndpointSource();
  assert.match(route, /pageSize: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(100\)\.default\(20\)/);
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

test("recipient ownership does not fall back from a group to its leader", () => {
  assert.match(readModel, /resolveRecipientDisplayName/);
  assert.match(readModel, /snapshot\.labourGroupName/);
  assert.match(readModel, /snapshot\.labourerName/);
  assert.doesNotMatch(readModel, /groupLeaderName|leaderName/i);
  assert.match(page, /Receiver unavailable/);
  assert.match(page, /Paid to group/);
  assert.match(page, /Recipient unavailable/);
  assert.match(page, /Needs review/);
});

test("mobile advance UX loads twenty rows, debounces search, aborts stale requests, and uses compact actions", () => {
  assert.match(page, /pageSize: 20/);
  assert.match(page, /setTimeout\(\(\) => setSearch\(searchInput\.trim\(\)\), 320\)/);
  assert.match(page, /new AbortController\(\)/);
  assert.match(page, /Load more/);
  assert.match(page, /Showing \{rows\.length\} of \{pageInfo\.totalCount\}/);
  assert.match(page, /className="secondary-action workforce-advance-recover"/);
  assert.doesNotMatch(page, />Record Recovery<\/button>/);
  assert.match(page, /max=\{refundAdvance\.outstandingAmount\}/);
  assert.match(page, /Recovery cannot exceed the outstanding advance amount/);
  assert.match(page, />\s*Grouped\s*<\/button>/);
  assert.match(page, />\s*Vouchers\s*<\/button>/);
  assert.match(styles, /\.workforce-advance-card \{ max-height: 190px; \}/);
  assert.match(styles, /--mobile-nav-height, 96px/);
});

test("human references, account review states, and all mobile payment tabs remain explicit", () => {
  assert.match(readModel, /sourceClassification: "CANONICAL" \| "CANONICAL_LINKED_LEGACY" \| "LEGACY_OPERATIONAL" \| "LEGACY_NORMALIZED"/);
  assert.match(route, /paymentAccountName: row\.paymentSourceDisplayName/);
  assert.match(route, /needsReview: row\.needsReview/);
  assert.match(page, /Unresolved payment source/);
  assert.match(page, /Needs review/);
  assert.doesNotMatch(page.slice(page.indexOf("function AdvancesView"), page.indexOf("function ReviewSettleDialog")), /Legacy account/);
  for (const label of ["Payments Due", "New Labour Due", "Payment Vouchers", "Advances"]) assert.match(hub, new RegExp(label));
  assert.match(hub, /scrollIntoView/);
});

test("record advance uses sectioned searchable selectors and valid-state posting", () => {
  const advances = page.slice(page.indexOf("function AdvancesView"), page.indexOf("function ReviewSettleDialog"));
  assert.match(advances, /<LabourSelectCombobox\s+ariaLabel="Labourer"/);
  assert.match(advances, /placeholder="Search labourers"/);
  assert.match(advances, /includeInactive/);
  assert.match(advances, /renderOption=\{renderAdvanceLabourOption\}/);
  assert.match(advances, /<LabourSelectCombobox\s+ariaLabel="Paid from account"/);
  for (const heading of ["Recipient", "Payment", "Details", "Preview"]) assert.match(advances, new RegExp(`>\\s*${heading}\\s*<`));
  assert.match(advances, /disabled=\{saving \|\| !formValid\}/);
  assert.match(advances, /Record money paid before final settlement/);
  assert.match(styles, /env\(safe-area-inset-bottom\)/);
});

test("advance cards retain explicit owner and receiver hierarchy in both views", () => {
  assert.match(page, /advance\.financialOwnerName \?\? receiver \?\? "Recipient unavailable"/);
  assert.match(page, /Received by \$\{receivers\[0\]\}/);
  assert.match(page, /receivers\.length > 1/);
  assert.match(page, /Receiver unavailable/);
  assert.match(page, /Paid from:/);
  assert.match(page, /Multiple payment sources/);
  assert.match(page, /workforce-advance-group-actions/);
  assert.match(styles, /\.workforce-advance-recover \{ min-height: 34px/);
  assert.match(page, /<dt>Paid to<\/dt>/);
  assert.match(page, /<dt>Recipient type<\/dt>/);
  assert.doesNotMatch(page, /<dt>Applied<\/dt>/);
  assert.doesNotMatch(page, /<dt>Outstanding<\/dt>/);
});

test("payment and advance registers remain separate business documents", () => {
  const voucherRegister = page.slice(page.indexOf("function VoucherRegister"), page.indexOf("function AdvancesView"));
  const advanceRegister = page.slice(page.indexOf("function AdvancesView"), page.indexOf("function ReviewSettleDialog"));
  assert.match(voucherRegister, /Final cash payments and aggregate applied-advances postings/);
  assert.doesNotMatch(voucherRegister, /<option value="ADVANCE">/);
  assert.doesNotMatch(voucherRegister, /<option value="REFUND_RECOVERY">/);
  assert.doesNotMatch(voucherRegister, /LPA-\$\{/);
  assert.match(voucherRegister, /Final labour payments/);
  assert.match(voucherRegister, /Applied advances/);
  assert.match(voucherRegister, /canonicalSummary\?\.activeAdvanceApplied/);
  assert.match(voucherRegister, /canonicalSummary\?\.wageExpense/);
  assert.match(voucherRegister, /onViewAdvances/);
  assert.match(advanceRegister, /Advance amount/);
  assert.match(advanceRegister, /Available advance balance/);
  assert.match(advanceRegister, /Applied to labour dues/);
  assert.doesNotMatch(advanceRegister, /<span>Outstanding<\/span>/);
  assert.doesNotMatch(advanceRegister, /Original \{money\(advance\.originalAmount\)\}/);
});

test("aggregate applied-advance history is derived from posting events while child allocations stay internal", () => {
  assert.match(readModel, /aggregateApplicationVoucherNumber/);
  assert.match(readModel, /action === "labour_due_settled"/);
  assert.match(readModel, /advanceApplicationParents/);
  assert.match(page, /applicationParents=\{canonicalFinancials\.data\?\.advanceApplicationParents \?\? \[\]\}/);
  assert.match(page, /kind: "application_parent"/);
  assert.match(page, /Advance applied to due — Non-cash/);
  assert.doesNotMatch(page, /sourceAdvanceVoucherNumber \?\? "Advance reference unavailable"/);
});

test("aggregate applied-advance reversal targets the parent event instead of individual child rows", () => {
  assert.match(route, /advance-application-events\/:eventId\/reverse/);
  assert.match(route, /labour_advance_application_event_reversed/);
  assert.match(page, /reverseLabourAdvanceApplicationEvent/);
  assert.match(page, /Void \/ reverse/);
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
  assert.match(advances, /recipientScopeRef\.current\?\.focus\(\)/);
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
  assert.match(review, /View allocation details/);
  assert.match(overview, /pageSize: 1, status: "OPEN"/);
  assert.match(overview, /setAdvanceSummary\(advanceResponse\.summary\)/);
  assert.match(overview, /advanceSummary\.totalOutstanding/);
  assert.match(overview, /advanceSummary\.openCount/);
  assert.doesNotMatch(overview, /const outstandingAdvances\s*=\s*advances\.reduce/);
  assert.match(page, /muzare:advance-list:v2:\$\{workspaceId\}:\$\{farmId\}:\$\{seasonId\}/);
});

test("accounts expense visibility uses outstanding advance balance and keeps active unpaid dues in the canonical snapshot", () => {
  assert.match(readModel, /export function shouldIncludeExpenseVisibilityRow/);
  assert.match(readModel, /\.filter\(shouldIncludeExpenseVisibilityRow\)/);
  assert.match(modulePage, /summary\.outstandingAdvance/);
  assert.match(modulePage, /Available advance balance/);
  assert.doesNotMatch(modulePage, /summary\.totalAdvance/);
});

test("the canonical read model can backfill a missing direct-payment funding entry without duplicating original partner advances", () => {
  assert.match(readModel, /export function buildSyntheticVoucherAccountEntry/);
  assert.match(readModel, /const syntheticFundedVoucherEntries = vouchers/);
  assert.match(readModel, /voucher\.status === "POSTED" && voucher\.nature !== "ADVANCE_APPLICATION"/);
  assert.match(readModel, /if \(economicNature === "ADVANCE" && account\.accountType === "partner"\) return \[\];/);
  assert.match(readModel, /\[\.\.\.transactionBackedAccountEntries, \.\.\.syntheticFundedVoucherEntries, \.\.\.missingOriginalAdvanceEntries\]/);
});

function advanceSchemaSource() {
  return route.slice(route.indexOf("const advanceSchema"), route.indexOf("const settleSchema"));
}

function advanceEndpointSource() {
  const path = '"/v1/workspace/:workspaceId/labour-payments/advances"';
  const createRoute = route.indexOf(path);
  return route.slice(
    route.indexOf(path, createRoute + path.length),
    route.indexOf('"/v1/workspace/:workspaceId/labour-payments/financial-read-model"'),
  );
}

test("mobile tabs and cards avoid clipped or oversized controls", () => {
  assert.match(styles, /scroll-snap-type:x mandatory/);
  assert.match(styles, /\.workforce-shell-panel::after \{ content:none; \}/);
  assert.match(styles, /\.workforce-advance-group-actions/);
  assert.match(styles, /\.workforce-advance-view-toggle/);
});
