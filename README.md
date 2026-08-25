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
| `npm run check` | Type-check the source. |

## Railway deployment

1. Create a new Railway project and deploy this repository.
2. Railway uses `railway.json` to install dependencies, compile TypeScript, start `npm start`, and probe `/api/health` before marking a deployment healthy.
3. Configure any required runtime environment variables in Railway. `PORT` is supplied by Railway; do not set a fixed port.

## API

Dates are ISO `YYYY-MM-DD`; passenger counts (`pax`) and deployment `capacity` are positive integers. All availability calculations are scoped to `route_id` plus service date. A deployment is required before seats become available.

### Operations

- `POST /operations/deployments` — `{ boat_id, route_id, service_date, capacity }`; creates or replaces a boat's deployment for that date.
- `DELETE /operations/deployments/{service_date}/{boat_id}` — removes a deployment.
- `GET /operations/deployments?from=&to=&route_id=` — lists deployments.
- `GET /operations/allotment?route_id=&service_date=` — deployed, booked, locked, and available seat totals, with contributing deployments.
- `GET /v1/manifest?date=&route_id=` — allotment plus bookings for the operating day.
- `GET /v1/availability?route_id=&date=` — booking-form availability.

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
