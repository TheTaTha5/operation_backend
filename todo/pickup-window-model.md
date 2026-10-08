# Pickup window: a start, an end, and "at the pier"

**Approved 2026-10-08.** Built on `feat/pickup-window` (migration 024).

## Why

`booking_trips.pickup_time` accepted only `HH:MM`. Legacy fills a trip's pickup time from the
pickup-area table (`bkV2GetPickupTime`, route × area), and that table holds a **window** such as
`07:30-07:45` or a pier deadline such as `Before 08:30 at pier`. So legacy could not save any
booking whose pickup area has a time (a `400`), and the importer dropped all but 2 of 4,689 trip
pickup times.

## Legacy data (read-only, 2026-10-08)

| Shape | `sb_bookings__trips.pickuptime` | `sb_bookings.ops_pickuptimefinal` |
|---|---|---|
| empty | 606 | 4,484 |
| one time (`07:30`, `7:30`, `08.00 a.m.`) | 2 | 629 + 83 `HH.MM a.m.` |
| window `HH:MM-HH:MM` | 3,994 | 85 |
| `Before HH:MM at pier` | 693 | 2 |
| start only (`08:20-`) | 0 | 1 |

No window ends at or before its start. Every value fits the fields below, so nothing is lost.
(`sb_bookings__trips.ops_pickuptimefinal` is empty on every row; the final time lives on the
booking row.)

## Fields

All three are **client facts** (the client proposes, the server checks the shape and the rules
between them). Legacy computes the default from the pickup-area table in the browser; moving that
table here, so the server fills the default, is a later step with the pickup-area catalogue.

| Field | Column | Meaning |
|---|---|---|
| `pickup_time` | `booking_trips.pickup_time` (exists) | Start of the hotel pickup window, `HH:MM` |
| `pickup_time_end` | `booking_trips.pickup_time_end` (new) | End of the window, or the pier deadline, `HH:MM` |
| `pickup_at_pier` | `booking_trips.pickup_at_pier` (new) | The guest meets the boat at the pier by `pickup_time_end` |

Rules (`pickupProblem`, `src/domain/pickup.ts`, refused with `400`):

- each time is `HH:MM`, 24-hour;
- `pickup_time_end` needs `pickup_time`, unless `pickup_at_pier`;
- `pickup_at_pier` needs `pickup_time_end` and refuses `pickup_time`;
- `pickup_time_end` is after `pickup_time`.

The same three columns go on `booking_trip_operations` (`pickup_time_final`,
`pickup_time_final_end`, `pickup_final_at_pier`) for the dispatcher's final time. This replaces the
`pickup_note` decided on 2026-10-06 (`todo/trip-ops-and-vans-model.md`, decision 5): the values
turned out to be windows and pier deadlines, not free text. Only the importer writes them until
the dispatch endpoints (slice A) exist.

## Legacy text ↔ fields

| Legacy | `pickup_time` | `pickup_time_end` | `pickup_at_pier` |
|---|---|---|---|
| `07:30` | `07:30` | | |
| `07:30-07:45` | `07:30` | `07:45` | |
| `08:20-` | `08:20` | | |
| `Before 08:30 at pier` | | `08:30` | `true` |

Legacy splits its text this way before saving and joins the fields back to show them, so its
screens are unchanged. The importer does the same (`legacyPickup`, `src/tools/legacy-pickup.ts`).

## Contract change

- `trips[].pickup_time_end` / `pickupTimeEnd` and `trips[].pickup_at_pier` / `pickupAtPier`, on
  create and on `PATCH` (they are client facts).
- A read returns them only when set, like `pickup_time`.
- Love Kingdom sends no pickup time today, so it has nothing to change.
