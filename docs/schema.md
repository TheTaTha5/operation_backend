# Database schema

The PostgreSQL schema as `migrations/*.sql` builds it: its tables in eight areas, plus `schema_migrations`,
the migrator's own ledger, which is not drawn.

Checked against every migration in `migrations/` (001–023) applied to an empty PostgreSQL 17
database on 2026-10-07. The
migrations are the authority. If this file disagrees with them, this file is wrong, and the fix
belongs in the same commit as the migration that moved the schema.

## Reading the diagrams

- **A box is a table.** Each line in it is a column: type, name, key, and sometimes a short note.
  `PK` is the primary key, `FK` a foreign key, `UK` part of a unique constraint.
- **A line is a relationship.** The ends say how many rows can be on that side: a bar is *one*, a
  circle means *zero is allowed*, and a crow's foot (three prongs) is *many*. So bar-to-crow's-foot
  reads "one route has many route seasons".
- **Solid line: a real foreign key.** The database refuses a row whose id points at nothing.
- **Dashed line: an id with no foreign key.** The column holds another table's id, but only the
  application keeps it valid, or nothing does. These are listed under
  [Ids with no foreign key](#ids-with-no-foreign-key).
- A table that belongs to another area appears with only its key columns, to show where the line goes.

## Overview

An arrow points from the area holding an id to the area it names.

```mermaid
flowchart LR
  catalogue["Catalogue and seat pool<br/>routes, route_families, route_times, route_seasons,<br/>route_day_overrides, boats, boat_documents, boat_status_log,<br/>boat_capacity_overrides, deployments, seat_locks"]
  bookings["Bookings<br/>bookings, booking_trips, booking_trip_pax,<br/>booking_trip_lock_draws,<br/>booking_passengers, booking_addons,<br/>booking_approvals, booking_approval_days,<br/>booking_reconfirmations, booking_alt_pickups,<br/>booking_upgrades, booking_trip_upgrades,<br/>attachments, booking_documents, booking_upgrade_slips,<br/>booking_allergies, booking_doc_checks,<br/>booking_doc_check_results, pickup_areas,<br/>pickup_time_profiles, pickup_times, changes"]
  actions["Booking action records<br/>booking_history, booking_cancellations,<br/>booking_reschedules, booking_partial_cancels,<br/>booking_fee_items"]
  ops["Day-of-operations and vans<br/>booking_trip_operations,<br/>booking_trip_van_allocations, van_groups,<br/>vans, van_days, van_day_routes, van_status_ranges,<br/>van_zone_ranges, van_log, van_stops,<br/>van_job_sends, pickup_name_th,<br/>booking_trip_checkins, booking_trip_checkin_events,<br/>booking_trip_checkin_event_tries"]
  sales["Agents and sales<br/>agents, agent_programs, agent_activity,<br/>markets, market_subs, sales_people"]
  money["Invoices and payments<br/>invoices, invoice_lines,<br/>invoice_number_counters,<br/>payments, payment_slips"]
  rates["Rate types<br/>rate_types, rate_type_routes,<br/>rate_type_seat_prices, rate_type_charter_prices,<br/>rate_type_longtail_prices, rate_type_transfer_prices"]

  bookings -- "trip route_id, lock draws" --> catalogue
  bookings -. "charter_boat_id, approval day route_id" .-> catalogue
  actions -- "booking_id" --> bookings
  ops -- "booking_trip_id" --> bookings
  ops -- "route_id" --> catalogue
  ops -. "boat_id" .-> catalogue
  sales -- "agent_programs.route_id" --> catalogue
  bookings -. "agent_id" .-> sales
  catalogue -- "seat_locks.agent_id" --> sales
  rates -- "rate_type_routes.route_id" --> catalogue
  rates -- "owner_sales_id" --> sales
  sales -. "agents.rate_type_id" .-> rates
  bookings -. "rate_type_ref" .-> rates
  money -- "invoice_lines.booking_id" --> bookings
  money -- "invoices.agent_id" --> sales
  b2c["Love Kingdom's held orders<br/>b2c_held_orders"] -- "booking_id, resolved_booking_id" --> bookings
  weather["Weather closures, refunds and credits<br/>weather_closures, weather_cases, refunds"]
  weather -- "weather_closures.route_id" --> catalogue
  weather -- "weather_cases.booking_id, refunds.booking_id" --> bookings
  weather -- "refunds.invoice_id" --> money
  weather -- "refunds.agent_id" --> sales
  vanbills["Partner van bills and report settings<br/>van_bills, van_bill_route_rates,<br/>van_bill_row_overrides, van_bill_extra_lines,<br/>van_rates, daily_report_settings"]
  vanbills -- "van_rates.route_id" --> catalogue
  fleet["Fleet maintenance<br/>fleet_engines, fleet_gearboxes, fleet_propellers,<br/>fleet_*_log, fleet_incidents, fleet_incident_assets,<br/>fleet_incident_log, fleet_jobs, fleet_job_assets,<br/>fleet_job_parts, fleet_job_log, fleet_job_steps"]
  fleet -- "boat_id" --> catalogue
  daymoney["Proforma, pier money, after the trip<br/>booking_pfm_events, booking_pier_payments, booking_tour_sales,<br/>booking_cot_decisions, booking_noshow_charges, pier_handovers, commission_payouts"]
  daymoney -- "booking_id" --> bookings
  daymoney -. "a COT deduct is a minus line" .-> money
```

## 1. Catalogue and seat pool

What runs, and how many seats there are to sell. Routes and boats are the catalogue. A
deployment puts a boat on a route for one day, and that is what creates seats.

```mermaid
erDiagram
  routes {
    text id PK
    text name
    text kind "marine or land"
    text ext_id "Love Kingdom product code"
    text pier
    text family_id FK
    text color
    text islands
    bigint sort
    timestamptz updated_at "an API write; null = legacy's copy (070)"
  }
  route_families {
    text id PK
    text name
    text color
    integer sort
  }
  route_times {
    text route_id PK, FK
    integer idx PK
    text departs_at "HH:MM"
  }
  route_seasons {
    text id PK
    text route_id FK
    text kind "open or closed"
    date from_date
    date to_date
  }
  route_day_overrides {
    text route_id PK, FK
    date service_date PK
    text kind "open or closed, beats any season"
  }
  boats {
    text id PK
    text name
    text type
    text pier
    integer capacity "seats the company sells; may exceed the licence (070)"
    integer license_pax "legal passenger maximum"
    integer crew
    integer fish_crew
    integer registered_persons "legacy totalcap, never sold"
    text ownership "own or charter"
    integer engine_count "1 to 5"
    text name_th_brand_model_etc "the form's registration text fields"
    float gt_nt_dwt_loa_etc "the form's measurements"
    boolean retired
    date retired_on
    text retired_reason
    date unretired_on
    timestamptz updated_at "an API write; null = legacy's copy (070)"
  }
  boat_documents {
    text boat_id PK, FK
    integer idx PK
    text name
    date expires_on
    text renew_status "processing or done"
  }
  boat_status_log {
    text boat_id PK, FK
    text id PK
    integer seq "the log's order"
    text status "available, fixing, unavailable, retired"
    date from_date
    date to_date "null = open-ended"
    text loc
    text reason
    text_array planned_over "work a person planned ahead of (130)"
  }
  boat_capacity_overrides {
    text boat_id PK, FK
    date service_date PK
    integer capacity "this day only"
    text reason
    text set_by "the login (046, 070); null from legacy"
    timestamptz set_at
  }
  deployments {
    date service_date PK
    text boat_id PK "no FK"
    text route_id "no FK"
    integer capacity
    integer license_pax "copied from boats on write"
    integer registered_persons "passengers plus crew, never sold"
  }
  seat_locks {
    text id PK
    text route_id "no FK"
    date service_date
    integer pax "seats asked; a release never lowers it"
    integer pending_pax "asked, not free yet (048)"
    integer released_pax "given back (048)"
    text holder_type "agent, office or global (048)"
    text agent_id FK "set for, and only for, agent"
    text boat_id "a whole-boat hold (047); no FK"
    text status "active or released"
    date expiry "past it, holds nothing (048)"
    text reason
    text group_id FK "a bulk lock's departure"
    text parent_id FK "a sub-group's parent"
    text sub_name "set with parent_id"
    timestamptz created_at
    text created_by
    timestamptz updated_at
    timestamptz released_at
  }
  seat_lock_groups {
    text id PK
    text route_id FK
    text holder_type
    text agent_id FK
    date date_from
    date date_to
    smallint_array weekdays "0 = Sunday; empty = every day"
    integer pax "per departure"
    integer release_days_before "the cutoff: a warning only"
    text release_time "HH:MM"
    text reason
  }
  seat_lock_events {
    bigint id PK
    text lock_id FK
    text group_id FK
    text type "create, add, edit, release, draw, return, ..."
    integer qty
    date trip_date
    text booking_id "no FK"
    text note
    date day
    timestamptz at "null on many legacy lines"
    text by
    boolean imported
  }

  routes ||--o{ route_times : "departs at"
  routes ||--o{ route_seasons : "open or closed in"
  routes ||--o{ route_day_overrides : "one-day exception"
  route_families |o--o{ routes : "groups"
  boats ||--o{ boat_capacity_overrides : "per-day capacity"
  boats ||--o{ boat_documents : "certificates"
  boats ||--o{ boat_status_log : "status ranges"
  routes ||..o{ deployments : "sails"
  boats ||..o{ deployments : "deployed as"
  deployments |o..o| boat_capacity_overrides : "same boat and day"
  routes ||..o{ seat_locks : "held on"
  seat_lock_groups ||--|{ seat_locks : "one per departure"
  seat_locks |o--o{ seat_locks : "sub-groups"
  seat_locks ||--o{ seat_lock_events : "log"
  seat_lock_groups ||--o{ seat_lock_events : "log"
```

- **Seat locks (048).** A lock is one route and day. A bulk lock is a `seat_lock_groups` row plus one
  lock per departure (`group_id`); a sub-group is a lock with `parent_id`, on its parent's route and
  day, one level deep. Only a top-level lock holds seats in the pool: `pax − released_pax − drawn −
  pending_pax`, its sub-groups dividing that. Expiry, the release cutoff and `overdue` are worked out
  on read (`src/domain/seat-locks.ts`), never written into `status`.

- **A boat sails one route per day.** `deployments` is keyed on `(service_date, boat_id)`, so
  deploying the same boat again that day *moves* it rather than adding a second row.
- **Seats a boat sells** = the day's override capacity (or else the deployment's capacity), capped
  at `license_pax`. `registered_persons` is passengers plus crew and is never a selling limit. The
  rule is written once, in `src/domain/capacity.ts`. Since 070 `boats.capacity` may exceed
  `license_pax` (legacy allows it); the cap above is what keeps sales legal.
