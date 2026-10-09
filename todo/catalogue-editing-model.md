# Catalogue editing, legacy read

**Status:** legacy read (wt-lk-inbox@658298d, 2026-10-09); not designed yet.

Scope: adding and editing routes and boats, and a boat's seats for one day. The route calendar
(seasons, day overrides) is already built here and is only mentioned where it touches the rest.

## What legacy does

### Screens and who may edit

| Screen (menu key, area) | What it edits | Edit area legacy checks |
|---|---|---|
| Settings → **Programs** (`settings`, config) | add / edit / delete a route, drag to reorder, seasons and day overrides | `config` |
| Fleet → **Boat Status** (`fl-boatstatus`, fleet) | "+ Add Boat" and "Edit" on a boat | `config` (not `fleet`, see oddities) |
| Fleet → boat detail | Restore a retired boat | `fleet` |
| Boat Operation and By-trip "cap" button | one boat's seats for one day | `operations`, plus `act-capunlock` to raise |
| Accounting → Costing (`costing`) | meal venues, and which venue a route uses | none |
| `POST /api/b2c/routes` (server, `b2c-catalog.js`) | Love Kingdom creates a route | `X-Api-Key` only |

All area checks are in the browser (`laCanEditArea`, `01-auth-sync.js`). The server only refuses a
login with no edit rights at all (`s.edit===false`, `server.js` `/api/save` and `_batch`). A config
edit is skipped at save time: `save('config')` (`04-data-core.js`) returns without writing when the
user lacks `config`. Nothing tells the user; the change lives in the page until reload.

### Routes (`openRouteModal`, `saveRoute`, `delRoute` in `04-data-core.js`)

The route form ("เพิ่มโปรแกรม / แก้ไขโปรแกรม") has:

- **name**: required. A blank name makes Save do nothing, with no message.
- **islands**: free text ("เกาะ 5,6,7,8,9").
- **departure times**: a list of `HH:MM`. A new route starts with `08:00`. The last row cannot be
  removed, but blank rows are dropped on save.
- **location**: four buttons. Three are piers (`tublamu`, `panwa`, `ranong`); the fourth sets
  `kind = 'land'` and `pier = ''`. Otherwise `kind = 'marine'`.
- **family** (programme group) from a fixed list, `_BKV2_FAMILIES` in `08-app.js`: similan, surin,
  phiphi, krabi, whaleshark, selava, nyaung, transfer, citytour, activity. Blank is allowed and
  labelled "will not show on the Booking calendar". Picking land with no family fills `transfer`.
  Adding a family is a code change.
- **daily cap**: shown only for land. Blank or 0 = no limit (`null`).

Not on the form: **color** (a new route gets the next of 8 fixed colours, `ROUTE_COLORS`),
**code** (short code for the pier work schedule; nothing sets it), **ext_id**, **sort**.

On save:
- New route id is `'r' + Date.now()`. `seasons: []`.
- Edit overwrites name, islands, times, pier, kind, family, daily cap. No other checks: renaming,
  moving to another pier or switching marine ↔ land is allowed with bookings and deployments on it.

**Delete** (`delRoute`): a `confirm()` that says how many seasons go with it. No check for bookings,
deployments, seat locks, or rate types that use the route. The route, its times, seasons and day
overrides are removed.

**Reorder** (`stApplyRouteOrder`): drag within one pier group. It renumbers `sort` for every route
(0..n-1) and saves. Order is shown in Programs and wherever `laApplySort` runs.

**What a route's fields drive:**
- `kind` (`laRouteKind`): land routes have no boats, no pier tabs, no seat check. A row with no
  `kind` falls back to `pier === 'other'` → land, else marine.
- `familyId` (`bkV2RouteFamily`): which card the Booking calendar draws it under. `null` falls back
  to guessing from the name; `''` means "no family" and hides the route from that calendar.
- `dailyCap` (`getAllotment`, `04-data-core.js`): for a land route with a cap, sales are limited to
  `cap − sold − locked` and going over goes to approval. With no cap, a land route sells without
  limit. Marine routes ignore it.
- `mealVenueId`: the lunch venue for costing and the lunch order slip. Set on the Costing screen
  (`mvRouteSet`, `08-app.js`), saved through `save()` with **no area**.

### Love Kingdom creating routes (`b2c-catalog.js`, `POST /api/b2c/routes`)

