# Sales editing: what is still open

**Built** on `feat/sales-editing` (decided 2026-10-09; legacy read wt-lk-inbox@658298d): agent
create, edit, programmes, rate type, renewal, deactivate/activate and delete; sales scoping; contract
templates and issued documents; salespeople and markets; the add-on catalogue; nationalities;
passengers' insurance age and review; the import's cutover. Migrations 090–093; README "Agents" to
"Nationalities" and "Insurance"; `src/routes/sales-editing.ts` and the `src/domain/` modules it names.

## Open

1. **Staff and welfare quotas** (decision 13): later, with the staff-welfare pricing. Legacy keeps a
   quota for 2026 only (`sb_staff.quota_2026`, bug 14); keep one per year when it comes. 24 staff.
2. **Sales targets and follow-up marks** (Sales Board, `sbEditTarget`, `salesSetTarget`): stored on
   the salesperson in legacy (`sb_sales.targets`, `followup`), not modelled here and not decided.
   Legacy keeps them until the Sales Board moves.
3. **Promo contracts** (add, edit, void): with the quote (`contracts-model.md`).
4. **Merge the custom nationalities** (decision 11): 66 in legacy today (four Nigerias, ISO-3 copies
   of built-ins, lower-case junk); merging rewrites the bookings that use them.
5. **The add-on catalogue's contents** come from sales (checklist). Not modelled: per-agent add-on
   prices (`a.addonServices`) and custom add-on kinds (`SB_ADDON_TYPES`); legacy never saved either.
6. **Agent codes:** add the unique constraint once sales renames the 21 shared ones (`agents.md`).
7. **`import:contracts`** still mirrors legacy's contracts and would overwrite a main contract's
   `rate_type_id` and `doc_id`, now set here: make it seed-only like the agents import.
8. **Scoping beyond agents** was not decided: a sales-bound login still lists and books for any
   agent through `/v1/bookings`, and sees every rate type (legacy hid other salespeople's rate types
   too, `_rtInScope`).

## Design — extras (feat/sales-extras, 2026-10-10)

The developer said build, copying legacy (wt-lk-inbox@658298d). Promo contracts are designed in
`contracts-model.md` ("Design — promo writes"). This covers open items 1, 2 and 7. Item 6 waits.

### Sales targets and follow-up marks (open item 2)

Legacy (`04-data-core.js` `salesSetTarget`, `salesToggleFollow`, `salesPaxAgg`, `salesStreak`;
`08-app.js` `sbEditTarget`, `renderSalesBoard`): a target is pax per salesperson per month, kept on
the salesperson (`sb_sales.targets = {"2026-07": 120}`; 0 deletes it). A follow-up mark is a tick per
salesperson, month and agent, two kinds (followed; FOC feedback collected), kept as
`sb_sales.followup = {"2026-07::a56": true, "foc:2026-07::a56": true}`. Persist guards `sales`; the
target's edit shows only to a login not bound to a salesperson; a bound login sees only its own
board. Legacy data: 0 targets, 1 follow-up mark.

The Sales Board counts **pax by trip month** (a trip counts in its own month, every passenger
including infants and FOC), cancelled/rejected/weather-cancelled bookings out, by the agent's
*current* salesperson. Trend per agent against last month: no pax last month → `new`; none this
month → `gone`; last month < 5 → `flat` with the difference; else +25 % or more `up`, −20 % or less
`down`, between `flat`. Streak: months in a row, back from this one (24 at most), with a target met.

