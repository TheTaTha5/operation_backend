-- Rate types: the price lists agents are sold at.
--
-- Legacy keeps them as one document per rate type (`SB_RATE_TYPES` in allotment_v2) shredded into 15
-- tables, several of them wide: a column per zone × pax type, a table per route for transfers, the
-- Selling/Min-sell tiers as a JSON string. Anything outside those columns was dropped on save
-- without a word: Ranong's RN zone, longtail charter rows, transfer prices on most routes, the
-- bundle's applies-to. Here a zone, a boat type, a vehicle or a route is a row, so none of them needs
-- a migration to exist.
--
-- Every constraint below was checked against production legacy on 2026-10-07 (84 rate types, 519
-- route blocks, 250 charter rows; no duplicate code, no negative price, no unknown owner or route).
-- See todo/rate-types-model.md, "Data check". The rows arrive through the importer, a separate
-- change; this migration only makes the place for them.
--
-- Pricing a booking from these rows is a later slice. Only tier 'net' will ever bill.

CREATE TABLE rate_types (
  id                TEXT PRIMARY KEY,
  -- Generated once, never edited: it is what an import matches on.
  code              TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  note              TEXT,
  color             TEXT,
  -- NULL = shared, visible to every salesperson. Legacy wrote '' for that.
  owner_sales_id    TEXT REFERENCES sales_people (id),
  -- The rate's own validity. It does not gate pricing, in legacy or here.
  valid_from        DATE,
  valid_to          DATE,
  active            BOOLEAN NOT NULL DEFAULT true,
  -- NULL = never set, which legacy reads as 'both'. Legacy's 'fr' is stored as 'foreign'.
  nationality_scope TEXT CHECK (nationality_scope IN ('both', 'thai', 'foreign')),
  -- Display label of the private-transfer price ("per trip"); one legacy rate says "per trip · premium".
  transfer_unit     TEXT,
  -- Legacy's createdDate, as legacy wrote it. created_at is this service's.
  created_on        DATE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (valid_from <= valid_to)
);

-- The routes a rate covers, in the editor's order, with the per-route travel window and the
-- longtail bundle. Every price below hangs off one of these rows.
CREATE TABLE rate_type_routes (
  rate_type_id                TEXT NOT NULL REFERENCES rate_types (id) ON DELETE CASCADE,
  route_id                    TEXT NOT NULL REFERENCES routes (id),
  seq                         INTEGER NOT NULL CHECK (seq >= 0),
  travel_from                 DATE,
  travel_to                   DATE,
  -- NULL = no bundle. A bundle folds the longtail into the seat price and locks the join add-on.
  longtail_bundle             TEXT CHECK (longtail_bundle IN ('free', 'paid')),
  longtail_bundle_adult       NUMERIC(12,2) CHECK (longtail_bundle_adult >= 0),
  longtail_bundle_child       NUMERIC(12,2) CHECK (longtail_bundle_child >= 0),
  -- NULL = seat. Legacy never stored it, so every imported bundle has NULL.
  longtail_bundle_applies_to  TEXT CHECK (longtail_bundle_applies_to IN ('seat', 'charter', 'both')),
  PRIMARY KEY (rate_type_id, route_id),
  UNIQUE (rate_type_id, seq),
  CHECK (travel_from <= travel_to)
);

-- One price per cell. category and residency are the booking pax vocabulary (src/domain/pax.ts).
-- Only tier 'net' is ever billed; 'sell' and 'min_sell' are printed on contracts.
-- A zone with no rows is not offered on that route.
CREATE TABLE rate_type_seat_prices (
  rate_type_id  TEXT NOT NULL,
  route_id      TEXT NOT NULL,
  -- PK, KL, NoTransfer, RN …; which zones a route takes depends on its pier, checked by the API.
  zone          TEXT NOT NULL,
  category      TEXT NOT NULL CHECK (category IN ('ad', 'chd', 'inf')),
  residency     TEXT NOT NULL CHECK (residency IN ('foreign', 'thai')),
  tier          TEXT NOT NULL CHECK (tier IN ('net', 'sell', 'min_sell')),
  price         NUMERIC(12,2) NOT NULL CHECK (price >= 0),
  PRIMARY KEY (rate_type_id, route_id, zone, category, residency, tier),
  FOREIGN KEY (rate_type_id, route_id) REFERENCES rate_type_routes ON DELETE CASCADE
);

-- A whole-boat price: starter_price covers starter_includes passengers, each one more costs
-- extra_per_pax. Chosen by the chartered boat's type, lowercase.
CREATE TABLE rate_type_charter_prices (
  rate_type_id      TEXT NOT NULL,
  route_id          TEXT NOT NULL,
  boat_type         TEXT NOT NULL,
  starter_price     NUMERIC(12,2) CHECK (starter_price >= 0),
  starter_includes  INTEGER CHECK (starter_includes >= 1),
  extra_per_pax     NUMERIC(12,2) CHECK (extra_per_pax >= 0),
  PRIMARY KEY (rate_type_id, route_id, boat_type),
  FOREIGN KEY (rate_type_id, route_id) REFERENCES rate_type_routes ON DELETE CASCADE
);

-- The longtail add-on on one route: joining a shared longtail per person, or chartering one.
CREATE TABLE rate_type_longtail_prices (
  rate_type_id      TEXT NOT NULL,
  route_id          TEXT NOT NULL,
  join_adult        NUMERIC(12,2) CHECK (join_adult >= 0),
  join_child        NUMERIC(12,2) CHECK (join_child >= 0),
  charter_price     NUMERIC(12,2) CHECK (charter_price >= 0),
  charter_capacity  INTEGER CHECK (charter_capacity >= 0),
  PRIMARY KEY (rate_type_id, route_id),
  FOREIGN KEY (rate_type_id, route_id) REFERENCES rate_type_routes ON DELETE CASCADE
);

-- A private transfer to one route from one pickup zone, per vehicle.
CREATE TABLE rate_type_transfer_prices (
  rate_type_id  TEXT NOT NULL,
  route_id      TEXT NOT NULL,
  zone          TEXT NOT NULL,
  vehicle       TEXT NOT NULL,
  price         NUMERIC(12,2) NOT NULL CHECK (price >= 0),
  PRIMARY KEY (rate_type_id, route_id, zone, vehicle),
  FOREIGN KEY (rate_type_id, route_id) REFERENCES rate_type_routes ON DELETE CASCADE
);
