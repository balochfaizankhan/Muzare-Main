ALTER TABLE farms
  ADD COLUMN IF NOT EXISTS source_file_hash text;

ALTER TABLE seasons
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

CREATE UNIQUE INDEX IF NOT EXISTS import_batches_workspace_file_hash_uidx
  ON import_batches (workspace_id, file_hash);

CREATE INDEX IF NOT EXISTS seasons_workspace_source_old_android_idx
  ON seasons (workspace_id, source_type, old_android_id)
  WHERE source_type IS NOT NULL AND old_android_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS operational_records_workspace_source_old_android_idx
  ON operational_records (workspace_id, source_type, old_android_id)
  WHERE source_type IS NOT NULL AND old_android_id IS NOT NULL;
