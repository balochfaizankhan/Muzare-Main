import { readFile } from "node:fs/promises";
import { pool } from "./client.js";

const STEP_KEY = "0048_dispatch_serial_guard";
const STARTUP_LOCK_KEY = "muzare_dispatch_serial_guard_migration";
const migrationUrl = new URL("../../../database/migrations/0048_dispatch_serial_guard.sql", import.meta.url);

/**
 * Apply the dispatch serial guard once after the normal workspace schema has
 * initialized. This is intentionally a startup-only schema action: normal page
 * loads and Dispatch saves never wait for it.
 *
 * The app_schema_migrations journal keeps the operation one-time and makes it
 * safe for multiple Render instances to start concurrently.
 */
export async function ensureDispatchSerialGuard(): Promise<void> {
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
      [STEP_KEY, JSON.stringify({ source: "startup-dispatch-serial-guard" })],
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
