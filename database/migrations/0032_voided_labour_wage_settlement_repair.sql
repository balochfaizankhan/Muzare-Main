WITH voided_settlements AS (
  SELECT
    client_record_id,
    workspace_id,
    farm_id,
    season_id,
    payload
  FROM operational_records
  WHERE entity_type = 'labourWageSettlement'
    AND (
      lower(coalesce(payload->>'status', '')) IN ('voided', 'deleted', 'cancelled')
      OR coalesce(payload->>'voidedAt', '') <> ''
      OR coalesce(payload->>'deletedAt', '') <> ''
      OR coalesce(payload->>'reversedAt', '') <> ''
    )
),
linked_vouchers AS (
  SELECT DISTINCT ON (voucher.id)
    voucher.id,
    settlement.client_record_id AS settlement_id
  FROM operational_records voucher
  JOIN voided_settlements settlement
    ON settlement.workspace_id = voucher.workspace_id
   AND settlement.farm_id = voucher.farm_id
   AND voucher.entity_type = 'voucher'
   AND (
     coalesce(voucher.payload->>'settlementId', '') = settlement.client_record_id::text
     OR coalesce(voucher.payload->>'linkedVoucherId', '') = settlement.client_record_id::text
     OR coalesce(voucher.client_record_id::text, '') = coalesce(settlement.payload->>'linkedVoucherId', '')
   )
)
UPDATE operational_records voucher
SET payload = jsonb_set(
  jsonb_set(
    jsonb_set(
      coalesce(voucher.payload, '{}'::jsonb),
      '{settlementId}',
      to_jsonb(linked_vouchers.settlement_id),
      true
    ),
    '{voucherPurpose}',
    to_jsonb('labour_wage_settlement'::text),
    true
  ),
  '{nonCashSettlement}',
  'true'::jsonb,
  true
),
updated_at = now(),
client_updated_at = now()
FROM linked_vouchers
WHERE voucher.id = linked_vouchers.id
  AND (
    coalesce(voucher.payload->>'settlementId', '') <> linked_vouchers.settlement_id::text
    OR coalesce(voucher.payload->>'voucherPurpose', '') <> 'labour_wage_settlement'
    OR coalesce(voucher.payload->>'nonCashSettlement', 'false') <> 'true'
  );

WITH voided_settlements AS (
  SELECT
    client_record_id,
    workspace_id,
    farm_id,
    season_id
  FROM operational_records
  WHERE entity_type = 'labourWageSettlement'
    AND (
      lower(coalesce(payload->>'status', '')) IN ('voided', 'deleted', 'cancelled')
      OR coalesce(payload->>'voidedAt', '') <> ''
      OR coalesce(payload->>'deletedAt', '') <> ''
      OR coalesce(payload->>'reversedAt', '') <> ''
    )
)
UPDATE operational_records earning
SET payload = jsonb_set(
  jsonb_set(
    jsonb_set(
      coalesce(earning.payload, '{}'::jsonb),
      '{status}',
      to_jsonb('pending_settlement'::text),
      true
    ),
    '{linkedSettlementId}',
    'null'::jsonb,
    true
  ),
  '{settlementDate}',
  'null'::jsonb,
  true
),
updated_at = now(),
client_updated_at = now()
FROM voided_settlements settlement
WHERE earning.entity_type = 'labourEarning'
  AND earning.workspace_id = settlement.workspace_id
  AND earning.farm_id = settlement.farm_id
  AND coalesce(earning.payload->>'linkedSettlementId', '') = settlement.client_record_id::text
  AND lower(coalesce(earning.payload->>'status', '')) = 'settled';

WITH voided_settlements AS (
  SELECT
    client_record_id,
    workspace_id,
    farm_id,
    season_id,
    payload
  FROM operational_records
  WHERE entity_type = 'labourWageSettlement'
    AND (
      lower(coalesce(payload->>'status', '')) IN ('voided', 'deleted', 'cancelled')
      OR coalesce(payload->>'voidedAt', '') <> ''
      OR coalesce(payload->>'deletedAt', '') <> ''
      OR coalesce(payload->>'reversedAt', '') <> ''
    )
),
missing_reversals AS (
  SELECT DISTINCT ON (settlement.client_record_id)
    settlement.client_record_id AS settlement_id,
    settlement.workspace_id,
    settlement.farm_id,
    settlement.season_id,
    settlement.payload,
    original.reference_id AS settlement_reference_id,
    original.account_id,
    original.type,
    original.amount,
    original.transaction_date,
    original.created_by
  FROM voided_settlements settlement
  JOIN account_transactions original
    ON original.reference_id::text = settlement.client_record_id::text
   AND original.source = 'settlement'
   AND original.source_type = 'labour_wage_settlement'
  WHERE NOT EXISTS (
    SELECT 1
    FROM account_transactions reversal
    WHERE reversal.reference_id::text = settlement.client_record_id::text
      AND reversal.source = 'settlement'
      AND reversal.source_type = 'labour_wage_settlement'
      AND coalesce(reversal.remarks, '') LIKE 'Reversal of Labour Wage Settlement%'
  )
  ORDER BY settlement.client_record_id, original.created_at ASC
)
INSERT INTO account_transactions (
  farm_id,
  season_id,
  account_id,
  source,
  reference_id,
  type,
  amount,
  transaction_date,
  remarks,
  created_by
)
SELECT
  missing_reversals.farm_id,
  missing_reversals.season_id,
  missing_reversals.account_id,
  'settlement',
  missing_reversals.settlement_reference_id,
  CASE WHEN missing_reversals.type = 'credit' THEN 'debit' ELSE 'credit' END,
  missing_reversals.amount,
  missing_reversals.transaction_date,
  'Reversal of Labour Wage Settlement ' || coalesce(missing_reversals.payload->>'settlementNumber', missing_reversals.settlement_id),
  missing_reversals.created_by
FROM missing_reversals;
