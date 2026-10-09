# Whole-boat holds, modelled

**Status:** approved 2026-10-09; building.

- **Source:** wt-lk-inbox@658298d, §bkLock. A seat lock with `scope: "boat"`; the boat-board cell is
  marked `type: "charter"` with `boatLockId`. See `seat-lock-extras-model.md` for the rest of legacy's
  locks.
- **Why:** the import brought a hold in as an ordinary lock of its promised seats on an ordinary
  boat. Seats on sale come out the same today, because every active hold promises its boat's full
  capacity. But three things differ from legacy:
  1. a hold promising fewer seats than its boat leaks the difference;
  2. a seat booking can be assigned to the held boat (`boat_chartered` does not fire);
  3. the boat's licensed seats still count in "real seats left", so an over-allotment booking goes to
     approval where legacy refuses it.

  Example of 3: r3 on 2026-10-15 has only b8 (licence 47), held whole. A 40-pax booking from another
  agent is refused in legacy and waits for approval here.

## Rule

A seat lock may name a `boat_id`: a whole-boat hold. In the day's seat pool (`dayCapacity`, both
stores), a hold on a boat deployed that day counts exactly as a charter does:
- the boat's sellable and licensed seats leave the pool, whatever number was promised;
- the boat reads `chartered`, so `boat_chartered` fires on trip-ops, and a charter booking can't take
  it (`409`);
- the hold itself holds nothing more, and nothing draws from it (0 seats left).

A hold whose boat is not deployed that day takes no boat, and holds its promised seats as a plain
lock, the way a charter with no deployed boat holds its passengers.

## Schema (migration 047)

```sql
ALTER TABLE seat_locks ADD COLUMN boat_id TEXT;   -- a whole-boat hold; no key, as deployments.boat_id
```

## Contract

- **Reads:** a lock read carries `boat_id`, which is `null` for an ordinary lock.
- **Writes:** `POST`/`PATCH` don't take it. Creating and converting holds through the API belongs to
  the seat-lock design; until then legacy creates them and the import mirrors them, with their
  `boat_id`.
