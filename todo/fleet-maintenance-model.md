# Fleet maintenance, legacy read

**Status:** legacy read (wt-lk-inbox@658298d, 2026-10-09); decided 2026-10-09. Both parts are built: part A
(availability, assets, incidents, jobs) and part B (stock, memos, Daily Fleet Log, projects, safety);
see the end. Data counted on 2026-10-09 through `ORIGINAL_DATABASE_URL`, read-only.

Two corrections to what we assumed before:

- **Legacy's "Fleet Deployment" page writes nothing.** It is a planning draft kept in one browser
  (`localStorage` `la_fd_plan`, `la_fd_plans`). Real deployments are written from Boat Operation
  (`bop2AssignBoat`). README's area table ("`fleet` | deployments (legacy's Fleet Deployment)") needs
  checking.
- **`fleet_drlock` is identified.** It is the Daily Fleet Log lock, one row per day:
  `{"panwa": true}`.

## What legacy does

The Fleet page is 13 screens. All of its rules run in the browser, in
`allotment_v2/js/05-fleet.js` (27k lines). A few shared rules sit in `04-data-core.js` (boat status),
`06-engine-assign.js` (certificates and safety screens) and `08-app.js` (`depSave`, certificate
renewal). `server.js` has no fleet logic. It stores whatever the browser sends.

| View key (`LA_NAV`) | Screen | Function |
|---|---|---|
| `fl-dashboard` | dashboard | `flRenderDashboard` |
| `fl-boatstatus` | boat status (the shared Boats page) | `renderBoats` |
| `fl-dailyreport` | Daily Fleet Log: fuel, meters, pax | `flRenderDR` |
| `fl-incident` | incidents | `flRenderIncident` |
| `fl-maintenance` | maintenance jobs and the job board | `flRenderMaint`, `flBoard*` |
| `fl-projects` | projects (drydock, overhaul) | `flRenderProjects` |
| `fl-inventory` | stock, with purchase memos as a sub-tab | `flRenderInventory` |
| `fl-consumables` | consumables drawn for a boat | `renderConsumables` |
| `fl-cost` | cost analytics | `flRenderCostAnalytics` |
| `fl-insights` | insights | `flRenderInsights` |
| `fl-fuel` | fuel intelligence | `renderFuelIntel` |
| `fl-asset` | asset tabs: overview, boats, engines, gearboxes, propellers, docs, safety | `flRenderAsset` |
| `fl-deployment` | Fleet Deployment planning board | `flRenderDeployment` |
| `rep-fleet` | Fleet report | |

### Permissions

- **Viewing:** every `fl-*` screen belongs to the `fleet` area (`LA_NAV`, `01-auth-sync.js`).
- **Editing:** one gate, `flSave()`: `if(!laCanEditArea('fleet')) return;`. It refuses
  **silently**. The change stays on screen and is gone after a refresh.
- **Exceptions to the gate:**
  - The Daily Log dialogs (issue, extra, request) accept `fleet` **or** `operations`. They refuse
    with `alert('ดูอย่างเดียว · แก้ไม่ได้')` ("view only").
  - Pier assignments (`flSaveAssignment`) skip the gate and write directly.
- **Rights for one action:** there are none. Anyone with fleet edit rights can approve a memo, mark
  it paid or close a project. The approver is a name typed into a box.
- **Server:** `/api/v1/_batch` checks only `role==='admin' || edit!==false`. Areas are enforced by
  the browser alone.
- **Who has it** (2026-10-09): 14 of 38 users have the `fleet` edit area, and 2 are admins.

### Boats: status, certificates, assignments

- **Boat status, effective status, plan ahead, retire:** built (catalogue editing; part A).
- **Certificates** (`boats.docs[{name, exp, renewStatus}]`):
  - Status is computed: `processing`, `na` (no expiry), `exp`, `warn30`, `warn90`, `ok`.
  - Renewing (`depSave`) adds a new row and marks old `processing` rows `done`.
- **Assignments** move a boat between piers (`tublamu`/`panwa`/`ranong`) for a while
  (`temporary`) or for good (`permanent`).
  - Hard refusals: the same pier at both ends, a missing date, an end before the start.
  - There is no overlap check.
  - `flAutoUpdateAssignments` is never called.

Engines, gearboxes, propellers, incidents and maintenance jobs: built (part A, below; README
"Fleet maintenance").

### Read-only reports

All computed in the browser:

- **Cost analytics** (`costAggregate`): job cost split across hull, engine, gearbox, propeller and
  other. Memos without a job are counted as `memo` or "central".
- **Upkeep** (`renderConsumables`): job cost plus consumables, per month.
- **Fuel intelligence, insights, dashboard.**

### Crew

Not part of Fleet. The planning board reads `pier_staff` (the Pier area) to compare the crew needed
with the staff at a pier. Licences (`pier_licenses`) belong to Pier.

### Fleet Deployment (planning board)

- **Four tabs:** pier placement, monthly deployment, repair runway, round factsheet.
- **Storage:** drafts and up to 24 saved mock-ups live in one browser's `localStorage`. They never
  reach the server or anyone else, and the page says so.
- **Boats that aren't ready:** placing one only shows a warning toast.

## How legacy stores it

- **Path to the database:**
  1. The browser keeps fleet data in one `localStorage` blob.
  2. `flSave` writes the whole blob.
  3. A shim sends the diff to `POST /api/v1/_batch`.
  4. `os_repo.js` turns it into `operation_schemas` tables, following `field_mapping.json`.
- **Unmapped fields are dropped.** A field with no mapping is lost on the next reload.
  `04-data-core.js` says so ("new fields don't survive the sync layer"). Fields the screens write but
  legacy loses:
  - **memos:** `history`, `receipts`, `cancelReason`/`cancelledBy`/`cancelledDate`, `shortClosed`,
    `orderedAmount`; on lines, `recvQty` (what was received);
  - **projects:** `workDoneOn`, `billNote`, `noCost`, `billClosedOn` (a "no cost" close fails the
    bill gate again after a reload);
  - **jobs:** the board fields (`boardLane`, `owner`, `parked`, `dueDate`, `pinned`, `subs`);
    on parts, `late`/`lateBy`;
  - **engines:** `retired`.
