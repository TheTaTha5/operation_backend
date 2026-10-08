# Operation Backend

Fastify service for boat deployments, operational capacity, bookings, and agent seat locks. Set `DATABASE_URL` to use PostgreSQL; without it, the service uses an in-process store for local testing.

## Live API documentation

When the service is running, the interactive Swagger UI is available at `/docs` (for example,
`http://localhost:3000/docs`). It is generated from the deployed Fastify routes, so frontend
integrators can view the current API and try requests without maintaining a separate OpenAPI file.
The raw generated OpenAPI document is available at `/docs/json`.

The routes an external sales channel needs (routes, availability, bookings, cancel, seat locks)
carry request and response descriptions from `src/routes/openapi.ts`. Those schemas are
**documentation only**: the route parsers validate, and responses are sent unfiltered. Keep them in
step with this README by hand. For a sales channel's walkthrough, see
`docs/love-kingdom-integration.md`.

## Requirements

- Node.js 20 or newer

## Getting started

```bash
npm install
export DATABASE_URL='postgresql://USER:PASSWORD@HOST:5432/DATABASE'
npm run db:migrate
npm run dev
```

## Run locally with Docker

`docker-compose.yml` runs PostgreSQL 18 (as on Railway), the API, built by `Dockerfile` the way
Railway builds it and migrated on start, and the legacy app from the integration worktree.

```bash
docker compose up -d --build                 # API on :3000 (docs on /docs), legacy app on :8791
docker compose --profile pull run --rm pull  # copy Railway's and legacy's data into the local db
```

- **The database** listens on host port **55433** (5432 and 5433 are often a local PostgreSQL, and 55432 is the legacy repo's dev database), user and
  password `postgres`. It holds two databases: `operations`, the API's, and `legacy`, a copy of
  legacy's.
- **`pull`** dumps the database at `.env`'s `DATABASE_URL` (Railway) into `operations` and the one
  at `ORIGINAL_DATABASE_URL` (legacy production, about 860 MB) into `legacy`, replacing both. The
  dumps run in read-only sessions and are kept in `.docker/dumps` (git-ignored);
  `SKIP_DUMP=1 docker compose --profile pull run --rm pull` restores those again without
  fetching. The API's connections are closed while it restores; it reconnects on its own.
- **The legacy app** (`integration`) runs the `integration/operation-backend` worktree at
  `../wt-operation-backend-integration` (`INTEGRATION_DIR` in `.env` to change it), mounted
  read-only, on http://localhost:8791/allotment_v2/allotment_v2.html. It runs as that branch is
  deployed: `LA_LEGACY_SYNC=false`, so all its data comes from the local API, and server.js gets no
  database. Log in as `admin` / `admin`, the local API's only user (`AUTH_PASSWORD_USERS` in the
  compose file). A change to its files shows on reload; a change to its `server.js` needs
  `docker compose restart integration`.
- **The API ignores `.env`.** Its `DATABASE_URL` is set in the compose file, so it can never write
  to Railway. Every request needs a Bearer token: get one with
  `curl -X POST localhost:3000/v1/login -H 'content-type: application/json' -d '{"username":"admin","password":"admin"}'`.
  `LOCAL_CORS_ORIGIN` in `.env` changes the browser origins allowed to call it (default
  `http://localhost:8791,http://localhost:5173`).
- **The sync tools and the import** run from the host against the local copies:

  ```bash
  SOURCE_DATABASE_URL=postgres://postgres:postgres@localhost:55433/legacy \
  TARGET_DATABASE_URL=postgres://postgres:postgres@localhost:55433/operations npm run sync:routes
  ```

- **Tests** want an empty database, not the copy: `docker compose exec db createdb -U postgres
  ops_test`, then `DATABASE_URL=postgres://postgres:postgres@localhost:55433/ops_test npm run db:migrate`
  and `npm test` with the same `DATABASE_URL`.

## Commands

| Command | Description |
| --- | --- |
| `npm run dev` | Start with file watching. |
| `npm run build` | Compile TypeScript into `dist/`. |
| `npm start` | Run the compiled service. |
| `npm test` | Run HTTP route tests. |
| `DATABASE_URL=… npm test` | Run the same tests against PostgreSQL instead of the in-process store. Use a fresh, empty database. Three test files run at a time (`--test-concurrency=3`), as on CI's runner: with a test-sized database PostgreSQL watches whole tables for serialization conflicts, so eleven files at once on a many-core machine made unrelated bookings collide until a request ran out of retries (`40001`, a `500`), about one test per run, on `main` too. |
| `npm run check` | Type-check the source. |
| `npm run db:migrate` | Apply PostgreSQL migrations. |
| `SOURCE_DATABASE_URL=… TARGET_DATABASE_URL=… npm run sync:routes [-- --commit]` | Copy the route catalogue (routes and times) from the legacy database. A dry run that prints the diff unless `--commit` is given. Re-runnable: legacy wins for every route it has, and a route only this service has is reported, never deleted. Seasons and day overrides are copied only for a route new to this service; after that the calendar is edited here (see "Editing the calendar"), and the run only reports where legacy's differs. |
| `SOURCE_DATABASE_URL=… TARGET_DATABASE_URL=… npm run sync:boats [-- --commit]` | Copy the boat catalogue from the legacy database, the same way: dry run unless `--commit`, legacy wins, never deletes. Legacy's `totalcap` is never read, and a boat selling more seats than its licence is skipped and listed, not clamped. Run the import afterwards so deployments pick up new or changed boats. |

Migrations are applied once and recorded in `schema_migrations`, so re-running is a no-op and a migration need not be idempotent. Each file and its ledger row commit together — a failure rolls the whole file back and records nothing. A session advisory lock serializes concurrent deploys. Migrations are checksummed, with line endings normalized to LF so a Windows checkout (`core.autocrlf`) and a Railway build agree: editing one that has already run is reported as a warning, because that database no longer matches a freshly migrated one. Fix such drift with a new migration rather than by editing history.

Deploys migrate themselves. `railway.json` runs `node dist/migrate.js` as `preDeployCommand`, so the schema moves after the build and before the new version takes traffic; if the migration fails the deploy is aborted and the previous version keeps serving. It runs the compiled migrator rather than `npm run db:migrate`, because that script goes through `tsx`, a devDependency the production build prunes. Run `npm run db:migrate` by hand for local databases, or against a production URL when you want to watch a destructive migration go in before deploying the code that needs it.

## Authentik OIDC authentication

> **Planned:** login moves to this service. Legacy's users are imported here and `POST /v1/login`
> becomes the real login. The design (users, permissions, approvals) is pending in
> `todo/login-permissions-model.md`. Until it ships, the two sections below describe what the code
> does today (`src/auth.ts`).

Once authentication is on, every API route needs a Bearer token, except `POST /v1/login`,
`/health` and `/docs`. It is on when `OIDC_ISSUER` and `OIDC_AUDIENCE` are both set, or when
`AUTH_JWT_SECRET` is set (see the next section):

```text
AUTH_REQUIRED=true
OIDC_ISSUER=https://auth.example.com/application/o/operation-backend
OIDC_AUDIENCE=operation-backend
```

`OIDC_ISSUER` is the issuer URL displayed by the Authentik OAuth2/OIDC provider; do not substitute the Authentik root URL. The API obtains the provider's JWKS URL from OIDC discovery and validates Bearer access tokens for the configured issuer and audience. A token must have a `sub` claim.

Send `Authorization: Bearer <access token>` on every request. A missing, invalid or expired token is `401`. Permissions come from the token's `scope` claim (space-separated) or its `groups` claim; either may carry these names:

| API area | Read permission | Write permission |
| --- | --- | --- |
| Everything under `/v1/` except `/v1/manifest`: routes, boats, availability, bookings, seat locks, agents, markets, salespeople, rate types | `booking:read` | `booking:write` |
| `/operations/…` (deployments, allotment) and `/v1/manifest` | `operations:read` | `operations:write` |

A `GET` needs the read permission; any other method needs the write permission. A token without it is `403`.

## Temporary password login (testing only)

`POST /v1/login` exchanges a username/password for a short-lived Bearer token this service will
itself accept. Today its users are a plain-text list in an environment variable, so it is for
testing only and not meant to stay configured as it is. The plan (above) is to make it the real
login, with users imported from legacy.

```text
AUTH_JWT_SECRET=<random string, e.g. `openssl rand -base64 32`>
AUTH_PASSWORD_USERS=[{"username":"ops","password":"...","groups":["admin"]}]
```

