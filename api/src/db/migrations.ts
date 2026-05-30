import { readFile } from "node:fs/promises";
import { db } from "./client.js";

const initialMigrationUrl = new URL("../../../database/migrations/0001_initial.sql", import.meta.url);
const roleArchitectureMigrationUrl = new URL("../../../database/migrations/0003_platform_workspace_roles.sql", import.meta.url);
const operationalSyncMigrationUrl = new URL("../../../database/migrations/0004_operational_sync.sql", import.meta.url);
const tenantHardeningMigrationUrl = new URL("../../../database/migrations/0005_tenant_hardening.sql", import.meta.url);
const farmManagementMigrationUrl = new URL("../../../database/migrations/0006_workspace_farm_management.sql", import.meta.url);
const seasonManagementMigrationUrl = new URL("../../../database/migrations/0007_workspace_season_management.sql", import.meta.url);
const expenseCategoryMigrationUrl = new URL("../../../database/migrations/0008_expense_category_system.sql", import.meta.url);

async function tableExists(tableName: string): Promise<boolean> {
  const result = (await db.execute(
    `SELECT to_regclass('public.${tableName}') IS NOT NULL AS exists`,
  )) as { rows: Array<{ exists: boolean }> };

  return Boolean(result.rows[0]?.exists);
}

async function ensureInitialSchema(): Promise<void> {
  if (await tableExists("users")) return;

  const initialMigration = await readFile(initialMigrationUrl, "utf8");
  await db.execute(initialMigration);
}

export async function ensureWorkspaceSchema(): Promise<void> {
  await ensureInitialSchema();

  await db.execute(`
    DO $$
    BEGIN
      CREATE TYPE user_status AS ENUM ('pending', 'approved', 'rejected', 'suspended');
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;

    CREATE TABLE IF NOT EXISTS workspaces (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      slug text NOT NULL UNIQUE,
      contact_email text NOT NULL,
      contact_phone text,
      status user_status NOT NULL DEFAULT 'pending',
      approved_at timestamptz,
      approved_by uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    ALTER TABLE users ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES workspaces(id);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS status user_status NOT NULL DEFAULT 'approved';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_at timestamptz;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_by uuid;
    ALTER TABLE farms ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES workspaces(id);
    ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES workspaces(id);

    INSERT INTO workspaces (name, slug, contact_email, status, approved_at)
    SELECT 'Default Workspace', 'default-workspace', COALESCE(min(email), 'admin@muzare.local'), 'approved', now()
    FROM users
    ON CONFLICT (slug) DO NOTHING;

    UPDATE users
    SET workspace_id = (SELECT id FROM workspaces WHERE slug = 'default-workspace'),
        status = 'approved',
        approved_at = COALESCE(approved_at, now())
    WHERE workspace_id IS NULL;

    UPDATE farms
    SET workspace_id = (SELECT id FROM workspaces WHERE slug = 'default-workspace')
    WHERE workspace_id IS NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS workspaces_slug_uidx ON workspaces(slug);
  `);

  const roleArchitectureMigration = await readFile(roleArchitectureMigrationUrl, "utf8");
  await db.execute(roleArchitectureMigration);
  const operationalSyncMigration = await readFile(operationalSyncMigrationUrl, "utf8");
  await db.execute(operationalSyncMigration);
  const tenantHardeningMigration = await readFile(tenantHardeningMigrationUrl, "utf8");
  await db.execute(tenantHardeningMigration);
  const farmManagementMigration = await readFile(farmManagementMigrationUrl, "utf8");
  await db.execute(farmManagementMigration);
  const seasonManagementMigration = await readFile(seasonManagementMigrationUrl, "utf8");
  await db.execute(seasonManagementMigration);
  const expenseCategoryMigration = await readFile(expenseCategoryMigrationUrl, "utf8");
  await db.execute(expenseCategoryMigration);
}
