# Vans

Van assignment for the ops board's van mode. The contract comes from the frontend hand-off:
`operation_frontend/apps/web/docs/handoff/van-endpoints.md`. Its §8 checklist is the definition of
done.

## Where it stands

- **Step 0: booking model.** Done in migration 015: trip `zone`, `pickup_time`, OVN fields, and one
  trip per route per day.
- **Step 1: trip ids survive edits.** Done: `planTrips`. A trip is matched by explicit `id`, else by
  route and day. The hand-off asked for route-and-day matching only; explicit ids were added on top,
  so the frontend can move a trip and keep it.
- **Step 2: schema and import.** Done in migration 016 and `src/tools/import-legacy.ts`.
  - Still open: apply it on the shared database and run the import there.
- **Steps 3 to 6** (the board read, the writes, error codes, live updates) are not started.

## Decisions made in step 2, and why

- **013 is left as written, and 016 reshapes its table.** Nobody could say whether 013 had been
  applied to a shared database. Leaving it untouched means a database that already has it and a
  fresh one end up the same. No code ever wrote to the table.
- **All times of day are ISO `HH:MM`** (`isIsoTime`, `src/domain/calendar.ts`), with a CHECK on
  each column.
  - Legacy's free text is normalised by the import: `8:30`, `06.30` and `07:30:00` are rewritten.
  - Ranges such as `07:30-07:45` are dropped and counted, rather than picking one end.
- **Status ranges are their own table** (`van_status_ranges`), not expanded into `van_days`. Legacy
  ranges can be open-ended (`to` empty), which can't be expanded.
- **`van_days.status` allows `available`**, because legacy uses it to override a range for one day.
  The hand-off schema only allowed `off`/`maintenance`, which would have lost that override.
- **Moving a trip clears its van data** (`movedTripIds`; hand-off R15).
  - "Moving" means a kept trip whose route or day changed.
  - Its allocations and `booking_trip_operations` row are deleted; the trip keeps its id.
- **Import: groups are keyed on legacy (date, route, effective zone, number).**
  - If members disagree on the van, the group is imported with **no van** and listed under "van
    group conflicts". The import never picks a van.
  - A number that repeats across zones is renumbered and listed the same way.
- **Import: some legacy van data is not carried over.**
  - A cancelled booking's van data: rule R1 excludes cancelled bookings from van assignment.
  - A van set on a passenger with no group: in the new model the van lives on the group.
  - A group on a self-arrive trip.

  Each is counted in the import's notes.

## Open, for the steps ahead

- **Effective zone needs the booking's add-ons.** A private-van add-on moves a NoTransfer seat into
  a van zone (R9). The import reads legacy add-ons, but the backend does not model add-ons. The
  board (step 3) cannot compute the zone for a booking created through the API until it does.
  Decide before step 3.
- **Allocations can exceed the trip's pax after an amendment.** If a booking's pax shrinks, its
  split allocations are not shrunk. The hand-off says to shrink idx 0 first; do it with the writes
  (step 4).
- **A group can be left empty** when its last member's trip is removed or moved. Legacy groups had
  no rows, so they disappeared by themselves. Decide in step 3 whether the board hides empty groups
  or the write deletes them.
- **Group numbers need the advisory-lock pattern** that capacity uses, keyed `van:<date>:<route>`,
  once groups are created through the API (step 4).
- **Before `--commit` on production,** run a dry run and read three lists: skipped bookings (the
  itinerary rules from step 0), van group conflicts, and the notes.
