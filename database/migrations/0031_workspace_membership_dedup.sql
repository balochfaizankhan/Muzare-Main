CREATE TEMP TABLE tmp_ranked_workspace_memberships AS
SELECT
  wm.id,
  wm.workspace_id,
  wm.user_id,
  wm.role,
  wm.active,
  wm.permissions,
  wm.farm_access_mode,
  wm.created_at,
  wm.updated_at,
  first_value(wm.id) OVER (
    PARTITION BY wm.workspace_id, wm.user_id
    ORDER BY
      wm.active DESC,
      CASE WHEN wm.permissions IS NULL THEN 0 ELSE 1 END DESC,
      wm.updated_at DESC NULLS LAST,
      wm.created_at DESC NULLS LAST,
      wm.id DESC
  ) AS canonical_id,
  row_number() OVER (
    PARTITION BY wm.workspace_id, wm.user_id
    ORDER BY
      wm.active DESC,
      CASE WHEN wm.permissions IS NULL THEN 0 ELSE 1 END DESC,
      wm.updated_at DESC NULLS LAST,
      wm.created_at DESC NULLS LAST,
      wm.id DESC
  ) AS membership_rank
FROM workspace_memberships wm;

CREATE TEMP TABLE tmp_duplicate_workspace_memberships AS
SELECT
  id AS duplicate_id,
  canonical_id
FROM tmp_ranked_workspace_memberships
WHERE membership_rank > 1;

INSERT INTO workspace_member_farms (workspace_id, membership_id, farm_id, created_at)
SELECT DISTINCT
  source.workspace_id,
  duplicates.canonical_id,
  source.farm_id,
  now()
FROM workspace_member_farms source
INNER JOIN tmp_duplicate_workspace_memberships duplicates
  ON duplicates.duplicate_id = source.membership_id
ON CONFLICT (membership_id, farm_id) DO NOTHING;

UPDATE workspace_memberships canonical
SET
  farm_access_mode = CASE
    WHEN aggregate_memberships.has_all_access THEN 'all'
    ELSE canonical.farm_access_mode
  END,
  updated_at = now()
FROM (
  SELECT
    canonical_id,
    bool_or(farm_access_mode = 'all') AS has_all_access
  FROM tmp_ranked_workspace_memberships
  GROUP BY canonical_id
) AS aggregate_memberships
WHERE canonical.id = aggregate_memberships.canonical_id;

DELETE FROM workspace_memberships
WHERE id IN (SELECT duplicate_id FROM tmp_duplicate_workspace_memberships);

DROP TABLE IF EXISTS tmp_duplicate_workspace_memberships;
DROP TABLE IF EXISTS tmp_ranked_workspace_memberships;

DROP INDEX IF EXISTS workspace_memberships_workspace_user_uidx;
CREATE UNIQUE INDEX workspace_memberships_workspace_user_uidx
  ON workspace_memberships (workspace_id, user_id);
