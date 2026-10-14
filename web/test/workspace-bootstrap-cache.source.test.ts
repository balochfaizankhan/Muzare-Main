import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const bootstrap = readFileSync(new URL("../src/lib/workspaceBootstrap.ts", import.meta.url), "utf8");
const seasons = readFileSync(new URL("../src/pages/workspace/Seasons.tsx", import.meta.url), "utf8");
const layout = readFileSync(new URL("../src/layouts/WorkspaceLayout.tsx", import.meta.url), "utf8");

test("workspace bootstrap is cached and used as immediate React Query initial data", () => {
  assert.match(bootstrap, /muzare-workspace-bootstrap-v1:/);
  assert.match(bootstrap, /initialData: \(\) => readCachedWorkspaceBootstrap/);
  assert.match(bootstrap, /writeCachedWorkspaceBootstrap\(resolvedWorkspaceId, data\)/);
});

test("workspace shell and Seasons share the same cached bootstrap query contract", () => {
  assert.match(layout, /useQuery\(workspaceBootstrapQueryOptions\(token, user\?\.workspaceId\)\)/);
  assert.match(seasons, /useQuery\(workspaceBootstrapQueryOptions\(token, workspaceId\)\)/);
});

test("Seasons uses restored sync context while bootstrap revalidates and avoids a false no-farm message", () => {
  assert.match(seasons, /bootstrap\.data\?\.activeFarmId \?\? sync\.farmId \?\? ""/);
  assert.match(seasons, /!farmId && \(bootstrap\.isLoading \|\| bootstrap\.isFetching\)/);
  assert.match(seasons, /!farmId && !bootstrap\.isLoading && !bootstrap\.isFetching/);
});
