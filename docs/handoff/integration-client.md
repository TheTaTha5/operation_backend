# Handoff: the integration client (allotment_v2 on operation-backend)

*Written 2026-10-08, from operation-backend `main` (`aba06d7`) and the integration worktree at
`39ff405`. For the agent working in the legacy repo.*

- **Where you work:** `D:\projects\wt-operation-backend-integration`, branch
  `integration/operation-backend`, repo `LOVE_Andaman_Workspace`. Almost all of it is in
  `allotment_v2/js/ops/*.js` (the layer that talks to operation-backend), plus a few legacy
  functions it wraps.
- **The API you talk to:** operation-backend (`D:\projects\operation-backend`). Its contract is in
  its `README.md` and live at `/docs` (Swagger). **Do not change the API from the client side.** If
  the client needs something the API lacks, write it down and ask.
- **The rule for the screens:** the rebuild keeps legacy's UI and UX identical: same screens, flows,
  buttons, dialogs and messages. Only where the data comes from changes. If a server rule makes a
  screen behave differently, say so rather than redesigning the screen.

## Status

**Bookings work end to end** since `39ff405` ("Bookings: the server decides the status, through its
commands"), checked against a local operation-backend in 12 scenarios:

| Action | What the client does |
|---|---|
| Create | `POST /v1/bookings` with `intent` (`quote` for Save draft, `confirm` for Submit); never sends `bookedAt`, `createdBy`, `confirmedAt`, `confirmedBy`; sends `focReason` |
| After any save | takes `status` and those four stamps from the response; a toast says when the server decided differently |
| Edit | `PATCH` without `status`; Submit on a booking the server holds as a quote then calls `POST /{id}/confirm` |
| Approve / reject / FOC approve / FOC reject | `POST /{id}/approve` or `/reject`, with the typed reason as `note` |
| Weather cancel | `POST /{id}/cancel-weather` |
| Cancel, restore, partial cancel, reschedule | already used the commands (`af03e95`) |
| Refresh | keeps `adjustments` (the server does not store them yet) |
| Approve past the licence | its own toast: `r5 2045-11-19: 3 over · add a boat before the trip` |

**Not done:** the six steps below.

## Run it locally

From `D:\projects\operation-backend`, on `main`:

```bash
docker compose up -d --build                  # API :3000, this app :8791, PostgreSQL :55433
docker compose --profile pull run --rm pull   # copy Railway's and legacy's data in (optional)
```

- **The app:** http://localhost:8791/allotment_v2/allotment_v2.html. Log in as `admin` / `admin`.
- **Edits show on reload.** The worktree is mounted read-only into the container. A change to
  `server.js` needs `docker compose restart integration`.
- **It runs as deployed:** `LA_LEGACY_SYNC=false`, `OPS_BACKEND_URL=http://localhost:3000`.
- **A token for curl:** `POST localhost:3000/v1/login {"username":"admin","password":"admin"}`. Every
  API call needs `Authorization: Bearer …`.
- **The data is a copy:** writing to the local database is safe. Reset it with
  `SKIP_DUMP=1 docker compose --profile pull run --rm pull`.

## Steps, in order

Each step names the code, what to change, and when it is done.

### 1. Approvals come from the server

**Why.** The server records every approval in `approvals` on each booking (`kind` `approval` or `foc`,
`status`, `over_capacity`, `days`, `decided_by`, `note`, …). The client still builds its own
`bk.approval` / `bk.focApproval`: `bookingV2EnsureApproval` (`booking/bookingV2EnsureApproval.js`)
invents a pending one when missing, and `mergeInto` (`ops/40-ops-bookings.js`) keeps the local copy
over the server's.

**Seat counts are already wrong because of it.** `bkPendHoldsSeat` (`04-data-core.js:10179`) counts a
`pending_approval` booking as holding seats unless its local `approval.over` says it is over
capacity. A booking that arrives from the server has no `approval.over`, so the browser counts its
seats while the server does not. That shows a fuller day than the server sells against.

**Change.**
- In `fromServer`, map the latest pending (or else latest) `approvals` entry of each kind into
  `bk.approval` / `bk.focApproval`, in the shape the screens read.
- Set `approval.over` from `days`, so `bkPendHoldsSeat` gives the server's answer.
- Stop `mergeInto` keeping the local `approval` / `focApproval` over the server's.

**Done when** a booking the server made `pending_approval` shows the same approval panel and the same
seats-left number as one legacy made, after a reload.

### 2. Settings → Programs writes the calendar

**Why.** The route calendar is now edited in operation-backend, and only there: `sync:routes` no longer
copies it from legacy. Today the screen edits the local `ROUTES` only, and `save('config')` is
dropped, so an edit seems to vanish on reload.

**The API:**
- `POST /v1/routes/{id}/seasons {kind, from_date, to_date}` adds a season and answers it with its
  `id`.
- `DELETE /v1/routes/{id}/seasons/{season_id}` deletes one.
- `PUT /v1/routes/{id}/days/{date} {kind}` sets a day override.
- `DELETE /v1/routes/{id}/days/{date}` clears it.
- `GET /v1/routes` carries each route's `seasons` (with ids) and `overrides`.

A change that closes a day holding bookings or a deployed boat is `409` with
`code: "bookings_on_closed_day"` and a message listing them. Send it again with `close_anyway: true`
(a query parameter on `DELETE`).

**Change.**
- In `mapRoute` (`ops/10-ops-catalogue.js:56`), fill `r.seasons` (`kind` → `type`, `from_date` →
  `from`, `to_date` → `to`, keep `id`) and `r.overrides` (`{date: kind}`) from the server.
- Wrap `saveNewSeason` (`04-data-core.js:11291`), `delSeason` (`:11450`) and `toggleDayOverride`
  (`:10434`) to call the endpoints, the same server-first way as the booking actions. Legacy's
  toggle maps to `PUT` with the opposite of the current status, or `DELETE` when an override exists.
- On `bookings_on_closed_day`, show the existing impact modal (`progShowImpactModal` `:11370`,
  `progShowImpactModalForDay` `:10493`). "Close anyway" resends with `close_anyway`. The error's
  `code` is on the thrown `LaOpsError` (`ops/00-ops-core.js:36`).
- Overlapping seasons are allowed, as in legacy; the one that starts first decides.

**Done when** adding, deleting and toggling survive a reload, and closing a booked day asks first.

### 3. The closed-day check looks only at changed trips

**Why.** The server refuses a closed day only for trips a save adds or moves (`409 route_closed`). An
untouched trip whose day closed after the sale still saves, so its notes can be edited. The browser's
guard (`booking/bookingV2CommitBooking.js:122`, "non-operating guard") blocks every save of such a
booking, so the server's lighter rule never shows.

**Change.** Check only trips that are new or whose route or date differs from the stored booking.
Keep the B2C exception: a `b2c_` booking only warns, and the server saves it too.

**Done when** a booking on a day closed after the sale can have its notes saved, and moving a trip
onto a closed day is still blocked.

### 4. Land routes come from the server's `kind`

**Why.** `GET /v1/routes` returns `kind` (`marine` or `land`), but `mapRoute` drops it.
`laRouteKind` (`04-data-core.js:60`) already prefers `r.kind` when it is set, and falls back to the
pier otherwise.

**Change.** `put(o, 'kind', s.kind)` in `mapRoute`.

**Done when** `laIsLandRoute` agrees with the server for every route.

### 5. Read `unlimited` and `unplaced_pax`

**Why.** Every capacity read (`/v1/availability`, `/operations/allotment`, `/v1/manifest`) now says:
- **`unlimited: true` with `available_seats: null`** on a land route. It has no seat limit, and a
  booking or lock is never refused for seats.
- **`unplaced_pax`** on a marine day with no boat yet. That day sells without a seat check, as
  legacy's `hasAllotment: false` does, and `unplaced_pax` counts the passengers and locked seats
  waiting for a boat.

`apply` (`ops/50-ops-availability.js:79`) turns `null` into 0 and can mark the day full.

**Change.**
- When `s.unlimited`, give the allotment legacy's "no limit" shape (`hasAllotment: false`), never
  `isFull`.
- Show `unplaced_pax` wherever a no-boat day is shown, if the screen has a place for it.

**Done when** a land booking of any size saves, and its day never shows as full.

### 6. A refused restore keeps the fee invoice

**Why.** `bookingV2RestoreBooking` (`booking/bookingV2RestoreBooking.js:11`) voids the
cancellation-fee invoice *before* the server answers. The wrapper's `putBack` restores the
booking but not invoices. A restore can now be refused for a closed day (`route_closed`), which
makes this more likely.

**Change.** Void the invoice only after `/restore` succeeds, or put it back on refusal.

**Done when** a refused restore leaves the invoice as it was.

## Rules and gotchas

- **Others' work is in the same worktree.** `allotment_v2/js/01-auth-sync.js` and `server.js` have
  uncommitted changes that are not yours. Commit only your files, by path.
- **Never send server-decided values:** not the four stamps, and not `status` on a `PATCH`. A status
  changes only through a command, and a `PATCH` with a different status is `400`, naming the command
  to use. Prices are the one temporary exception: the client still sends `total` and the price
  fields until the server can price a booking (`POST /v1/quote`).
- **Who did it is the login.** The name legacy prompts for when approving is not sent; the server
  records the token's user. Reasons go in `note`.
- **Show the server's message as it is.** Errors are `{ statusCode, code, error, message }`, and the
  message is written for staff. `O.fail` already shows it.
- **A create resent with the same `external_id`** (a retry after a timeout) is `409` with
  `code: "duplicate_external_id"` and the existing booking's id in the message. Nothing is written
  twice. Read that booking instead of creating it again.
- **Commit style** in this repo: one sentence saying what changed for the user, then a `(§tag)`, e.g.
  `Bookings: the server decides the status, through its commands (opsAuthority)`. Mark code with the
  same `§tag` and a date in comments.

## How to check a step

A harness that loads `ops/40-ops-bookings.js` in Node with stubbed legacy functions, and drives it
against the local API, verified the booking work (see `39ff405`'s message). For steps 1–6, a manual
run in the app at :8791 is the real check. Write down what you clicked and what the server answered.
