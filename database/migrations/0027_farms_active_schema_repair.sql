ALTER TABLE farms
  ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'farms'
      AND column_name = 'status'
  ) THEN
    EXECUTE $sql$
      UPDATE farms
      SET active = CASE
        WHEN deleted_at IS NOT NULL THEN false
        WHEN status IN ('archived', 'deleted', 'delete_pending') THEN false
        ELSE true
      END
    $sql$;
  ELSE
    EXECUTE $sql$
      UPDATE farms
      SET active = CASE
        WHEN deleted_at IS NOT NULL THEN false
        ELSE true
      END
    $sql$;
  END IF;
END $$;
