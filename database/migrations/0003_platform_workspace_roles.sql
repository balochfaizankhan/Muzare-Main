DO $$
BEGIN
  CREATE TYPE platform_role AS ENUM ('platform_admin', 'platform_support');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$
BEGIN
  CREATE TYPE workspace_role AS ENUM ('workspace_owner', 'workspace_manager', 'supervisor', 'operator', 'viewer');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$
BEGIN
  CREATE TYPE approval_entity_type AS ENUM ('expense', 'attendance', 'sale', 'dispatch');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$
BEGIN
  CREATE TYPE approval_status AS ENUM ('pending', 'approved', 'rejected');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TABLE users ADD COLUMN IF NOT EXISTS platform_role platform_role;

CREATE TABLE IF NOT EXISTS workspace_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role workspace_role NOT NULL DEFAULT 'viewer',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, user_id)
);

INSERT INTO workspace_memberships (workspace_id, user_id, role)
SELECT users.workspace_id, users.id,
  CASE users.role::text
    WHEN 'admin' THEN 'workspace_owner'::workspace_role
    WHEN 'operator' THEN 'operator'::workspace_role
    ELSE 'viewer'::workspace_role
  END
FROM users
JOIN workspaces ON workspaces.id = users.workspace_id
WHERE users.workspace_id IS NOT NULL
  AND workspaces.slug <> 'muzare-administration'
ON CONFLICT (workspace_id, user_id) DO NOTHING;

UPDATE users
SET platform_role = 'platform_admin',
    workspace_id = NULL
WHERE users.id IN (
  SELECT users.id
  FROM users
  JOIN workspaces ON workspaces.id = users.workspace_id
  WHERE workspaces.slug = 'muzare-administration' AND users.role::text = 'admin'
);

DELETE FROM workspace_memberships
WHERE user_id IN (SELECT id FROM users WHERE platform_role IS NOT NULL);

UPDATE users
SET workspace_id = NULL
WHERE platform_role IS NOT NULL;

CREATE TABLE IF NOT EXISTS workspace_approval_configurations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type approval_entity_type NOT NULL,
  required_roles jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, entity_type)
);

CREATE TABLE IF NOT EXISTS workspace_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type approval_entity_type NOT NULL,
  entity_id uuid NOT NULL,
  submitted_by uuid NOT NULL REFERENCES users(id),
  current_step integer NOT NULL DEFAULT 0,
  status approval_status NOT NULL DEFAULT 'pending',
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workspace_memberships_user_idx ON workspace_memberships(user_id, active);
CREATE INDEX IF NOT EXISTS workspace_approvals_queue_idx ON workspace_approvals(workspace_id, status, entity_type);

DO $$
BEGIN
  CREATE TYPE subscription_status AS ENUM ('trial', 'active', 'past_due', 'suspended', 'cancelled');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS subscription_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  monthly_price numeric(14,2) NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspace_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES subscription_plans(id),
  status subscription_status NOT NULL DEFAULT 'trial',
  starts_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS billing_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subscription_id uuid REFERENCES workspace_subscriptions(id),
  amount numeric(14,2) NOT NULL,
  status text NOT NULL DEFAULT 'open',
  due_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workspace_subscriptions_expiry_idx ON workspace_subscriptions(status, expires_at);
