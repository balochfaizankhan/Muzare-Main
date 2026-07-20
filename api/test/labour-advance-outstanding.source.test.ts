import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const route = readFileSync(new URL("../src/routes/labour-payments.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("../../web/src/pages/workspace/WorkforcePayments.tsx", import.meta.url), "utf8");

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
  assert.match(page, /No outstanding labour advances for this farm and season/);
});
