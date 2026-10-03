# Booking add-ons, modelled

## Shipped — 2026-10-03

Migration `018_booking_addons.sql`, `src/domain/booking-addons.ts` (`parseBookingAddOns`), both
stores, `POST`/`PATCH /v1/bookings` and every booking read. Documented in `README.md` →
"Add-ons". Tested by `test/booking-addons.test.ts` on the in-process store and on PostgreSQL.

Open questions settled as this note proposed: a negative `amount` is refused (discounts belong in
`adjustments`); the response key is `add_ons`; no one-entry-per-type rule until the duplicate count
is in. Still open: the data check below, the blob question (Open 1), and the follow-ups.

- **Source:** wt-lk-inbox@ce9769a. Every writer of a booking's `addOns[]`:
  - `allotment_v2/js/08-app.js` `const newBk = {` (the booking-v2 save, the one inside
    `addOns: d.addOns.map(a => {`): builds `{type, label, amount, qty, note}` and adds
    `jAd`/`jChd` only when `type === 'longtail-join'`. `label` and `amount` are recalculated by
    `bkV2AddOnInfo(type)` from the rate type *every time it saves*, edits included.
  - same file, the edit path for B2C bookings (`if(bkV2IsB2CBk(editing))` →
    `newBk.addOns = JSON.parse(JSON.stringify(editing.addOns || []))`): copies the stored rows
    exactly as they are, with no recalculation.
  - same file, the draft that feeds both of the above: `bkV2ToggleAddOn` (pushes
    `{type, qty:1}`, and `jAd`/`jChd` for longtail-join), `bkV2SetAddOnQty`, `bkV2SetAddOnNote`.
    The toggle keeps **at most one entry per `type`**.
  - `b2c-map.js` `b2cMapAddOns` (the B2C sync, called from `server.js`): builds
    `{type, label, amount, qty, note: ''}` from `details.addonsSelected`. It **never sets
    `jAd`/`jChd`**, even though B2C has sent `qtyAdult`/`qtyChild` since 2026-08-06. It writes that
    split into the label text instead (`"Longtail Join (2A + 0C)"`).
  - The other `const newBk = {` (the old `_bkDraft` form near `bkRenderRecent`) writes no
    `addOns` at all.
  - Legacy storage: `os-backend/src/mapping/field_mapping.json` → `sb_bookings__addons`
    (`sb_bookings_id`, `idx`, `type`, `label`, `amount` bigint, `qty` bigint, `note`, `jad`, `jchd`).
    `jad`/`jchd` were added by legacy `db/migrations/031_addon_join_pax.sql` (2026-09-15), where
    NULL means "nobody narrowed it down, count every passenger".
- **Already here:** no table, column or parser for add-ons. What does exist nearby:
  - `bookings.price_addon` (migration 011, `src/domain/booking-header.ts`): the add-on **total**
    saved with the booking (`priceBreakdown.addOn`). It stays. See "Derived" below for why the rows
    do not replace it.
  - `src/tools/import-legacy.ts` reads `sb_bookings__addons.type`, but only to work out a van zone
    (`groupZone`). It does not import the add-ons.
  - `todo/legacy-replacement.md` §4 proposes `PUT /v1/bookings/{id}/add-ons`. This note settles
    that as fields on the booking endpoints instead (see Contract).

## Why add-ons are lost today (worse than "not modelled")

There are two problems, and the first one is wider than add-ons:

