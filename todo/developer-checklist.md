# Your to-do list

What only you can do: decisions, pushes, Railway, the other repos. Tick by deleting the line.

## Deploy what is on `main`

1. **Push `main`** again: deploying applies migrations 039–044 (add-on checks, attachments,
   allergies, document check, pickup areas, the change feed). Once `feat/invoices` is merged, 045
   (invoices and payments), 046 (who raised a boat's day capacity) and 047 (whole-boat holds) come
   with it.
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
1c. **After that import,** validate the booking area keys on Railway:
   `ALTER TABLE bookings VALIDATE CONSTRAINT bookings_pickup_area_fk; ALTER TABLE bookings VALIDATE CONSTRAINT bookings_dropoff_area_fk;`
2. **Railway variables:** remove `OIDC_ISSUER`, `OIDC_AUDIENCE`, `AUTH_PASSWORD_USERS`; keep
   `AUTH_JWT_SECRET` and `AUTH_REQUIRED=true`; set `B2C_API_KEY` to legacy's value.
3. **Import the users — nobody can log in until you do:**
   `SOURCE_DATABASE_URL=<legacy> TARGET_DATABASE_URL=<railway> npm run import:users -- --commit`,
   after the agents import (so the sales staff's `sales_id` connects). Rerun until cutover.
3b. **Import the contracts:** `npm run import:contracts -- --commit` against Railway, after
   `sync:routes` and the agents and rate types imports. Rerun until cutover.
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
- **Love Kingdom:** log in as the service user (the old test login stops); availability may use the
  `X-Api-Key` it already has (`docs/love-kingdom-integration.md` §2). Must send `If-Match` on amend
  and cancel: without it they are `428 version_required` once `feat/if-match-required` is deployed.

## Ask ops

- **The 2027 route calendars.** Five Panwa routes close to bookings on 2027-01-01
  (`route-season-calendars-expire.md`).
- **A sea route with no boat yet:** what limit do they want on such days? Legacy uses a fake boat
  ("Boat for Allotment Set") for it (`catalogue-editing-model.md` 12).
- **B2C orphans:** cancel the 6 bookings of deleted Love Kingdom orders (2 in the future hold seats)
  and the 3 test bookings in legacy (`b2c-sync-model.md` 7).
- **Fleet projects PRJ-001…007:** copies or real? (`fleet-maintenance-model.md` 10)

## Ask sales

- **Re-enter the agents' rate seasons** once the season screen saves to this API: legacy kept them
  only in browsers, so none came across.
- **The add-on catalogue** you asked for: what should it list, and with which prices? Legacy never
  saved one (`sales-editing-model.md` 10).

## Housekeeping

- Docker Desktop is stopped; tests ran on the native PostgreSQL 18 (port 5433).
- Not committed anywhere: `docs/performance/` and the `todo-status` and `railway-deploy-triage`
  skills under `.claude/skills/`. Commit or delete them.
- Unmerged branches to merge or delete: `feat/bulk-seat-locks`, `chore/load-testing`,
  `chore/docker-legacy`, `docs/cleanup` (already in `main` by other commits),
  `docs/login-decisions` (already in `main` through `feat/login`).
