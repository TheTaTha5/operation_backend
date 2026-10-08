# Replacing the legacy server.js

The goal of this service: once the endpoints below exist, the legacy monolith's `server.js` can be
switched off. Every piece of data it stores has a home here, behind a domain endpoint.

This is **not** a port of its routes. Legacy has about 20 routes, and nearly all data goes through
three generic ones: `/api/load`, `/api/save`, and `/api/v1/:resource` with `/api/v1/_batch`. They
move the whole app state as one document. We replace the *data* they carry (about 50 resources),
not the routes.

Derived on 2026-10-03 from `operation_frontend` `origin/main` (`a2d1d88`, 2026-08-19):

- the route table in `server.js`
- the resource registry in `os-backend/src/mapping/os_repo.js`

Paths and shapes are proposals. Each is settled when built and documented in `README.md`.

Key: ✅ exists today. Everything else is to build.

## Where it stands

*Updated 2026-10-08.* The order is `todo/authority-revision.md`'s: the server decides, bookings first.

- **Done:** most of operations, bookings and seat locks (sections 3–5), with the status decided by
  the server and changed through commands; the route calendar, its closed-day rule and its writes
  (section 2); rate types and read-only agents (section 6).
- **Next:** login and permissions (`todo/login-permissions-model.md`, waiting for approval). The
  2027 calendars are now added through the season endpoints, once deployed.
- **After that:** pricing (`POST /v1/quote`), booking extras (4), the rest of sales (6), vans (8),
  money (7).

## 1. Identity and system

```
GET    /api/health                                   ✅
GET    /v1/me                  caller identity + permissions (replaces /api/me, /api/users*)
GET    /v1/changes?since=      what changed since version N (replaces /api/version, /api/events)
```

## 2. Catalogue: routes, boats, calendar

```
GET    /v1/routes                                    ✅
POST   /v1/routes
PATCH  /v1/routes/{id}
PUT    /v1/routes/{id}/times          departure times
POST   /v1/routes/{id}/seasons                       ✅  add an open/closed window
DELETE /v1/routes/{id}/seasons/{season_id}           ✅
PUT    /v1/routes/{id}/days/{date}                   ✅  one-off open/closed day
DELETE /v1/routes/{id}/days/{date}                   ✅  (see route-calendar-rules-model.md)
GET    /v1/boats                                     ✅
POST   /v1/boats
PATCH  /v1/boats/{id}
PUT    /v1/boats/{id}/capacity-overrides/{date}      one day's seats (legacy boat_capovr)
DELETE /v1/boats/{id}/capacity-overrides/{date}
```

## 3. Operations: deployments and seats

```
GET    /operations/deployments                       ✅
POST   /operations/deployments                       ✅
DELETE /operations/deployments/{date}/{boat_id}      ✅
GET    /operations/allotment                         ✅
GET    /v1/manifest                                  ✅
GET    /v1/availability                              ✅  (webshop still needs API-key access)
GET    /v1/weather-closures?from=&to=
POST   /v1/weather-closures           close a route on a date, flag affected bookings (legacy sb_weather)
DELETE /v1/weather-closures/{id}
```

## 4. Bookings

```
GET    /v1/bookings                                  ✅
GET    /v1/bookings/{id}                             ✅
POST   /v1/bookings                                  ✅
PATCH  /v1/bookings/{id}                             ✅
POST   /v1/bookings/{id}/cancel                      ✅  category, charge, record (hand-off: booking action records)
POST   /v1/bookings/{id}/restore                     ✅
POST   /v1/bookings/{id}/partial-cancel              ✅  by trip and pax key, refund split
POST   /v1/bookings/{id}/reschedule                  ✅  from_date → to_date, reason, fee item
POST   /v1/bookings/{id}/confirm                     ✅  the server decides confirmed, pending_foc or pending_approval
POST   /v1/bookings/{id}/approve                     ✅  over-capacity / discount / FOC approval
POST   /v1/bookings/{id}/reject                      ✅
POST   /v1/bookings/{id}/cancel-weather              ✅
GET    /v1/bookings/{id}/history                     ✅  every write appends; imported from sb_bookings__history
addOns on POST/PATCH /v1/bookings, add_ons on reads ✅  (replaces PUT /add-ons, see addons-model.md)
PUT    /v1/bookings/{id}/adjustments  price adjustments, upgrades (fee items are read-only on the booking, written by reschedule)
GET    /v1/bookings/{id}/attachments  (replaces /api/attach*)
POST   /v1/bookings/{id}/attachments
GET    /v1/attachments/{id}           download one file
DELETE /v1/attachments/{id}
```

Add-ons, adjustments and history follow the normalized model in `booking-model.md`.

## 5. Seat locks

```
GET    /v1/seat-locks                                ✅
POST   /v1/seat-locks                                ✅
PATCH  /v1/seat-locks/{id}                           ✅
POST   /v1/seat-locks/{id}/release                   ✅
GET    /v1/seat-locks/{id}/log
```

## 6. Sales: agents, prices, contracts

