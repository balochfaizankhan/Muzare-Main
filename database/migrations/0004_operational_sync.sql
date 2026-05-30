CREATE TABLE IF NOT EXISTS operational_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  farm_id uuid REFERENCES farms(id),
  season_id uuid REFERENCES seasons(id),
  client_record_id text NOT NULL,
  entity_type text NOT NULL,
  payload jsonb NOT NULL,
  recorded_by uuid NOT NULL REFERENCES users(id),
  client_updated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, entity_type, client_record_id)
);

CREATE INDEX IF NOT EXISTS operational_records_workspace_updated_idx
  ON operational_records(workspace_id, updated_at DESC);
