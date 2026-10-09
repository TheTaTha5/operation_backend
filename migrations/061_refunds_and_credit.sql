-- Refund and credit (todo/weather-closures-model.md, decision 6, 2026-10-09; money-model.md open 1).
-- A weather cancel takes only that booking's lines off its invoice (legacy voided the whole invoice),
-- and what the booking had paid beyond what the invoice still asks is either owed back to the agent
-- (a refund) or kept as the agent's credit, spent later as a payment with method `credit`.
-- Legacy, 2026-10-09: 0 refunds, 0 credits, 0 deposits saved (it never stored them).

-- A line taken off a live invoice. The invoice's totals are worked out from the lines left.
ALTER TABLE invoice_lines ADD COLUMN removed_at TIMESTAMPTZ, ADD COLUMN removed_by TEXT, ADD COLUMN removed_reason TEXT;

CREATE TABLE refunds (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('refund', 'credit')),
  invoice_id TEXT NOT NULL REFERENCES invoices (id),   -- the invoice the money comes off
  booking_id TEXT REFERENCES bookings (id),
  agent_id TEXT REFERENCES agents (id),                -- the invoice's agent; a credit is its balance
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL,                                -- 'weather' today
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  CHECK (kind = 'refund' OR agent_id IS NOT NULL)
);
CREATE INDEX refunds_invoice ON refunds (invoice_id);
CREATE INDEX refunds_agent ON refunds (agent_id, kind);

-- Spending a credit is a payment.
ALTER TABLE payments DROP CONSTRAINT payments_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_method_check CHECK (method IN ('transfer', 'cash', 'card', 'credit'));
