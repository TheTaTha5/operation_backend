# Seat-lock extras

**Status:** decided and built 2026-10-09 on `feat/seat-lock-extras` (migration 048; README "Agent
seat locks"; code in `src/domain/seat-locks.ts`, `seat-lock-service.ts`, `seat-lock-input.ts`;
import in `src/tools/legacy-locks.ts`). Legacy read: wt-lk-inbox@658298d, `08-app.js` `bkV2Lock*`.
Whole-boat holds (decision 5) built 2026-10-10 on `feat/boat-holds-commands` (migration 180; README
"Whole-boat holds"; `src/domain/boat-holds.ts`, `boat-hold-service.ts`). What is left, and what to
look at before merging, is below.

## Open

1. **Editing a bulk lock's range or weekdays** is refused (`400 server_owned`: "release it and make
   a new one"). Legacy allows it while nothing is drawn (7 `edit` log lines in all, none changing a
   range). Ask ops whether they need it; building it means adding and removing departures.
2. **A login tied to one agent (Love Kingdom's) may lock seats for any holder.** Bookings refuse
   another agent (`403`); locks never checked it. Decide whether `/v1/seat-locks` should too (holds
   included).
3. **Legacy's KPI per agent** (`bkV2LockKpiByAgent`: seats locked vs drawn, conversion %) has no
   endpoint; a screen can sum `GET /v1/seat-locks?agent_id=` (`pax`, `drawn_pax`, `state`). Ask
   whether one is wanted.
4. **A hold's boat seats in the list.** Legacy's hold rows show the boat's seats that day
   (`bkV2BoatCapOn`); `GET /v1/seat-locks` does not carry them. A screen reads them from
   `/v1/seat-locks/boat-options` or the boat (`GET /v1/boats`). Add `boat_capacity` to a hold if the
   screen wants it in one read.
5. **The boat's pier by date.** Legacy asks the boat's pier on the travel date (§boatPierDate); here
   a boat has one `pier`, so a boat that moves pier for a season is checked against its catalogue
   pier.

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

**Whole-boat holds** (2026-10-10, migration 180; legacy §bkLock, 8 holds: 4 active, 3 released, 1
converted, all `fixed`)

- *Placing the boat:* legacy writes the boat-board cell, creating it when the boat was not on the
  board; here a hold **creates the boat's deployment** on its route (catalogue capacity and licence)
  when missing, and the change feed announces it. Release or a move leaves it as a normal boat, as
  legacy's `CellClear`. A hold moved to another route on the same day and boat moves the deployment.
- *Deviations from legacy, decided here:*
  - the "sold more than the other boats seat" blocker counts only when the boat is on the hold's
    route; legacy took the boat's seats off the route even when it was not there, refusing an extra
    boat on a sold-out day;
  - an `any` hold is checked against its boat's seats on create too (legacy: edit and swap only);
  - convert refuses a booking without a charter of the held boat on the hold's route and date (`400
    hold_mismatch`; legacy saved the booking and left the hold active) and a quote (`400 hold_quote`;
    legacy converted the hold but, for a quote, did not take the boat, so it went back to the pool);
  - a route change is checked like a move (legacy re-checked only a new date or boat);
  - refusals and the pick list's reasons are in English (legacy's list said them in Thai).
- *Kept from legacy:* the booking's agent may differ from the holder's; expiry may already be past
  when made (the hold then reads `overdue`); no past-date check on the hold itself; locks are not
  counted in "sold" (legacy's `seatsConsumed`); a boat's readiness and pier have no "anyway" (legacy's
  list just does not offer such a boat); bookings that do not hold seats (quotes, cancelled) never
  block (legacy counted quotes).
- *Changes to existing behaviour:* `POST /v1/seat-locks` with `boat_id` makes a hold (`boat_id` was
  ignored); `PATCH` on a hold edits it (was `400 boat_hold` for seats or a move); `boat_id` on an
  ordinary lock's `PATCH` still `400 server_owned`, now saying how to make a hold; Boat Operation's
  remove or move of a held boat is `409 boat_held` (was open item 1 of `deployment-guards-model.md`);
  a hold's release logs legacy's `manual · {boat}` with no seats (was seats 0 and no note). Booking create
  was split into plan and write (`src/routes/operations.ts`) so convert runs it in its transaction;
  `createBooking` in both stores takes an exclusion.
- *The import:* `converted` stays `converted` with `lg_` + the booking its `convert` line names (a
  converted hold with no such line → released); `boat_deal` from `subname`. Rehearsed on a throwaway
  import 2026-10-10: 8 holds, deals and statuses as legacy, the converted one's booking present, 13
  log lines; `verify-import`'s lock checks 0 differences.
