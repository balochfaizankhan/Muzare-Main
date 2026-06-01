WITH ranked_attendance AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY workspace_id, farm_id, season_id, payload->>'labourerId', payload->>'date'
      ORDER BY updated_at DESC, id DESC
    ) AS duplicate_rank
  FROM operational_records
  WHERE entity_type = 'attendance'
)
DELETE FROM operational_records record
USING ranked_attendance ranked
WHERE record.id = ranked.id
  AND ranked.duplicate_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS operational_records_attendance_identity_uidx
  ON operational_records (
    workspace_id,
    farm_id,
    season_id,
    (payload->>'labourerId'),
    (payload->>'date')
  )
  WHERE entity_type = 'attendance';
