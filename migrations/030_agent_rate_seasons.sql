-- Which rate type an agent is priced at, by travel date (README, "Rate seasons"): legacy's
-- `§rtSeason`. A season runs from `from_date`, to `to_date` or with no end; the latest `from_date`
-- covering a date wins, and a date no season covers is priced at `agents.rate_type_id`.
--
-- Legacy keeps these only in browsers, so there is nothing to import: sales re-enter them
-- (`PUT /v1/agents/{id}/rate-seasons`).

CREATE TABLE agent_rate_seasons (
  agent_id     TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  from_date    DATE NOT NULL,
  to_date      DATE CHECK (to_date >= from_date),
  rate_type_id TEXT NOT NULL REFERENCES rate_types (id),
  PRIMARY KEY (agent_id, from_date)
);
CREATE INDEX agent_rate_seasons_rate_type ON agent_rate_seasons (rate_type_id);
