# Sales editing, legacy read

**Status:** legacy read (wt-lk-inbox@658298d, 2026-10-09); not designed yet.

Covers how legacy creates and edits agents, their programmes, contracts and contract templates,
markets and sub-markets, salespeople (the "Team & Markets" screen), staff welfare, the add-on
"catalogue", nationalities and insurance overrides. Function names are in
`allotment_v2/js/08-app.js` unless another file is named.

## What legacy does

### How a save works (all of these screens)

- **Every edit happens in the browser.** A screen changes an in-memory list (`SB_AGENTS`,
  `SB_CONTRACTS`, …), then a `…Persist()` function writes it to `localStorage`. The sync layer
  (`01-auth-sync.js`, `laDiffToOps`) diffs it and sends `POST /api/v1/_batch` (put / patch / del per
  record). The server stores what it gets.
- **The server checks one thing:** a login with `edit: false` gets `403` (`server.js`, `canWrite`).
  It does **not** check edit areas, admin-only actions, or any business rule below.
- **Edit areas are checked only in the browser,** in two ways: a `laGuardEdit(area)` toast before an
  action, or a silent `return` inside the `…Persist()` function (the change shows on screen, then is
  not saved).

### Which edit area legacy checks

| What | Screen (menu area) | Checked area | How |
|---|---|---|---|
| Agents: create, edit, table, bulk, import, programmes, rate type, template | Agent List (`sales`) | `sales` | `sbAgentsPersist`, `laGuardEdit('sales')` |
| Delete an agent | Agent List | **admin only** | `agDelete`, `agTblDeleteSelected` (`laIsAdmin`) |
| Contracts: promo add/edit/void, renewal | Agent detail (`sales`) | `sales` | buttons hidden; `sbContractsPersist` |
| Contract documents issued (`agent_artifacts`) | Agent detail | `sales` | `ctArtifactsPersist` |
| Contract templates | Contract Templates (`sales`) | `sales` | `ctTmplPersist`, plus an "Edit" unlock toggle that is not a permission |
| Salespeople | Team & Markets (`config`) | **`sales`** | `sbSalesPersist` |
| Sales targets | Sales Board (`sales`) | admin-only button; saved under `sales` | `sbEditTarget` → `salesSetTarget` → `sbSalesPersist` |
| Markets, sub-markets | Team & Markets (`config`) | `config` | `sbMarketsPersist` |
| Custom add-on types | Rate Types (`sales`) | **`config`** | `sbAddonTypesPersist` |
| Add-on Services master list | Add-on Services (`config`) | none, never saved | — |
| Staff & welfare quota | Staff & Welfare (`sales`) | `sales` | `sbStaffPersist` |
| Custom nationalities | booking form | **none** | `sbNationalitiesPersist` has no guard |
| Insurance overrides | Insurance (`operations`) | `operations` | `insPersist` |

**A sales-bound login** (`users.sales_id` set, not admin) sees only its own agents and rate types
(`laScopeAgents`, `laAgentInScope`, `_rtInScope`). Browser only; the server returns everything.

### Agents

**Create** (`agNew` → `agCreateSubmit`). Fields: name, legal name, tax ID, TAT licence, website,
address, market, sub-market, salesperson, rate type, payment type, credit days, credit limit, VAT
mode, contact, phone, email, signatory name / designation / tel, note.

- **Refusals (alert, nothing saved):** name, legal name, address, market, rate type, payment type
  and VAT mode are required.
- **Warning (confirm):** a name or code close to an existing agent's (`agFindDup`: same letters and
  digits, spaces ignored).
- **Rate type choices** are the chosen salesperson's own rate types plus shared ones (`rtForSales`).
  Changing the salesperson clears a rate type owned by someone else (`agNewSetSales`).
- **Computed on create:** id `LA_UID('a')`; code from the typed code, else the name's first 8
  letters/digits uppercased (no uniqueness check); credit days and limit forced to 0 unless the
  payment type is `invoice`; `creditBalance` 0; contract defaults from `_seedAgentContractDefaults`
  (status `active`, version `v2025-1`, contract dates from the programme rows, else
  2025-10-01..2026-09-30; booking channel with LoveAndaman's own email and phone; signatory from the
  contact when none is typed); programmes filled from the rate type (`agProgFill`).
