-- Reconfirmation (slice B of todo/trip-ops-and-vans-model.md): did the customer confirm their pickup,
-- and was the agent's list sent. One per booking, as legacy writes it (ops.reconfirm on day 1; no
-- legacy trip carries one). 013's per-trip reconfirm_* columns are left unused. Legacy, 2026-10-09:
-- 2,744 records; status done 2,448, wa 47, off 5, noans 1, blank 1; via reconfirm, list, phone.

CREATE TABLE booking_reconfirmations (
  booking_id TEXT PRIMARY KEY REFERENCES bookings (id) ON DELETE CASCADE,
  -- What the customer said (legacy RC_STATES); NULL = not contacted yet.
  status TEXT CHECK (status IN ('wa', 'noans', 'off', 'callback', 'done')),
  -- Where it was recorded: the reconfirm page, or the ops board's list or phone.
  via TEXT CHECK (via IN ('reconfirm', 'phone', 'list')),
  at TIMESTAMPTZ,
  by TEXT,
  -- The agent's re-confirm list was sent; NULL = not sent.
  sent_at TIMESTAMPTZ,
  sent_by TEXT,
  -- A row with neither is no row: legacy drops the record then.
  CHECK (status IS NOT NULL OR sent_at IS NOT NULL)
);
