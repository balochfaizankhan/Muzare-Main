-- One aggregate advance pool per labour group + retirement of
-- attendance-generated Labour Dues.
--
-- Business rule: each labour group has ONE advance pool, operationally owned
-- by the group's leader. It does not matter which member physically received
-- an advance — the money belongs to the group pool, and the original payment
-- account remains the financial funding owner. Eligibility for a group due is
-- therefore group ownership alone: never member calculation snapshots,
-- attendance, member payable shares, or the due's work period.
--
-- This forward migration (0042/0045 are applied history and are not edited):
--   1. Backfills labour_payment_vouchers.labour_group_id for historical
--      advances from the evidence preserved on the transaction itself
--      (recipient snapshot group id, or a group-scoped financial scope key).
--      Advances with no preserved group evidence are NOT assigned — never
--      from a worker's current group — and surface dynamically in the
--      advance-pools reconciliation-review list.
--   2. Replaces labour_advance_matches_due_scope with group-ownership
--      matching for LABOUR_GROUP dues (exact scope-key matching is kept for
--      individual/contractor/crew dues and for group dues with no preserved
--      group identity). validate_labour_advance_application from 0045 calls
--      this function dynamically and needs no redefinition.
--   3. Backfills per-voucher source allocations for historical ACTIVE pooled
--      applications that predate the source ledger, using the same
--      deterministic FIFO (group-owned vouchers first, then voucher date,
--      created_at, id) the application layer uses. Amounts, payment accounts,
--      dates, actors, descriptions and audit history are never modified —
--      only ownership/attribution rows are added, so farm-wide totals are
--      unchanged by construction. An application whose full amount cannot be
--      attributed keeps NO source rows and stays in the legacy aggregate
--      bucket rather than being partially misattributed.
--   4. Moves queued/in-flight attendance wage-settlement creation requests to
--      review (rolled_back) with a clear explanation, so they are never
--      posted. All creation routes reject with the same business message.
--
-- Every statement is idempotent: re-running fills only NULLs, skips
-- applications that already have source rows, and re-marks the same request
-- states.

-- 1. Stamp preserved group ownership onto historical advance funding
--    transactions (fill NULLs only; snapshot evidence first, then a
--    group-scoped financial scope key).
UPDATE labour_payment_vouchers
SET labour_group_id = COALESCE(
      NULLIF(recipient_snapshot->>'labourGroupId', ''),
      NULLIF(recipient_snapshot->>'groupId', '')
    ),
    updated_at = now()
WHERE nature = 'ADVANCE'
  AND labour_group_id IS NULL
  AND COALESCE(NULLIF(recipient_snapshot->>'labourGroupId', ''), NULLIF(recipient_snapshot->>'groupId', '')) IS NOT NULL;

UPDATE labour_payment_vouchers
SET labour_group_id = substring(financial_scope_key from 7),
    updated_at = now()
WHERE nature = 'ADVANCE'
  AND labour_group_id IS NULL
  AND financial_scope_key LIKE 'group:%'
  AND length(financial_scope_key) > 6;

-- 2. Group-ownership scope matching.
CREATE OR REPLACE FUNCTION labour_advance_matches_due_scope(advance labour_payment_vouchers, due labour_dues, in_workspace_id uuid) RETURNS boolean AS $$
DECLARE
  snapshot_labourer_id text;
  advance_group_id text;
  effective_scope text;
BEGIN
  snapshot_labourer_id := COALESCE(
    advance.labourer_id,
    advance.recipient_snapshot->>'labourerId',
    advance.recipient_snapshot->>'advanceLabourerId',
    advance.recipient_snapshot->>'recipientLabourerId'
  );
  advance_group_id := COALESCE(
    advance.labour_group_id,
    NULLIF(advance.recipient_snapshot->>'labourGroupId', ''),
    NULLIF(advance.recipient_snapshot->>'groupId', ''),
    CASE WHEN advance.financial_scope_key LIKE 'group:%' THEN NULLIF(substring(advance.financial_scope_key from 7), '') END
  );

  -- One aggregate pool per labour group: a group due draws from every active
  -- advance whose preserved evidence proves that group, no matter which
  -- member received it. Never restricted by member snapshots, attendance, or
  -- the due's work period; never widened from a worker's current group.
  IF due.recipient_scope = 'LABOUR_GROUP' AND due.labour_group_id IS NOT NULL THEN
    RETURN advance_group_id IS NOT NULL AND advance_group_id = due.labour_group_id;
  END IF;

  effective_scope := advance.financial_scope_key;
  IF effective_scope LIKE 'legacy:%' THEN
    IF advance_group_id IS NOT NULL AND advance_group_id <> '' THEN
      effective_scope := 'group:' || advance_group_id;
    ELSIF snapshot_labourer_id IS NOT NULL AND snapshot_labourer_id <> '' THEN
      effective_scope := 'individual:' || snapshot_labourer_id;
    END IF;
  END IF;

  RETURN effective_scope = due.financial_scope_key;
