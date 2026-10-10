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

## Differences from legacy to confirm

Booking rules this API already decides, but not the way legacy does, and that no other note
records (`legacy-browser-rules.md` Findings 2). Nothing here is changed yet. For each: say **yes**
(keep this API's behaviour) or **fix** (copy legacy, or the recommendation). Legacy is wt-lk-inbox
`allotment_v2/js/08-app.js`; search the function name.

1. **A trip with no price.** Legacy disables Save ("⚠ No rate · N trips · cannot save") when a
   rate-priced trip has no rate for its route and zone (`bkV2NoRateTrips`,
   `bkV2RenderSubmitButton`); a manual price or a B2C booking is exempt. A charter with no charter
   rate asks "saved at 0 THB, really free?" first (`bkV2SubmitBooking` §chManualNoRate). This API
   saves the trip at ฿0 and answers a `no_rate` or `not_offered` warning (`pricing.ts priceBooking`),
   and `no_charter_price` after the save. **Recommend fix:** refuse a create or price-changing edit
   with `409 no_rate` (same exemptions); keep `POST /v1/quote` answering warnings only; for the
   charter, refuse `409 no_charter_price` unless `free_anyway: true` (legacy's OK).
2. **Restore when the boat or the seats are gone.** Legacy always restores to `confirmed`: a
   charter boat another booking took is left unlocked with a "re-plan" history line and toast, lock
   shortfalls are logged, and capacity is never checked (`bkV2RestoreBooking`). This API refuses
   `409 charter_boat_taken`, and `409` when general seats cannot take what the locks no longer have
   (`POST /v1/bookings/{id}/restore`). **Recommend fix, with a guard:** keep the refusals but accept
   `restore_anyway: true` (as `remove_anyway`), which restores and answers the problems as warnings;
   that is legacy's outcome without restoring blind.
3. **Chartering a boat that has seats sold on it.** Legacy shows the displacement dialog (seats sold,
   available after, oversold by) and on Confirm sets the boat and stores
   `charterDisplacementAck: true` on the trip (`bkV2SetTripCharterBoat`, `bkV2ConfirmCharter`): the
   day is oversold on purpose. This API refuses the charter when the pool cannot lose the boat
   (`capacity.ts assertDayFits`/`weighDay`, `409 Insufficient available seats`). **Recommend fix:**
   accept `displace_anyway: true` and record the acknowledgement on the trip (a schema change: one
   column), so ops can still do what legacy allows, knowingly.
4. **A quote holds its charter boat.** Legacy's quote does not claim the boat in Boat Operation
   (`bkV2CommitBooking`: the `TRIPS` charter lock is written only when `status !== 'quote'`), so the
   boat can still be pulled off the route. Its seat pool still treats the boat as chartered
   (`baCharterBoatMap` skips only cancelled, rejected and weather-cancelled bookings). This API's
   quote holds the boat everywhere: out of the pool, `409 charter_boat` on pulling it.
   **Recommend yes:** the pool already matches legacy; the only loss is pulling a boat out from under
   a quote, which would strand it.
5. **A discount with FOC passengers.** Legacy asks the salesperson's discount approval only when the
   save would otherwise be `confirmed` (`bkV2CommitBooking`, `status==='confirmed' && _discAmt>0`); a
   booking with FOC goes to `pending_foc`, and approving the FOC confirms it with the discount never
   approved. This API asks both (`booking-approvals.ts decideStatus`). **Recommend yes:** legacy's
   order lets a discount through unapproved, which looks like a gap, not a rule.
6. **An edit does not ask again for FOC or discount approval.** Legacy's Update re-runs the whole
   save (`bkV2SubmitBooking` → `bkV2CommitBooking`): a discount is re-asked on every confirm save,
   FOC passengers send it to `pending_foc` (an approved FOC stays). This API's `PATCH` re-weighs the
   allotment only (`reweigh`); a discount or FOC passengers added by an edit to a confirmed booking
   need no approval. The discount part is noted only in a code comment (`booking-approvals.ts`).
   **Recommend fix, narrower than legacy:** ask again only when the edit raises the FOC count or
   the discount above what was approved; an unchanged booking is not re-asked.
7. **Editing a closed booking.** Legacy asks "This booking is cancelled. Edit anyway?" for
   cancelled, completed and rejected bookings, and lets a weather-cancelled one through without
   asking (`bkV2EditBooking`). This API refuses all four with `409 booking_closed`
   (`booking-actions.ts assertEditable`). **Recommend fix:** accept `edit_anyway: true` for the
   three (legacy's dialog) and let `cancelled_weather` through. The usual checks still apply to
   what the edit changes; a cancelled, rejected or weather-cancelled booking holds no seats.
8. **Save Draft on a live booking turns it back into a quote.** Legacy's Save Draft on a confirmed
   or pending booking asks to confirm, then saves it as `quote`, which drops it from the van and boat
   job sheets (`bkV2SaveDraft`). This API has no command for it (`PATCH` may not change the status).
   **Recommend fix:** a command, e.g. `POST /v1/bookings/{id}/unconfirm`, from `confirmed`,
   `pending_foc` or `pending_approval` to `quote`, with a history line; the client keeps legacy's
   confirm dialog.
9. **Booking ids.** Legacy numbers a booking `BK-YYMMNNNN-XXXX`: month, sequence, random suffix
   (`bkV2GenerateBookingCode`). This API's are `booking_<uuid>`, documented nowhere. **Recommend
   yes,** and document it: legacy's own comment says the sequence is not unique across browsers. If a
   screen shows the code to staff or agents, add a server-numbered `code` (as invoice numbers are).
   (Findings 2 counts nine, this one included.)
