# Rate types, modelled

## Shipped — 2026-10-07

- **Migration `022_rate_types.sql`**: the six tables below, with every constraint the data check
  cleared. Applies on an empty database and on top of 001–021; a rerun applies nothing.
- **`src/domain/rate-types.ts`**: reading and refusing requests, the pier → zones rule, request →
  rows, rows → detail and summary. Both stores call it and hold the same rows.
- **Both stores**: `OperationsStore` and `PostgresOperationsStore` (`listRateTypes`, `rateType`,
  `createRateType`, `patchRateType`, `putRateTypeRoute`, `deleteRateTypeRoute`, `deleteRateType`).
- **Endpoints**: `GET /v1/rate-types`, `GET/PATCH/DELETE /v1/rate-types/{id}`, `POST /v1/rate-types`,
  `PUT/DELETE /v1/rate-types/{id}/routes/{route_id}`. Documented in `README.md` → "Rate types".
- **Tests**: `test/rate-types.test.ts`, 19 tests, passing on both stores; two compare PostgreSQL
  with the in-process store.

Changed from the design below:

- **Codes are generated from the name alone** (`STANDARD-2026`). Legacy prefixes the salesperson's
  name; that needs the caller's salesperson in the token, which is undecided.
- **`created_on` is not accepted by the API.** It is legacy's `createdDate`, and only the importer
  will fill it; `created_at` is this service's own.

### The importer — shipped 2026-10-07

`src/tools/import-legacy.ts` reads the 15 legacy tables (the per-route transfer tables found by
name) and maps them with the pure `src/tools/legacy-rate-types.ts` (`test/legacy-rate-types.test.ts`).
Rate types keep legacy's ids and are upserted. Under each, only `LEGACY_HOLDS` is replaced (zones
PK/KL/NoTransfer, speedboat/catamaran charters, the longtail add-on, transfers on the legacy table
routes); RN prices, longtail charters, other routes' transfers and `applies_to` survive a re-run. A
code already owned by another rate type here is skipped and listed rather than aborting the run.

**Rehearsed 2026-10-07** against production legacy (read-only) into a throwaway local target that
`sync:routes` and `sync:boats` had filled first:

- 84 of 84 rate types, 519 routes, 10,438 seat prices, 251 charter rows, 155 longtail rows,
  1,530 transfer prices. One issue listed: `rtmuticommw2ho7` r11 `travel_to "20207-05-15"`.
- `rt003` read through `GET /v1/rate-types/rt003` matched legacy's own rows cell for cell (PK, KL,
  NoTransfer, foreign and Thai, adult and child; the speedboat charter).
- A second run changed no count. Then, after an RN price, a longtail charter, a transfer on r7 and a
  bundle `applies_to` were entered through the API, a re-run kept all four, and put a hand-changed
  PK price (2500 → 99) back to legacy's 2500.

Still open: running the import in production; then the `agents.rate_type_id` FK migration, which
cannot ship before it; then the items under "Open".

A rate type is a price list: what an agent pays per seat on each route and pickup zone, per charter
boat, and per add-on. Nothing in this service can price a booking until rate types live here
(`todo/legacy-replacement.md` §6). This note is the design for the first slice, the catalogue
itself. Pricing a booking from it (`POST /v1/quote`) is a later slice; see "Not this slice".

- **Source:** `wt-lk-inbox@658298d` (production, branch `lk-inbox`). Every writer found:
  - `rtSaveDraft` (`allotment_v2/js/08-app.js`): the editor's create and update. New drafts come
    from `rtOpenNew` and `rtClone`; the draft is mutated by `rtDraftSet` (dot paths) and the
    `rt*` handlers around it.
  - `rtDeleteRT`: delete, which also strips `rateTypeId` from every agent bound to it.
  - `_rtRestore`: the load path, which migrates two old shapes (charter `{high, low}`, a
    zone-keyed `privateTransfer`) and fills `active` when undefined.
  - `_rtEnsureStaff`: re-injects the `rt_staff` seed if missing.
  - `rtPersist`: writes `sb_rate_types` **and** `sb_agents_rate_bindings` (with each agent's
    `rateSeasons`) into the blob, which the generic sync sends to `server.js`.
  - `b2c-catalog.js` `normalizePricing` (server side): `POST /api/b2c/routes` writes
    `seatRates[route]` and `routeValidity[route]` straight into the tables, for B2C programmes.
  - Storage: `os-backend/src/mapping/field_mapping.json` + `operation_schemas_model.json`
    (15 `sb_rate_types*` tables). Production runs `DATA_BACKEND=relational`, so those tables are
    the store and **a key with no mapping is dropped on every save** (`server.js` §mapDrift).
