import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function source(path: string) {
  return readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
}

test("auth startup no longer imports the sync stack eagerly", () => {
  const authSource = source("auth/AuthProvider.tsx");
  assert.ok(!authSource.includes('from "../services/syncService"'));
  assert.ok(authSource.includes('await import("../services/syncService")'));
  assert.ok(authSource.includes("markStartup(\"session-refresh-start\")"));
});

test("service worker registration is deferred off the render path", () => {
  const mainSource = source("main.tsx");
  const scheduleIndex = mainSource.indexOf("scheduleBackgroundTask(async () => {");
  const registerIndex = mainSource.indexOf("registerSW({ immediate: true })");
  assert.ok(scheduleIndex >= 0);
  assert.ok(registerIndex > scheduleIndex);
  assert.ok(mainSource.includes('await import("virtual:pwa-register")'));
});

test("workspace sync startup reuses the bootstrap snapshot and defers background refresh", () => {
  const syncSource = source("services/syncService.ts");
  assert.ok(syncSource.includes("bootstrapSnapshot?: BootstrapData | null"));
  assert.ok(syncSource.includes("const bootstrap = bootstrapSnapshot ?? await fetchBootstrap(token);"));
  assert.ok(syncSource.includes('void scheduleBackgroundTask(async () => {'));
  assert.ok(syncSource.includes('emitStartup("ready", navigator.onLine ? i18n.t("sync.connectedReady") : i18n.t("sync.offlineReady"), {'));
  assert.ok(syncSource.includes("await refreshOperationalData({ notifySuccess: false });"));
  assert.ok(syncSource.includes("await syncPendingRecords();"));
});

test("workspace layout passes the bootstrap snapshot into sync startup", () => {
  const layoutSource = source("layouts/WorkspaceLayout.tsx");
  assert.ok(layoutSource.includes("startSyncService(token, user.workspaceId, bootstrap.data ?? null)"));
  assert.ok(layoutSource.includes("markStartup(\"workspace-bootstrap-ready\""));
});

test("dashboard refresh is batched and rendered with a loading skeleton", () => {
  const dashboardSource = source("pages/DashboardPage.tsx");
  assert.ok(dashboardSource.includes("scheduleBackgroundTask(async () => {"));
  assert.ok(dashboardSource.includes("refreshInFlight.current"));
  assert.ok(dashboardSource.includes("dashboard-data-ready"));
  assert.ok(dashboardSource.includes("dashboardLoading ? t(\"dashboardPage.loadingActivity\")"));
});
