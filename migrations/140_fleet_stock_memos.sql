-- Fleet maintenance, part B (todo/fleet-maintenance-model.md, "Design — part B", decided 2026-10-09):
-- stock in three warehouses with append-only movements, consumables drawn for a boat, and purchase
-- memos with their lines, history and receipt rounds. Legacy, 2026-10-09: 616 items, 1,265 history
-- rows, 225 memos with 1,118 lines, 1 consumable. Legacy keeps a stock quantity per warehouse and a
-- history beside it; here the quantity is the sum of the movements (src/domain/fleet-stock.ts).

CREATE TABLE fleet_warehouses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,      -- legacy's label, what its screens show and send
  pier TEXT NOT NULL,
  sort INTEGER NOT NULL
);
INSERT INTO fleet_warehouses (id, name, pier, sort) VALUES
  ('tublamu', 'คลัง Tub Lamu', 'tublamu', 1),
  ('panwa', 'คลัง Visit Panwa', 'panwa', 2),
  ('ranong', 'คลัง Ranong', 'ranong', 3);

-- An item: name + part number. Never deleted (decision 6): `deleted_at` hides it, its movements stay.
-- Legacy has 18 groups sharing a name and part number, so the pair is checked by the API, not here.
CREATE TABLE fleet_stock_items (
  id TEXT PRIMARY KEY,                             -- legacy's id kept; new inv_<time>_<hex>
  name TEXT NOT NULL CHECK (btrim(name) <> ''),
  part_no TEXT,
  category TEXT,
  supplier TEXT,
  unit TEXT NOT NULL DEFAULT 'ชิ้น',
  min_qty NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (min_qty >= 0),
  cost NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (cost >= 0),
  note TEXT,
  created_from TEXT,                               -- the memo number that registered it
  created_date DATE,
  created_at TIMESTAMPTZ NOT NULL,
  created_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL,
  deleted_at TIMESTAMPTZ,
  deleted_by TEXT,
  merged_into TEXT REFERENCES fleet_stock_items (id),
  CHECK (merged_into IS NULL OR deleted_at IS NOT NULL)
);

