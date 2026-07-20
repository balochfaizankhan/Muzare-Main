CREATE TABLE IF NOT EXISTS labour_dues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  farm_id uuid NOT NULL REFERENCES farms(id),
  season_id uuid NOT NULL REFERENCES seasons(id),
  due_number text NOT NULL,
  origin text NOT NULL CHECK (origin IN ('SETTLEMENT', 'DIRECT')),
  settlement_basis text CHECK (settlement_basis IS NULL OR settlement_basis IN ('ATTENDANCE', 'LABOUR_WORK', 'MIXED', 'MANUAL')),
  source_record_id uuid REFERENCES operational_records(id),
  source_client_record_id text,
  recipient_scope text NOT NULL CHECK (recipient_scope IN ('INDIVIDUAL', 'LABOUR_GROUP', 'CONTRACTOR_FOREMAN', 'TEMPORARY_CREW', 'UNREGISTERED_LABOUR', 'NO_SPECIFIC_RECIPIENT')),
  financial_scope_key text NOT NULL,
  labourer_id text,
  labour_group_id text,
  contractor_reference text,
  crew_reference text,
  recipient_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  description text NOT NULL,
  work_from_date date NOT NULL,
  work_to_date date NOT NULL,
  gross_amount numeric(14,2) NOT NULL CHECK (gross_amount >= 0),
  adjustment_amount numeric(14,2) NOT NULL DEFAULT 0,
  authorized_deductions numeric(14,2) NOT NULL DEFAULT 0 CHECK (authorized_deductions >= 0),
  calculation_status text NOT NULL DEFAULT 'APPROVED' CHECK (calculation_status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'VOIDED')),
  payment_status text NOT NULL DEFAULT 'UNPAID' CHECK (payment_status IN ('UNPAID', 'PARTIALLY_SETTLED', 'PAID', 'SETTLED_BY_ADVANCE', 'ON_HOLD', 'VOIDED')),
  approved_at timestamptz,
  approved_by uuid REFERENCES users(id),
  hold_reason text,
  void_reason text,
  voided_at timestamptz,
  voided_by uuid REFERENCES users(id),
  legacy boolean NOT NULL DEFAULT false,
  reconciliation_status text NOT NULL DEFAULT 'RECONCILED' CHECK (reconciliation_status IN ('RECONCILED', 'LEGACY_UNLINKED', 'NEEDS_REVIEW')),
  idempotency_key uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT labour_dues_date_range_check CHECK (work_from_date <= work_to_date),
  CONSTRAINT labour_dues_workspace_farm_fk FOREIGN KEY (workspace_id, farm_id) REFERENCES farms(workspace_id, id),
  CONSTRAINT labour_dues_workspace_farm_season_fk FOREIGN KEY (workspace_id, farm_id, season_id) REFERENCES seasons(workspace_id, farm_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS labour_dues_workspace_farm_number_uidx ON labour_dues(workspace_id, farm_id, due_number);
CREATE UNIQUE INDEX IF NOT EXISTS labour_dues_source_record_uidx ON labour_dues(source_record_id) WHERE source_record_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS labour_dues_idempotency_uidx ON labour_dues(workspace_id, idempotency_key);
CREATE INDEX IF NOT EXISTS labour_dues_queue_idx ON labour_dues(workspace_id, farm_id, season_id, payment_status, work_to_date DESC);

CREATE TABLE IF NOT EXISTS labour_payment_vouchers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  farm_id uuid NOT NULL REFERENCES farms(id),
  season_id uuid NOT NULL REFERENCES seasons(id),
  voucher_number text NOT NULL,
  voucher_date date NOT NULL,
  nature text NOT NULL CHECK (nature IN ('ADVANCE', 'FINAL_PAYMENT', 'SETTLEMENT_BALANCE_PAYMENT', 'DIRECT_LABOUR_PAYMENT', 'REFUND_RECOVERY', 'REVERSAL')),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'POSTED', 'VOIDED')),
  recipient_scope text NOT NULL CHECK (recipient_scope IN ('INDIVIDUAL', 'LABOUR_GROUP', 'CONTRACTOR_FOREMAN', 'TEMPORARY_CREW', 'UNREGISTERED_LABOUR', 'NO_SPECIFIC_RECIPIENT')),
  financial_scope_key text NOT NULL,
  labourer_id text,
  labour_group_id text,
  recipient_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  description text NOT NULL,
  payment_amount numeric(14,2) NOT NULL CHECK (payment_amount > 0),
  payment_account_id uuid REFERENCES accounts(id),
  payment_method text,
  transaction_reference text,
  source_type text NOT NULL,
  source_id text,
  linked_due_id uuid REFERENCES labour_dues(id),
  legacy_source_record_id uuid REFERENCES operational_records(id),
  account_transaction_id uuid REFERENCES account_transactions(id),
  idempotency_key uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  posted_by uuid REFERENCES users(id),
  posted_at timestamptz,
  void_reason text,
  voided_by uuid REFERENCES users(id),
  voided_at timestamptz,
  reversal_reference uuid REFERENCES labour_payment_vouchers(id),
  related_advance_voucher_id uuid REFERENCES labour_payment_vouchers(id),
  legacy boolean NOT NULL DEFAULT false,
  reconciliation_status text NOT NULL DEFAULT 'RECONCILED' CHECK (reconciliation_status IN ('RECONCILED', 'LEGACY_UNLINKED', 'NEEDS_REVIEW')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT labour_payment_vouchers_workspace_farm_season_fk FOREIGN KEY (workspace_id, farm_id, season_id) REFERENCES seasons(workspace_id, farm_id, id),
  CONSTRAINT labour_payment_vouchers_posted_fields_check CHECK (status <> 'POSTED' OR (posted_at IS NOT NULL AND posted_by IS NOT NULL)),
  -- Historical cash records are retained even when their old free-form account
  -- value cannot be mapped safely. They remain visible as legacy reconciliation
  -- items and are never replayed into account_transactions by this migration.
  CONSTRAINT labour_payment_vouchers_cash_account_check CHECK (legacy OR nature = 'REVERSAL' OR status <> 'POSTED' OR payment_account_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS labour_payment_vouchers_workspace_farm_number_uidx ON labour_payment_vouchers(workspace_id, farm_id, voucher_number);
CREATE UNIQUE INDEX IF NOT EXISTS labour_payment_vouchers_idempotency_uidx ON labour_payment_vouchers(workspace_id, idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS labour_payment_vouchers_legacy_source_nature_uidx ON labour_payment_vouchers(legacy_source_record_id, nature) WHERE legacy_source_record_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS labour_payment_vouchers_register_idx ON labour_payment_vouchers(workspace_id, farm_id, season_id, status, voucher_date DESC);

CREATE TABLE IF NOT EXISTS labour_payment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  voucher_id uuid NOT NULL REFERENCES labour_payment_vouchers(id) ON DELETE CASCADE,
  due_id uuid NOT NULL REFERENCES labour_dues(id) ON DELETE CASCADE,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVERSED')),
  reversed_at timestamptz,
  reversed_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(voucher_id, due_id)
);

CREATE TABLE IF NOT EXISTS labour_advance_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  advance_voucher_id uuid NOT NULL REFERENCES labour_payment_vouchers(id) ON DELETE CASCADE,
  due_id uuid NOT NULL REFERENCES labour_dues(id) ON DELETE CASCADE,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  idempotency_key uuid NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVERSED')),
  reversed_at timestamptz,
  reversed_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS labour_payment_allocations_due_idx ON labour_payment_allocations(due_id, status);
CREATE INDEX IF NOT EXISTS labour_advance_applications_due_idx ON labour_advance_applications(due_id, status);
CREATE INDEX IF NOT EXISTS labour_advance_applications_voucher_idx ON labour_advance_applications(advance_voucher_id, status);

CREATE TABLE IF NOT EXISTS labour_accounting_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  farm_id uuid NOT NULL REFERENCES farms(id),
  season_id uuid NOT NULL REFERENCES seasons(id),
  entry_key text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('DUE_RECOGNITION', 'ADVANCE_PAYMENT', 'ADVANCE_APPLICATION', 'DUE_PAYMENT', 'ADVANCE_REFUND', 'REVERSAL')),
  ledger_code text NOT NULL CHECK (ledger_code IN ('LABOUR_EXPENSE', 'LABOUR_PAYABLE', 'LABOUR_ADVANCE', 'CASH_CONTROL', 'PARTNER_PAYABLE')),
  due_id uuid REFERENCES labour_dues(id),
  voucher_id uuid REFERENCES labour_payment_vouchers(id),
  advance_application_id uuid REFERENCES labour_advance_applications(id),
  debit numeric(14,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit numeric(14,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  status text NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'REVERSED')),
  reversal_of uuid REFERENCES labour_accounting_entries(id),
  posted_by uuid NOT NULL REFERENCES users(id),
  posted_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT labour_accounting_entries_one_side_check CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)),
  CONSTRAINT labour_accounting_entries_context_fk FOREIGN KEY (workspace_id, farm_id, season_id) REFERENCES seasons(workspace_id, farm_id, id),
  UNIQUE(workspace_id, entry_key)
);

