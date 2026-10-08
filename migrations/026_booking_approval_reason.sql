-- Why an approval was asked for: legacy's `approval.reason`, which ops filter the approval queue by
-- (todo/approvals-import-model.md, question 1, approved 2026-10-08).
--
-- This service writes `over_capacity`, `discount` or `over_capacity+discount` for the approvals it
-- asks for. The legacy import also brings legacy's other labels: `closed_day` (sold on a day the
-- route did not run) and `b2c_hold` (held by the B2C sync). An FOC approval has none: its reason is
-- the booking's `foc_reason`. Free text and nullable, so a label legacy adds later cannot fail the
-- import.
ALTER TABLE booking_approvals ADD COLUMN reason TEXT;

-- The approvals this service already asked for, labelled the way it labels new ones.
UPDATE booking_approvals SET reason = CASE
    WHEN over_capacity AND coalesce(discount, 0) > 0 THEN 'over_capacity+discount'
    WHEN over_capacity THEN 'over_capacity'
    WHEN coalesce(discount, 0) > 0 THEN 'discount'
  END
  WHERE kind = 'approval' AND reason IS NULL;
