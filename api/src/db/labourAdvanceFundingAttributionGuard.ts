import { readFile } from "node:fs/promises";
import { pool } from "./client.js";

const STEP_KEY = "0049_pooled_advance_funding_attribution_v1";
const STARTUP_LOCK_KEY = "muzare_pooled_advance_funding_attribution_migration";
const migrationUrl = new URL("../../../database/migrations/0049_pooled_advance_funding_attribution.sql", import.meta.url);

/**
 * Apply the pooled-advance funding-attribution repair once after the base
 * workspace schema has initialized. The migration restores attribution/audit
 * lineage only; migration 0047 remains authoritative for aggregate pool
 * balances and settlement sufficiency.
 */
export async function ensureLabourAdvanceFundingAttribution(): Promise<void> {
  const client = await pool.connect();
  let transactionOpen = false;
  let lockHeld = false;

  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [STARTUP_LOCK_KEY]);
    lockHeld = true;

    const applied = await client.query(
      "SELECT 1 FROM app_schema_migrations WHERE step_key = $1 LIMIT 1",
      [STEP_KEY],
    );
    if ((applied.rowCount ?? 0) > 0) return;

    const sql = await readFile(migrationUrl, "utf8");
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query(sql);
    await client.query(
      `
        INSERT INTO app_schema_migrations (step_key, checksum, required, details)
        VALUES ($1, NULL, true, $2::jsonb)
        ON CONFLICT (step_key) DO NOTHING
      `,
      [STEP_KEY, JSON.stringify({ source: "startup-pooled-advance-funding-attribution" })],
    );
    await client.query("COMMIT");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original migration error.
      }
    }
    throw error;
  } finally {
    if (lockHeld) {
      try {
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [STARTUP_LOCK_KEY]);
      } catch {
        // The connection is released below; do not mask the startup result.
      }
    }
    client.release();
  }
}
