-- The per-departure fields the van board reads: where the passengers are picked up from, when, and
-- whether the trip is one half of an overnight (OVN) stay. Semantics are legacy's
-- (`sb_bookings__trips`, `bkV2CreateOvnReturnLeg` in allotment_v2.html):
--
-- - `zone` is the transfer/pricing zone code, e.g. `PK`, or `NoTransfer` for a self-arrival.
-- - `pickup_time` is the hotel pickup, `HH:MM`, local time. Text rather than TIME so it reads back
--   exactly as written instead of as `08:30:00`.
-- - `ovn` marks an outbound overnight trip: `return` (we bring them back on `ovn_return_date`) or
--   `self` (they make their own way back).
-- - `ovn_leg` marks the return leg itself. It holds seats on the return day like any seat trip.
-- - `ovn_of` is the leg's outbound trip. Legacy stores the outbound's array index; this stores its
--   id, so reordering or removing other trips cannot re-point it. The API still speaks in indexes.
--
-- The cross-trip rules (the leg's route and date match its outbound) are checked by
-- `assertItinerary` in src/domain/operations.ts. The constraints here are the ones a single row can
-- carry. The FK is deferred because a leg and its outbound are written in one transaction, in an
-- order that need not put the outbound first.

ALTER TABLE booking_trips
  ADD COLUMN zone TEXT,
  ADD COLUMN pickup_time TEXT CHECK (pickup_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  ADD COLUMN ovn TEXT CHECK (ovn IN ('return', 'self')),
  ADD COLUMN ovn_return_date DATE,
  ADD COLUMN ovn_leg BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN ovn_of TEXT REFERENCES booking_trips (id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT booking_trips_ovn_return_date_check
    CHECK ((ovn IS NOT DISTINCT FROM 'return') = (ovn_return_date IS NOT NULL) AND (ovn_return_date IS NULL OR ovn_return_date > service_date)),
  ADD CONSTRAINT booking_trips_ovn_leg_check
    CHECK (NOT ovn_leg OR ovn IS NULL),
  ADD CONSTRAINT booking_trips_ovn_of_check
    CHECK (ovn_of IS NULL OR (ovn_leg AND ovn_of <> id));
