CREATE TABLE IF NOT EXISTS labour_wage_settlement_create_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  farm_id uuid NOT NULL REFERENCES farms(id),
  season_id uuid NOT NULL REFERENCES seasons(id),
  client_request_id uuid NOT NULL,
  operation_type text NOT NULL DEFAULT 'labour_wage_settlement_create',
  state text NOT NULL,
  stage text,
  settlement_operational_record_id uuid,
  settlement_client_record_id text,
  settlement_number text,
  error_code text,
  safe_to_retry boolean NOT NULL DEFAULT false,
  message text,
  correlation_id text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS labour_wage_settlement_create_requests_client_uidx
  ON labour_wage_settlement_create_requests (workspace_id, client_request_id, operation_type);

CREATE INDEX IF NOT EXISTS labour_wage_settlement_create_requests_state_idx
  ON labour_wage_settlement_create_requests (workspace_id, farm_id, season_id, state, updated_at DESC);
