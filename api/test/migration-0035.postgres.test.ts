import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;

test("PostgreSQL 0035 conflict arbiter regression", { skip: databaseUrl ? false : "MIGRATION_TEST_DATABASE_URL is not configured" }, async () => {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query("BEGIN");
  try {
    await client.query("CREATE TEMP TABLE due_conflict_probe (source_record_id uuid)");
    await client.query("CREATE UNIQUE INDEX due_conflict_probe_partial_uidx ON due_conflict_probe(source_record_id) WHERE source_record_id IS NOT NULL");

    await assert.rejects(
      client.query("INSERT INTO due_conflict_probe(source_record_id) VALUES ($1) ON CONFLICT (source_record_id) DO NOTHING", [randomUUID()]),
      (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "42P10"),
    );

    // PostgreSQL aborts the current transaction after 42P10, so restart the
    // isolated transaction before proving the corrected explicit constraint.
    await client.query("ROLLBACK");
    await client.query("BEGIN");
    await client.query("CREATE TEMP TABLE due_conflict_fixed (source_record_id uuid, CONSTRAINT due_conflict_fixed_source_key UNIQUE(source_record_id))");
    const sourceId = randomUUID();
    await client.query("INSERT INTO due_conflict_fixed(source_record_id) VALUES ($1) ON CONFLICT ON CONSTRAINT due_conflict_fixed_source_key DO NOTHING", [sourceId]);
    await client.query("INSERT INTO due_conflict_fixed(source_record_id) VALUES ($1) ON CONFLICT ON CONSTRAINT due_conflict_fixed_source_key DO NOTHING", [sourceId]);
    await client.query("INSERT INTO due_conflict_fixed(source_record_id) VALUES (NULL), (NULL)");
    const dueCounts = await client.query("SELECT count(*)::int AS total, count(source_record_id)::int AS sourced FROM due_conflict_fixed");
    assert.deepEqual(dueCounts.rows[0], { total: 3, sourced: 1 });

    await client.query(`
      CREATE TEMP TABLE allocation_probe (
        voucher_id uuid NOT NULL,
        due_id uuid NOT NULL,
        CONSTRAINT allocation_probe_voucher_due_key UNIQUE(voucher_id, due_id)
      )
    `);
    const voucherA = randomUUID();
    const voucherB = randomUUID();
    const dueA = randomUUID();
    const dueB = randomUUID();
    await client.query("INSERT INTO allocation_probe VALUES ($1,$2),($3,$2),($1,$4)", [voucherA, dueA, voucherB, dueB]);
    assert.equal((await client.query("SELECT count(*)::int AS count FROM allocation_probe")).rows[0].count, 3);

    await client.query(`
      CREATE TEMP TABLE advance_application_probe (
        advance_voucher_id uuid NOT NULL,
        due_id uuid NOT NULL,
        idempotency_key uuid NOT NULL,
        CONSTRAINT advance_application_probe_idempotency_key UNIQUE(idempotency_key)
      )
    `);
    await client.query("INSERT INTO advance_application_probe VALUES ($1,$2,$3),($1,$2,$4)", [voucherA, dueA, randomUUID(), randomUUID()]);
    assert.equal((await client.query("SELECT count(*)::int AS count FROM advance_application_probe")).rows[0].count, 2);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
});