```
GET    /v1/agents, /v1/agents/{id}, /v1/agents/{id}/activity              ✅
POST   /v1/agents
PATCH  /v1/agents/{id}
PUT    /v1/agents/{id}/programs
POST   /v1/agents/{id}/deactivate, /v1/agents/{id}/activate
GET    /v1/markets, /v1/sales                        ✅
GET    /v1/rate-types, /v1/rate-types/{id}                                  ✅
POST   /v1/rate-types, PATCH /v1/rate-types/{id}                         ✅
PUT    /v1/rate-types/{id}/routes/{route_id}, DELETE …/routes/{route_id} ✅
DELETE /v1/rate-types/{id}                                               ✅  (409 while in use)
PUT    /v1/agents/{id}/rate-bindings
GET    /v1/contracts, POST /v1/contracts, PATCH /v1/contracts/{id}
GET    /v1/contract-templates, PUT /v1/contract-templates/{id}
GET    /v1/add-ons                    add-on catalogue (legacy sb_extras)
GET    /v1/nationalities
GET    /v1/insurance-overrides, PUT /v1/insurance-overrides/{date}
```

Agent writes are phase 2 of `agents.md`.

## 7. Money

```
GET    /v1/invoices, GET /v1/invoices/{id}, POST /v1/invoices, PATCH /v1/invoices/{id}
POST   /v1/invoices/{id}/void
GET    /v1/payments?booking_id=, POST /v1/payments
GET    /v1/reports/market-stats?from=&to=    computed from bookings, not stored
```

## 8. Pickups and vans

```
GET    /v1/pickup-areas, PUT /v1/pickup-areas/{id}
GET    /v1/pickup-time-profiles, PUT /v1/pickup-time-profiles/{id}
GET    /v1/vehicles, POST /v1/vehicles, PATCH /v1/vehicles/{id}
PUT    /v1/vehicles/{id}/days/{date}      that day's status or route
GET    /v1/staff, POST /v1/staff, PATCH /v1/staff/{id}     drivers and other staff
GET    /v1/van-board?date=                the board read
PUT    /v1/van-board/{date}/assignments   assign bookings to van and driver
POST   /v1/van-board/{date}/send          mark the job sheet sent (legacy vanjob_sent)
```

The van board is steps 3–6 of `vans.md`, which owns the detail.

## 9. Fleet maintenance — scope undecided

Each gets `GET` list, `GET /{id}`, `POST`, `PATCH /{id}`, `POST /{id}/log`:

```
/v1/fleet/engines   /v1/fleet/gearboxes   /v1/fleet/propellers
/v1/fleet/maintenance   /v1/fleet/incidents   /v1/fleet/safety
/v1/fleet/inventory   /v1/fleet/projects   /v1/fleet/memos
GET/POST /v1/fleet/consumable-logs,   GET/PUT /v1/fleet/fuel-prices/{date}
GET/POST /v1/boats/{id}/documents,    GET /v1/boats/{id}/repair-history
```

## Not replaced

- **Whole-state data routes:** `/api/load`, `/api/save`, `/api/v1/:resource` and
  `/api/v1/_batch`. The domain endpoints above take their place.
- **Login and session routes:** `/api/login` and `/api/logout` as legacy has them (cookie
  sessions). ~~Authentik owns login.~~ **Corrected 2026-10-08:** login moves here instead: legacy's
  users are imported and `POST /v1/login` issues Bearer tokens (`todo/login-permissions-model.md`).
- **Browser-side state:** `_app_hooks` (app wiring), `nat_learn` (a nationality-guessing cache) and
  `agent_artifacts`.

## Open, before the sections that depend on them

- **Is fleet maintenance ours?** Section 9 is outside the scope in `CLAUDE.md`. It may belong in a
  separate service.
- **The webshop.** Two decisions here:
  - Do we take over the B2C booking sync (`/api/b2c/raw`, `/reset`, `/health`)?
  - Should `/v1/availability` accept the webshop's API key? Today it accepts only Bearer tokens.
- **Live updates: a change feed or polling?** Legacy polls `/api/version` every 10s, deliberately,
  so that a broken B2C sync is still reported. Read the comment above that route before choosing.
- **Permissions.** Legacy has per-area edit rights (`/api/users/perms`). `/v1/me` needs an
  equivalent, built from the imported users' areas rather than Authentik scopes: designed in
  `todo/login-permissions-model.md`.
- **Email images** (`/api/mailimg`, `/m/:id`) look like marketing, not operations. Confirm they can
  go.
- **Resources mapped from field names only.** Check these with someone who uses the screens:
  - `trips`: looks like the old per-day boat board, which deployments replace.
  - `ts_cot` (`mode`, `deduct`, `payout`): looks like agent commission.
  - `travel_sum` (`decision`, `amount`, `note`): looks like an approval record.
  - `fleet_drlock`: not identified.
- ~~**Which checkout is production?**~~ **Answered 2026-10-03:** the `lk-inbox` branch of
  `LOVE_Andaman_Workspace` (`digitalmkt-bbot`), checked out at `D:\projects\wt-lk-inbox` — not
  `operation_frontend`, which this list was derived from. The booking code now lives in
  `allotment_v2/js/*.js`, not `allotment_v2.html`. **This list should be re-derived** from that
  checkout's `server.js` and `os-backend/src/mapping/os_repo.js`.
