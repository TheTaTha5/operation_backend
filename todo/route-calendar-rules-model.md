# Closed days, land routes and calendar writes, modelled

- **Source:** wt-lk-inbox@658298d — `04-data-core.js` `getDayStatus`, `laIsLandRoute`, `getAllotment`,
  `saveNewSeason`, `delSeason`, `toggleDayOverride`; `08-app.js` `bkV2IsRouteOpenOn`,
  `bkV2CommitBooking` (§non-operating guard), `bkV2SetTripField`, `bkV2RescheduleBooking`,
  `bkV2RestoreBooking`; `server.js` `/api/b2c/availability`.
- **Already here:** `routeCalendar` (`src/domain/calendar.ts`) is `getDayStatus` exactly, including
  "outside every open season is closed". `route_seasons`, `route_day_overrides` (005), synced by
  `sync:routes`. Read-only on `GET /v1/routes?from&to` and as `open` in availability. **No write
  checks the calendar, and there is no write API for it.**

## 1. Booking a day the route does not run

**Legacy.** `bkV2CommitBooking` refuses a save with any trip on a closed day (hard block). Two holes:
it blocks *every* save of such a booking, even a notes edit when the day closed after it was sold;
and reschedule and restore never check the calendar (or capacity). B2C bookings with their own
price only get a warning, because they were already paid when legacy synced them.

**Proposal** (validated):

| Write | Checked | Answer when closed |
|---|---|---|
| `POST /v1/bookings` | every trip | `409 route_closed`: `Route r3 does not run on 2027-01-04` |
| `PATCH` | only trips added or moved (new route or date) | same |
| `/reschedule` | the new date | same |
| `/restore` | every trip | same |
| `POST /v1/seat-locks` | its day | same |
| `/confirm`, `/approve`, header-only edits | not checked | — |

One pure function, `assertRouteOpen(calendar, trips)`, next to `routeCalendar`; both stores read the
seasons and overrides they already hold.

## 2. Land routes

**Legacy.** A land route's ceiling is `route.dailyCap`; unset or 0 means **no gate at all**. Over
the cap is never refused: it goes to `pending_approval`. Every legacy row has `dailyCap` empty
(migration 021 dropped the column for that reason), so **in practice legacy sells land routes
unlimited.** Here every land booking is `409` (no boats, so no seats).

**Proposal:** a land route has no seat pool. Its trips are accepted without a capacity check and
hold nothing; availability answers `available_seats: null` with `unlimited: true` for it.
`daily_cap` comes back (nullable, `NULL` = unlimited) only when someone needs a cap.

## 3. A marine day with no boat deployed

**Legacy** skips the seat gate entirely (`hasAllotment` false), so staff can sell a day before the
boats are assigned. **Here** it is `409` (the registered seats are 0).

## 4. Writing seasons and day overrides

**Legacy.** Settings → Programs. A season is `{type: open|closed, from, to}`, added or deleted (never
edited); an override is `{date: open|closed}`, toggled. Closing a season or a day shows the bookings
it affects ("Close anyway"). Gaps: overlapping seasons are allowed and the earliest wins silently;
adding an open season or deleting one skips the impact check though either can close dates; a day
on a route with no season can never be closed by clicking. Area `config`, enforced only in the
browser.

**Proposal** (validated; who may: the `config` area, `todo/login-permissions-model.md`):

- `POST /v1/routes/{id}/seasons` `{type, from, to}` → `201`; `DELETE /v1/routes/{id}/seasons/{season_id}`.
- `PUT /v1/routes/{id}/days/{date}` `{status: open|closed}`; `DELETE` removes the override.
- `400`: `from > to`, bad dates, bad type. `409 season_overlap` when it overlaps another season.
- **Impact:** any change that closes a date that holds bookings is `409 bookings_on_closed_day` with
  the bookings it would strand, unless the body carries `"close_anyway": true` — legacy's dialog,
  as an API. Checked for every change that can close a date, not only the two legacy checks.

