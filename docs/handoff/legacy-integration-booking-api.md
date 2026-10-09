# Handoff: legacy's screens on the booking API, all the way

*Written 2026-10-09, from operation-backend `main` (`12b0129`) and the integration worktree at
`386e7b5` (branch `integration/operation-backend`). For whoever works in
`D:\projects\wt-operation-backend-integration`. It follows `integration-client.md`, whose six steps
are done.*

- **The contract is `README.md`** in operation-backend, and live at `/docs` (Swagger). Every endpoint,
  field and error code below is spelled as the README spells it. If this note and the README
  disagree, the README wins.
- **The rule:** the server decides, the screen shows. Price, status, approvals, capacity, van seats,
  who did what and when: the server works it out. The browser sends what the user typed or picked,
  shows the answer, and shows an error's `message` as it is.
- **Same screens.** Keep legacy's screens, buttons, dialogs and wording. Where a server rule makes a
  screen behave differently, it is called out below as **Behaviour change**.
- **Do not change the API from the client.** If something is missing, add it to "Questions for the
  API team" and ask.

## What changes, in ten lines

1. `ME` comes from `GET /v1/me`, not from decoding the token. The Users screen moves to `/v1/users`.
2. Every booking read keeps the server's `version`; every booking write sends it back (`If-Match`).
3. The booking form shows `POST /v1/quote`'s price. After a save, the screen takes the server's
   `total`, price fields and `price_warnings`. `bookingV2CalcQuote` stops deciding the price.
4. `adjustments`, `alt_pickups`, `upgrades`, `allergy_list`, `attachments`, `ovnCharge` and the
   charter price fields are sent and read. They are stored now.
5. `fromServer` maps every trip's `operations` into legacy's `b.ops` / `t.ops`, plus `reconfirm`,
   `doc_check` and the rest. `mergeInto` stops keeping local copies of them.
6. Every day-of-operations screen writes through its endpoint. Today those edits live only in
   memory and vanish on reload.
7. Van, pickup-area and pickup-time screens load from and save to the API. The seeds in `08-app.js`
   are demo data.
8. Files go to `/v1/attachments` (not `/api/attach`), and are shown through a fetch with the Bearer
   header.
9. Deployments handle `409 seats_sold` with `remove_anyway`; seat locks send `If-Match`, save bulk
   locks, sub-groups, pending seats, expiry and reason to the API, and read every number back (§6.1).
10. Live updates come from `GET /v1/changes/stream`. The 30 s, 60 s and 120 s polls go.
11. Programs, the boat form, Boat Status and the day-seats dialog save to `/v1/routes`,
    `/v1/route-families` and `/v1/boats` (§3.14). Routes and boats are the API's now.

## How to read this

- **Already right**: the integration does it the API's way today. Leave it.
- **To do**: what to change, with the file and function.
- **Delete**: client logic that decides something the server now decides. Remove it, or keep it
  only as a hint before the request (never as the answer).
- Legacy functions are in `allotment_v2/js/08-app.js`, `04-data-core.js`, `01-auth-sync.js` and
  `js/booking/<name>.js` (one function per file). The integration layer is `js/ops/*.js`.

### The one thing to know first

With `LA_LEGACY_SYNC=false`, `_syncReady` stays `false` in `01-auth-sync.js`, so **nothing but
bookings, seat locks, deployments and the route calendar is saved anywhere**. Every other write
(`acctPersistBookings`, `sbVehiclesPersist`, `psuPersist`, `vsPersist`, `_docCheckPersist`,
`vanJobs*Persist`, …) changes memory only, and is lost on reload. That is why most of the work below
is wiring writes, not only reads.

## Order of work

Each step leaves the app working.

| # | Step | Why this order |
|---|---|---|
| 1 | Login: `ME` from `GET /v1/me`; logout; Users screen (§1) | The screens hide what a login may not do. Today every non-admin looks like they may edit everything |
| 2 | Load the catalogues the bookings point at: pickup areas, pickup-time profiles, vans (§4, §3.4) | A booking save is refused (`400`) when its `pickup_area_id` is not in the API's catalogue, and van groups need real van ids |
| 3 | Read the whole booking from the server (§2.1, §3.1). Stop `mergeInto` keeping local copies | Screens show the server's truth before anything writes it |
| 4 | Booking writes: `version` / `If-Match`, prices from the server, the new booking fields (§2.2–§2.6) | Saves stop being overwritten silently and stop showing a price the server did not keep |
| 5 | Day-of-operations writes, screen by screen (§3.2–§3.12) | Each one is independent; do the most used first: boat, final pickup, check-in, reconfirm |
| 6 | Deployments and seat-lock guards (§3.13, §6) | Small, and they only add handling for new refusals |
| 7 | Live updates (§5) | Last, once every screen reads from the server: then a refetch is enough |
| 8 | Sales reads: rate seasons, rate types, contracts (§6) | Display only |

## 0. Shared plumbing (`ops/00-ops-core.js`)

**Change: `call` needs headers, and errors need their `code`.**

- **Already right:** `LaOpsError` carries `status`, `code` and the server's `message`; `O.fail`
  shows the message as it is; `O.queue` keeps writes in order; 401 sends the user to the login.
- **To do:** give `call(method, path, body, headers)` an optional `headers` argument, so a write can
  send `If-Match`. (A body `version` works too, but a header keeps bodies clean.)
- **To do:** one helper, e.g. `O.bookingWrite(method, path, bk, body)`, that adds
  `If-Match: "<bk.opsVersion>"`, takes `version` from the answer, and on `409 stale_version` shows the
  message, refetches `GET /v1/bookings/{id}` and redraws. Use it for every booking write in §2–§3.

Errors always look like this (README → "History and who made a change"):

```jsonc
{ "statusCode": 409, "code": "stale_version", "error": "Conflict",
  "message": "Booking BK-1 has changed since you read it (you have version 1, it is now 2); reload and try again" }
```

Show `message`. Branch only on `code`. Never on the text.

---

## 1. Login and permissions

**Change: who the user is and what they may do comes from `GET /v1/me`; the server refuses
anything else with `403`.**

Legacy screens: the login card (`showLogin`), the logout dialog, the sidebar and edit guards
(`laCanEdit`, `laCanEditArea`, `laCanAct`, `laAllowed`, `laApplyPerms`, `laGuardEdit`), the Users
screen (`__laLoadUsers` and its save, add, password and delete actions), approve and reject.

### 1.1 Login and logout

**Already right:** `showLogin` posts `POST /v1/login`, stores `access_token` in `sessionStorage`
(`la_ops_token`), and shows `message` on failure (the same `401` for a wrong pair, an unknown user or
a disabled user; `429` after 15 failed tries in 3 minutes, saying how long to wait). `laOpsFetch`
adds `Authorization: Bearer …` and returns to the login on any `401`.

```bash
curl -X POST https://<host>/v1/login -H 'Content-Type: application/json' \
  -d '{"username":"RSVN01","password":"..."}'
# {"access_token":"…","token_type":"Bearer","expires_in":43200,"user":{…as GET /v1/me…}}
```

**To do:**
- **Build `ME` from `GET /v1/me`** (or from `user` in the login answer, then `GET /v1/me` on each
  boot). Today `01-auth-sync.js` decodes the token (`opsPayload`: `sub`, `groups`), which has no
  areas or rights, so `laCanEditArea` answers "yes" for every non-admin.

  | `ME` key (legacy, as `/api/me` gave it) | From `GET /v1/me` |
  |---|---|
  | `username`, `name`, `role` | `username`, `name`, `role` |
  | `canEdit` (the global gate `laCanEdit`) | `can_edit_any` |
  | `editAreas` | `edit_areas` (`null` = no list: `can_edit` decides, as legacy) |
  | `perms` (pages) | `view_perms` (`null` = every page) |
  | new: `actions` | `actions` (`act-approve`, `act-capunlock`, `act-tmpl`) |
  | `salesId`, `dept` | `sales_id`, `dept` |

- **`laCanAct` reads `ME.actions`**, not `ME.perms`. Legacy kept `act-` keys inside `perms`; the API
  keeps them apart.
- **Logout calls `POST /v1/logout`** (`204`) before clearing the token. Like legacy's `/api/logout`
  (`revokeSessions`), it ends every session that user has.
- **Rights change at once.** The server reads rights on every request, so a change, a disable or a
  password reset applies to the next call. A `401` mid-session is normal after that.

**Delete:** `opsPayload`-based `ME` and the `groups`-based admin guess.

### 1.2 What a login may do (`403`)

| Edit area | Writes (README → "What each login may do") |
|---|---|
| `operations` | bookings and their commands, seat locks, deployments, and the day-of-operations writes |
| `fleet` | deployments; stock, consumables, memos, projects, the Daily Fleet Log, safety (`/v1/fleet/…`, §6.7); file uploads |
| `sales` | rate types, agents (rate seasons), promo contracts, staff and their quotas, sales targets and follow-ups |
| `config` | the route calendar |

- Check-in also takes `pier`; attachments take `operations`, `pier`, `accounting` or `fleet`; a doc-check note
  takes any login. `role: admin` may do everything.
- A refusal is `403` naming what is missing: `Needs the operations area`. Show it as it is.
- **Keep** the local guards (`laGuardEdit`, `laCanEditArea`) as hints that hide buttons. The server's
  `403` is the answer.

### 1.3 Approve and reject

| The booking waits for | Who may decide |
|---|---|
| over the allotment | an admin, or a login with `act-approve` |
| FOC passengers | an admin, or `act-approve` |
| a discount | an admin, or the agent's salesperson (`users.sales_id` = the agent's `sales_id`) |

- **Already right:** the wrapped `bookingV2ApproveBooking`, `bookingV2RejectBooking`,
  `bookingV2FocApprove`, `bookingV2FocReject` (`ops/40-ops-bookings.js`, `tx`) put the booking back
  and show the server's message on a refusal, so a `403` already reads correctly.
- **To do:** nothing beyond §1.1, so the buttons hide for logins without the right.

### 1.4 The Users screen (`01-auth-sync.js`)

**Change: the screen talks to `/v1/users`; delete becomes disable; add an `act-approve` box.**