- **A deployment copies its boat's numbers** (`capacity`, `license_pax`, `registered_persons`). A boat
  edit rewrites them on the boat's deployments from today on (`PATCH /v1/boats/{id}`).
- **The catalogue is edited here** (070): `updated_at` marks a row edited through the API, which
  `seed:routes` and `seed:boats` never overwrite. `routes.ext_id` is unique (Love Kingdom's create
  is idempotent on it). `route_families` replaces legacy's hard-coded family list.
- **A boat's status** is `boat_status_log`, legacy's date ranges; the status on a date is the latest
  range covering it (`storedStatus` in `src/domain/catalogue.ts`). Whether it can sail adds the open
  work holding it (section 9, `availability` in `src/domain/fleet-availability.ts`), less the work an
  entry's `planned_over` names.
- **Seats left on a route-day are computed, not stored.** Each read sums what is deployed and
  subtracts what bookings and active locks hold. There is no counter column to fall out of step.
- **Whether a route runs on a date** is decided from `route_seasons` and `route_day_overrides` by
  `src/domain/calendar.ts`. A day override beats any season.
- **Land routes** (`kind = 'land'`) have no boats, so they have no deployments and no seats yet.
- **A seat lock** holds seats on one route-day for an agent. Bookings draw from it (see
  `booking_trip_lock_draws` below), and what it still holds is `pax` minus those draws.

## 2. Bookings

A booking is a **sale**. A trip is a **departure**. Seats are counted per trip, which is how one
booking can span several days.

```mermaid
erDiagram
  bookings {
    text id PK
    text status "one of 10, see notes"
    text external_id UK "caller's own reference"
    text agent_id "no FK"
    text voucher_ref
    text rate_type_ref "no FK, a snapshot of the rate used"
    text booking_mode "copy of the first trip's"
    text price_mode
    numeric manual_total
    numeric total "stored as sent"
    text job_note "van job order special request; empty = blanked"
    text cancellation_reason
    jsonb booking_data "legacy blob, being removed"
    timestamptz created_at
    timestamptz updated_at
  }
  booking_trips {
    text id PK
    text booking_id FK, UK
    integer seq UK "order in the itinerary"
    text route_id FK
    date service_date
    text booking_mode "seat or charter"
    text charter_boat_id "no FK, charters only"
    text zone "pickup zone, e.g. PK"
    text pickup_time "HH:MM, or window start"
    text pickup_time_end "HH:MM, window end or pier deadline"
    boolean pickup_at_pier "meet at the pier by pickup_time_end"
    text ovn "overnight: return or self"
    date ovn_return_date
    boolean ovn_leg "this trip is a return leg"
    text ovn_of FK "the leg's outbound trip"
  }
  booking_trip_pax {
    text booking_trip_id PK, FK
    text category PK "ad, chd, inf, foc"
    text residency PK "unknown, foreign, thai"
    integer count
  }
  booking_trip_lock_draws {
    text booking_trip_id PK, FK
    text seat_lock_id PK, FK
    integer qty
  }
  booking_passengers {
    text booking_id PK, FK
    integer seq PK
    text name
    text nationality
    text type
    boolean foc
  }
  booking_addons {
    text booking_id PK, FK
    integer seq PK
    text type "open set, no catalogue"
    text label "name as sold"
    numeric amount "line total"
    integer qty
    text note
    integer join_adults
    integer join_children
  }
  booking_approvals {
    bigint id PK
    text booking_id FK
    text kind "approval or foc"
    text status "pending, approved, rejected, replaced"
    text reason "over_capacity, discount, closed_day, b2c_hold…"
    boolean over_capacity "holds no seats while pending"
    integer over_total
    numeric discount
    integer foc_count
    text target_status "where approve moves the booking"
    text requested_by
    timestamptz requested_at
    text decided_by
    timestamptz decided_at
    text note
  }
  booking_approval_days {
    bigint approval_id PK, FK
    text route_id PK "no FK"
    date service_date PK
    integer need "seats asked for"
    integer over_by "seats the allotment lacks"
    integer licensed_free "registered seats left when asked"
  }
  routes {
    text id PK
  }
  boats {
    text id PK
  }
  seat_locks {
    text id PK
  }

  bookings ||--|{ booking_trips : "departs as"
  booking_trips ||--|{ booking_trip_pax : "carries"
  booking_trips ||--o{ booking_trip_lock_draws : "draws from"
  seat_locks ||--o{ booking_trip_lock_draws : "drawn by"
  booking_trips |o--o| booking_trips : "return leg of"
  bookings ||--o{ booking_passengers : "names"
  bookings ||--o{ booking_addons : "extras"
  bookings ||--o{ booking_approvals : "waits for"
  booking_approvals ||--o{ booking_approval_days : "over on"
  routes ||--o{ booking_trips : "sailed by"
  boats ||..o{ booking_trips : "chartered whole by"
  routes ||..o{ booking_approval_days : "asked about"
```

