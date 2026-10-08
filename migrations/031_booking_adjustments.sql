-- A booking's adjustments: the discounts and extra charges staff add on the review step
-- (todo/adjustments-model.md), legacy's `adjustments[]` (sb_bookings__adjustments). Until now this
-- API dropped them on save and kept only their totals (`price_discount`, `price_extra`).
--
-- Client facts. The quote (todo/pricing-model.md) prices them as legacy does: a `percent` discount
-- off seats + add-ons, an `amount` discount and any extra at their value.

CREATE TABLE booking_adjustments (
  booking_id TEXT NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('discount', 'extra')),
  mode       TEXT NOT NULL CHECK (mode IN ('amount', 'percent')),
  value      NUMERIC(12,2) NOT NULL CHECK (value > 0),
  label      TEXT,
  note       TEXT,
  PRIMARY KEY (booking_id, seq)
);
