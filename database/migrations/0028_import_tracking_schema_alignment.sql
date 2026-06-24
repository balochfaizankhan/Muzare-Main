ALTER TABLE farms
  ADD COLUMN IF NOT EXISTS source_type text,
  ADD COLUMN IF NOT EXISTS old_android_id text,
  ADD COLUMN IF NOT EXISTS import_batch_id uuid,
  ADD COLUMN IF NOT EXISTS source_file_hash text;

ALTER TABLE seasons
  ADD COLUMN IF NOT EXISTS source_type text,
  ADD COLUMN IF NOT EXISTS old_android_id text,
  ADD COLUMN IF NOT EXISTS import_batch_id uuid,
  ADD COLUMN IF NOT EXISTS source_file_hash text;

ALTER TABLE labour_groups
  ADD COLUMN IF NOT EXISTS source_type text,
  ADD COLUMN IF NOT EXISTS old_android_id text,
  ADD COLUMN IF NOT EXISTS import_batch_id uuid,
  ADD COLUMN IF NOT EXISTS source_file_hash text;

ALTER TABLE labourers
  ADD COLUMN IF NOT EXISTS source_type text,
  ADD COLUMN IF NOT EXISTS old_android_id text,
  ADD COLUMN IF NOT EXISTS import_batch_id uuid,
  ADD COLUMN IF NOT EXISTS source_file_hash text;

ALTER TABLE attendance_entries
  ADD COLUMN IF NOT EXISTS source_type text,
  ADD COLUMN IF NOT EXISTS old_android_id text,
  ADD COLUMN IF NOT EXISTS import_batch_id uuid,
  ADD COLUMN IF NOT EXISTS source_file_hash text;

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS source_type text,
  ADD COLUMN IF NOT EXISTS old_android_id text,
  ADD COLUMN IF NOT EXISTS import_batch_id uuid,
  ADD COLUMN IF NOT EXISTS source_file_hash text;

ALTER TABLE advance_records
  ADD COLUMN IF NOT EXISTS source_type text,
  ADD COLUMN IF NOT EXISTS old_android_id text,
  ADD COLUMN IF NOT EXISTS import_batch_id uuid,
  ADD COLUMN IF NOT EXISTS source_file_hash text;

ALTER TABLE vouchers
  ADD COLUMN IF NOT EXISTS source_type text,
  ADD COLUMN IF NOT EXISTS old_android_id text,
  ADD COLUMN IF NOT EXISTS import_batch_id uuid,
  ADD COLUMN IF NOT EXISTS source_file_hash text;

ALTER TABLE voucher_items
  ADD COLUMN IF NOT EXISTS source_type text,
  ADD COLUMN IF NOT EXISTS old_android_id text,
  ADD COLUMN IF NOT EXISTS import_batch_id uuid,
  ADD COLUMN IF NOT EXISTS source_file_hash text;

ALTER TABLE dispatches
  ADD COLUMN IF NOT EXISTS source_type text,
  ADD COLUMN IF NOT EXISTS old_android_id text,
  ADD COLUMN IF NOT EXISTS import_batch_id uuid,
  ADD COLUMN IF NOT EXISTS source_file_hash text;

ALTER TABLE dispatch_items
  ADD COLUMN IF NOT EXISTS source_type text,
  ADD COLUMN IF NOT EXISTS old_android_id text,
  ADD COLUMN IF NOT EXISTS import_batch_id uuid,
  ADD COLUMN IF NOT EXISTS source_file_hash text;

ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS source_type text,
  ADD COLUMN IF NOT EXISTS old_android_id text,
  ADD COLUMN IF NOT EXISTS import_batch_id uuid,
  ADD COLUMN IF NOT EXISTS source_file_hash text;

ALTER TABLE sale_items
  ADD COLUMN IF NOT EXISTS source_type text,
  ADD COLUMN IF NOT EXISTS old_android_id text,
  ADD COLUMN IF NOT EXISTS import_batch_id uuid,
  ADD COLUMN IF NOT EXISTS source_file_hash text;

ALTER TABLE account_transactions
  ADD COLUMN IF NOT EXISTS source_type text,
  ADD COLUMN IF NOT EXISTS old_android_id text,
  ADD COLUMN IF NOT EXISTS import_batch_id uuid,
  ADD COLUMN IF NOT EXISTS source_file_hash text;

ALTER TABLE operational_records
  ADD COLUMN IF NOT EXISTS source_type text,
  ADD COLUMN IF NOT EXISTS old_android_id text,
  ADD COLUMN IF NOT EXISTS import_batch_id uuid,
  ADD COLUMN IF NOT EXISTS source_file_hash text;

CREATE TABLE IF NOT EXISTS import_batches (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source text NOT NULL,
  export_version text,
  file_name text,
  file_hash text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  started_by uuid NOT NULL REFERENCES users(id),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  payload_json jsonb,
  summary_json jsonb,
  error_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS import_failures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_batch_id uuid NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  step text NOT NULL,
  source_row text,
  error_message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS import_batches_workspace_file_hash_uidx
  ON import_batches (workspace_id, file_hash);

CREATE UNIQUE INDEX IF NOT EXISTS import_failures_batch_step_row_uidx
  ON import_failures (import_batch_id, step, source_row);

CREATE INDEX IF NOT EXISTS farms_workspace_source_old_android_idx
  ON farms (workspace_id, source_type, old_android_id)
  WHERE source_type IS NOT NULL AND old_android_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS seasons_workspace_source_old_android_idx
  ON seasons (workspace_id, source_type, old_android_id)
  WHERE source_type IS NOT NULL AND old_android_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS operational_records_workspace_source_old_android_idx
  ON operational_records (workspace_id, source_type, old_android_id)
  WHERE source_type IS NOT NULL AND old_android_id IS NOT NULL;
