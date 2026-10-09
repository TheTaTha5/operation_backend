# Fleet maintenance, legacy read

**Status:** legacy read (wt-lk-inbox@658298d, 2026-10-09); not designed yet. Data counted on
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

### Projects (drydock, overhaul)

- **Number:** `PRJ-` plus `FL_PROJECTS.length + 1`. This is not even the highest number plus one,
  and nothing checks for duplicates.
- **Type:** `drydock`, `overhaul`, `refit`, `scheduled` or `other`.
- **Status:** `planned` → `inprogress` ⇄ `on_hold` → `awaiting_bill` → `completed`, and
  `cancelled` (reopen goes back to `planned`).
  - **Start** (only from `planned`) marks the boat `unavailable` (`dry_dock`/`overhaul`).
  - **Hold** needs a reason.
  - **Cancel** needs a reason and asks whether to unlink open jobs.
  - **Work done** closes the child jobs, sets `awaiting_bill` and frees the boat.
- **Bill gate** (`flProjBillGate`): a project completes only when both are true:
  - a document whose name looks like an invoice is attached;
  - the computed cost is above ฿0.

  Otherwise the user can close it with "no cost", which needs a written reason.
- **Health score** (`flProjHealth`) is computed from budget used, schedule overrun, open jobs and
  hold.
- **Phases, plan checklist, vendor visits and documents with required presets** are kept per type.
- **Files** go to `POST /api/attach` with `bookingId:'proj_<id>'`. The project's `docs` keep `attId`.
- **Automatic writes on every visit** (`flProjMigrate`):
  - Every `scheduled` job gets a project: it is linked to an overlapping one, or one is created.
  - One-off cleanups run and write to `localStorage` directly, skipping the edit gate.

### Purchase memos (`fleet_memos`)

- **Number:** `MO-` plus 3 digits, the highest plus one. A duplicate number is refused by alert and
  throw.
- **Type:** `parts`, `labor` or `mixed`.
- **Scope:** `vessel` (has a boat), or `general` with a category: `Office`, `Marketing`, `Pier`,
  `Vehicle`, `Staff`, `License`, `Other`.
- **Links:** to a job (`maintId`) or a project (`projectId`).
- **Supplier** is free text, with suggestions drawn from past memos and stock items.
- **Steps** (`flAdvanceMemo`, `currentStep` indexes the step list):
  - Parts or mixed: `pending_approval`(1) → `approved`(2) → `ordered`(3) → `received`(4) →
    `paid`(5).
  - Labor only: `pending_approval`(1) → `approved`(2) → `paid`(3).
  - **Approve** (`flSaveApprove`) needs a typed approver name and a position. No right is checked.
  - **Ordered** and **paid** only flip the status. Nobody records who ordered or paid, when, or how.
  - **Receive** (`flOpenReceiveMemo`) can be partial. The memo stays `ordered` until every line has
    arrived. Stock goes to the boat's pier warehouse. **Short close** (a confirm) accepts what came
    and recalculates the totals.
  - **Cancel** needs a reason. It is refused once `paid`, but allowed after `received`, and the
    stock already received is **not** reversed.
  - **Edit** is refused once `paid`.
- **Totals are computed** (`memoCalcTotal`, `_memoTotals`):
  - line = qty × price − line discount %;
  - then a memo discount (% plus a fixed amount);
  - then VAT 7% (can be turned off).
  - A line priced differently from stock cost only gets a warning badge.
- **Lines with no stock item** register a new stock item when the memo is saved (`autoRegister`).

### Inventory and consumables

- **Item:** name + part number. It holds stock per warehouse (`stocks[]`): `คลัง Tub Lamu`,
  `คลัง Visit Panwa`, `คลัง Ranong`.
- **Movements** go into `history`: `register`, `receive`, `withdraw`, `transfer-out`/`transfer-in`,
  `edit`, `merge`, `adjust_out`, plus the old `in`.
- **Hard refusals:**
  - a duplicate name + part number;
  - a reused name with no part number;
  - a transfer with the same warehouse at both ends, or more than is there;
  - a job withdrawal beyond stock.
