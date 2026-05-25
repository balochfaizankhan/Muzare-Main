import { readFile } from "node:fs/promises";
import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("Set DATABASE_URL to the Render Postgres external URL before running db:init.");
}

const migrationPath = new URL("../../../database/migrations/0001_initial.sql", import.meta.url);
const migration = await readFile(migrationPath, "utf8");
const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

try {
  await pool.query(migration);
  console.log("Muzare initial PostgreSQL schema created successfully.");
} finally {
  await pool.end();
}