- **Every booking has at least one trip, and every trip at least one pax row.** The API
  enforces this. The database can't: a plain constraint has no way to say "at least one child row".
- **A booking holds seats unless its status is `cancelled`, `rejected` or `cancelled_weather`,** or
  it is `pending_approval` with a pending approval that is over the allotment
  (`over_capacity = true`). The ten statuses are listed in `src/domain/booking-status.ts`, and the
  approval exception is `bookingHoldsSeats` in `src/domain/booking-approvals.ts`. The database only
  checks that the status is one of the ten.
- **A charter takes a whole boat.** `charter_boat_id` names it, and all that boat's sellable seats
  leave the pool, however few passengers the charter carries.
- **A lock draw** says how many of a trip's seats came out of an agent's seat lock, so those seats
  aren't counted twice. A lock that has been drawn from can't be deleted: the foreign key has no
  `ON DELETE`.
- **Overnight trips:** a trip with `ovn = 'return'` is the outbound. Its return leg is a separate
  trip with `ovn_leg = true` and `ovn_of` pointing back at it.
- **Passengers and add-ons are whole lists.** An amendment that sends them replaces every row.
- **An approval is a row per request, kept after it is decided.** `kind` is `approval` (over the
  allotment and/or a discount) or `foc` (free passengers). A booking has at most one `pending`
  approval per kind: asking again marks the old one `replaced`. `booking_approval_days` keeps the
  route-days an over-allotment approval was about, as they were when it was asked. A legacy-imported
  `pending_approval` booking has no approval row, and holds its seats.
- **Deleting a booking deletes everything under it.** Its trips, pax, passengers, add-ons,
  approvals and action records all cascade.

The `bookings` box shows the structural columns. The other 57 columns are the header: values the
booking form writes, one column each. `foc_reason` came in migration 023, the rest in 011.

| Group | Columns |
| --- | --- |
| Sale | `schema_ver` `sold_by` `purpose` `staff_id` `staff_purpose` `booking_date` `booked_at` `created_by` `updated_by` `confirmed_at` `confirmed_by` |
| Lead passenger | `lead_pax` `lead_nationality` `lead_type` `lead_foc` `lead_phone` `lead_email` |
| Pickup and drop-off | `pickup_area_id` `pickup_self` `pickup_area` `pickup_zone` `hotel_name` `room_number` `dropoff_same` `dropoff_area_id` `dropoff_area` `dropoff_hotel_name` |
| Guides | `guide_english` `guide_russian` `guide_chinese` `guide_other_lang` |
| Passenger needs | `pax_type` `special_meals_veg` `special_meals_vegan` `special_meals_halal` `special_meals_allergies` `large_luggage` |
| Cash on tour | `cash_on_tour_amount` `cash_on_tour_currency` `cash_on_tour_handling` `cash_on_tour_note` |
| Price breakdown | `price_seat` `price_addon` `price_foc_discount` `price_discount` `price_extra` |
| Payment snapshot | `payment_method` `payment_net_days` `payment_source` `payment_contract_version` |
| Market snapshot | `market` `market_sub` `market_agent_id` `market_at` |
| Notes | `notes` `note` |
| FOC | `foc_reason` |

How each header column is parsed from a request is in `src/domain/booking-header.ts`.

## 3. Booking action records

What the booking actions record beyond the seat change: who did it, why, and what it cost. The rules
are in `src/domain/booking-actions.ts`. These tables only hold the results.

```mermaid
erDiagram
  bookings {
    text id PK
    numeric total
  }
  booking_trips {
    text id PK
  }
  booking_history {
    bigint id PK
    text booking_id FK
    timestamptz at
    text by "username from the token"
    text kind
    text tag
    text text
  }
  booking_cancellations {
    text booking_id PK, FK
    text category
    text grp "customer, operator, other"
    text note
    text charge_type "none, full, partial"
    numeric charge_amount
    timestamptz at
    text by
  }
  booking_reschedules {
    bigint id PK
    text booking_id FK
    date from_date
    date to_date
    text reason
    text charge_type
    numeric charge_amount
    text collect "none, invoice, separate"
    timestamptz at
    text by
  }
  booking_partial_cancels {
    bigint id PK
    text booking_id FK
    text booking_trip_id "no FK, by design"
    date service_date
    jsonb pax_removed "e.g. ad_fr 1"
    integer count
    text category
    text grp
    text note
    integer charged_count
    numeric charged_amount
    integer waived_count
    numeric waived_amount "refunded off total"
    timestamptz at
    text by
  }
  booking_fee_items {
    bigint id PK
    text booking_id FK
    text type
    text label
    numeric amount
    timestamptz at
  }

  bookings ||--o{ booking_history : "timeline"
  bookings ||--o| booking_cancellations : "current cancellation"
  bookings ||--o{ booking_reschedules : "every move"
  bookings ||--o{ booking_partial_cancels : "every reduction"
  bookings ||--o{ booking_fee_items : "charged on top"
  booking_trips |o..o{ booking_partial_cancels : "came off"
```

- **`booking_history`** gets one line per write, in the same transaction as the write.
- **`booking_cancellations`** holds only the *current* cancellation: at most one row, and a restore
  deletes it. Earlier cancellations survive as history lines.
- **`booking_reschedules`** and **`booking_partial_cancels`** are append-only: a new row each time,
  never updated. Only the full request body writes one. The older bodies (a bare move, a bare
  passenger count) change the trips and leave a history line only.
- **`booking_partial_cancels.booking_trip_id` has no foreign key on purpose.** The record must
  outlive a trip that a later edit removes. `service_date` still says which departure it was.
- **What the agent owes** is `bookings.total` plus the booking's `booking_fee_items`. A fee never
  changes `total`.

## 4. Day-of-operations and vans

Who drives, which van, and who rides with whom. These tables are filled by the legacy import
(`src/tools/import-legacy.ts`) and written through the dispatch, van-group and vans endpoints
(README: "Dispatch", "Van groups", "Vans and the month matrix"). What is still to build is in
`todo/trip-ops-and-vans-model.md`.

