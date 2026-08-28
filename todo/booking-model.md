# The booking, de-blobbed

`bookings.booking_data JSONB` currently holds the frontend's whole document. That was the right
holding position while we were guessing; it is the wrong resting place. Nothing in a blob can be
constrained, joined, or migrated, so every consumer re-parses it and every rule is enforced in
application code or not at all.

This is the normalized target. It is derived from what the frontend *constructs on save*
(`allotment_v2.html:78328`), not from the legacy schema — their `sb_bookings` is ~130 columns of
wide-column and positional-shred damage and is not a model worth porting.

## The shape being normalized

The document is ~55 header fields and ~24 per-trip fields. Six of those are repeating groups
(`trips`, `passengers`, `addOns`, `adjustments`, `altPickups`, `attachments`), three are fixed-size
snapshots (`priceBreakdown`, `paymentSnapshot`, `marketSnapshot`), two are approval records
(`approval`, `focApproval`), one is a dispatch record (`trip.ops`), and the rest are scalars.

## The rule

**A repeating group becomes a table. A fixed-size struct becomes columns. Nothing stays JSONB.**

Fixed-size means the frontend writes exactly these keys and adding one is a schema change either
way — `guides {english, russian, chinese, otherLang}` is four booleans-and-a-string, not a
collection, so it is four columns. `passengers[]` is unbounded, so it is a table.

## Tables

### `bookings` — the sale header

Scalars only. Everything the frontend writes flat, stays flat.

| group | columns |
|---|---|
| identity | `id`, `external_id`, `schema_ver`, `voucher_ref` |
| commercial | `agent_id`, `rate_type_ref`, `sold_by`, `purpose`, `staff_id`, `staff_purpose` |
| lead | `lead_pax`, `lead_nationality`, `lead_type`, `lead_foc`, `lead_phone`, `lead_email` |
| pickup | `pickup_area_id`, `pickup_self`, `pickup_area`, `pickup_zone`, `hotel_name`, `room_number` |
| dropoff | `dropoff_same`, `dropoff_area_id`, `dropoff_area`, `dropoff_hotel_name` |
| guides | `guide_english`, `guide_russian`, `guide_chinese`, `guide_other_lang` |
| service | `pax_type`, `special_meals_veg`, `special_meals_vegan`, `special_meals_halal`, `special_meals_allergies`, `large_luggage` |
| cash on tour | `cash_on_tour_amount`, `cash_on_tour_currency`, `cash_on_tour_handling`, `cash_on_tour_note` |
| price | `price_mode`, `manual_total`, `total`, `price_seat`, `price_addon`, `price_foc_discount`, `price_discount`, `price_extra` |
| payment snapshot | `payment_method`, `payment_net_days`, `payment_source`, `payment_contract_version` |
| market snapshot | `market`, `market_sub`, `market_agent_id`, `market_at` |
| lifecycle | `status`, `booking_date`, `booked_at`, `created_at`, `created_by`, `updated_at`, `updated_by`, `confirmed_at`, `confirmed_by`, `cancellation_reason` |
| free text | `notes`, `note` |

`status` is a real enum:
`draft, quote, pending, pending_approval, pending_foc, confirmed, rejected, cancelled, cancelled_weather, completed`.
We currently accept two of these. Anything not in `(confirmed, pending_approval, pending_foc)`
holds no seats — that predicate belongs in one pure function both stores call, per the calendar
pattern, not repeated at every call site.

`pickup_area`/`pickup_zone`/`dropoff_area` are denormalized *by the frontend* for display. Keep
them denormalized here too, but as columns: they are a snapshot of what the area was called when
the booking was taken, and renaming an area must not silently rewrite history.

### `booking_trips` — one row per departure

**This is the capacity table.** Every allotment, availability, and manifest query reads this and
nothing else.

```
id, booking_id → bookings, route_id → routes, service_date DATE,
zone, pickup_time, booking_mode ('seat'|'charter'),
charter_boat_id → boats, charter_price_mode, charter_price_manual,
charter_price_note, charter_displacement_ack,
ovn, ovn_return_date, ovn_charge, ovn_leg, ovn_of,
seats_locked, seats_general, subtotal, seq
UNIQUE (booking_id, seq)
INDEX (route_id, service_date)
```

