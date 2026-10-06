-- Routes that are not boat trips.
--
-- Legacy's route list now holds land products alongside the boat programmes: transfers, city tours,
-- and show/park tickets (Fantasea, Hanuman World, …), 43 of 58 routes as of 2026-10-06. Legacy marks
-- them with `routes.kind` and links each to the Love Kingdom catalogue through `routes.extid`.
--
--   * `kind` — `marine` is a boat programme: it has a pier, deployments and seats. `land` has none of
--     these. Legacy leaves `kind` blank on its older routes, all of which are boat programmes, so the
--     default is `marine` and every existing row becomes one.
--   * `ext_id` — Love Kingdom product code, e.g. `TR-001` or `PTP-005:VT-002` (product:variant). Kept as
--     an opaque string; nothing here parses it.
--
-- Deliberately not carried over: `dailycap` (empty on every legacy row) and `mealvenueid` (out of
-- scope, as in 006). The rows themselves arrive through `npm run sync:routes`, not a migration, because
-- ops still edits routes in legacy and a seed would go stale the way 006 did.

ALTER TABLE routes ADD COLUMN kind TEXT NOT NULL DEFAULT 'marine' CHECK (kind IN ('marine', 'land'));
ALTER TABLE routes ADD COLUMN ext_id TEXT;