```mermaid
erDiagram
  booking_trips {
    text id PK
    text route_id FK
    date service_date
  }
  routes {
    text id PK
  }
  boats {
    text id PK
  }
  booking_trip_operations {
    text booking_trip_id PK, FK
    text boat_id "no FK"
    text pickup_time_final "HH:MM, or window start"
    text pickup_time_final_end "HH:MM, window end or pier deadline"
    boolean pickup_final_at_pier
    boolean return_same_van
    text upgrade
    text pier_checkin
    text reconfirm_status
    timestamptz reconfirm_at
    text reconfirm_by
  }
  booking_trip_van_allocations {
    text booking_trip_id PK, FK
    integer idx PK "0 is the main part"
    integer ad
    integer chd
    integer inf
    integer foc
    text van_group_id FK
    integer sequence "manual pickup order"
    text return_van_id FK
    text source "main, manual, alt_pickup"
    text pick_area_id
    text pick_hotel
    text pick_zone
    text drop_area_id
    text drop_hotel
    text drop_zone
  }
  van_groups {
    text id PK
    date service_date UK
    text route_id FK, UK
    integer number UK "display number"
    text zone "pickup zone or charter marker"
    text van_id FK "outbound van"
    text return_van_id FK
    text pickup_time "HH:MM, or window start"
    text pickup_time_end "HH:MM, window end or pier deadline"
    boolean pickup_at_pier "meet at the pier by pickup_time_end"
    integer display_order "place among the zone's groups"
  }
  van_job_sends {
    bigint id PK
    text group_id FK, UK "an outbound job"
    date service_date "a return-only job"
    text route_id FK
    text van_id FK
    timestamptz sent_at
    text sent_by
    text fingerprint "the sheet as sent"
  }
  pickup_name_th {
    text name_key PK "trimmed, lower-cased"
    text name
    text name_th
  }
  vans {
    text id PK
    text name
    text plate
    text type
    integer capacity
    text ownership "own, rented or partner"
    text partner_name
    text zone_base "PK or KL"
    text color
    text driver
    text driver_phone
    boolean active
    text note
  }
  van_days {
    text van_id PK, FK
    date service_date PK
    text status "available, off, maintenance"
    text zone "PK or KL, over the base"
    text driver
    text driver_phone
    text plate
  }
  van_day_routes {
    text van_id PK, FK
    date service_date PK
    text route_id PK, FK
  }
  van_status_ranges {
    bigint id PK
    text van_id FK
    text status "off or maintenance"
    date from_date
    date to_date "empty means open-ended"
    text note
  }
  van_zone_ranges {
    bigint id PK
    text van_id FK
    text zone "PK or KL"
    date from_date "empty means open"
    date to_date "empty means open"
  }
  van_log {
    bigint id PK
    text van_id FK
    timestamptz at
    text kind
    text text "legacy wording"
    text by
  }
  van_stops {
    text id PK
    date service_date
    text route_id FK
    text group_id FK "rides this group van"
    text kind "staff or cargo"
    text label
    integer pax "seats, staff only"
    text time "HH:MM"
    text place
    text leg "out, ret or both"
    integer sequence
    timestamptz checked_at
  }

  routes ||--o{ booking_trips : "sailed by"
  booking_trips ||--o| booking_trip_operations : "ops board row"
  booking_trips ||--o{ booking_trip_van_allocations : "split into parts"
  van_groups |o--o{ booking_trip_van_allocations : "rides in"
  routes ||--o{ van_groups : "runs for"
  vans |o--o{ van_groups : "outbound van"
  vans |o--o{ van_groups : "return van"
  vans |o--o{ booking_trip_van_allocations : "return van override"
  vans ||--o{ van_days : "driver and status per day"
  vans ||--o{ van_day_routes : "serves"
  vans ||--o{ van_zone_ranges : "works from"
  vans ||--o{ van_log : "changes"
  van_groups |o--o{ van_stops : "stops on the way"
  van_groups ||--o| van_job_sends : "sent to the driver"
  vans ||--o{ van_job_sends : "return-only run sent"
  routes ||--o{ van_day_routes : "served by"
  vans ||--o{ van_status_ranges : "out of service"
  boats |o..o{ booking_trip_operations : "boards"
```

- **A trip's passengers can be split across vans.** A trip with no allocation rows rides as one
  whole part. Part `idx = 0` is the main part, and further parts are splits or alternate pickups.
- **A van group is one outbound van run.** The group holds the van, so passengers grouped together
  can't disagree about which van they're on. Its `zone` is the pickup zone it collects from, or
  `__CHARTER__` for a charter's own van. Deleting a group leaves its allocations ungrouped rather
  than deleting them.
- **Whether a van works on a date:** a `van_days.status` override beats any `van_status_ranges`
  range. `van_day_routes` is the month matrix of which routes a van serves on which dates.
- **Vans are never deleted:** a retired van is set inactive. The foreign keys onto `vans` have no
  `ON DELETE`, so a van still in use can't be removed anyway.
- **Moving a trip to another route or day clears its van data,** because it was arranged for the
  old departure (`writeTrips` in `src/domain/postgres-operations.ts`).
- **Van job orders are computed, not stored** (`src/domain/van-jobs.ts`, README "Van job orders").
  What is stored is around them: `van_job_sends` (sent to the driver, one per job: on the group, or
  on date, route and van for a van that only brings people back; it goes with its group or van),
  `pickup_name_th` (Thai names printed under a pickup, keyed by the place trimmed and
  lower-cased), `van_groups.display_order` and `bookings.job_note`.

## 5. Agents and sales

The resellers who sell trips, the markets they sell into, and the salespeople who own them. `users` are
the staff logins (migration 027): a salesperson's login approves discounts on their agents' bookings, and
sees only their agents. This API is the master for this area since 2026-10-09 (migration 090,
todo/sales-editing-model.md); the legacy import seeds it once with legacy's ids (`--sales`).

```mermaid
erDiagram
  markets {
    text id PK
    text name
    text color
    integer sort
  }
  market_subs {
    text market_id PK, FK
    text name PK
    integer idx
  }
  sales_people {
    text id PK
    text code
    text name
    text full_name
    text designation
    text email
    text tel
    text color
    boolean active
    text signature "data:image URL, printed on contracts"
  }
  agents {
    text id PK "legacy id, e.g. a01"
    text code
    text name
    text market_id FK
    text sub_market
    text sales_id FK
    text pay_type "invoice, proforma, bt, cot"
    text vat_mode "none, include, exclude"
    integer credit_days
    numeric credit_limit
    text rate_type_id "no FK, the key waits for the import"
    boolean house "own channel, not a reseller"
    boolean active
  }
  agent_programs {
    text agent_id PK, FK
    text route_id PK, FK
    integer idx
    date book_from
    date book_to
    text note
  }
  agent_activity {
    bigint id PK
    text agent_id FK
    timestamptz at
    text by
    text kind
    text text
  }
  routes {
    text id PK
  }
  bookings {
    text id PK
    text agent_id "no FK"
  }
  seat_locks {
    text id PK
    text agent_id FK "048"
  }

  markets ||--o{ market_subs : "divided into"
  markets |o--o{ agents : "sells into"
  sales_people |o--o{ agents : "owns"
  agents ||--o{ agent_programs : "may sell"
  routes ||--o{ agent_programs : "sold by"
  agents ||--o{ agent_activity : "audit log"
  agent_contract_history {
    bigint id PK
    text agent_id FK
    text version
    date archived_at
    date contract_start
    date contract_end
    text rate_type_id "snapshot, no FK"
    jsonb programs
    jsonb signatory
    text archived_by
  }
  contract_templates {
    text id PK
    text code "unique when new or changed"
    text name
    boolean active
    boolean is_default "one"
    jsonb sections
    jsonb text
  }
  contract_documents {
    text id PK "gc_..."
    text agent_id FK
    text contract_id FK "null when none"
    text version
    text lang
    timestamptz generated_at
    text generated_by
    text template_id "snapshot, no FK"
    jsonb content "frozen"
  }
  contracts {
    text id PK
    text doc_id "the last document issued"
  }
  agents ||--o{ agent_contract_history : "renewed from"
  agents ||--o{ contract_documents : "was sent"
  contracts |o--o{ contract_documents : "printed as"
  contract_templates |o..o{ agents : "prints with (no FK)"
  users {
    bigint id PK
    text username "unique ignoring case"
    text pass_hash "legacy scrypt salt:key"
    text role "admin or staff"
    boolean can_edit
    text_array edit_areas "null = every area when can_edit"
    text_array actions "act-approve, act-capunlock, act-tmpl"
    text sales_id FK
    text agent_id FK "a login that books for one agent"
    timestamptz disabled_at
    timestamptz tokens_valid_after
    integer legacy_id
  }
  sales_people ||--o{ users : "is"
  agents ||--o{ users : "service login"
  agents |o..o{ bookings : "sold"
  agents |o--o{ seat_locks : "holds"
```

- **`agent_programs`** lists the routes an agent may sell, with the booking window sales entered.
- **`house` agents** (`a_walkin`, `a_staff`, `a_company`, `a_b2c`) are channels the business sells
  through itself, not resellers.
- **Agents are deactivated, not deleted** (`active`): a delete is refused while a booking, contract, seat
  lock, invoice or login names the agent.
