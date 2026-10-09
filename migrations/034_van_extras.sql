-- Van fields legacy keeps that 016 left out, and van stops (todo/van-extras-model.md). Counts from
-- legacy production, 2026-10-09: 2 rented vans, 3 van notes, 1,967 log lines, 1 day zone, no zone
-- ranges (legacy drops them on save) and no van stops yet.

-- Legacy's form offers a third kind of van, rented (เช่า). A van's note.
ALTER TABLE vans DROP CONSTRAINT vans_ownership_check;
ALTER TABLE vans
  ADD CONSTRAINT vans_ownership_check CHECK (ownership IN ('own', 'rented', 'partner')),
  ADD COLUMN note TEXT;

-- The zone a van works from on one day, over its base (legacy dayZone).
ALTER TABLE van_days ADD COLUMN zone TEXT CHECK (zone IN ('PK', 'KL'));

-- A van working from a zone over a span (legacy zoneOverrides, "สลับโซน"). Either end may be open,
-- as legacy allows. Where spans overlap, the first added (lowest id) wins, as legacy's `find` does.
CREATE TABLE van_zone_ranges (
  id BIGSERIAL PRIMARY KEY,
  van_id TEXT NOT NULL REFERENCES vans (id) ON DELETE CASCADE,
  zone TEXT NOT NULL CHECK (zone IN ('PK', 'KL')),
  from_date DATE,
  to_date DATE CHECK (to_date IS NULL OR from_date IS NULL OR to_date >= from_date)
);
CREATE INDEX van_zone_ranges_van_idx ON van_zone_ranges (van_id);

-- What changed on a van, oldest first (legacy log), with legacy's wording. Written by the server
-- only. `by` is NULL on imported lines: legacy kept no name.
CREATE TABLE van_log (
  id BIGSERIAL PRIMARY KEY,
  van_id TEXT NOT NULL REFERENCES vans (id) ON DELETE CASCADE,
  at TIMESTAMPTZ NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('created', 'edit', 'status', 'zone', 'driver')),
  text TEXT NOT NULL,
  by TEXT
);
CREATE INDEX van_log_van_idx ON van_log (van_id, id);

-- A deleted van takes its own dated rows with it, as legacy's delete takes the whole van. The API
-- refuses to delete a van with matrix days, so these cascades only ever remove what it allowed.
ALTER TABLE van_status_ranges DROP CONSTRAINT van_status_ranges_van_id_fkey,
  ADD CONSTRAINT van_status_ranges_van_id_fkey FOREIGN KEY (van_id) REFERENCES vans (id) ON DELETE CASCADE;

-- Stops a van makes that aren't bookings (legacy van_stops, §vanStop): a guide riding to the pier
-- (staff, takes seats) or something to pick up (cargo, none). Never on a boat, so they touch no boat
-- seat or park register. A stop rides its group's van; a disbanded group leaves it on the day with none.
CREATE TABLE van_stops (
  id TEXT PRIMARY KEY,
  service_date DATE NOT NULL,
  route_id TEXT NOT NULL REFERENCES routes (id),
  group_id TEXT REFERENCES van_groups (id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('staff', 'cargo')),
  label TEXT NOT NULL,
  pax INTEGER NOT NULL CHECK (pax >= 0),
  time TEXT CHECK (time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  place TEXT NOT NULL,
  area_id TEXT,
  area TEXT,                                  -- the pickup area's name that day
  leg TEXT NOT NULL DEFAULT 'out' CHECK (leg IN ('out', 'ret', 'both')),
  phone TEXT,
  note TEXT,
  sequence INTEGER CHECK (sequence > 0),
  checked_at TIMESTAMPTZ,                     -- checked in (legacy ck); NULL = not yet
  checked_by TEXT,
  checked_seats INTEGER CHECK (checked_seats >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT,
  updated_at TIMESTAMPTZ,
  updated_by TEXT,
  CHECK ((kind = 'staff') = (pax > 0))
);
CREATE INDEX van_stops_day_idx ON van_stops (service_date, route_id);
CREATE INDEX van_stops_group_idx ON van_stops (group_id);
