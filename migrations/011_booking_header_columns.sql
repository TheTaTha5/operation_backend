-- Step 1 of deleting `booking_data`: the header scalars become columns.
--
-- This is the additive half of an expand/contract. Nothing reads these yet and the blob is still
-- written beside them, so this migration is reversible and changes no behaviour on its own. The
-- backfill (step 3) and the contract change that stops returning `booking_data` (step 4) are
-- separate, and the DROP (step 5) is deliberately far off — see `todo/booking-model.md`.
--
-- Everything here is a scalar the frontend writes flat, or a fixed-size struct flattened into
-- columns. Repeating groups — passengers, add-ons, adjustments — are tables, not columns, and
-- land separately.
--
-- Every column is nullable. A booking taken before a field existed genuinely has no value for it,
-- and a DEFAULT would invent one; `pickup_self = false` on a row from before the flag was added is
-- a claim nobody made. Money is NUMERIC rather than a float so totals do not drift by cents.

ALTER TABLE bookings
  ADD COLUMN schema_ver INTEGER,

  -- commercial. `purpose` separates a sale from a staff welfare or inspection booking, which is why
  -- a staff booking can hold seats without being revenue.
  ADD COLUMN sold_by TEXT,
  ADD COLUMN purpose TEXT,
  ADD COLUMN staff_id TEXT,
  ADD COLUMN staff_purpose TEXT,

  ADD COLUMN lead_pax TEXT,
  ADD COLUMN lead_nationality TEXT,
  ADD COLUMN lead_type TEXT,
  ADD COLUMN lead_foc BOOLEAN,
  ADD COLUMN lead_phone TEXT,
  ADD COLUMN lead_email TEXT,

  -- `pickup_area`, `pickup_zone` and `dropoff_area` are denormalized on purpose. They are a
  -- snapshot of what the area was called when the booking was taken; renaming an area must not
  -- silently rewrite the history of every booking that ever used it.
  ADD COLUMN pickup_area_id TEXT,
  ADD COLUMN pickup_self BOOLEAN,
  ADD COLUMN pickup_area TEXT,
  ADD COLUMN pickup_zone TEXT,
  ADD COLUMN hotel_name TEXT,
  ADD COLUMN room_number TEXT,

  ADD COLUMN dropoff_same BOOLEAN,
  ADD COLUMN dropoff_area_id TEXT,
  ADD COLUMN dropoff_area TEXT,
  ADD COLUMN dropoff_hotel_name TEXT,

  -- `guides` is four booleans-and-a-string, not a collection: adding a fifth language is a schema
  -- change whether it lives in JSONB or in columns, so it may as well be constrainable.
  ADD COLUMN guide_english BOOLEAN,
  ADD COLUMN guide_russian BOOLEAN,
  ADD COLUMN guide_chinese BOOLEAN,
  ADD COLUMN guide_other_lang TEXT,

  ADD COLUMN pax_type TEXT,
  ADD COLUMN special_meals_veg INTEGER,
  ADD COLUMN special_meals_vegan INTEGER,
  ADD COLUMN special_meals_halal INTEGER,
  -- The free-text allergy note. The structured `allergyList` the kitchen counts from is a repeating
  -- group and becomes `booking_special_meal_allergies` in stage 3.
  ADD COLUMN special_meals_allergies TEXT,
  ADD COLUMN large_luggage INTEGER,

  ADD COLUMN cash_on_tour_amount NUMERIC(12,2),
  ADD COLUMN cash_on_tour_currency TEXT,
  ADD COLUMN cash_on_tour_handling TEXT,
  ADD COLUMN cash_on_tour_note TEXT,

  -- `priceBreakdown` is a fixed-size snapshot of how the total was reached, kept beside the total
  -- so a reprice later cannot make an old booking unexplainable.
  ADD COLUMN price_mode TEXT,
  ADD COLUMN manual_total NUMERIC(12,2),
  ADD COLUMN total NUMERIC(12,2),
  ADD COLUMN price_seat NUMERIC(12,2),
  ADD COLUMN price_addon NUMERIC(12,2),
  ADD COLUMN price_foc_discount NUMERIC(12,2),
  ADD COLUMN price_discount NUMERIC(12,2),
  ADD COLUMN price_extra NUMERIC(12,2),

  ADD COLUMN payment_method TEXT,
  ADD COLUMN payment_net_days INTEGER,
  ADD COLUMN payment_source TEXT,
  ADD COLUMN payment_contract_version TEXT,

  -- The market snapshot is taken at booking time and never recomputed: an agent moving market next
  -- year must not silently rewrite which market last year's bookings came from.
  ADD COLUMN market TEXT,
  ADD COLUMN market_sub TEXT,
  ADD COLUMN market_agent_id TEXT,
  ADD COLUMN market_at DATE,

  -- `booking_date` is the operational date of sale, editable on the form. `booked_at` is the exact
  -- instant the row was first written. They answer different questions and disagree legitimately.
  ADD COLUMN booking_date DATE,
  ADD COLUMN booked_at TIMESTAMPTZ,
  ADD COLUMN created_by TEXT,
  ADD COLUMN updated_by TEXT,
  ADD COLUMN confirmed_at TIMESTAMPTZ,
  ADD COLUMN confirmed_by TEXT,

  ADD COLUMN notes TEXT,
  ADD COLUMN note TEXT;

COMMENT ON COLUMN bookings.pickup_area IS
  'Area name as it was when the booking was taken. Denormalized deliberately; renaming an area must not rewrite history.';
COMMENT ON COLUMN bookings.total IS
  'Grand total at save time. price_seat + price_addon + price_foc_discount + price_discount + price_extra explain how it was reached.';
COMMENT ON COLUMN bookings.booking_date IS
  'Operational date of sale, editable on the form. booked_at is the instant the row was first written.';