- **Spec cross-checked:** `operation_frontend/apps/web/docs/porting/rate-types.md` (2026-10-03).
  Its loss list matches what I found in the production code. Three of its claims are stale; see
  "Corrections".
- **Already here:** nothing priced. `bookings.rate_type_ref` and `agents.rate_type_id` are free
  text with no FK (`017:66`), `sales_people` exists, `routes.pier` and `routes.kind` exist,
  booking trips carry `zone`. The frontend already calls `GET /v1/rate-types` for the agents page
  (`apps/web/src/lib/ob.ts:475`, `ObRateTypeSummary`) and gets 404.

## Corrections to what the notes and spec say

- **Migration 017's warning is still true, and wider than it says.** Data that production's
  editor accepts but legacy's database never stores, so it exists only in the browser of whoever
  typed it:
  - Ranong `RN` zone seat prices: `sb_rate_types__seatrates` has only `pk_*`, `kl_*` and
    `notransfer_*` columns. `b2c-catalog.js` refuses RN for this reason, verified on production
    2026-09-10.
  - charter rows for boat type `longtail` (`RT_BOAT_TYPES` has it; the table has speedboat and
    catamaran only)
  - private-transfer prices on any route except r4, r5, r6, r10, r11 and r12 (one hard-coded
    table per route)
  - the bundle's `applyTo` (it reads back as `seat`)
  - a flat custom add-on's `price` (no column), and the custom add-on catalogue `sb_addon_types`
    (not mapped at all)
  - agents' `rateSeasons`: `sb_agents_rate_bindings` has only `id` and `ratetypeid`, and
    `rateSeasons` appears nowhere in `field_mapping.json`
- **The spec's "next migration: 018" is stale.** 018 to 021 exist, and 019 is on the unmerged
  `feat/bulk-seat-locks` branch. This slice is **022**.
- **The spec's pricing-engine claims 5 and 8 predate production's code.** Production prices
  add-ons from the agent's season rate for the first trip (`bkV2AddOnRT`), not the base rate. An
  edit in "keep" mode holds a trip's sold rate while it stays on the same route and date
  (`bkV2RtKeptFor`, `§rtKeep`), so old bookings do not always re-price. Neither matters for this
  slice; both matter for the quote slice.

## Fields

Legacy shape: `{ id, code, name, note, color, createdDate, owner, validFrom, validTo, active,
nationalityScope, routes[], seatRates{route:{zone:{paxKey:n}}}, priceTiers{route:{zone:{paxKey:
{sell, minSell}}}}, routeValidity{route:{from,to}}, routeBundles{route:{longtail:{mode, adult,
child, applyTo}}}, charterRates{route:{boatType:{starterPrice, starterIncludes, extraPerPax}}},
addOns{longtail:{applies[], byRoute{route:{join:{adult,child}, charter:{price,capacity}}}, [old
flat join/charter or adult/child]}, privateTransfer:{unit, route:{zone:{sedan, van}}}, <custom>:
{applies[], adult, child | price}} }`. Pax keys are `{adult|child|infant}-{thai|fr}`.

