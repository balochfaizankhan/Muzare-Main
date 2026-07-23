import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = (relativePath: string) => readFile(new URL(`../../${relativePath}`, import.meta.url), "utf8");

test("the pool preview, settlement posting and per-voucher scope check all use group ownership, never member snapshots", async () => {
  const routes = await source("api/src/routes/labour-payments.ts");
  assert.match(routes, /function duePoolGroupId\(due: typeof labourDues\.\$inferSelect\)/);
  assert.match(routes, /dueLabourGroupId: poolGroupId,/);
  assert.match(routes, /resolveAdvancePoolGroupId\(advance\) === position\.due\.labourGroupId/);
  assert.doesNotMatch(routes, /snapshot\.memberCalculationSnapshot|memberCalculationSnapshot\)/, "member calculation snapshots must no longer influence advance eligibility");
  assert.doesNotMatch(routes, /loadDueEligibleMembership|resolveDueEligibleMembers|dueMemberPayableShares/);
  const lib = await source("api/src/lib/labour-payments.ts");
  assert.match(lib, /export function resolveAdvancePoolGroupId\(/);
  assert.doesNotMatch(lib, /memberPayableShares|eligibleMemberIds/, "the pool calculator no longer accepts member restrictions");
});

test("the due pool response exposes the authoritative group-pool position derived from transactions", async () => {
  const routes = await source("api/src/routes/labour-payments.ts");
  assert.match(routes, /groupPool: pool\.groupPool,/);
  assert.match(routes, /totalAdvances: Number\(groupTotals\.total\.toFixed\(2\)\)/);
  assert.match(routes, /outstandingAdvances: Number\(Math\.max\(groupTotals\.total - groupTotals\.applied - unattributedPooledConsumption - groupTotals\.refunded, 0\)\.toFixed\(2\)\)/);
});

