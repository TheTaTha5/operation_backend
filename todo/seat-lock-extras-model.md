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

**Tests**

- One full PostgreSQL run hit a `40001` serialization failure past the 8 retries in
  `test/booking-adjustments` (unrelated file, under parallel load); the rerun on a fresh database
  passed. Worth watching: `day()` now reads every sub-group of a day too.
