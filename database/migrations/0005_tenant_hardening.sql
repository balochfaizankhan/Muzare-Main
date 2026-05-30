UPDATE farms
SET workspace_id = (SELECT id FROM workspaces WHERE slug = 'default-workspace')
WHERE workspace_id IS NULL;

ALTER TABLE farms
  ALTER COLUMN workspace_id SET NOT NULL;

ALTER TABLE user_sessions
  ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS farms_workspace_active_idx
  ON farms (workspace_id, active);

CREATE INDEX IF NOT EXISTS operational_records_workspace_entity_updated_idx
  ON operational_records (workspace_id, entity_type, updated_at DESC);

CREATE INDEX IF NOT EXISTS workspace_approvals_workspace_status_entity_idx
  ON workspace_approvals (workspace_id, status, entity_type, created_at);

CREATE INDEX IF NOT EXISTS audit_logs_workspace_created_idx
  ON audit_logs (workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS workspace_memberships_workspace_active_role_idx
  ON workspace_memberships (workspace_id, active, role);

CREATE UNIQUE INDEX IF NOT EXISTS farms_workspace_id_id_uidx
  ON farms (workspace_id, id);

DO $$
BEGIN
  ALTER TABLE operational_records
    ADD CONSTRAINT operational_records_workspace_farm_fk
    FOREIGN KEY (workspace_id, farm_id)
    REFERENCES farms (workspace_id, id);
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
