import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/tenant-ownership.ts", import.meta.url), "utf8");

test("payment account references use farm scope, not season scope", () => {
  const accountValidation = source.match(/for \(const accountId of \[references\.accountId,[\s\S]*?if \(accountError\) return accountError;/)?.[0];
  assert.ok(accountValidation, "payment account validation must exist");
  assert.match(accountValidation, /farmId: references\.farmId/);
  assert.match(accountValidation, /seasonId: undefined/);
  assert.match(accountValidation, /entityTypes: \["account"\]/);
});

test("partner ledger references still validate season scope", () => {
  const ledgerValidation = source.match(/if \(typeof references\.ledgerId === "string"\) \{[\s\S]*?if \(ledgerError\) return ledgerError;/)?.[0];
  assert.ok(ledgerValidation);
  assert.match(ledgerValidation, /seasonId: references\.seasonId/);
});
