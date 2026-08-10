import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const migrationSource = readFileSync(new URL("../../database/migrations/0048_dispatch_serial_guard.sql", import.meta.url), "utf8");
const startupGuardSource = readFileSync(new URL("../src/db/dispatchSerialGuard.ts", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
const clientGuardSource = readFileSync(new URL("../../web/src/lib/dispatchSubmitGuard.ts", import.meta.url), "utf8");

test("dispatch serial allocation is authoritative, scoped and concurrency-safe", () => {
  assert.ok(migrationSource.includes("operational_records_dispatch_serial_lookup_idx"));
  assert.ok(migrationSource.includes("pg_advisory_xact_lock"));
  assert.ok(migrationSource.includes("existing.payload ->> 'date' = dispatch_date"));
  assert.ok(migrationSource.includes("existing.client_record_id <> NEW.client_record_id"));
  assert.ok(migrationSource.includes("jsonb_set(NEW.payload, '{serialNumber}'"));
});

test("stale dispatch edits preserve an already canonical server serial", () => {
  assert.ok(migrationSource.includes("TG_OP = 'UPDATE'"));
  assert.ok(migrationSource.includes("old_serial_collision"));
  assert.ok(migrationSource.includes("desired_serial := old_serial"));
});

test("dispatch serial guard is journaled once during API startup", () => {
  assert.ok(startupGuardSource.includes('STEP_KEY = "0048_dispatch_serial_guard_v2"'));
  assert.ok(startupGuardSource.includes("app_schema_migrations"));
  assert.ok(serverSource.includes("await ensureWorkspaceSchema();"));
  assert.ok(serverSource.includes("await ensureDispatchSerialGuard();"));
});

test("client double-submit guard adds no network or IndexedDB work to the save path", () => {
  assert.ok(clientGuardSource.includes('DISPATCH_FORM_SELECTOR = "form.dispatch-form"'));
  assert.ok(clientGuardSource.includes("stopImmediatePropagation"));
  assert.equal(clientGuardSource.includes("fetch("), false);
  assert.equal(clientGuardSource.includes("offlineDb"), false);
});
