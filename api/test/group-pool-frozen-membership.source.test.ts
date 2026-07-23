import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = (relativePath: string) => readFile(new URL(`../../${relativePath}`, import.meta.url), "utf8");

test("migration 0045 proves group membership from all three frozen sources, including recipientSnapshot.groupMembers", async () => {
  const migration = await source("database/migrations/0045_group_pool_frozen_membership_and_sources.sql");
  assert.match(migration, /CREATE OR REPLACE FUNCTION labour_advance_matches_due_scope\(advance labour_payment_vouchers, due labour_dues, in_workspace_id uuid\) RETURNS boolean/);
  assert.match(migration, /FROM labour_due_member_snapshots member/);
  assert.match(migration, /jsonb_array_elements\(COALESCE\(due\.recipient_snapshot->'groupMembers', '\[\]'::jsonb\)\) member\s+WHERE member->>'id' = snapshot_labourer_id/);
  assert.match(migration, /jsonb_array_elements\(COALESCE\(due\.recipient_snapshot->'memberCalculationSnapshot', '\[\]'::jsonb\)\) member\s+WHERE member->>'labourerId' = snapshot_labourer_id/);
});

test("migration 0045 persists pooled source allocations and counts them in both guard paths", async () => {
  const migration = await source("database/migrations/0045_group_pool_frozen_membership_and_sources.sql");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS labour_advance_application_sources/);
  assert.match(migration, /advance_voucher_id uuid NOT NULL REFERENCES labour_payment_vouchers\(id\) ON DELETE RESTRICT/);
  // Pooled path: source-attributed consumption plus pre-ledger pooled rows.
  assert.match(migration, /eligible_applied \+ eligible_refunded \+ eligible_source_consumed \+ eligible_pooled_applied \+ NEW\.amount > eligible_total \+ 0\.005/);
  assert.match(migration, /NOT EXISTS \(\s*SELECT 1 FROM labour_advance_application_sources s WHERE s\.application_id = p\.id\s*\)/);
  // Per-voucher path: a voucher already consumed by a pooled application's
  // source allocation cannot be double-spent by a manual application.
  assert.match(migration, /other_applications \+ refunds \+ pooled_source_consumption \+ NEW\.amount > target_advance\.payment_amount \+ 0\.005/);
  // Concurrency locks are retained.
  assert.match(migration, /FOR UPDATE;\r?\n\r?\n\s*PERFORM p\.id FROM labour_advance_applications p/);
  assert.match(migration, /FOR UPDATE OF p;/);
});

test("migration 0045 is a new forward migration (0042 is not edited) and is registered to run", async () => {
  const migration0042 = await source("database/migrations/0042_pooled_labour_advance_applications.sql");
  assert.doesNotMatch(migration0042, /groupMembers/, "the applied historical migration must not be edited in place");
  assert.doesNotMatch(migration0042, /labour_advance_application_sources/);
  const migrations = await source("api/src/db/migrations.ts");
  assert.match(migrations, /const groupPoolFrozenMembershipAndSourcesMigrationUrl = new URL\("\.\.\/\.\.\/\.\.\/database\/migrations\/0045_group_pool_frozen_membership_and_sources\.sql", import\.meta\.url\);/);
  assert.match(migrations, /\{ key: "0045_group_pool_frozen_membership_and_sources", kind: "sql", required: true, sourceUrl: groupPoolFrozenMembershipAndSourcesMigrationUrl \},/);
});

test("the pool preview resolves frozen membership through the shared helper, not memberCalculationSnapshot alone", async () => {
  const routes = await source("api/src/routes/labour-payments.ts");
  assert.match(routes, /async function loadDueEligibleMembership\(tx: DbTransaction, due: typeof labourDues\.\$inferSelect\)/);
  assert.match(routes, /from\(labourDueMemberSnapshots\)/, "the persisted member snapshots must be part of the union");
  assert.match(routes, /const membership = await loadDueEligibleMembership\(tx, due\);/);
  assert.match(routes, /eligibleMemberIds: membership\.memberIds,/);
  assert.match(routes, /unattributedPooledConsumption:/, "the preview must subtract pre-ledger pooled consumption like the database guard");
  assert.match(routes, /membershipReviewRequired: due\.recipientScope === "LABOUR_GROUP" && !membership\.hasMembershipEvidence/);
  // The settle route's per-voucher scope check uses the same helper, so a
  // member advance the preview accepted is never rejected at posting.
  assert.match(routes, /const memberIds = new Set\(\(await loadDueEligibleMembership\(tx, position\.due\)\)\.memberIds\);/);
});

