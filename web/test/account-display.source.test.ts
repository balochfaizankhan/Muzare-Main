import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const modulePage = readFileSync(new URL("../src/pages/ModulePage.tsx", import.meta.url), "utf8");

test("accounts page renders canonical display accounts instead of raw duplicate partner rows", () => {
  assert.match(modulePage, /buildCanonicalDisplayAccounts\(accounts, accountLookup, canonicalAccountsFinancials\?\.partnerPositions \?\? \[\]\)/);
  assert.match(modulePage, /displayAccounts\.map\(\(\{ id, account \}\) =>/);
  assert.doesNotMatch(modulePage, /<div className="account-grid">\s*\{accounts\.map\(/);
});
