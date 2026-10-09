-- Fleet maintenance, part A (todo/fleet-maintenance-model.md, decided 2026-10-09): whether a boat can
-- sail (its status log plus the open work holding it), its engines, gearboxes and propellers, the
-- incidents reported on it and the maintenance jobs that repair it. Legacy keeps all of this as
-- browser data synced into `operation_schemas` (`fleet_engines`, `fleet_incidents`,
-- `fleet_maintenance`, …); `import-fleet.ts` seeds these tables from it.

-- "Planned ahead" (legacy `ovrJobs`, kept in its note as `LA_PLAN_MARK`): the open work a person
-- confirmed the boat sails despite, for the days of this entry. Null: none.
ALTER TABLE boat_status_log ADD COLUMN planned_over TEXT[];

-- ── Engines, gearboxes, propellers (the Asset screens) ──
-- An engine sits on a boat at a position; a gearbox on an engine; a propeller on a gearbox. Legacy
-- has twin propellers on six gearboxes, so a gearbox may carry two here too (the form offers one).
CREATE TABLE fleet_engines (
  id                 TEXT PRIMARY KEY,
  brand              TEXT,
  model              TEXT,
  serial             TEXT,
  hp                 DOUBLE PRECISION CHECK (hp >= 0),
  boat_id            TEXT REFERENCES boats (id),
  pos                TEXT,
  status             TEXT NOT NULL CHECK (status IN ('ready', 'fixing', 'broken', 'spare', 'limited')),
  -- Hours the engine had when it came into the system; the Daily Fleet Log's meter adds to it.
  base_hours         DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (base_hours >= 0),
  service_interval   INTEGER CHECK (service_interval > 0),
  buy_date           DATE,
  price              NUMERIC(12,2) CHECK (price >= 0),
  note               TEXT,
  spare_location     TEXT,
  last_service_hours DOUBLE PRECISION CHECK (last_service_hours >= 0),
  last_service_date  DATE,
  -- Set by closing a job as `decommission`; legacy lost it on reload.
  retired            BOOLEAN NOT NULL DEFAULT false,
  retired_on         DATE,
  retired_reason     TEXT
);
CREATE INDEX fleet_engines_boat ON fleet_engines (boat_id);

