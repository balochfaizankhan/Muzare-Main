DO $$
BEGIN
  CREATE TYPE labour_archive_type AS ENUM ('labour_period', 'attendance', 'advances_payments', 'wage_settlement', 'full_period');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE labour_archive_batch_status AS ENUM ('draft', 'validated', 'archived', 'restored');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS labour_period_archive_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  farm_id uuid NOT NULL REFERENCES farms(id),
  season_id uuid NOT NULL REFERENCES seasons(id),
  archive_type labour_archive_type NOT NULL,
  archive_reason text NOT NULL,
  attendance_from date,
  attendance_to date,
  labour_work_from date,
  labour_work_to date,
  advances_from date,
  advances_to date,
  settlement_from date,
  settlement_to date,
  status labour_archive_batch_status NOT NULL DEFAULT 'draft',
  metadata jsonb,
  validation_summary jsonb,
  created_by uuid NOT NULL REFERENCES users(id),
  validated_at timestamptz,
  validated_by uuid REFERENCES users(id),
  archived_at timestamptz,
  archived_by uuid REFERENCES users(id),
  restored_at timestamptz,
  restored_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS labour_period_archive_batches_workspace_uidx
  ON labour_period_archive_batches (workspace_id, id);

CREATE INDEX IF NOT EXISTS labour_period_archive_batches_scope_idx
  ON labour_period_archive_batches (workspace_id, farm_id, season_id, status);
