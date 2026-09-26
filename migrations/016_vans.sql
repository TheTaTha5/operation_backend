-- Van assignment: the fleet, which programmes each van serves on a date, per-day driver and status,
-- and who rides which van. Shape from the frontend hand-off (operation_frontend
-- apps/web/docs/handoff/van-endpoints.md §2.2); semantics from legacy `sb_vehicles`, `vanjob_driver`
-- and the `ops_*` columns of `sb_bookings` / `sb_bookings__trips`.
--
-- Every time of day is ISO 8601 `HH:MM` (see `isIsoTime` in src/domain/calendar.ts), enforced by
-- CHECK. Legacy held free text such as `06.30` and `07:30-07:45`; the import normalises what it can
-- and drops the rest with a count.

-- The fleet the ops board assigns (legacy sb_vehicles). Never deleted: a retired van is inactive.
CREATE TABLE vans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plate TEXT,
  type TEXT,
  capacity INTEGER NOT NULL CHECK (capacity > 0),
  ownership TEXT NOT NULL DEFAULT 'own' CHECK (ownership IN ('own', 'partner')),
  partner_name TEXT,
  zone_base TEXT CHECK (zone_base IN ('PK', 'KL')),
  color TEXT,
  driver TEXT,
  driver_phone TEXT,
  active BOOLEAN NOT NULL DEFAULT true
);

-- The month matrix: which programmes a van serves on a date (legacy dayRoute). The only source of a
-- route's outbound van pool; there is deliberately no zone fallback.
CREATE TABLE van_day_routes (
  van_id TEXT NOT NULL REFERENCES vans (id),
  service_date DATE NOT NULL,
  route_id TEXT NOT NULL REFERENCES routes (id),
  PRIMARY KEY (van_id, service_date, route_id)
);
CREATE INDEX van_day_routes_day_idx ON van_day_routes (service_date, route_id);

-- A van out of service over a span (legacy statusRanges). `to_date` NULL is open-ended, which is why
-- this is a range and not a row per day. Where ranges overlap, the latest-created one wins, as in
-- legacy's `vehStatusOn`.
CREATE TABLE van_status_ranges (
  id BIGSERIAL PRIMARY KEY,
  van_id TEXT NOT NULL REFERENCES vans (id),
  status TEXT NOT NULL CHECK (status IN ('off', 'maintenance')),
  from_date DATE NOT NULL,
  to_date DATE CHECK (to_date IS NULL OR to_date >= from_date),
  note TEXT
);
CREATE INDEX van_status_ranges_van_idx ON van_status_ranges (van_id);

-- One van on one day: a status override and the driver for that day (legacy dayStatus and
-- vanjob_driver). `status` overrides any range; `available` is an override too — usable that day even
-- inside an off range. NULL = no override. Driver fields NULL fall back to the van's own.
CREATE TABLE van_days (
  van_id TEXT NOT NULL REFERENCES vans (id),
  service_date DATE NOT NULL,
  status TEXT CHECK (status IN ('available', 'off', 'maintenance')),
  driver TEXT,
  driver_phone TEXT,
  plate TEXT,
  -- Legacy VANJOB_SENT: when the job order went to the driver. Informational; it locks nothing.
  sent_at TIMESTAMPTZ,
  PRIMARY KEY (van_id, service_date)
);

-- One outbound van run: the passengers who ride one van together. Legacy had no such row — a group
-- was a number repeated on each member, with the van on each member too, so members could disagree.
-- Holding the van here makes a mixed-van group impossible.
CREATE TABLE van_groups (
  id TEXT PRIMARY KEY,
  service_date DATE NOT NULL,
  route_id TEXT NOT NULL REFERENCES routes (id),
  -- The effective pickup zone ('PK', 'KL', …) or '__CHARTER__'. Stored, not derived: it depends on
  -- add-ons (a private van on a NoTransfer seat), and a member from another zone is refused.
  zone TEXT NOT NULL,
  -- Display number, one sequence per (date, route) across every zone, as legacy numbers them.
  number INTEGER NOT NULL CHECK (number > 0),
  van_id TEXT REFERENCES vans (id),
  -- The members' default return van. NULL = they come back on the outbound van.
  return_van_id TEXT REFERENCES vans (id),
  pickup_time TEXT CHECK (pickup_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  UNIQUE (service_date, route_id, number)
);
CREATE INDEX van_groups_van_idx ON van_groups (van_id, service_date);

-- Migration 013 created this table with the van fields on it, one set per trip. Legacy splits a
-- booking's passengers across several vans, so those move to allocations below. What stays is what
-- is genuinely per trip. 013 is left as written so that a database that already applied it and a
-- fresh one end up the same; this reshapes it either way. No code has ever written to it.
ALTER TABLE booking_trip_operations
  DROP COLUMN van_id,
  DROP COLUMN van_return_id,
  DROP COLUMN van_group,
  DROP COLUMN van_sequence,
  DROP COLUMN alternate_split_auto,
  -- Check-in belongs to the check-in port, not here.
  DROP COLUMN van_checkin,
  ALTER COLUMN return_same_van SET DEFAULT false,
  ADD CONSTRAINT booking_trip_operations_pickup_time_final_check
    CHECK (pickup_time_final ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
UPDATE booking_trip_operations SET return_same_van = false WHERE return_same_van IS NULL;
ALTER TABLE booking_trip_operations ALTER COLUMN return_same_van SET NOT NULL;

-- Who rides which van. A trip with no rows is one whole, ungrouped part, so only trips someone has
-- touched have rows. idx 0 is the main part; more rows are splits, legacy's vanSplits. The counts use
-- legacy's categories without residency, because splits never carried one. Their sum never exceeds
-- the trip's pax; that cross-table rule is the API's, as pax cells can change under it.
CREATE TABLE booking_trip_van_allocations (
  booking_trip_id TEXT NOT NULL REFERENCES booking_trips (id) ON DELETE CASCADE,
  idx INTEGER NOT NULL CHECK (idx >= 0),
  ad INTEGER NOT NULL DEFAULT 0 CHECK (ad >= 0),
  chd INTEGER NOT NULL DEFAULT 0 CHECK (chd >= 0),
  inf INTEGER NOT NULL DEFAULT 0 CHECK (inf >= 0),
  foc INTEGER NOT NULL DEFAULT 0 CHECK (foc >= 0),
  van_group_id TEXT REFERENCES van_groups (id) ON DELETE SET NULL,
  -- Manual pickup order in the group (legacy vanSeq). NULL = by pickup time.
  sequence INTEGER CHECK (sequence > 0),
  -- Overrides the group's return van for this part.
  return_van_id TEXT REFERENCES vans (id),
  source TEXT NOT NULL DEFAULT 'main' CHECK (source IN ('main', 'manual', 'alt_pickup')),
  -- An alternate pickup or drop-off point. Only an alt_pickup part carries these.
  pick_area_id TEXT, pick_hotel TEXT, pick_zone TEXT,
  drop_area_id TEXT, drop_hotel TEXT, drop_zone TEXT,
  PRIMARY KEY (booking_trip_id, idx),
  CHECK (source = 'alt_pickup' OR num_nonnulls(pick_area_id, pick_hotel, pick_zone, drop_area_id, drop_hotel, drop_zone) = 0),
  CHECK ((idx = 0) = (source = 'main'))
);
CREATE INDEX booking_trip_van_allocations_group_idx ON booking_trip_van_allocations (van_group_id);
