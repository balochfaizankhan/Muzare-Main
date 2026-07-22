-- Individual advance vouchers are historical funding records; settlement
-- must draw from the aggregate eligible outstanding advance pool for the
-- due's financial scope, not voucher-by-voucher. A pooled application row
-- has no single source advance voucher, so advance_voucher_id becomes
-- nullable, and the guard trigger gains an aggregate-pool validation path
-- alongside the existing per-voucher path (kept unchanged for historical or
-- manual per-voucher application rows).

ALTER TABLE labour_advance_applications ALTER COLUMN advance_voucher_id DROP NOT NULL;

-- Factor the existing per-voucher scope resolution (financial scope key +
-- legacy fallback + labour-group member eligibility) into a reusable
-- function so the new aggregate pool path validates against exactly the
-- same eligibility rules as the per-voucher path, instead of re-deriving
-- them and risking divergence.
CREATE OR REPLACE FUNCTION labour_advance_matches_due_scope(advance labour_payment_vouchers, due labour_dues, in_workspace_id uuid) RETURNS boolean AS $$
DECLARE
  snapshot_labourer_id text;
  snapshot_group_id text;
  effective_scope text;
  scope_is_eligible boolean;
BEGIN
  snapshot_labourer_id := COALESCE(
    advance.labourer_id,
    advance.recipient_snapshot->>'labourerId',
    advance.recipient_snapshot->>'advanceLabourerId',
    advance.recipient_snapshot->>'recipientLabourerId'
  );
  snapshot_group_id := COALESCE(
    advance.labour_group_id,
    advance.recipient_snapshot->>'labourGroupId',
    advance.recipient_snapshot->>'groupId'
  );
  effective_scope := advance.financial_scope_key;
  IF effective_scope LIKE 'legacy:%' THEN
    IF snapshot_group_id IS NOT NULL AND snapshot_group_id <> '' THEN
      effective_scope := 'group:' || snapshot_group_id;
    ELSIF snapshot_labourer_id IS NOT NULL AND snapshot_labourer_id <> '' THEN
      effective_scope := 'individual:' || snapshot_labourer_id;
    END IF;
  END IF;

  scope_is_eligible := effective_scope = due.financial_scope_key;
  IF NOT scope_is_eligible AND due.recipient_scope = 'LABOUR_GROUP' AND snapshot_labourer_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM labour_due_member_snapshots member
      WHERE member.workspace_id = in_workspace_id
        AND member.due_id = due.id
        AND member.labourer_id = snapshot_labourer_id
    ) OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(due.recipient_snapshot->'memberCalculationSnapshot', '[]'::jsonb)) member
      WHERE member->>'labourerId' = snapshot_labourer_id
    ) INTO scope_is_eligible;
  END IF;

  RETURN scope_is_eligible;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION validate_labour_advance_application() RETURNS trigger AS $$
DECLARE
  target_due labour_dues%ROWTYPE;
  target_advance labour_payment_vouchers%ROWTYPE;
  other_applications numeric;
  refunds numeric;
  due_payments numeric;
  due_advances numeric;
  payable numeric;
  scope_is_eligible boolean;
  eligible_total numeric;
  eligible_applied numeric;
  eligible_refunded numeric;
  eligible_pooled_applied numeric;
