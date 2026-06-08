ALTER TABLE water_assets
  ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS water_assets_active_scope_idx
  ON water_assets(workspace_id, farm_id, season_id, active, asset_type);
