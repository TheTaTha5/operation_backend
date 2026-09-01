# Operation Backend

Fastify service for boat deployments, operational capacity, bookings, and agent seat locks. Set `DATABASE_URL` to use PostgreSQL; without it, the service uses an in-process store for local testing.

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

Migrations are applied once and recorded in `schema_migrations`, so re-running is a no-op and a migration need not be idempotent. Each file and its ledger row commit together — a failure rolls the whole file back and records nothing. A session advisory lock serializes concurrent deploys. Migrations are checksummed: editing one that has already run is reported as a warning, because that database no longer matches a freshly migrated one. Fix such drift with a new migration rather than by editing history.

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
| Bookings and seat locks | `booking:read` | `booking:write` |
| Manifest, allotment, deployments | `operations:read` | `operations:write` |

The `admin` group grants every permission. `CORS_ORIGIN` must contain the frontend's exact HTTPS origin (multiple values can be comma-separated). The health endpoint remains public. Authentication is deliberately disabled only when OIDC configuration is absent, which supports local tests; set `AUTH_REQUIRED=true` in Railway so an incomplete configuration prevents startup.

## API

Dates are ISO `YYYY-MM-DD`; passenger counts (`pax`) and deployment `capacity` are positive integers. All availability calculations are scoped to `route_id` plus service date. A deployment is required before seats become available.

### Catalogue

Reference data every other endpoint refers to by id.

- `GET /v1/routes` — the route catalogue. With `from=&to=` each route also carries its operating
  calendar resolved per date, as `days[date] = { open, source }`, where `source` names the rule that
  decided it. The range is capped at 400 days, and `from`/`to` must be supplied together.
- `GET /v1/boats` — the boat catalogue: `{ id, name, type?, pier?, capacity, license_pax,
  charter_ceiling, crew? }`.

`GET /v1/boats` is deliberately **not** date-aware. `boat_capacity_overrides` changes one boat's
seats for one day, but `GET /v1/availability` already resolves that against the day's deployment,
and answering the same question in two places invites the two answers to disagree.

`charter_ceiling` is how many passengers a charter may fill the boat to, resolved for you.
`license_pax` is `null` for a boat with no licence on file — three Ranong boats have none — and in
that case `charter_ceiling` falls back to `capacity`. **A missing licence is not a licence of zero.**
The null is reported rather than quietly replaced by `capacity`, because claiming a registration a
vessel does not hold is worse than saying it has none; read `charter_ceiling` for the number and
`license_pax` for whether it is a legal figure or a fallback.

### Operations

- `POST /operations/deployments` — `{ boat_id, route_id, service_date, capacity, license_pax?, registered_persons? }`; creates or replaces a boat's deployment for that date. `license_pax` is taken from the boat catalogue when omitted.
- `DELETE /operations/deployments/{service_date}/{boat_id}` — removes a deployment.
- `GET /operations/deployments?from=&to=&route_id=` — lists deployments.
- `GET /operations/allotment?route_id=&service_date=` — deployed, booked, locked, and available seat totals, with contributing deployments.
- `GET /v1/manifest?date=&route_id=` — allotment plus bookings for the operating day.
- `GET /v1/availability?route_id=&date=` — booking-form availability.

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
    { "routeId": "r-1", "date": "2030-01-02", "pax": { "ad": 2, "chd_fr": 1 } },
    { "routeId": "r-1", "date": "2030-01-03", "pax": { "ad": 2 }, "bookingMode": "charter" }
  ]
}
```

`pax` is a grid of category × pricing tier: categories are `ad`, `chd`, `inf`, `foc`, and a bare key
is untiered while `_fr` and `_th` are the foreign and Thai tiers (`ad`, `ad_fr`, `ad_th`, …). Every
category consumes a seat, infants and FOC included. An unrecognised key is rejected rather than
dropped — a silently ignored count is a passenger who is not on the boat. A plain `pax: 6` is
accepted and stored as one untiered cell.

Responses return `trips` with each trip's `pax` grid and `pax_total`, plus `route_id`,
`service_date`, `pax` and `allocated_pax` at the top level. Those four are **derived** — the first
trip's route and date, the total across every trip, and the seats that total currently holds — so a
single-departure client can ignore trips entirely.

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

- `GET /v1/bookings` — optionally filter by `route_id` and `service_date` (or `date`); a booking
  matches if any of its trips does.
- `GET /v1/bookings/{id}`
- `POST /v1/bookings` — `{ trips: [...] }`, or the flat `{ route_id, service_date, pax }` for a
  single departure. A supplied top-level `pax` must equal the sum across trips. The whole payload is
  retained in `booking_data`, while source ID, agent, voucher and rate type are stored in dedicated
  fields. **The itinerary is weighed as a whole**: if any day is short of seats the booking is
  refused entirely and no day is left holding part of it. Two trips on the same departure are
  counted together. A trip must name a route in the catalogue (`GET /v1/routes`); an unknown one is
  a `400` naming the route, and `booking_trips_route_fk` is the database backstop behind it.
- `PATCH /v1/bookings/{id}` — send `trips` to replace the itinerary outright, or `route_id`,
  `service_date` and/or `pax` to move a single-departure booking. Capacity is checked only when
  something actually moves, and days being vacated are released in the same transaction.
- `POST /v1/bookings/{id}/cancel` — accepts optional `{ reason }`; idempotently returns all seats.
- `POST /v1/bookings/{id}/partial-cancel` — `{ pax_to_cancel }` (also accepts `pax`). Requires a
  single departure whose passengers are untiered: on a booking split across categories a bare number
  does not say who left, and any rule for choosing would cancel the wrong people. Send `trips` with
  the intended grid instead.
- `POST /v1/bookings/{id}/reschedule` — `{ route_id, service_date, pax? }`; checks target capacity
  before moving allocation. Single-departure only, on the same grounds.

### Agent seat locks

- `GET /v1/seat-locks` — optionally filter by `route_id` and `service_date` (or `date`).
- `POST /v1/seat-locks` — `{ route_id, service_date, pax, agent_id? }`.
- `PATCH /v1/seat-locks/{id}` — change `pax` and/or `agent_id`; a larger allocation is capacity checked.
- `POST /v1/seat-locks/{id}/release` — idempotently releases a lock.

Booking creation/amendment/rescheduling and lock changes run in one serialized capacity guard. PostgreSQL deployments use transaction-scoped advisory locks for each route/date pool, so concurrent API instances cannot oversell. Over-capacity requests return `409`; invalid input returns `400`; unknown resources return `404`.

`GET /api/health` remains available for service health checks.
