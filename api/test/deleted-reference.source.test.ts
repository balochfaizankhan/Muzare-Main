import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/tenant-ownership.ts", import.meta.url), "utf8");
const validation = source.split("async function validateOperationalEntityReference(")[1]?.split("export async function validateTenantReferences(")[0];

test("reference validation checks deletedAt before accepting matching scope", () => {
  assert.ok(validation);
  assert.ok(validation.includes("referenced.payload.deletedAt"));
  const deletedCheck = validation.indexOf("referenced.payload.deletedAt");
  const acceptMatch = validation.indexOf("return null;", deletedCheck);
  assert.ok(acceptMatch > deletedCheck, "scope acceptance must follow deletion check");
  assert.ok(validation.includes("scopedRecord ?? await findOperationalReference"), "prefer matching scoped record");
});

test("farm account references remain season-independent", () => {
  assert.match(source, /entity: "payment account",[\s\S]*?entityTypes: \["account"\]/);
  assert.match(source, /seasonId: undefined,[\s\S]*?clientRecordId: accountId/);
});