The server-side way to add a route, used for the 43 land routes:
- Needs `externalId` (`^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`) and `name` (≤ 120 chars).
- **Idempotent on `externalId`**: if a route already has it, answers `200 created:false` with that
  route id and changes nothing. A unique index on `routes.extid` backs it.
- `kind` `marine|land`; marine needs a pier from the three. `pier: 'other'` is still accepted and
  means land.
- `familyId` must be in its own copy of the family list; when absent it is guessed (land → transfer
  or citytour; marine → from the name), and refused if it cannot be.
- `times` default `['08:00']`, each `HH:MM`. `seasons` are validated real dates, `to ≥ from`.
- `dailyCap` only for land (warning otherwise). `color` must be `#rrggbb`. `code` ≤ 16 chars.
- Warns (does not refuse) on: a duplicate name, no open season, no pricing, land with no daily cap.
- Optional `pricing` writes the route's seat prices into one rate type (that is sales, not here).
- `GET /api/b2c/routes[?externalId=]` lists routes with families and piers.

### Boats (`openBoatModal`, `flOpenEditBoatModal` in `06-engine-assign.js`, `saveBoat`)

The boat form has ~35 fields. The ones that matter to selling:
- **name**: required; blank = Save does nothing.
- **cap**: the seats sold. Defaults to 40; blank or 0 becomes 40.
- **licensePax**: registered passengers. Blank or 0 = `null`.
- **crew**, **fishcrew**; **totalcap** is filled in by the form as `licensePax + crew + fishcrew`
  (`fmCalcTotal`) but can be typed over.
- **pier**: home pier, one of the three. **type**: Catamaran / Speedboat / Big Boat / Longtail.
- **ownership**: `own` or `charter` (hired / partner boat). Charter boats are left out of engines,
  documents and fleet cost.

The rest is registration and fleet data: nameTh, brand, model, use, material, engineCount (1–5),
reg, callsign, imo, year, homeportCity, gt, nt, dwt, loa, beam, depth, draft, lbp, bhp, owner,
homeport, ownerAddr, note, documents (name + expiry), and a status (available / fixing /
unavailable) that appends a dated entry to the boat's status log.

**No rule is checked on save.** Legacy does not stop `cap > licensePax`, a duplicate name, or
changing `cap` on a boat with bookings. New boat id is `LA_UID('b')` (`b<epoch ms>`).

**No delete.** A boat can be retired (`flRetireBoat`, `05-fleet.js`) and restored
(`flUnretireBoat`), but no button calls `flRetireBoat`: only Restore is reachable. Retired boats are
hidden from Boat Operation and fleet lists.

A boat's day-to-day pier can also move through pier **assignments** (`boats.assignments`, fleet
screen), and its status log decides whether it can be deployed. Both are fleet data, not catalogue.

### A boat's seats for one day (`boatCapSet`, `boatCapModalOpen`, `08-app.js`)

A per-day replacement for `boat.cap`, keyed `'YYYY-MM-DD::boatId'`. The next day is normal again.

- **Opening the dialog** needs the `operations` edit area ("ต้องมีสิทธิ์แก้ไข Operations…").
  Reached from the "cap" button on Boat Operation (hidden on past days) and the seat count on the
  By-trip boat grid (not hidden on past days).
- **Never above the licence.** The value is clamped to `licensePax` (or `cap` when there is no
  licence) on save and again on every read (`boatCapInfo`). The input shows the warning
  "เกินที่นั่งจดทะเบียน… ปรับให้เป็น N แล้ว".
- **Raising above the normal cap needs `act-capunlock`** (admin always). Without it: "Not allowed:
  raising a boat above its normal capacity needs the special permission "unlock boat capacity"…".
  Lowering, or keeping a raise someone else set, needs only `operations`.
- **A reason is required** when the value differs from normal: "ใส่เหตุผลด้วยครับ…".
- Setting it back to normal, or "คืนค่าปกติ", deletes the override.
- Stored: `{cap, reason, by, at}`. `by` is meant to be the user's name.

**Who reads it:** `boatCapFor(boat, date)` replaces `boat.cap` in ~20 places: seats left on the
route-day (`getAssignedBoatsForRouteDate` → `getAllotment`), the ceiling when assigning bookings to
a boat, pier check-in cards, the B2C availability endpoint in `server.js` (same clamp, copied).

### The tolerance when putting bookings on a boat (`BA_CAP_TOL = 2`, `bkV2AssignBoat`)

