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

## Decided (2026-10-09)

1. **Sales onto a closed trip:** copy legacy, so nothing is refused; the closure only shows.
2–3. **Storage:** `weather_closures` (route, date, note, who, when) plus one follow-up row per booking
   per closure (awaiting → notified → resolved, outcome).
4. **Which bookings:** every booking on the closed trip, worked out on read (later sales included).
5. **Resolve** reuses `/reschedule` and `/cancel-weather`: a full new day is refused, lock seats are
   given back (legacy skipped both).
6. **Refund and credit: now**, with weather closures. This pulls part of Money forward: where a refund
   is recorded against the invoice (only this booking's share, not the whole invoice) and where an
   agent's credit balance lives and is spent (`money-model.md` open 1).
7. **Charters** are followed up too.
8. **Undo** keeps resolved bookings as they are and asks first when some exist (`undo_anyway`).
9. **The 3 stale `awaiting` cases** import as they are.
10. **Permission:** `operations` for everything, refund and credit included.
11. **Past dates:** allowed (staff may record a closure after the day).

## Design (2026-10-09, from the decisions above)

In short: a closure is a row; the follow-up list is worked out on read from the bookings on the
closed trip plus the follow-up rows; a row is written only when something happens to a booking
(notified, resolved, or imported). Resolving is the booking's own `/reschedule` or `/cancel-weather`,
which now also note the outcome on the closure. A weather cancel takes **only that booking's lines**
off its invoice; what it had paid beyond what the invoice still asks becomes a refund (owed to the
agent) or a credit (the agent's balance, spent as a payment method on a later invoice).

### Fields and who decides them

**Closure** (`weather_closures`)

| Field | Kind | Rule |
|---|---|---|
| `id` | computed | `wx_<uuid>`; imported ones `lg_<legacy id>` |
| `route_id`, `service_date` | client fact, validated | a route in the catalogue; a real `YYYY-MM-DD`; past dates allowed (decision 11); one open closure per route and date |
| `note` | client fact | free text, blank is `null` |
| `closed_by`, `closed_at` | computed | the login and the clock |
| `updated_by`, `updated_at` | computed | the last note change |
| `reopened_by`, `reopened_at` | computed | set by undo; a reopened closure is kept so its resolved rows keep a home |
| `counts`, `pax` | computed | from the follow-up list (legacy `bkV2WeatherCountsFor`) |

**Follow-up row** (`weather_cases`, one per booking per closure)

| Field | Kind | Rule |
|---|---|---|
| `status` | validated | `awaiting` → `notified` (`/notify`) → `resolved` (by `/reschedule` or `/cancel-weather`). A booking on the trip with no row reads `awaiting` |
| `notified_at/by` | computed | the notify |
| `outcome` | validated | `reschedule`, `refund`, `credit` or `cancel`: what the booking command did |
| `new_date` | computed | the reschedule's `to_date` |
| `resolved_at/by` | computed | the booking command |

**The follow-up list** (computed on every read): every booking with a trip on the closed route and
date that does not hold back its seats (`cancelled`, `rejected`, `cancelled_weather` excluded, as
legacy), charters included (decision 7), plus every booking that has a row (a resolved one that
moved away or was cancelled, or an imported stale one). Each entry: the booking's id, voucher, agent,
lead, status, mode, pax (its trip on that route, as legacy), whether it is still on the trip,
`payment_state`, `refundable` (what a refund or credit would be now: legacy's "Paid ฿x") and the
row's fields.

**Refund or credit** (`refunds`)

| Field | Kind | Rule |
|---|---|---|
| `kind` | validated | `refund` (owed back to the agent) or `credit` (kept as the agent's balance) |
| `amount` | computed | never sent (`400`); see "The money" |
| `invoice_id`, `booking_id`, `agent_id` | computed | the invoice it comes off, the booking, the invoice's agent |
| `reason` | computed | `weather` |
| `created_by`, `created_at` | computed | |

**Invoice line** gains `removed_at`, `removed_by`, `removed_reason` (computed): a line taken off by a
weather cancel. **Payment** `method` gains `credit` (validated: the agent must have the balance).

### The money (decision 6)

On `/cancel-weather`, for each live booking or prepay invoice carrying the booking's lines (fee
invoices stand: a fee for an earlier reschedule is still owed):

1. **Take the booking's share off.** If the booking is the only one with live lines on it, the
   invoice is voided (`void_reason: "weather"`), as legacy does; otherwise only the booking's lines
   are marked removed and the totals and VAT are worked out again from the lines left. The other
   bookings on it keep owing exactly what they owed. (Legacy voided the whole invoice: bug 6.)
2. **What it had paid** = the invoice's payments, less refunds and credits already taken from it,
   less what the invoice still asks after step 1, never below 0. On a one-booking invoice that is
   everything paid. On a shared invoice, payments go to the bookings that still travel first: only
   money the invoice no longer needs comes back. (Chosen here; legacy had no per-booking amount.)
3. **The outcome** (`outcome` in the body, default `cancel`):
   - `cancel` ("No refund"): nothing more; money paid stays on the invoice (legacy).
   - `refund`: a `refund` row of that amount. Paying it out is not modelled (legacy had no step
     either): the row is what is owed.
   - `credit`: a `credit` row of that amount on the invoice's agent. Refused when there is nothing to
     credit (`409 nothing_paid`, legacy greys the option) or the invoice has no agent (`409 no_agent`).
4. The invoice's `paid` stays what was paid; `refunded` and `credited` are new; `status` and `balance`
   use `paid − refunded − credited`.

**The agent's credit balance** = its `credit` rows − its live payments with `method: credit`. It is
read on `GET /v1/agents/{id}` as `credit_balance: { credited, used, available }` and listed with
`GET /v1/refunds?agent_id=&kind=credit`. **Spending it** is a payment: `POST /v1/invoices/{id}/payments`
with `method: "credit"` (`409 credit_short` above the balance; the usual overpayment rule). A credit
payment can be deleted by a correction (the balance comes back) but not edited (`409 credit_payment`).

### Migrations

`060_weather_closures.sql`:

```sql
CREATE TABLE weather_closures (
  id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL REFERENCES routes (id),
  service_date DATE NOT NULL,
  note TEXT,
  closed_by TEXT, closed_at TIMESTAMPTZ NOT NULL,
  updated_by TEXT, updated_at TIMESTAMPTZ,
  reopened_by TEXT, reopened_at TIMESTAMPTZ
);
-- One open closure per trip; a reopened one stays beside a new one.
CREATE UNIQUE INDEX weather_closures_open ON weather_closures (route_id, service_date) WHERE reopened_at IS NULL;
CREATE INDEX weather_closures_date ON weather_closures (service_date);

CREATE TABLE weather_cases (
  closure_id TEXT NOT NULL REFERENCES weather_closures (id) ON DELETE CASCADE,
  booking_id TEXT NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('awaiting', 'notified', 'resolved')),
  notified_at TIMESTAMPTZ, notified_by TEXT,
  outcome TEXT CHECK (outcome IN ('reschedule', 'refund', 'credit', 'cancel')),
  new_date DATE,
  resolved_at TIMESTAMPTZ, resolved_by TEXT,
  PRIMARY KEY (closure_id, booking_id),
  CHECK ((status = 'resolved') = (outcome IS NOT NULL)),
  CHECK (new_date IS NULL OR outcome = 'reschedule')
);
CREATE INDEX weather_cases_booking ON weather_cases (booking_id);

ALTER TABLE changes DROP CONSTRAINT changes_kind_check;
ALTER TABLE changes ADD CONSTRAINT changes_kind_check
  CHECK (kind IN ('booking', 'seat_lock', 'deployment', 'route', 'invoice', 'weather_closure'));
```

`061_refunds_and_credit.sql`:

```sql
ALTER TABLE invoice_lines ADD COLUMN removed_at TIMESTAMPTZ, ADD COLUMN removed_by TEXT, ADD COLUMN removed_reason TEXT;

CREATE TABLE refunds (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('refund', 'credit')),
  invoice_id TEXT NOT NULL REFERENCES invoices (id),
  booking_id TEXT REFERENCES bookings (id),
  agent_id TEXT REFERENCES agents (id),
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL,
  created_by TEXT, created_at TIMESTAMPTZ NOT NULL,
  CHECK (kind = 'refund' OR agent_id IS NOT NULL)
);
CREATE INDEX refunds_invoice ON refunds (invoice_id);
CREATE INDEX refunds_agent ON refunds (agent_id, kind);

ALTER TABLE payments DROP CONSTRAINT payments_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_method_check CHECK (method IN ('transfer', 'cash', 'card', 'credit'));
```

### Contract

All writes need the `operations` area (decision 10), the refund and credit included; spending a
credit is an invoice payment and needs `accounting`, as every payment does. Any login may read.

| Method + path | Does |
|---|---|
| `GET /v1/weather-closures?from=&to=&route_id=&include_reopened=true` | Closures by date, with `counts` and `pax`; open ones unless `include_reopened` |
| `GET /v1/weather-closures/{id}` | One, with `bookings`: the follow-up list |
| `POST /v1/weather-closures` | Close a trip: `{ route_id, service_date, note }` → `201` |
| `PATCH /v1/weather-closures/{id}` | The note |
| `POST /v1/weather-closures/{id}/bookings/{booking_id}/notify` | `awaiting` → `notified` |
| `POST /v1/weather-closures/{id}/undo` | Re-open the trip: `{ undo_anyway }` |
| `POST /v1/bookings/{id}/reschedule` | (existing) also resolves the booking's open rows on the day it leaves: `reschedule`, `new_date` |
| `POST /v1/bookings/{id}/cancel-weather` | (existing) `{ note, outcome }`: also the money above, and resolves every open row of the booking |
| `GET /v1/refunds?agent_id=&booking_id=&kind=&from=&to=` | Refunds and credits |
| `POST /v1/invoices/{id}/payments` | (existing) `method: "credit"` spends the agent's balance |

```jsonc
// GET /v1/weather-closures/wx_…
{ "id": "wx_…", "route_id": "r10", "service_date": "2026-07-02", "note": "high waves 3m",
  "closed_by": "ops1", "closed_at": "2026-07-01T04:57:02.238Z", "updated_by": null, "updated_at": null,
  "reopened_by": null, "reopened_at": null,
  "counts": { "awaiting": 1, "notified": 1, "resolved": 2 },
  "pax": { "pending": 6, "cancelled": 2, "rescheduled": 4, "total": 12 },
  "bookings": [
    { "booking_id": "BK-1", "voucher_ref": "V-881", "agent_id": "a01", "lead_pax": "Ann", "booking_status": "confirmed",
      "booking_mode": "seat", "pax": 4, "on_trip": true, "payment_state": "paid", "refundable": 5600,
      "status": "notified", "notified_at": "…", "notified_by": "ops1",
      "outcome": null, "new_date": null, "resolved_at": null, "resolved_by": null } ] }

// POST /v1/bookings/BK-1/cancel-weather  { "outcome": "credit", "note": "agent asked", "version": 7 }
{ "...": "the booking", "status": "cancelled_weather", "warnings": [],
  "refunds": [ { "id": "rf_…", "kind": "credit", "invoice_id": "inv_…", "booking_id": "BK-1", "agent_id": "a01",
                 "amount": 5600, "reason": "weather", "created_by": "ops1", "created_at": "…" } ] }
```

Errors (`{ statusCode, code, error, message }`):

| Status | `code` | When |
|---|---|---|
| `400` | — | bad `route_id`/`service_date`; a server field sent (`closed_by`, `amount`, …) with a value other than the stored one; bad `outcome` |
| `404` | — | unknown closure or booking |
| `404` | `not_on_closed_trip` | notify for a booking not on the list |
| `409` | `already_closed` | a second open closure for the trip; the message names it and says to use `PATCH` |
| `409` | `closure_reopened` | notify, `PATCH` or undo on a reopened closure |
| `409` | `wrong_status` | notify on a row already notified or resolved |
| `409` | `has_resolved` | undo when resolved bookings exist; the message lists them (`BK-1 · reschedule`); send `undo_anyway: true` |
| `409` | `nothing_paid`, `no_agent` | credit with nothing to credit, or no agent |
| `409` | `credit_short` | a credit payment above the agent's balance |
| `409` | `credit_payment` | editing a credit payment's amount or method (delete it instead) |

History lines (kind `weather`): close `Trip <route> · <date> cancelled due to weather` (tag
`Weather`) on every booking then on the trip; notify `Notified agent · awaiting customer decision
(reschedule/cancel)` (`Notify`); undo `Trip <route> · <date> re-opened · weather cancellation undone`
(`Weather`) on every unresolved one; cancel-weather `Cancelled for weather · No refund` /
`· Refund ฿x` / `· Kept as credit ฿x` (` · <note>`), tag `Cancel`/`Refund`/`Credit` (legacy's).

Change feed: a new kind `weather_closure` (`route_days` = its trip) for every closure write and for
a booking command that resolves one of its rows; the invoice and booking changes are recorded as
before.

### Import (`src/tools/legacy-weather.ts`, pure, with `test/legacy-weather.test.ts`)

- `sb_weather` → `weather_closures`: `lg_<id>`, `routeid`, `date`, `note` (blank → `null`),
  `closed_at = at`, `closed_by` null (legacy kept none). A route not in the catalogue or a bad date
  is skipped and listed.
- `sb_bookings.weatherresolve_*` → `weather_cases`: the closure by `event` (`<route>|<date>`), the
  booking `lg_<id>`, `status`, `notified_at`, `outcome`, `new_date`, `resolved_at` as stored; the 3
  stale `awaiting` ones as they are (decision 9). A row whose closure or booking did not import, or
  whose status/outcome does not fit, is skipped and listed.
- Replaced on every run, like the bookings: `lg_` closures (their rows cascade) go first. Refunds and
  credits on imported invoices are deleted with them (legacy has none).
