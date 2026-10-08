---
name: blob-to-relational
description: >-
  Convert a piece of the legacy blob/flat data model into proper relational tables in this backend — a field inside the booking document (`booking_data`: addOns, adjustments, approval, focApproval, altPickups, allergyList, trip.ops, docCheck…) or a whole-state legacy resource (sb_rate_types, sb_extras, sb_weather, invoices, any `sb_*` table or `/api/v1/:resource` key). Designs from the frontend's save code, checks against legacy data, writes a todo/<name>-model.md, stops for approval, then builds migration + both stores + endpoint + tests + README. Use whenever the user wants to model, normalize, de-blob, "give a home to", or stop losing a legacy field or resource, asks to add tables for something the frontend saves, or asks why a field disappears on save — even if they never say "relational" or "blob".
---

# Blob to relational

The legacy system stores its data as one big document: the frontend builds a JSON object, the
legacy server shreds it into wide `sb_*` tables or keeps it as a blob. This backend is replacing
that with real tables. This skill converts one piece at a time — one booking field, or one legacy
resource — into a schema that can be constrained, joined and migrated.

The rules here are not invented for the skill; they are the decisions recorded in `CLAUDE.md` and
`todo/booking-model.md` ("The rule", and why the blob is being deleted). Read those before starting
if you have not this session; `git log` holds the production incidents behind them.

Take the notes' *rules* as decided, but their *facts about the frontend* as claims to re-check.
The notes were written from older reads of the code, and some were wrong: an earlier
`booking-model.md` called `docCheck` an unknown shape (it confused the view's `_docCheck` with the
saved `bk.docCheck`) and sketched a `trip.addOns` that no writer produces. A design built on a stale
claim inherits its mistake, so wherever a note says what the frontend sends, confirm it in the
code — and where it is wrong, say so first in your summary and record the correction in the note.

The work has two phases with a hard stop between them, because a schema is the expensive thing to
get wrong: a migration ships on deploy, unwatched (`railway.json` `preDeployCommand`).

## Phase 1 — design (writes only the todo note)

### 1. Find the writer: what the frontend actually saves

The source of truth for the *shape* is the code that **builds** the document on save, not the
legacy database. The legacy tables only contain the combinations that have happened so far (legacy
has no `pax_chd` column simply because nobody needed one yet), and copying them copies their gaps.

- The production frontend is the `lk-inbox` worktree: `D:\projects\wt-lk-inbox` (repo
  `LOVE_Andaman_Workspace`). Code lives in `allotment_v2/js/*.js`; the booking save object is
  `const newBk = {` in `08-app.js`.
- **Find things by searching for the code, never by line number.** The file is ~70k lines and
  changes weekly; old notes citing `allotment_v2.html:<line>` predate the split into `js/` and are
  stale.
- **Ignore `allotment_v2/BACKUP/`** — dated copies that will match every search.
- A field is often written in more than one place (there are two `const newBk = {` sites, plus
  edit and import paths). Find every writer and compare them. Where they disagree, that
  disagreement is a finding for the note, not something to resolve silently.
- For a whole-state resource, also read how legacy stores it:
  `os-backend/src/mapping/os_repo.js` and `field_mapping.json` in the same worktree.
- Record the commit you read: `git -C D:\projects\wt-lk-inbox rev-parse --short HEAD`.

### 2. Check what already exists here

Grep `migrations/`, `src/domain/`, `src/routes/`, `todo/` and `README.md` for the field and its
likely table name. Part of it may already be modelled (e.g. `cancellation_reason` is a column;
`booking_trip_operations` was reshaped by migration 016). Build on what exists; never create a
second home for the same fact.

### 3. Classify every field

Go field by field and put each in exactly one bucket. This table is the heart of the note.

