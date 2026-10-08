# Booking authority, modelled

The first area of `todo/authority-revision.md`. Today `POST` and `PATCH /v1/bookings` take the whole
booking document, including the values the server should decide: `status`, who confirmed it and
when, who created it. This note moves those to the server, in two phases.

- **Legacy read:** `wt-lk-inbox@658298d`, `allotment_v2/js/08-app.js`: `bkV2SubmitBooking`,
  `bkV2CommitBooking`, `bkV2ApproveBooking`, `bkV2RejectBooking`, `bkV2FocApprove`,
  `bkV2FocReject`, `bkV2WeatherResolveOne`, the edit guard in `bkV2EditBooking`.
- **Client affected:** the legacy integration branch (`LOVE_Andaman_Workspace`
  `integration/operation-backend`, `allotment_v2/js/ops/40-ops-bookings.js`). Its save (`toServer`)
  sends every field on `POST` and `PATCH`, and approve / reject / FOC approve / FOC reject / weather
  cancel are each a `PATCH {status}`. Love Kingdom sends `status` and `total` on create.
- **Already here:** the commands `/cancel`, `/restore`, `/partial-cancel`, `/reschedule`;
  `assertOpen` / `assertRestorable` (`booking-actions.ts`); `updated_by` taken from the token.

## What legacy does (the rules to copy)

