ALTER TABLE farms
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS deletion_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS deletion_approved_by uuid REFERENCES users(id);

UPDATE farms f
SET
  active = false,
  deleted_at = COALESCE(f.deleted_at, fdr.reviewed_at, fdr.updated_at, now()),
  deleted_by = COALESCE(f.deleted_by, fdr.reviewed_by),
  deletion_approved_at = COALESCE(f.deletion_approved_at, fdr.reviewed_at, fdr.updated_at, now()),
  deletion_approved_by = COALESCE(f.deletion_approved_by, fdr.reviewed_by),
  updated_at = now()
FROM farm_deletion_requests fdr
WHERE fdr.farm_id = f.id
  AND fdr.workspace_id = f.workspace_id
  AND fdr.status = 'approved'
  AND f.deleted_at IS NULL;

UPDATE user_sessions us
SET
  active_farm_id = NULL,
  active_season_id = NULL
FROM farms f
WHERE us.workspace_id = f.workspace_id
  AND us.active_farm_id = f.id
  AND f.deleted_at IS NOT NULL;
