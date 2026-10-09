# Seat-lock extras, legacy read

**Status:** legacy read (wt-lk-inbox@658298d, 2026-10-09); decided and designed 2026-10-09 (below).

In short: here a seat lock is one route, one day, N seats, an optional agent. Legacy's Seat Locks
tab adds eight things on top: **bulk locks** (a date range, optionally some weekdays),
**sub-groups** (named slices of a lock), **pending seats** (asked for but not yet free), a **release
cutoff** per departure (now a warning only), a hard **expiry** (still automatic), a free-text
**reason**, a **log** of every change, and **whole-boat holds**. An unmerged branch here,
`feat/bulk-seat-locks`, built three of them, but its release time no longer matches legacy.

## What legacy does

All in `08-app.js`, the `bkV2Lock*` functions and the Seat Locks tab (`bkV2RenderLocks`). Writes save
with the `operations` edit area (`sbSeatLocksPersist`); without it they are silently not saved.

### Kinds (`scope`)

- **`day`**: one route, one date, `qty` seats. Has an `expiry` date.
- **`bulk`**: one route, `dateFrom`–`dateTo`, optional weekdays `dow` (0 = Sunday; empty = every
  day). `qty` is **seats per departure**, not a total. Departures are the days in range, on a ticked
  weekday, on which the route runs (`bkV2LockRounds`, `bkV2LockSpecDates`). Draws are counted per
  departure in `usedBy {date: n}`. No expiry; it uses the release cutoff instead and expires the day
  after `dateTo` (`bkV2LockExpireSweep`).
- **`month`**: the old form of bulk (`monthFrom`–`monthTo`). Converted to `bulk` on load, once, with
  a `migrate` log line.
- **`boat`**: a whole-boat hold (§bkLock, 2026-10-01). One boat on one route and date for an agent
  who has not confirmed numbers. `qty` is the **minimum seats promised**, not seats held; `subName`
  is reused as `fixed` (this exact boat) or `any` (any boat that big). It takes the boat out of the
  pool by writing a charter-style cell on the boat board (`TRIPS[date][boat].boatLockId`), and is
  converted into a real charter booking (`bkV2BoatLockToCharter`, log `convert`, status
  `converted`). Expiry is required and must be on or before the travel date. It never expires by
  itself: past expiry it shows as "overdue". Refusals: the boat is taken, carries sold passengers
  (`bkV2BoatLockBlockers` lists them), is placed on another route, or is smaller than promised.

### Holder

`holderType` `agent` (with `holderId`), `office`, or `global` (none in the data). The agent is
typed by name; **an unknown name is kept as free text** in `holderId`. A booking may draw from its
own agent's locks and from `office`/`global` ones (`bkV2LocksForAgent`).

### Sub-groups (`parentId`, `subName`)

- "A / B / C" slices of a lock, usually a sales person or LINE contact of the agent (`@Chicky65`,
  `Tukta`). One level. Created from the lock's manage popup (`bkV2CreateSubLock`): name required
  ("Type a sub-group name (e.g. A)"), seats > 0.
- A sub-group copies the parent's route, dates, holder and cutoff; editing the parent moves them too.
- Seats come out of the parent: the room is the parent's `qty` − children's `qty` − what the parent
  sold itself (`bkV2LockSubRoom`, alert "เกินจำนวนที่เหลือแบ่งได้ (เหลือ n ที่)").
- Only the parent holds seats in the pool (`bkV2LockPoolHold` is 0 for a child). A booking draws
  from a sub-group, or from the parent's "ยังไม่จัด" (not yet split) remainder (`bkV2DrawSources`).
- A child's draw is capped by both its own remainder and the parent's.
- With pending seats on the parent, sub-groups are served in creation order, then the unsplit
  remainder; a sub-group not reached yet is itself pending (`bkV2LockSubShares`, §lkPendSub
  2026-10-02).

### Pending seats (§lkPend, 2026-10-02)

