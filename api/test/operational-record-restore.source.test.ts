import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../src/routes/operational-sync.ts", import.meta.url), "utf8");

function routeSource(method: "app.delete" | "app.post", path: string) {
  const marker = `${method}("${path}"`;
  const start = source.indexOf(marker);
  assert.ok(start > -1, `route ${method} ${path} should exist`);
  const end = source.indexOf("\n  });", start);
  return source.slice(start, end);
}

test("sale is a supported soft-delete entity (fixes a prior schema gap that made sale deletion reject with 400)", () => {
  assert.match(source, /const financialDeleteSchema = z\.object\(\{[\s\S]*?entity: z\.enum\(\["partnerEntry", "advance", "voucher", "sale"\]\)/);
});

test("restore request schema accepts the same soft-deletable entities as delete", () => {
  assert.match(source, /const restoreRecordSchema = z\.object\(\{[\s\S]*?entity: z\.enum\(\["partnerEntry", "advance", "voucher", "sale"\]\)/);
});

test("every soft-deletable entity has a distinct, correctly-labeled delete and restore audit action (fixes sale/advance being mislabeled)", () => {
  assert.match(source, /partnerEntry: \{ deleted: "partner_ledger_deleted", restored: "partner_ledger_restored" \}/);
  assert.match(source, /advance: \{ deleted: "labour_advance_deleted", restored: "labour_advance_restored" \}/);
  assert.match(source, /voucher: \{ deleted: "expense_voucher_deleted", restored: "expense_voucher_restored" \}/);
  assert.match(source, /sale: \{ deleted: "sale_deleted", restored: "sale_restored" \}/);
  const deleteRoute = routeSource("app.delete", "/v1/workspace/operational-records");
  assert.match(deleteRoute, /action: softDeleteAuditAction\[entityForAudit\]\.deleted/);
  assert.doesNotMatch(deleteRoute, /"labour_advance_deleted"\s*:\s*"labour_advance_deleted"/, "the old catch-all ternary that mislabeled sale as a labour advance deletion must be gone");
});

test("restore route requires the same permission chain as delete (workspace write, module delete permission, farm access, active season, tenant ownership, MANAGE_RECORDS)", () => {
  const restoreRoute = routeSource("app.post", "/v1/workspace/operational-records/restore");
  assert.match(restoreRoute, /requireWorkspaceWrite\(request\.appUser, parsed\.data\.workspaceId, parsed\.data\.entity\)/);
  assert.match(restoreRoute, /requireEntityDelete\(request\.appUser, parsed\.data\.workspaceId, parsed\.data\.entity\)/);
  assert.match(restoreRoute, /hasFarmAccess\(request\.appUser, parsed\.data\.workspaceId, parsed\.data\.farmId\)/);
  assert.match(restoreRoute, /validateTenantReferences\(parsed\.data\.workspaceId/);
  assert.match(restoreRoute, /hasPermission\(request\.appUser, "MANAGE_RECORDS", parsed\.data\.workspaceId\)/);
  // Owner bypass is not re-implemented here — hasPermission/hasModulePermission already grant
  // workspace_owner unconditional access (see api/src/permissions.ts), so this route inherits
  // that bypass automatically without any owner-specific branch.
  assert.doesNotMatch(restoreRoute, /role === "workspace_owner"/, "owner bypass must come from the shared permission helpers, not a route-local special case");
});

test("restore is idempotent: restoring an already-active record is a no-op and never double-applies", () => {
  const restoreRoute = routeSource("app.post", "/v1/workspace/operational-records/restore");
  assert.match(restoreRoute, /if \(!isDeletedOperationalPayload\(entry\.payload\)\) return reply\.code\(204\)\.send\(\);/);
});

test("restore preserves workspace/farm/season isolation via the same scoped lookup as delete", () => {
  const restoreRoute = routeSource("app.post", "/v1/workspace/operational-records/restore");
  assert.match(restoreRoute, /eq\(operationalRecords\.workspaceId, parsed\.data\.workspaceId\)/);
  assert.match(restoreRoute, /eq\(operationalRecords\.farmId, parsed\.data\.farmId\)/);
  assert.match(restoreRoute, /seasonCondition/);
});

test("restore clears the deletion flags exactly once per call and logs before/after in dedicated audit columns", () => {
  const restoreRoute = routeSource("app.post", "/v1/workspace/operational-records/restore");
  assert.match(restoreRoute, /deletedAt: null, deletedBy: null, deletionReason: null/);
  assert.match(restoreRoute, /beforeJson: entry\.payload, afterJson: payload/);
});

test("delete now also records before/after in the dedicated audit columns (previously stuffed into details only)", () => {
  const deleteRoute = routeSource("app.delete", "/v1/workspace/operational-records");
  assert.match(deleteRoute, /beforeJson: entry\.payload, afterJson: payload/);
});