Not catalogue, but it is why the day override exists:
- A boat may be filled to **cap + 2** when ops assigns bookings to it. Past that it is **blocked**.
- Blocked, with `act-capunlock` and still within the licence: a confirm offers "EMERGENCY ONLY: raise
  the capacity of X for this day?" and opens the day-seats dialog pre-filled; on save it assigns.
- Blocked without `act-capunlock`: "Raising the capacity for this day is an emergency step that needs
  the special permission…". Over the licence: "The licensed seats cannot be exceeded…".
- A boat chartered that day cannot take seat bookings at all.
- Bulk assign (`bkV2BoatAssignSelected`) skips and lists the ones that would overflow. Auto-assign
  (`baAutoAssign`) fills to cap first, then to cap + 2.

### Other catalogue-like screens (not in this note)

- **Team & Markets**, **Add-on Services** (config area): see `sales-editing-model.md`.
- **Meal venues** (`meal_venues`, Costing screen, no area check): 3 venues with adult/child prices,
  6 routes point at one. Money/costing, not catalogue.
- **Pier office lists** (pier area): `pier_kinds` 6, `pier_items` 41, `pier_codes` 13, `pier_sect` 5,
  `pier_lic_types` 2, `pier_lic_classes` 4, `pier_staff` 72. Day-of-operations at the pier.
- **Piers themselves** are not data: `tublamu`, `panwa`, `ranong` are hard-coded
  (`LA_PIER_ORDER`, `b2c-catalog.js` `PIERS`), plus `other` as the old land marker.
- **Pickup times setup**: already built here.

## How legacy stores it

Whole-state sync: the browser edits arrays in memory (`ROUTES`, `BOATS`, `BOAT_CAP_OVR`), writes the
blob to localStorage, and `01-auth-sync.js` pushes the diff to the server, which maps it to tables in
`operation_schemas` (`os-backend/src/mapping/field_mapping.json`).

| Table | Holds |
|---|---|
| `routes` | id, name, islands, color, pier, kind, dailycap, familyid, sort, code, extid, mealvenueid. Unique `routes_extid_uq` on non-empty extid. |
| `routes__times` | one row per departure time (`idx`, `value`) |
| `routes__seasons`, `routes__overrides` | the calendar (built here) |
| `boats` | the 34 columns above. `brand`, `model`, `retiredDate`, `retiredReason`, `unretiredDate` have no column. |
| `boats__docs`, `boats__log`, `boats__assignments`, `boats__repairhistory` | fleet data |
| `boat_capovr` | `key` = `'YYYY-MM-DD::boatId'`, cap, reason, by, at (text) |
| `trips` | the deployment board: one row per day with **fixed columns per boat** (`b1_route` … `b15_route`); boats added later go to `trips__boat` as JSON |

## Data

Read 2026-10-09 from the legacy database.

**Routes: 58.**
- `kind`: 43 land, 6 marine, 9 blank (all with a pier, so marine). 15 boat programmes in all.
- Piers: tublamu 7, panwa 6, ranong 2; land routes have pier `''`.
- Families: activity 36, transfer 4, citytour 3, similan 6, phiphi 4, krabi 1, whaleshark 1,
  surin 1, selava 1, nyaung 1. None blank or null.
- `extid` on all 43 land routes, none on marine. `dailycap` 0 rows. `code` 0 rows.
  `mealvenueid` 6 (the panwa routes). `sort` set on all 58. `islands` empty on 41.
- Times: 22 routes have exactly one; **36 (all `activity`) have none**. Values: 08:00 ×11,
  06:30 ×4, 07:00 ×2, 08:30 ×2, 05:30, 09:00, 10:00.
- No duplicate names. No booking trip and no rate type points at a missing route.

**Boats: 22.** 15 own (`ownership` blank), 7 `charter`. None retired.
- Piers: panwa 11, tublamu 8, ranong 3. Types: Speedboat 17, Catamaran 5.
- **7 have no licence** (all 7 charter boats), so no crew or totalcap either. README still says
  "three Ranong boats".
- Every licensed boat has `cap ≤ licensePax` and `totalcap = licensePax + crew`. `fishcrew` unused.
- `b1787213821911` is now named "Boat for Allotment Set": a stand-in, deployed on the Nyaung Oo Phee
  route (r1784882390130) every day 2026-10-24 → 2027-05-15 (166 days), no bookings on it. Ops uses
  it to give that route seats before a real boat is known. Migration 006 excluded it as a fake boat.

