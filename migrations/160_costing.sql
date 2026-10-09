-- The cost model and Trip P&L (todo/money-model.md, "Design: the rest of Money", decided 2026-10-10).
-- Legacy kept these as JSON strings in app_meta (cost_template, cost_plans, boat_rent), its own
-- tables (meal_venues, trip_actuals) and routes.mealVenueId. Legacy, 2026-10-10: 22 template lines,
-- 10 plans, 2 boat rent records, 3 venues, 6 routes linked to a venue, 91 trip actuals (none closed).

-- The template's one setting; no row = legacy's default template (CT_DEFAULT, 7%).
CREATE TABLE cost_settings (
  id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  vat_rate NUMERIC(5,2) NOT NULL CHECK (vat_rate >= 0),
  updated_at TIMESTAMPTZ NOT NULL,
  updated_by TEXT
);

-- The template's cost lines, in order. A line's parts are a list of small records whose fields depend
-- on their kind (fix / var / step), checked by src/domain/costing.ts.
CREATE TABLE cost_lines (
  id TEXT PRIMARY KEY,
  sort INTEGER NOT NULL,
  group_name TEXT NOT NULL,
  label TEXT NOT NULL,
  vat BOOLEAN NOT NULL,                              -- input VAT can be claimed back
  parts JSONB NOT NULL,
  on_demand BOOLEAN NOT NULL DEFAULT false,          -- priced per item ordered (van, longtails), not per head
  on_demand_qty NUMERIC(8,2)                         -- the plan's default quantity: % of heads, or boats
);

-- A route's design sheet (legacy "แผนคำนวณ"). Trip P&L reads only its overrides, groups and fuel price.
CREATE TABLE cost_plans (
  id TEXT PRIMARY KEY,
  sort INTEGER NOT NULL,
  name TEXT NOT NULL,
  route_key TEXT,                                    -- a route id, or (older plans) a route family id
  note TEXT,
  engines TEXT NOT NULL CHECK (engines IN ('3EN', '4EN')),
  boats INTEGER NOT NULL CHECK (boats >= 1),
  capacity INTEGER NOT NULL CHECK (capacity >= 1),
  pax INTEGER NOT NULL CHECK (pax >= 0),
  pax_th INTEGER NOT NULL CHECK (pax_th >= 0),
  price NUMERIC(12,2) NOT NULL CHECK (price >= 0),
  price_child NUMERIC(12,2) CHECK (price_child >= 0),  -- NULL = the adult price
  child_pct NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (child_pct BETWEEN 0 AND 100),
  commission_pct NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (commission_pct BETWEEN 0 AND 100),
  fuel_price NUMERIC(8,2) NOT NULL DEFAULT 0 CHECK (fuel_price >= 0),
  boat_id TEXT REFERENCES boats (id),
  rent_off BOOLEAN NOT NULL DEFAULT false,           -- cost the pinned boat as the company's own
  overrides JSONB NOT NULL DEFAULT '{}',             -- {line id: {off, parts: [partial part | null]}}
  groups JSONB NOT NULL DEFAULT '{}',                -- {group: {off, pct}}
  on_demand JSONB NOT NULL DEFAULT '{}',             -- {line id: {agent_qty, agent_rev, upsell_qty, upsell_rev}}
  itinerary JSONB NOT NULL DEFAULT '[]',
  tiers JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ NOT NULL,
  updated_by TEXT
);

-- A boat's rent contract and its fuel factor (legacy boat_rent). A record with rented = false keeps
-- only the fuel factor: the boat is the company's own.
CREATE TABLE boat_rents (
  boat_id TEXT PRIMARY KEY REFERENCES boats (id),
  rented BOOLEAN NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('lump', 'seat')),
  amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  per_seat NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (per_seat >= 0),
  days INTEGER NOT NULL CHECK (days >= 1),
  days_off INTEGER NOT NULL CHECK (days_off >= 0),
  trips_per_day INTEGER NOT NULL CHECK (trips_per_day >= 1),
  vat BOOLEAN NOT NULL,
  note TEXT,
  from_date DATE,
  to_date DATE,
  fuel_pct NUMERIC(6,2) CHECK (fuel_pct > 0),        -- NULL = 100%
  owner_pays TEXT[] NOT NULL DEFAULT '{}',           -- template line ids the owner pays (dep, cap, crew)
  updated_at TIMESTAMPTZ NOT NULL,
  updated_by TEXT
);

