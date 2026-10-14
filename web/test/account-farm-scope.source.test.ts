import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const offline = readFileSync(new URL("../src/lib/offline-db.ts", import.meta.url), "utf8");
const sync = readFileSync(new URL("../src/services/syncService.ts", import.meta.url), "utf8");
const modulePage = readFileSync(new URL("../src/pages/ModulePage.tsx", import.meta.url), "utf8");
const dashboard = readFileSync(new URL("../src/pages/DashboardPageBase.tsx", import.meta.url), "utf8");
const reports = readFileSync(new URL("../src/pages/workspace/Reports.tsx", import.meta.url), "utf8");
const payments = readFileSync(new URL("../src/pages/workspace/WorkforcePayments.tsx", import.meta.url), "utf8");

test("Account masters are farm scoped in local storage and creation", () => {
  assert.match(offline, /v13 normalizes Account masters to farm scope/);
  assert.match(offline, /record\.seasonId = null/);
  assert.match(modulePage, /makeConfigRecord\(\)/);
});

test("all primary account consumers use farm-scoped account selectors", () => {
  assert.match(modulePage, /workspaceConfigRecords\(offlineDb\.accounts/);
  assert.match(dashboard, /workspaceConfigRecords\(offlineDb\.accounts\)/);
  assert.match(reports, /workspaceConfigRecords\(offlineDb\.accounts\)/);
  assert.match(payments, /workspaceConfigRecords\(offlineDb\.accounts/);
});

test("Account sync ignores season context and repairs duplicate failed creates", () => {
  assert.match(sync, /entity === "dateType" \|\| entity === "account"/);
  assert.match(sync, /repairFarmScopedAccountQueueItems/);
  assert.match(sync, /remapLocalAccountIdentity/);
});

test("Create Account blocks a duplicate farm account before queueing", () => {
  assert.match(modulePage, /accountAlreadyExistsFarm/);
  assert.match(modulePage, /account\.name\.trim\(\)\.toLowerCase\(\) === accountName\.toLowerCase\(\)/);
});
