# Trip operations and vans: what is still open

Everything this note designed is built (migrations 033–038; README → "Dispatch", "Van groups",
"Vans and the month matrix", "Van stops", "Alternate pickups", "Check-in", "Upgrades",
"Reconfirm"). Git history has the design. What is left:

## Needs a decision

1. **Payment-slip attachments.** On-tour upgrade sales carry payment-slip pictures
   (`slips`, `/api/attach/{id}` in legacy; 7 of 11 legacy sales). Attachments have no home here,
   so the API refuses a non-empty `slips` and the import doesn't keep them. Legacy's upgrade screen
   attaches a slip to every card payment, so this blocks that screen at cutover. It belongs with the
   booking attachments design.
2. **A deployment deleted under bookings assigned to that boat.** The deployment-delete endpoint
   and the import's mirror delete leave `boat_id` pointing at a boat that no longer sails that day
   (the read shows `boat_pulled: true`). Clear it, or refuse the delete?
3. **Alternate pickups follow two legacy rules that may be bugs** (copied 2026-10-09):
   - parts are built on the booking's **first day only** (legacy writes `b.ops`), so a two-day
     booking's second day has none;
   - when the entries take **every passenger**, nothing is split: BK-26100284-2D4T (3 passengers,
     3 entries at 3 hotels) has one part, at the booking's own pickup.
4. **The check-in event-tries table** (`booking_trip_checkin_event_tries`, migration 036) was added
   without a separate approval: legacy's live check-in screen writes `events[].tries` ("tried again,
   not found"), and without it they'd be lost. No legacy row has one yet.
5. **Reconfirm on the ops board** keeps the "sent to agent" mark when a booking is marked confirmed
   by list or phone, or cleared. Legacy's board buttons wipe it (its own Re-confirm page keeps it).

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
