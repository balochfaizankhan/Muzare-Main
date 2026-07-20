-- Temporary Labour Payments reconciliation and administrator cleanup support.
-- Cleanup logs and tombstones are deliberately outside business reporting tables.
CREATE TABLE IF NOT EXISTS labour_cleanup_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cleanup_batch_id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  farm_id uuid REFERENCES farms(id),
  season_id uuid REFERENCES seasons(id),
  entity_type text NOT NULL,
  original_entity_id text NOT NULL,
  original_reference text NOT NULL,
  recipient_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  original_amount numeric(14,2) NOT NULL DEFAULT 0,
  original_status text NOT NULL,
  related_settlement_number text,
  related_voucher_numbers jsonb NOT NULL DEFAULT '[]'::jsonb,
  dependent_records_removed integer NOT NULL DEFAULT 0,
  account_effects_removed boolean NOT NULL DEFAULT false,
  partner_effects_removed boolean NOT NULL DEFAULT false,
  advances_restored boolean NOT NULL DEFAULT false,
  deleted_by uuid NOT NULL REFERENCES users(id),
  deleted_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL,
  confirmation_mode text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS labour_cleanup_tombstones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cleanup_batch_id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  farm_id uuid REFERENCES farms(id),
  season_id uuid REFERENCES seasons(id),
  entity_type text NOT NULL,
  client_record_id text NOT NULL,
  deleted_by uuid NOT NULL REFERENCES users(id),
  deleted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, entity_type, client_record_id)
);

CREATE INDEX IF NOT EXISTS labour_cleanup_logs_scope_idx
  ON labour_cleanup_logs(workspace_id, farm_id, season_id, deleted_at DESC);
CREATE INDEX IF NOT EXISTS labour_cleanup_tombstones_scope_idx
  ON labour_cleanup_tombstones(workspace_id, farm_id, season_id, entity_type, client_record_id);
CREATE INDEX IF NOT EXISTS operational_records_labour_history_idx
  ON operational_records(workspace_id, farm_id, season_id, entity_type, client_updated_at DESC, id DESC)
  WHERE entity_type IN ('labourEarning', 'labourWageSettlement');
CREATE INDEX IF NOT EXISTS labour_dues_source_client_idx
  ON labour_dues(workspace_id, farm_id, season_id, source_client_record_id)
  WHERE source_client_record_id IS NOT NULL;
