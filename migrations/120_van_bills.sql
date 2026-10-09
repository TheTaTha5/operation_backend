-- Partner van bills and the money reports' settings (todo/money-model.md slices 5 and 6, decided
-- 2026-10-09). A bill's rows and amounts are computed from bookings, van parts and check-ins
-- (src/domain/van-bills.ts); only what staff type is stored, plus the new sent and paid state.
-- Legacy, 2026-10-09: 31 van_bill rows (26 with today's key, 5 with an older key nobody reads),
-- one van_rates table of 9 groups, one dr_cfg.

-- One bill per partner, month and ten-day period (legacy key `partner|YYYY-MM|period`).
-- `seen`: the row keys when staff last saved (legacy §vbSeen); NULL = never, as on older bills.
-- Sent and paid are new (decided 2026-10-09): legacy had no state. `sent_bill` and `paid_amount`
-- are the total at that moment, so a bill that moved since can say so.
CREATE TABLE van_bills (
  id TEXT PRIMARY KEY,
  partner TEXT NOT NULL CHECK (partner <> '' AND partner = btrim(partner)),
  month TEXT NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  period SMALLINT NOT NULL CHECK (period IN (1, 2, 3)),
  per_pax NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (per_pax >= 0),
  rate NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (rate >= 0),
  seen TEXT[],
  updated_at TIMESTAMPTZ,
  updated_by TEXT,
  sent_at TIMESTAMPTZ,
  sent_by TEXT,
  sent_bill NUMERIC(12,2),
  paid_at TIMESTAMPTZ,
  paid_by TEXT,
  paid_on DATE,
  paid_via TEXT CHECK (paid_via IN ('transfer', 'cash', 'cheque')),
  paid_ref TEXT,
  paid_amount NUMERIC(12,2),
  UNIQUE (partner, month, period),
  CHECK ((sent_at IS NULL) = (sent_bill IS NULL)),
  CHECK (CASE WHEN paid_at IS NULL THEN num_nonnulls(paid_on, paid_via, paid_amount) = 0
              ELSE num_nonnulls(paid_on, paid_via, paid_amount) = 3 AND sent_at IS NOT NULL END)
);

-- The default rate per van of one route code (legacy `rateC`): PP, PB, MT, SM, SR, or — for others.
CREATE TABLE van_bill_route_rates (
  bill_id TEXT NOT NULL REFERENCES van_bills (id) ON DELETE CASCADE,
  code TEXT NOT NULL CHECK (code IN ('PP', 'PB', 'MT', 'SM', 'SR', '—')),
  rate NUMERIC(12,2) NOT NULL CHECK (rate >= 0),
  PRIMARY KEY (bill_id, code)
);

-- What staff typed on one computed row (legacy `rows[key]`). The key is `date~route~van`, `~R` for a
-- return-only run. NULL = not set: an explicit 0 rate is kept apart from no rate, as legacy reads it.
CREATE TABLE van_bill_row_overrides (
  bill_id TEXT NOT NULL REFERENCES van_bills (id) ON DELETE CASCADE,
  row_key TEXT NOT NULL CHECK (row_key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}~[^~]+~[^~]+(~R)?$'),
  rate NUMERIC(12,2) CHECK (rate >= 0),
  ex NUMERIC(12,2) CHECK (ex >= 0),
  cut NUMERIC(12,2) CHECK (cut >= 0),
  per NUMERIC(12,2) CHECK (per >= 0),
  PRIMARY KEY (bill_id, row_key),
  CHECK (num_nonnulls(rate, ex, cut, per) > 0)
);

-- A hand-typed line: a van from outside, work that never went through a job order (legacy `extra`).
CREATE TABLE van_bill_extra_lines (
  bill_id TEXT NOT NULL REFERENCES van_bills (id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  line_date DATE,
  note TEXT,
  vans INTEGER NOT NULL DEFAULT 0 CHECK (vans >= 0),
  pax INTEGER NOT NULL DEFAULT 0 CHECK (pax >= 0),
  rate NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (rate >= 0),
  ex NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (ex >= 0),
  cut NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (cut >= 0),
  per_pax NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (per_pax >= 0),
  PRIMARY KEY (bill_id, id),
  UNIQUE (bill_id, seq)
);

-- Transfer Fleet's rate table (legacy app_meta `van_rates`): per van group (`own`, or `p:<partner>`),
-- a base, and per route a base or a rate per pickup zone. `route_id` NULL = the group's base.
-- Both van bills ("pull rates") and the daily report's van cost read it.
CREATE TABLE van_rates (
  group_key TEXT NOT NULL CHECK (group_key = 'own' OR (group_key LIKE 'p:%' AND length(group_key) > 2)),
  route_id TEXT REFERENCES routes (id) ON DELETE CASCADE,
  field TEXT NOT NULL CHECK (field IN ('base', 'PK', 'KL')),
  rate NUMERIC(12,2) NOT NULL CHECK (rate >= 0),
  updated_at TIMESTAMPTZ,
  updated_by TEXT,
  CHECK (route_id IS NOT NULL OR field = 'base'),
  UNIQUE NULLS NOT DISTINCT (group_key, route_id, field)
);

-- The daily report's own numbers (legacy app_meta `dr_cfg`). One row; NULL = legacy's default
-- (1,200 per van, 6 vans, 130 per passenger).
CREATE TABLE daily_report_settings (
  id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  van_cost NUMERIC(12,2) CHECK (van_cost > 0),
  van_quota INTEGER CHECK (van_quota > 0),
  target_per_pax NUMERIC(12,2) CHECK (target_per_pax > 0),
  updated_at TIMESTAMPTZ,
  updated_by TEXT
);
