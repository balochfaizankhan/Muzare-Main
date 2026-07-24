import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = (relativePath: string) => readFile(new URL(`../../${relativePath}`, import.meta.url), "utf8");

test("pool preview, settlement posting and the SQL guard all resolve pools from CURRENT group membership through one canonical resolver", async () => {
  const routes = await source("api/src/routes/labour-payments.ts");
  assert.match(routes, /loadAdvancePoolLedger/);
  assert.match(routes, /dueAdvancePoolPosition\(ledger, due, settlementDate\)/);
  assert.doesNotMatch(routes, /resolveAdvancePoolGroupId/, "preserved-evidence ownership is retired");
  assert.doesNotMatch(routes, /membershipReviewRequired/, "missing historical group evidence is no longer an error");
  const lib = await source("api/src/lib/labour-advance-pools.ts");
  assert.match(lib, /export function resolveAdvancePoolOwnership\(/);
  assert.match(lib, /labourerCurrentPoolKey/);
  assert.match(lib, /export function duePoolKey\(/);
  const migration = await source("database/migrations/0047_current_membership_group_advance_pools.sql");
  assert.match(migration, /CREATE OR REPLACE FUNCTION labour_current_pool_key/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION labour_advance_pool_key/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION labour_due_pool_key/);
  assert.match(migration, /RETURN due_pool IS NOT NULL AND labour_advance_pool_key\(advance\) = due_pool;/);
});

test("pool balances are signed: the guard subtracts applications and recoveries without clamping and rejects over-application", async () => {
  const migration = await source("database/migrations/0047_current_membership_group_advance_pools.sql");
  assert.match(migration, /IF NEW\.amount > eligible_total - applied_total - recovered_total \+ 0\.005 THEN/);
  assert.match(migration, /RAISE EXCEPTION 'Advance applications exceed available advance\.';/);
  assert.doesNotMatch(migration, /GREATEST\(eligible_total/, "the pool availability must never be clamped to zero");
  const lib = await source("api/src/lib/labour-advance-pools.ts");
  assert.match(lib, /SIGNED: negative pools are reported, never clamped/);
  assert.match(lib, /const availableMinor = entry\.total - entry\.applied - entry\.recovered;/);
});

test("the migration is registered and rewrites only functions — no data rewrites, no voucher changes", async () => {
  const migration = await source("database/migrations/0047_current_membership_group_advance_pools.sql");
  assert.doesNotMatch(migration, /UPDATE labour_payment_vouchers|DELETE FROM|DROP TABLE|INSERT INTO labour_/);
  const migrations = await source("api/src/db/migrations.ts");
  assert.match(migrations, /\{ key: "0047_current_membership_group_advance_pools", kind: "sql", required: true, sourceUrl: currentMembershipGroupAdvancePoolsMigrationUrl \},/);
});

test("the advance-pools endpoint returns group pools, individual pools, and only genuinely broken records for review", async () => {
  const routes = await source("api/src/routes/labour-payments.ts");
  assert.match(routes, /"\/v1\/workspace\/:workspaceId\/labour-payments\/advance-pools"/);
  assert.match(routes, /const individualPools = \[\.\.\.ledger\.pools\.values\(\)\]/);
  assert.match(routes, /The recipient labourer no longer exists\./);
  assert.doesNotMatch(routes, /No preserved labour-group evidence exists/, "absent historical snapshots are not a review reason");
  assert.match(routes, /memberCount: pool\.memberCount/);
  assert.match(routes, /voucherCount: pool\.voucherCount/);
});

test("an advance voucher records its ORIGINAL recipient: no auto-promotion into a group scope and no group-membership requirement", async () => {
  const routes = await source("api/src/routes/labour-payments.ts");
  assert.doesNotMatch(routes, /input\.recipientScope = "LABOUR_GROUP";\s*\n\s*input\.labourGroupId = memberGroupId;/);
  assert.doesNotMatch(routes, /Assign this labourer to a labour group before recording an advance\./);
  assert.match(routes, /resolved dynamically from the recipient's CURRENT group membership/);
  // Received-by on an explicit group advance must still belong to that group.
  assert.match(routes, /must belong to the selected labour group/);
});

test("settlement applies ONE pool-level amount: no per-voucher selection path and no persisted source allocations", async () => {
  const routes = await source("api/src/routes/labour-payments.ts");
  assert.match(routes, /Per-voucher advance application is no longer supported\./);
  assert.match(routes, /advanceVoucherId: null,/);
  assert.doesNotMatch(routes, /tx\.insert\(labourAdvanceApplicationSources\)/, "no per-voucher application allocation may be created");
  assert.match(routes, /advancePoolSnapshot/, "the posted settlement keeps an immutable pool snapshot");
});

test("recovery is pool-level: the recover endpoint targets a group or individual pool, never a specific advance voucher", async () => {
  const routes = await source("api/src/routes/labour-payments.ts");
  assert.match(routes, /"\/v1\/workspace\/:workspaceId\/labour-payments\/advance-pools\/recover"/);
  assert.match(routes, /relatedAdvanceVoucherId: null,/);
  assert.match(routes, /sourceType: "ADVANCE_POOL_RECOVERY"/);
  assert.match(routes, /of the combined advance balance is available to recover/);
  assert.match(routes, /Record the recovery against the group pool instead\./);
});

test("editing, deleting or voiding an advance is blocked when it would leave its current pool over-applied", async () => {
  const routes = await source("api/src/routes/labour-payments.ts");
  assert.match(routes, /async function assertAdvancePoolRemainsValid/);
  assert.match(routes, /This change would leave the pool over-applied by SAR/);
  const count = (routes.match(/await assertAdvancePoolRemainsValid\(tx, \{/g) ?? []).length;
  assert.equal(count, 3, "edit, delete and void must all run the pool dependency check");
});

test("the web advances page leads with tappable group-pool cards showing leader, member count and the combined balance", async () => {
  const ui = await source("web/src/pages/workspace/WorkforcePayments.tsx");
  assert.match(ui, /fetchLabourAdvancePools/);
  assert.match(ui, /advancesView\.groupPoolsTab/);
  assert.match(ui, /advancesView\.individualTab/);
  assert.match(ui, /advancesView\.allVouchersTab/);
  assert.match(ui, /advancesView\.poolsFollowMembershipNote/);
  assert.match(ui, /advancesView\.combinedPoolNote/, "the leader-responsibility note appears once in the pool details");
  assert.match(ui, /advancesView\.memberCount/);
  assert.match(ui, /advancesView\.voucherCount/);
  assert.match(ui, /recoverLabourAdvancePool/);
  assert.doesNotMatch(ui, /refundLabourAdvance/, "voucher-level Recover is removed from the page");
  assert.doesNotMatch(ui, /reviewSettle\.membershipEvidenceMissing/, "missing membership snapshots are no longer surfaced as an error");
  assert.match(ui, /onClick=\{\(\) => setPoolApplication\(advancePool\.maximumApplicable\)\}>\{t\("workforcePaymentsPage\.reviewSettle\.useAllAvailable"\)\}/);
});

test("voucher cards show original transactions only — no applied/outstanding voucher states anywhere in the advances view", async () => {
  const ui = await source("web/src/pages/workspace/WorkforcePayments.tsx");
  const advances = ui.slice(ui.indexOf("function AdvancesView"), ui.indexOf("function ReviewSettleDialog"));
  assert.doesNotMatch(advances, /advance\.appliedAmount|advance\.outstandingAmount/, "vouchers are original audit records, not consumable balances");
  assert.doesNotMatch(advances, /statusOptions\.partiallyApplied|statusOptions\.fullyApplied/, "no invented voucher-level application states");
  assert.match(advances, /advancesView\.currentGroupLabel/, "the voucher detail shows the CURRENT group as context");
});
