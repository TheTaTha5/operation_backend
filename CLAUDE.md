# Operation Backend

## Goal

Build the backend that becomes the system of record for boat operations: deployments, seat
inventory, bookings, seat locks, and the route/boat catalogue with its operating calendar.

**This project is the API. It is not a frontend project.**

Frontends consume this API; they are not developed here. When a frontend needs something, the
deliverable from this repo is an endpoint, its contract, and documentation of how to call it —
never frontend code. "Make the booking page work" means *design and ship the endpoint the booking
page should call*, then hand over the contract. Editing a frontend's API layer to point at us is
their integration step, not our implementation.

Concretely, in scope here:

- endpoints, request/response shapes, status codes, error semantics
- the domain rules behind them: capacity, seat allocation, whether a route runs on a date
- the schema and migrations that hold it
- documenting all of the above in `README.md` so an integrator needs nothing else

Out of scope here:

- UI, pages, components, styling
- browser-side auth flows — PKCE, redirect URIs, callbacks, token storage. This service validates
  Bearer tokens; it does not implement logins. There is deliberately no callback route, session,
  or cookie.
- the legacy monolith's contract — `/api/load`, whole-state blob sync, `/api/v1/_batch`, cookie
  sessions. We do not reimplement it and we are not bound by it.

## What exists

Fastify + PostgreSQL, no ORM — hand-written parameterized SQL via `pg`. See `README.md` for the
endpoint list and `todo/` for known issues and deferred decisions.

Two store implementations sit behind the same interface: `OperationsStore` (in-process, used when
`DATABASE_URL` is absent) and `PostgresOperationsStore`. They must behave identically.

## Conventions worth keeping

**Logic that both stores need goes in a pure function both call.** Not a SQL view, not two copies —
the in-process store has no database, so anything SQL-only forces a hand-written duplicate that
will drift. `src/domain/calendar.ts` is the pattern: I/O differs per store, the decision is written
once. The seat-lock `service_date` bug is what happens otherwise — two row mappers disagreed for
months because only one store was ever exercised.

**Run the suite against both stores.** `npm test` covers the in-process store only.
`DATABASE_URL=… npm test` runs the same tests against PostgreSQL and is where real bugs surface.

**Dates: cast in SQL, never stringify a `DATE`.** `pg` hydrates `DATE` and `TIMESTAMPTZ` into JS
`Date` objects. `String(row.service_date)` yields `"Wed Jan 04 2030 00:00:00 GMT+0700"`, and
`toISOString().slice(0,10)` is off by one day east of UTC. Prefer `service_date::text` in the
query.

**Migrations are applied once and recorded in `schema_migrations`.** They need not be idempotent.
Deploying does not migrate — `railway.json` runs build and start only, so `npm run db:migrate` is a
deliberate step.

**Capacity invariants belong in the schema.** `license_pax` is the registered *passenger* maximum;
the legacy `totalcap` is `license_pax + crew` and must never be used as a selling ceiling.

## Related systems

The legacy monolith (`allotment_v2.html` plus its `server.js`) is a separate repository with a
separate database. It is the system being migrated away from, and it is a *reference* for domain
rules — its production scars are documented in its own migrations and comments and are worth
reading before reinventing a rule. It is not a dependency, and changes to it do not belong here.
