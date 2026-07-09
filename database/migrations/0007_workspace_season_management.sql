DO $$
BEGIN
  CREATE TYPE season_status AS ENUM ('planned', 'active', 'closed', 'archived');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TABLE seasons
  ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES workspaces(id),
  ADD COLUMN IF NOT EXISTS crop_type text,
  ADD COLUMN IF NOT EXISTS expected_ends_on date,
  ADD COLUMN IF NOT EXISTS actual_ends_on date,
  ADD COLUMN IF NOT EXISTS status season_status,
  ADD COLUMN IF NOT EXISTS notes text;

UPDATE seasons
SET workspace_id = farms.workspace_id,
    expected_ends_on = COALESCE(expected_ends_on, ends_on),
    status = COALESCE(status, CASE
      WHEN seasons.closed THEN 'closed'::season_status
      WHEN seasons.active THEN 'active'::season_status
      ELSE 'planned'::season_status
    END)
FROM farms
WHERE farms.id = seasons.farm_id
  AND (
    seasons.workspace_id IS DISTINCT FROM farms.workspace_id
    OR seasons.expected_ends_on IS NULL
    OR seasons.status IS NULL
  );

ALTER TABLE seasons
  ALTER COLUMN workspace_id SET NOT NULL,
  ALTER COLUMN status SET DEFAULT 'planned',
  ALTER COLUMN status SET NOT NULL;

ALTER TABLE user_sessions
  ADD COLUMN IF NOT EXISTS active_season_id uuid REFERENCES seasons(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS user_sessions_active_season_idx
  ON user_sessions (active_season_id);

CREATE UNIQUE INDEX IF NOT EXISTS seasons_workspace_farm_id_uidx
  ON seasons (workspace_id, farm_id, id);

WITH ranked_active AS (
  SELECT id, row_number() OVER (PARTITION BY farm_id ORDER BY starts_on DESC, created_at DESC) AS position
  FROM seasons
  WHERE status = 'active'
)
UPDATE seasons
SET status = 'planned',
    active = false
WHERE id IN (SELECT id FROM ranked_active WHERE position > 1);

CREATE UNIQUE INDEX IF NOT EXISTS seasons_one_active_per_farm_uidx
  ON seasons (farm_id)
  WHERE status = 'active';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'seasons_workspace_farm_fk'
  ) THEN
    ALTER TABLE seasons
      ADD CONSTRAINT seasons_workspace_farm_fk
      FOREIGN KEY (workspace_id, farm_id)
      REFERENCES farms (workspace_id, id)
      NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'operational_records_workspace_farm_season_fk'
  ) THEN
    ALTER TABLE operational_records
      ADD CONSTRAINT operational_records_workspace_farm_season_fk
      FOREIGN KEY (workspace_id, farm_id, season_id)
      REFERENCES seasons (workspace_id, farm_id, id)
      NOT VALID;
  END IF;
END $$;