- **`agent_contract_history`** is what a renewal archives: legacy's renewal edits the agent's contract
  fields and makes no contract row.
- **`contract_templates`** hold the wording a contract prints with; `agents.contract_template_id` has no
  foreign key (legacy binds agents to templates the import writes later), and deleting a template
  unbinds its agents. **`contract_documents`** are the documents issued, frozen as printed.
- **`agents.code`** is unique for a new or changed code, checked by the write: 21 legacy codes are
  shared, so there is no constraint yet.

The `agents` box shows the structural columns. The rest describe the agent:

| Group | Columns |
| --- | --- |
| Contact | `contact` `email` `phone` `note` `color` |
| Contract | `contract_template_id` `contract_status` `contract_version` `contract_start` `contract_end` |
| Company | `legal_name` `tax_id` `tat_license` `address` `company_tel` `hotline` `fax` `website` |
| Signatory | `signatory_name` `signatory_designation` `signatory_tel` `signatory_signed_date` |
| Booking channel | `booking_method` `booking_cutoff` `booking_cancel_policy` `booking_email` `booking_phone` |
| Audit | `created_at` `updated_at` |

### Add-on services and nationalities

`addon_services` (`id`, `name`, `type` boat/van/guide/other, `description`, `active`, `sort`) and
`addon_service_variants` (`service_id`, `seq`, `id`, `name`, `unit`, `selling`, `net`): the add-on catalogue
(migration 091). `nationalities` (`code` PK, `name`, `builtin`, `sort`, `created_at`, `created_by`): legacy's
73 built-ins, seeded by migration 092, and the custom ones the booking form adds. Passengers'
nationalities stay free text (no foreign key).

Insurance (migration 093) is on the passengers: `bookings.lead_age`, `lead_insurance_reviewed_at`,
`lead_insurance_reviewed_by`, and `booking_passengers.age`, `insurance_reviewed_at`, `insurance_reviewed_by`.

## 6. Rate types

The price lists agents are sold at (migration 022). A rate type is a header; every price hangs off
one of its routes. The API reads and writes them, and the legacy import fills them with legacy's
ids. Nothing prices a booking from them yet. The API is in `README.md`, "Rate types"; pricing is `todo/pricing-model.md`.

```mermaid
erDiagram
  rate_types {
    text id PK "e.g. rt003"
    text code UK "never edited, the import matches on it"
    text name
    text note
    text color
    text owner_sales_id FK "empty means shared"
    date valid_from
    date valid_to
    boolean active
    text nationality_scope "both, thai, foreign"
    text transfer_unit "label, e.g. per trip"
    date created_on "legacy's createdDate"
    timestamptz created_at
    timestamptz updated_at
  }
  rate_type_routes {
    text rate_type_id PK, FK, UK
    text route_id PK, FK
    integer seq UK "order in the rate"
    date travel_from
    date travel_to
    text longtail_bundle "free or paid, empty means none"
    numeric longtail_bundle_adult
    numeric longtail_bundle_child
    text longtail_bundle_applies_to "seat, charter, both"
  }
  rate_type_seat_prices {
    text rate_type_id PK, FK
    text route_id PK, FK
    text zone PK "PK, KL, NoTransfer, RN"
    text category PK "ad, chd, inf"
    text residency PK "foreign or thai"
    text tier PK "net, sell, min_sell"
    numeric price
  }
  rate_type_charter_prices {
    text rate_type_id PK, FK
    text route_id PK, FK
    text boat_type PK "lowercase boat type"
    numeric starter_price
    integer starter_includes "passengers the starter covers"
    numeric extra_per_pax
  }
  rate_type_longtail_prices {
    text rate_type_id PK, FK
    text route_id PK, FK
    numeric join_adult
    numeric join_child
    numeric charter_price
    integer charter_capacity
  }
  rate_type_transfer_prices {
    text rate_type_id PK, FK
    text route_id PK, FK
    text zone PK
    text vehicle PK
    numeric price
  }
  routes {
    text id PK
  }
  sales_people {
    text id PK
  }
  agents {
    text id PK
    text rate_type_id "no FK"
  }
  bookings {
    text id PK
    text rate_type_ref "no FK"
  }

  rate_types ||--o{ rate_type_routes : "covers"
  routes ||--o{ rate_type_routes : "priced in"
  sales_people |o--o{ rate_types : "owns"
  rate_type_routes ||--o{ rate_type_seat_prices : "seat prices"
  rate_type_routes ||--o{ rate_type_charter_prices : "charter prices"
  rate_type_routes ||--o| rate_type_longtail_prices : "longtail add-on"
  rate_type_routes ||--o{ rate_type_transfer_prices : "transfer prices"
  rate_types |o..o{ agents : "prices"
  rate_types |o..o{ bookings : "priced"
```

- **Each price table points at `rate_type_routes` with a two-column key,** `(rate_type_id,
  route_id)`. A price exists only for a route on the rate, and taking the route off the rate deletes
  its prices. Deleting a rate type deletes its routes and all their prices.
- **Only tier `net` is billed.** `sell` and `min_sell` are printed on contracts.
- **A zone, a boat type, a vehicle or a route is a row,** so none of them needs a migration. Which
  zones a route takes depends on its pier, and the API checks it, not the database.
- **`valid_from`/`valid_to` and `travel_from`/`travel_to` do not stop a sale.**
- **A rate type that an agent or a booking names can't be deleted** through the API (`409`). The
  database would allow it: neither `agents.rate_type_id` nor `bookings.rate_type_ref` has a key.

## 7. Invoices and payments

Legacy's accounting (migration 045, `todo/money-model.md` slice 1). The rules are in
`src/domain/invoices.ts`. An invoice's status is not a column: `voided` and the payments decide it.

```mermaid
erDiagram
  invoices {
    text id PK
    text number UK "INV-YYMM-NNNN"
    text agent_id FK
    text kind "booking, prepay or fee"
    text fee_type "cancellation or reschedule; only on a fee"
    text vat_mode "copied from the agent at issue"
    numeric vat_rate
    numeric subtotal "the lines less their discounts"
    numeric net_amount
    numeric vat_amount
    numeric total
    numeric wht_amount "printed; never part of total or paid"
    timestamptz issued_at
    timestamptz due_at
    text note_ref_dear_remark "the document's header text"
    date accept_at
    boolean voided
    timestamptz voided_at "null on a legacy void"
    text voided_by
    text void_reason
    text created_by
  }
  invoice_lines {
    text invoice_id PK, FK
    int seq PK
    text booking_id FK
    text label
    numeric amount "as issued; never recomputed"
    numeric discount
    timestamptz removed_at "taken off by a weather cancel; out of every total (061)"
    text removed_by
    text removed_reason "weather"
  }
  invoice_number_counters {
    text year_month PK "YYMM"
    int last
  }
  payments {
    text id PK
    text invoice_id FK
    numeric amount "above 0"
    text method "transfer, cash, card or credit (061: spends the agent's credit)"
    date paid_on
    text ref
    text recorded_by
    timestamptz recorded_at
    timestamptz deleted_at "a deleted payment stays, out of every total"
    text deleted_by
    text delete_reason
  }
  payment_slips {
    text payment_id PK, FK
    int seq PK
    text attachment_id FK
  }
  agents { text id PK }
  bookings { text id PK }
  attachments { text id PK }
  agents |o--o{ invoices : "billed"
  invoices ||--|{ invoice_lines : "has"
  bookings |o--o{ invoice_lines : "billed on"
  invoices ||--o{ payments : "paid by"
  payments ||--o{ payment_slips : "has"
  attachments ||--o{ payment_slips : "is"
```

- **A booking's invoice** is found through its lines: a fee invoice has one line naming the booking.
- **One live invoice per booking** is checked by the API, not the database. A partial unique index
  can't see `voided` through the join, and legacy has one booking with two.