| Field | Authority |
|---|---|
| target `pax` | client fact (whole number ≥ 0; 0 clears) |
| follow-up mark | client fact (set or cleared) |
| `set_at`/`set_by`, `marked_at`/`marked_by` | computed (the write's time and login) |
| board: pax, FOC, bookings, `target_pct`, `reached`, `streak`, `rank`, `previous_rank`, agent `trend` | computed |

```sql
-- 201_sales_targets.sql
CREATE TABLE sales_targets (
  sales_id TEXT NOT NULL REFERENCES sales_people (id) ON DELETE CASCADE,
  month    TEXT NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  pax      INTEGER NOT NULL CHECK (pax > 0),
  set_at   TIMESTAMPTZ NOT NULL,
  set_by   TEXT,
  PRIMARY KEY (sales_id, month)
);
CREATE TABLE sales_followups (
  sales_id  TEXT NOT NULL REFERENCES sales_people (id) ON DELETE CASCADE,
  month     TEXT NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  agent_id  TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  kind      TEXT NOT NULL CHECK (kind IN ('agent', 'foc')),
  marked_at TIMESTAMPTZ NOT NULL,
  marked_by TEXT,
  PRIMARY KEY (sales_id, month, agent_id, kind)
);
```

Contract (area `sales`; a sales-bound login: no target writes, follow-ups on its own board only):

- `PUT /v1/sales/{id}/targets/{month}` `{ "pax": 120 }` → `{ "sales_id": "s01", "month": "2026-10", "pax": 120 }`.
  `0` or `null` clears (`pax: 0` answered). `400` for a month not `YYYY-MM` or pax not a whole number
  ≥ 0; `403` for a sales-bound login; `404` unknown salesperson.
- `PUT /v1/sales/{id}/followups` `{ "month": "2026-10", "agent_id": "a56", "kind": "agent" | "foc", "marked": true }`
  → `{ …, "marked": true }`. Legacy toggles; here the mark is set or cleared as sent, so a retry
  cannot undo it. `400` for an agent that is not this salesperson's; `403` for another
  salesperson's board.
- `GET /v1/sales-board?month=YYYY-MM` (default this month, Thailand), any login:

```jsonc
{ "month": "2026-10", "previous_month": "2026-09", "total_pax": 1234,
  "sales": [ { "sales_id": "s01", "name": "IRIS", "code": "IR", "color": "#0F6E56", "pax": 412, "foc": 6,
               "target": 400, "target_pct": 103, "reached": true, "streak": 2, "rank": 1, "previous_rank": 2,
               "bookings": 97, "agents": 140, "agents_with_sales": 38 } ],
  "agents": [ { "agent_id": "a56", "name": "…", "sales_id": "s01", "pax": 40, "previous_pax": 25, "foc": 2,
                "trend": { "category": "up", "pct": 60, "change": 15 }, "followed": true, "feedback_collected": false } ] }
```

`sales` is every active salesperson, most pax first (ties in id order, legacy's load order); a
sales-bound login sees the whole leaderboard (legacy did) but only its own `agents`.

### Staff and welfare quotas (open item 1): built

It can be built without designing staff pricing anew: the price is already the server's
(`enforcedPriceMode` — welfare at the staff rate, inspection free; FOC seats are free in
`priceBooking`). What was missing is the registry, the quota and the booking-form guard.

Legacy (`08-app.js` `SB_STAFF`, `staffAdd`, `staffSetField`, `staffSetQuota`, `staffDelete`,
`staffWelfareUsed`, `staffTripsFor`, the guard in `bkV2Save`): staff `{id st01…, code EMP-001…, name,
dept, active, quota: {"2026": 3}}`; persist guards `sales`. Used = FOC passengers (`foc`, `foc_fr`,
`foc_th`) on trips in that year, of the staff member's bookings that are not cancelled/rejected/
weather-cancelled and not an inspection. Remaining = quota − used. Saving a staff booking needs a
staff member; a welfare one whose FOC seats exceed what is left asks "Free welfare seats exceed the
quota … Save anyway?". Legacy data: 24 staff (3 code clashes: EMP-010, EMP-020, EMP-021), quotas for
2026 only, 41 bookings naming one, none unknown.

| Field | Authority |
|---|---|
| `code`, `name`, `dept`, `active` | client fact |
| a year's `free_seats` | client fact (whole number ≥ 0) |
| `id` | computed (`st` + next number, legacy) |
| `used`, `remaining` | computed |
| booking `staff_id` | validated: required on a staff booking, must be a staff member when set |
| booking FOC over the quota | validated: `409 over_quota` until `quota_anyway: true` |

```sql
-- 202_staff.sql
CREATE TABLE staff (
  id         TEXT PRIMARY KEY,
  code       TEXT,                         -- not unique: legacy's own 24 have 3 clashes
  name       TEXT NOT NULL DEFAULT '',     -- legacy adds a blank row and names it in place
  dept       TEXT,
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE staff_quotas (
  staff_id   TEXT NOT NULL REFERENCES staff (id) ON DELETE CASCADE,
  year       INTEGER NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  free_seats INTEGER NOT NULL CHECK (free_seats >= 0),
  PRIMARY KEY (staff_id, year)
);
```

`bookings.staff_id` gets no foreign key: the import mirrors legacy's bookings, and legacy deletes
staff freely. The write path checks it instead.

Contract (writes area `sales`, reads any login):

- `GET /v1/staff?year=2026` (default this year) → `{ "year": 2026, "staff": [{ id, code, name, dept,
  active, quotas: {"2026": 3}, quota, used, remaining }], "totals": { active, all, quota, used } }` in
  id order.
- `GET /v1/staff/trips?year=2026` → `{ "trips": [{ booking_id, staff_id, service_date, route_id,
  purpose: "welfare" | "inspection", foc, head, paid }] }` by date (legacy's "trips" tab).
- `POST /v1/staff` → `201`: `name`, `code`, `dept`, `active` optional; defaults legacy's `staffAdd`:
  id `st<n+1>`, code `EMP-<n+1>`, name `""`, a quota of 3 for this year.
- `PATCH /v1/staff/{id}`: `name`, `code`, `dept`, `active`. Unknown fields `400`.
- `PUT /v1/staff/{id}/quotas/{year}` `{ "free_seats": 3 }` → the staff row.
- `DELETE /v1/staff/{id}` → `204`; `409 in_use` while a booking names them (make them inactive).
- Bookings (`POST /v1/bookings`, `PATCH /v1/bookings/{id}` when trips, pax, `staff_id` or
  `staff_purpose` change): on the staff agent (`a_staff`/`STAFF`) `staff_id` is required (`400`);
  any `staff_id` sent must be a staff member (`400`); a welfare booking whose FOC seats in a year
  exceed that year's remaining (this booking excluded) is `409 over_quota` until `"quota_anyway": true`:

```json
{ "statusCode": 409, "code": "over_quota", "error": "Conflict",
  "message": "Free welfare seats exceed the quota: 2026: 1 free seat left, 3 requested, over by 2. The over-quota people should be Adult (charged at the staff rate), not FOC. Send quota_anyway: true to save anyway." }
```

### `import:contracts` seed-only (open item 7)

`npm run import:contracts` writes nothing without `--seed` (it says so); `--seed` upserts legacy's
contracts as today (legacy wins for each id it has; one only here is left). Run it once, to seed.

### Import (`import-legacy.ts --sales`)

Seeds staff (`sb_staff`, `quota_2026` → year 2026), targets (`sb_sales.targets`, months that are not
`YYYY-MM` or pax ≤ 0 listed and skipped) and follow-up marks (`sb_sales.followup`; a key that does
not parse, or an agent not here, listed and skipped). Upsert by key; without `--sales` none of them.

## Flagged

Behaviour changes against legacy, and decisions made while building (each defaults to legacy where
legacy had a rule):

- **A new agent's contract** runs from today to a year less a day, version `v<year>-1`. Legacy
  hard-codes 2025-10-01..2026-09-30 and `v2025-1` (bug 15), so a new agent was expired on arrival.
- **Confirms became flags:** a near-identical name is `409 possible_duplicate` until `create_anyway:
  true` (`agFindDup`); a rate that leaves programmes unpriced is `409 unpriced_programs` until
  `drop_unpriced` is sent (`agProgSyncOnRate`). A client that sends only `rate_type_id` meets the
  second whenever routes would be left unpriced.
- **Codes:** a sent code, new or changed, must be unique ignoring case (`409 code_taken`); a
  generated one that clashes is numbered (`PHUKETMA2`). Legacy never checked.
- **A rate type owned by another salesperson** is refused on create, rate change and renewal
  (`400`). Legacy only filtered the picker (`rtForSales`).
- **Scoping, beyond the decision:** it covers the agent's activity, seasons, rate type, documents
  and contracts too; a sales-bound login cannot hand its agent to another salesperson (`403`).
- **`PATCH` is strict:** unknown fields are `400`; `name`, `company.legal_name`, `market_id`,
  `pay_type` and `code` cannot be cleared; server-owned fields may be echoed but not changed.
  Legacy's company modal required name and legal name on every company save; here a legal name is
  required on create and cannot be removed, so the one legacy agent without one can still be edited.
  An address is required on create only (88 legacy agents have none).
- **Activity:** lines are written only when something changed (legacy wrote `Company info updated`
  and `Programs / periods updated` on every save), and new lines exist where legacy wrote none:
  code, contact fields, renewal, (de)activate, template delete, salesperson delete, document removed.
- **Signatory default:** with no contact the name is empty, not legacy's `—` printed on contracts.
- **Renewal** saves at once (legacy waited for another agent save, bug 4) and archives into a new
  table, `agent_contract_history`. Legacy's storage dropped the archived rate type, so the 77
  imported archives have none. A new rate at renewal syncs the main contracts, not the programmes,
  as legacy.
- **Issued documents:** all are kept; legacy capped them at 20 per agent (a browser-storage limit).
  Removing one (legacy's "Remove from history") clears the contract's `doc_id`.
- **Templates:** a generated code is the next free `CT-NN` (legacy counted, which is how two share
  `CT-06`); a bad `accent_hex` is refused (legacy blanked it); the first template becomes the
  default; the "Edit" lock stays the screen's.
- **Deleting a salesperson** is refused while a login or a rate type names them (legacy left those
  pointing at nobody); their agents are unassigned, each with an activity line.
- **Deleting an agent** also counts seat locks, invoices and logins, beyond the decided bookings and
  contracts.
- **A sub-market typed on an agent** joins its market's list under the `sales` area (legacy failed
  silently for a `sales`-only login, bug 5).
- **Insurance:** ages 0–999 (legacy had no rule; its one `134` is kept); reviewing a reviewed row
  keeps the first stamp; name and nationality overrides are gone (none was used); the command is a
  booking write, so it needs `If-Match`, writes a history line, and is refused on a cancelled or
  rejected booking (`409 booking_closed`). A `PATCH` replacing passengers keeps a passenger's age only
  when the same name is at the same position.
- **Nationalities** need the `operations` area to add (legacy had no guard).
- **The add-on catalogue's shape** is mine: `type` is legacy's icon (boat, van, guide, other) and
  each variant has a selling and a net price. It starts empty.
- **New response fields:** `has_signature` on `GET /v1/sales`; `contract_history` and
  `contract_template_effective_id` on the agent detail (`test/agents.test.ts` changed for them).
- **Routes** live in `src/routes/sales-editing.ts`, registered from `operations.ts`; the agent,
  contract, salesperson and market reads moved there too.

Import (`import-legacy.ts`):

- **Without `--sales`** it no longer writes agents, programmes, activity, markets, sub-markets,
  salespeople, templates, issued documents or renewal archives. Invoices name an agent only if it is
  here; a rate type's owner must be a salesperson here.
- **`--sales`** seeds them all (upsert by legacy id; legacy's default template takes over; a
  document already here is kept). It now imports salespeople's `active` (2 inactive) and signatures
  (5), which it forced to active and dropped before. `a_company` is a house account.
- **Every run** still mirrors legacy's custom nationalities (upsert by code; a built-in's code is
  skipped) and its insurance ages and ticks onto the imported bookings (legacy index → seq, since a
  nameless passenger is dropped).
- **Side effect:** an agent created in legacy after the seed never arrives here; legacy's agent
  screens must stop saving when this deploys (checklist 1b3). `verify:import` will report agents,
  markets and salespeople that differ once they are edited here.
- **Rehearsed** on a throwaway copy (2026-10-09): `--rate-types --sales` wrote 832 agents, 2,284
  programmes, 1,088 activity lines, 12 markets, 9 salespeople, 9 templates, 16 documents, 77 archives,
  66 custom nationalities and 5,135 insurance rows (2,711 leads, 2,424 passengers, 5,133 reviewed);
  a rerun without `--sales` kept an agent, a template and an activity line edited here.
