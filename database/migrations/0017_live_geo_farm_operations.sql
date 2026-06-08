CREATE TABLE IF NOT EXISTS farm_maps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  farm_id uuid NOT NULL REFERENCES farms(id),
  season_id uuid REFERENCES seasons(id),
  map_name text NOT NULL,
  center_lat numeric(10, 7) NOT NULL DEFAULT 0,
  center_lng numeric(10, 7) NOT NULL DEFAULT 0,
  default_zoom numeric(5, 2) NOT NULL DEFAULT 16,
  base_map_provider text NOT NULL DEFAULT 'maplibre_satellite',
  notes text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT farm_maps_workspace_farm_fk FOREIGN KEY (workspace_id, farm_id) REFERENCES farms(workspace_id, id),
  CONSTRAINT farm_maps_workspace_farm_season_fk FOREIGN KEY (workspace_id, farm_id, season_id) REFERENCES seasons(workspace_id, farm_id, id)
);

CREATE TABLE IF NOT EXISTS farm_map_features (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  farm_id uuid NOT NULL REFERENCES farms(id),
  season_id uuid REFERENCES seasons(id),
  feature_type text NOT NULL CHECK (feature_type IN ('farm_boundary', 'plot', 'irrigation_line', 'valve', 'landmark', 'other')),
  feature_code text,
  feature_name text NOT NULL,
  geojson jsonb NOT NULL,
  linked_plot_id uuid,
  linked_irrigation_line_id uuid,
  linked_valve_id uuid,
  style_json jsonb,
  display_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT farm_map_features_workspace_farm_fk FOREIGN KEY (workspace_id, farm_id) REFERENCES farms(workspace_id, id),
  CONSTRAINT farm_map_features_workspace_farm_season_fk FOREIGN KEY (workspace_id, farm_id, season_id) REFERENCES seasons(workspace_id, farm_id, id)
);

CREATE TABLE IF NOT EXISTS plots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  farm_id uuid NOT NULL REFERENCES farms(id),
  season_id uuid REFERENCES seasons(id),
  plot_code text NOT NULL,
  plot_name text,
  variety text,
  tree_count integer,
  area numeric(14, 2),
  notes text,
  geo_feature_id uuid REFERENCES farm_map_features(id) ON DELETE SET NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plots_workspace_farm_fk FOREIGN KEY (workspace_id, farm_id) REFERENCES farms(workspace_id, id),
  CONSTRAINT plots_workspace_farm_season_fk FOREIGN KEY (workspace_id, farm_id, season_id) REFERENCES seasons(workspace_id, farm_id, id),
  CONSTRAINT plots_workspace_code_uidx UNIQUE (workspace_id, farm_id, season_id, plot_code)
);

CREATE TABLE IF NOT EXISTS irrigation_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  farm_id uuid NOT NULL REFERENCES farms(id),
  season_id uuid REFERENCES seasons(id),
  line_code text NOT NULL,
  line_name text,
  description text,
  geo_feature_id uuid REFERENCES farm_map_features(id) ON DELETE SET NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT irrigation_lines_workspace_farm_fk FOREIGN KEY (workspace_id, farm_id) REFERENCES farms(workspace_id, id),
  CONSTRAINT irrigation_lines_workspace_farm_season_fk FOREIGN KEY (workspace_id, farm_id, season_id) REFERENCES seasons(workspace_id, farm_id, id),
  CONSTRAINT irrigation_lines_workspace_code_uidx UNIQUE (workspace_id, farm_id, season_id, line_code)
);

CREATE TABLE IF NOT EXISTS valves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  farm_id uuid NOT NULL REFERENCES farms(id),
  season_id uuid REFERENCES seasons(id),
  valve_code text NOT NULL,
  valve_name text,
  irrigation_line_id uuid REFERENCES irrigation_lines(id) ON DELETE SET NULL,
  plot_id uuid REFERENCES plots(id) ON DELETE SET NULL,
  estimated_tree_count integer,
  notes text,
  geo_feature_id uuid REFERENCES farm_map_features(id) ON DELETE SET NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT valves_workspace_farm_fk FOREIGN KEY (workspace_id, farm_id) REFERENCES farms(workspace_id, id),
  CONSTRAINT valves_workspace_farm_season_fk FOREIGN KEY (workspace_id, farm_id, season_id) REFERENCES seasons(workspace_id, farm_id, id),
  CONSTRAINT valves_workspace_code_uidx UNIQUE (workspace_id, farm_id, season_id, valve_code)
);

