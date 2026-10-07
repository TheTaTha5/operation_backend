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

## Commands

| Command | Description |
| --- | --- |
| `npm run dev` | Start with file watching. |
| `npm run build` | Compile TypeScript into `dist/`. |
| `npm start` | Run the compiled service. |
| `npm test` | Run HTTP route tests. |
| `DATABASE_URL=… npm test` | Run the same tests against PostgreSQL instead of the in-process store. |
| `npm run check` | Type-check the source. |
| `npm run db:migrate` | Apply PostgreSQL migrations. |
| `SOURCE_DATABASE_URL=… TARGET_DATABASE_URL=… npm run sync:routes [-- --commit]` | Copy the route catalogue (routes, times, seasons, day overrides) from the legacy database. A dry run that prints the diff unless `--commit` is given. Re-runnable: legacy wins for every route it has, and a route only this service has is reported, never deleted. |
| `SOURCE_DATABASE_URL=… TARGET_DATABASE_URL=… npm run sync:boats [-- --commit]` | Copy the boat catalogue from the legacy database, the same way: dry run unless `--commit`, legacy wins, never deletes. Legacy's `totalcap` is never read, and a boat selling more seats than its licence is skipped and listed, not clamped. Run the import afterwards so deployments pick up new or changed boats. |

Migrations are applied once and recorded in `schema_migrations`, so re-running is a no-op and a migration need not be idempotent. Each file and its ledger row commit together — a failure rolls the whole file back and records nothing. A session advisory lock serializes concurrent deploys. Migrations are checksummed, with line endings normalized to LF so a Windows checkout (`core.autocrlf`) and a Railway build agree: editing one that has already run is reported as a warning, because that database no longer matches a freshly migrated one. Fix such drift with a new migration rather than by editing history.

Deploys migrate themselves. `railway.json` runs `node dist/migrate.js` as `preDeployCommand`, so the schema moves after the build and before the new version takes traffic; if the migration fails the deploy is aborted and the previous version keeps serving. It runs the compiled migrator rather than `npm run db:migrate`, because that script goes through `tsx`, a devDependency the production build prunes. Run `npm run db:migrate` by hand for local databases, or against a production URL when you want to watch a destructive migration go in before deploying the code that needs it.

## Authentik OIDC authentication

Operational API routes are protected when all of these environment variables are configured:

```text
AUTH_REQUIRED=true
OIDC_ISSUER=https://auth.example.com/application/o/operation-backend
OIDC_AUDIENCE=operation-backend
CORS_ORIGIN=https://app.example.com
```

`OIDC_ISSUER` is the issuer URL displayed by the Authentik OAuth2/OIDC provider; do not substitute the Authentik root URL. The API obtains the provider's JWKS URL from OIDC discovery and validates Bearer access tokens for the configured issuer and audience.

The frontend must use Authorization Code with PKCE and send `Authorization: Bearer <access token>`. Configure the Authentik provider to emit either scopes or group names matching these permissions:

| API area | Read permission | Write permission |
| --- | --- | --- |
| Bookings, seat locks, agents, markets, salespeople | `booking:read` | `booking:write` |
| Manifest, allotment, deployments | `operations:read` | `operations:write` |

## Temporary password login (testing only)

`POST /v1/login` exchanges a username/password for a short-lived Bearer token this service will
itself accept. It is a deliberate, narrow exception to the "validate tokens, do not issue them"
boundary above, meant for testing before a frontend integration exists — not a replacement for
OIDC, and not meant to stay configured indefinitely.

```text
AUTH_JWT_SECRET=<random string, e.g. `openssl rand -base64 32`>
AUTH_PASSWORD_USERS=[{"username":"ops","password":"...","groups":["admin"]}]
```

`AUTH_PASSWORD_USERS` is a JSON array; `groups` follows the same permission table above (`admin`
grants everything). Both variables can be set alongside `OIDC_ISSUER`/`OIDC_AUDIENCE` — a request's
Bearer token is checked against whichever of the two are configured. `POST /v1/login` itself is
always public.

```bash
curl -X POST https://<host>/v1/login -H 'Content-Type: application/json' \
  -d '{"username":"ops","password":"..."}'
# {"access_token":"...","token_type":"Bearer","expires_in":43200}
```

The token is HS256, signed with `AUTH_JWT_SECRET`, expires after 12 hours, and is otherwise an
ordinary Bearer token: `Authorization: Bearer <access_token>` on any request. Rotate
`AUTH_JWT_SECRET` (which invalidates every outstanding token) and remove these two variables once
testing is done.

The `admin` group grants every permission. `CORS_ORIGIN` must contain the frontend's exact HTTPS origin (multiple values can be comma-separated); those origins may use `GET`, `HEAD`, `POST`, `PUT`, `PATCH` and `DELETE`. The health endpoint remains public. Authentication is deliberately disabled only when OIDC configuration is absent, which supports local tests; set `AUTH_REQUIRED=true` in Railway so an incomplete configuration prevents startup.

## API

Dates are ISO `YYYY-MM-DD`; passenger counts (`pax`) and deployment `capacity` are positive integers. All availability calculations are scoped to `route_id` plus service date. A deployment is required before seats become available.

### Catalogue

Reference data every other endpoint refers to by id.

- `GET /v1/routes` — the route catalogue. With `from=&to=` each route also carries its operating
  calendar resolved per date, as `days[date] = { open, source }`, where `source` names the rule that
  decided it. The range is capped at 400 days, and `from`/`to` must be supplied together.
  Each route is `{ id, name, kind, ext_id?, pier?, family_id?, color?, islands?, sort?, times }`.
  `kind=marine` or `kind=land` lists only that kind (`400` for anything else).
