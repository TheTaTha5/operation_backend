-- What the four booking actions record beyond the seat change: who did it, why, and what it cost.
--
-- Legacy keeps these on the booking document (`history[]`, `cancellation`, `reschedule`,
-- `partialCancels[]`, `feeItems[]`) and staff and reports read them. Before this migration the
-- routes stored only the seat change, so every cancel, reschedule and partial cancel lost its reason.
--
-- Rules live in `src/domain/booking-actions.ts`; these tables only hold the results.

-- One line per change, in the order it happened. `kind` and `tag` are legacy's vocabulary
-- (`bkV2AddHistory`): `kind` is the change class, `tag` the chip text the timeline shows. Both are
-- plain text rather than an enum so the import can carry every legacy row as it is.
CREATE TABLE booking_history (
  id BIGSERIAL PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  by TEXT,
  kind TEXT NOT NULL,
  tag TEXT,
  text TEXT NOT NULL
);
CREATE INDEX booking_history_booking ON booking_history (booking_id, at, id);

-- The booking's current cancellation. A restore deletes it; earlier ones survive in the history.
-- `grp` is derived from `category` (legacy BKV2_CANCEL_REASONS); `group` is a reserved word.
CREATE TABLE booking_cancellations (
  booking_id TEXT PRIMARY KEY REFERENCES bookings (id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  grp TEXT NOT NULL CHECK (grp IN ('customer', 'operator', 'other')),
  note TEXT,
  charge_type TEXT NOT NULL CHECK (charge_type IN ('none', 'full', 'partial')),
  charge_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (charge_amount >= 0),
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  by TEXT
);

-- Append-only: every reschedule, where legacy kept only the latest. `collect` is 'none' whenever
-- the charge is 0, matching legacy (`collect: _charge > 0 ? _collect : 'none'`).
CREATE TABLE booking_reschedules (
  id BIGSERIAL PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  from_date DATE NOT NULL,
  to_date DATE NOT NULL,
  reason TEXT,
  charge_type TEXT NOT NULL DEFAULT 'none' CHECK (charge_type IN ('none', 'full', 'partial')),
  charge_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (charge_amount >= 0),
  collect TEXT NOT NULL DEFAULT 'none' CHECK (collect IN ('none', 'invoice', 'separate')),
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  by TEXT
);
CREATE INDEX booking_reschedules_booking ON booking_reschedules (booking_id, at, id);

-- Append-only. `booking_trip_id` deliberately has no foreign key: the record must outlive a trip
-- that a later edit removes, and the in-process store cannot null it out the way ON DELETE SET NULL
-- would, so the two stores would disagree. `service_date` says which departure it was either way.
-- `pax_removed` is the flat grid the API speaks, e.g. {"ad_fr": 1}.
CREATE TABLE booking_partial_cancels (
  id BIGSERIAL PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  booking_trip_id TEXT,
  service_date DATE,
  pax_removed JSONB NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 0),
  category TEXT,
  grp TEXT CHECK (grp IN ('customer', 'operator', 'other')),
  note TEXT,
  charged_count INTEGER NOT NULL DEFAULT 0 CHECK (charged_count >= 0),
  charged_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (charged_amount >= 0),
  waived_count INTEGER NOT NULL DEFAULT 0 CHECK (waived_count >= 0),
  waived_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (waived_amount >= 0),
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  by TEXT
);
CREATE INDEX booking_partial_cancels_booking ON booking_partial_cancels (booking_id, at, id);

-- Charges listed beside the booking's own price (a reschedule fee collected on the invoice).
-- What the agent owes is `bookings.total` plus these (legacy `acctBookingTotal`); `total` is never
-- changed by a fee, so readers add them up.
CREATE TABLE booking_fee_items (
  id BIGSERIAL PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  label TEXT,
  amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX booking_fee_items_booking ON booking_fee_items (booking_id, at, id);
