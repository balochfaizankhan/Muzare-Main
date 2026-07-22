import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = (relativePath: string) => readFile(new URL(`../../${relativePath}`, import.meta.url), "utf8");

test("labour_advance_applications.advance_voucher_id is nullable for canonical pooled applications", async () => {
  const schema = await source("api/src/db/schema.ts");
  assert.match(
    schema,
    /advanceVoucherId: uuid\("advance_voucher_id"\)\.references\(\(\) => labourPaymentVouchers\.id, \{ onDelete: "cascade" \}\),/,
    "advanceVoucherId must no longer be .notNull() so a pooled application (no single source voucher) can be persisted",
  );
});

test("migration 0042 drops the NOT NULL constraint and replaces the guard trigger with an aggregate-pool-aware version", async () => {
  const migration = await source("database/migrations/0042_pooled_labour_advance_applications.sql");
  assert.match(migration, /ALTER TABLE labour_advance_applications ALTER COLUMN advance_voucher_id DROP NOT NULL;/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION labour_advance_matches_due_scope\(advance labour_payment_vouchers, due labour_dues, in_workspace_id uuid\) RETURNS boolean/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION validate_labour_advance_application\(\) RETURNS trigger/);
  assert.match(migration, /IF NEW\.advance_voucher_id IS NULL THEN/, "the guard must branch on a null advance_voucher_id for the pooled path");
  assert.match(migration, /eligible_applied \+ eligible_refunded \+ eligible_pooled_applied \+ NEW\.amount > eligible_total \+ 0\.005/, "the pooled path must validate against the aggregate eligible pool, not a single voucher's balance");
  assert.match(migration, /RAISE EXCEPTION 'Advance applications exceed available advance\.';/);
  // Concurrency: every eligible voucher and every sibling pooled application for the
  // same financial scope must be locked before computing the aggregate, so two
  // concurrent settlements cannot both read a stale "available" total.
  assert.match(migration, /FOR UPDATE;\s*\n\s*PERFORM p\.id FROM labour_advance_applications p/);
  assert.match(migration, /FOR UPDATE OF p;/);
  // The legacy per-voucher branch (ELSE) must still exist unchanged for manual/historical applications.
  assert.match(migration, /SELECT \* INTO target_advance FROM labour_payment_vouchers WHERE id = NEW\.advance_voucher_id FOR UPDATE;/);
  assert.match(migration, /IF other_applications \+ refunds \+ NEW\.amount > target_advance\.payment_amount \+ 0\.005 THEN RAISE EXCEPTION 'Advance applications exceed available advance\.'; END IF;/);
  // The due-level payable guard applies to both paths unconditionally (unchanged).
  assert.match(migration, /IF due_payments \+ due_advances \+ NEW\.amount > payable \+ 0\.005 THEN RAISE EXCEPTION 'Advance application exceeds due balance\.'; END IF;/);
});

test("the migration is registered in the deferred migration steps so it actually runs", async () => {
  const migrations = await source("api/src/db/migrations.ts");
  assert.match(migrations, /const pooledLabourAdvanceApplicationsMigrationUrl = new URL\("\.\.\/\.\.\/\.\.\/database\/migrations\/0042_pooled_labour_advance_applications\.sql", import\.meta\.url\);/);
  assert.match(migrations, /\{ key: "0042_pooled_labour_advance_applications", kind: "sql", required: true, sourceUrl: pooledLabourAdvanceApplicationsMigrationUrl \},/);
});

test("the settle route persists exactly one pooled application row instead of unrolling per-voucher allocations", async () => {
  const routes = await source("api/src/routes/labour-payments.ts");
  const settleHandlerMatch = routes.match(/"\/v1\/workspace\/:workspaceId\/labour-payments\/dues\/:dueId\/settle"[\s\S]*?\n {2}\);\n/);
  assert.ok(settleHandlerMatch, "settle route handler should exist");
  const handler = settleHandlerMatch![0];

  assert.match(
    handler,
    /const \[inserted\] = await tx\.insert\(labourAdvanceApplications\)\.values\(\{\s*workspaceId,\s*advanceVoucherId: null,\s*dueId,\s*amount: input\.advancePool\.amount\.toFixed\(2\),\s*idempotencyKey: input\.advancePool\.idempotencyKey,\s*status: "ACTIVE",\s*\}\)\.returning\(\);/,
    "the pool branch must insert exactly one row with advanceVoucherId: null",
  );
  assert.doesNotMatch(
    handler,
    /for \(let offset = 0; offset < requestedApplications\.length; offset \+= 40\)/,
    "the old per-voucher batched insert loop must be removed from the pool branch",
  );
  assert.match(handler, /Only SAR \$\{aggregatePlan\.maximumApplicable\.toFixed\(2\)\} of eligible outstanding advances are currently available\./, "insufficient-pool rejections must quantify the available amount, not just a generic message");
  assert.match(handler, /knownPoolValidationMessages/, "a known aggregate-pool database rejection must surface a clear business message, not only a request reference");
});

test("aggregate advance-application-event reversal recognizes a pooled application row by its pool idempotency key", async () => {
  const routes = await source("api/src/routes/labour-payments.ts");
  assert.match(
    routes,
    /const poolIdempotencyKey = firstText\(advancePool\.idempotencyKey\);/,
  );
  assert.match(
    routes,
    /poolIdempotencyKey \? eq\(labourAdvanceApplications\.idempotencyKey, poolIdempotencyKey\) : null,/,
    "reversal must also match the single pooled application row, not only the legacy per-voucher idempotency keys",
  );
});

test("postLabourAdvanceApplicationJournals (unchanged) posts no cash-control or partner-payable movement for an applied advance", async () => {
  const labourPayments = await source("api/src/lib/labour-payments.ts");
  const fn = labourPayments.match(/export async function postLabourAdvanceApplicationJournals\([\s\S]*?onConflictDoNothing\(\);\s*\n\s*\}\s*\n\}/);
  assert.ok(fn, "postLabourAdvanceApplicationJournals should exist");
  assert.match(fn![0], /ledgerCode: "LABOUR_EXPENSE"/);
  assert.match(fn![0], /ledgerCode: "LABOUR_ADVANCE"/);
  assert.doesNotMatch(fn![0], /CASH_CONTROL/, "applying an advance must never move cash");
  assert.doesNotMatch(fn![0], /PARTNER_PAYABLE/, "applying an advance must never increase Farm Owes Partner again");
});
