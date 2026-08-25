ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS external_id TEXT,
  ADD COLUMN IF NOT EXISTS agent_id TEXT,
  ADD COLUMN IF NOT EXISTS voucher_ref TEXT,
  ADD COLUMN IF NOT EXISTS rate_type_ref TEXT,
  ADD COLUMN IF NOT EXISTS booking_mode TEXT,
  ADD COLUMN IF NOT EXISTS pax_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS booking_data JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS bookings_external_id_unique
  ON bookings (external_id)
  WHERE external_id IS NOT NULL;