- **Tables** (each child table is a list inside its parent, holding `idx` and `<parent>_id`):

  | Data | Tables |
  |---|---|
  | Boats | `boats`, `boats__log`, `boats__docs`, `boats__repairhistory` (+`__assets`), `boats__assignments` |
  | Assets | `fleet_engines`, `fleet_gearboxes`, `fleet_propellers`, each with `__log` |
  | Incidents | `fleet_incidents` + `__damagedassets`, `__progresslog`, `__relatedmaintids` |
  | Jobs | `fleet_maintenance` + `__assets`, `__parts`, `__progresslog` |
  | Projects | `fleet_projects` + `__log`, `__plan`; `docs` and `vendorvisits` are JSON text |
  | Memos | `fleet_memos` + `__items` |
  | Stock | `fleet_inventory` + `__stocks`, `__history`, `__history__changes`; `fleet_consumable_logs` |
  | Daily Log | `fleet_daily`, `fleet_daily__boat` (JSON per boat), `fleet_daily__trips` (meters as JSON) |
  | Fuel price, lock | `fleet_fuelprice`, `fleet_drlock` (JSON `value`) |
  | Daily Log extras | `app_meta` keys `fl_water`, `fl_issue_items`, `fl_issue`, `fl_extra`, `fl_req` |
  | Safety | `fleet_safety` + `__inspections`, `__log` |
  | Files | `allotment.attachments` (bytea) |
- **Old columns:** `fleet_daily` still has per-boat columns (`b2_fuel`, …) next to the JSON rows.
- **Text everywhere:** every date is text and every id is a string. There are no foreign keys.
- **Hard-coded data patches:** about 60 "Hook:" blocks at the top of `05-fleet.js` seed, close or
  fix named records (MJ-006, MO-005 …). Some set `cost` directly. The database holds their results.

## Data

Counted 2026-10-09.

| What | Count | Detail |
|---|---|---|
| Boats | 22 | 15 company boats with a licence, 7 newer ones (Ranong, LKC) without. `retired` is null on all. Status log: 174 rows (73 available, 61 fixing, 40 unavailable) |
| Certificates | 76 rows, 57 current | Of the current ones (latest per boat and name), 12 have expired and 19 expire within 90 days. Names: boat licence, inspection certificate, national-park permits (Similan, Phi Phi, Surin, Phang Nga) |
| Pier assignments | 6 | All temporary Tub Lamu → Panwa, 2026-05 to 2026-09. 5 active, 1 cancelled |
| Projects | 21 | `PRJ-001`…`021`: 9 completed, 9 inprogress, 3 awaiting_bill. `phase` is empty on all. 9 projects hold 75 files (`attId`) |
| Purchase memos | 224, 1,116 lines | Created 2026-04-22 to 2026-10-08; 54 suppliers. Total ฿5,382,446: paid 84 (฿2.45M), received 74, ordered 10, pending approval 49 (฿1.71M), cancelled 7. No memo is currently `approved`. 109 are linked to a job, 76 to a project. 147 charge VAT |
| Inventory | 615 items | 789 stock rows, 1,261 movements (2026-04-01 to 2026-10-08). Categories: general 333, engine 191, gearbox 79. 181 items below their minimum |
| Consumables | 1 | One draw, 2026-06-28. The screen is effectively unused |
| Daily Log | 123 days | 2026-05-25 to 2026-10-07. Fuel on 5 boats (b2, b10, b13, b6, b12), 108,533 L in all. Meter readings: 229 boat-days |
| Fuel price | 120 days | 2026-06-06 to 2026-10-07, about ฿41.18/L lately |
| Daily Log lock | 119 days | All for `panwa` |
| Daily Log extras | | `fl_issue` 61 boat-days, `fl_water` 49, `fl_req` 4, `fl_extra` 1 |
| Safety | 94 items on 15 boats | 6 categories × 15 boats, plus 4 replaced. 15 expired (first aid, 2026-06-01). Only 4 inspections. The 94 install-log rows are the seed |

Odd rows:

- **Duplicate memo numbers:** `MO-077` and `MO-117` are each used twice by different memos.
- **Paid memos with no payment details:** 82 of 84 paid memos have no `paidDate`. 60 of 74 received
  memos have no `receivedDate`. Legacy never recorded these; the few that exist come from data
  patches. `approvedBy` is free text with 13 spellings (`ANON`, `Anon`, `ANON (แทน)`, …).
- **Seven copies of one project:** `PRJ-001`…`PRJ-007` are identical (boat b7, same vendor and
  dates). Only PRJ-001 has a job.
- **A deleted job still referenced:** job `mjmtsfprvltstem` is named by `MO-168` and `INC-051` but
  no longer exists.
- **One warehouse, eight spellings:** `คลังVisit Panwa`, `Visit panda`, `คลัง VIsit Panwa`, … All the
  stock sits under the two proper names.
- **Duplicate stock items:** 18 groups share a name and part number.
- **Stored cost differs from parts:** on 32 jobs the stored `cost` is not the parts total. This is
  expected when memos add to it, but `cost` is a stale copy of a computed value.
- **Memo subtotals:** on 17 memos the stored subtotal does not match the lines. Old memos kept a
  lump-sum discount, so this may be fine.

## Already here

- **Boats** (catalogue editing, migration 070): the whole boat form, `ownership`, certificates
  (`documents`, as stored data), the status log, `retired`, `seed:boats`. Not here: certificate
  expiry status and renewal, assignments.
- **Part A** (migration 130): availability, assets, incidents, jobs (see "Part A: built").
- **Attachments:** `/v1/attachments` (6 MB, jpeg/png/pdf) fits project documents.
  `import-attachments` already copies the files fleet projects name. Upload and delete need
  `operations`, `pier` or `accounting`, not `fleet`.
- **Login and areas:** the `fleet` area exists in `src/domain/users.ts`. A new endpoint is
  admin-only until it is given an area.
