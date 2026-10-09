-- The checks todo/addons-model.md proposed for booking_addons, decided 2026-10-09. Every one holds on
-- legacy's 712 rows (data check, same day). One per type per booking is deliberately left out: Love
-- Kingdom doesn't enforce it, and a booking must not be refused for it.
ALTER TABLE booking_addons
  ADD CONSTRAINT booking_addons_qty_check CHECK (qty >= 1),
  ADD CONSTRAINT booking_addons_amount_check CHECK (amount >= 0),
  ADD CONSTRAINT booking_addons_join_counts_check CHECK (join_adults >= 0 AND join_children >= 0),
  ADD CONSTRAINT booking_addons_join_only_check
    CHECK ((join_adults IS NULL AND join_children IS NULL) OR type LIKE 'longtail-join%');
