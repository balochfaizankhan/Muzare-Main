CREATE TABLE IF NOT EXISTS labour_due_member_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  due_id uuid NOT NULL REFERENCES labour_dues(id) ON DELETE CASCADE,
  labourer_id text NOT NULL,
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  calculated_amount numeric(14,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT labour_due_member_snapshots_due_labourer_uidx UNIQUE (due_id, labourer_id)
);

CREATE INDEX IF NOT EXISTS labour_due_member_snapshots_workspace_due_idx
  ON labour_due_member_snapshots (workspace_id, due_id);

CREATE TABLE IF NOT EXISTS labour_due_attendance_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  season_id uuid NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  due_id uuid NOT NULL REFERENCES labour_dues(id) ON DELETE CASCADE,
  attendance_record_id uuid NOT NULL REFERENCES operational_records(id) ON DELETE RESTRICT,
  attendance_client_record_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT labour_due_attendance_sources_record_uidx UNIQUE (workspace_id, attendance_record_id),
  CONSTRAINT labour_due_attendance_sources_client_uidx UNIQUE (workspace_id, attendance_client_record_id)
);

CREATE INDEX IF NOT EXISTS labour_due_attendance_sources_due_idx
  ON labour_due_attendance_sources (workspace_id, due_id);
