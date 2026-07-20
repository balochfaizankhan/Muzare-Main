-- Access paths for the paginated Outstanding Advances read model.
-- These indexes do not alter accounting data or replay historical postings.
CREATE INDEX IF NOT EXISTS labour_payment_vouchers_advance_list_idx
  ON labour_payment_vouchers(workspace_id, farm_id, season_id, voucher_date DESC, created_at DESC, id DESC)
  WHERE nature = 'ADVANCE';

CREATE INDEX IF NOT EXISTS labour_payment_vouchers_advance_refunds_idx
  ON labour_payment_vouchers(related_advance_voucher_id, status)
  WHERE nature = 'REFUND_RECOVERY' AND related_advance_voucher_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS operational_records_advance_scope_list_idx
  ON operational_records(workspace_id, farm_id, season_id, created_at DESC, id DESC)
  WHERE entity_type = 'advance';

CREATE INDEX IF NOT EXISTS advance_records_scope_date_idx
  ON advance_records(farm_id, season_id, advance_date DESC, created_at DESC, id DESC);
