-- Labour Payments remediation: production-safe detection only.
-- Run with explicit psql variables, for example:
-- psql ... -v workspace_id='<uuid>' -v farm_id='<uuid>' -v season_id='<uuid>' -f this-file.sql
-- Pass season_id='' only when deliberately auditing every season in the selected farm.
BEGIN TRANSACTION READ ONLY;
SELECT set_config('muzare.audit_workspace_id', :'workspace_id', true);
SELECT set_config('muzare.audit_farm_id', :'farm_id', true);
SELECT set_config('muzare.audit_season_id', :'season_id', true);

-- This inline scope is repeated deliberately so the file remains read-only.
-- s.workspace_id = current_setting('muzare.audit_workspace_id')::uuid
-- s.farm_id      = current_setting('muzare.audit_farm_id')::uuid
-- s.season_id    = nullif(current_setting('muzare.audit_season_id'),'')::uuid

-- 1. Original journal lines with more than one reversal.
SELECT o.id AS original_journal_id, o.entry_key, count(r.id) AS reversal_count
FROM labour_accounting_entries o JOIN labour_accounting_entries r ON r.reversal_of = o.id
CROSS JOIN (SELECT current_setting('muzare.audit_workspace_id')::uuid workspace_id,current_setting('muzare.audit_farm_id')::uuid farm_id,nullif(current_setting('muzare.audit_season_id'),'')::uuid season_id) s
WHERE o.workspace_id=s.workspace_id AND o.farm_id=s.farm_id AND (s.season_id IS NULL OR o.season_id=s.season_id)
GROUP BY o.id,o.entry_key HAVING count(r.id)>1;

-- 2. A reversal that references another reversal.
SELECT r.id AS reversal_id, r.entry_key, o.id AS referenced_reversal_id, o.entry_key AS referenced_entry_key
FROM labour_accounting_entries r JOIN labour_accounting_entries o ON o.id=r.reversal_of
CROSS JOIN (SELECT current_setting('muzare.audit_workspace_id')::uuid workspace_id,current_setting('muzare.audit_farm_id')::uuid farm_id,nullif(current_setting('muzare.audit_season_id'),'')::uuid season_id) s
WHERE r.workspace_id=s.workspace_id AND r.farm_id=s.farm_id AND (s.season_id IS NULL OR r.season_id=s.season_id)
  AND (o.reversal_of IS NOT NULL OR o.event_type='REVERSAL');

-- 3. Reversal without a valid original (also detects broken references on pre-FK databases).
SELECT r.* FROM labour_accounting_entries r LEFT JOIN labour_accounting_entries o ON o.id=r.reversal_of
CROSS JOIN (SELECT current_setting('muzare.audit_workspace_id')::uuid workspace_id,current_setting('muzare.audit_farm_id')::uuid farm_id,nullif(current_setting('muzare.audit_season_id'),'')::uuid season_id) s
WHERE r.workspace_id=s.workspace_id AND r.farm_id=s.farm_id AND (s.season_id IS NULL OR r.season_id=s.season_id)
  AND r.reversal_of IS NOT NULL AND (o.id IS NULL OR o.reversal_of IS NOT NULL OR o.event_type='REVERSAL');

-- 4. Original and reversal do not exactly net to zero per ledger and dimension.
SELECT o.id AS original_id,r.id AS reversal_id,o.ledger_code,
  (o.debit+r.debit)-(o.credit+r.credit) AS net,
  o.workspace_id,o.farm_id,o.season_id,o.due_id,o.voucher_id,o.advance_application_id
