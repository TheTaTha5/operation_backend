-- Invoices and payments (todo/money-model.md slice 1, approved 2026-10-09). Legacy SB_INVOICES and
-- SB_PAYMENTS, 2026-10-09: 467 invoices (every one for a single booking), 385 payments; every agent,
-- booking and invoice they name exists; one duplicate number (INV-2609-0003, imported as -0003-2).
--
-- An invoice's amounts are frozen when it is issued (legacy `gross0`): a line keeps the amount it was
-- issued for and is never recomputed from the booking. Its status is not stored: `voided` and the
-- payments decide it (src/domain/invoices.ts), so the two can no longer disagree as they do in legacy.

-- The last number issued per month, so two invoices never get the same one (legacy picked it in the browser).
CREATE TABLE invoice_number_counters (
  year_month TEXT PRIMARY KEY CHECK (year_month ~ '^[0-9]{4}$'),   -- YYMM, as in INV-YYMM-NNNN
  last INTEGER NOT NULL CHECK (last >= 0)
);

CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  agent_id TEXT REFERENCES agents (id),
  kind TEXT NOT NULL CHECK (kind IN ('booking', 'prepay', 'fee')),
  fee_type TEXT CHECK (fee_type IN ('cancellation', 'reschedule')),
  -- Copied from the agent at issue. Null on legacy invoices issued before VAT was recorded.
  vat_mode TEXT CHECK (vat_mode IN ('none', 'include', 'exclude')),
  vat_rate NUMERIC(5,4),
  subtotal NUMERIC(12,2) NOT NULL,          -- the lines less their discounts
  net_amount NUMERIC(12,2),
  vat_amount NUMERIC(12,2),
  total NUMERIC(12,2) NOT NULL,
  wht_amount NUMERIC(12,2) CHECK (wht_amount >= 0),   -- withholding tax: printed, never part of total or paid
  issued_at TIMESTAMPTZ NOT NULL,
  due_at TIMESTAMPTZ NOT NULL,
  note TEXT, ref TEXT, dear TEXT, accept_at DATE, remark TEXT,
  -- Legacy kept only the status: a legacy void has no time, user or reason.
  voided BOOLEAN NOT NULL DEFAULT false,
  voided_at TIMESTAMPTZ, voided_by TEXT, void_reason TEXT,
  created_by TEXT,
  CHECK ((kind = 'fee') = (fee_type IS NOT NULL))
);
CREATE INDEX invoices_agent ON invoices (agent_id, issued_at);

CREATE TABLE invoice_lines (
  invoice_id TEXT NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  booking_id TEXT REFERENCES bookings (id),
  label TEXT NOT NULL,
  amount NUMERIC(12,2) NOT NULL,            -- as issued; never recomputed from the booking
  discount NUMERIC(12,2) CHECK (discount >= 0),
  PRIMARY KEY (invoice_id, seq)
);
CREATE INDEX invoice_lines_booking ON invoice_lines (booking_id);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices (id),
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL CHECK (method IN ('transfer', 'cash', 'card')),
  paid_on DATE NOT NULL,
  ref TEXT,
  recorded_by TEXT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A deleted payment stays, out of every total (decided 2026-10-09).
  deleted_at TIMESTAMPTZ, deleted_by TEXT, delete_reason TEXT
);
CREATE INDEX payments_invoice ON payments (invoice_id);

CREATE TABLE payment_slips (
  payment_id TEXT NOT NULL REFERENCES payments (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  attachment_id TEXT NOT NULL REFERENCES attachments (id),
  PRIMARY KEY (payment_id, seq)
);
CREATE INDEX payment_slips_attachment_idx ON payment_slips (attachment_id);

-- The change feed names invoices too.
ALTER TABLE changes DROP CONSTRAINT changes_kind_check;
ALTER TABLE changes ADD CONSTRAINT changes_kind_check CHECK (kind IN ('booking', 'seat_lock', 'deployment', 'route', 'invoice'));