| Action | Legacy rule |
|---|---|
| Save, "quote" button | status `quote` |
| Save, "confirm" button | FOC passengers → `pending_foc` (an FOC reason is required); over the company's allotment but within the boat's licence → `pending_approval` (the user is asked first); a discount → `pending_approval` (the agent's salesperson approves); otherwise `confirmed`. Over the licence, or taking another agent's locked seats: refused. The same buttons save an edit, so an edit can change the status. |
| Edit | refused for `cancelled`, `completed`, `rejected`, `cancelled_weather` |
| Approve (`pending_approval`) | → the approval's target status, normally `confirmed`; stamps who confirmed if it was never confirmed; history line. Allowed even over the boat's licence, with a warning. |
| Reject (`pending_approval`) | → `rejected`, optional note, history line |
| FOC approve (`pending_foc`) | needs the FOC reason; → `confirmed` |
| FOC reject (`pending_foc`) | → `rejected`, optional reason |
| Weather cancel (a trip on a weather-closed day) | → `cancelled_weather`, reason `weather`; then refund, credit or void the invoice (money is not in this service yet) |
| `completed` | **never set by legacy**; only filtered on |

## Fields and their authority

| Field | Today | Should be | Phase |
|---|---|---|---|
| `status` | any of 10 via `POST`/`PATCH` | **validated**, changed only by commands | 1 (`PATCH`), 2 (`POST`) |
| `confirmed_by`, `confirmed_at` | taken from the body | **computed**: stamped by `confirm` / `approve` from the token | 1 |
| `created_by` | the body, else the token | **computed** from the token (see question 2) | 1 |
| `booked_at` | taken from the body | **computed**: server time on create; the importer keeps legacy's | 1 |
| `updated_by` | from the token | computed | done |
| a closed booking's fields | editable | **validated**: `PATCH` on a closed booking is `409`, as legacy | 1 |
| starting status on create | the body's `status` | **computed** from intent (`quote` / `confirm`) and the facts (FOC, over allotment, discount), as legacy's save | 2 |
| over allotment, within licence | `409` | **`pending_approval`**, as legacy | 2 |
| FOC reason, approval record (who, why, note) | not stored | client fact / computed, in new columns and a table | 2 |
| `total`, `price_*` | the body | computed by the quote | later (pricing) |

## Phase 1 (this change): `PATCH` stops deciding, commands take over

**`PATCH /v1/bookings/{id}`**

- Server-owned fields: `status`, `confirmed_by`/`confirmedBy`, `confirmed_at`/`confirmedAt`,
  `created_by`/`createdBy`, `booked_at`/`bookedAt`.
- **Transition rule:** a server-owned field whose value equals the stored one is accepted and
  ignored, so a client that sends the whole booking back keeps working. A **different** value is
  `400`, naming the command to use:
  `status cannot be changed with PATCH: use POST /v1/bookings/{id}/confirm, /approve, /reject, /cancel or /cancel-weather`.
- `PATCH` on a `cancelled`, `completed`, `rejected` or `cancelled_weather` booking is `409`
  (`booking_closed`), as legacy's edit guard.

**New commands.** Each stamps `updated_by` from the token and writes one history line, in the same
transaction as the change. A wrong starting status is `409` naming the current status.

| Command | From | To | Notes |
|---|---|---|---|
| `POST /v1/bookings/{id}/confirm` | `draft`, `quote`, `pending` | `confirmed`, or `pending_foc` when a trip carries FOC passengers | capacity checked, as a status change into holding is today; stamps `confirmed_by`/`confirmed_at` when it confirms |
| `POST /v1/bookings/{id}/approve` | `pending_approval`, `pending_foc` | `confirmed` | body `{ note? }`; stamps `confirmed_by`/`confirmed_at` if never confirmed |
| `POST /v1/bookings/{id}/reject` | `pending_approval`, `pending_foc` | `rejected` | body `{ note? }`; gives the seats back |
| `POST /v1/bookings/{id}/cancel-weather` | any status that holds seats | `cancelled_weather` | sets `cancellation_reason` to `weather`; refund/credit stays with legacy until money moves |

**Unchanged in phase 1:** `POST /v1/bookings` still accepts `status` and `total` (legacy and Love
Kingdom send both); `total` and prices stay client-sent until the quote exists.

**Swagger (`src/routes/openapi.ts`, `/docs`):** the four commands documented; `status`,
`confirmed_by`, `confirmed_at`, `created_by`, `booked_at`, `updated_by` marked read-only on
`PATCH` with the `400` and `409` responses; the transition rule described on `PATCH`.

**Client change, in the legacy repo** (`ops/40-ops-bookings.js`, shipped together):

- `statusPatch` for approve / reject / FOC approve / FOC reject → `POST …/approve` or `…/reject`.
- `bookingV2WeatherResolveOne`'s cancel → `POST …/cancel-weather`.
- `saveNow`: when the local status differs from the server's, `PATCH` without `status`, then call
  `…/confirm`. Its other fields can stay as they are, thanks to the transition rule.

**Tests:** for each server-owned field, a `PATCH` with a different value is `400` and one with the
same value succeeds; each command's allowed and refused starting statuses; who is stamped; the
history line; a closed booking refuses `PATCH`; both stores.

## Phase 2: the server decides the status on save

### What legacy's save does (`bkV2CommitBooking`, "Anti-overbook guard (tiered)")

For each seat trip (charters are checked elsewhere), on create and on an edit that **increases** a
trip's general-seat need, with `need` = pax less its own lock draw:

| `need` against the day | Legacy |
|---|---|
| ≤ seats available | fits |
| ≤ seats available **+ locked seats** (only locks in the way) | **hard block** (`lockViolation`) — our `409` today |
| over that, ≤ the boat's **licensed** seats free (or any land route) | **over allotment**: the user confirms, the booking is saved `pending_approval` with an approval record listing each over-full day (`over[]`, `totOver`) |
| over the licensed seats free | **hard block** (`licenseBlock`): no real seat |

Then, in order:

- a **discount** on a confirm → `pending_approval`, reason `discount` (or `over_capacity+discount`),
  approved by the agent's salesperson;
- **FOC passengers** on a confirm → `pending_foc` (an FOC reason is required to save);
- an approval record wins: the booking is `pending_approval` with `targetStatus` = what it would
  otherwise be (`confirmed`, `pending_foc` or `quote`). Approve then moves it there.
- **Seats:** an over-allotment `pending_approval` does **not** hold seats while it waits
  (`bkPendHoldsSeat`); a discount-only one does. (Legacy's own comment says the opposite; the
  function is what runs.)
- A resolved approval is kept for audit and replaced when a later save needs a new one.

### The server's version

**Contract.** `POST /v1/bookings` takes `intent`: `quote` or `confirm` (default `confirm`). The
server computes the status from it and the rules above. A `PATCH` that increases seats is
re-weighed the same way. The response says what happened (`status`, and `approval` when one is
waiting). Transition: `status` on create is accepted as an alias — `quote`/`draft` mean `quote`,
`confirmed`/`pending_foc` mean `confirm` — and any other value is `400`.

**Capacity.** A new pure function, next to `assertDayFits`, classifies a day's demand as *fits*,
*locks in the way* (`409`), *over allotment* (approval), or *over licence* (`409`). It reads the
numbers `dayCapacity` already has: available seats, locked seats, and the licensed seats left.

**Schema (migration 023):**

```sql
-- The reason legacy requires before FOC (free) passengers can be confirmed. A client fact.
ALTER TABLE bookings ADD COLUMN foc_reason TEXT;

-- Each approval a booking waited for, and how it was decided. Legacy kept one (`approval`) and a
-- second for FOC (`focApproval`) on the booking document, overwriting earlier ones; here each is a row.
CREATE TABLE booking_approvals (
  id            BIGSERIAL PRIMARY KEY,
  booking_id    TEXT NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('approval', 'foc')),
  status        TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  over_capacity BOOLEAN NOT NULL,          -- over the allotment: the booking holds no seats while pending
  over_total    INTEGER CHECK (over_total >= 0),
  discount      NUMERIC(12,2) CHECK (discount >= 0),
  foc_count     INTEGER CHECK (foc_count >= 0),
  target_status TEXT NOT NULL,             -- where approve moves it
  requested_by  TEXT, requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by    TEXT, decided_at TIMESTAMPTZ, note TEXT
);
CREATE INDEX booking_approvals_booking ON booking_approvals (booking_id, requested_at, id);

-- The days an over-allotment approval is about (legacy `approval.over[]`), as they were when asked.
CREATE TABLE booking_approval_days (
  approval_id   BIGINT NOT NULL REFERENCES booking_approvals (id) ON DELETE CASCADE,
  route_id      TEXT NOT NULL,
  service_date  DATE NOT NULL,
  need          INTEGER NOT NULL,
  over_by       INTEGER NOT NULL CHECK (over_by > 0),
  PRIMARY KEY (approval_id, route_id, service_date)
);
```

Additive, no backfill. The seven legacy `pending_approval` bookings have no approval record, which
legacy reads as "holds its seats" — so do we.

**Seat holding.** `holdsSeats` gains the approval: a `pending_approval` booking whose current
approval is `over_capacity` holds nothing. Both stores pass it through the same pure function;
PostgreSQL's capacity query excludes those bookings with the same predicate, tested on both stores.

**Commands.** `approve` moves to the approval's `target_status` and claims the seats when the
approval was over allotment (see question 1). `reject` closes the approval. `/confirm` runs the
same weighing as a create with intent `confirm`.

**Clients, on both sides together:** Love Kingdom sends `intent` (or keeps `status: "confirmed"`,
the alias); legacy's integration stops computing `pending_*` itself and shows what the server
answered.

**Not here:** the discount rule reads `price_discount` as sent, until the quote computes it; the
importer maps legacy's `approval` / `focApproval` records in a later change.

### Questions for phase 2

1. **Approving over the licence.** Legacy lets a manager approve a booking even when the boat has
   no registered seat left ("approve, but add a boat before the travel date"). That sells a seat
   that does not physically exist. Copy it, or refuse with `409` until a boat is added?
   Recommended: refuse — the licence is the legal passenger ceiling (`CLAUDE.md`, "Capacity").
2. **`status` on create:** accept `quote`/`draft`/`confirmed`/`pending_foc` as aliases for `intent`
   while clients move, as above? Recording a booking straight into `cancelled` would then be refused.

## Decisions — 2026-10-07

1. **The approver is the logged-in user.** Legacy's typed name (and FOC's hard-coded `'RM'`) is a
   bug, not copied.
