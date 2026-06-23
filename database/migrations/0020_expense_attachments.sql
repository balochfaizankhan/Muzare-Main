CREATE TABLE IF NOT EXISTS expense_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  farm_id uuid REFERENCES farms(id),
  season_id uuid REFERENCES seasons(id),
  expense_id uuid NOT NULL,
  file_name text NOT NULL,
  file_type text NOT NULL,
  file_size integer NOT NULL,
  storage_key text NOT NULL,
  file_url text,
  uploaded_by uuid NOT NULL REFERENCES users(id),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT expense_attachments_workspace_farm_fk
    FOREIGN KEY (workspace_id, farm_id)
    REFERENCES farms(workspace_id, id),
  CONSTRAINT expense_attachments_workspace_farm_season_fk
    FOREIGN KEY (workspace_id, farm_id, season_id)
    REFERENCES seasons(workspace_id, farm_id, id)
);

CREATE INDEX IF NOT EXISTS expense_attachments_expense_idx
  ON expense_attachments (workspace_id, expense_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS expense_attachments_farm_season_idx
  ON expense_attachments (workspace_id, farm_id, season_id)
  WHERE deleted_at IS NULL;
