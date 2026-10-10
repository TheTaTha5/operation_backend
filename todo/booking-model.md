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

Attachments, the allergy list, the document check and the pickup-area catalogue are designed in
`booking-extras-model.md` (waiting for approval). Alternate pickups are built.

## The blob is being deleted

No overflow column survives: a field the frontend sends is either modelled or dropped, and dropping
it is the signal that it needs modelling. The blob is no longer written (since 2026-09-22), but:

1. **Stop returning `booking_data`** in responses. A contract change: tell the clients
   (`README.md` already calls it deprecated).
2. **Drop the column**, once nothing reads it.

## Not built yet, deliberately

- **No FK from `booking_trips.charter_boat_id` to `boats`.** Add it together with one on
  `deployments.boat_id`.
- **Historical charters on multi-boat days have `charter_boat_id` NULL**; they subtract their
  passengers from the pool instead. Count them on production before repairing by hand.
- **No `UNIQUE (booking_id, route_id, service_date)`**: the API and the import enforce it. Count the
  violations on production first (the import's dry run lists them as skipped bookings).
- **Unbuilt fields:** `ovn_charge`, `subtotal`, the charter pricing fields,
  `seats_locked`/`seats_general`. They come with the quote.

## Open after the 2026-10-10 decisions

The ten differences from legacy were decided and built (README "Bookings"). Three edges are left:

1. **A booking with no agent is not refused for no rate.** Legacy cannot make one (it needs an agent
   and a rate type before Save); this API allows `agent_id` to be absent, and such a booking is saved
   at ฿0 with the warnings, as before. Requiring an agent is a separate decision.
2. **A restore still refuses a day the route no longer runs** (`409 route_closed`). Legacy's restore
   checks no calendar; the decision named the taken boat and the seats only.
3. **A trip that sends `charter_displaced_at`/`_by` is not refused**: they are ignored and the
   server's stand, as a trip's `subtotal` and `rate_type_id` are. CLAUDE.md wants a server-owned field
   that differs refused with `400`; trips have never been checked that way.
