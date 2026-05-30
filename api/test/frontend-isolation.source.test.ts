import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = (relativePath: string) => readFile(new URL(`../../${relativePath}`, import.meta.url), "utf8");

test("logout and workspace switching clear IndexedDB and React Query caches", async () => {
  const auth = await source("web/src/auth/AuthProvider.tsx");
  assert.match(auth, /await clearWorkspaceCache\(\);\s+queryClient\.clear\(\);/);
  assert.match(auth, /const switchWorkspace[\s\S]*await selectWorkspace[\s\S]*await clearWorkspaceCache\(\);[\s\S]*queryClient\.clear\(\);/);
});

test("workspace queries and IndexedDB records carry workspace ownership", async () => {
  const dashboard = await source("web/src/pages/DashboardPage.tsx");
  const offlineDb = await source("web/src/lib/offline-db.ts");
  assert.match(dashboard, /queryKey: \["bootstrap", user\?\.workspaceId, sync\.farmId, sync\.seasonId\]/);
  assert.match(offlineDb, /workspaceId: string;/);
  assert.match(offlineDb, /seasonId\?: string \| null;/);
  assert.match(offlineDb, /table\.where\("workspaceId"\)\.equals\(getActiveWorkspaceId\(\)\)/);
});

test("sync queue uploads only records belonging to the active workspace farm and season", async () => {
  const sync = await source("web/src/services/syncService.ts");
  assert.match(sync, /pendingMutations\.where\("workspaceId"\)\.equals\(context\.workspaceId\)\.sortBy\("createdAt"\)/);
  assert.match(sync, /mutation\.farmId === context!\.farmId && mutation\.seasonId === context!\.seasonId/);
  assert.match(sync, /workspaceId: context\.workspaceId, farmId: mutation\.farmId/);
});

test("farm and season switching scope browser records to the selected context", async () => {
  const offlineDb = await source("web/src/lib/offline-db.ts");
  const dashboard = await source("web/src/pages/DashboardPage.tsx");
  const sync = await source("web/src/services/syncService.ts");
  assert.match(offlineDb, /record\.farmId === activeFarmId/);
  assert.match(offlineDb, /record\.seasonId === activeSeasonId/);
  assert.match(dashboard, /item\.id === query\.data\.activeFarmId/);
  assert.match(dashboard, /item\.id === query\.data\.activeSeasonId/);
  assert.match(sync, /item\.id === bootstrap\.activeFarmId/);
  assert.match(sync, /bootstrap\.activeSeasonId/);
});
