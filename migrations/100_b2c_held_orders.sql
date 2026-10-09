-- Love Kingdom's push (todo/b2c-sync-model.md, decided 2026-10-09): a write from its service login
-- that is refused as bad input (400) is kept raw here for ops, instead of being lost. Legacy's pull
-- stored whatever it read and listed the problems; a booking on an unknown route cannot be stored
-- here (the trip's route is a foreign key), so this is where it waits.

CREATE TABLE b2c_held_orders (
  id TEXT PRIMARY KEY,                                   -- held_<uuid>
  action TEXT NOT NULL CHECK (action IN ('create', 'amend', 'cancel')),
  external_id TEXT,                                      -- Love Kingdom's order id (LOV-…)
  booking_id TEXT REFERENCES bookings(id) ON DELETE SET NULL,   -- amend/cancel: the booking it was for
  request JSONB NOT NULL,                                -- the body exactly as sent
  problem TEXT NOT NULL,                                 -- the refusal's message
  attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  received_at TIMESTAMPTZ NOT NULL,
  last_received_at TIMESTAMPTZ NOT NULL,
  received_by TEXT,
  decided_at TIMESTAMPTZ,
  decided_by TEXT,
  note TEXT,
  resolved_booking_id TEXT REFERENCES bookings(id) ON DELETE SET NULL,
  CHECK ((status = 'open') = (decided_at IS NULL))
);
-- One open held create per order: a retry updates it rather than listing the order twice.
CREATE UNIQUE INDEX b2c_held_orders_open_create_uk ON b2c_held_orders (external_id) WHERE status = 'open' AND action = 'create';
CREATE INDEX b2c_held_orders_status_idx ON b2c_held_orders (status, last_received_at DESC);

-- The change feed announces held orders, so the issues panel refetches. Other branches widen this
-- CHECK too: add to whatever list it has now rather than restating one, so the order the
-- migrations run in cannot drop a kind.
DO $$
DECLARE def TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid = 'changes'::regclass AND conname = 'changes_kind_check';
  IF def IS NULL OR position('ARRAY[' IN def) = 0 THEN
    RAISE EXCEPTION 'changes_kind_check is not the IN (...) list this migration expects: %', def;
  END IF;
  IF position('''b2c_held_order''' IN def) = 0 THEN
    ALTER TABLE changes DROP CONSTRAINT changes_kind_check;
    EXECUTE 'ALTER TABLE changes ADD CONSTRAINT changes_kind_check ' || regexp_replace(def, '\]', ', ''b2c_held_order''::text]');
  END IF;
END $$;