CREATE INDEX IF NOT EXISTS labour_accounting_entries_due_idx ON labour_accounting_entries(due_id, status);
CREATE INDEX IF NOT EXISTS labour_accounting_entries_voucher_idx ON labour_accounting_entries(voucher_id, status);

-- Historical settlements become dues. This insert recognizes existing state only;
-- it does not create or replay any account movement.
INSERT INTO labour_dues (
  workspace_id, farm_id, season_id, due_number, origin, settlement_basis,
  source_record_id, source_client_record_id, recipient_scope, financial_scope_key,
  labourer_id, labour_group_id, recipient_snapshot, description, work_from_date,
  work_to_date, gross_amount, adjustment_amount, authorized_deductions,
  calculation_status, payment_status, approved_at, approved_by, legacy,
  reconciliation_status, idempotency_key, created_by, created_at, updated_at
)
SELECT
  record.workspace_id,
  record.farm_id,
  record.season_id,
  COALESCE(NULLIF(record.payload->>'settlementNumber', ''), 'LEGACY-' || record.client_record_id),
  'SETTLEMENT',
  CASE
    WHEN COALESCE((record.payload->>'attendanceWages')::numeric, 0) > 0 AND COALESCE((record.payload->>'labourWorkWages')::numeric, 0) > 0 THEN 'MIXED'
    WHEN COALESCE((record.payload->>'labourWorkWages')::numeric, 0) > 0 THEN 'LABOUR_WORK'
    ELSE 'ATTENDANCE'
  END,
  record.id,
  record.client_record_id,
  CASE WHEN record.payload->>'settlementMode' = 'group' THEN 'LABOUR_GROUP' ELSE 'INDIVIDUAL' END,
  CASE
    WHEN record.payload->>'settlementMode' = 'group' THEN 'group:' || COALESCE(NULLIF(record.payload->>'groupId', ''), NULLIF(record.payload->>'groupName', ''), record.client_record_id)
    ELSE 'individual:' || COALESCE(NULLIF(record.payload->>'labourerId', ''), record.payload#>>'{includedLabourIds,0}', record.client_record_id)
  END,
  CASE WHEN record.payload->>'settlementMode' <> 'group' THEN COALESCE(NULLIF(record.payload->>'labourerId', ''), record.payload#>>'{includedLabourIds,0}') END,
  NULLIF(record.payload->>'groupId', ''),
  jsonb_build_object(
    'groupName', record.payload->>'groupName',
    'foremanId', record.payload->>'foremanId',
    'includedLabourRows', COALESCE(record.payload->'includedLabourRows', '[]'::jsonb),
    'legacySettlementNumber', record.payload->>'settlementNumber'
  ),
  COALESCE(NULLIF(record.payload->>'notes', ''), 'Labour wage settlement ' || COALESCE(record.payload->>'settlementNumber', record.client_record_id)),
  COALESCE(NULLIF(record.payload->>'fromDate', '')::date, record.created_at::date),
  COALESCE(NULLIF(record.payload->>'toDate', '')::date, record.created_at::date),
  GREATEST(COALESCE(NULLIF(record.payload->>'expenseAmount', '')::numeric, NULLIF(record.payload->>'grossWages', '')::numeric, NULLIF(record.payload->>'totalEarned', '')::numeric, 0), 0),
  COALESCE(NULLIF(record.payload->>'manualAdjustment', '')::numeric, 0),
  0,
  CASE WHEN record.payload->>'status' IN ('voided', 'deleted') THEN 'VOIDED' ELSE 'APPROVED' END,
  CASE
    WHEN record.payload->>'status' IN ('voided', 'deleted') THEN 'VOIDED'
    WHEN GREATEST(COALESCE(NULLIF(record.payload->>'balanceAfterPayment', '')::numeric, NULLIF(record.payload->>'payableBalance', '')::numeric, 0), 0) <= 0.005
      AND COALESCE(NULLIF(record.payload->>'paidAmount', '')::numeric, 0) > 0 THEN 'PAID'
    WHEN GREATEST(COALESCE(NULLIF(record.payload->>'balanceAfterPayment', '')::numeric, NULLIF(record.payload->>'payableBalance', '')::numeric, 0), 0) <= 0.005 THEN 'SETTLED_BY_ADVANCE'
    WHEN COALESCE(NULLIF(record.payload->>'paidAmount', '')::numeric, 0) > 0 OR COALESCE(NULLIF(record.payload->>'settledAdvanceAmount', '')::numeric, 0) > 0 THEN 'PARTIALLY_SETTLED'
    ELSE 'UNPAID'
  END,
  COALESCE(NULLIF(record.payload->>'createdAt', '')::timestamptz, record.created_at),
  record.recorded_by,
  true,
  CASE WHEN record.payload->>'status' IN ('voided', 'deleted') THEN 'RECONCILED' ELSE 'RECONCILED' END,
  md5(record.workspace_id::text || ':legacy-settlement-due:' || record.id::text)::uuid,
  record.recorded_by,
  record.created_at,
  record.updated_at
FROM operational_records record
WHERE record.entity_type = 'labourWageSettlement'
  AND record.farm_id IS NOT NULL
  AND record.season_id IS NOT NULL
ON CONFLICT (source_record_id) DO NOTHING;

-- Historical advances are registered without replaying their already-visible cash effect.
WITH ranked_advances AS (
  SELECT record.*,
    row_number() OVER (PARTITION BY record.workspace_id, record.farm_id ORDER BY record.created_at, record.id) AS legacy_sequence
  FROM operational_records record
  WHERE record.entity_type = 'advance' AND record.farm_id IS NOT NULL AND record.season_id IS NOT NULL
)
INSERT INTO labour_payment_vouchers (
  workspace_id, farm_id, season_id, voucher_number, voucher_date, nature, status,
  recipient_scope, financial_scope_key, labourer_id, labour_group_id,
  recipient_snapshot, description, payment_amount, payment_account_id,
  payment_method, transaction_reference, source_type, source_id,
  legacy_source_record_id, idempotency_key, created_by, posted_by, posted_at,
  legacy, reconciliation_status, created_at, updated_at
)
SELECT
  record.workspace_id,
  record.farm_id,
  record.season_id,
  'LPV-LA-' || substr(record.id::text, 1, 8),
  COALESCE(NULLIF(record.payload->>'date', '')::date, NULLIF(record.payload->>'advanceDate', '')::date, record.created_at::date),
  'ADVANCE',
  CASE WHEN NULLIF(record.payload->>'deletedAt', '') IS NOT NULL OR record.payload->>'status' IN ('voided', 'deleted', 'reversed') THEN 'VOIDED' ELSE 'POSTED' END,
  CASE WHEN NULLIF(record.payload->>'labourGroupId', '') IS NOT NULL THEN 'LABOUR_GROUP' ELSE 'INDIVIDUAL' END,
  CASE WHEN NULLIF(record.payload->>'labourGroupId', '') IS NOT NULL THEN 'group:' || (record.payload->>'labourGroupId') ELSE 'individual:' || COALESCE(NULLIF(record.payload->>'labourerId', ''), record.client_record_id) END,
  NULLIF(record.payload->>'labourerId', ''),
  NULLIF(record.payload->>'labourGroupId', ''),
  jsonb_build_object('labourGroupName', record.payload->>'labourGroupName', 'sourceAccountName', record.payload->>'sourceAccountName'),
  COALESCE(NULLIF(record.payload->>'notes', ''), 'Legacy labour advance'),
  GREATEST(COALESCE(NULLIF(record.payload->>'amount', '')::numeric, 0.01), 0.01),
  CASE WHEN NULLIF(record.payload->>'accountId', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND EXISTS (SELECT 1 FROM accounts candidate WHERE candidate.id = (record.payload->>'accountId')::uuid AND candidate.farm_id = record.farm_id)
    THEN (record.payload->>'accountId')::uuid ELSE NULL END,
  NULLIF(record.payload->>'paymentMethod', ''),
  record.client_record_id,
  'LEGACY_ADVANCE',
  record.client_record_id,
  record.id,
  md5(record.workspace_id::text || ':legacy-advance:' || record.id::text)::uuid,
  record.recorded_by,
  record.recorded_by,
  record.created_at,
  true,
  CASE WHEN NULLIF(record.payload->>'accountId', '') IS NULL THEN 'NEEDS_REVIEW' ELSE 'RECONCILED' END,
  record.created_at,
  record.updated_at
FROM ranked_advances record
ON CONFLICT (legacy_source_record_id, nature) WHERE legacy_source_record_id IS NOT NULL DO NOTHING;

-- Old standalone labourPayment rows had no due/allocation contract. Preserve
-- them in the register without guessing a settlement link or replaying cash.
INSERT INTO labour_payment_vouchers (
  workspace_id, farm_id, season_id, voucher_number, voucher_date, nature, status,
  recipient_scope, financial_scope_key, labourer_id, recipient_snapshot,
  description, payment_amount, payment_account_id, payment_method,
  transaction_reference, source_type, source_id, legacy_source_record_id,
  idempotency_key, created_by, posted_by, posted_at, legacy,
  reconciliation_status, created_at, updated_at
)
SELECT record.workspace_id, record.farm_id, record.season_id,
  'LPV-LLP-' || substr(record.id::text, 1, 8),
  CASE WHEN NULLIF(record.payload->>'date', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN (record.payload->>'date')::date ELSE record.created_at::date END,
  'FINAL_PAYMENT',
  CASE WHEN NULLIF(record.payload->>'deletedAt', '') IS NOT NULL OR record.payload->>'status' IN ('voided', 'deleted', 'reversed') THEN 'VOIDED' ELSE 'POSTED' END,
  CASE WHEN NULLIF(record.payload->>'labourerId', '') IS NOT NULL THEN 'INDIVIDUAL' ELSE 'NO_SPECIFIC_RECIPIENT' END,
  CASE WHEN NULLIF(record.payload->>'labourerId', '') IS NOT NULL THEN 'individual:' || (record.payload->>'labourerId') ELSE 'batch:legacy-labour-payment:' || record.client_record_id END,
  NULLIF(record.payload->>'labourerId', ''),
  jsonb_build_object('manualRecipientName', record.payload->>'recipientName', 'legacyOperationalRecord', true),
  COALESCE(NULLIF(record.payload->>'notes', ''), 'Legacy standalone labour payment'),
  (record.payload->>'amount')::numeric,
  CASE WHEN NULLIF(record.payload->>'accountId', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND EXISTS (SELECT 1 FROM accounts candidate WHERE candidate.id = (record.payload->>'accountId')::uuid AND candidate.farm_id = record.farm_id)
    THEN (record.payload->>'accountId')::uuid ELSE NULL END,
  NULLIF(record.payload->>'method', ''), record.client_record_id,
  'LEGACY_STANDALONE_PAYMENT', record.client_record_id, record.id,
  md5(record.workspace_id::text || ':legacy-labour-payment:' || record.id::text)::uuid,
  record.recorded_by, record.recorded_by, record.created_at, true,
  CASE WHEN NULLIF(record.payload->>'accountId', '') IS NULL OR NULLIF(record.payload->>'labourerId', '') IS NULL THEN 'NEEDS_REVIEW' ELSE 'LEGACY_UNLINKED' END,
  record.created_at, record.updated_at
FROM operational_records record
WHERE record.entity_type = 'labourPayment' AND record.farm_id IS NOT NULL AND record.season_id IS NOT NULL
  AND NULLIF(record.payload->>'amount', '') ~ '^[0-9]+([.][0-9]+)?$' AND (record.payload->>'amount')::numeric > 0
ON CONFLICT (legacy_source_record_id, nature) WHERE legacy_source_record_id IS NOT NULL DO NOTHING;

-- Existing normalized settlement/advance links become advance applications.
INSERT INTO labour_advance_applications (workspace_id, advance_voucher_id, due_id, amount, idempotency_key, status, created_at, updated_at)
SELECT allocation.workspace_id, voucher.id, due.id, allocation.absorbed_amount,
  md5(allocation.workspace_id::text || ':legacy-advance-application:' || allocation.id::text)::uuid,
  CASE WHEN due.payment_status = 'VOIDED' OR voucher.status = 'VOIDED' THEN 'REVERSED' ELSE 'ACTIVE' END,
  allocation.created_at, allocation.updated_at
FROM labour_wage_settlement_advance_allocations allocation
JOIN labour_dues due ON due.source_record_id = allocation.settlement_record_id
JOIN labour_payment_vouchers voucher ON voucher.legacy_source_record_id = allocation.advance_record_id AND voucher.nature = 'ADVANCE'
WHERE allocation.absorbed_amount > 0
ON CONFLICT (workspace_id, idempotency_key) DO NOTHING;

-- Existing settlement cash becomes a legacy voucher linked to the existing account
-- transaction. No account transaction is inserted by this migration.
WITH paid_settlements AS (
  SELECT record.*, due.id AS due_id,
    GREATEST(COALESCE(NULLIF(record.payload->>'paidAmount', '')::numeric, 0), 0) AS paid_amount
  FROM operational_records record
  JOIN labour_dues due ON due.source_record_id = record.id
  WHERE record.entity_type = 'labourWageSettlement'
)
INSERT INTO labour_payment_vouchers (
  workspace_id, farm_id, season_id, voucher_number, voucher_date, nature, status,
  recipient_scope, financial_scope_key, labourer_id, labour_group_id,
  recipient_snapshot, description, payment_amount, payment_account_id,
  payment_method, transaction_reference, source_type, source_id, linked_due_id,
  legacy_source_record_id, account_transaction_id, idempotency_key, created_by,
  posted_by, posted_at, legacy, reconciliation_status, created_at, updated_at
)
SELECT
  record.workspace_id, record.farm_id, record.season_id,
  'LPV-LS-' || substr(record.id::text, 1, 8),
  COALESCE(NULLIF(record.payload->>'settlementDate', '')::date, record.created_at::date),
  'SETTLEMENT_BALANCE_PAYMENT',
  CASE WHEN record.payload->>'status' IN ('voided', 'deleted') THEN 'VOIDED' ELSE 'POSTED' END,
  due.recipient_scope, due.financial_scope_key, due.labourer_id, due.labour_group_id,
  due.recipient_snapshot,
  'Legacy payment for ' || due.due_number,
  record.paid_amount,
  CASE WHEN COALESCE(NULLIF(record.payload->>'paymentAccountId', ''), NULLIF(record.payload->>'linkedAccountId', '')) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND EXISTS (SELECT 1 FROM accounts candidate WHERE candidate.id = COALESCE(NULLIF(record.payload->>'paymentAccountId', ''), NULLIF(record.payload->>'linkedAccountId', ''))::uuid AND candidate.farm_id = record.farm_id)
    THEN COALESCE(NULLIF(record.payload->>'paymentAccountId', ''), NULLIF(record.payload->>'linkedAccountId', ''))::uuid ELSE NULL END,
  NULL, record.client_record_id, 'LEGACY_SETTLEMENT_PAYMENT', record.client_record_id,
  due.id, record.id, transaction.id,
  md5(record.workspace_id::text || ':legacy-settlement-payment:' || record.id::text)::uuid,
  record.recorded_by, record.recorded_by, record.created_at, true,
  CASE WHEN transaction.id IS NULL THEN 'NEEDS_REVIEW' ELSE 'RECONCILED' END,
  record.created_at, record.updated_at
FROM paid_settlements record
JOIN labour_dues due ON due.id = record.due_id
LEFT JOIN account_transactions transaction
  ON transaction.reference_id::text = record.client_record_id
  AND transaction.source = 'settlement'
  AND transaction.source_type = 'labour_wage_settlement'
WHERE record.paid_amount > 0
ON CONFLICT (legacy_source_record_id, nature) WHERE legacy_source_record_id IS NOT NULL DO NOTHING;

INSERT INTO labour_payment_allocations (workspace_id, voucher_id, due_id, amount, status, created_at, updated_at)
SELECT voucher.workspace_id, voucher.id, voucher.linked_due_id, voucher.payment_amount,
  CASE WHEN voucher.status = 'VOIDED' THEN 'REVERSED' ELSE 'ACTIVE' END,
  voucher.created_at, voucher.updated_at
FROM labour_payment_vouchers voucher
WHERE voucher.nature = 'SETTLEMENT_BALANCE_PAYMENT' AND voucher.legacy = true AND voucher.linked_due_id IS NOT NULL
ON CONFLICT (voucher_id, due_id) DO NOTHING;

-- Seed the labour subledger from canonical historical mappings. These entries
-- recognize existing economic events only; they do not touch cash ledgers.
INSERT INTO labour_accounting_entries (workspace_id, farm_id, season_id, entry_key, event_type, ledger_code, due_id, debit, credit, posted_by, posted_at)
SELECT due.workspace_id, due.farm_id, due.season_id, 'due:' || due.id || ':expense', 'DUE_RECOGNITION', 'LABOUR_EXPENSE', due.id,
  GREATEST(due.gross_amount + due.adjustment_amount - due.authorized_deductions, 0), 0, due.created_by, COALESCE(due.approved_at, due.created_at)
FROM labour_dues due WHERE due.calculation_status = 'APPROVED' AND GREATEST(due.gross_amount + due.adjustment_amount - due.authorized_deductions, 0) > 0
ON CONFLICT (workspace_id, entry_key) DO NOTHING;

INSERT INTO labour_accounting_entries (workspace_id, farm_id, season_id, entry_key, event_type, ledger_code, due_id, debit, credit, posted_by, posted_at)
SELECT due.workspace_id, due.farm_id, due.season_id, 'due:' || due.id || ':payable', 'DUE_RECOGNITION', 'LABOUR_PAYABLE', due.id,
  0, GREATEST(due.gross_amount + due.adjustment_amount - due.authorized_deductions, 0), due.created_by, COALESCE(due.approved_at, due.created_at)
FROM labour_dues due WHERE due.calculation_status = 'APPROVED' AND GREATEST(due.gross_amount + due.adjustment_amount - due.authorized_deductions, 0) > 0
ON CONFLICT (workspace_id, entry_key) DO NOTHING;

INSERT INTO labour_accounting_entries (workspace_id, farm_id, season_id, entry_key, event_type, ledger_code, voucher_id, debit, credit, posted_by, posted_at)
SELECT voucher.workspace_id, voucher.farm_id, voucher.season_id, 'voucher:' || voucher.id || ':debit',
  CASE WHEN voucher.nature = 'ADVANCE' THEN 'ADVANCE_PAYMENT' WHEN voucher.nature = 'REFUND_RECOVERY' THEN 'ADVANCE_REFUND' ELSE 'DUE_PAYMENT' END,
  CASE WHEN voucher.nature = 'ADVANCE' THEN 'LABOUR_ADVANCE' WHEN voucher.nature = 'REFUND_RECOVERY' THEN CASE WHEN account.account_type = 'partner' THEN 'PARTNER_PAYABLE' ELSE 'CASH_CONTROL' END ELSE 'LABOUR_PAYABLE' END,
  voucher.id, voucher.payment_amount, 0, voucher.posted_by, voucher.posted_at
FROM labour_payment_vouchers voucher LEFT JOIN accounts account ON account.id = voucher.payment_account_id
WHERE voucher.status = 'POSTED' AND voucher.nature <> 'REVERSAL' AND voucher.reconciliation_status = 'RECONCILED' AND voucher.payment_account_id IS NOT NULL AND voucher.posted_by IS NOT NULL AND voucher.posted_at IS NOT NULL
ON CONFLICT (workspace_id, entry_key) DO NOTHING;

INSERT INTO labour_accounting_entries (workspace_id, farm_id, season_id, entry_key, event_type, ledger_code, voucher_id, debit, credit, posted_by, posted_at)
SELECT voucher.workspace_id, voucher.farm_id, voucher.season_id, 'voucher:' || voucher.id || ':credit',
  CASE WHEN voucher.nature = 'ADVANCE' THEN 'ADVANCE_PAYMENT' WHEN voucher.nature = 'REFUND_RECOVERY' THEN 'ADVANCE_REFUND' ELSE 'DUE_PAYMENT' END,
  CASE WHEN voucher.nature = 'REFUND_RECOVERY' THEN 'LABOUR_ADVANCE' WHEN account.account_type = 'partner' THEN 'PARTNER_PAYABLE' ELSE 'CASH_CONTROL' END,
  voucher.id, 0, voucher.payment_amount, voucher.posted_by, voucher.posted_at
FROM labour_payment_vouchers voucher LEFT JOIN accounts account ON account.id = voucher.payment_account_id
WHERE voucher.status = 'POSTED' AND voucher.nature <> 'REVERSAL' AND voucher.reconciliation_status = 'RECONCILED' AND voucher.payment_account_id IS NOT NULL AND voucher.posted_by IS NOT NULL AND voucher.posted_at IS NOT NULL
ON CONFLICT (workspace_id, entry_key) DO NOTHING;

INSERT INTO labour_accounting_entries (workspace_id, farm_id, season_id, entry_key, event_type, ledger_code, due_id, advance_application_id, debit, credit, posted_by, posted_at)
SELECT application.workspace_id, due.farm_id, due.season_id, 'advance-application:' || application.id || ':payable', 'ADVANCE_APPLICATION', 'LABOUR_PAYABLE', application.due_id, application.id,
  application.amount, 0, due.created_by, application.created_at
FROM labour_advance_applications application JOIN labour_dues due ON due.id = application.due_id WHERE application.status = 'ACTIVE'
ON CONFLICT (workspace_id, entry_key) DO NOTHING;

CREATE OR REPLACE FUNCTION validate_labour_payment_allocation() RETURNS trigger AS $$
DECLARE
  target_due labour_dues%ROWTYPE;
  target_voucher labour_payment_vouchers%ROWTYPE;
  other_payments numeric;
  applied_advances numeric;
  payable numeric;
BEGIN
  IF NEW.status <> 'ACTIVE' THEN RETURN NEW; END IF;
  SELECT * INTO target_due FROM labour_dues WHERE id = NEW.due_id FOR UPDATE;
  SELECT * INTO target_voucher FROM labour_payment_vouchers WHERE id = NEW.voucher_id FOR UPDATE;
  IF target_due.id IS NULL OR target_voucher.id IS NULL OR target_due.workspace_id <> NEW.workspace_id OR target_voucher.workspace_id <> NEW.workspace_id THEN
    RAISE EXCEPTION 'Payment allocation context is invalid.';
  END IF;
  IF target_voucher.status <> 'POSTED' OR target_voucher.nature IN ('ADVANCE', 'REFUND_RECOVERY') OR target_voucher.linked_due_id IS DISTINCT FROM target_due.id THEN
    RAISE EXCEPTION 'Only a posted final payment voucher linked to this due may be allocated.';
  END IF;
  SELECT COALESCE(sum(amount), 0) INTO other_payments FROM labour_payment_allocations WHERE voucher_id = NEW.voucher_id AND status = 'ACTIVE' AND id <> NEW.id;
  IF other_payments + NEW.amount > target_voucher.payment_amount + 0.005 THEN RAISE EXCEPTION 'Payment allocations exceed voucher amount.'; END IF;
  SELECT COALESCE(sum(amount), 0) INTO other_payments FROM labour_payment_allocations WHERE due_id = NEW.due_id AND status = 'ACTIVE' AND id <> NEW.id;
  SELECT COALESCE(sum(amount), 0) INTO applied_advances FROM labour_advance_applications WHERE due_id = NEW.due_id AND status = 'ACTIVE';
  payable := GREATEST(target_due.gross_amount + target_due.adjustment_amount - target_due.authorized_deductions, 0);
  IF other_payments + applied_advances + NEW.amount > payable + 0.005 THEN RAISE EXCEPTION 'Payment allocation exceeds due balance.'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS labour_payment_allocation_guard ON labour_payment_allocations;
CREATE TRIGGER labour_payment_allocation_guard BEFORE INSERT OR UPDATE OF amount, status, voucher_id, due_id ON labour_payment_allocations FOR EACH ROW EXECUTE FUNCTION validate_labour_payment_allocation();

CREATE OR REPLACE FUNCTION validate_labour_advance_application() RETURNS trigger AS $$
DECLARE
  target_due labour_dues%ROWTYPE;
  target_advance labour_payment_vouchers%ROWTYPE;
  other_applications numeric;
  refunds numeric;
  due_payments numeric;
  due_advances numeric;
  payable numeric;
BEGIN
  IF NEW.status <> 'ACTIVE' THEN RETURN NEW; END IF;
  SELECT * INTO target_due FROM labour_dues WHERE id = NEW.due_id FOR UPDATE;
  SELECT * INTO target_advance FROM labour_payment_vouchers WHERE id = NEW.advance_voucher_id FOR UPDATE;
  IF target_due.id IS NULL OR target_advance.id IS NULL OR target_due.workspace_id <> NEW.workspace_id OR target_advance.workspace_id <> NEW.workspace_id THEN
    RAISE EXCEPTION 'Advance application context is invalid.';
  END IF;
  IF target_advance.nature <> 'ADVANCE' OR target_advance.status <> 'POSTED' OR target_advance.financial_scope_key <> target_due.financial_scope_key THEN
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

DROP TRIGGER IF EXISTS labour_advance_application_guard ON labour_advance_applications;
CREATE TRIGGER labour_advance_application_guard BEFORE INSERT OR UPDATE OF amount, status, advance_voucher_id, due_id ON labour_advance_applications FOR EACH ROW EXECUTE FUNCTION validate_labour_advance_application();

CREATE OR REPLACE FUNCTION validate_labour_advance_refund() RETURNS trigger AS $$
DECLARE
  target_advance labour_payment_vouchers%ROWTYPE;
  applications numeric;
  other_refunds numeric;
BEGIN
  IF NEW.nature <> 'REFUND_RECOVERY' OR NEW.status <> 'POSTED' THEN RETURN NEW; END IF;
  SELECT * INTO target_advance FROM labour_payment_vouchers WHERE id = NEW.related_advance_voucher_id FOR UPDATE;
  IF target_advance.id IS NULL OR target_advance.nature <> 'ADVANCE' OR target_advance.status <> 'POSTED' OR target_advance.workspace_id <> NEW.workspace_id OR target_advance.financial_scope_key <> NEW.financial_scope_key THEN
    RAISE EXCEPTION 'Refund must reference a posted advance in the same financial scope.';
  END IF;
  SELECT COALESCE(sum(amount), 0) INTO applications FROM labour_advance_applications WHERE advance_voucher_id = target_advance.id AND status = 'ACTIVE';
  SELECT COALESCE(sum(payment_amount), 0) INTO other_refunds FROM labour_payment_vouchers WHERE related_advance_voucher_id = target_advance.id AND nature = 'REFUND_RECOVERY' AND status = 'POSTED' AND id <> NEW.id;
  IF applications + other_refunds + NEW.payment_amount > target_advance.payment_amount + 0.005 THEN RAISE EXCEPTION 'Refund exceeds outstanding advance.'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS labour_advance_refund_guard ON labour_payment_vouchers;
CREATE TRIGGER labour_advance_refund_guard BEFORE INSERT OR UPDATE OF payment_amount, status, related_advance_voucher_id ON labour_payment_vouchers FOR EACH ROW EXECUTE FUNCTION validate_labour_advance_refund();

INSERT INTO labour_accounting_entries (workspace_id, farm_id, season_id, entry_key, event_type, ledger_code, due_id, advance_application_id, debit, credit, posted_by, posted_at)
SELECT application.workspace_id, due.farm_id, due.season_id, 'advance-application:' || application.id || ':advance', 'ADVANCE_APPLICATION', 'LABOUR_ADVANCE', application.due_id, application.id,
  0, application.amount, due.created_by, application.created_at
FROM labour_advance_applications application JOIN labour_dues due ON due.id = application.due_id WHERE application.status = 'ACTIVE'
ON CONFLICT (workspace_id, entry_key) DO NOTHING;