| Frontend key | Bucket | Becomes | Note |
|---|---|---|---|
| `id` | Scalar | `rate_types.id` | Legacy ids kept (`rt003`, `rt_staff`), as agents kept theirs. |
| `code` | Scalar | `rate_types.code` | Generated on create, never edited; import matches on it. `UNIQUE` waits for the data check (the spec says duplicates exist). |
| `name`, `note`, `color` | Scalar | columns | `name` is required by the editor. |
| `createdDate` | Scalar | `rate_types.created_on DATE` | Legacy's own date, from `toISOString()` (a day early east of UTC before 07:00). `created_at` is ours. |
| `owner` | Reference | `rate_types.owner_sales_id` | `''` = shared, stored as NULL. FK to `sales_people` waits for the data check. |
| `validFrom`, `validTo` | Scalar | `valid_from`, `valid_to DATE` | Do **not** gate pricing (spec §1, confirmed in `bkV2TripSubtotal`). |
| `active` | Scalar | `active BOOLEAN NOT NULL DEFAULT true` | A lifecycle flag every row starts with; legacy reads undefined as true (`_rtRestore`). Same as `agents.active`. |
| `nationalityScope` | Scalar | `nationality_scope` | `both`/`thai`/`fr` in legacy; API says `foreign` for `fr`, like the pax residency. NULL = never set, read as both. |
| `routes[]` | Repeating group | `rate_type_routes` (`seq` keeps the order) | The routes the rate covers. |
| `routeValidity[route]` | Fixed struct per route | `rate_type_routes.travel_from`, `travel_to` | Feeds agent programme travel dates and contracts, not pricing. |
| `routeBundles[route].longtail` | Fixed struct per route | `rate_type_routes.longtail_bundle` (`free`/`paid`), `longtail_bundle_adult`, `longtail_bundle_child`, `longtail_bundle_applies_to` | `applies_to` is NULL on every imported row (legacy lost it) and read as `seat`. |
| `seatRates[route][zone][paxKey]` | Repeating group | `rate_type_seat_prices` row, `tier = 'net'` | Long format: a zone, a residency or a pax type becomes data, not a column. RN fits. |
| `priceTiers[...][paxKey].{sell,minSell}` | Repeating group | same table, `tier = 'sell' / 'min_sell'` | Only `net` ever bills (`rates.js` comment in the editor: "seatRates is the NET tier"). Legacy keeps tiers as a JSON string; here they are rows. |
| a zone with no prices, or both net adult prices 0 | Derived | not stored | "Not offered" (`bkV2TripSubtotal`). A pure function decides it. |
| `charterRates[route][boatType]` | Repeating group | `rate_type_charter_prices` | `boat_type` lowercase (`speedboat`, `catamaran`, `longtail`), matched against `lower(boats.type)`. |
| `addOns.longtail` (`byRoute`, `applies`, old flat shape) | Repeating group | `rate_type_longtail_prices`, one row per route | `_rtNormalizeLongtail` already resolves every legacy shape to a per-route price; that resolution happens once on the way in. |
| `addOns.privateTransfer[route][zone][vehicle]` | Repeating group | `rate_type_transfer_prices` | `vehicle` is `sedan` or `van` today. |
| `addOns.privateTransfer.unit`, `addOns.longtail.unit` | Unknown | left out | Looks like a constant label (`per trip`); the data check decides. |
| `addOns.<custom key>` | Unknown | left out | Never priced by bookings (`bkV2AddOnInfo` returns 0 for any other type), and the catalogue that defines the keys is not on the server. See Open. |
| `agents[].rateTypeId` | Reference | `agents.rate_type_id` (exists) | Gains its FK once rate types are imported. |
| `agents[].rateSeasons[]` | Repeating group | **not this slice**: `agent_rate_seasons` | Browser-only today. Needed by the quote slice. |

## Schema

