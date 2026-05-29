CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  CREATE TYPE user_role AS ENUM ('admin', 'operator', 'viewer');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$
BEGIN
  CREATE TYPE user_status AS ENUM ('pending', 'approved', 'rejected', 'suspended');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$
BEGIN
  CREATE TYPE attendance_status AS ENUM ('P', 'H', 'A');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$
BEGIN
  CREATE TYPE transaction_type AS ENUM ('credit', 'debit');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$
BEGIN
  CREATE TYPE transaction_source AS ENUM ('opening', 'settlement', 'expense', 'advance', 'sale');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  contact_email text NOT NULL,
  contact_phone text,
  status user_status NOT NULL DEFAULT 'pending',
  approved_at timestamptz,
  approved_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name text,
  role user_role NOT NULL DEFAULT 'viewer',
  status user_status NOT NULL DEFAULT 'pending',
  active boolean NOT NULL DEFAULT true,
  approved_at timestamptz,
  approved_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS farms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id),
  name text NOT NULL,
  location text,
  owner text,
  remarks text,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS seasons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id),
  name text NOT NULL,
  year integer NOT NULL,
  starts_on date NOT NULL,
  ends_on date,
  active boolean NOT NULL DEFAULT true,
  closed boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (farm_id, year, name)
);

CREATE TABLE IF NOT EXISTS labour_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (farm_id, name)
);

CREATE TABLE IF NOT EXISTS labourers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id),
  group_id uuid REFERENCES labour_groups(id),
  name text NOT NULL,
  labour_type text NOT NULL DEFAULT 'DAILY_WAGE',
  wage numeric(14,2) NOT NULL DEFAULT 0,
  display_order integer NOT NULL DEFAULT 0,
  joined_on date,
  ended_on date,
  remarks text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS attendance_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id),
  season_id uuid NOT NULL REFERENCES seasons(id),
  labourer_id uuid NOT NULL REFERENCES labourers(id),
  attendance_date date NOT NULL,
  status attendance_status NOT NULL,
  recorded_by uuid REFERENCES users(id),
  sync_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (farm_id, season_id, labourer_id, attendance_date)
);

CREATE TABLE IF NOT EXISTS accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id),
  name text NOT NULL,
  account_type text NOT NULL DEFAULT 'partner',
  remarks text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (farm_id, name)
);

CREATE TABLE IF NOT EXISTS advance_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id),
  season_id uuid NOT NULL REFERENCES seasons(id),
  labourer_id uuid NOT NULL REFERENCES labourers(id),
  account_id uuid REFERENCES accounts(id),
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  advance_date date NOT NULL,
  description text,
  created_by uuid REFERENCES users(id),
  sync_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id),
  number text NOT NULL,
  driver_name text NOT NULL,
  driver_phone text,
  active boolean NOT NULL DEFAULT true,
  UNIQUE (farm_id, number)
);

CREATE TABLE IF NOT EXISTS produce_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id),
  name text NOT NULL,
  UNIQUE (farm_id, name)
);

CREATE TABLE IF NOT EXISTS dispatches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id),
  season_id uuid NOT NULL REFERENCES seasons(id),
  vehicle_id uuid NOT NULL REFERENCES vehicles(id),
  dispatched_at timestamptz NOT NULL,
  created_by uuid REFERENCES users(id),
  sync_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dispatch_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispatch_id uuid NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
  produce_type_id uuid NOT NULL REFERENCES produce_types(id),
  carton_count integer NOT NULL CHECK (carton_count > 0)
);

CREATE TABLE IF NOT EXISTS sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id),
  season_id uuid NOT NULL REFERENCES seasons(id),
  account_id uuid REFERENCES accounts(id),
  sold_on date NOT NULL,
  buyer_name text NOT NULL,
  total_amount numeric(14,2) NOT NULL CHECK (total_amount >= 0),
  created_by uuid REFERENCES users(id),
  sync_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sale_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  dispatch_item_id uuid NOT NULL REFERENCES dispatch_items(id),
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price numeric(14,2) NOT NULL CHECK (unit_price >= 0)
);

CREATE TABLE IF NOT EXISTS expense_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id),
  name text NOT NULL,
  UNIQUE (farm_id, name)
);

CREATE TABLE IF NOT EXISTS vouchers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id),
  season_id uuid NOT NULL REFERENCES seasons(id),
  account_id uuid REFERENCES accounts(id),
  voucher_number text NOT NULL,
  voucher_date date NOT NULL,
  total_amount numeric(14,2) NOT NULL CHECK (total_amount >= 0),
  recorded_by uuid REFERENCES users(id),
  sync_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (farm_id, voucher_number)
);

CREATE TABLE IF NOT EXISTS voucher_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  voucher_id uuid NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  category_id uuid REFERENCES expense_categories(id),
  description text,
  amount numeric(14,2) NOT NULL CHECK (amount >= 0)
);

CREATE TABLE IF NOT EXISTS account_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id),
  season_id uuid NOT NULL REFERENCES seasons(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  source transaction_source NOT NULL,
  reference_id uuid,
  type transaction_type NOT NULL,
  amount numeric(14,2) NOT NULL CHECK (amount >= 0),
  transaction_date date NOT NULL,
  remarks text,
  created_by uuid REFERENCES users(id),
  sync_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  local_time time NOT NULL DEFAULT '19:00',
  timezone text NOT NULL DEFAULT 'Asia/Riyadh',
  push_subscription jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id),
  user_id uuid REFERENCES users(id),
  farm_id uuid REFERENCES farms(id),
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS attendance_entries_period_idx ON attendance_entries (farm_id, season_id, attendance_date);
CREATE INDEX IF NOT EXISTS dispatches_period_idx ON dispatches (farm_id, season_id, dispatched_at);
CREATE INDEX IF NOT EXISTS account_transactions_period_idx ON account_transactions (farm_id, season_id, transaction_date);
CREATE INDEX IF NOT EXISTS audit_logs_entity_idx ON audit_logs (entity_type, entity_id, created_at);
CREATE INDEX IF NOT EXISTS user_sessions_lookup_idx ON user_sessions (token_hash, expires_at);
