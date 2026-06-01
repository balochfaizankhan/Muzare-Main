CREATE TABLE IF NOT EXISTS muzare_data_migrations (
  key text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE
  missing_scope record;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM muzare_data_migrations WHERE key = '0014_historical_labour_advance_younis_account'
  ) THEN
    FOR missing_scope IN
      SELECT DISTINCT advance.workspace_id, advance.farm_id, advance.season_id
      FROM operational_records advance
      WHERE advance.entity_type = 'advance'
        AND NULLIF(btrim(advance.payload->>'labourerId'), '') IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM operational_records account
          WHERE account.workspace_id = advance.workspace_id
            AND account.farm_id IS NOT DISTINCT FROM advance.farm_id
            AND account.season_id IS NOT DISTINCT FROM advance.season_id
            AND account.entity_type = 'account'
            AND lower(btrim(account.payload->>'name')) = 'younis khan'
        )
    LOOP
      RAISE WARNING 'Skipping labour advance account correction for workspace %, farm %, season %: Younis Khan account was not found.',
        missing_scope.workspace_id, missing_scope.farm_id, missing_scope.season_id;
    END LOOP;

    WITH correction_targets AS (
      SELECT DISTINCT ON (advance.id)
        advance.id AS advance_id,
        advance.workspace_id,
        advance.farm_id,
        advance.payload->>'accountId' AS previous_account_id,
        account.client_record_id AS account_id
      FROM operational_records advance
      JOIN operational_records account
        ON account.workspace_id = advance.workspace_id
       AND account.farm_id IS NOT DISTINCT FROM advance.farm_id
       AND account.season_id IS NOT DISTINCT FROM advance.season_id
       AND account.entity_type = 'account'
       AND lower(btrim(account.payload->>'name')) = 'younis khan'
      WHERE advance.entity_type = 'advance'
        AND NULLIF(btrim(advance.payload->>'labourerId'), '') IS NOT NULL
        AND advance.payload->>'accountId' IS DISTINCT FROM account.client_record_id
      ORDER BY advance.id, account.created_at, account.id
    ),
    corrected AS (
      UPDATE operational_records advance
      SET payload = advance.payload || jsonb_build_object(
            'accountId', correction_targets.account_id,
            'sourceAccountName', 'Younis Khan'
          ),
          updated_at = now()
      FROM correction_targets
      WHERE advance.id = correction_targets.advance_id
      RETURNING
        advance.id,
        advance.workspace_id,
        advance.farm_id,
        correction_targets.previous_account_id,
        correction_targets.account_id
    )
    INSERT INTO audit_logs (workspace_id, farm_id, action, entity_type, entity_id, details)
    SELECT
      workspace_id,
      farm_id,
      'labour_advance_account_corrected',
      'advance',
      id,
      jsonb_build_object(
        'message', 'Labour advance account corrected to Younis Khan',
        'previousAccountId', previous_account_id,
        'accountId', account_id,
        'sourceAccountName', 'Younis Khan'
      )
    FROM corrected;

    INSERT INTO muzare_data_migrations (key)
    VALUES ('0014_historical_labour_advance_younis_account');
  END IF;
END $$;
