import { readdir, readFile } from "node:fs/promises";
import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("Set DATABASE_URL to the Render Postgres external URL before running db:init.");
}

const migrationsDir = new URL("../../../database/migrations/", import.meta.url);
const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

try {
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    const migration = await readFile(new URL(file, migrationsDir), "utf8");
    await pool.query(migration);
    console.log(`Applied ${file}`);
  }
  console.log("Muzare PostgreSQL schema initialized successfully.");
} finally {
  await pool.end();
}