- **Consumables** (`flConsumeSubmit`) draw oil, filters and the like for a boat.
  - Hard refusals: no item, quantity below 1, no boat.
  - Going below zero is only a **confirm**, so negative stock is allowed.
  - Deleting puts the stock back and **erases** the history row.
- **Fixers** for past damage: `invDupScan`/`invDupMerge` and `invLostScan`/`invLostFix`. They
  rewrite history and can leave negative stock.

### Daily Fleet Log and fuel

- **Per day and boat** (`fleet_daily`): fuel litres, actual pax, and engine hour-meter readings
  (`trips.normal.engines{engineId: reading}`).
  - A meter that goes backwards shows a red Δ. It is not refused.
- **Fuel price** (`fleet_fuelprice`) is ฿/L per day, per boat or pier.
  - The P&L price falls back through: boat → pier → another boat at the same pier → the last 30
    days → 0.
- **Lock** (`fleet_drlock`): "Save day" locks a pier's day; "Edit" unlocks it. The lock only
  disables inputs. No save function checks it.
- **Extras** are stored as JSON strings in `app_meta`:
  - water meter readings (`fl_water`);
  - issued items (`fl_issue_items`, `fl_issue`);
  - extra items (`fl_extra`);
  - supplies drawn by people outside the fleet (`fl_req`).

  `fl_extra` and `fl_req` **delete entries older than 120 days** on every save.
- **Anomaly flags** are display only:
  - Daily Log: more than 20 L per pax.
  - Fuel Intelligence: a day above 1.3× the boat's monthly average.
- **Monthly fuel budget:** `fleet_fuelbudget`. It has no server table and is not in `app_meta`, so it
  is lost.

### Read-only reports

All computed in the browser:

- **Cost analytics** (`costAggregate`): job cost split across hull, engine, gearbox, propeller and
  other. Memos without a job are counted as `memo` or "central".
- **Upkeep** (`renderConsumables`): job cost plus consumables, per month.
- **Fuel intelligence, insights, dashboard.**

### Safety equipment

- **Items per boat** (`fleet_safety`):
  - Categories: bilge pump, life jacket, fire extinguisher, EPIRB, flare, VHF, first aid, anchor,
    navigation light.
  - Each item has an expiry and a next-PM date. Status is computed: `EXPIRED`, `DUE` (≤30 days),
    `SOON` (≤90 days), `OK`.
  - Inspections are recorded as pass or fail.
- **The list was seeded** by `_generateSafetySeed` and is hardly used since (see Data).

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

## Design — part B (stock, memos, Daily Fleet Log, projects, safety, consumables)

Part A (boat availability, engines and other assets, incidents, maintenance jobs) is designed and
built separately. Part B links to part A only by plain text ids (`job_id`, `engine_id`), flagged
below, so the two merge without depending on each other.

All endpoints sit under `/v1/fleet/`. Writes need the `fleet` area, except the Daily Log's water,
issued items, extra items, outside requests and the issue-item catalogue, which take `fleet` **or**
`operations` (legacy `_flJsonSave`). Any login reads. `/v1/attachments` uploads also take `fleet`.
Money is `NUMERIC(12,2)`, quantities `NUMERIC(12,2)`, dates `DATE` (read as `::text`).

### Warehouses and stock

**Warehouses** are a fixed table seeded by the migration: `tublamu` (คลัง Tub Lamu), `panwa` (คลัง
Visit Panwa), `ranong` (คลัง Ranong). Requests may name one by key or by legacy's label.

**Stock item** (`fleet_stock_items`):

| Field | Authority | Notes |
|---|---|---|
| `id` | computed | legacy's id kept; new `inv_<time>_<hex>` |
| `name`, `part_no` | validated | name required; name + part number (trimmed, any case) unique among live items; a name already used needs a part number (legacy `flSaveAddStock`) |
| `category`, `supplier`, `unit`, `min_qty`, `cost`, `note` | client fact | `unit` defaults to ชิ้น |
| `stocks[]` `{warehouse, qty}`, `total_qty`, `primary_warehouse`, `below_min` | computed | from the movements; primary = most stock (legacy `invSyncLegacy`); `below_min` = `total_qty <= min_qty` (legacy) |
| `created_from`, `created_at/by`, `deleted_at/by`, `merged_into` | computed | |

