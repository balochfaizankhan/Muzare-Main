-- Keep the database guard aligned with the server-side canonical recipient
-- resolver. Legacy advance vouchers may still carry a legacy financial scope
-- key even though their immutable voucher fields/snapshot identify the
-- labourer or group owner reliably.
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
  effective_advance_scope text;
  snapshot_labourer_id text;
  snapshot_group_id text;
BEGIN
  IF NEW.status <> 'ACTIVE' THEN RETURN NEW; END IF;
  SELECT * INTO target_due FROM labour_dues WHERE id = NEW.due_id FOR UPDATE;
  SELECT * INTO target_advance FROM labour_payment_vouchers WHERE id = NEW.advance_voucher_id FOR UPDATE;
  IF target_due.id IS NULL OR target_advance.id IS NULL OR target_due.workspace_id <> NEW.workspace_id OR target_advance.workspace_id <> NEW.workspace_id THEN
    RAISE EXCEPTION 'Advance application context is invalid.';
  END IF;

  snapshot_labourer_id := COALESCE(
    target_advance.labourer_id,
    target_advance.recipient_snapshot->>'labourerId',
    target_advance.recipient_snapshot->>'advanceLabourerId',
    target_advance.recipient_snapshot->>'recipientLabourerId'
  );
  snapshot_group_id := COALESCE(
    target_advance.labour_group_id,
    target_advance.recipient_snapshot->>'labourGroupId',
    target_advance.recipient_snapshot->>'groupId'
  );
  effective_advance_scope := target_advance.financial_scope_key;
  IF effective_advance_scope LIKE 'legacy:%' THEN
    IF snapshot_group_id IS NOT NULL AND snapshot_group_id <> '' THEN
      effective_advance_scope := 'group:' || snapshot_group_id;
    ELSIF snapshot_labourer_id IS NOT NULL AND snapshot_labourer_id <> '' THEN
      effective_advance_scope := 'individual:' || snapshot_labourer_id;
    END IF;
  END IF;

  scope_is_eligible := effective_advance_scope = target_due.financial_scope_key;
  IF NOT scope_is_eligible AND target_due.recipient_scope = 'LABOUR_GROUP' AND snapshot_labourer_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM labour_due_member_snapshots member
      WHERE member.workspace_id = NEW.workspace_id
        AND member.due_id = NEW.due_id
        AND member.labourer_id = snapshot_labourer_id
    ) OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(target_due.recipient_snapshot->'memberCalculationSnapshot', '[]'::jsonb)) member
      WHERE member->>'labourerId' = snapshot_labourer_id
    ) INTO scope_is_eligible;
  END IF;

  IF target_advance.nature <> 'ADVANCE' OR target_advance.status <> 'POSTED' OR NOT scope_is_eligible THEN
    RAISE EXCEPTION 'Advance and due financial scopes do not match.';
  END IF;
  SELECT COALESCE(sum(amount), 0) INTO other_applications FROM labour_advance_applications WHERE advance_voucher_id = NEW.advance_voucher_id AND status = 'ACTIVE' AND id <> NEW.id;
  SELECT COALESCE(sum(payment_amount), 0) INTO refunds FROM labour_payment_vouchers WHERE related_advance_voucher_id = NEW.advance_voucher_id AND nature = 'REFUND_RECOVERY' AND status = 'POSTED';
  IF other_applications + refunds + NEW.amount > target_advance.payment_amount + 0.005 THEN RAISE EXCEPTION 'Advance applications exceed available advance.'; END IF;
  SELECT COALESCE(sum(amount), 0) INTO due_payments FROM labour_payment_allocations WHERE due_id = NEW.due_id AND status = 'ACTIVE';
  SELECT COALESCE(sum(amount), 0) INTO due_advances FROM labour_advance_applications WHERE due_id = NEW.due_id AND status = 'ACTIVE' AND id <> NEW.id;
  payable := GREATEST(target_due.gross_amount + target_due.adjustment_amount - target_due.authorized_deductions, 0);
  IF due_payments + due_advances + NEW.amount > payable + 0.005 THEN RAISE EXCEPTION 'Advance application exceeds due balance.'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
