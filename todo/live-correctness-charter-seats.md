# Correctness bugs in the charter seat path

Both found on 2026-08-26 while checking the legacy `allotment_v2` frontend against this
backend. **Bug 1 was fixed on 2026-08-28 by migration 007; bug 2 is still live.**

The only booking in the production database is a charter booking, so it is the exact shape
that triggers bug 1 and sits on the deployment that triggers bug 2:

```
booking_9719ee2e-98bc-4f5e-9f70-368210d2ede9
  route_id r10 · service_date 2026-08-07 · pax 13 · allocated_pax 0 · booking_mode charter

deployments
  boat_id b13 (Oceanus) · route_id r10 · capacity 38 · license_pax 45 · total_capacity 48
```

---

## 1. `partial-cancel` on a charter booking returns 500, and the two stores disagree — FIXED

Fixed on 2026-08-28, not by patching either store but by removing what they disagreed about.
`allocated_pax` was a second copy of the passenger count, and migration 007 deleted the column:
the seats a booking holds are now derived from its trip rows and its status, in `bookingView`,
which both stores call. There is no stored number left to drive negative and no second
implementation to diverge from.

Partial-cancel now reduces the head count and leaves the charter drawing on the charter ceiling,
which was the second of the two options weighed below. Locked in by *"partial-cancelling a charter
reduces the head count without touching the seat pool"* in `test/booking-source.test.ts`, which
passes against both stores.

The original report follows, since the reasoning about what partial-cancel means for a charter is
still the reason the current behaviour is what it is.

---

`POST /v1/bookings/{id}/partial-cancel` crashes for any charter booking.

A charter takes a whole boat rather than seats, so `createBooking` deliberately stores
`allocated_pax = 0` while `pax` holds the head count
(`src/domain/operations.ts`, `createBooking`). `partialCancel` then decrements both:

```sql
-- src/domain/postgres-operations.ts · partialCancel
UPDATE bookings SET pax = pax - $2, allocated_pax = allocated_pax - $2 WHERE id = $1
```

For the live booking that is `allocated_pax = 0 - 2 = -2`, which violates
`CHECK (allocated_pax >= 0)` from `migrations/001_operations.sql`. The request fails with a
500 rather than a 400 or 409, and the transaction rolls back.

The in-process store does not crash — it does something different and also wrong:

```ts
// src/domain/operations.ts · partialCancel
booking.pax -= paxToCancel;
booking.allocated_pax = booking.pax;   // charter booking silently starts consuming seats
```

So the same request 500s against PostgreSQL and succeeds against the in-process store while
converting a charter into a seat consumer. Any fix has to land in both stores, and the
existing suite will not catch a regression because it only exercises the in-process store
unless `DATABASE_URL` is set.

**Decide first:** what does partial-cancel even mean for a charter? A charter reserves the
boat, so removing two passengers returns no seats to the pool. The two defensible answers:

- reject it with a 400 (`partial cancellation does not apply to a charter booking`), or
- reduce `pax` only and hold `allocated_pax` at 0.

Whichever is chosen, `allocated_pax` must never be driven below zero, and the two stores must
agree. Add the charter case to `test/operations.test.ts` and run it against both.

## 2. The charter ceiling is a crew-inclusive figure, so charters can be sold crew seats

`total_capacity` is not a passenger capacity. Checked against the legacy production database
on 2026-08-26, it is **passengers plus crew**, and the identity holds for all 15 boats that
carry a licence with no exceptions:

```
 id  | name          | cap | licensepax | crew | totalcap | licensepax + crew
 b13 | Oceanus       |  38 |         45 |    3 |       48 | 48   ✓
 b1  | Aluminous1    |  64 |         75 |    5 |       80 | 80   ✓
 b3  | Okeanos       |  56 |         75 |    4 |       79 | 79   ✓
```

So legacy carries three distinct numbers per boat:

| Field | Meaning |
| --- | --- |
| `cap` | company sellable cap — a commercial decision |
| `licensepax` | registered **passenger** maximum — the legal ceiling |
| `totalcap` | `licensepax + crew`, total persons aboard from the vessel registration |

`totalcap` was imported into our `deployments.total_capacity`, which the charter path then
uses as a selling ceiling:

```ts
// src/domain/postgres-operations.ts · assertCapacity
const available = charter
  ? capacity.total_capacity - capacity.booked_pax - capacity.charter_pax - capacity.locked_pax
  : capacity.available_seats;
```

On the live deployment that is 48 for b13, a boat registered for 45 passengers and 3 crew. A
charter can therefore be sold 48 passenger seats — the 3 extra being the crew's. This is a
category error rather than an off-by-a-few: no passenger limit anywhere equals 48.

The correct passenger ceiling is `license_pax`, which is stored, returned by
`listDeployments`, and used in no calculation anywhere.

Legacy clamps at the source when it builds a day's capacity
(`db/migrations/020_v_seat_availability_trips_boat.sql`), and never consults `totalcap` for
selling at all:

```sql
LEAST(COALESCE(o.cap, bo.cap), COALESCE(NULLIF(bo.licensepax, 0), bo.cap))
```

A per-day capacity override may lower a boat's capacity but never raise it above the licence.
The frontend applies the same clamp on read, commented
*"เพดานแข็ง · ห้ามเกินที่นั่งจดทะเบียน"* — hard ceiling, must not exceed registered seats
(`allotment_v2.html`, `boatCapInfo`).

Note `NULLIF(licensepax, 0)` and the `COALESCE` fallback: three Ranong boats (Tri Star 01,
Tri Star 02, and a test boat) have no licence recorded at all, so any clamp must fall back to
`cap` rather than treating a missing licence as zero.

**The fix is to stop using `total_capacity` as a selling ceiling.** Charter headroom should
come from `license_pax` with a `cap` fallback. Whether `total_capacity` is worth keeping at
all is a separate question — it is a registration fact with no role in selling, so it is
probably documentation rather than a capacity field, and the column name actively invites the
mistake. A `CHECK (capacity <= license_pax)` would make the real invariant unrepresentable,
but the existing production row must be corrected first.
