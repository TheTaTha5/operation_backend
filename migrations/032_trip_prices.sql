-- Bookings priced by the server (README "Prices"). A booking's price becomes
-- `priceBooking`'s answer (src/domain/pricing.ts); each trip keeps what it was priced at, so an edit
-- can keep the rate a trip was sold at (legacy lost this: it kept one rate for the whole booking).
--
-- Computed: `subtotal`, `rate_type_id`, `promo_id`. Client facts: the overnight charge and the
-- charter's manual price. Nullable, no default: an imported trip has what legacy stored, and legacy
-- never kept the rate a trip was priced at.

ALTER TABLE booking_trips
  ADD COLUMN subtotal NUMERIC(12,2),
  ADD COLUMN rate_type_id TEXT REFERENCES rate_types (id),
  ADD COLUMN promo_id TEXT REFERENCES contracts (id),
  ADD COLUMN ovn_charge NUMERIC(12,2) CHECK (ovn_charge >= 0),
  ADD COLUMN charter_price_mode TEXT CHECK (charter_price_mode IN ('rate', 'manual')),
  ADD COLUMN charter_price_manual NUMERIC(12,2) CHECK (charter_price_manual >= 0),
  ADD COLUMN charter_price_note TEXT;

-- Migration 029's comment said a missing cell falls back to the standard rate; legacy, and
-- priceBooking, replace a promo's zone whole.
COMMENT ON TABLE contract_seat_prices IS
  'An own-price promo''s prices. A zone present here replaces the base rate''s zone whole; a cell missing in it is 0 (legacy laPromoRate).';
