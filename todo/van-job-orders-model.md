# Van job orders, legacy read

**Status:** legacy read (wt-lk-inbox@658298d, 2026-10-09); decided 2026-10-09; designed below
("Design"), being built on `feat/van-job-orders` (migration 080).

In short: a job order is the printed sheet a van driver gets for one van, one programme, one day
(one per round when the van runs the programme twice). Legacy builds it entirely in the browser
from bookings, van groups and van stops, then lets staff tick "sent to driver". Here the inputs
exist (vans, van groups, van stops, driver of the day, one `sent_at` per van and day). Four small
stores and the computed board/sheet do not:

- the per-round sent mark;
- the special-request override per booking;
- the Thai name per hotel;
- the drag order of groups.

## What legacy does

All in `08-app.js`. Every write below saves only with the `operations` edit area (the `*Persist`
functions return quietly otherwise).

### The Van Job Orders page (`renderVanJobs`, nav `vanjobs`, under Transfer Fleet)

- **Date** picker (default today, ‹ › and Today). Filters: owner (all / company / partner), route.
- **Hero banner:** passengers with no outbound van (red, "⚠ ยังไม่จัดรถ", by route), else
  bookings with no return van (amber, `bkV2RetInfo(...).alert`), else "✓ จัดครบแล้ว". A
  "self-arrive but still has a van or a transfer zone" list is shown as a warning (`selfWarn`).
- **One row per job.** A job is a van on one route that day: key `vanId~routeId`, plus `~group` only
  when that van runs **more than one round** on that route that day (`vjRoundAll`/`vjRoundPick`,
  §vjRound).
  - Rounds are numbered by **earliest pickup time**, not group number ("รอบ 1 / 2").
  - A return-leg job is a van that brings people back in a different van than took them; it never
    splits into rounds.