`AUTH_PASSWORD_USERS` is a JSON array of `{username, password, groups}`; a malformed value stops
the service at startup. `groups` follows the same permission table above (`admin` grants
everything). Setting `AUTH_JWT_SECRET` turns authentication on by itself, even without OIDC. Both
variables can be set alongside `OIDC_ISSUER`/`OIDC_AUDIENCE` — a request's Bearer token is checked
against whichever of the two are configured. `POST /v1/login` itself is always public. It answers
`400` when `username` or `password` is missing, and `401` for a wrong pair or when
`AUTH_JWT_SECRET` is not set.

```bash
curl -X POST https://<host>/v1/login -H 'Content-Type: application/json' \
  -d '{"username":"ops","password":"..."}'
# {"access_token":"...","token_type":"Bearer","expires_in":43200}
```

The token is HS256, signed with `AUTH_JWT_SECRET`, expires after 12 hours, and is otherwise an
ordinary Bearer token: `Authorization: Bearer <access_token>` on any request. Its `sub` and
`preferred_username` are the username, and it carries the user's `groups`. Rotate
`AUTH_JWT_SECRET` (which invalidates every outstanding token) and remove these two variables once
testing is done.

The `admin` group grants every permission. `CORS_ORIGIN` must contain the frontend's exact HTTPS origin (multiple values can be comma-separated); those origins may use `GET`, `HEAD`, `POST`, `PUT`, `PATCH` and `DELETE`. The health endpoint remains public. Authentication is off only when neither complete OIDC configuration (`OIDC_ISSUER` and `OIDC_AUDIENCE`) nor `AUTH_JWT_SECRET` is set, which supports local tests; set `AUTH_REQUIRED=true` in Railway so that case stops the service at startup instead.

## API

Dates are ISO `YYYY-MM-DD`; passenger counts (`pax`) and deployment `capacity` are positive integers. All availability calculations are scoped to `route_id` plus service date. A booking or seat lock on a day the route does not run is refused (`409 route_closed`, see "Closed days"). A marine day with no boat deployed yet sells without a seat check, and a land route has no seat limit (see "Land routes and days with no boat").

### Catalogue

Reference data every other endpoint refers to by id.

- `GET /v1/routes` — the route catalogue. With `from=&to=` each route also carries its operating
  calendar resolved per date, as `days[date] = { open, source }`, where `source` names the rule that
  decided it. The range is capped at 400 days, and `from`/`to` must be supplied together.
  Each route is `{ id, name, kind, ext_id?, pier?, family_id?, color?, islands?, sort?, times }`.
  `kind=marine` or `kind=land` lists only that kind (`400` for anything else).
  Each route also carries its calendar as stored, for the screen that edits it:
  `seasons: [{ id, kind, from_date, to_date }]` by start date, and `overrides: [{ service_date, kind }]`.
- `GET /v1/boats` — the boat catalogue: `{ id, name, type?, pier?, capacity, license_pax,
  charter_ceiling, crew? }`.

**Not every route is a boat trip.** `kind` is `marine` for a boat programme (it has a pier,
deployments and seats) and `land` for a transfer, city tour or show/park ticket, which has none of
these. `ext_id` is a land product's Love Kingdom code, e.g. `PTP-005:VT-002` (product, then variant);
treat it as opaque. A calendar or seat view wants `kind=marine`. A land route has no seat limit:
see "Land routes and days with no boat" below.

#### Closed days

A booking cannot be sold on a day its route does not run, the calendar `GET /v1/routes?from=&to=`
shows. The answer is `409` with `code: "route_closed"` and a message a staff screen can show as it
is: `Route Day Trip - Se La Va (r7) does not run on 2027-01-04` (several, joined by `; `).

| Write | What is checked |
| --- | --- |
| `POST /v1/bookings` | every trip |
| `PATCH /v1/bookings/{id}` | only trips it adds, or moves to another route or day |
| `POST /v1/bookings/{id}/reschedule` | the trips it moves |
| `POST /v1/bookings/{id}/restore` | every trip |
| `POST /v1/seat-locks` | its day |
| `/confirm`, `/approve`, `/reject`, `/cancel`, partial cancel | nothing: they do not choose a day |

A trip a `PATCH` leaves where it is was sold already, so a booking whose day closed after the sale
can still have its notes edited. (Legacy blocks every save of such a booking.) A booking whose
`external_id` starts with `b2c_`, legacy's mark for one synced from the B2C website, is saved on a
closed day on create and `PATCH`, as legacy saves it: it was paid before it arrived. Love Kingdom's
own bookings (`LOV-…`) are checked like any other.

Seasons may overlap; the one that starts first decides a day, as in legacy.

#### Editing the calendar

Legacy's Settings → Programs, as an API. The calendar is edited here and only here: `sync:routes`
no longer copies it from legacy. Every write needs `operations:write`.

- `POST /v1/routes/{id}/seasons` `{ kind: "open"|"closed", from_date, to_date, close_anyway? }` →
  `201` with the season and its `id`. A season is added or deleted, never edited, as in legacy.
  Overlaps are allowed.
- `DELETE /v1/routes/{id}/seasons/{season_id}[?close_anyway=true]` → `204`.
- `PUT /v1/routes/{id}/days/{date}` `{ kind: "open"|"closed", close_anyway? }` → `200` with the
  override: that day is open or closed whatever the seasons say.
- `DELETE /v1/routes/{id}/days/{date}[?close_anyway=true]` → `204`: the seasons decide it again.

**Closing a day that holds something.** Any change that turns a day from open to closed while it
holds a booking (any status but `cancelled`, `rejected`, `cancelled_weather`) or a deployed boat,
from today (Thai time) on, is `409` with `code: "bookings_on_closed_day"` and a message listing them:
`This closes days on r3 that hold 2 bookings (BK-1 on 2027-01-04, …) and 1 boat deployment (…).`
Send it again with `close_anyway: true` (a query parameter on `DELETE`) to close them anyway; the
bookings stay as they are. This is legacy's "Close anyway" dialog. Legacy only asks when a closed
season is added or a day is toggled closed; here it is asked for every change that can close a day,
including an open season added to a route that had none (which closes every date outside it) and a
deleted open season.

`400` for a bad `kind` or date, or `to_date` before `from_date`; `404` for an unknown route, season,
or a day with no override to remove.

#### Land routes and days with no boat

Both sell without a seat check, as legacy does (`hasAllotment` false):

- **A land route** (`kind: "land"`) has no seat pool. Any number of passengers can be booked or
  locked, and availability answers `available_seats: null` with `unlimited: true`.
- **A marine day with no boat deployed yet** is sold before the boats are assigned. Availability
  answers `available_seats: 0` and `unplaced_pax`: the passengers sold and the seats locked that
  day, waiting for a boat. Once a boat is deployed the day is checked as usual, and a day already
  sold past the boat shows a negative `available_seats`.

Seats drawn from a lock are still limited by the lock, and a charter still needs its boat deployed.

Routes and boats are still edited in legacy (the calendar is not: see "Editing the calendar").
`npm run sync:routes` and `npm run sync:boats` copy them here, and are meant to be run again whenever legacy has changed (see
Commands). A boat missing here is not just a missing row: the import skips every deployment on it,
so its seats are absent from `GET /v1/availability`. Run `sync:boats` before the import.

`GET /v1/boats` is deliberately **not** date-aware. `boat_capacity_overrides` changes one boat's
seats for one day, but `GET /v1/availability` already resolves that against the day's deployment,
and answering the same question in two places invites the two answers to disagree.

`charter_ceiling` is how many passengers a charter may fill the boat to, resolved for you.
`license_pax` is `null` for a boat with no licence on file — three Ranong boats have none — and in
that case `charter_ceiling` falls back to `capacity`. **A missing licence is not a licence of zero.**
The null is reported rather than quietly replaced by `capacity`, because claiming a registration a
vessel does not hold is worse than saying it has none; read `charter_ceiling` for the number and
`license_pax` for whether it is a legal figure or a fallback.

### Agents

Resellers, the markets they sell into, and the salespeople who own them. **Read-only for now.**
Agents arrive through the legacy import (`src/tools/import-legacy.ts`) with legacy's ids (`a01`,
`a_b2c`, …), which are the ids `bookings.agent_id` and `seat_locks.agent_id` already hold. Creating
and editing agents comes later. All of these are under `booking:read`.

**Every caller sees every agent.** Legacy hid other salespeople's agents only in the browser. Doing
it here needs the caller's salesperson id in the token, and that has not been decided yet.

- `GET /v1/markets`: `{ markets: [{ id, name, color, sort, subs: [name…] }] }`, by `sort` (unsorted
  last), then id.
- `GET /v1/sales`: `{ sales: [{ id, code, name, full_name, designation, email, tel, color, active }] }`,
  by name. An inactive salesperson can still own agents.
