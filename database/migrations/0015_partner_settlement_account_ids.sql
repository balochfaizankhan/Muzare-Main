WITH settlement_matches AS (
  SELECT
    settlement.id,
    from_account.client_record_id AS from_account_id,
    to_account.client_record_id AS to_account_id,
    count(from_account.id) OVER (PARTITION BY settlement.id) AS from_matches,
    count(to_account.id) OVER (PARTITION BY settlement.id) AS to_matches
  FROM operational_records settlement
  LEFT JOIN operational_records from_account
    ON from_account.workspace_id = settlement.workspace_id
   AND from_account.farm_id = settlement.farm_id
   AND from_account.season_id IS NOT DISTINCT FROM settlement.season_id
   AND from_account.entity_type = 'account'
   AND lower(trim(from_account.payload->>'name')) = lower(trim(settlement.payload->>'fromPartner'))
  LEFT JOIN operational_records to_account
    ON to_account.workspace_id = settlement.workspace_id
   AND to_account.farm_id = settlement.farm_id
   AND to_account.season_id IS NOT DISTINCT FROM settlement.season_id
   AND to_account.entity_type = 'account'
   AND lower(trim(to_account.payload->>'name')) = lower(trim(settlement.payload->>'toPartner'))
  WHERE settlement.entity_type = 'partnerEntry'
    AND settlement.payload->>'type' = 'settlement'
    AND (settlement.payload->>'fromAccountId' IS NULL OR settlement.payload->>'toAccountId' IS NULL)
),
resolved AS (
  SELECT id, max(from_account_id) AS from_account_id, max(to_account_id) AS to_account_id
  FROM settlement_matches
  GROUP BY id
  HAVING max(from_matches) = 1 AND max(to_matches) = 1
)
UPDATE operational_records settlement
SET payload = settlement.payload
  || jsonb_build_object('fromAccountId', resolved.from_account_id, 'toAccountId', resolved.to_account_id)
  - 'unresolvedSettlement',
    updated_at = now()
FROM resolved
WHERE settlement.id = resolved.id;

UPDATE operational_records settlement
SET payload = settlement.payload || jsonb_build_object('unresolvedSettlement', true),
    updated_at = now()
WHERE settlement.entity_type = 'partnerEntry'
  AND settlement.payload->>'type' = 'settlement'
  AND (settlement.payload->>'fromAccountId' IS NULL OR settlement.payload->>'toAccountId' IS NULL);