| Legacy call | API |
|---|---|
| `__laLoadUsers`: `GET /api/users` | `GET /v1/users` (admin) |
| save rights: `POST /api/users/perms` (two places, ~`:1806`, `:1992`) | `PATCH /v1/users/{id}` with `role`, `dept`, `view_perms` (legacy's `perms` accepted), `edit_areas` (`editAreas` accepted), `actions`, `sales_id` (`salesId` accepted) |
| add: `POST /api/users` (~`:2053`) | `POST /v1/users` `{username, password, name?, role?, edit_areas?, can_edit?, actions?, view_perms?, sales_id?, agent_id?, dept?}` → `201` |
| reset password: `POST /api/users/password` (~`:2092`) | `POST /v1/users/{id}/password` `{password}` (ends that user's sessions) |
| delete: `DELETE /api/users?id=` (~`:2121`) | `PATCH /v1/users/{id}` `{ "disabled": true }`. A user is disabled, never deleted |

- Map a row back as in the §1.1 table (`perms` ← `view_perms`, `acts` ← `actions`, `edit` ←
  `edit_areas`, `salesId` ← `sales_id`).
- **Split `act-` keys out of `perms`** into `actions` when saving. Keep legacy's `*explicit` marker in
  `view_perms`; it is just a string there. An unknown right is `400`.
- **Add `act-approve`** to `LA_ACTS` (beside `act-capunlock`) so an admin can tick it.
- **Errors:** read `message`, not `error` (legacy reads `r.json.error`; on the API that is only
  `"Bad Request"` / `"Conflict"`). `409` for a username taken (ignoring case). `PATCH` refuses
  `password` and `username` with a `400` naming what to use. An admin cannot disable or demote their
  own login.
- **Behaviour change:** a deleted user stays in the list as disabled (hide it with the screen's
  existing "hide off" toggle if wanted).

---

## 2. Bookings

### 2.1 Reading a booking (`fromServer`, `mergeInto` in `ops/40-ops-bookings.js`)

**Change: the server's booking is the whole booking. Map every stored field; stop keeping local
copies.**

**Already right:** header columns, structs, trips (lock draws, overnight, pickup joined back with
`pickupJoin`), passengers, add-ons, cancel/reschedule/partial-cancel records, fee items, approvals
(`approvalsInto`), `focPlaceholder`.

**To do: map these too.**

| Legacy (client) | From the booking read |
|---|---|
| `bk.opsVersion` (new) | `version` (also the `ETag` header) |
| `bk.adjustments` | `adjustments` `[{seq, kind, mode, value, label?, note?}]` |
| `bk.altPickups` | `alt_pickups` (`area_id`→`areaId`, `drop_same`→`dropSame`, `drop_area_id`→`dropAreaId`, `drop_area`→`dropArea`, `drop_zone`→`dropZone`, `drop_place`→`dropPlace`) |
| `bk.upgrades` | `upgrades` (`sell_price`→`sellPrice`, `to_company`→`toCompany`, `fee_pct`→`feePct`, `customer_paid`→`customerPaid`; `slips` as below) |
| `bk.specialMeals.allergyList` | `allergy_list` `[{name, qty}]`; count from `allergy_count` |
| `bk.specialMeals.pierAt` / `pierBy` | `special_meals_pier_at` / `special_meals_pier_by` |
| `bk.attachments` | `attachments` `[{id, name, mime, size, kind, by, at}]` (see §3.11 for showing them) |
| `bk.docCheck` | `doc_check` (or `null`); the list's badge from `doc_check_status` |
| `bk.ops.reconfirm` | `reconfirm` (`sent_at`→`sentAt`, `sent_by`→`sentBy`; `null` = none) |
| `t.ops` / `bk.ops` | each trip's `operations` (§3.1) |
| `t.rtRef`, `t.promoId` | `trips[].rate_type_id`, `trips[].promo_id` |
| `t.subtotal` | `trips[].subtotal` |
| `t.ovnCharge` | `trips[].ovn_charge` |
| `t.charterPriceMode` / `Manual` / `Note` | `trips[].charter_price_mode` / `charter_price_manual` / `charter_price_note` |

- **`mergeInto` keeps only what the API does not hold:** `history` (until `refreshDetail` replaces
  it), `rebook`, `b2cOverride`, `createdAt`. (`invoiceId` and `paymentStatus` now come from the
  booking's `invoice` and `payment_state`: see 2.7. `weatherResolve` and `refund` come from the
  weather closures and `GET /v1/refunds`: see 2.8.)
  Remove `ops`, `upgrades`, `altPickups`, `docCheck`, `adjustments` from its keep list, and stop
  copying `ops`, `ovnCharge`, `promoId`, `rtRef` from the old trips. Its comment "adjustments are not
  stored by the server yet" is out of date.
- **Pending approvals:** `loadPending` asks only `status=pending_approval`. Ask
  `status=pending_approval,pending_foc`, so a `pending_foc` booking outside the boot window shows too.
- **A read never carries `booking_data`.** It is deprecated; ignore it.

### 2.2 Saving a booking: create and edit (`toServer`, `saveNow`)

**Change: send every stored field, send the version, take the server's answer for everything it
decides.**

Endpoints: `POST /v1/bookings`, `PATCH /v1/bookings/{id}`.

```jsonc
// POST /v1/bookings  (README → "Bookings", "Pickup and overnight fields")
{ "intent": "confirm",
  "trips": [
    { "routeId": "r-1", "date": "2030-01-02", "pax": { "ad": 2 }, "zone": "PK", "pickupTime": "08:30",
      "ovn": "return", "ovnReturnDate": "2030-01-04" },
    { "routeId": "r-1", "date": "2030-01-04", "pax": { "ad": 2 }, "zone": "PK", "ovnLeg": true, "ovnOf": 0 } ] }
```

**Already right:** `intent` on create (not `status`); the four stamps never sent; `focReason`; trip
`id` echoed (`opsTripId`) so day-of-operations data survives an edit; lock draws mapped to server lock
ids; pickup text split into `pickupTime` / `pickupTimeEnd` / `pickupAtPier`; `external_id` = the
client id (a retry is `409 duplicate_external_id` naming the booking).

**To do in `toServer`:**
- **`adjustments`**: send `[{kind, mode, value, label, note}]` (what `bookingV2CommitBooking` already
  builds, value > 0). Present replaces the list, `[]` clears it. Today they are never sent, so the
  server prices without them.
- **Per trip:** `ovnCharge`, `charterPriceMode`, `charterPriceManual`, `charterPriceNote`. A trip is
  sent whole, so leave none out.
- **`altPickups`** (legacy spelling and keys are accepted), **`allergy_list`** (or
  `specialMeals.allergyList`), **`attachments`** as `[{id, kind}]`.
- **Do not send** `doc_check`, `reconfirm`, `special_meals_pier_at`/`_by` or `operations`. A `PATCH`
  may echo them unchanged; a different value is `400`. They have their own commands (§3).
- **`upgrades`**: send only from the on-tour sale dialog (§3.9), not on every save.
- **Add-on `amount`:** the server computes it on non-B2C bookings. Keep sending `type`, `label`,
  `qty`, `note`, `jAd`, `jChd`; `amount` may stay (it is replaced).
- **Prices:** see §2.3.

**To do in `saveNow`:** send `If-Match` with `bk.opsVersion` on `PATCH` and on the follow-up
`/confirm`. From the answer take `version`, `status`, the stamps, `approvals` (already done),
**and** `total`, `price_seat`, `price_addon`, `price_foc_discount`, `price_discount`, `price_extra`,
each trip's `subtotal` / `rate_type_id` / `promo_id`, each add-on's `amount`, and every trip's
`operations`. Simplest: run the answer through `mergeInto`.

**Server-owned fields.** `status`, `created_by`, `booked_at`, `confirmed_by` and `confirmed_at` may
only repeat the stored value on `PATCH`. A different value is `400`, e.g.:

```
status cannot be changed with PATCH: use POST /v1/bookings/{id}/confirm, /approve, /reject, /cancel, /cancel-weather or /restore
```

**Pickup areas must exist.** `pickup_area_id` and `dropoff_area_id` must be areas in
`GET /v1/pickup-areas` (`400` otherwise). Today the picker reads the seed `SB_PICKUP_AREAS`
(`08-app.js:1232`): load it from the API first (§4).

**Pickup windows.** A trip's pickup is `pickup_time`, `pickup_time_end`, `pickup_at_pier`:

| Legacy text | `pickup_time` | `pickup_time_end` | `pickup_at_pier` |
|---|---|---|---|
| `07:30` | `07:30` | | |
| `07:30-07:45` | `07:30` | `07:45` | |
| `Before 08:30 at pier` | | `08:30` | `true` |

A window whose fields disagree is a `400` naming the trip. A trip sent with no pickup time gets the
lookup's (§4), and one with no `zone` gets the area's zone; a value sent is never overwritten.

**Errors to handle on save** (all shown as they are; the form reopens, as the commit wrapper already
does):

| Status | `code` | When |
|---|---|---|
| `400` | — | a field or rule, named (`trips[0] …`, `addOns[2].amount must be a number`, `adjustments[1].value must be a number above 0`, unknown pickup area, a `price_mode` that contradicts the agent) |
| `400` | — | `foc_reason is required to confirm FOC (free) passengers` |
| `400` | — | `staff_id is required: a staff booking names the staff member` (the guard `bkV2Save` had: drop its alert), or a `staff_id` that is no staff member |
| `409` | `over_quota` | a welfare booking's free seats over the staff member's quota: legacy's "Save anyway?" confirm; resend with `quota_anyway: true` |
| `409` | `route_closed` | a new or moved trip on a closed day: `Route Day Trip - Se La Va (r7) does not run on 2027-01-04` |
| `409` | — | no seats: locks in the way, or past the boats' registered seats |
| `409` | `booking_closed` | editing a `cancelled`, `rejected`, `cancelled_weather` or `completed` booking |
| `409` | `stale_version` | someone saved it meanwhile |
| `409` | `duplicate_external_id` | a retried create; read the named booking instead |

**Delete** (in `bookingV2CommitBooking.js`):
- `bookedAt`, `confirmedBy`, `confirmedAt` set locally (`~:500-510`). The server stamps them.
- `newBk.status = 'pending_approval'` and the `newBk.approval` record (`~:487-498`), and
  `focApproval` built from the local quote (`~:412-418`). Keep the "over the allotment" confirm
  (`~:263`) and the discount alert (`~:273`) as hints; send `intent` from the button pressed. Then
  `intentOf` no longer needs `approval.targetStatus`.
- The `ops` clearing when the dates change (`~:546-567`). The server clears a moved trip's dispatch,
  vans and check-ins and keeps its pier note.
- The van clearing for a self-arriving booking (`~:572-583`). The server takes a trip out of its van
  group when its pickup zone changes, and refuses a NoTransfer trip in a van (`409 self_arrive`).
- `bookingV2SyncAltPickupSplits(newBk)` (`~:638`). The server builds the van parts from `alt_pickups`.
- Local history lines for things the server logs (`bookingV2AddHistory` on create, edit, approval,
  reconfirm, upgrade…). The History card reads `GET /v1/bookings/{id}/history`.

### 2.3 Prices and the quote

**Change: the server prices every non-B2C booking. The form shows `POST /v1/quote`; the saved
booking shows what the save answered.**

Legacy: `bookingV2CalcQuote` → `_bkV2CalcQuoteRun` (`08-app.js:44811`), `bookingV2TripSubtotal`,
`bookingV2RtKeep*` (keep the booked rate), `bookingV2RtKeepUse('now')` ("use today's rate"),
`bookingV2ResolveRateType` / `bookingV2GetRTForTrip`.

**Why now:** with legacy off, `SB_RATE_TYPES` is the demo seed (`08-app.js:1018`) and
`SB_CONTRACTS` is empty, so the browser's price is wrong. The server replaces it on every save and
says so, but `saveNow` ignores the answer, so the screen keeps showing the browser's number.

`POST /v1/quote` saves nothing. Body: the booking's `agent_id`, `booking_date`, `trips`, `add_ons`,
`adjustments`, `price_mode`, `manual_total`, `staff_purpose`, `rate_type_ref`, plus `booking_id` on
an edit and `rate` (`kept` or `agent`).

```jsonc
// POST /v1/quote → 200
{ "price_mode": "rate", "seat": 7400, "add_on": 600, "foc_discount": -1700, "discount": -800, "extra": 500, "total": 7700,
  "trips": [{ "subtotal": 7400, "rate_type_id": "rt003", "promo_id": null, "rate_source": "season" }],
  "add_ons": [{ "amount": 600, "counted": true }],
  "warnings": [{ "code": "not_offered", "trip": 1, "message": "trips[1]: r12 zone PK has no price: ฿0" }] }
```

**To do:**
- **The review step and price lines** call `POST /v1/quote` (debounced, on any change to trips, pax,
  add-ons, adjustments, price mode, manual total, staff purpose or booking date) and show its numbers
  in legacy's places (`seat` → seat total, `add_on`, `foc_discount`, `discount`, `extra`, `total`,
  `trips[].subtotal` per trip, `add_ons[].amount` per line). Show `warnings[].message` where legacy
  shows its "no rate" note (`bookingV2NoRateTrips`).
- **On an edit** send `booking_id`: each trip still on its route and day keeps the rate it was sold
  at. **"Use today's rate"** sends `rate: "agent"` on the quote and on the `PATCH`.
- **Stop sending** `total` and `priceBreakdown` on non-B2C bookings. If sent, the server replaces them
  and answers `price_warnings`.
- **Keep sending** them on a B2C booking (`external_id` starting `b2c_`, or agent `a_b2c`): its price
  stays as sent (`bookingV2IsB2CBk`, `§b2cEdit` already copy the stored price).
- **After a save**, take the price from the answer (§2.2) and show `price_warnings` once, as a toast:

```jsonc
"price_warnings": [
  { "code": "price_replaced", "field": "total", "sent": 99, "used": 4000, "message": "total 99 was replaced by the server's 4000 (POST /v1/quote shows how)" },
  { "code": "not_offered", "trip": 0, "message": "trips[0]: r12 zone PK has no price: ฿0" }
]
```

- **Errors:** `400` for an unknown `agent_id`, a bad `rate`, a negative charge, a `price_mode` that
  contradicts the agent (company always by hand, staff inspection by hand at 0, …); `404` for an
  unknown `booking_id`.
- **Commands keep the price:** confirm, approve, reject, cancel, restore and reschedule never
  re-price; a partial cancel takes its refund off `total`.

**Delete:** `_bkV2CalcQuoteRun` as the source of the saved price, `bookingV2RtKeep*` (the server
keeps the sold rate), the local rate resolution for pricing. **Behaviour change:** "use today's
rate" re-prices the trips but does not change the booking's `rate_type_ref` (legacy changed it).

### 2.4 Passengers and add-ons

**Already right:** `passengers` and `addOns` are sent whole and read back. Both replace the stored
list when sent, and are left alone when absent.

- `passengers`: `name` is required; `nationality`, `type`, `foc` optional.
- `addOns` errors: `addOns[1].type is required`, `addOns[0].qty must be a positive integer`,
  `addOns[0]: join counts are only for a longtail-join add-on`.
- **Note:** a missing `jAd` means every passenger joins; `0` means nobody does. Keep sending `null`
  as absent (`toServer` already does).

### 2.5 Edit conflicts: `version` and `If-Match`

**Change: send the version you read on every booking write.**

- Every booking has `version`: `1` on create, `+1` on every write. Responses also send it as `ETag`
  (`"7"`).
- Send it as `If-Match: "7"` (or `"version": 7` in the body) on `PATCH /v1/bookings/{id}` and every
  command and action: `/confirm`, `/approve`, `/reject`, `/cancel-weather`, `/cancel`, `/restore`,
  `/partial-cancel`, `/reschedule`, and `PUT /v1/bookings/{id}/meals`.
- `409 stale_version` → show the message ("…reload and try again"), refetch the booking, redraw.
  Nothing was written.
- A malformed `If-Match`, or a header and body `version` that disagree, is `400`.
- **Required** (since 2026-10-09): a write without it is `428 version_required` and changes nothing.
  Seat-lock `PATCH` and `release` need it too.
- Reconfirm writes do not change `version`; for the other day-of-operations writes see "Questions".

### 2.6 Status commands, approvals, cancel, restore, partial cancel, reschedule, history

**Already right, end to end** (see `integration-client.md`): Save draft / Submit use `intent`;
Submit on a quote calls `/confirm`; approve, reject, FOC approve/reject, weather cancel, cancel,
restore, partial cancel and reschedule are commands; `over_licence` and `lock_short` warnings are toasts; the approval card reads
`approvals[].days[].licensed_free`.

| Command | From | To |
|---|---|---|
| `POST /v1/bookings/{id}/confirm` | `draft`, `quote`, `pending` | `confirmed`, or `pending_foc` / `pending_approval` |
| `POST /v1/bookings/{id}/approve` | `pending_approval`, `pending_foc` | the approval's `target_status` |
| `POST /v1/bookings/{id}/reject` | `pending_approval`, `pending_foc` | `rejected` |
| `POST /v1/bookings/{id}/cancel-weather` | any status that holds seats | `cancelled_weather` |
| `POST /v1/bookings/{id}/cancel` | any status that holds seats | `cancelled` |
| `POST /v1/bookings/{id}/restore` | `cancelled`, `rejected`, `cancelled_weather` | `confirmed` |

```json
{ "category": "customer_cancel", "note": "changed plan", "charge_type": "partial", "charge_amount": 1500 }
```

**To do:**
- Add `If-Match` to every command (§2.5). The `tx` wrapper and `laOpsBookingAction` are the two
  places.
- Handle the codes: `wrong_status`, `already_cancelled`, `booking_closed`, `not_cancelled`,
  `charter_boat_taken`, `route_closed` (restore), `stale_version`, and `403` (§1.3). All are already
  shown by `O.fail`; add the refetch on `stale_version`.
- Partial cancel: `{ trip_id, pax, category, note, charged: {count, amount}, waived: {count, amount}
  }`. A trip is never emptied this way (`400`). Reschedule: `{ from_date, to_date, reason,
  charge_type, charge_amount, collect }` moves every trip on `from_date`.
- History: `refreshDetail` already reads `GET /v1/bookings/{id}/history`. Imported bookings carry
  legacy's own lines.

---

### 2.7 Invoices and payments (Accounting, Daily PFM payments)

**The server now issues, numbers, totals and settles invoices** (README "Invoices and payments"). The
Accounting screen and the Daily PFM payment dialogs move from `SB_INVOICES`/`SB_PAYMENTS` to these:

| Legacy | API |
|---|---|
| `acctCreateInvoice(agentId, ids, dueDays)`, `pfmIssueAll`, the prepay in `pfmRecSubmit` | `POST /v1/invoices` `{ agent_id, booking_ids, kind: "booking" \| "prepay" }`; the server sets lines, VAT, `number` and `due_at` |
| `acctInvSet` (ref, dear, acceptAt, remark, whtAmount) | `PATCH /v1/invoices/{id}` `{ ref, dear, accept_at, remark, wht_amount }` |
| `acctInvDisc` | `PUT /v1/invoices/{id}/discounts` `{ lines: [{ seq, discount }] }` |
| `acctVoidInvoice`, `pfmEditVoidInvoice` | `POST /v1/invoices/{id}/void` `{ reason }` |
| `acctRecordPayment`, `pfmRecSubmit` | `POST /v1/invoices/{id}/payments` `{ amount, method, paid_on, ref, slip_ids }` |
| `pfmEditSubmit` | `POST /v1/invoices/{id}/payment-corrections` `{ payments: [{ id, amount?, method?, paid_on?, deleted? }], reason }` |
| `acctInvoiceState`, `acctInvoiceBalance`, `acctBookingInvoice`, `acctBookingPaid` | the invoice's `status`, `paid`, `balance`; the booking's `invoice` and `payment_state` |
| `agCreditState` | `GET /v1/agents/{id}` → `credit` |
| `acctNextInvoiceNo` | delete: the server numbers |

- **Delete client-side:** `acctCreateFeeInvoice` and the void in `bkV2CancelBooking` and
  `bkV2RestoreBooking`. `/cancel` voids the booking's invoice and issues the cancellation fee
  invoice; `/restore` voids it.
- **Refusals to show as they are:**
  - `409 booking_already_invoiced`, `409 booking_cancelled` and `400 booking_not_agents` on issue;
  - `409 invoice_has_payments` on a discount;
  - `409 invoice_void`;
  - `409 payment_deleted`.
- **`409 overpayment`** is legacy's "Save anyway?" confirm. On yes, resend the same body with
  `overpay_anyway: true`.
- **Writes need the `accounting` area.**
- **A deleted payment stays** with `deleted_at`. Leave it out of what you list.

### 2.8 Weather closures, refund and credit (Boat Operation popover, the weather panel)

**The server keeps the closures and the follow-up now** (README "Weather closures, refund and
credit"). `SB_WEATHER_CLOSURES`, `bk.weatherResolve`, `bk.refund` and the weather `SB_DEPOSITS` move
to these:

| Legacy | API |
|---|---|
| `bkV2IsWeatherClosed`, `bkV2WeatherNote`, the calendars' closed marker | `GET /v1/weather-closures?from=&to=` (open ones; `counts`, `pax`) |
| `bkV2WeatherMarkConfirm` (new) | `POST /v1/weather-closures` `{ route_id, service_date, note }` |
| `bkV2WeatherMarkConfirm` ("Update note") | `PATCH /v1/weather-closures/{id}` `{ note }` |
| `bkV2WeatherUncancel` | `POST /v1/weather-closures/{id}/undo`; on `409 has_resolved` show the message as the confirm, and on yes resend with `undo_anyway: true` |
| `bkV2WeatherTagBookings`, `bkV2WeatherEventBookings`, `bkV2WeatherPanel`, `bkV2WeatherInlineCell` | `GET /v1/weather-closures/{id}` → `bookings` (status, outcome, `new_date`, `refundable` = "Paid ฿x") |
| `bkV2WeatherNotify` | `POST /v1/weather-closures/{id}/bookings/{booking_id}/notify` |
| `bkV2WeatherResolveOne` "Reschedule" | `POST /v1/bookings/{id}/reschedule` `{ from_date: <closed day>, to_date, reason: "weather" }` |
| `bkV2WeatherResolveOne` "Refund" / "Credit" / "Cancel" | `POST /v1/bookings/{id}/cancel-weather` `{ outcome: "refund" \| "credit" \| "cancel" }` |
| `bkV2WeatherCountsFor` | the closure's `pax` |
| `_dashBoardData` weather count | `GET /v1/weather-closures` → sum of `counts.awaiting + counts.notified` |
| `acctAgentDepositAvail`, "Deposit held" | `GET /v1/agents/{id}` → `credit_balance` |
| `acctPayUseDeposit`, `acctApplyDeposit` | `POST /v1/invoices/{id}/payments` `{ amount, method: "credit" }` |

- **Delete client-side:** the tagging on panel open, the weather branch of `bkV2WeatherResolveOne`
  (trip move, `bk.rebook`, the negative payment, `acctVoidInvoice`, `acctCreateDeposit`), and
  `weatherResolve` and `refund` from `mergeInto`'s keep list. The server moves the trips, takes only
  this booking's share off its invoice and writes the history lines.
- **What behaves differently:** a full new day refuses the reschedule (`409`, show it); the "Credit"
  option should be greyed when `refundable` is 0 (else `409 nothing_paid`); a shared invoice is no
  longer voided whole.
- **Refusals to show as they are:** `409 already_closed`, `409 closure_reopened`, `409 wrong_status`,
  `404 not_on_closed_trip`, `409 nothing_paid`, `409 no_agent`, `409 credit_short`,
  `409 credit_payment`.
- **Writes need the `operations` area** (the refund and credit too); spending credit is an invoice
  payment and needs `accounting`.

### 2.9 Partner van bills, van rates and the money reports

**The server works out every van bill row and amount, and every report figure** (README "Partner van
bills" and "Money reports"). `VAN_BILL`, `van_rates` and `dr_cfg` move to these:

| Legacy | API |
|---|---|
| `vbAgg`, `vbRenderOv` (ภาพรวม) | `GET /v1/van-bills?month=&period=` → `partners[]` |
| `vbRows`, `vbState`, the per-partner screen | `GET /v1/van-bills/{partner}/{month}/{period}?van_id=` → `rows`, `extra_lines`, `totals`, `by_code`, `codes`, `new_rows` |
| `vbSet('perPax')`, `vbSetRateC`, `vbSetRow`, `vbAddExtra`/`vbSetExtra`/`vbDelExtra` | `PATCH …` with `per_pax`, `route_rates`, `row_overrides`, `extra_lines` (each replaces that whole field) |
| `vbSave` (§vbSeen) | `PATCH …` with `mark_seen: true` (with the inputs, or alone) |
| `vbPullRates` | `POST …/pull-rates` → the bill and `pulled: { got, none }` (a `generic: true` code is legacy's `*`) |
| (new) sent / paid | `POST …/send`, `…/unsend`, `…/pay` `{ via, ref, paid_on }`, `…/unpay` |
| `vanRates`, `vanRateSet` (Transfer Fleet "ราคาจริง") | `GET /v1/van-rates`, `PUT /v1/van-rates` `{ group, route_id, field, rate }` (`rate: null` clears) |
| `renderAccounting` KPIs, `acctDashboardHtml` | `GET /v1/reports/accounting` |
| `acctStatementOpen` | `GET /v1/agents/{id}/statement` |
| `renderTravelSum` totals | `GET /v1/reports/travel-summary?date=` |
| `drData` money, `drPaneFi`, `drVanReal` | `GET /v1/reports/daily?date=` |
| `drCfg`, `drCfgSet` | `GET`/`PUT /v1/reports/daily/settings` |

- **Delete client-side:** `vbPersist`, `vbStamp`, the edit snapshot (`_vb.snap`) and every amount the
  screen adds up; keep the edit mode and the "fill an empty field at once" behaviour as UI only, and
  send the field with `PATCH`.
- **Refusals to show as they are:** `409 bill_paid` (undo the payment first), `409 bill_not_sent`,
  `409 bill_not_paid`, `409 no_van_rates` (legacy's alert, in Thai), `400` naming a field.
- **Writes:** van bills need `accounting`; van rates `accounting` or `fleet`; the daily report's
  settings `operations` or `accounting`. A login tied to an agent gets `403` on the reports and reads
  only its own statement.
- **The reports read the pier's money and the after-trip decisions** (§2.10): Travel Summary's
  collected, still-due, slip, sale, COT and no-show figures (`money`, `cot`, `noshow`, `collect_rows`),
  the Daily Report's `due`, `got`, `no_slip`, `extras` and each agent's `due`, and the dashboard's
  `extras_this_month`. Delete `tsMoneyOf`, `tsSaleList`, `tsNoCollect`, `drData`'s money and
  `acctExtrasMonthTotal` client-side and show these.

### 2.10 Daily PFM, pier money, on-tour sales, Travel Summary decisions

**Change: these move off the booking blob and `SB_EXTRAS`/`TS_COT`/`TRAVEL_SUM` onto commands; the
server works out every amount** (README "Proforma (Daily PFM)", "Pier money", "After the trip"). Every
`/v1/bookings/{id}/…` write below needs `If-Match` and moves the booking's `version` on.

| Legacy | API |
|---|---|
| `renderDailyPFM` rows, tallies, `pfmInScope`, `pfmCutoff` | `GET /v1/pfm?from=&to=` → `rows` (status, cutoff, total, balance, decision) and `totals` |
| `pfmApproveTravel` (the prompt's name → `approver`) | `POST /v1/bookings/{id}/pfm/approve-travel` `{ approver }` |
| `pfmHold` | `POST /v1/bookings/{id}/pfm/hold` |
| `pfmRemindAll` | `POST /v1/pfm/remind` `{ from, to }` |
| `pckMoney`, `pckMoneyCell`, `pckPayGuard`'s amount | `GET /v1/pier-money?date=` (the board) or `GET /v1/bookings/{id}/pier-money?date=` → `due`, `gross`, `paid`, `no_slip` … |
| `pckPaySave` (one line per method) | `POST /v1/bookings/{id}/pier-payments` `{ service_date, lines: [{ method, amount, fee_pct \| fee, note, slip_ids }] }` |
| `pckPayAddSlip`, `pckPayDel` | `POST …/pier-payments/{pid}/slips`, `DELETE …/pier-payments/{pid}` |
| `bkV2ExtraSave` (new / edit), `bkV2ExtraCollect`, `bkV2ExtraDelete` | `POST /v1/bookings/{id}/tour-sales`, `PATCH …/tour-sales/{sid}`, `POST …/{sid}/collect`, `DELETE …/{sid}` |
| `tsCotPick`, `tsCotAmt`, `tsCotRefSave`, the COT slips; `tsCotClear` | `PUT /v1/bookings/{id}/cot-decisions/{date}` `{ mode, deduct, payout, ref, slip_ids }`; `DELETE` |
| `tsPick`, `tsCustom`, `tsPostpone`; `tsClear` | `PUT /v1/bookings/{id}/noshow-charges/{date}` `{ decision, amount, note }`; `DELETE` |
| Travel Summary's COT and charge columns | `GET /v1/after-trip?date=` |

- **Delete client-side:** `bk.ops.pfm`, `bk.pierPayments`, `SB_EXTRAS`, `TS_COT`, `TRAVEL_SUM` and their
  persists; every fee, commission, total and `due` sum; `pfmCotWarn` (the invoice now subtracts the
  deduction itself: a minus line with `cot_date`, see 2.7).
- **Confirms that become flags:** the pier's "บันทึกต่อไหม?" is `409 overpayment` → resend with
  `overpay_anyway: true`.
- **Refusals to show as they are:** `409 before_cutoff`, `pfm_paid`, `pfm_decided`, `not_proforma`;
  `409 not_on_trip`, `booking_cancelled`, `payment_deleted`, `already_collected`, `commission_paid`,
  `no_cash_on_tour`; `400` for a fee on cash, a card fee above 5% on a sale, a computed amount sent
  different.
- **Warnings** (saved anyway): `cot_over` (legacy's "หัก+โอนออก เกินยอด COT"), `invoice_overpaid`.
- **New screens, no legacy:** the pier's day-close hand-over (`/v1/pier-handovers`, accepted by
  accounting) and commission payouts (`/v1/commissions`, `/v1/commission-payouts`).

## 3. Day-of-operations

**Change: every trip's `operations` is the truth for boats, vans, pickups and check-ins. Read it into
legacy's `ops`; write each change through its endpoint.**

### 3.1 Reading `trips[].operations` into legacy's `ops`

Legacy keeps day 1's operations on the booking (`bk.ops`) and every later day on its trip (`t.ops`):
`bkOpsRead` / `bkOpsFor` (`08-app.js:6636`). The server keeps every trip's on the trip. So in
`fromServer`, for each server trip put its `operations` into `bk.ops` when its date is the booking's
first date, else into that trip's `t.ops`. A write needs the trip's id: the `opsTripId` of the trip on
that date.

```jsonc
"operations": { "boat_id": "b2", "boat_splits": [], "boat_pulled": false,
  "pickup_time_final": "06:40", "pickup_time_final_end": null, "pickup_final_at_pier": false, "return_same_van": false,
  "pier_note": { "text": "Late, call guide", "at": "2026-09-12T05:50:00.000Z", "by": "Ploy" },
  "checkins": { "van": [], "pier": [] },
  "van_parts": [ { "idx": 0, "source": "main", "ad": 2, "chd": 1, "inf": 0, "foc": 0,
                   "group": { "id": "vgrp_…", "number": 3, "van_id": "veh07", "return_van_id": null, "pickup_time": "06:40" },
                   "sequence": 2, "return_van_id": null, "alt": null } ] }
```

| Legacy `ops` key | From `operations` |
|---|---|
| `boatId` | `boat_id` |
| `boatSplits` `[{boatId, ad, chd, inf, foc}]` | `boat_splits` `[{boat_id, ad, chd, inf, foc}]` |
| boat pulled flag (`bookingV2BoatPulled`) | `boat_pulled` |
| `pickupTimeFinal` (text) | `pickupJoin(pickup_time_final, pickup_time_final_end, pickup_final_at_pier)` |
| `returnSameVan` | `return_same_van` |
| `pierNote` `{t, at, by}` | `pier_note` `{text, at, by}` |
| `vanGroup` (number, 0 = none) | `van_parts[0].group.number` |
| `vanId` | `van_parts[0].group.van_id` |
| `vanReturnId` | `van_parts[0].return_van_id`, else `group.return_van_id` |
| `vanSeq` | `van_parts[0].sequence` |
| `vanSplits` (when more than one part) | one entry per part: `ad, chd, inf, foc`, `vanGroup`/`vanId` from its `group`, `vanReturnId`, `vanSeq` from `sequence`, `fromAlt` = `source === "alt_pickup"`, and the alternate point's keys from `alt` (`pick_*`, `drop_*`, `alt_who`, `pick_time`) |
| `vanCheckin` / `pierCheckin` | `checkins.van` / `checkins.pier` by slot (§3.6) |
| `t.upg` | `operations.upgrade` `{from_route_id, to_route_id, reason, charge, upgrade_id, at, by}` (§3.9) |

**Delete:** legacy's local boat-pulled check (`_bkV2BoatPulled1`), the auto split builders that run
in the browser (`bookingV2HealAltSplits`, `bookingV2SyncAltPickupSplits`, `bookingV2HealSplitPax`),
`bkOpsClear` on a move (the server does it).

### 3.2 Dispatch: boat, boat splits, final pickup, pier note, van parts

**Change: one endpoint, `PATCH /operations/trip-ops/{trip_id}`, for every per-trip dispatch edit.**

An absent field is unchanged, `null` clears it. It answers `{ "trip": …, "warnings": [] }`. Needs the
`operations` edit area.

| Legacy function | Body |
|---|---|
| `bookingV2AssignBoat` (and `bookingV2BoatAssignSelected`) | `{ "boat_id": "b2" }` (`null` unassigns) |
| `bookingV2BoatSplitApply` | `{ "boat_splits": [{ "boat_id": "b2", "ad": 4, "chd": 0, "inf": 0, "foc": 0 }, …] }` |
| `bookingV2BoatUnsplit` | `{ "boat_splits": null }` |
| `bookingV2SetPickupFinal` | `{ "pickup_time_final": "06:40" }`, or a window / pier deadline split with `pickupSplit` into `pickup_time_final`, `pickup_time_final_end`, `pickup_final_at_pier` |
| `bookingV2SetReturnSameVan` | `{ "return_same_van": true }` |
| `pckNoteSet` (pier note) | `{ "pier_note": "Late, call guide" }` (`null` clears). The server stamps `at` and `by` |
| `bookingV2VanSplit`, `bookingV2SplitApply`, `bookingV2VanUnsplit` | `{ "van_parts": [{ idx, ad, chd, inf, foc, group_id?, sequence?, return_van_id? }, …] }`; `null` or `[]` = one whole part |
| `bookingV2AssignVanReturnSplit` | `van_parts[i].return_van_id` |
| `bookingV2SetSplitPickTime` | `van_parts[i].pick_time` (only on a part with its own pickup) |

Rules (README → "Dispatch"):
- `boat_id` must be deployed on the trip's route that day: else `409 boat_not_deployed`. Send
  `boat_id` or `boat_splits`, not both; a split clears `boat_id`.
- `van_parts` must add up to the trip's passengers, category by category (`400`). A part with
  children and no adult is allowed with `"warnings": ["child_without_adult"]`: show legacy's warning.
- `group_id` must be a group of the trip's route and day (`400`) and pickup zone
  (`409 zone_mismatch`); a NoTransfer trip rides no van (`409 self_arrive`); the group's van must seat
  everyone (`409 van_over_capacity`).
- `return_van_id` must be in the return pool (`409 van_not_in_pool`) and is refused with
  `return_same_van: true` (`400`).
- An alternate-pickup part's passengers can't be changed (`409 alt_pickup_split`).
- A cancelled or rejected booking: `409 cancelled`. Unknown trip: `404`.

**Delete:** the local "boat is chartered that day" check in `bookingV2AssignBoat` (the server refuses
an undeployed boat; a charter is its own trip). **Keep for now** its boat-capacity check
(`§baCapGate`): the API does not check a boat's seats on assignment (see "Questions").

### 3.3 Van groups

**Change: a van group is a server record with an id. Legacy's group number maps to it.**

Legacy keys a group by date, route, zone and number (`vanGroup`). The server's group has `id`,
`number`, `zone`, `van_id`, `return_van_id`, `pickup_time`. Number is unique per route and day,
across zones, so look the group up by `(service_date, route_id, number)` from:

```
GET /operations/van-groups?service_date=2026-10-02&route_id=r1
```

```jsonc
{ "id": "vgrp_…", "service_date": "2026-10-02", "route_id": "r1", "zone": "PK", "number": 3,
  "van_id": "veh07", "return_van_id": null, "pickup_time": "06:40",
  "pax": 12, "customer_pax": 11, "stop_seats": 1, "capacity": 12, "over_capacity": false,
  "stops": [ … ],
  "members": [ { "trip_id": "trip_…", "booking_id": "lg_…", "idx": 0, "source": "main", "ad": 2, "chd": 1, "inf": 0, "foc": 0,
                 "sequence": 1, "pickup_time": "06:40", "return_van_id": null } ] }
```

| Legacy function | API |
|---|---|
| `bookingV2VanGroupSelected(date, routeId, zone, groupId)` into a **new** group number, `bookingV2VanAutoAssign` | `POST /operations/van-groups` `{service_date, route_id, zone, members: [{trip_id, idx?}], van_id?, allow_second_round?}` → `201`; the server gives the `number` |
| `bookingV2VanGroupSelected` into an **existing** group | `POST /operations/van-groups/{id}/members` `{members: [...]}` (moves them from any other group) |
| `bookingV2AssignVan(bkId, vanId, date)` (a van on one booking) | the API keeps a van on a group only: put the part in a group with that van (`POST /operations/van-groups` with `van_id`, or `…/{id}/members` of the group that has it) |
| `bookingV2VanGroupSetVan` | `PATCH /operations/van-groups/{id}` `{van_id}` |
| `bookingV2VanGroupSetReturn` | `PATCH …/{id}` `{return_van_id}` |
| `bookingV2VanGroupSetTime` | `PATCH …/{id}` `{pickup_time}` (also becomes every member's final pickup) |
| `bookingV2VanGroupSave` (pickup order inside a group) | `PUT /operations/van-groups/{id}/order` `{members: [...]}` |
| `bookingV2VanGroupClearSeq` | `PUT …/{id}/order` `{clear: true}` |
| `bookingV2VanGroupDisband` | `DELETE /operations/van-groups/{id}` → `204` |
| `bookingV2VanClearRoute` | `POST /operations/van-groups/clear` `{service_date, route_id}` |
| `bookingV2GrpOrderSet`, `bookingV2GrpMove` (the order groups are listed in, `bkv2_grp_order`) | `PUT /operations/van-groups/order` `{service_date, route_id, zone, group_ids}` → the day's groups, in that order |
| `bookingV2GrpOrderReset` | `PUT /operations/van-groups/order` `{service_date, route_id, zone, clear: true}` |

- **"Run another round" dialog** (`§vgRound` in `bookingV2VanGroupSetVan`): send without
  `allow_second_round`; on `409 van_in_other_group` show legacy's confirm (the message names the
  other groups and times), then resend with `"allow_second_round": true`.
- **Seat refusal:** `409 van_over_capacity` replaces legacy's "ที่นั่งไม่พอ" alert. Show the message.
- Other refusals: `409 van_not_in_pool` (van not on that route that day in the month matrix, or not
  usable), `409 zone_mismatch`, `409 self_arrive`, `409 cancelled`, `400` for a member not on the
  group's route and day, or an order that does not list each member once.
- After a group write, refetch the members' bookings (or let the change feed do it, §5): their
  `operations` changed.
- `GET` needs a `route_id`: the day's board is one call per route sailing that day.

**Delete:** `bookingV2VanGroupPax`-based seat checks, `_bkV2VanOtherGroups`, `bookingV2VanGroupHeal`,
`bookingV2VanGroupConflicts` as deciders, and `_bkV2GrpApply` writing `vanId`/`pickupTimeFinal` into
each member.

### 3.4 Vans and the month matrix (Vans page)

**Change: `SB_VEHICLES` is loaded from and saved to `/operations/vans`; each day's routes, status,
zone and driver to `/operations/van-days`.**

Today `SB_VEHICLES` is the seed at `08-app.js:180`, and `sbVehiclesPersist` saves nowhere.

| Legacy function | API |
|---|---|
| load | `GET /operations/vans` and `GET /operations/van-days?from=&to=` (at most 93 days) |
| `vehFormSave` (add / edit) | `POST /operations/vans` `{name, capacity?, plate?, type?, ownership?, partner_name?, zone_base?, color?, driver?, driver_phone?, active?, note?}` / `PATCH /operations/vans/{id}` |
| `vehSetField`, `vehSetColor` | `PATCH /operations/vans/{id}` |
| `vehDelete` | `DELETE /operations/vans/{id}` (`409 van_in_use`: "… set it inactive instead") |
| `vehDayToggleRoute`, `vehDaySetRoute`, `vehDayClearRoutes` | `PUT /operations/van-days/{date}/{van_id}` `{route_ids: [...]}` (`[]` clears) |
| `vehDaySetStatus`, `vehStatusCycleDay` | `PUT …/van-days/{date}/{van_id}` `{status}` |
| `vehDaySetZone` | `PUT …` `{zone}` |
| driver of the day (`VANJOB_DRIVER`, `vanJobsDriverPersist`) | `PUT …` `{driver, driver_phone, plate}` |
| job order sent (`VANJOB_SENT`, `vanJobsToggleSent`) | per job now: `PUT` / `DELETE /operations/van-jobs/{date}/{key}/sent` (§3.4b). `sent_at` on a van day is `400` |
| `vehStatusAdd` / `vehStatusSet` / `vehStatusDel` | `POST /operations/vans/{id}/status-ranges` `{status: "off"\|"maintenance", from_date, to_date?, note?}`, `PATCH …/status-ranges/{range_id}`, `DELETE …` |
| `vehZoneAdd` / `vehZoneSet` / `vehZoneDel` | `POST /operations/vans/{id}/zone-ranges` `{zone: "PK"\|"KL", from_date?, to_date?}`, `PATCH`, `DELETE` |
| the van's log | `GET /operations/vans/{id}/log?limit=` |

```jsonc
// GET /operations/van-days?from=2026-10-01&to=2026-10-31 (one day row)
{ "van_id": "veh07", "service_date": "2026-10-01", "route_ids": ["r1", "r5"], "status": null, "zone": null,
  "driver": null, "driver_phone": null, "plate": null,
  "status_on": "maintenance", "usable": false, "zone_on": "KL" }
```

- `name` is required (`400`, "Please enter a vehicle name"). An unknown route is `400`; a range
  ending before it starts is `400`.
- A new van gets legacy's defaults and a `veh…` id from the server.
- **Delete:** `vehStatusOn`, `vehEffectiveZone` (read `status_on`, `usable`, `zone_on`), and `vehLog`
  (the server writes the log in legacy's words).
- Vans are **not in the change feed** yet: refetch on opening the page.

### 3.4b Van job orders (Van Job Orders page)

**Change: the job list and each sheet come from the server; the sent tick, the special request and
the Thai pickup names are saved there.** README "Van job orders" has the shapes.

| Legacy function | API |
|---|---|
| `renderVanJobs` (the rows, hero banner, `selfWarn`) | `GET /operations/van-jobs?date=` → `{jobs, unassigned, return_unarranged, self_arrive, struck}` |
| `vanJobsOrderInner` (one sheet, both legs) | `GET /operations/van-jobs/{date}/{key}` → `{job, out, ret, ret_on_round_1, unassigned_on_route}` |
| `vanJobsToggleSent` | tick: `PUT /operations/van-jobs/{date}/{key}/sent`; untick: `DELETE …/sent` |
| `vanJobsSetSreq` / `vanJobsResetSreq` (`VANJOB_SREQ`) | `PATCH /v1/bookings/{id}` `{job_note, version}`: text, `""` blank, `null` reset |
| `vanJobsSetPickupTh` (`VANJOB_PICKUP_TH`) | `PUT /operations/pickup-names-th` `{name, name_th}` (empty `name_th` deletes) |
| driver of the day (`vanJobsSetDriver`) | unchanged: `PUT /operations/van-days/{date}/{van_id}` (§3.4) |
| `vjTpl`, `vjHl*` (template, row highlights) | not in the API: the client's |

- A job's `key` is the van group's id, or `<van_id>~<route_id>` for a van that only brings people
  back; legacy's `van~route[~group]` keys are gone. Rounds are `job.round` `{no, of, time}`.
- `sent.changed_since_sent: true` is new: the sheet changed after it was sent. Show it next to the
  tick (the tick stays); ticking again re-sends. `null` = sent in legacy, unknown.
- Every booking read has `special_request` (the override, else the notes): van check-in
  (`ckRowHtml`) and the pier (`pckJobNote`) read that instead of `vanJobsSreqFinal`.
- A struck-through row (`struck: "cancelled"`) is cleared with `PATCH /operations/trip-ops/{trip_id}`
  `{van_parts: null}` (legacy "ล้างออก").
- **Delete:** `VANJOB_SENT`, `VANJOB_SREQ`, `VANJOB_PICKUP_TH`, `bkv2_grp_order` and their
  `*Persist`; `vjRoundAll`, `vjRoundPick`, `vanJobsBookingsFor`, `vanJobsSreqFinal` as deciders.

### 3.5 Van stops

**Change: `VAN_STOPS` moves to `/operations/van-stops`; a stop rides a van group.**

| Legacy function | API |
|---|---|
| `vsFor(date, routeId)` | `GET /operations/van-stops?service_date=&route_id=` |
| `vsSubmit` / `vsSave` (new) | `POST /operations/van-stops` `{group_id, kind?, label, pax?, time?, place, area_id?, area?, leg?, phone?, note?, sequence?, seats_anyway?}` |
| `vsSubmit` (edit), `vsSetVan` | `PATCH /operations/van-stops/{id}` (a `group_id` moves it to another group) |
| `vsDel`, `vsDelGo` | `DELETE /operations/van-stops/{id}` |
| `vsCheck(k, on)` | `PUT` / `DELETE /operations/van-stops/{id}/check-in` |

- Legacy's form messages come back as `400`: "Type what this stop is for", "Type where the van stops",
  "How many people ride along? Enter at least 1".
- `409 group_has_no_van` is legacy's "เลือกรถก่อน". `409 van_over_capacity` → legacy's "Add anyway?"
  confirm, then resend with `"seats_anyway": true`.
- **Delete:** `vsSeats`, `vsSeatsOfVan` as seat checks (the group's `stop_seats` and `pax` say it).
- Not in the change feed yet.

### 3.6 Check-in (van and pier)

**Change: `ckWrite` writes one record per trip, side and slot through the API.**

| Method + path | Body | Answers |
|---|---|---|
| `PUT /operations/trip-ops/{trip_id}/checkins/{van\|pier}/{slot}` | the whole record | `{ trip, warnings: [] }` |
| `DELETE /operations/trip-ops/{trip_id}/checkins/{van\|pier}/{slot}` | — | `{ trip, warnings: [] }`; `404` if none |

```jsonc
{ "slot": 0, "expected": 3, "actual_pax": 2, "no_show": 1,
  "checked_in_at": "2026-10-02T23:45:00.000Z", "checked_in_by": "Somchai",
  "reason_code": "not_down", "reason_note": "lobby empty", "reason_at": "06:40",
  "arrived_at": null, "arrived_by": null, "cleared_at": null, "cleared_by": null,
  "flow": "standby", "flow_at": "06:35", "flow_by": "Somchai", "flow_note": null,
  "reinstate": null, "self_add": null,
  "events": [ { "type": "no_show", "pax": 1, "ad": 1, "chd": 0, "inf": 0, "foc": 0, "reason_code": "not_down", "note": "lobby empty",
                "at": "06:40", "by": "Somchai", "ts": "2026-10-02T23:40:00.000Z", "undone": null,
                "tries": [ { "at": "06:50", "by": "Somchai", "note": "called again", "ts": "…" } ] } ],
  "updated_at": "…", "updated_by": "Ploy" }
```

- **Mapping:** legacy's record (slot 0 at the top of `vanCheckin`/`pierCheckin`, others under `_s`)
  maps key by key: `at`↔`checked_in_at`, `by`↔`checked_in_by`, `actualPax`↔`actual_pax`,
  `reasonCode`↔`reason_code`, `arrivedAt`↔`arrived_at`, `selfAdd`↔`self_add`, an event's
  `paxBreak{ad,chd,inf,foc}`↔ its `ad`, `chd`, `inf`, `foc`, and so on. `slot` is the van part's
  `idx`.
- **A write replaces the record**, as `ckWrite` does. Staff names (`checked_in_by`, an event's `by`)
  stay the client's (`ckMe()`); `HH:MM` fields stay `HH:MM`; instants are ISO.
- **Computed:** `no_show` (`expected − actual_pax`) and `updated_at`/`updated_by`. Do not compute
  `no_show` for saving.
- **Refused:** `400` for counts above what the part booked, a slot that is not a van part, or a bad
  field (`events[1].type must be no_show or cxl`); `409 events_append_only` when a recorded event or
  try is removed, reordered or changed; `409 event_undone_is_final` when an `undone` is changed or
  cleared. To take an event back, set its `undone` (`why`: `found` or `mistake`), once.
- Edit areas `operations` or `pier`, as `ckCanEdit`.
- **Behaviour change:** legacy let a later save rewrite history; the server keeps events append-only.
- **Delete:** local `no_show` arithmetic for storage, and the `o.vanCkS` / `o.pierCkS` shadow copies.

### 3.7 Reconfirm

**Change: the Re-confirm page and the ops board write `reconfirm` through three endpoints.**

| Method + path | Body | Answers |
|---|---|---|
| `PUT /v1/bookings/{id}/reconfirm` | `{status, via?}` | the booking |
| `DELETE /v1/bookings/{id}/reconfirm[?all=true]` | — | the booking |
| `POST /v1/reconfirm/sent` | `{booking_ids: [...], sent: true\|false}` | `{bookings: [{id, reconfirm}], skipped: [{id, reason}]}` |

```jsonc
"reconfirm": { "status": "done", "via": "reconfirm", "at": "2026-09-09T10:02:11.000Z", "by": "Nok",
               "sent": true, "sent_at": "2026-09-09T11:00:00.000Z", "sent_by": "Nok" }
```

| Legacy function | API |
|---|---|
| `rcSetStatus(bkId, v)` (Re-confirm page) | `PUT …/reconfirm` `{status: v}` (`via` defaults to `reconfirm`); clearing: `DELETE …/reconfirm` (keeps `sent`) |
| `rcSendAgent(key)` | `POST /v1/reconfirm/sent` `{booking_ids, sent: true}` |
| `rcUnsendAgent(key)` | `POST /v1/reconfirm/sent` `{booking_ids, sent: false}` |
| `bookingV2Reconfirm(bkId, via)` (ops board) | `PUT …/reconfirm` `{status: "done", via: "list"\|"phone"}` |
| `bookingV2ReconfirmAll(date, rid, via)` | one `PUT` per booking, skipping those already `done` |
| `bookingV2ReconfirmClear(bkId)` (ops board) | `DELETE /v1/bookings/{id}/reconfirm?all=true` |

- `status` is `wa`, `noans`, `off`, `callback` or `done`; anything else is `400`. The server stamps
  `at`/`by` and writes legacy's history line.
- Sending passes over cancelled and rejected bookings and lists them in `skipped`. An unknown id
  refuses the whole request (`400`).
- These writes do not change the booking's `version`.
- **Delete:** the local `bk.ops.reconfirm = {…}` writes, `_rcKeepSent`, and the local history lines.

### 3.8 Alternate pickups

**Change: send `altPickups` with the booking; the server builds the van parts.**

Legacy: `bookingV2AddAltPickup`, `bookingV2SetAltPickup*`, `bookingV2RemoveAltPickup`,
`bookingV2ToggleAltDropSame`, `bookingV2SetAltDropArea`, built in `bookingV2CommitBooking`.

```jsonc
"alt_pickups": [ { "who": "Mr B", "ad": 1, "chd": 0, "inf": 0, "foc": 0,
                   "area_id": "pk-kata", "area": "Kata", "zone": "PK", "place": "Kata Palm",
                   "drop_same": true, "drop_area_id": null, "drop_area": null, "drop_zone": null, "drop_place": null } ]
```

- Sent on `POST`/`PATCH /v1/bookings` as `altPickups` (legacy keys accepted). Present replaces the
  list; `[]` clears it.
- The server builds the `alt_pickup` van parts on every trip (legacy did day 1 only), after every
  create, edit, partial cancel and reschedule. A hand-made split (`manual` parts) is left alone.
- **Delete:** `bookingV2SyncAltPickupSplits`, `bookingV2HealAltSplits`.

### 3.9 Upgrades: on-tour sales and route upgrade

**Change: on-tour sales are the booking's `upgrades` list; a route upgrade is a command.**

On-tour sales (`bookingV2UpgradeSave`, `bookingV2UpgradeDelete`, `bookingV2UpgradeRender`): send the
**whole** list with `PATCH /v1/bookings/{id}` `{ "upgrades": [...] }` (with `If-Match`), starting from
the server's list so ids and slips are kept.

```jsonc
"upgrades": [ { "id": "up_1789029877535", "label": "Longtail · Join → เหมา (Charter)", "sell_price": 1100, "to_company": 770,
                "commission": 330, "seller": "BEST", "note": null, "collected": true, "settle": "pending",
                "method": "card", "fee_pct": 5, "fee": 55, "customer_paid": 1155, "at": "2026-09-10T08:44:37.535Z",
                "slips": [ { "id": "att_mtvcoqp0_efb5fa2ab1", "name": "4767.jpg", "mime": "image/jpeg", "size": 539033 } ] } ]
```

- Legacy spellings (`sellPrice`, `toCompany`, `feePct`) are accepted. `slips` are uploaded file ids
  (§3.11).
- **Computed:** `commission`, `fee`, `customer_paid`, `at`. Values sent for them are replaced.
- **`collected` is set once:** send it on a new sale; afterwards the "เก็บเงินแล้ว" tick calls
  `POST /v1/bookings/{id}/upgrades/{upgrade_id}/collect` `{ method?, fee_pct?, slip_ids? }`. A
  `PATCH` that flips it is `400`.
- **Refused (`400`):** no `sell_price` above 0 ("ใส่ราคาขาย"), `fee_pct` above 100, an `id` twice,
  `settle` other than `pending`/`done`, a slip that is not an uploaded file.

Route upgrade (`bookingV2UpgModal`, `bookingV2UpgApply`, `bookingV2UpgUndo`):

| Method + path | Body | Answers |
|---|---|---|
| `POST /v1/bookings/{id}/upgrade` | `{trip_id, to_route_id, reason, charge?}` | the booking |
| `POST /v1/bookings/{id}/upgrade/undo` | `{trip_id}` | the booking |

- Keep legacy's confirm dialog (`§upgConfirm`), then call the command. Read `operations.upgrade`
  into `t.upg`.
- **Refused:** `400` with no `reason` ("Enter a reason."), the same route, a trip not on the booking,
  a negative charge; `409 charter`, `409 overnight` ("Edit the booking instead"), `409 lock_draw`
  ("Release the lock draw first"), `409 already_upgraded`, `409 route_not_sailing`,
  `409 not_enough_seats` ("Needs 2, free 1"); undo `409 not_upgraded`.
- **Delete:** in `bookingV2UpgApply` / `bookingV2UpgUndo`, the local seat check against
  `getAllotment`, the move of `t.routeId`, the `b.upgrades` push for the charge, the boat clearing and
  the history line. The server does all of it, at the price the trip was booked at.

### 3.10 Allergy list and pier meals

- **Allergy list** (`bookingV2AllergyAdd`, `…AddPreset`, `…SetQty`, `…Remove`): send
  `allergy_list` `[{name, qty}]` (or legacy's `specialMeals.allergyList`) with the booking. Two
  entries with the same name become one. `400` for a blank name or `qty` below 1. Read
  `allergy_count`; **delete** `bookingV2AllergyCount`.
- **Pier meal editor** (`pckMealSave`): `PUT /v1/bookings/{id}/meals` `{veg?, vegan?, halal?,
  allergies?}` with `If-Match`. It answers the booking with `special_meals_pier_at` and
  `special_meals_pier_by` stamped from the login. **Delete** the local `sm.pierAt` / `sm.pierBy`
  stamps. Never send those two on a create or edit unless unchanged (`400` otherwise).

### 3.11 Attachments (documents and slips)

**Change: files upload to `POST /v1/attachments`, not `/api/attach`; a booking or a sale names them
by id.**

| Method + path | Body | Answers |
|---|---|---|
| `POST /v1/attachments` | `{filename, mime, data_b64}` (legacy's `dataB64` too) | `201 {id, name, mime, size}` |
| `GET /v1/attachments/{id}` | — | the file, with its `Content-Type` |
| `DELETE /v1/attachments/{id}` | — | `204` |

Legacy callers: `bookingV2AttachUpload`, `bookingV2AttachRemove`, `bookingV2AttachListHTML`,
`pckSlipUpload` (`08-app.js:14630`), the upgrade/extra slip pickers, doc check's viewer and OCR
(`docCheckRunPre`, `worker.recognize('/api/attach/…')`), `laSlipUrl` (`05-fleet.js:14947`).

- **Upload, then name it.** The upload has no booking id. Put `{id, kind}` in the booking's
  `attachments` (`kind`: `upload`, `capture`, `paste`) or the sale's `slips`, and save that. A read
  fills `name`, `mime`, `size`, `by`, `at`.
- **Showing a file needs the Bearer header.** An `<img src>` or a link cannot send it. Fetch through
  `laOpsFetch`, then show `URL.createObjectURL(blob)`; give OCR the blob. Today every
  `'/api/attach/' + id` URL is a dead link with legacy off.
- **Refused (`400`):** over 6 MB, a type other than `image/jpeg`, `image/png` or `application/pdf`,
  data that isn't base64. **Behaviour change:** legacy's slip upload took any type.
- **Delete:** a file still named by a booking or an upgrade sale is `409 attachment_in_use`. Remove
  it from the list and save first, then delete (or leave it).
- Upload and delete need `operations`, `pier` or `accounting`; any login may download.

### 3.12 Document check (Doc Check page)

**Change: ticks, status, note and the OCR pre-check each have a `PUT`.**

| Legacy function | API |
|---|---|
| `docCheckToggleItem(bkId, k)` | `PUT /v1/bookings/{id}/doc-check/items/{item}` `{checked}` (`route`, `date`, `lead`, `pax`, `voucher`, `payment`) |
| `docCheckSetStatus(bkId, status)` | `PUT …/doc-check/status` `{status: "verified"\|"issue", note?}` |
| `docCheckSetNote(bkId, val)` | `PUT …/doc-check/note` `{note}` (debounce: it fires while typing) |
| `docCheckRunPre(bkId)` | `PUT …/doc-check/pre` `{at?, lang?, error?, text?, results: {item: {s\|result, ev\|evidence, detail}}, auto_tick?}` |

```jsonc
"doc_check": { "status": "verified", "by": "Nok", "at": "2026-09-09T10:02:11.000Z", "note": null,
  "items": { "route": true, "date": true, "lead": true, "pax": true, "voucher": true, "payment": false },
  "pre": { "at": "…", "lang": "eng", "error": null, "text": "VOUCHER …",
           "results": { "lead": { "result": "match", "evidence": "MR SMITH", "detail": null } },
           "summary": { "match": 1, "maybe": 0, "mismatch": 0, "none": 5 } } },
"doc_check_status": "verified"
```

- Each answers the booking; take it whole. The first write creates the record as `pending`.
- The pre-check ticks matched items unless `auto_tick: false`; it never unticks.
- **Delete:** `docCheckStatus` (read `doc_check_status`), the local `by`/`at` stamps, `_docCheckPersist`.

### 3.13 Deployments (Boat Operation)

**Change: the server refuses a boat change that strands sold seats or edits the past; the confirm
dialog resends with `remove_anyway`.**

**Already right:** `ops/20-ops-deployments.js` diffs `TRIPS` and sends `POST /operations/deployments`
/ `DELETE /operations/deployments/{service_date}/{boat_id}`, rolling back on refusal.

```jsonc
// POST /operations/deployments
{ "boat_id": "b2", "route_id": "r1", "service_date": "2026-10-12", "capacity": 40, "remove_anyway": true }
```

| Refusal | When | What the screen does |
|---|---|---|
| `409 seats_sold` ("N booking(s) (P pax) on it") | removing a boat, moving it to another route, or shrinking it below the passengers placed on it | legacy's confirm (`bop2UnassignBoat`, `bop2AssignBoat`) with the server's message; on yes resend with `remove_anyway: true` (`?remove_anyway=true` on `DELETE`) |
| `409 charter_boat` ("Cancel the charter booking first") | a boat a charter holds | show it |
| `409 past_date` | a date before today (Asia/Bangkok), unless the login is an admin | show it |
| `409 boat_not_ready` ("… is not ready on …: fixing, held by MJ-058") | putting a boat that is fixing/unavailable that day (its log or a started job), or a charter boat not chartered that day, on a route or another route | single assign: the pool already hides such a boat; if it still happens, confirm with the message and resend with `deploy_anyway: true`. Range and weekly forms: skip that day as `statusBlocked` does. Copy week/day, templates: resend with `deploy_anyway: true` to keep legacy's behaviour |
| `400` | a `license_pax` that differs from the boat catalogue's | show it |

- With `remove_anyway`, the answer carries `warnings: [{code: "boat_pulled" | "oversold", route_id,
  service_date, boat_id, bookings, pax}]`; those bookings read `operations.boat_pulled: true`.
- `runBatch` sends several changes in a row; resend only the refused one with `remove_anyway`.
- **Behaviour change:** `bop2GuardPast` blocks everyone on a past date; the server lets an admin
  correct history. See "Questions".
- **Delete:** `baAssignedBookings` as the decider of the warning count (use the server's message).
- Boat per-day seat overrides (`boatCapSet`) now have their own write (§3.14); stop sending them as
  the deployment's `capacity`. A retired boat can't be deployed: `409 boat_retired`, show it.

### 3.14 The catalogue: Programs, the boat form, Boat Status, the day-seats dialog

**Change: routes, families and boats are edited on the API (2026-10-09). Their screens save through
the endpoints below; `save('config')` and `boatCapPersist` stop writing the catalogue.** README
"Editing routes", "Editing boats", "A boat's seats for one day" are the field reference.

| Screen (legacy function) | Call |
|---|---|
| Programs: add / edit (`saveRoute`) | `POST /v1/routes`, `PATCH /v1/routes/{id}` `{name, islands, times, kind, pier, family_id}` |
| Programs: delete (`delRoute`) | `DELETE /v1/routes/{id}`; `409 route_in_use` names what uses it: show it, nothing is deleted |
| Programs: drag (`stApplyRouteOrder`) | `POST /v1/routes/order {pier, route_ids}` (every route of that pier, in the new order; `pier: null` for the land ones) |
| Family drop-down (`_BKV2_FAMILIES`, `_famFillRouteSelect`) | `GET /v1/route-families`; blank choice = `family_id: null` |
| Boat form: add / edit (`saveBoat`, `flOpenEditBoatModal`) | `POST /v1/boats`, `PATCH /v1/boats/{id}` with the form's fields (legacy names accepted), `documents`, and the status pick as `status` |
| Boat Status timeline (`saveStatus`, `editStatus`, `delStatus`) | `POST /v1/boats/{id}/status-log`, `PATCH …/status-log/{entry_id}`, `DELETE …/status-log/{entry_id}` |
| Restore a boat (`flUnretireBoat`) | `POST /v1/boats/{id}/restore` (and `/retire {reason}`, which legacy never wired) |
| Day-seats dialog (`boatCapModalOpen`, `_bcapSave`, `_bcapClear`) | `PUT /v1/boats/{id}/capacity-overrides/{date} {capacity, reason}`, `DELETE …/{date}`; `GET /v1/boats/{id}/capacity-overrides?from=&to=` for the badge and "set by" |

- **Load** `ROUTES` from `GET /v1/routes` (`familyId` ← `family_id`, `extId` ← `ext_id`) and `BOATS`
  from `GET /v1/boats` (`cap` ← `capacity`, `licensePax` ← `license_pax`, `totalcap` ←
  `registered_persons`, `log` ← `status_log` with `s` ← `status`, `from`/`to` ← `from_date`/`to_date`,
  `docs` ← `documents` with `exp` ← `expires_on`). Use `status_today` instead of `getStoredStatus`
  for today, and `status_effective`/`blocked_by` (or `GET /v1/fleet/availability` for other days)
  instead of `getCurStatus`/`boatEffStatus`/`boatJobBlock`.
- **Planned ahead** (`saveStatus`'s "ยังมีใบงานที่ไม่ถูกปิด" confirm): an `available` entry over open
  work answers `409 open_work`; on yes resend with `plan_ahead: true`. The server adds the
  `LA_PLAN_MARK` text to the note and returns `planned_over` (`ovrJobs`); stop writing the mark.
- **Refusals to show as they are:** `400` (the message names the field: a blank name, a marine route
  with no pier, an unknown family, over the licence on the day-seats dialog, a missing reason),
  `403` (the area, or "unlock boat capacity" on a raise), `409 route_in_use`, `409 family_in_use`,
  `409 future_deployments` (retire), `409 past_date` (day seats).
- **`409 seats_sold` on a boat edit** (a capacity cut below the passengers placed on a future day):
  confirm with the server's message and resend with `capacity_anyway: true`; the answer's
  `warnings` list the oversold days.
- **Behaviour changes (server rules):** the boat form needs `config` and now says so (`403`) instead
  of losing the edit; a capacity above the licence saves with a `capacity_above_licence` warning; a
  blank capacity is 40 but `0` is `400`; the day-seats dialog refuses over the licence instead of
  clamping; the day-seats "set by" is the login (legacy wrote `—`); `daily_cap` (land quota) is not
  kept (`400` for a value).
- **Delete:** `boatCapPersist`, the `BOAT_CAP_OVR` local copy, `ROUTE_COLORS` picking and route/boat
  id making (`'r'+Date.now()`, `LA_UID('b')`): the server does them.

### 3.15 Fleet: assets, incidents, maintenance jobs (part A)

**Change: engines, gearboxes, propellers, incidents and maintenance jobs are this API's
(2026-10-09). Their screens call the endpoints below; `flSave` stops writing `FL_ENGINES`,
`FL_GEARBOXES`, `FL_PROPELLERS`, `FL_INCIDENTS`, `FL_MAINT`.** README "Fleet maintenance" is the field
reference. Seed once with `npm run import:fleet -- --commit`.

| Screen (legacy function) | Call |
|---|---|
| Asset forms (`flSaveEngine`, `flSaveGearbox`, `flSavePropeller`, `flSaveAddSpare`) | `POST /v1/fleet/{engines,gearboxes,propellers}`; edit `PATCH …/{id}` with the form's fields only |
| Status change (`flChangeEngStatus`, the forms' status pick) | `POST …/{id}/status {status}` |
| Install / remove / swap (form selects, `flEquipRemove`, `flEquipSwapDo`) | `POST …/{id}/install`, `…/remove`, `…/swap {with_id}` |
| Move a spare (`flConfirmMove`) | `POST /v1/fleet/{gearboxes,propellers}/{id}/move` |
| Mark service (`flEngMarkService`, `flGbMarkService`) | `POST …/{id}/service {hours}` (the `prompt()` answer) |
| Incident add / edit / delete / log (`flSaveIncident`, `flDeleteIncident`, `flAddIncLog`) | `POST /v1/fleet/incidents`, `PATCH …/{id}`, `DELETE …/{id}`, `POST …/{id}/log` |
| Quick swap (`flConfirmSwap`, `flConfirmPropCascade`) | `POST /v1/fleet/incidents/{id}/swap` with the cascade choices in one call |
| Create job (`flSaveCreateJob`, `flChooseJobMode`) | `POST /v1/fleet/jobs`; the open-job confirm resends `create_anyway: true`; the one-or-per-asset choice is `per_asset` (+ `nos`) |
| Start (`flMaintStart`, `flStartGear*`) | `POST /v1/fleet/jobs/{id}/start {gear}`; the swap's replacement engine: `POST /v1/fleet/engines/{id}/install {boat_id, pos, job_id}` |
| Close (`flMaintClose`, `flMaintServiceReset` confirm) | `POST …/{id}/close {outcome, note, awaiting_invoice}`; on `409 reset_service_choice` ask legacy's question, resend with `reset_service` |
| Edit boat status (`flSaveEditBoatStatus`) | `POST …/{id}/boat-status` |
| Job assets, log, split, pin (`flMaintAddAsset`, `flMaintAddLog`, `flSplitExistingJob`, `flEngSplitIntoJobs`, `flMaintTogglePin`) | `POST/DELETE …/assets`, `POST …/log`, `POST …/split {by, nos}`, `PATCH {pinned}` |
| Job board (`flBoardSaveCard`, `flBoardDrop`, `flBoardPark`, `flBoardSub*`) | `PATCH …/{id} {owner, due_date, board_lane, parked}`, `POST …/log`, `…/steps…` |

- **Numbers stay the client's** (decided): send `no` (and `nos`) computed as today
  (`next_no` in the list answers says it); `409 number_taken` means pick the next one.
- **Read, don't compute:** `hours`/`service` (`flEngHours`, `flEngServiceState`, `flGbServiceState`),
  `severity`, `shown_status` (`effStatus`), `cost` (`flMaintCalcCost`), `lane`/`silent_days`
  (`flBoardLane`, `flBoardSilent`), labels of damaged assets.
- **Behaviour changes:** see todo/fleet-maintenance-model.md "Flagged" (closing a job run alongside
  the boat no longer cuts the boat's status entry; the per-asset choice really makes one job per
  asset; the board fields, engine `retired` and gearbox service hours are kept).
- **Part B (§6.7):** parts from stock are `POST /v1/fleet/jobs/{id}/parts` and `DELETE …/parts/{idx}`
  (`flMaintAddPart`, `flMaintRemovePart`); `hours` counts the Daily Log meters; a job's `cost` its memos;
  a project in progress holds its boat.

---

## 4. Pickup areas and pickup-time profiles (Pickup time setup)

**Change: the areas and the time tables live on the API. Load them at boot; save each edit.**

Today `SB_PICKUP_AREAS`, `SB_PICKUP_TIMES` and `SB_PICKUP_TIME_PROFILES` (`08-app.js:1232-1338`) are
seeds, and `psuPersist` saves nowhere. Bookings are refused for an area the API does not have.

| Method + path | Body | Answers |
|---|---|---|
| `GET /v1/pickup-areas[?active=true]` | — | `{ areas: [{id, name, zone, region, time_group, active}] }` |
| `POST /v1/pickup-areas` | `{name, zone, time_group, region?}` | `201` the area |
| `PATCH /v1/pickup-areas/{id}` | any of `name`, `zone`, `region`, `time_group`, `active` | the area |
| `DELETE /v1/pickup-areas/{id}` | — | the area, now `active: false` |
| `GET /v1/pickup-time-profiles` | — | `{ profiles }` |
| `GET /v1/pickup-time-profiles/{id}` | — | the profile and its `times` |
| `POST /v1/pickup-time-profiles` | `{name, from_date, to_date, notes?, clone_from?}` | `201`, with the clone's times copied |
| `PATCH /v1/pickup-time-profiles/{id}` | any of the same | the profile |
| `DELETE /v1/pickup-time-profiles/{id}` | — | `204` |
| `PUT /v1/pickup-time-profiles/{id}/times/{route_id}/{target}` | `{pickup_time, pickup_time_end?}` or `{pickup_time_end, pickup_at_pier: true}` | the cell |
| `DELETE /v1/pickup-time-profiles/{id}/times/{route_id}/{target}` | — | `204` |
| `GET /v1/pickup-time?route_id=&area_id=&date=` | — | `{pickup_time, pickup_time_end?, pickup_at_pier?, profile_id, target}`, or `404` |

| Legacy function | API |
|---|---|
| `psuSaveArea` (new / edit) | `POST` / `PATCH /v1/pickup-areas…` (`time_group` ↔ legacy `timeGroup`) |
| `psuDeleteArea` | `DELETE /v1/pickup-areas/{id}` |
| `psuSaveProfile`, `psuOpenNewProfile(cloneLatest)`, `psuOpenCloneProfile` | `POST` (with `clone_from`) / `PATCH /v1/pickup-time-profiles…` |
| `psuDeleteProfile` | `DELETE /v1/pickup-time-profiles/{id}` |
| `psuSetTimeCell(routeId, tgId, val)` | `PUT …/times/{route_id}/{target}` (split `val` with `pickupSplit`); empty → `DELETE` |
| `bookingV2GetPickupTime`, `psuResolveProfile` | `GET /v1/pickup-time?route_id=&area_id=&date=` |

- `zone` is `PK`, `KL`, `RN` or `NoTransfer`. An area id is the server's (`<zone>-<name slug>`) and
  never changes. Deleting makes it inactive: keep inactive areas for showing old bookings, and use
  `?active=true` for pickers.
- A `target` is an area id or a time group. The lookup takes the narrowest profile covering the date,
  then the area's own cell, else its time group's, else the fallback profile `prof-legacy-flat`
  (legacy's old flat table).
- A new or edited area takes its time group's times. **Delete** `_psuInheritTimesForArea`.
- **Behaviour change:** changing a booking's area does not redo pickup times already on its trips.
  When the user changes the area in the form, call `GET /v1/pickup-time` and send the new time.
- Not in the change feed yet.

---

## 5. Live updates (the change feed)

**Change: follow `GET /v1/changes/stream` and refetch only what it names. Remove the polls.**

Today: `setInterval` polls in `ops/40-ops-bookings.js` (manifest every 60 s, detail when older than
30 s) and `ops/50-ops-availability.js` (`refreshQuiet` every 120 s), and `O.onWrite` empties the
whole availability cache after any write. Legacy's `_laStartSSE` (`EventSource('/api/events')`) and
`_laCheckVersion` (`/api/version`) do not run with legacy off.

| Method + path | Answers |
|---|---|
| `GET /v1/changes` | `{ version, health }`: the starting point |
| `GET /v1/changes?since=N[&limit=500]` | `{ version, changes: [Change], health }`, oldest first |
| `GET /v1/changes/stream[?since=N]` | Server-sent events |

```jsonc
// Change
{ "version": 4521, "kind": "booking", "entity_id": "BK-…", "action": "updated",
  "route_days": [ { "route_id": "r1", "service_date": "2026-10-02" }, { "route_id": "r1", "service_date": "2026-10-03" } ],
  "changed_by": "ops1", "changed_at": "2026-10-01T09:12:44.000Z" }
```

**How to follow it:**
1. At boot, before loading data, read `GET /v1/changes` and keep `version`.
2. Load the data as today (`90-ops-boot.js`).
3. Open the stream with `?since=<that version>`, so nothing between steps 1 and 3 is missed.
   **Use `fetch` with the Bearer header** (through `laOpsFetch`) and read `response.body` as text.
   `EventSource` cannot send the header.
4. Parse events: blank-line separated, lines `id: 4521`, `event: change`, `data: {Change}`. Keep the
   last `id`. `event: hb` every 25 s carries `data: {version, health}`.
5. On a dropped stream, wait `retry` (5000 ms) and reconnect with `Last-Event-ID: <last id>`. The
   server sends anything missed. Changes are kept forever.
6. Collect changes for ~300 ms, then refetch once per record.

| `kind` | `entity_id` | Refetch |
|---|---|---|
| `booking` (edits, commands, dispatch, check-in, van parts and groups, reconfirm, upgrades, doc check) | the booking's server id (`bk.opsId`) | `GET /v1/bookings/{id}` → `O.bookings.upsert` |
| `seat_lock` | the lock id | `GET /v1/seat-locks?route_id=&service_date=` for its `route_days` |
| `deployment` | `<date>:<boat>` | `GET /operations/deployments?from=<date>&to=<date>` |
| `route` (created, edited, deleted, reordered, its calendar) | the route id | `GET /v1/routes?from=&to=`, and take that route (as `refreshCalendar` in `ops/10-ops-catalogue.js` does); a deleted one is gone |
| `boat` (created, edited, status timeline, retire, restore, day seats) | the boat id | `GET /v1/boats/{id}`; its `route_days` are the availability cells whose seats moved |

- **`route_days`** name the cells whose seats moved, before and after. Refetch availability only for
  those (`GET /v1/availability?route_id=&date=`); `null` on a route calendar.
- **Your own writes come back too.** `upsert` already skips a booking with a write in flight
  (`busyIds`) or the same `updated_at`.
- `health.migrations_pending` is what `/api/version` used to report; show it where legacy did, if
  wanted.
- **Not in the feed yet:** vans, van stops, pickup areas, attachments, users, agents, rate types,
  route families.
  Keep refetching those when their screen opens. The legacy import writes no changes: reload after an
  import.
- **Delete:** the three `setInterval` polls, the 30 s detail refresh, and `O.onWrite`'s clear-all
  (replace with clearing the named cells).

---

## 6. Seat locks, availability, rate seasons, rate types, contracts

### 6.1 Seat locks (`ops/30-ops-locks.js`)

**Already right:** one server lock per route and day, diffed and rolled back; `drawn_pax`; the
holder kept when the agent list is missing.

**Built here since (2026-10-09, migration 048, README "Agent seat locks"):** everything the Seat
Locks tab keeps "for the session only" now has a home: bulk locks (`/v1/seat-lock-groups`, one lock
per departure), sub-groups, pending seats, expiry, reason, holder type, released seats, the release
cutoff (`overdue`) and the log. The server works out every number the tab shows.

**To do (breaking where marked):**
- Keep each lock's `version` (it has one, and an `ETag`) and send `If-Match` on every write to one
  lock (`PATCH`, `release`, `add`, `release-departure`, `confirm-pending`, `sub-groups`) and to a bulk
  lock. `409 stale_version` → reload the locks and show the message.
- **Breaking:** a bulk lock is no longer sent as N day locks. Create it with
  `POST /v1/seat-lock-groups` and read it back as one row (`GET /v1/seat-lock-groups`, "x / y
  departures past" from `departures_past`/`departures`). "Grouping them again needs a group field on
  the server": it is `group_id`.
- **Breaking:** an agent lock needs a real agent (`400`), and a booking draws only from its own
  agent's locks or office/global ones (`400 lock_other_agent`). Send `holder_type: "office"` for an
  office hold, never a typed name as `agent_id`; put the name in `reason`.
- **Breaking:** `PATCH` with a server-owned field changed (`status`, `pending_pax`, `released_pax`,
  `group_id`, `parent_id`) is `400 server_owned`; unchanged it is ignored. Use the commands.
- **Breaking:** short of seats is `409 seats_short` with `short: [{service_date, free, want, short}]`:
  show the "ที่นั่งว่างไม่พอ" dialog from it and resend with `pending: "split"` or `"all"`, instead
  of `bkV2LockShort` working it out in the browser. Confirm with `POST …/confirm-pending`.
- **Breaking:** `pax` is what was asked; a release no longer lowers it. Legacy's `qty` is
  `pax − released_pax`; send `pax` = edited `qty` + `released_pax`. Release with
  `POST …/release { pax? }` (legacy's modal), and a departure with `POST …/release-departure`;
  "release every overdue lock of the day" is `POST /v1/seat-locks/release-overdue`.
- Read `held_pax`, `remaining_pax`, `pending_pax`, `state`, `holding`, `overdue` from the lock
  instead of `bkV2LockHeldRemaining`, `bkV2LockDrawable`, `bkV2LockSubShares`, `bkV2LockOverdue` and
  the expiry sweep (`bkV2LockExpireSweep` must stop writing `expired`: expiry is worked out on read).
- Sub-groups: `POST /v1/seat-locks/{id}/sub-groups { sub_name, pax, reason? }`; a draw names the
  sub-group's id in `lockDraws`. The audit, sweep and reconcile screens are not needed: `drawn_pax`
  is counted from the bookings, never a counter.
- The log: `GET /v1/seat-locks/{id}/log` (and `/v1/seat-lock-groups/{id}/log`) instead of `l.log`.
  Draw and return lines are written by the server from booking saves; stop writing them.

```
POST /v1/seat-locks   { "route_id": "r1", "service_date": "2026-10-12", "pax": 6, "agent_id": "a12", "expiry": "2026-10-10", "reason": "Love Boom" }
POST /v1/seat-lock-groups { "route_id": "r5", "date_from": "2026-11-01", "date_to": "2027-03-31", "weekdays": [2, 4], "pax": 30,
                            "agent_id": "amrsvysasrifkh", "release_days_before": 2, "release_time": "15:00" }
```

### 6.2 Availability (`ops/50-ops-availability.js`)

**Already right:** `getAllotment` takes the server's numbers; `unlimited`, `unplaced_pax`,
`licensed_free`; `exclude_booking_id` while editing; ranges of up to 62 days.

**To do:** refresh from the feed's `route_days` (§5). Optionally read `deployments[].chartered` from
`GET /v1/availability?from=&to=` instead of rebuilding charter cells from bookings (`markCharters`).

### 6.3 Agents' rate seasons

**Change: the agent's season table reads and saves on the API.**

- `GET /v1/agents/{id}` carries `rate_seasons`; also `GET /v1/agents/{id}/rate-seasons` →
  `{ "seasons": [{ "rate_type_id": "rt003", "from": "2026-11-01", "to": "2027-04-30" }, …] }`.
- `PUT /v1/agents/{id}/rate-seasons` `{ "seasons": [...] }` replaces the table (`[]` clears).
  Legacy's `{ "rt", "from", "to" }` is accepted; a blank `to` means no end. Needs `sales`. `400` for an
  unknown rate type, a bad date, a season ending before it starts, or two starting the same day.
- `GET /v1/agents/{id}/rate-type?date=YYYY-MM-DD` → `{ "rate_type_id": "rt003", "source": "season",
  "season": {…} }`: use it wherever a screen shows which rate applies.
- In `ops/10-ops-catalogue.js`, `mapAgentDetail` fills `rateSeasons` from `rate_seasons` (today
  `agentDefaults` leaves it `[]`), and the season editor's save calls the `PUT`.
- Legacy kept seasons only in browsers, so the API starts empty: sales re-enter them.

### 6.4 Rate types and contracts (read)

- `GET /v1/rate-types?active=&q=`, `GET /v1/rate-types/{id}` replace the seed `SB_RATE_TYPES` for
  display (Rate Types screen, agent detail). Seat prices are keyed `ad_fr`, `chd_fr`, `inf_fr`,
  `ad_th`, `chd_th`, `inf_th`; tiers `net`, `sell`, `min_sell`.
- `GET /v1/contracts?agent_id=&kind=&status=`, `GET /v1/contracts/{id}` fill `SB_CONTRACTS`. Promos
  are written on the API (§6.5). Each contract carries `state` (the badge `_ctContractStatus` drew)
  and `bonus_progress` (what `laPromoStat` counted): show those instead of computing them.
- Writes to rate types exist on the API, but see "Questions" before wiring them.

### 6.5 Agents, contracts (promos too), documents, templates, salespeople, markets, the Sales Board, staff (sales editing)

**Change: the Agent List, agent detail, Contract Templates and Team & Markets screens save on the API.**
The API is the master for these since 2026-10-09; the legacy import no longer writes them. README
"Agents", "Contract templates and documents", "Salespeople and markets" have every field.

| Legacy | API |
|---|---|
| `agCreateSubmit` | `POST /v1/agents` (`409 possible_duplicate` is `agFindDup`'s confirm: resend with `create_anyway: true`; `409 code_taken` is new) |
| `agEditSave` sections `sales`, `profile`, `company`, `signatory`, `booking`, `notes`, `contracttmpl`; table cells, bulk set, fill-down, Excel import | `PATCH /v1/agents/{id}` with the fields changed (groups `company`, `signatory`, `booking_channel`) |
| section `programs`, `agProgBulkApply`, the table's programme picker | `PUT /v1/agents/{id}/programs` (the whole list; a bare route id keeps its window) |
| section `ratetype` (+ `_ctSyncMainRate`, `agProgSyncOnRate`) | `PUT /v1/agents/{id}/rate-type`; on `409 unpriced_programs` show legacy's confirm and resend with `drop_unpriced` true (OK) or false (Cancel). The server syncs the contract and the programmes: do not call anything else |
| `ctRenewActivate` | `POST /v1/agents/{id}/renew` `{version, start, end, rate_type_id?, carry}` |
| `agDelete` | `DELETE /v1/agents/{id}` (admin; `409 in_use` once anything names the agent: offer Deactivate) |
| (new) | `POST /v1/agents/{id}/deactivate`, `/activate`; the booking form already hides `active === false` |
| `ctArtifactSave`, `ctArtifactRemove` | `POST /v1/agents/{id}/documents`, `DELETE /v1/contract-documents/{id}`; list with `GET /v1/agents/{id}/documents` |
| `cttNew`, `cttSetField`/`Text`/`Form`/`Accent`/`Hex`/`Font`/`Section`, `cttToggleActive`, `cttSetDefault`, `cttDelete` | `POST`/`PATCH /v1/contract-templates[/{id}]`, `POST /{id}/default`, `DELETE /{id}` |
| `tmSaveModal` (sales), `tmDeleteSales` | `POST`/`PATCH`/`DELETE /v1/sales[/{id}]` (area `config` now, not `sales`) |
| `tmSaveModal` (market), `tmApplyMarketOrder`, `tmDeleteMarket` | `POST`/`PATCH`/`DELETE /v1/markets[/{id}]`, `PUT /v1/markets/order` |
| `agSubMarketRemember` | nothing: saving the agent adds the sub-market |
| `agLog` | nothing: the server writes every activity line, signed with the login |
| `ctSaveAddPromo` (add) | `POST /v1/contracts` `{agent_id, price_mode, rate_type_id \| seat_prices \| discount, active_from, active_to, book_from?, book_to?, route_ids, bonus?, priority?, note?}`. The own-price table's cells go as `seat_prices: [{route_id, zone, category: ad\|chd, residency: thai\|foreign, price}]` (legacy's `adult-thai` → `ad`/`thai`, `child-fr` → `chd`/`foreign`) |
| `ctSaveAddPromo` (edit) | `PATCH /v1/contracts/{id}` with the form's fields |
| its confirms | `409 routes_unpriced` (no own price / no main price for a route): show legacy's confirm, resend with `unpriced_anyway: true`; `409 promo_sold` (already sold): resend with `sold_anyway: true` |
| `ctVoidContract` | `POST /v1/contracts/{id}/void` |
| `sbEditTarget` (`salesSetTarget`) | `PUT /v1/sales/{id}/targets/{YYYY-MM}` `{pax}` (0 clears) |
| `salesToggleFollow` | `PUT /v1/sales/{id}/followups` `{month, agent_id, kind: "agent" \| "foc", marked}`: send the new state, not a toggle |
| `renderSalesBoard`'s numbers (`salesPaxAgg`, `salesStreak`, `agentTrend`) | `GET /v1/sales-board?month=` |
| `staffAdd`, `staffSetField`, `staffSetQuota`, `staffDelete` | `POST /v1/staff`, `PATCH /v1/staff/{id}`, `PUT /v1/staff/{id}/quotas/{year}` `{free_seats}`, `DELETE /v1/staff/{id}` (`409 in_use` while bookings name them) |
| `renderStaff`'s numbers (`staffWelfareUsed`, `staffTripsFor`) | `GET /v1/staff?year=`, `GET /v1/staff/trips?year=` |

- **Stop writing** `sb_agents`, `sb_markets`, `sb_sales` (targets and follow-ups included),
  `contract_templates`, `agent_artifacts`, `sb_contracts` and `sb_staff` from the browser
  (`sbAgentsPersist`, `sbMarketsPersist`, `sbSalesPersist`, `ctTmplPersist`, `ctArtifactsPersist`,
  `sbContractsPersist`, `sbStaffPersist`).
- **A sales-bound login** (`LA_ME.salesId`, not admin) gets only its agents from `GET /v1/agents` and
  `403` for another's: `laScopeAgents` can stay as display, but the server is the gate.
- **`creditBalance`** is not accepted (the agent's `credit` block is worked out); drop the field from
  the profile modal's save.
- **Templates and documents** carry `sections`/`text` (template) and `content` (document) as the
  screen's own JSON: `text` is legacy's `{en: {...}, th: {...}}`, `content` is the artifact's
  `{sections, form, accent, accentHex, font, tmplText, overrides, customClauses}`.

### 6.6 The add-on catalogue, nationalities, insurance

- **Add-on Services screen** (`aos*`): `GET`/`POST`/`PATCH`/`DELETE /v1/addon-services` (area `sales`); it
  starts empty instead of the hard-coded `SB_ADDON_SVCS`.
- **Nationalities:** `bkV2AllNats` reads `GET /v1/nationalities`; `bkV2AddCustomNat` calls
  `POST /v1/nationalities {name}` (area `operations`) and uses the `code` it answers. Stop
  `sbNationalitiesPersist`.
- **Insurance page** (`ins*`): read `lead_age`/`lead_insurance_reviewed_*` and each passenger's
  `age`/`insurance_reviewed_*` from the booking; `insSetField` (age), `insToggleReviewed` and
  `insRevertRow` call `PUT /v1/bookings/{id}/insurance` with the booking's `version`, the lead as
  `"lead"` and a passenger by its `seq`. Name and nationality overrides are gone (none was ever
  used). Stop `insPersist`.

### 6.7 Fleet, part B: stock, memos, projects, Daily Fleet Log, safety (`05-fleet.js`)

README → "Fleet maintenance". Every write is `fleet`, except the Daily Log's water, issued and extra
items, outside requests and issue-item list (`fleet` or `operations`). `flSave` refused silently; the
API answers `403`, so show it. Numbers (`MO-…`, `PRJ-…`) are still computed by the screen and sent.

| Legacy | API |
|---|---|
| `flSaveAddStock`, `flSaveInvEdit` | `POST`/`PATCH /v1/fleet/stock-items`; the edit form's quantity becomes `POST …/adjust {warehouse, qty}` (sending `qty` to `PATCH` is `400`); a new part number needs `part_no_anyway: true` after the confirm |
| `flSaveReceive` (one item), `flSaveTransfer`, `invDupMerge` | `POST …/receive`, `…/transfer`, `…/merge` |
| `invLostFix`, `invDupScan` | not built: fix a wrong line with `adjust`; duplicates read from the import report |
| `flConsumeSubmit`, `flConsumeDelete` | `POST /v1/fleet/consumables` (the below-zero confirm becomes `allow_negative: true` after a `409 stock_short`), `DELETE …/{id}` |
| `flSaveMemo` | `POST /v1/fleet/memos` (send `no`; totals come back computed), `PATCH …/{id}` with each line's `id` |
| `flAdvanceMemo`, `flSaveApprove`, `flSaveReceive` (memo), `memoShortClose`, `flCancelMemo` | `…/approve`, `…/order`, `…/receive {lines: [{line_id, qty}]}`, `…/short-close`, `…/pay`, `…/cancel {reason}` (a `409 stock_short` asks to confirm with `allow_negative: true`) |
| `flProjSaveModal`, `flProjSetPhase` | `POST`/`PATCH /v1/fleet/projects` |
| `flProjStart`, `Hold`, `Resume`, `Cancel`, `Reopen`, `WorkDone`, `BillBack`, `MarkComplete`, `BillClose`, `BillGo` | `…/start`, `/hold`, `/resume`, `/cancel`, `/reopen`, `/work-done`, `/bill-back`, `/complete` (`no_cost_reason` for the "no cost" choice; `409 bill_gate` lists what is missing) |
| `flProjAddPlanItem…`, `flProjAddDoc…`, `flProjAttach*`, `flProjAddPhoto`, `flProjAddVendorVisit` | `…/plan`, `…/documents` (upload first with `POST /v1/attachments`, then send `attachment_id`), `…/vendor-visits`. Stop the `bookingId:'proj_…'` upload |
| `flSaveFuel`, `flSavePaxActual`, `flSaveMeter` | `PATCH /v1/fleet/daily-log/{date}/boats/{boat_id}` |
| `flSaveFuelPrice`, `flSaveDayLog`, `flDREdit` | `PUT …/{date}/fuel-prices`, `POST …/piers/{pier}/lock`, `…/unlock`. A locked day's writes are `409 day_locked` |
| `flWaterSet`, `flIssueSet`, `flExtraSet`/`Del`, `flReqSet`/`Del`, `flIssueAddItem`/`SetItem` | `PUT …/water`, `PUT …/issues`, `…/extras`, `…/requests`, `/v1/fleet/issue-items`. Stop writing `fl_*` in `app_meta` |
| `flSaveSafety`, `flSafetyDelete`, `flSaveInspection`, `flDeleteInspection` | `/v1/fleet/safety…`, `…/inspections` |
| Inventory, memo, project, Daily Log, safety reads | the matching `GET`s; computed fields (`stocks`, `below_min`, memo totals, `receive_state`, `bill_gate`, `health`, `fuel_price`, `state`) replace the screen's own |

---

## 7. Not in the API yet: legacy keeps doing these

Checked against `README.md` and `todo/` on 2026-10-09. **With `LA_LEGACY_SYNC=false` these screens
work for the session only and save nowhere** (see "The one thing to know first").

| Area | Legacy data / functions | Where it is tracked |
|---|---|---|
| Deposits, refunds, money reports (invoices, PFM, pier money and Travel Summary decisions moved: 2.7, 2.9) | `SB_DEPOSITS`, `bk.refund`, `acctDashboardHtml`, `acctStatementOpen`, the Travel Summary totals | `todo/money-model.md` slices 5–6, open 1 |
| Booking payment slips not tied to a payment | `paymentSlips` | `booking-extras-model.md` open 1 |
| Weather closures and their follow-up | `SB_WEATHER_CLOSURES`, `bookingV2WeatherMark`, `bk.weatherResolve`, `bk.rebook` | `legacy-replacement.md` §3 (`cancel-weather` itself is built) |
| Fleet reports beyond memo spend (cost analytics, upkeep, fuel intelligence, dashboard); the safety replace wizard | `05-fleet.js`, `06-engine-assign.js` | `fleet-maintenance-model.md` (part A: §3.15; part B: §6.7) |
| The computed van board (pools, return alerts across routes) | `vehJobsFor` and the board's own counts | `trip-ops-and-vans-model.md` 9 (job orders are built: §3.4b) |
| B2C sync health and raw feed | `_laB2C*` | `legacy-replacement.md` "Open" |
| Approval's salesperson name | `approval.saleName` | not stored; kept from the local copy |

---

## 8. Questions for the API team

1. **Which day-of-operations writes change a booking's `version`?** README says reconfirm writes do
   not. `PATCH /operations/trip-ops/{trip_id}` and the check-in calls answer `{trip}` without the
   booking's version. If they bump it, the client's next `PATCH` with `If-Match` is refused.
2. **Do trip-ops, check-in, van-group, upgrade and doc-check writes accept `If-Match`?** README names
   "`PATCH` or any command"; the server checks it on `PATCH`, the status commands, cancel, restore,
   partial cancel, reschedule and meals.
3. **Does `operations.boat_id` follow a charter's `charter_boat_id`?** Legacy forces
   `ops.boatId = charterBoatId` on save (`§chOpsSync` in `bookingV2CommitBooking`), and every screen
   reads `ops.boatId`. Until answered, the client can show `charter_boat_id` when `boat_id` is `null`.
   *Answer (2026-10-09): yes, built: a charter trip's `boat_id` is its `charter_boat_id`, kept in step
   on every save; another boat is `400` (README "Dispatch").*
4. **A boat's seats on assignment.** Legacy refuses assigning a booking to a boat that would go over
   its cap plus tolerance (`bookingV2AssignBoat`, `§baCapGate`, unlockable with `act-capunlock`).
   `PATCH /operations/trip-ops` checks only that the boat is deployed. Is that rule meant to move?
   *Answer (2026-10-09): yes, built (README "Dispatch"): over capacity + 2 is `409 boat_full`; legacy's
   emergency dialog resends with `raise_capacity: { reason }` (act-capunlock or admin, `403` otherwise);
   past the licence `409 over_licence`; a chartered boat `409 boat_chartered`.*
5. **Exact keys of `van_parts[].alt`, `reinstate`, `self_add` and `undone`.** README names them
   (`pick_*`, `drop_*`, `alt_who`, `pick_time`; `undone.why`) but shows them only as `null`. Please
   add one filled example each.
6. **`GET /v1/users` row shape.** Which fields, and how is a disabled user shown (`disabled`,
   `disabled_at`)?
7. **Files in `<img>` and OCR.** `GET /v1/attachments/{id}` needs the Bearer header, so the client
   must fetch and use a blob URL everywhere. Is that the intended way, or is a link that works
   without the header planned?
8. **Job order "sent" per round.** Legacy marks a van's job order sent per route or group
   (`VANJOB_SENT` key `date::van~route~group`); the API keeps one `sent_at` per van and day. Is losing
   the per-round mark intended?
   *Answer (2026-10-09): no, built: sent is per job (the van group, so a second round no longer
   orphans the first), flagged `changed_since_sent` when the sheet changes after (§3.4b).*
9. **`VANJOB_SREQ`, `VANJOB_PICKUP_TH` and `bkv2_grp_order`** (the order van groups are listed in)
   have no home in README. Planned, or dropped?
   *Answer (2026-10-09): built (§3.4b): the booking's `job_note`, `/operations/pickup-names-th`, and
   `PUT /operations/van-groups/order`, which the job orders follow too.*
10. **`SB_EXTRAS`.** In the client it is day-of extras sold on tour (`bookingV2ExtraSave`: service,
    qty, price, to-company, commission, payment). `legacy-replacement.md` §6 calls `sb_extras` the
    add-on catalogue. Which is it, and where will day-of extras live?
    *Answer (2026-10-09): on-tour sales, as in the client. `legacy-replacement.md` was wrong and is
    corrected; they become `booking_tour_sales` in Money slice 3 (`todo/money-model.md`).*
11. **Rate type writes.** `POST/PATCH/PUT/DELETE /v1/rate-types…` exist, but README says the next
    import run puts legacy's prices back until cutover. With legacy off, this app cannot edit them in
    legacy either. Should the Rate Types screen write to the API now, or stay read-only?
    *Answer (2026-10-09): rate types move now. This API becomes their master, the import stops
    overwriting them, and the Rate Types screen writes to the API.*
12. **Areas not moved yet, with legacy off.** Everything in §7 saves nowhere in this deployment.
    Should the integration run with `LA_LEGACY_SYNC=true` for those areas until they move, or accept
    the loss? (`legacySync` is all-or-nothing in `01-auth-sync.js`.)
    *Answer (2026-10-09): per area. The integration keeps saving to legacy only what has not moved, and
    never what has (bookings, seat locks, deployments, day-of-operations, pickup areas, invoices and
    payments, rate types). The switch has to become per area for an area-by-area cutover.*
13. **Past dates for admins.** `bop2GuardPast` blocks everyone; the server lets an admin correct
    history. Should the client let admins through? (A screen behaviour change; the developer decides.)
    *Answer (2026-10-09): yes, admins may; everyone else stays blocked.*

---

## 9. Checklist

Status: **Done** = on the API today; **Partial** = reads or some writes; **To do**; **Not in API**.

| Screen / function | Endpoint(s) | Status |
|---|---|---|
| Login card | `POST /v1/login` | Done |
| `ME`, sidebar, edit guards | `GET /v1/me` | To do |
| Logout | `POST /v1/logout` | To do |
| Users screen | `GET/POST /v1/users`, `PATCH /v1/users/{id}`, `POST /v1/users/{id}/password` | To do |
| Booking load, detail, history | `GET /v1/bookings`, `GET /v1/bookings/{id}`, `/history` | Done |
| Booking read: operations, reconfirm, alt pickups, upgrades, adjustments, attachments, doc check, allergy list, version | booking read fields | To do |
| Pending approvals queue | `GET /v1/bookings?status=pending_approval,pending_foc` | Partial |
| Booking save (create / edit) | `POST /v1/bookings`, `PATCH /v1/bookings/{id}` | Partial (new fields, `If-Match`, price answer) |
| Price on the form | `POST /v1/quote` | To do |
| Price after save, `price_warnings` | save answer | To do |
| Confirm, approve, reject, FOC, weather cancel | `/confirm`, `/approve`, `/reject`, `/cancel-weather` | Done (add `If-Match`) |
| Cancel, restore, partial cancel, reschedule | `/cancel`, `/restore`, `/partial-cancel`, `/reschedule` | Done (add `If-Match`) |
| By-trip day | `GET /v1/manifest` | Done |
| Boat on a booking, boat splits | `PATCH /operations/trip-ops/{trip_id}` | To do |
| Final pickup, return same van, pier note | `PATCH /operations/trip-ops/{trip_id}` | To do |
| Van splits | `PATCH /operations/trip-ops/{trip_id}` (`van_parts`) | To do |
| Van groups (van, return van, time, order, disband, clear) | `/operations/van-groups…` | To do |
| Vans page, month matrix, driver of the day | `/operations/vans…`, `/operations/van-days…` | To do |
| Van stops | `/operations/van-stops…` | To do |
| Van and pier check-in | `PUT/DELETE /operations/trip-ops/{trip_id}/checkins/{van\|pier}/{slot}` | To do |
| Re-confirm page | `PUT/DELETE /v1/bookings/{id}/reconfirm`, `POST /v1/reconfirm/sent` | To do |
| Ops board re-confirm | `PUT …/reconfirm` (`via: list\|phone`), `DELETE …?all=true` | To do |
| Alternate pickups | booking `alt_pickups` | To do |
| On-tour sales | booking `upgrades` | To do |
| Route upgrade, undo | `POST /v1/bookings/{id}/upgrade`, `/upgrade/undo` | To do |
| Allergy list | booking `allergy_list` | To do |
| Pier meal editor | `PUT /v1/bookings/{id}/meals` | To do |
| Documents and slips | `POST/GET/DELETE /v1/attachments…` | To do |
| Doc Check page | `PUT /v1/bookings/{id}/doc-check/…` | To do |
| Boat Operation | `POST /operations/deployments`, `DELETE …` | Partial (`remove_anyway`, `past_date`; `deploy_anyway` to do) |
| Fleet: assets, incidents, jobs, job board | `/v1/fleet/{engines,gearboxes,propellers,incidents,jobs}…`, `GET /v1/fleet/availability` | To do (§3.15) |
| Settings → Programs calendar | `/v1/routes/{id}/seasons…`, `/days/{date}` | Done |
| Settings → Programs: add, edit, delete, drag; families | `/v1/routes`, `/v1/routes/{id}`, `/v1/routes/order`, `/v1/route-families` | To do |
| Boat form, Boat Status timeline, restore | `/v1/boats`, `/v1/boats/{id}`, `…/status-log`, `…/retire`, `…/restore` | To do |
| Day-seats dialog (`boatCapSet`) | `PUT/DELETE /v1/boats/{id}/capacity-overrides/{date}` | To do |
| Seat locks | `/v1/seat-locks…` | Partial (`If-Match`) |
| Seat locks | `/v1/seat-locks…`, `/v1/seat-lock-groups…` | To do (§6.1: bulk locks, sub-groups, pending, expiry, log) |
| Availability everywhere (`getAllotment`) | `GET /v1/availability`, `GET /operations/allotment` | Done |
| Pickup time setup (areas, profiles, cells) | `/v1/pickup-areas…`, `/v1/pickup-time-profiles…` | To do |
| Pickup time on the booking form | `GET /v1/pickup-time` | To do |
| Live updates | `GET /v1/changes`, `GET /v1/changes/stream` | To do |
| Agents list and detail | `GET /v1/agents…`, `/v1/markets`, `/v1/sales` | Done (read-only) |
| Agent rate seasons | `GET/PUT /v1/agents/{id}/rate-seasons`, `GET …/rate-type?date=` | To do |
| Rate types, contracts (display) | `GET /v1/rate-types…`, `GET /v1/contracts…` | To do |
| Invoices and payments (Accounting, Daily PFM payments) | `/v1/invoices…`, `GET /v1/payments` | To do |
| Daily PFM list, extend, hold, remind | `GET /v1/pfm`, `/pfm/approve-travel`, `/pfm/hold`, `POST /v1/pfm/remind` | To do |
| Pier check-in money column, pay dialog, slips | `GET /v1/pier-money`, `/pier-payments…` | To do |
| Day-of extras (on-tour sales), upgrade collect | `/tour-sales…`, `/upgrades/{id}/collect` | To do |
| Travel Summary COT and no-show decisions | `GET /v1/after-trip`, `/cot-decisions/{date}`, `/noshow-charges/{date}` | To do |
| Pier hand-over, commission payouts (new screens) | `/v1/pier-handovers…`, `/v1/commissions`, `/v1/commission-payouts…` | Not in legacy |
| Fleet stock, memos, projects, Daily Fleet Log, safety | `/v1/fleet/…` (§6.7) | To do |

## Rules and gotchas

- **Commit style** in that repo: one sentence saying what changed for the user, then a `(§tag)`;
  mark code with the same `§tag` and a date. Others' uncommitted work sits in the same worktree
  (`01-auth-sync.js`, `server.js`): commit only your files, by path.
- **Run it locally** as `integration-client.md` → "Run it locally" says (`docker compose up -d
  --build`, the app on :8791, `admin` / `admin`).
- **Write down what you checked:** the screen, what you clicked, what the server answered. A manual
  run at :8791 is the real check for each step.