```sql
-- 022_rate_types.sql
--
-- Rate types: the price lists agents are sold at. Legacy holds them as one document per rate type
-- (`SB_RATE_TYPES` in allotment_v2) shredded into 15 tables, several of them wide: a column per
-- zone × pax type, a table per route for transfers. Anything outside those columns was dropped
-- on save (RN prices, longtail charters, most transfer prices, the bundle's applyTo). Here a zone,
-- a boat type, a vehicle or a route is a row, so none of them needs a migration to exist.
--
-- See todo/rate-types-model.md. Pricing a booking from these rows is a separate, later slice.

CREATE TABLE rate_types (
  id                TEXT PRIMARY KEY,
  code              TEXT NOT NULL UNIQUE,      -- generated once, never edited; what an import matches on
  name              TEXT NOT NULL,
  note              TEXT,
  color             TEXT,
  owner_sales_id    TEXT REFERENCES sales_people (id),   -- NULL = shared, visible to every salesperson
  valid_from        DATE,
  valid_to          DATE,
  active            BOOLEAN NOT NULL DEFAULT true,
  nationality_scope TEXT CHECK (nationality_scope IN ('both', 'thai', 'foreign')),   -- NULL = never set, read as both
  transfer_unit     TEXT,      -- display label of the private-transfer price ("per trip")
  created_on        DATE,      -- legacy createdDate, as legacy wrote it
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (valid_from <= valid_to)
);

-- The routes a rate covers, in the editor's order, with the per-route travel window and the
-- longtail bundle. Every price below hangs off one of these rows.
CREATE TABLE rate_type_routes (
  rate_type_id  TEXT NOT NULL REFERENCES rate_types (id) ON DELETE CASCADE,
  route_id      TEXT NOT NULL REFERENCES routes (id),
  seq           INTEGER NOT NULL CHECK (seq >= 0),
  travel_from   DATE,
  travel_to     DATE,
  longtail_bundle             TEXT CHECK (longtail_bundle IN ('free', 'paid')),               -- NULL = no bundle
  longtail_bundle_adult       NUMERIC(12,2) CHECK (longtail_bundle_adult >= 0),
  longtail_bundle_child       NUMERIC(12,2) CHECK (longtail_bundle_child >= 0),
  longtail_bundle_applies_to  TEXT CHECK (longtail_bundle_applies_to IN ('seat', 'charter', 'both')),   -- NULL = seat (legacy never stored it)
  PRIMARY KEY (rate_type_id, route_id),
  UNIQUE (rate_type_id, seq),
  CHECK (travel_from <= travel_to)
);

-- One price per cell. category and residency are the booking pax vocabulary (src/domain/pax.ts);
-- only tier 'net' is ever billed, 'sell' and 'min_sell' are printed on contracts.
-- A zone with no rows is not offered on that route.
CREATE TABLE rate_type_seat_prices (
  rate_type_id  TEXT NOT NULL,
  route_id      TEXT NOT NULL,
  zone          TEXT NOT NULL,                  -- PK | KL | NoTransfer | RN | …, checked per route pier by the API
  category      TEXT NOT NULL CHECK (category IN ('ad', 'chd', 'inf')),
  residency     TEXT NOT NULL CHECK (residency IN ('foreign', 'thai')),
  tier          TEXT NOT NULL CHECK (tier IN ('net', 'sell', 'min_sell')),
  price         NUMERIC(12,2) NOT NULL CHECK (price >= 0),
  PRIMARY KEY (rate_type_id, route_id, zone, category, residency, tier),
  FOREIGN KEY (rate_type_id, route_id) REFERENCES rate_type_routes ON DELETE CASCADE
);

-- A whole-boat price: starter_price covers starter_includes passengers, each one more costs
-- extra_per_pax. Chosen by the chartered boat's type.
CREATE TABLE rate_type_charter_prices (
  rate_type_id      TEXT NOT NULL,
  route_id          TEXT NOT NULL,
  boat_type         TEXT NOT NULL,              -- speedboat | catamaran | longtail | …, lowercase
  starter_price     NUMERIC(12,2) CHECK (starter_price >= 0),
  starter_includes  INTEGER CHECK (starter_includes >= 1),
  extra_per_pax     NUMERIC(12,2) CHECK (extra_per_pax >= 0),
  PRIMARY KEY (rate_type_id, route_id, boat_type),
  FOREIGN KEY (rate_type_id, route_id) REFERENCES rate_type_routes ON DELETE CASCADE
);

-- The longtail add-on on one route: joining a shared longtail per person, or chartering one.
CREATE TABLE rate_type_longtail_prices (
  rate_type_id      TEXT NOT NULL,
  route_id          TEXT NOT NULL,
  join_adult        NUMERIC(12,2) CHECK (join_adult >= 0),
  join_child        NUMERIC(12,2) CHECK (join_child >= 0),
  charter_price     NUMERIC(12,2) CHECK (charter_price >= 0),
  charter_capacity  INTEGER CHECK (charter_capacity >= 0),
  PRIMARY KEY (rate_type_id, route_id),
  FOREIGN KEY (rate_type_id, route_id) REFERENCES rate_type_routes ON DELETE CASCADE
);

-- A private transfer to one route from one pickup zone, per vehicle.
CREATE TABLE rate_type_transfer_prices (
  rate_type_id  TEXT NOT NULL,
  route_id      TEXT NOT NULL,
  zone          TEXT NOT NULL,
  vehicle       TEXT NOT NULL,                  -- sedan | van today
  price         NUMERIC(12,2) NOT NULL CHECK (price >= 0),
  PRIMARY KEY (rate_type_id, route_id, zone, vehicle),
  FOREIGN KEY (rate_type_id, route_id) REFERENCES rate_type_routes ON DELETE CASCADE
);
```

