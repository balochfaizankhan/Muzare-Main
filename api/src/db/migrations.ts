import { readFile } from "node:fs/promises";
import { db } from "./client.js";

const initialMigrationUrl = new URL("../../../database/migrations/0001_initial.sql", import.meta.url);
const roleArchitectureMigrationUrl = new URL("../../../database/migrations/0003_platform_workspace_roles.sql", import.meta.url);
const operationalSyncMigrationUrl = new URL("../../../database/migrations/0004_operational_sync.sql", import.meta.url);
const tenantHardeningMigrationUrl = new URL("../../../database/migrations/0005_tenant_hardening.sql", import.meta.url);
const farmManagementMigrationUrl = new URL("../../../database/migrations/0006_workspace_farm_management.sql", import.meta.url);
const seasonManagementMigrationUrl = new URL("../../../database/migrations/0007_workspace_season_management.sql", import.meta.url);
const expenseCategoryMigrationUrl = new URL("../../../database/migrations/0008_expense_category_system.sql", import.meta.url);
const attendanceCsvImportMigrationUrl = new URL("../../../database/migrations/0009_attendance_csv_import.sql", import.meta.url);
const defaultLabourWageMigrationUrl = new URL("../../../database/migrations/0010_default_labour_wage.sql", import.meta.url);
const expenseVoucherNumberMigrationUrl = new URL("../../../database/migrations/0011_expense_voucher_numbers.sql", import.meta.url);
const expenseImportMigrationUrl = new URL("../../../database/migrations/0012_expense_csv_import.sql", import.meta.url);
const attendanceOfflineIdentityMigrationUrl = new URL("../../../database/migrations/0013_attendance_offline_identity.sql", import.meta.url);
const labourAdvanceYounisAccountBackfillMigrationUrl = new URL("../../../database/migrations/0014_labour_advance_younis_account_backfill.sql", import.meta.url);
const partnerSettlementAccountIdsMigrationUrl = new URL("../../../database/migrations/0015_partner_settlement_account_ids.sql", import.meta.url);
const workspaceTeamPermissionsMigrationUrl = new URL("../../../database/migrations/0016_workspace_team_permissions.sql", import.meta.url);
const liveGeoFarmOperationsMigrationUrl = new URL("../../../database/migrations/0017_live_geo_farm_operations.sql", import.meta.url);
const simpleWaterAssetsMigrationUrl = new URL("../../../database/migrations/0018_simple_water_assets.sql", import.meta.url);
const farmOperationsSoftDeleteMigrationUrl = new URL("../../../database/migrations/0019_farm_operations_soft_delete.sql", import.meta.url);
const expenseAttachmentsMigrationUrl = new URL("../../../database/migrations/0020_expense_attachments.sql", import.meta.url);
const farmImportMetadataMigrationUrl = new URL("../../../database/migrations/0021_farm_import_metadata.sql", import.meta.url);
const expenseReceiptProcessingMigrationUrl = new URL("../../../database/migrations/0022_expense_receipt_processing.sql", import.meta.url);
const farmDeletionRequestsMigrationUrl = new URL("../../../database/migrations/0023_farm_deletion_requests.sql", import.meta.url);
const farmDeletionSoftDeleteMigrationUrl = new URL("../../../database/migrations/0024_farm_deletion_soft_delete.sql", import.meta.url);
const importBatchesRecoveryMigrationUrl = new URL("../../../database/migrations/0025_import_batches_recovery.sql", import.meta.url);
const importFailuresMigrationUrl = new URL("../../../database/migrations/0026_import_failures.sql", import.meta.url);
const farmsActiveSchemaRepairMigrationUrl = new URL("../../../database/migrations/0027_farms_active_schema_repair.sql", import.meta.url);
const importTrackingSchemaAlignmentMigrationUrl = new URL("../../../database/migrations/0028_import_tracking_schema_alignment.sql", import.meta.url);
const workspaceMemberFarmScopeMigrationUrl = new URL("../../../database/migrations/0029_workspace_member_farm_scope.sql", import.meta.url);

const requiredImportTrackingSchema = {
  farms: ["source_type", "old_android_id", "import_batch_id", "source_file_hash", "active", "deleted_at", "deletion_approved_at"],
  seasons: ["source_type", "old_android_id", "import_batch_id", "source_file_hash"],
  labour_groups: ["source_type", "old_android_id", "import_batch_id", "source_file_hash"],
  labourers: ["source_type", "old_android_id", "import_batch_id", "source_file_hash"],
  attendance_entries: ["source_type", "old_android_id", "import_batch_id", "source_file_hash"],
  accounts: ["source_type", "old_android_id", "import_batch_id", "source_file_hash"],
  advance_records: ["source_type", "old_android_id", "import_batch_id", "source_file_hash"],
  vouchers: ["source_type", "old_android_id", "import_batch_id", "source_file_hash"],
  voucher_items: ["source_type", "old_android_id", "import_batch_id", "source_file_hash"],
  dispatches: ["source_type", "old_android_id", "import_batch_id", "source_file_hash"],
  dispatch_items: ["source_type", "old_android_id", "import_batch_id", "source_file_hash"],
  sales: ["source_type", "old_android_id", "import_batch_id", "source_file_hash"],
  sale_items: ["source_type", "old_android_id", "import_batch_id", "source_file_hash"],
  account_transactions: ["source_type", "old_android_id", "import_batch_id", "source_file_hash"],
  operational_records: ["source_type", "old_android_id", "import_batch_id", "source_file_hash"],
  import_batches: ["file_hash", "payload_json", "summary_json", "error_json"],
  import_failures: ["import_batch_id", "step", "source_row", "error_message"],
  workspace_memberships: ["farm_access_mode"],
  workspace_team_invitations: ["farm_access_mode", "farm_ids"],
  workspace_member_farms: ["workspace_id", "membership_id", "farm_id"],
} as const;