- `GET /v1/boats` — the boat catalogue: `{ id, name, type?, pier?, capacity, license_pax,
  charter_ceiling, crew? }`.

**Not every route is a boat trip.** `kind` is `marine` for a boat programme (it has a pier,
deployments and seats) and `land` for a transfer, city tour or show/park ticket, which has none of
these. `ext_id` is a land product's Love Kingdom code, e.g. `PTP-005:VT-002` (product, then variant);
treat it as opaque. A calendar or seat view wants `kind=marine`. A land route is in the catalogue
so that legacy bookings on it have a route to point at, but **it cannot be booked through this API
yet**: `POST /v1/bookings` checks boat seats, a land route has no deployments, and the answer is
`409 Insufficient available seats`. Selling land products needs its own capacity rule, which is
undecided.

The route and boat catalogues are still edited in legacy. `npm run sync:routes` and
`npm run sync:boats` copy them here, and are meant to be run again whenever legacy has changed (see
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
  entered, and `null` means open. Travel dates are not stored: they come from the rate type, which
  has no endpoint yet.
- **`house`** marks `a_walkin`, `a_staff` and `a_b2c`: accounts the business sells through itself.
- **`rate_type_id`** is the rate type the agent is priced with. It is not validated yet, because
  there is no rate type table. `GET /v1/rate-types` comes with the Rate Types port.
- **Not here yet:** credit used and available (needs invoices and payments, which this service
  doesn't have), rate seasons and add-on prices (legacy never saved them to its database), and
  contract history (the Contracts port).

### Operations

- `POST /operations/deployments` — `{ boat_id, route_id, service_date, capacity, license_pax?, registered_persons? }`; creates or replaces a boat's deployment for that date. `license_pax` is taken from the boat catalogue when omitted.
- `DELETE /operations/deployments/{service_date}/{boat_id}` — removes a deployment.
- `GET /operations/deployments?from=&to=&route_id=` — lists deployments.
- `GET /operations/allotment?route_id=&service_date=` — deployed, booked, locked, and available seat totals, with contributing deployments.
- `GET /v1/manifest?date=&route_id=` — allotment plus bookings for the operating day.
- `GET /v1/availability?route_id=&date=` — booking-form availability for one route on one day:
  `{ route_id, service_date, deployed_capacity, licensed_capacity, booked_pax, charter_pax, locked_pax, available_seats }`.
- `GET /v1/availability?from=&to=[&route_id=]` — the same numbers for a range, both ends inclusive,
  for one route or, without `route_id`, every route in the catalogue:

  ```jsonc
  { "days": [
    { "route_id": "r1", "service_date": "2031-03-01", "open": true,
      "deployed_capacity": 40, "licensed_capacity": 45, "booked_pax": 8, "charter_pax": 4,
      "locked_pax": 0, "available_seats": 22,
      "deployments": [
        { "boat_id": "b1", "capacity": 30, "license_pax": 35, "chartered": false },
        { "boat_id": "b2", "capacity": 10, "license_pax": null, "chartered": true } ] } ] }
  ```

  Ordered by date, then by route in catalogue order; boats are ordered by id. Every route-day is
  present, and a day with no deployment is all zeros, not missing. `open` is the route calendar's
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
`completed`, `rejected`, `cancelled`, `cancelled_weather`. It defaults to `confirmed` on create,
may be set on create or changed with `PATCH`, and an unrecognised value is a `400` listing the
valid ones.

**Seats are released by `cancelled`, `rejected` and `cancelled_weather`. Every other status holds
them** — including `quote` and `draft`. That is a denylist rather than an allowlist on purpose, and
the direction matters more than the membership: a status nobody has classified yet holds its seats
instead of releasing them. Over-holding is a day that looks fuller than it is and someone asks;
under-holding is two parties sold the same seat, at the pier, on the day. It matches the rule the
legacy frontend applies (`getSeatsConsumed`).

Two consequences worth knowing:

- A booking created in a released status **reserves nothing and is never capacity-checked**, so a
  cancellation can be recorded against a day that is already full.
- Changing status from a released one to a holding one **is** capacity-checked, even when the
  itinerary has not moved — confirming a quote asks for those seats for the first time, and a day
  that filled up in the meantime will refuse it with a `409`.

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
  [Passengers](#passengers) — and so is an optional `addOns` array, see [Add-ons](#add-ons). **The itinerary is weighed as a whole**: if any day is short of seats
  the booking is refused entirely and no day is left holding part of it. A booking has **at most one
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
  Capacity is checked only when the amendment **asks for more**: a new or moved trip, more
  passengers, more general seats, or more seats from a lock. Taking passengers off never needs room,
  so it succeeds on a day that is already oversold (the legacy import brings such days over as they
  are).
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
`created_by` defaults to the token user on create, unless the body names one. With authentication
switched off (local development) there is no user: `updated_by` is left alone and `by` is `null`.

Each write appends one line to the booking's history, in the same transaction:

| Write | `kind` | `tag` | `text` |
|---|---|---|---|
| `POST /v1/bookings` | `create` | `Created` | `Created` |
| `PATCH` | `edit` | `Edited` (`Confirmed` when the status becomes `confirmed`) | `Edited · trips, total` (the keys sent) |
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
`not_cancelled`, `charter_boat_taken`, `already_cancelled`, `booking_closed`.

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
| lifecycle | `status`, `booking_date`, `booked_at`, `created_by`, `updated_by`, `confirmed_at`, `confirmed_by`, `cancellation_reason` |
| free text | `notes`, `note` |

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
