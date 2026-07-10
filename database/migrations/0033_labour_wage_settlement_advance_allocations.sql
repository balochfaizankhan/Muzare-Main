CREATE TABLE IF NOT EXISTS labour_wage_settlement_advance_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  farm_id uuid NOT NULL REFERENCES farms(id),
  season_id uuid NOT NULL REFERENCES seasons(id),
  settlement_record_id uuid NOT NULL REFERENCES operational_records(id) ON DELETE CASCADE,
  advance_record_id uuid NOT NULL REFERENCES operational_records(id) ON DELETE CASCADE,
  absorbed_amount numeric(14,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS labour_wage_settlement_advance_allocations_unique_uidx
  ON labour_wage_settlement_advance_allocations (settlement_record_id, advance_record_id);

CREATE UNIQUE INDEX IF NOT EXISTS labour_wage_settlement_advance_allocations_advance_uidx
  ON labour_wage_settlement_advance_allocations (advance_record_id, settlement_record_id);