END;
$$ LANGUAGE plpgsql STABLE;

-- 3. Attribute historical sourceless ACTIVE pooled applications to the exact
--    funding vouchers they consumed (deterministic FIFO), preserving each
--    advance's original funding account for partner attribution and removing
--    the need for any "pooled/non-cash" placeholder in reports.
DO $$
DECLARE
  app_row RECORD;
  due_row labour_dues%ROWTYPE;
  voucher_row RECORD;
  remaining numeric;
  available numeric;
  take numeric;
  next_order integer;
BEGIN
  FOR app_row IN
    SELECT p.id, p.workspace_id, p.amount, p.due_id
    FROM labour_advance_applications p
    WHERE p.advance_voucher_id IS NULL
      AND p.status = 'ACTIVE'
      AND NOT EXISTS (SELECT 1 FROM labour_advance_application_sources s WHERE s.application_id = p.id)
    ORDER BY p.created_at, p.id
  LOOP
    SELECT * INTO due_row FROM labour_dues WHERE id = app_row.due_id;
    IF due_row.id IS NULL THEN CONTINUE; END IF;
    remaining := app_row.amount;
    next_order := 0;
    FOR voucher_row IN
      SELECT v.id, v.payment_amount,
        COALESCE((SELECT sum(a.amount) FROM labour_advance_applications a WHERE a.advance_voucher_id = v.id AND a.status = 'ACTIVE'), 0) AS applied,
        COALESCE((SELECT sum(s.amount) FROM labour_advance_application_sources s JOIN labour_advance_applications ps ON ps.id = s.application_id WHERE s.advance_voucher_id = v.id AND ps.status = 'ACTIVE'), 0) AS source_applied,
        COALESCE((SELECT sum(r.payment_amount) FROM labour_payment_vouchers r WHERE r.related_advance_voucher_id = v.id AND r.nature = 'REFUND_RECOVERY' AND r.status = 'POSTED'), 0) AS refunded
      FROM labour_payment_vouchers v
      WHERE v.workspace_id = due_row.workspace_id
        AND v.farm_id = due_row.farm_id
        AND v.season_id = due_row.season_id
        AND v.nature = 'ADVANCE'
        AND v.status = 'POSTED'
        AND labour_advance_matches_due_scope(v, due_row, due_row.workspace_id)
      ORDER BY (v.financial_scope_key NOT LIKE 'group:%'), v.voucher_date, v.created_at, v.id
    LOOP
      EXIT WHEN remaining <= 0;
      available := voucher_row.payment_amount - voucher_row.applied - voucher_row.source_applied - voucher_row.refunded;
      IF available <= 0 THEN CONTINUE; END IF;
      take := LEAST(available, remaining);
      next_order := next_order + 1;
      INSERT INTO labour_advance_application_sources (workspace_id, application_id, advance_voucher_id, amount, allocation_order)
      VALUES (due_row.workspace_id, app_row.id, voucher_row.id, take, next_order);
      remaining := remaining - take;
    END LOOP;
    -- Never partially misattribute: if the full amount cannot be proved
    -- against eligible vouchers, keep the application in the legacy
    -- aggregate bucket for reconciliation review instead.
    IF remaining > 0.005 THEN
      DELETE FROM labour_advance_application_sources WHERE application_id = app_row.id;
    END IF;
  END LOOP;
END $$;

-- 4. Queued attendance-due (wage settlement) creation requests must never be
--    posted: move any non-terminal request to review with a clear reason.
UPDATE labour_wage_settlement_create_requests
SET state = 'rolled_back',
    stage = 'attendance_dues_retired',
    safe_to_retry = false,
    error_code = 'ATTENDANCE_DUES_RETIRED',
    message = 'Attendance-based Labour Dues are no longer supported. Create a direct labour group due instead.',
    updated_at = now()
WHERE state NOT IN ('committed', 'already_created', 'rolled_back', 'failed');
