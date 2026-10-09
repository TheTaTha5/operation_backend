# Fleet maintenance, legacy read

**Status:** legacy read (wt-lk-inbox@658298d, 2026-10-09); part B is built (see the end). Data counted on
2026-10-09 through `ORIGINAL_DATABASE_URL`, read-only.

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

- **Boat status** is a log of date ranges `{s, from, to, reason, note}` stored in `boats__log`.
  - Values: `available`, `fixing`, `unavailable`, `retired`.
  - Unavailable reasons: `engine_repair`, `donor`, `docs_expired`, `dry_dock`, `off_season`,
    `charter`, `scheduled_maint`, `other`.
  - Hard refusals in `flSaveEditBoatStatus`: no status chosen, the same status as now, no date,
    unavailable with no reason.
- **Effective status is computed** (`boatEffStatus` / `boatJobBlock`, `04-data-core.js`):
  - It takes the stricter of the boat log and the open work.
  - Open work means a maintenance job that is `inprogress`, has started, and does not leave the
    boat available; or a project that is `inprogress` or `on_hold`.
  - Setting a boat to available while work is still open is a **confirm**, not a refusal. If the
    user goes ahead, the boat is "planned ahead": those job numbers stop blocking it for that date
    range. Legacy saves this marker as text inside the log note (`LA_PLAN_MARK`), because a new field
    would not survive its sync.
- **Who reads it:** Boat Operation's boat pool (`bop2FleetStatus`) lists a non-available boat under
  "UNAVAILABLE / N/A" with the job numbers that block it. I did not confirm whether dropping that
  boat onto a route is refused.
- **Charter (rented) boats:** `ownership:'charter'`. A day not covered by their log counts as
  unavailable, the opposite of company boats.
- **Retire:** `flRetireBoat` has no caller anywhere in the UI. `flUnretireBoat` asks for a confirm.
- **Certificates** (`boats.docs[{name, exp, renewStatus}]`):
  - Status is computed: `processing`, `na` (no expiry), `exp`, `warn30`, `warn90`, `ok`.
  - Renewing (`depSave`) adds a new row and marks old `processing` rows `done`.
- **Assignments** move a boat between piers (`tublamu`/`panwa`/`ranong`) for a while
  (`temporary`) or for good (`permanent`).
  - Hard refusals: the same pier at both ends, a missing date, an end before the start.
  - There is no overlap check.
  - `flAutoUpdateAssignments` is never called.

### Mechanical assets: engines, gearboxes, propellers

- **Statuses:**
  - Engines and gearboxes: `ready`, `fixing`, `broken`, `spare`, and `limited` (set only by
    closing a job).
  - Propellers: `active`, `fixing`, `broken`, `spare`, and `damaged` (set only by a swap).
- **Links:** an engine sits on a boat at a position. Each engine has at most one gearbox and each
  gearbox at most one propeller. A spare has a `spareLocation`: `pier:<pier>` or `shop:<shop>`.
- **Engine hours are computed** (`flEngHours`): `baseHours` plus the latest meter reading minus the
  first non-zero meter reading in the Daily Log.
- **Service due is computed:**
  - Engines (`flEngServiceState`): the interval defaults to 100 h, counted from `lastServiceHours`.
  - Gearboxes (`flGbServiceState`): the interval defaults to 200 h.
  - Marking a service asks for the hour reading with `prompt()`.
- **Swaps:** `flConfirmSwap`, `flStartGearSwap` and `flConfirmPropCascade`.
  - The spare goes onto the boat and becomes `ready`/`active`. The damaged part is sent to a
    hard-coded shop (`shop:honda-phuket`).
  - Gearbox spares must match the brand; propeller spares must match the size.
- **Logs:** every move, install, service and repair adds a row to the asset's log (`*__log`).
- **Weak checks:** `flSaveEngine` requires a model and a serial but does not check that the serial
  is unique. `flChangeEngStatus`, `flEquipSwapDo` and `flEquipRemove` check nothing.

### Incidents

- **Number:** `INC-` plus 3 digits, taken as the highest existing number plus one.
- **Severity is computed from priority 1–5:** 4 or more is `critical`, 3 is `major`, anything else
  `minor`.
- **Stored status:** `open`; `resolved` for a Quick Fix (`quickFix`, `resolvedDate`); `closed`,
  written by closing the last linked job.
