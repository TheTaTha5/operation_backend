-- A pickup time is a window or a pier deadline, not one clock time (todo/pickup-window-model.md).
--
-- Legacy's pickup-area table gives a trip `07:30-07:45` (the van comes between these times) or
-- `Before 08:30 at pier` (the guest makes their own way to the pier by then). 015 kept only `HH:MM`,
-- so neither could be saved. The window's start stays in `pickup_time`; the end and the pier flag
-- are new. The dispatcher's final time on `booking_trip_operations` gets the same pair.
--
-- The rules between the three columns are checked by `pickupProblem` (src/domain/pickup.ts) before
-- a write, with a message the screen can show; the constraints here repeat them so no other writer
-- (the importer) can store a window the API would refuse. Additive: existing rows have no end and
-- are not at the pier, which every rule allows.

ALTER TABLE booking_trips
  ADD COLUMN pickup_time_end TEXT CHECK (pickup_time_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  ADD COLUMN pickup_at_pier BOOLEAN NOT NULL DEFAULT false,
  ADD CONSTRAINT booking_trips_pickup_window_check CHECK (
    CASE WHEN pickup_at_pier THEN pickup_time IS NULL AND pickup_time_end IS NOT NULL
         ELSE pickup_time_end IS NULL OR (pickup_time IS NOT NULL AND pickup_time_end > pickup_time) END
  );

ALTER TABLE booking_trip_operations
  ADD COLUMN pickup_time_final_end TEXT CHECK (pickup_time_final_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  ADD COLUMN pickup_final_at_pier BOOLEAN NOT NULL DEFAULT false,
  ADD CONSTRAINT booking_trip_operations_pickup_final_window_check CHECK (
    CASE WHEN pickup_final_at_pier THEN pickup_time_final IS NULL AND pickup_time_final_end IS NOT NULL
         ELSE pickup_time_final_end IS NULL OR (pickup_time_final IS NOT NULL AND pickup_time_final_end > pickup_time_final) END
  );
