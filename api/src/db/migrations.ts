import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { PoolClient, QueryResult } from "pg";
import { pool } from "./client.js";

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
const workspaceAccountantRoleMigrationUrl = new URL("../../../database/migrations/0030_workspace_accountant_role.sql", import.meta.url);
const workspaceMembershipDedupMigrationUrl = new URL("../../../database/migrations/0031_workspace_membership_dedup.sql", import.meta.url);
const voidedLabourWageSettlementRepairMigrationUrl = new URL("../../../database/migrations/0032_voided_labour_wage_settlement_repair.sql", import.meta.url);

const STARTUP_LOCK_KEY = "muzare_ensure_workspace_schema";
const STARTUP_LOCK_TIMEOUT = "10s";
const STARTUP_STATEMENT_TIMEOUT = "120s";
const DEFERRED_LOCK_TIMEOUT = "5s";
const DEFERRED_STATEMENT_TIMEOUT = "60s";

type MigrationStep = {
  key: string;
  kind: "bootstrap" | "sql" | "validation";
  required: boolean;
  sourceUrl?: URL;
  sql?: string;
};

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

const requiredMigrationSteps: MigrationStep[] = [
  { key: "0002_workspace_bootstrap_v2", kind: "bootstrap", required: true },
  { key: "0003_platform_workspace_roles", kind: "sql", required: true, sourceUrl: roleArchitectureMigrationUrl },
  { key: "0004_operational_sync", kind: "sql", required: true, sourceUrl: operationalSyncMigrationUrl },
  { key: "0005_tenant_hardening", kind: "sql", required: true, sourceUrl: tenantHardeningMigrationUrl },
  { key: "0006_workspace_farm_management", kind: "sql", required: true, sourceUrl: farmManagementMigrationUrl },
  { key: "0007_workspace_season_management", kind: "sql", required: true, sourceUrl: seasonManagementMigrationUrl },
  { key: "0008_expense_category_system", kind: "sql", required: true, sourceUrl: expenseCategoryMigrationUrl },
  { key: "0009_attendance_csv_import", kind: "sql", required: true, sourceUrl: attendanceCsvImportMigrationUrl },
  { key: "0010_default_labour_wage", kind: "sql", required: true, sourceUrl: defaultLabourWageMigrationUrl },
  { key: "0011_expense_voucher_numbers", kind: "sql", required: true, sourceUrl: expenseVoucherNumberMigrationUrl },
  { key: "0012_expense_csv_import", kind: "sql", required: true, sourceUrl: expenseImportMigrationUrl },
  { key: "0013_attendance_offline_identity", kind: "sql", required: true, sourceUrl: attendanceOfflineIdentityMigrationUrl },
  { key: "0014_labour_advance_younis_account_backfill", kind: "sql", required: true, sourceUrl: labourAdvanceYounisAccountBackfillMigrationUrl },
  { key: "0015_partner_settlement_account_ids", kind: "sql", required: true, sourceUrl: partnerSettlementAccountIdsMigrationUrl },
  { key: "0016_workspace_team_permissions", kind: "sql", required: true, sourceUrl: workspaceTeamPermissionsMigrationUrl },
  { key: "0017_live_geo_farm_operations", kind: "sql", required: true, sourceUrl: liveGeoFarmOperationsMigrationUrl },
  { key: "0018_simple_water_assets", kind: "sql", required: true, sourceUrl: simpleWaterAssetsMigrationUrl },
  { key: "0019_farm_operations_soft_delete", kind: "sql", required: true, sourceUrl: farmOperationsSoftDeleteMigrationUrl },
  { key: "0020_expense_attachments", kind: "sql", required: true, sourceUrl: expenseAttachmentsMigrationUrl },
  { key: "0021_farm_import_metadata", kind: "sql", required: true, sourceUrl: farmImportMetadataMigrationUrl },
  { key: "0022_expense_receipt_processing", kind: "sql", required: true, sourceUrl: expenseReceiptProcessingMigrationUrl },
  { key: "0023_farm_deletion_requests", kind: "sql", required: true, sourceUrl: farmDeletionRequestsMigrationUrl },
  { key: "0024_farm_deletion_soft_delete", kind: "sql", required: true, sourceUrl: farmDeletionSoftDeleteMigrationUrl },
  { key: "0025_import_batches_recovery", kind: "sql", required: true, sourceUrl: importBatchesRecoveryMigrationUrl },
  { key: "0026_import_failures", kind: "sql", required: true, sourceUrl: importFailuresMigrationUrl },
  { key: "0027_farms_active_schema_repair", kind: "sql", required: true, sourceUrl: farmsActiveSchemaRepairMigrationUrl },
  { key: "0028_import_tracking_schema_alignment", kind: "sql", required: true, sourceUrl: importTrackingSchemaAlignmentMigrationUrl },
  { key: "0029_workspace_member_farm_scope", kind: "sql", required: true, sourceUrl: workspaceMemberFarmScopeMigrationUrl },
  { key: "0030_workspace_accountant_role", kind: "sql", required: true, sourceUrl: workspaceAccountantRoleMigrationUrl },
  { key: "startup_schema_validation_v1", kind: "validation", required: true },
];