Every constraint above was checked against production legacy data on 2026-10-07 (see "Data check")
and holds once the import maps legacy values the way this note says. One waits for the import itself,
because `agents` already holds 523 rate type ids and `rate_types` starts empty:

```sql
-- a later migration, after the first import:
ALTER TABLE agents ADD CONSTRAINT agents_rate_type_fk FOREIGN KEY (rate_type_id) REFERENCES rate_types (id);
```

The API enforces every rule on what it is sent from day one.

## Contract

Under the current preHandler these paths need `booking:read` / `booking:write`, like agents.

### `GET /v1/rate-types?active=true|false|all&q=`

Active rate types by default. `q` matches `code` or `name`, case-insensitive. The shape is the
frontend's existing `ObRateTypeSummary`, so the agents page works unchanged.

```json
{ "rate_types": [
  { "id": "rt003", "code": "NOK-STD", "name": "Standard 2026", "color": "#1683C7", "active": true,
    "owner": "s1", "valid_from": "2026-01-01", "valid_to": "2026-10-31", "nationality_scope": "both",
    "priced_routes": ["r5", "r6"],
    "route_validity": { "r5": { "from": "2025-11-01", "to": "2026-04-30" } } } ] }
```

`priced_routes` is derived: covered routes with at least one offered zone (a net adult price
above 0), legacy's `agRtRoutes` plus the no-rate rule.

### `GET /v1/rate-types/{id}`

The summary plus every price. Seat prices use the booking pax-grid keys (`ad_fr`, `chd_th`, …),
so a quote is price × pax key by key.

```json
{ "id": "rt003", "code": "NOK-STD", "name": "Standard 2026", "active": true, "owner": "s1",
  "nationality_scope": "both", "valid_from": "2026-01-01", "valid_to": "2026-10-31",
  "routes": [
    { "route_id": "r5", "travel_from": "2025-11-01", "travel_to": "2026-04-30",
      "longtail_bundle": { "mode": "paid", "adult": 300, "child": 200, "applies_to": "seat" },
      "zones": {
        "PK": { "net": { "ad_fr": 2900, "chd_fr": 1900, "ad_th": 1900, "chd_th": 1200 },
                "sell": { "ad_fr": 3400 }, "min_sell": {} },
        "KL": { "net": { "ad_fr": 3100, "chd_fr": 2100 } } },
      "charter": { "speedboat": { "starter_price": 45000, "starter_includes": 20, "extra_per_pax": 1500 } },
      "longtail": { "join_adult": 400, "join_child": 300, "charter_price": 3500, "charter_capacity": 8 },
      "transfer": { "PK": { "sedan": 1200, "van": 1800 } } } ] }
```

404 `Rate type not found`. An absent key means "never given", as on bookings.

### Writes

- **`POST /v1/rate-types`**: header fields plus optional `routes` (the same shape as GET).
  `name` required. `id` and `code` generated when absent (code: a slug of the name, `-2`… on
  collision). 201 with the detail.
