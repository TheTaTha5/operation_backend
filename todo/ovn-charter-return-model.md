# Overnight charters: the return leg and the nights between

**Proposed 2026-10-08, waiting for a decision.** Nothing is built yet: the importer still skips both
bookings below, and the rule in `assertItinerary` is unchanged.

- **Source:** wt-lk-inbox `origin/lk-inbox@5d81a30`: `08-app.js` `bkV2CreateOvnReturnLeg` (§ovnRet),
  `04-data-core.js` `bkIsCharterOvnLeg` / `getSeatsConsumed` (§ovnRead); legacy data
  `operation_schemas.sb_bookings__trips`, `trips__boat` (dump of 2026-10-08).
- **Found by:** `npm run verify:import` (`feat/verify-import`): 2 bookings missing, charter pax off by
  12 and 44 on four days, booking totals off by ฿217,483 over two months.

## What legacy does

An overnight trip with `ovn: 'return'` gets a return leg on its return date. For a **seat** outbound
the leg is a seat trip, as `assertItinerary` expects. For a **charter** outbound, legacy makes the leg
a charter on the same boat (§ovnRet: "เหมาลำ คนละเคสกับจอย", a charter is not a join):

```js
leg.bookingMode = t.bookingMode === 'charter' ? 'charter' : 'seat';
if (t.bookingMode === 'charter') leg.charterBoatId = t.charterBoatId;
```

The leg is priced 0 (`ovnLeg`), and it takes no seats from the pool: the group comes back on the boat
it chartered (`bkIsCharterOvnLeg`, §ovnRead, measured on BK-26090351-ENOG: without it, 19 Sep
showed 12 seats sold that did not exist).

The boat stays with the group. Boat Operation marks it chartered by the booking **every day of the
stay**, the nights between included:

| Booking | Boat | Outbound | Return | `trips__boat` days chartered to it |
|---|---|---|---|---|
| BK-26090351-ENOG (Zeus, 12 pax, ฿139,800; ฿15,000 of it the overnight charge) | b13 | r10 2026-09-16 | 2026-09-19 | 16, 17, 18, 19 Sep |
| BK-26100056-MYJC (44 pax, ฿75,000) | b11 | r10 2026-10-26 | 2026-10-28 | 26, 27, 28 Oct |

These two are all of legacy's overnight charters today.

## What this service does

1. **The booking is refused.** `assertItinerary`: `trips[1] is a return leg and must be a seat
   trip` (`400`). The importer lists both as skipped, and the legacy integration client gets the same
   `400` if anyone saves one.
2. **The nights between sell the boat's seats.** The importer deploys the boat on the route for each
   `trips__boat` day, but a boat counts as chartered only on a day a charter *trip* names it
   (`capacity.ts`, `chartered`). No trip names it on the nights between, so its seats join the pool:
   b13's 38 seats on r10 on 17–18 Sep, and **b11's 65 seats on r10 on 27 Oct**, which is still ahead.
   Legacy sells none of them (`baDayBoats` leaves a charter boat out).

## Proposal

**A. The return leg of a charter is a charter on the same boat** (validated rule, `assertItinerary`):

- outbound `booking_mode = 'seat'` → leg must be a seat trip (as today);
- outbound `booking_mode = 'charter'` → leg must be a charter whose `charter_boat_id` is the
  outbound's (refused otherwise, `400`, naming both).

The leg then behaves as any charter: it needs its boat deployed on the return day and takes the
whole boat, so it takes nothing from the pool, which is legacy's §ovnRead.

**B. The boat is the charter's on every night between** (computed). A charter outbound with
`ovn: 'return'` holds its boat on each day after the outbound and before the return date: the
boat counts as `chartered` there too, so its seats leave the pool and no one else can charter it.
Nothing is stored for it; it follows from the trips, like `chartered` today.

**C. The importer** stops skipping both bookings (A makes them valid) and keeps importing the
nights-between deployments as it does (B makes them hold nothing).

**Price:** the leg's price stays the client's (`total`, as for every booking until `POST /v1/quote`).

## Questions

1. **A:** must the leg name the outbound's boat, or may it name a different boat (a boat swap on
   the island)? Recommended: the same boat, as legacy builds it; a swap is a reschedule of the leg.
2. **B:** is "the nights between belong to the charter" right, or should the boat be free for other
   work while the group stays on the island? Legacy holds it (Boat Operation shows it chartered).
3. Does an overnight **seat** booking need anything similar? No: its guests are in the pool both
   ways, as today.

## Tests to add

- An overnight charter with a charter leg on the same boat is accepted; on another boat, refused.
- A seat leg under a charter outbound is refused, and so is a charter leg under a seat outbound.
- The boat is chartered on the nights between: `GET /v1/availability` leaves its seats out, and a
  second charter of it there is `409`.
- `verify:import` after re-importing: bookings present 18 → 16 missing (the 16 B2C rows), charter
  pax and month totals match.
