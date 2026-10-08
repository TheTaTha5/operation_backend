# Trip operations and van assignment, modelled

Design only, written 2026-10-06. **Nothing here is built.** It waits for approval (see "Decisions
needed" at the end).

- **Why now:** in ops mode the frontend's integration layer keeps all of this local only.
  `mergeInto` (`allotment_v2/js/ops/40-ops-bookings.js`) keeps `ops`, `upgrades`, `altPickups` and
  more from the local copy, and `fromServer` hands every trip `ops: {}`. So a reload, or any booking
  loaded from this service, has no boat, van, check-in or reconfirm. Once the legacy save stops
  carrying `sb_bookings`, nothing stores them at all.
- **Source (what the frontend writes):**
  - wt-lk-inbox@`658298d`, `allotment_v2/js/08-app.js`:
    - accessors: `bkOpsFor` / `bkOpsRead` / `bkOpsClear`
    - boat: `bkV2AssignBoat`, `bkV2BoatSplitApply`
    - vans: `bkV2AssignVan*`, `bkV2VanGroup*`, `bkV2SplitApply`, `bkV2VanUnsplit`,
      `bkV2SyncAltPickupSplits`, `bkV2SetSplitPickTime`, `bkV2SetPickupFinal`
    - check-in: `ckWrite` and its callers, `vckSetFlow`
    - reconfirm: `rcSetStatus`, `rcSendAgent`, `rcUnsendAgent`
    - pier note: `pckNoteSet`
    - upgrades: `bkV2UpgradeSave`, `bkV2UpgApply`
    - alternate pickups: the form handlers around `altPickups.push`
  - Legacy storage: `os-backend/src/mapping/field_mapping.json` (same checkout).
  - The integration layer: wt-operation-backend-integration@`50c41ae`
    (`allotment_v2/js/ops/40-ops-bookings.js`).
  - Prior design: `operation_frontend@6a11076 apps/web/docs/handoff/van-endpoints.md` (the Vue
    port's hand-off). This note builds on its rules R1–R18 and diverges where listed below.
- **Already here:**
  - **Tables:**
    - `booking_trip_operations` (013, reshaped by 016): `boat_id`, `pickup_time_final`,
      `return_same_van`, `upgrade`, `pier_checkin`, `reconfirm_*`
    - `vans`, `van_day_routes`, `van_status_ranges`, `van_days`, `van_groups`,
      `booking_trip_van_allocations` (all 016)
  - **Import:** `src/tools/import-legacy.ts` fills vans, groups, allocations, `pickup_time_final`
    and `return_same_van`.
  - **Endpoints:** none of these tables has one. **No endpoint reads or writes them.** The
    in-process store has none of them either.
  - **Write path:** the only code that touches them is `movedTripIds` in `writeTrips`. It deletes a
    moved trip's allocations and its whole `booking_trip_operations` row.

## Corrections to existing notes

These are recorded here because this design pass may only write this file.
`todo/booking-model.md` and `todo/vans.md` still need the same edits.

1. **`booking-model.md` says "`trip.ops.van_splits` — shape unknown". That's stale.**
   - Legacy has 13 bookings with splits, up to 6 parts each.
   - The keys are `ad chd inf foc pax vanGroup vanId vanReturnId vanSeq`, plus `fromAlt pickAreaId
     pickHotel pickZone altWho` on alternate-pickup parts and `main` on part 0.
   - 016 already models them as allocations. It misses two keys the code writes: **`pickTime`**
     (`bkV2SetSplitPickTime`, and `bkV2VanGroupSetTime` for a part with its own pickup point) and
     **`altWho`**.
2. **013's `upgrade` column is not the `ops.upgrade` flag.**
   - The flag is retired: `bkV2UpgApply` nulls it.
   - Legacy's `sb_bookings__trips.ops_upgrade` stores `trips[].upg`, the **route-upgrade record**
     `{fromRouteId, toRouteId, date, reason, charge, upgId, by, at}`. 0 rows today.
3. **`pier_checkin` / `van_checkin` are not scalars.** Each is a record with an event list and
   per-split slots (see Check-in below). 016 already dropped `van_checkin`, "for the check-in port".
4. **Reconfirm is written on the booking, not per trip.** `rcSetStatus` writes `bk.ops.reconfirm`
   directly, and legacy's `sb_bookings__trips.ops_reconfirm` has 0 rows. 013's per-trip `reconfirm_*`
   also lacks the "sent to agent" half (`sent`, `sentAt`, `sentBy`).
5. **`vans.md` says "the backend does not model add-ons". Stale since 018.** `booking_addons.type`
   now holds the `transfer-<route>-<PK|KL>-<vehicle>` add-on, so the effective zone (R9) is
   computable server-side. `groupZone` in `import-legacy.ts` is already a port of it.
6. **The hand-off's "Decided 2026-09-25: legacy is no longer reachable from the frontend" was for
   the Vue port.** Production is lk-inbox, which now switches per domain (`legacy | read | ops`).
   The hand-off also misses boat assignment, the pier note, reconfirm, `pickTime` and `altWho`.

## Fields

Every key under `bk.ops` / `trip.ops`, plus `upgrades`, `altPickups` and `trip.upg`. Day 1 of a
booking lives in `bk.ops`, later days in that trip's `trip.ops` (`bkOpsFor`). Here that's always
the `booking_trips` row of that date. The counts are active legacy bookings, 2026-10-06.

| Frontend key | Bucket | Home | Note |
|---|---|---|---|
| `ops.boatId` | Reference | `booking_trip_operations.boat_id` (exists) | Whole-trip boat. 3,867 rows. **Not imported today.** |
| `ops.boatSplits[]` | Repeating group | **new** `booking_trip_boat_splits` | `{ad,chd,inf,foc,boatId}` per part; `pax` derived. 1 row. Legacy keeps `boatId` = part 0 for old readers; here, a split trip has `boat_id` NULL and the parts are the truth. |
| `ops.vanGroup` / `vanId` / `vanSeq` / `vanReturnId` | Reference / scalar | `van_groups`, `booking_trip_van_allocations` (exist) | The van lives on the group. Legacy has 0 vans set without a group (3,048 vans, 3,119 grouped). |
| `ops.vanSplits[]` | Repeating group | `booking_trip_van_allocations` (exists) + **new** `pick_time`, `alt_who` | `pax` and `main` derived (sum; idx 0). `fromAlt` → `source='alt_pickup'`. |
| `ops.altSplitAuto` | Derived | — | Never had a legacy column (`_bkV2IsAltAutoSplit` reads the parts instead); `source='alt_pickup'` carries it. |
| `ops.pickupTimeFinal` | Scalar | `booking_trip_operations.pickup_time_final` (exists, `HH:MM` CHECK) | 791 rows: 577 `HH:MM`, 45 `H:MM`/`HH.MM` (rewritable), **83 ranges and 86 free text that don't fit** (see Open). *2026-10-08: the 86 are `08.00 a.m.`-style single times and pier deadlines; all fit migration 024's window fields.* |
| `ops.returnSameVan` | Scalar | `booking_trip_operations.return_same_van` (exists) | 11 rows. |
| `ops.pierNote {t,at,by}` | Fixed-size struct | **new** `booking_trip_operations.pier_note`, `pier_note_at`, `pier_note_by` | 126 rows, all objects. |
| `ops.vanCheckin`, `ops.pierCheckin` | Overwritten record + repeating group | **new** `booking_trip_checkins` + `booking_trip_checkin_events` | 1,738 van and 2,040 pier rows. **Not imported today.** |
| `…Checkin._s{i}`, `ops.vanCkS` / `ops.pierCkS` | Repeating group | `booking_trip_checkins.slot` | Per van-split slot (max 3). `vanCkS`/`pierCkS` never had a column, so legacy dropped them on save (`§ckSlotFix`). |
| `…Checkin.noShow` | Derived | — | `max(0, expected − actualPax)`. Holds on 3,773 of 3,778 rows. |
| `ops.reconfirm` | Overwritten record | **new** `booking_reconfirmations` (booking level) | 2,669 rows. Status values: `done` 2,617, `wa` 45, `off` 5, `noans` 1, blank 1 (sent only). `via`: `reconfirm` 2,663, `phone` 2, `list` 3. `sent` ⇔ `sentAt` set (479/479). |
| `ops.pfm` | — | **out of this slice** | Unpaid-proforma travel decision (`approved`/`hold`). Belongs with approval/payments. Legacy has **no column**, so it's dropped on every save today. |
| `ops.upgrade` | — | not stored | Retired flag (`bkV2UpgApply` nulls it). |
| `trip.upg` | Overwritten record | **new** `booking_trip_upgrades` (append-only) | Route upgrade, written by `bkV2UpgApply`/`bkV2UpgUndo`. 0 legacy rows (feature from 2026-10-03). |
| `upgrades[]` | Repeating group (money) | **new** `booking_upgrades` | On-tour upsell sale ("Longtail · Join → เหมา", "Boat upgrade"…). 11 rows / 10 bookings. `commission` derived (`sellPrice − toCompany`, 11/11). `slips` → Open. |
| `altPickups[]` | Repeating group | **new** `booking_alt_pickups` | Sales-form field. 4 bookings, 5 entries, max 2. |
| `ops.dropSplits`, `ops.van` | — | not stored | Comments only. `dropSplits` is forbidden by its own comment, and `ops.van` is a stale read. |

## Schema

Proposed as `migrations/022_trip_dispatch.sql`. Everything is additive. Nothing here changes a row
that exists.

```sql
-- Day-of-operations dispatch that 013/016 left out: the pier note, boat splits, per-part pickup
-- time, check-in, reconfirmation, alternate pickups and on-tour upgrades. Shapes from wt-lk-inbox
-- (todo/trip-ops-and-vans-model.md); counts from legacy production, 2026-10-06.

-- The pier note for one departure (legacy ops.pierNote {t, at, by}).
ALTER TABLE booking_trip_operations
  ADD COLUMN pier_note TEXT,
  ADD COLUMN pier_note_at TIMESTAMPTZ,
  ADD COLUMN pier_note_by TEXT;

-- A trip split across boats (legacy ops.boatSplits), only when there are two boats or more. A whole
-- trip on one boat is booking_trip_operations.boat_id. Its pax is the trip's, so it never needs
-- adjusting when the booking is amended.
CREATE TABLE booking_trip_boat_splits (
  booking_trip_id TEXT NOT NULL REFERENCES booking_trips (id) ON DELETE CASCADE,
  idx INTEGER NOT NULL CHECK (idx >= 0),
  boat_id TEXT NOT NULL REFERENCES boats (id),
  ad INTEGER NOT NULL DEFAULT 0 CHECK (ad >= 0),
  chd INTEGER NOT NULL DEFAULT 0 CHECK (chd >= 0),
  inf INTEGER NOT NULL DEFAULT 0 CHECK (inf >= 0),
  foc INTEGER NOT NULL DEFAULT 0 CHECK (foc >= 0),
  PRIMARY KEY (booking_trip_id, idx),
  UNIQUE (booking_trip_id, boat_id)
);

-- A van part's own pickup time and whose pickup it is (legacy vanSplits[].pickTime / altWho). Only
-- an alternate-pickup part carries them, as with the pick_* columns.
ALTER TABLE booking_trip_van_allocations
  ADD COLUMN pick_time TEXT CHECK (pick_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  ADD COLUMN alt_who TEXT,
  ADD CHECK (source = 'alt_pickup' OR num_nonnulls(pick_time, alt_who) = 0);

-- Check-in, per departure, per side (van or pier), per van part. slot 0 is the main part.
-- Legacy kept the times staff type as clock text (HH:MM) and the instants as ISO, so both are here.
CREATE TABLE booking_trip_checkins (
  booking_trip_id TEXT NOT NULL REFERENCES booking_trips (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('van', 'pier')),
  slot INTEGER NOT NULL CHECK (slot >= 0),
  expected INTEGER CHECK (expected >= 0),
  actual_pax INTEGER CHECK (actual_pax >= 0),
  checked_in_at TIMESTAMPTZ,                 -- legacy at; NULL = not checked in
  checked_in_by TEXT,
  reason_code TEXT,                          -- not_down, sick, cancel_onsite, no_contact, own_transfer, other
  reason_note TEXT,
  reason_at TEXT CHECK (reason_at ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  arrived_at TIMESTAMPTZ, arrived_by TEXT,   -- pier stages (§pierStage)
  cleared_at TIMESTAMPTZ, cleared_by TEXT,
  flow TEXT CHECK (flow IN ('standby', 'pending')),   -- van row state; the rest is derived from at/events
  flow_at TEXT CHECK (flow_at ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  flow_by TEXT, flow_note TEXT,
  reinstate_at TEXT CHECK (reinstate_at ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  reinstate_by TEXT, reinstate_ts TIMESTAMPTZ,
  self_add_pax INTEGER CHECK (self_add_pax >= 0),    -- came to the pier on their own
  self_add_ad INTEGER, self_add_chd INTEGER, self_add_inf INTEGER, self_add_foc INTEGER,
  self_add_at TEXT, self_add_by TEXT, self_add_ts TIMESTAMPTZ, self_add_note TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT,
  PRIMARY KEY (booking_trip_id, kind, slot)
);

-- No-show and on-site cancellations, in order. Never deleted: a mistaken one is marked undone.
CREATE TABLE booking_trip_checkin_events (
  booking_trip_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  slot INTEGER NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 0),
  type TEXT NOT NULL CHECK (type IN ('no_show', 'cxl')),
  pax INTEGER NOT NULL CHECK (pax >= 0),
  ad INTEGER, chd INTEGER, inf INTEGER, foc INTEGER,  -- legacy paxBreak; absent on 3 of 86
  reason_code TEXT, note TEXT,
  at TEXT CHECK (at ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  by TEXT, ts TIMESTAMPTZ,
  undone_why TEXT CHECK (undone_why IN ('found', 'mistake')),
  undone_at TEXT, undone_by TEXT, undone_ts TIMESTAMPTZ, undone_note TEXT,
  PRIMARY KEY (booking_trip_id, kind, slot, seq),
  FOREIGN KEY (booking_trip_id, kind, slot) REFERENCES booking_trip_checkins ON DELETE CASCADE
);

-- Reconfirmation: did the customer confirm, and was the list sent to the agent. One per booking,
-- as legacy writes it. 013's per-trip reconfirm_* columns are left unused.
CREATE TABLE booking_reconfirmations (
  booking_id TEXT PRIMARY KEY REFERENCES bookings (id) ON DELETE CASCADE,
  status TEXT CHECK (status IN ('wa', 'noans', 'off', 'callback', 'done')),
  via TEXT CHECK (via IN ('reconfirm', 'phone', 'list')),
  at TIMESTAMPTZ, by TEXT,
  sent_at TIMESTAMPTZ, sent_by TEXT,          -- NULL = not sent to the agent
  CHECK (status IS NOT NULL OR sent_at IS NOT NULL)
);

-- Extra pickup or drop-off points inside one booking (sales form). The server derives the
-- alternate-pickup van parts from these (Decision 4).
CREATE TABLE booking_alt_pickups (
  booking_id TEXT NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 0),
  who TEXT,
  ad INTEGER CHECK (ad >= 0), chd INTEGER CHECK (chd >= 0),
  inf INTEGER CHECK (inf >= 0), foc INTEGER CHECK (foc >= 0),
  area_id TEXT, area TEXT, zone TEXT, place TEXT,             -- area: name snapshot
  drop_same BOOLEAN,
  drop_area_id TEXT, drop_area TEXT, drop_zone TEXT, drop_place TEXT,
  PRIMARY KEY (booking_id, seq)
);

-- On-tour upsells sold to the customer (legacy upgrades[]). commission = sell_price - to_company,
-- computed, not stored.
CREATE TABLE booking_upgrades (
  booking_id TEXT NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 0),
  id TEXT NOT NULL,                                -- client id ('up_<ms>'); a route upgrade links to it
  label TEXT NOT NULL,
  sell_price NUMERIC(12,2) NOT NULL CHECK (sell_price >= 0),
  to_company NUMERIC(12,2) CHECK (to_company >= 0),
  seller TEXT, note TEXT,
  collected BOOLEAN,
  settle TEXT CHECK (settle IN ('pending', 'done')),
  method TEXT,                                      -- cash | card seen; see Open
  fee_pct NUMERIC(5,2), fee NUMERIC(12,2), customer_paid NUMERIC(12,2),
  at TIMESTAMPTZ,
  PRIMARY KEY (booking_id, seq),
  UNIQUE (booking_id, id)
);

-- A trip moved to another programme (legacy trips[].upg), kept even after an undo.
CREATE TABLE booking_trip_upgrades (
  id BIGSERIAL PRIMARY KEY,
  booking_trip_id TEXT NOT NULL REFERENCES booking_trips (id) ON DELETE CASCADE,
  from_route_id TEXT NOT NULL REFERENCES routes (id),
  to_route_id TEXT NOT NULL REFERENCES routes (id),
  reason TEXT NOT NULL,
  charge NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (charge >= 0),
  upgrade_id TEXT,                                  -- booking_upgrades.id when charged
  at TIMESTAMPTZ NOT NULL DEFAULT now(), by TEXT,
  undone_at TIMESTAMPTZ, undone_by TEXT
);
```

Not proposed, because the data says to wait:
- **A foreign key on `booking_trip_operations.boat_id`.** Four boats that legacy assigns are not
  in our catalogue (Open 1).
- **A NOT NULL on `booking_trip_checkin_events.ts`.** All 86 rows have it, but it describes legacy
  data.
- **`pax > 0` on events.** The writer only pushes positive counts, but that isn't verified on data.

## Contract

Two permission areas, following the existing `preHandler` split (`src/routes/operations.ts`):

| Area | What | Read | Write |
|---|---|---|---|
| Booking fields | `alt_pickups`, `upgrades`, `reconfirm` | `booking:read` | `booking:write` |
| Dispatch | boat, van, check-in, pier note, vans | `operations:read` | `operations:write` |

Errors follow the codebase:
- **400** for malformed input, naming the field and index.
- **404** for an unknown booking, trip, group or van.
- **409 with a machine `code`** for a rule refusal, the way `booking-actions.ts` does it. There is
  no 422 in this API, so the hand-off's 422s become 409s.

### Reads: embedded where the frontend already looks

The frontend reads dispatch from the booking document, so it's returned there. That applies to
`GET /v1/bookings`, `GET /v1/bookings/{id}`, `GET /v1/manifest` and every write's response:

```json
{
  "id": "lg_BK-26090271-GR81",
  "reconfirm": { "status": "done", "via": "reconfirm", "at": "2026-09-09T10:02:11Z", "by": "Nok",
                 "sent_at": "2026-09-09T11:00:00Z", "sent_by": "Nok" },
  "alt_pickups": [ { "who": "Mr B", "ad": 2, "chd": 0, "inf": 0, "foc": 0, "area_id": "pa_kata", "area": "Kata",
                     "zone": "PK", "place": "Kata Palm", "drop_same": true } ],
  "upgrades": [ { "id": "up_1789...", "label": "Longtail · Join → เหมา (Charter)", "sell_price": 1100, "to_company": 0,
                  "commission": 1100, "seller": "Kai", "collected": true, "settle": "pending", "method": "card",
                  "fee_pct": 3, "fee": 33, "customer_paid": 1133, "at": "2026-09-10T08:44:37Z" } ],
  "trips": [ {
    "id": "trip_lg_BK-26090271-GR81_0", "route_id": "r10", "service_date": "2026-09-12",
    "operations": {
      "boat_id": "b2", "boat_splits": [],
      "pickup_time_final": "06:40", "return_same_van": false,
      "pier_note": { "text": "Late, call guide", "at": "2026-09-12T05:50:00Z", "by": "Ploy" },
      "van_parts": [ { "idx": 0, "source": "main", "ad": 2, "chd": 1, "inf": 0, "foc": 0,
                       "group": { "id": "vgrp_…", "number": 3, "van_id": "veh07", "return_van_id": null, "pickup_time": "06:40" },
                       "sequence": 2, "return_van_id": null } ],
      "checkins": { "van":  [ { "slot": 0, "expected": 3, "actual_pax": 3, "no_show": 0, "checked_in_at": "…", "flow": "standby", "events": [] } ],
                    "pier": [] }
    }
  } ]
}
```

- `operations` is always present, with empty lists and nulls when nothing is set.
- A trip with no van rows reports one virtual `idx 0` part holding the full pax, as 016 intends.
- `no_show` and `commission` are computed.

For the cross-booking views:
- **`GET /operations/van-groups?date=&route_id=`** returns the groups of a day, with member count,
  pax and capacity (R4, R5).
- The hand-off's computed `GET /operations/van-board` (pools, rounds, warnings) stays a later
  phase. It's the Vue port's need. lk-inbox computes the board client-side from the data above.

### Writes

**Dispatch, one departure:** `PATCH /operations/trip-ops/{trip_id}` (`operations:write`)

```json
{ "boat_id": "b2", "pickup_time_final": "06:40", "return_same_van": false,
  "pier_note": "Late, call guide",
  "van_parts": [ { "idx": 0, "ad": 2, "chd": 0, "inf": 0, "foc": 0, "group_id": "vgrp_…", "sequence": 1 },
                 { "idx": 1, "ad": 0, "chd": 1, "inf": 0, "foc": 0, "group_id": null, "source": "manual" } ] }
```

- **Field semantics:** an absent field is unchanged and `null` clears it. A list (`van_parts`,
  `boat_splits`) replaces the old one outright. `pier_note` is text; the server stamps `at` and
  `by` from the token.
- **Boat:**
  - Send `boat_id` *or* `boat_splits`. Both → 400.
  - A boat must be deployed on the trip's route that day → 409 `boat_not_deployed`. Legacy obeys
    this on 3,742 of 3,743 assignments.
  - Splits need ≥2 distinct boats whose pax sum to the trip's → 400.
- **Van parts:**
  - Pax may not exceed the trip's → 400.
  - Joining a group from another zone → 409 `zone_mismatch`.
  - Grouping a NoTransfer part → 409 `self_arrive`.
  - Any dispatch write on a released booking → 409 `cancelled` (R1).
  - `return_same_van: true` together with a `return_van_id` → 400 (R11).
- **Response:** `{ trip, warnings }`, as the hand-off's G2 asks.

**Van groups** (`operations:write`). These are cross-booking, so they're atomic here rather than
assembled from per-trip patches:

| Method + path | Body | Rule (hand-off) | Refusals |
|---|---|---|---|
| `POST /operations/van-groups` | `{service_date, route_id, zone, members:[{trip_id, idx}], van_id?}` | next number under an advisory lock `van:<date>:<route>`; members get `sequence` 1..n | 409 `zone_mismatch` / `self_arrive` / `cancelled` / `van_over_capacity` |
| `POST /operations/van-groups/{id}/members` | `{members:[…]}` | moves parts out of their old group (R4) | same |
| `PATCH /operations/van-groups/{id}` | `{van_id?, return_van_id?, pickup_time?, allow_second_round?}` | R2 pool, R4, R6. `pickup_time` also writes each member's `pickup_time_final`, or `pick_time` for an own-pickup part (`bkV2VanGroupSetTime`) | 409 `van_not_in_pool` / `van_over_capacity` / `van_in_other_group` |
| `PUT /operations/van-groups/{id}/order` | `{members:[…]}` or `{clear:true}` | R12 | 400 if not exactly the members |
| `DELETE /operations/van-groups/{id}` | — | disband (R13); keeps `pickup_time_final` | 404 |
| `POST /operations/van-groups/clear` | `{service_date, route_id}` | nulls every group's van (R14) | — |

**Check-in** (`operations:write`):
- `PUT /operations/trip-ops/{trip_id}/checkins/{van|pier}/{slot}` replaces one record, events
  included. That's how `ckWrite` already writes it: the whole record each time.
- `DELETE` on the same path clears the record.
- Errors:
  - `slot` beyond the trip's van parts → 400.
  - `actual_pax` above the booked pax, unless `self_add_pax` covers it → 400.
  - An event whose `undone` is removed → 409 `event_undone_is_final`.
  - Event order is append-only, so a PUT that shortens `events` → 409 `events_append_only`.

**Reconfirm** (`booking:write`):
- `PUT /v1/bookings/{id}/reconfirm {status, via?}`: the server stamps `at` and `by`.
- `DELETE` on the same path clears it (keeping `sent_*` if the list was sent, as `rcSetStatus` does).
- `POST /v1/reconfirm/sent {booking_ids:[…], sent:true|false}` is the agent-list send and undo
  (`rcSendAgent` / `rcUnsendAgent`). It stamps `sent_at` and `sent_by`.

**Booking fields** (`booking:write`): `altPickups`/`alt_pickups` and `upgrades` are accepted on
`POST /v1/bookings` and `PATCH /v1/bookings/{id}`. Each list replaces outright, with absent =
unchanged and `[]` = clear, exactly like `passengers` and `addOns`. A malformed entry is a 400 with
its index (`upgrades[1].sell_price must be a number ≥ 0`).

**Route upgrade** (`booking:write`), a later slice:
- `POST /v1/bookings/{id}/upgrade {trip_id, to_route_id, reason, charge}` checks seats on the
  target the way reschedule does. It records a `booking_trip_upgrades` row, adds a `booking_upgrades`
  row when `charge > 0`, and adds a history line.
- `POST /v1/bookings/{id}/upgrade/undo {trip_id}` reverses it, and drops the charge only if it
  isn't collected.

**Vans and the month matrix** (`operations:*`):
- `GET /operations/vans`, `POST /operations/vans`, `PATCH /operations/vans/{id}`. There is no
  delete; set `active=false`.
- `GET /operations/van-days?from=&to=` returns the matrix routes, status, driver override,
  `sent_at`, and the status ranges.
- `PUT /operations/van-days/{date}/{van_id}` with `{route_ids?, status?, driver?, driver_phone?,
  plate?, sent_at?}`.
- `POST /operations/vans/{id}/status-ranges` and
  `DELETE /operations/vans/{id}/status-ranges/{range_id}`.

### What both stores need

Pure functions in `src/domain/`, called by both stores (the `calendar.ts` pattern):
- **`dispatch.ts`:** the `PATCH trip-ops` parser and validator, plus the move rule below.
- **`effectiveZone(trip, booking, addOnTypes)`:** move `groupZone` out of `import-legacy.ts`.
- **`vanPool` / `returnPool` / `groupPax` / `rounds`:** R2–R7, unit-tested like `capacity.test.ts`.
- **`checkin.ts`:** the record parser and the append-only event rule.
- **`shrinkAllocations(parts, tripPax)`:** idx 0 shrinks first (`vans.md` open item).
- **`altPickupParts(altPickups, tripPax, current)`:** port of `bkV2SyncAltPickupSplits`, if
  Decision 4 says the server builds them.

`OperationsStore` needs in-memory maps for every table above. It has none of the 016 tables today.

**The move rule needs changing in both stores.**
- Today `writeTrips` deletes a moved trip's whole `booking_trip_operations` row.
- Legacy's `bkOpsClear` clears the boat, vans, splits, `pickupTimeFinal` and both check-ins, but
  **keeps the pier note** (and reconfirm, which is booking level here).
- So the move should null those columns and delete allocations, boat splits and check-ins, and keep
  the row with `pier_note`.
- **A route change isn't a date change** (Decision 6).

## Data check — 2026-10-06, legacy production, read-only

5,146 bookings, 5,155 trips. Day-2+ trip-level ops are almost unused: 6 boat ids, 4 pier
check-ins, nothing else.

| Check | Result |
|---|---|
| Boat assigned on day 1 (active bookings) | 3,743. 3,742 on a boat deployed on that route and date, 1 on no deployment, 0 on another route. Charters: 37, 0 disagree with `charterboatid`. |
| Boat on a released booking | 124 (skip, like van data: R1) |
| Boat ids missing from our `boats` | **4**: LKC66 (56 assignments, 25 deployments), LKC77 (8, 2), LKC33 (1, 1), สบายดีทัวร์ (1, 1) |
| Van set without a group | 0 of 3,048 |
| `pickupTimeFinal` | 577 `HH:MM`, 45 rewritable, 83 ranges, 86 free text |
| Check-in records | van 1,738 · pier 2,040 · trip-level pier 4. `_s` slots on 6, max 3. Events: 86 (`cxl` 54, `no_show` 32, 3 undone, 3 without `paxBreak`). `flow`: `standby` 657, `pending` 74. Every `at` is ISO; every `reasonAt`, `flowAt` and event `at` is `HH:MM`. |
| `noShow = max(0, expected − actualPax)` | 3,773 / 3,778 |
| Reconfirm | 2,669 rows, 5 on multi-day bookings, 0 trip-level. Every status and `via` value is inside the CHECKs above. |
| Pier note | 126, all `{t, at, by}` |
| Van splits | 13 bookings, max 6 parts. 0 legacy rows carry `pickTime` (the writer is newer than the data). |
| Boat splits | 1 (`b12` 60 + `b11` 60) |
| `altPickups` | 4 bookings, 5 entries. 1 old-shape entry has `qty` and no `ad/chd/inf/foc`. |
| `upgrades[]` | 11 rows, 10 bookings, all "Longtail · Join → เหมา (Charter)". `settle` always `pending`. `method`: card 7, cash 1, blank 3. 7 with slips. |
| `trips[].upg` (`ops_upgrade`) | 0 |

## Expand / contract

- **This slice only adds.** It brings new tables and columns, endpoints, and both stores.
- **No dual-write or backfill:** legacy is another database.
- **013's per-trip `reconfirm_*`, `upgrade` and `pier_checkin` columns stay unused.** Dropping them
  is a separate, later decision.

## Decisions

**Decided 2026-10-06:**
- 1–4 and 6 as proposed below.
- 5: add a `pickup_note` text column. `pickup_time_final` keeps its `HH:MM` CHECK, and the importer
  moves any value that is not a single time (a range, or text such as `Before 09:40 at pier`) into
  `pickup_note` instead of dropping it. *(Replaced 2026-10-08 by `todo/pickup-window-model.md`: the
  values are windows and pier deadlines, not free text, so migration 024 adds
  `pickup_time_final_end` and `pickup_final_at_pier` instead, and every legacy value imports.)*
- 7: keep the staff name the client sends inside check-in records, and always stamp `updated_by`
  from the token. Logins are per person: legacy accounts move into this service with their existing
  usernames and passwords.

The questions as they were asked:

1. **Order of slices.** Proposed:
   - **A:** dispatch (boat, van parts, groups, pickup final, pier note), the reads, and the
     vans/van-days endpoints.
   - **B:** reconfirm.
   - **C:** check-in.
   - **D:** alternate pickups.
   - **E:** upgrades (on-tour sales, then the route-upgrade action).

   A and B carry the most rows (boat 3,867, groups 3,119, reconfirm 2,669).
2. **Boat shape.** Whole trip in `boat_id`, with a split table only for ≥2 boats (proposed:
   99.97% of rows need no pax bookkeeping). Or one table with an idx-0 row for every trip, the
   way vans work, which then needs its counts kept in step on every amendment.
3. **What an amendment does to a split boat trip** whose pax changes: clear the split (proposed,
   with a warning in the response), or refuse with 409.
4. **Alternate pickups → van parts:** does the server build the alternate-pickup parts from
   `alt_pickups` (port `bkV2SyncAltPickupSplits`), or does the client send them in `van_parts`?
   This is the hand-off's Q3. Proposed: the server builds them, because otherwise two clients can
   disagree.
5. **`pickup_time_final` keeps its `HH:MM` CHECK**, so 169 legacy values (83 ranges, 86 free
   text such as `Before 09:40 at pier`) won't import. The importer already drops and counts them.
   Accept that loss, or add a separate `pickup_note` text column for them.
6. **A route upgrade, and the move rule.** Today a route change counts as a move, so it clears the
   **van** as well as the boat. Legacy's upgrade clears only the boat. It keeps the van group
   *number*, which then points at a different route's group: a silent legacy bug. Proposed: keep
   clearing both.
7. **Who `by` is.** Check-in events carry the staff name the client sends (legacy `ckMe()`).
   Reconfirm and the pier note are stamped from the token. Accept client-sent names inside
   check-in records (proposed, and the row's `updated_by` comes from the token), or stamp
   everything server-side. This depends on the login decision (legacy authentication).

## Open

1. ~~**The boat catalogue is stale, like routes were before `sync:routes`.**~~ **Closed
   2026-10-08:** `npm run sync:boats` (merged in `c68001a`) copies legacy's boats; run it before the
   import so no deployment is skipped. The original note: Four legacy boats are
   missing. That's 66 active boat assignments here, and **29 legacy deployments the import skips
   today** ("boat not in catalogue"), so those seats are missing from our availability now. It
   needs a `sync:boats` (or an extension of `sync:routes`) before the boat FK, and before any
   import.
2. **Upgrade `slips`** (7 rows) are payment-slip attachment references (`/api/attach/{id}`).
   Attachments have no home here. They're left out until they do.
3. **Upgrade `method`:** the shared payment block (`_bkExtraPay`) may also produce `cot` (cash on
   tour). Only `card`/`cash`/blank appear in the data, so it isn't constrained yet.
4. **`upgrades` money fields overlap the payments model** (`collected`, `settle`, `customer_paid`).
   When `paymentStatus` and `invoiceId` are modelled, check whether these move there.
5. **`ops.pfm`** (unpaid-proforma travel decision) has no legacy column and is lost on every save
   today. It belongs with the approval/payments model.
6. **A deployment deleted under bookings assigned to that boat.** The deployment-delete endpoint
   and the import's mirror delete both leave `boat_id` pointing at a boat that no longer sails that
   day. Clear it, or refuse the delete?
7. **Five check-in rows** where `noShow` ≠ `expected − actualPax`. The import recomputes, so these
   change on import.
8. **The split `returnSameVan`** is read (`L.sp.returnSameVan`) but never written, so it isn't
   stored.

## Follow-ups

- **`src/tools/import-legacy.ts` is not extended by this slice.** Until it is, every legacy booking
  imported at cutover will have **no boat (3,867), reconfirm (2,669), check-in (3,778), pier note
  (126), alternate pickups (4) or upgrades (11)**.
- `todo/booking-model.md` and `todo/vans.md` need the corrections listed at the top.