- Before this, nothing stopped a lock beyond the boat's free seats. Now create, edit and "+ seats"
  compare the request with free seats per departure (`bkV2LockShort`). Free seats = capacity −
  sold − locked; a day with no boat yet gives `null` and passes ("or you could never lock ahead").
- When short, a dialog "ที่นั่งว่างไม่พอ" offers:
  - **split**: lock what is free now, the rest pending;
  - **all**: the whole request pending (create only, and not when nothing is free);
  - **cancel**.
- Pending seats hold nothing and cannot be drawn. They are stored as `pendQty` (day lock) or
  `pendBy {date: n}` (bulk), on the parent only. Log `pend` with a note such as `free 0 of 2`.
- **Confirm** (`bkV2LockPendConfirm`, on the Seat Locks tab or the manifest) turns pending into held
  seats, up to what is free now; alert "No free seats on this trip yet - the lock stays pending".
  Log `pend-confirm`. Nothing confirms by itself.
- Lowering `qty` or releasing takes pending seats off first (`bkV2LockPendShrink`). Releasing a
  departure ends its pending seats.

### Release cutoff (bulk; `releaseDaysBefore`, `releaseTime`)

- E.g. "release 1 day before, 18:00" (`bkV2LockCutoffLabel`; form default 1 day, 18:00).
- **Since §lkNoAuto (2026-09-29) it releases nothing by itself.** Past the cutoff the departure
  is "overdue": a warning, and the seats stay held. Staff release a departure by hand
  (`bkV2LockReleaseRound`: confirm "ปล่อยที่นั่งของรอบนี้คืนเข้า pool…", log `release-round`
  with `tripDate`, by and seats), or every overdue lock of the day at once
  (`bkV2LockReleaseOverdueGo`). Released dates go into `releasedDates`.
- The reason: automatic release made a lock vanish from the manifest while the Seat Locks page
  still said ACTIVE (the Panorama case).

### Expiry (day locks and sub-groups)

- `expiry` date; the form says "หมดอายุ · ปล่อยคืนอัตโนมัติ" (released automatically).
- `bkV2LockExpireSweep` runs **in the browser when someone loads the app**: an active day lock whose
  `expiry` is before today becomes `expired` (log `expire`, no user), and its seats go back to the
  pool. Whole-boat holds are skipped. A bulk lock wrongly expired while its range is still open
  is set back to active (`reactivate`).
- So day locks still release automatically, by date only (no time), while bulk locks do not.

### Reason

Free text on the lock (`reason`), and on each sub-group. In practice it names the person or the
deal: `Love Boom`, `Fam Trip Georgia\n11 + 1 guide`, `รอคีย์บุ้คกิ้งเก่าเข้าระบบ` (waiting to key in
old bookings).

### Editing a lock (§lkEdit, 2026-09-29)

- Once any seat is drawn (from it or a sub-group: `bkV2LockEditLocked`), route, dates, kind and
  holder are frozen.
- `qty` may not go below the most drawn on one departure, or below what is split into sub-groups
  ("Seats cannot go below n (already drawn on one round)").