- **Activity:** `created` ("Agent created · rate type …").
- An OCR button reads a business card and fills empty fields only (`agNewOcrApply`). Browser only.

**Edit** is a modal per section (`agEditOpen` / `agEditSave`). Each section writes one activity
line when something changed:

| Section | Fields | Rules | Activity kind |
|---|---|---|---|
| `sales` | salesperson | blank is a confirm, not a refusal | `sales` |
| `programs` | programme rows: route, book from/to, note | travel dates are copied from the rate type's `routeValidity` and cannot be typed; banner lists routes missing from / not in the rate type; "Add missing" button | `programs` |
| `profile` | payment type, VAT mode, credit days, credit limit, credit balance | none; credit balance is typed by hand | `credit` |
| `company` | name, colour, legal name, TAT licence, market, sub-market, address, tel, hotline, fax, email, website | name and legal name required; a new sub-market is added to the market's list | `company` |
| `signatory` | name, designation, tel, signed date | none | `edit` |
| `booking` | method, cutoff, cancel policy, booking email, booking phone | none (free text) | `edit` |
| `notes` | internal note | none | `note` |
| `ratetype` | rate type | see below | `rate` |
| `contracttmpl` | contract template (blank = the default template) | none | `contract` |

**Changing the rate type** (section `ratetype`) also:
1. sets the rate on the agent's current main contract(s) (`_ctSyncMainRate`; not expired/void ones),
   activity `contract`;
2. adds programme rows for routes the new rate prices, and asks (confirm) whether to remove rows the
   rate does not price; "Cancel" keeps them, and the booking form then blocks those routes
   (`agProgSyncOnRate`), activity `programs`.

**Table view** (`agRenderTable`, `AG_COLS`): spreadsheet editing of name, code, market, sub,
salesperson, payment type (`invoice`/`proforma`/`cot` only), VAT, credit days/limit, rate type,
template, programmes, company, signatory, contact, email, phone, note. Plus bulk "set field on N
ticked agents" (`agBulkApply`), fill-down (`agFillDown`), and a bulk "fill programmes from the rate"
panel (`agProgBulkPanel`, `agProgBulkApply`). **None of these writes activity**, and a rate type
changed here does not sync the contract or the programmes.

**Import from Excel** (`agImport*`): matches by code, then name; creates or fills empty fields
(overwrite is opt-in). It never renames an agent and never changes an existing agent's salesperson
(warns instead). No activity lines.

**Programmes** decide which routes an agent may book. An agent with **no** programme rows can book
any route (`agProgBulkPanel` text). Legacy keeps them twice: `programs[]` (route ids) and
`programPeriods[]`; the section modal keeps both in step, the table picker writes only `programs`.

**Deactivate: legacy has none.** The booking form skips `a.active === false`, but nothing sets it
and `sb_agents` has no `active` column. **Delete** is hard, admin-only, and does not touch the
agent's contracts, documents or bookings (`agDelete`). `agClearOpen` (cascade delete of bookings,
contracts, locks) exists but nothing calls it.

### Contracts

- **Main contracts** were made once by a migration in the browser (`_sbMigrateContracts`,
  2026-07-23): `ct_main_<agent>` from the agent's fields, `ct_hist_<agent>_<version>` from each
  archived `contractHistory` entry. It reruns on every page load and adds ids it has not seen.
- **Renewal** (`ctOpenRenewal` → `ctRenewActivate`, a 4-step wizard, "any time"): new start (old end
  + 1 day), end (+1 year, presets), version (`vYYYY-1`), optional new rate type, and what to carry
  over (programmes, prices, add-ons, booking channel, signatory, company). It archives a snapshot
  into the agent's `contractHistory`, changes the **agent's** contract fields and shifts programme
  dates by the same number of days. It does **not** create a contract row; the next page load makes a
  `ct_hist_…` one. Refusal: end must be after start. No activity line.
