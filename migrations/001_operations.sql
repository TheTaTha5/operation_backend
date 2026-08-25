CREATE TABLE IF NOT EXISTS deployments (
  boat_id TEXT NOT NULL,
  route_id TEXT NOT NULL,
  service_date DATE NOT NULL,
  capacity INTEGER NOT NULL CHECK (capacity > 0),
  PRIMARY KEY (service_date, boat_id)
);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL,
  service_date DATE NOT NULL,
  pax INTEGER NOT NULL CHECK (pax >= 0),
  allocated_pax INTEGER NOT NULL CHECK (allocated_pax >= 0),
  status TEXT NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
  cancellation_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bookings_allotment_idx ON bookings (route_id, service_date) WHERE status = 'confirmed';

CREATE TABLE IF NOT EXISTS seat_locks (
  id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL,
  service_date DATE NOT NULL,
  pax INTEGER NOT NULL CHECK (pax > 0),
  agent_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'released')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS seat_locks_allotment_idx ON seat_locks (route_id, service_date) WHERE status = 'active';
