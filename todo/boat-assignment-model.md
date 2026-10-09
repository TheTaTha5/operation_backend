# Boat assignment rules, modelled

**Status:** design, waiting for approval. Decided 2026-10-09: copy legacy (handoff §8 Q3 and Q4).

- **Source:** wt-lk-inbox@658298d, `08-app.js`:
  - `bkV2AssignBoat`, `BA_CAP_TOL`, `§baCapGate`, `baAssignedPax`;
  - `boatCapMayRaise`, `boatCapSet`;
  - `§chOpsSync` (on save), `bkV2CharterBoatHeal`.
- **Already here:**
  - `PATCH /operations/trip-ops/{trip}` (`src/domain/dispatch.ts`) refuses only a boat not deployed on
    the trip's route that day (`409 boat_not_deployed`).
  - `boat_capacity_overrides` (boat, day, capacity, reason) is imported, with no write endpoint.
  - The `act-capunlock` right exists on users.

## What legacy does

1. **A full boat refuses a booking** (`bkV2AssignBoat`).
   - **The count:** what the boat would carry that day is the pax of every live booking already on it
     (counting a split's share of a booking on several boats), less this booking if it is already
     there, plus this trip's pax.
   - **The limit:** above the day's capacity + 2 (`BA_CAP_TOL`), the assignment is refused.
   - **The way out:** a user with `act-capunlock` (an admin passes too) may raise that day's capacity
     for the boat. It needs a reason, and never goes above the licensed seats. Then the assignment
     goes through.
   - **Above the licence** there is no way out: "assign another boat, or add a boat".
2. **A chartered boat takes no seat booking:** "used as a charter on <date>".
3. **A charter's boat is its charter boat** (`§chOpsSync`).
   - **The rule:** on every save, a charter trip's operations boat (`ops.boatId`) is set to its
     `charterBoatId`. The board's boat cell for a charter is locked, so changing the charter on the
     booking is the only way to change its boat.
   - **The exception:** a trip split over several boats keeps its splits.

## Rules here

| Field | Kind | Rule |
|---|---|---|
| `operations.boat_id` of a seat trip | validated | refused on a boat chartered that day (`409 boat_chartered`); refused over capacity + 2 (`409 boat_full`) unless `raise_capacity` is sent |
| `operations.boat_splits[]` | validated | the same two rules for every boat a split adds pax to |
| `operations.boat_id` of a charter trip | computed | always its `charter_boat_id`; another value is refused (`400`: "a charter's boat is its charter_boat_id: change it on the booking"); kept in step when the booking's charter boat changes |
| `raise_capacity: { reason }` on the trip-ops `PATCH` | validated | needs `act-capunlock` or admin (`403`); never above the licence (`409 over_licence`); sets that day's capacity override to `min(licence, needed)` as legacy's dialog does, records who and why, then assigns |

- **"Capacity that day"** is the boat's sellable seats for the day: the deployment, after any day
  override and the licence clamp. It is the same number `/v1/availability` shows.
- **The rule lives once, in `src/domain/dispatch.ts`.** Each store gives it the day's load per boat.

## Schema (migration 046)

```sql
-- Who raised a boat's capacity for a day, and when (todo/boat-assignment-model.md; legacy recorded '—').
ALTER TABLE boat_capacity_overrides ADD COLUMN set_by TEXT, ADD COLUMN set_at TIMESTAMPTZ;
```

## Contract

```jsonc
// PATCH /operations/trip-ops/{trip}
{ "boat_id": "b7", "raise_capacity": { "reason": "agent overbooked, 2 extra on deck" } }
// 409 boat_full: "Boat Hermetis would carry 69 on 2026-10-04 (capacity 65, at most 67). Raising the
//   day's capacity needs act-capunlock: send raise_capacity with a reason."
// 409 over_licence: "… licensed seats 66: assign another boat, or add a boat."
// 409 boat_chartered: "Boat b7 is a charter on 2026-10-04: a seat booking can't go on it."
```

- **The answer:** the trip, as today. A raise is in the change feed as a `deployment` change.
- **Charter sync on booking edits:** a `PATCH /v1/bookings/{id}` that changes a trip's
  `charter_boat_id` also moves that trip's `operations.boat_id`, unless it has splits.

## Data check: 2026-10-09 (a full legacy import, local)

- Seat trips on a boat chartered that day: 0.
- Charter trips whose operations boat differs from their charter boat: 0. Three have none; the sync
  fills them on their next edit.
- Boat-days above capacity + 2: 2, both in the past; none from today on. Nothing imported breaks the
  rules, and the import does not apply them.

## Open

1. **An edit that only changes pax** (no boat sent) can push a boat over too. Legacy checks only when a
   boat is assigned. Proposal: copy legacy, so an edit is not refused for the boat; dispatch sees the
   load on the board.