- **Promotions** (`ctOpenAddPromo` → `ctSaveAddPromo`): travel dates, optional booking dates,
  routes, priority (default 10), note, and a price mode: `rate` (pick a rate type), `own` (typed
  prices, prefilled from the main rate) or `discount` (`pct` or `amt`), plus an optional "buy N get
  1 free" bonus. Refusals: dates missing or backwards, no route, no price at all, discount ≤ 0,
  percent ≥ 100, amount ≥ the cheapest adult main price. Confirms: some routes have no price;
  editing a promo already used on N trips. `createdBy` is the username (`laBy`).
- **Void** a promo (`ctVoidContract`): confirm, then `status: 'void'`. Main contracts cannot be
  voided. Status shown on screen is worked out from dates (`_ctContractStatus`: scheduled / active /
  expired), not the stored status.
- **Issuing a document** (`ctDocOpen`, `ctArtifactSave`): renders the contract from a template and
  saves a frozen copy (text, sections, overrides, custom clauses, rate type name) in
  `agent_artifacts`, max 20 per agent; stamps the contract's `docId`; activity `contract`. This is the
  record of what was sent to the agent, not throwaway browser state.

### Contract templates (`ctt*`, view `contract-tmpl`)

A template is `{id, code, name, active, isDefault, createdDate, note, form, accent, accentHex,
font, sections{}, text{en{}, th{}}}`. New ones copy the default (`cttNew`). Rules: exactly one
default (`cttSetDefault`, which also activates it); the default cannot be deactivated or deleted;
deleting one unbinds its agents (they fall back to the default). An agent bound to an inactive
template uses the default (`ctTmplForAgent`). Text edits are locked behind an "Edit" toggle, but
form, accent, font, sections, default, active and delete ignore the lock.

### Salespeople and markets (Team & Markets, `renderTeamMkt`, `tm*`)

- **Salesperson fields:** code (≤3 letters, uppercased), nickname, full name, designation, email,
  tel, colour, signature image (shrunk to 900 px PNG, white made transparent, stored as a data URL),
  active. Refusals: code and name required; code unique. Delete is a hard delete after a confirm
  that unassigns their agents. Inactive (2026-10-05) hides them from pickers but keeps them on old
  agents (`sbSalesOpts`). Targets (`{"YYYY-MM": pax}`) and follow-up marks live on the same record.
- **Market fields:** id (lowercase letters/digits, fixed after create), name, colour, sub-markets
  (one per line), order (drag, `tmApplyMarketOrder` → `sort`). Refusals: name and id required, id
  unique. Delete is refused while any agent is in the market.
- **Sub-markets are free text on the agent.** The list on the market is only a suggestion list;
  typing a new one on an agent adds it to the market (`agSubMarketRemember`).

### Staff & welfare (`staff*`)

Staff rows (code `EMP-NNN`, name, dept, active, a free-trip quota per year). Hard delete with a
confirm. Used by the `a_staff` house agent.

### The add-on "catalogue"

Legacy has **no stored add-on catalogue.** What exists:

- **What a booking can add** comes from the agent's rate type: longtail join / charter and private
  transfer per route, zone and vehicle (`bkV2RenderAddOnsSection`, `bkV2AddOnInfo`). This repo already has
  it (rate types, booking add-ons).
- **Rate-type add-on kinds:** two built in (`RT_ADDON_BUILTIN`: `longtail`, `privateTransfer`) and
  custom kinds (`SB_ADDON_TYPES`: key, label en/th, `perPax` or `flat`, unit). Custom kinds show on
  rate types and contracts only, never on the booking form. None is stored in the database.
- **"Add-on Services" screen** (`SB_ADDON_SVCS`, `aos*`): a hard-coded list of 3 services (longtail
  Pileh, private van, international guide) with variants. Edits there are never saved.
- **Per-agent add-on prices** (`a.addonServices`, selling/net per variant, `agpAddon*`): no column
  on `sb_agents`, so never saved (only 2 renewal snapshots hold any).