- **Money:** `todo/money-model.md` leaves memos, fuel and maintenance cost to Fleet. Trip P&L waits
  for fuel and repair actuals.
- **Nothing else** from this note exists here.

## Bugs or oddities in legacy

1. **Silent edit refusal.** `flSave` refuses without telling the user, so the change looks saved
   until a refresh.
2. **Server enforces no area.** Some paths skip the gate entirely: assignments, project cleanups,
   fuel budget, and `save()` writing boat status for a user without fleet rights.
3. **Racy numbering.** Numbers are the highest plus one, worked out in the browser. Projects use the
   list length. This produced the real duplicates above, a whole "duplicate numbers" repair panel
   (`laDup*`, `costNo*`) and a silent dedupe on load (`flDedupeMaint`).
4. **Fields lost on reload** (see How legacy stores it): memo history, receipts, cancel reason,
   short close, received quantities; project bill fields; board fields.
5. **Cancelling a received memo** keeps the stock it brought in.
6. **Stock edits and deletes:**
   - Deleting a consumable erases its history row.
   - `flSaveInvEdit` writes a quantity that the next movement overwrites.
   - `invLostFix` rewrites past history and can leave negative stock.
7. **Approval notes:** the approval note is saved as `approveNote` and read back as `approvedNote`,
   so the print view never shows it.
8. **Project bill gate:**
   - A pending "Final Invoice" entry with no file passes.
   - The cost check leaves out project memos, while the message tells the user to add one.
9. **Project actions from the wrong status:** `flProjMarkComplete` works from any status when called
   directly; only its button is hidden.
10. **Incidents after a split:** the shown status follows the first job only.
11. **Deleting a job** leaves its parts withdrawn and its incident linked.
12. **Dead or wrong code:**
    - `flRetireBoat` and `flAutoUpdateAssignments` are never called.
    - `flBoatRepairCostMonth` reads `closedDate`, a field close never writes.
13. **The Daily Log lock is only a disabled input.**
14. **Daily Log extras older than 120 days are deleted.**
15. **Inconsistent pax:** Fuel Intelligence uses booked pax, while the Daily Log uses actual pax.
16. **Data patches in client code:** about 60 hard-coded "Hook:" blocks.

## Possible slices

Each slice is usable alone. The order puts first what other areas need.

1. **Boat availability**, 3. **Assets**, 4. **Incidents and maintenance jobs**: built (part A, below).
2. **Boat records.** Certificates with computed expiry status, registration particulars,
   assignments between piers, repair history (computed from closed jobs).
5. **Stock and purchase memos.**
   - Per-warehouse stock with append-only movements.
   - Memo commands: `approve`, `order`, `receive` (partial), `short-close`, `pay`, `cancel`.
   - Computed totals and VAT.
   - Consumables draw from the same stock.
6. **Daily Fleet Log.** Fuel, actual pax, meters, fuel price, the day lock (enforced), water and
   issued items.
7. **Projects.** Lifecycle commands, bill gate, plan, phases, documents through `/v1/attachments`,
   computed health and cost.
8. **Reports.** Cost analytics, upkeep, fuel intelligence, dashboard: computed reads over 4–7.

The Fleet Deployment planning board can stay a client draft unless shared plans are wanted.

## Questions for the developer

1. **Does fleet maintenance belong in this API at all?**
   CLAUDE.md already lists "fleet maintenance" in scope and says legacy is switched off completely,
   but `legacy-replacement.md` still asks.
   *Recommendation:* yes, in this API and this database, but after bookings and money. It shares
   boats, deployments, attachments, users and areas; a separate service would have to copy all of
   them. Start with slice 1 only, because it changes what deployments allow.
2. **Should a boat that is fixing or unavailable be refused for deployment?** Legacy computes it and
   lists the boat as N/A. I did not confirm whether Boat Operation then refuses the drop.
   *Recommendation:* check `bop2AssignBoat`, then copy it. If legacy allows it, use a warning with
   `deploy_anyway: true`, like `remove_anyway`.
3. **Who may approve and mark a memo paid?** In legacy, anyone with `fleet` edit rights, and the
   approver is typed text.
   *Recommendations:*
   - Approval: keep the `fleet` area, record the login as approver, and keep the typed name as a
     client fact. Ask the business whether only some people may approve (an `act-` right).
   - Payment: needs `accounting` and records date, by and via.
4. **Numbers.** *Recommendation:* the server assigns `MJ-`/`MO-`/`INC-`/`PRJ-` numbers and makes
   them unique. At import, renumber the second `MO-077` and `MO-117` and keep the old number as
   `prev_no`, as legacy's `laRenumberOne` does.
5. **Fields legacy loses** (memo history and receipts, cancel reason, project bill fields, job board
   fields). *Recommendation:* store them; the screens show them. Nothing can be imported for them.
6. **Stock rules that are bugs**: cancelling a received memo keeps the stock, deleting a consumable
   erases history, and a quantity edit is overwritten by the next movement.
   *Recommendation:* fix them. Movements are append-only, a cancel after receipt reverses the stock,
   and a quantity edit is an `adjust` movement.
7. **Negative stock.** Consumables allow it with a confirm; job parts refuse it.
   *Recommendation:* copy legacy as is (`allow_negative: true` for consumables only).
8. **Daily Log lock.** *Recommendation:* enforce it here (`409` while locked; unlocking is an
   explicit command).
9. **Extras older than 120 days.** *Recommendation:* keep them; the deletion looks like a size
   workaround.
10. **Clean-ups at import:** PRJ-001…007 copies, the 8 warehouse spellings, 18 duplicate stock
    items, the dangling job id, incident statuses `inprogress` and `high`.
    *Recommendation:* map the warehouse spellings to the 3 warehouses and import the rest as they
    are, listed in the import report. Ask ops about PRJ-002…007.
11. **Safety equipment and consumables** are barely used (seed data; 1 consumable).
    *Recommendation:* ask ops whether they want them before modelling them.
