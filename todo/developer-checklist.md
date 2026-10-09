# Your to-do list

What only you can do: decisions, pushes, Railway, the other repos. Tick by deleting the line.

## Deploy what is on `main`

1. **Push `main`** again: deploying applies migrations 039–044 (add-on checks, attachments,
   allergies, document check, pickup areas, the change feed). Once `feat/invoices` is merged, 045
   (invoices and payments), 046 (who raised a boat's day capacity) and 047 (whole-boat holds) come
   with it. Once `feat/weather-closures` is merged, 060 (weather closures and their follow-ups) and
   061 (refunds, credits, invoice lines taken off, payment method `credit`); then re-import, which
   brings legacy's 5 closures and 40 follow-ups. 060 rewrites `changes_kind_check`: if another branch
   adds a change kind too, the later migration must list both.
   with it, and with `feat/seat-lock-extras` 048 (bulk locks, sub-groups, pending seats, expiry,
   holders, the lock log). 048 turns a lock whose `agent_id` names no agent into an office lock with
   the name in its reason, then adds the agent key; rehearsed on the local full import (2 locks).
   Re-run `import-legacy` after it: sub-groups, bulk groups, pending seats and the 4,000-odd log
   lines only arrive with the import.
1b. **Copy the files, then re-import:** `npm run import:attachments -- --commit` against Railway
   (5,887 files, ~660 MB; ~18 min locally, re-runnable), then a fresh `import-legacy` run. It brings
   the day-of-operations data, documents, slips, allergy lists, document checks and pickup areas,
   and (with 045) the invoices and payments with their slips.
1b2. **Rate types are this API's now** (`feat/rate-types-cutover`): the import no longer touches
   them. If Railway has none yet (`SELECT count(*) FROM rate_types`), run the import once with
   `--rate-types`. From then on prices are edited here, not in legacy.
1b3. **Van job orders (`feat/van-job-orders`, migration 080):** 080 drops `van_days.sent_at`, moving
   each mark onto every group that van had that day; re-run `import-legacy` after deploying it so the
   marks land per job (rehearsed: 438 of legacy's 449), with the special requests, the 760 Thai
   pickup names and the group order.
1b4. **Routes and boats are this API's now** (`feat/catalogue-editing`, migration 070): after
   deploying, run `npm run seed:routes -- --commit` and `npm run seed:boats -- --commit` against
   Railway once. They add the 5 charter boats and fill every boat's form fields, documents and
   status log; a route or boat edited here is never overwritten. From then on ops edit Programs and
   boats here, not in legacy (stop `save('config')` writing them). `sync:routes`/`sync:boats` are gone.
1b5. **The sales area is this API's once `feat/sales-editing` is merged** (migrations 090–093):
   the import no longer writes agents, markets, salespeople, contract templates or issued documents.
   Run it once with `--sales` *before* deploying the code (or on a database with none), so Railway
   gets legacy's latest agents, templates, 16 documents and 77 renewal archives; from then on they are
   edited here. **Legacy must stop editing agents at the same moment** (the integration branch's
   §6.5): an agent made in legacy afterwards never arrives. `import:contracts` reruns would overwrite
   a main contract's rate and `doc_id` set here: stop rerunning it after this.
1b6. **Van bills and the money reports (`feat/money-van-bills-and-reports`, migration 120):** re-run
   `import-legacy` after deploying. It brings 26 of legacy's 31 van bills (the 5 with the older
   four-part key are skipped), 65 van-rate cells and the daily report's settings; re-runs keep any
   sent/paid state set here. Rehearsed 2026-10-09: 24 of the 26 bills match legacy's rows and totals
   exactly; 2 (โกอู๊ด and สตอ, 2026-08 period 3) each miss one run, because the van-group import drops
   the van of a legacy group whose members sat on different vans (see the import's "van group
   conflicts"). Then decide the open points in `todo/money-model.md` "Flagged".
1b7. **Fleet part A is this API's once `feat/fleet-availability-and-jobs` is merged** (migration
   130): after deploying (and after `seed:boats`), run `npm run seed:boats -- --commit` again if the
   boats were seeded before (it now reads legacy's 15 plan-ahead entries into `planned_over`, on boats
   never edited here), then `npm run import:fleet -- --commit` once (rehearsed 2026-10-09: 54 engines,
   59 gearboxes, 62 propellers, 73 incidents, 122 jobs, nothing skipped). **Legacy must stop editing
   assets, incidents and jobs at the same moment** (integration branch §3.15); a re-run overwrites
   edits made here to legacy's records. From then on deploying a boat under repair needs
   `deploy_anyway` (Boat Operation, §3.13).
1b8. **Fleet part B (`feat/fleet-stock-memos-log-projects`, migrations 140–143):** after deploying,
   run `npm run import:fleet-stock -- --commit` against Railway (after `seed:boats` and
   `import:attachments`, so the 75 project photos link to their files). Rehearsed 2026-10-09: 616
   items, 1,267 movements (+7 reconciliation), 226 memos, 21 projects, 123 log days, 94 safety items;
   every item's stock equal to legacy's. Rerun it until the fleet area cuts over. Run it after `import:fleet` (part A),
   so imported memos and movements find their jobs.
1c. **After that import,** validate the booking area keys on Railway:
   `ALTER TABLE bookings VALIDATE CONSTRAINT bookings_pickup_area_fk; ALTER TABLE bookings VALIDATE CONSTRAINT bookings_dropoff_area_fk;`
2. **Railway variables:** remove `OIDC_ISSUER`, `OIDC_AUDIENCE`, `AUTH_PASSWORD_USERS`; keep
   `AUTH_JWT_SECRET` and `AUTH_REQUIRED=true`; set `B2C_API_KEY` to legacy's value.
3. **Import the users — nobody can log in until you do:**
   `SOURCE_DATABASE_URL=<legacy> TARGET_DATABASE_URL=<railway> npm run import:users -- --commit`,
   after the agents import (so the sales staff's `sales_id` connects). Rerun until cutover.
3b. **Import the contracts:** `npm run import:contracts -- --commit` against Railway, after
   `seed:routes` and the agents and rate types imports. Rerun until cutover.
4. **Create Love Kingdom's service user**: `POST /v1/users` with `agent_id: "a_b2c"`,
   `edit_areas: ["operations"]`. Send them the username and password.
5. **Give `act-approve`** to the staff who approve over the allotment and FOC
   (`PATCH /v1/users/{id}`). Until then only `admin` and `Tata` can.

## Tell the other sides

- **Legacy integration client (the wt handoff):**
  - split the pickup text into `pickup_time`, `pickup_time_end`, `pickup_at_pier` (and join to show);
  - the approval card reads `approvals[].days[].licensed_free`;
  - log in with `POST /v1/login`; Users screen on `/v1/users`, delete becomes `disabled: true`,
    an `act-approve` tick box; show a `403` on approve/reject as it is.
  - send the `version` it read as `If-Match` on every booking and seat-lock save, and show a
    `409 stale_version` as "someone changed this; reload".
  - the agent's season table reads and saves `GET/PUT /v1/agents/{id}/rate-seasons`, and prices can
    use `GET /v1/agents/{id}/rate-type?date=` instead of computing it.
  - day-of-operations now lives here, read from every booking's `trips[].operations`: boat, van parts,
    check-ins, pier note, route upgrade; and `reconfirm`, `alt_pickups`, `upgrades` on the booking.
    Its screens write through `PATCH /operations/trip-ops/{trip}`, the check-in, van-group, van-stop
    and vans endpoints, `PUT /v1/bookings/{id}/reconfirm`, `POST /v1/reconfirm/sent` and
    `POST /v1/bookings/{id}/upgrade` (README → "Dispatch" to "Upgrades").
  - removing or shrinking a boat with bookings on it answers `409 seats_sold`: its confirm dialog
    resends with `remove_anyway: true`. Past dates are refused unless the login is an admin.
  - the ops board's re-confirm buttons send `via: list|phone`; its clear sends `?all=true`.
  - files upload to `POST /v1/attachments` (not `/api/attach`); bookings carry `attachments`,
    upgrades `slips`, `allergy_list`, `doc_check` (its screen writes `/doc-check/…`); the pier's meal
    editor saves through `PUT /v1/bookings/{id}/meals`; the Pickup time setup screen through
    `/v1/pickup-areas` and `/v1/pickup-time-profiles`. A booking's pickup area must be in the catalogue.
  - live updates: stop reloading the whole state on a version bump; follow `GET /v1/changes/stream`
    (fetch-based, Bearer header) and refetch only the records and `route_days` it names.
  - the booking screen shows `POST /v1/quote`'s price instead of computing it (`bkV2CalcQuote`): the
    server now prices every non-B2C booking on save and replaces a sent price (`price_warnings`). Its
    "use today's rate" button sends `rate: "agent"`; it sends `ovnCharge` and the charter price fields.
  - sales editing (once `feat/sales-editing` is deployed): the Agent List, agent detail, Contract
    Templates, Team & Markets, Add-on Services and Insurance screens save on the API and stop writing
    `sb_agents`, `sb_markets`, `sb_sales`, `contract_templates`, `agent_artifacts`, `sb_nationalities`
    and `insurance_overrides` (handoff §6.5–6.6). Salespeople and markets need the `config` area now.
  - accounting (once 045 is deployed): the Accounting screen and Daily PFM payments read and write
    `/v1/invoices` (issue, `PATCH` header and WHT, `PUT …/discounts`, `/void`, `/payments`,
    `/payment-corrections`) and `GET /v1/payments`. A booking's `invoice` and `payment_state` replace
    its `invoiceId` and `paymentStatus`; the agent's credit is `GET /v1/agents/{id}` → `credit`.
    Cancel and restore now issue and void the fee invoice on the server: stop calling
    `acctCreateFeeInvoice` and `acctVoidInvoice` from the booking screen. Show `409 overpayment` as
    legacy's "Save anyway?" and resend with `overpay_anyway: true`.
  - van job orders (once 080 is deployed, `feat/van-job-orders`): the Van Job Orders page reads
    `GET /operations/van-jobs?date=` and `/operations/van-jobs/{date}/{key}` instead of building the
    sheets; the sent tick is `PUT`/`DELETE …/{key}/sent` (not `sent_at` on the van day, now `400`);
    the special request is the booking's `job_note` and every screen prints `special_request`; Thai
    names save to `/operations/pickup-names-th`; the group drag saves to
    `PUT /operations/van-groups/order` (handoff §3.4b).
  - weather (once 060–061 are deployed): the Boat Operation "Cancel trip (weather)" dialog, the
    weather panel and the inline manifest column read and write `/v1/weather-closures` (close, note,
    notify, undo with `undo_anyway`); "Resolve" calls `/reschedule` (`reason: "weather"`) or
    `/cancel-weather` with `outcome`; the server moves the trips and takes only that booking's share
    off its invoice. Stop tagging on panel open, `bk.refund` and the weather `acctCreateDeposit`.
    "Deposit held" is `GET /v1/agents/{id}` → `credit_balance`; "Use deposit" is a payment with
    `method: "credit"` (handoff §2.8).
- **Legacy integration client, fleet part A (once 130 is deployed, handoff §3.15, §3.13):** the
  Asset, Incident and Maintenance screens and the job board save to `/v1/fleet/…` and stop writing
  `FL_ENGINES`, `FL_GEARBOXES`, `FL_PROPELLERS`, `FL_INCIDENTS`, `FL_MAINT`; boat status reads
  `status_effective` / `GET /v1/fleet/availability` instead of `boatEffStatus`; Boat Operation answers
  `409 boat_not_ready` with `deploy_anyway: true`; the Boat Status plan-ahead confirm resends
  `plan_ahead: true`. They keep numbering `INC-`/`MJ-` themselves (`next_no` helps).
- **Legacy integration client, seat locks (`feat/seat-lock-extras`, handoff §6.1):** save bulk
  locks to `/v1/seat-lock-groups` (not N day locks), sub-groups, pending seats (`409 seats_short` →
  the "ที่นั่งว่างไม่พอ" dialog, resend with `pending`), expiry and reason; office holds as
  `holder_type: "office"`, never a typed name; read `held_pax`, `remaining_pax`, `pending_pax`,
  `state`, `overdue` and the log from the API and stop the browser expiry sweep and the lock log.
  `pax` is what was asked; legacy's `qty` is `pax − released_pax`.
- **Love Kingdom:** log in as the service user (the old test login stops); availability may use the
  `X-Api-Key` it already has (`docs/love-kingdom-integration.md` §2). Must send `If-Match` on amend
  and cancel: without it they are `428 version_required` once `feat/if-match-required` is deployed.
  Once `feat/b2c-push` is deployed (integration doc §6a, §6b, §7):
  - push every order with boat items to `POST /v1/bookings` (legacy's pull is not ported), and
    back-fill the open orders made before go-live; tell you when the back-fill is done;
  - treat `202 held_for_review` as "not booked yet" (bad input is held for ops, no longer a `400`,
    CS's saves included) and show its `message`; read `issues` on create and amend;
  - alert on its own failed calls, and reconcile with `GET /v1/bookings?updated_since=`.
- **Ops (B2C):** Love Kingdom's held orders and the B2C issues list are `GET /v1/b2c/issues`
  (legacy's orange panel); they resolve or dismiss held orders there. The legacy client's panel
  should read it instead of `/api/b2c/health`.

## Switch the import off legacy's B2C bookings (after `feat/b2c-push`)

The import copies legacy's `b2c_…` bookings until told otherwise (`--b2c=all`, the default). A copy of
an order Love Kingdom also pushed holds its seats twice; an order skipped before Love Kingdom pushed
it is missing here. So, in this order:

1. **The day Love Kingdom's push goes live:** run every import with `--b2c=pushed` (skips the orders
   pushed here, still copies the rest).
2. **Once Love Kingdom says its back-fill is done:** check nothing is left only in legacy:
   `SELECT id FROM bookings WHERE id LIKE 'lg_b2c_%' AND split_part(substr(id, 8), '_', 1) NOT IN (SELECT external_id FROM bookings WHERE external_id IS NOT NULL AND id NOT LIKE 'lg_%')`
   should list only past or cancelled orders. Then run imports with `--b2c=none`.
  - the catalogue (once 070 is deployed): Programs, the boat form, Boat Status and the day-seats
    dialog save to `/v1/routes`, `/v1/route-families`, `/v1/boats` and
    `/v1/boats/{id}/capacity-overrides/{date}` (handoff §3.14); a boat edit that cuts seats below
    placed passengers answers `409 seats_sold`: resend with `capacity_anyway: true`.
- **Love Kingdom:** log in as the service user (the old test login stops); availability may use the
  `X-Api-Key` it already has (`docs/love-kingdom-integration.md` §2). Must send `If-Match` on amend
  and cancel: without it they are `428 version_required` once `feat/if-match-required` is deployed.
  New products' routes are created with `POST /v1/routes` instead of legacy's `/api/b2c/routes`
  (§3b): read `route.id`; `pricing` is no longer part of it (ops price routes in rate types).

## Ask ops

- **The 2027 route calendars.** Five Panwa routes close to bookings on 2027-01-01
  (`route-season-calendars-expire.md`).
- **A sea route with no boat yet:** what limit do they want on such days? Legacy uses a fake boat
  ("Boat for Allotment Set") for it (`catalogue-editing-model.md` 12).
- **B2C orphans:** cancel the 6 bookings of deleted Love Kingdom orders (2 in the future hold seats)
  and the 3 test bookings in legacy (`b2c-sync-model.md` 7).
- **Fleet projects PRJ-001…007:** copies or real? (`fleet-maintenance-model.md` 10)
- **Fleet stock:** 18 duplicate items to merge (`POST /v1/fleet/stock-items/{id}/merge`), and 7
  stock lines whose history did not add up (item i25 most of all: 44 between Tub Lamu and Panwa),
  from the `import:fleet-stock` report. Legacy's 7 cancelled memos have no reason (it was never kept).

## Ask sales

- **Re-enter the agents' rate seasons** once the season screen saves to this API: legacy kept them
  only in browsers, so none came across.
- **The add-on catalogue** is built (`/v1/addon-services`) and empty: what should it list, and with
  which prices? Legacy never saved one (`sales-editing-model.md` 10).
- **Agent codes:** 21 codes are shared by 2–3 agents (import report, "agent data to check"). Rename
  them, then the unique constraint can go in.
- **Templates:** two share code `CT-06`, and 8 are named "Template ใหม่": rename them.

## Housekeeping

- Docker Desktop is stopped; tests ran on the native PostgreSQL 18 (port 5433).
- Not committed anywhere: `docs/performance/` and the `todo-status` and `railway-deploy-triage`
  skills under `.claude/skills/`. Commit or delete them.
- Unmerged branches to merge or delete: `feat/bulk-seat-locks` (superseded by `feat/seat-lock-extras`: delete it), `chore/load-testing`,
  `chore/docker-legacy`, `docs/cleanup` (already in `main` by other commits),
  `docs/login-decisions` (already in `main` through `feat/login`).