- A bulk range needs both ends ("Pick the last day of the range": the Panorama case, where an
  empty end collapsed the range to a Saturday the lock's Tue/Thu weekdays never hit). A bulk lock
  that covers no departure is refused ("This lock covers no departure at all…").
- Every changed field is logged as one `edit` line, `field: old → new · …`.

### Other actions

- **+ seats** (`bkV2LockAddSeats`, log `add` with a note): a sub-group can grow only within the
  parent's unsplit seats; reactivates a depleted or released lock.
- **Release** (`bkV2ReleaseLock`, modal with a number): lowers `qty` by n, never below the peak drawn
  or the split seats. Undrawn and unsplit → `released`; drawn → `depleted`. Log `release` (no time,
  no user).
- **Draw / return** happen from bookings (`bkV2DrawLock`, `bkV2ReturnLock`): log `draw`/`return`
  with booking id and departure. A lock with nothing left and nothing pending becomes `depleted`.
  A reschedule returns its draws (log `resched-return`).
- **Audit and repair**: `bkV2LockAudit` compares the `used` counter with the bookings that still
  draw from it; `bkV2LockSweep` lists locks whose counter is too high (a booking moved or cancelled)
  and parents that sold more than their unsplit seats; "fix" rewrites `used` (log `reconcile`).
  Needed because `used` is a counter, not derived.
- **KPI per agent** (`bkV2LockKpiByAgent`): seats locked vs drawn, conversion %, counts by status.

### The list (the "bulk grouping")

- Filters: search, route, holder, kind, status (default `active`). Grouping by agent (default),
  by route, or none. A day strip starting tomorrow.
- A bulk lock shows as **one row** with "x / y departures past". On the integration branch
  (`ops/30-ops-locks.js`) a bulk lock is sent here as one lock per departure. After a reload they
  come back as N day locks, "Grouping them again needs a group field on the server".

## How legacy stores it

`sb_seat_locks` (blob key `sb_seat_locks`), one row per lock **and per sub-group**:

| Column | Meaning |
|---|---|
| `id` | `lk…` |
| `scope` | `day`, `bulk`, `month`, `boat` |
| `routeid`, `date` | day lock / whole-boat hold; `''` for bulk |
| `datefrom`, `dateto`, `dow` (JSON text `[2,4]`) | bulk range |
| `month`, `monthfrom`, `monthto` | old month kind |
| `boatid` | whole-boat hold only |
| `holdertype`, `holderid` | `agent`/`office`/`global`; id or free text |
| `qty`, `used` | seats asked (per departure for bulk), drawn counter; release lowers `qty` |
| `usedby` (JSON text `{date:n}`) | bulk draws per departure |
| `pendqty`, `pendby` (JSON text) | pending seats |
| `releasedaysbefore`, `releasetime`, `releaseddates` (JSON text) | cutoff and departures released by hand |
| `expiry`, `reason`, `status` (`active`/`depleted`/`expired`/`released`/`converted`) | |
| `parentid`, `subname` | sub-group (`subname` is `fixed`/`any` on a whole-boat hold) |
| `createdat`, `createdby` | |

`sb_seat_locks__log`: `sb_seat_locks_id`, `idx`, `date`, `type`, `qty`, `at`, `by`, `bookingid`,
`tripdate`, `note`, `sub`. Bookings point at locks through `sb_bookings__trips.lockdraws`
(JSON text `[{"lockId":"lk…","qty":2}]`) and `lockdrawsel`.

## Data (2026-10-09)

- **1,054 lock rows**: 543 locks + 511 sub-groups (under 114 parents, at most 18 under one).
  - By kind: day 1,034, bulk 11, boat 8, blank 1.
  - By status: day locks are active 61, depleted 577, expired 122, released 274.
  - Holders: agent 1,034, office 20, global 0.
- Future day locks (from 2026-10-09): active 58, depleted 31, expired 6, released 23.
- **Extras in use:**
  - `reason` 76;
  - `expiry` 1,021: on 536 day locks it is before the trip, on 468 the same day, on 6 after it;
  - release cutoff 9 (all bulk: 1 day 18:00 ×6, 2 days 15:00 ×2, 1 day 16:00 ×1);
  - weekdays 3;
  - pending: 0 now (`pendqty`/`pendby` all empty), but 13 `pend` log lines since 2026-10-02;
  - `releaseddates`: 0.
- **Bulk locks:** 3 active (r5 Nov–Mar Tue/Thu 30 seats; r1 Dec 30–Jan 7 38 seats; r1 Nov–May
  Mon/Thu/Sat 38 seats). 3 released ones have lost their range (null `datefrom`), the §lkHeal
  "no trail" case.
- **Whole-boat holds:** 8 (active 5, released 2, converted 1). One is held for `a_b2c` (Love
  Kingdom), 64 seats on r4 2026-12-16.
- **Log:** 4,079 lines.
  - Counts: draw 1,357, create 1,054, release 598, return 496, add 396, expire 124,
    resched-return 23, pend 13, edit 7, reconcile 7, migrate 2, heal 1, convert 1.
  - `release` lines have no time or user on 596 of 598; `expire` lines never do.
- **776 booking trips** carry lock draws.
- 298 rows have `qty = 0` (280 released, 17 expired, 1 active): release lowers `qty`.
- **Demo seed locks `lk001`–`lk004` are in production** (`SB_SEAT_LOCKS_SEED`, "DMC Russia",
  "Ctrip").

## Already here

- `seat_locks` (migration 001): `id`, `route_id`, `service_date`, `pax`, `agent_id`, `status`
  (`active`/`released`), timestamps, `version` (028). Lock draws in `booking_trip_lock_draws` (014).
  Endpoints: README "Agent seat locks". `drawn_pax` is computed; a lock holds `pax − drawn_pax`.
- **The import** (`src/tools/import-legacy.ts`, `legacy-locks.ts`):
  - a bulk/month lock becomes one lock per departure (`lg_<id>_<date>`);
  - sub-groups are folded into their parent;
  - pending seats are subtracted;
  - expired/depleted/released become `released`;
  - reason, expiry, cutoff, sub-group names and the log are dropped;
  - day-lock `pendqty` is not subtracted (only bulk `pendby` is). Harmless today: none is set.
  - **Whole-boat holds** take their boat, as a charter does (built 2026-10-09: README "Agent seat
    locks", migration 047). The import never double-counted them: it brought the boat as an ordinary
    deployment and a lock of the promised seats, which matched legacy only while a hold promised its
    whole boat.
  - A free-text holder (9 locks, 8 names such as `Aqua`, `GUIDE MAN`) is imported as an `agent_id`
    that matches no agent.
- **Unmerged `feat/bulk-seat-locks`** (8c90c94, 2026-10-02; migration renumbered to 019):
  - `seat_lock_groups` (range, weekdays, pax) with one day lock per departure;
  - sub-groups (`parent_id`, `sub_name`);
  - `release_days_before`/`release_time` that **release automatically on read**.
  
  Legacy dropped automatic release on 2026-09-29 (§lkNoAuto), so that part is now wrong.
  The branch has no pending seats, expiry, reason, log, or whole-boat holds.
  `developer-checklist.md` lists it to merge or delete.
- `legacy-replacement.md` §5 proposes `GET /v1/seat-locks/{id}/log`. `deployment-guards-model.md` 1:
  pulling a boat held whole waits for boat holds.
- `booking-model.md`: a draw does not check the lock's agent against the booking's.
- README says `PATCH /v1/seat-locks/{id}` **ignores** fields other than `pax`/`agent_id`.
  CLAUDE.md asks for `400` on a server-owned field. Worth fixing in the same design.
- The integration branch sends only route, date, seats (minus pending) and agent.
  Sub-groups, pending, cutoff, expiry, reason and log "live on screen for the session only".

## Bugs or oddities in legacy

1. **`used` is a stored counter** that drifts (a moved or cancelled booking left it high). Hence
   the audit/sweep/reconcile screens. Here `drawn_pax` is computed from draws, so none of that is
   needed.
2. **Expiry runs in whoever's browser loads first**, by date only, with no user on the log line.
   A lock expiring "today" still holds all day.
3. **Two release rules disagree:** day locks still release automatically at expiry, bulk locks no
   longer do at their cutoff (§lkNoAuto). Ask whether expiry should become a warning too.
4. **Release lowers `qty`.** What was asked is lost; only the log keeps it (280 released rows have
   `qty = 0`).
5. **Free-text holders**: a mistyped agent name becomes a holder id that matches no agent, so no
   booking can draw from it (9 locks, 8 names, 2026-10-09).
6. **The seed demo locks** `lk001`–`lk004` live in production.
7. **Bulk ranges lost** on 3 released locks (no `datefrom`/`dateto`), from before those columns
   existed.
8. **`release` and `expire` log lines** carry no time or user.
9. **Pending confirm checks the `booking` edit area** (`laGuardEdit('booking')`), but saving needs
   `operations`. A user with only `booking` sees it confirm, then lose it on reload.
10. **The whole-boat hold reuses `subName`** for fixed/any and `qty` for minimum seats: same columns,
    other meanings.
11. **A sub-group's own `expiry`** is set and swept on its own, independent of the parent.

## Questions for the developer

1. **Start from `feat/bulk-seat-locks` or from scratch?** *Recommend: reuse its shape (group row +
   one day lock per departure; `parent_id`/`sub_name`), but change release times to a computed
   `overdue` warning plus a manual per-departure release, as legacy does now.*
2. **Expiry on day locks: automatic or warning?** Legacy releases automatically, by date.
   *Recommend: ask ops. If kept, compute it on read (holding = not past expiry), as the branch does
   for cutoffs, so there is no sweep job. Otherwise make it an `overdue` warning, the same as the
   cutoff.*
3. **Pending seats: model them?** Used 13 times in a week; none open now. *Recommend: yes, as
   `pending_pax` per lock (per departure). Create/PATCH answer "short" with the numbers and accept
   `pending: "split"|"all"` (the dialog's choices). `POST /v1/seat-locks/{id}/confirm-pending`.
   Pending holds nothing, so the capacity guard ignores it.*
4. **Sub-groups:** 511 rows, heavily used. *Recommend: model them (one level), and stop folding them
   into the parent on import. A booking's draw names the sub-group; the pool counts the parent.*
5. **Whole-boat holds:** a separate feature with its own refusals and a charter conversion.
   *Recommend: a design note of its own (it touches deployments and charters), not part of this
   one. (The pool side is built: a hold takes its boat, migration 047.)*
6. **The log:** *Recommend: a `seat_lock_events` table written by the server on every command:
   create, add, release, release-departure, pend, pend-confirm, edit with old → new, draw and
   return from bookings, with time and user. `GET /v1/seat-locks/{id}/log`. Import legacy's 4,079
   lines.*
7. **Release:** keep `pax` and record released seats, rather than lowering `pax` like legacy?
   *Recommend: keep the asked number and store `released_pax` (or the release events). The
   screen's numbers stay legacy's.*
8. **Free-text holders:** *Recommend: refuse an unknown agent (`400`). Count legacy's free-text
   holders before deciding how to import them.*
9. **`office`/`global` holders:** here `agent_id: null` means office. *Recommend: add
   `holder_type` (`agent`/`office`/`global`) so a booking of any agent may draw from office/global,
   and enforce "own agent only" for agent locks (open in `booking-model.md`).*
10. **Reason and expiry on sub-groups:** keep them per sub-group as legacy does? *Recommend: reason
    yes; expiry inherited from the parent unless ops need it separate.*
11. **Seed locks `lk001`–`lk004`:** *Recommend: skip them on import.*

## Decided (2026-10-09)

1. **Bulk locks:** reuse `feat/bulk-seat-locks`'s shape (a group + one lock per departure), with an
   `overdue` warning and a manual release per departure instead of its automatic release.
2. **Day-lock expiry:** copy legacy: an expired lock stops holding seats, worked out on read (no job).
3. **Pending seats:** modelled (`pending_pax`, the short answer with split/all, a confirm command).
4. **Sub-groups:** modelled, one level; a booking draws from a sub-group, the pool counts the parent;
   reason per sub-group, expiry from the parent (Q10).
5. **Whole-boat holds:** their own design (the pool side is built, 047).
6. **Lock log:** server-written `seat_lock_events`, `GET /v1/seat-locks/{id}/log`, legacy's lines imported.
7. **Release** keeps the asked `pax` and records released seats separately.
8–9. **Holders:** `holder_type` agent/office/global; an agent lock needs a real agent (`400`) and only
   its bookings draw from it; office/global any. Legacy's 9 free-text holders import as `office`
   with the name kept in the reason.
11. **Demo locks `lk001`–`lk004`:** imported like any other lock.

## Design (2026-10-09, from the decisions above)

### The model in one paragraph

A lock stays one route, one day. A **bulk lock** is a `seat_lock_groups` row plus one ordinary
lock per departure (`group_id`), as on `feat/bulk-seat-locks`. A **sub-group** is a lock with
`parent_id` and `sub_name`, on its parent's route and day. Every number a screen shows (what a lock
holds, what a booking may draw, what is pending, whether it is expired or overdue) is worked out on
read by pure functions in `src/domain/seat-locks.ts`, which both stores call. The commands are
written once, in `src/domain/seat-lock-service.ts`, over a small I/O interface both stores implement
(read lock rows, read draws, upsert, write events). Nothing runs on a timer.

### Fields and who decides them

`seat_locks` (a day lock, one departure of a bulk lock, or a sub-group):

| Field | Kind | Rule |
|---|---|---|
| `id`, `version`, `created_at`, `created_by`, `updated_at`, `released_at` | computed | `created_by` is the login |
| `route_id`, `service_date` | validated | the route runs that day (`409 route_closed`); frozen once a seat is drawn (`409 lock_drawn`); a sub-group's are its parent's; a departure of a bulk lock cannot move (`400`) |
| `pax` | validated | seats **asked for**, never lowered by a release. Checked against free seats (see pending); not below `released_pax` + drawn + split into sub-groups (`409 below_floor`); a sub-group grows only into its parent's room (`409 no_room`) |
| `holder_type` | validated | `agent`, `office`, `global`. Absent: `agent` when `agent_id` is sent, else `office` (legacy's default). Frozen once drawn (`409 lock_drawn`); a sub-group's and a departure's are their parent's / group's (`400`) |
| `agent_id` | validated | required for, and only for, `agent` (`400`); must be a real agent (`400`, `GET /v1/agents`) |
| `reason` | client fact | free text, up to 500 characters; a sub-group has its own |
| `expiry` | client fact | a date; day locks only. A sub-group's is its parent's, a departure has none (`400` if sent) |
| `pending_pax` | computed | set by the `pending` choice and `confirm-pending`; `PATCH` refuses it (`400 server_owned`) |
| `released_pax` | computed | set by `release` / `release-departure`; `PATCH` refuses it |
| `status` | validated | `active`/`released`, moved only by the commands (`release`, `add` reactivates); `PATCH` refuses it |
| `group_id`, `parent_id` | computed | set by the group create and `/sub-groups`; `PATCH` refuses them |
| `sub_name` | client fact | a sub-group only, 1–40 characters |
| `boat_id` | computed (import) | whole-boat holds, unchanged: their own design. Commands other than a full release refuse a hold (`400 boat_hold`) |

Read-only numbers on every lock response (all computed):

| Field | Meaning |
|---|---|
| `drawn_pax` | seats drawn from this lock by bookings that hold seats (unchanged) |
| `pending_pax` | asked but waiting for room; holds nothing, cannot be drawn. On a sub-group, its share (legacy §lkPendSub) |
| `remaining_pax` | what a booking may draw now (a parent: only its seats in no sub-group) |
| `held_pax` | what it keeps off general sale now. A sub-group `0` (its parent holds); a whole-boat hold `null` (it takes the boat) |
| `allocated_pax`, `sub_group_room` | a top-level lock: seats split into sub-groups, and seats a new sub-group may take |
| `holding` | active, not past `expiry` (Asia/Bangkok day; a lock expiring today still holds all day), and for a sub-group its parent holding. Whole-boat holds ignore expiry, as legacy does |
| `state` | legacy's labels: `active`, `depleted` (nothing left, something drawn), `expired`, `released` |
| `release_at`, `overdue` | a departure of a bulk lock with a release cutoff: the instant, and whether it has passed while the lock still holds (a warning only, §lkNoAuto). A whole-boat hold is `overdue` past its expiry |

`seat_lock_groups` (a bulk lock): `id`, `version` (computed); `route_id`, `date_from`, `date_to`,
`weekdays` (validated: real dates, `date_to` required and not before `date_from`, at least one
departure, else `400 no_departure`); `pax` (validated per departure, as a lock's); `holder_type`,
`agent_id` (validated, as a lock's, and copied to every departure); `reason` (client fact);
`release_days_before` + `release_time` (client facts, both or neither). Computed on read:
`departures`, `departures_past`, `state` (`released` when every departure is; `expired` once
`date_to` is past), and the sums `held_pax`, `drawn_pax`, `pending_pax`.

`seat_lock_events` (the log) is all computed: written by the server inside the command's
transaction; legacy's lines are imported with `imported: true`.

### Pool arithmetic (legacy's `bkV2LockHeldRemaining`, `bkV2LockDrawable`, `bkV2LockSubShares`)

For a top-level lock P with sub-groups C (E = `pax − released_pax`):

- used = drawn(P) + Σ drawn(C); pend = min(`pending_pax`, E − used); **P holds** E − used − pend.
- allocated = Σ E(C); unallocated = E − allocated; sub-group room = unallocated − drawn(P).
- No pending: P may give min(unallocated − drawn(P), held); C gives min(E(C) − drawn(C), held(P)).
- With pending: what P holds is shared out in sub-group creation order, then the unsplit rest; a
  sub-group not reached is pending itself.
- A released sub-group gives nothing; its drawn seats still count against its parent.

### Pending seats (legacy §lkPend)

Create, a `pax` raise, a move and `add` compare what the lock still needs (`pax − released − drawn`)
with the free seats each day from today on (free = available + what the lock already holds; a day
sold ungated, with no boat or on a land route, never falls short). Short and no choice sent: `409
seats_short` with the numbers. With `pending: "split"`: lock what is free, the rest pending; with
`"all"` (create only): the short days entirely pending. An edit asks only when the shortfall exceeds
what is already pending (legacy). Lowering `pax` or releasing takes pending seats off first.
`confirm-pending` turns pending into held seats up to what is free now.

### Contract

Locks (`operations` edit area; every write to one lock needs its version, as today):

- `GET /v1/seat-locks` `?route_id&service_date|date&from&to&group_id&parent_id&agent_id`
- `GET /v1/seat-locks/{id}`; `GET /v1/seat-locks/{id}/log`
- `POST /v1/seat-locks` `{ route_id, service_date, pax, holder_type?, agent_id?, reason?, expiry?, pending? }` → `201`
- `PATCH /v1/seat-locks/{id}` client facts only: `pax, holder_type, agent_id, reason, expiry, route_id, service_date, sub_name, pending?`.
  `status, pending_pax, released_pax, group_id, parent_id, boat_id, drawn_pax` → `400 server_owned`
  naming the command.
- `POST /v1/seat-locks/{id}/add` `{ pax, note?, pending? }` (legacy "+ seats"; reactivates a released lock)
- `POST /v1/seat-locks/{id}/release` `{ pax? }` (legacy Release: n undrawn seats not in a sub-group, default all; a sub-group's go back to its parent)
- `POST /v1/seat-locks/{id}/release-departure` (legacy "ปล่อย n ที่": the whole departure, sub-groups and pending included, back to the pool)
- `POST /v1/seat-locks/release-overdue` `{ service_date, route_id? }` (legacy "release every overdue lock of the day")
- `POST /v1/seat-locks/{id}/confirm-pending` `{ pax? }`
- `POST /v1/seat-locks/{id}/sub-groups` `{ sub_name, pax, reason? }` → `201` the sub-group

Bulk locks:

- `GET /v1/seat-lock-groups` `?route_id&agent_id`; `GET /v1/seat-lock-groups/{id}` (with `seat_locks`); `GET /v1/seat-lock-groups/{id}/log`
- `POST /v1/seat-lock-groups` `{ route_id, date_from, date_to, weekdays?, pax, holder_type?, agent_id?, reason?, release_days_before?, release_time?, pending? }` → `201`
- `PATCH /v1/seat-lock-groups/{id}` `{ pax?, holder_type?, agent_id?, reason?, release_days_before?, release_time?, pending? }`
- `POST /v1/seat-lock-groups/{id}/add` `{ pax, note?, pending? }`; `/release` `{ pax? }`; `/sub-groups` `{ sub_name, pax, reason? }`

Errors carry `code`; `seats_short` also carries the days:

```json
{ "statusCode": 409, "code": "seats_short", "error": "Conflict",
  "message": "Not enough free seats on r1 2026-11-02: 2 free of 5 asked. Send pending: \"split\" to lock what is free and keep the rest pending, or \"all\" to keep it all pending",
  "short": [{ "service_date": "2026-11-02", "free": 2, "want": 5, "short": 3 }] }
```

Bookings: a draw on an `agent` lock by a booking of another agent (or of none) is `400
lock_other_agent`; `office`/`global` locks serve any booking. A draw on an expired lock is refused
as on a released one (`400`).

The log (`GET …/log`), oldest first:
`{ id, lock_id, group_id, type, qty, trip_date, booking_id, note, day, at, by, imported }`. Types
written here: `create`, `add`, `edit` (`field: old → new · …`), `release`, `release-round`, `pend`,
`pend-confirm`, and `draw` / `return` / `resched-return` from booking writes (worked out from the
booking's draws before and after each write, so a cancel returns its seats).

### Schema (migration 048)

```sql
CREATE TABLE seat_lock_groups (
  id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1, route_id TEXT NOT NULL REFERENCES routes (id),
  holder_type TEXT NOT NULL CHECK (holder_type IN ('agent','office','global')), agent_id TEXT REFERENCES agents (id),
  date_from DATE NOT NULL, date_to DATE NOT NULL, weekdays SMALLINT[] NOT NULL DEFAULT '{}',
  pax INTEGER NOT NULL CHECK (pax > 0), release_days_before INTEGER, release_time TEXT, reason TEXT,
  created_at, created_by, updated_at, CHECK (date_to >= date_from), CHECK ((holder_type = 'agent') = (agent_id IS NOT NULL)), …);
ALTER TABLE seat_locks ADD holder_type, pending_pax, released_pax, expiry DATE, reason, group_id → groups,
  parent_id → seat_locks, sub_name, created_by; agent_id → agents;
  CHECK (pending_pax + released_pax <= pax), CHECK ((parent_id IS NULL) = (sub_name IS NULL)), …;
CREATE TABLE seat_lock_events (id BIGSERIAL, lock_id → seat_locks ON DELETE CASCADE, group_id → groups ON DELETE CASCADE,
  type, qty, trip_date DATE, booking_id, note, day DATE NOT NULL, at TIMESTAMPTZ, by, imported BOOLEAN);
```

Existing rows: `holder_type = 'agent'` where `agent_id` is set; a lock whose `agent_id` names no
agent becomes `office` with the name moved into `reason` (decision 8–9), before the key is added.

### The import (`legacy-locks.ts`, pure, tested on fixture rows)

- Day locks → `lg_<id>`; bulk/month locks → a group `lg_<id>` plus `lg_<id>_<date>` per departure
  the route runs; sub-groups → `lg_<id>` with `parent_id` (no longer folded into the parent).
- `pax` = legacy `qty` + the seats its `release` log lines gave back; `released_pax` = those seats.
- `pending_pax` = `pendqty` (day) / `pendby[date]` (bulk), no longer subtracted.
- Status: `active` → active; `expired` → active with its expiry (so it reads expired) unless that
  expiry is not past, then released; `depleted`, `released`, `converted` → released; a departure in
  `releaseddates` → released.
- Holder: `agent` with a known agent → agent; an unknown name → `office`, the name put first in
  `reason`; `office`/`global` kept. Sub-groups take their parent's holder.
- Expiry: a day lock's; a sub-group's own expiry is dropped (decision 10). Cutoff → the group.
- The log: every line onto its lock (a bulk lock's onto its group, and onto the departure when the
  line names `tripdate`), `imported: true`. Lines of a lock not imported are counted, not kept.
- Draws land on the sub-group they name (no longer on the parent).