2. **`created_by` is the logged-in user, always,** on create too: a body naming anyone else is `400`.
3. **Both phases, together.** Phase 1 is built; phase 2's schema needs its own approval first
   (`CLAUDE.md`), below.

## Phase 1 — shipped 2026-10-07

As designed above, with: `createHeader` (create stamps `created_by`, `booked_at`, and
`confirmed_by`/`confirmed_at` when created confirmed; refuses them in the body), `stripServerOwned`
(the `PATCH` transition rule), `assertEditable`, `planStatusCommand` in `booking-actions.ts`;
`changeBookingStatus` in both stores; the four routes; Swagger (`docs.statusCommand`,
`bookingPatchIn`, the read-only fields); README. Tests: `test/booking-commands.test.ts`, plus the
four older tests that pinned the old behaviour. 179 / 179 on PostgreSQL.

Changed from the design: `PATCH` also refuses `booked_at`, and a create refuses `booked_at`,
`confirmed_by` and `confirmed_at` (the server sets them).

Legacy client changes still owed (`ops/40-ops-bookings.js`): `toServer` must stop sending
`createdBy`, `bookedAt`, `confirmedBy`, `confirmedAt` on `POST`; `statusPatch` → `/approve` /
`/reject`; weather → `/cancel-weather`; a save that changes the status → `PATCH` then `/confirm`.

