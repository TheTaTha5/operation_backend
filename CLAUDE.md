# Operation Backend

## Goal

Replace the legacy system with a modern backend that **decides**, not one that only stores.

- **The server decides; clients display.** Every business rule — price, status changes, capacity,
  whether a route runs, approvals, permissions — is enforced here. A client may show hints, but the
  server's answer is the one that counts.
- **The end state is that legacy is switched off completely:** its `server.js` (storage and login)
  *and* the business rules that live in its browser code (`allotment_v2/js/*.js`). Moving the data
  alone is not done: a rule left in a browser has to be re-implemented by every client.
- **Scope is everything legacy does:** bookings, seats, seat locks, deployments, the route and boat
  catalogue and its calendar, sales and pricing (agents, rate types, seasons, promos, contracts,
  quotes), money (invoices, payments, reports), day-of-operations (vans, pickups, check-in), fleet
  maintenance, and login.
- **Clients:** the new Vue staff app (`operation_frontend/apps/web`), legacy `allotment_v2` until it
  is retired, and Love Kingdom (the B2C website).
- **Cutover is area by area.** Until an area moves, legacy is its master and
  `src/tools/import-legacy.ts` mirrors it here. Once it moves, this backend is its master and legacy
  stops writing it. **Bookings move first.**
- `todo/legacy-replacement.md` lists the data still to give a home; the rules to move are in
  `allotment_v2/js` and need the same kind of list.

## Nothing live depends on this yet

**operation-backend is a development project.** No production traffic uses it, and `main` is a
development branch too. So:

- Changes, migrations and contract changes go through directly. No rollout plan, no deprecation
  period, no keeping an old field alive "so live clients don't break" — there are none.
- Breaking a client (legacy's integration branch, Love Kingdom) is fine; say what they must change.
- The design-note stop before new rules or schema still applies: it is about getting the rule right,
  not about protecting production.

This changes when the first area cuts over and real traffic arrives. Update this section then.

## Authority: who decides each value

Every field a feature adds is one of three kinds. The design note says which, for every field.

| Kind | Who decides | The server's job | Examples |
|---|---|---|---|
| **Computed** | the server | work it out; never take it from the request | price, seats left, `allocated_pax` |
| **Validated** | client proposes, server judges | check the rule; refuse with a clear error | status changes, deployment changes, booking a closed day |
| **Client fact** | the client | store it, checking only its shape | names, hotel, notes, the add-ons chosen |

API shape follows from it:

- **Resources for nouns, commands for actions.** `GET`/`POST`/`PATCH` on a resource; a rule-bound
  change is a command: `POST /v1/bookings/{id}/confirm`, `/cancel`, `POST /v1/quote`.
- **`PATCH` changes client facts only.** A server-owned field sent to `PATCH` is refused with `400`
  naming the command to use. Never silently dropped, never silently applied.
- **Every computed or validated field has a test that sends a wrong value** and expects it refused
  or overridden.
- **Temporary exceptions are written down.** Today `total` and the price fields are still taken from
  the client, because the server cannot price a booking until `POST /v1/quote` exists.

## Business rules come from legacy

- **Copy what legacy does.** Production legacy is the `lk-inbox` worktree at `D:\projects\wt-lk-inbox`
  (repo `LOVE_Andaman_Workspace`); its rules are in `allotment_v2/js/*.js`. `operation_frontend`'s
  copy of `allotment_v2` is older and not production. Legacy is a separate repository with its own
  database: a reference, not a dependency, and changes to it do not belong here.
- **When legacy is clearly a bug, ask** before copying or fixing it.
- **Prove a ported rule against legacy:** replay real legacy cases (e.g. re-price real bookings) and
  expect legacy's answer, apart from bugs you were told to fix.

## This project is the API

Frontends consume this API; they are not developed here. The deliverable is an endpoint, its
contract, its rules and its documentation in `README.md` — never frontend code.

In scope: endpoints, request/response shapes, status codes and errors; the domain rules behind them;
the schema and migrations; login (`/v1/login`, legacy's users imported here, Bearer tokens).

Out of scope: UI and styling; legacy's own contract (`/api/load`, whole-state sync, `/api/v1/_batch`,
cookie sessions), which we do not reimplement and are not bound by.

**Love Kingdom is ours too,** so a breaking change ships on both sides together. This repo changes the
contract and `docs/love-kingdom-integration.md`; Love Kingdom's code changes in its own repo.

## Working style

The developer is learning the codebase. Answers are **short but easy to understand**: lead with the
result, plain language, a brief definition for any technical term, file paths for code.

- **Stop for approval before new business rules, schema, or a contract change.** Write the design in
  `todo/<name>-model.md` (fields and their authority, schema, contract, legacy behaviour, open
  questions) and wait for a yes. Bug fixes and docs go straight ahead.
- **Call out assumptions and trade-offs;** ask when a request has more than one sensible design.
- **Git:** each feature gets its own branch and focused commits once it is done and tested. Pushing
  and pull requests are the developer's call.
- **Run the tests on both stores and say what they prove.** If they cannot run, say why and give the
  command.
- **Do not hide errors behind broad fallbacks.** Explain the error and the next debugging step.

## What exists

Fastify + PostgreSQL, no ORM: hand-written parameterized SQL via `pg`. See `README.md` for the
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
`DATABASE_URL=… npm test` runs the same tests against PostgreSQL and is where real bugs surface. Use
a fresh local database: the suite assumes an empty one, as CI's is.

**Dates: cast in SQL, never stringify a `DATE`.** `pg` hydrates `DATE` and `TIMESTAMPTZ` into JS
`Date` objects. `String(row.service_date)` yields `"Wed Jan 04 2030 00:00:00 GMT+0700"`, and
`toISOString().slice(0,10)` is off by one day east of UTC. Prefer `service_date::text` in the
query.

**Migrations are applied once and recorded in `schema_migrations`.** They need not be idempotent.
Deploying migrates: `railway.json` runs `node dist/migrate.js` as `preDeployCommand`, so the schema
moves before the new code takes traffic and a failed migration aborts the deploy with the old
version still serving. It runs the *compiled* migrator deliberately — `npm run db:migrate` goes
through `tsx`, a devDependency the build prunes.

That makes a migration something that ships unwatched, which the runner is built for — each file and
its ledger row commit together, an advisory lock serializes concurrent deploys, and a rerun is a
no-op. What it cannot catch is a migration that succeeds and is wrong. **Rehearse anything
destructive before merging it**: restore a copy, apply the migration, and check the rows, the way
007 was checked against a reproduction of the production booking. Railway will not stop a clean
mistake.

**Capacity invariants belong in the schema.** `license_pax` is the registered *passenger* maximum;
the legacy `totalcap` is `license_pax + crew` and must never be used as a selling ceiling.

**Legacy data is read-only and checked before it shapes a schema.** Read it with a read-only
session (`default_transaction_read_only=on`) through `ORIGINAL_DATABASE_URL`, and count before
adding a constraint that legacy rows must satisfy.