**Day seat overrides (`boat_capovr`): 6**, 2026-07-26 → 2026-10-09.
- All 6 raise (b10 44→46/47, b12 65→66/67/69). None lower; none over the licence.
- All have a reason. **All 6 have `by = '—'`** (see bugs). One reason is "TEST".

## Already here

- **Read:** `GET /v1/routes` (with the resolved calendar), `GET /v1/boats` (`charter_ceiling`).
- **Calendar writes:** seasons and day overrides, `config` area, `close_anyway`
  (README "Editing the calendar").
- **Copy from legacy:** `npm run sync:routes` and `npm run sync:boats` (legacy wins, never deletes,
  a boat with `cap > licence` is skipped). README says routes and boats are still edited in legacy.
- **Schema:** `routes` (+`kind`, `ext_id`, no unique index on it), `route_times`, `boats`
  (`capacity`, `license_pax`, `crew`; `CHECK capacity <= license_pax`), `boat_capacity_overrides`
  (`capacity`, `reason`; no `by`/`at`). Migrations 005, 021.
- **Day overrides** are imported only (`import-legacy.ts`); availability applies them, clamped to the
  licence (README "deployed_capacity"). There is **no write endpoint** (`legacy-replacement.md` §2,
  `deployment-guards-model.md` item 2).
- **Permissions:** `config`, `operations`, `fleet` areas and the `act-capunlock` action exist on
  users (`src/domain/users.ts`).
- **Assigning bookings to a boat** (`PATCH /operations/trip-ops/{trip_id}`, `src/domain/dispatch.ts`)
  checks only that the boat is deployed. It does **not** apply the cap + 2 tolerance or refuse a
  chartered boat.
- **Deployments carry their own `capacity`**: sent with `POST /operations/deployments`, or copied
  from the boat by the import. Legacy has no per-deployment capacity: it always reads the boat's
  current `cap` (+ day override).
- Not here: route create/edit/delete/reorder, route `daily_cap`, `code`, `meal_venue_id`, `islands`
  edits, boat create/edit, boat ownership/retired and the fleet fields, an equivalent of
  `POST /api/b2c/routes`.

## Bugs or oddities in legacy

1. **Boat edits by a fleet-only user are silently lost.** The boat form is on a fleet screen but saves
   through `save('config')`, which quietly does nothing without `config`.
2. **`by` is never recorded on day seat overrides.** `boatCapSet` reads a global `ME` that is private
   to `01-auth-sync.js`, so every row says `'—'`. The name shown in the dialog is always blank.
3. **Retire has no button.** `flRetireBoat` exists but nothing calls it; only Restore is reachable.
   `retiredDate`, `retiredReason`, `unretiredDate`, `brand`, `model` have no column and are lost on
   reload.
4. **No capacity rule on the boat form.** `cap > licensePax` can be saved (no row breaks it today).
   A blank or 0 `cap` silently becomes 40.
5. **Deleting a route checks nothing**: bookings, deployments, locks and rate types keep the old id.
6. **Families are listed twice and already differ.** `_BKV2_FAMILIES` has `activity`; `b2c-catalog.js`
   `FAMILIES` does not, so `POST /api/b2c/routes` refuses `familyId: "activity"`, although 36 routes
   use it (they were made another way).
7. **Land routes cannot be reordered.** Their drag group is `other` but their pier is `''`, so
   `stApplyRouteOrder` finds no routes, renumbers nothing useful, and still says "saved".
8. **Auto-assign ignores the day override** (`baAutoAssign` uses `boat.cap`), while manual and bulk
   assign use it.
9. **Meal venue changes have no area check** (`mvRouteSet` calls `save()` with no area; `mvPersist`
   has none).
10. **A stand-in boat** ("Boat for Allotment Set") is used to give a route seats ahead of time.
11. **The day-seats button is hidden on past days on Boat Operation but not on By-trip.**

## Questions for the developer

1. **Cut over routes and boats together, as one "catalogue" area?** Then legacy stops writing them
   and `sync:routes`/`sync:boats` retire. *Recommend yes*, once the write endpoints below exist; the
   calendar already moved.
2. **Which area guards boat edits: `config` (as legacy) or `fleet` (where the screen is)?**
   *Recommend `config` for the selling fields (name, pier, type, capacity, licence, crew, ownership)
   and `fleet` for registration and fleet data*, so the bug in item 1 cannot happen.
