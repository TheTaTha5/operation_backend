-- A version on bookings and seat locks, so a save made from a stale copy is refused instead of
-- silently overwriting someone else's edit (todo/booking-concurrency-model.md). 1 on create, +1 on
-- every write; a client sends back the version it read (`If-Match`). Existing rows start at 1.

ALTER TABLE bookings ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1);
ALTER TABLE seat_locks ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1);
