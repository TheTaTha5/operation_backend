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
