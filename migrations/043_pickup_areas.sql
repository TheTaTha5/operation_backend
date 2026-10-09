-- Pickup areas and pickup times (todo/booking-extras-model.md §4, approved 2026-10-09). Legacy
-- SB_PICKUP_AREAS and SB_PICKUP_TIME_PROFILES, 2026-10-09: 54 areas, one profile, 390 time cells;
-- every area id a booking uses is in the catalogue. Imported as legacy has them (decision D3).

CREATE TABLE pickup_areas (
  id TEXT PRIMARY KEY,                       -- <zone>-<name slug>, never changed (legacy psuSaveArea)
  name TEXT NOT NULL,
  zone TEXT NOT NULL CHECK (zone IN ('PK', 'KL', 'RN', 'NoTransfer')),
  region TEXT,
  time_group TEXT NOT NULL,                  -- areas that share pickup times
  active BOOLEAN NOT NULL DEFAULT true       -- deleting makes an area inactive (decision D2)
);

-- A set of pickup times valid over a span. Where spans overlap, the narrowest wins, then the newest.
-- A fallback profile (no dates: legacy's older flat table, decision D4) answers when none covers a date.
CREATE TABLE pickup_time_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  from_date DATE,
  to_date DATE,
  notes TEXT,
  cloned_from TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((from_date IS NULL) = (to_date IS NULL)),
  CHECK (to_date IS NULL OR to_date >= from_date)
);

-- One cell: a route and an area (or, in the fallback, a time group), in migration 024's window.
CREATE TABLE pickup_times (
  profile_id TEXT NOT NULL REFERENCES pickup_time_profiles (id) ON DELETE CASCADE,
  route_id TEXT NOT NULL REFERENCES routes (id),
  target TEXT NOT NULL,                      -- an area id, or a time group
  pickup_time TEXT CHECK (pickup_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  pickup_time_end TEXT CHECK (pickup_time_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  pickup_at_pier BOOLEAN NOT NULL DEFAULT false,   -- "Before HH:MM at pier": pickup_time_end only
  PRIMARY KEY (profile_id, route_id, target),
  CHECK (CASE WHEN pickup_at_pier THEN pickup_time IS NULL AND pickup_time_end IS NOT NULL ELSE pickup_time IS NOT NULL END)
);

-- A booking's pickup and drop-off areas now point at the catalogue (0 orphans in legacy). NOT VALID:
-- a database that already holds imported bookings has no areas until the next import fills them,
-- so existing rows aren't checked now; every new or changed row is. Validate once the import has run.
ALTER TABLE bookings
  ADD CONSTRAINT bookings_pickup_area_fk FOREIGN KEY (pickup_area_id) REFERENCES pickup_areas (id) NOT VALID,
  ADD CONSTRAINT bookings_dropoff_area_fk FOREIGN KEY (dropoff_area_id) REFERENCES pickup_areas (id) NOT VALID;