`seats_locked + seats_general` must equal the trip's total pax — a CHECK we cannot write today
because the numbers live in a blob.

This table is what removes the one-trip-per-booking restriction, which `bookingInput()` used to
enforce outright. Measured against the legacy database on 2026-08-28: that restriction blocks
**3 bookings out of 3,180**, and all three are the same thing — an overnight trip, outbound plus
return leg. An earlier draft of this note claimed 18,648, which was wrong and came from a count of
something else entirely. The reason to remove the restriction is that the shape is wrong, not that
thousands of rows are waiting behind it.

### `booking_trip_pax` — the 4×3 grid

```
booking_trip_id → booking_trips, category ('ad'|'chd'|'inf'|'foc'),
residency ('unknown'|'foreign'|'thai'), count INTEGER CHECK (count >= 0)
PRIMARY KEY (booking_trip_id, category, residency)
```

The frontend's keys are `ad, ad_fr, ad_th, chd, chd_fr, chd_th, …` — a category crossed with a
pricing residency, flattened into a string. Twelve nullable integer columns would reproduce the
wide-column mistake we just finished deleting from `routes`. Adding a category or a tier here is
a row, not a migration.

Trip pax total is `SUM(count)`, and it is the only definition of a trip's pax. `bookings.pax` as
a stored scalar goes away.

### `booking_passengers`

```
booking_id → bookings, seq, name, nationality, type, foc BOOLEAN
```

### `booking_addons`

```
id, booking_id → bookings, booking_trip_id → booking_trips NULL, type, label, amount, qty, note
```

Nullable `booking_trip_id` because the document carries add-ons at both levels
(`newBk.addOns` and `trip.addOns`). One table, one shape, the level expressed by the FK.

### `booking_adjustments`

```
booking_id → bookings, seq, kind, mode ('amount'|'percent'), value, label, note
```

### `booking_alt_pickups` and `booking_alt_pickup_pax`

```
booking_alt_pickups: id, booking_id, seq, who, area_id, area, zone, place
booking_alt_pickup_pax: booking_alt_pickup_id, category, residency, count
```

Alt pickups carry their own pax grid — the frontend merges it in with `Object.assign(…, _p)`.
Two pax tables rather than one polymorphic table, because a polymorphic owner column would give
up the foreign key, and the FK is the entire point of doing this. The *shape* repeats; the
*logic* does not — one `PaxCounts` type and one summing function serve both.

### `booking_attachments`

```
id, booking_id, name, mime, size, kind, uploaded_by, uploaded_at
```

### `booking_special_meal_allergies`

```
booking_id, seq, name, qty
```

The `allergies` free-text field stays on `bookings`; `allergyList` is the structured version the
kitchen actually counts from.

### `booking_approvals`

```
id, booking_id, kind ('capacity'|'foc'), status ('pending'|'approved'|'rejected'),
reason, target_status, over_total, discount, sale_name, foc_count,
requested_by, requested_at, approved_by, approved_at, note
```

`approval` and `focApproval` are the same record with different triggers. One table with a `kind`
keeps the audit history — the current document overwrites, so a booking approved twice remembers
only the second.

### `booking_trip_lock_draws`

```
booking_trip_id → booking_trips, seat_lock_id → seat_locks, qty
PRIMARY KEY (booking_trip_id, seat_lock_id)
```

How a trip consumes an agent's held seats. This is the first real FK between a booking and
`seat_locks`; today the link is a `{lockId: qty}` map inside a blob, which is why nothing can
verify that draws sum to `seats_locked` or that a released lock has no live draws against it.

### `booking_trip_ops` — dispatch, 1:1 with a trip

```
booking_trip_id PRIMARY KEY → booking_trips,
boat_id → boats, van_id, van_return_id, van_group, van_seq,
pickup_time_final, return_same_van, alt_split_auto, upgrade,
pier_checkin, van_checkin, reconfirm_status, reconfirm_at, reconfirm_by
```