- **Row:** van (colour), owner tag, driver, phone (the day's override, else the registry), pax /
  seats with "เกินที่นั่ง" when over, routes, zones, the **sent-to-driver checkbox** with its time,
  and a full-screen button.
- **Sort:** programme departure time → programme → zone → group number → pickup sequence → van
  name (§vjOrder).
- **Cancelled but still arranged** bookings (`ckIsCxl` + `ckHasArrange`), and bookings moved
  to another day (`ckStrandMovedRows`), are counted separately (`sx`). On the sheet they print
  struck through, so the driver can compare the new sheet with the old one line by line.
- **Expanding a row** shows three editors:
  - **Driver of the day** (`vanJobsSetDriver`): driver, phone, and plate (partner vans only); empty =
    the registry's default; "↺ คืนค่าตั้งต้น" resets.
  - **① Thai name under the pickup** (`vanJobsSetPickupTh`): typed once per pickup **name**, used on
    every sheet with that pickup ("พิมพ์ครั้งเดียว ใช้กับทุกใบงาน").
  - **② Special request** per booking (`vanJobsSetSreq`): starts as the booking's `notes`; staff
    edit or blank it because "some requests aren't van-related"; "reset" returns to the notes.

### The sheet (`vanJobsOrderInner`, preview drawer, full screen, image `vanJobsSaveImage`)

- Bilingual EN/TH. Header: van, route, round, driver, phone, plate.
- Two tables, outbound and return:
  - **Outbound:** bookings this van picks up (`vanId`, or the round's group only), minus self-arrive
    ones.
  - **Return:** bookings whose return van is this van (`vanReturnId || vanId`), minus self-return
    ones and overnight outbound legs. Rows that came out in another van go last.
- Columns: #, Voucher, Lead name, Pax, Pick-up time, Pick-up location (with the Thai name), Room,
  Zone, Drop-off, Bags, Special request (the override, else notes), AD, CHD, INF, FOC.
- Van stops (guides, cargo) print as their own rows; their seats are summed apart from the
  customers'.
- **Row order:** manual `vanSeq` first, rows without one inserted by pickup time (§vsSeqTime),
  else by time.
- Presentation settings, shared by the whole company:
  - **template** `vanjob_tpl`: fonts, colours, use the van's colour;
  - **row highlights** `vanjob_rowhl`: a colour per `date|van|route|o/r|booking`, set by clicking
    rows.

### Sent to driver (`VANJOB_SENT`, `vanJobsToggleSent`)

- A checkbox per job row. Ticking stores the time, unticking deletes it. Key
  `<date>::<job key>`, i.e. `2026-10-06::veh17~r10` or, for a second round, `…~r10~3`.
- Nothing un-ticks it when the job changes after sending. The struck-through rows are the only
  sign.

### Group order (`bkv2_grp_order`, `bkV2GrpOrderSet`, §grpDrag 2026-09-30)

- On the By-trip tab (van mode), staff drag group headers to reorder them; "reset" clears.
  Refused without `operations` ("View-only: cannot reorder groups").
- Key `<date>::<routeId>::<zone>` → group numbers in the dragged order. Groups not in the list
  follow by number.
- **Display only:** group numbers, assignments, the job orders and check-in are not affected (the
  comment says so; the job-order sort uses group numbers). Shared by the whole team.
- Entries older than 45 days are pruned on each save.

### Other readers

- `vehJobsFor(date)`: per van, the bookings and pax it carries that day (any trip on the date with
  `ops.vanId` = the van). Used for the "n job · n pax" pill and the detail panel on the Vans page.
  It is a summary, not the job-order logic.
- The special-request override is also read by van check-in (`ckRowHtml`) and the pier screens
  (`pckRowHtml`, `pckDetailOpen`, `pckJobNote`).

## How legacy stores it

| Data | Blob key | Table | Shape |
|---|---|---|---|
| Sent mark | `vanjob_sent` | `vanjob_sent (id, key, value)` | key `date::van~route[~group]`, value JSON ISO time |
| Special request override | `vanjob_sreq` | `vanjob_sreq (id, key, value)` | key booking id, value JSON string (`""` = blanked) |
| Thai pickup name | `vanjob_pickup_th` | `vanjob_pickup_th (id, key, value)` | key pickup name as typed (trimmed), value Thai text |
| Driver of the day | `vanjob_driver` | `vanjob_driver (id, key, driver, phone, plate)` | key `date::van` |
| Group order | `bkv2_grp_order` | `app_meta` row, value a JSON **string** | `{ "date::route::zone": [n, …] }` |
| Template, row highlights | `vanjob_tpl`, `vanjob_rowhl` | `app_meta` rows, JSON strings | see above |
| — | — | `vanjob_th_flag` | mapped, but no code reads or writes it |

The groups, vans, pickup times and sequence the sheet is built from are booking fields
(`ops.vanId`, `vanGroup`, `vanSeq`, `vanReturnId`, `vanSplits`, `pickupTimeFinal`) and
`SB_VEHICLES`. They are already modelled here (van groups, van parts, vans, van stops).

## Data (2026-10-09)

- `vanjob_sent`: **449 marks on 50 days**, 2026-07-10 → 2026-10-06. All 449 keys are
  `van~route`: no per-round key yet. On 4 van-days one van was sent for two routes.
- `vanjob_sreq`: 10 overrides (5 blanked, 5 rewritten, e.g. `ไม่ต้องส่งกลับ` "no return needed",
  `ลากหาด +200.-`, a house number).
- `vanjob_pickup_th`: **762 Thai names**, keyed by free-text hotel names. Near-duplicates exist
  (`77 Patong Hotel & Spa` / `77 Patong resort & spa`).
- `vanjob_driver`: 27 day overrides.
- `vanjob_th_flag`: 0.
- `bkv2_grp_order`: 13 orders, 2026-09-30 → 2026-10-10, routes r10/r11/r12, zone PK only.
  `vanjob_rowhl`: 9 highlights. `vanjob_tpl`: one setting (`fNote: 20`, two highlight colours).

## Already here

- Vans, month matrix, driver of the day and `sent_at` per van and day: README "Vans and the month
  matrix" (`PUT /operations/van-days/{date}/{van_id}` `{driver, driver_phone, plate, sent_at}`).
- The import maps `vanjob_driver` onto van days. It collapses `vanjob_sent` to the **latest time
  per van and day**, dropping the route and round (`src/tools/import-legacy.ts`).
- Van groups (number, zone, van, return van, pickup time, members with `sequence`, `pax`,
  `over_capacity`) and van stops: README "Van groups", "Van stops". Group `number` is per route and
  day across zones.
- Rounds: a second van group on the same van is refused unless `allow_second_round: true`; no round
  number is computed or returned.
- Booking `notes` exists; there is no override for the job order. Pickup areas exist
  (`/v1/pickup-areas`, with names); there is no hotel catalogue and no Thai hotel names.
- `todo/trip-ops-and-vans-model.md`:
  - 9: the computed `GET /operations/van-board`, a later phase; the hand-off's §8 checklist is the
    definition of done;
  - 10: overnight legs;
  - 12: rented vans print as company vans.
- The hand-off `operation_frontend/apps/web/docs/handoff/van-endpoints.md`:
  - §3.1 is the van board, with `round: {no, of, time}`;
  - §3.5 proposes `GET /operations/van-jobs?date&van_id[&route_id&group_id&leg]` returning the R18
    rows in print order with the driver (R17), "printable layout stays in the frontend".
- `docs/handoff/legacy-integration-booking-api.md` questions 8 (per-round sent) and 9 (`VANJOB_SREQ`,
  `VANJOB_PICKUP_TH`, `bkv2_grp_order`) are unanswered.

## Bugs or oddities in legacy

1. **A sent mark is not invalidated** when the job changes after it was sent: new passenger, van
   swap, time change. Staff must notice the struck-through rows.
2. **The sent key moves with rounds.** When a van gets a second round, the first round's key changes
   from `van~route` to `van~route~group`, so its existing tick is orphaned and shows unsent.
   Renumbering a group does the same.
3. **Thai names are keyed by free text.** A hotel typed two ways needs two Thai names; a typo fix
   loses the name.
4. **Group order is display only**, but the job orders and check-in still sort by group number.
   The By-trip tab and the sheets can show groups in different orders.
5. **Group order is stored as a JSON string inside `app_meta`** and pruned after 45 days.
6. **Rented vans print as company vans** (`vanJobsOwnerTag` checks `rental`, data says `rented`):
   already noted in `trip-ops-and-vans-model.md` 12.
7. **`vanjob_th_flag`** is mapped and has a table, but nothing uses it.
8. **Two "no van" counts disagree:** the hand-off notes the board's day-1 `b.ops` miscount; the job
   page uses per-day `bkOpsRead`.

## Questions for the developer

1. **Computed board and sheet: where?** *Recommend: `GET /operations/van-jobs?date=` (the day's job
   list: key, van, route, round `{no, of, time}`, leg, pax/capacity/over, driver, `sent_at`) and
   `GET /operations/van-jobs/{date}/{van_id}?route_id=&group_id=` (the sheet rows in print order,
   both legs, stops included, struck-through rows flagged). Write a pure `src/domain/van-jobs.ts`
   both stores call. The layout stays in the client.*
2. **Sent per round or per van-day?** Today's data never used the round key, and the import keeps
   one per van-day. *Recommend: per job (van + route + group) as legacy does now, keyed by the van
   group's id rather than its number, so the second round does not orphan the first. Move `sent_at`
   off `van_days`.*
3. **Should a change after sending clear or flag "sent"?** *Recommend: keep the tick, and compute
   `changed_since_sent: true` from the groups' and members' update times. That is a new warning, not
   in legacy: say so.*
4. **Special-request override:** a booking field (`job_note`, client fact, `null` = use notes, `""` =
   blank), or per trip? *Recommend: per booking, as legacy, and returned beside `notes` so check-in
   and pier screens read it too.*
5. **Thai pickup names:** keep a dictionary keyed by the typed name (762 rows), or attach the Thai
   name to a hotel catalogue? *Recommend: a small `pickup_name_th` table keyed by the normalised
   name (trimmed, case-folded), a client fact. A hotel catalogue is a bigger, separate design.*
6. **Group order:** persist it here? *Recommend: an `order` (or `display_rank`) on van groups, set
   by `PUT /operations/van-groups/order` `{service_date, route_id, zone, group_ids}`. Ask whether
   the job orders should follow it too; legacy's do not.*
7. **Template and row highlights** (`vanjob_tpl`, `vanjob_rowhl`): presentation, company-wide.
   *Recommend: out of scope for the API (UI settings), unless the developer wants a generic
   settings store; drop `vanjob_th_flag`.*
8. **Permissions:** *Recommend: `operations` edit area for every write, as legacy; reads open to any
   login.*
9. **Change feed:** vans and van stops are not in the feed yet. *Recommend: add `van_job` (or reuse
   `booking`/`van_group`) so two staff on the board see each other's ticks.*

## Decided (2026-10-09)

1. **The sheet is built by the server:** `GET /operations/van-jobs?date=` (the day's job list) and one
   sheet's rows in print order, from a pure `src/domain/van-jobs.ts`.
2. **"Sent" is per job** (van + route + group, keyed by the van group's id), off `van_days`.
3. **A change after sending** keeps the tick and is flagged `changed_since_sent` (new vs legacy).
4. **Special request:** a booking field `job_note` (empty = use the notes), read by check-in and pier too.
5. **Thai names:** a `pickup_name_th` table keyed by the trimmed, case-folded pickup text; 762 imported.
6. **Group order:** stored here (`PUT /operations/van-groups/order`), and job orders follow it.
7. **Template and row highlights:** the client's; `vanjob_th_flag` dropped.
8. **Permissions:** `operations` for writes, as legacy.
9. **Change feed:** not now (vans and van jobs stay out of the feed).

## Design (2026-10-09)

### What a job is

- **An outbound job** is a van group that has a van and something to carry that day: a member, a
  cancelled member still in the group (printed struck through), or a van stop. Its key is the
  **group's id**. A van with two groups of one route that day runs two rounds, two jobs.
- **A return-only job** is a van that brings passengers back from a route's pier but takes no group of
  that route out. Its key is `<van_id>~<route_id>` (legacy's own key shape); the date is in the path.
- **The return leg** of a van on a route prints on its first round's sheet (legacy §vjRound3), or on
  its return-only job. A part comes back on `part.return_van_id`, else its group's `return_van_id`,
  else its group's van (legacy `vanReturnId || vanId`).
- **Rounds** (legacy `vjRoundAll`/`vjRoundPick`): a van's outbound jobs on one route, ordered by the
  earliest pickup among their rows (final pickup, else booked; none = last), then group number.
  `round` is `{no, of, time}`, or `null` when the van runs the route once.

### Fields and authority

| Field | Kind | Rule |
|---|---|---|
| the job list, the sheet, every count and row on them | computed | `src/domain/van-jobs.ts`, from bookings, groups, stops, vans, van days, routes, pickup areas, Thai names |
| `sent.at`, `sent.by` | computed | stamped by `PUT …/sent` (the clock, the login); a `sent_at` in the body is `400` |
| `sent.changed_since_sent` | computed | the sheet's fingerprint now ≠ the one stored when it was sent; `null` for a mark imported from legacy (no fingerprint) |
| `bookings.job_note` | client fact | text; `null` = print the notes; `""` = print nothing (legacy's blanked override) |
| booking read `special_request` | computed | `job_note` when set (`""` → `null`), else `notes` |
| `pickup_name_th` row | client fact | one Thai name per pickup text; the key (trimmed, lower-cased) is computed |
| `van_groups.display_order` | validated | `PUT /operations/van-groups/order`: every id a group of that date, route and zone, once each |
| `van_days.sent_at` | removed | moved to the job; sending it to `PUT /operations/van-days/…` is `400` naming `PUT /operations/van-jobs/{date}/{key}/sent` |

**The fingerprint** is a SHA-256 of what the driver acts on, in print order: the van, the driver of
the day (name, phone, plate), and per row the booking, trip and parts, the four counts, pickup time,
pickup, room, zone, drop-off, return van, bags, special request, struck-through, overnight; per stop
its label, seats, leg, time, place, phone and note. Thai names, row numbers and highlights are
presentation and left out. A change that is undone reads as unchanged again.

### Migration 080

```sql
ALTER TABLE bookings ADD COLUMN job_note TEXT;              -- NULL = the notes, '' = blanked

CREATE TABLE van_job_sends (
  id BIGSERIAL PRIMARY KEY,
  group_id TEXT UNIQUE REFERENCES van_groups (id) ON DELETE CASCADE,   -- an outbound job
  service_date DATE, route_id TEXT REFERENCES routes (id),              -- a return-only job
  van_id TEXT REFERENCES vans (id) ON DELETE CASCADE,
  sent_at TIMESTAMPTZ NOT NULL, sent_by TEXT,
  fingerprint TEXT,                                                     -- NULL = imported, unknown
  CHECK (CASE WHEN group_id IS NULL THEN num_nonnulls(service_date, route_id, van_id) = 3
              ELSE num_nonnulls(service_date, route_id, van_id) = 0 END)
);
CREATE UNIQUE INDEX van_job_sends_return_only ON van_job_sends (service_date, route_id, van_id) WHERE group_id IS NULL;
-- van_days.sent_at moves to every group that van had that day, then goes.
INSERT INTO van_job_sends (group_id, sent_at)
  SELECT g.id, d.sent_at FROM van_days d JOIN van_groups g ON g.van_id = d.van_id AND g.service_date = d.service_date
  WHERE d.sent_at IS NOT NULL;
ALTER TABLE van_days DROP COLUMN sent_at;
DELETE FROM van_days WHERE num_nonnulls(status, zone, driver, driver_phone, plate) = 0;

CREATE TABLE pickup_name_th (
  name_key TEXT PRIMARY KEY,            -- trim + lower case, computed by pickupNameKey()
  name TEXT NOT NULL,                   -- as last typed
  name_th TEXT NOT NULL CHECK (name_th <> ''),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_by TEXT
);

ALTER TABLE van_groups ADD COLUMN display_order INTEGER CHECK (display_order > 0);
```

### Contract

Reads open to any login; writes need the `operations` area (writeNeed). Nothing here enters the
change feed.

| Method + path | Body | Answers |
|---|---|---|
| `GET /operations/van-jobs?date=[&route_id=]` | — | `{date, jobs, unassigned, return_unarranged, self_arrive, struck}` |
| `GET /operations/van-jobs/{date}/{key}` | — | `{job, out, ret, ret_on_round_1, unassigned_on_route}`; `404` for no such job that day |
| `PUT /operations/van-jobs/{date}/{key}/sent` | — | the job, sent now by the login (again = re-sent, the flag clears) |
| `DELETE /operations/van-jobs/{date}/{key}/sent` | — | the job, not sent |
| `PUT /operations/van-groups/order` | `{service_date, route_id, zone, group_ids}` | `{service_date, route_id, groups}`; `[]` or `clear: true` resets |
| `GET /operations/pickup-names-th` | — | `{names: [{name, name_th, updated_at, updated_by}]}` |
| `PUT /operations/pickup-names-th` | `{name, name_th}` | `{name, name_th}`; empty `name_th` deletes (legacy) |
| `PATCH /v1/bookings/{id}` | `{job_note, version}` | the booking, with `job_note` and `special_request` |

```jsonc
// GET /operations/van-jobs?date=2026-10-06 → jobs[]
{ "key": "vgrp_…", "route_id": "r10", "route_name": "…", "group_id": "vgrp_…", "group_number": 3,
  "van_id": "veh17", "van": { "name": "Love 2", "plate": "…", "color": "#…", "capacity": 13, "ownership": "own", "partner_name": null },
  "round": { "no": 1, "of": 2, "time": "07:30" }, "has_out": true, "has_ret": true, "zones": ["PK"],
  "out_pax": 11, "ret_pax": 12, "stop_seats": 1, "pax": 12, "capacity": 13, "over_capacity": false,
  "bookings": 6, "struck": 1,
  "driver": { "name": "Somchai", "phone": "081…", "plate": "…", "override": true, "plate_override": false },
  "pickups": [ { "name": "Patong Beach Hotel", "name_th": "ป่าตอง บีช" } ],
  "sent": { "at": "…", "by": "Ploy", "changed_since_sent": false } }
// GET /operations/van-jobs/2026-10-06/vgrp_… → out.rows[] (ret the same, pickup = the pier)
{ "no": 1, "kind": "booking", "booking_id": "…", "trip_id": "…", "parts": [0], "merged_parts": 1, "voucher": "…",
  "lead_pax": "…", "other_names": ["…"], "ad": 2, "chd": 1, "inf": 0, "foc": 0, "pax": 3,
  "split": null, "pickup_time": "07:30", "pickup": "Patong Beach Hotel", "pickup_th": "ป่าตอง บีช",
  "room": "512", "zone": "Patong", "zone_th": "ป่าตอง", "drop_off": null, "drop_own": false,
  "return_van_id": "veh03", "from_van_id": null, "extra": true, "bags": 2, "special_request": "รอด้านล่าง",
  "struck": null, "ovn": null, "ovn_return_date": null }
{ "no": 2, "kind": "stop", "stop_id": "vs_…", "stop_kind": "staff", "label": "Guide Nok", "seats": 1, "leg": "out",
  "time": "06:20", "place": "Office", "phone": "089…", "zone": "Patong", "zone_th": "ป่าตอง", "note": null }
// out.totals / ret.totals
{ "ad": 9, "chd": 2, "inf": 0, "foc": 0, "pax": 11, "bookings": 5, "separate_drops": 1, "struck": 1, "stops": 1, "stop_seats": 1 }
```

Errors: `400` a bad date, a body `sent_at`, a malformed order or Thai name; `404` a key that is no
job that day; order ids from another date, route or zone, or named twice, are `400`.

### Sheet rules, copied from legacy

- Outbound rows: parts in the job's group. Not a booking that comes on its own (`pickup_self`), not an
  overnight return leg. Two parts of one booking picked up at the same place print as one row
  (`merged_parts`, legacy §altDrop). Pickup time: an own-pickup part's own time, else the final, else
  the booked. Pickup: the part's own hotel or area, else the booking's hotel, else its area.
- Return rows: parts coming back on this van. Not a self-return (separate drop-off in a NoTransfer
  area, or named "self-arrive" / "กลับเอง"), not an overnight outbound. Pickup: the route's pier.
  Rows that came out on another van go last.
- Order (legacy §vsSeqTime): manual `sequence` first; a row without one goes in by time between
  them; else by time; untimed last. Van stops are rows too, on their leg.
- Cancelled bookings still in a group print struck through (`struck: "cancelled"`, `no: null`), and
  count in no total. Clearing a cancelled trip's `van_parts` takes them off.
- Job list order (§vjOrder): route's first departure, route name, zone (PK, KL, RN, NoTransfer),
  the group's `display_order` then number (return-only jobs last), van name.
- Day summary: `unassigned` (pax with no van, by route), `return_unarranged` (separate drop-off with no
  return van and not `return_same_van`), `self_arrive` (a `pickup_self` booking still on a van or a
  transfer zone), `struck`.

### Import

- `vanjob_sent` `date::van~route`: the one imported group of that van, route and day gets the mark;
  none → a return-only mark when an imported part comes back on that van, else dropped and counted;
  two or more (the van now runs rounds) → dropped, as legacy shows it unsent (bug 2). `~group` keys
  (none in the data) map by group number. Fingerprint `NULL`.
- `vanjob_sreq` → `job_note` of the imported booking, trimmed; `""` stays blank.
- `vanjob_pickup_th` → `pickup_name_th`, replaced wholesale (legacy is master until cutover); names
  that fold together keep the first.
- `app_meta.bkv2_grp_order` → `display_order` on the imported groups (legacy key → group).
- `van_days.sent_at` is no longer written.
