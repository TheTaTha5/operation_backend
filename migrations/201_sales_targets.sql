-- The Sales Board (todo/sales-editing-model.md, "Design — extras"): a salesperson's pax target for a
-- month, and their follow-up marks on an agent for a month. Legacy kept both as JSON on the
-- salesperson (`sb_sales.targets`, `sb_sales.followup`); a target of 0 is no target, so it is no row.

CREATE TABLE sales_targets (
  sales_id TEXT NOT NULL REFERENCES sales_people (id) ON DELETE CASCADE,
  month    TEXT NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  pax      INTEGER NOT NULL CHECK (pax > 0),
  set_at   TIMESTAMPTZ NOT NULL,
  set_by   TEXT,
  PRIMARY KEY (sales_id, month)
);

-- `agent`: the salesperson followed the agent up that month; `foc`: collected the agent's feedback on
-- its free seats.
CREATE TABLE sales_followups (
  sales_id  TEXT NOT NULL REFERENCES sales_people (id) ON DELETE CASCADE,
  month     TEXT NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  agent_id  TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  kind      TEXT NOT NULL CHECK (kind IN ('agent', 'foc')),
  marked_at TIMESTAMPTZ NOT NULL,
  marked_by TEXT,
  PRIMARY KEY (sales_id, month, agent_id, kind)
);
