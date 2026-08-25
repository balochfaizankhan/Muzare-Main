import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const migrationSource = readFileSync(
  new URL("../../database/migrations/0049_pooled_advance_funding_attribution.sql", import.meta.url),
  "utf8",
);
const startupGuardSource = readFileSync(
  new URL("../src/db/labourAdvanceFundingAttributionGuard.ts", import.meta.url),
  "utf8",
);
const serverSource = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
const partnerAttributionSource = readFileSync(
  new URL("../../web/src/lib/labourPartnerAdvanceAttribution.ts", import.meta.url),
  "utf8",
);

test("aggregate advance applications preserve original funding-source lineage", () => {
  assert.ok(migrationSource.includes("labour_advance_application_sources"));
  assert.ok(migrationSource.includes("labour_advance_pool_key(v) = target_pool_key"));
  assert.ok(migrationSource.includes("ORDER BY v.voucher_date, v.created_at, v.id"));
  assert.ok(migrationSource.includes("DELETE FROM labour_advance_application_sources"));
  assert.ok(migrationSource.includes("remaining > 0.005"));
});

test("source attribution is audit-only and does not replace aggregate pool math", () => {
  assert.equal(migrationSource.includes("UPDATE labour_advance_applications SET amount"), false);
  assert.equal(migrationSource.includes("UPDATE labour_payment_vouchers SET payment_amount"), false);
  assert.ok(migrationSource.includes("attribution/audit lineage"));
});

test("future pooled applications are attributed and existing sourceless applications are backfilled", () => {
  assert.ok(migrationSource.includes("AFTER INSERT ON labour_advance_applications"));
  assert.ok(migrationSource.includes("a.advance_voucher_id IS NULL"));
  assert.ok(migrationSource.includes("a.status = 'ACTIVE'"));
  assert.ok(migrationSource.includes("NOT EXISTS"));
});

test("funding attribution repair runs once during API startup", () => {
  assert.ok(startupGuardSource.includes('STEP_KEY = "0049_pooled_advance_funding_attribution_v1"'));
  assert.ok(startupGuardSource.includes("app_schema_migrations"));
  assert.ok(serverSource.includes("await ensureLabourAdvanceFundingAttribution();"));
});

test("partner summary reclassifies applied advances without changing partner liability", () => {
  assert.ok(partnerAttributionSource.includes("entry.appliedAdvances"));
  assert.ok(partnerAttributionSource.includes("labourAdvancesPaid"));
  assert.ok(partnerAttributionSource.includes("recoveries"));
  assert.equal(partnerAttributionSource.includes("farmOwesPartner:"), false);
  assert.equal(partnerAttributionSource.includes("ledgerBalance:"), false);
});