FROM labour_accounting_entries o JOIN labour_accounting_entries r ON r.reversal_of=o.id
CROSS JOIN (SELECT current_setting('muzare.audit_workspace_id')::uuid workspace_id,current_setting('muzare.audit_farm_id')::uuid farm_id,nullif(current_setting('muzare.audit_season_id'),'')::uuid season_id) s
WHERE o.workspace_id=s.workspace_id AND o.farm_id=s.farm_id AND (s.season_id IS NULL OR o.season_id=s.season_id)
  AND ((o.debit+r.debit)<>(o.credit+r.credit) OR r.ledger_code<>o.ledger_code
    OR r.workspace_id<>o.workspace_id OR r.farm_id<>o.farm_id OR r.season_id<>o.season_id
    OR r.due_id IS DISTINCT FROM o.due_id OR r.voucher_id IS DISTINCT FROM o.voucher_id
    OR r.advance_application_id IS DISTINCT FROM o.advance_application_id);

-- 5. Operationally reversed payment with a non-zero current journal effect.
SELECT v.id,v.voucher_number,e.ledger_code,sum(e.debit-e.credit) AS active_effect
FROM labour_payment_vouchers v JOIN labour_accounting_entries e ON e.voucher_id=v.id
CROSS JOIN (SELECT current_setting('muzare.audit_workspace_id')::uuid workspace_id,current_setting('muzare.audit_farm_id')::uuid farm_id,nullif(current_setting('muzare.audit_season_id'),'')::uuid season_id) s
WHERE v.workspace_id=s.workspace_id AND v.farm_id=s.farm_id AND (s.season_id IS NULL OR v.season_id=s.season_id)
  AND v.status IN ('REVERSED','VOIDED')
GROUP BY v.id,v.voucher_number,e.ledger_code HAVING sum(e.debit-e.credit)<>0;

-- 6. Operationally reversed application with a non-zero current journal effect.
SELECT a.id,e.ledger_code,sum(e.debit-e.credit) AS active_effect
FROM labour_advance_applications a JOIN labour_dues d ON d.id=a.due_id
JOIN labour_accounting_entries e ON e.advance_application_id=a.id CROSS JOIN (SELECT current_setting('muzare.audit_workspace_id')::uuid workspace_id,current_setting('muzare.audit_farm_id')::uuid farm_id,nullif(current_setting('muzare.audit_season_id'),'')::uuid season_id) s
WHERE d.workspace_id=s.workspace_id AND d.farm_id=s.farm_id AND (s.season_id IS NULL OR d.season_id=s.season_id)
  AND a.status='REVERSED'
GROUP BY a.id,e.ledger_code HAVING sum(e.debit-e.credit)<>0;

-- 7. Voided due retaining an expense or payable effect.
SELECT d.id,d.due_number,e.ledger_code,sum(e.debit-e.credit) AS active_effect
FROM labour_dues d JOIN labour_accounting_entries e ON e.due_id=d.id CROSS JOIN (SELECT current_setting('muzare.audit_workspace_id')::uuid workspace_id,current_setting('muzare.audit_farm_id')::uuid farm_id,nullif(current_setting('muzare.audit_season_id'),'')::uuid season_id) s
WHERE d.workspace_id=s.workspace_id AND d.farm_id=s.farm_id AND (s.season_id IS NULL OR d.season_id=s.season_id)
  AND d.payment_status='VOIDED' AND e.ledger_code IN ('LABOUR_EXPENSE','LABOUR_PAYABLE')
GROUP BY d.id,d.due_number,e.ledger_code HAVING sum(e.debit-e.credit)<>0;

-- 8. Posted canonical cash voucher without its required account transaction.
SELECT v.id,v.voucher_number,v.nature,v.payment_amount,v.payment_account_id,v.account_transaction_id
FROM labour_payment_vouchers v LEFT JOIN account_transactions t ON t.id=v.account_transaction_id CROSS JOIN (SELECT current_setting('muzare.audit_workspace_id')::uuid workspace_id,current_setting('muzare.audit_farm_id')::uuid farm_id,nullif(current_setting('muzare.audit_season_id'),'')::uuid season_id) s
WHERE v.workspace_id=s.workspace_id AND v.farm_id=s.farm_id AND (s.season_id IS NULL OR v.season_id=s.season_id)
  AND NOT v.legacy AND v.status='POSTED' AND v.payment_account_id IS NOT NULL
  AND (t.id IS NULL OR t.reference_id<>v.id OR t.account_id<>v.payment_account_id OR t.amount<>v.payment_amount);

