import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../config.js";
import * as schema from "./schema.js";

const pool = new Pool({
  connectionString: config.DATABASE_URL,
  ssl: config.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
});

export const db = drizzle(pool, { schema });
export { pool };

export async function checkDatabaseConnection(): Promise<void> {
  await pool.query("select 1");
}

export async function closeDatabaseConnection(): Promise<void> {
  await pool.end();
}