3. **How much of the boat form lives here?** *Recommend the selling fields now, and the registration
   and fleet fields with fleet maintenance (`legacy-replacement.md` §9)*, which is still undecided.
4. **Refuse `capacity > license_pax` on boat create/edit?** The schema already does. *Recommend yes,
   `400` with a message the form can show* (legacy allows it; no current row breaks it).
5. **When a boat's capacity changes, what happens to deployments already made?** Legacy changes every
   future day at once, because it reads the boat. Here deployments copy the capacity. *Recommend
   updating the boat's future deployments in the same write, and refusing (or `*_anyway`) when a day
   would end up with more passengers on the boat than seats*, like the deployment guards.
6. **Route delete: allow, or retire only?** Legacy deletes with no check; here bookings have a foreign
   key to routes. *Recommend refusing delete while anything refers to the route (`409` naming what),
   and adding nothing else until asked.*
7. **Route fields not here yet: `daily_cap`, `code`, `meal_venue_id`.** *Recommend `daily_cap` only
   when someone wants a land limit (0 rows use it; it would turn on seat checks for land routes,
   which today sell without limit here as in legacy), `code` no (unused), `meal_venue_id` with
   costing.*
8. **Families: a table, or a fixed list in code?** Legacy hard-codes ten and has already drifted.
   *Recommend a fixed, validated list in one place here (`GET` returns it), refusing unknown ids;
   a table only if ops asks to add families themselves.*
9. **Love Kingdom's "create a route" (`POST /api/b2c/routes`): take it over?** *Recommend yes as
   `POST /v1/routes` with `ext_id` idempotency (same `ext_id` → `200`, the existing route), a unique
   index on `ext_id`, and the Love Kingdom user allowed to call it.* Its pricing part belongs to rate
   types.
10. **Day seat override endpoint** (`PUT/DELETE /v1/boats/{id}/capacity-overrides/{date}`): copy
    legacy exactly? *Recommend: `operations` area; raising above the boat's capacity needs
    `act-capunlock`; above the licence is `400` (legacy clamps silently); a reason is required;
    store `by` and `at` (new columns), which legacy meant to and never did.* Also: allow past days?
    *Recommend no.*
11. **Bring the cap + 2 tolerance and the charter refusal to `PATCH /operations/trip-ops`?** They are
    legacy rules this API does not have. *Recommend yes, in the deployment-guards work: over cap + 2
    is `409` with legacy's message, and the client offers the day-seats dialog.*
12. **The stand-in boat.** Here a marine day with no boat already sells (`unplaced_pax`), so the
    stand-in may not be needed. *Recommend asking ops what limit they want on such days before
    copying the boat.*
13. **Retire boats here?** Legacy cannot actually retire one. *Recommend a `retired` flag set by a
    command (`POST /v1/boats/{id}/retire`, `/restore`), refused while the boat has future
    deployments.*

## Decided (2026-10-09)

1. **Routes and boats move together;** `sync:routes` and `sync:boats` retire once the edit endpoints exist.
2. **Boat edits need `config`** (all fields), as legacy.
3. **The whole boat form moves now,** all ~35 fields: selling, registration, the status log and
   documents with their rules (`fleet-maintenance-model.md` covers the rules).
4. **Capacity above the licence: copy legacy,** so it is accepted. This drops the schema check
   `capacity <= license_pax` (migration 005); sales stay capped at the licence by `deploymentSeats`.
5. **A capacity change** updates the boat's future deployments, and asks first (`*_anyway`) when a day
   would carry more passengers than the new seats.
6. **Route delete** is refused while anything uses it (`409` naming what).
11. **Capacity + 2 and the charter refusal on trip-ops:** built (README "Dispatch").
7. **Route fields:** none now; `meal_venue_id` and the venues list move with costing (Money reports);
   `daily_cap` when a land limit is wanted; `code` never.
8. **Families:** an editable table (ops add families).
9. **Love Kingdom creates routes** through `POST /v1/routes`: same `ext_id` → the same route; its
   login may call it.
10. **A boat's seats for one day:** `PUT/DELETE /v1/boats/{id}/capacity-overrides/{date}`, `operations`,
    raising above normal needs `act-capunlock`, a reason, who/when stored, over the licence `400`, no
    past days.
12. **The stand-in boat:** ask ops what limit they want on no-boat days first (in the checklist).
13. **Retire:** `POST /v1/boats/{id}/retire` and `/restore`; refused while the boat has future deployments.
