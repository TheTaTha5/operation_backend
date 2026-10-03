-- A booking's add-ons: longtail join/charter, private transfers, B2C extras.
--
-- `addOns[]` is unbounded, so it is a table, not columns — see the rule in `todo/booking-model.md`
-- and the design in `todo/addons-model.md`. Add-ons belong to the booking only: no frontend writer
-- puts add-ons on a trip, so there is no booking_trip_id. A private transfer names its route
-- inside `type` (`transfer-<routeId>-<zone>-<vehicle>`).
--
-- `type` is the code operations matches on. It is an open set with no catalogue (legacy
-- sb_addon_types is empty and B2C sends its own codes), so it has no FK and no enum CHECK.
--
-- `label` is a display snapshot: what the add-on was called, and sometimes how many, on the day it
-- was sold. A later change to the rate type must not rewrite it.
--
-- `amount` is the line total at save time. It is not guaranteed to add up to
-- bookings.price_addon: a bundled longtail-join keeps an amount it was not charged, and a
-- multi-line B2C order stores 0 per line with the money in price_addon.
--
-- join_adults / join_children: longtail-join only. NULL means nobody narrowed it down and readers
-- count every passenger — the legacy meaning (its migration 031) — so the columns have no default.
--
-- Additive, with no constraints that describe legacy rows yet: qty >= 1, amount >= 0 and
-- join-counts-only-on-longtail-join wait for the data check in todo/addons-model.md. The API
-- enforces them on what it is sent in the meantime.

CREATE TABLE booking_addons (
  booking_id TEXT NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 0),
  type TEXT NOT NULL,
  label TEXT,
  amount NUMERIC(12,2),
  qty INTEGER,
  note TEXT,
  join_adults INTEGER,
  join_children INTEGER,
  PRIMARY KEY (booking_id, seq)
);

COMMENT ON COLUMN booking_addons.amount IS
  'Line total at save time (unit price × qty). Not guaranteed to sum to bookings.price_addon.';
COMMENT ON COLUMN booking_addons.join_adults IS
  'longtail-join only · adults actually taking the longtail · NULL = not narrowed down, count every adult';
COMMENT ON COLUMN booking_addons.join_children IS
  'longtail-join only · children actually taking the longtail · NULL = not narrowed down, count every child';
