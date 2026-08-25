ALTER TABLE deployments
  ADD COLUMN IF NOT EXISTS license_pax INTEGER CHECK (license_pax > 0),
  ADD COLUMN IF NOT EXISTS total_capacity INTEGER CHECK (total_capacity > 0);

UPDATE deployments SET total_capacity = capacity WHERE total_capacity IS NULL;
ALTER TABLE deployments ALTER COLUMN total_capacity SET NOT NULL;
