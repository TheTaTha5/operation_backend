# Van job orders, legacy read

**Status:** legacy read (wt-lk-inbox@658298d, 2026-10-09); not designed yet.

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
