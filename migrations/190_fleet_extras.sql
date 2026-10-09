-- Fleet maintenance, the extras (todo/fleet-maintenance-model.md, "Design — extras"): a boat's pier
-- assignments and the monthly fuel budget. Certificates, the replace wizard, the reports and the Daily
-- Log flags need no table: they compute from what is stored, or write rows that exist.

-- A boat moved to another pier for a while (`temporary`) or for good (`permanent`), legacy
-- `boats.assignments` (`flSaveAssignment`). The status (planned, active, completed) is computed from the
-- dates; a cancel is kept, never deleted, as legacy's soft `status: 'cancelled'`.
CREATE TABLE boat_assignments (
  id           TEXT PRIMARY KEY,
  boat_id      TEXT NOT NULL REFERENCES boats (id) ON DELETE CASCADE,
  type         TEXT NOT NULL CHECK (type IN ('temporary', 'permanent')),
  from_pier    TEXT NOT NULL CHECK (from_pier IN ('tublamu', 'panwa', 'ranong')),
  to_pier      TEXT NOT NULL CHECK (to_pier IN ('tublamu', 'panwa', 'ranong')),
  start_date   DATE NOT NULL,
  end_date     DATE NOT NULL,
  reason       TEXT,
  cost         NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (cost >= 0),
  cancelled    BOOLEAN NOT NULL DEFAULT false,
  cancelled_at TIMESTAMPTZ,
  cancelled_by TEXT,
  created_date DATE NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL,
  created_by   TEXT,
  CHECK (from_pier <> to_pier),
  CHECK (end_date >= start_date)
);
CREATE INDEX boat_assignments_boat_idx ON boat_assignments (boat_id, start_date);

-- The month's fuel budget for the whole fleet, in baht (legacy `fleet_fuelbudget`, kept in one browser
-- and never saved). Fuel Intelligence compares its projection with it.
CREATE TABLE fleet_fuel_budgets (
  month  TEXT PRIMARY KEY CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  set_at TIMESTAMPTZ NOT NULL,
  set_by TEXT
);