## Phase 2 — shipped 2026-10-07

Decided: question 1, **approve over the licence like legacy**, with `warnings` (`over_licence`,
per day) instead of a refusal. Question 2, **the alias, documented and logged**: nothing is live
(`CLAUDE.md`), so the alias is a convenience for the two clients, not a production safeguard.

Built as designed, in:

- `booking-approvals.ts` (pure, both stores): `decideStatus` (the save), `reweigh` (an edit),
  `bookingHoldsSeats` (an over-allotment wait holds nothing), `parseIntent` (the alias),
  `decidedRecord`, `licenceWarnings` (in `operations.ts`).
- `capacity.ts`: `weighDay` (the four tiers), `licenceShortfall`, `licensed_free` on `DayState`.
- `booking-actions.ts`: `createHeader` no longer stamps the confirmation (the store does, once it
  has decided); `planStatusCommand` returns the approval to decide or ask for.
- Both stores: create, amend and the status commands; PostgreSQL counts seats with the same rule in
  SQL (`WAITING_FOR_SEATS`) and reads `approvals` in `BOOKING_SELECT`.
- Migration 023, Swagger, README "How the status is decided", `docs/love-kingdom-integration.md`.
- Tests: `test/booking-approvals.test.ts` (8), the older tests moved off creating in a status.
  187 / 187 on PostgreSQL; 181 + 6 PostgreSQL-only skipped in-process.

Changed from the design:

- `booking_approvals.status` gains **`replaced`**: an edit that asks again closes the pending
  request rather than deleting it, so the audit keeps every request.
- **The discount is weighed on create and `/confirm` only**, not on every edit. Legacy re-asks on
  every "Confirm" save of a discounted booking; here an edit carries the waiting discount over.
- **`/confirm` does not re-weigh the allotment**: a `draft`/`quote`/`pending` booking already holds
  its seats.
- **No booking is created in a released status** (`cancelled`, `rejected`, …) any more: it is
  created, then cancelled. The importer writes legacy's statuses directly and is unaffected.
- `claimsSeats` and `pendingApprovalHoldsSeats` are gone: status no longer changes through `PATCH`,
  and the seat rule is `bookingHoldsSeats`.