**This is a different domain wearing a booking's clothes.** It is day-of-operations dispatch —
who drives, which boat, did they show up — and it is written by the ops board, not the sales
form. It gets its own table so it can later get its own endpoints without another migration.
`van_splits` is the one genuinely open-ended piece and needs its own look before modelling.

## What this deletes

- `bookings.booking_data` — the blob
- `bookings.pax_breakdown` — superseded by `booking_trip_pax`
- `bookings.pax` / `allocated_pax` as stored scalars — derived from trips
- the one-trip-per-booking restriction in `bookingInput()`

## Build order

1. ~~`booking_trips` + `booking_trip_pax`, and move `capacity()` onto them.~~ **Done 2026-08-28,
   migration 007.** Multi-trip bookings work, an itinerary is weighed as a whole, and the pax grid
   is stored as rows. `bookings` lost `route_id`, `service_date`, `pax`, `allocated_pax` and
   `pax_breakdown`; all four of the first are now derived in `bookingView`, which both stores call.
2. `bookings` header columns, `booking_passengers`, `booking_addons`, `booking_adjustments`.
3. `booking_alt_pickups`, `booking_attachments`, `booking_special_meal_allergies`,
   `booking_approvals`, `booking_trip_lock_draws`.
4. `booking_trip_ops`, once the dispatch surface is designed rather than inferred.

Stage 1 was the one with a correctness story. The rest is mechanical now the trip table exists.

## What stage 1 turned up

- **SERIALIZABLE without a retry loop was incomplete.** Capacity is now read from `booking_trips`
  and written to the same table, so PostgreSQL raises `40001` between transactions that share no
  route or day — predicate locks are taken per page, and a small table is one page. Unretried, that
  is a 500 for the caller. `transaction()` now retries `40001` and `40P01` up to five times with a
  short jittered backoff. This was always latent; the trip table just made it reliable.
- **Locks must be taken in a fixed order.** A multi-day booking holds several pools, so two
  bookings covering the same days in opposite order would each hold what the other waits for.
  `assertTrips` sorts before locking, and locks the days an amendment is vacating as well.
- **`allocated_pax` took a bug class with it.** See `live-correctness-charter-seats.md` §1.
- **A bare pax count cannot retarget a tiered booking.** Largest-cell-first, proportional and
  cheapest-first are all inventions that cancel the wrong passengers. `retargetPax` refuses and asks
  for a grid; `partial-cancel` and `reschedule` are single-departure, untiered-only as a result.

## Still open from stage 1

- The status enum is still the two values `confirmed` and `cancelled`. `holdsSeats()` in `pax.ts`
  already knows about `pending_approval` and `pending_foc` and is the single place the rule lives,
  but the CHECK constraint and the API do not accept them yet. That lands with the header columns
  in stage 2.
- `PATCH /v1/bookings/{id}` no longer passes unrecognised fields through to storage. That was
  accidental before; the header columns in stage 2 are what should be patchable.
- The Postgres suite needs a clean database per run and is still not in CI.

## Open

- `docCheck` — the document says "verification state (set in Document Check view)" but the only
  `docCheck` object in the source is view state (`date/filter/openId`). Needs a real example
  before modelling.
- `trip.ops.van_splits` — shape unknown.
- Both stores must implement all of this identically. The in-process store has no joins, so the
  trip-total and status-holds-seats rules go in `src/domain/` pure functions first.

## Dry run against the legacy database — 2026-08-28

Read-only extract of `operation_schemas.sb_bookings` and `sb_bookings__trips` (3,180 bookings,
3,183 trips) transformed into `bookings` / `booking_trips` / `booking_trip_pax` in a throwaway
database. This is the first time the model met real data rather than rows written to agree with it.

**The model holds.** 8,740 passengers in, 8,740 out, and not one trip's total changed. Every
route-day the capacity query produces matches the figure computed independently from the legacy
columns: 311 route-days compared, 0 differing. No CHECK or foreign key was violated by real data.

Confirmations worth keeping:

