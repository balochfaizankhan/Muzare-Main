CREATE TABLE IF NOT EXISTS muzare_data_migrations (
  key text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM muzare_data_migrations WHERE key = '0010_existing_labour_wage_90'
  ) THEN
    UPDATE operational_records
    SET payload = jsonb_set(payload, '{dailyWage}', '90'::jsonb, true),
        client_updated_at = now(),
        updated_at = now()
    WHERE entity_type = 'labourer'
      AND payload->>'dailyWage' IS DISTINCT FROM '90';

    UPDATE labourers
    SET wage = 90,
        updated_at = now()
    WHERE wage IS DISTINCT FROM 90;

    INSERT INTO muzare_data_migrations (key)
    VALUES ('0010_existing_labour_wage_90');
  END IF;
END $$;
