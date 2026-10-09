# Replacing the legacy server.js: what is left

Once the endpoints below exist, legacy's `server.js` can be switched off: every piece of data it
stores has a home here, behind a domain endpoint. This replaces the *data* its generic routes carry
(`/api/load`, `/api/save`, `/api/v1/:resource`, `/api/v1/_batch`, about 50 resources), not the
routes. What exists is in `README.md`; this lists only what is still to build. Paths are proposals,
settled when built.

**Next:** bookings priced by the server (`pricing-model.md`, step 5), booking extras (4), the rest of sales (6), vans (8), money (7).

**This list was derived from `operation_frontend`, which is not production.** Re-derive it from
wt-lk-inbox's `server.js` and `os-backend/src/mapping/os_repo.js`.

## 1. Identity and system

Built: login and users, the change feed (`/v1/changes`, replacing `/api/version` and `/api/events`).

## 2. Catalogue: routes, boats

Built: routes, families, boats (the whole form, documents, status log, retire), a boat's seats for
one day (README "Editing routes", "Editing boats"). Left: meal venues, with costing
(`catalogue-editing-model.md`).

## 3. Operations

Built: weather closures (`/v1/weather-closures`, legacy `sb_weather` and `bk.weatherResolve`).

## 4. Bookings

Built, attachments included (`/v1/attachments`, replacing `/api/attach*`).

## 5. Seat locks

Built (migration 048, README "Agent seat locks"), the log included. Left: creating and converting
whole-boat holds, their own design (not written yet; the pool side is migration 047).

## 6. Sales: agents, prices, contracts

```
POST   /v1/contracts, PATCH /v1/contracts/{id}           (contracts-model.md)
staff and welfare quotas; sales targets                 (sales-editing-model.md)
```

Built: agents, programmes, rate type, renewal, (de)activate, templates, issued documents, salespeople,
markets, the add-on catalogue, nationalities, insurance (README → "Agents" to "Nationalities").

## 7. Money

Designed in `money-model.md`: invoices and payments, proforma, pier money and on-tour sales
(`sb_extras`), cash-on-tour decisions (`ts_cot`), no-show charges (`travel_sum`), partner van bills,
reports. `sb_market_stats` / `sb_market_monthly` are imported arrival figures, not money.

## 8. Pickups and vans

Built: pickup areas and times, vans and the month matrix, van groups and stops, dispatch, check-in
(README → "Dispatch" to "Pickup areas and pickup times"). Open items in `trip-ops-and-vans-model.md`.
Built too: the van job orders, with the sent tick, special requests, Thai pickup names and the
group order (README "Van job orders"; open items in `van-job-orders-model.md`). Still to come: the
computed van board for the Vue port.

## 8b. Pier office

Built: petty cash per pier (`po_cash_rows`, `po_cash_lt`, `po_cash_pk`, `po_cash_co`) and the office
lists (`pier_kinds`, `pier_items`, `pier_codes`, `pier_sect`, `pier_lic_types`, `pier_lic_classes`,
`pier_staff`): README "Pier office". Left (`pier-office-model.md`, Open): `pier_moves`, `pier_sheet`,
`pier_shift`, `pier_duty`, `pier_job`, `pier_team`, `pier_licenses`, `pier_cfg`, and the petty cash
sheets' booked side.

## 9. Fleet maintenance

Built (`todo/fleet-maintenance-model.md`; README "Fleet maintenance", three sections): assets,
incidents, jobs (part A); stock, consumables, memos, projects, the Daily Fleet Log, safety (part B);
pier assignments (`boats__assignments`), certificate status and renewal (`boats__docs`), the safety
replace wizard, the fuel budget (`fleet_fuelbudget`), the cost, upkeep and fuel reports, the dashboard
and the repair history (`boats__repairhistory`, computed from done jobs; legacy's rows not imported).

Still to give a home: Fleet Insights and the Fleet Report (computed reads; the rules to use are a
question), and the Fleet Deployment planning board (browser-only drafts, decided to stay out).

## Not replaced

- **Whole-state data routes:** `/api/load`, `/api/save`, `/api/v1/:resource`, `/api/v1/_batch`.
- **Cookie login:** `/api/login`, `/api/logout`. Replaced by `POST /v1/login` and Bearer tokens.
- **Browser-side state:** `_app_hooks`, `nat_learn` (a nationality-guessing cache).

## Open

- **The B2C booking sync** (`/api/b2c/raw`, `/reset`, `/health`): do we take it over?
  (`/v1/availability` already accepts Love Kingdom's `X-Api-Key`.)
- **Email images** (`/api/mailimg`, `/m/:id`) look like marketing, not operations. Confirm they can go.
- **Resources mapped from field names only.** Check with someone who uses the screens:
  - `trips`: looks like the old per-day boat board, which deployments replace.
