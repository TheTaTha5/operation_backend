# Catalogue editing: what is still open

Built 2026-10-09 (`feat/catalogue-editing`, migration 070; README "Editing routes", "Editing boats",
"A boat's seats for one day"): routes and families, the whole boat form with documents, status log
and retire/restore, a boat's seats for one day, Love Kingdom's `POST /v1/routes`, and
`seed:routes`/`seed:boats` in place of the syncs. Legacy read: wt-lk-inbox@658298d.

## Open

1. **The stand-in boat** ("Boat for Allotment Set", `b1787213821911`): ops use it to give the Nyaung
   Oo Phee route seats before a real boat is known (166 days deployed, no bookings). Waiting on ops:
   what limit do they want on a marine day with no boat? (checklist "Ask ops"). `seed:boats` copies
   it as legacy has it, as `sync:boats` did; nothing else is built for it.
2. **`meal_venue_id` and the venues list** move with costing (Money reports, decision 7).
3. **`daily_cap`** when someone wants a limit on a land route (decision 7). Today a value is `400`.
4. **Fleet rules on the boat** (`fleet-maintenance-model.md` slices 1–2): the effective status
   (status log plus open work), refusing or warning when a fixing/unavailable boat is deployed, the
   timeline's "planned ahead" confirm (`ovrJobs`), certificate expiry status and renewal. The data is
   stored now; the rules are fleet's.
5. **Clients:** the legacy integration client (handoff §3.14) and Love Kingdom (§3b) must switch;
   see `developer-checklist.md`.

## Flagged

Decisions made while building, side effects, and where this differs from legacy. Default was legacy.

**Schema and data**
- Migration 070 **drops `boats_check` (`capacity <= license_pax`)**, as decided: sales stay capped at
  the licence by `deploymentSeats`. `test/boats.test.ts` lost its "may not sell more seats than it may
  carry" invariant on purpose; `test/legacy-boats.test.ts` changed on purpose (a boat over its
  licence is no longer skipped; `totalcap` is now read, into `registered_persons`).
- `routes.family_id` gets a foreign key to the new `route_families`; `routes.ext_id` a unique index.
  The migration seeds legacy's ten families and adds any other id a route already names.
- `brand` and `model` are kept here (legacy had no column and lost them).
- The change feed gets a new kind, `boat`: 070 rewrites `changes_kind_check`. **Merge risk:** another
  branch that also rewrites that CHECK must end with the union of both lists.

**Import and seeds**
- `sync:routes`/`sync:boats` are replaced by `seed:routes`/`seed:boats`: they add what is missing,
  refresh a row never edited here (`updated_at` null), and never touch one edited here. The first
  run on a database synced before fills the boats' form fields, documents and status log, and sets
  the 7 charter boats' `ownership` (rehearsal: 22 boats, 76 documents, 174 entries; 58 routes).
- Legacy's status log repeats entries (b2's MJ-023 pair ×8, b7's MJ-022 ×7, same ids): kept as they
  are, ids suffixed `-2`, `-3`… so each is addressable.
- `import-legacy.ts` no longer overwrites a boat's day seats set here (`set_at`), matching its mirror
  delete, which already kept them.

**Routes**
- Delete is refused while anything refers to the route (decided); legacy checked nothing.
- Land routes can be reordered (`pier: null`); legacy's drag found none (bug 7). A group is the
  routes with that pier, as legacy groups them, so a land route with a pier sorts with that pier.
- `daily_cap`, `code`, `meal_venue_id`: an empty value is ignored, a real one is `400` (legacy and
  b2c stored them).
- No name length limit (b2c had 120). An explicit `times: []` is kept (b2c turned it into 08:00; 36
  legacy routes have none).
- Love Kingdom's create: `pricing` is not supported (prices are rate types'); a second call with the
  same `ext_id` answers the route unchanged even if the body differs, as legacy. Only the `a_b2c`
  login gets this exception (`LOVE_KINGDOM_AGENT` in `src/domain/users.ts`).
- Family changes are not in the change feed.

**Boats**
- **A capacity, licence or persons change rewrites every deployment of the boat from today (Thai
  time) on**, including one whose capacity was set differently through `POST /operations/deployments`.
  Past deployments keep their numbers.
- The `seats_sold` question weighs, per day that loses seats, the passengers **placed on the boat**
  (as the deployment guards do), not the route-day's unplaced bookings; a chartered day is weighed
  against the licence. A day already over that loses no seats is not asked about.
- Areas: boat edits and the status timeline `config` (legacy's `save('config')`), retire/restore
  `fleet` (legacy's `flSave`). A fleet-only login's boat edit is now `403` instead of silently lost
  (legacy bug 1).
- **New refusal:** a retired boat can't be deployed (`409 boat_retired`); legacy only hid it.
- Create: a blank capacity is 40 (legacy), but `0` is `400` (legacy made it 40). `pier` is required,
  `type` must be one of the form's four. `registered_persons` is computed on create only when not
  sent; a `PATCH` never recomputes it (the form does, in the browser).
- A capacity above the licence saves with a `capacity_above_licence` warning (legacy said nothing).
- The form's status pick closes overlaps as legacy's `autoClosePrevLog` does: an entry starting today
  or later is **removed** (e.g. a "planned ahead" entry). Copied as is.
- The status timeline requires `province` and `loc_type`, as legacy's dialog does; an imported entry
  without them must be given them when edited.
- Catalogue writes carry no `version`/`If-Match` (as rate types).

**A boat's seats for one day**
- Normal is the day's **deployment** capacity, else the boat's (legacy reads only the boat's, which
  deployments here copy).
- Over the licence is `400` (legacy clamped silently). `0` seats is allowed (legacy allowed it).
- **No past day for anyone, admins included** (decided "no past days"; deployments let an admin fix
  the past). `DELETE` on a past day is refused too.
- `set_by` is the login's username, as the trip-ops raise records it.

**Both stores**
- The in-process store now lists routes by `sort` (unsorted last, in insertion order) and deployments
  by date, as PostgreSQL does, and starts with legacy's ten families.
- `GET /v1/boats` answers every field (`null` for unset ones, so `crew` is `null` rather than absent).