**Movements** (`fleet_stock_movements`) are append-only: nothing updates or deletes one. Each has
`type`, `warehouse`, signed `delta`, business `date`, `note`, `by`, links (`memo_id`, `job_id` as
plain text, `consumable_id`) and, for `edit`, the `changes`. Types: legacy's `register`, `receive`,
`withdraw`, `transfer-out`, `transfer-in`, `edit`, `merge`, `adjust`, `adjust_out`, `in`, plus
`return` (a voided consumable, a job part put back), `reverse` (a cancelled memo's receipt) and
`import` (the import's reconciliation). Stock = the sum of `delta` per warehouse, in a pure function
both stores call.

| Endpoint | Rule |
|---|---|
| `GET /v1/fleet/warehouses` | the three |
| `GET /v1/fleet/stock-items?q=&category=&warehouse=&low=true&deleted=true` | live items by default |
| `GET /v1/fleet/stock-items/{id}` | the item and its movements (an item merged into it brings its own) |
| `POST /v1/fleet/stock-items` | `{name, part_no?, category?, supplier?, unit?, min_qty?, cost?, note?, qty?, warehouse?}`. An opening `qty` needs `warehouse` and is a `register` movement. `409 stock_item_exists`, `409 part_no_required` |
| `PATCH /v1/fleet/stock-items/{id}` | client facts; an `edit` movement lists what changed (legacy). Changing `part_no` needs `part_no_anyway: true` (legacy's confirm) else `409 part_no_change`. `qty`, `stocks`, `total_qty`, `location`… are `400` naming the command |
| `POST /v1/fleet/stock-items/{id}/receive` | `{warehouse, qty > 0, date?, note?}` |
| `POST /v1/fleet/stock-items/{id}/transfer` | `{from, to, qty > 0, date?, note?}`; same warehouse `400`; more than `from` holds `409 stock_short` |
| `POST /v1/fleet/stock-items/{id}/adjust` | `{warehouse, qty, note?, date?}`: the counted quantity (0 or more); the movement is the difference. Same as now `400` |
| `POST /v1/fleet/stock-items/{id}/merge` | `{from_ids}`: legacy `invDupMerge`; each must share name + part number. Their stock moves over (`merge` movements), blank `part_no`/`cost`/`supplier` are filled, memo lines repointed, the dropped items marked `merged_into` |
| `DELETE /v1/fleet/stock-items/{id}` | marks it deleted; history stays. `409 stock_not_empty` while any warehouse holds stock |
| `GET /v1/fleet/suppliers` | suggestions from memos and items (legacy `memoPopulateSupplierList`) |

A job part (part A) takes stock out with `withdraw` and puts it back with `return`, through the
exported `planWithdraw` (refuses beyond the warehouse's stock, legacy `flMaintAddPart`).

**Consumables** (`fleet_consumables`, legacy `fleet_consumable_logs`): `POST /v1/fleet/consumables`
`{item_id, warehouse, qty (whole, ≥ 1), boat_id, engine_id?, engine_label?, date?, by?, note?,
allow_negative?}`. More than the warehouse holds is `409 stock_short` unless `allow_negative: true`
(legacy's confirm). `unit_cost` (the item's cost now), `cost` (qty × unit cost) and `item_name` are
computed. `GET /v1/fleet/consumables?month=YYYY-MM&boat_id=`. `DELETE /v1/fleet/consumables/{id}`
voids it: a `return` movement puts the stock back and the record stays, marked `voided_at`.

### Purchase memos

`fleet_memos` + `fleet_memo_lines` + `fleet_memo_history` + `fleet_memo_receipts`.

| Field | Authority |
|---|---|
| `no` | client fact (legacy numbers in the browser); a number already used is `409 memo_no_taken` (legacy `flAssertUniqueNo`) |
| `title`, `memo_type` (`parts`/`labor`/`mixed`), `scope` (`vessel`/`general`), `general_category`, `boat_id`, `job_id` (text), `project_id`, `proposer`, `from`, `to`, `cc`, `ref_note`, `supplier`, `note`, `memo_date`, `vat_enabled`, `vat_rate`, `discount_pct`, `discount_amt`, lines `{name, qty, price, discount_pct, category, part_no, unit, item_id, snapshot}` | client fact (validated shape; `boat_id`, `project_id`, `item_id` must exist) |
| `subtotal`, `discount`, `after_discount`, `vat`, `amount`, `ordered_amount`, line `received_qty`, `price_mismatch` | computed (legacy `memoCalcTotal`, `_memoTotals`) |
| `status`, `current_step`, approval, order, receipt, payment and cancel fields, `short_closed`, history, receipts | validated, by the commands |

Totals: line gross = qty × price (a qty of 0 counts as 1, as legacy's form does); line discount %;
memo discount = round(after-line × pct / 100) + amount; after discount = max(0, …); VAT =
round(after × rate / 100, 2) when enabled; amount = after + VAT.

| Command | From | Rule |
|---|---|---|
| `POST /v1/fleet/memos` | — | `pending_approval`, step 1. A parts line with no `item_id` links to the one live item of that name (+ part number), else registers a new item (`register`, qty 0), unless `auto_register: false` |
| `PATCH /v1/fleet/memos/{id}` | not `paid` (`409 memo_paid`) | client facts and `lines` (a line keeps its `id` and `received_qty`; a line that received stock cannot be removed, `409 line_received`); totals recomputed; an `edit` history line |
| `POST …/approve` | `pending_approval` | `{approved_by (typed, required), approved_date?, note?}` → `approved`, step 2; the login is kept as `approved_login` |
| `POST …/order` | `approved`, parts or mixed with parts lines | `{ordered_date?, ordered_by?}` → `ordered`, step 3 |
| `POST …/receive` | `ordered` | `{warehouse?, date?, note?, lines: [{line_id, qty}]}`; warehouse defaults to the boat's pier, else Tub Lamu (legacy `flMemoWarehouse`). Each qty > 0 on a parts line adds stock (the linked item; else the one item of that name; else a new item). All lines in → `received`, step 4; else stays `ordered`. A receipt round is stored |
| `POST …/short-close` | `ordered` with something received, not all | totals from what came; `ordered_amount` keeps the old amount → `received` |
| `POST …/pay` | `received`, or `approved` for labor only | `{paid_date?, paid_by?, paid_via?}` → `paid` (step 5, labor 3) |
| `POST …/cancel` | not `paid`, not `cancelled` | `{reason}` required. Stock received is reversed (`reverse`); a warehouse that would go negative is `409 stock_short` unless `allow_negative: true` |

`GET /v1/fleet/memos?status=&boat_id=&job_id=&project_id=&q=` and `GET /v1/fleet/memos/{id}`
(lines, history, receipts, `receive_state`, `default_warehouse`, `duplicate_no`).

### Projects

`fleet_projects` + `fleet_project_log` + `fleet_project_plan` + `fleet_project_documents` +
`fleet_project_vendor_visits`.

| Field | Authority |
|---|---|
| `no` (client numbering, no check, as legacy), `name`, `boat_id` (null = General), `type`, `vendor`, `plan_from`, `plan_to`, `planned_budget`, `notes`, `phase` (one of the type's phases) | client fact / validated shape |
| `original_plan_to` (baseline set at create), `status`, `actual_from/to`, `hold_*`, `cancel_*`, `work_done_on`, `bill_note`, `no_cost`, `bill_closed_on`, log | by the commands |
| `cost`, `cost_breakdown`, `bill_gate`, `health`, `required_documents` | computed |

Commands: `start` (planned → inprogress; boat log `unavailable`, reason `dry_dock`/`overhaul`,
`project_id`), `hold {reason}`, `resume`, `cancel {reason}` (not completed or cancelled; closes the
project's boat entry and adds `available`), `reopen` (cancelled → planned), `work-done {note?}`
(inprogress → awaiting_bill; boat available), `bill-back` (awaiting_bill → inprogress; boat
unavailable again), `complete {no_cost_reason?}` (inprogress or awaiting_bill; the bill gate:
an invoice-like document and cost > 0, else `409 bill_gate` listing what is missing, unless
`no_cost_reason` is given). Plan items, documents (an uploaded `attachment_id` or a `url`; status
`required`/`pending`/`received`/`verified`; `type: photo`) and vendor visits have their own small
endpoints; each change writes legacy's log line.

Cost is legacy's `flProjCalcCost`, the child jobs' cost. Jobs are part A's, so the store answers
none until the two are wired (flagged).

### Daily Fleet Log

| Table | Key | Fields |
|---|---|---|
| `fleet_daily_boats` | date, boat | `fuel_litres`, `pax_actual` |
| `fleet_daily_meters` | date, boat, trip type, engine | `reading` (engine id is part A's, text) |
| `fleet_fuel_prices` | date, key (pier or boat) | `price` |
| `fleet_daily_locks` | date, pier | `locked_at`, `locked_by` |
| `fleet_water_meters` | date, boat | `open_reading`, `close_reading`, `by`, `at` |
| `fleet_issue_items` | id | `name`, `unit`, `pier` (null = all), `off` |
| `fleet_issues` | date, boat, item | `qty` |
| `fleet_daily_extras` | id | date, boat, `name`, `qty`, `unit` |
| `fleet_daily_requests` | id | date, pier, `name`, `pax`, `fuel`, `price`, `engine_hours`, `water_open`, `water_close`, `issues` |

`GET /v1/fleet/daily-log?from=&to=` (at most 93 days) answers each day's boats, prices, locks and
requests, with computed water used and the effective fuel price (legacy `flFuelPriceEff`: boat →
pier → another boat at the pier → the last 30 days → 0, with its source). Writes: `PATCH
…/daily-log/{date}/boats/{boat_id}` (fuel, pax, meters), `PUT …/water`, `PUT …/issues`,
`POST/PUT/DELETE …/extras`, `POST/PUT/DELETE …/daily-log/{date}/piers/{pier}/requests`,
`PUT …/daily-log/{date}/fuel-prices`, `POST …/piers/{pier}/lock` ("Save day") and `/unlock`
("Edit"). **Every write to a locked pier's day is `409 day_locked`.** A boat's pier is its
`pier` on the boat record. `GET/POST /v1/fleet/issue-items`, `PATCH /v1/fleet/issue-items/{id}`
(an `off` item is hidden, never deleted; adding a name that exists turns it back on).

### Safety equipment

`fleet_safety_items` (+ `fleet_safety_inspections`, `fleet_safety_log`). Fields as legacy's form:
boat, category (the 9 legacy categories), name required, brand, model, serial, qty, install date,
expiry, next PM, last inspection, status (`active`/`expired`/`replaced`/`missing`), location, note.
`state` is computed (legacy `_flSafetyStatus`: REPLACED, MISSING, EXPIRED, DUE ≤ 30 days, SOON ≤ 90,
OK, or OK with no PM). Inspections `{date, inspector, result (pass/needs_work/fail/observation),
findings, next_due}`; after each change the latest pass or needs-work sets `last_inspect` and
`next_pm` (legacy `flSaveInspection`). Delete is a real delete, as legacy's.

### Reports

`GET /v1/fleet/reports/memo-spend?from=&to=` totals approved, received and paid memos by supplier,
memo type, scope/category and boat.

### Import

`npm run import:fleet [-- --commit]` (`src/tools/import-fleet.ts`, mapping in
`src/tools/legacy-fleet.ts`): a dry run unless `--commit`; reruns upsert by legacy id and replace the
imported child rows (movement ids `lg_…`), leaving rows made here. Warehouse spellings map to the
three; a movement with no warehouse takes the item's main one; where the movements do not add up to
legacy's stock, an `import` movement makes them match, listed. MO-077/MO-117 duplicates, the
PRJ-001…007 copies, duplicate stock items and odd values come as they are and are listed.
