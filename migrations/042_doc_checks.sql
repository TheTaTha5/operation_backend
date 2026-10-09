-- The document check (todo/booking-extras-model.md §3, approved 2026-10-09): staff compare the agent's
-- attached document with the B2B booking, item by item, and mark it verified or an issue. Legacy
-- bk.docCheck, 2026-10-09: 3,181 bookings (verified 3,151, pending 29), 3,131 with the browser's
-- OCR pre-check.

CREATE TABLE booking_doc_checks (
  booking_id TEXT PRIMARY KEY REFERENCES bookings (id) ON DELETE CASCADE,
  status TEXT CHECK (status IN ('pending', 'verified', 'issue')),
  by TEXT,
  at TIMESTAMPTZ,
  note TEXT,
  route_ok BOOLEAN NOT NULL DEFAULT false,
  date_ok BOOLEAN NOT NULL DEFAULT false,
  lead_ok BOOLEAN NOT NULL DEFAULT false,
  pax_ok BOOLEAN NOT NULL DEFAULT false,
  voucher_ok BOOLEAN NOT NULL DEFAULT false,
  payment_ok BOOLEAN NOT NULL DEFAULT false,
  -- The browser's OCR pre-check (legacy pre), kept as it sent it: when, which language, the error if
  -- it failed, and the text it read (up to 3,000 characters; decision C2: kept).
  pre_at TIMESTAMPTZ,
  pre_lang TEXT,
  pre_error TEXT,
  pre_text TEXT
);

-- The pre-check's verdict per item ('cot' is the cash-on-tour amount it also looks for).
CREATE TABLE booking_doc_check_results (
  booking_id TEXT NOT NULL REFERENCES booking_doc_checks (booking_id) ON DELETE CASCADE,
  item TEXT NOT NULL CHECK (item IN ('route', 'date', 'lead', 'pax', 'voucher', 'payment', 'cot')),
  result TEXT NOT NULL CHECK (result IN ('match', 'maybe', 'mismatch', 'none')),
  evidence TEXT,
  detail TEXT,
  PRIMARY KEY (booking_id, item)
);
