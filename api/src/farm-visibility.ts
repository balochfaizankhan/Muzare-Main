import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { db } from "./db/client.js";
import { farms } from "./db/schema.js";

let hasFarmsActiveColumnCache: boolean | null = null;
let hasFarmsActiveColumnPromise: Promise<boolean> | null = null;

export async function hasFarmsActiveColumn(): Promise<boolean> {
  if (hasFarmsActiveColumnCache !== null) return hasFarmsActiveColumnCache;
  if (hasFarmsActiveColumnPromise) return hasFarmsActiveColumnPromise;
  hasFarmsActiveColumnPromise = (async () => {
    const result = await db.execute(sql`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'farms'
          AND column_name = 'active'
      ) AS exists
    `);
    const exists = Boolean((result.rows[0] as Record<string, unknown> | undefined)?.exists);
    hasFarmsActiveColumnCache = exists;
    hasFarmsActiveColumnPromise = null;
    return exists;
  })().catch((error) => {
    hasFarmsActiveColumnPromise = null;
    throw error;
  });
  return hasFarmsActiveColumnPromise;
}

export async function buildVisibleFarmConditions(
  workspaceId: string,
  options?: { farmId?: string; requireActive?: boolean },
): Promise<SQL<unknown>[]> {
  const hasActive = await hasFarmsActiveColumn();
  return [
    eq(farms.workspaceId, workspaceId),
    options?.farmId ? eq(farms.id, options.farmId) : undefined,
    isNull(farms.deletedAt),
    options?.requireActive !== false && hasActive ? eq(farms.active, true) : undefined,
  ].filter(Boolean) as SQL<unknown>[];
}

export async function visibleFarmSqlGuard(alias: string, options?: { requireActive?: boolean }): Promise<SQL<unknown>> {
  const hasActive = await hasFarmsActiveColumn();
  return options?.requireActive !== false && hasActive
    ? sql.raw(`${alias}.deleted_at IS NULL AND ${alias}.active = true`)
    : sql.raw(`${alias}.deleted_at IS NULL`);
}

export async function visibleFarmWhere(
  workspaceId: string,
  options?: { farmId?: string; requireActive?: boolean },
) {
  const conditions = await buildVisibleFarmConditions(workspaceId, options);
  return and(...conditions);
}
