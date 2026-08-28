-- The CHECK allowed two of the ten statuses the frontend writes, so eight of them could not be
-- stored at all. In the legacy production data six are in use: confirmed, cancelled,
-- cancelled_weather, pending_approval, quote and rejected. Collapsing the four we could not
-- represent would have been silent and wrong in both directions — squashing the seven
-- pending_approval bookings to cancelled releases seats they are holding, and calling the five
-- quotes confirmed sells them.
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check CHECK (status IN (
  'draft', 'quote', 'pending', 'pending_approval', 'pending_foc',
  'confirmed', 'completed', 'rejected', 'cancelled', 'cancelled_weather'
));

-- Which of them hold seats is not encoded here on purpose. It is a denylist in
-- `src/domain/booking-status.ts` — cancelled, rejected and cancelled_weather release, everything
-- else holds — and the capacity query is passed that list as a parameter. A generated column or a
-- second CHECK would be the same rule written twice, and the stores would drift.
COMMENT ON COLUMN bookings.status IS
  'Lifecycle status. Seats are released by cancelled, rejected and cancelled_weather; every other status holds them. See src/domain/booking-status.ts.';
