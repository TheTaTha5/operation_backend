-- The Daily Fleet Log (todo/fleet-maintenance-model.md, "Design — part B"): fuel, actual pax and
-- engine meters per boat and day, the fuel price, the day lock (enforced here, decision 8) and the
-- extras legacy kept as JSON strings in app_meta (water meters, issued items, extra items, outside
-- requests), with no 120-day deletion (decision 9). Legacy, 2026-10-09: 123 days, 120 fuel-price
-- days, 111 locked pier-days, fl_issue 61 boat-days, fl_water 49, fl_req 4, fl_extra 1.

CREATE TABLE fleet_daily_boats (
  date DATE NOT NULL,
  boat_id TEXT NOT NULL REFERENCES boats (id),
  fuel_litres NUMERIC(10,2) CHECK (fuel_litres > 0),
  pax_actual INTEGER CHECK (pax_actual >= 0),       -- NULL = the booked count
  updated_at TIMESTAMPTZ NOT NULL,
  updated_by TEXT,
  PRIMARY KEY (date, boat_id),
  CHECK (fuel_litres IS NOT NULL OR pax_actual IS NOT NULL)
);

-- Engine hour-meter readings (legacy trips.<type>.engines). The engine is part A's, kept as text.
CREATE TABLE fleet_daily_meters (
  date DATE NOT NULL,
  boat_id TEXT NOT NULL REFERENCES boats (id),
  trip_type TEXT NOT NULL,
  engine_id TEXT NOT NULL,
  reading NUMERIC(10,1) NOT NULL,
  PRIMARY KEY (date, boat_id, trip_type, engine_id)
);

-- ฿/L for a day, per pier or per boat (a boat's own price beats its pier's).
CREATE TABLE fleet_fuel_prices (
  date DATE NOT NULL,
  key TEXT NOT NULL,
  price NUMERIC(8,2) NOT NULL CHECK (price >= 0),
  PRIMARY KEY (date, key)
);

-- "Save day" locks a pier's day; "Edit" deletes the row.
CREATE TABLE fleet_daily_locks (
  date DATE NOT NULL,
  pier TEXT NOT NULL,
  locked_at TIMESTAMPTZ NOT NULL,
  locked_by TEXT,
  PRIMARY KEY (date, pier)
);

CREATE TABLE fleet_water_meters (
  date DATE NOT NULL,
  boat_id TEXT NOT NULL REFERENCES boats (id),
  open_reading NUMERIC(12,1),
  close_reading NUMERIC(12,1),
  by TEXT,
  at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (date, boat_id),
  CHECK (open_reading IS NOT NULL OR close_reading IS NOT NULL)
);

-- The issued-items catalogue (legacy fl_issue_items): an item is turned off, never deleted.
CREATE TABLE fleet_issue_items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  unit TEXT,
  pier TEXT,                                        -- NULL = every pier
  off BOOLEAN NOT NULL DEFAULT false,
  sort BIGSERIAL
);

CREATE TABLE fleet_issues (
  date DATE NOT NULL,
  boat_id TEXT NOT NULL REFERENCES boats (id),
  item_id TEXT NOT NULL REFERENCES fleet_issue_items (id),
  qty NUMERIC(10,2) NOT NULL,
  PRIMARY KEY (date, boat_id, item_id)
);

-- Odd items drawn for one boat on one day (legacy fl_extra).
CREATE TABLE fleet_daily_extras (
  id TEXT PRIMARY KEY,
  date DATE NOT NULL,
  boat_id TEXT NOT NULL REFERENCES boats (id),
  name TEXT NOT NULL,
  qty NUMERIC(10,2),
  unit TEXT,
  seq BIGSERIAL
);
CREATE INDEX fleet_daily_extras_day_idx ON fleet_daily_extras (date, boat_id);

-- Someone outside the fleet drawing fuel, water or items at a pier (legacy fl_req).
CREATE TABLE fleet_daily_requests (
  id TEXT PRIMARY KEY,
  date DATE NOT NULL,
  pier TEXT NOT NULL,
  name TEXT NOT NULL,
  pax NUMERIC(10,2),
  fuel NUMERIC(10,2),
  price NUMERIC(8,2),
  engine_hours NUMERIC(10,1),
  water_open NUMERIC(12,1),
  water_close NUMERIC(12,1),
  issues JSONB NOT NULL DEFAULT '{}',              -- {issue item id: qty}
  seq BIGSERIAL
);
CREATE INDEX fleet_daily_requests_day_idx ON fleet_daily_requests (date, pier);