DO $$
BEGIN
  ALTER TABLE farm_map_features ADD CONSTRAINT farm_map_features_plot_fk FOREIGN KEY (linked_plot_id) REFERENCES plots(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$
BEGIN
  ALTER TABLE farm_map_features ADD CONSTRAINT farm_map_features_irrigation_line_fk FOREIGN KEY (linked_irrigation_line_id) REFERENCES irrigation_lines(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$
BEGIN
  ALTER TABLE farm_map_features ADD CONSTRAINT farm_map_features_valve_fk FOREIGN KEY (linked_valve_id) REFERENCES valves(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS farm_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  product_type text NOT NULL CHECK (product_type IN ('fertilizer', 'pesticide', 'other')),
  category text,
  product_name text NOT NULL,
  unit text,
  notes text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS operation_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  farm_id uuid NOT NULL REFERENCES farms(id),
  season_id uuid NOT NULL REFERENCES seasons(id),
  plot_id uuid REFERENCES plots(id) ON DELETE SET NULL,
  irrigation_line_id uuid REFERENCES irrigation_lines(id) ON DELETE SET NULL,
  valve_id uuid REFERENCES valves(id) ON DELETE SET NULL,
  activity_type text NOT NULL CHECK (activity_type IN ('irrigation', 'fertilizer', 'pesticide', 'pruning', 'thinning', 'pollination', 'harvesting', 'maintenance', 'other')),
  activity_category text,
  product_id uuid REFERENCES farm_products(id) ON DELETE SET NULL,
  product_name_text text,
  operation_date date NOT NULL,
  start_time time,
  end_time time,
  duration_minutes integer,
  qty_per_tree numeric(14, 4),
  total_qty numeric(14, 4),
  unit text,
  tree_count_covered integer,
  performed_by text,
  labour_team_id uuid,
  remarks text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operation_logs_workspace_farm_fk FOREIGN KEY (workspace_id, farm_id) REFERENCES farms(workspace_id, id),
  CONSTRAINT operation_logs_workspace_farm_season_fk FOREIGN KEY (workspace_id, farm_id, season_id) REFERENCES seasons(workspace_id, farm_id, id)
);

CREATE TABLE IF NOT EXISTS operation_due_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  farm_id uuid NOT NULL REFERENCES farms(id),
  season_id uuid REFERENCES seasons(id),
  plot_id uuid REFERENCES plots(id) ON DELETE CASCADE,
  activity_type text NOT NULL,
  activity_category text,
  product_id uuid REFERENCES farm_products(id) ON DELETE SET NULL,
  interval_days integer NOT NULL,
  due_soon_days integer NOT NULL DEFAULT 2,
  active boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operation_due_rules_workspace_farm_fk FOREIGN KEY (workspace_id, farm_id) REFERENCES farms(workspace_id, id),
  CONSTRAINT operation_due_rules_workspace_farm_season_fk FOREIGN KEY (workspace_id, farm_id, season_id) REFERENCES seasons(workspace_id, farm_id, id)
);

CREATE INDEX IF NOT EXISTS farm_maps_scope_idx ON farm_maps(workspace_id, farm_id, season_id);
CREATE INDEX IF NOT EXISTS farm_map_features_scope_idx ON farm_map_features(workspace_id, farm_id, season_id, feature_type, active);
CREATE INDEX IF NOT EXISTS plots_scope_idx ON plots(workspace_id, farm_id, season_id, active);
CREATE INDEX IF NOT EXISTS irrigation_lines_scope_idx ON irrigation_lines(workspace_id, farm_id, season_id, active);
CREATE INDEX IF NOT EXISTS valves_scope_idx ON valves(workspace_id, farm_id, season_id, active);
CREATE INDEX IF NOT EXISTS operation_logs_scope_idx ON operation_logs(workspace_id, farm_id, season_id, operation_date);
CREATE INDEX IF NOT EXISTS operation_logs_plot_idx ON operation_logs(workspace_id, plot_id, activity_type, operation_date);
CREATE INDEX IF NOT EXISTS operation_logs_valve_idx ON operation_logs(workspace_id, valve_id, activity_type, operation_date);

INSERT INTO farm_products (workspace_id, product_type, category, product_name, unit, notes)
SELECT w.id, item.product_type, item.category, item.product_name, item.unit, 'Default farm operations product'
FROM workspaces w
CROSS JOIN (VALUES
  ('fertilizer', 'nitrogen', 'urea', 'kg'),
  ('fertilizer', 'phosphorus', 'dap', 'kg'),
  ('fertilizer', 'balanced', 'npk', 'kg'),
  ('fertilizer', 'potassium', 'sop', 'kg'),
  ('fertilizer', 'phosphorus', 'map', 'kg'),
  ('fertilizer', 'potassium', 'mop', 'kg'),
  ('fertilizer', 'nitrogen', 'ammonium sulfate', 'kg'),
  ('fertilizer', 'micronutrients', 'micronutrients', 'g'),
  ('fertilizer', 'organic', 'organic fertilizer', 'kg'),
  ('pesticide', 'insecticide', 'insecticide', 'ml'),
  ('pesticide', 'fungicide', 'fungicide', 'ml'),
  ('pesticide', 'miticide', 'miticide', 'ml'),
  ('pesticide', 'herbicide', 'herbicide', 'ml'),
  ('pesticide', 'nutrient spray', 'nutrient spray', 'ml'),
  ('pesticide', 'other', 'other', 'ml')
) AS item(product_type, category, product_name, unit)
WHERE NOT EXISTS (
  SELECT 1 FROM farm_products fp
  WHERE fp.workspace_id = w.id AND fp.product_type = item.product_type AND fp.product_name = item.product_name
);
