-- Current-membership Group Advance Pools.
--
-- Business rule (approved model): a labour group and its leader are ONE
-- financial settlement unit. Every valid advance voucher paid to the leader or
-- to any labourer CURRENTLY assigned to the group — plus group-directed
-- advance vouchers — forms one combined pool. Pool ownership follows the
-- recipient labourer's CURRENT group membership:
--   * moving a labourer moves their advance vouchers to the new group's pool,
--   * removing them from all groups returns the vouchers to their Individual
--     pool,
--   * historical group snapshots / preserved group evidence are NOT required
--     and never control pool assignment (they remain on the voucher purely as
--     audit information about the original recipient).
--
-- Applications and recoveries are pool-level only. No per-voucher allocation
-- is created any more (labour_advance_application_sources stops receiving
-- rows; historical rows are kept as immutable audit/attribution records but no
-- longer participate in any balance).
--
-- Pool balances are SIGNED: legacy data or later group movement may make a
-- pool mathematically negative. The guard preserves the signed result and
-- rejects further applications until the data is corrected — it never clamps
-- to zero and never invents per-voucher allocation to hide the problem.
--
-- These functions are the database mirror of api/src/lib/labour-advance-pools.ts
-- (resolveAdvancePoolOwnership / duePoolKey / loadAdvancePoolLedger). Change
-- them together or preview and posting will diverge.
--
-- Idempotent by construction: CREATE OR REPLACE only, no data rewrites.

-- The pool a labourer's advances currently belong to: their current group's
-- pool, or their individual pool when they are assigned to no group. NULL when
-- the labourer record no longer exists or is deleted (genuine review case).
CREATE OR REPLACE FUNCTION labour_current_pool_key(in_workspace uuid, in_farm uuid, in_labourer text) RETURNS text AS $$
DECLARE
  labourer_payload jsonb;
  group_id text;
  named_group_id text;
BEGIN
  IF in_labourer IS NULL OR in_labourer = '' THEN RETURN NULL; END IF;
  SELECT payload INTO labourer_payload
  FROM operational_records
  WHERE workspace_id = in_workspace
    AND farm_id = in_farm
    AND entity_type = 'labourer'
    AND client_record_id = in_labourer
  LIMIT 1;
  IF labourer_payload IS NULL THEN RETURN NULL; END IF;
  IF NOT (
    coalesce(labourer_payload->>'deletedAt', '') = ''
    AND coalesce(lower(labourer_payload->>'deleted'), 'false') <> 'true'
    AND coalesce(lower(labourer_payload->>'status'), '') NOT IN ('deleted', 'void', 'voided', 'cancelled')
  ) THEN
    RETURN NULL;
  END IF;

  group_id := NULLIF(labourer_payload->>'groupId', '');
  IF group_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM operational_records g
    WHERE g.workspace_id = in_workspace AND g.farm_id = in_farm
      AND g.entity_type = 'labourGroup' AND g.client_record_id = group_id
      AND coalesce(g.payload->>'deletedAt', '') = ''
      AND coalesce(lower(g.payload->>'deleted'), 'false') <> 'true'
      AND coalesce(lower(g.payload->>'status'), '') NOT IN ('deleted', 'void', 'voided', 'cancelled')
  ) THEN
    group_id := NULL;
  END IF;

  -- Legacy records may carry only a group NAME: accept it only when it maps
  -- to exactly one live group.
  IF group_id IS NULL AND NULLIF(labourer_payload->>'group', '') IS NOT NULL THEN
    SELECT min(g.client_record_id) INTO named_group_id
    FROM operational_records g
    WHERE g.workspace_id = in_workspace AND g.farm_id = in_farm
      AND g.entity_type = 'labourGroup'
      AND lower(coalesce(g.payload->>'name', '')) = lower(labourer_payload->>'group')
      AND coalesce(g.payload->>'deletedAt', '') = ''
      AND coalesce(lower(g.payload->>'deleted'), 'false') <> 'true'
      AND coalesce(lower(g.payload->>'status'), '') NOT IN ('deleted', 'void', 'voided', 'cancelled')
    HAVING count(*) = 1;
    group_id := named_group_id;
  END IF;

  -- A group leader belongs to their group's settlement unit even without an
  -- explicit member assignment of their own.
  IF group_id IS NULL THEN
    SELECT g.client_record_id INTO group_id
    FROM operational_records g
    WHERE g.workspace_id = in_workspace AND g.farm_id = in_farm
      AND g.entity_type = 'labourGroup'
      AND (g.payload->>'foremanLabourId' = in_labourer OR g.payload->>'foremanId' = in_labourer)
      AND coalesce(g.payload->>'deletedAt', '') = ''
      AND coalesce(lower(g.payload->>'deleted'), 'false') <> 'true'
      AND coalesce(lower(g.payload->>'status'), '') NOT IN ('deleted', 'void', 'voided', 'cancelled')
    ORDER BY g.client_record_id
    LIMIT 1;
  END IF;

  IF group_id IS NOT NULL THEN RETURN 'group:' || group_id; END IF;
  RETURN 'individual:' || in_labourer;