1. **The blob stopped being written on 2026-09-22.** Commit `49cdefa` ("Add booking pagination and
   live API docs") changed `booking_data: input,` to `// booking_data: input,` in `bookingInput()`
   (`src/routes/operations.ts`). Since then `POST /v1/bookings` saves `booking_data = {}`
   (`PostgresOperationsStore.createBooking` writes `input.booking_data ?? {}`). Until that commit,
   every field this backend does not model, add-ons included, was at least kept in the blob.
   Now all of them are thrown away on create. `PATCH` has never written the blob.
   - `README.md` is wrong about this. It says `booking_data` "still holds the payload exactly as it
     was sent at create time".
   - `test/booking-source.test.ts` has been failing since that commit. Checked on 2026-10-03 with
     `node --import tsx --test test/booking-source.test.ts` (in-process store only, no database):
     5 passed, 1 failed with `TypeError: Cannot read properties of undefined (reading 'passengers')`
     at line 32 (`created.booking_data.passengers[0].name`).
   - This slice does **not** propose turning the blob back on. The decided rule is that dropping an
     unmodelled field is the signal to model it. But this decision is yours: `adjustments`,
     `altPickups`, `focApproval`, `approval` and every other unmodelled field are being lost in the
     same way right now.
2. **Add-ons have no home here.** Even with the blob, nothing could read them except by
   re-parsing the JSON.

## Correction to `todo/booking-model.md`

It says the document carries add-ons "at both levels (`newBk.addOns` and `trip.addOns`)" and so it
sketches a nullable `booking_trip_id`. **No writer produces `trip.addOns`.** Every `addOns` that is
not `bk.addOns` in the frontend is `rt.addOns`: the rate type's add-on *price list* (`longtail`,
`privateTransfer`), which is a catalogue and not something attached to a booking. Add-ons belong to
the booking only, so this design has no `booking_trip_id`. A private transfer does name a route,
but only inside its `type` string (`transfer-<routeId>-<zone>-<vehicle>`).
`booking-model.md` should be updated to point here when this is approved.

## Fields

| Frontend key | Bucket | Column | Note |
|---|---|---|---|
| `addOns[]` | Repeating group | table `booking_addons`, `(booking_id, seq)` | Unbounded array. Order kept as `seq` (legacy `idx`). |
| *(position)* | Scalar | `seq INTEGER` | Position in the array. Same pattern as `booking_passengers.seq`. |
| `type` | Scalar (a code with no catalogue behind it) | `type TEXT NOT NULL` | The identity that ops matches on (`longtail-join`, `longtail-charter`, `longtail-charter-3`, `longtail-charter-7-9`, `transfer-r5-PK-van`, `join-transfer-phuket`, `b2c-ad-001`…). It is an open set and legacy `sb_addon_types` is empty, so there is **no FK and no enum CHECK**. Every writer sets it, so it is NOT NULL (pending the data check). |
| `label` | Display snapshot | `label TEXT` | The name worked out at save time, sometimes with the quantity baked in (`"Longtail Charter × 2 ลำ"`, `"Longtail Join (2A + 0C)"`). Kept as written. A change to a rate type must not rewrite old bookings. |
| `amount` | Scalar (money) | `amount NUMERIC(12,2)` | The **line total** (`info.total * qty`), not a unit price. It can be 0 when B2C sent several lines it could not split, and in that case `price_addon` holds the money. |
| `qty` | Scalar | `qty INTEGER` | Boats for `longtail-charter`, vehicles for `transfer-*`, extra **people** for `longtail-charter-7-9` (see `bkV2LtAddOnKind`). B2B and B2C always write ≥ 1. Nullable because of legacy rows, and the CHECK waits for the data check. |
| `note` | Scalar | `note TEXT` | B2B trims it, B2C always sends `''`. The API stores blank as NULL, the same way header text fields work. |
| `jAd` | Scalar | `join_adults INTEGER` | Only on `longtail-join`. NULL has a meaning: "not narrowed down, count every adult" (legacy 031). It must never default to 0. |
| `jChd` | Scalar | `join_children INTEGER` | Same as above, for children. |
| line sum vs `priceBreakdown.addOn` | Derived, but **not** derivable | none (stays as `bookings.price_addon`) | The sum of `amount` does not reliably equal what was charged: (a) B2B saves a non-zero `amount` on a `longtail-join` line even when a route bundle makes `bkV2CalcQuote` skip it, and (b) B2C multi-line orders save 0 per line. So `price_addon` stays a stored snapshot and nobody should compute it from the rows. |

No Overwritten-record or Unknown fields. All the keys any writer emits are listed above.

## Schema