- **`changes.kind`** also takes `invoice` (045).

## 8. Love Kingdom's held orders

A write from Love Kingdom's login that was refused as bad input, kept as it was sent for ops to
handle (migration 100, README "Love Kingdom's push").

```mermaid
erDiagram
  b2c_held_orders {
    text id PK "held_<uuid>"
    text action "create, amend or cancel"
    text external_id UK "Love Kingdom's order; unique among open creates"
    text booking_id FK "amend/cancel: the booking it was for"
    jsonb request "the body as sent"
    text problem "the refusal's message"
    integer attempts
    text status "open, resolved or dismissed"
    timestamptz received_at
    timestamptz last_received_at
    text received_by
    timestamptz decided_at "set exactly when not open"
    text decided_by
    text note
    text resolved_booking_id FK
  }
  bookings { text id PK }
  bookings |o--o{ b2c_held_orders : "amended by"
  bookings |o--o{ b2c_held_orders : "settles"
```

- **One open held create per order:** a partial unique index on `external_id` where
  `status = 'open' AND action = 'create'`. A retry updates that row (`attempts`).
- **Both booking keys are `ON DELETE SET NULL`:** the held order outlives a booking the import
  replaces.
- **`changes.kind`** also takes `b2c_held_order` (100). The migration adds it to whatever list the
  constraint has, so another branch's kind is kept whichever runs first.
## 8. Weather closures, refunds and credits

Legacy's weather cancel (migrations 060 and 061, `todo/weather-closures-model.md`). The rules are in
`src/domain/weather.ts` and `src/domain/refunds.ts`. The follow-up list is not stored: it is the
bookings on the closed trip plus the rows of `weather_cases`, worked out on read.

```mermaid
erDiagram
  weather_closures {
    text id PK "wx_… ; lg_… imported"
    text route_id FK
    date service_date "one open closure per route and day (partial unique index)"
    text note
    text closed_by
    timestamptz closed_at
    text updated_by "the last note change"
    timestamptz updated_at
    text reopened_by "undo; the closure is kept"
    timestamptz reopened_at
  }
  weather_cases {
    text closure_id PK, FK "ON DELETE CASCADE"
    text booking_id PK, FK "ON DELETE CASCADE"
    text status "awaiting, notified or resolved"
    timestamptz notified_at
    text notified_by
    text outcome "reschedule, refund, credit or cancel; set exactly when resolved"
    date new_date "a reschedule's new day"
    timestamptz resolved_at
    text resolved_by
  }
  refunds {
    text id PK "rf_…"
    text kind "refund (owed to the agent) or credit (the agent's balance)"
    text invoice_id FK "the invoice the money comes off"
    text booking_id FK
    text agent_id FK "the invoice's agent; required for a credit"
    numeric amount "above 0"
    text reason "weather"
    text created_by
    timestamptz created_at
  }
  routes { text id PK }
  bookings { text id PK }
  invoices { text id PK }
  agents { text id PK }
  routes ||--o{ weather_closures : "closed on"
  weather_closures ||--o{ weather_cases : "follows up"
  bookings ||--o{ weather_cases : "followed up"
  invoices ||--o{ refunds : "gives back"
  bookings |o--o{ refunds : "for"
  agents |o--o{ refunds : "to"
```

- **A row is written only when something happens to a booking** (notified, resolved, imported). A
  booking on the trip with no row reads `awaiting`.
- **The agent's credit balance** is its `credit` rows less its live payments with `method = 'credit'`.
- **`changes.kind`** also takes `weather_closure` (060).

## 9. Partner van bills and report settings

Legacy's partner van bill (`§vanBill`), Transfer Fleet's van rates and the daily report's settings
(migration 120, `todo/money-model.md` slices 5 and 6). The rules are in `src/domain/van-bills.ts` and
`src/domain/money-reports.ts`. **A bill's rows and amounts are not stored:** they are worked out on
every read from the bookings' van parts and check-ins. Only what staff type is kept, plus the sent
and paid state (new; legacy had none). The money reports store nothing.

```mermaid
erDiagram
  van_bills {
    text id PK "vb_…"
    text partner "a van's partner_name, trimmed; unique with month and period"
    text month "YYYY-MM"
    smallint period "1 = days 1–10, 2 = 11–20, 3 = 21–end"
    numeric per_pax "sale price per passenger"
    numeric rate "the old single default rate per van"
    text_array seen "row keys at the last save with mark_seen; NULL = never"
    timestamptz updated_at
    text updated_by
    timestamptz sent_at "sent to the van owner"
    text sent_by
    numeric sent_bill "the total when sent"
    timestamptz paid_at "needs sent_at"
    text paid_by
    date paid_on
    text paid_via "transfer, cash or cheque"
    text paid_ref
    numeric paid_amount "the total when paid"
  }
  van_bill_route_rates {
    text bill_id PK, FK "ON DELETE CASCADE"
    text code PK "PP, PB, MT, SM, SR or —"
    numeric rate
  }
  van_bill_row_overrides {
    text bill_id PK, FK "ON DELETE CASCADE"
    text row_key PK "date~route~van, ~R for a return-only run"
    numeric rate "NULL = not set (0 is a rate)"
    numeric ex
    numeric cut
    numeric per
  }
  van_bill_extra_lines {
    text bill_id PK, FK "ON DELETE CASCADE"
    text id PK
    int seq "unique per bill"
    date line_date
    text note
    int vans
    int pax
    numeric rate
    numeric ex
    numeric cut
    numeric per_pax
  }
  van_rates {
    text group_key "own, or p:<partner>"
    text route_id FK "NULL = the group's base; ON DELETE CASCADE"
    text field "base, PK or KL; a NULL route is base"
    numeric rate
    timestamptz updated_at
    text updated_by
  }
  daily_report_settings {
    boolean id PK "one row"
    numeric van_cost "NULL = 1,200"
    int van_quota "NULL = 6"
    numeric target_per_pax "NULL = 130"
    timestamptz updated_at
    text updated_by
  }
  routes { text id PK }
  van_bills ||--o{ van_bill_route_rates : "defaults"
  van_bills ||--o{ van_bill_row_overrides : "typed on rows"
  van_bills ||--o{ van_bill_extra_lines : "hand-typed lines"
  routes |o--o{ van_rates : "priced on"
```

- **`van_rates` is unique on (group, route, field) with `NULLS NOT DISTINCT`**, so a group has one base.
- **A bill names its partner by name, not by a key:** legacy's bill is per owner name, and vans carry
  that name (`vans.partner_name`). Renaming a partner's vans leaves its old bills under the old name.
- **Every amount is `NUMERIC(12,2)` and 0 or more**; a deduction (`cut`) is stored positive.

## 10. Fleet maintenance, part A: assets, incidents, jobs

Legacy's Fleet screens, part A (migration 130, `todo/fleet-maintenance-model.md`). The rules are in
`src/domain/fleet-availability.ts`, `fleet-assets.ts` and `fleet-jobs.ts`. Each record is written
whole: its row upserted, its lists (`*_log`, assets, parts, steps) replaced in order (`seq`/`idx`).

