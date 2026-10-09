# Weather closures and their follow-up, legacy read

**Status:** legacy read (wt-lk-inbox@658298d, 2026-10-09); not designed yet.

In short: a weather closure is a flag "route R does not run on date D because of weather", plus a
per-booking to-do list (notify the agent, then reschedule or cancel each booking). Legacy keeps the
flag in `sb_weather` and the to-do in `bk.weatherResolve`. The flag refuses nothing: it changes
what screens show and which seats they count. Here only the last step, `cancel-weather` on one
booking, exists.

(Legacy's function names are `bkV2Weather*`. `bookingV2WeatherMark` is the name in the
`operation_frontend` modular copy; it is the same code.)

## What legacy does

### 1. Closing a trip (route + date)

- **Where:** Boat Operation, a route/date cell's popover, button "Cancel trip (weather)"
  (`04-data-core.js`, the cell popover that calls `bkV2WeatherMark`). The button is hidden for past
  dates (`_bopPast`). On an already-closed cell the same button reopens the dialog to edit the note
  or undo.
- **Dialog** (`bkV2WeatherMark`): a free-text note ("e.g. high waves 3m · port closed · heavy
  rain"), then "Confirm cancel trip" (or "Update note" when already closed).
- **Confirm** (`bkV2WeatherMarkConfirm`):
  1. adds `{routeId, date, reason:'weather', note, at}` to `SB_WEATHER_CLOSURES`, or only updates
     the note if one exists for that route and date (one closure per route+date);
  2. tags the bookings on it (`bkV2WeatherTagBookings`, below);
  3. saves (`sbWeatherPersist`).
- **Which bookings are tagged:** any booking not `cancelled`/`rejected`/`cancelled_weather` with a
  trip on that route and date whose `bookingMode` is not `charter`. **Charters are never tagged.**
  Each gets `weatherResolve = {event: "<routeId>|<date>", status: 'awaiting'}` and a history line
  `Trip <route name> · <date> cancelled due to weather` (kind `weather`, tag `Weather`).
- **Tagging runs again every time the panel opens** (`bkV2WeatherPanel` calls
  `bkV2WeatherTagBookings` first), so a booking made on the day after it was closed is tagged
  then, not when it is made.
- `bkV2WeatherCancel` (a `confirm()` in Thai, then the panel) is dead code: nothing calls it.

### 2. Undo ("Undo cancel · re-open trip", `bkV2WeatherUncancel`)

- Refused with an alert "View only - no permission to edit operations" without the `operations`
  edit area.
- A `confirm()` lists how many bookings go back to normal and, by code and outcome, the ones
  already resolved, which **stay as they are** ("a booking already moved or refunded is not
  silently un-tagged").
- Removes the closure; deletes `weatherResolve` from every unresolved tagged booking with a
  history line `Trip … re-opened · weather cancellation undone` (tag `Weather`).

### 3. The per-booking follow-up

Two places show the same workflow: the modal "Manage bookings · trip cancelled (weather)"
(`bkV2WeatherPanel`, opened from the red banner "This trip is cancelled due to weather · Resolve
by booking" on the By-trip tab) and an inline column on the By-trip manifest
(`bkV2WeatherInlineCell`, only when the trip is closed). Steps: **notify agent → agent asks the
customer → resolve.**

The modal header counts "To notify / Notified / Resolved". Each row shows code, agent (or `B2C`),
pax, and "Paid ฿x" / "Unpaid" (from the booking's invoice).

- **awaiting → notified** (`bkV2WeatherNotify`, "Notify agent"): sets `status:'notified'`,
  `notifiedAt`, history `Notified agent · awaiting customer decision (reschedule/cancel)` (tag
  `Notify`). Nothing is sent: it is a check mark that staff called or messaged the agent.
- **notified → resolved** (`bkV2WeatherResolveOne`, "Resolve"/"Apply"): a select with four
  outcomes and a date (default: the day after the closed date).
  - **`reschedule`**: clears that date's ops block (`bkOpsClear`: boat, van, pickup time,
    check-ins); moves every trip on that route and date to the new date; writes
    `bk.rebook = {from, to, reason:'weather', at}` and `weatherResolve.newDate`; history
    `Rescheduled <route> · <from> → <to> (weather)` (tag `Reschedule`). The status stays as it was.
  - **`refund`**, **`credit`**, **`cancel`**: all set `status:'cancelled_weather'`,
    `cancelReason:'weather'`, `cancelledAt`, then:
    - `refund`: if the invoice has payments, pushes a negative payment
      `{amount:-paid, method:'refund', type:'refund'}` onto it; voids the invoice; sets
      `bk.refund = {amount: paid, status:'due'}`. History `Refund ฿x` (tag `Refund`).
    - `credit` (option disabled when nothing is paid): creates an agent deposit of the paid amount
      (`acctCreateDeposit(agentId, paid, 'transfer', 'Weather-cancel <code>')`); voids the invoice.
      History `Kept as credit ฿x` (tag `Credit`).
    - `cancel`: voids the invoice. History `No refund` (tag `Cancel`).
  - Then `status:'resolved'`, `outcome`, `resolvedAt`.
- There is no step back from `notified` or `resolved` except Undo (which skips resolved ones).

### 4. Who reads a closure (all display, nothing refuses)

`bkV2IsWeatherClosed(routeId, date)` is read by:

- calendars and availability summaries, which **skip the route's seats** that day and show a
  "Closed"/"CANCEL"/⛈ marker (`04-data-core.js` month calendar `dayAgg`, the free-seat calendar,
  the Boat Operation grid, the forecast calendar; `08-app.js` booking calendar chips with pax
  struck through, the trip card's red banner, the pickup-plan tag "ปิดจากอากาศ", the occupancy
  report);
- the action board (`09-action-board.js`), which shows the cell as state `wx` instead of seats;
- the dashboard (`_dashBoardData`), which counts bookings with an unresolved `weatherResolve`
  and links to the earliest date;
- the By-trip tab, which keeps "Rescheduled away" ghost rows on the closed date for bookings whose
  outcome was `reschedule` (`_wxGhosts`), and a "moved in" badge on the new date from `bk.rebook`;
- `bkV2WeatherCountsFor`: cancelled / rescheduled / pending pax per closure, for the calendar.

**Not read by:** booking create or edit, seat counting (`getAllotment`), the reschedule flows,
seat locks, the B2C sync. A booking can be made, moved onto, or synced onto a weather-closed day;
it is only tagged when someone opens the panel.

### 5. Permissions

- The closure list saves only with the `operations` edit area (`sbWeatherPersist` returns quietly
  otherwise: the dialog closes and the closure is lost on reload). Undo checks it up front.
- Booking changes (tags, notify, resolve) save with `operations` **or** `accounting`
  (`acctCanEditBookings`); otherwise they are silently not saved.
- No role or approval: anyone with the area can close a trip or cancel a paid booking.

## How legacy stores it

- **`sb_weather`** (blob key `sb_weather`, table `operation_schemas.sb_weather`): `id` (made up by
  `os_repo`, e.g. `sb_weather:mr68yggq5yc`; the browser object has none), `routeid`, `date`
  (text `YYYY-MM-DD`), `reason` (always `weather`), `at` (ISO text), `note` (text or null).
  Whole-list save: the list is the blob array.
- **`bk.weatherResolve`** → `sb_bookings.weatherresolve_event` (`"<routeId>|<date>"`),
  `_status` (`awaiting`/`notified`/`resolved`), `_notifiedat`, `_outcome`
  (`reschedule`/`refund`/`credit`/`cancel`), `_resolvedat`, `_newdate`. One per booking.
- **`bk.rebook`** → `rebook_from`, `rebook_to`, `rebook_reason` (`weather` or `manual`), `rebook_at`.
  The manual reschedule (`bkV2RescheduleBooking`) writes it too, beside its fuller `bk.reschedule`.
- **`bk.refund`** (`{amount, status:'due'}`) has **no column** in `field_mapping.json`: it is lost
  on every save.
- **Deposits** (`SB_DEPOSITS`, the credit outcome) are not in the mapping either: never saved
  (already noted in `money-model.md` open 5).
- Status `cancelled_weather`, `cancelreason`, `cancelledat`: ordinary booking columns.

## Data (2026-10-09)

- **5 closures**, all `reason: weather`, on 2 routes: `r10` Phi Phi Bamboo by Speedboat
  (2026-06-04, 07-01, 07-02, 07-03) and `r12` Whale Shark Phi Phi Maiton Sunset (2026-07-02).
  One per route+date. Notes: `null`, `''`, `cancelled`, `Cancelled`, `cancelled`.
- **40 bookings carry `weatherResolve`** (5,363 bookings in all): 13 / 15 / 9 / 2 / 1 per closure.
  - `resolved` + `cancel`: 24, all `cancelled_weather` with `cancelreason = 'weather'`. These are
    the only 24 `cancelled_weather` bookings in legacy.
  - `resolved` + `reschedule`: 13 (9 still `confirmed`, 4 later `cancelled` by the normal flow).
    All 13 have `rebook_reason = 'weather'`. (`rebook` overall: 13 weather, 87 manual.)
  - `refund`: 0. `credit`: 0. No refund payment exists in `sb_payments`.
  - `awaiting`: 3, all on `r10|2026-07-02`, a date now past (see oddities).
  - None of the 24 weather cancels still has an invoice.
- Booking history lines of kind `weather`: Weather 34, Notify 30, Cancel 22, Reschedule 7,
  `ยกเลิก` 3, no tag 9.
- Time from notify to resolve, over the 37 resolved cases:
  - under 1 minute: 23;
  - 1–10 minutes: 2;
  - 10–60 minutes: 12.
  
  Staff mostly tick "notified" after the agent has already answered.

## Already here

- `POST /v1/bookings/{id}/cancel-weather` (README "After create: commands"): one booking →
  `cancelled_weather`, `cancellation_reason: weather`, seats given back, optional note, history
  `Cancelled for weather · <note>`. "Refunds and credits stay in legacy until money moves here."
  `/restore` undoes it (capacity checked).
- `POST /v1/bookings/{id}/reschedule` (README "Booking actions"): the manual flow, with capacity,
  closed-day, overnight and lock-draw rules, and a `reschedules` record. Legacy's weather reschedule
  has none of these checks (see oddities).
- The import turns a legacy `rebook` with no `reschedule` beside it (the weather move) into a
  reschedule row with charge `none` (`src/tools/legacy-records.ts`, `rescheduleRow`).
  `weatherResolve` and `sb_weather` are not imported.
- Closed days (README "Closed days"): `route_closed` refuses sales on a day the route's calendar
  closes, with `close_anyway` for closing a day that holds bookings. A weather closure is not part
  of that calendar.
- The change feed has no `weather` kind; a closure would be a new kind or a `route` change.
- Money: invoices, payments and void exist (README "Invoices and payments"); deposits and refunds
  do not (`money-model.md` open 5).
- Proposed paths in `legacy-replacement.md` §3: `GET/POST/DELETE /v1/weather-closures`.
- `docs/handoff/legacy-integration-booking-api.md` §7: the integration branch keeps
  `weatherResolve`, `rebook` and `refund` in its local copy (`mergeInto`).

## Bugs or oddities in legacy

1. **A closure refuses nothing.** Bookings can be created, moved, or B2C-synced onto a closed
   trip (`BK-26070001-80WQ` was created on 2026-07-01 for r10 2026-07-02, after that day was
   closed). They are tagged only when someone opens the panel.
2. **The weather reschedule checks nothing**: no seat check on the new day, no closed-day or
   another-weather-closure check, it does not return seat-lock draws (the manual reschedule does,
   with a comment that skipping it makes "ghost seats"), and writes no `reschedule` record.
3. **Stale tags.** Three bookings are still `awaiting` for r10 2026-07-02, a past date; two of them
   were later moved to 07-04 (one by the manual reschedule, `rebook_reason: manual`), which does not
   clear the tag. The dashboard counts them as weather work forever.
4. **One tag per booking.** A booking already tagged for one closure that is caught by another is
   re-tagged and loses the first (status back to `awaiting`). A multi-day booking can only follow
   one closure.
5. **Charters are skipped** entirely: a chartered boat on a closed route/date is not tagged and has
   no follow-up.
6. **Void hits the whole invoice.** `refund`, `credit` and `cancel` void the booking's invoice,
   which may also carry other bookings; each of those goes back to `unpaid`.
7. **The refund is lost.** The negative payment goes onto an invoice that is voided in the next
   line, and `bk.refund` and deposits have no column: after a reload, a refund or credit leaves
   only a history line. (Never used in production: 0 refunds, 0 credits.)
8. **`cancel` keeps paid money silently**: a paid booking cancelled with "No refund" voids its
   invoice; the payment record stays on a void invoice.
9. **Save failures are silent** without the `operations` area: the dialog closes and the closure
   disappears on reload.
10. **Notify sends nothing**: it is a manual check mark.

## Questions for the developer

1. **Should a weather closure refuse new sales on that trip?** Legacy only shows it. *Recommend:
   yes, `409 route_closed`-style with a weather message, for creates, moves and reschedules onto
   it, B2C included (it is a same-morning call, so LK should not sell it). This changes legacy
   behaviour: say so in the design.*
2. **Is a closure its own record or a calendar day override?** *Recommend: its own record
   (`weather_closures`: route, date, note, by, at), unique per route+date, read by the same
   pure "does it run" function the calendar uses, so both stores agree.* A closed calendar day and
   a weather closure mean different things (planned vs same-day) and undo differently.
3. **Where does the follow-up state live?** *Recommend: a row per booking per closure
   (`weather_cases`: closure, booking, status awaiting/notified/resolved, outcome, new date,
   timestamps, by), not one field on the booking, so a booking can follow two closures and undo is
   exact.*
4. **Tag at close time only, or also later?** *Recommend: computed. The cases are the bookings on
   the closed trip; a booking sold onto it anyway (if Q1 allows) appears on read. No "open the panel
   to tag".*
5. **Should resolve reuse the existing commands?** *Recommend: yes. Resolve `reschedule` = the
   `/reschedule` command (capacity, lock draws, closed-day checks, a reschedule record with
   reason `weather`, charge none); resolve `cancel` = `/cancel-weather`. The weather case only
   records the outcome. This adds checks legacy lacks (a full new day is refused).*
6. **Refund and credit:** legacy's are broken and unused (0 of 40). *Recommend: leave them out
   of the first slice (outcome `reschedule` or `cancel` only) until deposits and refunds are
   designed in `money-model.md`; then add them as money commands.*
7. **Charters:** include them in the follow-up? *Recommend: yes, they are on the closed trip too;
   ask ops whether a charter can sail on a weather-closed day.*
8. **Undo:** legacy keeps resolved bookings as they are. *Recommend: copy that; undo deletes the
   closure and the unresolved cases, and is refused or warned when resolved ones exist
   (`close_anyway`-style `confirm`).*
9. **Stale legacy tags** (3 `awaiting` on a past date): import them as is, or drop them?
   *Recommend: import closures and cases; mark the 3 as resolved only if the developer says so.*
10. **Permission:** *Recommend: `operations` edit area for close/undo/notify/resolve, as legacy;
    refund and credit later under `accounting`.*
11. **Past dates:** legacy hides the button for past dates. *Recommend: refuse closing a past
    date (`400`).*