- `sb_extras` is on-tour sales (money), not a catalogue.

### Nationalities

73 built-in codes (incl. `OTHER`) are hard-coded in the browser (`BKV2_NATIONALITIES`). Typing an
unknown one in the booking form adds a custom one (`bkV2AddCustomNat`): name cleaned, at least 2
letters, matched against existing names/codes, code = first 3 letters (+ number on a clash). One-off
clean-ups (`bkV2CleanupNats`) merge duplicates and rewrite bookings. `nat_learn` is a name-token →
nationality vote table the form uses to guess a nationality (`natLearnGuess`).

### Insurance overrides (`ins*`, view `insurance`, area `operations`)

A per-date list of every passenger on the day's trips for the insurer: first/last name (split from
the passenger name), age, nationality, and a "Reviewed" tick, printable per route. Edits are stored
apart from the booking, keyed `<bookingId>::lead` or `<bookingId>::<passenger index>`, with fields
`firstName`, `lastName`, `age`, `nat`, `reviewed`, `at`. Revert removes the four value fields.
Age blank is flagged red; no other rule.

## How legacy stores it

`os-backend/src/mapping/field_mapping.json` maps the browser lists to tables; a key not mapped is
dropped or kept in `app_meta`.

| Data | Table(s) | Notes |
|---|---|---|
| Agents | `sb_agents`, `__programs`, `__programperiods`, `__activity`, `__contracthistory` | company / signatory / booking channel flattened to columns. No `active`, `addonServices` or `rateSeasons` column |
| Rate binding | `sb_agents_rate_bindings` (`id`, `ratetypeid`) | a copy of `sb_agents.ratetypeid`, written on every agent save |
| Contracts | `sb_contracts`, `sb_contracts__programperiods` | `rates`, `discount`, `bonus` as JSON text; no `voidedBy`/`voidedDate` column, so those are dropped |
| Templates | `contract_templates` | key/value, whole template as JSON |
| Issued documents | `agent_artifacts` | key = agent id, value = array |
| Salespeople | `sb_sales` | `signature` is a base64 image in a text column; `targets`, `followup` JSON text |
| Markets | `sb_markets`, `sb_markets__subs` | |
| Staff | `sb_staff` | only `quota_2026`; other years' quotas are dropped |
| Custom nationalities | `sb_nationalities` | built-ins are not stored |
| Name guesses | `nat_learn` | key = token |
| Insurance | `insurance_overrides` | key/value JSON |
| Custom add-on kinds, Add-on Services | not stored | |

## Data

Read-only, legacy production, 2026-10-09.

- **Agents: 832.** Ids: 81 seed-style (`a01`…), 4 house (`a_walkin`, `a_staff`, `a_company`,
  `a_b2c`), 747 generated. 254 have bookings; no booking points at an unknown agent.
- **Codes:** none blank, 808 distinct; 21 codes are shared by 2–3 agents (e.g. `COCONUTT`,
  `ANDAMANS`, `PHUKETMA` ×3).
- **Payment type:** proforma 528, invoice 154, null 142, blank 2, cot 4, `bank` 2.
- **VAT mode:** include 384, none 208, exclude 18, null 220, blank 2.
- **Incomplete:** no market 131 (127 null, 4 blank), no salesperson 15, no rate type 304, no
  contact 382. Market ids not in `sb_markets`: blank (4) and `b2c` (1, `a_b2c`).
- **Sub-markets:** 544 agents have one; 25 hold a sub-market not in their market's list (e.g. `DMC`
  under `ota` ×13).
- **Credit:** 67 have a limit (5 of them not on `invoice`); 1 has a non-zero `creditbalance`.
- **Contract fields:** status active 831, expired 1; version `v2025-1` 758, `v2026-1` 73,
  `v2027-1` 1; contract end 2026-08-28..2028-10-15. Signatory missing or `—` on 720.