- `/restore` and `/reschedule` with `from_date`/`to_date` still refuse over the allotment
  (`assertTrips`), as before: legacy's tiered guard is the save's, and neither is a save. (The older
  reschedule body goes through `PATCH`, so it is weighed like an edit.)

Legacy client changes owed (`wt-operation-backend-integration`, `allotment_v2/js/ops/40-ops-bookings.js`),
on top of phase 1's:

- **Create** sends `status: bk.status || 'confirmed'` (`toServer`). Legacy computes `pending_approval`
  and `pending_foc` itself, and those are now `400`. Send `intent` instead (`quote`/`draft` →
  `quote`, else `confirm`), and take `status` and `approvals` from the response.
- **Send `focReason`.** Legacy requires one before confirming FOC passengers (`08-app.js`), but the
  integration does not send it: a confirm with FOC passengers is now `400`.
- **Stop deciding the status in the browser** after a save: show the server's answer, including a
  `pending_approval` that holds no seats.
- The approval note and `approval`/`focApproval` it keeps locally (`keep`) can come from
  `approvals` instead.

## Checked against the integration client — 2026-10-08

`wt-operation-backend-integration` (`integration/operation-backend`, `50c41ae`): **none of the client
changes above are made.** Its ops layer last changed in `af03e95` (2026-10-05), before both phases.
Today every create is `400`: legacy always sets `bookedAt` (`booking/bookingV2CommitBooking.js:491`),
`toServer` sends it (`ops/40-ops-bookings.js:36,65`), and `createHeader` refuses it. Approve,
reject, FOC and weather cancel `PATCH {status}` and are `400` too. Cancel, restore,
partial cancel and reschedule already use the commands and work.

Corrections to this note:

- **`pending_foc` on create is not `400`.** It is accepted as an alias for `confirm` (decision 2),
  then refused because the client sends no `focReason`. Only `pending_approval` is refused.
- **"Its other fields can stay as they are" (phase 1) holds only after a merge.** After a create,
  `upsert` skips the merge because `updatedAt` already matches (`ops/40-ops-bookings.js:210`), so
  the local `bookedAt`, `createdBy` and `confirmed*` stay the browser's own. An edit before the next
  refresh sends values that differ from the stored ones and is `400`. The client must merge the
  create's response.

More client changes owed, found in the same check:

- **Create must not send `bookedAt`, `confirmedBy`, `confirmedAt`,** nor a `createdBy` other than
  the login (`bookingV2CommitBooking.js:276,491,495-501`). This blocks every create today.
- **Keep `adjustments` locally.** `fromServer` sets `adjustments: []` and `mergeInto` does not keep
  it (`ops/40-ops-bookings.js:158,190-191`), so a refresh erases discounts in the browser and the
  next edit re-prices without them.
- **Show `over_licence` warnings on their own.** The `tx` wrapper renders every warning as a
  seat-lock shortfall (`lock_id`/`got`/`wanted`, `ops/40-ops-bookings.js:289-291`), printing
  "undefined/undefined".
- **Seats held by `pending_approval`.** A booking loaded from the server has no local `approval`,
  so `bkPendHoldsSeat` counts its seats; the server does not (`bookingHoldsSeats`).

**Client changes made — 2026-10-08** (`wt-operation-backend-integration` `39ff405`): create sends
`intent` and none of the server-stamped fields, `focReason` goes with the booking, the browser takes
the server's status and stamps after every save, an edit is a `PATCH` without `status` followed by
`/confirm` for Submit on a quote, approve/reject/FOC use `/approve` and `/reject`, weather uses
`/cancel-weather`, adjustments survive a refresh, and `over_licence` warnings have their own toast.
Checked against the local stack, 12 of 12 scenarios. Still open on the client: showing the server's
`approvals` instead of the locally kept `approval`/`focApproval`, and a `pending_approval` loaded
from the server still counted as holding seats by `bkPendHoldsSeat`.
