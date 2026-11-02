-- Permit voucher numbers to restart per season while preserving all existing records.
-- Existing voucher numbers are intentionally not renumbered.
CREATE UNIQUE INDEX IF NOT EXISTS labour_payment_vouchers_workspace_farm_season_number_uidx
  ON labour_payment_vouchers (workspace_id, farm_id, season_id, voucher_number);
DROP INDEX IF EXISTS labour_payment_vouchers_workspace_farm_number_uidx;
