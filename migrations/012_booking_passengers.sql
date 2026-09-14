-- `passengers[]` is unbounded, so it is a table, not a struct — see the rule in
-- `todo/booking-model.md`. Additive: nothing reads it yet, and the blob keeps carrying passengers
-- too until the dual-write step for this table lands.

CREATE TABLE booking_passengers (
  booking_id TEXT NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 0),
  name TEXT NOT NULL,
  nationality TEXT,
  type TEXT,
  foc BOOLEAN,
  PRIMARY KEY (booking_id, seq)
);