const deferredMigrationSteps: MigrationStep[] = [
  { key: "0031_workspace_membership_dedup", kind: "sql", required: false, sourceUrl: workspaceMembershipDedupMigrationUrl },
  { key: "0032_voided_labour_wage_settlement_repair", kind: "sql", required: false, sourceUrl: voidedLabourWageSettlementRepairMigrationUrl },
];

function logMigrationEvent(event: string, details: Record<string, unknown>) {
  console.info(event, details);
}

function hashMigration(sql: string) {
  return createHash("sha256").update(sql).digest("hex");
}

async function query<T extends Record<string, unknown> = Record<string, unknown>>(client: PoolClient, text: string, values: unknown[] = []) {
  return client.query(text, values) as Promise<QueryResult<T>>;
}

async function tableExists(client: PoolClient, tableName: string): Promise<boolean> {
  const result = await query<{ exists: boolean }>(client, "SELECT to_regclass($1) IS NOT NULL AS exists", [`public.${tableName}`]);
  return Boolean(result.rows[0]?.exists);
}

async function ensureMigrationJournal(client: PoolClient): Promise<void> {
  await query(client, `
    CREATE TABLE IF NOT EXISTS app_schema_migrations (
      step_key text PRIMARY KEY,
      checksum text,
      required boolean NOT NULL DEFAULT true,
      applied_at timestamptz NOT NULL DEFAULT now(),
      duration_ms integer,
      details jsonb
    )
  `);
}

async function isStepApplied(client: PoolClient, stepKey: string): Promise<boolean> {
  const result = await query(client, "SELECT 1 FROM app_schema_migrations WHERE step_key = $1 LIMIT 1", [stepKey]);
  return (result.rowCount ?? 0) > 0;
}

async function markStepApplied(client: PoolClient, step: MigrationStep, checksum: string | null, durationMs: number, details: Record<string, unknown> | null = null): Promise<void> {
  await query(
    client,
    `
      INSERT INTO app_schema_migrations (step_key, checksum, required, duration_ms, details)
      VALUES ($1, $2, $3, $4, $5::jsonb)
      ON CONFLICT (step_key) DO UPDATE
      SET checksum = EXCLUDED.checksum,
          required = EXCLUDED.required,
          duration_ms = EXCLUDED.duration_ms,
          details = EXCLUDED.details,
          applied_at = now()
    `,
    [step.key, checksum, step.required, Math.round(durationMs), details ? JSON.stringify(details) : null],
  );
}

async function ensureInitialSchema(client: PoolClient): Promise<void> {
  if (await tableExists(client, "users")) return;
  const initialMigration = await readFile(initialMigrationUrl, "utf8");
  logMigrationEvent("MIGRATION_STEP_STARTED", { step: "0001_initial", required: true });
  const startedAt = Date.now();
  await query(client, initialMigration);
  logMigrationEvent("MIGRATION_STEP_COMPLETED", { step: "0001_initial", required: true, durationMs: Date.now() - startedAt });
}

async function runBootstrapWorkspaceSchema(client: PoolClient): Promise<void> {
  const statements = [
    {
      name: "create_user_status_enum",
      sql: `
        DO $$
        BEGIN
          CREATE TYPE user_status AS ENUM ('pending', 'approved', 'rejected', 'suspended');
        EXCEPTION
          WHEN duplicate_object THEN null;
        END $$;
      `,
    },
    {
      name: "create_workspaces_table",
      sql: `
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
        )
      `,
    },
    {
      name: "add_workspace_columns",
      sql: `
        ALTER TABLE users ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES workspaces(id);
        ALTER TABLE users ADD COLUMN IF NOT EXISTS status user_status NOT NULL DEFAULT 'approved';
        ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_at timestamptz;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_by uuid;
        ALTER TABLE farms ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES workspaces(id);
        ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES workspaces(id);
      `,
    },
    {
      name: "seed_default_workspace",
      sql: `
        INSERT INTO workspaces (name, slug, contact_email, status, approved_at)
        SELECT 'Default Workspace', 'default-workspace', COALESCE(min(email), 'admin@muzare.local'), 'approved'::user_status, now()
        FROM users
        ON CONFLICT (slug) DO NOTHING
      `,
    },
    {
      name: "backfill_users_workspace",
      sql: `
        UPDATE users
        SET workspace_id = (SELECT id FROM workspaces WHERE slug = 'default-workspace'),
            status = 'approved'::user_status,
            approved_at = COALESCE(approved_at, now())
        WHERE workspace_id IS NULL
      `,
    },
    {
      name: "backfill_farms_workspace",
      sql: `
        UPDATE farms
        SET workspace_id = (SELECT id FROM workspaces WHERE slug = 'default-workspace')
        WHERE workspace_id IS NULL
      `,
    },
    {
      name: "ensure_workspaces_slug_index",
      sql: "CREATE UNIQUE INDEX IF NOT EXISTS workspaces_slug_uidx ON workspaces(slug)",
    },
  ];

  for (const statement of statements) {
    logMigrationEvent("MIGRATION_SUBSTEP_STARTED", { step: "0002_workspace_bootstrap_v2", substep: statement.name });
    const startedAt = Date.now();
    await query(client, statement.sql);
    logMigrationEvent("MIGRATION_SUBSTEP_COMPLETED", { step: "0002_workspace_bootstrap_v2", substep: statement.name, durationMs: Date.now() - startedAt });
  }
}

