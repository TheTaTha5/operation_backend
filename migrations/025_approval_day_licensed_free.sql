-- The registered (licence) seats left on each day an over-allotment approval is about, as they were
-- when it was asked for: legacy's `approval.over[].licFree`, the approval card's "Real seats left"
-- (todo/approval-licensed-free-model.md).
--
-- Computed by `weighDay` (src/domain/capacity.ts), never taken from a request. A day goes to
-- approval only while its need fits the licence, so the value is at least `need`. Rows written
-- before this migration have no recorded value and stay NULL: it cannot be reconstructed.

ALTER TABLE booking_approval_days
  ADD COLUMN licensed_free INTEGER,
  ADD CONSTRAINT booking_approval_days_licensed_free_check CHECK (licensed_free >= need);
