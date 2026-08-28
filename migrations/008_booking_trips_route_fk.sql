-- A trip must depart on a route that exists. The catalogue has been seeded since migration 006 and
-- every one of the 3,183 trips in the legacy database resolves against it, so this costs nothing to
-- adopt and closes the gap that let a booking name a route we have never heard of.
--
-- The constraint is a backstop, not the error message: both stores check the route up front and
-- answer 400, because a foreign key violation surfaces as a 500 and tells the caller nothing.
ALTER TABLE booking_trips
  ADD CONSTRAINT booking_trips_route_fk FOREIGN KEY (route_id) REFERENCES routes (id);
