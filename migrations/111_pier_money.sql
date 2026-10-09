-- Pier money (todo/money-model.md slice 3, decided 2026-10-09): money taken at the pier, on-tour
-- sales, and the settlement legacy never built (the pier's cash handed over to accounts at day close,
-- and sellers' commissions paid out).
-- Legacy, 2026-10-09: 158 pier payments on 156 bookings (cash 122 ฿325,000; card 27 ฿63,323 plus
-- ฿2,698 in fees; transfer 9 ฿13,990), 160 on-tour sales (SB_EXTRAS, ฿254,000), no hand-over and no
-- payout; 58 bookings with a B2C balance (฿514,079).

-- Love Kingdom's payment state (legacy paymentSnapshot.paid/paidStatus/deposit/balance): client facts,
-- read by the amount owed at the pier.
ALTER TABLE bookings
  ADD COLUMN payment_paid NUMERIC(12,2),
  ADD COLUMN payment_paid_status TEXT,
  ADD COLUMN payment_deposit NUMERIC(12,2),
  ADD COLUMN payment_balance NUMERIC(12,2);

-- Money taken at the pier (legacy bk.pierPayments). `amount` pays the booking's debt; a card's `fee` is
-- the customer's surcharge passed to the bank, never income: amount + fee is the card machine's figure.
CREATE TABLE booking_pier_payments (
  id TEXT PRIMARY KEY,                        -- legacy's pp_…, kept
  booking_id TEXT NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  service_date DATE NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('cash', 'transfer', 'card')),
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  fee NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (fee >= 0),
  fee_pct NUMERIC(5,2) CHECK (fee_pct >= 0 AND fee_pct <= 100),
  note TEXT,
  by TEXT,
  at TIMESTAMPTZ NOT NULL,
  -- A deleted payment stays, out of every total (as invoice payments, decided 2026-10-09).
  deleted_at TIMESTAMPTZ, deleted_by TEXT, delete_reason TEXT,
  CHECK (method = 'card' OR (fee = 0 AND fee_pct IS NULL))
);
CREATE INDEX booking_pier_payments_booking_idx ON booking_pier_payments (booking_id, service_date);
CREATE INDEX booking_pier_payments_day_idx ON booking_pier_payments (service_date);
CREATE TABLE booking_pier_payment_slips (
  payment_id TEXT NOT NULL REFERENCES booking_pier_payments (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 0),
  attachment_id TEXT NOT NULL REFERENCES attachments (id),
  PRIMARY KEY (payment_id, seq)
);
CREATE INDEX booking_pier_payment_slips_attachment_idx ON booking_pier_payment_slips (attachment_id);

-- On-tour sales (legacy SB_EXTRAS): sold on the day, or sold earlier and collected on the travel day
-- (`method` cot). `total` and `commission` follow from the row; `fee` is stored because legacy's are
-- whole baht.
CREATE TABLE booking_tour_sales (
  id TEXT PRIMARY KEY,                        -- legacy's ex_…, kept
  booking_id TEXT NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  trip_date DATE,                             -- the day it belongs to; null on legacy's oldest
  service TEXT NOT NULL,
  qty INTEGER NOT NULL CHECK (qty >= 1),
  unit_price NUMERIC(12,2) NOT NULL CHECK (unit_price > 0),
  to_company NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (to_company >= 0),
  seller TEXT,
  method TEXT NOT NULL CHECK (method IN ('cash', 'transfer', 'card', 'cot')),
  fee_pct NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (fee_pct >= 0 AND fee_pct <= 100),
  fee NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (fee >= 0),
  collected_at TIMESTAMPTZ, collected_by TEXT,
  sold_at TIMESTAMPTZ NOT NULL,
  sold_by TEXT,
  CHECK (to_company <= qty * unit_price),
  CHECK (method = 'card' OR fee = 0)
);
CREATE INDEX booking_tour_sales_booking_idx ON booking_tour_sales (booking_id);
CREATE INDEX booking_tour_sales_day_idx ON booking_tour_sales (trip_date);
CREATE TABLE booking_tour_sale_slips (
  sale_id TEXT NOT NULL REFERENCES booking_tour_sales (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 0),
  attachment_id TEXT NOT NULL REFERENCES attachments (id),
  PRIMARY KEY (sale_id, seq)
);
CREATE INDEX booking_tour_sale_slips_attachment_idx ON booking_tour_sale_slips (attachment_id);

-- The pier's cash handed over to accounts at day close, per day and pier. `expected` is what the
-- server worked out when it was handed over, by method; a later payment shows on the read as a change.
CREATE TABLE pier_handovers (
  id TEXT PRIMARY KEY,
  service_date DATE NOT NULL,
  pier TEXT NOT NULL,
  expected JSONB NOT NULL,
  cash_counted NUMERIC(12,2) NOT NULL CHECK (cash_counted >= 0),
  note TEXT,
  handed_by TEXT,
  handed_at TIMESTAMPTZ NOT NULL,
  accepted_by TEXT, accepted_at TIMESTAMPTZ, accept_note TEXT,
  voided_by TEXT, voided_at TIMESTAMPTZ, void_reason TEXT,
  CHECK (accepted_at IS NULL OR voided_at IS NULL)
);
CREATE UNIQUE INDEX pier_handovers_live ON pier_handovers (service_date, pier) WHERE voided_at IS NULL;

-- A seller's commission paid out: the on-tour sales and upgrades it covers, each once while live.
CREATE TABLE commission_payouts (
  id TEXT PRIMARY KEY,
  seller TEXT NOT NULL,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL CHECK (method IN ('cash', 'transfer')),
  paid_on DATE NOT NULL,
  ref TEXT, note TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  voided_by TEXT, voided_at TIMESTAMPTZ, void_reason TEXT
);
CREATE INDEX commission_payouts_seller_idx ON commission_payouts (seller, paid_on);
CREATE TABLE commission_payout_items (
  payout_id TEXT NOT NULL REFERENCES commission_payouts (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('tour_sale', 'upgrade')),
  booking_id TEXT NOT NULL,                   -- no key: an upgrade list is rewritten whole, and an import replaces bookings
  item_id TEXT NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  PRIMARY KEY (payout_id, kind, booking_id, item_id)
);
CREATE INDEX commission_payout_items_item_idx ON commission_payout_items (kind, booking_id, item_id);

-- The change feed announces hand-overs and payouts. Other branches widen this CHECK too: add to
-- whatever list it has now rather than restating one (as migration 100 does).
DO $$
DECLARE def TEXT; kind TEXT;
BEGIN
  FOREACH kind IN ARRAY ARRAY['pier_handover', 'commission_payout'] LOOP
    SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid = 'changes'::regclass AND conname = 'changes_kind_check';
    IF def IS NULL OR position('ARRAY[' IN def) = 0 THEN
      RAISE EXCEPTION 'changes_kind_check is not the IN (...) list this migration expects: %', def;
    END IF;
    IF position('''' || kind || '''' IN def) = 0 THEN
      ALTER TABLE changes DROP CONSTRAINT changes_kind_check;
      EXECUTE 'ALTER TABLE changes ADD CONSTRAINT changes_kind_check ' || regexp_replace(def, '\]', ', ''' || kind || '''::text]');
    END IF;
  END LOOP;
END $$;
