ALTER TABLE expense_categories
  ALTER COLUMN farm_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_system boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

UPDATE expense_categories
SET workspace_id = farms.workspace_id
FROM farms
WHERE expense_categories.farm_id = farms.id
  AND expense_categories.workspace_id IS NULL;

CREATE TABLE IF NOT EXISTS expense_subcategories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid NOT NULL REFERENCES expense_categories(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  is_system boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS expense_categories_system_name_uidx
  ON expense_categories (name) WHERE workspace_id IS NULL AND is_system = true;
CREATE UNIQUE INDEX IF NOT EXISTS expense_subcategories_system_name_uidx
  ON expense_subcategories (category_id, name) WHERE workspace_id IS NULL AND is_system = true;
CREATE UNIQUE INDEX IF NOT EXISTS expense_subcategories_workspace_name_uidx
  ON expense_subcategories (workspace_id, category_id, name) WHERE workspace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS expense_categories_workspace_sort_idx ON expense_categories (workspace_id, sort_order);
CREATE INDEX IF NOT EXISTS expense_subcategories_workspace_category_sort_idx ON expense_subcategories (workspace_id, category_id, sort_order);

INSERT INTO expense_categories (name, sort_order, is_system)
SELECT name, sort_order, true FROM (VALUES
  ('Labour Related', 10), ('Fuel & POL', 20), ('Fertilizers & Chemicals', 30), ('Irrigation & Water', 40),
  ('Machinery & Vehicles', 50), ('Kitchen & Camp', 60), ('Harvest & Packaging', 70),
  ('Maintenance & Repairs', 80), ('Administration', 90), ('Other', 100)
) AS seeded(name, sort_order)
WHERE NOT EXISTS (
  SELECT 1 FROM expense_categories category
  WHERE category.workspace_id IS NULL AND category.is_system = true AND category.name = seeded.name
);

INSERT INTO expense_subcategories (category_id, name, sort_order, is_system)
SELECT category.id, seeded.name, seeded.sort_order, true
FROM (VALUES
  ('Labour Related', 'Wages', 10), ('Labour Related', 'Bonus Payment', 20),
  ('Fuel & POL', 'Diesel', 10), ('Fuel & POL', 'Petrol', 20), ('Fuel & POL', 'Lubricants', 30),
  ('Fertilizers & Chemicals', 'Fertilizer', 10), ('Fertilizers & Chemicals', 'Pesticide', 20), ('Fertilizers & Chemicals', 'Other', 30),
  ('Irrigation & Water', 'Irrigation Material', 10), ('Irrigation & Water', 'Pump Maintenance', 20),
  ('Machinery & Vehicles', 'Spare Parts', 10), ('Machinery & Vehicles', 'Vehicle Repair', 20), ('Machinery & Vehicles', 'Equipment Rental', 30),
  ('Kitchen & Camp', 'Groceries', 10), ('Kitchen & Camp', 'Vegetables', 20), ('Kitchen & Camp', 'Meat', 30), ('Kitchen & Camp', 'Drinking Water', 40), ('Kitchen & Camp', 'Gas Cylinder', 50),
  ('Harvest & Packaging', 'Cartons', 10), ('Harvest & Packaging', 'Packaging Material', 20), ('Harvest & Packaging', 'Transport', 30),
  ('Maintenance & Repairs', 'Electrical', 10), ('Maintenance & Repairs', 'Plumbing', 20), ('Maintenance & Repairs', 'Building Repair', 30), ('Maintenance & Repairs', 'Farm Maintenance', 40),
  ('Administration', 'Mobile & Internet', 10), ('Administration', 'Government Fees', 20),
  ('Other', 'Miscellaneous', 10)
) AS seeded(category_name, name, sort_order)
JOIN expense_categories category ON category.workspace_id IS NULL AND category.is_system = true AND category.name = seeded.category_name
WHERE NOT EXISTS (
  SELECT 1 FROM expense_subcategories subcategory
  WHERE subcategory.category_id = category.id AND subcategory.workspace_id IS NULL
    AND subcategory.is_system = true AND subcategory.name = seeded.name
);

WITH fallback AS (
  SELECT category.id AS category_id, subcategory.id AS subcategory_id
  FROM expense_categories category
  JOIN expense_subcategories subcategory ON subcategory.category_id = category.id
  WHERE category.workspace_id IS NULL AND category.name = 'Other'
    AND subcategory.workspace_id IS NULL AND subcategory.name = 'Miscellaneous'
)
UPDATE operational_records record
SET payload = record.payload || jsonb_build_object(
  'categoryId', COALESCE((
    SELECT category.id FROM expense_categories category
    WHERE category.workspace_id IS NULL AND category.is_system = true
      AND lower(category.name) = lower(record.payload->>'category') LIMIT 1
  ), fallback.category_id),
  'category', COALESCE((
    SELECT category.name FROM expense_categories category
    WHERE category.workspace_id IS NULL AND category.is_system = true
      AND lower(category.name) = lower(record.payload->>'category') LIMIT 1
  ), 'Other'),
  'subcategoryId', fallback.subcategory_id,
  'subcategory', 'Miscellaneous'
)
FROM fallback
WHERE record.entity_type = 'voucher'
  AND (record.payload->>'categoryId' IS NULL OR record.payload->>'subcategoryId' IS NULL);
