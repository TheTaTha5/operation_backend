# Your to-do list

What only you can do: decisions, pushes, Railway, the other repos. Tick by deleting the line.

## Deploy what is on `main`

Rehearsed end to end on 2026-10-10. The rehearsal ran on a copy of a full legacy import that was at
migration 048, as a deployed database would be. Each step below matched:
- **Migrations:** all 18 new ones (060–143) applied with no failure, and no booking, lock, agent,
  invoice or payment changed.
- **Re-import:** a second run left every count the same.
- **The API:** one read per area answered `200`.

Run the steps in this order against Railway, with `SOURCE_DATABASE_URL=<legacy>` and
`TARGET_DATABASE_URL=<railway>`. Every tool is a dry run without `--commit`.

1. **Rehearse the destructive migrations on a restored copy of Railway first** (CLAUDE.md). The
   local rehearsal used a copy of the import, not Railway's own data:
   - 070 drops the `capacity <= license_pax` check;
   - 080 drops `van_days.sent_at` (each mark moves onto that van's groups);
   - 048 turns a lock naming no agent into an office lock.
2. **Push `main`.** Deploying applies migrations 039–180 (`preDeployCommand`).
3. **Copy the files:** `npm run import:attachments -- --commit` (about 6,000 files, about 660 MB, about
   18 min; re-runnable). Run it before the imports, so slips, documents and project photos link.
4. **Seed the catalogue once:** `npm run seed:routes -- --commit`, then `npm run seed:boats -- --commit`.
   - Rehearsal: 58 routes (44 new) and 22 boats (5 new charter boats, 17 filled with their form,
     documents and status log).
   - It also brings the stand-in "Boat for Allotment Set": see "Ask ops".
   - From then on routes and boats are edited here, and legacy's `save('config')` must stop writing
     them.
5. **The main import:** `npx tsx src/tools/import-legacy.ts --commit --sales`.
   - Add `--rate-types` if Railway has no rate types yet (`SELECT count(*) FROM rate_types`).
   - `--sales` is needed the first time only: from then on agents, markets, salespeople, templates,
     documents, staff and their quotas, sales targets and follow-up marks are edited here. Legacy must
     stop editing them at the same moment (Staff & Welfare and the Sales Board's target and ticks too).
     Rehearsal: 24 staff with their 2026 quotas (58 seats), 0 targets, 1 follow-up mark.
   - Rehearsal: 5,377 bookings, 1,455 seat locks, 473 invoices, 5 weather closures, 158 pier
     payments, 143 cash-on-tour decisions, 26 van bills, 453 van-job sent marks and 836 agents.
6. **Fleet:** `npm run import:fleet -- --commit`, then `npm run import:fleet-stock -- --commit`.
   - Rehearsal: 54 engines, 122 jobs, 6 pier assignments (1 cancelled; migration 190), 616 stock
     items, 226 memos and 21 projects; every item's stock equals legacy's.
   - Legacy must also stop writing pier assignments, certificate renewals, `repairHistory` and the
     fuel budget (`fleet-maintenance-model.md` "Open (extras)" 2).
   - Legacy must stop editing assets, incidents, jobs, stock, memos, projects and the Daily Log at
     the same moment.
6b. **Pier office:** `npm run import:pier-office -- --commit`, after step 4 (the sheets name boats).
   - Rehearsal (2026-10-10, on a fresh import): petty cash Panwa 38 in ฿169,828 and 114 out
     ฿159,728, Tub Lamu 1 out ฿1,800; 54 longtail cells ฿190,000; 61 park cells ฿661,280 + ฿10,500
     dock fees; the company name; 6 kinds, 41 items, 13 codes, 5 groups, 72 staff, 2 licence types,
     4 classes; nothing skipped. Panwa's balance on 2026-10-09 reads ฿10,100, as legacy's. A re-run
     left every count the same.
   - Legacy must stop writing petty cash and the seven lists at the same moment (§6.8 of the handoff).
7. **Validate the booking area keys:**
   `ALTER TABLE bookings VALIDATE CONSTRAINT bookings_pickup_area_fk; ALTER TABLE bookings VALIDATE CONSTRAINT bookings_dropoff_area_fk;`
8. **Check:** `npm run verify:import`. Expected differences:
   - 22 bookings: the 9 B2C test orders (`b2c_BK-…`), which are skipped on purpose, and 13 B2C
     lines that name no route. These also explain 3 small seat and monthly total differences.
   - A rate type created in legacy after the rate types cutover. The rehearsal found one,
     `rtmv0s9674w9j90`: re-create it here, and stop making rate types in legacy.
   - "Legacy columns no import reads": informational.
9. **Re-import until each area moves:** step 5 without `--sales`, and step 6. A re-run changes
   nothing that was not changed in legacy; rehearsed, every count was identical. Re-runs also replace
   what was recorded here on legacy's records for:
   - pier payments, on-tour sales and the cash-on-tour and no-show decisions;
   - the fleet records;
   - van rates and the daily report settings;
   - the pier office (step 6b): its lists whole, legacy's petty cash rows and every sheet cell.

   So decide when legacy stops writing each of these (`money-model.md`, `fleet-maintenance-model.md`).
10. **Railway variables:**
    - remove `OIDC_ISSUER`, `OIDC_AUDIENCE` and `AUTH_PASSWORD_USERS`;
    - keep `AUTH_JWT_SECRET` and `AUTH_REQUIRED=true`;
    - set `B2C_API_KEY` to legacy's value.
11. **Import the users. Nobody can log in until you do:** `npm run import:users -- --commit`, after
    step 5, so the sales staff's `sales_id` connects. Re-run it until cutover.
12. **Import the contracts once:** `npm run import:contracts -- --seed --commit`, after steps 4 and 5.
    - Without `--seed` it writes nothing (contracts are this API's now). Re-running `--seed` would
      overwrite a main contract's rate and `doc_id`, and a promo, set here.
    - Rehearsal (2026-10-10, throwaway import): 918 contracts, 3,242 periods, 16 own prices; one
      skipped (`ct_main_amrsvysas2dymj`, its agent is gone).
    - Legacy's promo form (`ctSaveAddPromo`, `ctVoidContract`) must stop saving at the same moment.
13. **Create Love Kingdom's service user:** `POST /v1/users` with `agent_id: "a_b2c"` and
    `edit_areas: ["operations"]`. Send them the username and password.
14. **Give `act-approve`** to the staff who approve over the allotment and FOC
    (`PATCH /v1/users/{id}`). Until then only `admin` and `Tata` can. Give `act-capunlock` to whoever
    may raise a boat's seats for a day.

## Tell the other sides

- **Legacy integration client.** The details are in `docs/handoff/legacy-integration-booking-api.md`.
  - **Bookings and day-of-operations:**
    - **Pickup:** split the pickup text into `pickup_time`, `pickup_time_end` and `pickup_at_pier`,
      and join them to show.
    - **Approvals:** the approval card reads `approvals[].days[].licensed_free`.
    - **Login:** log in with `POST /v1/login`. The Users screen moves to `/v1/users`, delete becomes
      `disabled: true`, and an `act-approve` tick box is added. Show a `403` on approve or reject as
      it is.
    - **Versions:** send the `version` it read as `If-Match` on every booking and seat-lock save (`428`
      without). Show `409 stale_version` as "someone changed this; reload".
    - **Prices:** the booking screen shows `POST /v1/quote`'s price. The server prices every non-B2C
      booking and replaces a price sent (`price_warnings`). "Use today's rate" sends `rate: "agent"`.
    - **Day-of-operations:** read it from `trips[].operations`. Write it through:
      - `PATCH /operations/trip-ops/{trip}`;
      - the check-in, van-group, van-stop and vans endpoints;
      - reconfirm and upgrade.
    - **Boat assignment:**
      - Over capacity + 2 is `409 boat_full`; resend with `raise_capacity: { reason }`, which needs
        `act-capunlock`.
      - A boat under repair is `409 boat_not_ready`; resend with `deploy_anyway: true`.
    - **Deployments:** removing or shrinking a boat with bookings on it is `409 seats_sold`; resend
      with `remove_anyway: true`.
    - **Files:** upload to `POST /v1/attachments`. Show them by fetching with the Bearer header and
      using a blob URL.
    - **Live updates:** follow `GET /v1/changes/stream` and refetch only what it names.
    - **Agent seasons:** the season table reads and saves `GET/PUT /v1/agents/{id}/rate-seasons`.
    - **Smaller screens:**
      - the pier's meal editor saves through `PUT /v1/bookings/{id}/meals`;
      - Doc Check through `/doc-check/…`;
      - Pickup time setup through `/v1/pickup-areas` and `/v1/pickup-time-profiles`;
      - the ops board's re-confirm sends `via: list|phone`, and its clear sends `?all=true`.
  - **Areas that moved today** (each with its handoff section):
    - seat locks (§6.1: bulk groups, sub-groups, pending seats, holder types, the log; whole-boat
      holds: the Hold-whole-boat form, its boat list, release and "เหมาลำ" convert, and Boat
      Operation's `409 boat_held`);
    - weather (§2.8);
    - invoices (§2.7);
    - Daily PFM, pier money, on-tour sales and after-trip decisions (§2.10; an upgrade's "collected"
      is `POST …/upgrades/{id}/collect`);
    - van bills and reports (§2.9);
    - van job orders (§3.4b: the sent tick is a command, and `sent_at` on van days is now `400`);
    - the catalogue (§3.14: Programs, the boat form, Boat Status and day seats; `409 seats_sold`,
      resend with `capacity_anyway`);
    - sales (§6.5–6.6: agents, templates, Team & Markets, add-ons, insurance);
    - fleet (§3.13, §3.15, §6.7);
    - the pier office: petty cash, its sheets and certificate, and the office lists (§6.8; a deleted
      petty cash row is kept, out of the totals; `n` and a code's `bg` are the server's).

    Each screen stops writing legacy's blob for its area.
  - **Legacy sync per area** (decided): keep saving to legacy only the areas that have not moved.
    The `LA_LEGACY_SYNC` switch has to become per area.
- **Love Kingdom.** The details are in `docs/love-kingdom-integration.md`.
  - **Login:** log in as the service user; the old test login stops. Availability may keep using the
    `X-Api-Key`.
  - **Versions:** send `If-Match` on amend and cancel (`428` without).
  - **Push:** push every order with boat items to `POST /v1/bookings`, and back-fill the open orders
    made before go-live. Tell you when the back-fill is done.
  - **Held orders:** treat `202 held_for_review` as "not booked yet": bad input, CS's saves included,
    is held for ops. Read `issues` on create and amend.
  - **Payment state:** send the four payment fields on every create and update
    (`payment_paid`, `payment_paid_status`, `payment_deposit`, `payment_balance`), or the pier
    collects a stale balance.
  - **New routes:** create them with `POST /v1/routes`, not `/api/b2c/routes`. `pricing` is no
    longer part of it.
  - **Monitoring:** alert on its own failed calls, and reconcile with
    `GET /v1/bookings?updated_since=`.
- **Ops (B2C):** held orders and the issues list are `GET /v1/b2c/issues`, legacy's orange panel.
  They resolve or dismiss held orders there.

## Switch the import off legacy's B2C bookings (after Love Kingdom's push is live)

The import copies legacy's `b2c_…` bookings until told otherwise (`--b2c=all`, the default). Two
things can go wrong:
- **Too late:** a copy of an order Love Kingdom also pushed holds its seats twice.
- **Too early:** an order skipped before Love Kingdom pushed it is missing here.

So, in this order:

1. **The day Love Kingdom's push goes live:** run every import with `--b2c=pushed`. It skips the
   orders already pushed here and still copies the rest.
2. **Once Love Kingdom says its back-fill is done:** check that nothing is left only in legacy. This
   should list only past or cancelled orders:
   `SELECT id FROM bookings WHERE id LIKE 'lg_b2c_%' AND split_part(substr(id, 8), '_', 1) NOT IN (SELECT external_id FROM bookings WHERE external_id IS NOT NULL AND id NOT LIKE 'lg_%')`

   Then run imports with `--b2c=none`.

## Ask ops

- **The 2027 route calendars.** Five Panwa routes close to bookings on 2027-01-01
  (`route-season-calendars-expire.md`).
- **A sea route with no boat yet:** what limit do they want on such days? Legacy uses a fake boat
  ("Boat for Allotment Set") for it (`catalogue-editing-model.md` 12).
- **B2C orphans:** cancel the 6 bookings of deleted Love Kingdom orders (2 in the future hold seats)
  and the 3 test bookings in legacy (`b2c-sync-model.md` 7).
- **Fleet projects PRJ-001…007:** copies or real? (`fleet-maintenance-model.md` 10)
- **Whole-boat holds:** a hold's "เหมาลำ" now refuses a quote and a booking without the held boat's
  charter (legacy saved it and left the hold); a boat not yet on the route no longer counts as
  taking seats from it (`seat-lock-extras-model.md`, "Flagged"). Confirm with ops.
- **Fleet Insights and the Fleet Report:** which cost, date and "service due" rule should they use?
  Legacy's screens use five and three different ones (`fleet-maintenance-model.md` "Open (extras)" 1).
- **Money slices 2–4** (`money-model.md`, "Flagged"): who hands the pier's cash over and per which
  pier; whether pier staff may sell on-tour extras (legacy: operations only); what accounts do with an
  invoice left overpaid by a cash-on-tour deduction.
- **Pier office** (`pier-office-model.md`): which part of the rest comes next: the sheets' booked side
  (expected park fees need the cost plans), the roster and pay, stock moves and sign-out sheets, or
  licences.
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
- **Rate types are edited here now:** stop creating them in legacy. `rtmv0s9674w9j90`, made in legacy
  after the cutover, needs re-creating here.
- **Templates:** two share code `CT-06`, and 8 are named "Template ใหม่": rename them.

## Housekeeping

- Docker Desktop is stopped; tests ran on the native PostgreSQL 18 (port 5433).
- Not committed anywhere: `docs/performance/` and the `todo-status` and `railway-deploy-triage`
  skills under `.claude/skills/`. Commit or delete them.
- Unmerged branches to merge or delete: `feat/bulk-seat-locks` (superseded by `feat/seat-lock-extras`: delete it), `chore/load-testing`,
  `chore/docker-legacy`, `docs/cleanup` (already in `main` by other commits),
  `docs/login-decisions` (already in `main` through `feat/login`).
