DROP INDEX IF EXISTS operational_records_voucher_number_uidx;

CREATE INDEX IF NOT EXISTS operational_records_voucher_number_idx
  ON operational_records (
    workspace_id,
    COALESCE(season_id::text, 'farm:' || farm_id::text || ':general'),
    (payload->>'voucherNumber')
  )
  WHERE entity_type = 'voucher';

WITH numbered AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY workspace_id, COALESCE('season:' || season_id::text, 'farm:' || farm_id::text || ':general')
      ORDER BY created_at, id
    ) AS sequence_number
  FROM operational_records
  WHERE entity_type = 'voucher'
    AND COALESCE(payload->>'source', '') <> 'expense_csv_import'
)
UPDATE operational_records record
SET payload = record.payload || jsonb_build_object(
  'voucherNumber',
  'V-' || lpad(numbered.sequence_number::text, 4, '0')
)
FROM numbered
WHERE record.id = numbered.id;

INSERT INTO expense_voucher_sequences (workspace_id, scope_key, last_number)
SELECT
  workspace_id,
  COALESCE('season:' || season_id::text, 'farm:' || farm_id::text || ':general'),
  max(split_part(payload->>'voucherNumber', '-', 2)::integer)
FROM operational_records
WHERE entity_type = 'voucher'
  AND payload->>'voucherNumber' ~ '^V-[0-9]+$'
GROUP BY workspace_id, COALESCE('season:' || season_id::text, 'farm:' || farm_id::text || ':general')
ON CONFLICT (workspace_id, scope_key)
DO UPDATE SET
  last_number = GREATEST(expense_voucher_sequences.last_number, EXCLUDED.last_number),
  updated_at = now();

CREATE TABLE IF NOT EXISTS expense_import_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  farm_id uuid NOT NULL REFERENCES farms(id),
  season_id uuid NOT NULL REFERENCES seasons(id),
  uploaded_by uuid NOT NULL REFERENCES users(id),
  original_filename text NOT NULL,
  file_hash text NOT NULL,
  status text NOT NULL DEFAULT 'previewed',
  parsed_payload jsonb NOT NULL,
  validation_summary jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz
);

CREATE INDEX IF NOT EXISTS expense_import_sessions_workspace_created_idx
  ON expense_import_sessions (workspace_id, created_at DESC);
