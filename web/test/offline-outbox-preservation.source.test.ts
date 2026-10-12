import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const offlineDb = readFileSync(new URL("../src/lib/offline-db.ts", import.meta.url), "utf8");
const syncService = readFileSync(new URL("../src/services/syncService.ts", import.meta.url), "utf8");
const authProvider = readFileSync(new URL("../src/auth/AuthProvider.tsx", import.meta.url), "utf8");

test("cache clearing preserves the pending mutation outbox by default", () => {
  assert.match(offlineDb, /preservePendingMutations = options\.preservePendingMutations \?\? true/);
  assert.match(offlineDb, /table\.name !== "pendingMutations"/);
  assert.match(syncService, /clearCachedData\(\{ preservePendingMutations: true \}\)/);
});

test("logout and workspace switching guard unresolved local changes before changing session context", () => {
  assert.match(syncService, /confirmPendingChangesBeforeSessionTransition\(action: "logout" \| "switch_workspace"\)/);
  assert.match(syncService, /syncPendingRecords\(\{ force: true \}\)/);
  assert.match(syncService, /getUnresolvedWorkspaceMutationCount\(workspaceId\)/);

  const logoutGuard = authProvider.indexOf('confirmPendingChangesBeforeSessionTransition("logout")');
  const logoutRequest = authProvider.indexOf("logoutRequest(token)");
  assert.ok(logoutGuard >= 0 && logoutGuard < logoutRequest, "logout must guard pending changes before invalidating the session");

  const switchGuard = authProvider.indexOf('confirmPendingChangesBeforeSessionTransition("switch_workspace")');
  const selectWorkspace = authProvider.indexOf("selectWorkspace(token, workspaceId)");
  assert.ok(switchGuard >= 0 && switchGuard < selectWorkspace, "workspace switch must guard pending changes before changing server context");
});

test("session invalidation can clear disposable cache without erasing queued mutations", () => {
  assert.match(authProvider, /void clearWorkspaceCache\(\)/);
  assert.match(syncService, /pending mutation table is a durable\s+\/\/ local outbox/i);
});
