-- Van job orders (todo/van-job-orders-model.md, decided 2026-10-09): the special request a sheet
-- prints, "sent to the driver" per job, Thai names for pickup places, and the order staff put van
-- groups in. The sheets themselves are computed (src/domain/van-jobs.ts) and not stored. Legacy,
-- 2026-10-09: 449 sent marks, 10 special-request overrides (5 blanked), 762 Thai names, 13 orders.

-- The special request the job order prints (legacy VANJOB_SREQ). NULL = the booking's notes;
-- '' = print nothing, legacy's blanked override ("some requests aren't van-related").
ALTER TABLE bookings ADD COLUMN job_note TEXT;

-- Sent to the driver, per job (legacy VANJOB_SENT). An outbound job is a van group, so its mark
-- follows the group through a renumbering or a second round, and goes with it. A van that only
-- brings people back on a route has no group there: its mark is keyed by date, route and van.
-- `fingerprint` is the sheet as sent (van-jobs.ts `sheetFingerprint`); NULL = imported from legacy,
-- which kept none, so whether it changed since is unknown.
CREATE TABLE van_job_sends (
  id BIGSERIAL PRIMARY KEY,
  group_id TEXT UNIQUE REFERENCES van_groups (id) ON DELETE CASCADE,
  service_date DATE,
  route_id TEXT REFERENCES routes (id),
  van_id TEXT REFERENCES vans (id) ON DELETE CASCADE,
  sent_at TIMESTAMPTZ NOT NULL,
  sent_by TEXT,
  fingerprint TEXT,
  CHECK (CASE WHEN group_id IS NULL THEN num_nonnulls(service_date, route_id, van_id) = 3
              ELSE num_nonnulls(service_date, route_id, van_id) = 0 END)
);
CREATE UNIQUE INDEX van_job_sends_return_only ON van_job_sends (service_date, route_id, van_id) WHERE group_id IS NULL;

-- One mark per van and day (migration 016) becomes one per job: every group that van had that day.
INSERT INTO van_job_sends (group_id, sent_at)
  SELECT g.id, d.sent_at FROM van_days d JOIN van_groups g ON g.van_id = d.van_id AND g.service_date = d.service_date
  WHERE d.sent_at IS NOT NULL;
ALTER TABLE van_days DROP COLUMN sent_at;
-- A day that held only the mark now holds nothing, and the stores keep no row for nothing.
DELETE FROM van_days WHERE num_nonnulls(status, zone, driver, driver_phone, plate) = 0;

-- The Thai name printed under a pickup place (legacy VANJOB_PICKUP_TH), typed once and used on
-- every sheet. Keyed by the place as typed, trimmed and lower-cased (van-jobs.ts `pickupNameKey`),
-- so "Book a Bed Poshtel" and "Book A Bed Poshtel" share one.
CREATE TABLE pickup_name_th (
  name_key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_th TEXT NOT NULL CHECK (name_th <> ''),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT
);

-- The order staff dragged a route's groups into, per zone (legacy bkv2_grp_order). NULL = after the
-- ordered ones, by number. The board and the job orders both follow it.
ALTER TABLE van_groups ADD COLUMN display_order INTEGER CHECK (display_order > 0);
