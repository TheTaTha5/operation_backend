-- Fleet projects: drydock, overhaul, refit (todo/fleet-maintenance-model.md, "Design — part B").
-- Legacy, 2026-10-09: 21 projects (PRJ-001…007 are copies of one, imported as they are), 316 log
-- lines, 77 plan items, 75 documents (all photos with an uploaded file). Legacy loses the work-done
-- date, the bill note, a "no cost" close and when the bill closed; they are kept here.

CREATE TABLE fleet_projects (
  id TEXT PRIMARY KEY,
  no TEXT NOT NULL,                                -- the client's number, as legacy's; not checked
  name TEXT NOT NULL,
  boat_id TEXT REFERENCES boats (id),              -- NULL = a General (non-vessel) project
  type TEXT,                                       -- drydock, overhaul, refit, scheduled, other (legacy also has 'general')
  vendor TEXT,
  plan_from DATE,
  plan_to DATE,                                    -- NULL = open-ended
  original_plan_to DATE,                           -- the baseline: plan_to at creation
  actual_from DATE,
  actual_to DATE,
  status TEXT NOT NULL CHECK (status IN ('planned', 'inprogress', 'on_hold', 'awaiting_bill', 'completed', 'cancelled')),
  planned_budget NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (planned_budget >= 0),
  notes TEXT,
  phase TEXT,
  hold_reason TEXT,
  hold_since DATE,
  cancel_reason TEXT,
  cancelled_on DATE,
  work_done_on DATE,
  bill_note TEXT,
  no_cost JSONB,                                   -- {reason, by, at}: closed with no cost
  bill_closed_on DATE,
  created_at TIMESTAMPTZ NOT NULL,
  created_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (plan_to IS NULL OR plan_from IS NULL OR plan_to >= plan_from)
);
ALTER TABLE fleet_memos ADD CONSTRAINT fleet_memos_project_fk FOREIGN KEY (project_id) REFERENCES fleet_projects (id);

CREATE TABLE fleet_project_log (
  id BIGSERIAL PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES fleet_projects (id) ON DELETE CASCADE,
  date DATE NOT NULL,
  text TEXT NOT NULL,
  by TEXT
);
CREATE INDEX fleet_project_log_project_idx ON fleet_project_log (project_id, id);

CREATE TABLE fleet_project_plan (
  project_id TEXT NOT NULL REFERENCES fleet_projects (id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  text TEXT NOT NULL,
  done BOOLEAN NOT NULL DEFAULT false,
  added_at DATE,
  done_date DATE,
  PRIMARY KEY (project_id, id)
);

-- A document or photo: an uploaded file (attachments) or a pasted link, as legacy allows.
CREATE TABLE fleet_project_documents (
  project_id TEXT NOT NULL REFERENCES fleet_projects (id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  name TEXT NOT NULL,
  attachment_id TEXT REFERENCES attachments (id),
  url TEXT,
  mime TEXT,
  size INTEGER,
  note TEXT,
  type TEXT CHECK (type IN ('photo')),
  phase TEXT,
  status TEXT NOT NULL CHECK (status IN ('required', 'pending', 'received', 'verified')),
  added_at DATE,
  by TEXT,
  PRIMARY KEY (project_id, id)
);
CREATE INDEX fleet_project_documents_attachment_idx ON fleet_project_documents (attachment_id) WHERE attachment_id IS NOT NULL;

CREATE TABLE fleet_project_vendor_visits (
  project_id TEXT NOT NULL REFERENCES fleet_projects (id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  vendor TEXT NOT NULL,
  role TEXT,
  date DATE NOT NULL,
  by TEXT,
  PRIMARY KEY (project_id, id)
);