12. **Fleet Deployment board** (browser-only drafts). *Recommendation:* leave it out. Also check
    README's claim that the `fleet` area exists for "legacy's Fleet Deployment": the real writer is
    Boat Operation.
13. **Uploading project documents** needs `operations`, `pier` or `accounting` here.
    *Recommendation:* add `fleet` to `/v1/attachments` when slice 7 is built.

## Decided (2026-10-09)

1. **In this API and database,** after bookings and money; slice 1 (boat availability) first.
2. **A boat under repair:** check legacy's `bop2AssignBoat` and copy it; if legacy only shows N/A, a
   warning and `deploy_anyway: true`.
3. **Memos: copy legacy:** any `fleet` editor approves with a typed approver; "paid" as legacy.
4. **Numbers: copy legacy** (no server numbering; duplicates possible, as today).
5. **Fields legacy loses** are stored here.
6. **Stock bugs are fixed:** movements are append-only, a cancel after receipt reverses the stock, a
   hand edit is an `adjust` movement.
7. **Negative stock:** copy legacy (consumables only, after a confirm).
8. **The Daily Log lock is enforced** (`409`; unlocking is a command).
9. **Daily Log extras are kept** (no 120-day deletion).
10. **Import:** the 8 warehouse spellings map to the 3 warehouses; the rest imports as is and is
    listed; ops are asked about the PRJ-001…007 copies.
11. **Safety equipment and consumables are built** with the rest.
12. **The Fleet Deployment planning board stays out** (browser-only drafts).
13. **`fleet` may upload files** once projects are built.

## Part A: built

Built 2026-10-09 on `feat/fleet-availability-and-jobs` (migration 130; README "Fleet maintenance:
availability, engines, incidents, jobs"; handoff §3.15): boat availability (effective status,
`deploy_anyway`, `plan_ahead`), engines/gearboxes/propellers with their commands, incidents with the
quick swap, maintenance jobs with start/close/boat status/split/steps and the board's fields, and
`npm run import:fleet`. Import rehearsal (2026-10-09, local copy, legacy read-only): 54 engines (198
history lines), 59 gearboxes (177), 62 propellers (167), 73 incidents (83 damaged assets, 550
progress lines), 122 jobs (135 assets, 367 parts, 858 progress lines, legacy cost ฿1,337,906),
nothing skipped; `seed:boats` filled 15 plan-ahead entries.

What legacy's Boat Operation does (decision 2): `bop2AssignBoat` checks nothing; its pool and popover
offer only ready boats, the range and weekly forms skip days the boat is not ready, copy week/day,
templates and the Fleet Deployment draft do not check. So it "only shows N/A": `409 boat_not_ready`
and `deploy_anyway`.

## Open (part A)

1. **The seams to part B are wired** (`src/domain/fleet-seams.ts`): projects hold their boat,
   engine hours read the Daily Log meters, a job's cost counts its memos, job parts come from stock.
   Still open: a job made under a project does not write onto the project's log (`_projCreateForId`);
   it writes its own line naming the project.
2. **Pier assignments and certificate expiry/renewal** (catalogue open item 4) are not built.
3. **Repair history** (`boats.repairHistory`, 60 legacy rows) is not stored: it is the boat's done
   jobs (`GET /v1/fleet/jobs?boat_id=&status=done`). Legacy's rows snapshot the cost at close; not
   imported. Say if a stored history is wanted.
4. **Change feed:** a job's start, close and boat status emit a `boat` change; asset, incident and
   job writes emit none (no new change kind). Add kinds if a screen needs live fleet updates.
5. **Whole-boat holds** (`bkV2BoatLockBlockers` refuses a boat that is not ready) do not check
   availability here yet.

## Flagged

Decisions made while building, side effects, and where this differs from legacy. Default was legacy.

**Availability and deployments**
- **New refusal:** `POST /operations/deployments` with a catalogue boat not ready that day is
  `409 boat_not_ready` unless `deploy_anyway: true` (decision 2). Checked when a deployment is new or
  changes route; a re-post on the same route (capacity) is not asked; a boat not in the catalogue is
  not checked. A charter boat whose log does not cover the day counts as not ready (legacy's pool
  says "ไม่ได้เช่าวันนี้").
- `GET /v1/boats` and `/v1/boats/{id}` gain `status_effective` and `blocked_by` (today), beside the
  unchanged `status_today`. Writes answer the boat without them.
- **`plan_ahead`** on the status timeline (`POST`/`PATCH …/status-log`): `409 open_work` copies
  legacy's confirm; the entry stores `planned_over` and the server appends legacy's note mark too (its
  screens read the note). An edit re-asks (legacy reads raw) and an entry that is not `available`
  drops the plan. The boat form's status pick does not ask (legacy's `saveBoat` does not).
- A job start or close rewrites the boat's log as `autoClosePrevLog` does: entries starting today or
  later are **removed**, a planned-ahead entry included (the test shows it). Copied as is.
- Job start/close/boat-status write the boat through `writeBoat`, which stamps `updated_at`: such a
  boat is then "edited here" and `seed:boats` stops refreshing it.

