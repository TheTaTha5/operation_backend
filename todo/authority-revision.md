# Moving authority to the server

The plan for bringing what exists in line with `CLAUDE.md` (2026-10-07): the server decides, clients
display. Each area below lists what the browser still decides today, the kind each value should be
(computed / validated / client fact), and what changes. Every item that adds a rule, a migration or
a contract change gets its own design note in `todo/` and an approval before code.

Order follows the cutover decision: **bookings first**.

## 0. Housekeeping (docs only, no approval needed)

- `README.md` ("Authentik OIDC authentication", "Temporary password login") and
  `todo/frontend-authentication.md` still describe Authentik as the login. Login now moves here.
- `docs/booking-columns.md` describes a `booking_trip_meal_requirements` table that never shipped
  and says special meals are not columns (they are), and lacks the trip columns from 014–015.
- `docs/schema.md` / `docs/schema.html` (uncommitted) stop at migration 021: no rate type tables.
- `todo/legacy-replacement.md` lists data only. It needs a second checklist: each business rule in
  legacy's `allotment_v2/js` (wt-lk-inbox), and the endpoint that will own it.

## 1. Bookings (first area)

| Value | Today | Should be | Change |
|---|---|---|---|
| `status` | any of 10 via `PATCH` | **validated** | a state machine copied from legacy; changes only through commands (`confirm`, `approve`, `reject`, `complete`, `cancel-weather`, next to `cancel`, `restore`); `PATCH {status}` → 400 |
| `confirmed_by`, `confirmed_at` | taken from the body | **computed** | stamped by `confirm` from the token |
| `cancellation_reason` | settable by `PATCH` | **computed** | written by `/cancel` only |
| `created_by` | token, or the body if sent | decide | keep the "entered on someone's behalf" case, or always the token |
| `booked_at` | taken from the body | **computed** | server time on create; the import keeps legacy's |
| `pending_approval` | never set by the server; over capacity is always 409 | **validated** | copy legacy's approval flow: when an over-capacity request becomes `pending_approval`, and who approves |
| a closed day | bookable | **validated** | the calendar checked on create, amend, reschedule, restore (legacy's rule for closed days to be read first) |
| `total`, `price_*`, `manual_total` | taken from the body | **computed** | temporary exception until `POST /v1/quote` (area 5) |
| add-on `amount`, `label` | taken from the body | **computed** | priced by the quote; `type` and `qty` stay client facts |
| `adjustments[]` (discounts, extras) | dropped on save | **validated** | a table, plus who may give a discount |
| trips, pax, passengers, hotel, notes… | client facts | **client fact** | unchanged; trips stay capacity-checked |

Safety nets for the same area:

- **Edit conflicts:** a version on every booking read; `PATCH` and commands send it back
  (`If-Match`); a stale one is 409 instead of last-save-wins.
- **Retries:** a duplicate `external_id` answers 409 (or the existing booking) instead of 500, and
  the in-process store stops creating a second booking; an `Idempotency-Key` on create,
  partial cancel and lock create.
- **Love Kingdom:** `POST /v1/bookings` with `status: "confirmed"` and `total` is in their
  contract. Changes ship on both sides together (`docs/love-kingdom-integration.md`).

## 2. Login and permissions

Needed early: commands like `approve` need "who may".

- Import legacy's users (scrypt `salt:hash` hashes verify as they are); `/v1/login` becomes the
  real login, not "testing only".
- Per-area edit rights (legacy `editAreas`) checked by the server on every write; today only
  `booking:*` / `operations:*` exist and legacy checks areas in the browser.
- `GET /v1/me`: who the caller is and what they may do, so a client can hide what it can't use.

## 3. Catalogue and calendar

- Season and day-override endpoints. Panwa's calendar (r7–r11) ends 2026-12-31.
- Land routes (43 of 58) cannot be booked: they have no boats, so every booking is 409. A rule for
  their capacity is needed (legacy's to be read).

## 4. Deployments

| Value | Today | Should be |
|---|---|---|
| shrinking a boat below seats sold | allowed | **validated**: refused |
| moving a boat to another route with seats sold | allowed | **validated**: refused |
| deleting a deployment with seats sold | allowed | **validated**: refused |
| `license_pax` | the body may override the boat's | **computed** from the boat catalogue |

## 5. Sales and pricing

Rate types exist (catalogue, import). Still to come, in order:

1. Agent rate seasons. Today they live only in browsers' `localStorage`; someone must export them.
2. Promo contracts.
3. `POST /v1/quote`, then bookings priced by the server: the end of the price exception in area 1.
   Characterization test: re-price real legacy bookings and expect their `priceBreakdown`.
4. Agent writes, add-on types, clone and agent binding for rate types.

## 6. Later areas

Money (invoices, payments, reports), day-of-operations (vans, pickups, check-in: tables exist, no
API), fleet maintenance. Each designed authority-first when it comes.
