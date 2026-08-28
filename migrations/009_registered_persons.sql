-- `total_capacity` was imported from the legacy `totalcap`, which is license_pax + crew — the total
-- persons a vessel may carry, not a passenger limit. The charter path used it as a selling ceiling,
-- so a boat registered for 45 passengers and 3 crew could be sold 48 charter seats.
--
-- The column keeps the registration fact and loses the name that invited the mistake. Nothing reads
-- it for selling any more; the passenger ceiling is license_pax, falling back to capacity for the
-- boats that have no licence on file.
ALTER TABLE deployments RENAME COLUMN total_capacity TO registered_persons;
COMMENT ON COLUMN deployments.registered_persons IS
  'Registered total persons aboard (passengers + crew). A vessel registration fact. NOT a selling ceiling — use license_pax.';
