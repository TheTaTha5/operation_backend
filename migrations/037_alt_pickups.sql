-- Alternate pickups (slice D of todo/trip-ops-and-vans-model.md): extra pickup or drop-off points
-- inside one booking (legacy altPickups, the sales form's "รับหลายจุด"). The server builds the
-- alternate-pickup van parts from these (Decision 4). Legacy, 2026-10-09: 4 bookings, 5 entries.

CREATE TABLE booking_alt_pickups (
  booking_id TEXT NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 0),
  who TEXT,
  ad INTEGER CHECK (ad >= 0), chd INTEGER CHECK (chd >= 0),
  inf INTEGER CHECK (inf >= 0), foc INTEGER CHECK (foc >= 0),
  area_id TEXT, area TEXT, zone TEXT, place TEXT,             -- area: the pickup area's name that day
  drop_same BOOLEAN,
  drop_area_id TEXT, drop_area TEXT, drop_zone TEXT, drop_place TEXT,
  PRIMARY KEY (booking_id, seq)
);

-- An alternate-pickup part's own pickup time and whose pickup it is (legacy vanSplits[].pickTime /
-- altWho). Only an alternate-pickup part carries them, as with the pick_* columns.
ALTER TABLE booking_trip_van_allocations
  ADD COLUMN pick_time TEXT CHECK (pick_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  ADD COLUMN alt_who TEXT,
  ADD CONSTRAINT booking_trip_van_allocations_alt_only CHECK (source = 'alt_pickup' OR num_nonnulls(pick_time, alt_who) = 0);
