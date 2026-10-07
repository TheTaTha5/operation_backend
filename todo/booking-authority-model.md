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

## Phase 2 (next): the server decides the status on save

- `POST` (and a `PATCH` that changes trips or pax) takes an **intent**, `quote` or `confirm`, instead
  of a status. The server computes the status as legacy's save does: FOC → `pending_foc`, over
  allotment within licence → `pending_approval` (no longer `409`), discount → `pending_approval`.
- New columns and a table: the FOC reason, and the approval record (reason, target status, who
  approved or rejected, when, note). `pendingApprovalHoldsSeats` then reads the real over-count.
- Love Kingdom's create contract changes on both sides.

## Questions

1. **Legacy bug? The approver's name is typed by hand** (any text), and FOC approve hard-codes
   `'RM'`. Recommended: take it from the login token, like `updated_by`.
2. **`created_by`:** today the body may name someone else ("entered on someone's behalf"), which
   legacy also allows (`d.createdBy` from the form). Keep that, or always the token?
3. **Phase split:** phase 1 now, phase 2 as its own design after?
