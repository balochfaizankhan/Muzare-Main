-- Generic, idempotent repair for the accounting regression introduced by
-- commit 018f84d5 ("recognize labour wages only on settlement"): for a
-- window of time, ADVANCE_APPLICATION and DUE_PAYMENT settlement events
-- incorrectly debited LABOUR_EXPENSE (duplicating the expense already
-- recognized by the due's own DUE_RECOGNITION entry at creation) instead of
-- debiting LABOUR_PAYABLE to clear it. This migration detects and corrects
-- any such journal group generically — no due number, amount, or row id is
-- referenced by value. It is safe to run repeatedly: once a group is
-- corrected, it no longer matches the detection predicate (the misclassified
-- rows are POSTED only while unreversed) and the migration becomes a no-op
-- for that group.

WITH due_recognition AS (
  SELECT due_id
  FROM labour_accounting_entries
  WHERE event_type = 'DUE_RECOGNITION'
    AND ledger_code = 'LABOUR_EXPENSE'
    AND debit::numeric > 0
    AND status = 'POSTED'
    AND reversal_of IS NULL
),
misclassified_debits AS (
  SELECT
    lae.id,
    lae.entry_key,
    regexp_replace(lae.entry_key, ':debit$', '') AS event_base,
    lae.workspace_id, lae.farm_id, lae.season_id,
    lae.event_type, lae.due_id, lae.voucher_id, lae.advance_application_id,
    lae.debit, lae.credit, lae.posted_by
  FROM labour_accounting_entries lae
  JOIN due_recognition dr ON dr.due_id = lae.due_id
  LEFT JOIN labour_advance_applications app ON app.id = lae.advance_application_id
  LEFT JOIN labour_payment_vouchers voucher ON voucher.id = lae.voucher_id
  WHERE lae.event_type IN ('ADVANCE_APPLICATION', 'DUE_PAYMENT')
    AND lae.ledger_code = 'LABOUR_EXPENSE'
    AND lae.debit::numeric > 0
    AND lae.status = 'POSTED'
    AND lae.reversal_of IS NULL
    AND lae.due_id IS NOT NULL
    AND (
      (lae.event_type = 'ADVANCE_APPLICATION' AND app.status = 'ACTIVE')
      OR (lae.event_type = 'DUE_PAYMENT' AND voucher.status = 'POSTED')
    )
),
misclassified_credits AS (
  SELECT lae.id, lae.entry_key, lae.ledger_code, lae.debit, lae.credit, md.event_base
  FROM labour_accounting_entries lae
  JOIN misclassified_debits md ON lae.entry_key = md.event_base || ':credit'
  WHERE lae.reversal_of IS NULL
),
pairs AS (
  SELECT
    md.id AS debit_id, md.workspace_id, md.farm_id, md.season_id, md.event_base, md.event_type,
    md.due_id, md.voucher_id, md.advance_application_id, md.debit, md.credit, md.posted_by,
    mc.id AS credit_id, mc.ledger_code AS credit_ledger_code, mc.debit AS credit_row_debit, mc.credit AS credit_row_credit
  FROM misclassified_debits md
  JOIN misclassified_credits mc ON mc.event_base = md.event_base
)
INSERT INTO labour_accounting_entries (
  workspace_id, farm_id, season_id, entry_key, event_type, ledger_code, debit, credit, status, reversal_of,
  due_id, voucher_id, advance_application_id, posted_by, posted_at
)
SELECT p.workspace_id, p.farm_id, p.season_id,
  p.event_base || ':ledger-correction-reversal:' || p.debit_id, 'REVERSAL', 'LABOUR_EXPENSE',
  p.credit, p.debit, 'POSTED', p.debit_id,
  p.due_id, p.voucher_id, p.advance_application_id, p.posted_by, now()
FROM pairs p
WHERE NOT EXISTS (SELECT 1 FROM labour_accounting_entries r WHERE r.reversal_of = p.debit_id)
UNION ALL
SELECT p.workspace_id, p.farm_id, p.season_id,
  p.event_base || ':ledger-correction-reversal:' || p.credit_id, 'REVERSAL', p.credit_ledger_code,
  p.credit_row_credit, p.credit_row_debit, 'POSTED', p.credit_id,
  p.due_id, p.voucher_id, p.advance_application_id, p.posted_by, now()
FROM pairs p
WHERE NOT EXISTS (SELECT 1 FROM labour_accounting_entries r WHERE r.reversal_of = p.credit_id);

WITH due_recognition AS (
  SELECT due_id
  FROM labour_accounting_entries
  WHERE event_type = 'DUE_RECOGNITION'
    AND ledger_code = 'LABOUR_EXPENSE'
    AND debit::numeric > 0
    AND status = 'POSTED'
    AND reversal_of IS NULL
),
misclassified_debits AS (
  SELECT lae.id, regexp_replace(lae.entry_key, ':debit$', '') AS event_base
  FROM labour_accounting_entries lae
  JOIN due_recognition dr ON dr.due_id = lae.due_id
  LEFT JOIN labour_advance_applications app ON app.id = lae.advance_application_id
  LEFT JOIN labour_payment_vouchers voucher ON voucher.id = lae.voucher_id
  WHERE lae.event_type IN ('ADVANCE_APPLICATION', 'DUE_PAYMENT')
    AND lae.ledger_code = 'LABOUR_EXPENSE'
    AND lae.debit::numeric > 0
    AND lae.status = 'POSTED'
    AND lae.reversal_of IS NULL
    AND lae.due_id IS NOT NULL
    AND (
      (lae.event_type = 'ADVANCE_APPLICATION' AND app.status = 'ACTIVE')
      OR (lae.event_type = 'DUE_PAYMENT' AND voucher.status = 'POSTED')
    )
),
misclassified_credits AS (
  SELECT lae.id, md.event_base
  FROM labour_accounting_entries lae
  JOIN misclassified_debits md ON lae.entry_key = md.event_base || ':credit'
  WHERE lae.reversal_of IS NULL
),
misclassified_ids AS (
  SELECT id FROM misclassified_debits
  UNION ALL
  SELECT id FROM misclassified_credits
)
UPDATE labour_accounting_entries
SET status = 'REVERSED', updated_at = now()
WHERE id IN (SELECT id FROM misclassified_ids)
  AND status = 'POSTED'
  AND EXISTS (SELECT 1 FROM labour_accounting_entries r WHERE r.reversal_of = labour_accounting_entries.id);

WITH due_recognition AS (
  SELECT due_id
  FROM labour_accounting_entries
  WHERE event_type = 'DUE_RECOGNITION'
    AND ledger_code = 'LABOUR_EXPENSE'
    AND debit::numeric > 0
    AND status = 'POSTED'
    AND reversal_of IS NULL
),
misclassified_debits AS (
  SELECT
    lae.id, regexp_replace(lae.entry_key, ':debit$', '') AS event_base,
    lae.workspace_id, lae.farm_id, lae.season_id, lae.event_type,
    lae.due_id, lae.voucher_id, lae.advance_application_id, lae.debit, lae.posted_by
  FROM labour_accounting_entries lae
  JOIN due_recognition dr ON dr.due_id = lae.due_id
  LEFT JOIN labour_advance_applications app ON app.id = lae.advance_application_id
  LEFT JOIN labour_payment_vouchers voucher ON voucher.id = lae.voucher_id
  WHERE lae.event_type IN ('ADVANCE_APPLICATION', 'DUE_PAYMENT')
    AND lae.ledger_code = 'LABOUR_EXPENSE'
    AND lae.debit::numeric > 0
    AND lae.reversal_of IS NULL
    AND lae.due_id IS NOT NULL
    AND (
      (lae.event_type = 'ADVANCE_APPLICATION' AND app.status = 'ACTIVE')
      OR (lae.event_type = 'DUE_PAYMENT' AND voucher.status = 'POSTED')
    )
    AND EXISTS (SELECT 1 FROM labour_accounting_entries r WHERE r.reversal_of = lae.id)
),
misclassified_credits AS (
  SELECT lae.id, lae.entry_key, lae.ledger_code, lae.credit, md.event_base
  FROM labour_accounting_entries lae
  JOIN misclassified_debits md ON lae.entry_key = md.event_base || ':credit'
),
pairs AS (
  SELECT md.workspace_id, md.farm_id, md.season_id, md.event_base, md.event_type,
    md.due_id, md.voucher_id, md.advance_application_id, md.debit, md.posted_by,
    mc.ledger_code AS credit_ledger_code, mc.credit AS credit_amount
  FROM misclassified_debits md
  JOIN misclassified_credits mc ON mc.event_base = md.event_base
)
INSERT INTO labour_accounting_entries (
  workspace_id, farm_id, season_id, entry_key, event_type, ledger_code, debit, credit, status,
  due_id, voucher_id, advance_application_id, posted_by, posted_at
)
SELECT p.workspace_id, p.farm_id, p.season_id,
  p.event_base || ':ledger-correction:debit', p.event_type, 'LABOUR_PAYABLE', p.debit, '0', 'POSTED',
  p.due_id, p.voucher_id, p.advance_application_id, p.posted_by, now()
FROM pairs p
WHERE NOT EXISTS (
  SELECT 1 FROM labour_accounting_entries existing
  WHERE existing.workspace_id = p.workspace_id AND existing.entry_key = p.event_base || ':ledger-correction:debit'
)
UNION ALL
SELECT p.workspace_id, p.farm_id, p.season_id,
  p.event_base || ':ledger-correction:credit', p.event_type, p.credit_ledger_code, '0', p.credit_amount, 'POSTED',
  p.due_id, p.voucher_id, p.advance_application_id, p.posted_by, now()
FROM pairs p
WHERE NOT EXISTS (
  SELECT 1 FROM labour_accounting_entries existing
  WHERE existing.workspace_id = p.workspace_id AND existing.entry_key = p.event_base || ':ledger-correction:credit'
);
