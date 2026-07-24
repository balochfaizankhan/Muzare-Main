import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

test("canonical labour reports refetch by complete context and discard stale responses", () => {
  const hook = source("hooks/useCanonicalLabourFinancials.ts");
  const reports = source("pages/workspace/Reports.tsx");
  assert.match(hook, /const sync = useSyncState\(\)/);
  assert.match(hook, /queryKey: \["canonical-labour-financials", token, workspaceId, farmId, seasonId\]/);
  assert.match(hook, /queryFn: async \(\{ signal \}\)/);
  assert.match(hook, /const farmId = sync\.farmId \?\? ""/);
  assert.match(hook, /const seasonId = sync\.seasonId \?\? ""/);
  assert.match(hook, /placeholderData: undefined/);
  assert.match(hook, /scope\.workspaceId !== workspaceId \|\| scope\.farmId !== farmId \|\| scope\.seasonId !== seasonId/);
  assert.match(hook, /invalidateQueries\(\{ queryKey: \["canonical-labour-financials", token, workspaceId, farmId, seasonId\], exact: true \}\)/);
  assert.match(reports, /queryKey: \["reports-bootstrap", user\?\.workspaceId, sync\.farmId, sync\.seasonId\]/);
  assert.match(reports, /sequence !== requestSequence/);
  assert.match(reports, /window\.addEventListener\("muzare-data-refresh", reloadScopedRecords\)/);
  assert.match(reports, /bootstrapQuery\.data\?\.activeFarmId, bootstrapQuery\.data\?\.activeSeasonId, sync\.farmId, sync\.seasonId, user\?\.workspaceId/);
  assert.match(reports, /canonicalFinancials\.data\?\.advancePositions/);
  assert.match(reports, /farmId: canonicalFinancials\.farmId/);
  assert.match(reports, /seasonId: canonicalFinancials\.seasonId/);
  assert.doesNotMatch(reports, /fetchAllLabourPaymentAdvances/);
  assert.doesNotMatch(reports, /setCanonicalAdvancePositions/);
});

test("downstream pages consume the shared canonical labour model", () => {
  const modulePage = source("pages/ModulePage.tsx");
  const reports = source("pages/workspace/Reports.tsx");
  const activity = source("lib/workspaceActivity.ts");
  assert.ok((modulePage.match(/useCanonicalLabourFinancials\(\)/g) ?? []).length >= 3);
  assert.match(reports, /canonicalFinancials\.data\?\.accountEntries/);
  assert.match(reports, /canonicalFinancials\.data\?\.expenses/);
  assert.match(reports, /canonicalFinancials\.data\?\.expenseAccountAttributions/);
  assert.match(reports, /canonicalFinancials\.data\?\.advancePositions/);
  assert.match(reports, /\[\.\.\.canonicalAdvanceRows, \.\.\.legacyAdvanceRows\]/);
  assert.match(reports, /!replacedLegacySourceIds\.has\(item\.id\)/);
  assert.match(reports, /activeAdvanceReportRows\.reduce\(\(sum, item\) => sum \+ item\.appliedAmount/);
  assert.match(reports, /activeAdvanceReportRows\.reduce\(\(sum, item\) => sum \+ item\.outstandingAmount/);
  assert.match(modulePage, /setSettledAccountsSnapshot/);
  assert.match(modulePage, /settledAccountsSnapshotRef\.current/);
  assert.match(modulePage, /const canonicalAccountsFinancials = snapshot\?\.canonical \?\? null/);
  assert.match(modulePage, /const settledLabourWages = \(canonicalAccountsFinancials\?\.expenses \?\? \[\]\)/);
  assert.match(modulePage, /const paymentsDue = \(canonicalAccountsFinancials\?\.expenses \?\? \[\]\)/);
  assert.match(modulePage, /const totalBusinessExpenses = totalVoucherExpenses \+ settledLabourWages/);
  assert.doesNotMatch(modulePage, /canonicalLabourExpense = canonicalFinancials\.data\?\.summary\.wageExpense/);
  assert.match(modulePage, /canonical\.directLabourPayments/);
  assert.match(modulePage, /canonical\.outstandingLabourAdvances/);
  assert.match(modulePage, /t\("accountsPage\.labourWageSettlementsGroup"\)/);
  // Partner Status cards are grouped by canonical account id (one card per canonical
  // partner), never appended by raw represented-account ids.
  assert.match(reports, /buildCanonicalDisplayAccounts\(accounts, accountLookup, canonicalPartnerPositions\)/);
  assert.match(reports, /aggregatePartnerLiabilityPositions\(/);
  assert.doesNotMatch(reports, /representedAccountIds/);
  assert.match(reports, /expenseAccountTotals\.map/);
  assert.match(reports, /t\("reportsPage\.directLabourPayments"\)/);
  assert.doesNotMatch(reports, /canonicalAdvanceCoverageComplete/);
  assert.match(activity, /canonical\?\.activity/);
  assert.match(activity, /replacedLegacySourceIds/);
});
