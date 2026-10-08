# The booking table, explained like a normal person would

The booking's columns as `migrations/*.sql` builds them, through 023. The migrations are the
authority: if this file disagrees with them, this file is wrong. `docs/schema.md` draws every table
and its keys. How each header column is read from a request is in `src/domain/booking-header.ts`.

Three tables hold a booking's core:

- **`bookings`** — the sale. One row. All the flat stuff.
- **`booking_trips`** — the departures. One row per day you actually sail.
- **`booking_trip_pax`** — who's on each departure, broken down by type.

Other tables hang off them; see [Other booking tables](#4-other-booking-tables).

---

## 1. `bookings` — the sale header

71 columns. Sounds like a lot, it's fine, they're grouped and most are optional.

### The bones (migrations 001–010)

| Column | Type | Null? | What it's for |
| --- | --- | --- | --- |
| `id` | `TEXT` | **NOT NULL** | Our primary key. Looks like `booking_<uuid>`. |
| `status` | `TEXT` | **NOT NULL** | One of ten values. More on this below, it matters. |
| `cancellation_reason` | `TEXT` | null ok | Why it died, if it died. |
| `created_at` | `TIMESTAMPTZ` | **NOT NULL** | Defaults to `now()`. Row birthday. |
| `updated_at` | `TIMESTAMPTZ` | **NOT NULL** | Defaults to `now()`. Last touch. |
| `external_id` | `TEXT` | null ok | *Their* booking ref, e.g. `BK-26072100-K3PQ`. Unique when present. |
| `agent_id` | `TEXT` | null ok | Who sold it (an `agents` id, no foreign key). |
| `voucher_ref` | `TEXT` | null ok | Voucher number. |
| `rate_type_ref` | `TEXT` | null ok | Which price list applied (a `rate_types` id). Free text with no foreign key, on purpose: a deleted rate must not break old bookings. |
| `booking_mode` | `TEXT` | null ok | `seat` or `charter`. Copied off the first trip for convenience. |
| `booking_data` | `JSONB` | **NOT NULL** | ☠️ The blob, default `{}`. Dying. See the warning at the bottom. |

**Heads up on the gaps.** If you run `\d bookings` you'll notice the column positions skip 2–5 and
15. That's not a bug — migration 007 dropped `route_id`, `service_date`, `pax`, `allocated_pax` and
`pax_breakdown`, and Postgres never reuses an ordinal. Those five are gone on purpose: they're all
derived from the trips now, so there's no second copy left to fall out of sync. That "second copy
drifting" thing was an actual bug that shipped, so, yeah. Gone.

Everything below is the header (migration 011, plus `foc_reason` from 023). Every header column is
nullable: a booking taken before a field existed has no value for it, and a default would invent one.

### Identity & commercial

| Column | Type | Null? | What it's for |
| --- | --- | --- | --- |
| `schema_ver` | `INTEGER` | null ok | Frontend document version. Currently `2`. |
| `sold_by` | `TEXT` | null ok | Salesperson credit override for walk-ins. |
| `purpose` | `TEXT` | null ok | `sale`, `staff_welfare`, or `staff_inspection`. |
| `staff_id` | `TEXT` | null ok | Which staff member, for the non-sale ones. |
| `staff_purpose` | `TEXT` | null ok | Why the staff booking exists. |

Why `purpose` matters: a staff inspection booking **takes real seats on a real boat** but it is not
revenue. If you count it as a sale your numbers are wrong. If you don't reserve the seat, someone
gets bumped at the pier. It has to be both, which is why it's its own column.

### The lead passenger

| Column | Type | Null? | What it's for |
| --- | --- | --- | --- |
| `lead_pax` | `TEXT` | null ok | Name on the booking. |
| `lead_nationality` | `TEXT` | null ok | e.g. `DE`. |
| `lead_type` | `TEXT` | null ok | `AD` / `CHD` / `INF`. |
| `lead_foc` | `BOOLEAN` | null ok | Is the lead riding free. |
| `lead_phone` | `TEXT` | null ok | Phone. |
| `lead_email` | `TEXT` | null ok | Email. |

### Pickup

| Column | Type | Null? | What it's for |
| --- | --- | --- | --- |
| `pickup_area_id` | `TEXT` | null ok | FK-ish pointer to the area. |
| `pickup_self` | `BOOLEAN` | null ok | They're making their own way there. |
| `pickup_area` | `TEXT` | null ok | Area **name**, copied. Yes, on purpose. |
| `pickup_zone` | `TEXT` | null ok | Zone code, e.g. `PK`. Also copied on purpose. |
| `hotel_name` | `TEXT` | null ok | Where the van collects them. |
| `room_number` | `TEXT` | null ok | Room. |

**"Why store the name AND the id, isn't that duplication?"** Normally yes, and normally that's a
smell. Here it's deliberate. `pickup_area` is a *snapshot of what that area was called on the day
the booking was taken*. If ops renames "Patong" to "Patong Beach" next year, every booking from
last year would silently rewrite itself and your historical van sheets would start lying. The
snapshot freezes history. The id still points at the live record if you want today's name.

### Dropoff

| Column | Type | Null? | What it's for |
| --- | --- | --- | --- |
| `dropoff_same` | `BOOLEAN` | null ok | Same as pickup — the common case. |
| `dropoff_area_id` | `TEXT` | null ok | Area pointer. |
| `dropoff_area` | `TEXT` | null ok | Snapshot name, same reasoning as above. |
| `dropoff_hotel_name` | `TEXT` | null ok | Where they're dropped. |

### Guides

| Column | Type | Null? | What it's for |
| --- | --- | --- | --- |
| `guide_english` | `BOOLEAN` | null ok | Needs an English guide. |
| `guide_russian` | `BOOLEAN` | null ok | Needs a Russian guide. |
| `guide_chinese` | `BOOLEAN` | null ok | Needs a Chinese guide. |
| `guide_other_lang` | `TEXT` | null ok | Anything else, free text. |

The frontend sends this as one nested object, `guides: {english, russian, chinese, otherLang}`. We
flatten it into four columns instead of storing the object. Reason: it's a **fixed-size struct**,
not a list. Adding a fifth language is a code change either way, so you may as well have columns you
can index, constrain and `GROUP BY`. Compare that with passengers, which is unbounded — that one has
to be a table.

### Service stuff

| Column | Type | Null? | What it's for |
| --- | --- | --- | --- |
| `pax_type` | `TEXT` | null ok | e.g. `FIT`, `GROUP`. |
| `special_meals_veg` | `INTEGER` | null ok | How many vegetarian meals. |
| `special_meals_vegan` | `INTEGER` | null ok | How many vegan meals. |
| `special_meals_halal` | `INTEGER` | null ok | How many halal meals. |
| `special_meals_allergies` | `TEXT` | null ok | The free-text allergy note. |
| `large_luggage` | `INTEGER` | null ok | Number of big bags (affects the van). |

The frontend sends special meals as one nested object, `specialMeals: {veg, vegan, halal,
allergies}`, flattened into these four columns the same way as `guides` above. They are per
booking, not per departure. The structured allergy list legacy keeps (`allergyList`) is a repeating
group and is not stored yet.

### Cash on tour

| Column | Type | Null? | What it's for |
| --- | --- | --- | --- |
| `cash_on_tour_amount` | `NUMERIC(12,2)` | null ok | How much cash changes hands on the day. |
| `cash_on_tour_currency` | `TEXT` | null ok | Usually `THB`. |
| `cash_on_tour_handling` | `TEXT` | null ok | e.g. `deduct`. |
| `cash_on_tour_note` | `TEXT` | null ok | Note for the guide. |

### Money

| Column | Type | Null? | What it's for |
| --- | --- | --- | --- |
| `price_mode` | `TEXT` | null ok | `rate` (calculated) or `manual` (typed in). |
| `manual_total` | `NUMERIC(12,2)` | null ok | The typed-in number, only when `price_mode='manual'`. |
| `total` | `NUMERIC(12,2)` | null ok | **The grand total.** The one that matters. |
| `price_seat` | `NUMERIC(12,2)` | null ok | Seats portion. |
| `price_addon` | `NUMERIC(12,2)` | null ok | Add-ons portion. |
| `price_foc_discount` | `NUMERIC(12,2)` | null ok | FOC discount. **Stored negative.** |
| `price_discount` | `NUMERIC(12,2)` | null ok | Other discount. **Also negative.** |
| `price_extra` | `NUMERIC(12,2)` | null ok | Extras. |

Two things here:

**`NUMERIC(12,2)`, not float.** Floats can't represent `0.1` exactly, so money in a float drifts by
cents and eventually someone's invoice is off by ฿3 and you spend a day finding out why. `NUMERIC`
is exact. Cost is it's slower and — see next point — weird in JavaScript.

**The `pg` gotcha, read this one.** The Postgres driver hands `NUMERIC` back as a **string**, not a
number. On purpose: `NUMERIC` can hold values bigger than a JS number can represent, so the driver
refuses to silently lose precision for you. Which means if you don't convert, `total` comes back as
`24800` from the in-process store and `"24800.00"` from Postgres — *same API, two different types*.
We convert it in the row mapper and there's a test asserting `typeof total === 'number'`. Don't
remove that test, it's the only thing standing between you and that bug.

The breakdown columns exist so an old booking can always explain its own total. If prices change
next season, you can still see exactly how last season's ฿24,800 was reached.

### Payment snapshot

| Column | Type | Null? | What it's for |
| --- | --- | --- | --- |
| `payment_method` | `TEXT` | null ok | `credit` or `prepaid`. |
| `payment_net_days` | `INTEGER` | null ok | Credit terms, e.g. 30. |
| `payment_source` | `TEXT` | null ok | Where the terms came from, e.g. `contract`. |
| `payment_contract_version` | `TEXT` | null ok | Which contract version applied. |

### Market snapshot

| Column | Type | Null? | What it's for |
| --- | --- | --- | --- |
| `market` | `TEXT` | null ok | e.g. `EU`. |
| `market_sub` | `TEXT` | null ok | e.g. `DE`. |
| `market_agent_id` | `TEXT` | null ok | Agent at the time of booking. |
| `market_at` | `DATE` | null ok | When the snapshot was taken. |

Same snapshot logic as the pickup area. Agents move between markets. If you always read the market
off the *live* agent record, then the day an agent switches from EU to APAC, every historical
booking they ever made retroactively changes market and your year-on-year report becomes fiction.
Freeze it at booking time.

### Lifecycle

| Column | Type | Null? | What it's for |
| --- | --- | --- | --- |
| `booking_date` | `DATE` | null ok | Date of sale. Editable on the form. |
| `booked_at` | `TIMESTAMPTZ` | null ok | Exact instant the row was first written. Set by the server. |
| `created_by` | `TEXT` | null ok | Who submitted it: the logged-in user. |
| `updated_by` | `TEXT` | null ok | Who last edited it: the logged-in user, never the body. |
| `confirmed_at` | `TIMESTAMPTZ` | null ok | When it got confirmed. Set by the server. |
| `confirmed_by` | `TEXT` | null ok | Who confirmed it: the logged-in user. |

`booked_at`, `created_by`, `confirmed_at` and `confirmed_by` are server-owned
(`SERVER_OWNED_HEADER` in `src/domain/booking-actions.ts`): a request that sets them is refused with
`400` (`created_by` may only repeat the logged-in user). An `updated_by` in a request is dropped and
replaced by the logged-in user. With authentication off there is no user to stamp.

`booking_date` vs `booked_at` looks redundant and isn't. `booked_at` is a machine fact — the moment
the insert happened, never editable. `booking_date` is an *operational* claim staff can edit, e.g.
"this actually got sold on Friday, I'm just entering it Monday." They're allowed to disagree.

### Free text

| Column | Type | Null? | What it's for |
| --- | --- | --- | --- |
| `notes` | `TEXT` | null ok | Customer-facing-ish notes. |
| `note` | `TEXT` | null ok | Internal note. |

Yes. `notes` and `note`. Both. Different fields in the frontend, so both survive. I don't love it
either but renaming them here would just move the confusion somewhere worse.

### FOC (migration 023)

| Column | Type | Null? | What it's for |
| --- | --- | --- | --- |
| `foc_reason` | `TEXT` | null ok | Why passengers travel free. Required before a booking with FOC passengers can be confirmed. |

---

## 2. `booking_trips` — one row per departure

**This is the capacity table.** Every availability, allotment and manifest query reads this and
nothing else.

| Column | Type | Null? | What it's for |
| --- | --- | --- | --- |
| `id` | `TEXT` | **NOT NULL** | PK. |
| `booking_id` | `TEXT` | **NOT NULL** | → `bookings.id`, cascades on delete. |
| `seq` | `INTEGER` | **NOT NULL** | Order within the booking, 0-based. Unique per booking. |
| `route_id` | `TEXT` | **NOT NULL** | → `routes.id`. Real FK since migration 008. |
| `service_date` | `DATE` | **NOT NULL** | The sailing day. |
| `booking_mode` | `TEXT` | **NOT NULL** | `seat` or `charter`, default `seat`. Constrained. |
| `charter_boat_id` | `TEXT` | null ok | The boat a charter takes whole (014). Only on a charter. No foreign key: both stores check the boat is deployed on this route that day, which is stronger. |
| `zone` | `TEXT` | null ok | Transfer/pricing zone, e.g. `PK`, or `NoTransfer` for a self-arrival (015). |
| `pickup_time` | `TEXT` | null ok | Hotel pickup, or the start of the pickup window, `HH:MM` local time (015). Text, so it reads back as written. |
| `pickup_time_end` | `TEXT` | null ok | End of the pickup window, or the pier deadline when `pickup_at_pier` (024). Legacy `07:30-07:45` is `07:30` + `07:45`. |
| `pickup_at_pier` | `BOOLEAN` | `false` | The guest meets the boat at the pier by `pickup_time_end`, with no `pickup_time` (024). Legacy `Before 08:30 at pier`. |
| `ovn` | `TEXT` | null ok | Marks an outbound overnight trip (015): `return` (we bring them back) or `self` (they make their own way). |
| `ovn_return_date` | `DATE` | null ok | Set exactly when `ovn = 'return'`, and after `service_date` (015). |
| `ovn_leg` | `BOOLEAN` | **NOT NULL** | `true` on the return leg itself, default `false` (015). It holds seats on the return day like any seat trip. |
| `ovn_of` | `TEXT` | null ok | The leg's outbound trip → `booking_trips.id` (015). Only on a leg. The API still speaks in trip indexes. |

This table is why one booking can span multiple days. Real example from production: 4 bookings are
overnight trips — route r10, two consecutive days, outbound + return leg. Before this table existed
the API flat-out rejected them.

The rules that span trips (a leg's route and date match its outbound) are checked by
`assertItinerary` in `src/domain/operations.ts`. The constraints in the table are the ones a single
row can carry.

Per-trip data in other tables:

- **`booking_trip_lock_draws`** (014): how many of the trip's seats came out of which agent seat
  lock, so they are not counted twice.
- **`booking_trip_operations`** (013) and **`booking_trip_van_allocations`** (016): the ops board
  and van plan. Filled by the legacy import; no endpoint reads or writes them yet.

## 3. `booking_trip_pax` — the passenger grid

| Column | Type | Null? | What it's for |
| --- | --- | --- | --- |
| `booking_trip_id` | `TEXT` | **NOT NULL** | → `booking_trips.id`. |
| `category` | `TEXT` | **NOT NULL** | `ad` / `chd` / `inf` / `foc`. |
| `residency` | `TEXT` | **NOT NULL** | `unknown` / `foreign` / `thai`. |
| `count` | `INTEGER` | **NOT NULL** | How many. Must be > 0. |

PK is `(booking_trip_id, category, residency)`. Four categories × three residencies = twelve possible
cells, **stored as rows, not twelve columns.**

Why rows: the legacy system did it as wide columns and it has `pax_ad_fr`, `pax_chd_fr`, … but
**no `pax_chd` or `pax_inf`** — because nobody ever booked an untiered child, so the column was never
added. That's the wide-column failure mode in one sentence: *the schema ends up encoding which
combinations have happened so far.* As rows, a new tier is data. Zero people in a cell = no row.

**A trip's pax total is `SUM(count)`.** That is the only definition. There's no stored `pax` scalar
anywhere any more, which means there's nothing to drift.

---

## 4. Other booking tables

Each of these is deleted with the booking. `docs/schema.md` has their
columns.

- **`booking_passengers`** (012): the named passengers, in order. An amendment that sends the list
  replaces every row.
- **`booking_addons`** (018): extras sold with the booking, such as a longtail join or a private
  transfer. Also a whole list.
- **`booking_approvals`** and **`booking_approval_days`** (023): each approval the booking waited
  for (over the allotment, a discount, or FOC passengers), kept after it is decided.
- **`booking_history`**, **`booking_cancellations`**, **`booking_reschedules`**,
  **`booking_partial_cancels`** and **`booking_fee_items`** (020): what the booking actions recorded.

---

## The `status` column, because it's sneaky

Ten legal values:

```
draft · quote · pending · pending_approval · pending_foc
confirmed · completed · rejected · cancelled · cancelled_weather
```

Which ones hold seats? It's a **denylist**: `cancelled`, `rejected` and `cancelled_weather` give
seats back. **Everything else holds them.**

The direction is the whole point. If you write it as an allowlist and someone adds a new status
later, the new status silently releases seats — and under-holding means two parties sold the same
seat, discovered at the pier, on the day. Over-holding just means a day looks fuller than it is and
somebody asks a question. One of those is a bad afternoon, the other is a disaster. So: unknown
status holds.

One exception since migration 023: a `pending_approval` booking whose pending approval is **over
the allotment** holds no seats while it waits. It has not been granted those seats yet. A booking
waiting only for a discount approval does hold them.

The denylist lives in `src/domain/booking-status.ts` and the exception in `bookingHoldsSeats`
(`src/domain/booking-approvals.ts`). PostgreSQL's seat count is passed the same denylist and applies
the exception in SQL (`WAITING_FOR_SEATS` in `src/domain/postgres-operations.ts`); the test suite
runs on both stores to keep them equal. It is deliberately **not** a CHECK constraint or a generated
column, because that'd be the same rule written twice and the two would drift.

---

## ☠️ About `booking_data`

It's still there. It's still returned. **Don't build on it.**

Nothing writes it any more: a booking created since 2026-09-22 has `{}`, and so does every imported
one. Only a booking created through the API before that date carries the payload as it was sent at
create time, and `PATCH` never rewrote it. So even there it records what was first sent, not what
the booking now says.

That's the nastiest possible bug shape: read `booking_data.leadPax` and you get the right answer,
right answer, right answer… until someone edits the booking. Then it's quietly wrong forever.

Read the columns. The blob stops being returned in a later step, and gets dropped after that.

Also — anything **not** in the tables above is dropped on the floor. That's intentional. If a field
isn't modelled, losing it is the signal that it needs modelling, rather than it rotting unnoticed in
a junk drawer nobody can query.

Passengers (012) and add-ons (018) are stored now. **Not stored yet:** `adjustments`, the
structured allergy list, and the other repeating groups listed in `todo/booking-model.md`.