- **`PATCH /v1/rate-types/{id}`**: header fields only, merge semantics (absent = unchanged,
  `null` = clear). `code` cannot change (400).
- **`PUT /v1/rate-types/{id}/routes/{route_id}`**: one route's whole block, replacing that
  route's rows. **`DELETE …/routes/{route_id}`** removes it.
- **`DELETE /v1/rate-types/{id}`**: 409 `in_use` with counts when an agent or a booking names it;
  the caller deactivates instead. This replaces legacy's unbind-and-delete.

### Validation (400, naming the path)

- `routes[1].route_id r99 is not a route`
- `routes[0].zones.RN does not apply to route r5 (pier panwa): use PK, KL or NoTransfer`. The
  allowed set is legacy's `rtZonesForRoute`: Ranong piers take `RN`, `NoTransfer`; every other
  route, land routes included, takes `PK`, `KL`, `NoTransfer`.
- `routes[0].zones.PK.net.ad_xx is not a pax key: use ad_fr, chd_fr, inf_fr, ad_th, chd_th, inf_th`
- `routes[0].zones.PK.net.ad_fr must be a number ≥ 0`, the same for every price
- `routes[0].charter.yacht is not a boat type: use speedboat, catamaran or longtail`
- `routes[0].longtail_bundle.mode must be free or paid`; `applies_to must be seat, charter or both`
- `valid_from must not be after valid_to`, `travel_from must not be after travel_to`
- `nationality_scope must be both, thai or foreign`; `owner` must be a salesperson

## Data check — 2026-10-07

Read-only session (`default_transaction_read_only=on`) against production legacy
(`ORIGINAL_DATABASE_URL`, schema `operation_schemas`). Queries: `todo/rate-types-data-check.sql`.

| Claim | Count | Consequence |
|---|---|---|
| rate types | **84** (5 inactive, 1 with `active` NULL) | NULL is read as active, as `_rtRestore` does |
| duplicate `code` / empty `code` / empty `name` | **0 / 0 / 0** | `code NOT NULL UNIQUE`, `name NOT NULL` ship |
| `owner` not a salesperson | **0** (74 owned by 6 salespeople, 10 shared as `''` or NULL) | FK ships; `''` → NULL |
| `nationalityscope` | NULL 40, `fr` 25, `both` 18, `thai` 1 | CHECK ships; `fr` → `foreign` |
| malformed or reversed `validFrom`/`validTo` | **0** | DATE + order CHECK ship |
| covered routes | **519** rows, 1–9 per rate type, **0** not in `routes`, 0 duplicates | route FK ships |
| covered route piers | tublamu 236, panwa 279, ranong 4 | Ranong is priced only under NoTransfer (RN was never storable) |
| validity / bundle rows for a route outside `routes[]` | **8 / 3** (seat and charter rows: 0) | unreachable by pricing (no seat or charter price there); not imported, listed |
| malformed route validity | **1**: `rtmuticommw2ho7` r11 `to = '20207-05-15'` | imported as NULL and listed, never guessed |
| seat-rate rows | **519**, 0 negative, 0 infant priced above 0 | price ≥ 0 ships |
| empty zones | PK 4, KL 172, NoTransfer 1 | no rows = not offered |
| stray `kl` JSON text column | set on **347** rows, **0** disagree with `kl_*`, 0 set without them | ignored by the import |
| price tiers (`pricetiers` JSON) | **26** rate types; PK/KL/NoTransfer; `sell` and `minSell` only; 0 decimals | → tier rows |
| charter rows | **250** (speedboat 197, catamaran 54), 0 negative, 0 `starterIncludes` < 1 | CHECKs ship |
| bundles | `free` 66, `paid` 2, **0** with a price above 0 | CHECK ships; `applies_to` NULL everywhere |
| longtail add-on | 66 rate types; 156 `byRoute` rows, 155 `applies`; **0** with neither; 0 outside `routes[]`; 22 still carry the old flat `adult`/`child` shape; 0 negative | one row per route via `_rtNormalizeLongtail` |
| private transfer | 74 rate types, ~783 rows over r4/r5/r6/r10/r11/r12, zones PK and KL only, 0 negative; unit `per trip` ×73, `per trip · premium` ×1 (`rt004`) | `transfer_unit` kept as a label |
| agents bound to a missing rate type | **0** of 523 (`sb_agents_rate_bindings`: 828 rows, 0 dangling) | the agents FK will hold after import |
| bookings whose `ratetyperef` is not a rate type | **1** of 4,674 (`rtmu12ml66cx6cy`, deleted) | confirms `bookings.rate_type_ref` stays free text |