async function validateRequiredColumns(client: PoolClient): Promise<void> {
  const rows = await query<{ table_name: string; column_name: string }>(client, `
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
  `);

  const byTable = new Map<string, Set<string>>();
  for (const row of rows.rows) {
    if (!byTable.has(row.table_name)) byTable.set(row.table_name, new Set());
    byTable.get(row.table_name)!.add(row.column_name);
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

async function loadSqlStep(step: MigrationStep): Promise<{ sql: string; checksum: string | null }> {
  if (step.kind !== "sql" || !step.sourceUrl) return { sql: step.sql ?? "", checksum: step.sql ? hashMigration(step.sql) : null };
  const sql = await readFile(step.sourceUrl, "utf8");
  return { sql, checksum: hashMigration(sql) };
}

async function runStep(client: PoolClient, step: MigrationStep): Promise<void> {
  if (await isStepApplied(client, step.key)) {
    logMigrationEvent("MIGRATION_STEP_SKIPPED", { step: step.key, required: step.required, reason: "already_applied" });
    return;
  }

  logMigrationEvent("MIGRATION_STEP_STARTED", { step: step.key, required: step.required, kind: step.kind });
  const startedAt = Date.now();
  let checksum: string | null = null;

  try {
    if (step.kind === "bootstrap") {
      await runBootstrapWorkspaceSchema(client);
      checksum = hashMigration("0002_workspace_bootstrap_v2");
    } else if (step.kind === "validation") {
      await validateRequiredColumns(client);
      checksum = hashMigration("startup_schema_validation_v1");
    } else {
      const loaded = await loadSqlStep(step);
      checksum = loaded.checksum;
      await query(client, loaded.sql);
    }
    const durationMs = Date.now() - startedAt;
    await markStepApplied(client, step, checksum, durationMs);
    logMigrationEvent("MIGRATION_STEP_COMPLETED", { step: step.key, required: step.required, kind: step.kind, durationMs });
  } catch (error) {
    logMigrationEvent("MIGRATION_STEP_FAILED", {
      step: step.key,
      required: step.required,
      kind: step.kind,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function withSessionTimeouts(client: PoolClient, lockTimeout: string, statementTimeout: string, action: () => Promise<void>) {
  await query(client, `SET lock_timeout = '${lockTimeout}'`);
  await query(client, `SET statement_timeout = '${statementTimeout}'`);
  try {
    await action();
  } finally {
    await query(client, "RESET lock_timeout");
    await query(client, "RESET statement_timeout");
  }
}

export async function ensureWorkspaceSchema(): Promise<void> {
  const client = await pool.connect();

  try {
    await withSessionTimeouts(client, STARTUP_LOCK_TIMEOUT, STARTUP_STATEMENT_TIMEOUT, async () => {
      logMigrationEvent("MIGRATION_LOCK_WAITING", { lockKey: STARTUP_LOCK_KEY });
      await query(client, "SELECT pg_advisory_lock(hashtext($1))", [STARTUP_LOCK_KEY]);
      logMigrationEvent("MIGRATION_LOCK_ACQUIRED", { lockKey: STARTUP_LOCK_KEY });

      try {
        await ensureInitialSchema(client);
        await ensureMigrationJournal(client);

        for (const step of requiredMigrationSteps) {
          await runStep(client, step);
        }

        await withSessionTimeouts(client, DEFERRED_LOCK_TIMEOUT, DEFERRED_STATEMENT_TIMEOUT, async () => {
          for (const step of deferredMigrationSteps) {
            try {
              await runStep(client, step);
            } catch (error) {
              logMigrationEvent("MIGRATION_DEFERRED_STEP_SKIPPED", {
                step: step.key,
                reason: error instanceof Error ? error.message : String(error),
              });
            }
          }
        });
      } finally {
        await query(client, "SELECT pg_advisory_unlock(hashtext($1))", [STARTUP_LOCK_KEY]);
        logMigrationEvent("MIGRATION_LOCK_RELEASED", { lockKey: STARTUP_LOCK_KEY });
      }
    });
  } finally {
    client.release();
  }
}
