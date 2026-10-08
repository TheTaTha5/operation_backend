# Login, users and permissions, modelled

- **Source:** wt-lk-inbox@658298d — root `server.js` (`hashPw`, `verifyPw`, `/api/login`,
  `/api/logout`, `revokeSessions`, `/api/me`, `/api/users*`, `editInfo`); `01-auth-sync.js`
  (`laCanEdit`, `laCanEditArea`, `laGuardEdit`, `laIsAdmin`, `laCanAct`, `__laUsers`);
  `db/baseline/operation_schemas_20260820.sql` (`users`).
- **Already here:** `src/auth.ts` accepts Authentik Bearer JWTs (JWKS) and HS256 tokens from
  `/v1/login`, whose users are a plain-text list in `AUTH_PASSWORD_USERS` (testing only). One hook
  maps every route to `booking:read/write` or `operations:read/write`; group `admin` passes all.
  Writes are signed with the token's username (`actorOf`).

## What legacy does

- **Users** in `users`: `username` (unique, matched case-insensitively), `pass_hash` = scrypt
  `salt:hash` (hex; Node defaults N=16384, r=8, p=1; key 32 bytes), `name`, `role` (`admin` |
  `staff`), `can_edit`, `edit_areas` (JSON list or null = "everything if `can_edit`"), `perms`
  (pages it may view, plus action keys such as `act-capunlock`), `dept`, `sales_id` (the
  salesperson the user is), `logout_after`.
- **Login** gives a 30-day signed cookie that carries the permissions themselves, so a change of
  role or a deleted user keeps working until logout. No lockout or rate limit.
- **Edit areas:** `overview, operations, sales, accounting, fleet, pier, config`. Bookings and seat
  locks → `operations`; rate types, agents → `sales`; boat deployment → `operations` (Boat
  Operation) and `fleet` (Fleet Deployment); routes, boats, calendar → `config`.
- **Enforced only in the browser.** The server checks "may edit anything" and nothing more, so any
  editing user can write any area — and approve anything — through the API.
- **Approvals check no one.** Over-allotment and discount approval: the approver types a name;
  the UI says "manager" and "the agent's salesperson" but checks neither. FOC: hard-coded `'RM'`.

## Proposal

**Schema** (migration):

```sql
CREATE TABLE users (
  id            BIGSERIAL PRIMARY KEY,
  username      TEXT NOT NULL,
  pass_hash     TEXT,                    -- scrypt salt:hash, legacy's format; NULL = cannot log in
  name          TEXT,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'staff')),
  can_edit      BOOLEAN NOT NULL,
  edit_areas    TEXT[],                  -- NULL = every area when can_edit
  actions       TEXT[] NOT NULL DEFAULT '{}',  -- act-capunlock, act-approve, act-foc, …
  sales_id      TEXT REFERENCES sales_people (id),
  dept          TEXT,
  disabled_at   TIMESTAMPTZ,
  tokens_valid_after TIMESTAMPTZ,        -- legacy logout_after: tokens issued before are refused
  legacy_id     INTEGER UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username ON users (lower(username));
```

Legacy's `perms` (which pages to show) is a client concern: kept as `view_perms TEXT[]` only for
`GET /v1/me`, never enforced here.

**Login:**

- `POST /v1/login {username, password}` verifies legacy's scrypt hashes as they are. It issues a
  12-hour HS256 token carrying only the user id and username.
- Permissions are read from `users` on every request, not baked into the token. A change of role,
  a disable or a password reset takes effect at once (fixes legacy).
- `POST /v1/logout` sets `tokens_valid_after`.
- Failed logins: 5 in 15 minutes for one username → `429` for 15 minutes.

**Permissions** (validated on every write, in one hook):

| Area | Routes |
|---|---|
| `operations` | bookings and their commands and actions, seat locks, `/operations/*`, manifest |
| `sales` | rate types, agents |
| `config` | routes, boats, calendar writes |
| `fleet` | boat catalogue edits, capacity overrides |

- `admin` passes everything. `can_edit = false` is read-only.
- **Approve over the allotment:** `admin` or the action `act-approve`.
- **Approve a discount:** the agent's salesperson (`users.sales_id = agents.sales_id`) or `admin`.
- **Approve FOC:** `admin` or `act-foc`.
- A refusal is `403` naming what is missing (`needs the sales area`).

**Endpoints:**

- `GET /v1/me` → `{username, name, role, can_edit, edit_areas, actions, sales_id, view_perms}`.
- `GET/POST /v1/users`; `PATCH /v1/users/{id}` (role, areas, actions, disable);
  `POST /v1/users/{id}/password` (admin sets it); `POST /v1/me/password` (own, needs the old one).
  Admin only. Never a hard delete: `disabled_at`.

**Import:** `src/tools/import-legacy.ts` copies `users` (read-only from legacy) by `legacy_id`,
hashes as they are. Users made here are never touched by the import.

## Questions

1. **Authentik:** drop the Authentik token path once users are imported (recommended: one login,
   CLAUDE.md), or keep both?
2. **Who approves over the allotment:** `admin` + `act-approve` as proposed? Legacy checks no one;
   this is a new rule.
3. **Discount approval by the agent's salesperson only** (what legacy's UI says), plus `admin`?
4. **FOC approval:** who, given legacy hard-codes `'RM'`?
5. **Love Kingdom** calls the API as a machine. A service user with area `operations` limited to its
   own agent (`a_b2c`): recommended. Or a separate API key?
6. **Rate limit numbers** (5 in 15 min): fine?
