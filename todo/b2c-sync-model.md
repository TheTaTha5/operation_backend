# B2C sync health, legacy read

**Status:** legacy read (wt-lk-inbox@658298d, 2026-10-09); not designed yet.

In short: Love Kingdom sends legacy nothing. Legacy's server **pulls**: it reads Love Kingdom's
database directly, every 45 s and on every page load, and upserts each order's boat lines as
`b2c_<LOV-id>_<n>` bookings. `/api/b2c/health`, `/raw` and `/reset` watch, inspect and rebuild that
pull. This API already has the other model: Love Kingdom **pushes** bookings to
`POST /v1/bookings` (`docs/love-kingdom-integration.md`). So the main decision is whether the pull
moves here at all.

## What legacy does

### The pull (`server.js` `relSyncB2C`, mapper `b2c-map.js`)

- **Source:** `B2C_DB_URL`, schema `B2C_SCHEMA` (`love_kingdom`). It reads:
  - `bookings`, `booking_items` (falling back to `bookings.items[]`), `customers`, `b2c_channels`;
  - the view `v_booking_passengers`, else `bookings.passengers`;
  - `program_own_addons` for add-on names;
  - `programs_own.ops_route_id` and `transfer_services` for routes;
  - legacy's own `routes.extid`.
- **When:**
  - a background poll every `B2C_POLL_MS` (45 s);
  - on every `/api/load` (one full run at a time, `relSyncB2CShared`, after load storms filled the
    pool on 2026-09-11);
  - per order on `LISTEN booking_changed` (a `pg_notify` from Love Kingdom's database).
- **Window:** items with a travel date from 90 days ago on (`B2C_SYNC_DAYS_BACK`), at most 20,000
  rows (`B2C_SYNC_MAX_ROWS`; past the cap the last order is dropped whole and a warning logged).
- **Fast path:** a SHA-1 of the source rows, passengers, catalogues and `B2C_MAP_VER` (32) is kept
  in `app_state` (`b2c_sync_hash`). If unchanged, nothing is written.
- **Write**, one transaction:
  1. upsert `sb_bookings`. Only B2C-owned columns are overwritten (`B2C_OWN_BK`, an allow-list:
     lead details, status, total, notes, pickup/drop-off text, payment snapshot…).
     - A column listed in the booking's `b2coverride` keeps ops' value; money never does.
     - Status is sticky: an ops cancel or rejection survives; a B2C cancel comes through; an
       ops-approved booking keeps its status.
  2. replace trips, restoring every `ops_*` column, a hand-typed Thai/foreign count, and an upgraded
     trip's route;
  3. replace passengers and add-ons (B2C is the source);
  4. cancel lines that left an order still present;
  5. **oversell net:** on a route/day with boats deployed, B2C bookings past the seats (after locks)
     go `confirmed` → `pending_approval`, newest first;
  6. **closed-day net:** a B2C booking on a closed day goes to `pending_approval`. Season closures
     are flagged on every run; a per-day override only for sales new in this run. Weather closures
     (`sb_weather`) are **not** checked.
  
  Then it bumps the version and pushes SSE so every tab reloads.
- **Order deleted in Love Kingdom:** only the per-order `NOTIFY` path cancels its lines; a full run
  never does.

### Health (`B2C_HEALTH`, `b2cHealthReport`)

- In memory, per server process:
  - last success, last failure;
  - consecutive failed runs, with the error message and the failing phase (`upsert sb_bookings`,
    `oversell flag`…);
  - the post-import issues.
- **`ok`** = fewer than 3 consecutive failed runs (about 2 min) **and** a success within 10 minutes
  (`B2C_STALE_MS`; "a query that hangs instead of throwing"). A deployment with no B2C source
  reports `{configured: false, ok: true}`.
- **Post-import checks** (`b2cCheckOrders`, §b2cCheck 2026-10-03), report only, never fail a sync.
  Warnings:
  - `nat_unread` (nationality text not understood);
  - `route` (no route found);
  - `date`, `pax0`;
  - `nat_mix` (all priced Thai but foreigners on board);
  - `money_parts`, `money_total`, `money_order` (imported more than the customer paid).
  
  Info: `not_imported`, `pickup_area`.

### Endpoints

| Endpoint | Auth | What it does | Who calls it |
|---|---|---|---|
| `GET /api/version` | session | carries `b2c` (health minus the issue list) with the data version, `mig`, `map`, `db` | every legacy tab, every 10 s |
| `GET /api/b2c/health` | none; logged-in callers also get `message`, `phase`, `issues` | the report; **`200` healthy, `503` not** (issues never cause `503`) | uptime monitors; the issues panel when opened |
| `GET /api/b2c/raw?id=LOV-…` | session | for one order: the raw `booking_items`, `booking`, `customer`, passengers and what the mapper makes of them | developers (no UI); used for `docs/B2C_LONGTAIL_ADDON.md` |
| `POST /api/b2c/reset` | session (any user) | deletes **every** `b2c_` booking and its child rows (trips, passengers, add-ons, adjustments, fee items, history, over, partial cancels, upgrades), runs a full sync, bumps the version | nobody in the UI; a manual POST |

Other `/api/b2c/*` routes are Love Kingdom calling legacy with `X-Api-Key`: `availability`,
`routes`, `rate`. They belong to the catalogue and rate notes (`catalogue-editing-model.md`,
`rate-types-model.md`); this API already serves availability (README "Love Kingdom's API key").

### In the browser (`01-auth-sync.js`)

- **Red bar** at the bottom (`_laB2CHealth`) when `b2c.ok` is false: "ดึงข้อมูล B2C ไม่ได้" with
  why (never succeeded / last success n min ago / n failures in a row) and the phase. Not
  dismissible on purpose: "bookings are still being taken on the website".
- **Orange panel** (`_laB2CIssues`): "ใบ B2C ที่ต้องเช็ค n รายการ".
  - Opening it fetches `/api/b2c/health` for the list; each item links to the booking.
  - Dismissible until the set of issues changes (`issueSig` in `localStorage`).
- **New-booking toast** (`_laB2CScan`, `_laB2CAlert`): on each refresh, compares `b2c_` ids with the
  ones seen before and shows a card with a beep. The card has ref, route, pier, date, pax, total,
  lead and paid state, plus a link to the By-trip tab. Nothing on first load.
- No permission check beyond being logged in: anyone sees the bar and panel.

### What Love Kingdom "sends"

- Nothing over HTTP. It gives legacy read access to its database. It is meant to fire
  `pg_notify('booking_changed', <order id>)`: the function `public.notify_booking_change` exists in
  the shared database, but **no trigger calls it** (2026-10-09), so the per-order push is dead and
  the 45 s poll does all the work.
- In the other direction, Love Kingdom reads the ops database directly too
  (`server/ops-routes.js`, `OPS_DATABASE_URL`, view `v_seat_availability`), and calls legacy's
  `/api/b2c/availability`.
- The target is `docs/love-kingdom-integration.md`: `POST /v1/bookings` with `external_id`
  `LOV-…`, seat locks while the customer pays, `PATCH`, `/cancel`.

## How legacy stores it

- Synced bookings are ordinary `sb_bookings` rows, id `b2c_<order>_<line>`, agent `a_b2c`.
  - `b2coverride` (JSON text, the columns ops took over);
  - `voucherref` (the order id);
  - `paymentsnapshot_*` (Love Kingdom's paid state).
- `allotment.app_state` row `b2c_sync_hash`: the last source hash (last changed 2026-10-09
  06:01 UTC).
- Health and issues: **memory only**. Lost on restart, not shared between instances.

## Data (2026-10-09)

- **564 `b2c_` booking rows from 481 orders**, created 2026-07-04 → 2026-10-09; agent `a_b2c` on
  561, none on 3.
  - Statuses: confirmed 440, cancelled 112, rejected 9, quote 2, pending_approval 1.
  - `approval_status`: approved 29, rejected 9.
- 63 more `a_b2c` bookings are not `b2c_` rows (keyed in by staff).
- `b2coverride` set on 133 rows. Most often `["hotelname","dropoffhotelname"]` (48) and
  `["hotelname","pickuparea","dropoffhotelname"]` (38).
- 9 rows are test orders `b2c_BK-001…003` (3 still confirmed, on 2026-07-04, 07-06, 11-20).
- **Love Kingdom has 454 orders.**
  - 35 legacy B2C rows belong to orders that no longer exist there. **6 are still confirmed**, 2 of
    them in the future (`b2c_BK-002_1` 2026-11-20, `b2c_LOV-8161340_1` 2026-12-23): they hold seats
    for orders that are gone.
  - 2 Love Kingdom orders have no legacy row: a hotel-only order, and a day trip with no travel
    date.

## Already here

- `docs/love-kingdom-integration.md`: the push contract (service user for `a_b2c`, `POST
  /v1/bookings` with `external_id`, `intent`, seat locks, cancel, `duplicate_external_id` on
  retry). It replaces the pull.
- `GET /v1/availability` accepts `X-Api-Key` (`B2C_API_KEY`), as legacy's `/api/b2c/availability`.
- B2C price authority:
  - a booking with an external id `b2c_…` or agent `a_b2c` keeps the price sent (CLAUDE.md;
    README "Prices");
  - a `b2c_…` booking is saved on a closed day (README "Closed days", `isLegacyB2C`);
  - `LOV-…` bookings are checked like any other.
- The legacy import mirrors `b2c_` rows like any booking; imported approvals may carry reason
  `b2c_hold`.
- The change feed's `health` carries `migrations_pending`; `change-feed-model.md` 4 says "B2C sync
  health joins `migrations_pending` when the sync moves here".
- `legacy-replacement.md` "Open": "The B2C booking sync (`/api/b2c/raw`, `/reset`, `/health`): do we
  take it over?"
- Nothing here reads Love Kingdom's database.

## Bugs or oddities in legacy

1. **The per-order push is dead**: no trigger calls `notify_booking_change`, so a change waits for
   the next poll (≤ 45 s) and a deleted order is never cancelled.
2. **Deleted orders keep their seats**: 6 confirmed rows whose order is gone (above). A full sync
   only cancels missing *lines* of orders still present.
3. **`/reset` loses data**:
   - it deletes every `b2c_` row and its ops data (history, upgrades, adjustments, partial cancels,
     check-in on trips);
   - the re-sync brings back only travel dates from 90 days ago, so older B2C bookings are gone for
     good;
   - any logged-in user can call it.
4. **Health lives in one process's memory**: a restart shows "never succeeded" until the next run;
   two instances could disagree.
5. **Writes bypass the capacity guard**, then repair after the fact (oversell and closed-day nets
   set `pending_approval`). Weather closures are not checked at all.
6. **`/api/b2c/health` is unauthenticated** (intended for monitors). It hides the message but shows
   counts and timings.
7. **Ownership by column list** (`B2C_OWN_BK` + `b2coverride`) is subtle: a new B2C field is silently
   not updated until someone adds it to the list.
8. **Test orders `BK-001…003`** live in production data, 3 still confirmed.

## Questions for the developer

1. **Port the pull, or require the push?** *Recommend: do not port it. Love Kingdom books through
   `POST /v1/bookings` (already documented). Then `/raw`, `/reset`, the hash, the nets and the
   column-ownership rules disappear: capacity and closed days are checked before the write. Breaking
   for Love Kingdom; it ships on both sides together.*
2. **Until Love Kingdom pushes, what feeds B2C bookings here?** Today the legacy import mirrors
   legacy's `b2c_` rows. *Recommend: keep that until bookings cut over, and make the push a
   condition of the bookings cutover.*
3. **Health in a push world:** the failure to watch moves to Love Kingdom's side (its calls failing).
   *Recommend: Love Kingdom alerts on its own failed calls. Here, add a cheap reconciliation read
   instead: `GET /v1/bookings?agent_id=a_b2c&updated_since=` for Love Kingdom to compare. The red
   bar becomes Love Kingdom's job. Ask whether ops still want a "B2C stale" signal in `health`
   (e.g. no `a_b2c` booking in n hours is normal at night, so probably not).*
4. **The post-import checks:** in a push, most become `400`s on create (unknown route, no date,
   pax 0, unknown nationality code). *Recommend: refuse those. Keep `nat_mix` and the money
   mismatches as `warnings` on the response, since the price is Love Kingdom's.*
5. **The new-booking toast:** *Recommend: the change feed already announces a created booking with
   `changed_by` (Love Kingdom's service user). The client filters on that; nothing to add.*
6. **Ops edits to a Love Kingdom booking** (legacy's `b2coverride`: hotel, pickup area, notes): who
   wins when both edit? *Recommend: with the push, the booking's `version`/`If-Match` decides, and
   Love Kingdom must re-read before `PATCH`. Ask Love Kingdom whether they will ever overwrite fields
   ops corrected; if yes, list the client-fact fields each side owns in the integration doc.*
7. **The 6 confirmed rows of deleted orders and the 3 test bookings:** *Recommend: list them for
   ops to cancel in legacy now (a legacy data fix, not ours), and skip `b2c_BK-` on import.*
8. **`POST /api/b2c/reset`:** *Recommend: no equivalent here.*

## Decided (2026-10-09)

1. **Push, not pull:** Love Kingdom books through `POST /v1/bookings`; the pull is not ported.
2. **Love Kingdom pushes now,** writing to legacy and to this API during the transition.
   - **Duplicates:** the legacy import stops copying legacy's `b2c_` bookings, so Love Kingdom's push
     is the only source here.
3. **Health:** Love Kingdom alerts on its own failed calls; this API adds a reconciliation read
   (B2C bookings changed since a time).
4. **Bad data:** accepted and listed, as legacy's issues panel does, not refused. *Design note:* a
   booking on an unknown route can't be stored today (the trip's route is a foreign key), so the
   design needs a holding place for what can't become a booking (an issues list of raw orders).
6. **Edit clashes:** the version decides; Love Kingdom sends the version it read, a clash is `409`.
7. **Orphans:** ops cancels the 6 deleted-order bookings and the 3 test ones in legacy; the import
   skips `b2c_BK-` test ids.
8. **`/reset`:** no equivalent here.

## Design (2026-10-09, from the decisions above)

Words used below:
- **the push login**: a login whose `agent_id` is `a_b2c` (Love Kingdom's service user).
- **held order**: a write from the push login that could not be stored as asked, kept raw for ops.
- **booking issue**: a problem in a B2C booking that *was* stored, computed from the booking.

### 1. Held orders (decision 4: a holding place)

When the push login's `POST /v1/bookings`, `PATCH /v1/bookings/{id}` or
`POST /v1/bookings/{id}/cancel` is refused with a **`400`** (unknown route, no date, no passengers,
bad pax key, unknown pickup area, FOC without a reason, a field of the wrong type…), nothing is
written to the booking, as today, and instead:
- the raw body is stored as a held order, with the refusal's message as `problem`;
- the answer is **`202 Accepted`**, not `400`:

```json
{
  "code": "held_for_review",
  "message": "Not booked: Unknown route: r99. Held for ops to review as held_6f1c…",
  "held_order": {
    "id": "held_6f1c…", "action": "create", "external_id": "LOV-4190737", "booking_id": null,
    "problem": "Unknown route: r99", "status": "open", "attempts": 1,
    "received_at": "2026-10-09T03:00:00.000Z", "last_received_at": "2026-10-09T03:00:00.000Z", "received_by": "lovekingdom",
    "decided_at": null, "decided_by": null, "note": null, "resolved_booking_id": null,
    "request": { "external_id": "LOV-4190737", "trips": [{ "routeId": "r99", "date": "2030-01-04", "pax": { "ad_fr": 2 } }] }
  }
}
```

- Only `400` is held. `403`, `404`, `409` (sold out, `route_closed`, `duplicate_external_id`,
  `stale_version`, `booking_closed`), `428` and `5xx` answer as today: they are not bad data.
- Only the push login. Staff, legacy's client and an unauthenticated caller (no `AUTH_JWT_SECRET`)
  still get the `400`: a person at a screen can fix the field and save again.
- **Retries:** a held `create` with the same `external_id` as an **open** held create replaces its
  request and problem and counts `attempts` up; it is the same order, not a second one.
- **Fixed and resent:** when the push login then creates the booking (`201`) with that
  `external_id`, the open held create is resolved by itself (`resolved_booking_id` = the booking,
  `decided_by` = the push login, `note` "Booked as …").
- A held order holds **no seats**. Love Kingdom must treat `202` as "not booked yet".

| Field | Authority | Notes |
|---|---|---|
| `id` | computed | `held_<uuid>` |
| `action` | computed | `create`, `amend` or `cancel`, from the endpoint |
| `external_id` | client fact (as sent) | the body's `external_id`; for amend/cancel the booking's |
| `booking_id` | computed | amend/cancel: the booking it was for (from the URL) |
| `request` | client fact | the body exactly as sent (JSON) |
| `problem` | computed | the refusal's message |
| `attempts`, `received_at`, `last_received_at`, `received_by` | computed | `received_by` is the login |
| `status` | validated | `open` → `resolved` or `dismissed`, only through the commands below |
| `decided_at`, `decided_by` | computed | the caller's login |
| `note` | client fact | free text, on resolve or dismiss |
| `resolved_booking_id` | validated | must be a booking (`400` otherwise) |

Endpoints (writes need the `operations` area; the push login cannot write them, as today):

| Endpoint | What |
|---|---|
| `GET /v1/b2c/held-orders?status=open` | `{ held_orders: [...] }`, newest first; `status` `open` (default), `resolved`, `dismissed` or `all` |
| `GET /v1/b2c/held-orders/{id}` | one; `404` |
| `POST /v1/b2c/held-orders/{id}/resolve` | `{ booking_id?, note? }`: ops handled it (booked it by hand, or it was resent) |
| `POST /v1/b2c/held-orders/{id}/dismiss` | `{ note? }`: nothing to do (a test, a duplicate) |

Refusals: `404 Held order … not found`; `409 wrong_status` "Held order … is already resolved";
`400` `booking_id … is not a booking`, `note must be a string`. No `version`/`If-Match`: the only
change is `open` → closed, and a second click is already a `409`.

### 2. Booking issues (decision 4: stored, with its problems listed)

Computed from a stored booking by one pure function (`src/domain/b2c.ts`), never stored, so a
booking ops correct drops off the list by itself. Ported from legacy's `b2cCheckOrders`; the
messages are legacy's Thai, since the panel shows them as they are.

| `code` | `severity` | When | Legacy |
|---|---|---|---|
| `nat_unread` | warn | the lead's or a passenger's nationality is not a two-letter code (`TH`, `GB`) | same idea; legacy read names through an alias list |
| `nat_mix` | warn | a seat trip has Thai-priced seats (`*_th`) and more known foreigners (passengers whose nationality is set and not `TH`) than its other seats | legacy flagged any foreigner when the price was Thai off the lead alone |
| `money_parts` | warn | a price part was sent (`price_seat`…`price_extra`) and the parts differ from `total` by more than ฿1 | same rule |
| `pickup_area` | info | a hotel or pickup text, no `pickup_area_id`, not `pickup_self` | same rule |

Legacy's `route`, `date` and `pax0` cannot be stored here, so they become held orders.
`money_total` and `money_order` compare legacy's mapper with Love Kingdom's own order, which this API
never sees: not ported. `not_imported` does not exist in a push.

They appear:
- on the push login's `201`/`200` from create and `PATCH`, as `issues: [{code, severity, message}]`
  (always present for that login, `[]` when none);
- in the panel list below.

### 3. The issues panel: `GET /v1/b2c/issues`

Legacy's orange panel ("ใบ B2C ที่ต้องเช็ค n รายการ"), for any login:

```json
{
  "held_orders": [ { "...": "every open held order, as above" } ],
  "issues": [
    { "booking_id": "booking_…", "external_id": "LOV-4190737", "service_date": "2030-01-04", "lead_pax": "Jane Doe",
      "code": "nat_unread", "severity": "warn", "message": "อ่านสัญชาติผู้จองไม่ออก: \"Slovak\"" }
  ],
  "counts": { "held": 1, "warn": 1, "info": 0 },
  "signature": "3f2a9c1b0d4e"
}
```

- Bookings checked: agent `a_b2c`, a status that holds seats or waits (not cancelled, rejected or
  cancelled for weather), with a trip from today (Thailand) on.
- `signature` is legacy's `issueSig`: 12 hex of a SHA-1 over the held order ids and the `warn`
  issues' `booking_id:code`, so a client can keep "dismissed until the set changes" in
  `localStorage` as legacy does. Dismissing an issue is the client's, as in legacy.

### 4. Reconciliation read (decision 3)

`GET /v1/bookings?updated_since=<ISO instant>`: bookings whose `updated_at` is at or after the
instant, combinable with every filter (`agent_id=a_b2c` is forced for the push login anyway). Each
booking already carries `updated_at` and `version`. Love Kingdom keeps the newest `updated_at` it
has seen and asks from there; "at or after" re-sends the boundary booking rather than risk missing
one changed in the same millisecond. A value that is not an instant is `400 updated_since must be
an ISO instant, e.g. 2026-10-09T03:00:00Z`.

### 5. Change feed

A held order created, updated or decided is announced as `kind: "b2c_held_order"` (no
`route_days`), so the panel refetches. Migration 100 widens `changes_kind_check`; the change for a
held write replaces the booking `updated` row the write would otherwise record (nothing in the
booking changed).

### 6. Migration `100_b2c_held_orders.sql`

```sql
CREATE TABLE b2c_held_orders (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK (action IN ('create', 'amend', 'cancel')),
  external_id TEXT,
  booking_id TEXT REFERENCES bookings(id) ON DELETE SET NULL,
  request JSONB NOT NULL,
  problem TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  received_at TIMESTAMPTZ NOT NULL,
  last_received_at TIMESTAMPTZ NOT NULL,
  received_by TEXT,
  decided_at TIMESTAMPTZ,
  decided_by TEXT,
  note TEXT,
  resolved_booking_id TEXT REFERENCES bookings(id) ON DELETE SET NULL,
  CHECK ((status = 'open') = (decided_at IS NULL))
);
-- One open held create per order: a retry updates it.
CREATE UNIQUE INDEX b2c_held_orders_open_create_uk ON b2c_held_orders (external_id) WHERE status = 'open' AND action = 'create';
CREATE INDEX b2c_held_orders_status_idx ON b2c_held_orders (status, last_received_at DESC);
-- + 'b2c_held_order' added to changes_kind_check, keeping whatever kinds it has.
```

### 7. The import: `--b2c=all|pushed|none` (decisions 2 and 7)

`src/tools/import-legacy.ts` takes `--b2c=<mode>`; **the default `all` is today's behaviour**.

| Mode | Legacy's `b2c_<order>_<n>` rows |
|---|---|
| `all` (default) | imported, as today |
| `pushed` | skipped when a booking here (not `lg_`) has `external_id` = `<order>`: Love Kingdom pushed that order, so its push is the only copy; the others are still imported |
| `none` | all skipped: Love Kingdom's push is the only source |

- In every mode `b2c_BK-…` (the test orders) are skipped (decision 7).
- Skipped rows are counted in the report's notes, not listed one by one.
- A run deletes every `lg_` booking first, so a mode that skips also removes the copies earlier
  runs made.

**The switch-over, and its timing risk.** Legacy's copy and Love Kingdom's push of the same order
are two bookings holding the same seats here, so the import must stop copying an order once Love
Kingdom pushes it, and not before:
- **too early** (`none` while Love Kingdom does not push every order yet): orders only legacy has are
  lost here;
- **too late** (`all` after Love Kingdom pushes): pushed orders are here twice and their seats count
  twice.

`pushed` removes the risk for each order separately, so: run imports with `--b2c=pushed` from the
day Love Kingdom's push goes live; switch to `none` once Love Kingdom has pushed its open orders
(their back-fill) and no `lg_b2c_` booking is left that is not pushed.

### Contract changes (Love Kingdom)

- `202 held_for_review` on create, amend and cancel instead of `400`: not booked, not changed.
- `issues` on its create and amend responses.
- `GET /v1/bookings?updated_since=` to reconcile; alert on its own failed calls.
- `If-Match` on amend and cancel (already required, `428`/`409 stale_version`).
- Push every order with boat items, including the open ones made before go-live (the back-fill),
  so the import can move to `none`.
