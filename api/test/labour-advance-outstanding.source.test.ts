import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const route = readFileSync(new URL("../src/routes/labour-payments.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("../../web/src/pages/workspace/WorkforcePayments.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../../web/src/styles.css", import.meta.url), "utf8");
const hub = readFileSync(new URL("../../web/src/pages/workspace/WorkforceHub.tsx", import.meta.url), "utf8");

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
  assert.match(page, />Retry</);
  assert.match(page, /No outstanding advances match these filters/);
});

test("the advances endpoint paginates, summarizes, filters, and executes one card-ready query", () => {
  const endpoint = route.slice(route.indexOf('app.get("/v1/workspace/:workspaceId/labour-payments/advances"'), route.indexOf('app.get("/v1/workspace/:workspaceId/labour-payments/reconciliation"'));
  assert.match(route, /pageSize: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(100\)\.default\(20\)/);
  assert.match(endpoint, /count\(\*\) OVER\(\).*total_count/);
  assert.match(endpoint, /sum\(outstanding_amount\) OVER\(\).*total_outstanding/);
  assert.match(endpoint, /ORDER BY voucher_date DESC,created_at DESC,id DESC LIMIT/);
  assert.match(endpoint, /financial_owner_name/);
  assert.match(endpoint, /payment_account_name/);
  assert.match(endpoint, /ILIKE .*search/);
  assert.match(endpoint, /diagnostics:\{queryCount:1/);
  assert.equal((endpoint.match(/await db\.execute/g) ?? []).length, 1);
  assert.doesNotMatch(endpoint, /for \(const .*await db/);
});

test("recipient ownership does not fall back from a group to its leader", () => {
  assert.match(route, /WHEN 'LABOUR_GROUP' THEN COALESCE\(NULLIF\(voucher\.recipient_snapshot->>'labourGroupName'/);
  assert.match(route, /WHEN 'INDIVIDUAL' THEN COALESCE\(NULLIF\(voucher\.recipient_snapshot->>'labourerName'/);
  assert.doesNotMatch(route, /WHEN 'LABOUR_GROUP' THEN COALESCE\([^\n]+leader/i);
  assert.match(page, /<b>Received by:<\/b>/);
  assert.match(page, /Recipient unavailable/);
  assert.match(page, /Review required/);
});

test("mobile advance UX loads twenty rows, debounces search, aborts stale requests, and uses compact actions", () => {
  assert.match(page, /pageSize:20/);
  assert.match(page, /setTimeout\(\(\)=>setSearch\(searchInput\.trim\(\)\),320\)/);
  assert.match(page, /new AbortController\(\)/);
  assert.match(page, /Load more/);
  assert.match(page, /Showing \{rows\.length\} of \{pageInfo\.totalCount\}/);
  assert.match(page, /className="secondary-action workforce-advance-recover"/);
  assert.doesNotMatch(page, />Record Recovery<\/button>/);
  assert.match(page, /max=\{refundAdvance\.outstandingAmount\}/);
  assert.match(page, /Recovery cannot exceed the outstanding advance amount/);
  assert.match(page, /Group recipients/);
  assert.match(styles, /\.workforce-advance-card \{ max-height: 190px; \}/);
  assert.match(styles, /--mobile-nav-height, 96px/);
});

test("human references, account review states, and all mobile payment tabs remain explicit", () => {
  assert.match(route, /ADV-L-/);
  assert.match(route, /ADV-N-/);
  assert.match(page, /Account unavailable · Legacy record/);
  assert.doesNotMatch(page.slice(page.indexOf("function AdvancesView"), page.indexOf("function ReviewSettleDialog")), /Legacy account/);
  for (const label of ["Payments Due", "New Direct Due", "Payment Vouchers", "Outstanding Advances"]) assert.match(hub, new RegExp(label));
  assert.match(hub, /scrollIntoView/);
});
