-- Whole-boat holds made, edited, released and converted here (todo/seat-lock-extras-model.md,
-- "Design — whole-boat holds"; legacy §bkLock). 047 gave a hold its boat; this adds what legacy's
-- Hold-whole-boat form keeps beside it: the deal (`fixed` this boat / `any` boat that big, legacy's
-- reused `subName`) and the booking a hold became (legacy's `convert` log line), with its status.

ALTER TABLE seat_locks DROP CONSTRAINT seat_locks_status_check;
ALTER TABLE seat_locks ADD CONSTRAINT seat_locks_status_check CHECK (status IN ('active', 'released', 'converted'));

-- Legacy reads a missing `subName` as fixed, so every hold so far is fixed.
ALTER TABLE seat_locks ADD COLUMN boat_deal TEXT CHECK (boat_deal IN ('fixed', 'any'));
-- No key, as seat_lock_events.booking_id has none: the import writes locks before bookings.
ALTER TABLE seat_locks ADD COLUMN converted_booking_id TEXT;
UPDATE seat_locks SET boat_deal = 'fixed' WHERE boat_id IS NOT NULL;

ALTER TABLE seat_locks
  ADD CONSTRAINT seat_locks_boat_deal CHECK ((boat_id IS NULL) = (boat_deal IS NULL)),
  ADD CONSTRAINT seat_locks_converted CHECK ((status = 'converted') = (converted_booking_id IS NOT NULL)),
  ADD CONSTRAINT seat_locks_converted_hold CHECK (status <> 'converted' OR boat_id IS NOT NULL);
