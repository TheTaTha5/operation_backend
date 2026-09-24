-- Two facts the seat pool needs and could not see.
--
-- A charter buys a whole boat, so the boat's sellable seats must leave the pool — which needs to
-- know WHICH boat. Until now a charter recorded only its passengers, so the pool subtracted nothing
-- and a day with one chartered boat still offered every seat on it.
--
-- A booking that sells an agent's locked seats draws them from the lock. Until now nothing linked
-- the two, so those seats were held twice: once by the booking and once by the untouched lock.

-- No foreign key to `boats`: the rule a charter must satisfy is "deployed on this route that day",
-- which is stronger than "exists in the catalogue", and both stores check it before writing.
-- `deployments.boat_id` is unenforced for the same reason, and the two should gain a key together.
ALTER TABLE booking_trips ADD COLUMN charter_boat_id TEXT;
ALTER TABLE booking_trips ADD CONSTRAINT booking_trips_charter_boat_check
  CHECK (charter_boat_id IS NULL OR booking_mode = 'charter');
COMMENT ON COLUMN booking_trips.charter_boat_id IS
  'The boat a charter takes whole. Its sellable seats leave the seat pool. NULL only on charters recorded before this column, where no single boat could be inferred.';

-- A charter on a day with exactly one boat deployed on its route can only have taken that boat.
-- Anything else is left NULL rather than guessed; `dayCapacity` then subtracts its passengers.
UPDATE booking_trips t
SET charter_boat_id = d.boat_id
FROM deployments d
WHERE t.booking_mode = 'charter'
  AND t.charter_boat_id IS NULL
  AND d.route_id = t.route_id AND d.service_date = t.service_date
  AND (SELECT count(*) FROM deployments d2 WHERE d2.route_id = t.route_id AND d2.service_date = t.service_date) = 1;

-- How a trip consumes an agent's held seats; see `booking_trip_lock_draws` in todo/booking-model.md.
-- A lock's held seats are `pax` less what holding bookings have drawn, derived on read rather than
-- kept as a second counter that cancellation paths could drive out of step — `allocated_pax` was
-- dropped in 007 for exactly that.
CREATE TABLE booking_trip_lock_draws (
  booking_trip_id TEXT NOT NULL REFERENCES booking_trips (id) ON DELETE CASCADE,
  seat_lock_id TEXT NOT NULL REFERENCES seat_locks (id),
  qty INTEGER NOT NULL CHECK (qty > 0),
  PRIMARY KEY (booking_trip_id, seat_lock_id)
);
CREATE INDEX booking_trip_lock_draws_lock_idx ON booking_trip_lock_draws (seat_lock_id);
