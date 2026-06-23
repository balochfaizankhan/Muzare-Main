ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS actor_user_id uuid REFERENCES users(id);
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS before_json jsonb;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS after_json jsonb;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS notes text;

UPDATE audit_logs
SET actor_user_id = user_id
WHERE actor_user_id IS NULL AND user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS farm_deletion_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  farm_id uuid NOT NULL REFERENCES farms(id),
  requested_by uuid NOT NULL REFERENCES users(id),
  reason text,
  record_counts_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  review_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS farm_deletion_requests_workspace_status_idx
  ON farm_deletion_requests (workspace_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS farm_deletion_requests_farm_status_idx
  ON farm_deletion_requests (farm_id, status, created_at DESC);
