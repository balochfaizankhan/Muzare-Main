import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("labour work scope plumbing persists individual and group earning fields end to end", () => {
  const api = read("../src/routes/operational-sync.ts");
  const settlements = read("../src/lib/labour-wage-settlements.ts");
  const webPage = read("../../web/src/pages/workspace/LabourEarnings.tsx");
  const apiTypes = read("../../web/src/lib/api.ts");

  assert.ok(api.includes('earningScope: z.enum(["individual", "group"]).optional()'));
  assert.ok(api.includes("Select a labour group."));
  assert.ok(api.includes("The selected labour group has no foreman assigned."));
  assert.ok(api.includes("Group work cannot be assigned to an individual labourer."));
  assert.ok(settlements.includes("individualLabourWorkWages"));
  assert.ok(settlements.includes("groupLabourWorkWages"));
  assert.ok(settlements.includes('earningScope: "group"'));
  assert.ok(settlements.includes("includedEarnings"));
  assert.ok(webPage.includes("Work for"));
  assert.ok(webPage.includes("Individual labour"));
  assert.ok(webPage.includes("Labour group"));
  assert.ok(webPage.includes("Assigned foreman"));
  assert.ok(webPage.includes("Record group work"));
  assert.ok(webPage.includes("labourGroupId"));
  assert.ok(apiTypes.includes("individualLabourWorkWages?: number;"));
  assert.ok(apiTypes.includes("groupLabourWorkWages?: number;"));
  assert.ok(apiTypes.includes('earningScope: "individual" | "group";'));
});

