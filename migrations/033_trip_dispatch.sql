-- Dispatch for one departure, slice A1 of todo/trip-ops-and-vans-model.md: the boat a trip goes on
-- (or the boats it is split across), and the pier note. 013/016 have the boat column and the final
-- pickup time already; nothing wrote or read them until now.

-- The pier note (legacy ops.pierNote {t, at, by}). It survives a trip being moved to another day, as
-- legacy's bkOpsClear keeps it.
ALTER TABLE booking_trip_operations
  ADD COLUMN pier_note TEXT,
  ADD COLUMN pier_note_at TIMESTAMPTZ,
  ADD COLUMN pier_note_by TEXT;

-- A trip split across boats (legacy ops.boatSplits), only with two boats or more. A whole trip on one
-- boat is booking_trip_operations.boat_id, left NULL while it is split. The parts' pax add up to the
-- trip's; an amendment that changes the pax clears the split (decided 2026-10-06).
CREATE TABLE booking_trip_boat_splits (
  booking_trip_id TEXT NOT NULL REFERENCES booking_trips (id) ON DELETE CASCADE,
  idx             INTEGER NOT NULL CHECK (idx >= 0),
  -- No foreign key, as booking_trip_operations.boat_id has none: the rule is that the boat is deployed
  -- on the trip's route that day, which the API checks.
  boat_id         TEXT NOT NULL,
  ad              INTEGER NOT NULL CHECK (ad >= 0),
  chd             INTEGER NOT NULL CHECK (chd >= 0),
  inf             INTEGER NOT NULL CHECK (inf >= 0),
  foc             INTEGER NOT NULL CHECK (foc >= 0),
  PRIMARY KEY (booking_trip_id, idx),
  UNIQUE (booking_trip_id, boat_id)
);
