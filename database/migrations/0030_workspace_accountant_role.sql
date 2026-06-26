DO $$
BEGIN
  ALTER TYPE workspace_role ADD VALUE IF NOT EXISTS 'accountant';
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
