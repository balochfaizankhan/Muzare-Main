import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/lib/voucherCollections.ts", import.meta.url), "utf8");

test("workspace voucher reads are always active-season scoped", () => {
  const start = source.indexOf("export async function loadWorkspaceVouchers");
  const block = source.slice(start);
  assert.match(block, /workspaceRecords\(offlineDb\.vouchers, \{\s*includeDeleted: true,\s*\}\)/);
  assert.doesNotMatch(block, /includeGeneralFarmRecords: options\.includeGeneralFarmRecords/);
  assert.doesNotMatch(block, /includeImportedAcrossSeasons: options\.includeImportedAcrossSeasons/);
});

test("cross-season compatibility flags are explicitly deprecated instead of widening financial reads", () => {
  assert.match(source, /Expense vouchers are season-scoped financial records/);
  assert.match(source, /Historical imports must be assigned to the correct season/);
});
