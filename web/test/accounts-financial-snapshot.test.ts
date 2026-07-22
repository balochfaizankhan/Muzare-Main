import assert from "node:assert/strict";
import { test } from "node:test";
import { isAccountsFinancialScope, settleAccountsFinancialSnapshot, type AccountsFinancialSnapshot } from "../src/lib/accountsFinancialSnapshot";

const scope = {
  workspaceId: "workspace-1",
  farmId: "farm-1",
  seasonId: "season-1",
};

const settled = (overrides: Partial<AccountsFinancialSnapshot> = {}): AccountsFinancialSnapshot => ({
  ...scope,
  snapshotVersion: "accounts-v1",
  generatedAt: "2026-07-22T10:00:00.000Z",
  ...overrides,
});

test("accounts financial snapshot keeps the last settled scope while canonical data is still pending", () => {
  const previous = settled();
  const next = settleAccountsFinancialSnapshot({
    scope,
    previousSnapshot: previous,
    canonicalReady: false,
    nextSnapshot: settled({ snapshotVersion: "pending" }),
  });
  assert.deepEqual(next, previous);
});

test("accounts financial snapshot rejects a stale farm or season snapshot", () => {
  assert.equal(isAccountsFinancialScope(settled({ farmId: "farm-2" }), scope), false);
  assert.equal(isAccountsFinancialScope(settled(), scope), true);
});

test("accounts financial snapshot accepts the canonical snapshot once the scoped result is ready", () => {
  const nextSnapshot = settled({ snapshotVersion: "accounts-v2", generatedAt: "2026-07-22T10:01:00.000Z" });
  const next = settleAccountsFinancialSnapshot({
    scope,
    previousSnapshot: settled(),
    canonicalReady: true,
    nextSnapshot,
  });
  assert.deepEqual(next, nextSnapshot);
});