-- 9. Canonical and legacy operational representations that coexist. These are
-- expected only when the shared read model suppresses the linked legacy source.
SELECT v.id AS voucher_id,v.voucher_number,o.id AS operational_record_id,o.client_record_id
FROM labour_payment_vouchers v JOIN operational_records o
  ON o.workspace_id=v.workspace_id AND o.entity_type IN ('advance','labourPayment')
  AND (o.client_record_id=v.source_id OR o.id=v.legacy_source_record_id)
CROSS JOIN (SELECT current_setting('muzare.audit_workspace_id')::uuid workspace_id,current_setting('muzare.audit_farm_id')::uuid farm_id,nullif(current_setting('muzare.audit_season_id'),'')::uuid season_id) s
WHERE v.workspace_id=s.workspace_id AND v.farm_id=s.farm_id AND (s.season_id IS NULL OR v.season_id=s.season_id)
  AND NOT v.legacy;

-- 10. Partner Position cash movement versus normalized partner-payable journal.
WITH account_effect AS (
 SELECT v.payment_account_id AS account_id,sum(CASE WHEN t.type='credit' THEN t.amount ELSE -t.amount END) amount
 FROM labour_payment_vouchers v JOIN account_transactions t ON t.id=v.account_transaction_id CROSS JOIN (SELECT current_setting('muzare.audit_workspace_id')::uuid workspace_id,current_setting('muzare.audit_farm_id')::uuid farm_id,nullif(current_setting('muzare.audit_season_id'),'')::uuid season_id) s
 WHERE v.workspace_id=s.workspace_id AND v.farm_id=s.farm_id AND (s.season_id IS NULL OR v.season_id=s.season_id) AND NOT v.legacy
 GROUP BY v.payment_account_id
), journal_effect AS (
 SELECT v.payment_account_id AS account_id,sum(e.credit-e.debit) amount
 FROM labour_payment_vouchers v JOIN labour_accounting_entries e ON e.voucher_id=v.id CROSS JOIN (SELECT current_setting('muzare.audit_workspace_id')::uuid workspace_id,current_setting('muzare.audit_farm_id')::uuid farm_id,nullif(current_setting('muzare.audit_season_id'),'')::uuid season_id) s
 WHERE v.workspace_id=s.workspace_id AND v.farm_id=s.farm_id AND (s.season_id IS NULL OR v.season_id=s.season_id)
   AND e.ledger_code='PARTNER_PAYABLE' AND NOT v.legacy GROUP BY v.payment_account_id
)
SELECT coalesce(a.account_id,j.account_id) account_id,coalesce(a.amount,0) partner_position,coalesce(j.amount,0) partner_ledger,
 coalesce(a.amount,0)-coalesce(j.amount,0) difference FROM account_effect a FULL JOIN journal_effect j USING(account_id)
WHERE coalesce(a.amount,0)<>coalesce(j.amount,0);

-- 11. Due equation mismatch. Expected remaining = gross + adjustment - deductions - active applications - active payments.
SELECT d.id,d.due_number,d.payment_status,
 d.gross_amount+d.adjustment_amount-d.authorized_deductions
 -coalesce((SELECT sum(a.amount) FROM labour_advance_applications a WHERE a.due_id=d.id AND a.status='ACTIVE'),0)
 -coalesce((SELECT sum(p.amount) FROM labour_payment_allocations p WHERE p.due_id=d.id AND p.status='ACTIVE'),0) AS expected_remaining