**Catch:** the catalogue is not cut over. `sync:routes` copies legacy's seasons over ours, so a
season written here is overwritten by the next sync. The write API is useful only once the
catalogue's master moves here.

## Questions

1. **The B2C exception** (warn, don't block, for an already-paid B2C booking): copy it? Recommended:
   no. Love Kingdom books here before payment (lock, then book), so it can be refused in time.
2. **Closed day on an untouched trip:** check only added or moved trips (recommended), or block
   every save like legacy?
3. **Reschedule and restore:** check them (recommended), unlike legacy?
4. **Land routes unlimited** as legacy actually runs them (recommended), or a cap?
5. **Marine day with no boat:** copy legacy and accept the booking ungated (staff sell before boats
   are assigned), or keep refusing? Ungated means it holds no counted seat and cannot oversell a
   boat that does not exist yet; the risk is selling a day no boat is ever put on. Recommended:
   copy legacy, and list such bookings on the availability response (`unplaced_pax`).
6. **Overlapping seasons:** refuse (recommended), or allow with earliest-wins like legacy?
7. **Calendar writes now, or at the catalogue cutover?** Recommended: at the cutover, with sync
   stopped for seasons in the same change.

## Checked against the integration client — 2026-10-08

Read against `wt-operation-backend-integration` (`integration/operation-backend`, `50c41ae`). The
legacy description above holds for that branch too, apart from renames (`bkV2*` → `bookingV2*`,
moved into `js/booking/`). The client already shows a refusal's `message` in a toast and puts the
local change back, so a `409 route_closed` needs no new screen. Its message is shown to staff as is.

**Additions to the proposal:**

1. **Proposal 3 covers seat locks too.** Legacy treats a day with no boat as "no limit" for a lock
   (`booking/bookingV2LockFreeOn.js:5`), and the client syncs locks before every booking save
   (`ops/40-ops-bookings.js:220`). If only bookings are accepted, the lock `POST` is still `409` and
   the whole save rolls back, so selling before boats are assigned still fails.
2. **Land "unlimited" applies to every capacity read:** `/v1/availability` (day and range),
   `/operations/allotment` and `/v1/manifest`. The client reads all three.
3. **Who decides "land".** `GET /v1/routes` returns `kind`, but the client's `mapRoute` drops it
   (`ops/10-ops-catalogue.js:56-63`) and decides land itself from `dailyCap`, which is always
   empty. The client must take `kind` from the server, or the two disagree.
4. **Question 2 needs a client change to be seen.** The browser blocks every save with a closed
   trip (`bookingV2CommitBooking.js:122-128`), so the lighter server rule is invisible until the
   browser's guard is narrowed the same way. A trip without `opsTripId` looks "added".

**Client follow-ups found (legacy repo, not this note's scope):**

- A refused `/restore` leaves the cancellation-fee invoice voided: the browser voids it before
  asking the server, and `putBack` does not restore it (`bookingV2RestoreBooking.js:11`).
- Settings → Programs edits only the local copy, and the server's calendar replaces it on screen,
  so an edit seems to vanish. Until the catalogue cuts over, that screen should say it is read-only.

**Where the proposal makes a screen behave differently from legacy** (`CLAUDE.md`, "Same screens,
new data"; each is the developer's call):

| Item | Legacy screen | With the proposal |
|---|---|---|
| Q2 untouched trips | a notes edit on a booking whose day closed is blocked | allowed (needs the client guard narrowed) |
| Q3 reschedule / restore | never refused for a closed day | refused, with the server's message |
| Q1 B2C exception | a B2C booking on a closed day saves with a warning | refused |
| Q6 overlapping seasons | saved, earliest wins silently | refused (only once writes exist, Q7) |
| Q7 Settings → Programs | editable | read-only until the catalogue cutover |
| P2 land routes, P3 no boat | saves | saves; no change from legacy (refused here today) |
