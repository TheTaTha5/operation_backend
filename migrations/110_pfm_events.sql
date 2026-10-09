-- Proforma (todo/money-model.md slice 2, decided 2026-10-09): legacy's Daily PFM decisions. When a
-- proforma booking is still unpaid after its cutoff (18:00 the day before its first trip), staff extend
-- travel (with a free-text approver) or put it on hold; they also log payment reminders. Legacy kept
-- the last of these in `ops.pfm` and lost it on every save; here every one is kept. Hold blocks nothing.
-- Legacy, 2026-10-09: no `ops.pfm` saved; its history holds 69 reminders and 2 "travel EXTENDED by".

CREATE TABLE booking_pfm_events (
  id BIGSERIAL PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('approved', 'hold', 'reminded')),
  approver TEXT,                              -- approved only: who extended travel, as typed
  by TEXT,
  at TIMESTAMPTZ NOT NULL,
  CHECK ((kind = 'approved') = (approver IS NOT NULL))
);
CREATE INDEX booking_pfm_events_booking_idx ON booking_pfm_events (booking_id, at, id);
