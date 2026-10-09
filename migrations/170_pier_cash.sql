-- Pier petty cash (todo/pier-office-model.md): legacy's §poCash, a cash box per pier whose balance
-- carries from day to day, and its two month sheets (longtail boats paid, national-park and dock fees).
-- Legacy, 2026-10-10: Panwa 38 in (฿169,828) and 114 out (฿159,728), Tub Lamu 1 out (฿1,800);
-- 54 longtail cells (฿190,000); 61 park cells (฿661,280 park + ฿10,500 dock).

-- A ledger row (legacy po_cash_rows). `source` marks a row the server made by pulling a sheet's day
-- total in (legacy `src` lt/pk/dock). A deleted row stays, out of every total.
CREATE TABLE pier_cash_rows (
  id TEXT PRIMARY KEY,                        -- legacy's pc…, kept; pc_<uuid> here
  pier TEXT NOT NULL CHECK (pier IN ('tublamu', 'panwa', 'ranong')),
  cash_date DATE NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('in', 'out')),
  description TEXT,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  time TEXT CHECK (time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  source TEXT CHECK (source IN ('longtail', 'park', 'dock')),
  created_at TIMESTAMPTZ NOT NULL,
  created_by TEXT,
  deleted_at TIMESTAMPTZ, deleted_by TEXT, delete_reason TEXT,
  CHECK (source IS NULL OR kind = 'out')
);
CREATE INDEX pier_cash_rows_day_idx ON pier_cash_rows (pier, cash_date);
-- A category is pulled once a day (legacy `pcPull`); deleting the pulled row allows it again.
CREATE UNIQUE INDEX pier_cash_rows_pulled ON pier_cash_rows (pier, cash_date, source) WHERE source IS NOT NULL AND deleted_at IS NULL;

-- The longtail sheet: what the pier keyed per boat and day (legacy po_cash_lt). Legacy's `n` is
-- join + charter, worked out on read.
CREATE TABLE pier_cash_longtail (
  pier TEXT NOT NULL CHECK (pier IN ('tublamu', 'panwa', 'ranong')),
  cash_date DATE NOT NULL,
  boat_id TEXT NOT NULL REFERENCES boats (id),
  join_boats INTEGER CHECK (join_boats >= 0),
  charter_boats INTEGER CHECK (charter_boats >= 0),
  amount NUMERIC(12,2) CHECK (amount >= 0),
  note TEXT,
  updated_at TIMESTAMPTZ NOT NULL,
  updated_by TEXT,
  PRIMARY KEY (pier, cash_date, boat_id)
);

-- The park-fee sheet: heads paid at the gate by nationality and age, the fee and the dock fee
-- (legacy po_cash_pk). `filled_from`: which set a client's "fill from bookings" used (legacy `src`).
CREATE TABLE pier_cash_park (
  pier TEXT NOT NULL CHECK (pier IN ('tublamu', 'panwa', 'ranong')),
  cash_date DATE NOT NULL,
  boat_id TEXT NOT NULL REFERENCES boats (id),
  ad_th INTEGER CHECK (ad_th >= 0), chd_th INTEGER CHECK (chd_th >= 0), inf_th INTEGER CHECK (inf_th >= 0), foc_th INTEGER CHECK (foc_th >= 0),
  ad_fr INTEGER CHECK (ad_fr >= 0), chd_fr INTEGER CHECK (chd_fr >= 0), inf_fr INTEGER CHECK (inf_fr >= 0), foc_fr INTEGER CHECK (foc_fr >= 0),
  amount NUMERIC(12,2) CHECK (amount >= 0),
  dock NUMERIC(12,2) CHECK (dock >= 0),
  filled_from TEXT CHECK (filled_from IN ('nat', 'price')),
  updated_at TIMESTAMPTZ NOT NULL,
  updated_by TEXT,
  PRIMARY KEY (pier, cash_date, boat_id)
);

-- The company printed on the receipt-substitute certificate, one for every pier (legacy po_cash_co).
CREATE TABLE pier_cash_settings (
  id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  company_name TEXT,
  updated_at TIMESTAMPTZ,
  updated_by TEXT
);

-- The change feed announces a pier's cash day. Other branches widen this CHECK too: add to whatever
-- list it has now rather than restating one (as migration 100 does).
DO $$
DECLARE def TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid = 'changes'::regclass AND conname = 'changes_kind_check';
  IF def IS NULL OR position('ARRAY[' IN def) = 0 THEN
    RAISE EXCEPTION 'changes_kind_check is not the IN (...) list this migration expects: %', def;
  END IF;
  IF position('''pier_cash''' IN def) = 0 THEN
    ALTER TABLE changes DROP CONSTRAINT changes_kind_check;
    EXECUTE 'ALTER TABLE changes ADD CONSTRAINT changes_kind_check ' || regexp_replace(def, '\]', ', ''pier_cash''::text]');
  END IF;
END $$;
