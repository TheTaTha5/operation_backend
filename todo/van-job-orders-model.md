# Van job orders: what is still open

Built on `feat/van-job-orders` (migration 080): README → "Van job orders", "Van groups" (the order),
"Vans and the month matrix"; handoff §3.4b. The legacy read (wt-lk-inbox@658298d) and the design are
in git history (`docs: van job orders design`).

Decided 2026-10-09 and built: the server builds the job list and the sheets; "sent" per job, keyed
by the van group; a change after sending keeps the tick and is flagged `changed_since_sent`; the
special request is the booking's `job_note`, read by check-in and the pier as `special_request`;
Thai names in `pickup_name_th`; the group order stored and followed by the job orders; template and
row highlights are the client's (`vanjob_th_flag` dropped); `operations` for writes; not in the
change feed.

## Open

1. **A booking moved to another day after its sheet went out.** Legacy keeps a snapshot
   (`ops_stranded`, `ckStrandMovedRows`) and prints the row struck through on the old day's sheet
   ("เลื่อนวันแล้ว") until someone clears it. Here a moved trip loses its van parts and simply leaves
   the sheet; the job shows `changed_since_sent: true` if it had been sent. Building the struck row
   needs a home for the snapshot: say whether it is wanted.
2. **Check-in tags on the return sheet** (legacy §vjRetNS): "didn't travel, don't wait" when every
   passenger was a no-show, "missed the van this morning, return as normal". Not built: the sheet's
   rows carry no check-in yet. The check-in records are on every booking read, so a client can show
   them meanwhile.
3. **A booking's alternate pickups under its main row** (legacy lists `altPickups` in the main row's
   pickup cell). Not built: an alternate pickup prints as its own row once it is in the group.
4. **Return-only marks outlive their job.** A mark on a van that only brings people back stays when
   that run goes away (no row is shown for it). Harmless; clear them if it matters.
5. **The day's van board** (pools, return alerts across routes) is still
   `trip-ops-and-vans-model.md` 9.

## Flagged

Side effects, changes against legacy, and decisions made here (legacy followed where it could be):

- **`job_note: ""` prints nothing; `null` goes back to the notes.** The decision reads "empty = use
  the notes"; legacy's box stores `""` as "blanked" (5 of its 10 overrides), and that is kept. If
  `""` should mean "the notes", it is one parser line (`keptText` in `booking-header.ts`).
- **`changed_since_sent` compares a fingerprint of the sheet**, not update times (the note had
  suggested those): any change the driver acts on flags it, and undoing the change clears it.
  Marks imported from legacy have no fingerprint: `null` ("unknown").
- **Ticking a sent job again re-sends it** (new time, new fingerprint); legacy's tick toggled.
- **`sent_at` left the van day:** `PUT /operations/van-days/…` with `sent_at` is now `400` naming the
  new command. Breaking for the legacy integration client (handoff §3.4).
- **Migration 080** copies each van-day mark onto every group that van had that day (a van on two
  routes gets both marked), then drops `van_days.sent_at`. Re-import puts the marks per job.
  Rehearsed on synthetic 047-era rows.
- **`special_request` is computed on every booking read.** Sent back on `PATCH`, it is ignored, as
  `allergy_count` is (legacy's integration echoes whole bookings), not refused.
- **`GET /operations/van-groups` order changed:** zone (PK, KL, RN, NoTransfer, others), then the
  dragged order, then number; it was by number across zones.
- **A cancelled booking's van parts can be cleared** (`PATCH /operations/trip-ops/{trip}` with only
  `{van_parts: null}`), the one dispatch change it still takes: legacy's "ล้างออก" for a struck row.
  Every other dispatch change on it stays `409 cancelled`.
- **The job's `pax` and `over_capacity` count guides riding out**, as van groups do; legacy's job
  list counted customers only (its sheet footer adds them).
- **A group with only van stops is a job**, and counts as a round.
- **Return-leg van stops** of all the van's groups on the route print on round 1's sheet; legacy
  kept only round 1's group's.
- **Untimed rows sort last.** Legacy meant that too, but its final `localeCompare` sorts `~` before
  digits.
- **A manual split row is labelled `manual`;** legacy labels it "แยกส่ง" (separate drop-off).
- **`pickups`** on a job lists every place its sheet prints as a pickup, the pier included.
- **The job returns the van's `ownership`** (`own`, `rented`, `partner`); legacy's tag showed rented
  vans as company vans (its bug 6), which the client need not repeat.
- **`zone_th`** comes from legacy's fixed `VANJOB_AREA_TH` list, copied into `van-jobs.ts`.
- **"No van back yet" is per trip**, not per booking's first trip that day.
- **Group order is not pruned** after 45 days as legacy's is: it lives on the group rows.
- **Import (rehearsed 2026-10-09 on a throwaway database):**
  - sent marks: 438 of 449 (4 on return-only runs). 1 dropped because that van now runs the
    programme twice that day (legacy shows it unsent, its bug 2); 10 because the import left the van
    off its group (members on different vans, a van on an ungrouped passenger, or a cancelled
    booking, whose van data is not imported). All 438 show on the imported days' job lists.
  - special requests: 10 (5 blanked).
  - Thai names: 760 of 762 (two pairs differ only in case, same Thai). **Replaced whole on every
    import** while legacy is master: a name typed here before cutover is lost on the next run.
  - group order: 63 groups on 13 days; 18 entries dropped (groups the import has no row for).
