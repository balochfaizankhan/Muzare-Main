CREATE TABLE IF NOT EXISTS attendance_import_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  farm_id uuid NOT NULL REFERENCES farms(id),
  season_id uuid NOT NULL REFERENCES seasons(id),
  uploaded_by uuid NOT NULL REFERENCES users(id),
  original_filename text NOT NULL,
  file_hash text NOT NULL,
  status text NOT NULL DEFAULT 'previewed'
    CHECK (status IN ('previewed', 'confirmed', 'failed', 'cancelled')),
  parsed_payload jsonb NOT NULL,
  validation_summary jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  CONSTRAINT attendance_import_sessions_workspace_farm_fk
    FOREIGN KEY (workspace_id, farm_id)
    REFERENCES farms (workspace_id, id),
  CONSTRAINT attendance_import_sessions_workspace_farm_season_fk
    FOREIGN KEY (workspace_id, farm_id, season_id)
    REFERENCES seasons (workspace_id, farm_id, id)
);

CREATE INDEX IF NOT EXISTS attendance_import_sessions_workspace_created_idx
  ON attendance_import_sessions (workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS attendance_import_sessions_uploaded_by_created_idx
  ON attendance_import_sessions (uploaded_by, created_at DESC);
