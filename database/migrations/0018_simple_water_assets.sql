CREATE TABLE IF NOT EXISTS water_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  farm_id uuid NOT NULL REFERENCES farms(id),
  season_id uuid REFERENCES seasons(id),
  asset_type text NOT NULL CHECK (asset_type IN ('pump', 'reservoir')),
  asset_code text NOT NULL,
  asset_name text NOT NULL,
  linked_feature_id uuid REFERENCES farm_map_features(id) ON DELETE SET NULL,
  status text,
  notes text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT water_assets_workspace_farm_fk FOREIGN KEY (workspace_id, farm_id) REFERENCES farms(workspace_id, id),
  CONSTRAINT water_assets_workspace_farm_season_fk FOREIGN KEY (workspace_id, farm_id, season_id) REFERENCES seasons(workspace_id, farm_id, id)
);

CREATE INDEX IF NOT EXISTS water_assets_scope_idx
  ON water_assets(workspace_id, farm_id, season_id, asset_type);
