-- Staff logins and what each may do (todo/login-permissions-model.md). Login moves here from legacy:
-- its users are imported with their usernames and scrypt password hashes as they are, so everyone
-- keeps their password, and `POST /v1/login` replaces Authentik and the `AUTH_PASSWORD_USERS` list.
--
-- Legacy kept the permissions inside its 30-day cookie and checked areas only in the browser. Here
-- they are read from this table on every request, and every write is checked against them.

CREATE TABLE users (
  id                 BIGSERIAL PRIMARY KEY,
  username           TEXT NOT NULL CHECK (btrim(username) <> ''),
  -- Legacy's format: scrypt (N=16384, r=8, p=1), 16-byte salt and 32-byte key, hex, `salt:key`.
  -- NULL: the user cannot log in.
  pass_hash          TEXT CHECK (pass_hash ~ '^[0-9a-f]{32}:[0-9a-f]{64}$'),
  name               TEXT,
  role               TEXT NOT NULL CHECK (role IN ('admin', 'staff')),
  -- Legacy `editInfo`: a list of areas decides what may be edited, and `can_edit` is read only when
  -- there is no list (then it means every area).
  can_edit           BOOLEAN NOT NULL DEFAULT true,
  edit_areas         TEXT[] CHECK (edit_areas <@ ARRAY['overview', 'operations', 'sales', 'accounting', 'fleet', 'pier', 'config']),
  -- Action rights: `act-approve` (approve over the allotment and FOC), and legacy's `act-capunlock`
  -- and `act-tmpl`.
  actions            TEXT[] NOT NULL DEFAULT '{}' CHECK (actions <@ ARRAY['act-approve', 'act-capunlock', 'act-tmpl']),
  -- The pages legacy shows (its `perms` less the actions). A client concern: returned by
  -- `GET /v1/me`, never enforced here.
  view_perms         TEXT[],
  -- The salesperson this user is: they approve discounts on their agents' bookings.
  sales_id           TEXT REFERENCES sales_people (id),
  -- A login that books for one agent only (Love Kingdom's service user, `a_b2c`).
  agent_id           TEXT REFERENCES agents (id),
  dept               TEXT,
  disabled_at        TIMESTAMPTZ,
  -- Legacy `logout_after`: a token issued at or before this instant is refused.
  tokens_valid_after TIMESTAMPTZ,
  legacy_id          INTEGER UNIQUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username ON users (lower(username));
