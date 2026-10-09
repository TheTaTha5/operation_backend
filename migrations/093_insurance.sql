-- Insurance (todo/sales-editing-model.md, decision 12): each passenger's age for the insurer, and who
-- reviewed the row and when, kept on the passenger rather than beside the booking. Legacy keeps them
-- apart (`insurance_overrides`, keyed `<booking>::lead` or `<booking>::<position>`), so removing a
-- passenger moved an age onto the next one. Set by `PUT /v1/bookings/{id}/insurance` only.
-- Ages may be fractional (an infant of 2.5); legacy has one over 100, so no upper bound.
ALTER TABLE bookings
  ADD COLUMN lead_age NUMERIC(6,2) CHECK (lead_age >= 0),
  ADD COLUMN lead_insurance_reviewed_at TIMESTAMPTZ,
  ADD COLUMN lead_insurance_reviewed_by TEXT;

ALTER TABLE booking_passengers
  ADD COLUMN age NUMERIC(6,2) CHECK (age >= 0),
  ADD COLUMN insurance_reviewed_at TIMESTAMPTZ,
  ADD COLUMN insurance_reviewed_by TEXT;