| Bucket | Becomes | How to recognise it |
|---|---|---|
| Repeating group | its own table, FK to the owner | an array, or a map keyed by id (`{lockId: qty}`) — unbounded |
| Fixed-size struct | columns on the owner, prefixed (`cash_on_tour_*`) | the frontend writes exactly these keys; adding one is a schema change either way |
| Scalar | one column | — |
| Reference | `<thing>_id` column | holds an id of something in another catalogue |
| Display snapshot | a text column **kept denormalized** | a name copied beside an id (`pickup_area`, `market`) — it records what the thing was called *that day*; a rename must not rewrite history |
| Derived | not stored; computed in a pure function | recomputable from other stored fields (a trip's pax total) |
| Overwritten record | a table with history (`kind`, `status`, who/when) | the document overwrites it, so a second approval erases the first |
| Unknown | **left out**, listed under Open | after searching every writer, still no real example of the shape (`trip.ops.van_splits`) — a "shape unknown" line in a note is not enough on its own |

**Nothing stays JSONB.** That was decided on 2026-09-01: an overflow column becomes a junk
drawer, and dropping an unmodelled field is the signal that it needs modelling. Do not propose a
JSON column, even "temporarily".

### 4. Design the schema

- **A column that describes legacy data is nullable with no DEFAULT.** A row from before the
  field existed genuinely has no value; a default invents a claim nobody made
  (`pickup_self = false`). This applies to every column added to an existing table and to any
  field the frontend or the import fills. It does not forbid what the *server* knows for certain
  on a brand-new table — `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`, or a lifecycle flag
  every new row really starts with, the way migration 017 made `agents.active NOT NULL DEFAULT
  true`. When in doubt, ask whether the default would be true of an imported row.
- Money is `NUMERIC(12,2)`. Dates are `DATE`, instants `TIMESTAMPTZ`, times of day `TEXT` with the
  `HH:MM` CHECK used in migration 016.
- Child tables: `REFERENCES <owner> (id) ON DELETE CASCADE`, ordered by `seq` where order matters,
  composite PK `(owner_id, seq)` — copy `migrations/012_booking_passengers.sql`.
- Something that can belong to either level (add-ons on the booking *or* a trip) is one table with
  a nullable `booking_trip_id`, not two tables.
- Polymorphic owners are refused: two tables with the same shape keep their foreign keys, one
  table with an `owner_type` column loses them. Share the *logic* (one type, one function), not the
  table.
- An enum CHECK, a foreign key to a catalogue, or a NOT NULL on existing data is a claim about
  real rows — it waits for the data check (step 6). Plain nullable tables may ship before it.
- Capacity rules live in the schema where they can (`CLAUDE.md`: `license_pax`, never `totalcap`).

### 5. Design the contract

Remember this repo is the API; the deliverable is an endpoint and its documentation, never
frontend code.

- **A booking field** is accepted on `POST /v1/bookings` and `PATCH /v1/bookings/{id}` and
  returned on `GET`. A list replaces outright on PATCH (absent = unchanged, `[]` = clear), the way
  `passengers` and `trips` do — a list is one fact, so there is no per-item merge to define.
  Accept the frontend's key spelling as well as snake_case where the create path already does.
- **A whole-state resource** gets its own endpoints, following the paths proposed in
  `todo/legacy-replacement.md` (they are proposals; settle them here).
- Present-but-malformed input is a `400` naming the field and index (`addOns[2].amount must be a
  number`), never silently dropped — the choice `parseBookingPassengers` makes.
- Write the request/response with a JSON example.

### 6. Check the design against legacy data

The legacy database is reached through `SOURCE_DATABASE_URL`, the same variable
`src/tools/import-legacy.ts` uses. **Read-only `SELECT`s only**, and ask the user before the first
connection in a session. If the variable is not set, write the queries into the note and mark the
check *pending* — do not reach for another URL from `.env`.

Count, don't eyeball: rows using the field, distinct values of anything that looks like an enum,
max array length, nulls, values that would violate a proposed CHECK or FK, orphan references. Write
the numbers into the note with the date. A 2026-08-28 dry run against legacy is the model:
it is why `booking_mode` has a CHECK (3,169 seat, 14 charter, nothing else) and why the status enum
was pulled forward (38 rows were unstorable).

### 7. Write the note and stop

Always a **new** file: `todo/<name>-model.md` (e.g. `todo/trip-ops-and-vans-model.md`). Once the
work is built, delete what the note says about it, and the note itself when nothing is left open:
git history keeps the record. Use this outline:

```markdown
# <name>, modelled

- **Source:** wt-lk-inbox@<sha>, `<file>` `<symbol>` (every writer found)
- **Already here:** <columns/tables/endpoints that exist, or "nothing">

## Fields
<the classification table: frontend key → bucket → column/table → note>

## Schema
<the proposed migration SQL, with the comments it will ship with>

## Contract
<method + path, validation errors, response example>

## Data check — <date or "pending">
<numbers, or the queries to run>

## Expand / contract
<which steps this slice does: add, dual-write, backfill. Backfill must skip rows whose columns
have already moved (an amended booking has correct columns beside a stale blob). Stopping
returning `booking_data` and dropping it are separate, later decisions — not this slice.>

## Open
<unknown fields left out and the example each needs; writer disagreements>

## Where the data comes from
<only if the new home starts empty and the consumer needs rows on day one (a catalogue like rate
types is useless empty): the options — a seed migration from legacy as 006 did for routes, the
importer, or entry through the new write endpoints — as a decision for the user, not done here>

## Follow-ups
- `src/tools/import-legacy.ts` is not extended by this slice: every legacy booking imported at
  cutover will have no <name> until it is.
```

Extending the importer is a separate decision the user has kept out of this skill; list it, do
not plan it into the slice.

Then print a short summary in the terminal — the classification, the tables, anything surprising,
and the open items — and **ask the user to approve before writing any code or migration.** Their
changes go into the note first.

## Phase 2 — build (only after approval)

Follow `CLAUDE.md`. In order:

1. **Migration** `migrations/NNN_<name>.sql`, next free number, additive, with a header comment
   saying what it models and why, in the style of 011/012. Constraints from step 4 only if the data
   check is done and clean.
2. **Domain:** `src/domain/<name>.ts` holds the parser/validator and any rule both stores need, as
   pure functions both stores call (`booking-passengers.ts`, `calendar.ts` are the pattern). Never
   a SQL view or two copies — the in-process store has no database.
3. **Both stores**, identically: `OperationsStore` (`src/domain/operations.ts`) and
   `PostgresOperationsStore` (`src/domain/postgres-operations.ts`). For a booking child table copy
   passengers: aggregate it into `BOOKING_SELECT`, map it in the row mapper, write it with a
   delete-and-insert `writeX` called from create and (when mentioned) amend. Cast dates in SQL
   (`service_date::text`); never stringify a `Date`.
4. **Routes** in `src/routes/operations.ts`, parsing with the domain function.
5. **Tests:** a new `test/<name>.test.ts` hitting the route through `buildApp()`, data scoped to an
   id unique to the run. Run `npm run check`, `npm test`, and the same suite with `DATABASE_URL`
   pointing at a **local** database only — never the Railway URL in `.env`. If no local database is
   reachable, say PostgreSQL was not run and give the exact command. A failure that also happens
   with your change stashed is pre-existing: report it, don't fix it silently.
6. **README.md:** every endpoint added or changed — parameters, validation errors, response shape,
   an example — so an integrator needs nothing else.
7. Update the todo note: what shipped, what is still open.

Out of this skill's scope unless the user asks: `src/tools/import-legacy.ts`, any frontend code,
stopping `booking_data` being returned, dropping a column. A destructive migration (backfill,
drop) is rehearsed against a restored copy before merging, as `CLAUDE.md` requires. Do not commit.

Finish with: what changed and why, the test results (and whether PostgreSQL ran), and how to verify.
