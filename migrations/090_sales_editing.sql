-- Sales editing (todo/sales-editing-model.md, decided 2026-10-09): agents, salespeople and markets are
-- edited here now, with contract templates and the contract documents issued to agents.

-- `a_company` is the business's own account, as `a_walkin`, `a_staff` and `a_b2c` are (decision 14).
UPDATE agents SET house = true WHERE id = 'a_company';

-- A salesperson's signature, printed on the contracts they sign: a `data:image/…;base64,` URL, as
-- legacy stores it (`sb_sales.signature`, shrunk to 900 px in the browser before it is saved).
ALTER TABLE sales_people ADD COLUMN signature TEXT;

-- What a renewal archives (legacy `contractHistory`, `ctRenewActivate`): the agent's contract fields
-- before the renewal, and the rate, programmes and signatory they had. Renewing edits the agent and
-- makes no contract row (decision 6); this is the record of what came before.
CREATE TABLE agent_contract_history (
  id             BIGSERIAL PRIMARY KEY,
  agent_id       TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  version        TEXT,
  archived_at    DATE NOT NULL,
  contract_start DATE,
  contract_end   DATE,
  -- A snapshot: the rate type may be deleted later, so no foreign key.
  rate_type_id   TEXT,
  -- `[{route_id, book_from, book_to, note}]`, the programmes as they were.
  programs       JSONB NOT NULL DEFAULT '[]',
  -- `{name, designation, tel, signed_date}`, or null when legacy kept none.
  signatory      JSONB,
  archived_by    TEXT
);
CREATE INDEX agent_contract_history_agent ON agent_contract_history (agent_id);

-- Contract templates (legacy `contract_templates`): the wording and style a contract document is
-- printed with. `sections` (which sections print) and `text` (`{en: {key: text}, th: {…}}`) are the
-- screen's own vocabulary; the server stores them and checks only their shape. The code is unique
-- for a new or changed one, checked by the write: legacy has two templates sharing CT-06.
CREATE TABLE contract_templates (
  id           TEXT PRIMARY KEY,
  code         TEXT NOT NULL,
  name         TEXT NOT NULL,
  active       BOOLEAN NOT NULL DEFAULT true,
  is_default   BOOLEAN NOT NULL DEFAULT false,
  created_date DATE,
  note         TEXT,
  form         TEXT,
  accent       TEXT,
  accent_hex   TEXT,
  font         TEXT,
  sections     JSONB NOT NULL DEFAULT '{}',
  text         JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The default prints for every agent bound to none, so it can never be switched off.
  CHECK (active OR NOT is_default)
);
-- Exactly one default once there are templates (legacy `cttSetDefault`).
CREATE UNIQUE INDEX contract_templates_one_default ON contract_templates (is_default) WHERE is_default;

-- The contract documents issued to an agent (legacy `agent_artifacts`), frozen as they were printed:
-- a template edited later must not change a contract already signed. Never edited; removable.
CREATE TABLE contract_documents (
  id             TEXT PRIMARY KEY,
  agent_id       TEXT NOT NULL REFERENCES agents (id),
  contract_id    TEXT REFERENCES contracts (id) ON DELETE SET NULL,
  version        TEXT NOT NULL,
  lang           TEXT CHECK (lang IN ('en', 'th')),
  generated_at   TIMESTAMPTZ NOT NULL,
  generated_by   TEXT,
  -- Snapshots, so no foreign keys: the template or rate may change or go later.
  template_id    TEXT,
  template_name  TEXT,
  rate_type_ref  TEXT,
  rate_type_name TEXT,
  page_count     INTEGER CHECK (page_count >= 0),
  -- The render as printed: sections, style, the template's text, overrides and custom clauses.
  content        JSONB NOT NULL
);
CREATE INDEX contract_documents_agent ON contract_documents (agent_id, generated_at DESC);
