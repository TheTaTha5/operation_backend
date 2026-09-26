-- Agents (resellers), the markets they sell into, and the salespeople who own them.
--
-- Shape from the frontend porting spec for the Agent List screen (operation_frontend, "Porting spec:
-- Agent List" §3); semantics from legacy `sb_agents`, `sb_markets`, `sb_sales` and their child tables.
-- This is the read-only slice: the tables, the import, and GET endpoints. Writes come later.
--
-- Several of the spec's constraints are loosened here, because legacy data breaks them and the import
-- would fail rather than bring the rows across:
--   * `agents.code` is neither NOT NULL nor UNIQUE. Legacy generated codes from the name and never
--     checked them, so duplicates and blanks exist. The import report lists them for clean-up.
--   * `agents.pay_type` is nullable. A missing payment type is one of legacy's "incomplete" flags
--     (`agIncompleteFields`); about a fifth of agents were unsellable for reasons like this.
--   * Rate seasons, add-on prices and contract history are not here: the first two were never saved to
--     legacy's database, and the last belongs to the Contracts port.

-- Markets (legacy sb_markets). `sort` orders the filter list.
CREATE TABLE markets (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL,
  color TEXT,
  sort  INTEGER
);

-- A market's sub-markets, in legacy's order (sb_markets__subs).
CREATE TABLE market_subs (
  market_id TEXT NOT NULL REFERENCES markets (id) ON DELETE CASCADE,
  idx       INTEGER NOT NULL,
  name      TEXT NOT NULL,
  PRIMARY KEY (market_id, name)
);

-- Salespeople (legacy sb_sales). Never deleted: one who leaves becomes inactive, and their agents
-- keep pointing at them until reassigned.
CREATE TABLE sales_people (
  id          TEXT PRIMARY KEY,
  code        TEXT,
  name        TEXT NOT NULL,
  full_name   TEXT,
  designation TEXT,
  email       TEXT,
  tel         TEXT,
  color       TEXT,
  active      BOOLEAN NOT NULL DEFAULT true
);

-- One reseller. Ids are legacy's (`a01`, `a_b2c`, …) because `bookings.agent_id` and
-- `seat_locks.agent_id` already hold them. Never hard-deleted: bookings point at agents.
CREATE TABLE agents (
  id           TEXT PRIMARY KEY,
  code         TEXT,
  name         TEXT NOT NULL,
  market_id    TEXT REFERENCES markets (id),
  sub_market   TEXT,
  sales_id     TEXT REFERENCES sales_people (id),
  color        TEXT,
  -- Legacy SB_PAYMENT_TYPES. Legacy's edit form wrote `bank` for Bank Transfer; the import maps it to `bt`.
  pay_type     TEXT CHECK (pay_type IN ('invoice', 'proforma', 'bt', 'cot')),
  -- Legacy reads a missing VAT mode as `none` everywhere (`a.vatMode || 'none'`), so that is the default.
  vat_mode     TEXT NOT NULL DEFAULT 'none' CHECK (vat_mode IN ('none', 'include', 'exclude')),
  credit_days  INTEGER,
  credit_limit NUMERIC,
  contact      TEXT,
  email        TEXT,
  phone        TEXT,
  note         TEXT,
  -- No foreign key yet: there is no rate_types table until the Rate Types port.
  rate_type_id         TEXT,
  contract_template_id TEXT,
  contract_status  TEXT,
  contract_version TEXT,
  contract_start   DATE,
  contract_end     DATE,
  -- Company (legacy companyInfo.*)
  legal_name   TEXT,
  tax_id       TEXT,
  tat_license  TEXT,
  address      TEXT,
  company_tel  TEXT,
  hotline      TEXT,
  fax          TEXT,
  website      TEXT,
  -- Who signs for the agent (legacy agentSignatory.*)
  signatory_name        TEXT,
  signatory_designation TEXT,
  signatory_tel         TEXT,
  signatory_signed_date DATE,
  -- How the agent books with us (legacy bookingChannel.*)
  booking_method        TEXT,
  booking_cutoff        TEXT,
  booking_cancel_policy TEXT,
  booking_email         TEXT,
  booking_phone         TEXT,
  -- a_walkin, a_staff, a_b2c: accounts the business itself sells through, not resellers.
  house      BOOLEAN NOT NULL DEFAULT false,
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX agents_market_idx ON agents (market_id);
CREATE INDEX agents_sales_idx ON agents (sales_id);

-- The programmes (routes) an agent may sell, with the booking window sales entered by hand. One list
-- replaces legacy's `programs[]` and `programPeriods[]`, which drifted apart because some screens
-- edited only one. Travel dates are not stored: they come from the rate type (`routeValidity`).
CREATE TABLE agent_programs (
  agent_id  TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  route_id  TEXT NOT NULL REFERENCES routes (id),
  idx       INTEGER NOT NULL,
  book_from DATE,
  book_to   DATE,
  note      TEXT,
  PRIMARY KEY (agent_id, route_id),
  CHECK (book_to IS NULL OR book_from IS NULL OR book_to >= book_from)
);

-- The agent's audit log (legacy sb_agents__activity). Newest first when read.
CREATE TABLE agent_activity (
  id       BIGSERIAL PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  by       TEXT,
  kind     TEXT NOT NULL,
  text     TEXT NOT NULL
);
CREATE INDEX agent_activity_agent_idx ON agent_activity (agent_id, at DESC);