END;
$$ LANGUAGE plpgsql STABLE;

-- The pool an advance (or recovery) voucher belongs to RIGHT NOW.
-- 1. Labour-recipient voucher -> the recipient's current pool.
-- 2. Group-directed voucher -> that group's pool (if the group still exists).
-- 3. Contractor/crew/unregistered/batch voucher -> its own scope pool.
-- NULL only for genuinely broken records (recipient/group no longer exists).
CREATE OR REPLACE FUNCTION labour_advance_pool_key(advance labour_payment_vouchers) RETURNS text AS $$
DECLARE
  labourer_id text;
  group_id text;
  pool_key text;
BEGIN
  labourer_id := COALESCE(
    NULLIF(advance.labourer_id, ''),
    NULLIF(advance.recipient_snapshot->>'labourerId', ''),
    NULLIF(advance.recipient_snapshot->>'advanceLabourerId', ''),
    NULLIF(advance.recipient_snapshot->>'recipientLabourerId', '')
  );
  IF labourer_id IS NOT NULL THEN
    pool_key := labour_current_pool_key(advance.workspace_id, advance.farm_id, labourer_id);
    IF pool_key IS NOT NULL THEN RETURN pool_key; END IF;
  END IF;

  group_id := COALESCE(
    NULLIF(advance.labour_group_id, ''),
    NULLIF(advance.recipient_snapshot->>'labourGroupId', ''),
    NULLIF(advance.recipient_snapshot->>'groupId', ''),
    CASE WHEN advance.financial_scope_key LIKE 'group:%' THEN NULLIF(substring(advance.financial_scope_key from 7), '') END
  );
  IF group_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM operational_records g
    WHERE g.workspace_id = advance.workspace_id AND g.farm_id = advance.farm_id
      AND g.entity_type = 'labourGroup' AND g.client_record_id = group_id
      AND coalesce(g.payload->>'deletedAt', '') = ''
      AND coalesce(lower(g.payload->>'deleted'), 'false') <> 'true'
      AND coalesce(lower(g.payload->>'status'), '') NOT IN ('deleted', 'void', 'voided', 'cancelled')
  ) THEN
    RETURN 'group:' || group_id;
  END IF;

  IF advance.financial_scope_key IS NOT NULL
    AND advance.financial_scope_key NOT LIKE 'legacy:%'
    AND advance.financial_scope_key NOT LIKE 'individual:%'
    AND advance.financial_scope_key NOT LIKE 'group:%' THEN
    RETURN advance.financial_scope_key;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

