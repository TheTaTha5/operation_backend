# Booking add-ons: what is still open

`booking_addons` (migration 018), its parser (`src/domain/booking-addons.ts`) and the contract
(`README.md` → "Add-ons") exist. What follows is not done.

## The importer does not bring add-ons

`src/tools/import-legacy.ts` reads only `sb_bookings__addons.type`, to work out a van zone
(`groupZone`). It imports no add-on rows, so every legacy booking arrives with `add_ons: []`.
Legacy storage: `sb_bookings__addons` (`sb_bookings_id`, `idx`, `type`, `label`, `amount`, `qty`,
`note`, `jad`, `jchd`); `jad`/`jchd` NULL means "count every passenger".

## Data check — not run

Run read-only against legacy before adding any constraint to `booking_addons`:

```sql
-- size and coverage
SELECT count(*) AS rows, count(DISTINCT sb_bookings_id) AS bookings FROM operation_schemas.sb_bookings__addons;
SELECT max(n) AS max_per_booking FROM (SELECT count(*) n FROM operation_schemas.sb_bookings__addons GROUP BY sb_bookings_id) x;

-- type: distinct values and spread (confirms the "open set, no enum" call)
SELECT type, count(*) FROM operation_schemas.sb_bookings__addons GROUP BY type ORDER BY count(*) DESC;
SELECT count(*) FILTER (WHERE type IS NULL OR btrim(type) = '') AS blank_type FROM operation_schemas.sb_bookings__addons;

-- qty: would CHECK (qty >= 1) hold?
SELECT count(*) FILTER (WHERE qty IS NULL) AS qty_null, count(*) FILTER (WHERE qty < 1) AS qty_below_1 FROM operation_schemas.sb_bookings__addons;

-- amount: negatives, NULLs
SELECT count(*) FILTER (WHERE amount IS NULL) AS amount_null, count(*) FILTER (WHERE amount < 0) AS amount_negative FROM operation_schemas.sb_bookings__addons;

-- join counts: only on longtail-join? any negatives?
SELECT type, count(*) FROM operation_schemas.sb_bookings__addons WHERE jad IS NOT NULL OR jchd IS NOT NULL GROUP BY type;
SELECT count(*) FROM operation_schemas.sb_bookings__addons WHERE jad < 0 OR jchd < 0;

-- duplicates of one type on a booking (the B2B toggle prevents them; does B2C?)
SELECT count(*) FROM (SELECT sb_bookings_id, type FROM operation_schemas.sb_bookings__addons GROUP BY 1,2 HAVING count(*) > 1) d;

-- does the sum of line amounts match pricebreakdown_addon? (shows how often price_addon cannot be derived)
SELECT count(*) AS bookings,
       count(*) FILTER (WHERE s.total <> coalesce(b.pricebreakdown_addon, 0)) AS mismatched
FROM (SELECT sb_bookings_id, sum(coalesce(amount,0)) total FROM operation_schemas.sb_bookings__addons GROUP BY 1) s
JOIN operation_schemas.sb_bookings b ON b.id = s.sb_bookings_id;

-- orphans
SELECT count(*) FROM operation_schemas.sb_bookings__addons a LEFT JOIN operation_schemas.sb_bookings b ON b.id = a.sb_bookings_id WHERE b.id IS NULL;
```

Constraints that wait on these results: `CHECK (qty >= 1)`,
`CHECK ((join_adults IS NULL AND join_children IS NULL) OR type LIKE 'longtail-join%')`,
`CHECK (join_adults >= 0 AND join_children >= 0)`, `CHECK (amount >= 0)`, a possible
`UNIQUE (booking_id, type)`, and whether `type NOT NULL` survives blank legacy types.

## Open

1. **B2C does not send join counts.** `b2cMapAddOns` (legacy) writes the adult/child split into
   `label` and leaves `jAd`/`jChd` unset, so B2C longtail-join rows have NULL join counts ("count
   every passenger") even when B2C knew the number. A fix in the other repo; it explains NULLs in
   the data check.
2. **Edits re-price B2B add-ons.** Legacy's B2B save recalculates `label`/`amount` from the
   *current* rate type on every save, so an amendment silently changes an old add-on's price. This
   API stores what it is sent; the quote (`todo/pricing-model.md`) decides who prices add-ons.
3. **One entry per type?** The B2B UI guarantees it, B2C may not. Decide after the duplicate count.
