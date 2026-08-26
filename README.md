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

### Operations

- `POST /operations/deployments` — `{ boat_id, route_id, service_date, capacity }`; creates or replaces a boat's deployment for that date.
- `DELETE /operations/deployments/{service_date}/{boat_id}` — removes a deployment.
- `GET /operations/deployments?from=&to=&route_id=` — lists deployments.
- `GET /operations/allotment?route_id=&service_date=` — deployed, booked, locked, and available seat totals, with contributing deployments.
- `GET /v1/manifest?date=&route_id=` — allotment plus bookings for the operating day.
- `GET /v1/availability?route_id=&date=` — booking-form availability.

`GET /operations/allotment` and `GET /v1/availability` also accept `exclude_booking_id` and `exclude_lock_id`. A reservation being edited still holds its seats, so an unqualified read counts them against it: raising a 6-pax booking to 8 on a full day looks refused even though the six seats it releases would cover it, and a no-op edit on a sold-out day looks unsavable. Pass the id being edited to read availability as it will be once that reservation is re-saved. Amendments apply the same exclusion internally, so a `PATCH` never rejects a booking on the strength of its own seats.

### Bookings

- `GET /v1/bookings` — optionally filter by `route_id` and `service_date` (or `date`).
- `GET /v1/bookings/{id}`
- `POST /v1/bookings` — `{ route_id, service_date, pax }`. It also accepts a source booking with exactly one `trips` item: `trips[0].routeId`, `trips[0].date`, and its `pax` category object are normalized automatically. All categories, including infants and FOC, consume seats. The source payload is retained in `booking_data`, while its source ID, agent, voucher, rate type, booking mode, and pax breakdown are stored in dedicated fields.
- `PATCH /v1/bookings/{id}` — amend `route_id`, `service_date`, and/or `pax`; capacity is checked only when one of these changes.
- `POST /v1/bookings/{id}/cancel` — accepts optional `{ reason }`; idempotently returns all allocated seats.
- `POST /v1/bookings/{id}/partial-cancel` — `{ pax_to_cancel }` (also accepts `pax`); returns that many seats.
- `POST /v1/bookings/{id}/reschedule` — `{ route_id, service_date, pax? }`; checks target capacity before moving allocation.

### Agent seat locks

- `GET /v1/seat-locks` — optionally filter by `route_id` and `service_date` (or `date`).
- `POST /v1/seat-locks` — `{ route_id, service_date, pax, agent_id? }`.
- `PATCH /v1/seat-locks/{id}` — change `pax` and/or `agent_id`; a larger allocation is capacity checked.
- `POST /v1/seat-locks/{id}/release` — idempotently releases a lock.

Booking creation/amendment/rescheduling and lock changes run in one serialized capacity guard. PostgreSQL deployments use transaction-scoped advisory locks for each route/date pool, so concurrent API instances cannot oversell. Over-capacity requests return `409`; invalid input returns `400`; unknown resources return `404`.

`GET /api/health` remains available for service health checks.
