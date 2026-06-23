ALTER TABLE farms ADD COLUMN IF NOT EXISTS source_type text;
ALTER TABLE farms ADD COLUMN IF NOT EXISTS old_android_id text;
ALTER TABLE farms ADD COLUMN IF NOT EXISTS import_batch_id uuid;

UPDATE farms
SET
  source_type = 'farm',
  old_android_id = substring(remarks from 'old_android_id:([^;]+)$'),
  remarks = NULL
WHERE remarks LIKE 'source_type:farm;old_android_id:%';

UPDATE farms
SET
  source_type = 'farm',
  old_android_id = substring(remarks from 'old_android_id:(.+)$'),
  remarks = NULL
WHERE remarks LIKE 'old_android_id:%';

DROP INDEX IF EXISTS farms_workspace_source_old_android_uidx;

CREATE INDEX IF NOT EXISTS farms_workspace_source_old_android_idx
  ON farms (workspace_id, source_type, old_android_id)
  WHERE source_type IS NOT NULL AND old_android_id IS NOT NULL;