```mermaid
erDiagram
  fleet_engines {
    text id PK "legacy's (e1…); e<base36 ms> new"
    text boat_id FK "null: off a boat"
    text pos "Port, Std, C.Port…"
    text status "ready, fixing, broken, spare, limited"
    float base_hours "hours brought in; the Daily Fleet Log meter adds"
    integer service_interval
    float last_service_hours
    boolean retired "a job closed as decommission"
  }
  fleet_gearboxes {
    text id PK
    text boat_id FK
    text engine_id FK "at most one per engine (form rule)"
    text on_boat_id FK "left on the boat waiting for an engine"
    text status "ready, fixing, broken, spare, limited"
    float base_hours "the engine's hours at fitting"
  }
  fleet_propellers {
    text id PK
    text boat_id FK
    text gearbox_id FK "legacy has twin props on 6 gearboxes"
    text status "active, fixing, broken, spare, damaged, limited"
  }
  fleet_incidents {
    text id PK
    text no "INC-…; not unique (legacy duplicates)"
    text boat_id FK
    date date
    integer priority "1-5"
    text severity "computed from priority; legacy high kept"
    text status "open, resolved, closed, inprogress (legacy)"
    text job_id "no key: legacy keeps one dangling"
    text_array related_job_ids
  }
  fleet_jobs {
    text id PK
    text no "MJ-…; not unique"
    text boat_id FK
    text type "corrective, preventive, scheduled"
    text status "pending, inprogress, done"
    date start_date "holds the boat from here once started"
    text boat_status "available, fixing, unavailable; null = fixing"
    boolean set_fixing "false: runs alongside the boat"
    text outcome "success, limited, rework, decommission, cancelled"
    text incident_id "no key"
    numeric legacy_cost "legacy's stored cost, read-only"
    text board_lane "decide, wait, doing, close"
  }
  boats { text id PK }
  boats |o--o{ fleet_engines : "carries"
  fleet_engines |o--o| fleet_gearboxes : "drives"
  fleet_gearboxes |o--o{ fleet_propellers : "turns"
  boats ||--o{ fleet_incidents : "reported on"
  boats ||--o{ fleet_jobs : "repaired by"
```

- **Child tables** (each `ON DELETE CASCADE`): `fleet_engine_log`, `fleet_gearbox_log`,
  `fleet_propeller_log` (the same columns: `date, type, description, detail, text, hours,
  engine_hours, used_hours, from_loc, to_loc, incident_id, outcome, cost, by`);
  `fleet_incident_assets`, `fleet_incident_log`; `fleet_job_assets`, `fleet_job_parts`,
  `fleet_job_log`, `fleet_job_steps`.
- **Numbers are the client's** (decided 2026-10-09): a new one already used is refused by the API,
  but legacy's duplicates are kept, so `no` has an index, not a unique one.
- **A job holds its boat** while `inprogress`, from `start_date`, unless `set_fixing` is false or
  `boat_status` is `available`. Nothing stores the effective status; it is computed on read.
## 9. Proforma, pier money and after the trip

Money slices 2–4 (migrations 110–112, `todo/money-model.md`). The rules are in `src/domain/pfm.ts`,
`src/domain/pier-money.ts` and `src/domain/after-trip.ts`. Nothing derived is stored: the PFM row,
the amount owed at the pier, a sale's total and commission, a hand-over's difference are worked out
on read. Every booking-owned row goes with its booking (`ON DELETE CASCADE`).

```mermaid
erDiagram
  booking_pfm_events {
    bigserial id PK
    text booking_id FK
    text kind "approved, hold or reminded"
    text approver "approved only: as typed"
    text by
    timestamptz at
  }
  booking_pier_payments {
    text id PK "pp_… ; lg_pp_… imported"
    text booking_id FK
    date service_date
    text method "cash, transfer or card"
    numeric amount "above 0: pays the debt"
    numeric fee "card only; kept apart from amount"
    numeric fee_pct "card only"
    text note
    text by
    timestamptz at
    timestamptz deleted_at "kept, out of every total"
    text deleted_by
    text delete_reason
  }
  booking_pier_payment_slips {
    text payment_id PK, FK
    int seq PK
    text attachment_id FK
  }
  booking_tour_sales {
    text id PK "ex_… ; lg_ex_… imported"
    text booking_id FK
    date trip_date "null on legacy's oldest"
    text service
    int qty
    numeric unit_price
    numeric to_company "at most qty × unit_price"
    text seller
    text method "cash, transfer, card or cot (to collect)"
    numeric fee_pct
    numeric fee "stored: legacy's are whole baht"
    timestamptz collected_at
    text collected_by
    timestamptz sold_at
    text sold_by
  }
  booking_tour_sale_slips {
    text sale_id PK, FK
    int seq PK
    text attachment_id FK
  }
  pier_handovers {
    text id PK "ho_…"
    date service_date "one live per day and pier (partial unique index)"
    text pier
    jsonb expected "what the server worked out when handed over"
    numeric cash_counted
    text note
    text handed_by
    timestamptz handed_at
    text accepted_by "accounting"
    timestamptz accepted_at
    text voided_by
    timestamptz voided_at
  }
  commission_payouts {
    text id PK "cp_…"
    text seller
    numeric amount "the items' commission"
    text method "cash or transfer"
    date paid_on
    text ref
    timestamptz voided_at
  }
  commission_payout_items {
    text payout_id PK, FK
    text kind PK "tour_sale or upgrade"
    text booking_id PK "no key"
    text item_id PK "no key"
    numeric amount
  }
  booking_cot_decisions {
    text booking_id PK, FK
    date service_date PK
    text mode "full, part, none, payout or nocol"
    numeric deduct "off the agent's invoice"
    numeric payout "paid back to the agent"
    text ref "nocol: why"
    text by
    timestamptz at
  }
  booking_cot_decision_slips {
    text booking_id PK, FK
    date service_date PK, FK
    int seq PK
    text attachment_id FK
  }
  booking_noshow_charges {
    text booking_id PK, FK
    date service_date PK
    text decision "full, partial, none or postpone"
    numeric amount
    text note
    text by
    timestamptz at
  }
  bookings { text id PK }
  attachments { text id PK }
  bookings ||--o{ booking_pfm_events : "decided"
  bookings ||--o{ booking_pier_payments : "paid at the pier"
  booking_pier_payments ||--o{ booking_pier_payment_slips : "slips"
  bookings ||--o{ booking_tour_sales : "sold on tour"
  booking_tour_sales ||--o{ booking_tour_sale_slips : "slips"
  commission_payouts ||--o{ commission_payout_items : "pays"
  bookings ||--o{ booking_cot_decisions : "cash on tour"
  booking_cot_decisions ||--o{ booking_cot_decision_slips : "slips"
  bookings ||--o{ booking_noshow_charges : "no-show"
  attachments ||--o{ booking_pier_payment_slips : "file"
```

- **`bookings`** gains Love Kingdom's payment state: `payment_paid`, `payment_paid_status`,
  `payment_deposit`, `payment_balance` (111).
- **`invoice_lines.cot_date`** (112): set on a cash-on-tour deduction's minus line, one per trip date.
- **`changes.kind`** also takes `pier_handover` and `commission_payout` (111).

## 11. Fleet maintenance, part B: stock, memos, projects, Daily Fleet Log, safety

Migrations 140–143 (`todo/fleet-maintenance-model.md`, "Design — part B"). The rules are in
`src/domain/fleet-*.ts`; both stores reach these tables through `store.fleetRepo` (`fleet-store.ts`,
`fleet-postgres.ts`). Part A's jobs and engines are named by text ids (`job_id`, `engine_id`).

