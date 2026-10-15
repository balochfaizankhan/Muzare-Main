import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sync = readFileSync(new URL("../src/services/syncService.ts", import.meta.url), "utf8");
const modulePage = readFileSync(new URL("../src/pages/ModulePage.tsx", import.meta.url), "utf8");

test("season snapshots never prune farm-level account masters", () => {
  assert.match(sync, /entity === "account" \|\| entity === "dateType"/);
});
test("refresh pulls canonical farm accounts independently of active season", () => {
  assert.match(sync, /fetchFarmAccounts\(activeContext\.token, activeContext\.workspaceId, activeContext\.farmId\)/);
  assert.match(sync, /cacheRecord\("account", account, false, activeContext\.farmId, null/);
});
test("account deletion is server validated", () => {
  assert.match(modulePage, /deleteFarmAccount\(token, workspaceId, farmId, canonicalAccountId\)/);
  assert.match(modulePage, /deleteAccountConfirm/);
});
