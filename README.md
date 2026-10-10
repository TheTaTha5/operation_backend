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
  database. Log in with a login from the local `users` table: the data pull brings Railway's, and on a
  fresh database `DATABASE_URL=postgres://postgres:postgres@localhost:55433/operations npm run
  user:create -- admin admin --admin` makes one. A change to its files shows on reload; a change to its `server.js` needs
  `docker compose restart integration`.
- **The API ignores `.env`.** Its `DATABASE_URL` is set in the compose file, so it can never write
  to Railway. Every request needs a Bearer token: get one with
  `curl -X POST localhost:3000/v1/login -H 'content-type: application/json' -d '{"username":"admin","password":"admin"}'`.
  `LOCAL_CORS_ORIGIN` in `.env` changes the browser origins allowed to call it (default
  `http://localhost:8791,http://localhost:5173`).
- **The seed tools and the import** run from the host against the local copies:

  ```bash
  SOURCE_DATABASE_URL=postgres://postgres:postgres@localhost:55433/legacy \
  TARGET_DATABASE_URL=postgres://postgres:postgres@localhost:55433/operations npm run seed:routes
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
| `DATABASE_URL=… npm test` | Run the same tests against PostgreSQL instead of the in-process store. Use a fresh, empty database. Three test files run at a time (`--test-concurrency=3`), as on CI's runner: with a test-sized database PostgreSQL watches whole tables for serialization conflicts, so eleven files at once on a many-core machine made unrelated bookings collide often. A collision is retried, and the retry runs alone (`transaction` in `src/domain/postgres-operations.ts`), so it no longer runs out of retries. |
| `npm run check` | Type-check the source. |
| `npm run db:migrate` | Apply PostgreSQL migrations. |
| `SOURCE_DATABASE_URL=… TARGET_DATABASE_URL=… npm run seed:routes [-- --commit]` | Seed the route catalogue (routes, times, and the families they name) from the legacy database. A dry run that prints the diff unless `--commit` is given. Routes are edited here (see "Editing routes"): a route missing here is added with its calendar, one never edited here (`updated_at` null) is refreshed (not its calendar), and **one edited here is never touched**; the run lists where legacy differs. Never deletes. |
| `SOURCE_DATABASE_URL=… TARGET_DATABASE_URL=… npm run seed:boats [-- --commit]` | Seed the boat catalogue the same way: every field of the boat form, its documents and status log. Dry run unless `--commit`; adds what is missing, refreshes a boat never edited here, never touches one edited here, never deletes. Legacy's `totalcap` becomes `registered_persons`, never a selling limit. Run the import afterwards so deployments on a new boat are imported. |
| `SOURCE_DATABASE_URL=… TARGET_DATABASE_URL=… npm run import:fleet-stock [-- --commit] [--all]` | Import legacy's fleet stock, memos, projects, Daily Fleet Log and safety equipment (see "Fleet maintenance"). Dry run unless `--commit`; rerunnable; run after `seed:boats` and `import:attachments`. |
| `SOURCE_DATABASE_URL=… TARGET_DATABASE_URL=… npm run import:pier-office [-- --commit] [--all]` | Import legacy's pier petty cash (ledger rows, the longtail and park sheets, the company name) and the Pier Office lists (see "Pier office"). Dry run unless `--commit`; prints counts and baht totals beside legacy's. Until the pier area cuts over a rerun mirrors legacy: lists replaced whole, rows with legacy's ids and every sheet cell replaced, rows made here (`pc_…`) kept. Run after `seed:boats`. |
| `SOURCE_DATABASE_URL=… TARGET_DATABASE_URL=… npm run import:fleet [-- --commit]` | Seed fleet maintenance (engines, gearboxes, propellers and their histories, incidents, maintenance jobs) from legacy. Dry run unless `--commit`. A seed: run it once, after `seed:boats` and before anyone edits fleet here. Legacy's ids are upserted with their lists replaced; records created here are untouched. Lists what it skipped and legacy's oddities (duplicate numbers, a job link to a deleted job, `inprogress`/`high`). |
| `SOURCE_DATABASE_URL=… TARGET_DATABASE_URL=… npm run verify:import [-- --limit=N] [--json=file]` | Check what `import-legacy.ts` wrote against what legacy holds, read-only on both. Run it after an import with `--commit` into a local copy (see "Checking an import" below). Exit code 1 when anything differs. |

### Checking an import

The import's own report says what it wrote and what it skipped; `verify:import` says whether what it
wrote means what legacy meant. It shares no code with the importer (`src/tools/verify-legacy.ts`
restates the column contract and compares values by meaning: `7:30` is `07:30`, `'4800'` is
`4800`, no value is `false` for a flag), so a mapping bug shows up as a difference instead of being
repeated on both sides. Four levels:

1. **Every row:** bookings, trips, passengers, history lines, seat locks, deployments, capacity
   overrides, agents, markets, salespeople, rate types and vans are on both sides.
2. **Every column:** legacy columns that hold data but that no import code names. A column read
   through a name the code builds (`` `pax_${category}${suffix}` ``) counts as read; one built from
   two lookup tables is listed in `COMPOSED_READS`.
3. **Every value:** each imported booking's status and header fields, and each trip's route, date,
   mode, zone, pickup, overnight fields and passengers by category and residency.
4. **Every total:** seat and charter passengers per route and day, booking totals per month, active
   locked seats and boats per route and day.

The dry run rolls back, so there is nothing to compare until an import commits; do that on the
local copy, never on Railway:

```bash
docker compose --profile pull run --rm pull        # local `legacy` and `operations` from Railway
SOURCE_DATABASE_URL=postgres://postgres:postgres@localhost:55433/legacy \
TARGET_DATABASE_URL=postgres://postgres:postgres@localhost:55433/operations \
  npx tsx src/tools/import-legacy.ts --commit
SOURCE_DATABASE_URL=postgres://postgres:postgres@localhost:55433/legacy \
TARGET_DATABASE_URL=postgres://postgres:postgres@localhost:55433/operations \
  npm run verify:import -- --json=verify.json
```

A difference is not always a bug: a booking the importer skips on purpose is missing here too, and
a legacy column that belongs to an area not moved yet (money, check-in) is unread by design. The
report lists every one so a person can tell which.

Migrations are applied once and recorded in `schema_migrations`, so re-running is a no-op and a migration need not be idempotent. Each file and its ledger row commit together — a failure rolls the whole file back and records nothing. A session advisory lock serializes concurrent deploys. Migrations are checksummed, with line endings normalized to LF so a Windows checkout (`core.autocrlf`) and a Railway build agree: editing one that has already run is reported as a warning, because that database no longer matches a freshly migrated one. Fix such drift with a new migration rather than by editing history.

Deploys migrate themselves. `railway.json` runs `node dist/migrate.js` as `preDeployCommand`, so the schema moves after the build and before the new version takes traffic; if the migration fails the deploy is aborted and the previous version keeps serving. It runs the compiled migrator rather than `npm run db:migrate`, because that script goes through `tsx`, a devDependency the production build prunes. Run `npm run db:migrate` by hand for local databases, or against a production URL when you want to watch a destructive migration go in before deploying the code that needs it.

## Login and permissions

Legacy's logins live here (`users`, migration 027): its users are imported with their usernames and
password hashes as they are, so everyone logs in with the password they have. The server checks
every write against the caller's rights, which legacy checked only in the browser.

Authentication is on when `AUTH_JWT_SECRET` is set; then every route needs a Bearer token except
`POST /v1/login`, `/api/health` and `/docs`. Set `AUTH_REQUIRED=true` in Railway, so a missing
secret stops the service at startup instead of leaving it open. Without the secret nothing is
checked: local development and most tests.

```text
AUTH_REQUIRED=true
AUTH_JWT_SECRET=<random string, e.g. `openssl rand -base64 32`>
```

### Logging in

```bash
curl -X POST https://<host>/v1/login -H 'Content-Type: application/json' \
  -d '{"username":"RSVN01","password":"..."}'
# {"access_token":"…","token_type":"Bearer","expires_in":43200,"user":{…as GET /v1/me…}}
```

- The username is matched ignoring case, and the password against legacy's scrypt hash (`salt:key`,
  hex), unchanged. A wrong pair, an unknown username and a disabled user all answer the same `401`.
- **15 failed logins in 3 minutes** lock that username (`429`, saying how many seconds to wait) until
  the oldest of them is 3 minutes old. Counted per server instance, in memory.
- The token lasts 12 hours. Send `Authorization: Bearer <access_token>` on every request.
- Rights are read from `users` on every request, not from the token: a change of rights, a disable,
  a password reset or `POST /v1/logout` takes effect at once. The last three end every session the
  user already has (legacy `logout_after`).

| Endpoint | Who | What |
|---|---|---|
| `POST /v1/login` | anyone | `{username, password}` → token and user |
| `POST /v1/logout` | any login | ends all of the caller's sessions; `204` |
| `GET /v1/me` | any login | `{id, username, name, role, can_edit, edit_areas, can_edit_any, actions, view_perms, sales_id, agent_id, dept, …}` |
| `POST /v1/me/password` | any login | `{old_password, new_password}`; `403` when the old one is wrong. Ends the other sessions and answers a fresh token |
| `GET /v1/users` | admin | every login |
| `POST /v1/users` | admin | `{username, password, name?, role?, edit_areas?, can_edit?, actions?, view_perms?, sales_id?, agent_id?, dept?}` → `201`; `409` for a username taken (ignoring case) |
| `PATCH /v1/users/{id}` | admin | the same fields, and `disabled: true/false`. `password`, `username` and the stamps are refused (`400` naming what to use). An admin cannot disable or demote their own login |
| `POST /v1/users/{id}/password` | admin | `{password}`; ends the user's sessions |

A user is disabled, never deleted. Legacy's spellings `editAreas`, `canEdit`, `salesId` and `perms`
are accepted on `POST` and `PATCH`.

### What each login may do

Any login may read everything. A write needs an **edit area**, as legacy assigns them:

| Area | Writes |
|---|---|
| `operations` | bookings and their commands (a weather cancel's refund and credit, and insurance, included), seat locks, deployments, weather closures, a boat's seats for one day, nationalities, the daily report's settings; the Daily Fleet Log's water meters, issued and extra items and outside requests (as `fleet` does); the pier office (as `pier` does) |
| `fleet` | deployments, as well as `operations` (legacy's Fleet Deployment page saved nothing; Boat Operation deploys); retiring and restoring a boat; van rates; engines, gearboxes, propellers, incidents and maintenance jobs; stock, consumables, purchase memos, projects, the Daily Fleet Log, safety equipment (`/v1/fleet/…`); uploading files |
| `sales` | rate types, agents, promo contracts, contract templates and documents, the add-on catalogue, staff and their welfare quotas, sales targets and follow-up marks |
| `config` | routes, their families and calendar; boats (the whole boat form and its status timeline); salespeople, markets |
| `accounting` | invoices, their discounts and payments; accepting the pier's hand-over; commission payouts; also the Daily PFM decisions, pier payments and collecting an upgrade (legacy saves bookings for accounting too); partner van bills; van rates; the daily report's settings |
| `pier` | pier payments (`/v1/bookings/{id}/pier-payments`), handing the pier's cash over, check-ins; the pier office: petty cash and its sheets, the office lists (`/v1/pier-cash/…`, `/v1/pier-office/…`, as `operations` does, legacy's `poCanEdit`) |

- `role: admin` may do everything, including the user screens.
- **Edit areas follow legacy's `editInfo`:** a list in `edit_areas` decides, and `can_edit` is read
  only when there is no list, where `true` means every area. An empty list is read-only.
- A write no area covers is admin-only, so a new endpoint is closed until it is given one.
- `view_perms` (the pages legacy shows) is returned for the client and never enforced here.
- A refusal is `403` naming what is missing: `Needs the operations area`.

**Approving.** `approve` and `reject` need, beyond `operations`:

| The booking waits for | Who may decide |
|---|---|
| over the allotment | an admin, or a login with the `act-approve` right |
| FOC passengers | an admin, or `act-approve` |
| a discount | an admin, or the agent's salesperson (`users.sales_id` = the agent's `sales_id`) |

An approval carrying both an over-allotment and a discount needs both. The decision is stamped with
the caller's username. Action rights are `act-approve` and legacy's `act-capunlock` and `act-tmpl`;
any other is `400`.

**A login tied to one agent** (`agent_id`, for Love Kingdom's service user, `a_b2c`) books for that
agent only: a create without `agent_id` gets it, another agent is `403`, the list shows only its
bookings, any other booking is `404`, and every write outside `/v1/bookings` is `403` (so is the money
kept beside a booking: its PFM decisions, pier payments, on-tour sales and after-trip decisions), with one
exception: Love Kingdom's login (`a_b2c`) may also create routes, `POST /v1/routes`, without the
`config` area (see "Editing routes"). The `a_b2c` login's bad input is held for ops rather than
refused (`202`, see [Love Kingdom's push](#love-kingdoms-push-held-orders-and-b2c-issues)).

### Love Kingdom's API key

Love Kingdom's server may read `GET /v1/availability` with an `X-Api-Key` header instead of a Bearer
token, as it does legacy's `/api/b2c/availability`. The key is `B2C_API_KEY`, the same value legacy
uses. It grants **availability only**: any other route answers `403`, so the key can never book.
A wrong key is `401` even when a valid Bearer token is also sent, and so is any key while
`B2C_API_KEY` is unset. Booking needs the service user's Bearer token.

### Importing the users

```bash
SOURCE_DATABASE_URL=… TARGET_DATABASE_URL=… npm run import:users [-- --commit]
```

A dry run unless `--commit`. Rerunnable, matched by legacy id: until cutover legacy is the master
for its users, so a rerun brings their password changes and areas here, while what is set only here
(`act-approve`, `agent_id`, a disable) stays. A login made here is never touched, and a legacy user
whose username one already has is skipped and listed. Run it after the agents import, so each
salesperson's `sales_id` is found. A row that does not fit (an unknown area or right, a hash not in
legacy's format) is noted, never guessed.

`CORS_ORIGIN` must contain the frontend's exact HTTPS origin (multiple values can be
comma-separated); those origins may use `GET`, `HEAD`, `POST`, `PUT`, `PATCH` and `DELETE`.

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
- `GET /v1/routes/{id}` — one route, as the list shows it (`404` for an unknown one).
- `GET /v1/route-families` — the programme families the Booking calendar groups routes by:
  `{ families: [{ id, name, color, sort }] }`, by `sort` then `id`.
- `GET /v1/boats`, `GET /v1/boats/{id}` — the boat catalogue, every field of the boat form (see
  "Editing boats"), with `charter_ceiling` and `status_today` computed.

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
| `POST /v1/seat-locks`, `PATCH` moving one, `POST /v1/seat-lock-groups` | its day (a bulk lock: only the days the route runs become departures; a whole-boat hold too) |
| `/confirm`, `/approve`, `/reject`, `/cancel`, partial cancel | nothing: they do not choose a day |

A trip a `PATCH` leaves where it is was sold already, so a booking whose day closed after the sale
can still have its notes edited. (Legacy blocks every save of such a booking.) A booking whose
`external_id` starts with `b2c_`, legacy's mark for one synced from the B2C website, is saved on a
closed day on create and `PATCH`, as legacy saves it: it was paid before it arrived. Love Kingdom's
own bookings (`LOV-…`) are checked like any other.

Seasons may overlap; the one that starts first decides a day, as in legacy.

#### Editing the calendar

Legacy's Settings → Programs, as an API. The calendar is edited here and only here: `seed:routes`
copies it only for a route new here. Every write needs the `config` edit area.

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

#### Editing routes

Routes are edited here since 2026-10-09 (legacy's Settings → Programs and Love Kingdom's
`POST /api/b2c/routes`; `todo/catalogue-editing-model.md`). `seed:routes` fills a new database from
legacy and never overwrites a route edited here. Every write needs `config`, except Love Kingdom's
create.

| Endpoint | Body | Answers |
|---|---|---|
| `POST /v1/routes` | `{ name, kind?, pier?, family_id?, islands?, times?, color?, ext_id?, seasons? }` | `201 { created: true, route, warnings }`; an `ext_id` a route already has → `200 { created: false, route, warnings: [] }`, nothing changed |
| `PATCH /v1/routes/{id}` | any of `name, kind, pier, family_id, islands, times, color, ext_id` | `200` the route |
| `DELETE /v1/routes/{id}` | | `204`; `409 route_in_use` |
| `POST /v1/routes/order` | `{ pier, route_ids }` | `200 { routes: [{ id, sort }] }` |

- **Decided by the server:** `id` (`r<epoch ms>`, as legacy), `sort` (a new route goes last), and a
  `color` when none is sent (the next of legacy's eight). `id` and `sort` sent are `400`.
- **`kind` and `pier`:** a marine route sails from `tublamu`, `panwa` or `ranong` (required); a
  land route needs none but may name one. `pier: "other"` is legacy's old land marker and means
  `kind: "land"`. Legacy lets a route switch pier or kind with bookings on it; so does this.
- **`family_id`** must be a family (`GET /v1/route-families`); `null` means "no family", which hides
  the route from the Booking calendar, as legacy's blank choice does. **Left out on create**, it is
  guessed as Love Kingdom's create guessed it: a land route is `citytour` when its name says City
  Tour, else `transfer`; a marine one by its name (Similan, Surin, Phi Phi, Whale, …). No guess →
  `400`.
- **`times`** are `HH:MM`; blanks are dropped; a new route without any starts at `["08:00"]`.
- **`seasons`** on create only: `[{ kind, from_date, to_date }]` (Love Kingdom's `type`, `from`, `to`
  are accepted). After that the calendar has its own endpoints ("Editing the calendar").
- **Not kept here** (decided 2026-10-09): `daily_cap`, `code`, `meal_venue_id`. An empty one (`null`,
  `""`, `0`) is accepted and ignored; a real one is `400` saying so.
- **`ext_id`** (`^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`) is unique: another route's is `409 ext_id_taken`.
  `externalId` and `familyId` are accepted as legacy spells them.
- **`warnings`:** `duplicate_name` when another route has the same name (Love Kingdom's warning).
- **Delete** is refused while anything refers to the route, `409 route_in_use` naming what:
  `Route Surin (r5) is used by 3 bookings, 12 boat deployments, 1 rate type: it can't be deleted`.
  Counted: bookings, deployments, seat locks, rate types, agents' programme lists, contracts, van
  days, van groups, van stops, upgrades, pickup times. Otherwise its times, seasons and day
  overrides go with it. (Legacy deleted with no check.)
- **Order** is legacy's drag within one pier: `route_ids` lists every route of that pier once
  (`pier: null` = the routes with no pier, the land ones); they take those places in the new order
  and every route is renumbered `0…n-1`. Anything else in `route_ids` is `400`.

**Love Kingdom** creates its products with its service login (`agent_id: a_b2c`), which may call
`POST /v1/routes` and nothing else in the catalogue: see `docs/love-kingdom-integration.md`.

**Families** (`config`): `POST /v1/route-families { id?, name, color?, sort? }` → `201` (an `id` left
out is made from the name; one taken is `409 family_exists`); `PATCH /v1/route-families/{id}
{ name?, color?, sort? }` (the id is permanent, `400`); `DELETE /v1/route-families/{id}` → `204`, or
`409 family_in_use` while a route uses it. Migration 070 seeds legacy's ten.

#### Editing boats

Boats are edited here since 2026-10-09: legacy's boat form (`saveBoat`), its status timeline
(`saveStatus`) and its retire/restore. `seed:boats` fills a new database and never overwrites a boat
edited here.

| Endpoint | Area | Body | Answers |
|---|---|---|---|
| `POST /v1/boats` | `config` | the boat's fields, `status?` | `201` the boat, `warnings` |
| `PATCH /v1/boats/{id}` | `config` | any of the fields, `status?`, `capacity_anyway?` | `200` the boat, `deployments_updated`, `warnings`; `409 seats_sold` |
| `POST /v1/boats/{id}/retire` | `fleet` | `{ reason? }` | `200` the boat; `409 future_deployments`, `already_retired` |
| `POST /v1/boats/{id}/restore` | `fleet` | | `200` the boat; `409 not_retired` |
| `POST /v1/boats/{id}/status-log` | `config` | an entry, `plan_ahead?` | `201` the entry; `409 open_work` |
| `PATCH /v1/boats/{id}/status-log/{entry_id}` | `config` | entry fields, `plan_ahead?` | `200` the entry; `409 open_work` |
| `DELETE /v1/boats/{id}/status-log/{entry_id}` | `config` | | `204` |

A boat:

```jsonc
{ "id": "b12", "name": "Hermetis", "name_th": null, "type": "Speedboat", "pier": "panwa", "ownership": "own",
  "color": "#dfa006", "engine_count": 4, "capacity": 65, "license_pax": 75, "crew": 5, "fish_crew": null,
  "registered_persons": 80, "charter_ceiling": 75,
  "vessel_use": "บรรทุกคนโดยสาร (เร็ว)", "material": "อลูมิเนียม", "brand": null, "model": null,
  "reg": "6051/0244/7", "callsign": "HSB7808", "imo": null, "build_year": null, "homeport_city": "ภูเก็ต",
  "homeport": "ท่าการ ภูเก็ต", "owner": "บริษัท เลิฟ ไอแลนด์ จำกัด", "owner_addr": "9/244 …",
  "gt": 22.33, "nt": 15.18, "dwt": null, "loa": 18, "beam": 4.2, "depth": 1.2, "draft": null, "lbp": 16, "bhp": 186.5, "note": null,
  "documents": [{ "name": "ใบอนุญาตใช้เรือ", "expires_on": "2027-03-09", "renew_status": null }],
  "status_log": [{ "id": "sl1779722337776", "status": "unavailable", "from_date": "2026-05-25", "to_date": "2026-05-30",
    "loc": "Visit Panwa Pier · Phuket", "province": "Phuket", "loc_type": "Visit Panwa Pier", "detail": null, "note": null,
    "reason": "scheduled_maint", "project_id": null, "planned_over": null }],
  "status_today": "available", "status_effective": "fixing", "blocked_by": [{ "kind": "job", "id": "mj_…", "no": "MJ-058", "status": "fixing", "reason": "" }],
  "retired": false, "retired_on": null, "retired_reason": null, "unretired_on": null,
  "updated_at": "2026-10-09T08:00:00.000Z" }
```

- **Decided by the server:** `id` (`b<epoch ms>`), `charter_ceiling`, `status_today`, `updated_at`,
  and the retire fields (the commands set them). Sending any of them, or `status_log`, is `400`
  naming what to use.
- **`status_today`** is the status log's own answer; **`status_effective`** is today's status with the
  open work holding the boat (legacy `boatEffStatus`), and `blocked_by` that work (on `GET` only; see
  "Fleet maintenance"). A log entry's `planned_over` is set by `plan_ahead: true`, never sent.
- **Planned ahead** (legacy `saveStatus`'s confirm): saving an `available` entry while a started job
  still holds the boat on its first day is `409 open_work` naming the jobs; with `plan_ahead: true` the
  entry is saved with `planned_over` (those jobs stop holding the boat on its days; later work still
  does) and legacy's mark `วางล่วงหน้าทั้งที่ยังมีงานค้าง · MJ-…` appended to its note.
- **The form's defaults on create:** `capacity` 40, `engine_count` 4, `ownership: "own"`, and
  `registered_persons` = `license_pax + crew + fish_crew` (legacy `fmCalcTotal`) when not sent.
  `pier` (`tublamu`/`panwa`/`ranong`) and `name` are required; `type` is one of `Catamaran`,
  `Speedboat`, `Big Boat`, `Longtail`; `engine_count` 1–5; `license_pax`, `crew`, `fish_crew` `0` or
  blank mean none. Legacy's spellings (`cap`, `licensePax`, `totalcap`, `nameTh`, `use`, `year`,
  `docs`, …) are accepted.
- **Capacity above the licence is accepted**, as legacy accepts it: the answer warns
  `capacity_above_licence`, and a day sells at most the licence (`deploymentSeats`).
- **`documents`** replace the list: `[{ name, expires_on?, renew_status? }]`, `renew_status`
  `processing`, `done` or none. Their expiry state and the renewal dialog are
  `GET /v1/boats/{id}/documents` and `POST …/documents/renew` (see "Fleet maintenance: assignments,
  certificates, replace wizard, reports"), as are `pier_today`, `at_shop` and the pier assignments.
- **`status`** is the form's pick (`available`, `fixing`, `unavailable`). A new boat starts its log
  with it (default `available`); on an edit, when it differs from today's stored status, an
  open-ended entry from today is added at the boat's pier, after closing what it overlaps (legacy
  `autoClosePrevLog`: an entry running into it ends yesterday; one starting today or later is
  removed).
- **A capacity change reaches the boat's deployments** from today (Thai time) on: a `PATCH` that
  changes `capacity`, `license_pax` or `registered_persons` rewrites them on every such deployment
  (legacy reads the boat live; here a deployment copies it). Before it does, each day that loses
  seats is weighed: the passengers placed on the boat that day against its new seats (a day's own
  seats, below, still win; a chartered day counts against the licence). A day over is
  `409 seats_sold` listing the days, unless `capacity_anyway: true`; then the answer carries
  `warnings: [{ code: "oversold", route_id, service_date, boat_id, bookings, pax, seats }]`.
- **Retire** is refused while the boat is deployed from today on (`409 future_deployments`, naming
  the days). It stamps `retired_on` and `retired_reason` and logs a `retired` entry; restore stamps
  `unretired_on` and logs `available`. A retired boat can't be deployed (`409 boat_retired`).
