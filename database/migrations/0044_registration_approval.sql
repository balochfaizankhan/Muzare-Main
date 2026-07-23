-- Administrator approval for public self-registration.
--
-- Adds explicit audit columns for the account-approval lifecycle so that
-- approval/rejection/suspension of a user account is always attributable
-- and timestamped, independent of the pre-existing generic approved_at /
-- approved_by columns (which remain in place and continue to record
-- approval only). All new columns are nullable/backfill-safe and do not
-- change the meaning of any existing column.

ALTER TABLE users ADD COLUMN IF NOT EXISTS rejected_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS rejected_by uuid;
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_by uuid;
ALTER TABLE users ADD COLUMN IF NOT EXISTS internal_review_note text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS registration_source text NOT NULL DEFAULT 'self_service';
ALTER TABLE users ADD COLUMN IF NOT EXISTS registration_language text;

-- Backfill rule for pre-existing rows: every user that already exists as of
-- this migration predates the approval-gate feature and was already able to
-- sign in and use the product, so it must remain ACTIVE ("approved") rather
-- than being retroactively placed into PENDING_APPROVAL. Only *new* public
-- registrations created after this migration will start out pending.
-- Existing rejected/suspended rows are left completely untouched.
UPDATE users
SET status = 'approved',
    active = true,
    approved_at = COALESCE(approved_at, now()),
    registration_source = 'legacy_backfill'
WHERE status = 'pending';
