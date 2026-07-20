-- One immutable original journal line may have at most one financial inverse.
-- Current balances use original + reversal effects; business voiding must never
-- select a row whose reversal_of is populated.
CREATE UNIQUE INDEX IF NOT EXISTS labour_accounting_entries_one_reversal_uidx
  ON labour_accounting_entries (reversal_of)
  WHERE reversal_of IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'labour_accounting_entries_reversal_of_fk'
  ) THEN
    ALTER TABLE labour_accounting_entries
      ADD CONSTRAINT labour_accounting_entries_reversal_of_fk
      FOREIGN KEY (reversal_of) REFERENCES labour_accounting_entries(id)
      ON DELETE RESTRICT;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'labour_accounting_entries_not_self_reversal_ck'
  ) THEN
    ALTER TABLE labour_accounting_entries
      ADD CONSTRAINT labour_accounting_entries_not_self_reversal_ck
      CHECK (reversal_of IS NULL OR reversal_of <> id);
  END IF;
END $$;
