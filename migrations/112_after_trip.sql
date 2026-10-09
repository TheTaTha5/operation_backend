-- After the trip (todo/money-model.md slice 4, decided 2026-10-09): legacy's Travel Summary decisions,
-- per booking and trip date. The cash-on-tour decision says what became of the cash taken on tour
-- (taken off the agent's invoice, paid back to the agent, kept, or never collected); the invoice now
-- subtracts its `deduct` (decided: legacy only warned, so the money was collected twice). The no-show
-- charge decision says what a no-show is charged; it bills nothing by itself.
-- Legacy, 2026-10-09: 143 COT decisions (TS_COT), 76 no-show decisions (travel_sum).

CREATE TABLE booking_cot_decisions (
  booking_id TEXT NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  service_date DATE NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('full', 'part', 'none', 'payout', 'nocol')),
  deduct NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (deduct >= 0),   -- taken off the agent's invoice
  payout NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (payout >= 0),   -- paid back to the agent
  ref TEXT,                                   -- the transfer's reference; for nocol, why it was not collected
  by TEXT,
  at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (booking_id, service_date)
);
CREATE TABLE booking_cot_decision_slips (
  booking_id TEXT NOT NULL,
  service_date DATE NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 0),
  attachment_id TEXT NOT NULL REFERENCES attachments (id),
  PRIMARY KEY (booking_id, service_date, seq),
  FOREIGN KEY (booking_id, service_date) REFERENCES booking_cot_decisions (booking_id, service_date) ON DELETE CASCADE
);
CREATE INDEX booking_cot_decision_slips_attachment_idx ON booking_cot_decision_slips (attachment_id);

CREATE TABLE booking_noshow_charges (
  booking_id TEXT NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  service_date DATE NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('full', 'partial', 'none', 'postpone')),
  amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  note TEXT,
  by TEXT,
  at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (booking_id, service_date)
);

-- A cash-on-tour deduction is a minus line on the booking's invoice, one per trip date.
ALTER TABLE invoice_lines ADD COLUMN cot_date DATE;