```sql
-- 018_booking_addons.sql
--
-- A booking's add-ons: longtail join/charter, private transfers, B2C extras.
--
-- `addOns[]` is unbounded, so it is a table, not columns: see the rule in `todo/booking-model.md`
-- and the design in `todo/addons-model.md`. Add-ons belong to the booking only. No frontend writer
-- puts add-ons on a trip, so there is no booking_trip_id. A private transfer names its route
-- inside `type` (`transfer-<routeId>-<zone>-<vehicle>`).
--
-- `type` is the code operations matches on. It is an open set with no catalogue (legacy
-- sb_addon_types is empty and B2C sends its own codes), so it has no FK and no enum CHECK.
--
-- `label` is a display snapshot: what the add-on was called, and sometimes how many, on the day it
-- was sold. A later change to the rate type must not rewrite it.
--
-- `amount` is the line total at save time. It is NOT guaranteed to add up to
-- bookings.price_addon: a bundled longtail-join keeps an amount it was not charged, and a
-- multi-line B2C order stores 0 per line with the money in price_addon.
--
-- join_adults / join_children: longtail-join only. NULL means nobody narrowed it down and readers
-- count every passenger. That is the legacy meaning (its migration 031), so the columns have no
-- default.
--
-- Additive, with no constraints that describe legacy rows yet: the qty >= 1 and
-- join-counts-only-on-longtail-join CHECKs wait for the data check in todo/addons-model.md.

CREATE TABLE booking_addons (
  booking_id TEXT NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 0),
  type TEXT NOT NULL,
  label TEXT,
  amount NUMERIC(12,2),
  qty INTEGER,
  note TEXT,
  join_adults INTEGER,
  join_children INTEGER,
  PRIMARY KEY (booking_id, seq)
);

COMMENT ON COLUMN booking_addons.amount IS
  'Line total at save time (unit price × qty). Not guaranteed to sum to bookings.price_addon.';
COMMENT ON COLUMN booking_addons.join_adults IS
  'longtail-join only · adults actually taking the longtail · NULL = not narrowed down, count every adult';
COMMENT ON COLUMN booking_addons.join_children IS
  'longtail-join only · children actually taking the longtail · NULL = not narrowed down, count every child';
```

There is no index beyond the PK. Every read is by `booking_id`, which is the leading PK column.

## Contract

The field is part of the booking. There is no separate `PUT /v1/bookings/{id}/add-ons`.