-- The pool a labour due settles against. A group due always settles against
-- its own group's pool (posted applications stay attached to that group). An
-- individual due settles against the labourer's CURRENT pool, so a grouped
-- labourer's earnings settle through the group's combined balance.
CREATE OR REPLACE FUNCTION labour_due_pool_key(due labour_dues) RETURNS text AS $$
BEGIN
  IF due.recipient_scope = 'LABOUR_GROUP' THEN
    IF due.labour_group_id IS NULL OR due.labour_group_id = '' THEN RETURN NULL; END IF;
    RETURN 'group:' || due.labour_group_id;
  END IF;
  IF due.recipient_scope = 'INDIVIDUAL' AND NULLIF(due.labourer_id, '') IS NOT NULL THEN
    RETURN COALESCE(
      labour_current_pool_key(due.workspace_id, due.farm_id, due.labourer_id),
      'individual:' || due.labourer_id
    );
  END IF;
  RETURN NULLIF(due.financial_scope_key, '');
END;
$$ LANGUAGE plpgsql STABLE;

-- Kept with its historical signature because validate_labour_advance_application
-- and older tooling call it: an advance funds a due exactly when both resolve
-- to the same current pool.
CREATE OR REPLACE FUNCTION labour_advance_matches_due_scope(advance labour_payment_vouchers, due labour_dues, in_workspace_id uuid) RETURNS boolean AS $$
DECLARE
  due_pool text;
BEGIN
  due_pool := labour_due_pool_key(due);
  RETURN due_pool IS NOT NULL AND labour_advance_pool_key(advance) = due_pool;
END;
$$ LANGUAGE plpgsql STABLE;

-- Signed pool-level guard. For a canonical pooled application (no advance
-- voucher id) the available balance is:
--   sum of POSTED advance vouchers currently owned by the due's pool
--   - all other ACTIVE applications on dues settling against the same pool
--   - POSTED recoveries belonging to the same pool
-- computed within the due's workspace/farm/season. The subtraction is signed:
-- a pool already negative rejects every further application.
CREATE OR REPLACE FUNCTION validate_labour_advance_application() RETURNS trigger AS $$
DECLARE
  target_due labour_dues%ROWTYPE;
  target_advance labour_payment_vouchers%ROWTYPE;
  pool_key text;
  eligible_total numeric;
  applied_total numeric;
  recovered_total numeric;
  other_applications numeric;
  refunds numeric;
  due_payments numeric;
  due_advances numeric;
  payable numeric;
