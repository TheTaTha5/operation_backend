-- Whole-boat holds (todo/boat-holds-model.md, approved 2026-10-09): a seat lock naming a boat takes
-- that boat for the day, as a charter does (legacy §bkLock). Legacy, 2026-10-09: 8 holds, 5 active.
-- No key, as deployments.boat_id has none.
ALTER TABLE seat_locks ADD COLUMN boat_id TEXT;
