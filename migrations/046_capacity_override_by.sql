-- Who raised a boat's capacity for a day, and when (todo/boat-assignment-model.md, approved
-- 2026-10-09). Legacy recorded '—' on all six of its overrides; the trip-ops raise records the login.
ALTER TABLE boat_capacity_overrides ADD COLUMN set_by TEXT, ADD COLUMN set_at TIMESTAMPTZ;