- `GET /v1/agents?market=&sales=&q=&active=`: summary rows for the list, its filters and header
  counts, A–Z by name (case-insensitive), then id.
  - `market` and `sales` are ids.
  - `q` matches name, code, sub-market, market name and salesperson name, case-insensitively.
  - `active` is `true` (the default), `false`, or `all`.

  ```jsonc
  { "agents": [ { "id": "a12", "code": "SUNTOUR", "name": "Sun Tour", "market_id": "ru",
    "sub_market": "Moscow", "sales_id": "s3", "color": null, "pay_type": "invoice",
    "vat_mode": "exclude", "credit_limit": 200000, "rate_type_id": "rt007",
    "program_route_ids": ["r5", "r6"], "contract_status": "active", "contract_end": "2026-12-31",
    "incomplete": [], "house": false, "active": true } ] }
  ```
- `GET /v1/agents/{id}`: the whole agent, `404` if unknown. It has the summary's fields except
  `program_route_ids`, plus `credit_days`, `contact`, `email`, `phone`, `note`,
  `contract_template_id`, `contract_version`, `contract_start`, `created_at` and `updated_at`. It
  also has these groups:
  - `company`: `{ legal_name, tax_id, tat_license, address, tel, hotline, fax, website }`
  - `signatory`: `{ name, designation, tel, signed_date }`
  - `booking_channel`: `{ method, cutoff, cancel_policy, email, phone }`
  - `programs`: `[{ route_id, book_from, book_to, note }]` in the agent's order
- `GET /v1/agents/{id}/activity?limit=`: the audit log, newest first:
  `{ activity: [{ at, by, kind, text }] }`. `limit` defaults to 50 and may be 1–200. `404` if the
  agent is unknown.

Field notes:

- **Every field is always present.** A value that is not set is `null`, never omitted.
- **`pay_type`** is `invoice`, `proforma`, `bt` or `cot`, or `null` when legacy had none. Legacy's
  edit form wrote `bank`; the import maps it to `bt`.
- **`vat_mode`** is `none`, `include` or `exclude`. It is never null, because legacy reads a
  missing VAT mode as `none`.
- **`incomplete`** lists what the profile lacks before the agent can be sold correctly, in this
  order: `market`, `sales`, `pay_type`, `rate_type`, `programs`, `contact`. This is legacy's
  `agIncompleteFields`. Any one of email, phone or contact counts as contact.
