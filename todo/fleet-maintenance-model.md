# Fleet maintenance, legacy read

**Status:** legacy read (wt-lk-inbox@658298d, 2026-10-09); decided 2026-10-09. Part A (availability,
assets, incidents, jobs) is built; part B (stock, memos, Daily Fleet Log, projects, safety) is another branch.

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

1. **Seams to part B, wired at merge** (`src/routes/fleet.ts`):
   - `openWork`: add projects `inprogress`/`on_hold` from `actual_from ?? plan_from`, status
     `unavailable`, reason `dry_dock`/`overhaul` (legacy `boatJobBlock`), so a project holds its boat;
   - `hoursOf`: the Daily Fleet Log's meter readings per engine (`engineHours(e, meters)`), so `hours`,
     `service` and the gearbox lifetime count real running hours (today `base_hours`);
   - `memosOf`: the job's memos (`{status, memo_type, amount, item_names}`), so `cost` includes them
     (today parts only; `legacy_cost` shows legacy's figure);
   - job parts from stock (`flMaintAddPart`, `flMaintRemovePart`, the "late edit"): a stock movement,
     part B's. Parts are imported and shown; no command adds or removes one yet;
   - a job made under a project writes onto the project's log (`_projCreateForId`); here it only
     writes its own line naming the project id.
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