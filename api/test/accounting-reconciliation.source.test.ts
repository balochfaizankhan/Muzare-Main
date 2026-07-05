import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("debug accounting reconciliation route exposes deployed build info and settlement fallback tracing", () => {
  const source = readFileSync(new URL("../src/routes/accounting-reconciliation.ts", import.meta.url), "utf8");
  assert.ok(source.includes('"/v1/debug/accounting-reconciliation"'));
  assert.ok(source.includes("buildInfo"));
  assert.ok(source.includes("transactionAccountIds.includes(selectedAccount.id)"));
  assert.ok(source.includes("Settlement row is missing a settlement account link"));
  assert.ok(source.includes("Accounting entries are missing."));
  assert.ok(source.includes("normalizeSettlementPayload"));
});