- **`programs`** are the routes the agent may sell. `book_from`/`book_to` is the booking window sales
  entered, and `null` means open. Travel dates are not stored: they come from the rate type (see
  [Rate types](#rate-types)).
- **`house`** marks `a_walkin`, `a_staff` and `a_b2c`: accounts the business sells through itself.
- **`rate_type_id`** is the rate type the agent is priced with (see [Rate types](#rate-types)). It
  is not validated yet. The foreign key is a migration that can only ship after the import has run
  in production: before it, agents hold rate type ids that `rate_types` does not have yet.
- **Not here yet:** credit used and available (needs invoices and payments, which this service
  doesn't have), rate seasons and add-on prices (legacy never saved them to its database), and
  contract history (the Contracts port).

### Rate types

A rate type is a price list: what an agent pays per seat on each route and pickup zone, per charter
boat, and per add-on. All of these are under `booking:read` / `booking:write`, like agents. Nothing
prices a booking from them yet; that is the quote, a later slice (`todo/rate-types-model.md`).

Rate types arrive through the legacy import (`src/tools/import-legacy.ts`) with legacy's ids
(`rt003`, `rt_staff`, …), which are the ids `agents.rate_type_id` and `bookings.rate_type_ref`
already hold. Until cutover legacy is the master, and each import run replaces only what legacy's
tables can hold: seat prices in zones PK, KL and NoTransfer, speedboat and catamaran charters, the
longtail add-on, and transfers on r4, r5, r6, r10, r11 and r12. Legacy dropped everything else on
save, so it can only be entered here, and the import keeps it: RN prices, longtail charters,
transfers on other routes, a bundle's `applies_to`. A legacy price changed here is put back by the
next import run, so change those in legacy until cutover.

- `GET /v1/rate-types?active=&q=`: summary rows, A–Z by name (case-insensitive), then id.
  - `active` is `true` (the default), `false`, or `all`.
  - `q` matches code or name, case-insensitively.

  ```jsonc
  { "rate_types": [ { "id": "rt003", "code": "NOK-STD", "name": "Standard 2026", "color": "#1683C7",
    "active": true, "owner": "s1", "valid_from": "2026-01-01", "valid_to": "2026-10-31",
    "nationality_scope": "both", "priced_routes": ["r5", "r6"],
    "route_validity": { "r5": { "from": "2025-11-01", "to": "2026-04-30" } } } ] }
  ```
- `GET /v1/rate-types/{id}`: the summary's fields plus `note`, `transfer_unit`, `created_on`,
  `created_at`, `updated_at` and every price, route by route in the rate's order. `404` if unknown.

  ```jsonc
  { "id": "rt003", "code": "NOK-STD", "name": "Standard 2026", "…": "the summary's fields",
    "note": null, "transfer_unit": "per trip", "created_on": null,
    "created_at": "2026-10-07T09:00:00.000Z", "updated_at": "2026-10-07T09:00:00.000Z",
    "routes": [ {
      "route_id": "r5", "travel_from": "2025-11-01", "travel_to": "2026-04-30",
      "longtail_bundle": { "mode": "paid", "adult": 300, "child": 200, "applies_to": "seat" },
      "zones": {
        "PK": { "net": { "ad_fr": 2900, "chd_fr": 1900, "ad_th": 1900, "chd_th": 1200 },
                "sell": { "ad_fr": 3400 }, "min_sell": { "ad_fr": 3100 } },
        "KL": { "net": { "ad_fr": 3100, "chd_fr": 2100 } } },
      "charter": { "speedboat": { "starter_price": 45000, "starter_includes": 20, "extra_per_pax": 1500 } },
      "longtail": { "join_adult": 400, "join_child": 300, "charter_price": 3500, "charter_capacity": 8 },
      "transfer": { "PK": { "sedan": 1200, "van": 1800 } } } ] }
  ```
- `POST /v1/rate-types`: creates one. `201` with the detail.
  - The body has the header fields (`name` required; `id`, `code`, `note`, `color`, `owner`,
    `valid_from`, `valid_to`, `active`, `nationality_scope`, `transfer_unit` optional) and an
    optional `routes` array. Each entry is a route block, as in the detail, plus its `route_id`.
  - `id` is generated (`rt_<uuid>`) when absent.
  - `code` is generated from the name when absent: `Standard 2026` → `STANDARD-2026`, then
    `-2`, `-3`… on a clash.
  - `409` with `code: "exists"` when the `id` or `code` is taken.
- `PATCH /v1/rate-types/{id}`: changes the header fields it names. A field it doesn't mention is
  left alone, and `null` clears one that may be empty. `code` and `id` cannot change (`400`):
  an import matches rate types on the code. Deactivate with `{ "active": false }`.
- `PUT /v1/rate-types/{id}/routes/{route_id}`: replaces that route's whole block, and adds the
  route at the end of the rate's routes if it is new. A zone, a charter boat or a transfer left out
  of the body is removed, not kept. The body may repeat `route_id`, but it must match the path.
  Returns the detail.
- `DELETE /v1/rate-types/{id}/routes/{route_id}`: takes a route and its prices off the rate.
  `204`, or `404` if the rate type or the route on it is unknown.
- `DELETE /v1/rate-types/{id}`: `204`. If an agent or a booking names the rate type, it answers
  `409` with `code: "in_use"` and the counts in the message; deactivate it instead.

Field notes:

- **Seat prices are keyed like a booking's pax grid:** `ad_fr`, `chd_fr`, `inf_fr`, `ad_th`,
  `chd_th`, `inf_th`. A rate is always foreign or Thai. Legacy prices a booking pax with no
  residency (`ad`) as foreign.
- **Tiers:** only `net` is what the agent pays. `sell` and `min_sell` are the agent's suggested
  and minimum selling prices, printed on contracts and never billed.
- **A zone is offered on a route when it has a net adult price above 0** (foreign or Thai). A zone
  with no prices, or both adult prices at 0, is not offered. `priced_routes` lists the routes with
  at least one offered zone, in the rate's order.
- **Zones depend on the route's pier:** Ranong routes take `RN` and `NoTransfer`; every other
  route, land routes included, takes `PK`, `KL` and `NoTransfer`. Transfer zones follow the same
  rule.
- **Charter `boat_type`** is `speedboat`, `catamaran` or `longtail`. It is matched against the
  chartered boat's type, lowercased. `starter_price` covers `starter_includes` passengers, and each
  one more costs `extra_per_pax`.
- **`longtail_bundle`** folds the longtail into the seat price. `mode` is `free` or `paid` (a free
  bundle has no price). `applies_to` is `seat`, `charter` or `both`; `null` means `seat`.
- **Transfer `vehicle`** is `sedan` or `van`.
- **`travel_from`/`travel_to` and `valid_from`/`valid_to` do not stop a sale.** They feed agent
  programmes and contracts, as in legacy.
- **`nationality_scope`** is `both`, `thai` or `foreign`; `null` means never set, read as `both`.
- **`owner`** is a salesperson id; `null` means shared, visible to every salesperson.
- **Present values only:** a price map lists only the cells that are set, so `null` in a request
  means "not set" and is dropped. Header fields are always present, `null` when empty.

Validation errors are `400` and name the path, for example:

- `routes[1].charter.yacht is not a boat type: use speedboat, catamaran, longtail`
- `zones.PK.net.ad_fr must be a number ≥ 0`
- `routes[0].zones.RN does not apply to route r5 (pier panwa): use PK, KL, NoTransfer`
- `routes[0].route_id r99 is not a route`
- `travel_to must be a real date, YYYY-MM-DD`; `valid_from must not be after valid_to`
- `owner s9 is not a salesperson`

### Operations

- `POST /operations/deployments` — `{ boat_id, route_id, service_date, capacity, license_pax?, registered_persons? }`; creates or replaces a boat's deployment for that date. `license_pax` is taken from the boat catalogue when omitted.
- `DELETE /operations/deployments/{service_date}/{boat_id}` — removes a deployment.
- `GET /operations/deployments?from=&to=&route_id=` — lists deployments.
- `GET /operations/allotment?route_id=&service_date=` — deployed, booked, locked, and available seat totals, with contributing deployments.
- `GET /v1/manifest?date=&route_id=` — allotment plus bookings for the operating day.
- `GET /v1/availability?route_id=&date=` — booking-form availability for one route on one day:
  `{ route_id, service_date, deployed_capacity, licensed_capacity, booked_pax, charter_pax, locked_pax, available_seats, unlimited, unplaced_pax }`.
  `available_seats` is `null` on a land route (`unlimited: true`); see "Land routes and days with no boat".
- `GET /v1/availability?from=&to=[&route_id=]` — the same numbers for a range, both ends inclusive,
  for one route or, without `route_id`, every route in the catalogue:

  ```jsonc
  { "days": [
    { "route_id": "r1", "service_date": "2031-03-01", "open": true,
      "deployed_capacity": 40, "licensed_capacity": 45, "booked_pax": 8, "charter_pax": 4,
      "locked_pax": 0, "available_seats": 22, "unlimited": false, "unplaced_pax": 0,
      "deployments": [
        { "boat_id": "b1", "capacity": 30, "license_pax": 35, "chartered": false },
        { "boat_id": "b2", "capacity": 10, "license_pax": null, "chartered": true } ] } ] }
  ```

  Ordered by date, then by route in catalogue order; boats are ordered by id. Every route-day is
  present, and a day with no deployment is all zeros (apart from `unplaced_pax`), not missing. `open` is the route calendar's
  answer for that date (see `GET /v1/routes?from=&to=`), and is what tells a closed day apart from
  an open one nobody has staffed yet — both have zero seats. `deployments[].capacity` is the boat's
  sellable seats that day after any override and the licence clamp, so they sum to
  `deployed_capacity`. `from`/`to` must be supplied together and may not be combined with `date`.
  The range is capped at 400 days for one route and 62 without `route_id`.

`GET /operations/allotment` and `GET /v1/availability` also accept `exclude_booking_id` and `exclude_lock_id`. A reservation being edited still holds its seats, so an unqualified read counts them against it: raising a 6-pax booking to 8 on a full day looks refused even though the six seats it releases would cover it, and a no-op edit on a sold-out day looks unsavable. Pass the id being edited to read availability as it will be once that reservation is re-saved. Amendments apply the same exclusion internally, so a `PATCH` never rejects a booking on the strength of its own seats.

#### Capacity: three numbers, two ceilings

Availability returns `deployed_capacity` and `licensed_capacity`, and they are not the same limit:

| | meaning |
| --- | --- |
| `capacity` | seats the company sells. A commercial decision, set per deployment. |
| `license_pax` | the registered maximum **passengers**. The legal ceiling. |
| `registered_persons` | `license_pax + crew` — total persons the vessel may carry. **Never a selling ceiling.** |

`deployed_capacity` is what the seat pool offers: the deployment's capacity, replaced by a
`boat_capacity_overrides` row when the day has one, then clamped by the licence. `licensed_capacity`
is the passenger ceiling a **charter** may fill the boat to — higher than the selling cap on
purpose, because a charter buys the whole boat.

A boat with no licence on file — three Ranong boats have none — falls back to its capacity. A
missing licence is not a licence of zero.

#### What `available_seats` subtracts

```
available_seats = sellable seats on boats not chartered
                − booked_pax                 (seat trips, including seats drawn from locks)
                − locked_pax                 (what locks still hold: pax − drawn, per lock)
                − passengers of any charter whose boat is unknown
```

- **A charter takes its whole boat.** The chartered boat's sellable seats leave the pool, however
  few passengers the charter carries; `deployments[].chartered` marks it. `charter_pax` is reported
  for information and is not subtracted again. A charter recorded before boats were tracked, on a
  day with more than one boat, cannot say which boat it took, so its passengers come out of the
  pool instead — the last line above.
- **A lock holds only what has not been drawn from it.** Seats a booking draws from a lock are
  counted once, in `booked_pax`; the lock's own contribution to `locked_pax` shrinks by the same
  amount. A cancelled booking returns its draws to the lock.

`available_seats` can be negative on a day that was oversold before these rules existed. It is
reported as it is rather than clamped to zero, so the oversell is visible.

`registered_persons` is stored for the record and read by nothing. It was previously called
`total_capacity` and was used as the charter ceiling, which meant a boat registered for 45
passengers and 3 crew could be sold 48 charter seats. `total_capacity`/`totalcap` are still accepted
on input, since that is what legacy sends, and stored as `registered_persons`.

### Bookings

A booking is a sale; a **trip** is one departure. Seats are consumed per departure, so a booking
carries a `trips` array and one booking may span several days.

```jsonc
{
  "trips": [
    { "routeId": "r-1", "date": "2030-01-02", "pax": { "ad": 2, "chd_fr": 1 }, "lockDraws": { "lock_123": 2 } },
    { "routeId": "r-1", "date": "2030-01-03", "pax": { "ad": 2 }, "bookingMode": "charter", "charterBoatId": "b13" }
  ]
}
```

- **`charter_boat_id`** (`charterBoatId`) is **required on a charter** and refused on anything else.
  The boat must be deployed on that route and day (`400` otherwise) and not already chartered
  (`409`). The charter's passengers must fit that boat's licence (`409`). The day must still have
  room for the seats already sold once the boat leaves the pool (`409`), because taking a boat must
  not strand passengers already booked on it.
- **`lock_draws`** (`lockDraws`) is `{ lock_id: seats }`: the part of a seat trip sold from an
  agent's lock. The draws may not add up to more than the trip's `pax` and do not apply to a
  charter (`400`). Each lock must be active on the same route and day (`400`) and have that many
  seats left (`409`); a lock id that does not exist is a `400`. Only `pax − drawn` needs general
  seats. Responses return `lock_draws` in the same map shape, `{}` when there are none.
- Moving a single-departure booking to another route or day (`PATCH` with `route_id`/
  `service_date`, or `reschedule`) **drops its lock draws**, because a lock belongs to one departure,
  and the moved trip takes general seats. To draw on a lock on the new day, send `trips`. Reducing
  the head count by a bare number (`PATCH` with `pax`, or `partial-cancel` with `pax_to_cancel`)
  keeps the lock seats and gives back general seats first. Which passengers left isn't recorded, and
  this way an agent is never handed back lock seats they had already sold. A partial cancel that
  **names** who left does the opposite and returns lock seats first — see
  [Booking actions](#booking-actions-cancel-restore-partial-cancel-reschedule).

`pax` is a grid of category × pricing tier: categories are `ad`, `chd`, `inf`, `foc`, and a bare key
is untiered while `_fr` and `_th` are the foreign and Thai tiers (`ad`, `ad_fr`, `ad_th`, …). Every
category consumes a seat, infants and FOC included. An unrecognised key is rejected rather than
dropped — a silently ignored count is a passenger who is not on the boat. A plain `pax: 6` is
accepted and stored as one untiered cell.

Responses return `trips` with each trip's `pax` grid and `pax_total`, plus `route_id`,
`service_date`, `pax` and `allocated_pax` at the top level. Those four are **derived** — the first
trip's route and date, the total across every trip, and the seats that total currently holds — so a
single-departure client can ignore trips entirely.

#### Pickup and overnight fields

Each trip may also carry these fields. All are optional; `null` or `""` means not set. Responses
leave out any field that isn't set, except `ovn_leg`, which is always present.

| Field (alias) | Meaning |
|---|---|
| `zone` | Transfer zone code, e.g. `PK`, or `NoTransfer` for a self-arrival. Free text. |
| `pickup_time` (`pickupTime`) | Hotel pickup time, `HH:MM`, 24-hour, local time. |
| `ovn` | Marks an **overnight outbound** trip: `return` (we bring them back on `ovn_return_date`) or `self` (they make their own way back). |
| `ovn_return_date` (`ovnReturnDate`) | The day they come back, `YYYY-MM-DD`. Required when `ovn` is `return`, refused otherwise, and must be after the trip's own date. |
| `ovn_leg` (`ovnLeg`) | `true` on the **return leg**: the trip that brings them back. It holds seats on that day like any seat trip. |
| `ovn_of` (`ovnOf`) | On a return leg: the **index in this `trips` list** of its outbound trip. |

These rules match the legacy booking screen. A return leg must:
- have `ovn_of` pointing at a *different* trip in the list whose `ovn` is `return`
- be on that trip's route, dated its `ovn_return_date`
- be a seat trip, not a charter
- carry no `ovn` of its own

`ovn_of` is refused on any trip that is not a leg. Every violation is a `400` naming the trip.

`ovn_of` is an index on the way in and on the way out. The link is stored against the outbound
trip's id, so reordering the list keeps it pointing at the right trip. The response gives the
outbound's *current* index.

```jsonc
{ "trips": [
  { "routeId": "r-1", "date": "2030-01-02", "pax": { "ad": 2 }, "zone": "PK", "pickupTime": "08:30",
    "ovn": "return", "ovnReturnDate": "2030-01-04" },
  { "routeId": "r-1", "date": "2030-01-04", "pax": { "ad": 2 }, "zone": "PK", "ovnLeg": true, "ovnOf": 0 }
] }
```

These rules are checked when a request sends `trips`, and when a single-departure move
(`reschedule`, or `PATCH` with `route_id`/`service_date`) would put an overnight trip on or after
its return date. An edit that leaves the trips alone is not re-checked. That way a booking imported
before these rules existed can still have its header edited.

#### Trip ids

Every trip in a response has an **`id`** that stays the same for as long as the trip exists.
Day-of-operations data (van, pickup, check-in) is attached to that id, so it must survive edits.

On `PATCH` with `trips`, each trip you send is matched to a stored trip like this:

1. **With an `id`:** it is that stored trip, updated in place, even if its route, date or pax
   change. Sending an `id` with a new date is how you *move* a trip.
2. **Without an `id`:** it is the stored trip on the **same route and date**, if one exists and no
   other trip in the request claimed it by `id`. So a client that never sends ids still keeps them,
   as long as it doesn't move trips.
3. **Otherwise** it is a new trip with a fresh id.

A stored trip that nothing matched is removed, along with anything attached to it.

**Moving a trip clears its day-of-operations data.** When a kept trip's route or date changes, its
van group, allocations and trip operations are deleted, because they were arranged for the old
departure. The trip keeps its id. Without an `id`, a trip on a new day is a new trip, so the old
trip's data goes when that trip is removed. Both paths end the same way.

- An `id` that is not one of this booking's trips, or the same `id` twice, is a `400`, and nothing
  changes. `POST` takes no trip ids, because a new booking has no trips yet.
- An `id` that is not one of this booking's trips, or the same `id` twice, is a `400`, and nothing
  changes. `POST` takes no trip ids, because a new booking has no trips yet.
- Edits that don't send `trips` keep every trip's id: header or `passengers` changes, `PATCH` with
  `route_id`/`service_date`/`pax`, `reschedule` and `partial-cancel`.
- `seq` is the trip's position in the list, and changes when you reorder. Don't use it as an id.
- Treat ids as opaque strings. New ones look like `trip_<uuid>`, older ones differ.

```jsonc
// Stored: [A (trip_a), B (trip_b)]. Remove A, keep B, add a new day:
{ "trips": [
  { "id": "trip_b", "routeId": "r-1", "date": "2030-01-03", "pax": { "ad": 2 } },
  { "routeId": "r-1", "date": "2030-01-04", "pax": { "ad": 2 } }
] }
// → B keeps trip_b (now seq 0), the new trip gets a new id, trip_a is removed.
// Leaving out "id": "trip_b" gives the same result, because B's route and date are unchanged.
```

#### Status, and which statuses hold seats

`status` is one of `draft`, `quote`, `pending`, `pending_approval`, `pending_foc`, `confirmed`,
`completed`, `rejected`, `cancelled`, `cancelled_weather`. **The server decides it; a client never
sends one.**

##### How the status is decided on create: `intent`

A create says which save button was pressed — `"intent": "quote"` ("Save as quote") or
`"intent": "confirm"` ("Confirm", the default) — and the server decides the status from that and
the facts, the way legacy's save does (`bkV2SubmitBooking`, `bkV2CommitBooking`):

| The facts | `intent: quote` | `intent: confirm` |
|---|---|---|
| fits the seats on sale | `quote` | `confirmed`, stamped `confirmed_by`/`confirmed_at` |
| carries FOC (free) passengers | `quote` | `pending_foc` — needs `focReason`, else `400 foc_reason is required to confirm FOC (free) passengers` |
| carries a discount (`price_discount` ≠ 0) | `quote` | `pending_approval`, **holding** its seats |
| over the allotment, within the boats' registered seats | `pending_approval`, **holding no seats** | `pending_approval`, **holding no seats** |
| needs seats other agents' locks hold | `409` | `409` |
| past the boats' registered seats (`license_pax`) | `409` | `409` |

"Over the allotment" means a day's seats on sale (`available_seats`) plus what locks still hold are
not enough, but the registered seats (`licensed_capacity`) are. Legacy saves that for a manager to
decide; so does this. While it waits, the booking **holds no seats** — counting them would let it
take the very room it is waiting for (legacy `bkPendHoldsSeat`) — so `allocated_pax` is `0` and
`available_seats` does not move. A booking waiting only for a discount approval does hold its seats.

When an approval is asked for, the booking's `approvals` list gets a `pending` entry that remembers
where the booking was going (`target_status`): `/approve` moves it there. Over the allotment with
FOC passengers asks for both, and approves in two steps (`pending_approval` → `pending_foc` →
`confirmed`).

```jsonc
// POST /v1/bookings  { "intent": "confirm", "trips": [{ "routeId": "r3", "date": "2039-02-01", "pax": { "ad": 22 } }] }
// on a day with 20 seats on sale and 25 registered → 201
{
  "status": "pending_approval", "allocated_pax": 0,
  "approvals": [{
    "kind": "approval", "status": "pending", "over_capacity": true, "over_total": 2, "discount": null, "foc_count": null,
    "target_status": "confirmed", "requested_by": "ops1", "requested_at": "…", "decided_by": null, "decided_at": null, "note": null,
    "days": [{ "route_id": "r3", "service_date": "2039-02-01", "need": 22, "over_by": 2 }]
  }]
}
```

`approvals` is every approval asked for, oldest first, kept after it is decided: `kind` `approval`
(over the allotment and/or a discount) or `foc`; `status` `pending`, `approved`, `rejected`, or
`replaced` (a later edit asked again before it was decided). At most one per kind is `pending`.

**`status` on create is deprecated.** Until both clients send `intent`, a create may still send the
old `status`, read as the intent it meant: `quote` or `draft` → `quote`; `confirmed` or
`pending_foc` → `confirm`. The server still decides the final status. Any other status is a `400`
(`status pending_approval cannot be asked for on create: send intent quote or confirm, and the server
decides the status`); `intent` and `status` that disagree are a `400`. Each use is logged as a
warning (`deprecated: POST /v1/bookings with status; send intent`) so we can see who still sends it.
It will be removed.

##### After create: commands

**After a booking is created, its status changes only through a command**, never `PATCH`. The
server checks the move is allowed from where the booking is and records who made it:

| Command | From | To |
|---|---|---|
| `POST /v1/bookings/{id}/confirm` | `draft`, `quote`, `pending` | as a create with `intent: confirm`: `confirmed`; `pending_foc` with FOC passengers (`foc_reason` required); `pending_approval` with a discount. The seats it holds are not weighed again |
| `POST /v1/bookings/{id}/approve` | `pending_approval`, `pending_foc` | the approval's `target_status` (`confirmed` unless FOC passengers still wait: `pending_foc`). Over the allotment, it now holds its seats |
| `POST /v1/bookings/{id}/reject` | `pending_approval`, `pending_foc` | `rejected` (seats given back) |
| `POST /v1/bookings/{id}/cancel-weather` | any status that holds seats | `cancelled_weather`, `cancellation_reason` `weather` (seats given back) |
| `POST /v1/bookings/{id}/cancel` | any status that holds seats | `cancelled` — see [Booking actions](#booking-actions-cancel-restore-partial-cancel-reschedule) |
| `POST /v1/bookings/{id}/restore` | `cancelled`, `rejected`, `cancelled_weather` | `confirmed` |

- `confirm`, `approve`, `reject` and `cancel-weather` take an optional `{ "note": "…" }`, written
  into the history (and, for `approve`/`reject`, onto the approval). Each answers the booking plus
  `warnings`, `404` for an unknown one, and `409` with `code: "wrong_status"` (or
  `already_cancelled` / `booking_closed`) when the move is not allowed from the current status.
- **Approving past the registered seats is allowed, with a warning**, as legacy allows it ("add a
  boat before the travel date"). When an over-allotment booking is approved and its seats no longer
  fit the boats' licence — another booking took the room meanwhile — the approval goes through and
  `warnings` lists each day short:

  ```json
  { "...": "the booking", "status": "confirmed", "warnings": [{ "code": "over_licence", "route_id": "r3", "service_date": "2039-02-03", "over_by": 17 }] }
  ```

  `warnings` is `[]` otherwise, and always `[]` for `confirm`, `reject` and `cancel-weather`.
- **Who confirmed is the logged-in user.** `confirm`, `approve` and a create the server confirms
  stamp `confirmed_by` and `confirmed_at` the first time a booking is confirmed; a later approval
  keeps the first confirmation. The approver is never a name from the request; `decided_by` on the
  approval is the logged-in user too.
- A legacy-imported `pending_approval` or `pending_foc` booking has no approval record. It holds
  its seats (legacy reads it the same way), `/approve` moves it to `confirmed`, and the decision is
  recorded as a new, already-decided entry in `approvals`.
- `cancel-weather` handles the booking only. Refunds and credits stay in legacy until money moves
  here. Undo it with `/restore`.
- These are legacy's rules (`bkV2ApproveBooking`, `bkV2RejectBooking`, `bkV2FocApprove`,
  `bkV2FocReject`, `bkV2WeatherResolveOne`). Nothing in legacy ever sets `completed`, so no command
  does either.

**Seats are released by `cancelled`, `rejected` and `cancelled_weather`. Every other status holds
them** — including `quote` and `draft` — **except a `pending_approval` booking waiting for an
over-allotment approval**, which holds none until it is approved (above). That is a denylist rather than an allowlist on purpose, and
the direction matters more than the membership: a status nobody has classified yet holds its seats
instead of releasing them. Over-holding is a day that looks fuller than it is and someone asks;
under-holding is two parties sold the same seat, at the pier, on the day. It matches the rule the
legacy frontend applies (`getSeatsConsumed`).

Bringing a released booking back with `/restore` **is** capacity-checked, even when the itinerary
has not moved — it asks for those seats again, and a day that filled up in the meantime refuses it
with a `409`. (A booking is never created in a released status: it is cancelled after.)

- `GET /v1/bookings` — optionally filter by `route_id` and an exact `service_date` (or `date`),
  or by an inclusive trip-date range using `from` and `to`; a booking matches if any of its trips
  does. Results use cursor pagination: `limit` defaults to 50 and may be 1–100, and `cursor` is
  returned as `next_cursor` when another page exists. `service_date` cannot be combined with
  `from`/`to`. `agent_id` narrows the list to one agent's bookings. Pages are ordered by creation
  time, then id, oldest first. `order=desc` gives newest first, which is what an agent's Recent
  Bookings tab wants. A cursor carries on in the direction it was issued in, so send the same
  `order` with it. Imported bookings were created at legacy's `bookedAt`, so creation order is
  booking-date order.

  Three more filters, all combinable with the above:
  - `status=pending_approval` — any of a comma-separated list (`status=cancelled,cancelled_weather`),
    or the key repeated. An unknown status is a `400`, not an empty list.
  - `voucher_ref=` — the whole voucher reference, ignoring case and surrounding spaces. This is the
    duplicate-voucher check.
  - `q=` — a case-insensitive substring of the booking id, `voucher_ref` or `lead_pax`. `%` and `_`
    are ordinary characters, not wildcards.

  Every page carries `total`: how many bookings the filters match, ignoring `cursor` and `limit`, so
  it is the same on every page. A badge count is `?status=pending_approval&limit=1`, read `total`.

  ```json
  { "bookings": [ … ], "next_cursor": "…", "total": 7 }
  ```
- `GET /v1/bookings/{id}`
- `POST /v1/bookings` — `{ trips: [...] }`, or the flat `{ route_id, service_date, pax }` for a
  single departure. A supplied top-level `pax` must equal the sum across trips. The header fields
  are stored as columns and returned as columns — see [Booking header fields](#booking-header-fields)
  below. An optional `passengers` array is stored as columns too — see
  [Passengers](#passengers) — and so is an optional `addOns` array, see [Add-ons](#add-ons).
  `intent` (`quote` or `confirm`) says which save button it was; the server decides the status —
  see [How the status is decided](#how-the-status-is-decided-on-create-intent). **The itinerary is
  weighed as a whole**: if any day is refused (locks in the way, registered seats full) the booking
  is refused entirely and no day is left holding part of it; if any day is over the allotment the
  whole booking waits for approval. A booking has **at most one
  trip per route per day** (`400` otherwise); send one trip with the combined pax. A trip must name a route in the catalogue (`GET /v1/routes`); an
  unknown one is a `400` naming the route, and `booking_trips_route_fk` is the database backstop
  behind it.
- `PATCH /v1/bookings/{id}` — send `trips` to replace the itinerary outright (echo each kept trip's
  `id`, see [Trip ids](#trip-ids)), or `route_id`,
  `service_date` and/or `pax` to move a single-departure booking. Days being vacated are
  released in the same transaction. Any
  [header field](#booking-header-fields) may be sent in the same call, and **the header merges**:
  a field you do not mention keeps the value it had. Sending `passengers` **replaces the whole
  list**, the same way `trips` replaces the itinerary — see [Passengers](#passengers). `addOns`
  works the same way — see [Add-ons](#add-ons). An amendment refused for capacity changes nothing,
  header, passengers and add-ons included.
  Capacity is weighed only when the amendment **asks for more**: a new or moved trip, more
  passengers, more general seats, or more seats from a lock. Taking passengers off never needs room,
  so it succeeds on a day that is already oversold (the legacy import brings such days over as they
  are). **An amendment can change the status**, the way a create decides it: asking for more than
  the allotment has moves the booking to `pending_approval` (holding no seats, remembering where it
  was), and a booking waiting over the allotment is weighed again whenever its itinerary changes —
  still over, a new approval replaces the old (`replaced`); fits now, it goes back where it was
  (`Fits the allotment now · confirmed`). Past the registered seats or into locked seats is `409`.

  **`PATCH` changes what the client knows, not what the server decides.** `status`, `created_by`,
  `booked_at`, `confirmed_by` and `confirmed_at` are accepted only when they **repeat the stored
  value** — so a client that sends the whole booking back on every save keeps working — and a
  different value is a `400` naming what to do instead, e.g.
  `status cannot be changed with PATCH: use POST /v1/bookings/{id}/confirm, /approve, /reject, /cancel, /cancel-weather or /restore`.
  A `cancelled`, `rejected`, `cancelled_weather` or `completed` booking cannot be edited at all:
  `409` with `code: "booking_closed"`, as legacy refuses it.
- `POST /v1/bookings/{id}/confirm`, `/approve`, `/reject`, `/cancel-weather` — see
  [Status](#status-and-which-statuses-hold-seats).
- `POST /v1/bookings/{id}/cancel`, `/restore`, `/partial-cancel`, `/reschedule` — see
  [Booking actions](#booking-actions-cancel-restore-partial-cancel-reschedule).
- `GET /v1/bookings/{id}/history` — see [History and who made a change](#history-and-who-made-a-change).

#### Booking actions: cancel, restore, partial cancel, reschedule

Each action changes the seats **and records why, who, and what it cost**, the way legacy did.
Every booking read (`GET /v1/bookings/{id}`, the list, and every write's response) carries the
records:

| Key | Present | Shape |
|---|---|---|
| `cancellation` | only while the booking is cancelled with a category | `{ category, group, note, charge_type, charge_amount, at, by }` |
| `reschedules` | always, `[]` when none | `[{ from_date, to_date, reason, charge_type, charge_amount, collect, at, by }]`, oldest first |
| `partial_cancels` | always | `[{ trip_id, service_date, pax_removed, count, category, group, note, charged: {count, amount}, waived: {count, amount}, at, by }]`, oldest first |
| `fee_items` | always | `[{ type, label, amount, at }]`, oldest first |

`note`, `reason`, `label`, `by` and `trip_id` are `null` when there is none. `at` is an ISO instant.
**What the agent owes is `total` plus the sum of `fee_items[].amount`**; a fee never changes
`total`.

**Cancellation categories.** `category` is one of these codes; `group` is derived from it and never
sent. Weather is not on the list: a weather cancel is its own status, `cancelled_weather`.

| code | label | group |
|---|---|---|
| `customer_cancel` | Customer cancelled / changed plan (ลูกค้ายกเลิกเอง / เปลี่ยนแผน) | customer |
| `no_show` | No-show (ไม่มาตามนัด) | customer |
| `sick` | Sick / health (ป่วย / เหตุสุขภาพ) | customer |
| `flight_visa` | Flight / visa / documents (ไฟลท์ / วีซ่า / เอกสาร) | customer |
| `agent_error` | Agent error / double booking (เอเย่นต์จองผิด / จองซ้ำ) | customer |
| `operator` | Operator (boat down / trip off) (ฝั่งเรา (เรือเสีย / ทริปไม่ออก)) | operator |
| `force_majeure` | Force majeure (เหตุสุดวิสัย (ภัยพิบัติ/โรคระบาด)) | operator |
| `other` | Other (อื่นๆ (ระบุใน note)) — `note` is required | other |

**Charges.** `charge_type` is `none` (default), `full` or `partial`. `partial` needs
`charge_amount > 0`. `full` is computed: `total` plus the existing fee items. `none` ignores any
amount. The charge is recorded, not billed: invoices belong to accounting.

**A closed booking is refused.** Cancel, partial cancel and reschedule answer `409` on a booking
that is `cancelled`, `cancelled_weather`, `rejected` or `completed`.

##### `POST /v1/bookings/{id}/cancel`

```json
{ "category": "customer_cancel", "note": "changed plan", "charge_type": "partial", "charge_amount": 1500 }
```

Sets `status: "cancelled"`, writes the `cancellation` record, and sets `cancellation_reason` to the
category's label plus the note (`Customer cancelled / changed plan (ลูกค้ายกเลิกเอง / เปลี่ยนแผน) ·
changed plan`), so every reader of that column keeps working. Lock seats go back to their locks and a
charter's boat is freed, because a cancelled booking holds nothing. A body with no `category` —
`{ "reason": "..." }` or nothing at all — is the older form: it sets `cancellation_reason` to the
text and writes no record.

##### `POST /v1/bookings/{id}/restore`

No body. Puts a `cancelled`, `cancelled_weather` or `rejected` booking back to `confirmed`, deletes
its `cancellation` and clears `cancellation_reason`. Any other status is `409` with
`code: "not_cancelled"`.

- **Lock seats are redrawn as far as the locks allow.** If someone has used a lock meanwhile, the
  trip keeps what the lock still has and takes the rest from general seats. Each shortfall is
  reported, and the restore is refused (`409`) only if general seats cannot take the rest either.
- **A charter wants its boat back whole.** If another charter took the boat on that day, it is
  `409` with `code: "charter_boat_taken"`.

The response is the booking plus `warnings` (`[]` when everything fitted):

```json
{ "...": "the booking", "warnings": [{ "code": "lock_short", "trip_id": "trip_…", "lock_id": "lock_…", "wanted": 3, "got": 1 }] }
```

##### `POST /v1/bookings/{id}/partial-cancel`

```json
{ "trip_id": "trip_…", "pax": { "ad_fr": 1, "chd_fr": 1 }, "category": "sick", "note": "",
  "charged": { "count": 0, "amount": 0 }, "waived": { "count": 2, "amount": 4000 } }
```

Takes the named passengers off one trip. Works on multi-trip and tiered bookings.

- `pax` keys must be on that trip, each count at most what the trip holds (`400`). An unknown
  `trip_id` is `404`.
- **A trip is never emptied this way** (`400`, "trips[0] would have no passengers; cancel the booking
  instead"). Remove a whole departure by cancelling or by `PATCH` with `trips`.
- `category` and `note` follow the cancel rules. `charged.count + waived.count` must equal the
  passengers removed.
- **`waived.amount` is the refund and lowers `total`** (never below 0). `charged.amount` is a
  cancellation fee the agent still pays and leaves `total` alone.
- **Lock seats go back first**, lowest lock id first: the customer dropped out, so the agent may
  resell the seat. Only the rest come off general seats.
- No capacity check: seats only go down.

The older body `{ "pax_to_cancel": 2 }` still works as before. It needs a single-trip, untiered
booking, keeps lock seats, and writes no record.

##### `POST /v1/bookings/{id}/reschedule`

```json
{ "from_date": "2026-10-10", "to_date": "2026-10-14", "reason": "customer request",
  "charge_type": "partial", "charge_amount": 500, "collect": "invoice" }
```

Moves **every trip on `from_date`** to `to_date`, on the same route. Other days are untouched, so
this works on multi-trip bookings.

- `from_date` and `to_date` are `YYYY-MM-DD` and must differ. `reason` is required. No trip on
  `from_date` is `400`.
- The moved trips **return their lock draws** and take general seats on the new day. Their
  day-of-operations data (van, pickup time) is cleared, as it was arranged for the old day. A charter
  keeps its boat and must get it whole on the new day.
- The new day is capacity-checked as usual (`409` when full). Overnight trips and the
  one-trip-per-route-per-day rule are checked too (`400`).
- **The price stands; a charge is extra.** `collect` is `invoice` (default) or `separate`. With
  `invoice` and a charge above 0, a fee item `{ type: "reschedule", label: "Reschedule fee · <from> →
  <to> · <reason>", amount }` is added. With `separate`, the charge is kept on the reschedule record
  only. The recorded `collect` is `none` whenever the charge is 0.

The older body `{ route_id, service_date, pax? }` still works. It moves a single-trip booking
anywhere and writes no reschedule record (it does write a history line).

#### History and who made a change

**Every write is signed by the token's user**: `preferred_username`, else the token subject.
`updated_by` is set from the token on every write, and **an `updated_by` in the body is ignored**.
**`created_by` is the logged-in user, always**: a create that names anyone else is a `400`, and
`booked_at` is the time of the create. Neither may be sent. With authentication switched off (local
development) there is no user: the user columns stay empty and `by` is `null`.

Each write appends one line to the booking's history, in the same transaction:

| Write | `kind` | `tag` | `text` |
|---|---|---|---|
| `POST /v1/bookings` | `create` | `Created` | `Created`, then any line below for an approval it waits for |
| waits for approval (create, confirm, `PATCH`) | `approval` | `Approval` | `Waiting for approval · over the allotment by <n> (<route> <date> +<n>, …) · discount ฿<n>` (the parts that apply) |
| waits for FOC approval (create, confirm) | `foc` | `FOC` | `Waiting for FOC approval · <n> FOC pax` |
| fits again (`PATCH`) | `approval` | `Approval` | `Fits the allotment now · <status>` |
| `PATCH` | `edit` | `Edited` | `Edited · trips, total` (the keys sent) |
| confirm | `edit` | `Confirmed` (`FOC`/`Approval` when it waits) | `Confirmed`, or one of the waiting lines above; `· <note>` |
| approve | `confirm` | `Approval` (`FOC` from `pending_foc`) | `Approved · booking confirmed`, `Approved · now <status>`, or `FOC approved · <n> pax · booking confirmed`; `· <note>` |
| reject | `cancel` | `Approval` (`FOC` from `pending_foc`) | `Rejected`, or `FOC rejected`; `· <note>` |
| cancel-weather | `weather` | `Weather` | `Cancelled for weather · <note>` |
| cancel | `cancel` | `Cancel` | `Cancelled · <charge> · <category label> · <note>` |
| restore | `edit` | `Confirmed` | `Restored`, plus `· seat lock <id>: <got>/<wanted> seats back` per short lock |
| partial cancel | `cancel` | `Cancel` | `Partial cancel · −2 pax · <category label> · charge 0 (฿0) · waive 2 (฿4,000)` |
| reschedule | `reschedule` | `Reschedule` | `Rescheduled <from> → <to> · <charge> · <collect> · <reason>` |

`<charge>` is `No charge`, `Full charge ฿<n>` or `Charge ฿<n>`.

`GET /v1/bookings/{id}/history` answers `{ "history": [{ at, by, kind, tag, text }] }`, oldest
first, and `404` for an unknown booking. It is kept out of the booking read because it only grows.
Imported bookings carry legacy's own lines, whose `kind` values are wider than the table above
(`notify`, `invoice`, `payment`, …).

**Errors** keep the shape `{ statusCode, error, message }`. `message` names the field or the rule
and is fit to show to a person. Where a client needs to branch, a machine-readable `code` is added:
`not_cancelled`, `charter_boat_taken`, `already_cancelled`, `booking_closed`, `wrong_status`.

#### Booking header fields

The scalar fields of a booking are stored as columns and returned as columns. Send them in the
frontend's camelCase (`leadPax`) or in the response's snake_case (`lead_pax`) — both are accepted,
the way `routeId` is accepted beside `route_id`. Fixed-size structs are flattened on the way in:
send `guides: {english, russian, chinese, otherLang}` and read back `guide_english`,
`guide_russian`, `guide_chinese`, `guide_other_lang`. The same applies to `specialMeals`,
`cashOnTour`, `priceBreakdown`, `paymentSnapshot` and `marketSnapshot`.

| Group | Fields |
| --- | --- |
| identity | `schema_ver`, `external_id`, `voucher_ref` |
| commercial | `agent_id`, `rate_type_ref`, `sold_by`, `purpose`, `staff_id`, `staff_purpose` |
| lead | `lead_pax`, `lead_nationality`, `lead_type`, `lead_foc`, `lead_phone`, `lead_email` |
| pickup | `pickup_area_id`, `pickup_self`, `pickup_area`, `pickup_zone`, `hotel_name`, `room_number` |
| dropoff | `dropoff_same`, `dropoff_area_id`, `dropoff_area`, `dropoff_hotel_name` |
| guides | `guide_english`, `guide_russian`, `guide_chinese`, `guide_other_lang` |
| service | `pax_type`, `special_meals_veg`, `special_meals_vegan`, `special_meals_halal`, `special_meals_allergies`, `large_luggage` |
| cash on tour | `cash_on_tour_amount`, `cash_on_tour_currency`, `cash_on_tour_handling`, `cash_on_tour_note` |
| price | `price_mode`, `manual_total`, `total`, `price_seat`, `price_addon`, `price_foc_discount`, `price_discount`, `price_extra` |
| payment | `payment_method`, `payment_net_days`, `payment_source`, `payment_contract_version` |
| market | `market`, `market_sub`, `market_agent_id`, `market_at` |
| lifecycle | `booking_date` |
| free text | `notes`, `note` |
| FOC | `foc_reason` (`focReason`) — why passengers travel free; required to confirm FOC passengers |
| **set by the server** (read-only) | `status`, `approvals`, `booked_at`, `created_by`, `updated_by`, `confirmed_at`, `confirmed_by`, `cancellation_reason` |

A field you do not send is **absent from the response**, not `null` — absence means never given,
which is not the same claim as an explicit blank. `booking_date` and `market_at` are plain
`YYYY-MM-DD` days; `booked_at` and `confirmed_at` are ISO instants. Money fields are numbers, never
strings.

**A field that is not in this table is dropped.** It is not retained anywhere. If you need one
stored, that is a request for a column, not a payload change.

##### Amending the header

`PATCH /v1/bookings/{id}` merges. Three cases, and the difference between the last two matters:

| You send | What happens |
| --- | --- |
| nothing for a field | it keeps the value it had |
| `"leadPhone": "0899999999"` | it is set |
| `"leadPhone": null` or `""` | it is **cleared**, and reads back absent |

So correcting one field is a one-field request — you need not read the booking, merge locally and
send all fifty-seven back. Clearing has to be said out loud, because a merge has no other way to
tell "I have no opinion on the hotel name" from "there is no hotel name". An empty or
whitespace-only string clears, which is what a form sends when someone deletes the text in a box;
on `POST` it simply means the field was never filled in, since there is nothing yet to clear.

`false` and `0` are values, not clears. Nested structs work on `PATCH` exactly as on `POST`, and
partially: `{"guides": {"english": true}}` sets `guide_english` and leaves the other three guide
columns alone.

> **`booking_data` is deprecated and will be removed.** It still appears on responses, but nothing
> writes it any more: a booking created since 2026-09-22 has `{}`, and so does every imported one.
> Only a booking created through this API before that date carries the payload as it was sent at
> create time, and `PATCH` never rewrote it, so even there it records what was first sent, not what
> the booking now says. Read the columns. A future release stops returning it, and a later one
> drops it.

#### Passengers

Every booking response carries `passengers`, an ordered array:

```json
"passengers": [{ "seq": 0, "name": "Jane Doe", "nationality": "DE", "type": "AD", "foc": false }]
```

`name` is the only required field on the way in; `nationality`, `type` and `foc` are optional and
absent (not `null`) when not given, the same convention as the header fields. `seq` is assigned by
array position and is not something you send.

Unlike the header, **`passengers` does not merge on `PATCH`** — sending it replaces the whole list,
the same way `trips` replaces the itinerary. Omitting it on an amendment leaves the existing list
untouched. There is no way to add or edit one passenger without resending the full list.

#### Add-ons

Longtail join/charter, private transfers and B2C extras. Send them on `POST /v1/bookings` or
`PATCH /v1/bookings/{id}` as `addOns` (the frontend's spelling) or `add_ons`; every booking response
— `GET /v1/bookings`, `GET /v1/bookings/{id}`, and the response to each write — carries `add_ons`,
ordered, `[]` when there are none.

```json
POST /v1/bookings
{
  "route_id": "r10", "service_date": "2030-01-04", "pax": 4,
  "addOns": [
    { "type": "longtail-join", "label": "Longtail Join (2A + 0C)", "amount": 800, "qty": 1, "note": "", "jAd": 2, "jChd": 0 },
    { "type": "transfer-r10-PK-van", "amount": 1200 }
  ]
}
```

```json
"add_ons": [
  { "seq": 0, "type": "longtail-join", "label": "Longtail Join (2A + 0C)", "amount": 800, "qty": 1, "join_adults": 2, "join_children": 0 },
  { "seq": 1, "type": "transfer-r10-PK-van", "amount": 1200 }
]
```

| Field | In | Out | Meaning |
| --- | --- | --- | --- |
| `type` | required string | `type` | The code operations matches on (`longtail-join`, `longtail-charter`, `transfer-<route>-<zone>-<vehicle>`, `b2c-…`). Any string: there is no catalogue to check it against. |
| `label` | optional string | `label` | What the line was called when sold. Stored as sent, never recomputed. |
| `amount` | optional number ≥ 0 | `amount` | The **line total** (unit price × qty), not a unit price. A number, never a string. Not guaranteed to add up to `price_addon`, which stays the booking's charged add-on total. |
| `qty` | optional integer ≥ 1 | `qty` | Boats, vehicles or people, depending on `type`. |
| `note` | optional string | `note` | |
| `jAd` / `join_adults` | optional integer ≥ 0 | `join_adults` | Longtail join only: adults actually taking the longtail. |
| `jChd` / `join_children` | optional integer ≥ 0 | `join_children` | Same, for children. |

**Nothing is filled in.** A field you do not send is absent from the response, not `null`, and is
never defaulted: a missing `qty` is not 1, and a missing join count is not 0. For a longtail join
that difference matters — absent means nobody narrowed it down and every passenger is counted,
while `0` means none of them go. Blank `label`/`note` strings are stored as absent. `seq` is assigned
by array position and is not something you send.

Like `passengers`, **add-ons do not merge on `PATCH`**:

| You send | What happens |
| --- | --- |
| no `addOns` / `add_ons` key | the stored list is kept |
| `"addOns": [ … ]` | the whole list is replaced |
| `"addOns": []` or `null` | the list is cleared |

Validation errors are `400` and name the key you used and the position, for example
`addOns[2].amount must be a number`, `addOns[1].type is required`, `addOns[0].amount must not be
negative`, `addOns[0].qty must be a positive integer`, `addOns[0].jAd must be a non-negative
integer`. A refused request writes nothing.

### Agent seat locks

- `GET /v1/seat-locks` — optionally filter by `route_id` and `service_date` (or `date`).
- `POST /v1/seat-locks` — `{ route_id, service_date, pax, agent_id? }`.
- `PATCH /v1/seat-locks/{id}` — change `pax` and/or `agent_id`; a larger allocation is capacity
  checked, and a lock cannot shrink below `drawn_pax` (`409`) — those seats are sold.
- `POST /v1/seat-locks/{id}/release` — idempotently releases a lock. Seats already drawn from it stay
  with their bookings; only the undrawn remainder goes back to the pool.

Every lock response carries `drawn_pax`: the seats bookings that hold seats have drawn from it. The
lock itself holds `pax − drawn_pax`, and that is what a new draw may take.

Booking creation/amendment/rescheduling and lock changes run in one serialized capacity guard. PostgreSQL deployments use transaction-scoped advisory locks for each route/date pool, so concurrent API instances cannot oversell. Over-capacity requests return `409`; invalid input returns `400`; unknown resources return `404`.

`GET /api/health` remains available for service health checks. It returns `{ status: "ok", commit }`,
where `commit` is the git SHA Railway built the running deploy from (`null` outside Railway). If it
is not the head of the branch you pushed, the deploy you are talking to is stale.
