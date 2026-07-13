import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("stale queue records cannot be rebound to the active context", () => {
  const sync = read("../../web/src/services/syncService.ts");
  const layout = read("../../web/src/layouts/WorkspaceLayout.tsx");
  const repairStart = sync.indexOf("export async function repairStaleSyncQueueItem");
  const repairEnd = sync.indexOf("\nexport function stopSyncService", repairStart);
  const repair = sync.slice(repairStart, repairEnd);

  assert.ok(repair.includes('item.entity === "dateType"'));
  assert.ok(repair.includes("belongs to a different workspace, farm, or season"));
  assert.doesNotMatch(repair, /workspaceId:\s*context\.workspaceId/);
  assert.doesNotMatch(repair, /farmId:\s*payload\.farmId\s*\?\?/);
  assert.doesNotMatch(repair, /seasonId:\s*payload\.seasonId\s*\?\?/);
  assert.ok(layout.includes("{isDateTypeQueueItem && <button"));
  assert.ok(!layout.includes('item.status === "stale_context") && <button'));
});

test("operational updates preserve server fields omitted by older clients", () => {
  const source = read("../src/routes/operational-sync.ts");
  assert.ok(source.includes("...(existing?.payload ?? {})"));
  assert.ok(source.includes("...parsed.data.record"));
});

test("unexpected server errors are not returned verbatim", () => {
  const source = read("../src/app.ts");
  assert.ok(source.includes("if (statusCode < 500)"));
  assert.ok(source.includes('requestId: request.id'));
  assert.ok(source.includes('message: "Something went wrong. Please try again or contact support."'));
});

test("local signup exits before querying PostgreSQL", () => {
  const source = read("../src/routes/session.ts");
  const signupStart = source.indexOf('app.post("/v1/auth/signup"');
  const loginStart = source.indexOf('app.post("/v1/auth/login"', signupStart);
  const signup = source.slice(signupStart, loginStart);
  assert.ok(signup.indexOf("if (localDevelopmentMode)") < signup.indexOf("db.select"));
});