-- Purchase memos (legacy fleet_memos). The number is the client's, as legacy's is (decision 4), and
-- legacy has MO-077 and MO-117 twice, so it is not unique here; the API refuses a new duplicate.
CREATE TABLE fleet_memos (
  id TEXT PRIMARY KEY,
  no TEXT NOT NULL,
  title TEXT NOT NULL,
  boat_id TEXT REFERENCES boats (id),
  memo_type TEXT NOT NULL CHECK (memo_type IN ('parts', 'labor', 'mixed')),
  scope TEXT CHECK (scope IN ('vessel', 'general')),
  general_category TEXT,
  proposer TEXT,
  from_text TEXT,
  to_text TEXT,
  cc TEXT,
  ref_note TEXT,
  supplier TEXT,
  note TEXT,
  memo_date DATE NOT NULL,
  job_id TEXT,                                     -- a maintenance job (part A), as text
  project_id TEXT,                                 -- foreign key added with fleet_projects (141)
  status TEXT NOT NULL CHECK (status IN ('pending_approval', 'approved', 'ordered', 'received', 'paid', 'cancelled')),
  current_step SMALLINT NOT NULL CHECK (current_step BETWEEN 1 AND 5),
  vat_enabled BOOLEAN NOT NULL,
  vat_rate NUMERIC(5,2) NOT NULL CHECK (vat_rate >= 0),
  discount_pct NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (discount_pct BETWEEN 0 AND 100),
  discount_amt NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (discount_amt >= 0),
  subtotal NUMERIC(12,2) NOT NULL,
  discount NUMERIC(12,2) NOT NULL,
  after_discount NUMERIC(12,2) NOT NULL,
  vat NUMERIC(12,2) NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  ordered_amount NUMERIC(12,2),                    -- the amount before a short close
  approved_by TEXT,                                -- typed, as legacy's approval box
  approved_date DATE,
  approve_note TEXT,
  approved_login TEXT,                             -- the login that pressed approve
  ordered_date DATE,
  ordered_by TEXT,
  received_date DATE,
  received_by TEXT,
  received_warehouse TEXT REFERENCES fleet_warehouses (id),
  received_summary TEXT,
  paid_date DATE,
  paid_by TEXT,
  paid_via TEXT,
  short_closed JSONB,                              -- {date, by, missing[], cut}: legacy loses it
  cancel_reason TEXT,                              -- legacy loses these three
  cancelled_by TEXT,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  created_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX fleet_memos_no_idx ON fleet_memos (no);
CREATE INDEX fleet_memos_job_idx ON fleet_memos (job_id) WHERE job_id IS NOT NULL;

CREATE TABLE fleet_memo_lines (
  id TEXT PRIMARY KEY,
  memo_id TEXT NOT NULL REFERENCES fleet_memos (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  name TEXT NOT NULL,
  qty NUMERIC(12,2) NOT NULL CHECK (qty >= 0),
  price NUMERIC(12,2) NOT NULL CHECK (price >= 0),
  discount_pct NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (discount_pct BETWEEN 0 AND 100),
  category TEXT CHECK (category IN ('parts', 'labor')),
  part_no TEXT,
  unit TEXT NOT NULL DEFAULT 'ชิ้น',
  item_id TEXT REFERENCES fleet_stock_items (id),
  from_inventory BOOLEAN NOT NULL DEFAULT false,
  received_qty NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (received_qty >= 0),   -- legacy loses it (recvQty)
  snapshot JSONB,
  UNIQUE (memo_id, seq)
);
CREATE INDEX fleet_memo_lines_item_idx ON fleet_memo_lines (item_id) WHERE item_id IS NOT NULL;

-- What legacy loses: every create, edit, approval, order, receipt, short close, payment and cancel.
CREATE TABLE fleet_memo_history (
  id BIGSERIAL PRIMARY KEY,
  memo_id TEXT NOT NULL REFERENCES fleet_memos (id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('create', 'edit', 'approve', 'order', 'receive', 'short_close', 'pay', 'cancel')),
  at TIMESTAMPTZ NOT NULL,
  by TEXT,
  note TEXT
);
CREATE INDEX fleet_memo_history_memo_idx ON fleet_memo_history (memo_id, id);

-- Each receipt round of a memo (legacy `receipts`, lost on reload there).
CREATE TABLE fleet_memo_receipts (
  id TEXT PRIMARY KEY,
  memo_id TEXT NOT NULL REFERENCES fleet_memos (id) ON DELETE CASCADE,
  date DATE NOT NULL,
  by TEXT,
  warehouse TEXT NOT NULL REFERENCES fleet_warehouses (id),
  note TEXT,
  lines JSONB NOT NULL,                            -- [{line_id, name, qty, unit}]
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX fleet_memo_receipts_memo_idx ON fleet_memo_receipts (memo_id);

-- Consumables drawn for a boat (legacy fleet_consumable_logs). A void keeps the record.
CREATE TABLE fleet_consumables (
  id TEXT PRIMARY KEY,
  date DATE NOT NULL,
  item_id TEXT NOT NULL REFERENCES fleet_stock_items (id),
  item_name TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT '',
  qty NUMERIC(12,2) NOT NULL CHECK (qty > 0),
  unit_cost NUMERIC(12,2) NOT NULL,
  cost NUMERIC(12,2) NOT NULL,
  warehouse TEXT NOT NULL REFERENCES fleet_warehouses (id),
  boat_id TEXT NOT NULL REFERENCES boats (id),
  engine_id TEXT,                                  -- an engine (part A), as text
  engine_label TEXT,
  drawn_by TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  created_by TEXT,
  voided_at TIMESTAMPTZ,
  voided_by TEXT
);

-- Movements (legacy `history`): append-only (decision 6). Stock is the sum of `delta` by item and
-- warehouse. `edit`, `register` and the `merge` marker carry no quantity.
CREATE TABLE fleet_stock_movements (
  seq BIGSERIAL PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,                         -- lg_<legacy row> for imported rows
  item_id TEXT NOT NULL REFERENCES fleet_stock_items (id),
  date DATE NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('register', 'receive', 'withdraw', 'transfer-out', 'transfer-in', 'edit', 'merge', 'adjust', 'adjust_out', 'in', 'return', 'reverse', 'import')),
  warehouse TEXT REFERENCES fleet_warehouses (id),
  delta NUMERIC(12,2) NOT NULL DEFAULT 0,
  note TEXT,
  by TEXT,
  memo_id TEXT REFERENCES fleet_memos (id),
  job_id TEXT,                                     -- a maintenance job (part A), as text
  consumable_id TEXT REFERENCES fleet_consumables (id),
  changes JSONB,                                   -- an edit's [{field, from, to}]
  created_at TIMESTAMPTZ NOT NULL,
  created_by TEXT,
  CHECK (delta = 0 OR warehouse IS NOT NULL)
);
CREATE INDEX fleet_stock_movements_item_idx ON fleet_stock_movements (item_id, seq);
CREATE INDEX fleet_stock_movements_memo_idx ON fleet_stock_movements (memo_id) WHERE memo_id IS NOT NULL;

-- Append-only in the schema too. Only the legacy import (which replaces its own `lg_` rows on a
-- rerun) sets fleet.import_rewrite for its transaction.
CREATE FUNCTION fleet_movements_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('fleet.import_rewrite', true) = 'on' AND OLD.id LIKE 'lg\_%' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION 'fleet_stock_movements is append-only: add a movement instead of changing %', OLD.id;
END $$;
CREATE TRIGGER fleet_movements_append_only BEFORE UPDATE OR DELETE ON fleet_stock_movements
  FOR EACH ROW EXECUTE FUNCTION fleet_movements_append_only();