- **Templates:** 68 agents bound to `ctt_std`, 12 blank, 752 null. 9 templates; 8 are named
  "Template ใหม่", two share code `CT-06`; the default is `ctt_mswn8sgv`, not `ctt_std`.
- **Rate bindings** match `sb_agents.ratetypeid` on all 832 today.
- **Programmes:** 371 agents have rows (2343 period rows, 2320 route rows); 461 have none. 9 agents'
  two lists disagree. No agent has two rows for one route. 6 rows have book-to before book-from;
  87 have no travel dates.
- **Activity:** 1084 rows on 400 agents, 2026-06-10..2026-10-09; kinds programs 404, created 282,
  rate 187, contract 100, company 47, credit 34, sales 28, edit 1, note 1. **`by` is blank on all
  1084** (see bugs).
- **Contracts: 927.** main active 845, main expired 78, promo active 2, promo void 2 (2 promos have
  no `pricemode`). 77 are `ct_hist_…`. Created by `migration` 923, `admin` 3, `SALES.MAM` 1. 14
  belong to deleted agents. Of 831 active `ct_main_…`, 259 have a different rate type from the agent
  and 73 a different end date. 1 has a document id.
- **Contract history:** 77 rows on 75 agents, archived 2024-09-30..2026-10-07.
- **Issued documents:** 16 on 8 agents.
- **Salespeople: 9** (`s01`…`s05`, `s057714`, `s300574`, `s363434`, `s904791`); 2 inactive (no
  agents), 7 with `active` null (= active). Signatures up to 682 KB. No duplicate codes.
- **Markets: 11** (`ru`, `ota`, `hpk`, `hkl`, `cpk`, `ckl`, `ap`, `ww`, `walkin`, `staff`, `house`);
  `house` has no `sort`. No duplicate sub-markets within a market.
- **Staff:** 24, all active, all with a 2026 quota.
- **Custom nationalities: 65**, messy: ISO-3 codes that duplicate built-ins (`DEU`, `GBR`, `USA`,
  `CHN`…), four Nigerias (`NG`, `NGA`, `NGN`, `NIG`), two Ghanas, lower-case junk (`ano`, `ao`,
  `sun`, `suda`). Used by 218 bookings' lead and 199 passengers.
- **`nat_learn`:** 12,514 tokens.
- **Insurance overrides: 5088** (2682 lead, 2406 by passenger index), 2026-07-04..2026-10-09. Every
  row has `age`; none overrides a name or nationality; 5086 are reviewed. One age is `2.5`, one is
  over 100. No orphan bookings or indexes today.
- `sb_addon_types` and the Add-on Services list: nothing in the database.

## Already here

- **Agents (read):** migration 017, `GET /v1/agents`, `/v1/agents/{id}`, `/activity`,
  `/v1/markets`, `/v1/sales` (README → Agents). `agent_programs` has one row per route
  (`PRIMARY KEY (agent_id, route_id)`), replacing legacy's two lists. `agents.active` exists, all
  imported as true. `house` is set for `a_walkin`, `a_staff`, `a_b2c` (`import-legacy.ts`
  `HOUSE_AGENTS`), **not `a_company`**.
- **Credit** is worked out (`credit` block on the agent detail), so legacy's typed `creditBalance`
  is not needed.
- **Rate seasons:** `GET`/`PUT /v1/agents/{id}/rate-seasons` (migration 030), area `sales`, writes
  an activity line. Legacy's seasons never reached its database.
- **Contracts (read):** migration 029, `GET /v1/contracts`, `/{id}`, `import:contracts`. Promo
  writes are planned with the quote (`contracts-model.md`).
- **Rate types** with add-on prices, write endpoints, area `sales` (README → Rate types).
- **Booking add-ons** (migration 018, README → Add-ons); booking passengers with `nationality` as
  free text (migration 012).
- **Edit areas** are enforced server-side (README → "What each login may do"): `sales` covers rate
  types and agents; `config` the route calendar.
- **Planned** in `legacy-replacement.md` §6 and `agents.md`: agent writes, deactivate/activate,
  contract writes, templates, nationalities, insurance overrides.
