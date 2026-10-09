# Booking add-ons: what is still open

`booking_addons` (migration 018), its parser (`src/domain/booking-addons.ts`), the contract
(`README.md` → "Add-ons") and the import (through the API's own parser) exist.

## Data check — 2026-10-09, legacy production, read-only

712 rows on 572 bookings, at most 3 per booking; 15 distinct types (open set, none blank); no
orphans. The import brings 711 (the other is on a cancelled B2C booking the import skips whole).

| Proposed constraint | Holds? |
|---|---|
| `CHECK (qty >= 1)` (NULL allowed: 38 rows) | yes, range 1..18 |
| `CHECK (amount >= 0)` | yes, 106 rows are 0 |
| join counts only on `longtail-join%` | yes, 33 rows, all B2B |
| `join_adults >= 0 AND join_children >= 0` | yes |
| `UNIQUE (booking_id, type)` | yes today; nothing in B2C enforces it |
| `type NOT NULL` | yes |

## Open

1. **Add the constraints above?** They all hold. A migration with them is a schema change, so it
   waits for a yes.
2. **Two joins of nobody.** BK-26090340-EYLX and BK-26090892-XCJQ have a `longtail-join` with 0
   adults and 0 children ("Longtail Join (0A + 0C)", amount 0). Here 0 means nobody joins, not
   "count every passenger"; they are imported as legacy has them.
3. **B2C does not send join counts.** All 20 B2C longtail-join rows have NULL counts ("count every
   passenger") even when B2C knew the number. A fix in Love Kingdom's repo.
4. **`price_addon` is 0 while add-on lines carry money** on 18 legacy bookings (7 B2C, 11 B2B), so
   the stored total isn't always the sum of the lines. The server prices B2B add-ons now; the B2C
   ones keep what Love Kingdom sent.
5. **Legacy never records a child count on a join** (`jchd` is 0 whenever set).
