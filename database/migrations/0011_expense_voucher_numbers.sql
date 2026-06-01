CREATE TABLE IF NOT EXISTS expense_voucher_sequences (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope_key text NOT NULL,
  last_number integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, scope_key)
);

WITH readable AS (
  SELECT
    workspace_id,
    COALESCE('season:' || season_id::text, 'farm:' || farm_id::text || ':general') AS scope_key,
    COALESCE(max(
      CASE
        WHEN payload->>'voucherNumber' ~ '^EXP-[0-9]{4}-[0-9]+$'
          THEN split_part(payload->>'voucherNumber', '-', 3)::integer
        ELSE 0
      END
    ), 0) AS last_number
  FROM operational_records
  WHERE entity_type = 'voucher'
    AND COALESCE(payload->>'source', '') <> 'expense_csv_import'
  GROUP BY workspace_id, COALESCE('season:' || season_id::text, 'farm:' || farm_id::text || ':general')
),
numbered AS (
  SELECT
    record.id,
    record.workspace_id,
    COALESCE('season:' || record.season_id::text, 'farm:' || record.farm_id::text || ':general') AS scope_key,
    COALESCE(readable.last_number, 0) + row_number() OVER (
      PARTITION BY record.workspace_id, COALESCE('season:' || record.season_id::text, 'farm:' || record.farm_id::text || ':general')
      ORDER BY record.created_at, record.id
    ) AS sequence_number,
    COALESCE(NULLIF(substring(record.payload->>'date' FROM 1 FOR 4), ''), to_char(record.created_at, 'YYYY')) AS voucher_year
  FROM operational_records record
  LEFT JOIN readable ON readable.workspace_id = record.workspace_id
    AND readable.scope_key = COALESCE('season:' || record.season_id::text, 'farm:' || record.farm_id::text || ':general')
  WHERE record.entity_type = 'voucher'
    AND COALESCE(record.payload->>'source', '') <> 'expense_csv_import'
    AND COALESCE(record.payload->>'voucherNumber', '') !~ '^EXP-[0-9]{4}-[0-9]+$'
)
UPDATE operational_records record
SET payload = record.payload || jsonb_build_object(
  'voucherNumber',
  'EXP-' || numbered.voucher_year || '-' || lpad(numbered.sequence_number::text, 4, '0')
)
FROM numbered
WHERE record.id = numbered.id;

INSERT INTO expense_voucher_sequences (workspace_id, scope_key, last_number)
SELECT
  workspace_id,
  COALESCE('season:' || season_id::text, 'farm:' || farm_id::text || ':general') AS scope_key,
  max(split_part(payload->>'voucherNumber', '-', 3)::integer)
FROM operational_records
WHERE entity_type = 'voucher'
  AND COALESCE(payload->>'source', '') <> 'expense_csv_import'
  AND payload->>'voucherNumber' ~ '^EXP-[0-9]{4}-[0-9]+$'
GROUP BY workspace_id, COALESCE('season:' || season_id::text, 'farm:' || farm_id::text || ':general')
ON CONFLICT (workspace_id, scope_key)
DO UPDATE SET
  last_number = GREATEST(expense_voucher_sequences.last_number, EXCLUDED.last_number),
  updated_at = now();

CREATE UNIQUE INDEX IF NOT EXISTS operational_records_voucher_number_uidx
  ON operational_records (
    workspace_id,
    COALESCE(season_id::text, 'farm:' || farm_id::text || ':general'),
    (payload->>'voucherNumber')
  )
  WHERE entity_type = 'voucher'
    AND COALESCE(payload->>'source', '') <> 'expense_csv_import';