CREATE TABLE meal_venues (
  id TEXT PRIMARY KEY,
  sort BIGSERIAL,
  name TEXT NOT NULL DEFAULT '',
  place TEXT,
  price_adult NUMERIC(12,2) NOT NULL CHECK (price_adult >= 0),
  price_child NUMERIC(12,2) NOT NULL CHECK (price_child >= 0),
  phone TEXT,
  eta TEXT,
  note TEXT,
  active BOOLEAN NOT NULL DEFAULT true
);

-- The route's restaurant (legacy routes.mealVenueId), which the catalogue left for costing.
ALTER TABLE routes ADD COLUMN meal_venue_id TEXT REFERENCES meal_venues (id);

-- What one boat's day actually cost, beside the formula (legacy trip_actuals, key date::boat).
CREATE TABLE trip_actuals (
  service_date DATE NOT NULL,
  boat_id TEXT NOT NULL REFERENCES boats (id),
  venue_id TEXT REFERENCES meal_venues (id),         -- this day's restaurant (legacy pier_job.mv); NULL = the route's
  no_meal BOOLEAN NOT NULL DEFAULT false,            -- legacy mv '-': no meal this day
  -- The meal order sent (legacy pckMealSend), frozen: a later price change does not move it.
  meal_venue_id TEXT,
  meal_venue_name TEXT,
  meal_adults INTEGER CHECK (meal_adults >= 0),
  meal_children INTEGER CHECK (meal_children >= 0),
  meal_price_adult NUMERIC(12,2),
  meal_price_child NUMERIC(12,2),
  meal_amount NUMERIC(12,2),
  meal_at TIMESTAMPTZ,
  meal_by TEXT,
  meal_note TEXT,
  meal_note_at TIMESTAMPTZ,
  meal_note_by TEXT,
  ran BOOLEAN NOT NULL DEFAULT false,                -- sailed with no passenger and no booking
  ran_at TIMESTAMPTZ,
  ran_by TEXT,
  -- The P&L frozen at close (legacy pxClose).
  closed_at TIMESTAMPTZ,
  closed_by TEXT,
  closed_revenue NUMERIC(12,2),
  closed_cost NUMERIC(12,2),
  closed_profit NUMERIC(12,2),
  closed_pax INTEGER,
  closed_rows JSONB,                                 -- [{id, label, amount, actual}]
  PRIMARY KEY (service_date, boat_id),
  CHECK (NOT (no_meal AND venue_id IS NOT NULL)),
  CHECK ((closed_at IS NULL) = (closed_rows IS NULL)),
  CHECK ((meal_at IS NULL) = (meal_amount IS NULL))
);

-- Whether an overnight return booking eats on this boat's day (legacy mealOvn): 'in' or 'out'.
CREATE TABLE trip_meal_overnight (
  service_date DATE NOT NULL,
  boat_id TEXT NOT NULL,
  booking_id TEXT NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  include TEXT NOT NULL CHECK (include IN ('in', 'out')),
  PRIMARY KEY (service_date, boat_id, booking_id),
  FOREIGN KEY (service_date, boat_id) REFERENCES trip_actuals (service_date, boat_id) ON DELETE CASCADE
);

-- The change feed announces trip actuals (the pier's meal order, a closed P&L). Appended to whatever
-- list the CHECK has now, as migration 100 does.
DO $$
DECLARE def TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid = 'changes'::regclass AND conname = 'changes_kind_check';
  IF def IS NULL OR position('ARRAY[' IN def) = 0 THEN
    RAISE EXCEPTION 'changes_kind_check is not the IN (...) list this migration expects: %', def;
  END IF;
  IF position('''trip_actual''' IN def) = 0 THEN
    ALTER TABLE changes DROP CONSTRAINT changes_kind_check;
    EXECUTE 'ALTER TABLE changes ADD CONSTRAINT changes_kind_check ' || regexp_replace(def, '\]', ', ''trip_actual''::text]');
  END IF;
END $$;