async function tableExists(tableName: string): Promise<boolean> {
  const result = (await db.execute(
    `SELECT to_regclass('public.${tableName}') IS NOT NULL AS exists`,
  )) as { rows: Array<{ exists: boolean }> };

  return Boolean(result.rows[0]?.exists);
}

async function validateRequiredColumns(): Promise<void> {
  const rows = (await db.execute(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
  `)) as { rows: Array<{ table_name: string; column_name: string }> };

  const byTable = new Map<string, Set<string>>();
  for (const row of rows.rows) {
    const tableName = row.table_name;
    const columnName = row.column_name;
    if (!byTable.has(tableName)) byTable.set(tableName, new Set());
    byTable.get(tableName)!.add(columnName);
  }

  const issues: string[] = [];
  for (const [table, columns] of Object.entries(requiredImportTrackingSchema)) {
    const available = byTable.get(table);
    if (!available) {
      issues.push(`${table}: table is missing`);
      continue;
    }
    const missing = columns.filter((column) => !available.has(column));
    if (missing.length) issues.push(`${table}: missing ${missing.join(", ")}`);
  }

  if (issues.length) {
    console.error("MIGRATION_SCHEMA_VALIDATION_FAILED", { issues });
    throw new Error(`Database schema is missing required import-tracking columns. ${issues.join(" | ")}. Run npm run db:init against the target DATABASE_URL.`);
  }
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
  const attendanceCsvImportMigration = await readFile(attendanceCsvImportMigrationUrl, "utf8");
  await db.execute(attendanceCsvImportMigration);
  const defaultLabourWageMigration = await readFile(defaultLabourWageMigrationUrl, "utf8");
  await db.execute(defaultLabourWageMigration);
  const expenseVoucherNumberMigration = await readFile(expenseVoucherNumberMigrationUrl, "utf8");
  await db.execute(expenseVoucherNumberMigration);
  const expenseImportMigration = await readFile(expenseImportMigrationUrl, "utf8");
  await db.execute(expenseImportMigration);
  const attendanceOfflineIdentityMigration = await readFile(attendanceOfflineIdentityMigrationUrl, "utf8");
  await db.execute(attendanceOfflineIdentityMigration);
  const labourAdvanceYounisAccountBackfillMigration = await readFile(labourAdvanceYounisAccountBackfillMigrationUrl, "utf8");
  await db.execute(labourAdvanceYounisAccountBackfillMigration);
  const partnerSettlementAccountIdsMigration = await readFile(partnerSettlementAccountIdsMigrationUrl, "utf8");
  await db.execute(partnerSettlementAccountIdsMigration);
  const workspaceTeamPermissionsMigration = await readFile(workspaceTeamPermissionsMigrationUrl, "utf8");
  await db.execute(workspaceTeamPermissionsMigration);
  const liveGeoFarmOperationsMigration = await readFile(liveGeoFarmOperationsMigrationUrl, "utf8");
  await db.execute(liveGeoFarmOperationsMigration);
  const simpleWaterAssetsMigration = await readFile(simpleWaterAssetsMigrationUrl, "utf8");
  await db.execute(simpleWaterAssetsMigration);
  const farmOperationsSoftDeleteMigration = await readFile(farmOperationsSoftDeleteMigrationUrl, "utf8");
  await db.execute(farmOperationsSoftDeleteMigration);
  const expenseAttachmentsMigration = await readFile(expenseAttachmentsMigrationUrl, "utf8");
  await db.execute(expenseAttachmentsMigration);
  const farmImportMetadataMigration = await readFile(farmImportMetadataMigrationUrl, "utf8");
  await db.execute(farmImportMetadataMigration);
  const expenseReceiptProcessingMigration = await readFile(expenseReceiptProcessingMigrationUrl, "utf8");
  await db.execute(expenseReceiptProcessingMigration);
  const farmDeletionRequestsMigration = await readFile(farmDeletionRequestsMigrationUrl, "utf8");
  await db.execute(farmDeletionRequestsMigration);
  const farmDeletionSoftDeleteMigration = await readFile(farmDeletionSoftDeleteMigrationUrl, "utf8");
  await db.execute(farmDeletionSoftDeleteMigration);
  const importBatchesRecoveryMigration = await readFile(importBatchesRecoveryMigrationUrl, "utf8");
  await db.execute(importBatchesRecoveryMigration);
  const importFailuresMigration = await readFile(importFailuresMigrationUrl, "utf8");
  await db.execute(importFailuresMigration);
  const farmsActiveSchemaRepairMigration = await readFile(farmsActiveSchemaRepairMigrationUrl, "utf8");
  await db.execute(farmsActiveSchemaRepairMigration);
  const importTrackingSchemaAlignmentMigration = await readFile(importTrackingSchemaAlignmentMigrationUrl, "utf8");
  await db.execute(importTrackingSchemaAlignmentMigration);
  const workspaceMemberFarmScopeMigration = await readFile(workspaceMemberFarmScopeMigrationUrl, "utf8");
  await db.execute(workspaceMemberFarmScopeMigration);

  await validateRequiredColumns();
}
