-- Upgrades (slice E of todo/trip-ops-and-vans-model.md). Legacy, 2026-10-09: 11 on-tour sales on 10
-- bookings, no route upgrade yet.

-- On-tour upsells sold to the customer (legacy upgrades[], sb_bookings__upgrades). The server works out
-- commission = sell_price - to_company on read, and fee and customer_paid when it saves. A sale saved
-- before legacy took payment details (5 of 11) has no method, fee or customer_paid.
CREATE TABLE booking_upgrades (
  booking_id TEXT NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 0),
  id TEXT NOT NULL,                                -- client id ('up_<ms>'); a route upgrade links to it
  label TEXT NOT NULL,
  sell_price NUMERIC(12,2) NOT NULL CHECK (sell_price >= 0),
  to_company NUMERIC(12,2) CHECK (to_company >= 0),
  seller TEXT, note TEXT,
  collected BOOLEAN,
  settle TEXT CHECK (settle IN ('pending', 'done')),
  method TEXT,                                      -- cash | card seen; legacy's form also offers cot
  fee_pct NUMERIC(5,2), fee NUMERIC(12,2), customer_paid NUMERIC(12,2),
  at TIMESTAMPTZ,
  PRIMARY KEY (booking_id, seq),
  UNIQUE (booking_id, id)
);

-- A trip moved to another programme (legacy trips[].upg), kept even after an undo.
CREATE TABLE booking_trip_upgrades (
  id BIGSERIAL PRIMARY KEY,
  booking_trip_id TEXT NOT NULL REFERENCES booking_trips (id) ON DELETE CASCADE,
  from_route_id TEXT NOT NULL REFERENCES routes (id),
  to_route_id TEXT NOT NULL REFERENCES routes (id),
  reason TEXT NOT NULL,
  charge NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (charge >= 0),
  upgrade_id TEXT,                                  -- booking_upgrades.id when charged
  at TIMESTAMPTZ NOT NULL DEFAULT now(), by TEXT,
  undone_at TIMESTAMPTZ, undone_by TEXT
);
CREATE INDEX booking_trip_upgrades_trip_idx ON booking_trip_upgrades (booking_trip_id);
