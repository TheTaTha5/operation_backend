-- Staff and their welfare quotas (todo/sales-editing-model.md, "Design — extras"): legacy's staff
-- registry (`sb_staff`), which kept a quota for 2026 only (`quota_2026`); here one per year.
--
-- `bookings.staff_id` gets no foreign key: the import mirrors legacy's bookings, and legacy deletes
-- staff freely. The booking write path checks a staff id it is sent instead.

CREATE TABLE staff (
  id         TEXT PRIMARY KEY,                     -- st01…, legacy's
  code       TEXT,                                 -- EMP-001…; not unique: legacy's own 24 have 3 clashes
  name       TEXT NOT NULL DEFAULT '',             -- legacy adds a blank row and names it in place
  dept       TEXT,
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Free (FOC) welfare seats a member may take in a year. Used and remaining are computed from bookings.
CREATE TABLE staff_quotas (
  staff_id   TEXT NOT NULL REFERENCES staff (id) ON DELETE CASCADE,
  year       INTEGER NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  free_seats INTEGER NOT NULL CHECK (free_seats >= 0),
  PRIMARY KEY (staff_id, year)
);
