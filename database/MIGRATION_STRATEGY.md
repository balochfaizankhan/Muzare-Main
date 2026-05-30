# Platform and Workspace Role Migration

Apply migrations in numeric order. `0003_platform_workspace_roles.sql` is additive so existing farm data remains intact.

## Backfill Rules

- Existing workspace `admin` users become `workspace_owner` memberships.
- Existing `operator` and `viewer` users receive matching workspace memberships.
- The legacy user in the `muzare-administration` workspace becomes a `platform_admin` with no workspace membership.
- New platform administrators are created directly on `users.platform_role`.
- New customer signups create a `workspace_owner` membership and remain pending until platform approval.

## Rollout

1. Back up PostgreSQL.
2. Deploy the API and apply `npm run db:init`.
3. Verify platform administrators have `platform_role = 'platform_admin'` and no membership.
4. Verify every operational user has at least one active `workspace_memberships` row.
5. Retain legacy `users.workspace_id` and `users.role` columns during the transition. Remove them only after all deployed clients read memberships.

## Operational Synchronization

Apply `0004_operational_sync.sql` after the role migration.

- PostgreSQL `operational_records` is the authoritative workspace record stream.
- Browser IndexedDB is a cache and temporary retry queue only.
- API writes are attempted before a browser record is marked pending.
- Timestamp conflicts are resolved by the newest `updatedAt`; the database result is returned to the client and conflicts are written to `audit_logs`.
