-- Restore immutable funding-source attribution for aggregate Group Advance Pool applications.
--
-- Migration 0047 correctly changed settlement math to ONE aggregate pool-level
-- application and removed per-voucher consumption from the balance model. It also
-- stopped writing labour_advance_application_sources. That second change broke
-- downstream attribution: the application itself still reduced the group pool, but
-- Partner Ledger, Labour Payments voucher details, and Expense Summary by account no
-- longer knew which original payment account(s) funded the applied amount.
--
-- This migration restores source rows strictly as ATTRIBUTION/AUDIT lineage. They do
-- NOT participate in validate_labour_advance_application or any pool-balance formula.
-- The authoritative balance remains migration-0047's signed aggregate pool:
--   total POSTED advances - ACTIVE pool applications - POSTED recoveries.
--
-- Attribution convention: deterministic FIFO across advance vouchers that belong to
-- the due's current pool, ordered by voucher date / creation / id. Earlier active
-- source allocations, legacy per-voucher applications, and recoveries are respected.
-- A source attribution is kept only when the full pooled application can be proved;
-- partial attribution is deleted rather than inventing an owner.
--
-- Existing sourceless ACTIVE pooled applications are backfilled once. A trigger then
-- records attribution automatically for every future aggregate application. Reversal
-- never deletes the source rows: application status controls whether they are active,
-- preserving immutable audit history and allowing exact reversal reporting.

CREATE OR REPLACE FUNCTION attribute_labour_advance_application_sources(in_application_id uuid) RETURNS boolean AS $$
DECLARE
  app_row labour_advance_applications%ROWTYPE;
  due_row labour_dues%ROWTYPE;
  voucher_row RECORD;
  target_pool_key text;
  remaining numeric;
  pool_recovery_remaining numeric;
  available numeric;
  recovery_take numeric;
  take numeric;
  next_order integer := 0;
BEGIN
  SELECT * INTO app_row
  FROM labour_advance_applications
  WHERE id = in_application_id;

  IF app_row.id IS NULL
     OR app_row.advance_voucher_id IS NOT NULL
     OR app_row.status <> 'ACTIVE' THEN
    RETURN false;
  END IF;

  -- Idempotent: an already-attributed pooled application is left untouched.
  IF EXISTS (
    SELECT 1 FROM labour_advance_application_sources s
    WHERE s.application_id = app_row.id
  ) THEN
    RETURN true;
  END IF;

  SELECT * INTO due_row FROM labour_dues WHERE id = app_row.due_id;
  IF due_row.id IS NULL THEN RETURN false; END IF;

  target_pool_key := labour_due_pool_key(due_row);
  IF target_pool_key IS NULL THEN RETURN false; END IF;

  remaining := app_row.amount;

  -- Pool-level recoveries have no related advance voucher. For attribution only,
  -- consume them FIFO before assigning this application so a recovered amount is
  -- never also presented as applied from the same original funding.
  SELECT COALESCE(sum(r.payment_amount), 0)
  INTO pool_recovery_remaining
  FROM labour_payment_vouchers r
  WHERE r.workspace_id = due_row.workspace_id
    AND r.farm_id = due_row.farm_id
    AND r.season_id = due_row.season_id
    AND r.nature = 'REFUND_RECOVERY'
    AND r.status = 'POSTED'
    AND r.related_advance_voucher_id IS NULL
    AND r.created_at <= app_row.created_at
    AND labour_advance_pool_key(r) = target_pool_key;

  FOR voucher_row IN
    SELECT
      v.id,
      v.payment_amount,
      COALESCE((
        SELECT sum(a.amount)
        FROM labour_advance_applications a
        WHERE a.advance_voucher_id = v.id
          AND a.status = 'ACTIVE'
          AND a.created_at <= app_row.created_at
      ), 0) AS direct_applied,
      COALESCE((
        SELECT sum(s.amount)
        FROM labour_advance_application_sources s
        JOIN labour_advance_applications pa ON pa.id = s.application_id
        WHERE s.advance_voucher_id = v.id
          AND pa.status = 'ACTIVE'
          AND pa.id <> app_row.id
          AND pa.created_at <= app_row.created_at
      ), 0) AS source_applied,
      COALESCE((
        SELECT sum(r.payment_amount)
        FROM labour_payment_vouchers r
        WHERE r.related_advance_voucher_id = v.id
          AND r.nature = 'REFUND_RECOVERY'
          AND r.status = 'POSTED'
          AND r.created_at <= app_row.created_at
      ), 0) AS specifically_recovered
    FROM labour_payment_vouchers v
    WHERE v.workspace_id = due_row.workspace_id
      AND v.farm_id = due_row.farm_id
      AND v.season_id = due_row.season_id
      AND v.nature = 'ADVANCE'
      AND v.status = 'POSTED'
      AND v.created_at <= app_row.created_at
      AND v.voucher_date <= app_row.created_at::date
      AND labour_advance_pool_key(v) = target_pool_key
    ORDER BY v.voucher_date, v.created_at, v.id
  LOOP
    EXIT WHEN remaining <= 0.005;

    available := voucher_row.payment_amount
      - voucher_row.direct_applied
      - voucher_row.source_applied
      - voucher_row.specifically_recovered;

    IF available <= 0.005 THEN CONTINUE; END IF;

    IF pool_recovery_remaining > 0.005 THEN
      recovery_take := LEAST(available, pool_recovery_remaining);
      available := available - recovery_take;
      pool_recovery_remaining := pool_recovery_remaining - recovery_take;
    END IF;

    IF available <= 0.005 THEN CONTINUE; END IF;

    take := LEAST(available, remaining);
    next_order := next_order + 1;

    INSERT INTO labour_advance_application_sources (
      workspace_id,
      application_id,
      advance_voucher_id,
      amount,
      allocation_order
    ) VALUES (
      due_row.workspace_id,
      app_row.id,
      voucher_row.id,
      take,
      next_order
    );

    remaining := remaining - take;
  END LOOP;

  -- Never leave a partly-attributed pooled application. If the complete amount
  -- cannot be proved from the pool's original funding, retain the application
  -- itself but remove attribution rows so it remains visibly reviewable.
  IF remaining > 0.005 THEN
    DELETE FROM labour_advance_application_sources
    WHERE application_id = app_row.id;
    RETURN false;
  END IF;

  RETURN true;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION populate_pooled_advance_application_sources() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'ACTIVE' AND NEW.advance_voucher_id IS NULL THEN
    PERFORM attribute_labour_advance_application_sources(NEW.id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS populate_pooled_advance_application_sources_trigger
  ON labour_advance_applications;

CREATE TRIGGER populate_pooled_advance_application_sources_trigger
AFTER INSERT ON labour_advance_applications
FOR EACH ROW
EXECUTE FUNCTION populate_pooled_advance_application_sources();

-- Repair aggregate applications created after 0047 stopped writing source rows.
-- 0046-era source rows are already present and are skipped by the helper.
DO $$
DECLARE
  app RECORD;
BEGIN
  FOR app IN
    SELECT a.id
    FROM labour_advance_applications a
    WHERE a.advance_voucher_id IS NULL
      AND a.status = 'ACTIVE'
      AND NOT EXISTS (
        SELECT 1 FROM labour_advance_application_sources s
        WHERE s.application_id = a.id
      )
    ORDER BY a.created_at, a.id
  LOOP
    PERFORM attribute_labour_advance_application_sources(app.id);
  END LOOP;
END $$;
