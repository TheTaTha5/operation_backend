-- An agent's contracts (todo/contracts-model.md): one `main` contract and time-boxed `promo` overlays,
-- from legacy's sb_contracts and sb_contracts__programperiods (`npm run import:contracts`). Read-only
-- here until the quote prices from them (todo/pricing-model.md).
--
-- Legacy's ids are kept: bookings will refer to a promo by it (`trip.promoId`), and legacy's
-- "first main contract" is the smallest id.

CREATE TABLE contracts (
  id             TEXT PRIMARY KEY,
  agent_id       TEXT NOT NULL REFERENCES agents (id),
  kind           TEXT NOT NULL CHECK (kind IN ('main', 'promo')),
  -- No current legacy writer sets 'void'; two old promos have it.
  status         TEXT NOT NULL CHECK (status IN ('active', 'expired', 'void')),
  -- A main contract's rate; a promo's in 'rate' mode.
  rate_type_id   TEXT REFERENCES rate_types (id),
  -- The travel dates the contract covers.
  active_from    DATE,
  active_to      DATE CHECK (active_to >= active_from),
  -- Between promos covering the same trip, the higher wins (then the later active_from).
  priority       INTEGER NOT NULL,
  version        TEXT,
  -- Promos only: 'rate' (a rate type), 'own' (contract_seat_prices) or 'discount' (off the main rate).
  price_mode     TEXT CHECK (price_mode IN ('rate', 'own', 'discount')),
  discount_mode  TEXT CHECK (discount_mode IN ('pct', 'amt')),
  discount_value NUMERIC(12,2) CHECK (discount_value > 0),
  -- "Buy N, get one free"; a bonus exists when these are set.
  bonus_buy      INTEGER CHECK (bonus_buy >= 1),
  bonus_free     INTEGER CHECK (bonus_free >= 1),
  bonus_basis    TEXT,
  -- The promo also checks the booking date against each period's book window (legacy `bookWin`).
  book_window    BOOLEAN NOT NULL,
  created_date   DATE,
  -- A username as legacy wrote it, a snapshot.
  created_by     TEXT,
  note           TEXT,
  -- Legacy's contract document; it has no home here yet.
  doc_id         TEXT,
  CHECK ((kind = 'promo') = (price_mode IS NOT NULL)),
  CHECK ((price_mode = 'discount') = (discount_mode IS NOT NULL AND discount_value IS NOT NULL)),
  CHECK ((bonus_buy IS NULL) = (bonus_free IS NULL))
);
CREATE INDEX contracts_agent ON contracts (agent_id);

-- The routes a contract covers, and when: the booking window and the travel window.
CREATE TABLE contract_program_periods (
  contract_id  TEXT NOT NULL REFERENCES contracts (id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  route_id     TEXT NOT NULL REFERENCES routes (id),
  book_from    DATE NOT NULL,
  book_to      DATE NOT NULL CHECK (book_to >= book_from),
  -- Missing on archived contracts: legacy reads a missing bound as open.
  travel_from  DATE,
  travel_to    DATE CHECK (travel_to >= travel_from),
  note         TEXT,
  PRIMARY KEY (contract_id, seq)
);

-- An own-price promo's prices, in rate types' vocabulary. A cell missing means the standard rate
-- applies (legacy drops a zone whose adult prices are both 0).
CREATE TABLE contract_seat_prices (
  contract_id TEXT NOT NULL REFERENCES contracts (id) ON DELETE CASCADE,
  route_id    TEXT NOT NULL REFERENCES routes (id),
  zone        TEXT NOT NULL,
  category    TEXT NOT NULL CHECK (category IN ('ad', 'chd')),
  residency   TEXT NOT NULL CHECK (residency IN ('foreign', 'thai')),
  price       NUMERIC(12,2) NOT NULL CHECK (price >= 0),
  PRIMARY KEY (contract_id, route_id, zone, category, residency)
);
