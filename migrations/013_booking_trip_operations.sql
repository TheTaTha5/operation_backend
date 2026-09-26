-- Day-of-operations dispatch, one row per departure. This is a different domain wearing a
-- booking's clothes: it is written by the ops board (who drives, which boat, did they show up),
-- not the sales form that creates the booking. See `todo/booking-model.md` ("booking_trip_ops").
--
-- `van_splits` is left out. Its shape is still unknown and needs its own look before modelling,
-- per the open item in `todo/booking-model.md`.

CREATE TABLE booking_trip_operations (
  booking_trip_id TEXT PRIMARY KEY REFERENCES booking_trips (id) ON DELETE CASCADE,
  boat_id TEXT,
  van_id TEXT,
  van_return_id TEXT,
  van_group INTEGER,
  van_sequence INTEGER,
  pickup_time_final TEXT,
  return_same_van BOOLEAN,
  alternate_split_auto BOOLEAN,
  upgrade TEXT,
  pier_checkin TEXT,
  van_checkin TEXT,
  reconfirm_status TEXT,
  reconfirm_at TIMESTAMPTZ,
  reconfirm_by TEXT
);
