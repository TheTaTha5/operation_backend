-- Routes and boats as first-class entities.
--
-- Until now route_id and boat_id were bare strings with nothing behind them, so this service could
-- not answer the one question the booking frontend asks constantly: does this route run on this day?
-- That answer needs three sources and a precedence order, which is why it is four tables and not a
-- column. See docs in 006 and the resolution order in the application layer.

CREATE TABLE IF NOT EXISTS routes (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  pier      TEXT,
  /** Programme grouping the booking calendar renders chips by. The legacy frontend derives this by
      substring-matching the route name, so renaming a route silently drops it out of its group. */
  family_id TEXT,
  color     TEXT,
  islands   TEXT,
  sort      BIGINT
);

-- Departure times. One per route today, modelled as many because the legacy table is a list.
CREATE TABLE IF NOT EXISTS route_times (
  route_id   TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,
  departs_at TEXT NOT NULL,
  PRIMARY KEY (route_id, idx)
);

-- Open/closed windows: the normal operating rule, e.g. Similan closes for the monsoon.
CREATE TABLE IF NOT EXISTS route_seasons (
  id        TEXT PRIMARY KEY,
  route_id  TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  kind      TEXT NOT NULL CHECK (kind IN ('open', 'closed')),
  from_date DATE NOT NULL,
  to_date   DATE NOT NULL,
  CHECK (from_date <= to_date)
);
CREATE INDEX IF NOT EXISTS route_seasons_lookup_idx ON route_seasons (route_id, from_date, to_date);

-- Single-day exceptions, which beat any season covering the same date.
CREATE TABLE IF NOT EXISTS route_day_overrides (
  route_id     TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  service_date DATE NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('open', 'closed')),
  PRIMARY KEY (route_id, service_date)
);

CREATE TABLE IF NOT EXISTS boats (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  type    TEXT,
  pier    TEXT,
  /** Seats the company sells. A commercial decision, always at or below the licence. */
  capacity    INTEGER NOT NULL CHECK (capacity > 0),
  /** Registered maximum PASSENGERS. The legal ceiling. Null for boats with no licence on file,
      in which case capacity is the ceiling. Never confuse this with persons aboard: the legacy
      `totalcap` column is license_pax + crew and is deliberately not carried over, because using
      it as a selling ceiling is what let charters be sold the crew's seats. */
  license_pax INTEGER CHECK (license_pax > 0),
  crew        INTEGER CHECK (crew >= 0),
  CHECK (license_pax IS NULL OR capacity <= license_pax)
);

-- Ops lowering one boat's capacity for one day. Clamped to the licence on write and on read.
CREATE TABLE IF NOT EXISTS boat_capacity_overrides (
  boat_id      TEXT NOT NULL REFERENCES boats(id) ON DELETE CASCADE,
  service_date DATE NOT NULL,
  capacity     INTEGER NOT NULL CHECK (capacity >= 0),
  reason       TEXT,
  PRIMARY KEY (boat_id, service_date)
);