BEGIN
  IF NEW.status <> 'ACTIVE' THEN RETURN NEW; END IF;
  SELECT * INTO target_due FROM labour_dues WHERE id = NEW.due_id FOR UPDATE;
  IF target_due.id IS NULL OR target_due.workspace_id <> NEW.workspace_id THEN
    RAISE EXCEPTION 'Advance application context is invalid.';
  END IF;

  IF NEW.advance_voucher_id IS NULL THEN
    IF NEW.amount <= 0 THEN
      RAISE EXCEPTION 'Advance application amount must be positive.';
    END IF;
    pool_key := labour_due_pool_key(target_due);
    IF pool_key IS NULL THEN
      RAISE EXCEPTION 'Advance and due financial scopes do not match.';
    END IF;

    -- Lock the pool's funding vouchers and every other pooled application row
    -- on the same pool so two concurrent settlements cannot both read the same
    -- "available" total before either commits.
    PERFORM v.id FROM labour_payment_vouchers v
      WHERE v.workspace_id = NEW.workspace_id
        AND v.farm_id = target_due.farm_id AND v.season_id = target_due.season_id
        AND v.nature = 'ADVANCE' AND v.status = 'POSTED'
        AND labour_advance_pool_key(v) = pool_key
      FOR UPDATE;
    PERFORM p.id FROM labour_advance_applications p
      JOIN labour_dues scope_due ON scope_due.id = p.due_id
      WHERE p.workspace_id = NEW.workspace_id
        AND p.status = 'ACTIVE' AND p.id <> NEW.id
        AND scope_due.farm_id = target_due.farm_id AND scope_due.season_id = target_due.season_id
        AND labour_due_pool_key(scope_due) = pool_key
      FOR UPDATE OF p;

    SELECT COALESCE(sum(v.payment_amount), 0) INTO eligible_total
      FROM labour_payment_vouchers v
      WHERE v.workspace_id = NEW.workspace_id
        AND v.farm_id = target_due.farm_id AND v.season_id = target_due.season_id
        AND v.nature = 'ADVANCE' AND v.status = 'POSTED'
        AND labour_advance_pool_key(v) = pool_key;

    SELECT COALESCE(sum(p.amount), 0) INTO applied_total
      FROM labour_advance_applications p
      JOIN labour_dues scope_due ON scope_due.id = p.due_id
      WHERE p.workspace_id = NEW.workspace_id
        AND p.status = 'ACTIVE' AND p.id <> NEW.id
        AND scope_due.farm_id = target_due.farm_id AND scope_due.season_id = target_due.season_id
        AND labour_due_pool_key(scope_due) = pool_key;

    -- A recovery recorded against a specific historical voucher follows that
    -- voucher's current pool; a pool-level recovery resolves through its own
    -- recorded group/labourer.
    SELECT COALESCE(sum(r.payment_amount), 0) INTO recovered_total
      FROM labour_payment_vouchers r
      LEFT JOIN labour_payment_vouchers rel ON rel.id = r.related_advance_voucher_id
      WHERE r.workspace_id = NEW.workspace_id
        AND r.farm_id = target_due.farm_id AND r.season_id = target_due.season_id
        AND r.nature = 'REFUND_RECOVERY' AND r.status = 'POSTED'
        AND COALESCE(labour_advance_pool_key(rel), labour_advance_pool_key(r)) = pool_key;

    IF NEW.amount > eligible_total - applied_total - recovered_total + 0.005 THEN
      RAISE EXCEPTION 'Advance applications exceed available advance.';
    END IF;
  ELSE
    -- Legacy per-voucher application rows (historical replay only — the
    -- settlement API no longer creates these): individual-voucher guard.
    SELECT * INTO target_advance FROM labour_payment_vouchers WHERE id = NEW.advance_voucher_id FOR UPDATE;
    IF target_advance.id IS NULL OR target_advance.workspace_id <> NEW.workspace_id THEN
      RAISE EXCEPTION 'Advance application context is invalid.';
    END IF;
    IF target_advance.nature <> 'ADVANCE' OR target_advance.status <> 'POSTED'
      OR NOT labour_advance_matches_due_scope(target_advance, target_due, NEW.workspace_id) THEN
      RAISE EXCEPTION 'Advance and due financial scopes do not match.';
    END IF;
    SELECT COALESCE(sum(amount), 0) INTO other_applications FROM labour_advance_applications WHERE advance_voucher_id = NEW.advance_voucher_id AND status = 'ACTIVE' AND id <> NEW.id;
    SELECT COALESCE(sum(payment_amount), 0) INTO refunds FROM labour_payment_vouchers WHERE related_advance_voucher_id = NEW.advance_voucher_id AND nature = 'REFUND_RECOVERY' AND status = 'POSTED';
    IF other_applications + refunds + NEW.amount > target_advance.payment_amount + 0.005 THEN
      RAISE EXCEPTION 'Advance applications exceed available advance.';
    END IF;
  END IF;

  SELECT COALESCE(sum(amount), 0) INTO due_payments FROM labour_payment_allocations WHERE due_id = NEW.due_id AND status = 'ACTIVE';
  SELECT COALESCE(sum(amount), 0) INTO due_advances FROM labour_advance_applications WHERE due_id = NEW.due_id AND status = 'ACTIVE' AND id <> NEW.id;
  payable := GREATEST(target_due.gross_amount + target_due.adjustment_amount - target_due.authorized_deductions, 0);
  IF due_payments + due_advances + NEW.amount > payable + 0.005 THEN RAISE EXCEPTION 'Advance application exceeds due balance.'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
