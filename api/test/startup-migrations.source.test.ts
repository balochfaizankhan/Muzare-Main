import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("startup schema migration uses a journal, advisory lock, and defers heavy repairs", () => {
  const source = readFileSync(new URL("../src/db/migrations.ts", import.meta.url), "utf8");
  assert.ok(source.includes("app_schema_migrations"));
  assert.ok(source.includes("STARTUP_LOCK_KEY"));
  assert.ok(source.includes("pg_advisory_lock"));
  assert.ok(source.includes("pg_advisory_unlock"));
  assert.ok(source.includes("MIGRATION_LOCK_ACQUIRED"));
  assert.ok(source.includes("MIGRATION_STEP_STARTED"));
  assert.ok(source.includes("MIGRATION_STEP_COMPLETED"));
  assert.ok(source.includes("MIGRATION_DEFERRED_STEP_SKIPPED"));
  assert.ok(source.includes('"0031_workspace_membership_dedup"'));
  assert.ok(source.includes('"0032_voided_labour_wage_settlement_repair"'));
});

test("startup SQL keeps workspace and season backfills minimal and constraints not valid", () => {
  const tenantHardening = readFileSync(new URL("../../database/migrations/0005_tenant_hardening.sql", import.meta.url), "utf8");
  const seasonManagement = readFileSync(new URL("../../database/migrations/0007_workspace_season_management.sql", import.meta.url), "utf8");
  const settlementRepair = readFileSync(new URL("../../database/migrations/0032_voided_labour_wage_settlement_repair.sql", import.meta.url), "utf8");
  const membershipDedup = readFileSync(new URL("../../database/migrations/0031_workspace_membership_dedup.sql", import.meta.url), "utf8");
  assert.ok(tenantHardening.includes("NOT VALID"));
  assert.ok(seasonManagement.includes("IS DISTINCT FROM"));
  assert.ok(seasonManagement.includes("NOT VALID"));
  assert.ok(settlementRepair.includes("'settlement'::transaction_source"));
  assert.ok(settlementRepair.includes(")::transaction_type"));
  assert.ok(settlementRepair.includes("'labour_wage_settlement'"));
  assert.ok(membershipDedup.includes("CREATE UNIQUE INDEX IF NOT EXISTS workspace_memberships_workspace_user_uidx"));
  assert.ok(!membershipDedup.includes("DROP INDEX IF EXISTS workspace_memberships_workspace_user_uidx"));
});
