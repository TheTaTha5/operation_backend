-- Refund payouts and deposits (todo/money-model.md, "Design: the rest of Money", decided 2026-10-10).
-- A refund owed to an agent gets a "paid out" step; a deposit is money received from an agent with no
-- invoice, added to the same credit balance weather credits use and spent as a `credit` payment.
-- Legacy, 2026-10-10: no payout step, 0 deposits saved (sb_deposits never reached the server).

CREATE TABLE refund_payouts (
  refund_id TEXT PRIMARY KEY REFERENCES refunds (id),
  paid_on DATE NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('transfer', 'cash', 'cheque')),
  ref TEXT,
  paid_out_by TEXT,
  recorded_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE refund_payout_slips (
  refund_id TEXT NOT NULL REFERENCES refund_payouts (refund_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  attachment_id TEXT NOT NULL REFERENCES attachments (id),
  PRIMARY KEY (refund_id, seq)
);
CREATE INDEX refund_payout_slips_attachment_idx ON refund_payout_slips (attachment_id);

CREATE TABLE deposits (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents (id),
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL CHECK (method IN ('transfer', 'cash', 'card')),
  received_on DATE NOT NULL,
  ref TEXT,
  note TEXT,
  recorded_by TEXT,
  recorded_at TIMESTAMPTZ NOT NULL,
  -- A voided deposit stays, out of the balance.
  voided_at TIMESTAMPTZ,
  voided_by TEXT,
  void_reason TEXT,
  CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
CREATE INDEX deposits_agent ON deposits (agent_id);
CREATE TABLE deposit_slips (
  deposit_id TEXT NOT NULL REFERENCES deposits (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  attachment_id TEXT NOT NULL REFERENCES attachments (id),
  PRIMARY KEY (deposit_id, seq)
);
CREATE INDEX deposit_slips_attachment_idx ON deposit_slips (attachment_id);

-- The change feed announces deposits and refunds (a payout), so the accounting screens refetch.
DO $$
DECLARE def TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid = 'changes'::regclass AND conname = 'changes_kind_check';
  IF def IS NULL OR position('ARRAY[' IN def) = 0 THEN
    RAISE EXCEPTION 'changes_kind_check is not the IN (...) list this migration expects: %', def;
  END IF;
  IF position('''deposit''' IN def) = 0 THEN
    def := regexp_replace(def, '\]', ', ''deposit''::text]');
  END IF;
  IF position('''refund''' IN def) = 0 THEN
    def := regexp_replace(def, '\]', ', ''refund''::text]');
  END IF;
  ALTER TABLE changes DROP CONSTRAINT changes_kind_check;
  EXECUTE 'ALTER TABLE changes ADD CONSTRAINT changes_kind_check ' || def;
END $$;