- **The status timeline:** an entry is `{ status, from_date, to_date, province, loc_type, loc?,
  detail?, note?, reason? }`; `to_date`, `province` and `loc_type` are required, and `reason` when
  `unavailable` (legacy's checks). Adding one closes or trims what it overlaps first; editing changes
  it in place. Fleet's own rules (open jobs, maintenance links) come with fleet maintenance.

`charter_ceiling` is how many passengers a charter may fill the boat to, resolved for you.
`license_pax` is `null` for a boat with no licence on file — the charter boats have none — and in
that case `charter_ceiling` falls back to `capacity`. **A missing licence is not a licence of zero.**
The null is reported rather than quietly replaced by `capacity`, because claiming a registration a
vessel does not hold is worse than saying it has none; read `charter_ceiling` for the number and
`license_pax` for whether it is a legal figure or a fallback.

#### A boat's seats for one day

Legacy's "cap" dialog on Boat Operation (`boatCapSet`): one boat's seats on one date, instead of its
normal number. Area `operations`.

| Endpoint | Body | Answers |
|---|---|---|
| `GET /v1/boats/{id}/capacity-overrides[?from=&to=]` | | `{ overrides: [day] }` |
| `PUT /v1/boats/{id}/capacity-overrides/{date}` | `{ capacity, reason }` | `200` the day |
| `DELETE /v1/boats/{id}/capacity-overrides/{date}` | | `204`; `404` when the day has none |

```jsonc
// day
{ "boat_id": "b12", "service_date": "2026-10-12", "capacity": 67, "normal": 65, "ceiling": 75,
  "overridden": true, "reason": "รับเกินมา 2", "set_by": "ops1", "set_at": "2026-10-09T08:00:00.000Z" }
```

- **Normal** is the day's deployment capacity, else the boat's. **The ceiling** is the licence, else
  the boat's capacity (legacy `boatCapLicense`): above it is `400` (legacy clamped silently).
- **Raising** above normal and above what the day already has needs the `act-capunlock` right or an
  admin: `403` with legacy's message. Lowering, or keeping part of a raise someone else set, needs
  only `operations`.
- **A reason** is required when the number differs from normal. Sending the normal number removes
  the day's seats, as legacy does.
- **No past day** (Thai time): `409 past_date`, for `PUT` and `DELETE`.
- Who and when are the server's: `set_by` the login, `set_at` now. (Legacy recorded `—`.)
- Availability applies it (`deployed_capacity`), clamped to the licence; the trip-ops raise writes
  the same row. A day set here survives the legacy import.

### Agents

Resellers, the markets they sell into, and the salespeople who own them. **This API is the master
for agents, markets and salespeople** (moved 2026-10-09, todo/sales-editing-model.md): edit them
here, not in legacy. `import-legacy.ts --sales` imports them once, to seed an empty database, with
legacy's ids (`a01`, `a_b2c`, …), the ids `bookings.agent_id` and `seat_locks.agent_id` already hold;
without `--sales` the import leaves them alone.

**A sales-bound login sees only its own agents.** A login with a `sales_id` that is not an admin
(legacy's `laSalesScoped`) lists only agents with that salesperson; opening another salesperson's
agent, its activity, seasons, rate type or documents, or a contract or document of theirs, is `403`
(`This agent belongs to another salesperson`), and so is every write to it. `GET /v1/contracts`
lists only its agents' contracts. House agents have no salesperson, so they are out of its scope, as
in legacy. Any other login reads every agent.

- `GET /v1/markets`, `GET /v1/sales`: see [Salespeople and markets](#salespeople-and-markets).
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
  - `credit`: `{ limit, used, available, pct, over }`, worked out (see "Invoices and payments")
  - `contract_history`: what each renewal archived, newest first: `[{ version, archived_at, contract_start,
    contract_end, rate_type_id, programs, signatory, archived_by }]`
  - `contract_template_effective_id`: the template its contract prints with: the bound one if it
    exists and is active, else the default (legacy `ctTmplForAgent`).
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
- **`house`** marks `a_walkin`, `a_staff`, `a_company` and `a_b2c`: accounts the business sells through itself.
- **`rate_type_id`** is the rate type the agent is priced with (see [Rate types](#rate-types)). A write
  checks it exists; the column has no foreign key (legacy agents name rate types legacy deleted).
- **`code`** is unique ignoring case for a new or changed code (`409 code_taken`). Legacy never
  checked, and 21 of its codes are shared by 2–3 agents; those stay until sales cleans them.
- **Not here:** per-agent add-on prices (legacy never saved them).

#### Creating and editing agents

Writes need the `sales` area (and a sales-bound login, its own agents: see above). Each answers the
agent as `GET /v1/agents/{id}` does, and writes one line per change to its activity, in legacy's
wording and signed with the login (legacy's `by` was always blank).

- `POST /v1/agents` → `201`. The body is the detail's client facts (flat fields and the `company`,
  `signatory`, `booking_channel` groups) plus `rate_type_id`. Required, as legacy's form: `name`,
  `company.legal_name`, `company.address`, `market_id`, `rate_type_id`, `pay_type`, `vat_mode`
  (`400 Missing: …`). The server makes the `id`, the `code` when none is sent (the name's first 8
  letters and digits, numbered on a clash), the contract fields (`active`, `v<year>-1`, today to a
  year less a day), the programmes (every route the rate prices, booked within the contract dates)
  and legacy's defaults (credit 0 unless `pay_type` is `invoice`; company tel = phone; signatory =
  contact, `Authorized Signatory`, phone; legacy's booking channel). A sales-bound login's agent gets
  its salesperson. `409 possible_duplicate` when an agent's name matches once normalised (legacy's
  `agFindDup`), unless `create_anyway: true`. A sub-market new to the market joins its list.
  ```jsonc
  { "name": "Sun Tour", "market_id": "ru", "pay_type": "invoice", "vat_mode": "exclude", "rate_type_id": "rt003",
    "credit_days": 30, "credit_limit": 200000, "email": "ops@sun.test",
    "company": { "legal_name": "Sun Tour Co., Ltd.", "address": "1 Beach Rd" } }
  ```
- `PATCH /v1/agents/{id}`: the client facts it names; a group merges field by field. Sending the
  whole `GET` back is fine: a server-owned field that repeats the stored value is ignored, and a
  different one is `400` naming the command (`rate_type_id cannot be changed here: use PUT
  /v1/agents/{id}/rate-type`). `name`, `company.legal_name`, `market_id`, `pay_type` and `code` cannot
  be cleared. Credit days and limit stay as sent whatever the payment type (legacy).
- `PUT /v1/agents/{id}/programs` `{ "programs": [{ "route_id": "r5", "book_from": …, "book_to": …, "note": … } | "r6"] }`:
  the whole list, in order, one row per route. A bare route id keeps that route's window and note.
- `PUT /v1/agents/{id}/rate-type` `{ "rate_type_id": "rt005", "drop_unpriced": true }`: the rate (or
  `null`); the agent's main contracts that are not expired or void take it (legacy `_ctSyncMainRate`);
  a route the rate prices joins the programmes. When the agent sells routes the new rate does not
  price, `drop_unpriced` must say whether to remove them (legacy's confirm): absent is
  `409 unpriced_programs` naming them. A rate owned by another salesperson is `400`.
- `POST /v1/agents/{id}/renew` `{ "version": "v2027-1", "start": "2027-10-01", "end": "2028-09-30",
  "rate_type_id": "rt009", "carry": { "programs": true, "booking": true, "signatory": false, "company": true } }`:
  legacy's renewal. It archives the contract fields into `contract_history`, sets the new ones, moves
  every programme's booking window by as many days as the start moved, applies a new rate to the main
  contracts, and clears what is not carried (no programmes; an empty booking channel; the signed
  date; the company fields). No contract row is made, as in legacy. `400` unless `end` is after `start`.
- `POST /v1/agents/{id}/deactivate`, `/activate`. A booking for an inactive agent is refused
  (`409 agent_inactive`); its existing bookings are untouched.
- `DELETE /v1/agents/{id}` → `204`, an admin only, and only while no booking, contract, seat lock,
  invoice or login names it (`409 in_use`: deactivate it instead).
- `GET /v1/agents/{id}/documents`, `POST /v1/agents/{id}/documents`: see
  [Contract templates and documents](#contract-templates-and-documents).

#### Rate seasons

Which rate type an agent is priced at, by travel date (legacy's season table on the agent). A season
is a rate type from a travel date, to a date or with no end. For a date, the covering season with
the latest `from` wins; a date no season covers is priced at the agent's own `rate_type_id`.
Legacy keeps seasons only in browsers, so they start empty here and sales re-enter them.

- `GET /v1/agents/{id}/rate-seasons` → `{ "seasons": [{ "rate_type_id": "rt003", "from": "2026-11-01", "to": "2027-04-30" }, …] }`,
  by `from`; `to` is `null` for no end. Also on `GET /v1/agents/{id}` as `rate_seasons`.
- `PUT /v1/agents/{id}/rate-seasons` with `{ "seasons": [...] }` replaces the whole table (`[]`
  clears). Legacy's `{ "rt", "from", "to" }` is accepted, a blank `to` meaning no end. Needs the
  `sales` edit area. Answers the table, and writes legacy's line to the agent's activity
  (`ตั้งตารางฤดูกาล 2 ช่วง · …`). `404` for an unknown agent; `400` for an unknown rate type, a date
  not `YYYY-MM-DD`, a season ending before it starts, or two starting the same day.
- `GET /v1/agents/{id}/rate-type?date=YYYY-MM-DD` → the rate type for that travel date:
  `{ "rate_type_id": "rt003", "source": "season", "season": {…} }`, or `"source": "agent"` and
  `"season": null` when no season covers it.

A rate type a season uses is in use: `DELETE /v1/rate-types/{id}` refuses it (`409`).

### Contracts

An agent's contracts: one `main` contract (its rate type and the routes it covers), imported once
from legacy, and time-boxed `promo` overlays, written here (legacy's promo form). Two agent commands
change a main contract: a rate type change or a renewal with a new rate sets the rate of the agent's
main contracts that are not expired or void, and issuing a document stamps `doc_id`. The quote
prices from them ([Quote](#quote)). Any login may read them; a sales-bound login, only its own
agents' (see [Agents](#agents)).

- `GET /v1/contracts?agent_id=&kind=&status=` → `{ "contracts": [...] }`, by agent, then main
  before promo, then the latest `active_from` first. `kind` is `main` or `promo`, `status` is
  `active`, `expired` or `void`; anything else is `400`.
- `GET /v1/contracts/{id}` → one contract; `404` when unknown.

```jsonc
{ "id": "ctmuzot869guphq", "agent_id": "amuzop15vupelw", "kind": "promo", "status": "active",
  "rate_type_id": null, "active_from": "2026-10-08", "active_to": "2026-10-15", "priority": 10,
  "version": "promo-2026-10-08", "price_mode": "own", "discount": null, "bonus": null, "book_window": true,
  "created_date": "2026-10-08", "created_by": "SALES.MAM", "note": null, "doc_id": null,
  "voided_at": null, "voided_by": null, "state": "active", "bonus_progress": null,
  "program_periods": [{ "route_id": "r10", "book_from": "2026-10-08", "book_to": "2026-10-15",
                        "travel_from": "2026-10-08", "travel_to": "2026-10-15", "note": null }],
  "seat_prices": [{ "route_id": "r10", "zone": "PK", "category": "ad", "residency": "thai", "price": 1500 }] }
```

| Field | Meaning |
|---|---|
| `id` | Legacy's id, kept: bookings will refer to a promo by it |
| `rate_type_id` | A main contract's rate; a promo's when `price_mode` is `rate`. `null` when none |
| `active_from`, `active_to` | The travel dates the contract covers |
| `priority` | Between promos covering one trip, the higher wins (then the later `active_from`) |
| `price_mode` | Promos only: `rate` (a rate type), `own` (`seat_prices`) or `discount` (off the main rate). `null` on a main contract |
| `discount` | `{ mode: "pct" \| "amt", value }` on a discount promo, else `null` |
| `bonus` | `{ buy, free, basis }`, "buy N get one free", else `null` |
| `book_window` | The promo also checks the booking date against each period's `book_from`..`book_to` |
| `program_periods` | The routes covered, with their booking and travel windows, in legacy's order. A `null` travel bound is open |
| `seat_prices` | An own-price promo's prices, in rate types' vocabulary (`ad`/`chd` × `thai`/`foreign`) |
| `voided_at`, `voided_by` | When and by whom a promo was voided here; `null` otherwise (and on legacy's two) |
| `state` | Computed, legacy's badge: `void`, `expired` (past `active_to`), `scheduled` (before `active_from`), else `active` |
| `bonus_progress` | Computed for a promo with a bonus that is not void (legacy `laPromoStat`), else `null`: see below |

**Promotions** (legacy's "+ เพิ่ม Promotion" form, `ctSaveAddPromo`; area `sales`, a sales-bound
login only for its own agents):

- `POST /v1/contracts` → `201` and the contract:

```jsonc
{ "agent_id": "a06", "price_mode": "discount", "discount": { "mode": "pct", "value": 10 },
  "active_from": "2026-11-01", "active_to": "2027-03-31", "book_from": "2026-10-10", "book_to": "2026-10-31",
  "route_ids": ["r10", "r12"], "bonus": { "buy": 10, "basis": "adchd" }, "priority": 10, "note": "Xmas Promo" }
```

  `price_mode` is `rate` (with `rate_type_id`), `own` (with `seat_prices`, the read's shape, zones
  `PK`, `KL`, `NoTransfer`) or `discount` (with `discount`). `active_from`/`active_to` are the travel
  dates; `book_from`/`book_to` are optional, and either one turns on the booking window (a missing
  bound is the travel date). Each route becomes a period with those windows. `bonus` is "buy N, get
  one free" (`basis` `adchd` adults and children, or `ad`). `priority` defaults to 10. The server sets
  `version` (`promo-<active_from>`), `status`, `created_date`, `created_by`.
- `PATCH /v1/contracts/{id}`: any of those fields but `agent_id`; the rest is the stored promo's,
  and the whole promo is checked again. Fields the server sets may be echoed, not changed (`400`).
  Unchanged → `200`, nothing written.
- `POST /v1/contracts/{id}/void` → the contract, `status: "void"`, `voided_at`, `voided_by`. The quote
  skips it from then on; trips already sold keep their price.

Legacy's checks: travel dates required and in order; a booking window in order; at least one route,
each one of the agent's programmes or its main contracts' routes (or the edited promo's own); a
mode's fields only with that mode. `own` keeps only zones with an adult price above 0, and needs
one; `discount` needs a value above 0, a percentage below 100 and an amount below the cheapest adult
price above 0 the main rate has on those routes (it would read as not sold); `rate` needs a rate
type that exists. All `400`. Then legacy's confirms, as flags:

| Refusal | When | Send to go ahead |
|---|---|---|
| `409 routes_unpriced` | a route has no own price, or no main-contract price to discount: it sells at the standard rate | `unpriced_anyway: true` |
| `409 promo_sold` | editing a promo trips were already priced with (bookings that hold seats) | `sold_anyway: true` |
| `409 contract_void` | editing or voiding a void promo | — |

A main contract is `400` on `PATCH` and void: it follows its agent. Each write adds a line to the
agent's activity (`Promotion added · Xmas Promo · ลด 10%`).

`bonus_progress` counts the agent's bookings that hold seats, on the promo's routes and travel
dates (and booking window): `sold` (adults, plus children when `basis` is `adchd`), `bookings`,
`earned` (`sold` ÷ `buy`), `used` (the FOC seats on those trips, whatever the reason), `left`,
`over`, `to_next`, `pct`. It counts only; nothing is added or blocked.

**Importing them:** `SOURCE_DATABASE_URL=… TARGET_DATABASE_URL=… npm run import:contracts -- --seed [--commit]`,
a dry run unless `--commit`, after `seed:routes` and the agents and rate types imports. Without
`--seed` it writes nothing: contracts are this API's. `--seed` seeds a database that has none: legacy
wins for every contract it has (its periods and prices replaced whole, a rate or `doc_id` set here
overwritten; a void made here stays only while legacy's row is void too); one only this service has
is left alone. What does not fit is listed: a contract whose agent is gone is skipped, a rate type
that no longer exists becomes `null`, a period whose window runs backwards is dropped (legacy could
never match it).

### Contract templates and documents

A **template** is the wording and style an agent's contract prints with (legacy's Contract Templates
screen). Area `sales` for writes; any login reads.

- `GET /v1/contract-templates?active=` → `{ "contract_templates": [summary…] }` by code; a summary
  has no `sections`/`text` and adds `agents`, how many agents are bound to it. `active` is `true`,
  `false` or absent for all.
- `GET /v1/contract-templates/{id}` → the template with `sections` (`{ "cover": true, … }`) and
  `text` (`{ "en": { "childRateTitle": "…", "notRecItems": ["…"] }, "th": { … } }`), and `agents`.
- `POST /v1/contract-templates` → `201`. Any of `code`, `name`, `note`, `active`, `form`, `accent`,
  `accent_hex`, `font`, `sections`, `text`; what is not sent is copied from the default (legacy
  `cttNew`), the name defaults to `Template ใหม่` and the code to the next free `CT-NN`. The first
  template is the default.
- `PATCH /v1/contract-templates/{id}`: those fields. `409 code_taken` for another template's code
  (ignoring case); `409 default_template` to switch the default off; `400` for `is_default` (use the
  command) or an `accent_hex` that is not `#RRGGBB`.
- `POST /v1/contract-templates/{id}/default`: makes it the one default, and active.
- `DELETE /v1/contract-templates/{id}` → `204`; `409 default_template` for the default. Its agents
  fall back to the default, each with a line in its activity.

A **document** is a contract issued to an agent, frozen as it was printed (legacy's
`agent_artifacts`): a template or rate edited later does not change it.

- `POST /v1/agents/{id}/documents` → `201`, body `{ "lang": "en" | "th", "contract_id"?, "template_id"?,
  "page_count"?, "content": { … } }`. `content` is the render (sections, style, the template's text,
  overrides, custom clauses), stored as sent. The server records `id` (`gc_…`), `version` (the agent's
  contract version, else `draft`), `generated_at`, `generated_by`, `template_name`, and `rate_type_ref`
  and `rate_type_name` (the contract's rate, else the agent's); it stamps the contract's `doc_id` and
  writes `Contract generated · v2025-1 · EN` to the activity. `400` for a contract of another agent or
  an unknown template.
- `GET /v1/agents/{id}/documents` → `{ "documents": [summary…] }`, newest first, without `content`.
- `GET /v1/contract-documents/{id}` → the document with `content`.
- `DELETE /v1/contract-documents/{id}` → `204` (legacy's "Remove from history"); clears the contract's
  `doc_id` if it was this one.

### Salespeople and markets

Legacy's Team & Markets screen; writes need the `config` area. Any login reads.

- `GET /v1/sales` → `{ "sales": [{ id, code, name, full_name, designation, email, tel, color, active,
  has_signature }] }` by name. An inactive salesperson can still own agents.
- `GET /v1/sales/{id}` → the same with `signature`, a `data:image/png;base64,…` URL (it can be
  several hundred KB, so the list leaves it out).
- `POST /v1/sales` → `201`: `code` (1–3 characters, uppercased, unique ignoring case:
  `409 code_taken`) and `name` required; `full_name`, `designation` (default `Sales Executive`),
  `email`, `tel`, `color`, `signature` (a PNG or JPEG data URL up to 1 MB, or `null`), `active`.
- `PATCH /v1/sales/{id}`: those fields.
- `DELETE /v1/sales/{id}` → `204`: their agents are left with no salesperson, each with a line in its
  activity (legacy `tmDeleteSales`). `409 in_use` while a login or a rate type names them: make them
  inactive instead.
- `GET /v1/markets` → `{ "markets": [{ id, name, color, sort, subs: [name…] }] }`, by `sort`
  (unsorted last), then id.
- `POST /v1/markets` → `201`: `id` (lowercase letters and digits; `409 exists`), `name`, `color`,
  `subs` (blanks and repeats dropped). A new market goes last.
- `PATCH /v1/markets/{id}`: `name`, `color`, `subs`. The id never changes.
- `PUT /v1/markets/order` `{ "ids": [...] }`: every market once, in the new order.
- `DELETE /v1/markets/{id}` → `204`; `409 in_use` while an agent is in it.

An agent's `sub_market` is free text; a new one joins its market's `subs` when the agent is saved.

### Sales Board

Legacy's Sales Board: each salesperson's monthly pax target, their follow-up ticks on their agents,
and the leaderboard drawn from bookings. Writes need the `sales` area.

- `PUT /v1/sales/{id}/targets/{month}` `{ "pax": 120 }` → `{ "sales_id", "month", "pax" }`. A whole
  number ≥ 0; `0` or `null` clears it. A sales-bound login cannot set targets (`403`, as legacy showed
  the edit only to others).
- `PUT /v1/sales/{id}/followups` `{ "month": "2026-10", "agent_id": "a56", "kind": "agent" | "foc", "marked": true }`:
  sets or clears one tick (`agent`: followed up; `foc`: FOC feedback collected). The agent must be
  this salesperson's (`400`); a sales-bound login marks only its own board (`403`).
- `GET /v1/sales-board?month=YYYY-MM` (default this month), any login:

```jsonc
{ "month": "2026-10", "previous_month": "2026-09", "total_pax": 1234,
  "sales": [ { "sales_id": "s01", "name": "IRIS", "code": "IR", "color": "#0F6E56", "pax": 412, "foc": 6,
               "target": 400, "target_pct": 103, "reached": true, "streak": 2, "rank": 1, "previous_rank": 2,
               "bookings": 97, "agents": 140, "agents_with_sales": 38 } ],
  "agents": [ { "agent_id": "a56", "name": "…", "sales_id": "s01", "pax": 40, "previous_pax": 25, "foc": 2,
                "trend": { "category": "up", "pct": 60, "change": 15 }, "followed": true, "feedback_collected": false } ] }
```

Everything here is computed, as legacy computes it. Pax count by **trip month** (each passenger,
infants and FOC included), on bookings that hold seats, for the agent's salesperson today. `sales` is
every active salesperson, most pax first (`rank`; ties in id order). `streak` is the months in a row,
back from this one, whose target was met (24 at most). `agents` lists agents with pax this month or
last: `trend` is `new` (none last month), `gone` (none now), `flat` with only `change` when last month
was under 5, else `up` (+25 % or more), `down` (−20 % or less) or `flat`. A sales-bound login sees the
whole leaderboard and only its own agents.

### Staff and welfare quotas

Legacy's Staff & Welfare screen: staff, the free (FOC) welfare seats each may take in a year, and
what bookings used. Writes need the `sales` area; any login reads.

- `GET /v1/staff?year=2026` (default this year) → `{ "year", "staff": [{ id, code, name, dept, active,
  quotas: { "2026": 3 }, quota, used, remaining }], "totals": { active, all, quota, used } }`, by id.
  `used` is the FOC seats on that year's trips of the member's bookings that hold seats and are not
  an inspection.
- `GET /v1/staff/{id}?year=`, `GET /v1/staff/trips?year=` → `{ "trips": [{ booking_id, staff_id,
  service_date, route_id, purpose: "welfare" | "inspection", foc, head, paid }] }` by date.
- `POST /v1/staff` → `201`: `name`, `code`, `dept`, `active`, all optional. The id is `st<n+1>`, the
  code `EMP-<n+1>`, a quota of 3 for this year (legacy `staffAdd`). Codes need not be unique.
- `PATCH /v1/staff/{id}`: `name`, `code`, `dept`, `active`; `quotas`, `used` and the rest may be echoed,
  not changed (`400`).
- `PUT /v1/staff/{id}/quotas/{year}` `{ "free_seats": 3 }` → the member, viewed for that year.
- `DELETE /v1/staff/{id}` → `204`; `409 in_use` while a booking names them (make them inactive).

**On a booking** (`POST /v1/bookings`, and `PATCH` when trips, pax, `staff_id`, `staff_purpose` or
`purpose` change): a booking on the staff account (`a_staff`) needs `staff_id` (`400`); a `staff_id`
sent must be a staff member (`400`); a welfare booking (not `staff_purpose: inspection`) whose FOC
seats in a year exceed what that year has left, this booking aside, is refused until the body says
`"quota_anyway": true`:

```json
{ "statusCode": 409, "code": "over_quota", "error": "Conflict",
  "message": "Free welfare seats exceed the quota: 2026: 1 free seat left, 3 requested, over by 2. The over-quota people should be Adult (charged at the staff rate), not FOC. Send quota_anyway: true to save anyway." }
```

The price is unchanged by this: welfare is priced at the staff rate, FOC seats free, an inspection at
0 ([Prices](#prices)).

### Add-on services

The catalogue of extra services sales offers, with their variants and prices (legacy's "Add-on
Services" screen, which never saved). It starts empty: what it lists comes from sales. Booking add-ons
are still priced from rate types ([Add-ons](#add-ons)). Area `sales` for writes.

- `GET /v1/addon-services?active=` → `{ "addon_services": [...] }` by `sort`, then name.
- `GET /v1/addon-services/{id}`.
- `POST /v1/addon-services` → `201`, `PATCH /v1/addon-services/{id}`, `DELETE /v1/addon-services/{id}` → `204`.

```jsonc
{ "id": "aos_mv0…", "name": "Long-tail Boat (Pileh Lagoon)", "type": "boat", "description": "…", "active": true, "sort": null,
  "variants": [ { "id": "v_mv0…", "name": "Join Long-tail", "unit": "per person · share boat", "selling": 280, "net": 180 } ],
  "created_at": "…", "updated_at": "…" }
```

`name` and `type` (`boat`, `van`, `guide`, `other`) are required; `variants` replaces the whole list,
a variant's `id` is made when absent, and prices are numbers ≥ 0 or `null`.

### Nationalities

The list the booking form picks a nationality from: legacy's 73 built-ins and the custom ones staff
add. Passengers' `nationality` stays free text.

- `GET /v1/nationalities` → `{ "nationalities": [{ code, name, custom }] }`: the built-ins, then the
  custom ones as they were added, `OTHER` last (legacy `bkV2AllNats`).
- `POST /v1/nationalities` `{ "name": "Ghanaian" }`, area `operations`: legacy's `bkV2AddCustomNat`.
  The name is cleaned (a ` · CODE` suffix, stray brackets and punctuation removed); fewer than 2
  letters is `400`. One whose name matches ignoring case and punctuation, or whose code is the text, is
  answered `200` with `created: false`; else a custom one is made, coded with the first three
  letters (`CUS` when there are none), numbered on a clash, `201` with `created: true`.

Legacy's 66 custom ones arrive with the import, duplicates included; merging them rewrites bookings
and is a later decision.

### Rate types

A rate type is a price list: what an agent pays per seat on each route and pickup zone, per charter
boat, and per add-on. Reads are open to any login; writes need the `sales` edit area. Nothing
prices a booking from them yet; that is the quote, a later slice (`todo/pricing-model.md`).

**This API is the master for rate types** (moved 2026-10-09): edit them here, not in legacy. The
legacy import leaves them alone. `import-legacy.ts --rate-types` imports them once, to seed a database
that has none, with legacy's ids (`rt003`, `rt_staff`, …), the ids `agents.rate_type_id` and
`bookings.rate_type_ref` already hold. Legacy dropped some prices on save, so they were never there
to import and are entered here: RN prices, longtail charters, transfers outside r4, r5, r6, r10, r11
and r12, a bundle's `applies_to`.

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

- `POST /operations/deployments` — `{ boat_id, route_id, service_date, capacity, license_pax?, registered_persons?, remove_anyway?, deploy_anyway? }`; creates or replaces a boat's deployment for that date. `license_pax` is the boat catalogue's: taken from it when omitted, and a different value is `400` (a boat not in the catalogue keeps what is sent).
- `DELETE /operations/deployments/{service_date}/{boat_id}[?remove_anyway=true]` — removes a deployment: `204`, or `200 { warnings }` when it went ahead with `remove_anyway`.
- **Guards** (legacy `bop2GuardPast`, `bop2UnassignBoat`; decided 2026-10-09):
  - a date before today (Asia/Bangkok) is `409 past_date`, except for an admin correcting history;
  - a boat a charter booking holds can't leave its route: `409 charter_boat` ("Cancel the charter booking first");
  - nor can a boat an active whole-boat hold takes on its route that day: `409 boat_held` ("Release the hold on the Seat Locks page first"; legacy `opHoldOnly`);
  - removing a boat, moving it to another route, or shrinking it below the passengers **placed on it** that day (as legacy counts: not the whole route-day) is `409 seats_sold` ("N booking(s) (P pax) on it"), unless `remove_anyway: true` (legacy's confirm dialog). Then the answer carries `warnings: [{code: "boat_pulled" | "oversold", route_id, service_date, boat_id, bookings, pax}]`, and those bookings read `boat_pulled: true`.
  - a catalogue boat that is not ready that day (fixing, unavailable or retired in its log, held by a
    started job, or a charter boat not chartered that day: `GET /v1/fleet/availability`) is
    `409 boat_not_ready` when it is put on a route or moved to another, unless `deploy_anyway: true`;
    then the answer warns `{code: "boat_not_ready", boat_id, service_date, status, not_chartered,
    blocked_by}`. Legacy's Boat Operation offers only ready boats and its bulk forms skip the rest, so a
    range form gets the `409` per day and skips it. A deployment that stays on its route (a capacity
    change) is not asked.
  - `available_seats` goes negative on an oversold day; it shows the oversell.
- `GET /operations/deployments?from=&to=&route_id=` — lists deployments.
- `GET /operations/allotment?route_id=&service_date=` — deployed, booked, locked, and available seat totals, with contributing deployments.
- `GET /v1/manifest?date=&route_id=` — allotment plus bookings for the operating day.
- `GET /v1/availability?route_id=&date=` — booking-form availability for one route on one day:
  `{ route_id, service_date, deployed_capacity, licensed_capacity, booked_pax, charter_pax, locked_pax, available_seats, unlimited, unplaced_pax, licensed_free }`.
  `available_seats` is `null` on a land route (`unlimited: true`); see "Land routes and days with no boat".
- `GET /v1/availability?from=&to=[&route_id=]` — the same numbers for a range, both ends inclusive,
  for one route or, without `route_id`, every route in the catalogue:

  ```jsonc
  { "days": [
    { "route_id": "r1", "service_date": "2031-03-01", "open": true,
      "deployed_capacity": 40, "licensed_capacity": 45, "booked_pax": 8, "charter_pax": 4,
      "locked_pax": 0, "available_seats": 22, "unlimited": false, "unplaced_pax": 0, "licensed_free": 27,
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
| `capacity` | seats the company sells. A commercial decision, copied from the boat to each deployment (a boat edit rewrites its future ones). It may be above the licence; the licence still caps what is sold. |
| `license_pax` | the registered maximum **passengers**. The legal ceiling. |
| `registered_persons` | `license_pax + crew` — total persons the vessel may carry. **Never a selling ceiling.** |

`deployed_capacity` is what the seat pool offers: the deployment's capacity, replaced by a
`boat_capacity_overrides` row when the day has one, then clamped by the licence. `licensed_capacity`
is the passenger ceiling a **charter** may fill the boat to — higher than the selling cap on
purpose, because a charter buys the whole boat.

A boat with no licence on file — three Ranong boats have none — falls back to its capacity. A
missing licence is not a licence of zero.

`licensed_free` is the registered passenger seats still left on the unchartered boats: their
licensed seats less the passengers booked (locks are not subtracted). It is how far an
over-allotment approval may still go, and the approval card's **Real seats left** (legacy
`licenseAvailable`). Never negative; `0` with no boat deployed; `null` on a land route.

#### What `available_seats` subtracts

```
available_seats = sellable seats on boats not chartered
                − booked_pax                 (seat trips, including seats drawn from locks)
                − locked_pax                 (what locks still hold: pax − drawn, per lock)
                − passengers of any charter whose boat is unknown
```

- **A charter takes its whole boat.** The chartered boat's sellable seats leave the pool, however
  few passengers the charter carries; `deployments[].chartered` marks it. A charter trip split over
  several boats (its dispatch `boat_splits`) takes every one of them, as legacy (`baCharterBoatMap`):
  each leaves the sellable and the licensed seats, and takes no seat booking (`409 boat_chartered`)
  or other charter. `charter_pax` is reported
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

### Fleet maintenance: availability, engines, incidents, jobs

Legacy's Fleet screens (`05-fleet.js`), part A (todo/fleet-maintenance-model.md, decided
2026-10-09): whether a boat can sail, its engines, gearboxes and propellers, incidents and
maintenance jobs. Writes need the `fleet` area. Stock, purchase memos, the Daily Fleet Log, projects,
safety equipment and consumables are part B ("Fleet maintenance: stock, memos, projects…"); where the
two meet is `src/domain/fleet-seams.ts`.

**Availability** (legacy `boatEffStatus`, `boatJobBlock`):

- `GET /v1/fleet/availability?from=&to=&boat_id=` (default today; at most 62 days) →
  `{ days: [{ boat_id, service_date, status, stored_status, reason, not_chartered, blocked_by, planned_over }] }`.
- `stored_status` is the status log's; `blocked_by` the started jobs, and the projects in progress or on hold (`kind: project`, status `unavailable`, from their actual else planned start), holding the boat that day
  (`{kind, id, no, status, reason}`): a job `inprogress` whose `boat_status` is not `available`, from
  its `start_date`. `status` is the stricter of the two, but a log already saying fixing, unavailable or
  retired is kept as written. Work an entry is planned ahead of (`planned_over`) holds nothing on that
  entry's days. A charter boat with no entry that day is `unavailable`, `not_chartered: true`.
- Deploying a boat not ready that day needs `deploy_anyway` (see "Operations").

**Engines, gearboxes, propellers** — `{kind}` is `engines`, `gearboxes` or `propellers`:

| Endpoint | Body | Answers |
|---|---|---|
| `GET /v1/fleet/{kind}?boat_id=` | | `{ engines: [...] }` (or `gearboxes`, `propellers`), without histories |
| `GET /v1/fleet/{kind}/{id}` | | the asset with its `log` |
| `POST /v1/fleet/{kind}` | the form's fields, `status?`, install fields | `201` |
| `PATCH /v1/fleet/{kind}/{id}` | the form's fields | `200`; a status, a place or a computed field is `400` naming the command |
| `POST /v1/fleet/{kind}/{id}/status` | `{ status, note? }` | logged `Status: a → b` |
| `POST /v1/fleet/{kind}/{id}/install` | engine `{ boat_id, pos, job_id? }`; gearbox `{ engine_id }`; propeller `{ gearbox_id, prop_pos? }` | `409 engine_not_installed`, `engine_has_gearbox`, `gearbox_not_installed`, `gearbox_has_propeller` |
| `POST /v1/fleet/{kind}/{id}/remove` | `{ spare_location? }` | off its boat/engine/gearbox; `409 not_installed` |
| `POST /v1/fleet/{kind}/{id}/swap` | `{ with_id }` | two of a kind trade places |
| `POST /v1/fleet/{gearboxes,propellers}/{id}/move` | `{ spare_location, note? }` | a `shop:` place is fixing, any other spare |
| `POST /v1/fleet/{engines,gearboxes}/{id}/service` | `{ hours }` | the service baseline |

- **Fields** (legacy's camelCase accepted): engine `brand, model, serial, hp, buy_date, price,
  base_hours, service_interval, note, spare_location`; gearbox `brand, model, model_suffix, serial,
  buy_date, base_hours, note, shaft_length, rotation, gear_ratio, oil_capacity, service_interval,
  last_service_date, spare_location`; propeller `brand, serial, old_serial, diameter, pitch, size,
  blades, material, rotation, hub_size, cupping, cost, buy_date, note, spare_location, prop_pos`.
  An engine needs `model` and `serial`; a blank `base_hours` is 0, a blank interval 100, a blank
  propeller `cost` 0, and `size` is `diameter×pitch` when both are sent (the forms').
- **Statuses:** engines and gearboxes `ready, fixing, broken, spare` (`limited` only by closing a job);
  propellers `active, fixing, broken, spare` (`damaged` only by a quick swap, `limited` by a job).
- **Computed:** an engine's `hours` (`base_hours` plus what its Daily Fleet Log meter ran: the latest
  reading less the first above 0, every trip type) and `service` (`{current_hours, interval, base, since, next, left, pct, overdue}`); a
  gearbox's `lifetime_hours` and `service` (interval 200 when none). Decommissioned engines carry
  `retired`, `retired_on`, `retired_reason`.

**Incidents:**

| Endpoint | Body | Answers |
|---|---|---|
| `GET /v1/fleet/incidents?boat_id=&status=` | | `{ incidents, next_no }` |
| `GET /v1/fleet/incidents/{id}` | | the incident |
| `POST /v1/fleet/incidents` | `{ no, boat_id, date, time?, title, detail?, remark?, cause?, priority?, damaged_assets?, quick_fix? }` | `201`; `409 number_taken` |
| `PATCH /v1/fleet/incidents/{id}` | the edit form's fields | `200` (writes legacy's "✎ แก้ไขรายละเอียด" line) |
| `DELETE /v1/fleet/incidents/{id}` | | `204` (its job stays) |
| `POST /v1/fleet/incidents/{id}/log` | `{ text, by? }` | `200` |
| `POST /v1/fleet/incidents/{id}/swap` | `{ asset_type, asset_id, spare_id, propellers?: [{ id, action: keep\|stock\|repair, location? }] }` | `200`; `409 spare_not_compatible` |

- **`no`** is the client's (decided: legacy numbers in the browser, highest + 1, three digits;
  `next_no` says what that is). A number already used is `409 number_taken`; legacy's duplicates stay.
- `damaged_assets`: `[{ type: engine|gearbox|propeller, asset_id }]` labelled by the server
  (`serial · pos`), or `[{ type: hull|safety, label }]`. `severity` is computed from `priority` (1–5,
  default 5: 4+ critical, 3 major, else minor). `quick_fix: true` resolves it at once (`resolved_on`).
- `shown_status` is legacy's `effStatus`: resolved, or its job's (`open` with none, `pending`,
  `inprogress`, else `resolved`). `status` (`open`, `resolved`, `closed`) is the server's: the last of
  its jobs closing closes it.
- The quick swap fits a spare kept at a pier or on this boat (same brand of gearbox, same size of
  propeller); the damaged part goes to `shop:honda-phuket`. After a gearbox, each propeller on the
  old one is kept on the new one (default), stocked or sent with it for repair.

**Maintenance jobs:**

| Endpoint | Body | Answers |
|---|---|---|
| `GET /v1/fleet/jobs?boat_id=&status=&incident_id=` | | `{ jobs, next_no }` |
| `GET /v1/fleet/jobs/{id}` | | the job |
| `POST /v1/fleet/jobs` | `{ no, boat_id, type?, title, detail?, location?, start_date?, boat_status?, boat_status_reason?, incident_id?, per_asset?, nos?, assets?, parent_project_id?, create_anyway? }` | `201 { jobs }`; `409 open_jobs`, `incident_linked`, `number_taken` |
| `PATCH /v1/fleet/jobs/{id}` | `title, detail, location, type, start_date, no, parent_project_id, awaiting_invoice`, the board's `owner, due_date, board_lane, parked, pinned` | `200` |
| `DELETE /v1/fleet/jobs/{id}` | | `204`; `409 job_done` |
| `POST /v1/fleet/jobs/{id}/start` | `{ gear?: keep\|stash\|swap, stash_location? }` | `409 job_started`, `job_done` |
| `POST /v1/fleet/jobs/{id}/close` | `{ outcome?, note?, awaiting_invoice?, reset_service? }` | adds `boat_status_after`, `service_reset`; `409 reset_service_choice`, `job_done` |
| `POST /v1/fleet/jobs/{id}/reset-service` | | `409 not_a_service` |
| `POST /v1/fleet/jobs/{id}/boat-status` | `{ status, reason?, effective_date, note? }` | `200` |
| `POST /v1/fleet/jobs/{id}/assets` | `{ type, asset_id? \| label, detail? }` | `200`; `DELETE …/assets/{idx}` |
| `POST /v1/fleet/jobs/{id}/log` | `{ text, by?, date? }` | onto its incident too |
| `POST /v1/fleet/jobs/{id}/split` | `{ by: job_engines\|boat_engines, nos }` | adds `created` |
| `POST /v1/fleet/jobs/{id}/steps`, `…/steps/template`, `PATCH …/steps/{idx}`, `DELETE …/steps/{idx}` | `{ text }`, —, `{ done }`, — | the board's sub-steps |

- **Create:** `type` (default `corrective`) sets the default `boat_status`: corrective `fixing`,
  scheduled `unavailable` (`scheduled_maint`), preventive `available` (the job runs alongside, holds
  nothing: `set_fixing: false`). `boat_status_reason` is one of `engine_repair, donor, docs_expired,
  dry_dock, off_season, charter, scheduled_maint, other`, required when unavailable. The boat must be a
  company boat not retired. An open job on the boat is legacy's confirm: `create_anyway: true`. From an
  incident, its damaged assets come along; with 2 or more, `per_asset` is required (legacy's choice):
  `true` makes one job per asset, numbered by `nos`.
- **Start** writes the boat's log: the job's status from today (tomorrow when the boat already sailed
  today), closing what it overlaps as legacy's `autoClosePrevLog`; its parts go fixing. `gear`: keep
  the gearbox/propeller on its engines (default), `stash` them as spares, or `swap` the engine out
  (its gearbox waits on the boat; fit the replacement with `POST /v1/fleet/engines/{id}/install` and
  `job_id`).
- **Close** (`outcome`: `success` default, `limited`, `rework`, `decommission`, `cancelled`) sets the
  parts (legacy's table) and the boat: the outcome's status unless other started work still holds it.
  A job that reads like a service (scheduled, or "oil/service/gear…" in its words) with engines or
  gearboxes needs `reset_service` true or false (legacy's confirm). The incident closes with its last
  job (not on a cancel).
- **Computed:** `cost` (parts not already in a parts memo, plus the job's approved/received/paid
  memos, those whose `job_id` is the job), `parts_cost`, `memo_cost`, `parts_covered`, `lane` (the board's
  `flBoardLane`), `silent_days`, `blocks_boat`. `legacy_cost` is legacy's stored cost, read-only.
  `status`, `end_date`, `outcome`, `set_fixing`, `pinned_on`, `parked_on`, the logs and steps are the
  server's; sending them to `PATCH` is `400` naming the command.
- A board field change writes the line legacy's board writes (owner, due date, lane, park), and a new
  progress line frees a lane dragged to `decide` or `wait`.

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
  charter (`400`). Each lock must be holding on the same route and day (`400`: not released, not
  past its expiry) and have that many seats left (`409`); a lock id that does not exist is a `400`.
  An agent's lock serves that agent's bookings only (`400 lock_other_agent`); a draw may name a
  sub-group (see "Agent seat locks"). Only `pax − drawn` needs general
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
| `pickup_time` (`pickupTime`) | Hotel pickup time, or the **start** of the pickup window. `HH:MM`, 24-hour, local time. |
| `pickup_time_end` (`pickupTimeEnd`) | The **end** of the pickup window, `HH:MM`, after `pickup_time`. With `pickup_at_pier`, the time to be at the pier. Refused without `pickup_time` unless `pickup_at_pier`. |
| `pickup_at_pier` (`pickupAtPier`) | `true` when the guest makes their own way to the pier by `pickup_time_end`. Needs `pickup_time_end` and refuses `pickup_time`. |
| `ovn` | Marks an **overnight outbound** trip: `return` (we bring them back on `ovn_return_date`) or `self` (they make their own way back). |
| `ovn_return_date` (`ovnReturnDate`) | The day they come back, `YYYY-MM-DD`. Required when `ovn` is `return`, refused otherwise, and must be after the trip's own date. |
| `ovn_leg` (`ovnLeg`) | `true` on the **return leg**: the trip that brings them back. A seat leg holds seats on that day like any seat trip; a charter leg takes its boat. Priced ฿0 (the overnight charge is on the outbound). |
| `ovn_of` (`ovnOf`) | On a return leg: the **index in this `trips` list** of its outbound trip. |

Legacy writes the pickup as one text. It maps to the three pickup fields like this, and back again
for display. A window whose fields disagree is a `400` naming the trip.

| Legacy text | `pickup_time` | `pickup_time_end` | `pickup_at_pier` |
|---|---|---|---|
| `07:30` | `07:30` | | |
| `07:30-07:45` | `07:30` | `07:45` | |
| `Before 08:30 at pier` | | `08:30` | `true` |

These rules match the legacy booking screen. A return leg must:
- have `ovn_of` pointing at a *different* trip in the list whose `ovn` is `return`
- be on that trip's route, dated its `ovn_return_date`
- be booked as its outbound is: a seat trip under a seat outbound; under a charter outbound, a
  charter of any boat deployed on the return day (legacy builds it on the same boat; a different one
  is allowed). The boat is not held on the nights between, so it is free for other work there.
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
    "kind": "approval", "status": "pending", "reason": "over_capacity", "over_capacity": true, "over_total": 2, "discount": null, "foc_count": null,
    "target_status": "confirmed", "requested_by": "ops1", "requested_at": "…", "decided_by": null, "decided_at": null, "note": null,
    "days": [{ "route_id": "r3", "service_date": "2039-02-01", "need": 22, "over_by": 2, "licensed_free": 25 }]
  }]
}
```

Each of `days` is a day over the allotment: the seats it needs (`need`), how many the allotment
lacks (`over_by`), and the registered seats left when the approval was asked (`licensed_free`, the
approval card's **Real seats left**, legacy `licFree`). It is never below `need`, since past the
licence the booking is refused instead. It is a record of that moment and does not change as the
day sells; `GET /v1/availability` gives today's figure. It is `null` on an approval asked before
migration 025.

`approvals` is every approval asked for, oldest first, kept after it is decided: `kind` `approval`
(over the allotment and/or a discount) or `foc`; `status` `pending`, `approved`, `rejected`, or
`replaced` (a later edit asked again before it was decided). At most one per kind is `pending`.
`reason` says why an `approval` was asked, in legacy's labels: `over_capacity`, `discount`, or
`over_capacity+discount`; one imported from legacy may also say `closed_day` (sold on a day the
route did not run) or `b2c_hold` (held by the B2C sync). An `foc` approval has none: its reason is
the booking's `foc_reason`.

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
| `POST /v1/bookings/{id}/cancel-weather` | any status that holds seats | `cancelled_weather`, `cancellation_reason` `weather` (seats given back); its money, see [Weather closures](#weather-closures-refund-and-credit) |
| `POST /v1/bookings/{id}/cancel` | any status that holds seats | `cancelled` — see [Booking actions](#booking-actions-cancel-restore-partial-cancel-reschedule) |
| `POST /v1/bookings/{id}/restore` | `cancelled`, `rejected`, `cancelled_weather` | `confirmed` |

- `confirm`, `approve`, `reject` and `cancel-weather` take an optional `{ "note": "…" }`, written
  into the history (and, for `approve`/`reject`, onto the approval). `cancel-weather` also takes
  `outcome` (`cancel`, the default, `refund` or `credit`) and answers `refunds` too. Each answers the booking plus
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
- `cancel-weather` takes only this booking's share off its invoice and refunds or keeps as credit
  what it had paid: see [Weather closures](#weather-closures-refund-and-credit). Undo the status with
  `/restore`; the money stays as it was.
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
  - `updated_since=` — an ISO instant (`2026-10-09T03:00:00Z`): bookings whose `updated_at` is **at
    or after** it, so the booking at the boundary comes again rather than one changed in the same
    millisecond being missed. Love Kingdom's reconciliation read: it keeps the newest `updated_at` it
    has seen and asks from there. Anything else is a `400`.

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
  behind it. `external_id` names one booking: a second create with the same one is `409` with
  `code: "duplicate_external_id"`, its message naming the existing booking
  (`external_id LOV-4190737 is already booking booking_…`), and nothing is written. A client
  retrying after a timeout reads that booking instead.
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
amount. Cancelling voids the booking's live invoice, and a charge becomes a fee invoice of its own
(see "Invoices and payments"); restoring voids that fee invoice.

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
  <to> · <reason>", amount }` is added, and a booking already on a live invoice has that invoice
  topped up with the same line (see "Invoices and payments"). With `separate`, the charge is kept on
  the reschedule record only. The recorded `collect` is `none` whenever the charge is 0.

The older body `{ route_id, service_date, pax? }` still works. It moves a single-trip booking
anywhere and writes no reschedule record (it does write a history line).

Either body moving a booking off a trip closed for weather resolves its follow-up there (outcome
`reschedule`, `new_date` the day it went to): see [Weather closures](#weather-closures-refund-and-credit).
Legacy's weather screen sends `reason: "weather"`.

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
| cancel-weather | `weather` | `Cancel`, `Refund` or `Credit` | `Cancelled for weather · No refund · <note>`; `Refund ฿<n>` or `Kept as credit ฿<n>` in place of `No refund` |
| close a trip for weather | `weather` | `Weather` | `Trip <route> · <date> cancelled due to weather`, on every booking then on the trip |
| notify (weather) | `weather` | `Notify` | `Notified agent · awaiting customer decision (reschedule/cancel)` |
| undo a weather closure | `weather` | `Weather` | `Trip <route> · <date> re-opened · weather cancellation undone`, on every unresolved booking |
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
`not_cancelled`, `charter_boat_taken`, `already_cancelled`, `booking_closed`, `wrong_status`,
`duplicate_external_id`.

#### Edit conflicts: `version` and `If-Match`

Every booking carries a `version`: `1` on create, `+1` on every write (`PATCH`, every command and
action). A response also sends it as the `ETag` header (`"7"`). It is the server's: a `version` sent
on create is ignored.

To make sure a save does not overwrite an edit you have not seen, send back the version you read,
as `If-Match: "7"` or `"version": 7` in the body of `PATCH` or any command. If the booking has
moved on, the write is refused and nothing changes:

```jsonc
// PATCH /v1/bookings/BK-1  If-Match: "1"   (someone else saved version 2 meanwhile) → 409
{ "statusCode": 409, "code": "stale_version", "error": "Conflict",
  "message": "Booking BK-1 has changed since you read it (you have version 1, it is now 2); reload and try again" }
```

**Required of a login** (decided 2026-10-09): a `PATCH`, command or `PUT …/meals` that sends neither
is `428 version_required`, and nothing changes. Creating needs none. With authentication off (local
development) it is not checked, as permissions are not. A malformed `If-Match`, or a header and a
body `version` that disagree, is `400`.

Retries need nothing extra: a retried create with the same `external_id` is `409
duplicate_external_id` naming the booking already made.

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
| commercial | `agent_id` (an inactive agent is `409 agent_inactive` on create), `rate_type_ref`, `sold_by`, `purpose`, `staff_id`, `staff_purpose` (`staff_id` is required on a staff booking and checked: see [Staff and welfare quotas](#staff-and-welfare-quotas)) |
| lead | `lead_pax`, `lead_nationality`, `lead_type`, `lead_foc`, `lead_phone`, `lead_email`; `lead_age`, `lead_insurance_reviewed_at`, `lead_insurance_reviewed_by` (read-only here: see [Insurance](#insurance)) |
| pickup | `pickup_area_id`, `pickup_self`, `pickup_area`, `pickup_zone`, `hotel_name`, `room_number` |
| dropoff | `dropoff_same`, `dropoff_area_id`, `dropoff_area`, `dropoff_hotel_name` |
| guides | `guide_english`, `guide_russian`, `guide_chinese`, `guide_other_lang` |
| service | `pax_type`, `special_meals_veg`, `special_meals_vegan`, `special_meals_halal`, `special_meals_allergies`, `large_luggage` |
| cash on tour | `cash_on_tour_amount`, `cash_on_tour_currency`, `cash_on_tour_handling`, `cash_on_tour_note` |
| price | `price_mode`, `manual_total`, `total`, `price_seat`, `price_addon`, `price_foc_discount`, `price_discount`, `price_extra` |
| payment | `payment_method`, `payment_net_days`, `payment_source`, `payment_contract_version`; Love Kingdom's payment state `payment_paid`, `payment_paid_status`, `payment_deposit`, `payment_balance` (legacy `paymentSnapshot.paid/paidStatus/deposit/balance`; the pier collects `payment_balance`, see [Pier money](#pier-money)) |
| market | `market`, `market_sub`, `market_agent_id`, `market_at` |
| lifecycle | `booking_date` |
| free text | `notes`, `note` |
| van job order | `job_note` (`jobNote`) — the special request the job order prints; see "Van job orders" |
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

#### Insurance

Each passenger's age for the insurer, and who reviewed the row and when (legacy's Insurance page,
area `operations`). The lead's are header fields, `lead_age`, `lead_insurance_reviewed_at` and
`lead_insurance_reviewed_by`; every other passenger's are on its row, `age`, `insurance_reviewed_at`
and `insurance_reviewed_by`. All are absent until set.

- `PUT /v1/bookings/{id}/insurance` with `If-Match` (or `version`), as every booking write:
  ```json
  { "version": 4, "passengers": [ { "passenger": "lead", "age": 47, "reviewed": true }, { "passenger": 0, "age": 2.5 } ] }
  ```
  `passenger` is `"lead"` or a passenger's `seq`. `age` is a number from 0 to 999, fractions allowed
  (legacy's text ages such as `"47"` are read as numbers); `null` clears it. `reviewed: true` stamps
  the login and the time (a row already reviewed keeps its first stamp), `false` clears them, absent
  leaves them. Answers the booking, with a line in its history (`Insurance · lead age 47 reviewed ·
  #0 age 2.5`). `400` for a passenger the booking does not have or a bad age.
- These fields change only through the command: a `PATCH` may echo them, and a different value is
  `400` naming it. A `PATCH` that replaces `passengers` keeps a passenger's age and review when the
  row at the same position has the same name, and drops them otherwise (legacy kept them by position
  alone and moved them onto whoever took it).

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
integer`, `addOns[0]: join counts are only for a longtail-join add-on`. A refused request writes
nothing. The database holds the same rules (migration 039).

The legacy import brings every booking's add-ons through the same parser, as legacy saved them (a
missing join count stays missing: every passenger joins).

#### Prices

The server prices a booking, with the same rule as `POST /v1/quote` ("Quote"):

- **On create**, and **on a `PATCH` that changes something the price reads**: trips, pax, add-ons,
  adjustments, `price_mode`, `manual_total`, `staff_purpose`, `booking_date`, or `rate: "agent"`.
  A `PATCH` that changes only a name, a note or a phone leaves the price alone.
- **Commands keep the price**, as legacy: confirm, approve, reject, cancel, restore and reschedule
  never re-price. A partial cancel takes its refund off `total`.
- On an edit each trip that is still the trip it was sold as keeps the rate it was priced at
  (`trips[].rate_type_id`); `rate: "agent"` re-prices at today's rate instead (legacy's "use today's
  rate"). A booking's `rate_type_ref` is its agent's rate when it was made.

What the server sets: `total`, `price_seat`, `price_addon`, `price_foc_discount`, `price_discount`,
`price_extra`, `price_mode` and `manual_total` (by the rules in "Quote"), each add-on's `amount`, and
each trip's `subtotal`, `rate_type_id` and `promo_id`. The client still sends a trip's
`ovn_charge` (`ovnCharge`) and charter price (`charter_price_mode`, `charter_price_manual`,
`charter_price_note`, legacy's spellings too), which are returned on the trip.

A price the client sends anyway is replaced by the server's, and the response says so:

```jsonc
"price_warnings": [
  { "code": "price_replaced", "field": "total", "sent": 99, "used": 4000, "message": "total 99 was replaced by the server's 4000 (POST /v1/quote shows how)" },
  { "code": "not_offered", "trip": 0, "message": "trips[0]: r12 zone PK has no price: ฿0" }
]
```

`price_warnings` also carries the quote's warnings (a ฿0 trip or add-on), and appears only when
there is something to say. The discount approval reads the computed discount.

**B2C bookings keep the price their client sends:** a booking whose `external_id` starts `b2c_`
(legacy's B2C sync) or whose agent is `a_b2c` (Love Kingdom). Legacy never re-prices them.

#### Adjustments

The discounts and extra charges added on the booking's review step (legacy's `adjustments`), sent on
`POST /v1/bookings` and `PATCH /v1/bookings/{id}` and returned on every read. Like `passengers`:
present replaces the list, `[]` or `null` clears it, absent leaves it; a change is an edit (version
+1, a history line).

```jsonc
"adjustments": [
  { "seq": 0, "kind": "discount", "mode": "percent", "value": 10, "label": "Discount", "note": "repeat agent" },
  { "seq": 1, "kind": "extra", "mode": "amount", "value": 500, "label": "Extra charge" }
]
```

| Field | Meaning |
|---|---|
| `kind` | `discount` or `extra` |
| `mode` | `amount` (default) or `percent`. Legacy prices a `percent` discount off seats + add-ons; an extra is always an amount |
| `value` | A number above 0 |
| `label`, `note` | Free text; left off when unset |

A row that does not fit is `400` naming it (`adjustments[1].value must be a number above 0`). They
are client facts. What they add up to is computed into `price_discount` and `price_extra` (see
"Prices"). The legacy import brings them with each booking.

### Quote

`POST /v1/quote` prices a booking the way legacy does, and saves nothing. Any login may ask (a login
tied to an agent, for that agent only). The rule is `priceBooking` (`src/domain/pricing.ts`), proven
on 4,352 of legacy's own bookings: each re-prices exactly as legacy stored it, seats, add-ons, FOC
value, discount, extras, total and every trip's subtotal (`test/quote-legacy.test.ts`). Legacy's
quirks are kept on purpose, marked "legacy:" in the code.

The body is a booking's (`agent_id`, `booking_date`, `trips`, `add_ons`, `adjustments`, `price_mode`,
`manual_total`, `staff_purpose`, `rate_type_ref`), plus:

| Field | Meaning |
|---|---|
| `trips[].ovn_charge` (`ovnCharge`) | An overnight trip's charge, added to extras |
| `trips[].charter_price_mode` (`charterPriceMode`), `charter_price_manual` | `manual` prices a charter by hand |
| `booking_id` | This is an edit of that booking: a trip that is still the one it was sold as keeps its rate |
| `rate` | `kept` (the default with `booking_id`) or `agent`: re-price at today's rate |

```jsonc
{ "price_mode": "rate", "seat": 7400, "add_on": 600, "foc_discount": -1700, "discount": -800, "extra": 500, "total": 7700,
  "trips": [{ "subtotal": 7400, "rate_type_id": "rt003", "promo_id": null, "rate_source": "season" }],
  "add_ons": [{ "amount": 600, "counted": true }],
  "warnings": [{ "code": "not_offered", "trip": 1, "message": "trips[1]: r12 zone PK has no price: ฿0" }] }
```

How a price is reached, as legacy reaches it:

- **The rate for a trip:** on an edit, the rate it was sold at; else the agent's rate season for the
  travel date, else the agent's rate, else `rate_type_ref` (`rate_source` says which). An active
  promo of the agent covering the route and date (and the booking date, when it has a book window)
  is laid over it: highest `priority`, then the latest start.
- **Seats:** foreign and Thai adult and child prices × the pax; infants are free. Both adult prices 0
  means not offered (฿0, with a warning). A paid longtail bundle adds its price per adult and child.
- **Charters:** the boat type's starter price, plus each passenger over the included number
  (infants and FOC count), plus a paid bundle; or the charter's manual price.
- **Add-ons:** from the first trip's rate (never a promo): longtail join and charter, private
  transfers. An add-on type the rate has no price for is ฿0, with a warning. A longtail join is left
  out of the total when a trip's route has a longtail bundle (`counted: false`).
- **Total:** seats + add-ons − discounts (a percent of seats + add-ons, or an amount) + extras +
  overnight charges, never below 0. `foc_discount` is the value given away free: shown, never
  subtracted.
- **Priced by hand** (`price_mode: manual`): the total is `manual_total`; adjustments and overnight
  charges do not apply. Company bookings are always by hand, staff inspection by hand at 0, staff
  welfare by rate, a walk-in either, every other agent by rate: a `price_mode` that contradicts this
  is `400`.
- **B2C bookings** (`booking_id` of one whose `external_id` starts `b2c_`): the price Love Kingdom
  set, as stored (`"stored": true`); legacy never re-prices them.

`400` for an unknown `agent_id`, a bad `rate`, a negative charge, or anything a booking create
refuses; `404` for an unknown `booking_id`. A booking is priced by this same rule when it is saved (see
"Prices").

**Rebuilding the proof** after a deliberate pricing change: load a scratch database with
`seed:routes`, `seed:boats`, `import-legacy.ts --commit` and `import:contracts --commit`, then
`SOURCE_DATABASE_URL=… TARGET_DATABASE_URL=… npx tsx src/tools/build-quote-fixture.ts`. It lists what
it could not reproduce and why.

### Dispatch: boats, final pickup, pier note

Every trip in a booking read carries its day-of-operations dispatch as `operations`, always present
and empty until set:

```jsonc
"operations": { "boat_id": "b2", "boat_splits": [], "boat_pulled": false,
  "pickup_time_final": "06:40", "pickup_time_final_end": null, "pickup_final_at_pier": false, "return_same_van": false,
  "pier_note": { "text": "Late, call guide", "at": "2026-09-12T05:50:00.000Z", "by": "Ploy" },
  "checkins": { "van": [], "pier": [] },
  "van_parts": [ { "idx": 0, "source": "main", "ad": 2, "chd": 1, "inf": 0, "foc": 0,
                   "group": { "id": "vgrp_…", "number": 3, "van_id": "veh07", "return_van_id": null, "pickup_time": "06:40" },
                   "sequence": 2, "return_van_id": null, "alt": null } ] }
```

`van_parts` is who rides which van. A trip with nothing set reads as one whole, ungrouped part
(`idx 0`). More parts are a split across vans; `source` is `main` (idx 0), `manual` (a split), or
`alt_pickup` (built from the booking's `alt_pickups`, with its points in `alt`; see "Alternate pickups").

`PATCH /operations/trip-ops/{trip_id}` sets it (the `operations` edit area). An absent field is
unchanged, `null` clears it. Answers `{ "trip": …, "warnings": [] }`.

| Field | Meaning |
|---|---|
| `boat_id` | The boat the whole trip goes on. It must be deployed on the trip's route that day, else `409 boat_not_deployed` |
| `boat_splits` | `[{boat_id, ad, chd, inf, foc}]`: the trip split across two boats or more (each deployed), whose passengers add up to the trip's. Send `boat_id` or `boat_splits`, not both; a split clears `boat_id` |
| `pickup_time_final`, `pickup_time_final_end`, `pickup_final_at_pier` | The dispatcher's final pickup, a time, a window or a pier deadline, by the same rules as a trip's pickup |
| `return_same_van` | The group comes back on the van it went out on |
| `pier_note` | Text; the server stamps `at` and `by` (the login) |
| `van_parts` | `[{idx, ad, chd, inf, foc, group_id?, sequence?, return_van_id?}]` replaces the trip's parts; `null` or `[]` is one whole, ungrouped part again (legacy unsplit). See below |
| `raise_capacity` | `{ reason }`: raise the boat's capacity for the day so this assignment fits (see below) |

**Which boat a trip may go on** (legacy `bkV2AssignBoat`; checked when `boat_id` or `boat_splits`
is sent):
- **A boat carries its capacity that day + 2.** Its load is every live booking's passengers on it that
  day (a split counts its share), this trip's included. Past capacity + 2 the assignment is
  `409 boat_full`, naming the numbers.
- **Raising the day's capacity:** a login with the `act-capunlock` right, or an admin, sends
  `raise_capacity: { "reason": "…" }`.
  - The boat's capacity for that day becomes min(licence, load), and the login and time are recorded
    (`boat_capacity_overrides.set_by`, `set_at`). Then the assignment goes through. Anyone else is
    `403`.
  - **The licence + 2 is the end:** past it the answer is `409 over_licence` ("assign another boat, or
    add a boat").
  - A raise made here survives the legacy import.
  - Only a boat in the boat catalogue can be raised (`409 boat_not_catalogued`).
- **A chartered boat takes no seat booking:** `409 boat_chartered`.
- **A charter trip rides its charter boat.** Its `boat_id` is its `charter_boat_id`, set when the
  booking is made and moved when the charter boat changes (legacy `§chOpsSync`). Another boat is
  `400`. A split over several boats is kept.
- **An edit that changes passengers only** is not weighed against the boat, as in legacy: the board
  shows the load.

**`van_parts`:**
- They must add up to the trip's passengers, category by category, and each carries one or more,
  else `400`. idx 0 is the main part. A part with children or infants and no adult is allowed, with
  `"warnings": ["child_without_adult"]` (legacy warns the same way).
- `group_id` must be a group of the trip's route and day (`400`), of the trip's pickup zone
  (`409 zone_mismatch`). A NoTransfer trip rides no van (`409 self_arrive`). If the group has a van,
  it must still seat everyone (`409 van_over_capacity`).
- `return_van_id` must be in the return pool (`409 van_not_in_pool`; see "Van groups"), and is
  refused together with `return_same_van: true` (`400`). Setting one sets `return_same_van` to
  false; `return_same_van: true` clears every part's own return van.
- An `alt_pickup` part comes from the booking's alternate pickups. Its passengers can't be changed
  or dropped here (`409 alt_pickup_split`); its group, order and return van can.

- `boat_pulled` (computed) is `true` when a boat the trip is on no longer sails on its route that day:
  legacy's "boat pulled · re-plan".
- **A trip moved** to another route or day (an edit or a reschedule) loses its dispatch and van
  parts, which were arranged for the old departure, but keeps its pier note (legacy `bkOpsClear`).
  **A change of passengers** clears a boat split, which no longer adds up. The van parts follow it:
  the main part takes the change, and if the passengers fall below what the split parts carry,
  those shrink from the last one. **A change of pickup zone** (the trip's zone, the booking's
  pickup zone, or a private-van add-on) takes the trip out of its van group.
- A cancelled or rejected booking's dispatch cannot change (`409 cancelled`); an unknown trip is `404`.
- The legacy import brings each active booking's boat, boat split, final pickup and pier note.

Check-in has its own section below.

### Alternate pickups

Some of a booking's passengers picked up, or dropped off, somewhere else (the sales form's
"รับหลายจุด"). `alt_pickups` is a booking field: accepted on `POST /v1/bookings` and
`PATCH /v1/bookings/{id}`, returned on every read. The list replaces outright (absent = unchanged,
`[]` or `null` = clear). Legacy's spelling `altPickups` and its keys (`areaId`, `dropSame`,
`dropAreaId`, `dropArea`, `dropZone`, `dropPlace`) are accepted, and an old entry with only `qty`
counts as that many adults.

```jsonc
"alt_pickups": [ { "who": "Mr B", "ad": 1, "chd": 0, "inf": 0, "foc": 0,
                   "area_id": "pk-kata", "area": "Kata", "zone": "PK", "place": "Kata Palm",
                   "drop_same": true, "drop_area_id": null, "drop_area": null, "drop_zone": null, "drop_place": null } ]
```

**The server builds the van parts** from them, after every create, edit, partial cancel and
reschedule (legacy `bkV2SyncAltPickupSplits`, which ran in each browser):
- It works on every trip of the booking (legacy did day 1 only), and not on a cancelled booking.
- An entry counts when it has passengers and a place, area, name or drop-off.
- The main part (idx 0) keeps the rest of the trip's passengers, category by category. Each entry
  becomes an `alt_pickup` part, carrying its points in `alt` (`pick_*`, `drop_*` when
  `drop_same` is false, `alt_who`, `pick_time`).
- Parts keep their van group, order and return van by position:
  - a new entry with its own pickup starts ungrouped;
  - a drop-off-only entry rides with the main part.
- When the entries take every passenger, there is no main part: just their parts (legacy split
  nothing). With no entries, entries asking for more passengers of a kind than the trip has, or a
  trip of one passenger, an automatic split folds back into one part that keeps the main part's group.
- **A split made by hand** (`van_parts` with `manual` parts) is left alone.
- An alternate-pickup part's passengers can't be changed in `van_parts` (`409 alt_pickup_split`).
  Its group, order, return van and own `pick_time` can (`van_parts[i].pick_time`). Only a part
  with its own pickup has one: anything else is `400`.
- A group's `pickup_time` goes to such a part's `pick_time`; every other member gets it as the
  trip's final pickup (legacy `bkV2VanGroupSetTime`).

The import brings every entry. For a booking whose parts legacy never saved, it builds them the
same way.

### Check-in

Legacy's van check-in and pier check-in screens: one record per trip, side (`van` or `pier`) and
van part (`slot`, the part's `idx`; 0 is the main part). Every trip's `operations.checkins` carries
them, `{ "van": [...], "pier": [...] }` by slot, empty until written.

| Method + path | Body | Answers |
|---|---|---|
| `PUT /operations/trip-ops/{trip_id}/checkins/{van\|pier}/{slot}` | the whole record | `{ trip, warnings: [] }` |
| `DELETE /operations/trip-ops/{trip_id}/checkins/{van\|pier}/{slot}` | — | `{ trip, warnings: [] }`; `404` if there is none |

```jsonc
{ "slot": 0, "expected": 3, "actual_pax": 2, "no_show": 1,
  "checked_in_at": "2026-10-02T23:45:00.000Z", "checked_in_by": "Somchai",
  "reason_code": "not_down", "reason_note": "lobby empty", "reason_at": "06:40",
  "arrived_at": null, "arrived_by": null, "cleared_at": null, "cleared_by": null,
  "flow": "standby", "flow_at": "06:35", "flow_by": "Somchai", "flow_note": null,
  "reinstate": null,
  "self_add": null,
  "events": [ { "type": "no_show", "pax": 1, "ad": 1, "chd": 0, "inf": 0, "foc": 0, "reason_code": "not_down", "note": "lobby empty",
                "at": "06:40", "by": "Somchai", "ts": "2026-10-02T23:40:00.000Z", "undone": null,
                "tries": [ { "at": "06:50", "by": "Somchai", "note": "called again", "ts": "…" } ] } ],
  "updated_at": "…", "updated_by": "Ploy" }
```

- **A write replaces the record**, as legacy's `ckWrite` does. A record has three kinds of field:
  - **times staff type** (`reason_at`, `flow_at`, an event's or try's `at`, `reinstate.at`) are `HH:MM`;
  - **instants** are ISO 8601;
  - **staff names** (`checked_in_by`, an event's `by`, …) are the client's, as legacy's `ckMe()`.

  Edit areas `operations` or `pier`, as legacy's `ckCanEdit`.
- **Computed:**
  - `no_show` is `expected − actual_pax`, never below 0; a value sent is ignored;
  - `updated_at`, and `updated_by` from the login.
- **Refused:**
  - `400`:
    - `actual_pax` or `expected` above what the part booked;
    - a `slot` that isn't one of the trip's van parts;
    - a malformed field, named with its path (`events[1].type must be no_show or cxl`).
  - **The events are kept** (legacy §ckBack):
    - removing, reordering or changing a recorded event, or a try, is `409 events_append_only`;
    - to take one back, set its `undone` (`why`: `found` or `mistake`), and that is final:
      changing or clearing it is `409 event_undone_is_final`;
    - new events and tries go at the end.
- **A trip moved** to another route or day loses its check-ins, as legacy's `bkOpsClear` does.
- **The special request** the van and pier screens print is the booking's `special_request`
  (computed: its `job_note`, else its notes; see "Van job orders").
- **The import** brings every legacy record of an imported booking, cancelled ones included: an
  on-site cancel is one of its events. Split parts are kept, and `no_show` is recomputed, which
  changes 5 legacy records whose stored count disagreed.

### Pickup areas and pickup times

Legacy's "Pickup time setup": the areas guests are picked up from, and the time each programme's
van comes for each area, by season. Writes need the `operations` edit area.

| Method + path | Body | Answers |
|---|---|---|
| `GET /v1/pickup-areas[?active=true]` | — | `{ areas: [{id, name, zone, region, time_group, active}] }` |
| `POST /v1/pickup-areas` | `{name, zone, time_group, region?}` | `201` the area |
| `PATCH /v1/pickup-areas/{id}` | any of `name`, `zone`, `region`, `time_group`, `active` | the area |
| `DELETE /v1/pickup-areas/{id}` | — | the area, now `active: false` |
| `GET /v1/pickup-time-profiles` | — | `{ profiles }` |
| `GET /v1/pickup-time-profiles/{id}` | — | the profile and its `times` |
| `POST /v1/pickup-time-profiles` | `{name, from_date, to_date, notes?, clone_from?}` | `201` the profile, with the clone's times copied |
| `PATCH /v1/pickup-time-profiles/{id}` | any of the same | the profile |
| `DELETE /v1/pickup-time-profiles/{id}` | — | `204` |
| `PUT /v1/pickup-time-profiles/{id}/times/{route_id}/{target}` | `{pickup_time, pickup_time_end?}` or `{pickup_time_end, pickup_at_pier: true}` | the cell |
| `DELETE /v1/pickup-time-profiles/{id}/times/{route_id}/{target}` | — | `204` |
| `GET /v1/pickup-time?route_id=&area_id=&date=` | — | `{pickup_time, pickup_time_end?, pickup_at_pier?, profile_id, target}`, or `404` |

- **Areas:**
  - `zone` is `PK`, `KL`, `RN` or `NoTransfer`;
  - the id is legacy's, `<zone>-<name slug>` with `-2`, `-3` on a clash, and never changes;
  - deleting makes an area inactive (legacy deletes it): bookings point at it (decision D2).
- **A new or edited area takes its time group's times** wherever it has none: copied from another
  area of the group, as legacy's `_psuInheritTimesForArea` does.
- **A cell** is a route and a `target`: an area id, or a time group. Its window follows the trip
  pickup fields: a time, a window, or a pier deadline.
- **The lookup** (legacy `bkV2GetPickupTime`):
  1. of the profiles covering the date, the narrowest range wins, then the newest;
  2. in it, the area's own cell, else its time group's;
  3. else the fallback profile (no dates; legacy's older flat table, imported as
     `prof-legacy-flat`, decision D4).
- **Bookings:**
  - `pickup_area_id` and `dropoff_area_id` must be areas in the catalogue (`400`).
  - A trip sent with no pickup time gets the lookup's, and one with no `zone` gets the area's
    zone. A value sent is never overwritten (decision D1).
  - An edit fills only the trips it sends; changing a booking's area doesn't redo the times
    already there.
- **The import** brings the areas as legacy has them (decision D3), its profile with all 390 cells,
  and the old flat table. Run it before validating the booking foreign keys (migration 043 adds them
  `NOT VALID`).

### Document check

Staff compare the agent's attached document with the booking (legacy's Doc Check screen, B2B
bookings). Every booking read carries `doc_check` (or `null`) and `doc_check_status`.

```jsonc
"doc_check": { "status": "verified", "by": "Nok", "at": "2026-09-09T10:02:11.000Z", "note": null,
  "items": { "route": true, "date": true, "lead": true, "pax": true, "voucher": true, "payment": false },
  "pre": { "at": "…", "lang": "eng", "error": null, "text": "VOUCHER …",
           "results": { "lead": { "result": "match", "evidence": "MR SMITH", "detail": null } },
           "summary": { "match": 1, "maybe": 0, "mismatch": 0, "none": 5 } } },
"doc_check_status": "verified"
```

| Method + path | Body | Rule |
|---|---|---|
| `PUT /v1/bookings/{id}/doc-check/items/{item}` | `{checked}` | `item`: `route`, `date`, `lead`, `pax`, `voucher`, `payment` |
| `PUT /v1/bookings/{id}/doc-check/status` | `{status: "verified" \| "issue", note?}` | Stamps `by`/`at` and logs "Document check · ✅ verified[ · note]". Verified doesn't need every tick, as legacy (decision C1) |
| `PUT /v1/bookings/{id}/doc-check/note` | `{note}` | Any login may edit it, as legacy (decision C3) |
| `PUT /v1/bookings/{id}/doc-check/pre` | `{at?, lang?, error?, text?, results: {item: {s\|result, ev\|evidence, detail}}, auto_tick?}` | The browser's OCR pre-check, kept as sent, raw text included (up to 3,000 characters; decision C2). Items it matched are ticked unless `auto_tick: false`; it never unticks one |

- Each answers the booking. The first write creates the record as `pending`, as legacy does.
- Ticks, status and the pre-check need the `operations` edit area.
- **Computed:**
  - `pre.summary` counts the six items' results;
  - **`doc_check_status`** is legacy's `docCheckStatus`: the record's status, else `pending` when
    the booking has `attachments`, else `nofiles`.
- `PATCH /v1/bookings/{id}` may echo `doc_check` unchanged; another value is `400`.
- The import brings every legacy record (3,204 on 2026-10-09).

### Allergy list and pier meals

**`allergy_list`** is who can't eat what, for the kitchen: `[{name, qty}]`, `qty` being people.
- It is a booking field, accepted on `POST`/`PATCH /v1/bookings` and returned on every read.
  Legacy's `specialMeals.allergyList` and `allergyList` spellings are read too.
- The list replaces outright (`[]` clears it). The free text stays `special_meals_allergies`.
- Two entries with the same name (any case) become one, their qty added, as legacy's add button does.
- **Refused (`400`):** a blank `name`; a `qty` below 1 (a missing qty is 1).
- **`allergy_count`** (computed) is what the kitchen counts (legacy `bkV2AllergyCount`): the list's
  people, or 1 when there is only free text.
- The import brings the 29 legacy lists.

**`PUT /v1/bookings/{id}/meals`** is the pier's meal editor (legacy `pckMealSave`).
- It takes `{veg?, vegan?, halal?, allergies?}`, sets those meal fields, and stamps
  `special_meals_pier_at` and `special_meals_pier_by` from the login. It answers the booking.
- Those two are the server's: a create or an edit may echo them unchanged; a different value is
  `400`, naming this command. Legacy has no column for them, so no booking imports with them.

### Attachments

Files: an agent's voucher, a passport, a payment slip. A file is uploaded once, then named by a
booking's `attachments` or an upgrade sale's `slips`. Files are kept in the database, as legacy
keeps them (`attachments`, migration 040).

| Method + path | Body | Answers |
|---|---|---|
| `POST /v1/attachments` | `{filename, mime, data_b64}` (legacy's `dataB64` too) | `201 {id, name, mime, size}` |
| `GET /v1/attachments/{id}` | — | the file itself, with its `Content-Type` |
| `DELETE /v1/attachments/{id}` | — | `204` |

- **Upload refusals (`400`):**
  - over 6 MB (legacy's limit);
  - a type other than `image/jpeg`, `image/png` or `application/pdf`;
  - data that isn't base64.

  Ids look like legacy's, `att_<time>_<hex>`. Upload and delete need the `operations`, `pier`,
  `accounting` or `fleet` edit area (`fleet` for project documents).
- **Download:** any login may download (decided 2026-10-09). A login tied to an agent may download
  only its own bookings' files (others answer `404`).
- **Delete:** a file still named by a booking, an upgrade sale or a fleet project's documents is
  `409 attachment_in_use`.
- **A booking's `attachments`** (on `POST`/`PATCH /v1/bookings`, every read):
  `[{id, kind?}]`, where `kind` is `upload`, `capture` or `paste`. The list replaces outright.
  - Each id must be an uploaded file (`400`).
  - A read shows `{id, name, mime, size, kind, by, at}`: the server fills the file's details, and
    stamps `by` and `at` when a document is added. A document kept keeps its own.
- **An upgrade sale's `slips`:** the same list of ids (see "Upgrades").
- **Import:** `npm run import:attachments [-- --commit]` copies the legacy files something points at
  (5,887 of 6,342; batches, re-runnable). Run it before the main import, which then links each
  booking's documents and upgrade slips to them.

### Invoices and payments

Legacy's Accounting screen and Daily PFM payments (todo/money-model.md slice 1, migration 045). The
server works out every amount, the invoice number, the due date and the status. A client sends who
is billed and what was paid. Writes need the `accounting` area; any login may read.

| Method + path | Does |
|---|---|
| `GET /v1/invoices?agent_id=&booking_id=&status=&from=&to=` | List the invoices, oldest first. `status` takes one or more, comma-separated; `from` and `to` are the issue date (Bangkok) |
| `GET /v1/invoices/{id}` | One invoice |
| `POST /v1/invoices` | Issue one; answers `201` and the invoice |
| `PATCH /v1/invoices/{id}` | The document's header text and the withholding tax |
| `PUT /v1/invoices/{id}/discounts` | Line discounts |
| `POST /v1/invoices/{id}/void` | Void it |
| `POST /v1/invoices/{id}/payments` | Record a payment; answers `201` and the invoice |
| `POST /v1/invoices/{id}/payment-corrections` | Change or delete payments; answers the invoice |
| `GET /v1/payments?agent_id=&from=&to=&method=&deleted=` | Payments across invoices, oldest first |
| `GET /v1/refunds?agent_id=&booking_id=&kind=&from=&to=` | Refunds and credits, oldest first: see [Weather closures](#weather-closures-refund-and-credit) |

```jsonc
// An invoice, as every endpoint above answers it
{ "id": "inv_…", "number": "INV-2610-0012", "agent_id": "a12", "kind": "booking", "fee_type": null,
  "lines": [ { "seq": 0, "booking_id": "BK-…", "label": "V-881 · Phi Phi Premium · 2026-10-12", "amount": 5600, "discount": null } ],
  "vat_mode": "include", "vat_rate": 0.07, "subtotal": 5600, "net_amount": 5234, "vat_amount": 366, "total": 5600,
  "wht_amount": null, "payment_amount": 5600,
  "issued_at": "2026-10-09T03:12:44.000Z", "due_at": "2026-10-24T03:12:44.000Z",
  "status": "partial", "paid": 3000, "balance": 2600, "booking_ids": ["BK-…"],
  "note": null, "ref": "PO-77", "dear": null, "accept_at": null, "remark": null,
  "voided": false, "voided_at": null, "voided_by": null, "void_reason": null, "created_by": "acc1",
  "payments": [ { "id": "pay_…", "invoice_id": "inv_…", "amount": 3000, "method": "transfer", "paid_on": "2026-10-09", "ref": null,
    "recorded_by": "acc1", "recorded_at": "…", "deleted_at": null, "deleted_by": null, "delete_reason": null,
    "slips": [ { "id": "att_…", "name": "slip.jpg", "mime": "image/jpeg", "size": 120331 } ] } ] }
```

**Issuing** (legacy `acctCreateInvoice`):
- **Request:** `{ "agent_id": "a12", "booking_ids": ["BK-…"], "kind": "booking", "ref": "PO-77" }`.
  - `kind` is `booking` (the default) or `prepay`. A prepay invoice is a credit agent paying one
    booking early.
  - The header fields `note`, `ref`, `dear`, `accept_at` (`YYYY-MM-DD`) and `remark` may come too.
  - `lines`, totals, `number` and `due_at` are the server's; anything sent for them is ignored.
- **Refused:**
  - a booking of another agent: `400 booking_not_agents`;
  - a cancelled, rejected or weather-cancelled booking: `409 booking_cancelled`;
  - a booking already on a live invoice: `409 booking_already_invoiced`, naming the invoice.
- **Lines:** one per booking at today's price (`total`), then one per fee item, then a **minus line**
  per trip date whose cash on tour was decided as taken off the agent's bill (`cot_date` set, label
  `Cash on tour deducted · 2026-10-12`; see [After the trip](#after-the-trip-cash-on-tour-and-no-show-decisions)).
  From then on each line keeps the amount it was issued for: a later price change does not move the
  invoice. Only a cash-on-tour decision changes its own minus line afterwards. Every line carries
  `cot_date` (`null` on the others); a minus line takes no discount (`400`).
- **`overpaid`**: what was paid beyond the total (refunds and credits taken back), on every read. A
  deduction made after the agent paid leaves it above 0.
- **VAT** is the agent's `vat_mode`, copied at issue, at 7% in whole baht:
  - `include`: the total is the subtotal, and `net = round(subtotal / 1.07)`;
  - `exclude`: VAT is added on top;
  - `none`: no VAT.
- **Number:** `INV-YYMM-NNNN` for the Bangkok month, from a server counter, so two invoices never
  share a number.
- **Due date:** a `proforma` agent's, or a prepay invoice, is due when issued. Otherwise it is due
  after the agent's `credit_days`, or 30 days for an `invoice` agent without them.
- **Several bookings** may share an invoice, as on legacy's screen.
- Each booking's history gets `Invoice INV-… issued · ฿5,600 (incl. VAT)`.

**Status** is worked out, never stored:
- `void` once voided;
- `paid` once the payments reach `total`;
- `partial` once something is paid;
- `issued` otherwise.

`balance` is what is still owed; a void invoice owes nothing. Withholding tax does not count towards
paid, as in legacy: an agent that pays `total − wht_amount` leaves the invoice `partial`.

**Refunds and credits** (a weather cancel's, migration 061): `paid` stays every live payment;
`refunded` and `credited` are what refunds and credits took back from the invoice, and `refunds`
lists them. `status`, `balance` and the overpayment check count `paid − refunded − credited`. A line a
weather cancel took off keeps its place with `removed_at`, `removed_by` and `removed_reason`
(`weather`) and leaves every total; the other lines are `null` there.

**`PATCH`** changes `note`, `ref`, `dear`, `accept_at`, `remark` and `wht_amount` (0 or `null`
clears it). `payment_amount` is `total − wht_amount`, what the document asks to be paid. A field the
server works out is refused with `400` naming what to use instead (`total cannot be changed: it is
worked out from the lines`). An unchanged echo of it is accepted.

**Discounts** (legacy `acctInvDisc`):
- **Request:** `PUT …/discounts` with `{ "lines": [ { "seq": 0, "discount": 600 } ] }`.
  - Lines not named keep their discount; 0 or `null` clears one.
- **Effect:** the discounts come off the issued amounts, never more than all of them. VAT is then
  worked out again as at issue.
- **Refused:**
  - once anything is paid: `409 invoice_has_payments` ("void it and issue another");
  - on a void invoice: `409 invoice_void`.

**Void:**
- **Request:** `{ "reason": "wrong agent" }`; the reason is optional.
- **Effect:** frees the bookings to be invoiced again. Payments already recorded stay on the void
  invoice, as in legacy.
- **History:** `Invoice INV-… voided · reason: …`.
- **Refused:** voiding twice is `409 invoice_void`.

**Recording a payment** (legacy `acctRecordPayment`):
- **Request:** `{ "amount": 3000, "method": "transfer", "paid_on": "2026-10-09", "ref": "…", "slip_ids": ["att_…"] }`.
  - `method` is `transfer` (the default), `cash`, `card`, or `credit`: spending the agent's credit
    balance (see [Weather closures](#weather-closures-refund-and-credit)), never more than it holds
    (`409 credit_short`).
  - `paid_on` defaults to today in Bangkok.
  - `slip_ids` name files uploaded with `POST /v1/attachments`.
- **Refused:**
  - an amount that is not above 0: `400`;
  - a void invoice: `409 invoice_void`;
  - more than the invoice still owes: `409 overpayment`, naming the amounts. Send
    `overpay_anyway: true` to save anyway (legacy's "Save anyway?").
- **History:** `Payment ฿3,000 (transfer) · partial` or `· paid in full`.

**Correcting payments** (legacy `pfmEditSubmit`):
- **Request:** one dialog's changes at once:
  `{ "payments": [ { "id": "pay_1", "amount": 1500 }, { "id": "pay_2", "deleted": true } ], "reason": "typo" }`.
  - Each entry may change `amount`, `method` and `paid_on`, or set `deleted: true`.
  - `reason` is optional.
- **A deleted payment stays.** It keeps `deleted_at`, `deleted_by` and `delete_reason`, and it leaves
  every total. `GET /v1/payments` shows deleted payments only with `deleted=true`.
- **History:** one line, as legacy writes it: `Payment correction · edited THB 2,000 -> THB 1,500 ·
  deleted THB 3,000 (transfer, 2026-10-01) · reason: typo`.
- **Refused:**
  - a payment already deleted: `409 payment_deleted`;
  - a result that pays more than the total: `409 overpayment`, unless `overpay_anyway: true`;
  - changing a `credit` payment's amount or method, or making a payment `credit`: `409 credit_payment`
    (delete it, which gives the credit back, and record it again).
- **Nothing changed** writes nothing.

**On the booking.** Every booking read carries two fields the server works out:
- `invoice`: the booking's live invoice as `{ id, number, kind, fee_type, status, total, paid, balance }`,
  or `null`. That is its booking or prepay invoice, else its newest live fee invoice (a cancelled
  booking's cancellation fee).
- `payment_state`: `none`, `invoiced`, `partial` or `paid`, over every live invoice of the booking: `paid`
  once all are paid, `partial` once anything is.

They replace legacy's stored `invoiceId` and `paymentStatus`. A booking `PATCH` that sends any of
`invoice`, `invoice_id`, `invoiceId`, `payment_state` or `paymentStatus` with a different value is
refused with `400`; an unchanged echo is accepted.

**Cancel and restore bill, as legacy does:**
- **Cancel** voids the booking's live invoice. A charge (`charge_type` `full` or `partial`) becomes an
  invoice of its own:
  - `kind: "fee"`, `fee_type: "cancellation"`, one line `Cancellation fee · <reason>`;
  - no VAT, due now, whole baht;
  - only when the booking's agent is in the catalogue.
- **Restore** voids that fee invoice.
- **A reschedule fee** collected on the invoice (`collect: "invoice"`) is always a fee item on the
  booking, as legacy (`bkV2RescheduleBooking`):
  - booking not invoiced yet: the fee item is billed by its next invoice;
  - booking already on a live booking or prepay invoice: **that invoice is topped up**, as legacy does.
    It gets a line `Reschedule fee · <from> → <to> · <reason>` for the booking, and its subtotal, net,
    VAT and total are worked out again with the invoice's own VAT mode (as a discount is). Legacy
    added the fee to subtotal, net and total alike, which left its VAT wrong; this does not. A paid
    invoice takes the fee too and then reads `partial`. The history line says `on invoice <number>`.
  - **Billed once:** while that invoice is live the booking cannot go on another
    (`409 booking_already_invoiced`); once it is voided, the next invoice bills the fee item once.
  - No separate fee invoice is issued for a reschedule; `fee_type: "reschedule"` comes only from
    legacy's import.

**The agent's credit** (legacy `agCreditState`):
- **Where:** `GET /v1/agents/{id}` carries `credit: { limit, used, available, pct, over }`. (Its
  `credit_balance` is something else: money kept for the agent by a weather cancel, see
  [Weather closures](#weather-closures-refund-and-credit).)
- **`used`** counts an `invoice` agent's bookings that are:
  - not cancelled, rejected, a quote or a draft;
  - not yet paid.

  Each counts at its price plus its fee items. Other pay types use 0.
- **Over the limit** is a warning only, as in legacy.

**Import.** `import-legacy.ts` mirrors `sb_invoices` and `sb_payments` with their slips:
- **Ids:** prefixed like the bookings (`lg_…`), and replaced on every run.
- **Payments, refunds and credits made here on an imported invoice** are replaced with it, because
  legacy stays master for money until Money moves.
- **Lines:** legacy kept none for a booking invoice, so its single line is rebuilt with the amount
  legacy froze.
- **Duplicate number:** `INV-2609-0003` imports its second invoice as `INV-2609-0003-2`.
- **Status:** worked out here. The run prints where that differs from what legacy stored.
- **Slips:** run `npm run import:attachments` first, or they are dropped.
- **Rehearsal of 2026-10-09:**
  - 467 invoices, ฿3,332,728;
  - 385 payments, ฿2,788,328;
  - 378 of 379 slips linked;
  - one status corrected, from legacy's `issued` to `paid`.

### Weather closures, refund and credit

Legacy's "Cancel trip (weather)" and its "Manage bookings · trip cancelled (weather)" panel
(todo/weather-closures-model.md, migrations 060 and 061). A closure says a route did not run on a day
because of weather; the follow-up list is what staff do about each booking on it: **notify the agent,
then reschedule or cancel**. Writes need the `operations` area (the refund and credit too); any login
may read, and a login tied to one agent sees only its own bookings on the list.

| Method + path | Does |
|---|---|
| `GET /v1/weather-closures?from=&to=&route_id=&include_reopened=true` | Closures by date, with `counts` and `pax`; open ones unless `include_reopened` |
| `GET /v1/weather-closures/{id}` | One, with `bookings`: the follow-up list |
| `POST /v1/weather-closures` | Close a trip: `{ "route_id": "r10", "service_date": "2026-07-02", "note": "high waves 3m" }` → `201` |
| `PATCH /v1/weather-closures/{id}` | Change the note (legacy's "Update note") |
| `POST /v1/weather-closures/{id}/bookings/{booking_id}/notify` | `awaiting` → `notified` (legacy's "Notify agent"; nothing is sent) |
| `POST /v1/weather-closures/{id}/undo` | Re-open the trip: `{ "undo_anyway": true }` when bookings are already resolved |
| `POST /v1/bookings/{id}/reschedule` | Resolves the booking's follow-up as `reschedule` when it moves off the closed day |
| `POST /v1/bookings/{id}/cancel-weather` | Resolves it as `cancel`, `refund` or `credit`, with the money below |
| `GET /v1/refunds?agent_id=&booking_id=&kind=&from=&to=` | Refunds and credits, oldest first, each with its `invoice_number` |

```jsonc
// GET /v1/weather-closures/wx_…
{ "id": "wx_…", "route_id": "r10", "service_date": "2026-07-02", "note": "high waves 3m",
  "closed_by": "ops1", "closed_at": "2026-07-01T04:57:02.238Z", "updated_by": null, "updated_at": null,
  "reopened_by": null, "reopened_at": null,
  "counts": { "awaiting": 1, "notified": 1, "resolved": 2 },
  "pax": { "pending": 6, "cancelled": 2, "rescheduled": 4, "total": 12 },
  "bookings": [
    { "booking_id": "BK-1", "voucher_ref": "V-881", "agent_id": "a01", "lead_pax": "Ann", "booking_status": "confirmed",
      "booking_mode": "seat", "pax": 4, "on_trip": true, "payment_state": "paid", "refundable": 5600,
      "status": "notified", "notified_at": "…", "notified_by": "ops1",
      "outcome": null, "new_date": null, "resolved_at": null, "resolved_by": null } ] }
```

**A closure refuses nothing**, as in legacy: a booking can still be sold, moved or synced onto the
closed trip. It is a record and a to-do list.

- **Who decides:** `route_id`, `service_date` and `note` are the client's. `id`, `closed_by`,
  `closed_at`, `updated_*`, `reopened_*`, `counts`, `pax` and the list are the server's: sent on create
  they are `400`; sent to `PATCH` they are `400` unless they repeat the stored value.
- **Past days** may be closed. **One open closure per trip:** a second is `409 already_closed`, naming
  the open one; change its note with `PATCH`.
- **The list is worked out on every read:** every booking with a trip on that route and day that holds
  its seats (charters too), plus every booking with a follow-up row. A booking sold onto the trip
  later is on it at once (legacy tagged it only when someone opened the panel). A booking with no row
  reads `awaiting`; a row is written when it is notified or resolved.
- Each entry: `pax` is its passengers on that route; `on_trip` is false once it has moved away or
  been cancelled; `refundable` (single read only) is what a weather cancel would give back now, the
  "Paid ฿x" legacy shows.
- `counts` and `pax` are legacy's "To notify / Notified / Resolved" and its calendar tally
  (`bkV2WeatherCountsFor`): `pending` is not yet resolved, `cancelled` is resolved any way but
  `reschedule`.

**Notify** needs the booking on the list (`404 not_on_closed_trip`) and `awaiting` (`409 wrong_status`).

**Resolving is the booking's own command** (a full new day is refused, lock seats go back, as for any
reschedule):
- `/reschedule` moving the booking off the closed day: outcome `reschedule`, `new_date` where it went.
- `/cancel-weather`: outcome `cancel`, `refund` or `credit`. It resolves every open follow-up of the
  booking.
- A row needs no notify first, and a row already resolved keeps its first outcome. A `PATCH` move or
  an ordinary `/cancel` resolves nothing.

**The money of a weather cancel** (`POST /v1/bookings/{id}/cancel-weather`,
`{ "outcome": "refund", "note": "…" }`):
1. **Only this booking's share comes off its invoice.** On each live booking or prepay invoice
   carrying its lines: if no other booking has a live line on it, the invoice is voided
   (`void_reason: "weather"`), as legacy does; otherwise only this booking's lines are taken off
   (`removed_*`) and the totals and VAT are worked out from the lines left. Fee invoices stand.
   Legacy voided the whole invoice, so the other bookings on it went back to unpaid.
2. **What it had paid** is the invoice's payments, less refunds and credits already taken from it,
   less what the invoice still asks; never below 0. On a shared invoice the bookings still travelling
   are paid first, so only money the invoice no longer needs comes back.
3. **The outcome:**
   - `cancel` (default, legacy "No refund"): nothing more; what was paid stays on the invoice.
   - `refund`: a `refund` of that amount, owed to the agent. Paying it out is its own step
     (`POST /v1/refunds/{id}/payout`, "Deposits and refund payouts").
   - `credit`: a `credit` of that amount for the invoice's agent. Nothing paid is `409 nothing_paid`;
     an invoice with no agent is `409 no_agent`.
4. `amount` cannot be sent (`400`): the server works it out.

```jsonc
// POST /v1/bookings/BK-1/cancel-weather  { "outcome": "credit", "version": 7 }
{ "...": "the booking", "status": "cancelled_weather", "invoice": null, "warnings": [],
  "refunds": [ { "id": "rf_…", "kind": "credit", "invoice_id": "inv_…", "booking_id": "BK-1", "agent_id": "a01",
                 "amount": 5600, "reason": "weather", "created_by": "ops1", "created_at": "…" } ] }
```

**The agent's credit balance** (legacy's deposits): `GET /v1/agents/{id}` carries
`credit_balance: { credited, deposited, used, available }`: its credits and live deposits ("Deposits
and refund payouts"), less its live payments with `method: "credit"`. Spend it with
`POST /v1/invoices/{id}/payments` and `method: "credit"`.

**Restore** of a weather-cancelled booking puts its status back only: it stays off its old invoice
(issue a new one), a refund or credit stays, and its follow-up keeps its outcome.

**Undo** (legacy "Undo cancel · re-open trip") keeps the closure as reopened, deletes the follow-up of
every unresolved booking with a history line, and leaves resolved bookings as they are. With any
resolved it first answers `409 has_resolved`, listing them (`BK-1 · reschedule`); send
`undo_anyway: true`. A reopened closure refuses notify, `PATCH` and undo (`409 closure_reopened`); the
trip may be closed again, as a new closure.

**Change feed:** kind `weather_closure`, `route_days` its trip, for every closure write and for a
booking command that resolved one of its rows.

**Calendars** that grey out a closed trip read `GET /v1/weather-closures?from=&to=`: availability does
not change, as legacy's seat count did not.

**Import.** `import-legacy.ts` mirrors `sb_weather` and the bookings' `weatherResolve`
(`legacy-weather.ts`), `lg_`-prefixed and replaced on every run, as legacy has them (the 3 stale
`awaiting` follow-ups included). Rehearsal of 2026-10-09: 5 closures, 40 follow-ups (3 awaiting,
37 resolved), the same 13 / 15 / 9 / 1 / 2 per closure as legacy.

### Partner van bills

Legacy's "วางบิลรถร่วม" (todo/money-model.md slice 5, migration 120, `src/domain/van-bills.ts`): what
a partner van owner bills us, per partner, month and ten-day period (1 = days 1–10, 2 = 11–20, 3 = 21
to the end). **The rows and every amount are worked out on each read** from the bookings' van parts and
check-ins; only what staff type is stored. Writes need the `accounting` area; any login may read.

| Method + path | Does |
|---|---|
| `GET /v1/van-bills?month=2026-09&period=2` | The overview: every partner with work in the period, most runs first, with `totals` |
| `GET /v1/van-bills/{partner}/{month}/{period}?van_id=` | One bill (a partner with no van and no bill: `404`); `van_id` shows one van's rows |
| `PATCH /v1/van-bills/{partner}/{month}/{period}` | The staff inputs; answers the bill |
| `POST …/pull-rates` | Fills `route_rates` from the van rates; answers the bill and `pulled` |
| `POST …/send`, `…/unsend`, `…/pay`, `…/unpay` | The settlement state (new); answers the bill |
| `GET /v1/van-rates`, `PUT /v1/van-rates` | Transfer Fleet's rate table |

```jsonc
// GET /v1/van-bills/Queen/2026-09/1
{ "partner": "Queen", "month": "2026-09", "period": 1, "from": "2026-09-01", "to": "2026-09-10", "label": "1–10", "saved": true, "van_id": null,
  "vans": [ { "id": "veh15", "name": "Queen1", "plate": null, "capacity": 13, "zone_base": "PK", "driver": null, "driver_phone": null, "active": true } ],
  "per_pax": 200, "rate": 0, "route_rates": { "PP": 1500 }, "row_overrides": { "2026-09-01~r10~veh15": { "rate": null, "ex": 200, "cut": null, "per": null } },
  "codes": [ { "code": "PP", "rows": 3, "rate": 1500 } ],
  "rows": [ { "key": "2026-09-01~r10~veh15", "date": "2026-09-01", "route_id": "r10", "code": "PP", "van_id": "veh15", "return_only": false,
      "ad": 11, "chd": 0, "inf": 0, "foc": 0, "pax": 11, "booked_pax": 11, "bookings": 4, "return_pax": 0, "return_bookings": 0, "return_same_van": 0,
      "pickups": ["Patong"], "drops": [], "override": { "rate": null, "ex": 200, "cut": null, "per": null },
      "rate": 1500, "ex": 200, "cut": 0, "per_pax": 200, "bill": 1700, "sale": 2200, "pl": 500, "new": false } ],
  "extra_lines": [ { "id": "x1", "date": "2026-09-01", "note": "รถนอก", "vans": 1, "pax": 0, "rate": 700, "ex": 0, "cut": 0, "per_pax": 0, "bill": 700, "sale": 0 } ],
  "totals": { "ad": 27, "chd": 0, "inf": 0, "foc": 0, "pax": 27, "booked_pax": 27, "vans": 4, "outbound_vans": 4, "avg_pax_per_van": 6.75,
              "ex": 200, "cut": 0, "bill": 5400, "sale": 5400, "pl": 0 },
  "by_code": [ { "code": "PP", "vans": 3, "pax": 27, "bill": 4700, "ex": 200, "cut": 0,
                 "mix": [ { "rate": 1500, "ex": 0, "cut": 0, "per_van": 1500, "vans": 2, "amount": 3000 }, { "rate": 1500, "ex": 200, "cut": 0, "per_van": 1700, "vans": 1, "amount": 1700 } ] } ],
  "missing_rate": 0, "new_rows": [], "seen": ["2026-09-01~r10~veh15", "…"], "updated_at": "…", "updated_by": "AP.Petch",
  "state": "sent", "sent": { "at": "…", "by": "AP.Petch", "bill": 5400, "changed_since_sent": false }, "paid": null }
```

**Rows** (legacy `vbRows`), one per day, route and partner van, from every booking not cancelled,
rejected or weather-cancelled:
- **`pax` is who was aboard** (legacy §vbPaxReal): booked less the no-shows and on-site cancels of the
  van and pier check-ins. A van no-show whose reason is `self_arrive` or `own_transfer`, or reinstated
  at the pier, still went; a pier `self_add` gives people back; a no-show with no breakdown comes off
  adults. A row stays at 0: the van ran.
- **A booking on several vans** shares its no-shows across them in proportion, the remainder on the
  last, shown as adults (legacy).
- **Out and back is one run** (§vbRetMerge): a part's return van (its own, else its group's; not when
  `return_same_van`) adds `return_pax` to that van's outbound row that day; a van that only brings
  people back gets a return-only row (`~R`, `pax` 0: the sale was on the way out).
- **`code`** is legacy's fixed table by route (r7–r10 `PP`, r11 `PB`, r12 `MT`, r1–r5 `SM`, r6 `SR`,
  others `—`). `pickups` and `drops` are labels; a drop is `changed` when the booking chose it.

**Amounts:** a row's `rate` is its override, else `route_rates[code]`, else `rate`; `per_pax` its
override, else the bill's. `bill = rate + ex − cut`, `sale = pax × per_pax`, `pl = sale − bill`. An extra
line bills `vans × rate + ex − cut`. `missing_rate` counts vans with no rate; `avg_pax_per_van` divides
by outbound vans only; `by_code.mix` groups vans by the same rate, extra and deduction (legacy §vbMix).

**`PATCH`** takes any of `per_pax`, `rate`, `route_rates` (`{ "PP": 1500 }`), `row_overrides`
(`{ "<row key>": { "rate", "ex", "cut", "per" } }`), `extra_lines` and `mark_seen`. A field sent
replaces that whole field; one not sent is kept. Amounts are numbers, 0 or more (a deduction is sent
positive). `400`: an unknown code, a row key that is neither in the period nor already stored, an
unknown field, or a worked-out field (`rows`, `totals`, `state`, …) sent with a different value; the
bill read back is accepted unchanged. **`mark_seen: true`** records the rows there are now (legacy
§vbSeen); a row that appears later with nothing typed on it is in **`new_rows`** (§vbNewRow).

**Sent and paid** (new: legacy had no state, decided 2026-10-09):
- `send` stamps who and when and the total (`sent.bill`); `changed_since_sent` is true while the total
  differs. Sending again re-stamps.
- `pay` `{ "via": "transfer" | "cash" | "cheque", "ref": "…", "paid_on": "2026-10-01" }` (default
  today) needs the bill sent (`409 bill_not_sent`) and records the total as `paid.amount`.
- **A paid bill refuses `PATCH`, `pull-rates`, `send` and `unsend`** (`409 bill_paid`); `unpay` first
  (`409 bill_not_paid` when it is not paid). `unsend` takes a sent bill back to draft.

**Pull rates** (legacy `vbPullRates`): for each code with work, the first of its routes with a rate
above 0 for the partner's van group, in its first van's zone. `pulled.got[].generic` marks a code
that fell back to the group's base or the default ("check before billing"). Nothing at all:
`409 no_van_rates`. The rates are a starting point: the bill keeps what was agreed.

**Van rates** (legacy `van_rates`, Transfer Fleet's "ราคาจริง"): cells of a van group (`own`, or
`p:<partner name>`), a route (`null` = the group's base) and a field (`base`, `PK`, `KL`). A van's day
costs the route's zone cell, else the route's base, else the group's base, else ฿900 (own) or ฿1,800.
`PUT /v1/van-rates` `{ "group": "p:Queen", "route_id": "r10", "field": "PK", "rate": 1700 }` sets one
cell and `rate: null` clears it; answers `{ groups, rates, defaults }`. Writes: `accounting` or `fleet`.
The daily report's van cost reads the same table.

**Import.** `import-legacy.ts` brings legacy's van bills with today's key (`legacy-van-bills.ts`),
upserted on partner, month and period: legacy's inputs replace ours, the sent and paid state stays.
The 5 bills under an older four-part key (`partner|van|month|period`) are skipped: legacy's own code
no longer reads them. `van_rates` and `dr_cfg` are replaced whole. Rehearsal of 2026-10-09: 26 bills,
62 row overrides, 3 extra lines, 65 rate cells; 24 bills give legacy's rows and totals exactly, 2
each miss one run whose legacy van group mixed vans (the van-group import leaves such a group without
a van).

### Money reports

Legacy's accounting dashboard, agent statement, Travel Summary totals and the Daily Report's money
pane (todo/money-model.md slice 6, `src/domain/money-reports.ts`). **Computed on every read; nothing is
stored.** They read the pier's money and the decisions after the trip ("Pier money", "After the trip")
through the same rule as those screens (`pierMoney`). A login tied to an agent gets `403` on the reports and reads only its own statement.

| Method + path | Legacy |
|---|---|
| `GET /v1/reports/accounting` | `renderAccounting` KPIs and `acctDashboardHtml` |
| `GET /v1/agents/{id}/statement` | `acctStatementOpen` |
| `GET /v1/reports/travel-summary?date=` | `renderTravelSum`'s totals (default today, Bangkok) |
| `GET /v1/reports/daily?date=` | `drData` and `drPaneFi` (default today) |
| `GET`, `PUT /v1/reports/daily/settings` | `drCfg`, `drCfgSet` |

```jsonc
// GET /v1/reports/accounting
{ "as_of": "2026-10-09", "outstanding": 427700, "paid_this_month": 283100, "credit_exposure": 17273133, "overdue_invoices": 54, "deposits_held": 0, "extras_this_month": 18450,
  "aging": { "not_due": 82000, "days_1_30": 236000, "days_31_60": 17400, "days_60_plus": 92300 },
  "collections": [ { "month": "2026-05", "amount": 0 }, "…", { "month": "2026-10", "amount": 283100 } ],
  "top_outstanding": [ { "agent_id": "amrlvm41bp8an5", "name": "ASIATIC ADVENTURES", "balance": 162500 } ] }
```

- **Accounting:** `outstanding` is the live invoices' balances; `aging` sorts them by days past
  `due_at`; `overdue_invoices` counts those with a balance past due. `paid_this_month` and
  `collections` (six Bangkok months) are live payments by `paid_on`, credit spent left out (legacy
  counted `type: payment` only). `credit_exposure` is every agent's credit `used`; `deposits_held`
  every agent's credit balance left (weather credits and deposits, less credit spent).
  `refunds_to_pay { count, amount, items }` lists the refunds owed and not paid out yet, oldest
  first. `top_outstanding` is the five largest balances.
  `extras_this_month` is legacy's "Extras · cash · month" (`acctExtrasMonthTotal`): every on-tour
  sale made this Bangkok month (by `sold_at`), whatever its method or trip day.
- **Statement** `{ agent_id, name, code, pay_type, invoiced, paid, outstanding, credit_balance, credit,
  invoices, credits, deposits }`: live invoices newest first, `paid` net of what refunds and credits
  took back, `credits` the agent's weather credits, `deposits` its live deposits.
- **Travel Summary** `{ date, bookings, booked, travelled, no_show, cxl, money, cot, noshow, collect_rows }`:
  `travelled` is booked less the last count (the pier's, else the van's); `no_show` and `cxl` are the
  check-in events.
  - `money` (legacy `tsMoneyOf`, `tsSaleList`), over the bookings with something to collect, taken or
    sold: `cash`, `transfer`, `card` and `received` are what was taken that day, pier payments plus
    on-tour sales and upgrades collected; `fees` the card fees of both (the bank's, not income);
    `pier { cash, transfer, card, total, fees, no_slip }` the live pier payments alone; `sales`,
    `sales_due`, `sales_count`, `commission`, `sales_fees`, `sales_by`, `sales_no_slip` the day's
    on-tour sales and the upgrades; `no_slip` counts non-cash money still waiting for its slip.
    `to_collect` is each booking's cash on tour, Love Kingdom balance and upgrades still owed, less
    what a paid invoice already cleared; `due` is `to_collect` less what the pier took; both leave
    out a booking nobody travelled on that paid nothing (`tsNoCollect`: one that paid counts, a
    refund's matter), and `to_collect_bookings` counts the rest. On-tour sales left to collect are in
    `sales_due`, not `to_collect`, as legacy. `net` is `received` less the cash-on-tour payouts
    (commission is not taken off, legacy §tsCommOut).
  - `cot { total, deduct, payout, not_collected, not_collected_bookings, undecided_bookings }`: the
    cash-on-tour decisions; one not made yet, or deducting and paying out more than the cash on tour,
    counts as undecided.
  - `noshow { cases, pending, decided, postponed, charged }`: a case is a booking someone did not
    travel on, or one already decided; `charged` adds the decided amounts, a postponement charges 0.
  - `collect_rows`: per booking, `cot`, `b2c_balance`, `upgrades_due`, `billed`, `target`, `paid`,
    `due`, `not_counted` (`cxl`, `no_show` or `null`), `received` by method, `fees`, `no_slip` and its
    `sales`.
- **Daily** `{ date, bookings, pax, paying_pax, revenue, revenue_per_pax, by_route, by_market,
  by_channel, by_agent, upgrades, due, got, no_slip, extras, van_cost, settings }`: a trip's revenue is its own price on a
  multi-trip booking, else the booking's total, 0 on an overnight return leg (legacy `tsTripAmount`);
  markets are the agent's, else staff, walk-in or not set; channels follow the agent's pay type.
  `due`, `got`, `no_slip` and `extras` are legacy `pckMoney` over the day: still owed at the pier
  (cash on tour, Love Kingdom balance, upgrades and on-tour sales still due, less pier payments), taken
  by pier payments, those waiting for a slip, and the day's on-tour sales; each `by_agent` row has
  its `due`.
  `van_cost` (legacy `drVanReal`) prices each van's day from the van rates by route and pickup zone,
  shared by heads when one van took two routes; with no van cost at all it is the vans × `van_cost`
  (`estimated: true`). `default_rate_vans` counts vans priced by the default, with no rate set.
  `longtail { charter_boats, join_pax, cost, by_route }` (legacy `drData` §drReal, `drLtRate`): the
  day's longtail boats chartered and join heads (booked heads, as legacy; an overnight return leg's
  was paid on the way out), at the route plan's `ltc` and `ltj` prices (฿600 a boat with no `ltc`
  line). `known_cost` is `van_cost.total + longtail.cost`; `net_before_boat_costs` is
  `revenue − known_cost + extras` (legacy's "คงเหลือก่อนต้นทุนเรือ/ครัว").
- **Settings** `{ van_cost, van_quota, target_per_pax, set, updated_at, updated_by }`: `PUT` takes
  whole numbers; 0 or `null` goes back to legacy's default (1,200, 6, 130). Writes: `operations` or
  `accounting`.

### Cost model and Trip P&L

Legacy's costing menu and Trip P&L (todo/money-model.md, "Design: the rest of Money", migration 160;
`src/domain/costing.ts`, `src/domain/trip-pl.ts`, `src/routes/costing.ts`). The maths is legacy's
`ctCalc`, line for line; replayed on 94 imported trips, every one of 1,778 cost lines and every
break-even matched legacy's own functions. Costing and P&L are staff screens: a login tied to an
agent gets `403`.

| Method + path | Body | Legacy | Writes |
|---|---|---|---|
| `GET`, `PUT /v1/costing/template` | `{ vat_rate, lines }` | `ctTpl`, `ctTplSave` | `accounting` |
| `GET /v1/costing/plans`, `GET /v1/costing/plans/{id}?pax=` | — | `ctPlans`, `ctCalc`, `ctBreakEven` | |
| `POST /v1/costing/plans` | fields, or `{ copy_of }` | `ctBlankPlan`, copy | `accounting` |
| `PATCH`, `DELETE /v1/costing/plans/{id}` | fields | `ctPlanPut` | `accounting` |
| `GET /v1/costing/boat-rents`, `PUT`, `DELETE /v1/costing/boat-rents/{boat_id}` | fields | `boat_rent`, `ctRentSet` | `accounting` |
| `GET`, `POST /v1/meal-venues`, `PATCH /v1/meal-venues/{id}` | fields | `MEAL_VENUES`, `mvAdd`, `mvSet` | `accounting` |
| `PUT /v1/routes/{id}/meal-venue` | `{ meal_venue_id \| null }` | `mvRouteSet` | `accounting` |
| `GET /v1/trip-actuals?from=&to=`, `GET /v1/trip-actuals/{date}/{boat_id}` | — | `trip_actuals` | |
| `PUT /v1/trip-actuals/{date}/{boat_id}/venue` | `{ venue: id \| "none" \| null }` | pier job sheet `pjMvSet` | `pier` or `operations` |
| `POST …/meal-order` | — | `pckMealSend` | `operations` |
| `PUT …/meal-note` | `{ text }` | `pckMealNoteSave` | `operations` |
| `PUT …/meal-overnight/{booking_id}` | `{ include: "in" \| "out" \| null }` | `pckMealOvnSet` | `operations` |
| `POST …/close`, `…/reopen`, `…/ran`, `…/not-ran` | — | `pxClose`, `pxRan` | `accounting` |
| `GET /v1/reports/trip-pl?date=&pier=` | — | `pxDay`, `pxDayAgg` | |
| `GET /v1/reports/trip-pl/{date}/{boat_id}` | — | `pxTrip` | |
| `GET /v1/reports/trip-pl/month?month=YYYY-MM&pier=` | — | `pxMonth` (each day's totals, to today) | |

**The template** `{ vat_rate, lines, dropped, saved }`: each line `{ id, group, label, vat, parts,
on_demand, on_demand_qty }`; a part `{ kind: fix | var | step, per?: "boat", qty?, qty_4en?, unit?,
unit_4en?, unit_th?, unit_ch?, unit_ch_th?, fuel?, mode?: every | over, every?, min?, over?, add? }`.
`fix` is qty × unit (× boats per boat; a `fuel` part's unit is ฿/L); `var` is per head with four
prices (adult/child × foreign/Thai, each falling back to a wider one); `step` adds one every N heads
(at least `min`), or `add` over X heads. `on_demand` lines (van, longtail join and charter) are
priced per item ordered: `on_demand_qty` is the default, a % of heads for a per-head line. With
nothing saved it is legacy's `CT_DEFAULT`. `PUT` replaces it whole; a default line left out is
`dropped` and stays out. Legacy's short keys (`k q q4 u u4 uTH uCh uChTH g l od odQ`) are accepted.

**A plan** (a route's design sheet): `name, route_key` (a route or a family), `note, engines (3EN |
4EN), boats, capacity, pax, pax_th, price, price_child, child_pct, commission_pct, fuel_price,
boat_id, rent_off, overrides ({line: {off, parts: [partial part | null]}}), groups ({group: {off,
pct}}), on_demand ({line: {agent_qty, agent_rev, upsell_qty, upsell_rev}}), itinerary, tiers` are
the client's; `seats` (the pinned boat's, else `capacity`), `calc` (priced at `pax` or `?pax=`:
`gross, vat_in, net, fixed_net, var_net, rows, rent, revenue, profit`) and `break_even` (the first
head count with a profit, walked 1..seats) are computed, and refused when sent (`400`).

**A rented boat** `{ rented, mode (lump | seat), amount, per_seat, days, days_off, trips_per_day, vat,
note, from, to, fuel_pct, owner_pays }` plus computed `seats, total, run_days, per_day, per_trip,
per_calendar_day`: per trip = rent ÷ (days − days off) ÷ trips. Inside `from..to`, with a rent, the
lines in `owner_pays` (default depreciation, captain, crew) are left out and the rent is a row of
its own. `fuel_pct` scales fuel parts whether rented or not. A `PUT` onto a boat with no record starts
from a record that is **not** rented (§rentZero).

**Trip actuals** (per boat and day): `venue_id` / `no_meal` (the day's restaurant, else the route's),
`meal` (the order sent: `venue_id, venue_name, adults, children, price_adult, price_child, amount,
at, by`), `meal_note`, `meal_overnight`, `ran`, `closed`; the read adds `meal_preview`.
`meal-order` counts the heads on board of the boat's bookings (an overnight return leg only once
marked `in`; infants do not order), prices them at the venue and freezes it; sending again replaces
it. Refused `409`: `no_meal_venue`, `overnight_meal_undecided` (with `bookings`), `nobody_aboard`.

**One trip** `{ boat_id, name, route_id, route_name, departs, status (est | part | done | nosail),
pax { ad, chd, inf, foc, total, th, fr, bookings, revenue }, capacity, revenue_gross, upsell, revenue,
cost, profit, would_cost, no_sail, ran, closed, fuel_price { price, src, from }, fuel_litres, plan,
engines, longtail { charter, join, upgrades, upgrades_due }, vans, rows, break_even, check_revenue }`:
- heads are those on board (the pier's count, else booked less those lost), Thai and foreign;
  revenue the trips' amounts; `revenue` is net of VAT and adds what the company keeps of on-tour
  sales (`upsell`);
- the route's plan gives only its overrides and groups (its heads and price are for playing);
- each row `{ id, group, label, vat, estimate, actual, use, gross, source, why }`, `source`:
  `actual` (fuel = Daily Fleet Log litres × the effective ฿/L; meal = the order sent; van = each
  van's day rate shared by heads; longtails = what was ordered; rent = the contract), `plan` (the
  route's plan changed the line), `formula`, or `pending` (a restaurant is set but no order sent);
  an actual with VAT counts net;
- `close` freezes revenue, cost and every row; `reopen` lets it move again. A boat with nobody and
  no booking did not sail (`nosail`, cost 0, `would_cost` what it would have been) unless marked
  `ran`. Refused `409`: `trip_closed`, `trip_not_closed`, `trip_not_sailed`, `trip_not_empty`; a boat
  with no deployment that day is `404`.

The day adds `totals { trips, revenue, cost, profit, pax, bookings, loss_trips, capacity,
did_not_sail }`, `by_route` and `by_group`; `check_revenue` flags a boat whose revenue a head is under
30% of the day's (legacy §revFlag).

**Change feed:** kind `trip_actual`, entity `{date}:{boat_id}`, on every write under
`/v1/trip-actuals/{date}/{boat_id}/`; a route's restaurant is a `route` change.

**Import:** `npm run import:costing` (after `import-legacy.ts`). Template, plans and rents are
replaced whole on every run; venues and route links upserted; trip actuals upserted, a close or
`ran` made here kept. Rehearsal 2026-10-10: 22 lines, 10 plans, 2 rents, 3 venues, 6 routes linked,
92 boat-days (90 meals, ฿774,730, as legacy; 36 notes; 2 overnight choices; 1 day venue), nothing
skipped.

### Deposits and refund payouts

An agent's money held with us (todo/money-model.md, "Design: the rest of Money", migration 161;
`src/domain/credit.ts`, `src/routes/credit.ts`). Writes: `accounting`.

| Method + path | Body | Answers |
|---|---|---|
| `GET /v1/deposits?agent_id=&include_voided=true` | — | `{ deposits }` (an agent login: its own) |
| `POST /v1/deposits` | `{ agent_id, amount, method?, received_on?, ref?, note?, slip_ids? }` | the deposit, `201` |
| `GET /v1/deposits/{id}` | — | the deposit with the agent's `credit_balance` |
| `POST /v1/deposits/{id}/void` | `{ reason }` | the deposit |
| `POST /v1/refunds/{id}/payout` | `{ method, paid_on?, ref?, slip_ids? }` | the refund with `payout` |
| `DELETE /v1/refunds/{id}/payout` | — | the refund, `payout: null` |

- **A deposit** (legacy "รับมัดจำ") is money an agent paid with no invoice. It adds to the agent's
  credit balance, the one weather credits fill, and is spent as a payment with `method: "credit"`.
  `method` is `transfer` (default), `cash` or `card`; `received_on` defaults to today (Bangkok).
  The balance is one pool: a deposit has no "remaining" of its own (legacy tracked which deposit a
  payment used). Void needs a reason and is refused `409 deposit_spent` when it would leave the
  balance below 0, `409 deposit_void` twice; a voided deposit stays listed with `include_voided`.
- **A refund payout** records that a refund owed to the agent was paid: `method` `transfer`, `cash`
  or `cheque`, `paid_on` (default today), `ref`, slips; `paid_out_by` is the login. Refused `409`:
  `not_a_refund` (a credit is spent, not paid out), `refund_paid_out`; undoing one not paid out is
  `409 refund_not_paid_out`. `GET /v1/refunds` shows each refund's `payout` and filters
  `?paid_out=true|false`. The accounting dashboard lists the unpaid ones (`refunds_to_pay`).
- **An overpaid invoice** stays a manual matter (decided 2026-10-10): the invoice reads `overpaid`,
  nothing is credited or refunded by itself.
- **Change feed:** kinds `deposit` and `refund` (a payout).
### Proforma (Daily PFM)

Legacy's Daily PFM (todo/money-model.md slice 2, migration 110): a proforma agent pays before travel,
by **18:00 Bangkok the day before the booking's first trip**. Past that and still unpaid, staff
extend travel or put the booking on hold. Hold is a label: it blocks nothing.

| Method + path | Body | Answers | Area |
|---|---|---|---|
| `GET /v1/pfm?date=` or `?from=&to=` (≤ 400 days) | — | `{ from, to, rows, totals }` | any login (an agent's: its own) |
| `POST /v1/bookings/{id}/pfm/approve-travel` | `{ approver?, version }` | the row | `operations` or `accounting` |
| `POST /v1/bookings/{id}/pfm/hold` | `{ version }` | the row | same |
| `POST /v1/pfm/remind` | `{ date }` or `{ from, to }` | `{ reminded: [booking ids] }` | same |

```jsonc
{ "booking_id": "BK-1", "version": 4, "voucher_ref": "V-881", "agent_id": "a12", "agent_name": "Andaman Tours", "sales_name": "Nok",
  "kind": "proforma", "travel_date": "2026-10-12", "route_id": "r10", "pax": 4, "cutoff_at": "2026-10-11T11:00:00.000Z", "past_cutoff": true,
  "total": 5600, "paid": 0, "balance": 5600, "invoice": { "id": "inv_…", "number": "INV-2610-0012", "status": "issued" },
  "status": "alert", "decision": null, "reminded_at": null, "cot_deduct": 0 }
// totals: { "count": 12, "total": 61200, "paid": 40000, "unpaid": 21200, "collected_pct": 65, "alert": 2, "by_status": { "paid": 7, … } }
```

- **Who is listed** (legacy `pfmInScope`): bookings holding seats with a trip in the range whose agent
  is `proforma` (`kind: proforma`), or an `invoice` agent's booking paid ahead on its own `prepay`
  invoice (`kind: prepay`, legacy §pfmPrepay: only what was received counts, no cutoff).
- **All computed:** `total`, `paid` and `balance` are the invoice's; with no invoice, the booking's
  total and fees less its cash-on-tour deductions. `status`, first that fits: `hold`, `approved`,
  `paid`, `prepaid_part`, `alert` (past the cutoff, unpaid), `awaiting` (invoiced), `no_invoice`.
- **Deciding** (legacy's Extend and Hold buttons): `approver` is free text, by default the booking's
  salesperson (`400` with neither). Refused with `409`: `booking_cancelled`; `not_proforma` (a prepay
  row); `pfm_paid`; `before_cutoff`; `pfm_decided` (the same decision again). The other decision may
  replace one; every decision and reminder is kept. History: `PFM unpaid · travel EXTENDED by Nok`,
  `PFM unpaid · put on hold`.
- **Remind** logs `PFM payment reminder sent` on every proforma booking in the range still owing
  (held and approved ones too, as legacy). It changes no booking's version.
- "Issue all" is `POST /v1/invoices` per booking.
- **Import:** legacy lost `ops.pfm` on every save; its history lines are read back as decisions and
  reminders.

### Pier money

Money at the pier (todo/money-model.md slice 3, migration 111): what the pier still has to collect,
what it took, the sales made on the day, and the settlement legacy never built.

| Method + path | Body | Answers | Area |
|---|---|---|---|
| `GET /v1/pier-money?date=&route_id=&pier=` | — | `{ service_date, rows }`: every booking holding seats that day | any login (an agent's: its own) |
| `GET /v1/bookings/{id}/pier-money?date=` | — | one row with `payments` (that day) and `tour_sales` | any login |
| `POST /v1/bookings/{id}/pier-payments` | `{ service_date, lines: [{ method, amount, fee_pct? \| fee?, note?, slip_ids? }], overpay_anyway?, version }` | `201`, the row | `pier`, `operations` or `accounting` |
| `POST /v1/bookings/{id}/pier-payments/{payment_id}/slips` | `{ slip_ids, version }` | the row | same |
| `DELETE /v1/bookings/{id}/pier-payments/{payment_id}?reason=` | `If-Match` | the row | same |
| `GET /v1/bookings/{id}/tour-sales` | — | `{ tour_sales }` | any login |
| `POST /v1/bookings/{id}/tour-sales` | the sale, `version` | `201`, the sale | `operations` |
| `PATCH /v1/bookings/{id}/tour-sales/{sale_id}` | what changes, `version` | the sale | `operations` |
| `POST /v1/bookings/{id}/tour-sales/{sale_id}/collect` | `{ method?, fee_pct?, slip_ids?, version }` | the sale | `operations` |
| `DELETE /v1/bookings/{id}/tour-sales/{sale_id}` | `If-Match` | `204` | `operations` |
| `GET /v1/pier-handovers?from=&to=&pier=`, `GET /v1/pier-handovers/{id}` | — | `{ handovers }`, one | any login but an agent's |
| `GET /v1/pier-handovers/preview?date=&pier=` | — | `{ service_date, pier, expected, handover }` | same |
| `POST /v1/pier-handovers` | `{ service_date, pier, cash_counted, note? }` | `201` | `pier` or `operations` |
| `POST /v1/pier-handovers/{id}/accept` | `{ note? }` | the hand-over | `accounting` |
| `POST /v1/pier-handovers/{id}/void` | `{ reason? }` | the hand-over | `pier` or `operations` |
| `GET /v1/commissions?from=&to=&seller=&paid=` | — | `{ items, totals }` | any login but an agent's |
| `GET /v1/commission-payouts?seller=&from=&to=`, `GET …/{id}` | — | `{ payouts }`, one | same |
| `POST /v1/commission-payouts` | `{ seller, items: [{ kind, booking_id, id }], method, paid_on?, ref?, note? }` | `201` | `accounting` |
| `POST /v1/commission-payouts/{id}/void` | `{ reason? }` | the payout | `accounting` |

```jsonc
// GET /v1/bookings/BK-1/pier-money?date=2026-10-12
{ "booking_id": "BK-1", "version": 6, "voucher_ref": "V-881", "lead_pax": "Ann", "agent_id": "a12", "route_id": "r10", "service_date": "2026-10-12",
  "overnight_return": false, "cot": 3000, "cot_currency": "THB", "cot_handling": "deduct", "cot_note": null,
  "upgrades_due": 1100, "upgrades_got": 0, "b2c_balance": 0, "tour_sales_due": 0, "tour_sales_got": 650,
  "gross": 4100, "paid": 2000, "fees": 0, "due": 2100, "got": 2650, "no_slip": 0, "term": "invoice", "paid_status": null,
  "payments": [ { "id": "pp_…", "booking_id": "BK-1", "service_date": "2026-10-12", "method": "cash", "amount": 2000, "fee": 0, "fee_pct": null,
                  "note": null, "slips": [], "by": "GSA.PK01", "at": "…", "deleted_at": null, "deleted_by": null, "delete_reason": null } ],
  "tour_sales": [ /* as below */ ] }
```

**The amount owed** (legacy `pckMoney`, never stored): `gross` = cash on tour + upgrades not
collected + the B2C balance (`payment_balance`) + on-tour sales of that day still to collect (`cot`);
`due` = `gross` − the day's pier payments, never below 0; `got` = sales and upgrades collected + pier
payments; `no_slip` counts transfer and card payments with no slip. An **overnight return leg** owes
none of the booking's cash on tour, upgrades or balance (`overnight_return: true`, legacy
§ovnSettled). A sale of another day is not this day's; one with no day counts every day. `term` is
Love Kingdom's own payment method on its bookings (legacy §b2cPayOne), else the agent's pay type.
**Boarding is never refused** for money owed (legacy's guard is a warning): the board reads `due`.

**Pier payments** (legacy `pckPaySave`): one payment per line, all at the same instant.
- `amount` pays the debt; a card's `fee` (from `fee_pct`, to the satang, or sent in baht) is kept
  apart: amount + fee is the card machine's figure. A fee on another method is `400`.
- A line of 0 is dropped, as legacy drops it; none left is `400` ("ใส่จำนวนเงินก่อน").
- Refused: a day the booking does not travel (`409 not_on_trip`); a cancelled booking (`409
  booking_cancelled`); more than `due` (`409 overpayment`) unless `overpay_anyway: true` (legacy's
  "บันทึกต่อไหม?").
- History, legacy's words: `เก็บเงินหน้าท่า ฿3,000 · แบ่งจ่าย 2 วิธี (เงินสด ฿2,000 · บัตรเครดิต ฿1,000 +ธรรมเนียม ฿30)`.
- **Delete** keeps the payment with `deleted_at`, `deleted_by`, `delete_reason` and out of every
  total (legacy removed it); a second delete is `409 payment_deleted`.

**On-tour sales** (legacy `SB_EXTRAS`, "Extra วันเดินทาง"):

```jsonc
{ "id": "ex_…", "booking_id": "BK-1", "trip_date": "2026-10-12", "service": "Longtail Join", "qty": 2, "unit_price": 650, "to_company": 910,
  "seller": "BEST", "method": "card", "fee_pct": 3, "fee": 39, "total": 1300, "commission": 390, "customer_paid": 1339, "settle": "done",
  "collected_at": "…", "collected_by": "ops1", "sold_at": "…", "sold_by": "ops1", "slips": [] }
```

- **The client's:** `service`, `qty` (≥ 1), `unit_price` (> 0, "ใส่ราคา"), `to_company` (at most the
  total), `seller`, `method` (`cash`, `transfer`, `card`, or `cot`: sold now, collected on the travel
  day), `fee_pct` (card only, at most 5, legacy's cap), `slip_ids`, `trip_date` (a day the booking
  travels; its first by default).
- **The server's:** `total` = qty × unit_price, `commission` = total − to_company, `fee`,
  `customer_paid` = total + fee, `settle` (`pending` while `cot`, else `done`), `collected_*`,
  `sold_*`. Sent with another value they are `400` naming what to use.
- **Collect** (legacy's ✓ on a `cot` sale) takes the money as cash, or `method` transfer/card;
  `409 already_collected` otherwise. Switching a sale back to `cot` makes it owed again.
- A sale whose commission was paid out cannot change its commission or seller, nor be deleted
  (`409 commission_paid`).
- History: `Day-of extra · Longtail Join ×2 · ฿1,300 · คอม ฿390 (card · fee ฿39)`, `Edited extra · …`,
  `Collected on tour · …`. A delete is not logged, as legacy.

**The pier's cash handed over at day close** (new; legacy never built it), per day and pier
(`routes.pier`, `other` when the route has none):
- `expected` is computed when handed over: by method (`cash`, `transfer`, `card`, `card_fees`) and by
  source (`pier_payments`, `tour_sales`, `upgrades`), plus `no_slip`. On-tour sales count on their
  day once collected; an upgrade counts on the day it was sold if the booking travels then, else on
  its first travel day.
- `cash_counted` is the pier's; `cash_difference` = counted − expected cash.
- One live hand-over per day and pier (`409 already_handed_over`); void it to redo, never once
  accepted (`409 already_accepted`). Accounts accept it.
- A later payment for that day is **not refused**: the read gives `expected_now` and `changed: true`.

**Commission payouts** (new): a payout pays one seller the commission of the on-tour sales and
upgrades it names. `amount` is computed. Refused: an item of another seller or with no commission
(`400`), a `cot` sale or upgrade not collected (`409 not_collected`), an item on a live payout
(`409 already_paid`). Void frees the items. `GET /v1/commissions` lists every commission in the range
(a sale's trip date, an upgrade's day as above) with its `payout_id`, and `totals` per seller.

**Change feed:** a booking command here is a `booking` change; kinds `pier_handover` and
`commission_payout` announce hand-overs and payouts (`route_days: null`).

### Pier office: petty cash

Legacy's "เงินสดย่อย" (§poCash; todo/pier-office-model.md, migration 170): a cash box per pier
(`tublamu`, `panwa`, `ranong`) whose balance carries from day to day, and two month sheets the pier
keys: longtail boats paid, and national-park and dock fees. Writes need `pier` or `operations`
(legacy `poCanEdit`); any staff login reads, an agent's login gets `403`. Petty cash is not linked to
pier payments or the hand-over, as in legacy.

| Method + path | Body | Answers |
|---|---|---|
| `GET /v1/pier-cash/{pier}/days/{date}[?deleted=true]` | — | the ledger day (below) |
| `POST /v1/pier-cash/{pier}/days/{date}/rows` | `{ kind: "in"\|"out", amount, description?, time? }` | `201`, `{ row, day }` |
| `DELETE /v1/pier-cash/rows/{id}?reason=` | — | `{ row, day }` |
| `POST /v1/pier-cash/{pier}/days/{date}/pull` | — | `201`, `{ rows, day }` |
| `GET /v1/pier-cash/{pier}/days/{date}/certificate[?ids=a,b]` | — | the receipt-substitute certificate |
| `GET /v1/pier-cash/{pier}/months/{yyyy-mm}` | — | the month table |
| `GET /v1/pier-cash/{pier}/months/{yyyy-mm}/longtail[?date=]` | — | the longtail sheet |
| `GET /v1/pier-cash/{pier}/months/{yyyy-mm}/park[?date=]` | — | the park-fee sheet |
| `PATCH /v1/pier-cash/{pier}/days/{date}/longtail/{boat_id}` | `{ join_boats?, charter_boats?, amount?, note? }` | `{ pier, date, boat_id, cell }` |
| `PATCH /v1/pier-cash/{pier}/days/{date}/park/{boat_id}` | `{ ad_th?, chd_th?, inf_th?, foc_th?, ad_fr?, chd_fr?, inf_fr?, foc_fr?, amount?, dock?, filled_from? }` | same |
| `GET /v1/pier-cash/settings`, `PUT /v1/pier-cash/settings` | `{ company_name }` | `{ company_name, updated_at, updated_by }` |

```jsonc
// GET /v1/pier-cash/panwa/days/2026-10-09
{ "pier": "panwa", "date": "2026-10-09", "opening": 12350, "in": 0, "out": 2250, "net": -2250, "closing": 10100, "negative": false,
  "reference": { "longtail": 0, "park": 20940, "dock": 300, "total": 21240 }, "pulled": 0, "waiting": 21240,
  "rows": [ { "id": "pc1791506960246odh", "pier": "panwa", "date": "2026-10-09", "kind": "out", "description": "Guide (PP1500)", "amount": 1500,
              "time": "07:48", "source": null, "created_at": "…", "created_by": "GSA.PK01", "deleted_at": null, "deleted_by": null,
              "delete_reason": null, "balance": 10850 } ] }
```

- **The ledger** (legacy `pcSheetMain`): `opening` is every earlier day's in − out at that pier;
  `closing` = opening + in − out. Rows run by `time` (`HH:MM`; untimed last; at one time, in before
  out), each with the `balance` after it. `negative` is legacy's "⚠ ติดลบ" warning: a balance below
  0 is never refused.
- **A row:** `amount` above 0 (to the satang; "ใส่จำนวนเงินก่อนครับ" in legacy), `kind`,
  `description` and `time` are the client's; `id`, `source`, `created_*` the server's. There is no
  edit, as in legacy. **Delete** keeps the row with `deleted_*` and out of every total (legacy removed
  it); `?deleted=true` lists them under `deleted`; a second delete is `409 row_deleted`.
- **The sheets' figures** (`reference`: longtail paid, park fees, dock fees) count in the ledger only
  once **pulled**: pull adds an out row per category with a total above 0 and no live pulled row
  that day (`source` `longtail`/`park`/`dock`, "ค่าเรือหางยาว (ดึงจากชีท)" …). Nothing new is `409
  nothing_to_pull`. `waiting` = reference − pulled: a cell changed after its pull shows there, and
  pulls again only after its pulled row is deleted (legacy pulls a category once a day). `source`
  sent on a row is `400`.
- **The month table** (`pcMonthTable`): `{ pier, month, opening, closing, days, totals }`, one day per
  date with rows, sheet cells or a boat deployed on a route of the pier, each with its own opening,
  in, out, closing, `reference`, `pulled`, `waiting`.
- **The sheets** (`pcSheetLT`, `pcSheetPK`): `{ days: [{ date, boats: [{ boat_id, boat_name,
  route_id, route_name, route_color, cell }], totals }], totals }`, for the boats deployed from the
  pier that day plus any boat with a cell. A longtail `cell` adds `used_boats` (= join + charter,
  legacy `n`); a park `cell` adds `heads` (the 8 counts). Both are the server's: a different value
  sent is `400`. A cell left with nothing is removed (`cell: null`), as legacy deletes it. A boat
  not in the catalogue is `404`. **Not here yet:** the booked side legacy shows beside them (join
  heads and charter boats from bookings, heads by nationality after check-in, the expected park fee
  from the cost plan).
- **The certificate** ("ใบรับรองแทนใบเสร็จรับเงิน", `pcPrintCert`): the day's out rows in ledger order,
  or only `ids` (`400` "No rows selected." when none is), with `company_name`, `date_th`
  (`09/10/2569`), `total` and `total_text_th` ("เจ็ดพันหกร้อยห้าสิบบาทถ้วน"; satang as "…สตางค์").
  Without a company name it is `409 company_name_missing` (legacy opens its dialog first).

### Pier office lists

The lists the Pier Office pages edit (todo/pier-office-model.md, migration 171). Writes need `pier`
or `operations`; any staff login reads.

| List (`{list}`) | Row | Legacy |
|---|---|---|
| `item-kinds` | `{ id, name, name_en, unit, color, sort, active }` (texts up to 40) | `pier_kinds`, the loan equipment kinds |
| `items` | `{ id, pier, kind_id, label, total, active, note }` | `pier_items`, each pier's equipment lines |
| `attendance-codes` | `{ id, code, label, color, bg, kind: work\|off\|leave\|none\|night, sort, active }` | `pier_codes`, the roster codes |
| `sections` | `{ id, pier, name, sort }` | `pier_sect`, the roster groups |
| `staff` | `{ id, pier, nick, name, role, phone, active, default_code, section_id, note, sort }` | `pier_staff` |
| `license-types` | `{ id, side: deck\|eng, short, formal, per_boat, active }` | `pier_lic_types` |
| `license-classes` | `{ id, type_id, name, max_gt, max_bhp, sort }` (null = no limit) | `pier_lic_classes` |

| Method + path | Answers |
|---|---|
| `GET /v1/pier-office[?pier=]` | `{ item_kinds, items, attendance_codes, sections, staff, license_types, license_classes }`, items, groups and staff narrowed to `pier` |
| `POST /v1/pier-office/{list}` | `201`, the row (not `license-types`: `405`) |
| `PATCH /v1/pier-office/{list}/{id}` | the row |
| `DELETE /v1/pier-office/{list}/{id}` | `{ deleted, unassigned }`: `item-kinds`, `attendance-codes`, `sections`, `license-classes` only; the others are switched off with `{ "active": false }` (`405`) |
| `POST /v1/pier-office/{list}/order` | `{ ids }` (`item-kinds`, `attendance-codes`), `{ pier, ids }` (`sections`, `staff`): every row once, in the order shown |

- A fresh system starts from legacy's seeds: kinds fin, mask, towel; 11 roster codes; the deck and
  eng licence types with two classes each.
- **The server's:** `id`, `sort` (the order command's; a new row goes last), a code's `bg` (legacy
  `paTint` of `color`), a licence type's `side`, a class's `type_id`. Sent with another value they are
  `400` naming what to use.
- **Refused:** an item with no label or an unknown kind (`400`; `409 no_kinds` when there are none);
  a negative total; deleting a kind that items use (`409 kind_in_use`); a code already used, any
  case (`409 code_taken`); a person with neither nick nor name (the missing one copies the other);
  a group of another pier; deleting a group with people unless `?unassign_anyway=true` (`409
  section_in_use`; they become unassigned).
- A person moved into another group, or to another pier, goes last (legacy `paStaffSect`); moved to
  another pier without a group named, they leave theirs. `default_code` is upper-cased.

### After the trip: cash on tour and no-show decisions

Legacy's Travel Summary decisions, per booking and trip date (todo/money-model.md slice 4, migration
112). Writes need `operations`, any login reads.

| Method + path | Body | Answers |
|---|---|---|
| `GET /v1/after-trip?date=` | — | `{ service_date, rows }`: each booking travelling that day with its cash on tour, `trip_amount` and both decisions |
| `GET /v1/bookings/{id}/after-trip` | — | `{ cot_decisions, noshow_charges }` |
| `PUT /v1/bookings/{id}/cot-decisions/{date}` | `{ mode, deduct?, payout?, ref?, slip_ids?, version }` | `{ decision, invoice, warnings }` |
| `DELETE /v1/bookings/{id}/cot-decisions/{date}` | `If-Match` | `{ decision: null, invoice, warnings }` |
| `PUT /v1/bookings/{id}/noshow-charges/{date}` | `{ decision, amount?, note?, version }` | the decision |
| `DELETE /v1/bookings/{id}/noshow-charges/{date}` | `If-Match` | `204` |

**Cash on tour** (legacy `TS_COT`): `mode` is `full` (deduct all of it from the agent's invoice),
`part` (the client's `deduct` and `payout`, deduct-all to start), `none`, `payout` (all paid back to
the agent) or `nocol` (never collected; `ref` says why). Except for `part`, `deduct` and `payout` are
the server's (whole baht) and a different value is `400`. The decision answers `cot`, `kept` (what
the company keeps) and `over`: deduct + payout above the cash on tour is a warning (`cot_over`), as
legacy. `ref` and slips survive a change of mode. Refused: no cash on tour (`409 no_cash_on_tour`), a
day the booking does not travel (`409 not_on_trip`), a cancelled booking.

```jsonc
// PUT /v1/bookings/BK-1/cot-decisions/2026-10-12  { "mode": "full", "ref": "KBank 123", "version": 6 }
{ "decision": { "booking_id": "BK-1", "service_date": "2026-10-12", "mode": "full", "deduct": 1500, "payout": 0, "ref": "KBank 123",
                "by": "ops1", "at": "…", "cot": 1500, "kept": 0, "over": false, "slips": [] },
  "invoice": { "...": "the booking's invoice", "total": 4100, "overpaid": 0 }, "warnings": [] }
```

**The invoice subtracts `deduct`** (decided 2026-10-09; legacy only warned, so the money was
collected twice). The booking's live booking or prepay invoice gets a minus line per trip date
(`cot_date`), changed with the decision and taken off (`removed_reason: "cot"`) when it is cleared;
its totals and VAT are worked out again, as for a discount. A booking not invoiced yet gets the lines
when it is. A fee invoice is never touched. An invoice already paid can end up `overpaid`: the
answer warns `invoice_overpaid`; refunding or crediting it is accounting's. History: `Invoice
INV-2610-0012 · cash on tour deducted ฿1,500 · total ฿4,100`.

**No-show charge** (legacy `travel_sum`): `decision` `full` (amount the trip's price, computed:
legacy `tsTripAmount`, 0 on an overnight return leg, a trip's own subtotal on a multi-trip booking,
else the booking's total), `partial` (the client's `amount`, whole baht, required), `none` or
`postpone` (0); a different amount is `400`. It bills nothing and moves nothing: on `postpone` the
screen opens the reschedule, as legacy.

**Import.** `import-legacy.ts` mirrors legacy's pier payments, `SB_EXTRAS`, `TS_COT`, `travel_sum`,
the PFM history lines and the B2C payment state (`legacy-pier-money.ts`), `lg_`-prefixed and hanging
off the imported bookings, so they are replaced with them on every run; what was made here on an
imported booking goes with it, as invoices' payments do. Imported invoices get no minus lines, so
their totals stay legacy's; the run lists the invoiced bookings that carry a deduction.
Rehearsal of 2026-10-09 (after `import:attachments`), every total equal to legacy's:
- 158 pier payments on 156 bookings: cash 122 ฿325,000, card 27 ฿63,323 + ฿2,698 fees, transfer 9
  ฿13,990; all 34 slips linked;
- 160 on-tour sales, ฿256,000, commission ฿80,500; 49 slips;
- 143 COT decisions (deduct ฿203,450, payout ฿20,750; 8 slips); 76 no-show decisions (฿349,000);
- 71 PFM events (69 reminders, 2 extensions);
- 56 bookings owing a B2C balance (฿417,079; legacy's other 2 are bookings the import skips, a test
  order among them);
- 11 invoiced bookings carry a deduction their invoice does not show.

### Upgrades

**On-tour sales.** An upsell sold to the customer on the day ("Longtail · Join → เหมา (Charter)"):
`upgrades` is a booking field, accepted on `POST /v1/bookings` and `PATCH /v1/bookings/{id}` and
returned on every read. The list replaces outright (absent = unchanged, `[]` = clear). Legacy's
spellings (`sellPrice`, `toCompany`, `feePct`) are accepted.

```jsonc
"upgrades": [ { "id": "up_1789029877535", "label": "Longtail · Join → เหมา (Charter)", "sell_price": 1100, "to_company": 770,
                "commission": 330, "seller": "BEST", "note": null, "collected": true, "settle": "pending",
                "method": "card", "fee_pct": 5, "fee": 55, "customer_paid": 1155, "at": "2026-09-10T08:44:37.535Z",
                "slips": [ { "id": "att_mtvcoqp0_efb5fa2ab1", "name": "4767.jpg", "mime": "image/jpeg", "size": 539033 } ] } ]
```

- **Computed:**
  - `commission` = `sell_price − to_company`;
  - `fee` = `sell_price × fee_pct / 100` for a `card` payment, 0 otherwise;
  - `customer_paid` = `sell_price + fee`;
  - `at` is when the sale was first saved; it doesn't change on an edit.

  Values sent for them are replaced. A sale with no `method` (legacy's older ones) has no `fee` or
  `customer_paid`.
- **Refused (`400`, naming the index):**
  - no `sell_price` above 0 (legacy's "ใส่ราคาขาย");
  - `fee_pct` above 100;
  - an `id` twice;
  - `settle` other than `pending` / `done`;
  - a `slips` id that isn't an uploaded file (see "Attachments").

  `id` is the client's (`up_<ms>`), made by the server if absent. `settle` starts `pending`.
- **`collected` is set once** (todo/money-model.md slice 3, the same rule as on-tour sales): a new sale
  may say it was paid; an existing sale's `collected` sent different is `400` naming
  `POST /v1/bookings/{id}/upgrades/{upgrade_id}/collect` (`{ method?, fee_pct?, slip_ids?, version }`,
  cash by default, as legacy's collect button; a card pays its fee on top; slips are added). It answers
  the booking, logs `Collected on tour · <label> · ฿1,100 (cash)`, and refuses one already collected
  (`409 already_collected`). Areas: `operations` or `accounting`.
- **History**, in legacy's words: "Upgrade · <label> · ขาย ฿2,000 · บริษัท ฿1,300 · คอม ฿700 ·
  <seller>" for a new sale; "Edited upgrade · …" for a changed one. Removing a sale isn't logged.

**Route upgrade.** One trip moves to another programme that sails that day (legacy's
"⤴ Upgrade"):

| Method + path | Body | Answers |
|---|---|---|
| `POST /v1/bookings/{id}/upgrade` | `{trip_id, to_route_id, reason, charge?}` | the booking |
| `POST /v1/bookings/{id}/upgrade/undo` | `{trip_id}` | the booking |

- **The trip moves at the price it was booked at.** As any move, it loses its boat, vans and
  check-ins (pier note kept); the route's calendar is checked as for an edit.
- **A `charge` above 0** adds an on-tour sale "Upgrade > <programme>": cash, not collected,
  all of it owed to the company.
- **History:** "Upgrade route · <from> > <to> · <reason> · +THB 1,500" (or "· no charge").
- The trip's `operations.upgrade` shows the upgrade in force:
  `{id, from_route_id, to_route_id, reason, charge, upgrade_id, at, by}`, or `null`.
- **Refused:**
  - `400`:
    - no `reason` (legacy's "Enter a reason.");
    - `to_route_id` the trip is already on;
    - a trip not on the booking;
    - `charge` below 0;
  - `409`:
    - `charter`: a charter trip;
    - `overnight`: an overnight trip ("Edit the booking instead");
    - `lock_draw`: a trip drawing on a seat lock ("Release the lock draw first");
    - `already_upgraded`;
    - `route_not_sailing`: no boat on the target that day;
    - `not_enough_seats`: "Needs 2, free 1".
- **Undo** moves the trip back, under the same seat checks (`409 not_upgraded` if there's no
  upgrade). It drops the charge unless it was collected, logs "Upgrade undone · back to <from>",
  and keeps the upgrade's record.

The import brings every legacy sale, with its own fee and amount paid, and its payment slips (once
`import:attachments` has copied the files).

### Reconfirm

Did the customer confirm their pickup, and was the agent's re-confirm list sent: legacy's Re-confirm
page and the ops board's re-confirm column. Every booking read carries it as `reconfirm`, `null`
until something is recorded:

```jsonc
"reconfirm": { "status": "done", "via": "reconfirm", "at": "2026-09-09T10:02:11.000Z", "by": "Nok",
               "sent": true, "sent_at": "2026-09-09T11:00:00.000Z", "sent_by": "Nok" }
```

| Method + path | Body | Answers |
|---|---|---|
| `PUT /v1/bookings/{id}/reconfirm` | `{status, via?}` | the booking |
| `DELETE /v1/bookings/{id}/reconfirm[?all=true]` | — | the booking |
| `POST /v1/reconfirm/sent` | `{booking_ids: [...], sent: true\|false}` | `{bookings: [{id, reconfirm}], skipped: [{id, reason}]}` |

- **`status`** is what the customer said:
  - `wa`: WhatsApp sent, awaiting;
  - `noans`: called, no answer;
  - `off`: called, phone off;
  - `callback`: call back later;
  - `done`: confirmed.

  **`via`** is where it was recorded: `reconfirm` (the Re-confirm page, the default), or `list` /
  `phone` (the ops board). The server stamps `at` and `by` from the login. Anything else is `400`.
- **Sending the list is a separate fact** (legacy §rcSplit):
  - setting or clearing the status from the Re-confirm page keeps `sent` as it was;
  - from the ops board, setting a status (`via` `list` or `phone`) replaces the record whole, and
    its clear (`?all=true`) removes it: both drop `sent`, as legacy's board buttons do;
  - sending never changes the status;
  - `sent: true` stamps `sent_at` and `sent_by` (again on a resend);
  - `sent: false` undoes it;
  - a record left with neither a status nor a send is removed (`reconfirm: null`).
- `POST /v1/reconfirm/sent` passes over cancelled and rejected bookings when sending, as legacy does,
  and lists them in `skipped`. An unknown booking id refuses the whole request (`400`).
- **History:** setting a status logs legacy's line ("Re-confirm: WhatsApp sent · awaiting", or
  "Re-confirmed pickup (phone)" from the ops board); a send logs "Re-confirm sent to agent".
- `PATCH /v1/bookings/{id}` may echo `reconfirm` back unchanged; any other value is `400`.
- Writes need the `operations` edit area. They don't change the booking's `version`.
- **Legacy differences:**
  - re-confirming every booking on a trip at once is one `PUT` per booking: skip those already
    `done`, as legacy does.
- The import brings every legacy record. One saved before legacy split out "sent" counts as sent
  when its status is `done`, at the time and by the person who confirmed it, as legacy reads it.

### Van groups

A van group is the passengers who ride one outbound van run together, on one route and day. It
holds the van, the members' default return van and the pickup time. Writes need the `operations`
edit area. Every write answers the group as `GET` shows it, except `DELETE` (`204`).

| Method + path | Body | Rule |
|---|---|---|
| `GET /operations/van-groups?service_date=&route_id=` | — | `{service_date, route_id, groups}`: by zone (PK, KL, RN, NoTransfer, others), then the zone's `display_order`, then number |
| `PUT /operations/van-groups/order` | `{service_date, route_id, zone, group_ids}` or `{…, clear: true}` | The order staff dragged one zone's groups into (legacy `bkv2_grp_order`): those named get `display_order` 1..n, the zone's others `null` and follow by number. `[]` or `clear: true` resets. Answers the day's groups |
| `POST /operations/van-groups` | `{service_date, route_id, zone, members: [{trip_id, idx?}], van_id?, allow_second_round?}` | `201`. Number: one more than the highest that route and day, across zones. Members get `sequence` 1..n in the order sent |
| `POST /operations/van-groups/{id}/members` | `{members: [...]}` | Moves the parts in from any other group, numbered after the last member |
| `PATCH /operations/van-groups/{id}` | `{van_id?, return_van_id?, pickup_time?, allow_second_round?}` | See below. `null` clears |
| `PUT /operations/van-groups/{id}/order` | `{members: [...]}` or `{clear: true}` | The pickup order, 1..n; `clear` goes back to ordering by time. `members` must list each member once (`400`) |
| `DELETE /operations/van-groups/{id}` | — | Disband: members lose the group, their order and their own return van; their final pickup and `return_same_van` stay |
| `POST /operations/van-groups/clear` | `{service_date, route_id}` | Every group that route and day loses its van; groups and return vans stay. Answers the day's groups |

```jsonc
{ "id": "vgrp_…", "service_date": "2026-10-02", "route_id": "r1", "zone": "PK", "number": 3,
  "van_id": "veh07", "return_van_id": null, "pickup_time": "06:40",
  "pax": 12, "customer_pax": 11, "stop_seats": 1, "capacity": 12, "over_capacity": false,
  "stops": [ … ],
  "members": [ { "trip_id": "trip_…", "booking_id": "lg_…", "idx": 0, "source": "main", "ad": 2, "chd": 1, "inf": 0, "foc": 0,
                 "sequence": 1, "pickup_time": "06:40", "return_van_id": null } ] }
```

- **Members** are van parts (`trip_id`, `idx`, default 0). Each must be on the group's route and
  day (`400`), from a booking that isn't cancelled (`409 cancelled`), not NoTransfer
  (`409 self_arrive`), and picked up in the group's `zone` (`409 zone_mismatch`). The zone is the
  trip's zone, else the booking's pickup zone; a charter is `__CHARTER__`; a NoTransfer seat with a
  private-van add-on (`transfer-<route>-<PK|KL>-<vehicle>`) is in that van's zone.
- **`van_id`** must be in the route's van pool that day: vans the month matrix puts on the route
  and that are usable (`409 van_not_in_pool`). It must seat the group (`409 van_over_capacity`);
  every passenger takes a seat, infants and FOC included. A van already on another group of the
  same route and day is a second round, refused (`409 van_in_other_group`, naming those groups and
  times) unless `allow_second_round: true`. Seats are checked per round, never summed.
- **`return_van_id`** must be in the return pool (`409 van_not_in_pool`): the outbound pool, plus
  usable vans whose zone that day is the group's (`zone_on` in the month matrix). A charter takes any usable van, NoTransfer none. Setting it sets the members'
  `return_same_van` to false.
- **`pickup_time`** (`HH:MM`) is also written as every member's `pickup_time_final`, as legacy does
  (an alternate-pickup part's own time comes with alternate pickups).
- **Seats** are checked when a van is set, when members join a group with a van, and when a van
  stop is added (see "Van stops"). `pax` (computed) is every seat taken: `customer_pax` plus
  `stop_seats`, the guides riding along on the outbound leg, as legacy counts them. `capacity` and
  `over_capacity` show a group pushed over later, e.g. by an edit. `stops` are its van stops.
- **Cancelled bookings** take no part: not in `members`, `pax` or a second-round check.
- **A group with nobody riding and no stop** (its members moved, removed or cancelled) is kept, with its van and
  number, and left out of `GET` until a member joins again. A new group never reuses its number.
- **`display_order`** (validated) is the group's place among its zone's groups, `null` when not
  dragged. Every id in `group_ids` must be a group of that date, route and zone, named once (`400`).
  The board and the van job orders both follow it; group numbers do not change.

### Vans and the month matrix

Legacy's Vans page: the fleet, which programmes each van serves on a date, its days off, its zone
and its driver of the day. Writes need the `operations` edit area. Every field is the client's; the
server checks shapes, works out what each day comes to, and keeps each van's log.

| Method + path | Body | Answers |
|---|---|---|
| `GET /operations/vans` | — | `{ vans: [Van] }`, by id |
| `GET /operations/vans/{id}` | — | the van, its `status_ranges` and its `zone_ranges` |
| `GET /operations/vans/{id}/log?limit=` | — | `{ log: [{at, kind, text, by}] }`, newest first; `limit` 1–500, default 100 |
| `POST /operations/vans` | `{name, capacity?, plate?, type?, ownership?, partner_name?, zone_base?, color?, driver?, driver_phone?, active?, note?}` | `201` the van |
| `PATCH /operations/vans/{id}` | any of the same | the van |
| `DELETE /operations/vans/{id}` | — | `204`; see below |
| `POST /operations/vans/{id}/status-ranges` | `{status: "off"\|"maintenance", from_date, to_date?, note?}` | `201` the range |
| `PATCH /operations/vans/{id}/status-ranges/{range_id}` | any of the same | the range |
| `DELETE /operations/vans/{id}/status-ranges/{range_id}` | — | `204` |
| `POST /operations/vans/{id}/zone-ranges` | `{zone: "PK"\|"KL", from_date?, to_date?}` | `201` the range |
| `PATCH /operations/vans/{id}/zone-ranges/{range_id}` | any of the same | the range |
| `DELETE /operations/vans/{id}/zone-ranges/{range_id}` | — | `204` |
| `GET /operations/van-days?from=&to=` | — | the matrix, at most 93 days |
| `PUT /operations/van-days/{date}/{van_id}` | `{route_ids?, status?, zone?, driver?, driver_phone?, plate?}` | the day |

```jsonc
// Van
{ "id": "veh07", "name": "Van 7", "plate": "นข 1234", "type": "van", "capacity": 12, "ownership": "own",
  "partner_name": null, "zone_base": "PK", "color": "#0f6e56", "driver": "Somchai", "driver_phone": "081…",
  "active": true, "note": null }
// GET /operations/van-days?from=2026-10-01&to=2026-10-31
{ "from": "2026-10-01", "to": "2026-10-31", "vans": [ … ],
  "days": [ { "van_id": "veh07", "service_date": "2026-10-01", "route_ids": ["r1", "r5"], "status": null, "zone": null,
              "driver": null, "driver_phone": null, "plate": null,
              "status_on": "maintenance", "usable": false, "zone_on": "KL" } ],
  "status_ranges": [ { "id": 3, "van_id": "veh07", "status": "maintenance", "from_date": "2026-09-28", "to_date": null, "note": "gearbox" } ],
  "zone_ranges": [ { "id": 1, "van_id": "veh07", "zone": "KL", "from_date": "2026-10-05", "to_date": "2026-10-20" } ] }
```

- **A new van** gets legacy's defaults (9 seats, a van, own, zone PK, active) and legacy's id: `veh`
  and one more than the highest number in use. `name` is required (`400`, legacy's "Please enter a
  vehicle name"). Legacy's spellings `partnerName`, `zoneBase` and `driverPhone` are accepted.
- **`ownership`** is `own` (บริษัท), `rented` (เช่า) or `partner` (ร่วม). An `own` van has no
  `partner_name`; a rented van keeps its lessor's there.
- **Delete** removes a van no van group uses (as outbound van, return van, or a part's return van)
  and with no day in the month matrix, together with its log and ranges. Otherwise
  `409 van_in_use` ("… set it inactive instead"): a retired van is `active: false`.
- **`days`** has every van × every date, in van then date order. `status`, `zone`, `driver`,
  `driver_phone` and `plate` are that day's overrides (`null` = none). Computed:
  - **`status_on`** (legacy `vehStatusOn`): the day's own status if set, else the latest-added
    status range covering the date, else `null`.
  - **`usable`**: active, and not `off` or `maintenance` that day. Only usable vans enter a route's
    van pool.
  - **`zone_on`** (legacy `vehEffectiveZone`): the pier zone of the van's first route that day
    (Panwa PK, Tap Lamu KL), else the day's `zone`, else the first-added zone range covering the
    date, else `zone_base`. The return-van pool reads it.
- **`route_ids`** are the programmes the van serves that day, the only source of a route's van pool
  (no zone fallback, as legacy). A `PUT` replaces the list; `[]` clears it; an unknown route is `400`.
- A status range's `to_date: null` is open-ended; a zone range may be open at either end. A range
  ending before it starts is `400`.
- **The log** is written by the server, in legacy's words, on the changes legacy logs:
  - a new van;
  - `active`, `zone_base`, `driver` or `color` changing;
  - a day's routes, status or zone;
  - a status range given both ends;
  - a zone range given both ends, or deleted.

  For example "ย้ายโซนหลัก PK → KL" or "2026-10-05 · เพิ่มเส้นทาง Phi Phi Bamboo". `kind` is
  `created`, `edit`, `status`, `zone` or `driver`; `by` is the login (`null` on imported lines).
  Every line is kept.
- **"Sent to the driver"** is per job now, not per van and day: a `sent_at` sent here is `400`,
  naming `PUT /operations/van-jobs/{date}/{key}/sent` (see "Van job orders").

### Van stops

A stop a van makes that isn't a booking: a guide riding to the pier (`staff`), or something to
pick up (`cargo`). A stop rides its group's van. Writes need the `operations` edit area.

| Method + path | Body | Answers |
|---|---|---|
| `GET /operations/van-stops?service_date=&route_id=` | — | `{ stops }` in pickup order (manual `sequence`, then `time`, untimed last); `route_id` optional |
| `POST /operations/van-stops` | `{group_id, kind?, label, pax?, time?, place, area_id?, area?, leg?, phone?, note?, sequence?, seats_anyway?}` | `201` the stop |
| `PATCH /operations/van-stops/{id}` | any of the same | the stop |
| `DELETE /operations/van-stops/{id}` | — | `204` |
| `PUT /operations/van-stops/{id}/check-in` | — | the stop, checked in now by the login |
| `DELETE /operations/van-stops/{id}/check-in` | — | the stop, not checked in |

```jsonc
{ "id": "vs_…", "service_date": "2026-10-02", "route_id": "r1", "group_id": "vgrp_…", "kind": "staff",
  "label": "Guide Nok", "pax": 1, "time": "06:20", "place": "Office", "area_id": "pk-patong", "area": "Patong",
  "leg": "out", "phone": "089…", "note": null, "sequence": null,
  "checked_in": { "at": "2026-10-02T23:15:00.000Z", "by": "Ploy", "seats": 1 },
  "created_at": "…", "created_by": "Ploy", "updated_at": null, "updated_by": null }
```

- **Legacy's form rules**, `400` with its messages:
  - `label` is required ("Type what this stop is for");
  - `place` is required ("Type where the van stops");
  - a `staff` stop needs `pax` of 1 or more ("How many people ride along? Enter at least 1");
  - a `cargo` stop carries nobody (`pax` 0);
  - `time` is `HH:MM`;
  - `kind` defaults to `staff`, `leg` (`out`, `ret` or `both`) to `out`.
- **`group_id`** must be a van group (`400`) that has a van (`409 group_has_no_van`: legacy's
  "เลือกรถก่อน"). The stop takes the group's date and route, and rides whatever van the group has.
- **Seats:** a `staff` stop on the outbound leg (`out` or `both`) takes `pax` seats in its group.
  Adding it, or an edit that takes more seats, is refused when the group's van can't seat everyone
  (`409 van_over_capacity`), unless `seats_anyway: true` (legacy's "Add anyway?"). Van groups count
  these seats in every check, and show them as `stop_seats` (see "Van groups").
- **Check-in** records when, by whom, and the seats taken then (a `staff` stop's `pax`, 0 for cargo).
- **A disbanded group** leaves its stops on the day with `group_id: null`; a `PATCH` with a
  `group_id` puts one on another group. `area_id` is a plain id, not checked against the
  pickup-area catalogue.

### Van job orders

Legacy's Van Job Orders page: the sheet each van driver gets, one per van, programme and day, one
per round when the van runs the programme twice. The server builds the job list and every sheet
(`src/domain/van-jobs.ts`); the layout, fonts, colours and row highlights stay in the client.
Reads are open to any login; writes need the `operations` area. Nothing here enters the change feed.

| Method + path | Body | Answers |
|---|---|---|
| `GET /operations/van-jobs?date=[&route_id=]` | — | the day's jobs and its warnings (below) |
| `GET /operations/van-jobs/{date}/{key}` | — | one sheet: `{job, out, ret, ret_on_round_1, unassigned_on_route}` |
| `PUT /operations/van-jobs/{date}/{key}/sent` | — | the job, sent to the driver now, by the login |
| `DELETE /operations/van-jobs/{date}/{key}/sent` | — | the job, not sent |
| `GET /operations/pickup-names-th` | — | `{names: [{name, name_th, updated_at, updated_by}]}` |
| `PUT /operations/pickup-names-th` | `{name, name_th}` | `{name, name_th}`; an empty `name_th` deletes it |

```jsonc
// GET /operations/van-jobs?date=2026-10-06
{ "date": "2026-10-06",
  "jobs": [ { "key": "vgrp_…", "service_date": "2026-10-06", "route_id": "r10", "route_name": "Phi Phi Bamboo by Speedboat",
              "group_id": "vgrp_…", "group_number": 1, "van_id": "veh03",
              "van": { "name": "Love3", "plate": "31-6675", "color": "#8b5cf6", "capacity": 13, "ownership": "own", "partner_name": null, "zone_base": "PK" },
              "round": null, "has_out": true, "has_ret": true, "zones": ["PK"],
              "out_pax": 7, "ret_pax": 7, "stop_seats": 0, "pax": 7, "capacity": 13, "over_capacity": false, "bookings": 3, "struck": 0,
              "driver": { "name": "บังญัติ", "phone": "080…", "plate": "31-6675", "override": false, "plate_override": false },
              "pickups": [ { "name": "Park 38", "name_th": "ปาร์ค 38" } ],
              "sent": { "at": "2026-10-05T11:45:22.092Z", "by": "Ploy", "changed_since_sent": false } } ],
  "unassigned": { "pax": 4, "by_route": [ { "route_id": "r10", "pax": 4 } ] },
  "return_unarranged": [ { "booking_id": "…", "trip_id": "…", "route_id": "r10", "lead_pax": "…", "drop": "Old Town Hostel", "pax": 2 } ],
  "self_arrive": [ { "booking_id": "…", "trip_id": "…", "voucher": "…", "lead_pax": "…", "hotel": "…", "has_van": true } ],
  "struck": 0 }
// a sheet's out.rows[] (ret.rows the same; on the return leg the pickup is the pier)
{ "no": 1, "kind": "booking", "booking_id": "…", "trip_id": "…", "parts": [0], "merged_parts": 1, "voucher": "…", "lead_pax": "…",
  "other_names": ["…"], "ad": 2, "chd": 1, "inf": 0, "foc": 0, "pax": 3, "split": null,
  "pickup_time": "07:30", "pickup": "Park 38", "pickup_th": "ปาร์ค 38", "room": "512", "zone": "Patong", "zone_th": "ป่าตอง",
  "drop_off": null, "drop_own": false, "return_van_id": null, "from_van_id": null, "extra": false, "bags": 2,
  "special_request": "รอด้านล่าง", "struck": null, "ovn": null, "ovn_return_date": null }
{ "no": 2, "kind": "stop", "stop_id": "vs_…", "stop_kind": "staff", "label": "Guide Nok", "seats": 1, "leg": "out",
  "time": "06:20", "place": "Office", "phone": "089…", "zone": "Patong", "zone_th": "ป่าตอง", "note": null }
// out.totals, ret.totals
{ "ad": 9, "chd": 2, "inf": 0, "foc": 0, "pax": 11, "bookings": 5, "separate_drops": 1, "struck": 1, "stops": 1, "stop_seats": 1 }
```

- **A job** is a van group with a van and something to carry (key: the group's id), or a van that
  only brings people back on a route (key `<van_id>~<route_id>`). A van with two groups of one
  route that day runs two **rounds**: `round` is `{no, of, time}`, numbered by each group's earliest
  pickup (legacy `vjRoundPick`), `null` when it runs once. The return leg prints once, on round 1's
  sheet (`ret_on_round_1` on the others). Unknown key that day: `404`; a bad date: `400`.
- **Outbound rows** are the group's parts, less bookings that come on their own (`pickup_self`) and
  overnight return legs. Two parts of one booking picked up at the same place are one row
  (`merged_parts`). **Return rows** are every part coming back on this van: its own return van,
  else its group's, else its group's van; less self-returns (a separate drop-off in a NoTransfer
  area, or named "self-arrive" / "กลับเอง") and overnight outbound legs. Rows from another van go last.
- **Order** (legacy §vsSeqTime): a group's manual order first; a row without one goes in by time
  before the first ordered row that is later; untimed last. Van stops are rows on their leg.
- **A cancelled booking still in a group** prints struck through (`struck: "cancelled"`, `no:
  null`) and counts in no total, so the driver can hold the new sheet against the old one.
  `PATCH /operations/trip-ops/{trip_id}` with `{van_parts: null}` takes it off (legacy "ล้างออก");
  that is the one dispatch change a cancelled booking still takes.
- **Job list order** (legacy §vjOrder): the programme's first departure, its name, the zone, the
  group's `display_order` then number (return-only jobs last), the van's name.
- **`pax`** is the outbound load (customers plus guides riding along), else the return's;
  `over_capacity` compares it with the van's seats.
- **The driver** is the day's override (`PUT /operations/van-days`), else the van's own; `override`
  says one is set.
- **Sent to the driver** (computed): `PUT …/sent` stamps the time and the login, with a fingerprint
  of the sheet; a `sent_at` in the body is `400`. Ticking again re-sends. **`changed_since_sent`**
  is `true` when what the driver acts on has changed since (rows, counts, times, places, special
  requests, stops, van, driver); undo the change and it reads `false` again. Legacy kept the tick
  and showed nothing; the flag is new. A mark imported from legacy has no fingerprint: `null`.
  The mark is on the group: it survives a renumbering or a second round, and goes when the group
  is disbanded.
- **The special request** is the booking's `job_note` when set, else its `notes`. `job_note` is a
  booking field (`PATCH /v1/bookings/{id}`, with `version` when logged in): text, `""` to print
  nothing (legacy's blanked override), `null` back to the notes. Every booking read carries the
  result as **`special_request`** (computed; `null` = none), so van check-in and the pier print
  the same.
- **Thai pickup names** (`pickup_name_th`): typed once per place and printed under it on every
  sheet (`pickup_th`). The place is matched trimmed and lower-cased, so "Book a Bed Poshtel" and
  "Book A Bed Poshtel" share one. `name` is required (`400`). `zone_th` comes from legacy's fixed
  list of area names.
- **Warnings**: `unassigned` (passengers with no van yet, by route), `return_unarranged` (a
  separate drop-off with no return van and not `return_same_van`), `self_arrive` (a `pickup_self`
  booking still in a van group or a transfer zone), and per sheet `unassigned_on_route` (bookings
  on its route with no van, not on the sheet: it may be missing someone).
- **The import** brings legacy's 449 marks as 438 (on the van's one group that day, or its
  return-only run; a van that now runs the route twice, or a van the import left off its group,
  keeps none), the 10 special requests (5 blanked), the 762 Thai names as 760 (two pairs differ only
  in case), and the group order of 13 days (63 groups).

### Love Kingdom's push: held orders and B2C issues

Love Kingdom books here itself (`docs/love-kingdom-integration.md`); legacy's pull is not ported
(`todo/b2c-sync-model.md`). Legacy stored whatever it pulled and listed what looked wrong. Here what
can be stored is stored and checked; what cannot is **held**, never lost.

**Held orders.** When Love Kingdom's login (a login whose `agent_id` is `a_b2c`) sends
`POST /v1/bookings`, `PATCH /v1/bookings/{id}` or `POST /v1/bookings/{id}/cancel` and it is refused
as bad input (`400`: unknown route, no date, no passengers, a bad pax key, an unknown pickup area,
FOC without a reason…), nothing changes in the bookings, and:

- the body is kept as it was sent, with the refusal's message as `problem` (`b2c_held_orders`,
  migration 100);
- the answer is `202`, holding **no seats**:

```json
{ "code": "held_for_review", "message": "Not booked: Unknown route: r99. Held for ops to review as held_6f1c…",
  "held_order": { "id": "held_6f1c…", "action": "create", "external_id": "LOV-4190737", "booking_id": null,
    "problem": "Unknown route: r99", "status": "open", "attempts": 1, "received_at": "…", "last_received_at": "…",
    "received_by": "lovekingdom", "decided_at": null, "decided_by": null, "note": null, "resolved_booking_id": null,
    "request": { "…": "the body as sent" } } }
```

- Only a `400`, and only that login. `403`, `404`, `409` (sold out, `route_closed`,
  `duplicate_external_id`, `stale_version`, `booking_closed`) and `428` answer as before: they are
  not bad data. Staff, legacy's client and a caller with authentication off still get the `400`. A
  body that is not JSON at all is refused before it reaches the handler, and is not held.
- `action` is `create`, `amend` or `cancel`; an amend or cancel carries the `booking_id` it was for
  and that booking's `external_id`.
- **A retry is the same order:** a create with the `external_id` of an open held create replaces its
  request and problem and counts `attempts` up.
- **Fixed and resent:** when Love Kingdom's login then books that `external_id` (`201`), the open held
  create is resolved by itself: `resolved_booking_id` is the booking, `note` `Booked as …`.

| Method + path | What |
|---|---|
| `GET /v1/b2c/held-orders?status=open` | `{ held_orders }`, newest first. `status` `open` (default), `resolved`, `dismissed` or `all` |
| `GET /v1/b2c/held-orders/{id}` | one; `404` |
| `POST /v1/b2c/held-orders/{id}/resolve` | `{ booking_id?, note? }`: handled (booked by hand, or resent) |
| `POST /v1/b2c/held-orders/{id}/dismiss` | `{ note? }`: nothing to do (a test, a duplicate) |

Resolving and dismissing need the `operations` area; Love Kingdom's login cannot. Only an `open`
order can be decided: another answers `409 wrong_status` (`Held order … is already resolved`).
`booking_id` must be a booking (`400`), and goes with `resolve` only. `status`, `decided_by` and
`decided_at` are the server's: a body that sends them is ignored. No `version`: the only change is
`open` to closed, and a second click is already a `409`.

**B2C issues.** What is wrong in a B2C booking that *was* stored, as legacy's post-import checks
found it (`b2cCheckOrders`). Computed from the booking each time, never stored, so a booking ops
correct drops off by itself. The messages are legacy's, in Thai.

| `code` | `severity` | When |
|---|---|---|
| `nat_unread` | `warn` | the lead's or a passenger's nationality is not a two-letter code (`TH`, `GB`) |
| `nat_mix` | `warn` | a seat trip has Thai-priced seats (`*_th`) and more known foreigners aboard (passengers whose nationality is a code other than `TH`; with no list, the lead) than its other seats. The park page would buy them Thai tickets |
| `money_parts` | `warn` | a price part was sent (`priceBreakdown` / `price_seat`…`price_extra`) and the parts differ from `total` by more than ฿1 |
| `pickup_area` | `info` | a pickup or hotel text, no `pickup_area_id`, and not `pickup_self` |

A cancelled, rejected or weather-cancelled booking has none. Love Kingdom's login gets
`issues: [{ code, severity, message }]` on its create and amend answers (`[]` when nothing is wrong);
nobody else's answer changes.

**The panel: `GET /v1/b2c/issues`**, legacy's orange "ใบ B2C ที่ต้องเช็ค" panel, for any login:

```json
{ "held_orders": [ "…every open held order…" ],
  "issues": [ { "booking_id": "…", "external_id": "LOV-4190737", "service_date": "2030-01-04", "lead_pax": "Jane Doe",
                "code": "nat_unread", "severity": "warn", "message": "อ่านสัญชาติผู้จองไม่ออก: \"Slovak\"" } ],
  "counts": { "held": 1, "warn": 1, "info": 0 }, "signature": "3f2a9c1b0d4e" }
```

- It checks the bookings of agent `a_b2c` that still hold or wait for seats and have a trip from
  today (Thailand) on, ordered by date.
- `signature` is legacy's `issueSig`: 12 hex characters that change when a held order or a `warn`
  line comes or goes (not an `info` line, not a reworded message). Legacy's panel stays dismissed
  until it changes, kept in `localStorage`; dismissing is the client's, as in legacy.

**Legacy's own B2C bookings** come through the import until Love Kingdom's push takes over, which
`import-legacy.ts --b2c=all|pushed|none` sets (see [Importing legacy's B2C
bookings](#importing-legacys-b2c-bookings)).

#### Importing legacy's B2C bookings

Legacy keeps each line of a Love Kingdom order as `b2c_<order>_<line>`. Once Love Kingdom pushes the
same order here (`external_id` = `<order>`), a copy from legacy would hold the same seats twice. The
import's `--b2c` says how far that has gone:

| `--b2c=` | Legacy's B2C bookings |
|---|---|
| `all` (default) | imported, as before |
| `pushed` | skipped when a booking here (not `lg_`) has the order's `external_id`; the others are imported |
| `none` | all skipped: Love Kingdom's push is the only source |

The test orders `b2c_BK-…` are never imported. Skipped bookings are counted in the report's notes.
Each run deletes every `lg_` booking first, so switching mode also removes the copies earlier runs
made. Switching too early loses orders only legacy has; too late counts pushed orders twice. Use
`pushed` from the day Love Kingdom's push goes live, and `none` once it has pushed its open orders
(rehearsed 2026-10-09 on a copy: `all` 5,351 bookings, 543 of them B2C; `pushed` with two orders
pushed 5,344; `none` 4,808).

### Live updates (the change feed)

How a screen learns that someone else changed something, without reloading everything. Every write
records **which** records it changed, in a numbered list (`changes`, migration 044). A client keeps
the last number it saw and refetches only the records named.

| Method + path | Answers |
|---|---|
| `GET /v1/changes` | `{ version, health }`: the starting point |
| `GET /v1/changes?since=N[&limit=500]` | `{ version, changes: [Change], health }`, oldest first (`limit` up to 1,000) |
| `GET /v1/changes/stream[?since=N]` | Server-sent events (see below) |

```jsonc
// Change
{ "version": 4521, "kind": "booking", "entity_id": "BK-…", "action": "updated",
  "route_days": [ { "route_id": "r1", "service_date": "2026-10-02" }, { "route_id": "r1", "service_date": "2026-10-03" } ],
  "changed_by": "ops1", "changed_at": "2026-10-01T09:12:44.000Z" }
```

- **Kinds:**
  - `booking`: any write to it: an edit, a command, dispatch, check-in, van parts and groups,
    reconfirm, upgrades, its document check;
  - `seat_lock`: any write to it, every departure a bulk-lock write touches, and each lock a
    booking write draws on or returns seats to;
  - `deployment`, with `entity_id` `<date>:<boat>`: by its own endpoints, or a whole-boat hold that
    placed its boat on a route or took it to another (a hold's `convert` adds its new `booking`);
  - `route`: created, edited, deleted, reordered, or its calendar;
  - `invoice`: issued, changed, voided, or a payment recorded or corrected. Its bookings are in the
    feed as well, since their `invoice` and `payment_state` changed. A weather cancel's lines taken
    off, refund or credit count as a change;
  - `b2c_held_order`: Love Kingdom's write held for review, retried, resolved or dismissed (see
    [Love Kingdom's push](#love-kingdoms-push-held-orders-and-b2c-issues)). `route_days` is `null`;
  - `weather_closure`: closed, its note, a notify, undo, or a booking command that resolved one of
    its follow-ups (`route_days` is its trip);
  - `boat`: created or edited, its status timeline, retire and restore, and a day's seats. Its
    `route_days` are the days whose seats moved: the deployments a capacity change rewrote, and the
    day of a day's seats (when the boat is deployed); `null` when none did;
  - `pier_cash`: a pier's petty cash day, `entity_id` `<pier>:<date>` (a row added or deleted, a
    pull, a sheet cell), or `settings`; `pier_office`: an office list, `entity_id` its name
    (`staff`, `sections`, …). See [Pier office](#pier-office-petty-cash). `route_days` is `null`.

  `action` is `created`, `updated` or `deleted`.
- **`route_days`** are the days whose seats the write touched, before *and* after: a moved booking
  names the day it left and the day it went to. An availability grid refetches only those cells.
  `null` for a route calendar (refetch it).
- **Recorded with the write:** a write that fails leaves no change, and one that commits always has
  one. Changes are numbered as they commit, so a client reading up to N never misses an earlier one.
  They are kept forever (no `410`).
- **The stream:**
  - It starts after `Last-Event-ID` (a reconnecting client sends it), else `?since=`, else now. It
    sends anything missed, then each change as it commits:
    `id: 4521`, `event: change`, `data: {Change}`.
  - A heartbeat `event: hb` with `data: {version, health}` comes every 25 s; `retry: 5000`.
  - Send the Bearer header: use a fetch-based reader, as the browser's `EventSource` can't send
    one. Any login may read; the Love Kingdom API key can't.
  - It works with any number of server instances (PostgreSQL `LISTEN`/`NOTIFY`).
- **`health`** carries what bumps no version, as legacy's `/api/version` did: today
  `migrations_pending`.
- **Not in the feed yet:** vans, van stops, pickup areas, attachments, users, agents, rate types and route families.
  The legacy import writes no changes either: reload after an import.

### Agent seat locks

Legacy's Seat Locks tab, as an API (`todo/seat-lock-extras-model.md`, decided 2026-10-09). A lock is
one route, one day and `pax` seats kept off general sale for a holder. On top of that: **bulk locks**
(a date range, one lock per departure), **sub-groups** (named slices of a lock, legacy "A / B / C"),
**pending seats** (asked for but not free yet), an **expiry**, a **reason**, released seats kept apart
from what was asked, and a **log** the server writes. Every write needs the `operations` edit area.

Nothing runs on a timer: what a lock holds, may give, has pending, and whether it is expired or
overdue are worked out on every read (`src/domain/seat-locks.ts`), the same in both stores.

#### A lock

| Field | Who decides | Meaning |
|---|---|---|
| `id`, `version`, `created_at`, `created_by`, `updated_at`, `released_at` | server | `created_by` is the login |
| `route_id`, `service_date` | client, checked | The route must run that day (`409 route_closed`). Frozen once a seat is drawn (`409 lock_drawn`). |
| `pax` | client, checked | Seats **asked for**. A release never lowers it (see `released_pax`). Weighed against free seats (see "Pending seats"). |
| `holder_type` | client, checked | `agent`, `office` or `global`. Absent: `agent` when `agent_id` is sent, else `office`. |
| `agent_id` | client, checked | Required for `agent`, refused for the others (`400`); must be an agent (`400`, `GET /v1/agents`). |
| `reason` | client | Free text, up to 500 characters (legacy's "Love Boom", "Fam Trip 11 + 1 guide"). |
| `expiry` | client | A date. Past it (Asia/Bangkok) the lock stops holding; a lock expiring today holds all day. |
| `status` | server | `active` or `released` (a whole-boat hold also `converted`), moved only by the commands below. |
| `pending_pax` | server | Of `pax`, seats waiting for room: they hold nothing and cannot be drawn. |
| `released_pax` | server | Of `pax`, seats given back by a release. |
| `group_id` | server | The bulk lock this is one departure of. |
| `parent_id`, `sub_name` | server / client | Set on a sub-group: the lock it is carved from, and its name. |
| `boat_id` | client, checked | A whole-boat hold (below). `null` on an ordinary lock, which can't become one. |
| `boat_deal` | client | A hold's `fixed` (this boat) or `any` (any boat that seats `pax`). `null` on an ordinary lock. |
| `converted_booking_id` | server | The charter booking a hold became (`convert`). |
| `drawn_pax` | server | Seats bookings that hold seats have drawn from it. |
| `remaining_pax` | server | What a booking may draw from it now. A parent's are its seats in no sub-group. |
| `held_pax` | server | What it keeps off general sale now. A sub-group `0` (its parent holds); a whole-boat hold `null`. |
| `allocated_pax`, `sub_group_room` | server | A top-level lock: seats split into sub-groups, and seats a new sub-group may still take. |
| `holding` | server | Active, not past `expiry`, and for a sub-group its parent holding. |
| `state` | server | Legacy's label: `active`, `depleted` (nothing left, something drawn), `expired`, `released`, `converted`. |
| `release_at`, `overdue` | server | A bulk departure's release cutoff as an instant, and whether it has passed while the lock still holds. A whole-boat hold is `overdue` past its expiry. |

A lock with no sub-groups and nothing pending holds `pax − released_pax − drawn_pax`, and that is
what a new draw may take. A screen that shows legacy's single "seats" number shows
`pax − released_pax` (legacy lowered `qty` on every release), and sends `pax` = that number +
`released_pax` when it edits it.

#### Endpoints

- `GET /v1/seat-locks` — every lock; filter by `route_id`, `service_date` (or `date`), `from`/`to`,
  `group_id`, `parent_id`, `agent_id`, `kind` (`boat`: whole-boat holds only; `seats`: the rest).
  Oldest first. `400` for a bad date or kind.
- `GET /v1/seat-locks/{id}`; `GET /v1/seat-locks/{id}/log` → `{ events: [...] }`, oldest first. `404` if unknown.
- `POST /v1/seat-locks` — `{ route_id, service_date, pax, holder_type?, agent_id?, reason?, expiry?, pending? }` → `201`.
  With `boat_id` it makes a whole-boat hold instead (below).
- `PATCH /v1/seat-locks/{id}` — client facts only: `pax`, `holder_type`, `agent_id`, `reason`,
  `expiry`, `route_id`, `service_date` (moves it, with its sub-groups), a sub-group's `sub_name`, and
  `pending: "split"` when a raise or a move is short. A server-owned field (`status`, `pending_pax`,
  `released_pax`, `group_id`, `parent_id`, `boat_id`, the numbers) with a **different** value is
  `400 server_owned`, naming the command that sets it; echoed unchanged it is ignored, as a booking's.
  `pax` cannot go below `released_pax` + drawn + split into sub-groups (`409 below_floor`). A
  whole-boat hold's `PATCH` is its own form (below).
- `POST /v1/seat-locks/{id}/convert`, `GET /v1/seat-locks/boat-options` — whole-boat holds (below).
- `POST /v1/seat-locks/{id}/add` — `{ pax, note?, pending? }`: legacy "+ seats". A released lock is
  active again. A sub-group grows only into its parent's room (`409 no_room`).
- `POST /v1/seat-locks/{id}/release` — `{ pax? }`: legacy Release. That many undrawn seats back
  (absent: all that can be); pending seats go first. A parent releases only its seats in no
  sub-group; a sub-group's go back to its parent, not to the pool. With nothing left the lock is
  `released`. More than can be released is `409 below_floor`. Idempotent.
- `POST /v1/seat-locks/{id}/release-departure` — legacy "ปล่อย n ที่" on an overdue departure:
  everything the lock holds that day, sub-groups and pending seats included, back to the pool now.
  `400` on a sub-group. Idempotent.
- `POST /v1/seat-locks/release-overdue` — `{ service_date, route_id? }`: every overdue lock of that
  day still holding seats, released as above → `{ service_date, route_id, released: [locks], seats }`.
- `POST /v1/seat-locks/{id}/confirm-pending` — `{ pax? }`: pending seats become held ones, as far as
  seats are free now. `409 no_free_seats` ("No free seats on this trip yet - the lock stays
  pending"), `409 nothing_pending`, `409 not_holding`; `400` on a sub-group (its pending seats are its
  parent's).
- `POST /v1/seat-locks/{id}/sub-groups` — `{ sub_name, pax, reason? }` → `201` with the sub-group.

A lock carries a `version` and an `ETag` as a booking does; every write to one lock (`PATCH` and
the commands, `sub-groups` included) needs `If-Match` (or `version`) from a login (`428
version_required` without), and answers `409 stale_version` when the lock has moved on. Creating a
sub-group raises its parent's version.

#### Pending seats (legacy §lkPend)

Create, a `pax` raise, a move and `add` compare what the lock still needs (`pax − released − drawn`)
with the seats free that day (available, plus what the lock already holds). A day sold ungated (a
land route, a marine day with no boat yet) never falls short, and neither does a day already past.
When short, and no choice is sent, the answer is legacy's "ที่นั่งว่างไม่พอ" dialog:

```json
{ "statusCode": 409, "code": "seats_short", "error": "Conflict",
  "message": "Not enough free seats on r1 2061-01-06: 3 free of 5 asked. Send pending: \"split\" to lock what is free and keep the rest pending, or \"all\" to keep it all pending",
  "short": [{ "service_date": "2061-01-06", "free": 3, "want": 5, "short": 2 }] }
```

Send the same request again with `pending: "split"` (lock what is free, the rest pending) or
`pending: "all"` (the short days entirely pending; a new lock only, `400` otherwise). An edit asks
only when the shortfall is more than what is already pending. Lowering `pax` or releasing takes
pending seats off first. Nothing confirms pending seats by itself: `confirm-pending` does.

#### Sub-groups

A sub-group is a named slice of a lock's seats, usually a salesperson or a LINE contact of the
agent. One level only (`400` for a sub-group of a sub-group). It lives on its parent's route, day,
holder and expiry (changing those on it is `400`), and has its own `reason`.

- Only the parent holds seats in the pool: `pax − released − drawn from it and from every sub-group −
  pending`. Sub-groups divide that hold, they do not add to it.
- A booking draws from a sub-group's own seats, or from the parent's seats in no sub-group, never
  past what the parent holds. A new or bigger sub-group must fit the parent's `sub_group_room`
  (`409 no_room`: "Only n seats are left to put in a sub-group").
- While the parent has pending seats, what it holds goes to its sub-groups in creation order, then
  to its unsplit seats; a sub-group not reached shows `pending_pax` itself (legacy §lkPendSub).

#### Bulk locks

A bulk lock holds the same seats on every departure in a date range: a group plus one ordinary lock
per day in the range, on the weekdays chosen, that the route runs. Each departure is a lock with
`group_id`; draw on it, release it or confirm its pending seats through `/v1/seat-locks`. Its holder
and expiry are the group's (a departure has none; `400` if sent), and it cannot move.

- `GET /v1/seat-lock-groups` — `?route_id&agent_id` → `{ seat_lock_groups: [...] }`, each with
  `departures`, `departures_past`, `state` (`active`, `expired` once `date_to` is past, `released`
  when every departure is) and the sums `held_pax`, `drawn_pax`, `pending_pax`.
- `GET /v1/seat-lock-groups/{id}` — the group with `seat_locks`: every departure and its sub-groups,
  by date. `GET /v1/seat-lock-groups/{id}/log` — the group's own lines and every departure's.
- `POST /v1/seat-lock-groups` — `{ route_id, date_from, date_to, weekdays?, pax, holder_type?,
  agent_id?, reason?, release_days_before?, release_time?, pending? }` → `201`. `weekdays` (or `dow`)
  is 0 = Sunday … 6 = Saturday, empty for every day. `date_to` is required ("Pick the last day of the
  range"), not before `date_from`, at most 800 days on. A range with no departure is `400
  no_departure` ("This lock covers no departure at all - check the date range and the weekdays you
  ticked"). Short days answer `409 seats_short` listing every one.
- `PATCH /v1/seat-lock-groups/{id}` — `{ pax?, holder_type?, agent_id?, reason?, release_days_before?,
  release_time?, pending? }`: `pax` for every departure not released, as a lock's edit; the holder
  only while nothing is drawn (`409 lock_drawn`). `date_from`, `date_to`, `weekdays` and `route_id`
  cannot change here (`400 server_owned`): release it and make a new one.
- `POST /v1/seat-lock-groups/{id}/add` `{ pax, note?, pending? }`, `/release` `{ pax? }` (the same
  seats off every departure, at most what the busiest one can give), `/sub-groups` `{ sub_name, pax,
  reason? }` (on every departure from today on that still holds; all or none, `409 no_room` naming
  the days). Each answers the group with its `seat_locks`.

Group writes need the group's `version` from a login, as a lock's do.

**The release cutoff is a warning only** (legacy §lkNoAuto, 2026-09-29). `release_days_before` +
`release_time` (`HH:MM`, Asia/Bangkok; both or neither) on a 5 March departure with `{ 1, "18:00" }`
make its `release_at` 4 March 18:00. Past it the departure reads `overdue: true` and **still holds
its seats** until staff release it (`release-departure`, or `release-overdue` for the whole day).

#### Expiry

A day lock past its `expiry` (Asia/Bangkok day, legacy's `expiry < today`) stops holding: it reads
`holding: false`, `state: "expired"`, holds nothing in availability and takes no draws (`400`).
`status` stays `active`: nothing is rewritten, so no job has to run at midnight. Draws already made
stay with their bookings. A whole-boat hold ignores its expiry (it reads `overdue` instead).

#### Holders and draws

An `agent` lock serves that agent's bookings only: a draw on it from a booking of another agent, or
of none, is `400 lock_other_agent` ("Seat lock … holds seats for agent a10, not a07"). `office`
and `global` locks serve any booking (legacy `bkV2LocksForAgent`).

#### The log

`GET /v1/seat-locks/{id}/log` and `GET /v1/seat-lock-groups/{id}/log` →
`{ events: [{ id, lock_id, group_id, type, qty, trip_date, booking_id, note, day, at, by, imported }] }`.
The server writes a line, in the same transaction, for `create`, `add`, `edit` (`pax: 4 → 6 ·
reason: — → Love Boom`, legacy's form), `release`, `release-round`, `pend` (`free 0 of 2`),
`pend-confirm`, `convert` (a whole-boat hold, with its `booking_id`; a hold's `edit` reads legacy's
`route: r3 → r5 · boat: Oceanus → Verona · min: … · deal: … · holder: agent:a7 → … · note: …`), and
from booking writes `draw`, `return` (with the command as its note: `edit`,
`cancel`, …) and `resched-return`. Legacy's lines are imported with `imported: true`; many of them
(`release`, `expire`) have no `at` or `by`, and none is made up.

#### Whole-boat holds

Legacy's Hold-whole-boat form (§bkLock; migrations 047 and 180). A lock with a `boat_id` holds a
whole boat on one route and day for a holder who has not confirmed numbers, until it is released or
turned into a charter booking. `pax` is the **minimum seats promised**, not seats held; `boat_deal`
is `fixed` (this boat was promised) or `any` (any boat that seats `pax`).

- **It takes its boat exactly as a charter does:** the boat's sellable and licensed seats leave the
  pool, whatever number was promised; the boat reads `chartered` in `/v1/availability`; a seat
  booking can't be put on it (`409 boat_chartered`), nor another charter; Boat Operation can't remove
  it or move it to another route (`409 boat_held`: "Cannot unassign - this boat is held whole for an
  agent. Release the hold on the Seat Locks page first."). It holds nothing more (`held_pax: null`),
  and nothing draws from it. (A hold the import brought in on a boat not deployed that day holds its
  `pax` as a plain lock.)
- **It never expires by itself:** past its `expiry` it still holds and reads `overdue: true` (legacy
  §lkNoAuto); release it by hand.
- `add` and `sub-groups` don't apply to a hold (`400 boat_hold`); it has no pending seats to
  confirm; `release-departure` releases it as `release` does.

**Make one:** `POST /v1/seat-locks` →`201` the hold.

```json
{ "route_id": "r3", "service_date": "2026-10-15", "boat_id": "b8", "pax": 38, "boat_deal": "fixed",
  "agent_id": "amrg7d9d50aycj", "expiry": "2026-10-14", "reason": "Fam Trip Georgia" }
```

Refused, in legacy's words:

| Answer | When |
|---|---|
| `400` "Expiry date is required for a whole-boat hold" | no `expiry` |
| `400` "Expiry must be on or before the travel date" | `expiry` after `service_date` |
| `400` "Enter the minimum seats promised" | `pax` missing or not above 0 |
| `400 land_route` "A land programme has no boat to hold" | a land route |
| `400` | an unknown route, boat or agent; `boat_deal` other than `fixed`/`any`; `pending` |
| `409 route_closed` | the route does not run that day |
| `409 boat_retired`, `409 boat_other_pier`, `409 boat_not_ready` | a retired boat, a boat at another pier than the route's, a boat not ready that day (`GET /v1/fleet/availability`). Legacy's list does not offer them, so there is no "anyway". |
| `409 boat_other_route` "That boat is already placed on {route} for {date}. A boat placed on another programme cannot be held here. Move it in Boat Operation first, or pick another boat." | the boat is deployed on another route that day |
| `409 boat_taken` | a charter booking or another hold has the boat that day (any route); bookings holding seats have passengers placed on it; or it is on this route and the day has sold more seats than its other boats seat |
| `409 boat_too_small` "That boat has fewer seats than the minimum promised" | an `any` hold on a boat that seats fewer than `pax` |

`boat_other_route` and `boat_taken` carry what stands in the way, legacy's blocker table included:

```json
{ "statusCode": 409, "code": "boat_taken", "error": "Conflict",
  "message": "That boat is not free on 2026-10-15: 1 booking(s) (6 pax) are on it. Move them to another boat first",
  "blockers": { "charter_booking_id": null, "hold_id": null, "placed_route_id": "r3",
    "bookings": [{ "booking_id": "booking_…", "voucher_ref": "BH-V1", "agent_id": "a7", "route_id": "r3", "pax": 6, "from_lock": 0 }],
    "pax": 6, "sold": 30, "short": 0 } }
```

When the boat is not deployed that day, making the hold **deploys it on the route** (the boat
catalogue's capacity and licence), as legacy writes the boat-board cell; the change feed announces
that deployment too. Releasing or moving the hold leaves the deployment as a normal boat.

**The boat list:** `GET /v1/seat-locks/boat-options?route_id=&service_date=[&lock_id=]` → legacy's
list in the form (`bkV2BoatLockPickList`): every boat of the route's pier (another pier's are not
listed), biggest free one first, each `{ boat_id, name, capacity, pier, own, ok, why, placed_route_id,
blockers }`; `why` is `{ code, message }` (the codes above) or `null`. `lock_id` names the hold being
edited: its own boat is listed first and always `ok`.

**Edit:** `PATCH /v1/seat-locks/{id}` (with `If-Match`) takes `route_id`, `service_date`, `boat_id`,
`pax`, `boat_deal`, `holder_type`, `agent_id`, `expiry`, `reason` — legacy's one form. The same `400`s
as making one; a new route, date or boat is checked like a new hold, its own boat left out. Changing
the boat of a `fixed` hold is `409 fixed_boat` ("This hold names a specific boat for {holder}. {old}
-> {new}. The agent may already be selling that boat name. Tell them first…") until it is sent again
with `change_boat_anyway: true`. A hold that moves to another route takes its boat's deployment along.
A released or converted hold can't be edited (`409 hold_not_active`, `409 hold_converted`). Nothing
changed: nothing is written. `status`, `converted_booking_id` and the numbers are `400 server_owned`;
on an ordinary lock `boat_id` and `boat_deal` are too.

**Release:** `POST /v1/seat-locks/{id}/release` (with `If-Match`, no `pax`: `400 boat_hold`) frees
the boat at once (log `release`, note `manual · {boat}`). A converted hold is `409 hold_converted`;
a released one is answered as it is.

**Convert into a charter:** `POST /v1/seat-locks/{id}/convert` (with the hold's `If-Match`) takes the
body of `POST /v1/bookings`; what it leaves out is filled from the hold, as legacy's prefilled form:
`agent_id` (an agent hold), and on `trips[0]` (or the flat form) `route_id`, `service_date`,
`booking_mode: "charter"` and `charter_boat_id`. In one transaction the booking is created (priced,
checked and weighed as any create, with the hold left out, so the boat is free to it alone) and the
hold becomes `converted` with `converted_booking_id` (log `convert`, note `เหมาลำ {boat}`).

```json
// POST /v1/seat-locks/lock_…/convert   If-Match: "1"
{ "trips": [{ "pax": { "ad": 40 } }], "lead_pax": "Mikhail" }
// 201
{ "booking": { "id": "booking_…", "agent_id": "a77", "status": "confirmed",
    "trips": [{ "route_id": "r7", "service_date": "2026-12-18", "booking_mode": "charter", "charter_boat_id": "b13", … }], … },
  "seat_lock": { "id": "lock_…", "status": "converted", "state": "converted", "converted_booking_id": "booking_…", … } }
```

A booking with no charter of the held boat on the hold's route and date is `400 hold_mismatch`, a
quote `400 hold_quote`; any refusal of the booking (`400`, `409`) leaves the hold as it was. Only a
hold converts (`400 not_a_hold`); a converted one again is `409 hold_converted`. The booking's agent
may differ from the holder's (legacy's form could be changed).

### Fleet maintenance: stock, memos, projects, Daily Fleet Log, safety

Legacy's Fleet pages, part B (todo/fleet-maintenance-model.md, "Design — part B", migrations
140–143): stock in three warehouses, consumables, purchase memos, projects, the Daily Fleet Log and
safety equipment. Writes need the `fleet` area; the Daily Log's water meters, issued and extra
items, outside requests and the issue-item list also take `operations`, as legacy does. Any login
reads. Boats, engines, incidents and maintenance jobs are part A's: a job or an engine is named here
by its id as plain text (`job_id`, `engine_id`).

**Warehouses.** `GET /v1/fleet/warehouses` → `tublamu` (คลัง Tub Lamu), `panwa` (คลัง Visit Panwa),
`ranong` (คลัง Ranong). A request may name one by key or by legacy's label.

**Stock items.** A quantity is never a stored number: it is the sum of the item's **movements**,
which are append-only (a database trigger refuses to change or delete one). Undoing anything
appends the opposite movement.

| Method + path | Body | Rule |
|---|---|---|
| `GET /v1/fleet/stock-items` | `?q=&category=&warehouse=&low=true&deleted=true` | live items; each with `stocks[{warehouse, warehouse_name, qty}]`, `total_qty`, `primary_warehouse` (most stock), `below_min` (`total_qty <= min_qty`, legacy) |
| `GET /v1/fleet/stock-items/{id}` | — | the item and its `movements` (those of items merged into it too) |
| `POST /v1/fleet/stock-items` | `{name, part_no?, category?, supplier?, unit?, min_qty?, cost?, note?, qty?, warehouse?}` | `201`. An opening `qty` needs `warehouse` and is a `register` movement. `409 stock_item_exists` (same name and part number), `409 part_no_required` (a name already used, with no part number) |
| `PATCH /v1/fleet/stock-items/{id}` | the client facts above | an `edit` movement lists what changed. A new `part_no` needs `part_no_anyway: true` (legacy's confirm), else `409 part_no_change`. `qty`, `stocks`, `total_qty`, `location` are `400` naming the command |
| `POST …/{id}/receive` | `{warehouse, qty > 0, date?, note?}` | stock in |
| `POST …/{id}/transfer` | `{from, to, qty > 0, date?, note?}` | `400` same warehouse; `409 stock_short` beyond what `from` holds |
| `POST …/{id}/adjust` | `{warehouse, qty, note?, date?}` | `qty` is the count (0 or more); the movement is the difference. A hand count is always this |
| `POST …/{id}/merge` | `{from_ids}` | duplicates (same name and part number) fold in: their stock moves over, blank `part_no`/`cost`/`supplier` filled, memo lines repointed, the duplicates marked `merged_into` |
| `DELETE …/{id}` | — | `204`; the item is marked deleted, its history stays. `409 stock_not_empty` while it holds stock |
| `GET /v1/fleet/suppliers` | — | names from memos and items, for suggestions |

A movement: `{id, seq, item_id, date, type, warehouse, delta, note, by, memo_id, job_id,
consumable_id, changes, created_at, created_by}`. Types: legacy's `register`, `receive`, `withdraw`,
`transfer-out`, `transfer-in`, `edit`, `merge`, `adjust`, `adjust_out`, `in`, and `return` (a voided
draw or a job part put back), `reverse` (a cancelled memo's receipt), `import`. `409 stock_short`
carries `short: [{item_id, warehouse, have, asked}]`.

**A job's parts from stock** (legacy `flMaintAddPart`, `flMaintRemovePart`):

| Method + path | Body | Rule |
|---|---|---|
| `POST /v1/fleet/jobs/{id}/parts` | `{item_id, warehouse, qty?, late_anyway?, date?}` | `201 {job, item}`. A `withdraw` movement with the job's id; the job gets the part (`name`, `unit`, the item's `cost`, `location` as the warehouse's label), added to one taken the same day from the same warehouse. Beyond the warehouse's stock is `409 stock_short` (a job part never goes below zero). On a closed job it is a late edit: `409 job_closed` unless `late_anyway: true`, and the part is marked `late` |
| `DELETE /v1/fleet/jobs/{id}/parts/{idx}` | `?late_anyway=true` on a closed job | `{job, item}`. The part goes back to the warehouse it came from (a `return` movement); a part with no stock item only comes off |

Both write legacy's progress line. Refetch `GET /v1/fleet/jobs/{id}` for the job's cost.

**Consumables** (legacy "เบิกของใช้/น้ำมัน"): `POST /v1/fleet/consumables` `{item_id, warehouse, qty,
boat_id, engine_id?, engine_label?, date?, by?, note?, allow_negative?}` → `201`. `qty` whole, at
least 1; a boat is required. More than the warehouse holds is `409 stock_short` unless
`allow_negative: true` (legacy's confirm): a consumable may go below zero, a job part may not.
`item_name`, `unit_cost` (the item's cost now) and `cost` are computed. `GET
/v1/fleet/consumables?month=YYYY-MM&boat_id=&voided=true` → `{consumables, total_cost}`. `DELETE
/v1/fleet/consumables/{id}` voids a draw: the stock comes back with a `return` movement and the
record stays (`voided_at`, `voided_by`); legacy erased it.

**Purchase memos.** `GET /v1/fleet/memos?status=&boat_id=&job_id=&project_id=&q=&from=&to=`,
`GET /v1/fleet/memos/{id}` (with `history`, `receipts`, `default_warehouse`). The number `no` is the
client's, as legacy numbers in the browser; a number already used is `409 memo_no_taken`. Legacy's
`MO-077` and `MO-117` exist twice and read `duplicate_no: true`.

| Command | From | Body | Result |
|---|---|---|---|
| `POST /v1/fleet/memos` | — | `{no, title, memo_type (parts/labor/mixed), scope (vessel/general), general_category, boat_id, job_id, project_id, proposer, from, to, cc, ref_note, supplier, note, memo_date, vat_enabled, vat_rate, discount_pct, discount_amt, lines[{name, qty, price, discount_pct, category, part_no, unit, item_id, snapshot, auto_register}]}` | `201`, `pending_approval`. A parts line with no `item_id` links to the one live item of its name, else registers a new item (not when `auto_register: false`) |
| `PATCH /v1/fleet/memos/{id}` | not `paid` (`409 memo_paid`) | the same fields; a line keeps its `id` | totals recomputed; removing a line that received stock is `409 line_received` |
| `…/approve` | `pending_approval` | `{approved_by (typed, required), approved_date?, note?}` | `approved`; the login is kept as `approved_login` |
| `…/order` | `approved` (not labor only) | `{ordered_date?, ordered_by?}` | `ordered` |
| `…/receive` | `ordered` | `{warehouse?, date?, note?, lines: [{line_id, qty}]}` | stock in (default warehouse: the boat's pier, else Tub Lamu); all in → `received`, else stays `ordered` |
| `…/short-close` | `ordered`, part received | — | totals from what came; `ordered_amount` keeps the old amount → `received` |
| `…/pay` | `received`; `approved` for labor only | `{paid_date?, paid_by?, paid_via?}` | `paid` |
| `…/cancel` | not `paid` or `cancelled` | `{reason, allow_negative?}` | stock received comes back out (`reverse`); `409 stock_short` if it was used, unless `allow_negative: true` |

Totals are computed, never taken (legacy `memoCalcTotal`): line gross = qty × price (an empty or 0
qty counts as 1 on the form), less the line's discount %; the memo discount is round(after-line ×
`discount_pct` / 100) + `discount_amt`; VAT at `vat_rate` to the satang when `vat_enabled`. A short
close counts the received quantity (a 0-qty labor line counts 0 there, as legacy). Lines read
`left` and `price_mismatch` (price differs from the item's cost by more than ฿0.50). Every command
writes a history line; a `status`, total or approval field sent to `PATCH` is `400` naming the
command.

**Projects** (drydock, overhaul). `GET /v1/fleet/projects?status=&boat_id=`, `GET
/v1/fleet/projects/{id}` (with `log`, `memos`). `POST /v1/fleet/projects` `{no, name, boat_id (null =
General), type, vendor, plan_from, plan_to?, planned_budget?, notes?}` → `201`, `planned`; `no` is
the client's; `original_plan_to` keeps the plan end as the baseline. `PATCH` takes the same fields,
`phase` (one of the type's `phases`) and `bill_note`.

| Command | From | Body | Effect |
|---|---|---|---|
| `…/start` | planned | — | `inprogress`; the boat's status log gets `unavailable` (`dry_dock`/`overhaul`, `project_id`) |
| `…/hold` | inprogress | `{reason}` | `on_hold` |
| `…/resume` | on_hold | — | `inprogress` |
| `…/cancel` | not completed/cancelled | `{reason, unlink_jobs?}` | `cancelled`; a running project's boat entry ends and the boat is `available`. `unlink_jobs: true` (legacy's confirm) lets the open child jobs go on alone |
| `…/reopen` | cancelled | — | `planned` |
| `…/work-done` | inprogress | `{note?}` | `awaiting_bill`; the boat back to `available`; open child jobs closed (`done`, a line, no outcome: legacy's cascade) |
| `…/bill-back` | awaiting_bill | — | `inprogress`; the boat `unavailable` again |
| `…/complete` | inprogress, awaiting_bill | `{no_cost_reason?}` | `completed` when the **bill gate** passes: an invoice-like document and `cost > 0`; else `409 bill_gate` with `missing` (legacy's messages). `no_cost_reason` closes with no cost. From in progress, open child jobs are closed as above |

Plan items: `POST …/plan {text}`, `PATCH …/plan/{item_id} {done?, text?}`, `DELETE …`. Documents:
`POST …/documents {name, attachment_id? | url?, note?, type? (photo), phase?, status?}` (a file from
`POST /v1/attachments`, which `fleet` may now upload), `PATCH …/documents/{doc_id} {status?,
attachment_id?, name?, note?}` (`required`/`pending`/`received`/`verified`), `DELETE` (also deletes
the file when nothing else names it). Vendor visits: `POST …/vendor-visits {vendor, role?}`,
`DELETE …/vendor-visits/{id}`. These answer the project. Computed: `cost` (the child jobs' cost,
legacy `flProjCalcCost`: jobs whose `parent_project_id` is the project, memos included), `cost_breakdown`,
`bill_gate`, `health` (legacy's score), `phase_index`, `required_documents` still missing,
`bill_days`.

**Daily Fleet Log.** `GET /v1/fleet/daily-log?from=&to=` (at most 93 days) → `{days: [{date,
boats: [{boat_id, pier, fuel_litres, pax_actual, pax_booked, pax, litres_per_pax, meters: {normal:
{engine_id: reading}}, meter_deltas, water: {open, close, used, by, at}, issues: {item_id: qty},
extras, fuel_price: {price, src, from}, flags}], fuel_prices, locks, requests, totals: {fuel, pax,
litres_per_pax}, anomalies: [{boat_id, litres_per_pax}]}], issue_items}`. `fuel_price` is legacy's
effective price: the boat's, else its (home) pier's, else another boat's at the pier that day, else
the latest within 30 days (`src`: `boat`, `pier`, `sib`, `back`), else 0.

Computed on each boat row (legacy `flRenderDR`): `pax_booked` (bookings not cancelled, rejected or
weather-cancelled whose trip that day is dispatched on the boat, FOC and infants in; a split across
boats is not counted), `pax` (`pax_actual`, else booked), `litres_per_pax`, `meter_deltas` (each
reading less the engine's latest earlier reading above 0, on any boat; null with none) and `flags`:
`high_fuel_per_pax` (more than 20 L a passenger: the one anomaly legacy counts, also in the day's
`anomalies`), `meter_backwards`, `water_negative`, `price_missing` (fuel with neither the boat's nor its
pier's price that day). `totals.pax` counts every boat logged or booked that day.

| Method + path | Body | Area |
|---|---|---|
| `PATCH /v1/fleet/daily-log/{date}/boats/{boat_id}` | `{fuel_litres?, pax_actual?, meters?: {trip_type: {engine_id: reading or null}}}` | fleet |
| `PUT …/boats/{boat_id}/water` | `{open, close}` | fleet or operations |
| `PUT …/boats/{boat_id}/issues` | `{item_id: qty or null}` | fleet or operations |
| `POST …/boats/{boat_id}/extras`, `PUT`/`DELETE …/extras/{id}` | `{name, qty?, unit?}` | fleet or operations |
| `POST /v1/fleet/daily-log/{date}/piers/{pier}/requests`, `PUT`/`DELETE …/{id}` | `{name, pax, fuel, price, engine_hours, water_open, water_close, issues}` | fleet or operations |
| `PUT /v1/fleet/daily-log/{date}/fuel-prices` | `{pier or boat id: ฿/L or null}` | fleet |
| `POST …/{date}/piers/{pier}/lock`, `…/unlock` | — | fleet |
| `GET`/`POST /v1/fleet/issue-items`, `PATCH /v1/fleet/issue-items/{id}` | `{name, unit?, pier?, off?}` | fleet or operations |

Writes answer the day. **The day lock is enforced:** "Save day" (`lock`) locks a pier's day and
every write to it — a boat whose pier it is, a request at that pier, its price — is `409
day_locked` until "Edit" (`unlock`). A boat's pier is its pier **that day** (legacy `_drPier`): the
pier assignment covering the day, else the pier its status entry that day names, else its home `pier`;
a boat held at a shop by a started job counts at its home pier. A fuel of 0 is
no fuel (legacy); a meter that goes backwards is not refused. An issue item is turned `off`, never
deleted; adding a name that exists turns it back on. Nothing is deleted after 120 days (legacy did).

**Safety equipment.** `GET /v1/fleet/safety?boat_id=&category=`, `GET /v1/fleet/safety/{id}` (with
`log`), `GET /v1/fleet/safety-categories`. `POST /v1/fleet/safety {boat_id, category, name, brand,
model, serial, qty, install_date, expiry_date, next_pm, last_inspect, status (active/expired/replaced/
missing), location, note}` → `201`; `PATCH`; `DELETE` (`204`, a real delete as legacy's). `state` is
computed: `REPLACED`, `MISSING`, else the nearer of expiry and next PM: `EXPIRED`, `DUE` (≤ 30 days),
`SOON` (≤ 90), `OK`, `OK_NO_PM`. Inspections: `POST …/{id}/inspections {date, inspector?, result
(pass/needs_work/fail/observation), findings?, next_due?}`, `PATCH`/`DELETE …/inspections/{insp_id}`;
after each, the latest pass or needs-work sets `last_inspect` and `next_pm`.

**Report.** `GET /v1/fleet/reports/memo-spend?from=&to=` → approved, received and paid memos by
supplier, type, scope, boat and status.

**Import.** `SOURCE_DATABASE_URL=… TARGET_DATABASE_URL=… npm run import:fleet-stock [-- --commit]` (after
`seed:boats` and `import:attachments`). Dry run unless `--commit`; rerunnable while legacy is the
master. The eight warehouse spellings map to the three; where an item's history does not add up to
legacy's stock, an `import` movement makes it match; duplicates and odd rows come as they are and are
listed (`--all` lists every row).

### Fleet maintenance: assignments, certificates, replace wizard, reports

Legacy's Fleet extras (todo/fleet-maintenance-model.md, "Design — extras", migration 190). Writes on a
boat need `fleet` or `config`; the rest `fleet`. Every report is a read for any login.

**Pier assignments** (legacy `flSaveAssignment`, `flCancelAssignment`): a boat moved to another pier for
a while (`temporary`) or for good (`permanent`).

| Method + path | Body | Rule |
|---|---|---|
| `GET /v1/boats/{id}/assignments` | — | `{assignments (newest first), active, planned, past, pier_today}`; the panels leave cancelled ones out |
| `POST /v1/boats/{id}/assignments` | `{type?, from_pier, to_pier, start_date, end_date, reason?, cost?}` | `201 {assignment, boat_pier}`. `400`: the same pier at both ends, a date missing, an end before the start, a pier or type that is not one. No overlap check (legacy). A `permanent` one active today sets the boat's home `pier` |
| `POST /v1/boats/{id}/assignments/{asn_id}/cancel` | — | kept, `cancelled: true`; `409 already_cancelled`. A home pier it moved stays moved (legacy) |

An assignment: `{id, boat_id, type, from_pier, to_pier, start_date, end_date, reason, cost, status,
cancelled, cancelled_at, cancelled_by, created_date, created_at, created_by}`. `status` is computed
(`planned`, `active`, `completed`, `cancelled`); sending it is `400`. `GET /v1/boats` and
`/v1/boats/{id}` carry `pier_today` (the assignment covering today, else the pier today's status entry
names, else the home pier; legacy `getBoatCurrentPier`) and `at_shop` (the location of a started job
holding the boat, or null). Both are computed: `PATCH` refuses them. When two assignments cover one day
the older wins (legacy's list order). The Daily Fleet Log groups and locks by this pier.

**Certificates** (legacy `flDocStatus`, `flRenderDocsList`, `depSave`). The rows stay the boat's
`documents`; their state is computed on read:

| Method + path | Body | Answers |
|---|---|---|
| `GET /v1/boats/{id}/documents` | — | `{documents: [{idx, name, expires_on, renew_status, doc_type, status, days_left, current}]}` |
| `GET /v1/fleet/certificates` | — | the Documents matrix: each company boat in service × `types` (`lic`, `inspect`, `ins`, `similan`, `surin`, `pp`, `phangnga`, `tarn`), each cell the row shown for it or null; `others`; `counts {ok, warn90, warn30, exp, processing, na}`; `valid_pct`; `expired_boats`; `issues` (cells `exp` or `warn30`) |
| `POST /v1/boats/{id}/documents/renew` | `{name, state: "exp" \| "processing" \| "ok", expires_on?}` | the documents as `GET` |

`status`: `processing` (being renewed), else `na` (no expiry), else by the days left: `exp` (< 0),
`warn30` (< 30), `warn90` (< 90), `ok`. `doc_type` is read from the name (legacy `flGuessDocType`);
`current` is the row the matrix shows for its type (a processing row, else one not `done`, else the
later expiry). Renew: `exp` clears the mark on the latest row of that name; `processing` marks it (and
sets `expires_on` when sent), or adds a row; `ok` needs `expires_on`, adds the renewed row and marks the
name's processing rows `done`.

**The safety replace wizard** (legacy `swapDocExecute`): `POST /v1/fleet/safety/{id}/replace` → `201
{incident, job, memo, withdrawn_item, old_item, new_item}`.

```jsonc
{ "reason": "broken",                // broken, expired, upgrade, scheduled, lost
  "description": "motor stuck", "date": "2026-10-10",
  "source": "inventory",             // or "buy"
  "item_id": "inv_…", "warehouse": "panwa",                              // inventory
  "brand": "Rule", "model": "1100", "supplier": "Marine", "price": 2400,  // buy (brand and model default to the old item's)
  "serial": "BP-002", "install_date": "2026-10-10", "installer": "Somchai", "labour": 300,
  "incident_no": "INC-074", "job_no": "MJ-123", "memo_no": "MO-225",   // numbers are the client's
  "expiry_date": null, "allow_negative": false, "serial_anyway": false }
```

In one transaction: a `resolved` incident (priority 5/3/2 by the reason, legacy's four lines); a
`done` corrective job that leaves the boat's status alone, its parts the withdrawn item (or the
purchase at its price) and `ค่าแรง` for the labour, so its cost is legacy's; from stock, a `withdraw` of
1 with the job's id (the warehouse defaults to the boat's pier with stock, else any with stock); bought,
a new stock item (category `safety`, nothing in stock) and a `pending_approval` memo (VAT 7 %, not linked
to the job, as legacy); the old item `replaced` with a `replace` log line; a new `active` item (name,
category, qty, location copied, `expiry_date` the old one's unless sent, `next_pm` a month after
install, an initial `pass` inspection). Refused: `409 already_replaced`, `400` (no stock item picked; a
purchase with neither brand nor model; a number missing), `409 number_taken`/`memo_no_taken`, `409
no_serial` (until `serial_anyway: true`), `409 stock_short` (until `allow_negative: true`: the stock goes
below zero).

**Log lines legacy writes.** A memo on a job: on create the job gets `📋 สร้าง Memo {no} · ฿{amount}`
and its incident `📋 สร้าง Memo {no} · {title} · ฿{amount}`; an edit and a cancel write the incident
(`✏️ แก้ไข Memo …`, `🚫 ยกเลิก Memo {no} · {reason}`). A memo for a project writes the project `Memo {no}
· {title} · ฿{amount} (Project overhead)`. A job made under a project writes it `+ Created MJ {no} ·
{title}` (and the job `+ Created under project {project no}`); a split `+ Split {no} → {nos}`; a `PATCH`
of `parent_project_id` links or unlinks with a line on each side. A `parent_project_id` that is not a
project is `400`.

**Fuel budget.** `GET /v1/fleet/fuel-budgets` → `{budgets: [{month, amount, set_at, set_by}]}`; `PUT
/v1/fleet/fuel-budgets/{YYYY-MM} {amount}` (baht, more than 0; `null` removes it) → the month.

**Reports.** Every fleet report reads the same two definitions (decided 2026-10-10;
`todo/fleet-maintenance-model.md`, "Design — insights"):

- **A job's cost** is what `GET /v1/fleet/jobs/{id}` answers (parts from stock not already paid by one of
  its parts memos, plus its approved, received and paid memos), **dated by the job's close date**. An
  open job has no date: it is in no period's spend, and reports show its cost so far as open or in
  progress, as of today. A job's duration is start to close with both days counted.
- **Service due** is hours since the engine's last service (else since the hours it came with) against
  its own `service_interval`; an engine with no interval is never due.

| `GET` | What (legacy) |
|---|---|
| `/v1/fleet/reports/cost?period=all\|ytd\|last30\|month` | `costAggregate`: jobs done or in progress, each costed as `GET /v1/fleet/jobs` does and split equally over the categories of its assets (`hull`, `engine`, `gearbox`, `propeller`, `other`); memos with a boat and no job as `memo` (the share not bought into stock, `directShare`); `central` (no boat, or the stock share) apart from the total. `{total, done, proc, n_done, n_proc, n_jobs, boats_serviced, average_per_job, central, categories, by_type, outcomes, months (12), boats, units (top 10), rows}`. A done job is in the period it closed in (with no close date: `all` only); a job in progress has `date: null` and counts as `proc` in every period. `months[]`: done jobs by close month; `proc` there is the direct memos not yet paid |
| `/v1/fleet/reports/upkeep?month=YYYY-MM` | `renderConsumables`: per boat `repairs` (jobs closed that month) + `consumables` (`qty × unit_cost`, rounded) = `upkeep`; `draws`, `oil_drawn` |
| `/v1/fleet/reports/fuel?month=YYYY-MM` | `renderFuelIntel`: company boats' days that ran (booked pax, a route, or fuel); cost = fuel × the boat's, else its home pier's, price that day (no other fallback: `price_missing`). `{cost, fuel, pax, trip_days, cost_per_pax, previous, change_pct, projection, budget, over_budget, anomalies (a day above 1.3 × the boat's month average, 3+ fuel days), missing (ran, no fuel), logged_pct, boats (with routes), efficiency (L per engine hour from the `normal` meters, best/thirsty), efficiency_median, families (fuel, cost, pax, revenue, % of revenue), weekly (W1–W5), trend (per boat: base month, weeks, 6 months)}` |
| `/v1/fleet/dashboard?date=` | `flRenderDashboard`: `piers` (company boats by pier that day), `board` (open jobs not parked by lane, `boats_down`, `money_tied`, `silent_over_60`, `no_owner`, `parked`), `pending_work` per boat, `engines` by model, `spares`, `low_stock`, `memos`, `incidents`, `service_due` (engines on a boat with an interval, listed from 70 % of the way: `{count, engines (top 5): [{engine_id, boat_id, boat_name, model, hours, interval, since, remaining, pct, overdue, critical (≥ 95 %)}]}`), `cost_trend` (6 months: jobs closed each month, their cost) |
| `/v1/fleet/repair-history?boat_id=` | the boat's done jobs in legacy's `repairHistory` shape, latest first: legacy wrote a copy at every close and read none; here it is computed |
| `/v1/fleet/insights?period=month\|quarter\|ytd\|all` | `flRenderInsights` (below) |
| `/v1/fleet/reports/fleet?from=&to=` | the Fleet Report, `repFleetGather` (below) |

**Fleet Insights** (`GET /v1/fleet/insights?period=`, default `month`; the period runs from its first
day to today; `400` for another period). Computed, nothing stored. A login tied to an agent gets `403`.

| Field | What |
|---|---|
| `fleet` | company boats (not charter, not retired): `company_boats`, `available`/`fixing`/`unavailable` (effective status today), `piers` (today's pier; a boat held at a shop is at none) |
| `kpis` | `incidents` (dated in the period), `incidents_critical` (priority ≥ 4), `jobs_closed`, `spent` (their cost), `average_per_job`, `active_jobs`, `pending_jobs`, `open_cost` (open jobs now) |
| `boats[]` | per company boat, by cost: `jobs` (closed in the period, plus still open and opened in it), `jobs_closed`, `jobs_active`, `cost` (closed in the period), `open_cost`, `incidents`, `status`, `health` (`critical`: 3+ jobs or ฿100,000+; `watch`: 1+ job; else `healthy`) |
| `alert_boat` | the first boat with cost or jobs |
| `trend` | `months` (6: cost and count of jobs closed, incidents), `cost_delta_pct`, `incidents_delta_pct` (this month against last), `top_boat` (this month's) |
| `by_supplier` | memos approved, ordered, received or paid, dated in the period, by supplier (the memo's; else the one most of its stock items name; else read from `ref_note`; else `Other`): `{memos, suppliers, amount, rows}` |
| `by_type` | jobs closed in the period by type: cost and count |
| `healthy` | company boats with no jobs and available today |
| `service_due` | engines on a boat within 20 % of their interval or overdue, soonest first: `{engine_id, serial, model, brand, boat_id, boat_name, hours, since, interval, left, overdue}` |
| `memos` | `pending`, `pending_amount`, `pending_nos` (first 3), `received`, `received_amount`, `approval_rate` (approved or later of all memos; null under 3 memos) |
| `awaiting_invoice` | done jobs marked awaiting the invoice that no memo names, `days_since` the close |
| `documents` | each type's current certificate on company boats expiring within 60 days or expired: `expired`, `critical` (≤ 14 days), `warning`, `items` |
| `closing_speed` | average days (start to close) of the jobs closed in the period against those closed before it; null under 3 done jobs |
| `recurring_incidents` | boats with 2+ incidents in the period |
| `long_running` | jobs in progress started 14+ days ago |
| `cost_concentration` | the top boat when it took over half the period's spend, else null |

**The Fleet Report** (`GET /v1/fleet/reports/fleet?from=YYYY-MM-DD&to=YYYY-MM-DD`; both required, `to` not
before `from`, at most 366 days, else `400`; agent logins `403`). `{from, to, days, current, previous,
stock, data_gaps}`: `current` is the range, `previous` the same number of days just before it, each:

| Field | What |
|---|---|
| `availability` | every boat not retired (charter boats too), day by day, by the effective status: `boats_registered`, `boats_in_service` (available at least one day), `idle_boats` (never; left out of the rate), `down_days`, `availability_pct`, `down_by_boat` (`days`, `available_pct`) |
| `incidents` | dated in the range: `count`, `open`, `serious` (critical or major), `by_severity`, `by_boat` |
| `jobs` | `closed` (in the range), `opened` (started in it), `average_days`, `cost` (of the closed), `with_cost`, `open_list` (open jobs started by `to`, `age` in days at `to`, oldest first) |
| `spend` | `repairs` (= `jobs.cost`), `purchasing` (memos), `total` (repairs plus the memos that name no job, so a job's memo counts once) |
| `engine_hours` | per boat, last minus first meter reading (above 0) per engine in the range, every trip type: `total`, `reads`, `by_boat` (`hours`, `per_day`) |
| `projects` | overlapping the range, cancelled ones left out: `active`, `completed`, `late` (past the planned end, not completed), `list` (`late_days`) |
| `memos` | dated in the range, not cancelled, after discount (before VAT): `count`, `amount`, `pending`, `pending_amount`, `by_supplier`, `by_type` |

`stock` is now: `items`, `at_zero`, `in_stock`, `with_min`, `below_min`, `value` (qty × cost), `uniform_min`
(the minimum when every item that has one shares it), `out` (items at zero, dearest first). `data_gaps`
lists legacy's "where the data is thin" as `{code, level, …numbers}`: `jobs_without_cost`,
`no_project_budget`, `safety_default_pm` (still on 2026-01-01), `few_consumables` (under 10),
`idle_boats`, `uniform_min`. The headline, agenda and "what needs a decision" are the screen's text.

**Import.** `import:fleet` also copies `boats__assignments` (legacy's id; `cancelled` kept; legacy kept
no creator).

Booking creation/amendment/rescheduling and lock changes run in one serialized capacity guard. PostgreSQL deployments use transaction-scoped advisory locks for each route/date pool, so concurrent API instances cannot oversell. Over-capacity requests return `409`; invalid input returns `400`; unknown resources return `404`.
Booking creation/amendment/rescheduling and lock changes run in one serialized capacity guard. PostgreSQL deployments use transaction-scoped advisory locks for each route/date pool, so concurrent API instances cannot oversell. Every write is a `SERIALIZABLE` transaction, retried on a serialization failure (`40001`) or deadlock; **a retry runs alone**: each transaction holds a gate (an advisory lock taken before `BEGIN`) shared, a retry takes it exclusive, so it waits for the transactions in flight and none runs beside it. A first attempt never waits, so writes stay concurrent until two collide; a collision then costs one retry, not a `500`. (Only a serializable transaction from outside this store, which skips the gate, could still cancel a retry; there are 8 attempts for that.) Over-capacity requests return `409`; invalid input returns `400`; unknown resources return `404`.

`GET /api/health` remains available for service health checks. It returns `{ status: "ok", commit }`,
where `commit` is the git SHA Railway built the running deploy from (`null` outside Railway). If it
is not the head of the branch you pushed, the deploy you are talking to is stale.