test("the advance-pools endpoint reports pools per group plus a reconciliation-review list, never guessing from live membership", async () => {
  const routes = await source("api/src/routes/labour-payments.ts");
  assert.match(routes, /"\/v1\/workspace\/:workspaceId\/labour-payments\/advance-pools"/);
  assert.match(routes, /reviewAdvances\.push\(/);
  assert.match(routes, /No preserved labour-group evidence exists for this advance\./);
  assert.match(routes, /outstandingAdvances: money\(Math\.max\(farmWide\.total - farmWide\.applied - farmWide\.refunded, 0\)\)/);
});

test("a new advance for a labourer who belongs to a group is recorded into the group pool, with received-by informational only", async () => {
  const routes = await source("api/src/routes/labour-payments.ts");
  assert.match(routes, /input\.recipientScope = "LABOUR_GROUP";\s*\n\s*input\.labourGroupId = memberGroupId;/);
  assert.match(routes, /input\.receivedByLabourerId = input\.receivedByLabourerId \?\? input\.labourerId;/);
  assert.match(routes, /must belong to the selected labour group/);
  // Received-by is optional for group advances now.
  assert.doesNotMatch(routes, /Select the labourer who received this group advance\.",\s*\n\s*\}\);\s*\n\s*if \(/);
  // There is no standalone individual advance pool: a labourer with no group
  // cannot receive a new advance at all.
  assert.match(routes, /Assign this labourer to a labour group before recording an advance\./);
});

test("recording an advance is one workflow: the form selects the recipient labourer, resolves the group automatically, and never asks for a group-advance entry", async () => {
  const ui = await source("web/src/pages/workspace/WorkforcePayments.tsx");
  assert.match(ui, /advancesView\.recipientLabourerLabel/);
  assert.match(ui, /advancesView\.recipientGroupLabel/, "the resolved labour group is displayed after selecting the recipient labourer");
  assert.match(ui, /advancesView\.assignGroupBeforeAdvance/, "a group-less labourer blocks posting with the assignment message");
  assert.match(ui, /labourerId && \(editingAdvance \|\| recipientGroup\)/, "a new advance cannot be submitted without a resolved labour group");
  assert.doesNotMatch(ui, /openRecordAdvance\(false\); setScope\("LABOUR_GROUP"\)/, "pool cards must open the single Record advance form, not a group-advance variant");
  const i18n = await source("web/src/i18n.ts");
  assert.match(i18n, /No group advances recorded yet\./);
  assert.doesNotMatch(i18n, /Record a group advance to open one\./, "the empty state must not instruct recording a separate group advance");
});

test("migration 0046 stamps preserved group ownership, backfills FIFO source allocations idempotently, and parks queued attendance requests", async () => {
  const migration = await source("database/migrations/0046_group_advance_pools_and_attendance_due_retirement.sql");
  assert.match(migration, /AND labour_group_id IS NULL/, "the ownership backfill only fills missing values (idempotent)");
  assert.match(migration, /NULLIF\(recipient_snapshot->>'labourGroupId', ''\)/);
  assert.match(migration, /financial_scope_key LIKE 'group:%'/);
  assert.match(migration, /IF due\.recipient_scope = 'LABOUR_GROUP' AND due\.labour_group_id IS NOT NULL THEN\s*\n\s*RETURN advance_group_id IS NOT NULL AND advance_group_id = due\.labour_group_id;/);
  assert.match(migration, /NOT EXISTS \(SELECT 1 FROM labour_advance_application_sources s WHERE s\.application_id = p\.id\)/, "the source backfill skips already-attributed applications (idempotent)");
  assert.match(migration, /IF remaining > 0\.005 THEN\s*\n\s*DELETE FROM labour_advance_application_sources WHERE application_id = app_row\.id;/, "never partially misattribute an application");
  assert.match(migration, /UPDATE labour_wage_settlement_create_requests/);
  assert.match(migration, /Attendance-based Labour Dues are no longer supported\. Create a direct labour group due instead\./);
  assert.doesNotMatch(migration, /DROP TABLE|DROP COLUMN|DELETE FROM labour_dues|DELETE FROM labour_payment_vouchers/, "the migration is non-destructive");
  const migrations = await source("api/src/db/migrations.ts");
  assert.match(migrations, /\{ key: "0046_group_advance_pools_and_attendance_due_retirement", kind: "sql", required: true, sourceUrl: groupAdvancePoolsAndAttendanceDueRetirementMigrationUrl \},/);
});

test("no fake 'Applied advances — pooled/non-cash' account exists anywhere in the read model or reports", async () => {
  const readModel = await source("api/src/lib/labour-financial-read-model.ts");
  assert.doesNotMatch(readModel, /pooled\/non-cash”|Applied advances — pooled\/non-cash|pooled_non_cash/);
  assert.match(readModel, /applicationSourcesByApplicationId/, "pooled applications attribute to original funding accounts via persisted sources");
});

test("the web advances page shows group pool cards with leader and the four aggregate totals, and 'Use all available' applies min(pool, due)", async () => {
  const ui = await source("web/src/pages/workspace/WorkforcePayments.tsx");
  assert.match(ui, /fetchLabourAdvancePools/);
  assert.match(ui, /advancesView\.groupPoolsTitle/);
  assert.match(ui, /pool\.outstandingAdvances/);
  assert.match(ui, /advancesView\.receivedByInformationalLabel/);
  assert.match(ui, /onClick=\{\(\) => setPoolApplication\(advancePool\.maximumApplicable\)\}>\{t\("workforcePaymentsPage\.reviewSettle\.useAllAvailable"\)\}/);
  assert.doesNotMatch(ui, /setPoolApplication\(advancePool\.globalOutstanding\)/);
  // The settlement dialog shows the group position and no per-voucher pickers.
  assert.match(ui, /reviewSettle\.totalGroupAdvances/);
  assert.match(ui, /reviewSettle\.previouslyAppliedAdvances/);
  assert.match(ui, /reviewSettle\.groupOutstandingAdvances/);
  assert.doesNotMatch(ui, /reviewSettle\.viewAllocationDetails|reviewSettle\.whyExcluded|reviewSettle\.exclusions\./, "individual voucher allocation and exclusion sections are removed");
  assert.match(ui, /reviewSettle\.applyAndPayAmounts/);
});
