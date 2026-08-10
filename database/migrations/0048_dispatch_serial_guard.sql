-- 0048_dispatch_serial_guard.sql
--
-- Keep Dispatch entry local-first and fast while making the server authoritative
-- for human-facing dispatch serial allocation. The guard runs only when a
-- dispatch record is written during background sync; it adds no page-load or
-- pre-save network round trip.

CREATE INDEX IF NOT EXISTS operational_records_dispatch_serial_lookup_idx
  ON operational_records (
    workspace_id,
    farm_id,
    season_id,
    ((payload ->> 'date')),
    ((payload ->> 'serialNumber'))
  )
  WHERE entity_type = 'dispatch';

CREATE OR REPLACE FUNCTION ensure_operational_dispatch_serial()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  dispatch_date text;
  date_token text;
  serial_prefix text;
  desired_serial text;
  old_serial text;
  next_sequence integer;
  serial_collision boolean;
  old_serial_collision boolean;
BEGIN
  IF NEW.entity_type <> 'dispatch' THEN
    RETURN NEW;
  END IF;

  dispatch_date := NULLIF(BTRIM(NEW.payload ->> 'date'), '');
  IF dispatch_date IS NULL OR dispatch_date !~ '^\d{4}-\d{2}-\d{2}$' THEN
    RETURN NEW;
  END IF;

  date_token := REPLACE(dispatch_date, '-', '');
  serial_prefix := 'DIS-' || date_token || '-';

  -- Serial allocation is scoped to the same logical dispatch context and date.
  -- The transaction advisory lock prevents two devices/background sync workers
  -- from claiming the same sequence concurrently without introducing a new
  -- blocking request in the PWA save path.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      CONCAT_WS(
        ':',
        'muzare-dispatch-serial',
        NEW.workspace_id::text,
        COALESCE(NEW.farm_id::text, ''),
        COALESCE(NEW.season_id::text, ''),
        dispatch_date
      ),
      0
    )
  );

  desired_serial := NULLIF(BTRIM(NEW.payload ->> 'serialNumber'), '');
  IF desired_serial IS NULL THEN
    desired_serial := NULLIF(BTRIM(NEW.payload ->> 'dispatchNumber'), '');
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM operational_records existing
    WHERE existing.workspace_id = NEW.workspace_id
      AND existing.entity_type = 'dispatch'
      AND existing.client_record_id <> NEW.client_record_id
      AND existing.farm_id IS NOT DISTINCT FROM NEW.farm_id
      AND existing.season_id IS NOT DISTINCT FROM NEW.season_id
      AND existing.payload ->> 'date' = dispatch_date
      AND existing.payload ->> 'serialNumber' = desired_serial
  )
  INTO serial_collision;

  -- If a stale client edit sends the pre-canonical serial back to the server,
  -- retain the already-canonical serial stored on this same record whenever it
  -- is still valid and unique. This prevents harmless edits from changing a
  -- dispatch number after the server has already resolved a collision.
  IF serial_collision AND TG_OP = 'UPDATE' THEN
    old_serial := NULLIF(BTRIM(OLD.payload ->> 'serialNumber'), '');
    IF old_serial IS NOT NULL AND old_serial ~ ('^' || serial_prefix || '[0-9]+$') THEN
      SELECT EXISTS (
        SELECT 1
        FROM operational_records existing
        WHERE existing.workspace_id = NEW.workspace_id
          AND existing.entity_type = 'dispatch'
          AND existing.client_record_id <> NEW.client_record_id
          AND existing.farm_id IS NOT DISTINCT FROM NEW.farm_id
          AND existing.season_id IS NOT DISTINCT FROM NEW.season_id
          AND existing.payload ->> 'date' = dispatch_date
          AND existing.payload ->> 'serialNumber' = old_serial
      )
      INTO old_serial_collision;

      IF NOT old_serial_collision THEN
        desired_serial := old_serial;
        serial_collision := false;
      END IF;
    END IF;
  END IF;

  IF desired_serial IS NULL
     OR desired_serial !~ ('^' || serial_prefix || '[0-9]+$')
     OR serial_collision THEN
    SELECT COALESCE(
      MAX(
        CASE
          WHEN existing.payload ->> 'serialNumber' ~ ('^' || serial_prefix || '[0-9]+$')
          THEN SUBSTRING(existing.payload ->> 'serialNumber' FROM '([0-9]+)$')::integer
          ELSE NULL
        END
      ),
      0
    ) + 1
    INTO next_sequence
    FROM operational_records existing
    WHERE existing.workspace_id = NEW.workspace_id
      AND existing.entity_type = 'dispatch'
      AND existing.client_record_id <> NEW.client_record_id
      AND existing.farm_id IS NOT DISTINCT FROM NEW.farm_id
      AND existing.season_id IS NOT DISTINCT FROM NEW.season_id
      AND existing.payload ->> 'date' = dispatch_date;

    desired_serial := serial_prefix || LPAD(next_sequence::text, 3, '0');
  END IF;

  NEW.payload := jsonb_set(NEW.payload, '{serialNumber}', to_jsonb(desired_serial), true);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS operational_records_dispatch_serial_guard ON operational_records;
CREATE TRIGGER operational_records_dispatch_serial_guard
BEFORE INSERT OR UPDATE OF payload, farm_id, season_id
ON operational_records
FOR EACH ROW
EXECUTE FUNCTION ensure_operational_dispatch_serial();