- **`booking_mode` really is only `seat` and `charter`** — 3,169 and 14. The CHECK is right.
- **Every `routeid` resolves** against the catalogue seeded by migration 006. 7 distinct routes.
- **The 4×3 grid is right, and legacy is missing two of the cells.** `sb_bookings__trips` has ten
  wide pax columns and no `pax_chd` or `pax_inf` — the untiered child and infant were simply never
  needed, so the column was never added. That is the wide-column failure mode in miniature: the
  schema encodes which combinations have occurred so far.
- **The untiered tier is nearly dead.** `pax_ad` is used by 0 trips of 3,183 and `pax_foc` by 1.
  Real bookings are all `_fr`/`_th`. `residency = 'unknown'` earns its place for imports and bare
  `pax: 6` requests, not for anything the frontend writes.

### What does not fit, and what it costs

**38 bookings cannot keep their status** — 24 `cancelled_weather`, 7 `pending_approval`, 5 `quote`,
2 `rejected` — because the CHECK still allows only `confirmed` and `cancelled`. Seven of those are
`pending_approval`, which `holdsSeats()` already counts as occupying seats; collapsing them to
`cancelled` would silently release 7 bookings' worth. Collapsing `quote` to `cancelled` is storable
but wrong in the other direction. **This is the strongest argument for pulling the status enum
forward in stage 2** — it is not cosmetic, it decides whether seats are held.

**5 trips are unrepresentable** and their bookings were held back whole:

| id | problem |
| --- | --- |
| `b2c_BK-001`, `b2c_BK-002` | `date` is `Sat Jul 04` / `Fri Nov 20` |
| `b2c_BK-003` | both — bad date and no `routeid` |
| `b2c_LOV-0542142_1`, `b2c_LOV-7358225_1` | no `routeid` |

The dates are a stringified JS `Date` truncated into a text column — the exact failure the date
convention in `CLAUDE.md` exists to prevent, preserved in production data. All five are `b2c_`
prefixed and look like demo rows, but that should be confirmed before an import drops them.

### Corrections to the design

- **`ovn_of` is an index, not an id.** It holds the `idx` of the outbound trip within the same
  booking, so it maps onto `booking_trips.seq`, and a self-reference on `(booking_id, seq)` will
  enforce it. Joining it against `row_pk` finds nothing.
- **`ovn` is an enum**: `return` (3) and `self` (2). Not free text.
- **Two `ops` fields were missed** in the table sketch above: `ops_boatsplits` and `ops_piernote`.
- **Stage 1's migration is narrower than the `booking_trips` sketch in this note.** 007 created
  `id, booking_id, seq, route_id, service_date, booking_mode` only. The charter fields, the OVN
  fields, `zone`, `pickup_time`, `subtotal` and the `seats_locked`/`seats_general` split are still
  to come. Nothing reads them yet, so nothing is broken by their absence, but the sketch above
  describes the destination rather than what exists.

## Stage 1 closed out — 2026-08-28

Migration 008 adds `booking_trips_route_fk`, the foreign key the `booking_trips` sketch above
always called for and 007 did not create. The dry run had already proved all 3,183 legacy trips
resolve against the catalogue, so it went on clean.

The constraint is a backstop rather than the error path. A foreign key violation reaches the caller
as a 500 naming a constraint, which tells them nothing, so both stores check the route first and
answer `400 Unknown route: <id>` from one shared function (`assertKnownRoutes`).

**A store divergence to keep in view.** The in-process store's catalogue is empty unless seeded —
"with no database there is no catalogue to read" — so with nothing to check against it accepts any
route, while PostgreSQL always enforces. This is the one place the two stores knowingly differ. It
is not testable end to end for that reason: `assertKnownRoutes` is covered by unit tests in
`test/booking-routes.test.ts`, and the constraint itself was verified by direct SQL. If the
in-process store ever gains a default catalogue, the divergence should go with it.

Still outstanding from stage 1:

- **007 and 008 are not applied to production.** `railway.json` runs build and start only.
- **The PostgreSQL suite is not in CI** and needs a clean database per run. Every real defect this
  week came out of that run — the `40001` retry gap and, before it, the seat-lock date mapper.
