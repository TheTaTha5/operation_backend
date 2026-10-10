-- Ops' acknowledgement that a charter took a boat with seats already sold on the day (todo/booking-model.md,
-- decided 2026-10-10): legacy's displacement dialog (`bkV2SetTripCharterBoat`, `bkV2ConfirmCharter`)
-- stored `charterDisplacementAck: true` on the trip; here who and when. Set by the server when a create
-- or edit sends `displace_anyway: true` and the charter displaces seats; kept while the trip keeps that
-- boat on that day.
--
-- Legacy, 2026-10-10: 19 of 5,428 trips carry the flag. The import writes the booking's last change as
-- the time (it kept none) and no name.

ALTER TABLE booking_trips
  ADD COLUMN charter_displaced_at TIMESTAMPTZ,
  ADD COLUMN charter_displaced_by TEXT,
  ADD CONSTRAINT booking_trips_displaced_charter CHECK (charter_displaced_at IS NULL OR booking_mode = 'charter'),
  ADD CONSTRAINT booking_trips_displaced_by_when CHECK (charter_displaced_by IS NULL OR charter_displaced_at IS NOT NULL);
