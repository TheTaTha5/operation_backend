-- Check-in (slice C of todo/trip-ops-and-vans-model.md), per departure, per side (van or pier), per
-- van part. slot is the part's idx; 0 is the main part. Legacy kept the times staff type as clock
-- text (HH:MM) and the instants as ISO, so both are here. Legacy, 2026-10-09: 1,821 van and 2,156
-- pier records, 90 events, 4 of them undone.

CREATE TABLE booking_trip_checkins (
  booking_trip_id TEXT NOT NULL REFERENCES booking_trips (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('van', 'pier')),
  slot INTEGER NOT NULL CHECK (slot >= 0),
  expected INTEGER CHECK (expected >= 0),
  actual_pax INTEGER CHECK (actual_pax >= 0),
  checked_in_at TIMESTAMPTZ,                 -- legacy at; NULL = not checked in
  checked_in_by TEXT,
  reason_code TEXT,                          -- not_down, sick, cancel_onsite, no_contact, own_transfer, other
  reason_note TEXT,
  reason_at TEXT CHECK (reason_at ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  arrived_at TIMESTAMPTZ, arrived_by TEXT,   -- pier stages (§pierStage)
  cleared_at TIMESTAMPTZ, cleared_by TEXT,
  flow TEXT CHECK (flow IN ('standby', 'pending')),   -- van row state; the rest is derived from at/events
  flow_at TEXT CHECK (flow_at ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  flow_by TEXT, flow_note TEXT,
  reinstate_at TEXT CHECK (reinstate_at ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  reinstate_by TEXT, reinstate_ts TIMESTAMPTZ,
  self_add_pax INTEGER CHECK (self_add_pax >= 0),    -- came to the pier on their own
  self_add_ad INTEGER, self_add_chd INTEGER, self_add_inf INTEGER, self_add_foc INTEGER,
  self_add_at TEXT, self_add_by TEXT, self_add_ts TIMESTAMPTZ, self_add_note TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT,
  PRIMARY KEY (booking_trip_id, kind, slot)
);

-- No-show and on-site cancellations, in order. Never deleted: a mistaken one is marked undone.
CREATE TABLE booking_trip_checkin_events (
  booking_trip_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  slot INTEGER NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 0),
  type TEXT NOT NULL CHECK (type IN ('no_show', 'cxl')),
  pax INTEGER NOT NULL CHECK (pax >= 0),
  ad INTEGER, chd INTEGER, inf INTEGER, foc INTEGER,  -- legacy paxBreak; absent on 3 of 90
  reason_code TEXT, note TEXT,
  at TEXT CHECK (at ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  by TEXT, ts TIMESTAMPTZ,
  undone_why TEXT CHECK (undone_why IN ('found', 'mistake')),
  undone_at TEXT, undone_by TEXT, undone_ts TIMESTAMPTZ, undone_note TEXT,
  PRIMARY KEY (booking_trip_id, kind, slot, seq),
  FOREIGN KEY (booking_trip_id, kind, slot) REFERENCES booking_trip_checkins ON DELETE CASCADE
);

-- Each time staff went back for a no-show and still didn't find them (legacy §ckBack "วนแล้วไม่เจอ",
-- events[].tries). It changes no count. Not in the 2026-10-06 design: legacy's screen started writing
-- it after the data check, and no legacy row has one yet.
CREATE TABLE booking_trip_checkin_event_tries (
  booking_trip_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  slot INTEGER NOT NULL,
  event_seq INTEGER NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 0),
  at TEXT CHECK (at ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  by TEXT, note TEXT, ts TIMESTAMPTZ,
  PRIMARY KEY (booking_trip_id, kind, slot, event_seq, seq),
  FOREIGN KEY (booking_trip_id, kind, slot, event_seq) REFERENCES booking_trip_checkin_events ON DELETE CASCADE
);