**Numbers (decision 4)**
- The client sends `no` (and `nos` for one-job-per-asset and split); the server never assigns one.
  A number already used is `409 number_taken` (legacy's `flAssertUniqueNo`); legacy's duplicates
  (INC-012 ×10) are kept and `no` is not unique. List answers carry `next_no` (legacy's highest + 1)
  as a hint. `PATCH` may change `no` (legacy's renumber panel), refused if taken.

**Legacy bugs not copied (say if you want legacy's behaviour)**
- **Closing a job run alongside the boat** (`set_fixing: false`): legacy's `flMaintClose` calls
  `autoClosePrevLog` first and then writes nothing, so it cuts the boat's current status entry (an
  open-ended `off_season` ends yesterday). Here the boat's log is left alone, as its comment intends.
- **One job per damaged asset:** legacy's split path reads a checkbox (`job-fixing`) the production
  page no longer has, throws, and silently falls back to one job. Here `per_asset: true` makes one job
  per asset; each takes the form's `boat_status`/reason (legacy's split path had none).

**Kept as legacy (flag only)**
- Deleting an incident leaves its job's `incident_id`; deleting a job leaves the incident's `job_id`
  (legacy bug 11). Job parts were never moved here, so nothing is "left withdrawn".
- An incident edit rebuilds `damaged_assets` from what is sent, losing a swap's marks, as the edit form
  does; and writes the "✎ แก้ไขรายละเอียด" line with `by` = the remark, as legacy.
- Incident `by` on the opening line is the remark text (`by: remark||'ระบบ'`), as legacy.
- The quick swap sends the damaged part to `shop:honda-phuket`, hard-coded, as legacy.
- `flSaveEditBoatStatus` ends the boat's open entries whose note contains the job number on the
  effective date (not the day before) and does not close overlaps, as legacy; an end before an
  entry's start is clamped to its start (legacy would store it backwards; the schema refuses that).
- `jobs done with no outcome` (7) and the `inprogress`/`high` incident values are imported as is.

**My decisions**
- **Commands, not `PATCH`, for rule-bound asset fields:** status, install/remove/swap/move, service.
  Legacy's forms saved status and place with the rest; a client splits that save.
- Create accepts the form's status and place (validated as the form's lists: a gearbox only on an
  engine that is on a boat and has none, a propeller only on an installed gearbox with none). The
  "one propeller per gearbox" rule refuses a second though 6 legacy gearboxes have two (imported).
- Installing a gearbox or propeller through the command sets its `base_hours`/`install_hours` to the
  engine's hours (the quick swap's rule), so its lifetime counts from fitting; the form never did.
- Removing a gearbox also clears its `boat_id`; legacy left it. An engine `install` with `job_id` is
  legacy's job-start swap (shed own gearbox, adopt the waiting one); without it, only the place moves.
  The swap flow's "where the old engine goes" picker (`fl-sg-engloc`) is not a parameter: `PATCH` the
  engine's `spare_location`.
- `start` defaults `gear` to `keep` (legacy's dialog always asked); `stash_location` must be one of
  legacy's six places (default `pier:central`).
- `close` from `pending` is allowed (legacy's close is the in-progress button; `flUpdateMaint` allows
  it); `outcome` defaults to `success`. `reset_service` is required (`409 reset_service_choice`) when
  legacy would ask.
- `boat-status`, adding a job asset, and `close` refuse a closed job (`409 job_done`); legacy hid the
  buttons.
- Any new progress line (`POST …/log`) frees a lane dragged to `decide`/`wait` (legacy: only the
  board's note did). `parked: false` unparks (legacy had no unpark); board lines are written for owner,
  due date, lane and park, not for pin.
- A job may be made for an incident whose `job_id` names a deleted job (legacy hid such an incident).
- `boat_status_reason` must be one of the create form's eight reasons.
- Ids: assets `e|g|p<base36 ms>`, incidents `inc…`, jobs `mj…` (legacy used `LA_UID`).
- Engine `retired` (legacy lost it) and gearbox `last_service_hours` (no legacy column) are stored.
- `import:fleet` is a separate tool, a seed: legacy's ids upserted, lists replaced, re-runnable;
  a re-run overwrites edits made here to legacy's records (checklist 1b6).

## Part B: built (branch `feat/fleet-stock-memos-log-projects`)

Stock with append-only movements, consumables, purchase memos, projects, the Daily Fleet Log with the
enforced day lock, safety equipment, the memo spend report and `npm run import:fleet-stock` (migrations
140–143). The contract is README → "Fleet maintenance"; the legacy read of these screens is removed
from this note. Rehearsed 2026-10-09 on a copy: 616 items, 1,267 movements (+7 reconciliation, 522
receipts linked to their memo), 226 memos / 1,119 lines, 1 consumable, 21 projects (316 log lines,
77 plan items, 75 photos), 123 log days (220 boat-days, 843 meter readings), 120 fuel-price days, 111
locks, 61 issued-item boat-days, 49 water, 3 extras, 5 outside requests, 94 safety items; every
item's stock equal to legacy's.

## Open (part B)

1. **Legacy writes a job log line** when a memo on the job is created, edited or cancelled
   (`flPushLog`); not done. `job_id` and `engine_id` have no foreign keys yet.
2. **Bill gate bugs copied from legacy** (bug 8): a pending "Final Invoice" entry with no file passes,
   and the cost leaves out project memos although the message says to add one. Ask whether to fix.
3. **Not built:** the safety replace wizard (it creates an incident, a job and a memo: part A);
   cost analytics, upkeep, fuel intelligence, insights and the dashboard (only memo spend is a
   report); the Daily Log anomaly flags; the monthly fuel budget (legacy loses it); `invLostScan` /
   `invLostFix` (a legacy-bug repair: use `adjust`).
4. **A boat's pier for the day lock** is its home `pier`. Legacy uses its pier assignment that day
   (6 temporary Tub Lamu → Panwa moves); use it once assignments are built.
5. **Fleet writes are not on the change feed** (no change kind added); screens refetch.

## Flagged (part B)

Behaviour changes against legacy:

- `flSave` refused silently; here a write without `fleet` is `403`.
- The item form's quantity is no longer a field: `PATCH` with a different `qty` is `400`, the count is
  `POST …/adjust` (an `adjust` movement). The screen sends two calls.
- A voided consumable stays listed with `?voided=true`; its stock comes back with a `return`
  movement (legacy erased the history row).
- A memo cancelled after receipt takes its stock back (`reverse`). If that stock was used, the cancel
  is `409 stock_short` until resent with `allow_negative: true` (my choice: the same confirm as
  consumables).
- The day lock refuses every write to that pier's day: fuel, pax, meters, the pier's and its boats'
  prices, water, issued and extra items, outside requests (legacy disabled the inputs only).
- Taking a project document off deletes its file when nothing else names it (legacy deleted it
  fire-and-forget). A file a project names cannot be deleted from `/v1/attachments` (`409`).
- `fleet` may upload and delete attachments.
- A project completes only from `inprogress` or `awaiting_bill` (legacy's buttons; bug 9 closed).
- Deleting a stock item is new (legacy had none): it hides the item, keeps its history, and is
  refused while the item holds stock.

My own decisions (legacy copied where it has an answer):

- Numbers are the client's. A memo number already used is `409 memo_no_taken` (legacy's
  `flAssertUniqueNo`); a project number is not checked (legacy does not).
- A new item's opening quantity is a `register` movement carrying it (legacy registered 0 and kept
  the quantity beside).
- Per-warehouse minimums (195 legacy stock rows have one) are not kept: legacy reads the item's.
  `below_min` is legacy's `qty <= minQty`, so an empty item with minimum 0 reads low (478 of the
  imported 616; the 181 in "Data" counted `<`).
