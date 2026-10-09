-- Routes and boats are edited here (todo/catalogue-editing-model.md, decided 2026-10-09): legacy's
-- Settings → Programs, its boat form and its day-seats dialog, as an API. `seed:routes` and
-- `seed:boats` replace the old syncs and never overwrite a row edited here (`updated_at` set).

-- Programme families (decision 8): an editable table instead of legacy's two hard-coded lists.
-- Seeded with `_BKV2_FAMILIES` (allotment_v2/js/08-app.js), names and colours as legacy has them.
CREATE TABLE route_families (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL CHECK (btrim(name) <> ''),
  color TEXT CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  sort  INTEGER NOT NULL DEFAULT 0
);
INSERT INTO route_families (id, name, color, sort) VALUES
  ('similan', 'Similan Islands', '#185fa5', 0),
  ('surin', 'Surin Islands', '#3B6D11', 1),
  ('phiphi', 'Phi Phi Bamboo', '#c0392b', 2),
  ('krabi', 'Krabi + Phang Nga', '#0F6E56', 3),
  ('whaleshark', 'Whale Shark Phi Phi Maiton', '#BA7517', 4),
  ('selava', 'Day Trip - Se La Va', '#BA7517', 5),
  ('nyaung', 'Day Trip - Nyaung Oo Phee Island', '#0F6E56', 6),
  ('transfer', 'Transfer', '#5B289A', 7),
  ('citytour', 'City Tour', '#7B4BB7', 8),
  ('activity', 'Activities', '#C77D1E', 9);
-- A family a route already names that legacy's list lacks keeps working, named after its id.
INSERT INTO route_families (id, name, sort)
  SELECT DISTINCT family_id, family_id, 100 FROM routes WHERE family_id IS NOT NULL
  ON CONFLICT (id) DO NOTHING;
ALTER TABLE routes ADD CONSTRAINT routes_family_fk FOREIGN KEY (family_id) REFERENCES route_families (id) ON UPDATE CASCADE;

-- Love Kingdom's code is how its "create a route" stays idempotent (legacy `routes_extid_uq`).
CREATE UNIQUE INDEX routes_ext_id_key ON routes (ext_id) WHERE ext_id IS NOT NULL;
-- Set by every API write. Null means the row is still legacy's copy, which `seed:routes` may refresh.
ALTER TABLE routes ADD COLUMN updated_at TIMESTAMPTZ;

-- Capacity above the licence is accepted, as legacy accepts it (decision 4). Sales stay capped at
-- the licence by `deploymentSeats` (src/domain/capacity.ts), which never read this CHECK.
ALTER TABLE boats DROP CONSTRAINT boats_check;

-- The whole boat form (`saveBoat`, decision 3). Legacy's `use` and `year` are `vessel_use` and
-- `build_year` here; `brand` and `model` had no legacy column and were lost on reload.
ALTER TABLE boats
  ADD COLUMN name_th TEXT,
  ADD COLUMN brand TEXT,
  ADD COLUMN model TEXT,
  ADD COLUMN vessel_use TEXT,
  ADD COLUMN material TEXT,
  ADD COLUMN engine_count INTEGER CHECK (engine_count BETWEEN 1 AND 5),
  ADD COLUMN ownership TEXT NOT NULL DEFAULT 'own' CHECK (ownership IN ('own', 'charter')),
  ADD COLUMN color TEXT CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  ADD COLUMN fish_crew INTEGER CHECK (fish_crew >= 0),
  -- Legacy `totalcap`: persons aboard (passengers + crew). A registration fact, never a selling limit.
  ADD COLUMN registered_persons INTEGER CHECK (registered_persons > 0),
  ADD COLUMN reg TEXT,
  ADD COLUMN callsign TEXT,
  ADD COLUMN imo TEXT,
  ADD COLUMN build_year TEXT,
  ADD COLUMN homeport_city TEXT,
  ADD COLUMN homeport TEXT,
  ADD COLUMN owner TEXT,
  ADD COLUMN owner_addr TEXT,
  ADD COLUMN gt DOUBLE PRECISION CHECK (gt >= 0),
  ADD COLUMN nt DOUBLE PRECISION CHECK (nt >= 0),
  ADD COLUMN dwt DOUBLE PRECISION CHECK (dwt >= 0),
  ADD COLUMN loa DOUBLE PRECISION CHECK (loa >= 0),
  ADD COLUMN beam DOUBLE PRECISION CHECK (beam >= 0),
  ADD COLUMN depth DOUBLE PRECISION CHECK (depth >= 0),
  ADD COLUMN draft DOUBLE PRECISION CHECK (draft >= 0),
  ADD COLUMN lbp DOUBLE PRECISION CHECK (lbp >= 0),
  ADD COLUMN bhp DOUBLE PRECISION CHECK (bhp >= 0),
  ADD COLUMN note TEXT,
  -- Set only by POST /v1/boats/{id}/retire and /restore (decision 13).
  ADD COLUMN retired BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN retired_on DATE,
  ADD COLUMN retired_reason TEXT,
  ADD COLUMN unretired_on DATE,
  -- Set by every API write. Null means the row is still legacy's copy, which `seed:boats` may refresh.
  ADD COLUMN updated_at TIMESTAMPTZ;

-- Certificates on the boat form (`boats.docs`): name and expiry, in the form's order. A renewal adds
-- a row and marks the old one `done` (fleet's `depSave`), so a name may repeat.
CREATE TABLE boat_documents (
  boat_id      TEXT NOT NULL REFERENCES boats (id) ON DELETE CASCADE,
  idx          INTEGER NOT NULL,
  name         TEXT NOT NULL CHECK (btrim(name) <> ''),
  expires_on   DATE,
  renew_status TEXT CHECK (renew_status IN ('processing', 'done')),
  PRIMARY KEY (boat_id, idx)
);

-- The boat's status log (`boats.log`): date ranges of available / fixing / unavailable / retired.
-- Legacy's entry ids repeat (174 rows, 153 distinct per boat), so the seed makes them unique per boat.
CREATE TABLE boat_status_log (
  boat_id    TEXT NOT NULL REFERENCES boats (id) ON DELETE CASCADE,
  id         TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('available', 'fixing', 'unavailable', 'retired')),
  from_date  DATE NOT NULL,
  to_date    DATE,
  loc        TEXT,
  province   TEXT,
  loc_type   TEXT,
  detail     TEXT,
  note       TEXT,
  reason     TEXT,
  project_id TEXT,
  PRIMARY KEY (boat_id, id),
  CHECK (to_date IS NULL OR to_date >= from_date)
);

-- Boat edits reach the change feed (migration 044) as their own kind.
ALTER TABLE changes DROP CONSTRAINT changes_kind_check;
ALTER TABLE changes ADD CONSTRAINT changes_kind_check CHECK (kind IN ('booking', 'seat_lock', 'deployment', 'route', 'invoice', 'weather_closure', 'boat'));