- **Missing:** every write here except rate seasons; templates, issued documents, nationalities,
  insurance overrides, staff, market and salesperson edits.

## Bugs or oddities in legacy

1. **Activity never says who.** `agLog` stamps `window._rmUser`, which nothing sets: `by` is blank on
   all 1084 rows.
2. **Edits with no activity line:** table cells, bulk set, fill-down, import, renewal, promo
   add/edit/void, salesperson delete (unassigns agents), template delete (unbinds agents).
3. **Table rate-type edit skips the side effects** the modal does (contract rate sync, programme
   fill). Bulk-setting programmes writes `programs` but not `programPeriods`, so the two lists drift
   (9 agents today).
4. **Renewal changes the agent, not the contract,** and is not saved until something else saves the
   agent (`ctRenewActivate` never calls `sbAgentsPersist`). The `ct_hist_…` made afterwards takes the
   agent's **current** rate type, not the archived one. Result: 259 main contracts disagree with
   their agent's rate.
5. **Silent "saved on screen, not saved":** a `config`-only user editing a salesperson, a
   `sales`-only user adding a sub-market from the agent form, a `sales`-only user creating a custom
   add-on kind. The persist function returns without a message.
6. **Add-on Services edits are never saved;** per-agent add-on prices and custom add-on kinds never
   reach the database.
7. **No agent deactivate;** delete is hard and leaves 14 orphan contracts.
8. **Agent codes are not unique** (21 shared). The generated code is the first 8 letters, so two
   "Phuket Ma…" agents collide.
9. **Payment type `bank`** is written by the edit modal while the list and every reader use `bt`
   (2 agents); the table view cannot set `bt` at all.
10. **`creditBalance` is typed by hand,** and any agent without one is seeded at 70 % of its limit (`_seedAgentContractDefaults`).
11. **Credit days/limit are cleared only on create** for non-invoice payment types; editing keeps them
    (5 agents have a limit without `invoice`).
12. **Insurance overrides are keyed by passenger position.** Removing or reordering a passenger moves
    an age onto someone else.
13. **Nationality list has no edit guard** and has collected duplicates of built-ins.
14. **Staff quotas** for any year but 2026 are dropped on save.
15. **Default contract values are hard-coded dates** (2025-10-01..2026-09-30) in
    `_seedAgentContractDefaults` and `agEditPPAdd`.
16. **Template "Edit" lock** covers text only; style, sections, default, active and delete bypass it.
    Two templates share code `CT-06`.

## Questions for the developer

1. **Deactivate instead of delete?** Legacy only hard-deletes (admin). *Recommend:* `POST
   /v1/agents/{id}/deactivate` and `/activate` (area `sales`); no delete once an agent has a booking
   or contract; the booking create refuses an inactive agent. That is a new refusal; legacy's form
   already hides `active === false`.
2. **Who edits salespeople and markets?** Legacy shows them on a `config` screen but saves
   salespeople under `sales` and markets under `config`. *Recommend:* both `config`, matching the
   screen; a new sub-market typed on an agent is just the agent's text (client fact) and the server
   adds it to the market's list as part of the agent save.
3. **Enforce sales scoping on the server?** *Recommend:* yes, when the login has `sales_id`: list and
   detail show only own agents, writes to another's agent are `403`, a new agent gets the caller's
   salesperson.
4. **Agent code:** *Recommend:* computed when absent (legacy rule), checked unique for new and changed
   codes (`409 code_taken`); leave the 21 legacy duplicates until sales cleans them, then add the
   constraint.
5. **Rate-type change as a command** `PUT /v1/agents/{id}/rate-type` that also fills programmes and
   syncs the active main contract, with `drop_unpriced: true` for legacy's "remove them" confirm?
   *Recommend:* yes; `PATCH` refuses `rate_type_id` and names this command. The same for programmes
   (`PUT /v1/agents/{id}/programs`, one row per route, book_to ≥ book_from).
