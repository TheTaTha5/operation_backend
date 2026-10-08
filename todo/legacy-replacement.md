# Replacing the legacy server.js: what is left

Once the endpoints below exist, legacy's `server.js` can be switched off: every piece of data it
stores has a home here, behind a domain endpoint. This replaces the *data* its generic routes carry
(`/api/load`, `/api/save`, `/api/v1/:resource`, `/api/v1/_batch`, about 50 resources), not the
routes. What exists is in `README.md`; this lists only what is still to build. Paths are proposals,
settled when built.

**Next:** login and permissions (`login-permissions-model.md`, waiting for approval). After that:
pricing (`POST /v1/quote`), booking extras (4), the rest of sales (6), vans (8), money (7).

**This list was derived from `operation_frontend`, which is not production.** Re-derive it from
wt-lk-inbox's `server.js` and `os-backend/src/mapping/os_repo.js`.

## 1. Identity and system

```
GET    /v1/me                  caller identity + permissions (replaces /api/me, /api/users*)
GET    /v1/changes?since=      what changed since version N (replaces /api/version, /api/events; change-feed-model.md)
```

## 2. Catalogue: routes, boats

```
POST   /v1/routes
PATCH  /v1/routes/{id}
PUT    /v1/routes/{id}/times          departure times
POST   /v1/boats
PATCH  /v1/boats/{id}
PUT    /v1/boats/{id}/capacity-overrides/{date}      one day's seats (legacy boat_capovr)
DELETE /v1/boats/{id}/capacity-overrides/{date}
```

## 3. Operations

```
GET    /v1/weather-closures?from=&to=
POST   /v1/weather-closures           close a route on a date, flag affected bookings (legacy sb_weather)
DELETE /v1/weather-closures/{id}
```

## 4. Bookings

```
PUT    /v1/bookings/{id}/adjustments  price adjustments, upgrades (booking-model.md)
GET    /v1/bookings/{id}/attachments  (replaces /api/attach*)
POST   /v1/bookings/{id}/attachments
GET    /v1/attachments/{id}           download one file
DELETE /v1/attachments/{id}
```

## 5. Seat locks

```
GET    /v1/seat-locks/{id}/log
```

## 6. Sales: agents, prices, contracts

```
POST   /v1/agents, PATCH /v1/agents/{id}, PUT /v1/agents/{id}/programs        (agents.md)
POST   /v1/agents/{id}/deactivate, /v1/agents/{id}/activate
PUT    /v1/agents/{id}/rate-bindings
GET    /v1/contracts, POST /v1/contracts, PATCH /v1/contracts/{id}
GET    /v1/contract-templates, PUT /v1/contract-templates/{id}
GET    /v1/add-ons                    add-on catalogue (legacy sb_extras)
GET    /v1/nationalities
GET    /v1/insurance-overrides, PUT /v1/insurance-overrides/{date}
```

## 7. Money

```
GET    /v1/invoices, GET /v1/invoices/{id}, POST /v1/invoices, PATCH /v1/invoices/{id}
POST   /v1/invoices/{id}/void
GET    /v1/payments?booking_id=, POST /v1/payments
GET    /v1/reports/market-stats?from=&to=    computed from bookings, not stored
```

## 8. Pickups and vans

`trip-ops-and-vans-model.md` owns the detail.

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

## 9. Fleet maintenance (scope undecided)

Each gets `GET` list, `GET /{id}`, `POST`, `PATCH /{id}`, `POST /{id}/log`:

```
/v1/fleet/engines   /v1/fleet/gearboxes   /v1/fleet/propellers
/v1/fleet/maintenance   /v1/fleet/incidents   /v1/fleet/safety
/v1/fleet/inventory   /v1/fleet/projects   /v1/fleet/memos
GET/POST /v1/fleet/consumable-logs,   GET/PUT /v1/fleet/fuel-prices/{date}
GET/POST /v1/boats/{id}/documents,    GET /v1/boats/{id}/repair-history
```

## Not replaced

- **Whole-state data routes:** `/api/load`, `/api/save`, `/api/v1/:resource`, `/api/v1/_batch`.
- **Cookie login:** `/api/login`, `/api/logout`. Login moves here as Bearer tokens
  (`login-permissions-model.md`).
- **Browser-side state:** `_app_hooks`, `nat_learn` (a nationality-guessing cache),
  `agent_artifacts`.

## Open

- **Is fleet maintenance ours?** Section 9 may belong in a separate service.
- **The B2C booking sync** (`/api/b2c/raw`, `/reset`, `/health`): do we take it over?
  (`/v1/availability` already accepts Love Kingdom's `X-Api-Key`, branch
  `feat/availability-api-key`.)
- **Live updates:** `change-feed-model.md`.
- **Permissions:** `login-permissions-model.md`.
- **Email images** (`/api/mailimg`, `/m/:id`) look like marketing, not operations. Confirm they can go.
- **Resources mapped from field names only.** Check with someone who uses the screens:
  - `trips`: looks like the old per-day boat board, which deployments replace.
  - `ts_cot` (`mode`, `deduct`, `payout`): looks like agent commission.
  - `travel_sum` (`decision`, `amount`, `note`): looks like an approval record.
  - `fleet_drlock`: not identified.