CREATE TABLE fleet_gearboxes (
  id                 TEXT PRIMARY KEY,
  brand              TEXT,
  model              TEXT,
  model_suffix       TEXT,
  serial             TEXT,
  boat_id            TEXT REFERENCES boats (id),
  engine_id          TEXT REFERENCES fleet_engines (id),
  -- Left on the boat while its engine is out (a job start's swap), waiting for the replacement.
  on_boat_id         TEXT REFERENCES boats (id),
  on_boat_pos        TEXT,
  status             TEXT NOT NULL CHECK (status IN ('ready', 'fixing', 'broken', 'spare', 'limited')),
  base_hours         DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (base_hours >= 0),
  install_hours      DOUBLE PRECISION,
  service_interval   INTEGER CHECK (service_interval > 0),
  last_service_hours DOUBLE PRECISION CHECK (last_service_hours >= 0),
  last_service_date  DATE,
  buy_date           DATE,
  note               TEXT,
  spare_location     TEXT,
  shaft_length       TEXT,
  rotation           TEXT,
  gear_ratio         TEXT,
  oil_capacity       TEXT
);
CREATE INDEX fleet_gearboxes_engine ON fleet_gearboxes (engine_id);

CREATE TABLE fleet_propellers (
  id             TEXT PRIMARY KEY,
  brand          TEXT,
  serial         TEXT,
  old_serial     TEXT,
  boat_id        TEXT REFERENCES boats (id),
  gearbox_id     TEXT REFERENCES fleet_gearboxes (id),
  prop_pos       TEXT,
  diameter       DOUBLE PRECISION CHECK (diameter >= 0),
  pitch          DOUBLE PRECISION CHECK (pitch >= 0),
  size           TEXT,
  blades         TEXT,
  material       TEXT,
  rotation       TEXT,
  hub_size       TEXT,
  cupping        TEXT,
  cost           NUMERIC(12,2) CHECK (cost >= 0),
  install_hours  DOUBLE PRECISION,
  status         TEXT NOT NULL CHECK (status IN ('active', 'fixing', 'broken', 'spare', 'damaged', 'limited')),
  buy_date       DATE,
  note           TEXT,
  spare_location TEXT
);
CREATE INDEX fleet_propellers_gearbox ON fleet_propellers (gearbox_id);

-- Each asset's history (legacy `*__log`), in order. The three logs have the same columns.
CREATE TABLE fleet_engine_log (
  engine_id    TEXT NOT NULL REFERENCES fleet_engines (id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  date         DATE,
  type         TEXT,
  description  TEXT,
  detail       TEXT,
  text         TEXT,
  hours        DOUBLE PRECISION,
  engine_hours DOUBLE PRECISION,
  used_hours   DOUBLE PRECISION,
  from_loc     TEXT,
  to_loc       TEXT,
  incident_id  TEXT,
  outcome      TEXT,
  cost         NUMERIC(12,2),
  by           TEXT,
  PRIMARY KEY (engine_id, seq)
);
CREATE TABLE fleet_gearbox_log (
  gearbox_id   TEXT NOT NULL REFERENCES fleet_gearboxes (id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  date         DATE,
  type         TEXT,
  description  TEXT,
  detail       TEXT,
  text         TEXT,
  hours        DOUBLE PRECISION,
  engine_hours DOUBLE PRECISION,
  used_hours   DOUBLE PRECISION,
  from_loc     TEXT,
  to_loc       TEXT,
  incident_id  TEXT,
  outcome      TEXT,
  cost         NUMERIC(12,2),
  by           TEXT,
  PRIMARY KEY (gearbox_id, seq)
);
CREATE TABLE fleet_propeller_log (
  propeller_id TEXT NOT NULL REFERENCES fleet_propellers (id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  date         DATE,
  type         TEXT,
  description  TEXT,
  detail       TEXT,
  text         TEXT,
  hours        DOUBLE PRECISION,
  engine_hours DOUBLE PRECISION,
  used_hours   DOUBLE PRECISION,
  from_loc     TEXT,
  to_loc       TEXT,
  incident_id  TEXT,
  outcome      TEXT,
  cost         NUMERIC(12,2),
  by           TEXT,
  PRIMARY KEY (propeller_id, seq)
);

-- ── Incidents ──
-- Numbers are legacy's, given by the client (decision 4): a new number already used is refused, but
-- the duplicates legacy has (INC-012 ten times) are kept, so `no` is not unique. The job link has no
-- foreign key: legacy keeps one to a deleted job, and deleting an incident leaves its job's link.
CREATE TABLE fleet_incidents (
  id              TEXT PRIMARY KEY,
  no              TEXT NOT NULL CHECK (btrim(no) <> ''),
  boat_id         TEXT NOT NULL REFERENCES boats (id),
  date            DATE NOT NULL,
  time            TEXT,
  title           TEXT NOT NULL CHECK (btrim(title) <> ''),
  detail          TEXT,
  remark          TEXT,
  priority        INTEGER CHECK (priority BETWEEN 1 AND 5),
  -- Computed from priority on every save; legacy's one `high` is kept until the incident is edited.
  severity        TEXT,
  -- `inprogress` is not a value legacy writes; one legacy row has it and is kept.
  status          TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'closed', 'inprogress')),
  job_id          TEXT,
  related_job_ids TEXT[] NOT NULL DEFAULT '{}',
  closed_on       DATE,
  quick_fix       BOOLEAN NOT NULL DEFAULT false,
  resolved_on     DATE
);
CREATE INDEX fleet_incidents_no ON fleet_incidents (no);
CREATE INDEX fleet_incidents_boat ON fleet_incidents (boat_id);

CREATE TABLE fleet_incident_assets (
  incident_id TEXT NOT NULL REFERENCES fleet_incidents (id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('engine', 'gearbox', 'propeller', 'hull', 'safety')),
  asset_id    TEXT,
  label       TEXT,
  swapped     BOOLEAN NOT NULL DEFAULT false,
  swapped_to  TEXT,
  swapped_on  DATE,
  PRIMARY KEY (incident_id, idx)
);
CREATE TABLE fleet_incident_log (
  incident_id TEXT NOT NULL REFERENCES fleet_incidents (id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  date        DATE,
  text        TEXT,
  by          TEXT,
  created_on  DATE,
  PRIMARY KEY (incident_id, seq)
);

-- ── Maintenance jobs ──
CREATE TABLE fleet_jobs (
  id                 TEXT PRIMARY KEY,
  no                 TEXT NOT NULL CHECK (btrim(no) <> ''),
  boat_id            TEXT NOT NULL REFERENCES boats (id),
  type               TEXT NOT NULL CHECK (type IN ('corrective', 'preventive', 'scheduled')),
  title              TEXT NOT NULL CHECK (btrim(title) <> ''),
  detail             TEXT,
  location           TEXT,
  status             TEXT NOT NULL CHECK (status IN ('pending', 'inprogress', 'done')),
  start_date         DATE,
  end_date           DATE,
  incident_id        TEXT,
  -- The boat's status while the job runs; null on legacy's older jobs (read as fixing).
  boat_status        TEXT CHECK (boat_status IN ('available', 'fixing', 'unavailable')),
  boat_status_reason TEXT,
  -- false: the work runs alongside the boat and does not hold it.
  set_fixing         BOOLEAN NOT NULL DEFAULT true,
  outcome            TEXT CHECK (outcome IN ('success', 'limited', 'rework', 'decommission', 'cancelled')),
  close_note         TEXT,
  awaiting_invoice   BOOLEAN NOT NULL DEFAULT false,
  parent_project_id  TEXT,
  -- Legacy's stored `cost`, a stale copy of its computed cost (memos and data patches included).
  legacy_cost        NUMERIC(12,2),
  -- The job board's fields, which legacy lost on reload (decision 5).
  board_lane         TEXT CHECK (board_lane IN ('decide', 'wait', 'doing', 'close')),
  owner              TEXT,
  due_date           DATE,
  parked_on          DATE,
  pinned             BOOLEAN NOT NULL DEFAULT false,
  pinned_on          DATE,
  CHECK (end_date IS NULL OR status = 'done')
);
CREATE INDEX fleet_jobs_no ON fleet_jobs (no);
CREATE INDEX fleet_jobs_boat ON fleet_jobs (boat_id);
CREATE INDEX fleet_jobs_incident ON fleet_jobs (incident_id);

CREATE TABLE fleet_job_assets (
  job_id   TEXT NOT NULL REFERENCES fleet_jobs (id) ON DELETE CASCADE,
  idx      INTEGER NOT NULL,
  type     TEXT NOT NULL CHECK (type IN ('engine', 'gearbox', 'propeller', 'hull', 'safety')),
  asset_id TEXT,
  label    TEXT,
  detail   TEXT,
  status   TEXT,
  added_on DATE,
  PRIMARY KEY (job_id, idx)
);
-- Parts taken from stock for the job (legacy `parts`; taking them is part B's stock).
CREATE TABLE fleet_job_parts (
  job_id   TEXT NOT NULL REFERENCES fleet_jobs (id) ON DELETE CASCADE,
  idx      INTEGER NOT NULL,
  id       TEXT,
  inv_id   TEXT,
  name     TEXT,
  qty      NUMERIC NOT NULL DEFAULT 0 CHECK (qty >= 0),
  unit     TEXT,
  cost     NUMERIC(12,2),
  location TEXT,
  date     DATE,
  late     BOOLEAN NOT NULL DEFAULT false,
  late_by  TEXT,
  PRIMARY KEY (job_id, idx)
);
CREATE TABLE fleet_job_log (
  job_id     TEXT NOT NULL REFERENCES fleet_jobs (id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  date       DATE,
  text       TEXT,
  by         TEXT,
  created_on DATE,
  PRIMARY KEY (job_id, seq)
);
-- The job board's sub-steps (legacy `subs`, lost on reload).
CREATE TABLE fleet_job_steps (
  job_id  TEXT NOT NULL REFERENCES fleet_jobs (id) ON DELETE CASCADE,
  idx     INTEGER NOT NULL,
  text    TEXT NOT NULL CHECK (btrim(text) <> ''),
  done    BOOLEAN NOT NULL DEFAULT false,
  done_by TEXT,
  done_on DATE,
  PRIMARY KEY (job_id, idx)
);