FROM labour_dues d CROSS JOIN (SELECT current_setting('muzare.audit_workspace_id')::uuid workspace_id,current_setting('muzare.audit_farm_id')::uuid farm_id,nullif(current_setting('muzare.audit_season_id'),'')::uuid season_id) s
WHERE d.workspace_id=s.workspace_id AND d.farm_id=s.farm_id AND (s.season_id IS NULL OR d.season_id=s.season_id)
 AND d.payment_status<>'VOIDED' AND ((d.payment_status='PAID') <>
 ((d.gross_amount+d.adjustment_amount-d.authorized_deductions
 -coalesce((SELECT sum(a.amount) FROM labour_advance_applications a WHERE a.due_id=d.id AND a.status='ACTIVE'),0)
 -coalesce((SELECT sum(p.amount) FROM labour_payment_allocations p WHERE p.due_id=d.id AND p.status='ACTIVE'),0))=0));

-- 12. Advance equation mismatch or over-application/recovery.
SELECT v.id,v.voucher_number,v.payment_amount,
 coalesce(sum(a.amount) FILTER (WHERE a.status='ACTIVE'),0) AS applied,
 v.payment_amount-coalesce(sum(a.amount) FILTER (WHERE a.status='ACTIVE'),0) AS expected_outstanding
FROM labour_payment_vouchers v LEFT JOIN labour_advance_applications a ON a.advance_voucher_id=v.id CROSS JOIN (SELECT current_setting('muzare.audit_workspace_id')::uuid workspace_id,current_setting('muzare.audit_farm_id')::uuid farm_id,nullif(current_setting('muzare.audit_season_id'),'')::uuid season_id) s
WHERE v.workspace_id=s.workspace_id AND v.farm_id=s.farm_id AND (s.season_id IS NULL OR v.season_id=s.season_id) AND v.nature='ADVANCE'
GROUP BY v.id,v.voucher_number,v.payment_amount HAVING coalesce(sum(a.amount) FILTER (WHERE a.status='ACTIVE'),0)>v.payment_amount;

-- 13. Cross-workspace/farm/season mismatches across canonical source, journal, account and application dimensions.
SELECT e.id,e.entry_key,'journal-source-scope' AS mismatch
FROM labour_accounting_entries e LEFT JOIN labour_dues d ON d.id=e.due_id LEFT JOIN labour_payment_vouchers v ON v.id=e.voucher_id
CROSS JOIN (SELECT current_setting('muzare.audit_workspace_id')::uuid workspace_id,current_setting('muzare.audit_farm_id')::uuid farm_id,nullif(current_setting('muzare.audit_season_id'),'')::uuid season_id) s
WHERE e.workspace_id=s.workspace_id AND e.farm_id=s.farm_id AND (s.season_id IS NULL OR e.season_id=s.season_id)
 AND ((d.id IS NOT NULL AND (d.workspace_id,d.farm_id,d.season_id)<>(e.workspace_id,e.farm_id,e.season_id))
   OR (v.id IS NOT NULL AND (v.workspace_id,v.farm_id,v.season_id)<>(e.workspace_id,e.farm_id,e.season_id)))
UNION ALL
SELECT a.id,a.idempotency_key::text,'application-source-scope'
FROM labour_advance_applications a JOIN labour_dues d ON d.id=a.due_id JOIN labour_payment_vouchers v ON v.id=a.advance_voucher_id CROSS JOIN (SELECT current_setting('muzare.audit_workspace_id')::uuid workspace_id,current_setting('muzare.audit_farm_id')::uuid farm_id,nullif(current_setting('muzare.audit_season_id'),'')::uuid season_id) s
WHERE d.workspace_id=s.workspace_id AND d.farm_id=s.farm_id AND (s.season_id IS NULL OR d.season_id=s.season_id)
 AND (a.workspace_id<>d.workspace_id OR (v.workspace_id,v.farm_id,v.season_id)<>(d.workspace_id,d.farm_id,d.season_id));

ROLLBACK;