```mermaid
erDiagram
  fleet_warehouses { text id PK "tublamu, panwa, ranong" text name "legacy's label" }
  fleet_stock_items {
    text id PK "legacy's id; inv_…"
    text name "name + part_no unique among live items (checked by the API)"
    text part_no
    numeric min_qty
    numeric cost
    timestamptz deleted_at "never deleted: hidden"
    text merged_into FK "a merged duplicate"
  }
  fleet_stock_movements {
    bigserial seq PK
    text id "lg_… imported"
    text item_id FK
    date date
    text type "register, receive, withdraw, transfer-in/out, edit, merge, adjust, adjust_out, in, return, reverse, import"
    text warehouse FK "required when delta is not 0"
    numeric delta "signed; stock = sum by item and warehouse"
    text memo_id FK
    text job_id "part A, text"
    text consumable_id FK
    jsonb changes "an edit's [{field, from, to}]"
  }
  fleet_consumables { text id PK date date text item_id FK numeric qty numeric cost text warehouse FK text boat_id FK timestamptz voided_at }
  fleet_memos {
    text id PK
    text no "client's number; not unique (legacy has two duplicates)"
    text status "pending_approval, approved, ordered, received, paid, cancelled"
    smallint current_step
    numeric amount "computed; imported as legacy stored it"
    text boat_id FK
    text project_id FK
    text job_id "part A, text"
    jsonb short_closed
    text cancel_reason
  }
  fleet_memo_lines { text id PK text memo_id FK numeric qty numeric price text category text item_id FK numeric received_qty }
  fleet_memo_history { bigserial id PK text memo_id FK text type text by timestamptz at }
  fleet_memo_receipts { text id PK text memo_id FK date date text warehouse FK jsonb lines }
  fleet_projects { text id PK text no "client's" text boat_id FK "null = General" text status date original_plan_to "baseline" jsonb no_cost }
  fleet_project_log { bigserial id PK text project_id FK date date text text }
  fleet_project_plan { text project_id PK, FK text id PK boolean done }
  fleet_project_documents { text project_id PK, FK text id PK text attachment_id FK text url text status }
  fleet_project_vendor_visits { text project_id PK, FK text id PK text vendor }
  fleet_daily_boats { date date PK text boat_id PK, FK numeric fuel_litres int pax_actual }
  fleet_daily_meters { date date PK text boat_id PK, FK text trip_type PK text engine_id PK "part A, text" numeric reading }
  fleet_fuel_prices { date date PK text key PK "pier or boat" numeric price }
  fleet_daily_locks { date date PK text pier PK timestamptz locked_at }
  fleet_water_meters { date date PK text boat_id PK, FK numeric open_reading numeric close_reading }
  fleet_issue_items { text id PK text name text pier boolean off }
  fleet_issues { date date PK text boat_id PK, FK text item_id PK, FK numeric qty }
  fleet_daily_extras { text id PK date date text boat_id FK text name }
  fleet_daily_requests { text id PK date date text pier text name jsonb issues }
  fleet_safety_items { text id PK text boat_id FK text category date expiry_date date next_pm }
  fleet_safety_inspections { text id PK text item_id FK date date text result date next_due }
  fleet_safety_log { bigserial id PK text item_id FK text type }
  fleet_stock_items ||--o{ fleet_stock_movements : "moves"
  fleet_warehouses ||--o{ fleet_stock_movements : "in"
  fleet_memos ||--o{ fleet_memo_lines : "lists"
  fleet_memos ||--o{ fleet_memo_history : "logs"
  fleet_memos ||--o{ fleet_memo_receipts : "received in"
  fleet_memos |o--o{ fleet_stock_movements : "brought"
  fleet_stock_items |o--o{ fleet_memo_lines : "for"
  fleet_projects |o--o{ fleet_memos : "pays for"
  fleet_projects ||--o{ fleet_project_documents : "files"
  fleet_issue_items ||--o{ fleet_issues : "issued"
  fleet_safety_items ||--o{ fleet_safety_inspections : "checked"
```

- **Movements are append-only in the schema:** a trigger refuses `UPDATE` and `DELETE`, except on
  imported `lg_` rows inside the import's transaction (`SET LOCAL fleet.import_rewrite = 'on'`).
- **`fleet_daily_locks`:** a row means the pier's day is locked; every Daily Log write to it is
  refused (`409 day_locked`).
- **A project's boat entries** are rows of the boat's status log with `project_id` set.

## 12. Fleet maintenance, the extras: pier assignments, fuel budget

Migration 190 (`todo/fleet-maintenance-model.md`, "Design — extras"). Certificates' state, the replace
wizard, the reports and the Daily Log flags add no table: they compute from what is stored or write
part A's and part B's rows. Both stores reach these through `store.fleetRepo`.

```mermaid
erDiagram
  boats ||--o{ boat_assignments : "moved by"
  boat_assignments {
    text id PK "legacy's asn_…"
    text boat_id FK
    text type "temporary, permanent"
    text from_pier "tublamu, panwa, ranong; not to_pier"
    text to_pier
    date start_date
    date end_date "not before start_date"
    numeric cost "0 or more"
    boolean cancelled "kept, never deleted"
    timestamptz created_at "orders two that cover one day"
  }
  fleet_fuel_budgets { text month PK "YYYY-MM" numeric amount "more than 0" timestamptz set_at text set_by }
```

- **An assignment's status** (planned, active, completed) is computed from its dates, never stored.
- **A boat's pier on a day** (`pierOn` in `src/domain/fleet-assignments.ts`) reads the assignments,
  the boat's status log and its home `pier`; the Daily Log's day lock follows it.

## Ids with no foreign key

These columns hold another table's id, but the database does not check it. Where a migration
gives a reason, it is quoted; otherwise the table says what happened.

| Column | Points at | Why there is no key |
| --- | --- | --- |
| `booking_trips.charter_boat_id` | `boats` | The real rule, "deployed on this route that day", is stronger than a key, and both stores check it before writing (014). |
| `deployments.boat_id` | `boats` | Left out for the same reason. 014 says it and `charter_boat_id` "should gain a key together". |
| `deployments.route_id` | `routes` | Created (001) before the route catalogue existed (005). 008 added a key for `booking_trips.route_id` only. |
| `seat_locks.route_id` | `routes` | Same as `deployments.route_id`. |
| `booking_trip_operations.boat_id` | `boats` | Created without one (013). No API writes the column yet. |
| `bookings.agent_id` | `agents` | Created (002) before the agents table (017). No key was added when it arrived. |
| `seat_locks.boat_id` | `boats` | A whole-boat hold's boat (047), keyless like `deployments.boat_id`. |
| `booking_partial_cancels.booking_trip_id` | `booking_trips` | Deliberate: the record must outlive a trip a later edit removes (020). |
| `booking_approval_days.route_id` | `routes` | Created without one (023). |
| `agents.rate_type_id` | `rate_types` | Created (017) before the rate types table (022). The key can only ship after the rate types import has run in production; until then agents hold ids `rate_types` does not have (`todo/rate-types-model.md`). |
| `bookings.rate_type_ref` | `rate_types` | Free text for good: it is a historical snapshot, and a deleted rate must not break old bookings. |
| `fleet_memos.job_id`, `fleet_stock_movements.job_id` | part A's maintenance jobs | Built in parallel with `fleet_jobs` (140); legacy's are imported as they are. Legacy names one deleted job (`mjmtsfprvltstem`). |
| `fleet_daily_meters.engine_id`, `fleet_consumables.engine_id` | part A's engines | Same. |
| `fleet_fuel_prices.key`, `fleet_daily_locks.pier`, `fleet_daily_requests.pier` | piers or `boats` | A price key is a pier or a boat; piers have no table. |
| `fleet_incidents.job_id`, `fleet_jobs.incident_id` | `fleet_jobs`, `fleet_incidents` | Legacy keeps an incident linked to a deleted job, and deleting an incident leaves its job's link (130). |
| `fleet_jobs.parent_project_id` | `fleet_projects` | The two were built in parallel (130, 141); legacy's are imported as they are. |
| `commission_payout_items.booking_id`, `item_id` | `booking_tour_sales`, `booking_upgrades` | An upgrade list is rewritten whole on every save, and an import replaces bookings (111). |
| `pier_handovers.pier` | `routes.pier` | A pier is a route's text field, `other` when none (111). |

There is also no users table. Every `by` and `*_by` column is a username stored as plain text. On a
write through the API, `updated_by` and the action records' `by` come from the caller's Bearer
token (`actorOf` in `src/domain/booking-actions.ts`).