test("the shared membership resolver unions all three frozen sources and never consults live group membership", async () => {
  const lib = await source("api/src/lib/labour-payments.ts");
  assert.match(lib, /export function resolveDueEligibleMembers\(/);
  assert.match(lib, /memberSnapshotLabourerIds/);
  assert.match(lib, /snapshot\.groupMembers/);
  assert.match(lib, /snapshot\.memberCalculationSnapshot/);
  const resolver = lib.match(/export function resolveDueEligibleMembers\([\s\S]*?\n\}/)![0];
  assert.doesNotMatch(resolver, /operational_records|labourGroups|live/i, "membership must come only from frozen due-time evidence");
});

test("settlement posting persists the per-voucher source allocations of every pooled application", async () => {
  const routes = await source("api/src/routes/labour-payments.ts");
  assert.match(routes, /await tx\.insert\(labourAdvanceApplicationSources\)\.values\(sourceAllocations\.map\(\(allocation\) => \(\{\s*workspaceId,\s*applicationId: pooledApplication!\.id,\s*advanceVoucherId: allocation\.id,\s*amount: allocation\.proposedAmount\.toFixed\(2\),\s*allocationOrder: allocation\.allocationOrder,\s*\}\)\)\);/);
  // The pooled application row itself is unchanged: one canonical row, no per-voucher unrolling.
  assert.match(routes, /const \[inserted\] = await tx\.insert\(labourAdvanceApplications\)\.values\(\{\s*workspaceId,\s*advanceVoucherId: null,/);
});

test("the pool preview counts ACTIVE pooled source consumption against each voucher, matching the guard", async () => {
  const routes = await source("api/src/routes/labour-payments.ts");
  assert.match(routes, /select sum\(s\.amount\) from labour_advance_application_sources s join labour_advance_applications p on p\.id = s\.application_id where s\.advance_voucher_id = \$\{labourPaymentVouchers\.id\} and p\.status = 'ACTIVE'/);
});

test("the read model attributes pooled applications to original funding owners via persisted sources", async () => {
  const readModel = await source("api/src/lib/labour-financial-read-model.ts");
  assert.match(readModel, /applicationSourcesByApplicationId/);
  assert.match(readModel, /labourAdvanceApplicationSources/);
  assert.match(readModel, /sources\?: Array<\{ advanceVoucherId: string; amount: number \| string \}>/);
});

test("the web 'Use all available' action uses the server's min(pool, due) and the summary shows the three required lines", async () => {
  const ui = await source("web/src/pages/workspace/WorkforcePayments.tsx");
  assert.match(ui, /onClick=\{\(\) => setPoolApplication\(advancePool\.maximumApplicable\)\}>\{t\("workforcePaymentsPage\.reviewSettle\.useAllAvailable"\)\}/);
  assert.doesNotMatch(ui, /setPoolApplication\(advancePool\.globalOutstanding\)/, "farm-wide outstanding must never be applied");
  assert.match(ui, /reviewSettle\.availableGroupAdvances/);
  assert.match(ui, /reviewSettle\.remainingLabourDue/);
  assert.match(ui, /reviewSettle\.maximumApplicable/);
  assert.match(ui, /membershipReviewRequired/, "a group due without provable membership must be reported, not silently guessed");
  const i18n = await source("web/src/i18n.ts");
  for (const key of ["remainingLabourDue", "groupOwnedVouchers", "membershipEvidenceMissing"]) {
    const occurrences = i18n.split(`"${key}"`).length - 1;
    assert.equal(occurrences, 3, `${key} must exist in all three locales`);
  }
});