- Memo totals: the form counts a 0 qty as 1, a short close counts it as 0 (both legacy formulas).
- A parts line without an item auto-registers one on create (not on edit, as legacy);
  `auto_register: false` stops it. Receiving more than ordered is allowed (legacy's input has no max).
- The approving login is stored as `approved_login` beside the typed approver.
- A project's start pushes a boat status entry without trimming overlaps, as legacy does; such
  entries have no province or location type, which the status-log form requires.
- Safety item ids are the server's (`sf_…`); legacy numbered them in the browser.
- A consumable's `engine_label` is taken as sent (legacy builds it from the engine: part A).
- A fuel of 0 is no fuel (legacy `parseFloat(v)||null`).
- Merge folds only exact name + part number duplicates (legacy's key); the dropped item's history
  is read with the kept one rather than copied.

Wiring part A and part B (after both merged; `fleet-seams.ts`):

- **A project holds its boat** in `openWork` while `inprogress` or `on_hold`, from its actual
  (else planned) start, as `unavailable` with reason `dry_dock` (a drydock) or `overhaul` (any other
  type), legacy `boatJobBlock`. A general project (no boat) holds nothing.
- **Engine hours** count every trip type's meter readings for the engine (latest − first above 0),
  across boats (the meter travels with the engine, part A's rule).
- **A job's cost** counts memos whose `job_id` is the job, any scope; a cancelled or pending memo
  counts nothing (part A's `jobCost`).
- **Job parts from stock** are `POST /v1/fleet/jobs/{id}/parts` and `DELETE …/parts/{idx}` in part B's
  route file. A part's `location` is written as the warehouse's label, as legacy's and part A's
  imported parts are. A closed job needs `late_anyway` (legacy's confirm), and the part is marked
  late. Taking a part off a job returns it with a `return` movement (legacy wrote `receive`). A part
  imported with no stock item only comes off. The answer is `{job, item}` with the job as stored; its
  cost is on `GET /v1/fleet/jobs/{id}`.
- **Project cost** is its child jobs' cost (`parent_project_id`), memos included.
- **Project cascade:** completing from in progress and "work done" close the open child jobs as
  legacy does: `done`, end date, a line, no outcome, no asset or boat status change (part A's
  `/close` is not run). Cancelling takes `unlink_jobs: true` for legacy's "unlink them?" confirm.
- **Renamed apart from part A:** part B's routes are `src/routes/fleet-stock.ts`, its import
  `import:fleet-stock` (run after part A's `import:fleet`), its store field `store.fleetRepo`.

Import:

- The eight warehouse spellings map to the three. 62 movements with no warehouse get the item's
  main one. 7 item-warehouses whose history did not add up to legacy's stock get an `import`
  movement (i25: +44 Panwa, −44 Tub Lamu; five −1/+1), listed.
- A receipt is linked to its memo by the number in its note (522); 3 name a duplicated number and
  stay unlinked.
- Memo totals are kept as legacy stored them; 3 differ from the formula (MO-005 ฿16,558.50 vs
  ฿17,430, MO-002, MO-191 by cents), listed. Received and paid memos' parts lines count as fully
  received (legacy lost `recvQty`); ordered memos' as nothing received.
- MO-077 and MO-117 (twice each), 18 duplicate stock items, PRJ-001…007, the 7 cancelled memos with
  no reason, project type `general` (PRJ-016) and the deleted job `mjmtsfprvltstem` come as they are,
  listed.
- Project photos link to their files only if `import:attachments` ran first; otherwise they keep
  legacy's `/api/attach/…` link (the rehearsal did not copy files: 75 links).
- Dropped: 3 boat-days with neither fuel (above 0) nor pax, 8 lock rows with no pier set to true.
- A rerun upserts by legacy id and replaces imported child rows; it never deletes a row legacy dropped.

## Design — extras (branch `feat/fleet-extras`)

The items part A and part B left open, read from legacy (wt-lk-inbox, `05-fleet.js`, `06-engine-assign.js`,
`08-app.js`, `04-data-core.js`) on 2026-10-10. Legacy is copied; what I decided is marked **(mine)** and
listed under "Flagged (extras)". Migration `190_fleet_extras.sql`. No new change-feed kind: assignments
and renewals are under `/v1/boats/{id}/…`, which already announces a `boat` change; the reports are reads.

### 1. Pier assignments (legacy `flSaveAssignment`, `flCancelAssignment`, `getBoatCurrentPier`)

Legacy: a boat moves to another pier for a while (`temporary`) or for good (`permanent`). The form asks
from, to, type, start, end (both required), reason, cost. Refused: the same pier at both ends ("From
และ To ต้องต่างกัน"), a missing date, an end before the start. No overlap check. A `permanent` one that
is active on the day it is saved sets the boat's home `pier`; cancelling never sets it back. Cancel is
a soft `status: 'cancelled'`; there is no edit and no delete. Readers ignore the stored status except
`cancelled`: active = `start <= day <= end`. Legacy data: 6 rows (5 active, 1 cancelled).

| Field | Authority |
|---|---|
| `id` (`asn_…`), `created_at`, `created_by`, `created_date` | computed |
| `type`, `from_pier`, `to_pier`, `start_date`, `end_date` | validated (the checks above) |
| `reason`, `cost` (฿, 0 or more) | client fact |
| `status` (`planned`/`active`/`completed`/`cancelled`) | computed from the dates and `cancelled` (legacy's `flAutoUpdateAssignments` rule) |
| `cancelled`, `cancelled_at`, `cancelled_by` | set by `/cancel` |

**A boat's pier on a day** (pure, `fleet-assignments.ts` `pierOn`, legacy `getBoatCurrentPier`): the
first assignment (oldest created) covering the day → its `to_pier`; else the status-log entry covering
the day whose `loc` names a pier (`panwa`; `ranong`/`grand andaman`/`se la va`; `tub`/`tublamu`/`tab
lamu`); else the home `pier`. Legacy's first step (`'shop'`: a started job with a location holding the
boat) is `at_shop` beside it. The **Daily Fleet Log** groups and locks a boat by this pier, a boat at
the shop by its home pier (`_drPier`), so a day lock follows the assignment.

```sql
CREATE TABLE boat_assignments (
  id TEXT PRIMARY KEY,
  boat_id TEXT NOT NULL REFERENCES boats (id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('temporary', 'permanent')),
  from_pier TEXT NOT NULL CHECK (from_pier IN ('tublamu', 'panwa', 'ranong')),
  to_pier TEXT NOT NULL CHECK (to_pier IN ('tublamu', 'panwa', 'ranong')),
  start_date DATE NOT NULL, end_date DATE NOT NULL,
  reason TEXT, cost NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (cost >= 0),
  cancelled BOOLEAN NOT NULL DEFAULT false, cancelled_at TIMESTAMPTZ, cancelled_by TEXT,
  created_date DATE NOT NULL, created_at TIMESTAMPTZ NOT NULL, created_by TEXT,
  CHECK (from_pier <> to_pier), CHECK (end_date >= start_date)
);
```

| Endpoint | Area | Answers |
|---|---|---|
| `GET /v1/boats/{id}/assignments` | read | `{assignments, active, planned, past, pier_today}` (lists without cancelled, as legacy's panels) |
| `POST /v1/boats/{id}/assignments` | `fleet`, `config` **(mine)** | `201 {assignment, boat_pier}`; `400` as above |
| `POST /v1/boats/{id}/assignments/{asn_id}/cancel` | `fleet`, `config` | `200` the assignment; `409 already_cancelled` |

`GET /v1/boats` and `/v1/boats/{id}` gain `pier_today` and `at_shop` (the shop's name or null).

```jsonc
// POST /v1/boats/b4/assignments
{ "type": "temporary", "from_pier": "tublamu", "to_pier": "panwa", "start_date": "2026-05-29", "end_date": "2026-09-30", "reason": "high season", "cost": 0 }
// 201
{ "assignment": { "id": "asn_…", "boat_id": "b4", "type": "temporary", "from_pier": "tublamu", "to_pier": "panwa",
    "start_date": "2026-05-29", "end_date": "2026-09-30", "reason": "high season", "cost": 0, "status": "active",
    "cancelled": false, "cancelled_at": null, "cancelled_by": null, "created_date": "2026-05-29", "created_at": "…", "created_by": "anon" },
  "boat_pier": "tublamu" }
```

Import: `import:fleet` copies `boats__assignments` (legacy id kept; `status: 'cancelled'` → `cancelled`).

### 2. Certificates: expiry status and renewal (legacy `flDocStatus`, `flDocBetter`, `depSave`)

Rows stay the boat's `documents` (migration 070). Computed per row, never stored:

- `status` (`flDocStatus`, in this order): `renew_status = 'processing'` → `processing`; no expiry →
  `na`; days left (`ceil`) `< 0` → `exp`, `< 30` → `warn30`, `< 90` → `warn90`; else `ok`.
- `doc_type` (`flGuessDocType`): `lic`, `inspect`, `ins`, `similan`, `surin`, `pp`, `phangnga`,
  `tarn`, else `other`; `current`: the row the Documents matrix shows for that type (`flDocBetter`: a
  processing row, else a row not `done`, else one with an expiry, else the later expiry).

| Endpoint | Area | Answers |
|---|---|---|
| `GET /v1/fleet/certificates` | read | the Documents matrix: company boats (not charter, not retired) × the 8 types, each cell the current row with `status` and `days_left`; `counts {ok, warn90, warn30, exp, processing, na}`, `valid_pct`, `expired_boats`, `issues` (cells `warn30` or `exp`) |
| `GET /v1/boats/{id}/documents` | read | `{documents: [{idx, name, expires_on, renew_status, doc_type, status, days_left, current}]}` |
| `POST /v1/boats/{id}/documents/renew` | `fleet`, `config` **(mine)** | `{name, state: "exp" \| "processing" \| "ok", expires_on?}` → the documents as `GET` |

Renew is `depSave`: `exp` clears `renew_status` on the latest row of that name (no row: nothing
changes, as legacy); `processing` marks the latest row `processing` (and sets its expiry when sent), or
adds `{name, expires_on, processing}`; `ok` needs `expires_on` (`400`), adds a new row and marks the
name's `processing` rows `done`.

### 3. The safety replace wizard (legacy `swapDocExecute`)

`POST /v1/fleet/safety/{id}/replace` (`fleet`) does in one transaction what the wizard does:

```jsonc
{ "reason": "broken",            // broken | expired | upgrade | scheduled | lost
  "description": "pump motor stuck", "date": "2026-10-10",
  "source": "inventory",         // or "buy"
  "item_id": "inv_…", "warehouse": "panwa",      // inventory; warehouse defaults as legacy (the boat's pier with stock, else any with stock)
  "brand": "Rule", "model": "1100", "supplier": "Marine Shop", "price": 2400,  // buy
  "serial": "BP-002", "install_date": "2026-10-10", "installer": "Somchai", "labour": 300,
  "incident_no": "INC-074", "job_no": "MJ-123", "memo_no": "MO-225",       // numbers are the client's (decision 4)
  "expiry_date": null, "allow_negative": false, "serial_anyway": false }
```

It writes, as legacy: a **resolved incident** (title `เปลี่ยน {category} · {reason}`, the safety item as
damaged asset, priority 5/3/2, severity `critical`/`medium`/`low`, legacy's four lines); a **done job**
(corrective, `set_fixing: false`, no boat status change, legacy's three lines); in buy mode a **stock
item** (category `safety`, 0 in stock) and a **memo** (`pending_approval`, VAT 7 %, one line, `ref_note`
`Replace … via INC (MJ)`; no `job_id`, as legacy); in inventory mode a **withdraw** of 1 with the job's
id; the old item `replaced` with a `replace` log line; a **new item** (name, category, qty, location
copied; brand/model from the purchase in buy mode; `next_pm` = install + 1 month; an initial `pass`
inspection; `install` log line).

- **Job cost (mine):** legacy stored `cost = part + labour`. Here a job's cost is computed from its parts
  and memos, so the job gets parts: the withdrawn item (inventory) or the purchase at its price with no
  stock item (buy), and `ค่าแรง` for labour. The memo is not linked, so nothing counts twice.
- Refused: a replaced item (`409 already_replaced`), no item picked (`400`), buy with neither brand nor
  model (`400`), a taken number (`409 number_taken`, `409 memo_no_taken`), no serial (`409 no_serial`
  until `serial_anyway: true`, legacy's confirm), stock short (`409 stock_short` until
  `allow_negative: true`, legacy's confirm).
- `201 {incident, job, memo, withdrawn_item, old_item, new_item}`.

### 4. Reports (computed `GET`s, read for any login)

| Endpoint | Legacy | What |
|---|---|---|
| `GET /v1/fleet/reports/cost?period=all\|ytd\|last30\|month` | `costAggregate` | jobs done/in progress split equally over their assets' categories (hull, engine, gearbox, propeller, other), boat-linked direct memos (`memo`, share not bought into stock), central spend, by boat, top 10 units, by job type, outcomes, 12 months, `rows` for the drill-downs |
| `GET /v1/fleet/reports/upkeep?month=YYYY-MM` | `renderConsumables` | per boat: repairs (`flBoatRepairCostMonth`: jobs started that month, any status) + consumables (`qty × unit_cost`), oil drawn, the month's draws |
| `GET /v1/fleet/reports/fuel?month=YYYY-MM` | `renderFuelIntel`, `_fuelAgg`, `_fuelWkAgg` | company boats' fuel, cost (boat's else home pier's price that day), booked pax, trip-days, ฿/pax and its change on last month, projection and budget, anomalies (> 1.3 × the boat's month average, 3+ fuel days), missing fuel days, per boat (routes inside), L per engine hour and the median, by programme family with revenue, weekly W1–W5, per boat by week and by month (6) |
| `GET /v1/fleet/dashboard?date=` | `flRenderDashboard` | pier counts, the work board's header and lanes, pending work per boat, engines by model, spares, low stock, memo chips, open incidents, service due (500 h), 6-month cost trend |
| `GET /v1/fleet/repair-history?boat_id=` | `boats.repairHistory` | computed: the boat's done jobs in legacy's row shape (item 7) |

Booked pax per boat and day is legacy's `flBoatBookingsFor`: bookings not cancelled, rejected or
weather-cancelled, trips that day whose dispatch boat is the boat, `pax_total` (FOC and infants in).

### 5. Daily Log flags, fuel budget, `invLostFix`

- **Flags** on each boat row of `GET /v1/fleet/daily-log` (legacy `flRenderDR`): `pax_booked`, `pax`
  (actual, else booked), `litres_per_pax`, `meter_deltas` (against `flPrevMeter`: the engine's latest
  earlier reading above 0), and `flags`: `high_fuel_per_pax` (> 20 L/pax, the one anomaly legacy counts),
  `meter_backwards`, `water_negative`, `price_missing` (fuel without a boat or pier price that day). A day
  gains `totals {fuel, pax, litres_per_pax}` and `anomalies`.
- **Monthly fuel budget** (legacy kept it in one browser): one amount per month for the fleet, in baht.

  ```sql
  CREATE TABLE fleet_fuel_budgets (month TEXT PRIMARY KEY CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0), set_at TIMESTAMPTZ NOT NULL, set_by TEXT);
  ```

  `GET /v1/fleet/fuel-budgets`; `PUT /v1/fleet/fuel-budgets/{month} {amount}` (`fleet`; `null` or empty
  removes it, as legacy's prompt). The fuel report reads it.
- **`invLostScan`/`invLostFix` are not built:** a repair for legacy's colliding stock ids (received stock
  booked to the wrong item). Ids here cannot collide; a leftover is fixed with `adjust` and `receive`.

### 6. Log lines legacy writes

- **Memo on a job** (`flSaveMemo`, `moLiveSave`, `flCancelMemo` → `flPushLog`): create writes the job a
  line `📋 สร้าง Memo {no} · ฿{amount}` (dated the memo's date) and its incident `📋 สร้าง Memo {no} ·
  {title} · ฿{amount}`; an edit writes the incident `✏️ แก้ไข Memo {no} · ฿{amount}`; a cancel `🚫 ยกเลิก
  Memo {no} · {reason}`; `by` is `ระบบ`. Approve, order, receive and pay write none (legacy).
- **Memo on a project:** create writes the project `Memo {no} · {title} · ฿{amount} (Project overhead)`,
  `by: user`.
- **Job under a project** (`_projCreateForId`): the project gets `+ Created MJ {no} · {title}` and the job
  `+ Created under project {project no}`; a split `+ Split {no} → {nos}`; a `PATCH` of
  `parent_project_id` `+ Linked MJ {no} · {title}` / `− Unlinked MJ {no}` and on the job `🔗 Linked to
  project {no} · {name}` / `🔗 Unlinked from project {no}`. A `parent_project_id` that is not a project is
  `400` **(mine)**.

### 7. Repair history

Legacy writes `boats.repairHistory` at every close (61 rows, 40 distinct jobs, all still present) and
nothing reads it; its "recent repairs" reads the done jobs. So it stays computed
(`GET /v1/fleet/repair-history`), and the 61 rows are not imported.

### 8. Project bill gate

The two copied bugs stay as legacy and flagged (developer to decide).