- **Shown status is computed** from the linked job (`maintId`):
  - no job → open;
  - `pending` → pending;
  - `inprogress` → inprogress;
  - anything else → resolved.
- **Damaged assets:** an incident lists the parts that were damaged (`damagedAssets`). Its assets
  can be swapped for spares.
- **Creating a job from an incident** with 2 or more damaged assets offers a choice: one job, or one
  job per asset (`relatedMaintIds`).
- **Refusals:** missing fields → `กรุณากรอกข้อมูลให้ครบ` ("fill in every field"). Deleting asks for
  a confirm and leaves the linked job in place.

### Maintenance jobs (MJ)

- **Number:** `MJ-` plus 3 digits, the highest existing number plus one, with no lock.
  `flAssertUniqueNo` alerts and throws on a duplicate.
- **Type:** `corrective`, `preventive` or `scheduled`. The type sets the default boat status
  (`_defaultBoatStatusForType`):
  - corrective → `fixing`;
  - scheduled → `unavailable` with reason `scheduled_maint`;
  - preventive → `available`.
- **Status:** `pending` → `inprogress` (Start) → `done` (Close).
  - There is no cancelled status. A cancel is `done` with `outcome:'cancelled'`.
- **Create** (`flSaveCreateJob`):
  - Hard refusal: no boat or no title.
  - Confirm: the boat already has an open job.
  - Hard refusal: the boat will be unavailable but no reason is given.
  - Charter and retired boats are not offered.
- **Start** (`flMaintStart`, `_flMaintStartProceed`):
  - Opens a boat-log row with the job's boat status. If the boat already ran today, the row starts
    tomorrow.
  - Marks each asset `fixing` and logs `service-start` with engine hours.
  - May stash or swap the engine's gearbox and propeller first.
- **Close** (`flMaintClose`) picks an outcome, which sets the assets and the boat:

  | Outcome | Engine | Gearbox | Propeller | Boat |
  |---|---|---|---|---|
  | `success` | ready | ready | active | available |
  | `limited` | limited | limited | limited | available |
  | `rework` | fixing | fixing | fixing | fixing |
  | `decommission` | broken | broken | broken | available |
  | `cancelled` | ready | ready | active | available |

  For `decommission` the engine also gets `retired`. For `cancelled`, only parts that are `fixing`
  change.

  The boat does not simply become available. If other jobs or projects are still open
  (`boatJobBlock`), it keeps their status. Closing also:
  - appends a row to `boats.repairHistory`;
  - writes the asset logs;
  - closes the incident once all its jobs are done;
  - may reset the service counter (`flMaintServiceReset`, a confirm, when the title looks like a
    service).

  `awaitingInvoice` keeps a closed job listed until its memos are paid.
- **Parts** (`flMaintAddPart`) take stock out of one warehouse.
  - Hard refusals: no part, no warehouse, or more than the warehouse holds
    (`คลังนี้เหลือ N เท่านั้น`, "this warehouse only has N").
  - Removing a part puts the stock back.
  - On a closed job, parts can be changed only after a confirm ("late edit"), which marks them
    `late`.
- **Cost is computed** (`flMaintCalcCost`):
  - It is the sum of linked memos in `approved`, `received` or `paid`, plus parts (qty × cost).
  - A part is left out when a parts memo already carries the same name. The comment cites ฿271,041
    double-counted across 18 jobs.
  - It is recalculated on every render and written into `m.cost`.
- **Delete:** a confirm, and only for jobs that are not done. It does **not** return parts to stock
  or unlink the incident.
