# Deployment guards, modelled

- **Source:** wt-lk-inbox@658298d — `04-data-core.js` `bop2UnassignBoat`, `bop2AssignBoat`,
  `bop2GuardPast`, `bop2ClearWeek`, `bop2ApplySwap`; `08-app.js` `baAssignedBookings`,
  `bkV2BoatPulled`, `pjOpDrop`, `boatCapSet`, `bkV2BoatLockBlockers`; `05-fleet.js` `saveBoat`.
- **Already here:** `POST /operations/deployments` is an upsert on `(service_date, boat_id)` and
  `DELETE /operations/deployments/{date}/{boat}` a bare delete. Neither checks anything beyond the
  input shape. `license_pax` may be sent per deployment; the catalogue's is used only when it is
  omitted.

## What legacy does

- **Past dates:** no change at all (`bop2GuardPast`), hard block.
- **A chartered boat** cannot be removed, moved or swapped: "Cannot unassign - charter is active.
  Cancel the charter booking first." Hard block. Same for a boat held whole by an agent.
- **Bookings placed on that boat:** a confirm dialog ("N bookings (P pax) are on this boat…"); on
  OK the boat goes and the bookings are flagged "boat pulled · re-plan".
- **Seats sold on the route but not placed on a boat are never counted**, so removing a boat can
  leave the day oversold with no warning (bug). `bop2ClearWeek`, swaps and template overwrites skip
  even the dialog (bug).
- **Lowering a capacity:** no check; the dialog shows the current load. Raising above normal needs
  `act-capunlock`; nothing goes above the licence.
- **Licence:** always the boat catalogue's. A deployment has no licence of its own.

## Proposal

| Field | Kind | Rule |
|---|---|---|
| `route_id`, `service_date`, `boat_id`, `capacity` | client fact, validated | below |
| `license_pax` | **computed** | the boat's; a different value in the body is `400` |

Checks, as one pure function `planDeploymentChange(day before, day after)` both stores call:

1. A date before today (Asia/Bangkok) → `409 past_date`.
2. Removing or moving a boat a charter holds → `409 charter_boat`.
3. Removing, moving or shrinking a boat so that the day's seats held (bookings + locks) no longer
   fit → `409 seats_sold` with `{held, capacity_after}`, **unless** the body carries
   `"remove_anyway": true` (legacy's dialog). Then it goes through and the answer carries
   `warnings: [{code: 'oversold', route_id, service_date, over_by}]`.
4. Moving a boat to another route is a remove on the old route-day plus an add on the new.

## Decided 2026-10-09 (approved, not built)

1. Count only the bookings **placed on that boat**, as legacy (not the whole route-day).
2. `remove_anyway: true` overrides, as legacy's dialog.
3. Past dates: blocked for staff; **an admin may correct** them.
4. `available_seats` stays negative on an oversold day.

## The questions as asked

1. **Count the whole route-day, not just bookings placed on that boat** (recommended — legacy's way
   misses oversells), knowing this asks for `remove_anyway` more often than legacy's dialog appeared?
2. **`remove_anyway`**, or a hard refusal with no override? Recommended: the override, as legacy.
3. Past dates: a hard block like legacy (recommended), or allowed for an admin correcting history?
4. `available_seats` here goes negative on an oversold day; legacy clamps it to 0. Keep negative
   (recommended: it shows the oversell)?
