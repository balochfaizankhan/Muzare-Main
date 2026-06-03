ALTER TABLE users ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE workspace_memberships ADD COLUMN IF NOT EXISTS permissions jsonb;
ALTER TABLE workspace_approvals ADD COLUMN IF NOT EXISTS decision_note text;

CREATE TABLE IF NOT EXISTS workspace_team_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email text NOT NULL,
  phone text,
  role workspace_role NOT NULL DEFAULT 'viewer',
  permissions jsonb,
  token_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending',
  invited_by uuid NOT NULL REFERENCES users(id),
  accepted_by uuid REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workspace_team_invitations_workspace_status_idx
  ON workspace_team_invitations(workspace_id, status);
