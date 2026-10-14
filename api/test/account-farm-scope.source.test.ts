import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/routes/operational-sync.ts", import.meta.url), "utf8");

test("Account operational sync is farm scoped", () => {
  assert.match(source, /parsed\.data\.entity === "dateType" \|\| parsed\.data\.entity === "account"/);
  assert.match(source, /!\["dateType", "account"\]\.includes\(parsed\.data\.entity\)/);
});

test("farm Account masters are returned across seasons and canonical-only accounts are synthesized", () => {
  assert.match(source, /eq\(operationalRecords\.entityType, "account"\)/);
  assert.match(source, /const canonicalAccounts = await db\.select/);
  assert.match(source, /canonicalAccountId: account\.id/);
});

test("same-farm same-name Account conflict is friendly and machine-readable", () => {
  assert.match(source, /code: "account_name_exists"/);
  assert.match(source, /existingAccountId: sameNameAccount\.id/);
});