- `POST /v1/bookings`: accepts `addOns` (the frontend's spelling) or `add_ons`. If it is absent,
  the booking has no add-ons.
- `PATCH /v1/bookings/{id}`: same keys. **Absent = unchanged. `[]` = clear. A list replaces the
  whole list**, the same way `passengers` and `trips` work.
- `GET /v1/bookings`, `GET /v1/bookings/{id}` and every booking response: `add_ons`, an array
  ordered by `seq`, `[]` when there are none.

Per entry, accepted keys: `type`; `label`; `amount`; `qty`; `note`; `jAd` or `join_adults`;
`jChd` or `join_children`.

Validation (`400`, each error names the field and its position, nothing is silently dropped):

| Input | Error |
|---|---|
| `addOns` present and not an array | `addOns must be an array` |
| an entry that is not an object | `addOns[2] must be an object` |
| `type` missing, blank or not a string | `addOns[2].type is required` |
| `amount` present and not a finite number | `addOns[2].amount must be a number` |
| `amount` negative | `addOns[2].amount must not be negative` *(to confirm, see Open)* |
| `qty` present and not an integer ≥ 1 | `addOns[2].qty must be a positive integer` |
| `jAd`/`jChd` present and not an integer ≥ 0 | `addOns[2].jAd must be a non-negative integer` |
| `label`/`note` present and not a string | `addOns[2].label must be a string` |

`null` or a missing optional key is stored as NULL. The API never fills in a value: no `qty`
defaulting to 1, no join count defaulting to 0. The validation is a pure function,
`parseBookingAddOns` in `src/domain/booking-addons.ts`, called by both stores' callers the way
`parseBookingPassengers` is.

Request:

```json
POST /v1/bookings
{
  "external_id": "BK-2030-0001",
  "trips": [{ "route_id": "r10", "service_date": "2030-01-04", "pax": { "ad_fr": 4 } }],
  "addOns": [
    { "type": "longtail-join", "label": "Longtail Join (2A + 0C)", "amount": 800, "qty": 1, "note": "", "jAd": 2, "jChd": 0 },
    { "type": "transfer-r10-PK-van", "label": "Transfer · Van PK", "amount": 1200, "qty": 1 }
  ]
}
```

Response (excerpt):

```json
{
  "id": "booking_…",
  "add_ons": [
    { "seq": 0, "type": "longtail-join", "label": "Longtail Join (2A + 0C)", "amount": 800, "qty": 1, "join_adults": 2, "join_children": 0 },
    { "seq": 1, "type": "transfer-r10-PK-van", "label": "Transfer · Van PK", "amount": 1200, "qty": 1 }
  ]
}
```

Keys whose value is NULL are left out of the response, the way `passengers` leaves out an
unset `nationality`. `note: ""` was stored as NULL, so it does not appear. `amount` comes back as a
JSON number. The Postgres mapper must convert `NUMERIC` (which `pg` returns as a string) the same
way `price_addon` is converted, so that both stores return the same thing.

## Data check — pending

`SOURCE_DATABASE_URL` was not set in this session, so no legacy database was queried. Run these
read-only queries against the legacy database before adding any constraint:

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

Constraints that depend on these results: `type NOT NULL` (already in the proposed migration;
drop it if blank types exist), `CHECK (qty >= 1)`,
`CHECK ((join_adults IS NULL AND join_children IS NULL) OR type LIKE 'longtail-join%')`,
`CHECK (join_adults >= 0 AND join_children >= 0)`, `CHECK (amount >= 0)`, and a possible
`UNIQUE (booking_id, type)`.

## Expand / contract

This slice does **add** and **write**:

- **Add:** migration 018 creates `booking_addons`, empty.
- **Write:** `POST`/`PATCH` write the table, and every booking read returns `add_ons`.
- **Dual-write:** not applicable as things stand. The blob is `{}` for every booking created
  since 2026-09-22 (see the top of this note), so nothing is written beside the table.
- **Backfill from `booking_data`:** only bookings created through this API before 2026-09-22
  carry `addOns` in their blob. A backfill would have to skip any booking that already has
  `booking_addons` rows (an amended booking has the correct rows beside a stale blob). Whether
  it is worth doing depends on how many such bookings exist in production. Count them first:
  `SELECT count(*) FROM bookings WHERE jsonb_array_length(coalesce(booking_data->'addOns','[]')) > 0;`
  Any backfill would be a separate migration, rehearsed against a restored copy as `CLAUDE.md`
  requires.
- Not this slice: stopping `booking_data` being returned, or dropping it.

## Open

1. **The blob regression (`49cdefa`).** Was commenting out `booking_data: input` deliberate? If
   so, `README.md` and `test/booking-source.test.ts` need to be updated to say so. If not, every
   unmodelled field is being lost on create, not just add-ons. Your decision. This slice does not
   change it.
2. **B2C does not send join counts.** `b2cMapAddOns` writes the adult/child split into `label`
   and leaves `jAd`/`jChd` unset, so B2C longtail-join rows will have NULL join counts
   ("count every passenger") even when B2C knew the real number. That is a frontend/sync fix in the
   other repo, not here. Listed because it explains NULLs in the data check.
3. **Edits re-price B2B add-ons.** The B2B save recalculates `label`/`amount` from the
   *current* rate type every time it saves. So an amendment silently changes an old add-on's
   price, which looks inconsistent with `price_addon`. This API stores what it is sent. It is
   flagged for the frontend.
4. **Negative `amount`.** No writer produces one. Should the API refuse it (proposed), or accept
   it so that refunds or credits could be written as add-on lines later? `adjustments` is the
   designed home for discounts, so refusing seems right.
5. **One entry per type?** The B2B UI guarantees it and B2C may not. Decide after the duplicate
   count.
6. **Should the response be called `add_ons` or `addOns`?** The proposal is `add_ons` because
   responses here use snake_case and inputs accept both spellings.

## Follow-ups

- `src/tools/import-legacy.ts` is not extended by this slice. Every legacy booking imported at
  cutover will have no add-ons until it is. (It already reads `sb_bookings__addons.type` for van
  zones, so the source query is half there.)
- `todo/booking-model.md`: replace the `booking_addons` sketch with a pointer here, and remove the
  `trip.addOns` claim.
- `todo/legacy-replacement.md` §4: strike `PUT /v1/bookings/{id}/add-ons` (settled as fields on
  the booking). The `GET /v1/add-ons` catalogue stays a separate, later item. The rate-type add-on
  price list (`rt.addOns`) belongs to the rate-types slice.
- `todo/vans.md` ("the backend does not model add-ons"): once this ships, effective van zone (R9)
  can read `booking_addons` instead of needing the import's side channel.
