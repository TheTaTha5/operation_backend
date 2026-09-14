# The booking table, explained like a normal person would

Yo. This is the target booking schema for TASK-6 and its special-meal follow-up. It is the contract
for the migration and API; once applied, verify the names and types against `information_schema`
rather than trusting this document from memory.

Four tables hold a booking:

- **`bookings`** — the sale. One row. All the flat stuff.
- **`booking_trips`** — the departures. One row per day you actually sail.
- **`booking_trip_pax`** — who's on each departure, broken down by type.
- **`booking_trip_meal_requirements`** — meal requirements for a specific departure.

---

## 1. `bookings` — the sale header

66 columns. Sounds like a lot, it's fine, they're grouped and most are optional.

### The bones (these existed before TASK-6)

| Column | Type | Null? | What it's for |
| --- | --- | --- | --- |
| `id` | `TEXT` | **NOT NULL** | Our primary key. Looks like `booking_<uuid>`. |
| `status` | `TEXT` | **NOT NULL** | One of ten values. More on this below, it matters. |
| `cancellation_reason` | `TEXT` | null ok | Why it died, if it died. |
| `created_at` | `TIMESTAMPTZ` | **NOT NULL** | Defaults to `now()`. Row birthday. |
| `updated_at` | `TIMESTAMPTZ` | **NOT NULL** | Defaults to `now()`. Last touch. |
| `external_id` | `TEXT` | null ok | *Their* booking ref, e.g. `BK-26072100-K3PQ`. Unique when present. |
| `agent_id` | `TEXT` | null ok | Who sold it. |
| `voucher_ref` | `TEXT` | null ok | Voucher number. |
| `rate_type_ref` | `TEXT` | null ok | Which price list applied. |
| `booking_mode` | `TEXT` | null ok | `seat` or `charter`. Copied off the first trip for convenience. |
| `booking_data` | `JSONB` | **NOT NULL** | ☠️ The blob. Dying. See the warning at the bottom. |

**Heads up on the gaps.** If you run `\d bookings` you'll notice the column positions skip 2–5 and
15. That's not a bug — migration 007 dropped `route_id`, `service_date`, `pax`, `allocated_pax` and
`pax_breakdown`, and Postgres never reuses an ordinal. Those five are gone on purpose: they're all
derived from the trips now, so there's no second copy left to fall out of sync. That "second copy
drifting" thing was an actual bug that shipped, so, yeah. Gone.

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
| `large_luggage` | `INTEGER` | null ok | Number of big bags (affects the van). |

Special meals do **not** live in JSON or as `special_meals_veg` / `special_meals_vegan` / … columns.
They are a repeatable requirement on a particular departure, so they live in
`booking_trip_meal_requirements` below. This means ops can add `no_spicy`, `gluten_free`, or another
meal type as data, without a database migration.

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
| `booked_at` | `TIMESTAMPTZ` | null ok | Exact instant the row was first written. |
| `created_by` | `TEXT` | null ok | Who submitted it. |
| `updated_by` | `TEXT` | null ok | Who last edited it. |
| `confirmed_at` | `TIMESTAMPTZ` | null ok | When it got confirmed. |
| `confirmed_by` | `TEXT` | null ok | Who confirmed it. |

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
| `booking_mode` | `TEXT` | **NOT NULL** | `seat` or `charter`. Constrained. |

This table is why one booking can span multiple days. Real example from production: 4 bookings are
overnight trips — route r10, two consecutive days, outbound + return leg. Before this table existed
the API flat-out rejected them.

⚠️ **Still to come (TASK-10):** charter fields, the OVN fields, `zone`, `pickup_time`, `subtotal`,
and the `seats_locked` / `seats_general` split. The design doc describes them; the table doesn't
have them yet. Nothing reads them, so nothing's broken, but don't be surprised when the doc and the
schema disagree.

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

## 4. `booking_trip_meal_requirements` — special meals per departure

A meal requirement belongs to a sailing day, not the sale header. An overnight or multi-day booking
can need different meals on each departure.

| Column | Type | Null? | What it's for |
| --- | --- | --- | --- |
| `booking_trip_id` | `TEXT` | **NOT NULL** | → `booking_trips.id`, cascades on delete. |
| `meal_type_code` | `TEXT` | **NOT NULL** | → `meal_types.code`, for example `veg`, `vegan`, `halal`, or `no_spicy`. |
| `quantity` | `INTEGER` | **NOT NULL** | How many. Must be greater than zero. |
| `note` | `TEXT` | null ok | Specific instruction, such as an allergy detail. |

Its primary key is `(booking_trip_id, meal_type_code)`: one count per meal type for each departure.
The kitchen can total a day with `SUM(quantity)`, and changing a count is a normal row update.

`meal_types` is a small controlled lookup table with a stable `code`, display name, and active flag.
Adding a new standard requirement is data, not a schema change:

```sql
INSERT INTO meal_types (code, display_name)
VALUES ('no_spicy', 'No spicy food');
```

Do not use a JSON object for this. JSON would make day totals, validation, and reporting harder, and
would still need application changes whenever a new meal type affects operations. Free-text notes are
for unusual detail; they are not the source of truth for a countable meal type.

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

That rule lives in `src/domain/booking-status.ts` as one function, and both stores call it. It is
deliberately **not** a CHECK constraint or a generated column, because that'd be the same rule
written twice and the two would drift.

---

## ☠️ About `booking_data`

It's still there. It's still returned. **Don't build on it.**

Right now we're in the dual-write step: new bookings write the real columns *and* the blob. But
`PATCH` only updates `booking_mode`, `status` and `updated_at` — it **does not** rewrite the blob.
So the moment anyone amends a booking, `booking_data` is frozen at whatever was sent at create time
while the columns next to it have moved on.

That's the nastiest possible bug shape: read `booking_data.leadPax` and you get the right answer,
right answer, right answer… until someone edits the booking. Then it's quietly wrong forever.

Read the columns. The blob stops being returned in a later step, and gets dropped after that.

Also — anything **not** in the tables above is dropped on the floor. That's intentional. If a field
isn't modelled, losing it is the signal that it needs modelling, rather than it rotting unnoticed in
a junk drawer nobody can query.

**Not stored yet, coming soon:** `passengers` (TASK-7), `addOns` (TASK-8), `adjustments` (TASK-9).
Right now those only survive inside the blob — so they need to land *before* the blob stops being
returned, or real data goes with it.