- **Split:** one job per engine (`flEngSplitIntoJobs`, `flSplitExistingJob`).
- **Job board:** four lanes, `decide` / `wait` / `doing` / `close`.
  - A lane is computed from the last log line's date and words such as "waiting", "ordered",
    "parts", "approval" (`flBoardLane`), unless set by hand.
  - It also has sub-steps, owner, parking, and "silent for more than 60 days".

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
| Engines / gearboxes / propellers | 53 / 59 / 62 | Engines: 30 ready, 20 fixing, 3 broken. Logs: 195 / 177 / 167. One serial appears twice (`BBNJ-8000285`) |
| Incidents | 71 | 2026-02-10 to 2026-10-04. Stored status: 43 closed, 18 open, 9 resolved, 1 `inprogress` (not a value the code writes). Severity: 38 critical, 32 major, 1 `high` (also not a code value). 5 Quick Fixes; 65 linked to a job |
| Maintenance jobs | 120 | `MJ-001`…; started 2025-12-01 to 2026-10-04. 78 done (67 success, 4 decommission, 7 no outcome), 41 inprogress (29 started before August), 1 pending. 70 corrective, 30 preventive, 20 scheduled. 75 have a cost, totalling ฿1,322,391. 364 parts lines (฿457,645). 847 progress lines. 3 awaiting invoice |
| Repair history | 60 rows | Every row matches a job number |
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
  (`documents`, as stored data), the status log with legacy's timeline checks, `retired` with
  retire/restore commands, `seed:boats`. Not here: the computed effective status (log plus open
  work), certificate expiry status and renewal, assignments, repair history.
- **Deployments:** `/operations/deployments`, writable by `operations` or `fleet`. They **do not
  check boat status**, so a boat in a drydock can be deployed here. Legacy shows it as N/A.
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

1. **Boat availability.**
   - Status log, `retired`, `ownership`, and the computed effective status (log plus open work).
   - Deployments read it (refuse, or warn with `deploy_anyway`).
   - Smallest slice, and the one bookings feel.
2. **Boat records.** Certificates with computed expiry status, registration particulars,
   assignments between piers, repair history (computed from closed jobs).
3. **Assets.**
   - Engines, gearboxes, propellers, their links and logs.
   - Swap and stash commands.
   - Computed engine hours and service due (these need slice 6's meters).
4. **Incidents and maintenance jobs.**
   - Server-assigned `INC-`/`MJ-` numbers.
   - Commands: `start`, `close` (outcome), `split`, `add-part`/`remove-part`.
   - Close sets asset and boat status, as in the outcome table above. Job cost is computed.
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

## Part B: built (branch `feat/fleet-stock-memos-log-projects`)

Stock with append-only movements, consumables, purchase memos, projects, the Daily Fleet Log with the
enforced day lock, safety equipment, the memo spend report and `npm run import:fleet-stock` (migrations
140–143). The contract is README → "Fleet maintenance"; the legacy read of these screens is removed
from this note. Rehearsed 2026-10-09 on a copy: 616 items, 1,267 movements (+7 reconciliation, 522
receipts linked to their memo), 226 memos / 1,119 lines, 1 consumable, 21 projects (316 log lines,
77 plan items, 75 photos), 123 log days (220 boat-days, 843 meter readings), 120 fuel-price days, 111
locks, 61 issued-item boat-days, 49 water, 3 extras, 5 outside requests, 94 safety items; every
item's stock equal to legacy's.

### Open

1. **Wire part A** after both merge:
   - `projectJobs` (both stores answer none): a project's child jobs, their cost and whether open.
     Until then a project's cost is ฿0, so the bill gate always asks for "no cost".
   - Job parts take and return stock through `planWithdraw` / `planReturn` (`fleet-stock.ts`):
     refused beyond stock, `job_id` on the movement.
   - The project cascade legacy does to child jobs: close them on complete or work done, offer to
     unlink them on cancel. Not done here.
   - Legacy writes a job log line when a memo on the job is created, edited or cancelled. Not done.
   - `job_id` and `engine_id` gain foreign keys.
   - Part A's effective boat status should count this branch's `inprogress`/`on_hold` projects.
2. **Bill gate bugs copied from legacy** (bug 8): a pending "Final Invoice" entry with no file passes,
   and the cost leaves out project memos although the message says to add one. Ask whether to fix.
3. **Not built:** the safety replace wizard (it creates an incident, a job and a memo: part A);
   cost analytics, upkeep, fuel intelligence, insights and the dashboard (only memo spend is a
   report); the Daily Log anomaly flags; the monthly fuel budget (legacy loses it); `invLostScan` /
   `invLostFix` (a legacy-bug repair: use `adjust`).
4. **A boat's pier for the day lock** is its home `pier`. Legacy uses its pier assignment that day
   (6 temporary Tub Lamu → Panwa moves); use it once assignments are built.
5. **Fleet writes are not on the change feed** (no change kind added); screens refetch.

## Flagged

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

