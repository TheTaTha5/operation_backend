# The booking, de-blobbed: what is still open

The booking used to live in `bookings.booking_data JSONB`, the frontend's whole document. Most of it
is now tables and columns (migrations 007–018, 023, 024; `docs/schema.md`). This lists what is not.
The shape comes from what the frontend constructs on save: `const newBk = {` in
`allotment_v2/js/08-app.js` of wt-lk-inbox (search for the symbol; line numbers drift).

## The rule

**A repeating group becomes a table. A fixed-size struct becomes columns. Nothing stays JSONB.**

Fixed-size means the frontend writes exactly these keys and adding one is a schema change either
way: `guides {english, russian, chinese, otherLang}` is four columns, not a collection.
`passengers[]` is unbounded, so it is a table.

## Tables not built yet

### `booking_attachments`

```
id, booking_id, name, mime, size, kind, uploaded_by, uploaded_at
```

### `booking_special_meal_allergies`

```
booking_id, seq, name, qty
```

The `allergies` free text stays on `bookings`; `allergyList` is the structured version the kitchen
counts from.

### Alternate pickups

Built (migration 037, README → "Alternate pickups").

### `docCheck`

The saved field is `bk.docCheck`, written by `docCheckToggleItem`, `docCheckSetStatus`,
`docCheckSetNote` and `docCheckRunPre` in `08-app.js`:
`{status, by, at, note, items{route,date,lead,pax,voucher,payment}, pre}`. Ready to model; it is
dropped on every save today. (`_docCheck` is the page's view state, never saved.)

## The blob is being deleted

No overflow column survives: a field the frontend sends is either modelled or dropped, and dropping
it is the signal that it needs modelling. The blob is no longer written (since 2026-09-22), but:

1. **Stop returning `booking_data`** in responses. A contract change: tell the clients
   (`README.md` already calls it deprecated).
2. **Drop the column**, once nothing reads it.

## The area catalogue does not exist

`pickup_area_id` and `dropoff_area_id` (011) are plain `TEXT` pointing at nothing: there is no
`areas` table. The way out is the one `route_id` took (005 catalogue, 006 seed, 008 FK), but we do
not own the list yet: whether ids are stable, who edits them, whether an id is unique across zones.

**Next step is a dry run, not a migration:** the distinct area ids in legacy's bookings, checked
against what the frontend treats as the area list.

The name columns (`pickup_area`, `pickup_zone`, `dropoff_area`) are snapshots of what the area was
called that day, like `market`. They stay as they are whatever happens to the ids.

## Not built yet, deliberately

- **No FK from `booking_trips.charter_boat_id` to `boats`.** Add it together with one on
  `deployments.boat_id`.
- **Historical charters on multi-boat days have `charter_boat_id` NULL**; they subtract their
  passengers from the pool instead. Count them on production before repairing by hand.
- **A lock draw does not check the lock's agent against the booking's** (legacy's
  `holderType`/`holderId` suggests it should).
- **No `UNIQUE (booking_id, route_id, service_date)`**: the API and the import enforce it. Count the
  violations on production first (the import's dry run lists them as skipped bookings).
- **Unbuilt fields:** `ovn_charge`, `subtotal`, the charter pricing fields,
  `seats_locked`/`seats_general`. They come with the quote.
