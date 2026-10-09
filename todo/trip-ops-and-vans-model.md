# Trip operations and vans: what is still open

Everything this note designed is built (migrations 033–038; README → "Dispatch", "Van groups",
"Vans and the month matrix", "Van stops", "Alternate pickups", "Check-in", "Upgrades",
"Reconfirm"). Git history has the design. What is left:

## Decided 2026-10-09, to build

1. **Payment slips** go with attachments (`booking-extras-model.md`, approved): upgrade sales take
   `slips` again, and the import keeps them.
2. **Alternate pickups:** build their van parts on **every** trip of the booking, not day 1 only; and
   split even when the entries take every passenger (the main part, left with nobody, goes).
3. **Reconfirm from the ops board wipes the "sent to agent" mark**, as legacy's board buttons do:
   marking confirmed by list or phone, and the board's clear. The Re-confirm page keeps it.

Also decided: a deleted deployment keeps the trips' boat and shows `boat_pulled` (as built); the
check-in tries table stays.

## Later

6. **Upgrade `method`:** legacy's payment block may also produce `cot` (cash on tour). Only `card`,
   `cash` and blank appear in the data, so it isn't constrained.
7. **Upgrade money overlaps the payments model** (`collected`, `settle`, `customer_paid`). When
   payments are modelled, check whether these move there.
8. **`ops.pfm`** (unpaid-proforma travel decision) has no legacy column and is lost on every save
   today. It belongs with the approval/payments model.
9. **The day's van board.** `GET /operations/van-groups` needs a `route_id`; the hand-off's computed
   `GET /operations/van-board` (pools, rounds, return alerts, warnings across routes) is a later
   phase for the Vue port (`operation_frontend/apps/web/docs/handoff/van-endpoints.md`, its §8
   checklist is the definition of done).
10. **Overnight legs on the van board (R16).** Legacy skips an overnight return leg in its
    second-round check and shows "no pickup leg" for it; here a return-leg trip can be grouped.
11. **The split `returnSameVan`** is read by legacy (`L.sp.returnSameVan`) but never written, so it
    isn't stored.
12. **Rented vans print as company vans on legacy's job order** (its owner tag checks
    `rental`/`charter`, not `rented`). A legacy display bug, noted only.

## Before the import runs on production

- Apply the migrations on the shared database, then a dry run: read the skipped bookings, the van
  group conflicts and the notes before `--commit`.