6. **Renewal:** keep legacy's "change the agent's fields" or make it create a new main contract and
   expire the old one? *Recommend:* a command `POST /v1/agents/{id}/renew` that creates the contract
   row (fixing bug 4), and the agent's `contract_*` fields read from the current main contract. Needs
   a decision on which is the truth (`contracts-model.md` already asks).
7. **Activity:** *Recommend:* the server writes the line for every agent change, from every path
   (table, bulk, import), stamped with the caller. Keep legacy's kinds and its English wording.
8. **Credit balance and credit for non-invoice agents:** *Recommend:* `credit_balance` is never
   accepted (computed); credit days/limit refused or cleared unless `pay_type` is `invoice`? Ask: 5
   agents would change.
9. **Templates and issued documents:** store templates as rows with the JSON text, and issued
   documents as frozen records linked to the contract (`contracts.doc_id`)? *Recommend:* yes, area
   `sales`; one default enforced by the server; template code unique.
10. **Add-on catalogue:** *Recommend:* build none now. Booking add-ons already come from rate types;
    the Add-on Services screen and per-agent add-on prices were never saved, so nobody relies on
    them. Confirm with sales before dropping the screen.
11. **Nationalities:** *Recommend:* the server owns the list (73 built-ins + custom), `GET
    /v1/nationalities` and `POST` with legacy's clean/match rule, area `operations` (it is added from
    the booking form). Ask before merging the 65 custom ones: it rewrites 218 bookings.
12. **Insurance overrides:** the planned `PUT /v1/insurance-overrides/{date}` does not match legacy,
    which keys by booking passenger. *Recommend:* passenger fields `age`, `insurance_reviewed` (and
    who/when) on the booking (lead on the header, others on `booking_passengers`), area
    `operations`, set by a small command; drop the unused name/nationality overrides. Ask whether an
    age of `2.5` is valid (infant ages in months?).
13. **Staff and welfare quota:** in scope now? *Recommend:* later, with the staff-welfare pricing; keep
    quotas per year when it comes.
14. **`a_company` as a house account?** The import marks only three. *Recommend:* add it.
15. **`nat_learn`:** *Recommend:* leave it out (a client-side guess cache), as `legacy-replacement.md`
    says. `agent_artifacts` is not browser state, though; it should move off that list.

## Decided (2026-10-09)

1. **Agents are deactivated, not deleted:** deactivate/activate (`sales`); delete only with no booking
   or contract; a booking for an inactive agent is refused (new).
2. **Salespeople and markets** are edited under `config`.
3. **Sales scoping is the server's:** a login with `sales_id` lists and opens only its own agents,
   editing another's is `403`, a new agent gets the caller's salesperson.
4. **Agent codes:** new and changed codes must be unique (`409 code_taken`); the 21 legacy duplicates
   stay until sales cleans them, then the constraint is added.
5. **Rate type** changes through `PUT /v1/agents/{id}/rate-type` (refills programmes, syncs the main
   contract, `drop_unpriced`); `PATCH` refuses `rate_type_id`; programmes through their own `PUT`.
6. **Renewal: copy legacy:** renew edits the agent's contract fields; no contract row is created.
7. **Activity:** the server writes a line for every agent change from every path, with the login.
8. **Credit on non-invoice agents: copy legacy** (allowed; billing ignores it).
9. **Templates and issued documents** are stored: templates (one default, unique code, `sales`) and
   frozen issued documents linked to their contract.
10. **Add-on catalogue: build one** (add-on services with prices). Needs its own design: legacy never
    saved one, so there is nothing to copy; ask sales what it lists.
11. **Nationalities:** the server owns the list (`GET`/`POST`, legacy's clean-and-match rule,
    `operations`); merging the 65 custom ones later (it rewrites 218 bookings).
12. **Insurance:** `age` and `insurance_reviewed` (who/when) on booking passengers, a small command
    under `operations`; fractional ages allowed.
13. **Staff welfare quotas:** later, with staff pricing.
14. **`a_company`** becomes a house account.
15. **`nat_learn`** stays out (a browser guess cache); `agent_artifacts` is real data (item 9).
