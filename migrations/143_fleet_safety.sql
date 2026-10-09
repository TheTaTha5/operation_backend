-- Safety equipment per boat (todo/fleet-maintenance-model.md, "Design — part B", decision 11).
-- Legacy, 2026-10-09: 94 items on 15 boats (the seed plus 4 replacements), 4 inspections, 98 log
-- rows. Legacy loses an inspection's inspector, findings and next due date; they are kept here.

CREATE TABLE fleet_safety_items (
  id TEXT PRIMARY KEY,
  boat_id TEXT NOT NULL REFERENCES boats (id),
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  brand TEXT,
  model TEXT,
  serial TEXT,
  qty INTEGER NOT NULL DEFAULT 1 CHECK (qty >= 1),
  install_date DATE,
  expiry_date DATE,
  next_pm DATE,
  last_inspect DATE,
  status TEXT NOT NULL DEFAULT 'active',
  location TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE fleet_safety_inspections (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES fleet_safety_items (id) ON DELETE CASCADE,
  date DATE NOT NULL,
  inspector TEXT,
  result TEXT NOT NULL CHECK (result IN ('pass', 'needs_work', 'fail', 'observation')),
  findings TEXT,
  next_due DATE,
  created_at TIMESTAMPTZ NOT NULL,
  created_by TEXT
);
CREATE INDEX fleet_safety_inspections_item_idx ON fleet_safety_inspections (item_id);

CREATE TABLE fleet_safety_log (
  id BIGSERIAL PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES fleet_safety_items (id) ON DELETE CASCADE,
  date DATE NOT NULL,
  type TEXT NOT NULL,
  "desc" TEXT NOT NULL
);
CREATE INDEX fleet_safety_log_item_idx ON fleet_safety_log (item_id, id);
