import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const route = readFileSync(new URL("../src/routes/labour-payments.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("../../web/src/pages/workspace/WorkforcePayments.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../../web/src/styles.css", import.meta.url), "utf8");
const hub = readFileSync(new URL("../../web/src/pages/workspace/WorkforceHub.tsx", import.meta.url), "utf8");
const paymentService = readFileSync(new URL("../src/lib/labour-payments.ts", import.meta.url), "utf8");

test("outstanding endpoint combines canonical and both legacy stores without replaying accounting", () => {
  assert.match(route, /FROM operational_records advance/);
  assert.match(route, /FROM advance_records advance/);
  assert.match(route, /mapped\.legacy_source_record_id=advance\.id OR mapped\.source_id=advance\.client_record_id/);
  assert.match(route, /advance\.farm_id=.*OR advance\.farm_id IS NULL/);
  assert.match(route, /advance\.season_id=.*OR advance\.season_id IS NULL/);
  assert.doesNotMatch(route.slice(route.indexOf('app.get("\/v1\/workspace\/:workspaceId\/labour-payments\/advances"'), route.indexOf('app.get("\/v1\/workspace\/:workspaceId\/labour-payments\/reconciliation"')), /insertAccountMovement|postLabourVoucherJournal/);
});

test("the advances tab distinguishes loading, request failure, retry, and genuine empty", () => {
  assert.match(page, /Loading outstanding advances/);
  assert.match(page, /Unable to load outstanding advances/);
  assert.match(page, />\s*Retry\s*</);
  assert.match(page, /No outstanding advances match these filters/);
});

test("the advances endpoint paginates, summarizes, filters, and executes one card-ready query", () => {
  const endpoint = advanceEndpointSource();
  assert.match(route, /pageSize: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(100\)\.default\(20\)/);
  assert.match(endpoint, /count\(\*\) OVER\(\)[\s\S]*filtered_total_count/);
  assert.match(endpoint, /context_total_outstanding/);
  assert.match(endpoint, /context_open_count/);
  assert.match(endpoint, /context_summary LEFT JOIN paged/);
  assert.match(endpoint, /ORDER BY voucher_date DESC,created_at DESC,id DESC LIMIT/);
  assert.match(endpoint, /financial_owner_name/);
  assert.match(endpoint, /payment_account_name/);
  assert.match(endpoint, /ILIKE .*search/);
  assert.match(endpoint, /diagnostics:\s*\{\s*queryCount:\s*1/);
  assert.equal((endpoint.match(/await db\.execute/g) ?? []).length, 1);
  assert.doesNotMatch(endpoint, /for \(const .*await db/);
});

test("recipient ownership does not fall back from a group to its leader", () => {
  assert.match(route, /WHEN 'LABOUR_GROUP' THEN COALESCE\(NULLIF\(voucher\.recipient_snapshot->>'labourGroupName'/);
  assert.match(route, /WHEN 'INDIVIDUAL' THEN COALESCE\(NULLIF\(voucher\.recipient_snapshot->>'labourerName'/);
  assert.doesNotMatch(route, /WHEN 'LABOUR_GROUP' THEN COALESCE\([^\n]+leader/i);
  assert.match(page, /Receiver unavailable/);
  assert.match(page, /Received by · for/);
  assert.match(page, /For \$\{advance\.financialOwnerName \?\? "Owner unavailable"\} · Legacy record · review required/);
  assert.match(page, /Recipient unavailable/);
  assert.match(page, /Review required/);
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
  assert.match(route, /ADV-L-/);
  assert.match(route, /ADV-N-/);
  assert.match(page, /Account unavailable/);
  assert.match(page, /Legacy record/);
  assert.doesNotMatch(page.slice(page.indexOf("function AdvancesView"), page.indexOf("function ReviewSettleDialog")), /Legacy account/);
  for (const label of ["Payments Due", "New Direct Due", "Payment Vouchers", "Outstanding Advances"]) assert.match(hub, new RegExp(label));
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
  assert.match(page, /advance\.recipientScope === "INDIVIDUAL"\s*\? advance\.financialOwnerName/);
  assert.match(page, /Received by \$\{receivers\[0\]\}/);
  assert.match(page, /receivers\.length > 1/);
  assert.match(page, /Receiver unavailable/);
  assert.match(page, /Paid from:/);
  assert.match(page, /workforce-advance-group-actions/);
  assert.match(styles, /\.workforce-advance-recover \{ min-height: 34px/);
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

test("the canonical read query resolves historical receivers without current group-leader fallback", () => {
  const endpoint = advanceEndpointSource();
  assert.match(endpoint, /source_record\.payload->>'labourerId'/);
  assert.match(endpoint, /advance\.payload->>'labourerName'/);
  assert.match(endpoint, /operational_people receiver_person/);
  assert.match(endpoint, /receivedByNameSnapshot/);
  assert.doesNotMatch(endpoint, /received_by_name[^;]+groupLeaderName/i);
  assert.match(paymentService, /receivedByLabourerId: advanceLabourerId/);
  assert.match(paymentService, /receivedByNameSnapshot: advancePayload\.labourerName/);
});

test("payments due and review use the complete canonical advance response", () => {
  const overview = page.slice(page.indexOf("export function WorkforcePaymentsPage"), page.indexOf("function AdvancesView"));
  assert.match(overview, /fetchAllLabourPaymentAdvances/);
  assert.match(overview, /setAdvanceSummary\(advanceResponse\.summary\)/);
  assert.match(overview, /advanceSummary\.totalOutstanding/);
  assert.match(overview, /advanceSummary\.openCount/);
  assert.doesNotMatch(overview, /const outstandingAdvances\s*=\s*advances\.reduce/);
  assert.match(page, /muzare:advance-list:v2:\$\{workspaceId\}:\$\{farmId\}:\$\{seasonId\}/);
});

function advanceSchemaSource() {
  return route.slice(route.indexOf("const advanceSchema"), route.indexOf("const settleSchema"));
}

function advanceEndpointSource() {
  const path = '"/v1/workspace/:workspaceId/labour-payments/advances"';
  const createRoute = route.indexOf(path);
  return route.slice(
    route.indexOf(path, createRoute + path.length),
    route.indexOf('"/v1/workspace/:workspaceId/labour-payments/reconciliation"'),
  );
}

test("mobile tabs and cards avoid clipped or oversized controls", () => {
  assert.match(styles, /scroll-snap-type:x mandatory/);
  assert.match(styles, /\.workforce-shell-panel::after \{ content:none; \}/);
  assert.match(styles, /\.workforce-advance-group-actions/);
  assert.match(styles, /\.workforce-advance-view-toggle/);
});
