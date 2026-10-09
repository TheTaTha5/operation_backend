-- The allergy list and who changed the meals at the pier (todo/booking-extras-model.md §2, approved
-- 2026-10-09). Legacy, same day: 29 bookings have a list (at most 5 entries, qty 1, 2 or 4). Legacy's
-- pier meal editor also writes specialMeals.pierAt/pierBy, which legacy has no column for and loses.

-- What the kitchen counts from (legacy specialMeals.allergyList). The free text stays in
-- bookings.special_meals_allergies.
CREATE TABLE booking_allergies (
  booking_id TEXT NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 0),
  name TEXT NOT NULL CHECK (btrim(name) <> ''),
  qty INTEGER NOT NULL CHECK (qty >= 1),           -- people
  PRIMARY KEY (booking_id, seq)
);

-- Stamped by PUT /v1/bookings/{id}/meals (the pier's meal editor), never sent.
ALTER TABLE bookings
  ADD COLUMN special_meals_pier_at TIMESTAMPTZ,
  ADD COLUMN special_meals_pier_by TEXT;
