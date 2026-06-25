ALTER TABLE workspace_memberships
  ADD COLUMN IF NOT EXISTS farm_access_mode text NOT NULL DEFAULT 'all';

ALTER TABLE workspace_team_invitations
  ADD COLUMN IF NOT EXISTS farm_access_mode text NOT NULL DEFAULT 'all',
  ADD COLUMN IF NOT EXISTS farm_ids jsonb;

CREATE TABLE IF NOT EXISTS workspace_member_farms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  membership_id uuid NOT NULL REFERENCES workspace_memberships(id) ON DELETE CASCADE,
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_member_farms_membership_farm_uidx
  ON workspace_member_farms (membership_id, farm_id);

DELETE FROM workspace_member_farms wm
WHERE EXISTS (
  SELECT 1
  FROM workspace_memberships m
  LEFT JOIN farms f ON f.id = wm.farm_id
  WHERE m.id = wm.membership_id
    AND (
      m.workspace_id <> wm.workspace_id
      OR f.id IS NULL
      OR f.workspace_id <> wm.workspace_id
    )
);
