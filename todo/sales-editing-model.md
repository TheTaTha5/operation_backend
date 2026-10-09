# Sales editing: what is still open

**Built** on `feat/sales-editing` (decided 2026-10-09; legacy read wt-lk-inbox@658298d): agent
create, edit, programmes, rate type, renewal, deactivate/activate and delete; sales scoping; contract
templates and issued documents; salespeople and markets; the add-on catalogue; nationalities;
passengers' insurance age and review; the import's cutover. Migrations 090–093; README "Agents" to
"Nationalities" and "Insurance"; `src/routes/sales-editing.ts` and the `src/domain/` modules it names.

**Built** on `feat/sales-extras` (2026-10-10, same legacy read): promo contracts
(`contracts-model.md`), `import:contracts` seed-only, the Sales Board's targets and follow-up marks
(`sales-board.ts`), staff and their welfare quotas with the booking form's staff guard (`staff.ts`).
Migrations 200–202; README "Contracts", "Sales Board", "Staff and welfare quotas".

## Open

1. **Merge the custom nationalities** (decision 11): 66 in legacy today (four Nigerias, ISO-3 copies
   of built-ins, lower-case junk); merging rewrites the bookings that use them.
2. **The add-on catalogue's contents** come from sales (checklist). Not modelled: per-agent add-on
   prices (`a.addonServices`) and custom add-on kinds (`SB_ADDON_TYPES`); legacy never saved either.
3. **Agent codes:** add the unique constraint once sales renames the 21 shared ones (`agents.md`).
4. **Scoping beyond agents** was not decided: a sales-bound login still lists and books for any
   agent through `/v1/bookings`, and sees every rate type (legacy hid other salespeople's rate types
   too, `_rtInScope`).
5. **A company booking's reason** (`companyPurpose`, legacy `bkV2Save`, beside the staff guard): legacy
   refuses a booking on `a_company` without one. Not built: the booking has no such field here yet
   (`purpose` holds the staff ones), so it needs its own small design.
6. **The Sales Board reads bookings on every request** (two months, more when targets run back):
   fine at legacy's volume (about 5,000 bookings); a summary table if it gets slow.

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

Extras (`feat/sales-extras`, 2026-10-10; promos are flagged in `contracts-model.md`):

- **Staff quotas were built now**, not "later" (decision 13): staff pricing already exists
  (`enforcedPriceMode`: welfare at the staff rate, FOC free, inspection 0), so only the registry, the
  quota and the guard were missing. One quota per year (legacy: 2026 only, bug 14).
- **The over-quota guard** counts what was used without inspection bookings, as legacy's roster does
  (`staffWelfareUsed`); legacy's save guard counted inspections too. One rule here. Like legacy, a
  year already over its quota asks even when the booking adds no free seat.
- **The guard runs** on create, and on a `PATCH` only when trips, pax, `staff_id`, `staff_purpose` or
  `purpose` change (legacy asked on every save); not on a cancelled booking. "Save anyway" is
  `quota_anyway: true`.
- **A `staff_id` sent must be a staff member** on any booking (`400`; legacy's picker only offered
  them). `bookings.staff_id` has no foreign key: imported bookings mirror legacy, which deletes staff.
- **Deleting a staff member** is refused while a booking names them (`409 in_use`; legacy deleted
  and left the bookings naming nobody).
- **A new staff member's quota** is for this year (legacy: the year on screen). Ids and codes are
  legacy's (`st` and `EMP-` + the highest number + 1); codes are not unique (legacy has 3 clashes).
- **Targets:** a pax that is not a whole number ≥ 0 is `400` (legacy read it as 0, which cleared the
  target); a sales-bound login cannot set one (`403`; legacy hid the button). `set_at`/`set_by` are
  new; imported targets carry the import's time.
- **Follow-up marks** are set or cleared as sent (legacy toggled, so a retry undid it); the agent must
  be the salesperson's (`400`; legacy only listed their own). Imported marks carry the import's time.
- **The Sales Board is computed here** (`GET /v1/sales-board`), legacy's numbers: ties in rank by
  salesperson id (legacy's load order).
- **Import:** `--sales` also seeds staff (legacy's 2026 quota replaced, a year set here kept),
  targets and follow-up marks. Rehearsed 2026-10-10 on a throwaway import: 24 staff, 24 quotas
  (58 seats), 0 targets, 1 follow-up mark; a rerun without `--sales` kept a rename, a 2027 quota and
  a target set here.

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
