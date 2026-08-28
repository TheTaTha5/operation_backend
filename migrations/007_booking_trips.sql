-- A booking is a sale; a trip is a departure. Seats are consumed per departure, so the route, the
-- date and the passenger counts move off `bookings` and onto a row per trip. This is what lets one
-- booking span several days — the shape the frontend has always written and the API has always
-- rejected — and it makes the seat pool readable from one table.

CREATE TABLE booking_trips (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 0),
  route_id TEXT NOT NULL,
  service_date DATE NOT NULL,
  booking_mode TEXT NOT NULL DEFAULT 'seat' CHECK (booking_mode IN ('seat', 'charter')),
  UNIQUE (booking_id, seq)
);
CREATE INDEX booking_trips_allotment_idx ON booking_trips (route_id, service_date);
CREATE INDEX booking_trips_booking_idx ON booking_trips (booking_id);

-- The frontend's `ad`/`ad_fr`/`ad_th`/`chd`/… keys are an age category crossed with a pricing
-- residency. Twelve columns would repeat the wide-column mistake that `routes.overrides_YYYY_MM_DD`
-- was; as rows, a new tier is data rather than a migration. A cell with nobody in it is no row.
CREATE TABLE booking_trip_pax (
  booking_trip_id TEXT NOT NULL REFERENCES booking_trips (id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('ad', 'chd', 'inf', 'foc')),
  residency TEXT NOT NULL CHECK (residency IN ('unknown', 'foreign', 'thai')),
  count INTEGER NOT NULL CHECK (count > 0),
  PRIMARY KEY (booking_trip_id, category, residency)
);

-- Every existing booking is a one-trip booking.
INSERT INTO booking_trips (id, booking_id, seq, route_id, service_date, booking_mode)
SELECT 'trip_' || b.id, b.id, 0, b.route_id, b.service_date,
       CASE WHEN b.booking_mode = 'charter' THEN 'charter' ELSE 'seat' END
FROM bookings b;

-- `pax_breakdown` is only trustworthy where every key is a category we can store and the cells add
-- up to the booking's own total. Anything else would silently move the seat pool, so it falls back
-- to a single untiered count and keeps the number the pool has been using all along.
CREATE TEMP TABLE trusted_breakdown ON COMMIT DROP AS
SELECT b.id
FROM bookings b
WHERE b.pax_breakdown IS NOT NULL
  AND b.pax_breakdown <> '{}'::jsonb
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_each_text(b.pax_breakdown) AS e (k, v)
    WHERE k !~ '^(ad|chd|inf|foc)(_fr|_th)?$' OR v !~ '^[0-9]+$'
  )
  AND (SELECT COALESCE(SUM(v::int), 0) FROM jsonb_each_text(b.pax_breakdown) AS e (k, v)) = b.pax;

INSERT INTO booking_trip_pax (booking_trip_id, category, residency, count)
SELECT t.id,
       regexp_replace(e.k, '_(fr|th)$', ''),
       CASE WHEN e.k LIKE '%\_fr' THEN 'foreign' WHEN e.k LIKE '%\_th' THEN 'thai' ELSE 'unknown' END,
       e.v::int
FROM booking_trips t
JOIN bookings b ON b.id = t.booking_id
JOIN trusted_breakdown tb ON tb.id = b.id
CROSS JOIN LATERAL jsonb_each_text(b.pax_breakdown) AS e (k, v)
WHERE e.v::int > 0;

INSERT INTO booking_trip_pax (booking_trip_id, category, residency, count)
SELECT t.id, 'ad', 'unknown', b.pax
FROM booking_trips t
JOIN bookings b ON b.id = t.booking_id
WHERE b.pax > 0 AND NOT EXISTS (SELECT 1 FROM trusted_breakdown tb WHERE tb.id = b.id);

-- `allocated_pax` goes with them, and takes a class of bug with it: it was a second copy of the pax
-- count that cancellation paths could drive out of step (and negative, on charters). Seats held are
-- now derived from the trip rows and the booking's status, so there is nothing left to desynchronise.
ALTER TABLE bookings
  DROP COLUMN route_id,
  DROP COLUMN service_date,
  DROP COLUMN pax,
  DROP COLUMN allocated_pax,
  DROP COLUMN pax_breakdown;