What cannot be counted, because legacy never stored it: RN prices, longtail charter rows, transfer
prices on other routes, `applies_to`, flat custom add-on prices, agents' `rateSeasons`.

## Expand / contract

Purely additive: six new tables, no change to an existing column, no backfill. Nothing reads the
blob. `bookings.rate_type_ref` stays free text for good: it is a historical snapshot, and a
deleted rate must not break old bookings.

## Open

1. **Lost prices are re-entered by hand** (agreed 2026-10-07): RN prices, longtail charter rows,
   transfer prices outside r4/5/6/10/11/12, every bundle's `applies_to`. The data that does exist
   shows where to look: the 4 Ranong route rows, the 2 `paid` bundles.
2. **Agent rate seasons live only in browsers.** The quote slice needs them. Export
   `localStorage['loveandaman_v2'].sb_agents_rate_bindings` from the machine that set them up,
   or re-enter them.
3. **Custom add-ons:** keep (priced once a quote exists) or drop? Left out until decided.
4. **Permissions:** legacy edits rates under its `sales` area. The proposal keeps `booking:*`
   for now; a `sales:*` scope is the agents spec's decision too.
5. **`nationality_scope` does not restrict pricing in legacy** (spec Q2). Decided in the quote slice.

(Resolved by the data check: longtail with empty `applies` does not occur.)

## Where the data comes from — decided: the importer

Extend `src/tools/import-legacy.ts`, as a separate change right after this slice. Why:

- **Volume.** 84 rate types, 519 route blocks, several thousand price cells. Typing them in is
  not realistic, and every typo is a wrong price.
- **Legacy stays master until cutover.** Sales still edit rates in legacy. The importer is
  re-runnable and dry-run by default, and already mirrors agents, bookings and deployments the
  same way. A seed migration would go stale the first time a rate changes, as 006 did for routes.
- **The data is clean.** Every constraint above holds on today's rows, so the import can bring
  them across without dropping any, apart from the 11 listed orphans and one typo'd date.
- **It is needed anyway.** Bookings and agents reference rate type ids, so cutover needs every
  legacy rate type here regardless.
- **The one catch:** the hand-entered lost prices must survive later import runs. The importer
  will replace only what legacy can hold (zones PK/KL/NoTransfer, speedboat/catamaran charters,
  transfers on the six routes, tiers, header fields). It leaves RN rows, `longtail` charter rows,
  other routes' transfers and `applies_to` untouched. Re-entering them here therefore works now,
  not only after cutover.

## Not this slice

In order, what pricing a booking still needs after this:

1. `agent_rate_seasons` and `PUT /v1/agents/{id}/rate-seasons`.
2. Promo contracts (`sb_contracts` with `pricemode`, `rates`, `discount`, `bookwin`, and
   `__programperiods`).
3. `POST /v1/quote`: a pure `src/domain/pricing.ts` called by both stores, then used by
   `POST /v1/bookings` and the pricing-relevant `PATCH`es, storing per-trip `subtotal`,
   `rate_type_id` and `promo_id` (columns that do not exist yet).
4. `POST /v1/rate-types/{id}/clone`, agent binding (`POST /v1/rate-types/{id}/agents`), the add-on
   type catalogue, the B2C rate endpoints (`/api/b2c/rate-types`, `/routes`, `/availability`).

## Follow-ups

- ~~Extend `src/tools/import-legacy.ts`~~: shipped, see "The importer" at the top.
- **Run it in production**, then the `agents.rate_type_id` FK migration.
