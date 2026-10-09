-- Weather closures (todo/weather-closures-model.md, decided 2026-10-09): "route R does not run on
-- date D because of weather", and the follow-up of each booking on it. Legacy `sb_weather` and
-- `bk.weatherResolve`, 2026-10-09: 5 closures (one per route and date), 40 follow-ups.
--
-- The follow-up list is worked out on read (src/domain/weather.ts): the bookings on the closed trip,
-- plus every booking with a row. A row is written only when something happens to a booking: it is
-- notified, resolved, or imported. Nothing here refuses a sale (decision 1).

CREATE TABLE weather_closures (
  id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL REFERENCES routes (id),
  service_date DATE NOT NULL,
  note TEXT,
  closed_by TEXT,
  closed_at TIMESTAMPTZ NOT NULL,
  updated_by TEXT,                          -- the last note change
  updated_at TIMESTAMPTZ,
  -- Undo keeps the closure, so the bookings it already resolved keep their record (decision 8).
  reopened_by TEXT,
  reopened_at TIMESTAMPTZ
);
-- One open closure per trip; a reopened one stays beside a new one.
CREATE UNIQUE INDEX weather_closures_open ON weather_closures (route_id, service_date) WHERE reopened_at IS NULL;
CREATE INDEX weather_closures_date ON weather_closures (service_date);

CREATE TABLE weather_cases (
  closure_id TEXT NOT NULL REFERENCES weather_closures (id) ON DELETE CASCADE,
  booking_id TEXT NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('awaiting', 'notified', 'resolved')),
  notified_at TIMESTAMPTZ,
  notified_by TEXT,
  outcome TEXT CHECK (outcome IN ('reschedule', 'refund', 'credit', 'cancel')),
  new_date DATE,                            -- where a reschedule took it
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,
  PRIMARY KEY (closure_id, booking_id),
  CHECK ((status = 'resolved') = (outcome IS NOT NULL)),
  CHECK (new_date IS NULL OR outcome = 'reschedule')
);
CREATE INDEX weather_cases_booking ON weather_cases (booking_id);

-- The change feed names closures too.
ALTER TABLE changes DROP CONSTRAINT changes_kind_check;
ALTER TABLE changes ADD CONSTRAINT changes_kind_check
  CHECK (kind IN ('booking', 'seat_lock', 'deployment', 'route', 'invoice', 'weather_closure'));
