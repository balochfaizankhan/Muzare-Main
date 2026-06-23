ALTER TABLE expense_attachments ADD COLUMN IF NOT EXISTS original_file_key text;
ALTER TABLE expense_attachments ADD COLUMN IF NOT EXISTS cropped_file_key text;
ALTER TABLE expense_attachments ADD COLUMN IF NOT EXISTS crop_metadata jsonb;
ALTER TABLE expense_attachments ADD COLUMN IF NOT EXISTS ocr_status text NOT NULL DEFAULT 'not_started';
ALTER TABLE expense_attachments ADD COLUMN IF NOT EXISTS ocr_provider text;
ALTER TABLE expense_attachments ADD COLUMN IF NOT EXISTS ocr_raw_text text;
ALTER TABLE expense_attachments ADD COLUMN IF NOT EXISTS ocr_parsed_json jsonb;
ALTER TABLE expense_attachments ADD COLUMN IF NOT EXISTS ocr_confidence text;
ALTER TABLE expense_attachments ADD COLUMN IF NOT EXISTS user_corrected_json jsonb;
ALTER TABLE expense_attachments ADD COLUMN IF NOT EXISTS processed_at timestamptz;

UPDATE expense_attachments
SET
  original_file_key = COALESCE(original_file_key, storage_key),
  cropped_file_key = COALESCE(cropped_file_key, storage_key)
WHERE original_file_key IS NULL OR cropped_file_key IS NULL;
