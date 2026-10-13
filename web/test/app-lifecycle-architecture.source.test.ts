import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const auth = readFileSync(new URL("../src/auth/AuthProvider.tsx", import.meta.url), "utf8");
const sync = readFileSync(new URL("../src/services/syncService.ts", import.meta.url), "utf8");
const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const layout = readFileSync(new URL("../src/layouts/WorkspaceLayout.tsx", import.meta.url), "utf8");

test("workspace switching preserves workspace-scoped offline cache", () => {
  const switchStart = auth.indexOf("const switchWorkspace");
  const switchEnd = auth.indexOf("const updateUser", switchStart);
  const block = auth.slice(switchStart, switchEnd);
  assert.match(block, /prepareWorkspaceSwitch\(\)/);
  assert.doesNotMatch(block, /clearWorkspaceCache\(\)/);
});

test("cached user permissions stay usable during silent session validation", () => {
  assert.match(auth, /setPermissionContextUser\(user\)/);
  assert.doesNotMatch(auth, /setPermissionContextUser\(sessionRefreshing \? null : user\)/);
});

test("manual Sync pushes only while background reconciliation pushes then pulls", () => {
  const syncNowStart = sync.indexOf("export async function syncNow");
  const refreshStart = sync.indexOf("export async function refreshOperationalData", syncNowStart);
  const syncNow = sync.slice(syncNowStart, refreshStart);
  assert.doesNotMatch(syncNow, /refreshOperationalData/);

  const reconcileStart = sync.indexOf("export async function reconcileWorkspaceData");
  const pruneStart = sync.indexOf("async function pruneSynchronizedCache", reconcileStart);
  const reconcile = sync.slice(reconcileStart, pruneStart);
  assert.ok(reconcile.indexOf("syncPendingRecords()") < reconcile.indexOf("refreshOperationalData("));
  assert.match(sync, /window\.addEventListener\("online",[\s\S]*reconcileWorkspaceData/);
});

test("lazy page routes use in-shell loading while layout boundaries keep the full startup screen", () => {
  assert.match(app, /route-content-loading/);
  assert.match(app, /routeElement\(<WorkspaceLayout \/>, "routeLoading\.workspaceShell", true\)/);
  assert.match(app, /routeElement\(<AdminLayout \/>, "routeLoading\.adminWorkspace", true\)/);
});

test("workspace shell exposes distinct refresh and sync handlers", () => {
  assert.match(layout, /const handleRefresh = async/);
  assert.match(layout, /await refreshOperationalData\(\)/);
  assert.match(layout, /const handleSync = async/);
  assert.match(layout, /await syncNow\(\)/);
});
