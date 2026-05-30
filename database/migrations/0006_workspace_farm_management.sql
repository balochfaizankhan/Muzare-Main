ALTER TABLE farms
  ADD COLUMN IF NOT EXISTS contact_name text,
  ADD COLUMN IF NOT EXISTS contact_email text,
  ADD COLUMN IF NOT EXISTS contact_phone text;

ALTER TABLE user_sessions
  ADD COLUMN IF NOT EXISTS active_farm_id uuid REFERENCES farms(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS user_sessions_active_farm_idx
  ON user_sessions (active_farm_id);
