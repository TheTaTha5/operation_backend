# Seat-lock extras

**Status:** decided and built 2026-10-09 on `feat/seat-lock-extras` (migration 048; README "Agent
seat locks"; code in `src/domain/seat-locks.ts`, `seat-lock-service.ts`, `seat-lock-input.ts`;
import in `src/tools/legacy-locks.ts`). Legacy read: wt-lk-inbox@658298d, `08-app.js` `bkV2Lock*`.
What is left, and what to look at before merging, is below.

## Open

1. **Whole-boat holds: creating and converting them** (legacy `bkV2BoatLock*`, the charter
   conversion, "fixed/any", the refusals). Their own design (decision 5). Here a hold is made by the
   import only; every command but a full release refuses it (`400 boat_hold`).
2. **Editing a bulk lock's range or weekdays** is refused (`400 server_owned`: "release it and make
   a new one"). Legacy allows it while nothing is drawn (7 `edit` log lines in all, none changing a
   range). Ask ops whether they need it; building it means adding and removing departures.
3. **A login tied to one agent (Love Kingdom's) may lock seats for any holder.** Bookings refuse
   another agent (`403`); locks never checked it. Decide whether `/v1/seat-locks` should too.
4. **Legacy's KPI per agent** (`bkV2LockKpiByAgent`: seats locked vs drawn, conversion %) has no
   endpoint; a screen can sum `GET /v1/seat-locks?agent_id=` (`pax`, `drawn_pax`, `state`). Ask
   whether one is wanted.

## Design — whole-boat holds (2026-10-10, building)

Legacy: wt-lk-inbox@658298d `08-app.js` §bkLock, §bkLockEdit, §bkLkPlaced (`bkV2CreateBoatLock`,
`bkV2BoatLockEdit`, `bkV2BoatLockSwap`, `bkV2BoatLockRelease`, `bkV2BoatLockBlockers`,
`bkV2BoatLockPickList`, `bkV2BoatLockToCharter` + `bkV2BoatLockOnConvert`), `04-data-core.js`
`opLocked` (Boat Operation's guards). Data (2026-10-10): 8 holds, all `fixed`; 4 active, 3 released,
1 converted (to `BK-26100035-N13I`, its `convert` line names it); 13 log lines (create 8, release 3,
edit 1, convert 1).

### What a hold is (unchanged from 047)

A seat lock with `boat_id`. On its boat deployed that day it takes the boat as a charter does
(`dayCapacity`); `pax` is the **minimum seats promised**, held by nothing. New here: the commands
that make, edit, release and convert one, so legacy's Hold-whole-boat form can be switched off.

### Legacy behaviour copied

- **Create** (`bkV2BoatLockSubmit` → `bkV2CreateBoatLock`): route, travel date, boat, holder,
  minimum seats (> 0, "Enter the minimum seats promised"), `fixed` (this boat) or `any` (any boat
  that big; default fixed), expiry **required** ("Expiry date is required for a whole-boat hold")
  and **on or before the travel date** ("Expiry must be on or before the travel date"), reason.
  A land route has no boat ("A land programme has no boat to hold"). Log `create` with the minimum.
- **Writing the boat cell:** legacy marks the boat-board cell `charter` + `boatLockId`, creating the
  cell (placing the boat on the route) when the boat was not on the board that day. Here: the boat's
  **deployment** on the route that day is created when missing (catalogue capacity and licence),
  and the hold takes it. Release and a move leave the deployment as a normal boat (legacy "ไม่ลบเซลล์
  ทิ้ง").
- **Blockers** (`bkV2BoatLockBlockers`, `bkV2BoatLockCanTake`), on the boat that date, the hold
  itself left out when editing:
  - a charter booking on it (any route) — `charterOf`;
  - another active hold on it (any route) — `holdOf`;
  - it is placed (deployed) on **another route** — its own refusal, legacy's "That boat is already
    placed on {route} for {date}. A boat placed on another programme cannot be held here. Move it in
    Boat Operation first, or pick another boat.";
  - bookings holding seats with passengers **placed on it** (dispatch `boat_id` or a split), any
    route — listed (booking, voucher, agent, route, pax, seats drawn from locks), biggest first;
  - the route that day has **sold more** than its other boats seat (`sold − (capacity − this boat) >
    0`, sold = seat passengers + charters with no known boat; locks not counted, as legacy's
    `seatsConsumed`).
- **The pick list** (`bkV2BoatLockPickList`): the route's pier only (a boat at another pier is not
  listed), the boat's readiness that day ("ไม่พร้อมใช้งาน"), each boat's blockers and where it is
  placed; the hold's own boat always listed and pickable; own first, then free ones, biggest first.
- **Edit** (`bkV2BoatLockEdit`, one form): route, date, boat, holder, minimum, deal, expiry, reason.
  Only an active hold (`inactive`). The same 400s as create. A move (date or boat changed; here also
  route) is re-checked with the blockers, the hold left out. An `any` hold's boat must seat the
  minimum on every save (`small`). Changing the boat of a `fixed` hold asks first ("This hold names a
  specific boat for {holder}. {old} -> {new}. The agent may already be selling that boat name. Tell
  them first. Continue?"). Log `edit` with every changed field. Legacy's separate "เปลี่ยนลำ"
  (`bkV2BoatLockSwap`) is the same edit with only the boat.
- **Release** (`bkV2BoatLockRelease`): an active hold → `released`, the boat back in the pool at once;
  log `release`, no seats, note `manual · {boat name}`.
- **Overdue** (`bkV2BoatLockOverdue`): active and past expiry; never expires by itself (built).
- **Convert** (`bkV2BoatLockToCharter` → the booking form prefilled → `bkV2BoatLockOnConvert` on
  save): a new booking with the holder's agent (an agent hold) and its first trip a **charter** of the
  held boat on the hold's route and date; staff fill pax and price. When the saved booking has that
  charter trip, the hold becomes `converted`, log `convert` with the booking id and note `เหมาลำ
  {boat name}`, and the boat passes from the hold to the charter "in one beat" (never back in the
  pool).
- **Boat Operation** refuses to unassign or move a held boat: "Cannot unassign - this boat is held
  whole for an agent. Release the hold on the Seat Locks page first." (`opLocked`).

### Fields and authority (a hold's `seat_locks` row)

| Field | Kind | Rule |
|---|---|---|
| `boat_id` | validated | a catalogue boat (or one deployed that day), not retired (`409 boat_retired`), at the route's pier (`409 boat_other_pier`), ready that day (`409 boat_not_ready`, no "anyway": legacy's list offers none), free (`409 boat_taken` with `blockers`), not placed on another route (`409 boat_other_route`) |
| `route_id`, `service_date` | validated | known route (`400`), not land (`400 land_route`), running that day (`409 route_closed`) |
| `pax` | validated | minimum seats promised, > 0; an `any` hold's boat must seat it (`409 boat_too_small`) |
| `boat_deal` | client fact | `fixed` (default) or `any`; other values `400` |
| `holder_type`, `agent_id` | validated | as any lock (an agent lock needs a real agent) |
| `expiry` | validated | required, on or before `service_date` (`400`) |
| `reason` | client fact | as any lock |
| `status` | computed | `active` → `released` (release) or `converted` (convert); commands only |
| `converted_booking_id` | computed | set by convert |
| `pending_pax`, `released_pax` | computed | 0 / `pax` once released, as today |
| the deployment | computed | created by create/edit when the boat is not on the route that day |

`state` gains `converted`. `holding`, `held_pax: null`, `overdue` unchanged.

### Schema — migration 180

```sql
ALTER TABLE seat_locks DROP CONSTRAINT seat_locks_status_check;
ALTER TABLE seat_locks ADD CONSTRAINT seat_locks_status_check CHECK (status IN ('active', 'released', 'converted'));
-- Legacy reuses `subName` for this; a missing one meant fixed.
ALTER TABLE seat_locks ADD COLUMN boat_deal TEXT CHECK (boat_deal IN ('fixed', 'any'));
-- No key, as seat_lock_events.booking_id has none: the import writes locks before bookings.
ALTER TABLE seat_locks ADD COLUMN converted_booking_id TEXT;
UPDATE seat_locks SET boat_deal = 'fixed' WHERE boat_id IS NOT NULL;
ALTER TABLE seat_locks
  ADD CONSTRAINT seat_locks_boat_deal CHECK ((boat_id IS NULL) = (boat_deal IS NULL)),
  ADD CONSTRAINT seat_locks_converted CHECK ((status = 'converted') = (converted_booking_id IS NOT NULL)),
  ADD CONSTRAINT seat_locks_converted_hold CHECK (status <> 'converted' OR boat_id IS NOT NULL);
```

No new change-feed kind: a hold write is a `seat_lock` change; a deployment it creates or moves is a
`deployment` change; a conversion's booking is a `booking` change (`created`).

### Contract

All under `/v1/seat-locks` (the `operations` area); every write to an existing hold needs its
`version` from a login (`If-Match`), as any lock.

- `POST /v1/seat-locks` with `boat_id` makes a hold:
  `{ route_id, service_date, boat_id, pax, boat_deal?, holder_type?, agent_id?, expiry, reason? }` →
  `201` the lock (`pending` is `400`: a hold takes a boat, not seats).
- `PATCH /v1/seat-locks/{id}` on a hold: `route_id`, `service_date`, `boat_id`, `pax`, `boat_deal`,
  `holder_type`, `agent_id`, `expiry`, `reason`, and `change_boat_anyway: true` to change a `fixed`
  hold's boat (else `409 fixed_boat`). A released or converted hold: `409 hold_not_active`. On a
  plain lock `boat_id` stays `400 server_owned`; `converted_booking_id` is `400 server_owned` on any.
- `POST /v1/seat-locks/{id}/release` (exists): a hold → `released`; `pax` is `400 boat_hold`; a
  converted hold `409 hold_converted`; a released one is answered as it is.
- `POST /v1/seat-locks/{id}/convert`: the body of `POST /v1/bookings`. Absent fields are filled from
  the hold: `agent_id` (an agent hold), and on `trips[0]` (or the flat form) `route_id`,
  `service_date`, `booking_mode: "charter"`, `charter_boat_id`. The booking must carry a charter of
  the held boat on the hold's route and date (`400 hold_mismatch`), and not be a quote (`400
  hold_quote`). In one transaction: the booking is created, weighed with the hold left out (so its
  boat is free to it and to no one else), and the hold becomes `converted`. → `201 { booking,
  seat_lock }`. Any refusal of the booking (`409`, `400`) leaves the hold as it was.
- `GET /v1/seat-locks/boat-options?route_id&service_date[&lock_id]` → the pick list:
  `{ route_id, service_date, boats: [{ boat_id, name, capacity, pier, own, ok, why, placed_route_id,
  blockers }] }`, `why` `{ code, message }` or `null`.
- `GET /v1/seat-locks?kind=boat` (holds only) or `kind=seats` (the rest).
- `POST /operations/deployments`, `DELETE …`: a boat an active hold takes can't leave its route:
  `409 boat_held`.

```json
// POST /v1/seat-locks
{ "route_id": "r3", "service_date": "2026-10-15", "boat_id": "b8", "pax": 38, "boat_deal": "fixed",
  "agent_id": "amrg7d9d50aycj", "expiry": "2026-10-14", "reason": "Fam Trip Georgia" }
// 201
{ "id": "lock_…", "version": 1, "route_id": "r3", "service_date": "2026-10-15", "boat_id": "b8",
  "boat_deal": "fixed", "pax": 38, "holder_type": "agent", "agent_id": "amrg7d9d50aycj",
  "expiry": "2026-10-14", "status": "active", "converted_booking_id": null, "held_pax": null,
  "holding": true, "state": "active", "overdue": false, … }
// 409, the boat carries sold passengers
{ "statusCode": 409, "code": "boat_taken", "error": "Conflict",
  "message": "That boat is not free on 2026-10-15: 2 booking(s) (14 pax) are on it. Move them to another boat first",
  "blockers": { "charter_booking_id": null, "hold_id": null, "placed_route_id": "r3",
    "bookings": [{ "booking_id": "…", "voucher_ref": "V-1", "agent_id": "a7", "route_id": "r3", "pax": 10, "from_lock": 0 }],
    "pax": 14, "sold": 30, "short": 0 } }
// POST /v1/seat-locks/{id}/convert   If-Match: "1"
{ "trips": [{ "pax": { "ad": 40 } }], "lead_pax": "Mikhail" }
// 201
{ "booking": { "id": "booking_…", "agent_id": "a77", "trips": [{ "route_id": "r7", "booking_mode": "charter", "charter_boat_id": "b13", … }], … },
  "seat_lock": { "id": "lock_…", "status": "converted", "state": "converted", "converted_booking_id": "booking_…", … } }
```

### Import

`converted` → `converted`, `converted_booking_id` = `lg_` + the booking its `convert` line names (a
converted hold with no such line → `released`); `boat_deal` = `any` when `subname` is `any`, else
`fixed`.

### Decided here (legacy unless said)

- The "sold more than the other boats seat" blocker only counts when the boat is on that route: legacy
  takes the boat's seats off the route's capacity even when the boat is not placed there, which
  refuses holding an extra boat on a sold-out day — the day one is most needed.
- An `any` hold is checked against its boat on create too (legacy only on edit and swap), so a new
  hold never starts in a state its first edit would refuse.
- A conversion whose booking has no charter of the held boat is refused (`400`); legacy saved the
  booking and left the hold active "for someone to decide". A quote is refused too: legacy converted
  the hold and then did not write the charter's boat for a quote, so the boat went back to the pool.
- Holder: a free-text name is refused, as for every lock (decision 8–9). The booking's agent may
  differ from the holder's (legacy's prefilled form could be changed).

## Flagged

Behaviour that changed, data the import changes, and decisions taken here because the note did not
cover them (legacy's behaviour unless said otherwise).

**Changes to existing behaviour**

- `PATCH /v1/seat-locks/{id}` used to ignore other fields; a server-owned field with a **different**
  value is now `400 server_owned` (unchanged it is ignored, as a booking's). `test/edit-conflicts`
  updated.
- An agent lock needs a real agent (`400`), and serves only that agent's bookings (`400
  lock_other_agent`, also for a booking with no agent). `test/operations` used an unseeded
  `agent-1`; its locks are now office locks. No legacy booking draws on another agent's lock.
- Short of seats is `409 seats_short` with a `short` list (was `409 Insufficient available seats`).
  A plugin error handler now sends a refusal's extra fields (`src/routes/operations.ts`); every other
  error is unchanged.
- `release` keeps `pax` and grows `released_pax`. A release with nothing undrawn left to give (every
  seat drawn) changes nothing and keeps `status: active` (`state: depleted`), as legacy; it used to
  set `released`. A parent with sub-groups stays active after a release (legacy).
- A lock past its expiry stops holding (decision 2). As for a released lock already, a booking
  amendment that asks for more seats while keeping a draw on it is refused (`400`); legacy silently
  moves those seats to the general pool.
- Migration 048 data step: a lock whose `agent_id` names no agent becomes `office` with the name put
  first in `reason`, then `seat_locks.agent_id` gets its key (2 locks on the local full import).
- Booking writes add `draw`/`return`/`resched-return` lines to the lock log and a `seat_lock` row to
  the change feed for each lock whose draws moved. Bulk-lock writes record every departure.
- `capacity.ts`: `assertLockFits` is gone (replaced by `freeForLock` and the service);
  `test/capacity` and `test/route-calendar-rules` updated, and `test/boat-holds` makes its holds
  through the service as office locks.

**Decisions taken here**

- *Floor:* `pax` may not go below `released_pax` + drawn + split into sub-groups (the sum); legacy
  takes the larger of "most drawn" and "split", which can hand out more than the lock has (§lkOver).
- *Sub-group "+ seats"* is capped by the parent's room less what the parent sold itself, as creating
  one is (§lkOver); legacy's "+ seats" checks only the unsplit seats.
- *Release more than can be released* is `409 below_floor`; legacy's modal caps the number.
  *Confirm more than is pending* is capped, as legacy.
- *Bulk locks:* every running day in the range becomes a departure, past days included (legacy
  counts them as "past"); the short check covers today on. Releasing a bulk lock takes the same seats
  off every departure, at most what the busiest one can give. A bulk sub-group is made on every
  departure from today on that still holds, all or none. One departure's `pax` may be edited on its
  own (legacy has one `qty` for all).
- *Sub-groups:* need the parent's `version` (the URL is the parent's), and raise it. A released
  sub-group gives nothing even after a booking returns seats to it (legacy could draw on it again).
- *Expiry:* any date, as legacy (before, on or after the trip); a new lock whose expiry has passed is
  accepted. Moving an expired lock's expiry later brings it back (legacy kept `expired` for good).
- *`release-departure`* works on any top-level lock, not only a bulk departure; `release-overdue`
  takes every route that day unless `route_id` is sent (legacy: the day being viewed).
- *`held_pax`* is `null` on a whole-boat hold (it takes a boat, not seats).
- *Return lines* carry the command as their note (`edit`, `cancel`, `partial-cancel`, …), as legacy's
  `why`.

**The import** (rehearsed on `ob_files_1791520090`, 2026-10-09)

- Sub-groups now come over as their own locks (were folded into the parent), and a draw lands on the
  sub-group it names. Their own expiry is dropped (68 differed; decision 10).
- A bulk lock is a group plus a lock per departure; `pax` is what was asked (`qty` + released, so a
  released lock with `qty 0` comes over with its seats and `released_pax`); pending seats are
  pending, not subtracted. `expired` → active with its past expiry (118); `depleted`, `released`,
  `converted` → released.
- Free-text holders → office, the name first in the reason (9). Demo locks `lk001`–`lk003` came
  over; `lk004` did not (its r5 June–August 2026 range has no day the route runs here).
- Not imported: 4 bulk locks with no range (3 released, the §lkHeal case), 3 locks on route
  `r1791037542879`, not in the catalogue. 22 draws dropped: their booking moved off the lock's day
  or route (legacy §lkStale), so they cost general seats.
- Numbers: 1,448 locks (514 sub-groups, 402 departures of 6 bulk locks), 4,085 log lines, 779 draws.
  `verify-import`: every mapped lock and log line present; locked seats per route and day match
  legacy on all 179 route-days. A replay of legacy's pool hold (`bkV2LockPoolHold`) for every active
  day lock from today matches on all 41 route-days.
