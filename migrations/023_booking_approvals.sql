-- What a booking waited for before it could be confirmed, and how it was decided.
--
-- Legacy's save decides a booking's status in the browser (`bkV2CommitBooking`): over the company's
-- allotment but within the boat's licence, or carrying a discount, it is saved `pending_approval`;
-- with FOC (free) passengers, `pending_foc`. It keeps the request on the booking document
-- (`approval`, `focApproval`) and overwrites it on the next one. This service now decides the
-- status itself (todo/booking-authority-model.md, phase 2), so the requests are rows: one per
-- approval asked for, kept after it is decided.
--
-- Additive, no backfill. Legacy's seven `pending_approval` bookings have no approval record, which
-- legacy reads as "holds its seats", and so does this service.

-- The reason legacy requires before FOC passengers can be confirmed. A client fact.
ALTER TABLE bookings ADD COLUMN foc_reason TEXT;

CREATE TABLE booking_approvals (
  id            BIGSERIAL PRIMARY KEY,
  booking_id    TEXT NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  -- 'approval': over the allotment and/or a discount (legacy `approval`); 'foc': free passengers
  -- (legacy `focApproval`).
  kind          TEXT NOT NULL CHECK (kind IN ('approval', 'foc')),
  -- 'replaced': a later edit asked for a new approval before this one was decided.
  status        TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'replaced')),
  -- Over the allotment: while pending, the booking holds no seats (legacy `bkPendHoldsSeat`).
  over_capacity BOOLEAN NOT NULL,
  over_total    INTEGER CHECK (over_total >= 0),
  discount      NUMERIC(12,2) CHECK (discount >= 0),
  foc_count     INTEGER CHECK (foc_count >= 0),
  -- The status approve moves the booking to: confirmed, pending_foc or quote.
  target_status TEXT NOT NULL,
  requested_by  TEXT,
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by    TEXT,
  decided_at    TIMESTAMPTZ,
  note          TEXT
);
CREATE INDEX booking_approvals_booking ON booking_approvals (booking_id, requested_at, id);
-- The seat count asks, for every booking it weighs, whether one of these is pending and over capacity.
CREATE INDEX booking_approvals_pending ON booking_approvals (booking_id) WHERE status = 'pending';

-- The days an over-allotment approval is about (legacy `approval.over[]`), as they were when asked.
CREATE TABLE booking_approval_days (
  approval_id   BIGINT NOT NULL REFERENCES booking_approvals (id) ON DELETE CASCADE,
  route_id      TEXT NOT NULL,
  service_date  DATE NOT NULL,
  need          INTEGER NOT NULL CHECK (need > 0),
  over_by       INTEGER NOT NULL CHECK (over_by > 0),
  PRIMARY KEY (approval_id, route_id, service_date)
);
