import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

test("canonical labour reports refetch by complete context and discard stale responses", () => {
  const hook = source("hooks/useCanonicalLabourFinancials.ts");
  const reports = source("pages/workspace/Reports.tsx");
  assert.match(hook, /const sync = useSyncState\(\)/);
  assert.match(hook, /queryKey: \["canonical-labour-financials", token, workspaceId, farmId, seasonId\]/);
  assert.match(hook, /queryFn: \(\{ signal \}\)/);
  assert.match(hook, /const farmId = sync\.farmId \?\? ""/);
  assert.match(hook, /const seasonId = sync\.seasonId \?\? ""/);
  assert.match(hook, /placeholderData: undefined/);
  assert.match(reports, /setCanonicalAdvancePositions\(\[\]\)/);
  assert.match(reports, /const sequence = \+\+canonicalRequestSequence\.current/);
  assert.match(reports, /sequence !== canonicalRequestSequence\.current \|\| controller\.signal\.aborted/);
  assert.match(reports, /return \(\) => controller\.abort\(\)/);
});

test("downstream pages consume the shared canonical labour model", () => {
  const modulePage = source("pages/ModulePage.tsx");
  const reports = source("pages/workspace/Reports.tsx");
  const activity = source("lib/workspaceActivity.ts");
  assert.ok((modulePage.match(/useCanonicalLabourFinancials\(\)/g) ?? []).length >= 3);
  assert.match(reports, /canonicalFinancials\.data\?\.accountEntries/);
  assert.match(reports, /canonicalFinancials\.data\?\.expenses/);
  assert.match(activity, /canonical\?\.activity/);
  assert.match(activity, /replacedLegacySourceIds/);
});