BEGIN
  IF NEW.status <> 'ACTIVE' THEN RETURN NEW; END IF;
  SELECT * INTO target_due FROM labour_dues WHERE id = NEW.due_id FOR UPDATE;
  IF target_due.id IS NULL OR target_due.workspace_id <> NEW.workspace_id THEN
    RAISE EXCEPTION 'Advance application context is invalid.';
  END IF;

  IF NEW.advance_voucher_id IS NULL THEN
    -- Canonical pooled application: validate against the aggregate eligible
    -- outstanding pool for the due's financial scope instead of any single
    -- advance voucher's remaining balance.
    IF NEW.amount <= 0 THEN
      RAISE EXCEPTION 'Advance application amount must be positive.';
    END IF;

    -- Lock every eligible advance voucher and every other pooled application
    -- row sharing this financial scope so two concurrent settlements cannot
    -- both read the same "available" total before either commits.
    PERFORM v.id FROM labour_payment_vouchers v
      WHERE v.workspace_id = NEW.workspace_id
        AND v.nature = 'ADVANCE'
        AND v.status = 'POSTED'
        AND labour_advance_matches_due_scope(v, target_due, NEW.workspace_id)
      FOR UPDATE;

    PERFORM p.id FROM labour_advance_applications p
      JOIN labour_dues scope_due ON scope_due.id = p.due_id
      WHERE p.workspace_id = NEW.workspace_id
        AND p.advance_voucher_id IS NULL
        AND p.status = 'ACTIVE'
        AND scope_due.financial_scope_key = target_due.financial_scope_key
      FOR UPDATE OF p;

    SELECT COALESCE(sum(v.payment_amount), 0) INTO eligible_total
      FROM labour_payment_vouchers v
      WHERE v.workspace_id = NEW.workspace_id
        AND v.nature = 'ADVANCE'
        AND v.status = 'POSTED'
        AND labour_advance_matches_due_scope(v, target_due, NEW.workspace_id);

    SELECT COALESCE(sum(a.amount), 0) INTO eligible_applied
      FROM labour_advance_applications a
      JOIN labour_payment_vouchers v ON v.id = a.advance_voucher_id
      WHERE a.status = 'ACTIVE' AND a.id <> NEW.id
        AND v.workspace_id = NEW.workspace_id
        AND v.nature = 'ADVANCE' AND v.status = 'POSTED'
        AND labour_advance_matches_due_scope(v, target_due, NEW.workspace_id);

    SELECT COALESCE(sum(r.payment_amount), 0) INTO eligible_refunded
      FROM labour_payment_vouchers r
      JOIN labour_payment_vouchers v ON v.id = r.related_advance_voucher_id
      WHERE r.nature = 'REFUND_RECOVERY' AND r.status = 'POSTED'
        AND v.workspace_id = NEW.workspace_id
        AND v.nature = 'ADVANCE' AND v.status = 'POSTED'
        AND labour_advance_matches_due_scope(v, target_due, NEW.workspace_id);

    SELECT COALESCE(sum(p.amount), 0) INTO eligible_pooled_applied
      FROM labour_advance_applications p
      JOIN labour_dues scope_due ON scope_due.id = p.due_id
      WHERE p.workspace_id = NEW.workspace_id
        AND p.advance_voucher_id IS NULL
        AND p.status = 'ACTIVE' AND p.id <> NEW.id
        AND scope_due.financial_scope_key = target_due.financial_scope_key;

    IF eligible_applied + eligible_refunded + eligible_pooled_applied + NEW.amount > eligible_total + 0.005 THEN
      RAISE EXCEPTION 'Advance applications exceed available advance.';
    END IF;
  ELSE
    -- Legacy/manual per-voucher application: unchanged individual-voucher guard.
    SELECT * INTO target_advance FROM labour_payment_vouchers WHERE id = NEW.advance_voucher_id FOR UPDATE;
    IF target_advance.id IS NULL OR target_advance.workspace_id <> NEW.workspace_id THEN
      RAISE EXCEPTION 'Advance application context is invalid.';
    END IF;

    scope_is_eligible := labour_advance_matches_due_scope(target_advance, target_due, NEW.workspace_id);
    IF target_advance.nature <> 'ADVANCE' OR target_advance.status <> 'POSTED' OR NOT scope_is_eligible THEN
      RAISE EXCEPTION 'Advance and due financial scopes do not match.';
    END IF;
    SELECT COALESCE(sum(amount), 0) INTO other_applications FROM labour_advance_applications WHERE advance_voucher_id = NEW.advance_voucher_id AND status = 'ACTIVE' AND id <> NEW.id;
    SELECT COALESCE(sum(payment_amount), 0) INTO refunds FROM labour_payment_vouchers WHERE related_advance_voucher_id = NEW.advance_voucher_id AND nature = 'REFUND_RECOVERY' AND status = 'POSTED';
    IF other_applications + refunds + NEW.amount > target_advance.payment_amount + 0.005 THEN RAISE EXCEPTION 'Advance applications exceed available advance.'; END IF;
  END IF;

  SELECT COALESCE(sum(amount), 0) INTO due_payments FROM labour_payment_allocations WHERE due_id = NEW.due_id AND status = 'ACTIVE';
  SELECT COALESCE(sum(amount), 0) INTO due_advances FROM labour_advance_applications WHERE due_id = NEW.due_id AND status = 'ACTIVE' AND id <> NEW.id;
  payable := GREATEST(target_due.gross_amount + target_due.adjustment_amount - target_due.authorized_deductions, 0);
  IF due_payments + due_advances + NEW.amount > payable + 0.005 THEN RAISE EXCEPTION 'Advance application exceeds due balance.'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
