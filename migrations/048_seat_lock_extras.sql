-- Seat-lock extras (todo/seat-lock-extras-model.md, decided 2026-10-09): what legacy's Seat Locks tab
-- has beyond one route, one day, N seats: bulk locks, sub-groups, pending seats, expiry, reason,
-- holders, released seats kept apart, and a log written by the server.
--
-- A bulk lock is a `seat_lock_groups` row plus one ordinary lock per departure, each with `group_id`,
-- so every seat count keeps working on day locks. A sub-group (legacy "A / B / C") is a lock with
-- `parent_id`, on its parent's route and day; only its parent holds seats in the pool. One level.
--
-- Nothing here is decided in SQL: what a lock holds, may give, has pending, and whether it is expired
-- or overdue are worked out on read (src/domain/seat-locks.ts), so both stores answer the same.

CREATE TABLE seat_lock_groups (
  id                  TEXT PRIMARY KEY,
  version             INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  route_id            TEXT NOT NULL REFERENCES routes (id),
  holder_type         TEXT NOT NULL CHECK (holder_type IN ('agent', 'office', 'global')),
  agent_id            TEXT REFERENCES agents (id),
  date_from           DATE NOT NULL,
  date_to             DATE NOT NULL,
  -- 0 = Sunday … 6 = Saturday, as legacy's `dow`. Empty = every day the route runs.
  weekdays            SMALLINT[] NOT NULL DEFAULT '{}' CHECK (weekdays <@ ARRAY[0,1,2,3,4,5,6]::SMALLINT[]),
  -- Seats asked per departure, as last set for the whole bulk lock. One departure may differ.
  pax                 INTEGER NOT NULL CHECK (pax > 0),
  -- The release cutoff: "N days before the departure, at HH:MM" (Asia/Bangkok). A warning only
  -- (legacy §lkNoAuto): past it a departure reads `overdue` and still holds until released by hand.
  release_days_before INTEGER CHECK (release_days_before >= 0),
  release_time        TEXT CHECK (release_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  reason              TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by          TEXT,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (date_to >= date_from),
  CHECK ((release_days_before IS NULL) = (release_time IS NULL)),
  CHECK ((holder_type = 'agent') = (agent_id IS NOT NULL))
);

ALTER TABLE seat_locks
  -- `agent` serves that agent's bookings only; `office` and `global` serve any booking.
  ADD COLUMN holder_type  TEXT NOT NULL DEFAULT 'office' CHECK (holder_type IN ('agent', 'office', 'global')),
  -- Of `pax`: seats asked for but not free yet (they hold nothing), and seats given back by a release.
  -- `pax` is never lowered by a release, so what was asked is kept (decision 7).
  ADD COLUMN pending_pax  INTEGER NOT NULL DEFAULT 0 CHECK (pending_pax >= 0),
  ADD COLUMN released_pax INTEGER NOT NULL DEFAULT 0 CHECK (released_pax >= 0),
  -- Past this day (Asia/Bangkok) a lock stops holding. Worked out on read; nothing rewrites `status`.
  ADD COLUMN expiry       DATE,
  ADD COLUMN reason       TEXT,
  ADD COLUMN group_id     TEXT REFERENCES seat_lock_groups (id),
  ADD COLUMN parent_id    TEXT REFERENCES seat_locks (id),
  ADD COLUMN sub_name     TEXT,
  ADD COLUMN created_by   TEXT;

UPDATE seat_locks SET holder_type = 'agent' WHERE agent_id IS NOT NULL;
-- Decision 8–9: an agent lock needs a real agent. The import wrote legacy's free-text holders as an
-- `agent_id` that names no agent; they become office locks with the name kept in the reason.
UPDATE seat_locks l
   SET holder_type = 'office', reason = l.agent_id || COALESCE(' · ' || l.reason, ''), agent_id = NULL
 WHERE l.agent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.id = l.agent_id);

ALTER TABLE seat_locks
  ADD CONSTRAINT seat_locks_agent_fk FOREIGN KEY (agent_id) REFERENCES agents (id),
  ADD CONSTRAINT seat_locks_holder_agent CHECK ((holder_type = 'agent') = (agent_id IS NOT NULL)),
  ADD CONSTRAINT seat_locks_parts_fit CHECK (pending_pax + released_pax <= pax),
  ADD CONSTRAINT seat_locks_sub_group_named CHECK ((parent_id IS NULL) = (sub_name IS NULL)),
  ADD CONSTRAINT seat_locks_sub_group_not_self CHECK (parent_id IS DISTINCT FROM id),
  -- Pending seats are asked of the pool, which only a top-level lock does.
  ADD CONSTRAINT seat_locks_sub_group_no_pending CHECK (parent_id IS NULL OR pending_pax = 0);

CREATE INDEX seat_locks_group_idx ON seat_locks (group_id) WHERE group_id IS NOT NULL;
CREATE INDEX seat_locks_parent_idx ON seat_locks (parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX seat_locks_day_idx ON seat_locks (route_id, service_date);

-- The lock log (legacy `sb_seat_locks.log`): written by the server in the same transaction as the
-- change, never by a client. A bulk lock's own lines have `group_id` and no `lock_id`; a line about
-- one departure has both. Legacy's lines are imported with `imported`; many have no time or user.
CREATE TABLE seat_lock_events (
  id         BIGSERIAL PRIMARY KEY,
  lock_id    TEXT REFERENCES seat_locks (id) ON DELETE CASCADE,
  group_id   TEXT REFERENCES seat_lock_groups (id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  qty        INTEGER,
  trip_date  DATE,
  booking_id TEXT,
  note       TEXT,
  day        DATE NOT NULL,
  at         TIMESTAMPTZ,
  by         TEXT,
  imported   BOOLEAN NOT NULL DEFAULT false,
  CHECK (lock_id IS NOT NULL OR group_id IS NOT NULL)
);
CREATE INDEX seat_lock_events_lock_idx ON seat_lock_events (lock_id) WHERE lock_id IS NOT NULL;
CREATE INDEX seat_lock_events_group_idx ON seat_lock_events (group_id) WHERE group_id IS NOT NULL;
