# Legacy's browser rules: what this API owns, and what is left

Legacy can be switched off only when every decision its browser makes has a home here
(`CLAUDE.md` → Goal). `legacy-replacement.md` lists the **data** still to give a home; this lists the
**rules**: every refusal, warning, computed value, automatic change, permission check, numbering
scheme and load-time sweep in legacy's browser code, and whether this API owns it.

- **Source:** wt-lk-inbox @ `658298d` (2026-10-06), `allotment_v2/js/*.js`, `BACKUP/` ignored. Read on
  2026-10-10 by nine parallel readers, one file range each, then cross-checked. Checked against
  `README.md`, `todo/*.md` and `src/domain/*.ts` on `main` @ `12b0129`.
- **Files:** `app` = `08-app.js`, `core` = `04-data-core.js`, `fleet` = `05-fleet.js`,
  `eng` = `06-engine-assign.js`, `charter` = `07-charter.js`, `auth` = `01-auth-sync.js`,
  `ab` = `09-action-board.js`, `embed` = `10-embed.js`. Functions are named, not line numbers:
  `grep -n 'function <name>' allotment_v2/js/*.js` finds them.
- **Status:**
  - **built**: this API decides it. The endpoint or domain function is named.
  - **built differently**: this API decides it, but not the way legacy does. The row says how,
    and whether a note records the difference ("not flagged" when none does).
  - **decided not to copy**: a note or `README.md` says so (cited).
  - **missing**: no home yet, *or* the data has a home but the rule is not enforced or computed
    here. `missing?` means the reader could not settle it; the row says what was checked.
- **Impact** (missing rows only): `[money]` changes an amount priced, owed or paid; `[seats]` changes
  who gets a seat or how many are sold; `[ops]` changes day-of-operations data; `[data]` data quality
  or consistency; `[ux]` a warning, a convenience or a dashboard figure.
- Pure display (labels, colours, print layout) is left out. A computed figure a screen shows as
  fact (a KPI, a dashboard count) is kept, tagged `[ux]`.

## Summary

823 rules. **492 are owned here** (305 as legacy, 187 differently), 23 were decided against, and
**308 are missing**: 11 change seats, 62 change money, 68 the day's operations, 75 data quality, and
92 are warnings, conveniences or dashboard figures.

| Area | Built | Built differently | Decided not to copy | Missing |
|---|---:|---:|---:|---:|
| Bookings | 18 | 20 | 0 | 36 |
| Pricing | 15 | 12 | 0 | 12 |
| Seat locks | 11 | 8 | 1 | 4 |
| Availability and capacity | 12 | 4 | 1 | 13 |
| Deployments and boats | 15 | 13 | 0 | 17 |
| Charters | 4 | 7 | 0 | 3 |
| Vans and dispatch | 38 | 16 | 1 | 9 |
| Check-in and pier | 9 | 6 | 1 | 35 |
| Check-in and pier: Pier Office, park tickets, roster, licences, job sheet | 0 | 1 | 0 | 48 |
| Reconfirm | 4 | 2 | 0 | 1 |
| Upgrades and add-ons | 8 | 4 | 1 | 2 |
| Weather | 3 | 4 | 0 | 0 |
| Money: invoices and payments | 13 | 2 | 0 | 3 |
| Money: PFM | 5 | 7 | 1 | 1 |
| Money: pier money | 13 | 2 | 0 | 10 |
| Money: cash on tour and after the trip | 5 | 2 | 0 | 1 |
| Money: van bills | 9 | 3 | 1 | 0 |
| Money: reports | 7 | 3 | 0 | 16 |
| Money: costing (waits for Fleet) | 0 | 0 | 1 | 28 |
| Sales, agents and contracts | 26 | 11 | 1 | 20 |
| Catalogue | 15 | 11 | 1 | 3 |
| Fleet | 61 | 36 | 4 | 38 |
| Users and permissions | 12 | 7 | 5 | 3 |
| B2C sync | 1 | 2 | 2 | 2 |
| Misc | 1 | 4 | 2 | 3 |
| **Total** | **305** | **187** | **23** | **308** |

A row is one rule; the same check repeated in several functions is one row. Counts come from the
tables below (`missing?` counted as missing).

## Findings to settle first

Things the inventory turned up that are not just "build X".

1. **The Pier area has no home and is not on any list.** Pier Office (gear stock, issue sheets,
   laundry, deposits), park tickets, pier petty cash (`po_cash_*`), the staff roster and trip
   allowance pay, crew licences, the daily boat job sheet, guide orders and the PR/PO meal forecast
   are stored in legacy's `pier_*`, `po_cash_*`, `go_*` and `trip_actuals` keys. No endpoint,
   migration or todo note covers them, and `legacy-replacement.md` does not list them. Only
   `fleet-maintenance-model.md` ("licences belong to Pier") and `money-model.md` ("pier petty cash
   belongs with pier operations") mention any of it. The `pier` edit area exists but guards only
   check-in and pier money.
2. **`README.md` is wrong about legacy's reschedule fee.** It says "Legacy left this fee unbilled".
   `bkV2RescheduleBooking` (app) adds the fee as a line onto the booking's existing invoice and
   raises its subtotal, net and total ("Booking already invoiced → top up that same invoice"). This
   API issues a separate fee invoice instead, which is a reasonable choice, but the README line
   should say so.
3. **`deployment-guards-model.md` Open 1 is stale.** It says seat locks are per route and day, so
   there is no boat hold to check. Whole-boat holds exist since migration 047, and
   `src/domain/deployment-guards.ts` still lets a held boat be moved or removed.
4. **Booking rules built differently with no note recording it.** Each needs a yes or a fix:
   - a trip whose route has no rate saves at ฿0 with a `not_offered`/`no_rate` warning; legacy
     disables Save (`bkV2NoRateTrips`, `bkV2RenderSubmitButton`);
   - `/restore` refuses (`409 charter_boat_taken`, capacity); legacy always restores and only warns;
   - chartering a boat on a day with seats sold is refused; legacy warns, stores
     `charterDisplacementAck` and lets you oversell (`bkV2ConfirmCharter`);
   - a quote holds its charter boat; legacy's quote does not;
   - the discount approval is asked alongside FOC; legacy asks it only when the save would
     otherwise be `confirmed`;
   - an edit does not re-ask FOC or discount approval (`reweigh` weighs over-allotment only); legacy
     re-runs the whole save. The discount part is only in a code comment in `booking-approvals.ts`;
   - `PATCH` refuses a cancelled, completed, rejected or weather-cancelled booking
     (`409 booking_closed`); legacy asks "Edit anyway?" and lets a weather-cancelled one through;
   - Save Draft turning a confirmed booking back into a quote has no command;
   - booking ids are `booking_<uuid>`, not legacy's `BK-YYMMNNNN-XXXX`.
5. **Other unflagged differences:** a PFM invoice can be voided with payments on it (legacy's PFM
   screen refuses, Accounting does not); an upgrade's card fee may be up to 100% (on-tour sales are
   capped at 5%, as legacy caps both); the pier note writes no history line and a `pier`-only login
   cannot set it; reconfirm needs `operations` (legacy also `accounting`); a pickup-time profile
   overlapping another is not warned about; several fleet ones (see Fleet, "not flagged").
6. **Two legacy oddities to ask ops about:** `flLoad`'s one-time fleet hooks are guarded only by
   `_app_hooks` in each browser's `localStorage`, so a fresh browser may re-run them (one
   bulk-approves pending memos; unverified). And `getSeatsConsumed` takes van and pier no-shows off
   seats sold, so a no-show's seat is sold again on the day; confirm that is wanted before copying.

## Missing: the list to build before legacy can be switched off

Ranked by impact: seats and money first, then the day's operations, then data quality. Dashboard
figures and conveniences (`[ux]`) come last and are grouped. Each item names the area table that
holds its rows.

### Seats

1. **A charter split over several boats takes only its `charter_boat_id` out of the pool.** Legacy
   charters every boat in `ops.boatSplits` (`baCharterBoatMap`, `baCharterBoatIds`, `_calTripsFor`).
   `capacity.ts dayCapacity` reads only `charter_boat_id`, and `dispatch.ts` accepts `boat_splits`
   on a charter trip, so the second boat's seats are still sold. (Charters)
2. **Whole-boat holds: create, edit, swap, convert to charter, and protect from deployment
   changes.** Holds come only from the import; every command but a full release is `400 boat_hold`.
   Legacy `bkV2CreateBoatLock`, `bkV2BoatLockBlockers`, `bkV2BoatLockEdit`, `bkV2BoatLockSwap`,
   `bkV2BoatLockOnConvert`, and `opLocked` in Boat Operation. (Availability/capacity,
   Deployments)
3. **Van and pier no-shows and on-site cancels free their seats** (`getSeatsConsumed` via
   `ckLostByType`, also `_abAgentSplit`). `aboard.ts lostByType` exists but capacity does not use
   it. Confirm first (Findings 6). (Availability/capacity)
4. **A Boat Operation slot typed `charter` with no booking takes the boat out of the pool**
   (`isBoatChartered`, `getCellType`). Deployments have no type here. `missing?`: check whether any
   such slots exist in legacy data. (Availability/capacity)
5. **Editing a bulk lock's range or weekdays while nothing is drawn** (`bkV2LockEditSubmit`):
   refused here, `seat-lock-extras-model.md` Open 2. (Seat locks)

### Money

6. **A partial cancel lowers the booking's total but leaves its invoice at the old total.** Legacy
   flags the invoice `needsAdjustment` with a record (`bkV2PartialCancel`). Here nothing marks or
   adjusts the invoice. (Bookings)
7. **Promo contracts cannot be written.** Create, edit, void, own-price grid, discount and
   buy-N-get-1 checks (`ctSaveAddPromo`, `ctVoidContract`) have no endpoint, yet `priceBooking`
   reads promos. Until then promos change only through the import (`contracts-model.md`).
   (Sales/agents/contracts)
8. **An upgraded trip stays priced on the route it was sold on, and the upgrade ends when the trip
   is moved** (`bkUpgActive`, `bkV2PrRoute`, `bkV2WithSold`). Here `activeUpgrade` looks only at
   `undone_at`, so moving the trip by `PATCH` leaves the upgrade in force, and a later re-price uses
   the trip's current (upgraded) route. `missing?`: confirm with a test. (Upgrades)
9. **A sold trip's check price uses the promo locked at sale, even after the promo is cancelled**
   (`laPromoRateSold`). `priceBooking` re-resolves only `active` promos, so a price-affecting edit
   re-prices without it. `missing?`. (Pricing)
10. **A private-van add-on moves that route's seat to the NoTransfer zone** so the transfer is not
    charged twice (`bkV2ToggleAddOn`). Here the zone is priced as sent. (Pricing)
11. **Manual deposits and paying from them** (`acctDepositSubmit`, `acctPayUseDeposit`,
    `acctApplyDeposit`): `money-model.md` Open 1 (`refunds.invoice_id NOT NULL`). (Money:
    invoices/payments)
12. **House-account rules:** a staff booking must name the staff member, a company booking must
    give a reason (`companyPurpose`, dropped today), `purpose` is derived, `sold_by`/`staff_id` are
    cleared when a real agent is picked, and FOC beyond a staff member's yearly welfare quota is
    warned (`bkV2CommitBooking`, `bkV2ApplyAgentRules`, `staffQuota`, `staffWelfareUsed`). Staff
    registry and quotas: `sales-editing-model.md` Open 1. (Bookings, Sales)
13. **The payment snapshot at create** (credit or prepaid, net days, contract version) is the
    client's here; pier money reads the agent's *current* pay type (`bkV2CommitBooking`
    `paymentSnapshot`). (Bookings)
14. **Pier money with no home:** the pier petty-cash book with its opening balance, park-fee and
    longtail sheets (`pc*`); gear deposits and lost-item fines (`poIsCalc`, `poCloseSave`); pier
    staff trip allowance pay (`paPayOf`, `paWsMin`). (Money: pier money, Check-in/pier: Pier
    Office)
15. **Costing, Trip P&L and meal orders** wait for Fleet (`money-model.md` Open 1): cost template
    and plans (`ct*`), Trip P&L with close/freeze (`px*`, `pxClose`), meal venues and the sent meal
    order with its cost (`mv*`, `pckMealSend`), longtail cost (`drLtRate`). (Money: costing,
    reports)
16. **Smaller money rules:** an upgrade's card fee capped at 5% (`bkV2ExtraSetPct`); an old fleet
    memo's lump-sum discount kept when re-totalled (`moLiveLegacyDisc`); a parts-free memo going
    straight to paid on receive (`flOpenReceiveMemo`); internal ฿0 bookings left out of sales totals
    (`laIsInternalFree`); a v1 booking's total re-derived on load (`sbCalcBookingTotal`, `missing?`:
    count v1 rows first); COT amount parsed from notes when `cashOnTour` is empty (`bkV2CotChip`).

### Day-of operations

17. **Booking required fields** (`bkV2CommitBooking`): agent (Save Draft too), lead name, lead and
    passenger nationalities, guide language (B2C exempt), hotel once an area is chosen, a pickup
    point to confirm (NoTransfer counts), and the soft `incomplete` flag list. None is checked here.
    (Bookings)
18. **Deployment refusals:** a boat must be at the route's pier, not on a closed day, not on a land
    route (`bop2OpenCellPopover`, `bop2AssignBoatOptsFor`, `bop2AssignRangeForm`). (Deployments)
19. **Check-in rules:** pier `expected` = booked less van losses (`pckExpected`); a no-show or
    on-site cancel needs a reason and a breakdown and cannot exceed the people left (`ckEvSave`);
    a pier count above expected must say who came on their own (`ckSelfSave`); stages in order
    (`pckStageSet`); no check-in on a cancelled booking (`ckRowHtml` §strand); the driver's
    "arrived at first pickup" stamp (`vckArrToggle`, `vck_arrive`). (Check-in/pier)
20. **A booking moved to another day keeps a struck row on the old day's van sheets, check-in boards
    and manifest** (`ckStrandSnap`, `ckStrandMovedRows`): `van-job-orders-model.md` Open 1, and the
    return sheet's no-show tags, Open 2. (Vans and dispatch)
21. **Auto-assign:** vans for a route's transfer bookings (`bkV2VanAutoAssign`) and boats for a
    route-day (`baAutoAssign`); the overnight return leg's fallback to any boat sailing that day
    (`bkV2BoatPicker` §OVN). (Vans and dispatch)
22. **The Pier Office, park tickets, roster, crew licences, job sheet, guide orders and the PR/PO
    forecast** (Findings 1): about 60 rules, all `[ops]` or `[money]`. (Check-in/pier: Pier Office)
23. **Fleet:** boat certificate status and expiry levels (`flDocStatus`, `flDocCurrent`); pier
    assignments and a boat's pier on a date (`flSaveAssignment`, `getBoatCurrentPier`); the job's
    repair location cascading to its engines (`flMaintSetRepairLoc`); swapping one engine out of a
    started job (`flMaintSwapEngine`); the Daily Log's per-boat booked and effective pax
    (`flRenderDR`, `flBoatBookingsFor`). (Fleet, Deployments)
24. **Data repairs legacy runs on every render** that this API neither prevents nor runs: an
    overnight return leg's inherited hotel time (`bkV2HealOvnLegs`, `missing?`), a self-arrive trip
    with a clock pickup time (`bkV2HealSelfArrivePickup`). (Vans and dispatch)

### Data quality

25. **Permissions and scope:** a sales-bound login's booking list is not scoped (agents are);
    sales-bound rate-type scope and admin-only rate owner (`rtScopeList`, `rtSetOwner`); passwords
    of at least 6 characters (`__laAddUser`, `__laPwChk`). (Users/permissions, Pricing)
26. **Catalogue and sales checks:** an inactive rate type can be bound to an agent or a season
    (`rtForSales`); contract status from its dates (`_ctContractStatus`); a new rate type's owner
    from the login (`rtOpenNew`); status-log `loc` from the fixed list (`fmtLoc`) and the log
    cleanup (`bsCleanupLog`); the charter-boat period's auto location (`saveCharterBoat`).
    (Catalogue, Pricing, Sales, Fleet)
27. **Fleet integrity:** engine positions limited to the boat's engine count, no two engines in one
    position, no engine taken silently from another boat (`flOpenAssignEngModal`,
    `flSaveAssignEng`); only company boats that are not retired in install, project and safety
    pickers (`flBoatsForInstall`); a job linked to a project only if scheduled and on the same boat,
    with log lines (`flMaintLinkProjectPick`); the project sweeps (`flProjResyncMJLinks`,
    `flProjAutoCreateForScheduledMJs`); the safety inspection cadence (`pmMonths`); Thai
    `spareLocation` labels mapped to keys; engine status self-heal; memo edit needs a line and is
    refused when cancelled. (Fleet)
28. **Booking data checks:** passenger list sized to the heads and lead type (`bkV2SyncPassengers`);
    FOC flags capped at the FOC count; special meals capped at the headcount (form and pier,
    `_bkV2MealRoom`, `pckMealStep`); hotel names snapped to an existing spelling and bulk merged
    (`bkV2CanonicalHotel`, `psuHotelMerge`); `marketSnapshot` frozen at create; nationality
    dedupe and merge (`bkV2CleanupNats`); real Thai heads per trip for the park fee (`t.nat`).
    (Bookings, Misc)
29. **Bulk tools with no endpoint:** the agent Excel import (`agImport*`), bulk programme fill
    (`agProgBulk*`), rate-type clone and copy (`rtClone`, `rtCopyFromRT`; `rate-types-model.md`),
    season split from the contract on expiry (`rtExpBulkPlan`), invoice header settings
    (`acctInvCfg`), custom add-on types, guide registry, the stock duplicate scan (`invDupScan`).

### Conveniences and dashboards (`[ux]`, last)

30. Dashboard, Action Board and Sales Board figures (`renderDash`, `abRender`, `renderSalesBoard`,
    `_dashBoardData`), market intelligence and sales analytics (`md*`, `pmap*`, `b2d*`), the
    cancellation report, the Ops and Fleet decks (`repOpsGather`, `repFleetGather`), fleet
    analytics (cost, fuel intelligence, insights, project hub), rate expiry scan (`rtExpScan`),
    agent health flags and contract-expiry alerts, seat-lock coverage and KPIs, Travel Summary
    scopes (pier, route, VAT) and the cancelled/moved lists, slip packs, the Daily Report's
    operations side and email settings, deployment templates, Daily Availability templates,
    user-screen helpers, System Log. Each is a computed `GET` or a client-side screen; none changes
    stored data.

---

## Bookings

| Rule | Legacy (file) | Kind | Status | Here / note |
|---|---|---|---|---|
| At least one trip with route and date, at least one passenger | `bkV2CommitBooking` (app) | refusal | built | `tripsInput` and pax parsing in `src/routes/operations.ts` |
| An agent (or B2C channel) is required, Save Draft included | `bkV2CommitBooking`, `bkV2SaveDraft` (app) | refusal | missing | `agent_id` optional on `POST /v1/bookings` [data] |
| Lead passenger name is required | `bkV2CommitBooking` (app) | refusal | missing | `lead_pax` optional [data] |
| Lead nationality required, guessed first from the name | `bkV2CommitBooking`, `bkV2GuessNationality` (app) | refusal / auto-change | missing | no check, no guess ("never guessed", README "Nationalities") [data] |
| Every named passenger needs a nationality; unnamed rows are dropped | `bkV2CommitBooking` (app) | refusal | missing | `parseBookingPassengers` needs only `name`; a blank name is `400`, not dropped [data] |
| Guide language required (B2C exempt) | `bkV2CommitBooking` (app) | refusal | missing | [ops] |
| Hotel required once a pickup area is chosen (NoTransfer exempt) | `bkV2CommitBooking` (app) | refusal | missing | [ops] |
| A pickup point is required to confirm; a quote may skip it | `bkV2CommitBooking` §pickup guard (app) | refusal | missing | `/confirm` and `intent: confirm` don't check it [ops] |
| No trip on a day its route doesn't run; B2C exempt but flagged | `bkV2CommitBooking`, `bkV2SetTripField`, `bkV2IsRouteOpenOn` (app) | refusal | built | `409 route_closed` (README "Closed days"); `PATCH` checks only trips it adds or moves |
| Soft-missing data asks once, then saves an `incomplete` flag list | `bkV2CommitBooking` `_missSoft` (app) | warning / auto-change | missing | no `incomplete` on bookings [data] |
| Possible duplicate: same voucher, or same lead name on a shared route and date | `bkV2FindDuplicateBookings`, `bkV2VoucherDupHtml` (app) | warning | built differently | `GET /v1/bookings?voucher_ref=` only; the name match is missing [ux] |
| Self-arrive ticked while a hotel is entered: asks | `bkV2CommitBooking` (app) | warning | missing | [ux] |
| Save Draft on a live booking turns it back into a quote | `bkV2SaveDraft` (app) | warning / auto-change | built differently | no command does it; `PATCH` can't change status. Not flagged |
| Status from the button and the facts: quote, confirmed, pending_foc, pending_approval | `bkV2SubmitBooking`, `bkV2CommitBooking` (app) | computed | built | `decideStatus` (`booking-approvals.ts`), README "intent" |
| Discount approval asked only when the save would otherwise be confirmed | `bkV2CommitBooking` (app) | computed | built differently | asked on any confirm intent, FOC included. Not flagged |
| An edit re-runs FOC and discount approval (an approved FOC stays confirmed) | `bkV2SubmitBooking`, `bkV2CommitBooking` (app) | auto-change | built differently | `PATCH` re-weighs over-allotment only; discount noted in a code comment, FOC nowhere |
| FOC passengers need a reason to confirm | `bkV2SubmitBooking` (app) | refusal | built | `400 foc_reason is required` |
| Approval record: reason, days over, discount, target status, requester; kept once decided | `bkV2CommitBooking` (app) | computed | built | `approvals[]` (README "Approving") |
| A pending_approval booking with no record gets one made up | `bkV2EnsureApproval`, `bkV2PendReason` (app) | auto-change | built | import makes a decided entry; reasons `closed_day`/`b2c_hold` kept |
| On load, an FOC-approved booking still pending is flipped to confirmed | FOC reconcile IIFE (app) | sweep | built differently | no sweep; status moves only by command, so the state cannot arise here. Imported stuck rows: count them |
| Approve asks again over the licence; approver typed; `confirmedBy` stamped | `bkV2ApproveBooking`, `bkV2ApprovalImpact` (app) | warning / permission | built differently | `/approve`: approver is the login; over-licence a warning (README "Approving") |
| FOC approve/reject only when pending; reason required | `bkV2FocApprove`, `bkV2FocReject` (app) | refusal | built | `/approve`, `/reject` |
| Reject: approver plus optional note → rejected | `bkV2RejectBooking` (app) | auto-change | built | `/reject` with `note` |
| `createdBy` typed, `confirmedBy` editable | `bkV2NewBooking`, `bkV2CommitBooking` (app) | computed | built differently | always the login (README "History and who made a change") |
| `bookedAt` stamped once; `bookingDate` defaults to today | `bkV2CommitBooking` (app) | computed | built differently | `booked_at` server-set; `booking_date` a client fact with no default [data] |
| `marketSnapshot` from the agent at create, kept on edits | `bkV2CommitBooking` (app) | computed | missing | stored as sent (`booking-header.ts`) [data] |
| `paymentSnapshot` from the agent's contract at create; B2C keeps its own | `bkV2CommitBooking` (app) | computed | missing | client fact; pier money reads the agent's current pay type (`pier-money.ts`) [money] |
| `purpose` derived: staff_welfare, staff_inspection, company reason, sale | `bkV2CommitBooking` (app) | computed | missing | client fact, not checked against the 5 values [data] |
| A booking is internal (`purpose`, `staffId`, house market) or company (`a_company`) | `laIsInternalBk`, `laIsCompanyBk` (core) | computed | missing | neither flag computed; `money-reports.ts marketOf` reads staff purposes only [data] |
| A staff booking must name a staff member | `bkV2CommitBooking` (app) | refusal | missing | `staff_id` optional [data] |
| A company booking must give a reason (`companyPurpose`) | `bkV2CommitBooking` (app) | refusal | missing | no column; the field is dropped [data] |
| Staff welfare FOC beyond the yearly quota asks "should be Adult, charged" | `bkV2CommitBooking`, `staffQuota` (app) | warning | missing | `sales-editing-model.md` Open 1 [money] |
| House-account rules on agent change: rate from agent, staff/company price mode, walk-in and real agents clear `soldBy`/`staffId` | `bkV2ApplyAgentRules`, `bkV2SetBookingField` (app) | auto-change | built differently | price mode enforced (`enforcedPriceMode`); clearing `sold_by`/`staff_id` missing [data] |
| A route outside the agent's programmes asks; the picker offers only those | `bkV2CommitBooking` §contract-scope, `bkV2BookableRoutes` (app) | warning | missing | server only prices it at ฿0 `not_offered` [ux] |
| Changing the agent clears agent-scoped form data | `bkV2ResetAgentScopedData` (app) | auto-change | missing | client form [ux] |
| Inactive agents can't be picked | `bkV2PickAgentByText` (app) | refusal | built | `409 agent_inactive` |
| Booking id `BK-YYMMNNNN-XXXX` (month sequence + random) | `bkV2GenerateBookingCode` (app) | numbering | built differently | `booking_<uuid>`. Not documented [data] |
| An edit keeps history, invoice, ops, upgrades, fees, reschedules, cancellation | `bkV2CommitBooking` (app) | auto-change | built | per-table storage; `PATCH` keeps what it doesn't send |
| Hotel name snapped to an existing spelling; a near match (≥82%) asks | `bkV2CanonicalHotel`, `bkV2HotelNear` (app) | auto-change / warning | missing | [data] |
| Hotel-name merge rewrites `hotelName`/`pickup` on every matching booking, with history | `psuHotelGroups`, `psuHotelMerge` (app) | auto-change | missing | no bulk rename [data] |
| Nationality backfill from names on confirm, with history | `mdBackfillNat` (app) | auto-change | missing | not guessed here; `nat_learn` "Not replaced" (`legacy-replacement.md`) [data] |
| Passenger list sized to the largest trip's heads; lead type AD, else FOC, CHD, INF | `bkV2SyncPassengers` (app) | computed | missing | `passengers`, `lead_type` client facts [data] |
| FOC flags need FOC seats and are capped at the FOC count | `bkV2ToggleLeadFoc`, `bkV2TogglePassengerFoc` (app) | refusal | missing | [data] |
| Group paste: N names → adults = N − others, Thai split by nationality | `bkV2GroupPasteApply` (app) | auto-change | missing | [ux] |
| Veg + vegan + halal cannot exceed the headcount | `bkV2BumpSpecialMeal`, `_bkV2MealRoom` (app) | refusal | missing | `PUT /v1/bookings/{id}/meals` does not cap [data] |
| Allergy entries: blank dropped, qty ≥ 1, same name merged | `bkV2CommitBooking`, `bkV2AllergyAdd` (app) | auto-change | built | README "Allergy list" |
| Allergy text left in the input box is saved on Save | `bkV2CommitBooking` §bkAlFlush (app) | auto-change | missing | client form [ux] |
| 3 or more large bags warn "van seats may shrink" | `bkV2RenderDietaryLuggageSection` (app) | warning | missing | [ux] |
| Cash on tour defaults to THB, handling deduct | `bkV2ToggleCashOnTour` (app) | computed | built differently | applied on read (`pier-money.ts`, `after-trip.ts suggestedCotMode`) |
| Adjustments of 0 or less are dropped | `bkV2CommitBooking` (app) | auto-change | built differently | `400` (README "Adjustments") |
| Advisory edit lock: someone else opened it in the last 5 minutes | `bkV2EditLockActive`, `bkV2SetEditLock` (app) | warning | built differently | `version` / `If-Match`, `409 stale_version` (README "Edit conflicts") |
| Editing a cancelled, completed or rejected booking asks "Edit anyway?"; weather-cancelled passes | `bkV2EditBooking` (app) | warning | built differently | `409 booking_closed` for all four. Not flagged |
| Cancel: refused when cancelled, completed, rejected; category; "other" needs a note; charge none/full/partial | `bkV2DetailCancel`, `bkV2CancelConfirm`, `bkV2CancelBooking` (app) | refusal | built | `POST /v1/bookings/{id}/cancel` |
| Cancel voids the live invoice, raises a fee invoice, returns lock draws, frees the charter boat | `bkV2CancelBooking` (app) | auto-change | built | same |
| A cancel reason suggests a default charge | `bkV2CancelPickReason` (app) | auto-change | missing | UI hint [ux] |
| Restore from cancelled, weather-cancelled or rejected; voids the fee invoice; redraws locks; a taken charter boat only warns | `bkV2RestoreBooking` (app) | auto-change | built differently | `/restore` refuses `409 charter_boat_taken` and over capacity. Not flagged |
| Reschedule refused for closed statuses or no date; new date ≠ old; reason; partial fee > 0 | `bkV2DetailReschedule`, `bkV2RescheduleConfirm` (app) | refusal | built | `POST …/reschedule` |
| Reschedule moves the from-date's trips, returns lock draws, carries the charter boat, clears the day's ops | `bkV2RescheduleBooking` (app) | auto-change | built | README "reschedule" |
| Reschedule fee "on invoice": added as a line onto the booking's existing invoice | `bkV2RescheduleBooking` (app) | computed | built differently | a separate fee invoice. README says legacy left it unbilled, which is wrong (Findings 2) |
| Partial cancel: reason, note for "other", ≥ 1 head, charged + waived = removed, refund lowers total, lock draws first | `bkV2PartialConfirm`, `bkV2PartialCancel` (app) | refusal / auto-change | built | `POST …/partial-cancel` (also refuses emptying a trip) |
| Partial cancel suggests amounts = heads × seat price per head | `bkV2PartialRecalc` (app) | computed | missing | client facts [ux] |
| Partial cancel flags the booking's invoice `needsAdjustment` | `bkV2PartialCancel` (app) | auto-change | missing | the invoice keeps the old total [money] |
| Booking money strip: billable = total − COT deduct; paid/balance from the invoice; mismatch warnings | `bkV2PayOf`, `bkV2CotOf` (app) | computed | built differently | `payment_state`; the invoice subtracts the COT deduct (README "After the trip") |
| Payment chip: FREE, PFM state, invoice state, else pay term; B2C its own | `bkV2PayChip` (app) | computed | built | `payment_state`, `invoice`, `GET /v1/pfm` |
| Paid/owed per booking on a shared invoice; a B2C order counted once as total − paid | `bkV2PaidSplit`, `bkV2PaidLine` (app) | computed | built differently | B2C balance is `payment_balance` as sent (`money-model.md` Open 3) |
| COT chip: from `cashOnTour`, else parsed out of the notes | `bkV2CotChip` (app) | computed | missing | structured field only [money] |
| Voucher money strip on/off system-wide, operations only | `bkV2PayToggle` (app) | permission | missing | no setting [ux] |
| Booking money = price + fee items | `laBkMoney` (core) | computed | built | `booking-actions.ts amountOwed` |
| Entered day = Created history stamp, else `createdAt`, else `bookingDate` | `_dashBkTs`, `_dashBkDay` (core) | computed | built differently | no created-date filter on `GET /v1/bookings` [ux] |
| Notice board: pending approvals, weather follow-ups, cancelled today | `_dashBoardData` (core) | computed | built differently | from `?status=` and weather counts; "cancelled today" has no filter [ux] |
| On every load a v1 booking's total is re-derived from mock price tables | `sbCalcBookingTotal` (app) | sweep | missing? | count v1 rows first [money] |
| On load, demo bookings `BK-26050001`… are removed | dummy-cleanup IIFE (app) | sweep | missing? | one-off, probably already applied [data] |
| Cancellation report: rates, fees, by reason, side, agent, month | `bkV2RenderCancelReport` (app) | computed | missing | [ux] |
| Calendar, matrix and month stats | `bkV2Aggregate`, `bkV2RenderStats`, `bkV2RenderTab3` (app) | computed | missing | raw reads only [ux] |

## Pricing

| Rule | Legacy (file) | Kind | Status | Here / note |
|---|---|---|---|---|
| Save stamps total, breakdown, trip subtotals, `promoId`, `rtRef` | `bkV2CommitBooking`, `bkV2CalcQuote` (app) | computed | built | `priceBooking`, README "Prices" |
| Rate for a date: covering season with the latest start, else the agent's rate | `laSeasonAt`, `laMainRtIdFor` (app) | computed | built | `rate-seasons.ts rateTypeFor` |
| Winning promo by agent, route, travel date, booking window, priority, latest start | `laPromoFor`, `laPromoCovers`, `laPromoHasRate` (app) | computed | built | `pricing.ts priceBooking` |
| Promo modes: rate, own (overlay filled zones), discount (% or amount, never below 0) | `laPromoRate`, `laPromoMainRt` (app) | computed | built | `pricing.ts` overlay and discount |
| A sold trip's check price uses the promo locked at sale, even if since cancelled | `laPromoRateSold`, `laPromoById` (app) | computed | missing? | `promo_id` stored, but only active promos are resolved [money] |
| Buy-N-get-1 counter: sold, earned, used, left (warns only) | `laPromoBonus`, `laPromoStat`, `ctPromoView` (app) | computed | missing | `bonus` stored, nothing counts it [ux] |
| Editing keeps a trip's sold rate; "use new rate" switches and moves `rateTypeRef` | `bkV2RtKeepInit`, `bkV2RtKeepUse` (app) | computed | built | `rate: "kept"` / `"agent"` (README "Prices") |
| Rate drift since save shown in red before saving | `bkV2EditBooking`, `bkV2RtKeepNote` (app) | warning | missing | `price_warnings` covers a client-sent price only [ux] |
| On edit, prices changed since save ask before overwriting | `bkV2SubmitBooking` §rtKeep (app) | warning | built | kept rate; `POST /v1/quote` shows both |
| Add-on prices from the season/main rate of the first trip, never a promo | `bkV2AddOnRT` (app) | computed | built | `pricing.ts addOnRate` |
| Trip subtotal: seat × pax, bundles, charter starter + extra heads, manual charter, OVN leg 0 | `_bkV2TripSubtotalRun` (app) | computed | built | `pricing.ts` steps 3–4, proved on 4,352 bookings |
| Longtail join head count capped and filled trip by trip; left out under a bundle | `bkV2LtJoinMax`, `bkV2SetAddOnJoin` (app) | computed | built | `join_adults`/`join_children`, `counted: false` |
| Total = seats + add-ons − discounts + extras + OVN, never below 0; manual; B2C kept | `_bkV2CalcQuoteRun` (app) | computed | built | `pricing.ts`; B2C exception (README "Prices") |
| Adjustment rows | `bkV2AddAdjustment` (app) | computed | built | README "Adjustments" |
| Company booking always manual; staff inspection manual ฿0; welfare at the rate | `bkV2GetRT`, `laManualRT`, `bkV2ApplyAgentRules` (app) | computed | built | `enforcedPriceMode` |
| A trip with no rate can't be saved; zones with no seat rate disabled | `bkV2NoRateTrips`, `bkV2RenderSubmitButton` (app) | refusal | built differently | saves at ฿0 with `not_offered`/`no_rate`. Not flagged (Findings 4) |
| A charter with no price asks "saved at 0 THB, really free?" | `bkV2SubmitBooking` (app) | warning | built differently | `no_charter_price` warning after save |
| A private-van add-on moves that route's seat to NoTransfer | `bkV2ToggleAddOn` (app) | auto-change | missing | zone priced as sent [money] |
| Longtail join locked out under a bundled route | `bkV2RenderAddOnsSection` (app) | refusal | built differently | accepted, `counted: false` |
| Add-on amount = catalogue price × qty; label from the catalogue | `bkV2CommitBooking` (app) | computed | built differently | amount computed, label the client's (`pricing-model.md`) |
| Staff-edited B2C booking keeps its price and records `b2cOverride` | `bkV2CommitBooking` §b2cEdit, `bkV2EditBooking` (app) | auto-change | built differently | price kept; `b2cOverride` not needed with the push (`b2c-sync-model.md`) |
| Season table warnings: overlap, gap, open-ended before the next, last has an end | `laSeasonIssues` (app) | warning | built differently | refuses end < start, same start, unknown rate; the rest missing [ux] |
| Season editor: drop incomplete rows, sort, "snap" each end to the next start | `rtmSave`, `rtmSnap` (app) | auto-change | built differently | `PUT …/rate-seasons` validates; snap not served [ux] |
| Season schedule from the contract on rate expiry: split day, old rate then new | `rtExpBulkPlan`, `rtExpBulkApply`, `rtmSuggest` (app) | auto-change | missing | per agent `PUT` only [money] |
| Rate expiry scan: rates ending ≤ 60 days with agents and no covering season | `rtExpScan`, `rtExpForAgent` (app) | computed | missing | [ux] |
| Season edits need `sales` | `rtmSave` (app) | permission | built | README "Rate seasons" |
| Rate type save: name, valid-from ≤ valid-to, drop unselected routes' prices | `rtSaveDraft` (app) | refusal | built | `POST`/`PATCH /v1/rate-types` |
| Rate type code from owner + name, unique, `-2`… | `_rtAutoCode` (app) | numbering | built differently | from the name only; never changes |
| A new or cloned rate type's owner is the creating salesperson | `rtOpenNew`, `rtClone` (app) | auto-change | missing | `owner` optional [data] |
| Only an admin sets a rate type's owner | `rtSetOwner` (app) | permission | missing | `PATCH owner` needs `sales` [data] |
| A sales-bound login sees only its own and shared rate types | `rtScopeList`, `_rtInScope` (app) | permission | missing | `sales-editing-model.md` Open 8 [data] |
| An inactive rate type can't be bound to an agent or season | `rtForSales`, `agTabRate` (app) | refusal | missing | both `PUT`s accept it [data] |
| Duplicate-code scan and fix | `rtDupCodeScan`, `rtDupCodeFix` (app) | sweep | built differently | `code` UNIQUE (migration 022) |
| Delete a rate type unbinds its agents | `rtDeleteRT` (app) | auto-change | built differently | `409 in_use` |
| Clone; copy routes and prices; copy net to a tier | `rtClone`, `rtCopyFromRT`, `rtCopyNetToTier` (app) | auto-change | missing | to-do in `rate-types-model.md` [ux] |
| Zone "not offered", free bundle, zones by pier | `rtToggleZoneNotOffered`, `rtSetBundleMode`, `rtZonesForRoute` (app) | auto-change | built | README "Rate types" |
| Custom add-on types (need `config`) | `rtAddonTypeCreate`, `rtAddonTypeDelete` (app) | permission | missing | `rate-types-model.md` Open 2 [data] |
| Load-time rate-type migrations and seeds | `_rtRestore`, `_rtBackfillOwners`, `_rtEnsureStaff` (app) | sweep | built differently | one-time import `--rate-types` |
| Bulk bind/unbind agents to a rate type | `rtAgentPickerApply`, `rtUnbindAgent` (app) | auto-change | built differently | per agent `PUT …/rate-type`; bulk is to-do |

## Seat locks

| Rule | Legacy (file) | Kind | Status | Here / note |
|---|---|---|---|---|
| Create: route; bulk needs first/last day covering a running departure; seats > 0; day lock needs a date | `bkV2LockCreateSubmit`, `bkV2LockRounds` (app) | refusal | built | `POST /v1/seat-locks`, `/v1/seat-lock-groups` (`400 no_departure`) |
| Agent holder matched by name; free text allowed | `bkV2LockCreateSubmit` (app) | computed | built differently | real agent required; Flagged in `seat-lock-extras-model.md` |
| Short of seats asks split / all pending / cancel | `bkV2LockShort`, `bkV2LkPendAskModal` (app) | warning | built | `409 seats_short` + `pending` |
| Pending seats hold nothing; cut first; confirm capped by free | `bkV2LockPendOn`, `bkV2LockPendConfirm` (app) | computed | built | `…/confirm-pending` |
| Sub-groups carve from the parent's unallocated seats; pending shares | `bkV2CreateSubLock`, `bkV2LockSubShares` (app) | refusal / computed | built | `…/sub-groups` (`409 no_room`) |
| A sub-group's own expiry | `bkV2CreateSubLock` (app) | computed | decided not to copy | `seat-lock-extras-model.md` Flagged, decision 10 |
| "+ seats" into the parent's unallocated seats; reactivates | `bkV2LockAddSeats` (app) | refusal / auto-change | built differently | cap also subtracts the parent's own sales (Flagged) |
| Edit frozen once drawn; floor = max(drawn, split) | `bkV2LockEditLocked`, `bkV2LockEditSubmit` (app) | refusal | built differently | floor is a sum (Flagged) |
| Edit a bulk lock's range or weekdays while nothing is drawn | `bkV2LockEditSubmit` (app) | auto-change | missing | `400 server_owned`; Open 2 [seats] |
| Release gives back unallocated seats; modal caps it | `bkV2ReleaseLock`, `bkV2ReleaseModalCommit` (app) | auto-change | built differently | `released_pax`; over the floor `409` (Flagged) |
| Release cutoff is a warning; release one departure or all overdue | `bkV2LockReleaseCutoff`, `bkV2LockReleaseOverdueGo` (app) | warning / auto-change | built | `release_at`, `overdue`, `…/release-departure`, `/release-overdue` |
| Expiry sweep on load | `bkV2LockExpireSweep` (app) | sweep | built differently | worked out on read (README "Expiry") |
| Month locks → bulk; heal lost ranges | month→bulk IIFE, `bkV2LockHealRange` (app) | sweep | built differently | once, by the import (Flagged, Import) |
| Draw capped; per departure; depleted; return reactivates | `bkV2DrawLock`, `bkV2ReturnLock` (app) | computed / auto-change | built | booking writes draw and return |
| Own agent's locks plus office and global; parents expand to sub-groups | `bkV2LocksForAgent`, `bkV2DrawSources` (app) | permission | built | `400 lock_other_agent` |
| Pool hold counted at the parent | `bkV2LockPoolHold`, `bkV2LockedTotal` (app) | computed | built | `held_pax`, `capacity.ts` |
| Audit and fix the `used` counter | `bkV2LockAudit`, `bkV2LockFixUsed`, `bkV2LockSweep` (app) | sweep | built differently | `drawn_pax` computed; nothing to drift |
| Coverage: holder's bookings that took pool seats instead of the lock | `bkV2LockCoverage` (app) | computed | missing | [ux] |
| KPIs per agent: locked vs drawn, conversion | `bkV2LockKpiByAgent` (app) | computed | missing | Open 4 [ux] |
| Agent has lock seats free but drew none: asks | `bkV2CommitBooking` (app) | warning | missing | [ux] |
| Draws by explicit pick, else automatic agent → office → global | `bkV2CommitBooking`, `bkV2AutoDrawLocks` (app) | auto-change | built differently | only the `lock_draws` sent |
| Draw ≤ the lock's remaining; total ≤ pax; a charter draws nothing | `bkV2SetTripLockDraw` (app) | refusal | built | README "lock_draws" |
| An edit returns old draws, then draws again | `bkV2CommitBooking` §lkReturn (app) | auto-change | built | `lock_draws` replace |
| Lock writes need `operations` | `sbSeatLocksPersist` (app) | permission | built | `writeNeed` |

## Availability and capacity

| Rule | Legacy (file) | Kind | Status | Here / note |
|---|---|---|---|---|
| Pool = unchartered deployed boats (with overrides) − sold − locked | `getAllotment`, `_calTripsFor` (core) | computed | built differently | `capacity.ts dayCapacity`; clamped to licence; oversold goes negative (README "What available_seats subtracts") |
| Seats sold: all tiers on live seat trips; charters excluded | `getSeatsConsumed`, `getTripPaxTotal` (core) | computed | built | `capacity.ts`, `SEAT_RELEASING_STATUSES` |
| Van and pier no-shows and on-site cancels come off seats sold | `getSeatsConsumed` (`ckLostByType`), `_abAgentSplit` (core, ab) | computed | missing | `aboard.ts lostByType` not used by capacity (Findings 6) [seats] |
| Over-allotment pending holds no seats; pending for another reason does | `bkPendHoldsSeat` (core) | computed | built | `bookingHoldsSeats` |
| Three tiers: locked seats refused, past licence refused, over allotment → approval | `bkV2CommitBooking` (app) | refusal / warning | built | `capacity.ts weighDay` |
| Real seats left = licensed unchartered seats − sold | `getAllotment` `licenseAvailable` (core) | computed | built | `licensed_free` |
| No boat deployed: sells without a seat check | `getAllotment` (core) | computed | built | `unplaced_pax` |
| A land route's `dailyCap` | `getAllotment`, `bkV2CommitBooking` §otherPier (core, app) | computed | decided not to copy | README "Editing routes"; `catalogue-editing-model.md` decision 7 |
| Agent locks off the free count, boat by boat | `_calTripsFor` §lkAvail (core) | computed | built | `locked_pax` |
| Closed-route days hidden or excluded | `_calTripsFor`, `buildDAGroups`, `_abScan` (core, ab) | computed | built | `/v1/availability` `open` |
| A deployed boat not ready still counts, flagged | `_calTripsFor` §calDown (core) | computed | built differently | flag from `GET /v1/fleet/availability` |
| Chartered overnight return leg uses no pool seats | `bkIsCharterOvnLeg` (core) | computed | built differently | the leg must itself be a charter |
| A Boat Operation slot typed `charter` with no booking takes the boat | `isBoatChartered`, `getCellType` (core) | computed | missing? | deployments have no type [seats] |
| Whole-boat hold: create (land refused, expiry ≤ trip date, minimum seats, agent named) | `bkV2CreateBoatLock`, `bkV2BoatLockSubmit` (app) | refusal | missing | import only (`seat-lock-extras-model.md` Open 1) [seats] |
| Whole-boat hold blockers: no charter or hold, not placed elsewhere, no pax, route not left short, pier matches, available | `bkV2BoatLockBlockers`, `bkV2BoatLockCanTake` (app) | refusal | missing | [seats] |
| Edit a hold with the same checks | `bkV2BoatLockEdit` (app) | refusal / auto-change | missing | `400 boat_hold` [seats] |
| Swap a held boat: "fixed" asks, "any" refuses a smaller boat | `bkV2BoatLockSwap` (app) | warning / refusal | missing | [seats] |
| Release a hold | `bkV2BoatLockRelease` (app) | auto-change | built | full release only |
| A held boat leaves the pool, takes no seat booking, is overdue past expiry | `bkV2LocksFor`, `bkV2BoatLockOverdue` (app) | computed | built | `dayCapacity`, `409 boat_chartered`, `overdue` |
| Seat badge per trip and over-capacity note | `bkV2RenderTripsSection` (app) | computed | built | `GET /v1/availability?exclude_booking_id=` |
| Weather-closed trips count 0 free; pax split pending/cancelled/rescheduled | `renderCal`, `bkV2WeatherCountsFor` (core) | computed | built differently | `GET /v1/weather-closures` `pax`; availability unchanged (Flagged 14) |
| Day labels open/tight/full/all-chartered/weather; fill % | `getAllotment`, `renderDA`, `_abScan` (core, ab) | computed | missing | numbers only [ux] |
| Pier closed when all its routes are; calendar stats | `_calPierClosed`, `renderCal` (core) | computed | missing | derivable from `/v1/routes`, `/v1/availability` [ux] |
| Operating-boats card: sold seats spread boat by boat | `renderDash` (core) | computed | missing | [ux] |
| Pax aboard each boat per day (Daily Fleet Log auto-pax) | `flBoatBookingsFor`, `fcLoadMap` (core) | computed | missing? | daily log has `pax_actual` as sent [ops] |
| Action Board grid from `getAllotment` | `_abScan`, `abRender` (ab) | computed | built | `/v1/availability?from&to` |
| Action Board pax by agent or salesperson per cell | `_abAgentSplit` (ab) | computed | missing | [ux] |
| "At risk" (< 5 days, < 40%), "almost full", free seats over 14 days | `abRender` §abRisk5 (ab) | computed | missing | [ux] |
| Daily Availability: allotment and booked per route | `buildDAGroups`, `renderDA` (core) | computed | built | `/v1/availability` |
| Legacy v1 bookings count toward seats | `getSeatsConsumed`, `progCountBookingImpact` (core) | computed | missing? | how the import maps them was not checked [data] |

## Deployments and boats

| Rule | Legacy (file) | Kind | Status | Here / note |
|---|---|---|---|---|
| No change to a past day's deployment | `bop2GuardPast` (core) | refusal | built differently | `409 past_date`, an admin may correct (`deployment-guards-model.md`) |
| A boat held by a charter can't be unassigned or moved | `opLocked`, `bop2AssignBoat` (core) | refusal | built | `409 charter_boat` |
| A boat held whole for an agent can't be unassigned, moved or swapped | `opLocked`, `opHoldOnly`, `bop2ApplySwap` (core) | refusal | missing | Findings 3 [seats] |
| Moving a boat with bookings on it asks, then flags them "boat pulled" | `bop2AssignBoat`, `bop2UnassignBoat` (core) | warning | built | `409 seats_sold` / `remove_anyway`, `boat_pulled` |
| Only boats at the route's pier are offered | `bop2AssignBoatOptsFor`, `openPortal` (core) | refusal | missing | [ops] |
| No boat on a day the route is closed | `bop2OpenCellPopover` (core) | refusal | missing | `route_closed` covers bookings and locks only [ops] |
| Land routes left out of Boat Operation | `bop2AssignRangeForm`, `bop2WeekdayPatternForm` (core) | refusal | missing | [data] |
| A boat not ready is not offered | `bop2FleetStatus` (core) | refusal | built | `409 boat_not_ready` / `deploy_anyway` |
| Retired boats never offered | `bop2FleetStatus` (core) | refusal | built | `409 boat_retired` |
| A boat on an overnight charter is unavailable on the nights between | `bop2FleetStatus` `bkOvnHoldOn` (core) | computed | built differently | free on those nights (README "Pickup and overnight fields") |
| Bulk: copy week, copy day, range, weekday pattern, clear week | `bop2CopyWeekToNext`, `bop2ApplyAssignRange`, `bop2ClearWeek` (core) | auto-change | built differently | client loops; per-day guards apply |
| Swap two boats' routes on a day | `bop2ApplySwap` (core) | auto-change | built differently | two moves, not atomic [ops] |
| Saved weekday deployment templates | `bop2ApplySaveTemplate`, `bop2ApplyTemplate` (core) | auto-change | missing | [ux] |
| Route-days needing a boat: pax but no boat, or every boat broken | `bop2RouteDaysNeedingBoats` (core) | computed | built differently | `unplaced_pax`; "broken" needs a client join |
| A cell is "early" when the route name contains "Early" | `getCellType` (core) | computed | missing | [ux] |
| Old ops matrix booked counter | `initOpListeners`, `openPortal` (core) | auto-change | missing? | looks like dead code; confirm [ux] |
| Boat load ≤ day capacity + 2, else refused | `bkV2AssignBoat`, `bkV2BoatAssignSelected` (app) | refusal | built | `dispatch.ts checkBoatAssignment` `409 boat_full` |
| Over capacity, `act-capunlock` raises the day's capacity with a reason | `bkV2AssignBoat`, `boatCapModalOpen` (app) | permission | built | `raise_capacity` |
| Load above licence + 2 can't be raised | `bkV2AssignBoat` (app) | refusal | built | `409 over_licence` |
| A chartered or held boat takes no seat bookings (every date of the booking) | `bkV2AssignBoat`, `baDayBoats` (app) | refusal | built differently | `409 boat_chartered`, the trip's day only |
| Only boats deployed on the route can be picked | `bkV2BoatPicker` (app) | refusal | built | `409 boat_not_deployed` |
| Choosing one boat for a split booking asks first | `bkV2AssignBoat` (app) | warning | built differently | `boat_id` replaces `boat_splits` silently [ux] |
| Bulk assign: skip and report the ones over capacity | `bkV2BoatAssignSelected` (app) | refusal | built differently | one PATCH per trip |
| Boat load counts each split's share | `baAssignedPax`, `bkBoatSplits` (app) | computed | built | `dispatch.ts paxByBoat` |
| Boat split: ≥ 2 pax, parts add up, a boat per part, no boat twice | `bkV2BoatSplit`, `bkV2BoatSplitApply` (app) | refusal | built | `parseDispatchPatch` |
| Boat split over capacity only warns | `bkV2BoatSplitRender` (app) | warning | built differently | refused per boat |
| Auto-fill a boat split by free room | `bkV2BoatSplitAuto` (app) | auto-change | missing | [ux] |
| Unsplit puts everyone on the first boat | `bkV2BoatUnsplit` (app) | warning | built differently | client sends `boat_id` |
| "Boat pulled" | `bkV2BoatPulled` (app) | computed | built | `boat_pulled` |
| Day capacity override: reason; ≤ licence; raising needs `act-capunlock` | `boatCapSet`, `_bcapSave` (app) | permission | built | `PUT/DELETE /v1/boats/{id}/capacity-overrides/{date}` |
| Auto-assign boats: keep set ones, first that fits, else least loaded within + 2 | `baAutoAssign` (app) | auto-change | missing | [ops] |
| Boat select offers only boats deployed on the route | `renderBoatAssign` (app) | refusal | built | `409 boat_not_deployed` |
| Boat document renewed: needs a new expiry, keeps the old, flips `processing` to `done` | `depSave` (app) | refusal / auto-change | built differently | `documents` replaced whole, shape only |
| Certificate status: processing, n/a, expired, ≤ 30, ≤ 90, ok | `flDocStatus` (eng) | computed | missing | `fleet-maintenance-model.md` Open (part A) 2 [ops] |
| Current certificate per type; name → type | `flDocBetter`, `flDocCurrent`, `flGuessDocType` (eng) | computed | missing | same [ops] |
| Expiry levels on the job sheet; park permit picked from route | `pjDocLv`, `pjParkNeed` (app) | computed | missing | [ops] |
| Certificate counts: expired and ≤ 90 days | `flRenderBoatList`, `flRenderOverview` (fleet) | computed | missing | `catalogue-editing-model.md` Open 4 [ops] |
| Boat document alerts on the dashboard (≤ 60 days) | `renderDash` (core) | computed | missing | [ux] |
| Pier assignment: from ≠ to, dates, status by date, permanent move changes home pier | `flSaveAssignment`, `flCancelAssignment` (fleet) | refusal / auto-change | missing | Open (part A) 2 [ops] |
| A boat's pier on a date: shop, assignment, status location, home | `getBoatCurrentPier` (core, fleet) | computed | missing | home pier only (Open part B 4) [ops] |
| Boats counted by their pier today | `flRenderDashboard`, `flRenderOverview` (fleet) | computed | missing | [ops] |
| Restore a retired boat | `flUnretireBoat` (fleet) | auto-change | built | `POST /v1/boats/{id}/restore` |
| Boat's day status on the job sheet; stale programme flag | `pjBoatSt`, `pjAllBoats` (app) | computed | built differently | `GET /v1/fleet/availability`; no job-sheet groups [ops] |
| Removing a stale programme refused while bookings are on the boat | `pjOpDrop` (app) | refusal | built differently | `remove_anyway` |
| Daily Log orphan warning: booking on a pulled boat | `flRenderDR` (fleet) | warning | built | `boat_pulled` on dispatch |

## Charters

| Rule | Legacy (file) | Kind | Status | Here / note |
|---|---|---|---|---|
| A charter takes every boat it is split over; all leave the pool | `baCharterBoatMap`, `baCharterBoatIds`, `_calTripsFor` (app, core) | computed | missing | `dayCapacity` reads `charter_boat_id` only; verified [seats] |
| Overnight charter holds its boat every day of the span | `bkOvnHoldMap`, `bkOvnHoldOn` (app) | computed | built differently | not held between (decided, README) |
| On load: move return legs, make them charters, claim span cells | `bkOvnHealSpans` (app) | sweep | built differently | wrong leg date is `400` |
| Charter boat picker: deployed boats, chartered ones disabled | `bkV2RenderTripsSection` (app) | refusal | built | `400`, `409` (`capacity.ts`) |
| Chartering over sold seats: shows the oversell, ack, may go ahead | `bkV2SetTripCharterBoat`, `bkV2ConfirmCharter` (app) | warning | built differently | `409`. Not flagged |
| A quote does not hold the charter boat | `bkV2CommitBooking` (app) | computed | built differently | a quote holds it (README "Status"). Not flagged [seats] |
| A whole-boat hold converts into the charter booking | `bkV2BoatLockOnConvert`, `bkV2BoatLockToCharter` (app) | auto-change | missing | `legacy-replacement.md` §5 [seats] |
| Changing the charter boat moves `ops.boatId` | `bkV2CommitBooking` §chOpsSync, `bkV2CharterBoatHeal` (app) | auto-change | built | `dispatch.ts charterSynced` |
| Overnight return leg: dates in order, no duplicate, copies route/pax/zone, ฿0, charter on the same boat | `bkV2CreateOvnReturnLeg` (app) | refusal / auto-change | built | README overnight rules |
| On save, legs follow the outbound's return date; orphans dropped | `bkV2CommitBooking` §ovnSync (app) | auto-change | built differently | `400` instead of fixing |
| Charter-boat dialog: name, seats > 0, period start ≤ end | `saveCharterBoat` (charter) | refusal | built | `POST`/`PATCH /v1/boats`, status log |
| New charter boat: ownership charter, one available period | `saveCharterBoat` (charter) | auto-change | built differently | two calls; status log needs `province`/`loc_type` |
| Overlapping charter periods ask "Save anyway?" | `saveCharterBoat` (charter) | warning | built differently | add trims overlaps; in-place edit unchecked. Not flagged |
| Editing a period rewrites its location only while it is the old auto label | `saveCharterBoat` (charter) | auto-change | missing | [data] |

## Vans and dispatch

| Rule | Legacy (file) | Kind | Status | Here / note |
|---|---|---|---|---|
| Dispatch is per travel day | `bkOpsRead`, `bkOpsFor` (app) | computed | built | `trips[].operations` |
| A moved trip loses boat, vans, groups, final pickup, check-ins | `bkOpsClear`, `bkV2CommitBooking` (app) | auto-change | built | `dispatch.ts clearedOnMove` |
| A moved booking snapshots its arrangement and stays struck on the old day | `ckStrandSnap`, `ckStrandMovedRows`, `tsMvRows` (app) | sweep | missing | `van-job-orders-model.md` Open 1 [ops] |
| Return sheet tags from check-in | `vanJobsOrderInner` §vjRetNS (app) | computed | missing | Open 2 [ops] |
| Overnight return leg: clear its inherited hotel time, restore its zone | `bkV2HealOvnLegs` (app) | sweep | missing? | no normalisation on write [data] |
| Self-arrive trip with a clock time reset to the area default | `bkV2HealSelfArrivePickup` (app) | sweep | missing | warned (`self_arrive`), not fixed [data] |
| Render-time repairs: van groups, alt splits, charter boat | `renderVanCheckin`, `bkV2RenderTab2` heal calls (app) | sweep | built differently | built on every write |
| Overnight return leg may use any boat sailing that day | `bkV2BoatPicker` §OVN (app) | auto-change | missing | [ops] |
| Zone change: only `pickupAreaId`; re-looks up times not hand-edited; warns on a price-zone change | `bkV2ZonePickConfirm` (app) | auto-change | built differently | `PATCH pickup_area_id`; times not redone (`booking-extras-model.md` 4) [ux] |
| Pickup time from route × area × date unless edited | `bkV2SetPickupArea`, `bkV2ResetTripPickupTime` (app) | auto-change | built | `fillPickups` |
| Pickup area overwrites every trip's zone | `bkV2SetPickupArea` (app) | auto-change | built differently | fills only an empty zone (D1) |
| A NoTransfer zone picks the pier's NoTransfer area | `bkV2SetPickupZone` (app) | auto-change | missing | [ux] |
| Saved copies: area name, zone (default PK), drop-off = pickup | `bkV2CommitBooking` (app) | computed | missing | client facts [data] |
| Switching to self-arrive clears the outbound van | `bkV2CommitBooking` §bug1 (app) | auto-change | built differently | skipped on read; nothing cleared |
| Alt pickups: qty, zone, empty rows dropped | `bkV2CommitBooking`, `bkV2SetAltPickupPax` (app) | computed | built | README "Alternate pickups" |
| Alt pickups build auto van splits | `bkV2SyncAltPickupSplits` (app) | auto-change | built | `alt-pickups.ts` |
| Split part with its own pickup has its own time | `bkSplitOwnPick`, `bkV2SetSplitPickTime` (app) | auto-change | built differently | `400` on a part without its own pickup |
| Vans for a route/day = usable vans the matrix puts there | `vanVehiclesForRoute`, `_vehUsableOn` (app) | refusal | built | `409 van_not_in_pool` |
| Van zone that day; return pool by zone | `vehEffectiveZone`, `vanVehiclesForZone` (app) | computed | built | `zone_on`, `returnPool` |
| Grouping zone: trip, booking, charter, private-van add-on | `bkV2EffZone`, `bkV2TripPrivateVan` (app) | computed | built | `effectiveZone` |
| Auto-assign a route's transfer bookings to vans | `bkV2VanAutoAssign` (app) | auto-change | missing | [ops] |
| Clear all outbound vans of a route/day | `bkV2VanClearRoute` (app) | auto-change | built | `POST /operations/van-groups/clear` |
| Van and return van per booking; `returnSameVan` | `bkV2AssignVan`, `bkV2AssignVanReturn` (app) | auto-change | built differently | van on the group; R11 on every setter |
| Group number = max + 1 across the route/day | `_bkV2VanNextGroup` (app) | numbering | built | `POST /operations/van-groups` |
| Ticked rows join in tick order and inherit the van | `bkV2VanGroupSelected` (app) | auto-change | built | `…/members` |
| A group over the van's seats is refused | `bkV2VanGroupSelected`, `bkV2VanGroupPax` (app) | refusal | built | `409 van_over_capacity` |
| A van on another group asks "another round?" | `bkV2VanGroupSetVan` (app) | warning | built | `409 van_in_other_group` / `allow_second_round` |
| Heal grouped bookings missing the group's van | `bkV2VanGroupHeal` (app) | sweep | built differently | van stored on the group |
| Disband clears group, vans and order | `bkV2VanGroupDisband` (app) | auto-change | built | `DELETE /operations/van-groups/{id}` |
| Group pickup time to every member | `bkV2VanGroupSetTime` (app) | auto-change | built | group `pickup_time` |
| Pickup order by tick; sort by time clears it | `bkV2VanGroupSave` (app) | auto-change | built | `PUT …/order` |
| Group return van for all members | `bkV2VanGroupSetReturn` (app) | auto-change | built differently | pool-checked |
| Dragged group order, `operations`, pruned after 45 days | `bkV2GrpOrderSet`, `_grpOrdPrune` (app) | permission | built | no pruning (Flagged in `van-job-orders-model.md`) |
| Van split: ≥ 2 pax; warns on children without an adult | `bkV2VanSplit`, `bkV2SplitApply` (app) | refusal | built | `child_without_adult` |
| Unsplit keeps the first part's group and vans | `bkV2VanUnsplit` (app) | auto-change | built differently | client sends one part with `group_id` |
| Rebalance splits whose counts disagree | `bkV2HealSplitPax` (app) | sweep | built differently | must add up (`400`); `rebalanceParts` |
| Final pickup per day | `bkV2SetPickupFinal` (app) | auto-change | built | `pickup_time_final` |
| Return leg needs a van alert | `bkV2RetInfo` (app) | computed | built | `return_unarranged` |
| Self-arrive still in a van zone is flagged | `renderVanJobs` (app) | warning | built | `self_arrive` |
| Job = van × route (× group); round by earliest pickup | `vjRoundAll`, `vjRoundPick` (app) | computed | built | `van-jobs.ts` `round` |
| A cancelled but arranged booking prints struck | `ckHasArrange`, `ckStrandOn` (app) | computed | built | `struck: "cancelled"` |
| Clearing it wipes boat, vans, final pickup and check-ins | `ckStrandClear` (app) | auto-change | built differently | only `van_parts` cleared [ops] |
| Sent-to-driver tick | `vanJobsToggleSent` (app) | auto-change | built | `…/sent` |
| Special request from notes, overridable | `vanJobsSreqAuto`, `vanJobsSetSreq` (app) | computed | built | `job_note` |
| Thai pickup names, `operations` | `vanJobsSetPickupTh` (app) | permission | built | `PUT /operations/pickup-names-th` |
| Per-date driver/phone/plate | `vanJobsSetDriver` (app) | auto-change | built | `PUT /operations/van-days/{date}/{van_id}` |
| Job sheet template and highlights | `vjTplSave`, `vjHlToggle` (app) | permission | decided not to copy | `van-job-orders-model.md` |
| Van stop: label, place, staff ≥ 1, cargo 0 | `vsSubmit`, `vsSave` (app) | refusal | built | `POST /operations/van-stops` |
| A staff stop overfilling the van asks | `vsSubmit` (app) | warning | built differently | per group; `seats_anyway` |
| Outbound staff stops take seats | `vsSeats` (app) | computed | built | `stop_seats` |
| Stop check-in stamp | `vsCheck` (app) | auto-change | built | `…/check-in` |
| Van job order print; unknown van refused | `bkV2VanJobOrder` (app) | refusal | built | `GET /operations/van-jobs/{date}/{key}` |
| Van, day, status, zone writes need `operations` | `vehAdd`, `vehSetField`, `vehDayCellClick` (app) | permission | built | README "Vans" |
| A van needs a name; id `veh` + next; defaults 9 seats, PK | `vehFormSave`, `vehAdd` (app) | refusal / numbering | built | `vans.ts nextVanId` |
| Capacity clamped to ≥ 1 | `vehSetField` (app) | auto-change | built differently | `400` |
| An `own` van loses its partner name | `vehFormSave` (app) | auto-change | built | `vans.ts` |
| Delete a van even if in use | `vehDelete` (app) | warning | built differently | `409 van_in_use`. Not flagged |
| Day status: the day's own, else a covering range | `vehStatusOn` (app) | computed | built | `status_on` |
| Status range: available, maintenance, off | `vehStatusAdd` (app) | auto-change | built differently | off/maintenance only. Not flagged |
| Zone override defaults to the opposite zone | `vehZoneAdd` (app) | auto-change | built differently | client sends `zone` |
| Several routes per van per day | `vehDayToggleRoute` (app) | auto-change | built | `route_ids` (route not checked to run) |
| Day zone: route's pier, day, range, base | `_vehRouteZone` (app) | computed | built | `zone_on` |
| Van log lines | `vehLog` (app) | auto-change | built | `GET /operations/vans/{id}/log` |
| Matrix day summary; per-van fill % | `_vehMatrixSummaryHTML`, `vehJobsFor` (app) | computed | missing | [ux] |

## Check-in and pier

| Rule | Legacy (file) | Kind | Status | Here / note |
|---|---|---|---|---|
| Check-in writes need `operations` or `pier` | `ckCanEdit`, `ckGuard` (app) | permission | built | edit areas |
| One record per trip, side and slot | `ckRead`, `ckWrite`, `_ckSlot` (app) | computed | built | `PUT /operations/trip-ops/{trip}/checkins/{side}/{slot}` |
| Partial writes keep stage/flow/reinstate/selfAdd | `ckWrite` (app) | auto-change | built differently | a write replaces the record |
| `noShow` = cap − actual, ≥ 0 | `ckStep`, `ckEvSave` (app) | computed | built | `no_show` |
| Counter ceilings: van = booked, pier = expected | `ckStep`, `ckCeil` (app) | refusal | built differently | only `actual_pax`/`expected` ≤ booked |
| Pier expected = booked − van losses | `ckCap`, `pckExpected` (app) | computed | missing | stored as sent [ops] |
| Pier count above expected must say who came alone | `ckSelfOpen`, `ckSelfSave`, `ckSelfTrim` (app) | refusal | missing | `self_add` as sent [data] |
| No-show or on-site cancel: reason, breakdown, ≤ people left | `ckEventOpen`, `ckEvSave` (app) | refusal | missing | events shape-checked only [data] |
| No-show reasons a fixed list; some mean "expected at pier" | `CK_NOSHOW_REASONS`, `ckExpectAtPier` (app) | computed | built differently | `EXPECT_AT_PIER`; `reason_code` not validated [data] |
| Events append-only; undo final | `ckBackSave`, `ckEvLive` (app) | auto-change | built | `409 events_append_only` |
| Old "withdraw last event" | `ckEventUndo` (app) | auto-change | decided not to copy | replaced by §ckBack; append-only |
| Retry attempts appended | `ckTrySave` (app) | auto-change | built | tries |
| Lost by type | `ckLostByType`, `ckPaxLeft` (app) | computed | built | `aboard.ts lostByType` |
| Travel no-show = booked − pier count | `ckSummary` (app) | computed | built | `summaryNoShow` |
| Pier reinstate sets actual = expected = booked | `ckPierReinstate` (app) | auto-change | built differently | counts are the client's |
| Stages wait → arrived → cleared → boarded, in order | `pckStageSet`, `pckStage` (app) | auto-change | missing | no order check [data] |
| A booking cancelled on site to 0 is a closed row | `pckVoidInfo` (app) | computed | missing | [ux] |
| No check-in actions on a cancelled but arranged booking | `ckRowHtml` §strand (app) | refusal | missing | not refused [data] |
| Boarding with money owed asks; never blocks | `pckPayGuard` (app) | warning | built | `GET /v1/pier-money` `due` |
| Paid in full from check-in → checked in | `pckPaySave` §autoCheckIn (app) | auto-change | missing | [ux] |
| Van row status | `vckRowSt` (app) | computed | missing | [ux] |
| Moving a checked-in row back un-checks it first | `vckStatus`, `vckSetFlow` (app) | warning | missing | [ux] |
| Driver arrived at first pickup: stamp; rows go standby; 15-minute wait | `vckArrToggle`, `vckArrFlow`, `vckArrWait` (app) | auto-change | missing | `vck_arrive` has no home [ops] |
| Van tally: no-show / cancel / went to pier / waiting | `renderVanCheckin` §vckArr (app) | computed | missing | `lostByType` not served per van [ops] |
| One van, several boats: join or another run (20 min) | `pckVanBoatSplit`, `_pckSameRun` (app) | computed | missing | [ux] |
| Arrival kind: our van, own, no van | `pckArrivalOf` (app) | computed | missing | [ux] |
| Split bookings: one row per part, losses from the first part, money once | `pckExpandBoatSplits`, `pckExpandVanSplits` (app) | computed | missing | [ux] |
| Pier note per trip-day, history line, no guard | `pckNoteSet` (app) | auto-change | built differently | no history; `operations` only. Not flagged [data] |
| Pier meals capped at booked | `pckMealStep` (app) | refusal | missing | [data] |
| Pier meal save stamps | `pckMealSave` (app) | auto-change | built differently | `special_meals_pier_at/by` |
| "Only one name, N pax" warning | `pckNameCell` (app) | warning | missing | [ux] |
| A no-show with no reason flagged | `pckRowHtml` (app) | warning | missing | [ux] |
| Slip upload ≤ 6 MB | `pckSlipUpload` (app) | refusal | built | `POST /v1/attachments` |
| Add-on list for pier and guide: longtail first, bundle fallbacks | `ckAddonList`, `pckJobAddons` (app) | computed | missing | [ops] |
| Longtail needed per booking and day | `bkLtState`, `pckJobService`, `bkV2AddOnFlags` (app) | computed | missing | [ops] |
| Boat stats after losses: categories, languages, meals, longtail | `pckTripStats`, `pckBoatMeta` (app) | computed | missing | [ops] |
| Guide language text normalised to a code | `pckLangNorm`, `goLangsOf` (app) | computed | missing | stored as typed [data] |
| Guide and service colours; one-time key rewrite | `pckGuideColors`, `pckSvc*` (app) | sweep | missing | [ux] |
| Guide job sheet: bookings with a boat only | `pckGuideJobOrder` (app) | refusal | missing | [ops] |
| Kitchen heads after no-shows; OVN leg only if marked in | `pckMealCount`, `mvLunchRows` (app) | computed | missing | [money] |
| Every OVN return booking marked meal in/out before ordering | `pckMealOvnSet`, `pckMealOvnNeed` (app) | refusal | missing | [money] |
| Send meal order: venue, travellers; saves the trip's meal cost | `pckMealSend`, `mvOrderSlip` (app) | computed | missing | `trip_actuals.meal` no home [money] |
| Kitchen warns when sent ≠ now | `pckKitchenHtml` (app) | warning | missing | [ux] |
| Note to the restaurant per boat-day | `pckMealNoteSave` (app) | auto-change | missing | [ops] |
| Allergy list merged across a boat | `pckAllergyList` (app) | computed | missing | [ops] |
| Guide order number per date and boat from a counter | `goNoFor`, `goCfgNext` (app) | numbering | missing | [data] |
| Guide order counts: travellers, guides, others, crew, seats | `goCounts`, `goSheet`, `goCrewN` (app) | computed | missing | [ops] |
| Guide registry and assignment; one signer kept | `goRegAdd`, `goSgDel`, `goSetupSave` (app) | refusal | missing | [data] |
| Guide-order print warnings | `goPrint` (app) | warning | missing | [ux] |
| Harbour travel register: people, Thai/foreign, nationality codes, crew | `pckTravelRows`, `pckTravelSheet`, `pckNat3` (app) | computed | missing | `GET /v1/manifest` is generic [ops] |
| Company-wide check-in colours and bar style | `vckColorSet`, `vckBarStyleSet` (app) | permission | missing | display config [ux] |

### Check-in and pier: Pier Office, park tickets, roster, licences, job sheet, PR/PO (Findings 1)

| Rule | Legacy (file) | Kind | Status | Here / note |
|---|---|---|---|---|
| Pier Office editing needs `pier` (falls back to `operations` for old logins) | `poCanEdit`, `poGuard` (app) | permission | missing | [ops] |
| Gear stock computed from moves into ready, on-boat, on-ship, dirty, laundry, repair, gone | `poBal` (app) | computed | missing | [ops] |
| "Ready" capped at the registered total | `poReadyShown` (app) | computed | missing | [ops] |
| Gear still out carries to the boat's next day; boat stage | `poBoatCarry`, `poBoatStage` (app) | computed | missing | [ops] |
| Real heads per boat; unassigned heads warned | `poPaxLeft`, `poBoats`, `poUnassigned` (app) | computed | missing | [ops] |
| Issue sheet sizes split in proportion to stock | `poIsDist`, `poIsAuto` (app) | computed | missing | [ops] |
| Commit refused when the size split ≠ totals | `poIsCommit` (app) | refusal | missing | [ops] |
| Over-issue and decreases ask; over-returns moved or cut | `poIsCommit` (app) | warning / auto-change | missing | [ops] |
| Draft sheets save without checks | `poIssueDraft`, `poIsPrint` (app) | auto-change | missing | [ops] |
| Gear deposits: taken, returned, kept, outstanding | `poIsCalc` (app) | computed | missing | [money] |
| Close-out: every missing piece classified | `poCloseSave`, `poMissSum` (app) | refusal | missing | [ops] |
| A lost item carries a fine | `poCloseSave` (app) | computed | missing | nothing settles it [money] |
| Repair: fixed + written off ≤ in repair | `poFixSave` (app) | refusal | missing | [ops] |
| Laundry out/in clamped to balance | `poLaundrySave` (app) | auto-change | missing | [ops] |
| Permanent on-boat kit: qty ≤ ready; un-assign returns all | `poShipSave`, `poUnshipSave` (app) | refusal | missing | [ops] |
| Ledger edits: note (and boat on adjust) only, stamped | `poMoveEditSave` (app) | permission | missing | [data] |
| Towel queue; laundry > 2 days, dirty > 1 day warned | `poTowelQ`, `poLaundryBlock` (app) | warning | missing | [ops] |
| Item kinds: delete refused in use; seeds; name back-fill | `poKindDel`, `poKindSync` (app) | refusal / sweep | missing | [data] |
| Inactive items still count for returns and carry | `poItemsAll` (app) | computed | missing | [ops] |
| Pier staff need a name or nickname | `poStaffAdd`, `paStaffFld` (app) | refusal | missing | [data] |
| Park tickets: heads to 5 ticket types, Thai/foreign split, match petty cash | `pkBkCnt`, `pkTkCatOf`, `pkTkData` (app) | computed | missing | [ops] |
| Park name list matched to heads; mismatches flagged | `pkTkData` (app) | computed | missing | [ops] |
| A typed name unique for the day and pier | `pkNmEdit`, `pkNmNorm` (app) | refusal | missing | [data] |
| Fill from the lead; drop duplicates and orphans | `pkNmFillLead`, `pkNmDropOver` (app) | auto-change | missing | [ops] |
| Per-person ticket type; custom types | `pkFixSet`, `pkTypes` (app) | auto-change | missing | [ops] |
| Park names and overrides older than 120 days deleted | `pkNmSet`, `pkFixSet` (app) | sweep | missing | [data] |
| Job sheet defaults to the standing team | `pjOf`, `pjTeamSave`, `pjTeamPull` (app) | auto-change | missing | [ops] |
| Wristband colour carries 14 days | `pjWbOf` (app) | auto-change | missing | [ops] |
| "Done" lock needs captain, wristband, guide, venue | `pjLockMiss`, `pjLockSet` (app) | refusal | missing | [ops] |
| Copy yesterday skips locked sheets | `pjCopyYday` (app) | auto-change | missing | [ops] |
| A guide holds one slot per boat; busy elsewhere marked | `pjGdPick`, `pjGdBusy` (app) | refusal / warning | missing | `go_asn` no home [ops] |
| Pre-departure board per boat | `pjPrep`, `pjPax` (app) | computed | missing | [ops] |
| Idle boats hidden | `pjIsIdle` (app) | computed | missing | [ux] |
| Programme colour set from the job sheet by a pier editor | `pjProgColor` (app) | permission | built differently | `PATCH /v1/routes/{id}` needs `config` |
| Work code defaults to MT when a job is open | `pjWcAuto`, `paJobKind` (app) | auto-change | missing | [ops] |
| Licence state ok/soon/expired (60 days) | `plState`, `plWarnDays` (app) | computed | missing | [ops] |
| A licence class covers a boat by gt/bhp | `plCovers` (app) | computed | missing | [ops] |
| Crew check per boat-day | `plCheckBoat`, `plBoatBad` (app) | warning | missing | [ops] |
| Licence needs a class; deleting a used class asks | `plSave`, `plClassDel` (app) | refusal / warning | missing | [data] |
| Pay cycle from day N (1–28, default 26) | `paCycle`, `paCycleStart` (app) | computed | missing | [ops] |
| Roster cell: override, sheet, dry-dock, route code, plan | `paCell`, `paDayIdx` (app) | computed | missing | [ops] |
| Route code: `route.code`, else guessed | `paRouteCode`, `paRouteCodeGuess` (app) | computed | missing | `routes` has no `code` [data] |
| Night shift is a second layer | `paSetNight`, `paSetManual` (app) | auto-change | missing | [ops] |
| Range fill skips set cells unless override | `paRangeApply` (app) | refusal | missing | [ops] |
| Row totals: work, off, PH | `paRowTotal` (app) | computed | missing | [ops] |
| Deleting a used code asks; deleting a section unassigns | `paCodeDel`, `paSectDel` (app) | warning / auto-change | missing | [data] |
| PR/PO meal heads per trip; allergy quantities | `ppRows`, `ppAllPax` (app) | computed | missing | differs from `allergy_count` [ops] |
| PR/PO capacity tags per boat-day and pier | `ppCapTag`, `ppPierCapTag` (app) | warning | missing | [seats] |
| Sign-sheet agent colours | `poSignColorSet` (app) | auto-change | missing | [ux] |

## Reconfirm

| Rule | Legacy (file) | Kind | Status | Here / note |
|---|---|---|---|---|
| Status is the contact result; sent fields kept; history line | `rcSetStatus`, `_rcKeepSent` (app) | auto-change | built | `PUT`/`DELETE /v1/bookings/{id}/reconfirm` |
| Send to an agent stamps every live booking of the day | `rcSendAgent`, `rcUnsendAgent`, `rcToggleBooking` (app) | auto-change | built | `POST /v1/reconfirm/sent` |
| An old `done` record counts as sent | `_rcSent` (app) | computed | built | the import |
| Board reconfirm (list/phone) and clear | `bkV2Reconfirm`, `bkV2ReconfirmClear` (app) | auto-change | built | `via` |
| Reconfirm all of a trip, skipping closed and done | `bkV2ReconfirmAll` (app) | auto-change | built differently | one `PUT` per booking |
| Writes go through `operations` or `accounting` | `rcSetStatus` → `acctPersistBookings` (app) | permission | built differently | `operations` only. Not flagged |
| Re-confirm status colours | `rcSaveStatusColor` (app) | auto-change | missing | [ux] |

## Upgrades and add-ons

| Rule | Legacy (file) | Kind | Status | Here / note |
|---|---|---|---|---|
| Route upgrade refused: no seat trip, charter, overnight, lock draw, no reason, too few seats | `bkV2BoatUpgrade`, `bkV2UpgApply` (app) | refusal | built | `POST /v1/bookings/{id}/upgrade` |
| Targets: other open routes with a boat; confirm | `bkV2UpgTargets`, `bkV2UpgModal` (app) | warning | built | server refuses `route_not_sailing`, `not_enough_seats` |
| A charge becomes an upgrade sale; boat cleared; history | `bkV2UpgApply` (app) | auto-change | built | `routeUpgradeSale`, `routeUpgradeLine` |
| Undo: origin must have seats; uncollected charge removed | `bkV2UpgUndo` (app) | refusal | built | `…/upgrade/undo` |
| An upgrade is in force only while the trip is on its to-route and date | `bkUpgActive` (app) | computed | missing? | `activeUpgrade` checks only `undone_at`; a `PATCH` move keeps it [money] |
| An upgraded trip is priced on the route it was sold on | `bkV2PrRoute`, `bkV2WithSold` (app) | computed | missing? | `pricing.ts` prices the trip's current route [money] |
| Upgrade note in special requests | `bkUpgNote`, `tsSreqOf` (app) | computed | built differently | `operations.upgrade`, not in `special_request` [ux] |
| Upgrading needs `operations` | `bkV2BoatUpgrade` (app) | permission | built | `writeNeed` |
| Upgrade sale: sell price > 0; commission = sell − to-company | `bkV2UpgradeSave`, `bkV2UpgradeRecalc` (app) | refusal | built | booking `upgrades` |
| Upgrade card fee capped at 5% | `bkV2ExtraSetPct` (app) | computed | built differently | `fee_pct` up to 100 (`upgrades.ts`). Not flagged [money] |
| "Collected" ticked freely | `bkV2UpgradeSave` (app) | auto-change | built differently | only via `…/collect` (Flagged) |
| Upgrade id, `settle`, history | `bkV2UpgradeSave` (app) | numbering | built | README "Upgrades" |
| Longtail join starts at every passenger; qty ≥ 1 | `bkV2ToggleAddOn`, `bkV2SetAddOnQty` (app) | computed | built | README "Add-ons" |
| Add-on service: name; variant name; delete warns with agents using it | `aosSaveModal`, `aosDeleteService` (app) | refusal / warning | built differently | `/v1/addon-services`; no per-agent link |
| Per-agent add-on prices | `agpAddonAddService` (app) | auto-change | decided not to copy | README "Agents": "legacy never saved them" |

## Weather

| Rule | Legacy (file) | Kind | Status | Here / note |
|---|---|---|---|---|
| Close a route-day; tag non-charter bookings awaiting; history | `bkV2WeatherCancel`, `bkV2WeatherTagBookings` (app) | auto-change | built differently | `POST /v1/weather-closures`; list computed, charters included (Flagged 9, 12) |
| Notify agent | `bkV2WeatherNotify` (app) | auto-change | built | `…/notify` |
| Resolve reschedule with no checks | `bkV2WeatherResolveOne` (app) | auto-change | built differently | ordinary reschedule (Flagged 5) |
| Resolve cancel/refund/credit; refund voids the whole invoice | `bkV2WeatherResolveOne` (app) | computed | built differently | this booking's share only (Flagged 1, 2) |
| Undo closure; resolved bookings kept | `bkV2WeatherUncancel` (app) | warning | built differently | reopened (Flagged 11) |
| Closure writes need `operations` | `sbWeatherPersist` (app) | permission | built | README "Weather" |
| Closed trips greyed on calendars and the Action Board | `renderCal`, `_abScan` (core, ab) | computed | built | `GET /v1/weather-closures` |

## Money: invoices and payments

| Rule | Legacy (file) | Kind | Status | Here / note |
|---|---|---|---|---|
| Invoice total = booking + fees; VAT include/exclude/none | `acctBookingTotal`, `acctCreateInvoice`, `acctInvRecalc` (app) | computed | built | `POST /v1/invoices` |
| Number `INV-YYMM-NNNN` | `acctNextInvoiceNo` (app) | numbering | built | server counter, Bangkok month |
| Due date = credit days, else 30 for invoice agents, else now | `acctCreateInvoice`, `acctNewInvoiceCreate` (app) | computed | built | `invoices.ts dueDays` |
| Fee invoice: no VAT, due now, whole baht | `acctCreateFeeInvoice` (app) | computed | built | made by cancel |
| Paid, balance, state | `acctInvoicePaid`, `acctInvoiceState` (app) | computed | built | `invoiceState` |
| Issue needs a booking; lists only live, uninvoiced ones | `acctNewInvoiceRender`, `acctNewInvoiceCreate` (app) | refusal | built | `400`; `booking_already_invoiced`. No "not invoiced" filter on bookings [ux] |
| Record payment: amount > 0, default = balance | `acctRecordPayment`, `acctPaySubmit` (app) | refusal | built | `POST /v1/invoices/{id}/payments` |
| Void unlinks the bookings | `acctVoidInvoice` (app) | auto-change | built | `…/void` |
| Header fields and WHT, `accounting` | `acctInvSet` (app) | permission | built | `PATCH /v1/invoices/{id}` |
| Line discount refused once paid; ≤ gross; VAT from the issue amount | `acctInvDisc` (app) | refusal | built | `PUT …/discounts` |
| Invoice document: pre-VAT per line, baht in words | `acctInvoiceDocHtml`, `_acctBahtText` (app) | computed | missing | [ux] |
| Invoice header settings (seller, tax id, bank) | `acctInvCfg`, `acctInvCfgSet` (app) | permission | missing | [data] |
| Manual deposit: agent, amount > 0 | `acctDepositSubmit`, `acctCreateDeposit` (app) | refusal | missing | `money-model.md` Open 1 [money] |
| Pay an invoice from deposits, first in first out | `acctPayUseDeposit`, `acctApplyDeposit` (app) | auto-change | built differently | weather credits only (`method: credit`) |
| Payment ids | `acctApplyDeposit` (app) | numbering | built | server ids |
| Agent credit used and available | `agCreditState` (app) | computed | built | `GET /v1/agents/{id}` `credit` |
| Money writes need `accounting`; booking money `operations` or `accounting` | `sbInvoicesPersist`, `acctCanEditBookings` (app) | permission | built | `writeNeed` |
| Manual "credit balance remaining" field | `agEditSave` (app) | computed | built differently | computed `credit` |

## Money: PFM

| Rule | Legacy (file) | Kind | Status | Here / note |
|---|---|---|---|---|
| In scope: proforma agents plus a prepaid credit booking | `pfmInScope`, `pfmIsCreditPrepaid` (app) | computed | built | `GET /v1/pfm` |
| Cutoff 18:00 the day before | `pfmCutoff` (app) | computed | built differently | from the booking's first trip (Flagged) |
| Amounts: booking total and invoice balance | `pfmChartBuckets`, `renderDailyPFM` (app) | computed | built differently | the invoice's (Flagged) |
| Chart buckets | `pfmChartBuckets` (app) | computed | decided not to copy | `money-model.md` Flagged |
| Prepay: invoice agent, no invoice, live, total > 0; issued with the payment | `pfmPrepayCands`, `pfmRecSubmit` (app) | refusal / auto-change | built differently | two calls, not atomic |
| Issue refused when invoiced; COT deduct warned | `pfmIssueInvoice`, `pfmCotWarn` (app) | refusal / warning | built differently | the invoice subtracts the deduct |
| Record payment needs an invoice | `pfmRecordPayment` (app) | refusal | built | payments hang off an invoice |
| Slip ≤ 6 MB | `pfmSlipUpload` (app) | refusal | built | `POST /v1/attachments` |
| Payment correction: `accounting`, amount > 0, overpay asks | `pfmEditSubmit` (app) | refusal / warning | built differently | `…/payment-corrections`; deleted payments kept |
| Void refused while payments remain | `pfmEditVoidInvoice` (app) | refusal | built differently | `…/void` voids with payments. Not flagged |
| Extend and Hold past cutoff | `pfmApproveTravel`, `pfmHold` (app) | auto-change | built differently | one may replace the other (Flagged) |
| Remind | `pfmRemindAll` (app) | auto-change | built | `POST /v1/pfm/remind` |
| Booking payment slips: attach, delete | `pfmSlipsAttach`, `pfmSlipDelete` (app) | auto-change | missing | `booking-extras-model.md` Open 1 [money] |
| PFM report totals | `pfmPrintReport` (app) | computed | built | `GET /v1/pfm` |

## Money: pier money

On-tour sales, pier payments, and the pier petty-cash book (`pc*`, `po_cash_*`).

| Rule | Legacy (file) | Kind | Status | Here / note |
|---|---|---|---|---|
| Owed at the pier: COT, upgrades, B2C balance, cot sales; OVN leg 0 | `pckMoney`, `pckPaidSum` (app) | computed | built | `pier-money.ts pierMoney` |
| A sale is collected unless cot and unsettled | `bkxExGot` (app) | computed | built | `collected_at` |
| Payment term: B2C its own, else the agent's | `pckMoney`, `pckCotUnset` (app) | computed | built | `term` |
| Pier payment: 0 lines dropped, card fee, overpay asks, history | `pckPaySave`, `pckLineFee` (app) | refusal | built | `…/pier-payments` |
| Delete a pier payment | `pckPayDel` (app) | warning | built differently | kept with `deleted_*` (Flagged) |
| Attach a slip later | `pckPayAddSlip`, `tsSlipPick` (app) | auto-change | built | `…/slips` |
| Pier payment rights | `pckPaySave` (app) | permission | built differently | pier/operations/accounting (Flagged) |
| Sale: price > 0, qty ≥ 1, commission = total − to-company | `bkV2ExtraSave`, `bkV2ExtraRecalc` (app) | refusal | built | `…/tour-sales`; above total refused (Flagged) |
| Card fee to the satang, ≤ 5% | `bkV2ExtraFee`, `bkV2ExtraSetPct` (app) | computed | built | over 5% refused (Flagged) |
| Transfer or card with no slip asks | `bkV2ExtraSave` (app) | warning | built | `no_slip` |
| cot = not collected; other methods collected now | `bkV2ExtraSave` (app) | auto-change | built | server owns `settle` |
| Collect a cot sale | `bkV2ExtraCollect` (app) | auto-change | built | `…/collect` |
| Sale day | `bkV2ExtraDayOf` (app) | computed | built | `trip_date` |
| Sale history lines | `bkV2ExtraSave` (app) | auto-change | built | README "Pier money" |
| On-tour sale writes need `operations` | `sbExtrasPersist` (app) | permission | built | `writeNeed` |
| Cash book per pier: in/out rows, amount > 0, whole baht | `pcRowAdd`, `pcRowSave` (app) | refusal | missing | [money] |
| Opening balance = every earlier day's net | `pcOpening`, `pcTotals` (app) | computed | missing | [money] |
| "Pull into book" adds one out-row per category, once | `pcPull` (app) | auto-change | missing | [money] |
| Longtail sheet per day and boat | `pcSheetLT`, `pcLtUsed` (app) | computed | missing | [money] |
| Park-fee headcount by Thai/foreign × type | `pcPax`, `bkNatTH` (app) | computed | missing | `t.nat` no home [money] |
| Park rates from the cost plan; fallbacks | `pcParkRate`, `pcParkAmt` (app) | computed | missing | [money] |
| Expected park fee; diff = paid − expected | `pcSheetPK`, `pcDiffCell` (app) | computed | missing | [money] |
| Fill keyed counts from the computed set | `pcFillPK` (app) | auto-change | missing | [ux] |
| Pier cash edits need pier rights | `pcGuard` (app) | permission | missing | [money] |
| `po_cash_*` strings migrated into rows on open | `pcRowsMigrate` (app) | sweep | missing | no import either [data] |

## Money: cash on tour and after the trip

| Rule | Legacy (file) | Kind | Status | Here / note |
|---|---|---|---|---|
| No-show decision: full = trip amount; partial; none; postpone | `tsSet`, `tsTripAmount` (app) | computed | built | `PUT …/noshow-charges/{date}` |
| A booking needs a no-show decision when anyone didn't travel | `tsRows` (app) | computed | built | travel-summary `noshow` |
| COT modes full/part/none/payout/nocol; amounts worked out | `tsCotPick`, `tsCotAmt` (app) | computed | built | `PUT …/cot-decisions/{date}` |
| Suggested mode; "nobody travelled → nocol" | `tsCotSugMode` (app) | computed | built differently | handling only; nocol suggestion missing [ux] |
| nocol reason pre-filled from check-in | `tsCotWhySug` (app) | computed | missing | [ux] |
| Deduct + payout above COT warned | `tsCotCell`, `tsRowFlags` (app) | warning | built | `cot_over` |
| Slips survive a mode change; attach needs a decision | `tsCotSlipPick` (app) | refusal | built | `slip_ids` |
| A COT deduction only warned (collected twice) | `tsCotCell` (app) | warning | built differently | the invoice subtracts it (Flagged) |

## Money: van bills

| Rule | Legacy (file) | Kind | Status | Here / note |
|---|---|---|---|---|
| Rows per day/route/van; no-shows shared over splits | `vbRows` (app) | computed | built | `van-bills.ts` |
| Return van merges; return-only row | `vbRows` §vbRetMerge (app) | computed | built | README "Partner van bills" |
| Route codes; periods; bill key | `VB_CODE`, `vbPeriod`, `vbKey` (app) | computed | built | same |
| Amounts: rate, extras, cuts, sale | `vbAgg`, `vbRateOf` (app) | computed | built | same |
| Inputs strip the sign | `vbSet`, `vbSetRow` (app) | auto-change | built differently | negatives `400` (Flagged) |
| Filled cells locked until Edit | `vbCanSet`, `vbEdit` (app) | warning | built differently | a paid bill is locked instead [ux] |
| Rows seen; later rows flagged new | `vbSave` (app) | computed | built | `mark_seen` |
| Pull rates | `vbPullRates` (app) | auto-change | built | `…/pull-rates` |
| Van bill writes need `accounting` | `vbPersist` (app) | permission | built | `writeNeed` |
| Rate group own or partner | `vanGroupKey` (app) | computed | built | `van-bills.ts` |
| Day rate fallbacks (฿900 own, ฿1,800 partner) | `vanRate` (app) | computed | built | `vanRate` |
| A van's own `costPerDay` | `vanDayCost` (app) | computed | decided not to copy | `money-model.md` Flagged |
| Van rates editable by anyone | `vanRateSet` (app) | permission | built differently | `accounting` or `fleet` (Flagged) |

## Money: reports

| Rule | Legacy (file) | Kind | Status | Here / note |
|---|---|---|---|---|
| Accounting KPIs, aging, collections, top 5 | `renderAccounting`, `acctDashboardHtml` (app) | computed | built | `GET /v1/reports/accounting` |
| Agent statement | `acctStatementOpen` (app) | computed | built | `GET /v1/agents/{id}/statement` |
| Agents over their credit limit | `_dashBoardData` (core) | computed | built | `credit.over` per agent |
| Travel Summary rows; travelled; no-collect; settle; sales; net | `tsRows`, `tsNoCollect`, `tsMoneyOf`, `tsSaleList` (app) | computed | built | `GET /v1/reports/travel-summary` |
| Day-close checklist | `tsV6Checks` (app) | computed | built | counts served |
| Daily settings: van cost, quota, target | `drCfg`, `drCfgSet` (app) | computed | built | `PUT /v1/reports/daily/settings` |
| Daily van cost | `drVanReal` (app) | computed | built differently | every van part (Flagged) |
| Daily revenue by route, market, channel, agent | `drData`, `drMarket` (app) | computed | built | `GET /v1/reports/daily` |
| Travel Summary scope by pier, route, VAT; document number | `tsScopeKeep`, `tsVatMode` (app) | computed | missing | `date` only [ux] |
| Cancelled and moved-out bookings of the day | `tsCxlRows`, `tsMvRows` (app) | computed | missing | [ux] |
| Rate-check "Net" per trip | `tsNetOf` (app) | computed | built differently | `priceBooking`; check figure not served |
| Close-day special request strips the COT chunk | `tsSreqOf` (app) | computed | built differently | no stripping [ux] |
| Slip and reference packs | `tsSlipPackList`, `tsRefPackList` (app) | computed | missing | [ux] |
| Daily Report operations side | `drData`, `drPane*` (app) | computed | missing | not in Money [ops] |
| Longtail count and cost; net before boat costs | `drLtRate`, `drPaneFi` (app) | computed | missing | waits for Fleet [money] |
| 14-day trend by market | `drTrend`, `drTrendBooked` (app) | computed | missing | [ux] |
| Daily Report email settings; chart images | `drMailCfg`, `drmUpload` (app) | auto-change | missing | `/api/mailimg` (`legacy-replacement.md` Open) [ux] |
| "Not yet billed" alert across PFM and invoices | `_dashBoardData` (core) | computed | missing | [ux] |
| Live feed by entered day, B2B vs B2C; internal-free skipped | `_dashLiveFeedHtml`, `_ddSum` (core) | computed | missing | [ux] |
| Internal ฿0 bookings left out of sales totals | `laIsInternalFree` (core) | computed | missing | [money] |
| Dashboard KPIs | `renderDash` (core) | computed | missing | [ux] |
| Agent's recent bookings by month and route | `agSumRows`, `agSumBlock` (app) | computed | missing | [ux] |
| Ops deck: real heads, fill, trips run, B2B/B2C, deltas | `repOpsGather` (app) | computed | missing | [ux] |
| Fleet deck: availability, repairs, memo spend, hours, stock | `repFleetGather` (app) | computed | missing | memo-spend only [ux] |
| B2B dashboard: windows, classes, revenue bridge | `b2dLines`, `b2dCls`, `b2dBridge` (app) | computed | missing | [ux] |
| Market intelligence import and analytics | `mdIngest`, `mdTabSales`, `pmapAgg` (app) | computed / sweep | missing | `sb_market_*` no home [data] |

## Money: costing (all wait for Fleet, `money-model.md` Open 1)

| Rule | Legacy (file) | Kind | Status | Here / note |
|---|---|---|---|---|
| Cost template lines with fixed, per-head and step parts; VAT reclaim | `CT_DEFAULT`, `ctTpl`, `ctVatR` (app) | computed | missing | [money] |
| Back-fill default lines; on-demand seeds | `ctTplFill`, `ctTplOdSeed` (app) | sweep | missing | [data] |
| Line amount maths | `ctPartAmt`, `ctEffLine` (app) | computed | missing | [money] |
| Children split by the boat's mix | `ctPaxSplit`, `ctChdAt` (app) | computed | missing | [money] |
| Plan category toggles, ±%, overrides | `ctGrpCfg`, `ctOvrSet` (app) | computed | missing | [money] |
| Trip cost gross, VAT, net, fixed, variable | `ctCalc` (app) | computed | missing | [money] |
| On-demand lines (van, longtail) | `ctOdQty`, `ctOdRev` (app) | computed | missing | [money] |
| Boat rent per trip; rented boat swaps cost lines | `ctRentOf`, `ctRentActiveOn` (app) | computed | missing | [money] |
| Per-boat fuel multiplier | `ctBoatFuelMul` (app) | computed | missing | [money] |
| Profit at n pax, break-even | `ctProfitAt`, `ctBreakEven` (app) | computed | missing | [money] |
| Plan seats, pax ≥ 1, one plan kept, one plan per route | `ctPlanSeats`, `ctDelPlan`, `ctFamSetPlan` (app) | refusal / auto-change | missing | [data] |
| Plans from `cost_overrides` on first load; ids | `ctPlans`, `ctNewId` (app) | sweep / numbering | missing | [data] |
| Linking a plan needs `accounting` | `ctFamSetPlan` (app) | permission | missing | [money] |
| Five price tiers from the plan price | `ctTierSeed`, `ctTiers` (app) | computed | missing | [money] |
| Rent span, seasons, idle rent, fact sheet | `ctRentSpan`, `ctRentIdle`, `ctFactSheet` (app) | computed | missing | [money] |
| Meal venues: defaults, ids, caps | `mvAdd`, `mvSet` (app) | numbering | missing | `legacy-replacement.md` §2 [money] |
| Route default meal venue | `mvRouteSet`, `mvForRoute` (app) | auto-change | decided not to copy | `meal_venue_id` "moves with costing" (`catalogue.ts`) |
| Trip meal venue and cost | `mvForTrip`, `mvCost` (app) | computed | missing | [money] |
| Trip P&L heads, longtail, upsell, van cost, plan lookup | `pxPax`, `pxLongtail`, `pxUpsell`, `pxVanCost`, `pxPlanFor` (app) | computed | missing | [money] |
| Trip P&L: actuals beat estimates; profit | `pxTrip` (app) | computed | missing | [money] |
| A boat with no pax did not sail, unless "sailed anyway" | `pxRan` (app) | computed | missing | [money] |
| Close a trip freezes it; needs `accounting` | `pxClose`, `taSet` (app) | auto-change / permission | missing | `trip_actuals` no home [money] |
| Day, month, analysis totals; regression break-even; revenue flags | `pxDayAgg`, `pxAnalysis` (app) | computed | missing | [money] |
| Unabsorbed boat rent | `pxRentIdle` (app) | computed | missing | [money] |
| Pier staff trip allowance per cycle | `paPayOf`, `PA_PAY_DEF` (app) | computed | missing | [money] |
| WS minimum rate by slot | `paWsTier`, `paWsMin` (app) | computed | missing | [money] |
| WS-LT days | `renderPierAtt` (app) | computed | missing | [money] |
| Pay seen and edited by pier editors; rates ≥ 0 | `paPayCan`, `paPaySave` (app) | permission | missing | [money] |
| Pay config migrations | `paEnsureLtSplit`, `paEnsureWsLt` (app) | sweep | missing | [data] |

## Sales, agents and contracts

| Rule | Legacy (file) | Kind | Status | Here / note |
|---|---|---|---|---|
| Create agent: name, legal name, address, market, rate, pay type, VAT | `agCreateSubmit` (app) | refusal | built | `POST /v1/agents` |
| Duplicate check on create | `agFindDup`, `agNewDupCheck` (app) | warning | built | `409 possible_duplicate` / `create_anyway` |
| Code, credit, signatory, phone defaults | `agCreateSubmit` (app) | auto-change | built | `planAgentCreate` |
| New agent's programmes = the rate's routes | `agProgFill` (app) | auto-change | built | `POST /v1/agents` |
| Changing salesperson clears another's rate | `agNewSetSales` (app) | auto-change | built differently | `400` (Flagged) |
| Sub-market joins its market | `agSubMarketRemember` (app) | auto-change | built | README "Salespeople and markets" |
| Company save needs name and legal name | `agEditSave` (app) | refusal | built | `PATCH` |
| No salesperson asks | `agEditSave` (app) | warning | built | `sales_id: null` allowed |
| Rate change syncs main contracts and programmes | `_ctSyncMainRate`, `agProgSyncOnRate` (app) | auto-change | built | `PUT …/rate-type` |
| Manual "sync to bound rate" | `agAlertSyncRate` (app) | auto-change | missing | [data] |
| Programme travel dates from the rate | `agEditRenderPP` (app) | computed | built | not stored |
| New programme window defaults to a fixed year; duplicates allowed | `agEditPPAdd` (app) | auto-change | built differently | client window; a route twice `400`. Not flagged [data] |
| Delete agent: admin, even in use | `agDelete` (app) | permission | built differently | `409 in_use` (Flagged) |
| "Clear agents" cascades to bookings and locks | `agClearExecute` (app) | auto-change | built differently | no cascade |
| Table cell edit, bulk set, fill-down | `agTblEdit`, `agBulkApply`, `agFillDown` (app) | auto-change | built differently | per agent [ux] |
| Bulk fill programmes to the rate | `agProgBulkPlan`, `agProgBulkApply` (app) | auto-change | missing | [data] |
| Programme picker pre-ticks the rate's routes | `agProgPicker` (app) | auto-change | built | add priced routes |
| Incomplete profile fields | `agIncompleteFields` (app) | computed | built | `incomplete` |
| Gap filters: VAT, document fields | `agGapCounts` (app) | computed | missing | [ux] |
| Health flags and KPI counts | `agHdIssues`, `renderAgKPI` (app) | computed | missing | [ux] |
| Alerts: credit ≥ 80% or over; contract expiring; rate not started | `agAlerts` (app) | warning | built differently | credit built; the rest missing [ux] |
| Contracts expiring ≤ 30 days badge; ≤ 60 days | `agUpdateExpiringBadge`, `ctIsExpiringSoon` (app) | computed | missing | `contract_status` stored [ux] |
| Contract status from dates: void, expired, scheduled, active | `_ctContractStatus` (app) | computed | missing | stored (`contracts.ts`) [data] |
| Main-contract sync skips expired ones | `_ctSyncMainRate` (app) | auto-change | built | `mainContractsToSync` |
| Sales-bound login sees only its own agents | `laSalesScoped`, `agTblRows` (app) | permission | built | README "Agents" |
| Agent writes need `sales` | `sbAgentsPersist`, `agTblEdit` (app) | permission | built | README |
| Excel agent import: match, update empty fields, create with codes | `agImportFile`, `agImportComputeWrites`, `_agImpCode` (app) | computed / numbering | missing | [data] |
| Add or edit a promo: dates, routes, priority, periods | `ctSaveAddPromo`, `ctOpenAddPromo` (app) | refusal | missing | `contracts-model.md` [money] |
| Own-price promo: zones with an adult price, ≥ 1 route | `ctSaveAddPromo`, `ctPromoTbl` (app) | refusal | missing | [money] |
| Discount promo: value > 0, % < 100, amount below the cheapest price | `ctSaveAddPromo`, `ctPromoDiscPrev` (app) | refusal | missing | [money] |
| Rate-mode promo needs a rate; buy-N needs N ≥ 1 | `ctSaveAddPromo` (app) | refusal | missing | [money] |
| Editing a promo sold on N trips asks | `ctSaveAddPromo` (app) | warning | missing | [ux] |
| Void a promo (sales) | `ctVoidContract` (app) | permission | missing | [money] |
| Renewal defaults: start, end, version | `ctOpenRenewal`, `ctRenewPeriodPreset` (app) | computed | missing | client sends them [ux] |
| Renewal: archive, new contract, shift windows, sync rate | `ctRenewNext`, `ctRenewActivate` (app) | refusal | built | `POST /v1/agents/{id}/renew` |
| On load: contract defaults; credit balance 70% of limit | `_seedAgentContractDefaults` (app) | sweep | built differently | new agent today → a year; `credit_balance` is weather credit |
| On load: migrate contracts | `_sbMigrateContracts` (app) | sweep | built | `import:contracts` |
| On load: seed house agents and markets | seed IIFEs (app) | sweep | built | `HOUSE_AGENT_IDS` |
| Agent and vehicle logs capped | `agLog`, `vehLog` (app) | auto-change | built differently | kept whole, `?limit` |
| Issue a contract document; capped at 20 | `ctDocOpen`, `ctArtifactSave` (app) | auto-change | built differently | stored as sent; all kept (Flagged) [ux] |
| Remove a document | `ctArtifactRemove` (app) | auto-change | built | `DELETE /v1/contract-documents/{id}` |
| Template for an agent | `ctTmplForAgent` (app) | computed | built | `contract_template_effective_id` |
| Templates: one default, rules | `cttSetDefault`, `cttDelete`, `cttNew` (app) | refusal | built | README "Contract templates" |
| Template writes need `sales` | `ctTmplPersist` (app) | permission | built | README |
| Salesperson code and name required, code unique | `tmSaveModal` (app) | refusal | built | `POST`/`PATCH /v1/sales` |
| Deleting a salesperson unassigns their agents | `tmDeleteSales` (app) | warning / auto-change | built | `DELETE /v1/sales/{id}` |
| Market id unique; delete refused while used | `tmSaveModal`, `tmDeleteMarket` (app) | refusal | built | `/v1/markets` |
| Signature upload shrunk and made transparent | `tmUploadSignature` (app) | auto-change | built differently | ≤ 1 MB data URL |
| Salespeople writes need `sales`, markets `config` | `sbSalesPersist`, `sbMarketsPersist` (app) | permission | built differently | both `config` (decision 2) |
| Inactive salespeople hidden from pickers | `sbSalesActive`, `_abSalesList` (app, ab) | computed | built | `active` |
| Staff welfare quota: used FOC this year, remaining | `staffWelfareUsed`, `staffRemaining` (app) | computed | missing | `sales-editing-model.md` Open 1 [money] |
| Staff registry: id, code, quota 3, delete asks | `staffAdd`, `staffSetQuota`, `staffDelete` (app) | numbering / refusal | missing | [data] |
| Internal report | `laInternalReport`, `staffTripsReport` (app) | computed | missing | [ux] |
| Monthly pax per salesperson and agent; targets; streak; trend | `salesPaxAgg`, `salesSetTarget`, `salesStreak`, `agentTrend` (core) | computed / permission | missing | `sales-editing-model.md` Open 2 [ux] |
| Sales Board | `renderSalesBoard` (app) | computed | missing | [ux] |
| Action Board agent stats and lists (top, gone, steady, cancel spike) | `_abAgentStats`, `abRender` (ab) | computed | missing | [ux] |
| Insurance per passenger: age, reviewed | `insSetField`, `insToggleReviewed` (app) | auto-change | built | `PUT /v1/bookings/{id}/insurance` |
| Insurance name and nationality overrides | `insSetField`, `insRevertRow` (app) | auto-change | decided not to copy | `sales-editing-model.md` Flagged |

## Catalogue

| Rule | Legacy (file) | Kind | Status | Here / note |
|---|---|---|---|---|
| Day status: override, then the earliest covering season; outside seasons closed | `getDayStatus` (core) | computed | built | `calendar.ts routeCalendar` |
| Clicking a day flips its override | `toggleDayOverride` (core) | auto-change | built differently | explicit `PUT`/`DELETE …/days/{date}` |
| Closing a day with bookings asks "Close anyway" | `toggleDayOverrideGuarded`, `progConfirmCloseAnyway` (core) | warning | built differently | `close_anyway`, from today (README "Editing the calendar") |
| Deleting a season is a plain confirm | `delSeason` (core) | warning | built differently | asks when days would close |
| A season needs both dates, from ≤ to | `saveNewSeason` (core) | refusal | built | `400` |
| Season id | `saveNewSeason` (core) | numbering | built differently | `season_<uuid>` |
| New route: id, colour, times, name; land; family | `saveRoute`, `openRouteModal` (core) | numbering | built | `POST /v1/routes` |
| Delete a route with no in-use check | `delRoute` (core) | warning | built differently | `409 route_in_use` |
| Reorder routes and markets | `stApplyRouteOrder`, `tmApplyMarketOrder` (core) | auto-change | built | `POST /v1/routes/order`, `PUT /v1/markets/order` |
| Route kind; land kept off boat screens | `laRouteKind`, `laIsLandRoute` (core) | computed | built | `?kind=marine` |
| Route order by pier rank, sort, position | `laRouteOrd` (core) | sweep | built differently | `sort`; grouping the client's |
| Hard-coded default routes and boats | `loadData`, `DEFAULT_ROUTES` (core) | sweep | built differently | seeded from legacy |
| Boat inline edits: capacity > 0, name, type, colour | `confirmCap`, `confirmName`, `flSetBoatColor` (core) | refusal | built | `parseBoatInput` |
| Boat form defaults; total persons | `saveBoat`, `fmCalcTotal` (core) | computed | built | `POST /v1/boats` |
| Boat and status ids | `saveBoat`, `saveStatus` (core) | numbering | built | server ids |
| A new boat's log starts with its status; an edit adds an entry | `saveBoat` (core) | auto-change | built | `withFormStatus` |
| Daily Availability template, route short names, calendar labels | `daSaveTemplate`, `daEditRouteName`, `calEditRouteName` (core) | auto-change | missing | not in `legacy-replacement.md` [ux] |
| A route's pricing zones follow its pier | `rtZonesForRoute` (app) | computed | built | `rate-types.ts` |
| Pickup profile: name, dates, id, clone | `psuSaveProfile` (app) | refusal / numbering | built | `POST /v1/pickup-time-profiles` |
| A profile overlapping another warns | `psuSaveProfile` (app) | warning | missing | [ux] |
| Pickup area: name, group, id; empty cells from a sibling | `psuSaveArea`, `_psuInheritTimesForArea` (app) | refusal / auto-change | built | `/v1/pickup-areas`, `inheritedCells` |
| Delete an area | `psuDeleteArea` (app) | auto-change | built differently | inactive (D2) |
| Empty time cell deleted | `psuSetTimeCell` (app) | auto-change | built | `DELETE …/times/…` |
| Pickup time lookup | `psuResolveProfile`, `bkV2GetPickupTime` (app) | computed | built | `GET /v1/pickup-time` |
| On load: times expanded; flat table → profile | `_psuExpandTimesToAreas`, `_migratePickupTimesToProfile` (app) | sweep | built differently | `prof-legacy-flat` (D4) |
| A split pickup with no area takes the booking's, marked inherited | `bkV2SplitArea` (app) | computed | built differently | no `inherited` mark |
| Route family: `familyId`, else guessed; backfill | `bkV2RouteFamily`, `bkV2BackfillRouteFamilies` (app) | sweep | built differently | stored and seeded |
| Custom nationality: cleaned, ≥ 2 letters, reused, code | `bkV2AddCustomNat` (app) | numbering / refusal | built | `POST /v1/nationalities` |
| Junk nationalities purged, duplicates merged into bookings | `bkV2CleanupNats` (app) | sweep | missing | "a later decision" (README) [data] |
| Nationality learning table | `natLearnRecord`, `natLearnGuess` (app) | sweep | decided not to copy | `legacy-replacement.md` "Not replaced" |

## Fleet

Fleet maintenance is mostly built (`fleet-maintenance-model.md` parts A and B). Rows the note
already records are cited; "not flagged" means it does not.

| Rule | Legacy (file) | Kind | Status | Here / note |
|---|---|---|---|---|
| Fleet writes need `fleet` (legacy refuses silently) | `flSave` (fleet) | permission | built differently | `403` (Flagged part B) |
| Daily Log water, issues, extras, requests accept `fleet` or `operations` | `_flJsonSave`, `flIssueQuickOpen`, `flReqOpen` (fleet) | permission | built | `users.ts` |
| Board edits need `fleet` | `flBoardCanEdit` (fleet) | permission | built | `PATCH /v1/fleet/jobs/{id}` |
| Merge's empty `laGuardEdit` | `invDupMerge` (fleet) | permission | built | `…/merge` needs `fleet` |
| Engine hours = base + latest − first meter reading | `flEngHours` (fleet) | computed | built | `fleet-assets.ts engineHours` |
| Engine service countdown | `flEngServiceState` (fleet) | computed | built | `engineService` |
| Engine service due = ceil(hours/interval) × interval (old tab) | `renderFleetTab` (core) | computed | built differently | last service + interval. Not flagged |
| Gearbox lifetime hours and service (200 default) | `flGbLifetimeHours`, `flGbServiceState` (fleet) | computed | built | `gearboxLifetime` |
| Propeller lifetime hours | `flRenderPropDetailPink` (fleet) | computed | missing | [ux] |
| Log a service: hours ≥ 0 | `flEngMarkService`, `flGbMarkService` (fleet) | refusal | built | `…/service` |
| Gearbox interval a whole number > 0 | `flGbSetInterval` (fleet) | refusal | built | `intOf` |
| Closing a service job asks to reset baselines | `flMaintServiceReset` (fleet) | warning | built | `reset_service` |
| Manual reset refuses a non-service job | `flMaintServiceResetManual` (fleet) | refusal | built | `409 not_a_service` |
| Engine status change logged with hours | `flChangeEngStatus` (fleet) | auto-change | built | `…/status` |
| Bay swap and remove | `flEquipSwapDo`, `flEquipRemove` (fleet) | auto-change | built | `…/swap`, `…/remove` |
| Per-asset cost share (lifetime, YTD) | `flMaintCostShare` (fleet) | computed | missing | [ux] |
| Thai `spareLocation` labels rewritten to keys on load | flLoad hook (fleet) | sweep | missing | free text; `/move` misreads a Thai label [data] |
| Engine status self-heal: fixing with no job → ready | flLoad hook (fleet) | sweep | built differently | only job start/close; drift not repaired. Not flagged [data] |
| Board lane; silent days; blocks boat | `flBoardLane`, `flBoardSilent` (fleet) | computed | built | `jobLane`, `silentDays` |
| Board order, header numbers | `flBoardJobs`, `flBoardScan` (fleet) | computed | missing | [ux] |
| Card save, lane drop, park, steps; lines copied to the incident | `flBoardSaveCard`, `flBoardDrop`, `flBoardPark`, `flBoardSub*`, `flBoardLog` (fleet) | auto-change | built | `PATCH`, `…/steps`, `…/log` |
| Drag a boat's group to a lane | `flBoardDrop` (fleet) | auto-change | built differently | per job; no "ยกทั้งลำ" line. Not flagged |
| "Awaiting invoice" until every linked memo is paid | `flGoToMaint`, `flRenderMaint` (fleet) | computed | missing | flag stored only [money] |
| Consumable draw: item, qty ≥ 1, boat; over stock asks | `flConsumeSubmit` (fleet) | refusal / warning | built | `409 stock_short` / `allow_negative` |
| Consumable cost = qty × cost now | `flConsumeCostOf` (fleet) | computed | built | `unit_cost`, `cost` |
| Deleting a draw returns stock | `flConsumeDelete` (fleet) | auto-change | built differently | voided (Flagged part B) |
| Upkeep per boat per month | `renderConsumables`, `flBoatRepairCostMonth` (fleet) | computed | missing | Open (part B) 3 [ux] |
| Stock per warehouse; transfer ≤ held; primary warehouse | `invRemoveAt`, `invTransfer` (fleet) | refusal / computed | built | `409 stock_short` |
| Multi-warehouse migration | flLoad hook (fleet) | sweep | built differently | import movements |
| Memo type sets line categories | `memoSelectType` (fleet) | auto-change | built | `parseLines` |
| Memo totals | `memoCalcTotal`, `_memoTotals` (fleet) | computed | built | `memoTotals` |
| Line discount 0–100 | `memoRenderItems` (fleet) | refusal | built | `parseLines` |
| Stock-linked line price locked to the item's cost | `memoRenderItems`, `flViewMemo` (fleet) | refusal | built differently | taken as sent; `price_mismatch`. Not flagged |
| Ambiguous line name refused; exact match links; parts auto-register | `memoAddItem` (fleet) | refusal / auto-change | built differently | ambiguous name registers a duplicate item. Not flagged [data] |
| Picking an item fills an empty supplier | `memoSelectInv` (fleet) | auto-change | missing | [ux] |
| Memo edit refused when paid or cancelled | `moLiveStart`, `flEditMemo` (fleet) | refusal | built differently | paid only; a cancelled memo is editable. Not flagged [data] |
| Memo edit needs a line | `moLiveSave` (fleet) | refusal | missing | [data] |
| Old memo's lump-sum discount kept on re-total | `moLiveLegacyDisc` (fleet) | computed | missing | dropped by `planMemoPatch` [money] |
| Detail edit counts 0 qty as 0 | `moLiveTotals` (fleet) | computed | built differently | always 1 (near Flagged part B) |
| Memo edit and cancel write a job log line | `moLiveSave`, `flCancelMemo` (fleet) | auto-change | built differently | history only (Open part B 1) |
| Memo create: title, date; pending approval | `flSaveMemo` (fleet) | refusal | built | `planMemoCreate` |
| Memo number `MO-` next; duplicates blocked | `flSaveMemo`, `flAssertUniqueNo` (fleet) | numbering | built | `409 memo_no_taken` |
| Memo boat from the job, else the project | `flSaveMemo` (fleet) | computed | built differently | client fact. Not flagged [data] |
| Memo from a project logs on the project | `flSaveMemo` (fleet) | auto-change | missing | [data] |
| Parts line registers an item | `flSaveMemo`, `_invPickByName` (fleet) | auto-change | built | `autoRegister` |
| Cancel: reason, not paid | `flCancelMemo` (fleet) | refusal | built | `planCancel` |
| Approve needs an approver | `flSaveApprove` (fleet) | refusal | built | `planApprove` |
| Status flow; labor-only skips order/receive | `flAdvanceMemo` (fleet) | refusal | built | `planOrder`, `planPay` |
| Receive line by line | `flSaveReceive`, `memoRecvState` (fleet) | auto-change | built | `planReceive` |
| Receiving warehouse = the boat's current pier | `flMemoWarehouse` (fleet) | computed | built differently | home pier (Open part B 4) [ops] |
| A memo with no parts lines goes straight to paid on receive | `flOpenReceiveMemo` (fleet) | auto-change | built differently | `received`. Not flagged [money] |
| Short close | `memoShortClose` (fleet) | warning | built | `planShortClose` |
| New stock item: name; duplicates refused | `flSaveAddStock`, `_invFindDup` (fleet) | refusal | built | `409 stock_item_exists` |
| New item minimum quantity 5 | `flSaveAddStock` (fleet) | computed | built differently | 0. Not flagged [data] |
| Item edit; part-number change asks | `flSaveInvEdit` (fleet) | refusal / warning | built | `part_no_anyway` |
| Receive and transfer | `flSaveReceive`, `flSaveTransfer` (fleet) | refusal | built | `planTransfer` |
| Duplicate scan | `invDupScan` (fleet) | computed | missing | [data] |
| Merge: keeper chosen, memo lines and job parts repointed | `invDupMerge` (fleet) | auto-change | built differently | client picks; job parts not repointed. Not flagged [data] |
| Lost-receive repair | `invLostScan`, `invLostFix` (fleet) | sweep | decided not to copy | Open part B 3 |
| Item grouped by engine model | `invGetGroup` (fleet) | computed | missing | [ux] |
| Job part from stock; late edits | `flMaintAddPart`, `flMaintRemovePart` (fleet) | refusal / auto-change | built | `…/parts` |
| Job cost | `flMaintCalcCost` (fleet) | computed | built | `jobCost` |
| Typed job cost | `flMaintUpdateCost` (fleet) | computed | built differently | computed |
| Job create: confirm open jobs, per-asset, default status | `flSaveCreateJob` (fleet) | refusal / warning | built | `newJobs` |
| Job number `MJ-` | `flSaveCreateJob` (fleet) | numbering | built | `409 number_taken` |
| Job start: boat log, parts fixing, gear keep/stash/swap | `flMaintStart` (fleet) | auto-change | built | `startedJob` |
| Replacement engine picker; location; gearbox stays | `flStartSwapRenderPicker`, `flStartSwapInstall` (fleet) | refusal / auto-change | built differently | broken engine not refused (Flagged) |
| Swap an engine out of a started job | `flMaintSwapEngine` (fleet) | auto-change | missing | [ops] |
| Repair location moves the job's engines | `flMaintSetRepairLoc` (fleet) | auto-change | missing | [ops] |
| Stash a gearbox or propeller from a job | `flMaintStashConfirm` (fleet) | auto-change | built differently | two calls; no job line |
| "Add all boat engines" | `flMaintAutoAddEngines` (fleet) | auto-change | built differently | per engine, with logs |
| Split a job | `flSplitExistingJob`, `flEngSplitIntoJobs` (fleet) | auto-change | built | `splitJob`; project line missing (Open part A 1) |
| Add or remove a job asset | `flMaintAddAsset` (fleet) | auto-change | built | `addedJobAsset` |
| Job log copied to the incident | `flMaintAddLog`, `flPushLog` (fleet) | auto-change | built | `jobLog` |
| Pin a job | `flMaintTogglePin` (fleet) | auto-change | built | `pinned` |
| Close: outcomes, incident, decommission | `flMaintClose` (fleet) | auto-change | built | `closedJob` |
| Close writes a repair-history snapshot on the boat | `flMaintClose` (fleet) | auto-change | built differently | read from done jobs (Open part A 3) |
| Boat status during a job | `flSaveEditBoatStatus` (fleet) | refusal | built | `…/boat-status` |
| Delete a job, any status | `flDeleteMaint` (fleet) | warning | built differently | `409 job_done`. Not flagged |
| Link a job to a project: scheduled, same boat; log lines | `flMaintLinkProjectPick`, `flMaintUnlinkProject` (fleet) | refusal / auto-change | missing | `parent_project_id` unchecked [data] |
| Project sweeps: unlink, auto-link, auto-create, conversions | `flProjResyncMJLinks`, `flProjAutoCreateForScheduledMJs`, `flProjMigrate` (fleet) | sweep | missing | [data] |
| Incident create; number `INC-`; edit; delete | `flSaveIncident`, `flDeleteIncident` (fleet) | refusal / numbering | built | `newIncident`, `409 number_taken` |
| Quick swap: same brand or size | `flConfirmSwap`, `flConfirmPropCascade` (fleet) | refusal | built | `quickSwap` |
| Move a spare | `flConfirmMove` (fleet) | auto-change | built | `…/move` |
| Quick-add spare defaults (propeller ฿8,500, 3 blades) | `flSaveAddSpare` (fleet) | computed | built differently | no defaults |
| Engine, gearbox, propeller forms | `flSaveEngine`, `flSaveGearbox`, `flSavePropeller` (fleet) | refusal | built | `parseAssetInput` |
| Pickers offer only company boats not retired | `flBoatsForInstall` (fleet), `flOpenAddSafetyModal` (eng) | refusal | missing | jobs/incidents only (`assertWorkBoat`) [data] |
| Assign picker leaves out engines on another boat | `flOpenAssignEngModal` (eng) | refusal | missing | `install` takes it silently [data] |
| Occupied position asks; occupant to spare | `flSaveAssignEng` (eng) | warning / auto-change | missing | [data] |
| Positions limited to the engine count | `getEngPositions` (core, eng) | refusal | missing | `pos` free text [data] |
| Replace an engine; new one's spare location cleared | `flSaveAssignEng` (eng) | auto-change | built differently | `installedEngine` keeps `spare_location` |
| Unassign: status spare at the central store | `flUnassignEng` (eng) | auto-change | built differently | keeps status |
| Project form, baseline, number | `flProjSaveModal` (fleet) | refusal / numbering | built | `/v1/fleet/projects` |
| Phase, phase index, health | `flProjSetPhase`, `flProjHealth` (fleet) | computed | built | `projectView` |
| Project insight lines | `flProjInsight` (fleet) | computed | missing | [ux] |
| Project cost and breakdown | `flProjCalcCost`, `flProjCostBreakdown` (fleet) | computed | built differently | no parts/labour split per job |
| Bill gate; start, hold, resume, cancel, reopen, complete, work done, bill back | `flProjBillGate`, `flProjStart`, `flProjMarkComplete` (fleet) | refusal / auto-change | built | `planStart` … `planBillBack` |
| Plan items, documents, photos, vendor visits | `flProjAddPlanItemDirect`, `flProjAddDoc*` (fleet) | auto-change | built | `planDocAdd` |
| Safety item create, edit, delete; id | `flSaveSafety`, `flSafetyDelete` (eng) | refusal | built | `planSafetyCreate` |
| Safety state | `_flSafetyStatus` (eng) | computed | built | `safetyState` |
| Inspection: next due = date + the category's cadence | `flSaveInspection` (eng) | computed | built differently | cadence missing; `next_pm` null [data] |
| Replace wizard | `swapDocExecute` (eng) | auto-change | missing | Open part B 3 [data] |
| Daily Log inputs: fuel, pax, meters, prices | `flSaveFuel`, `flSavePaxActual`, `flSaveMeter` (fleet) | refusal | built | `parseBoatDay` |
| Daily Log lock | `flDRSetLock` (fleet) | refusal | built differently | enforced (decision 8) |
| Effective fuel price | `flFuelPriceEff` (fleet) | computed | built | `effectiveFuelPrice` |
| A boat's Daily Log pier that day | `flRenderDR` (fleet) | computed | built differently | home pier (Open part B 4) |
| Water used | `flWaterSet` (fleet) | computed | built | `waterUsed` |
| Issue items turned off, never deleted | `flIssueAddItem` (fleet) | auto-change | built | `/v1/fleet/issue-items` |
| Extras and requests need a name; deleted after 120 days | `flExtraSet`, `flReqSet` (fleet) | refusal / sweep | built | names required; 120-day delete not copied (decision 9) |
| Move an extra to another boat | `flExtraSaveBtn` (fleet) | auto-change | built differently | `DELETE` + `POST` |
| Extras refused when the pier has no boat | `flExtraOpen` (fleet) | refusal | missing | [ux] |
| Move an extra into an issue column | `flExtraToCol` (fleet) | refusal / warning | missing | [data] |
| Which boats get a Daily Log row | `flDRRan` (fleet) | computed | missing | [ux] |
| Effective pax per boat | `flRenderDR` (fleet) | computed | missing | [ops] |
| No entry for a boat that did not run | `flRenderDR` (fleet) | refusal | missing | [data] |
| Fuel per pax > 20 L flagged | `flRenderDR` (fleet) | computed | missing | [ux] |
| Pier fuel cost and "price missing" | `flRenderDR`, `flFuelPriceForBoat` (fleet) | computed | missing | [money] |
| Day KPIs; closed-pier banner; previous meter | `flRenderDR`, `flPrevMeter` (fleet) | computed | missing | [ux] |
| Dashboard and overview metrics | `flRenderDashboard`, `flRenderOverview` (fleet) | computed | missing | [ux] |
| Duplicate jobs dropped on load; renumber clashes | `flDedupeMaint`, `laRenumberOne` (fleet) | sweep / numbering | built differently | imported as they are; memo `no` can't change |
| Duplicate panel | `laDupScan`, `laDupClean` (fleet) | sweep | built differently | ids are keys |
| Hard-coded data patches and version migrations on load | `flLoad` (fleet) | sweep | decided not to copy | results imported (bug 16) |
| Seed demo data | `flLoad`, `_generateSafetySeed` (fleet) | sweep | decided not to copy | real data imported |
| Gearbox and propeller serial codes | `flLoad` hooks (fleet) | numbering | missing? | `serial` a client fact [data] |
| Status on a day; open work holds a boat | `getStoredStatus`, `boatEffStatus` (core) | computed | built | `fleet-availability.ts` |
| On every load, open-ended entries closed before the next | `BOATS.forEach` after `loadData` (core) | sweep | built differently | `closeOverlaps` on write; imports kept. Not flagged [data] |
| Manual cleanup log | `bsCleanupLog` (core) | sweep | missing | [data] |
| Status entry: dates, province, location type, reason | `saveStatus` (core) | refusal | built | `assertStatusEntry` |
| Setting available while work holds it asks | `saveStatus` §boatPlanAhead (core) | warning | built | `409 open_work` / `plan_ahead` |
| New entry closes overlaps; delete | `autoClosePrevLog`, `delStatus` (core) | auto-change | built | `closeOverlaps` |
| `loc` from a fixed list | `fmtLoc`, `parseLoc` (core) | computed | missing | stored as sent [data] |
| Project boat hold sync; stuck-boat self-heal | flLoad hooks (fleet) | sweep | built differently | computed from open work (part A) |
| Dashboard counts and fleet score | `renderDash` (core) | computed | built differently | statuses built; score the client's |
| Cost analytics | `costAggregate`, `laMemoDirectShare` (fleet) | computed | missing | Open part B 3 [money] |
| Fuel intelligence; fuel budget | `_fuelAgg`, `fuelSetBudget` (fleet) | computed | missing | Open part B 3 [money] |
| Insights; projects hub and YoY | `flRenderInsights`, `flProjYoYStats` (fleet) | computed | missing | [ux] |
| Safety matrix | `flRenderSafetyList` (eng) | computed | missing | [ux] |
| Fleet Deployment planning board | `flRenderDeployment`, `fd*` (fleet) | warning | decided not to copy | decision 12 |
| Data-integrity warnings on load | `flValidateDataIntegrity` (fleet) | sweep | built differently | numbers checked on create |

## Users and permissions

| Rule | Legacy (file) | Kind | Status | Here / note |
|---|---|---|---|---|
| Log in; nothing loads before | `showLogin`, `/api/me` (auth) | permission | built | `POST /v1/login` (plus a lockout) |
| Logout; Authentik SSO logout | `__laLogout` (auth) | permission | built differently | `POST /v1/logout`; no SSO [ux] |
| Expired session on save | `save` 401 (auth) | warning | built | `401` |
| Global view-only | `laCanEdit` (auth) | permission | built | every write checked |
| Per-area edit: admin, `editAreas`, else `canEdit` | `laCanEditArea`, `laGuardEdit` (auth, core) | permission | built | `users.ts` `writeNeed` |
| Action rights exact; admin has all | `laCanAct`, `LA_ACTS` (auth) | permission | built | `ACTIONS` |
| Page access by perms | `laAllowed`, `laWrapNav` (auth), `applyView` (embed) | permission | decided not to copy | README "What each login may do": `view_perms` not enforced |
| Perms expansion and back-fills; `*explicit` seal | `laExpandPerms`, `laBackfillPier` (auth) | sweep | decided not to copy | same; the client keeps it |
| Admin-only elements and user screens | `laApplyAdminOnly`, `__laUsers` (auth) | permission | built | `role: admin` |
| A salesperson-bound login sees only its agents' bookings | `__laEditPerms` hint, `laSalesScoped` (auth, app) | permission | built differently | agents scoped; the booking list is not [data] |
| Password at least 6 characters, typed twice | `__laAddUser`, `__laPwChk` (auth) | refusal | built differently | any non-empty password [data] |
| An admin can't delete or demote themself | `__laDelUser`, `__laSavePerms` (auth) | refusal | built | README |
| Delete user keeps history | `__laDelGo` (auth) | auto-change | built differently | disabled, never deleted |
| New rights after re-login | Users screen (auth) | auto-change | built differently | read on every request |
| A non-admin with no pages asks | `__laSavePerms` (auth) | warning | decided not to copy | `view_perms` not enforced |
| Admin role saves every menu and area | `__laSavePerms` (auth) | auto-change | built | admin bypasses checks |
| Permissions form logic | `__laCycle`, `__laTogMenu`, `__laPreset` (auth) | auto-change | missing | independent fields here [ux] |
| Department guessed from the username | `laGuessDept` (auth) | computed | missing | [ux] |
| Users overview warnings | `lauOverview` (auth) | warning | missing | [ux] |
| Reset all data, import backup: admin | `resetAllData`, `flImportData` (core) | permission | decided not to copy | whole-state, out of scope (`CLAUDE.md`) |
| Embed mode view-only | `roLockDown` (embed) | permission | decided not to copy | UI only; the server checks writes |
| Approve/reject: no permission in legacy | `bkV2ApproveBooking` (app) | permission | built differently | `act-approve` or the agent's salesperson |
| Booking writes need `operations` | `bkV2NewBooking`, `bkV2CommitBooking` (app) | permission | built | README |
| Doc-check writes need `operations` | `docCheckToggleItem` (app) | permission | built | README "Document check" |
| Per-screen persist gates (vehicles, pickup, locks, insurance, agents, contracts) | `sbVehiclesPersist`, `psuPersist`, `insPersist` (app) | permission | built | `writeNeed` |
| Hotel merge and van colour need `operations` | `psuHotelMerge`, `vehColorPick` (app) | permission | built | vans; the merge itself missing |
| Every new record's id made in the browser (`LA_UID`) | `window.LA_UID` (auth) | numbering | built differently | server ids |

## B2C sync

| Rule | Legacy (file) | Kind | Status | Here / note |
|---|---|---|---|---|
| B2B or B2C by id, channel, agent, code, market | `laIsB2C` (core) | computed | built differently | `isB2C` uses `b2c_` or `a_b2c`, for the price exception only; reports' split has no home [data] |
| New-B2C-booking alert with ref, pax, total, paid | `_laB2CScan`, `_laB2CAlert` (auth) | computed | built differently | the client derives it from `GET /v1/changes` [ux] |
| "Can't pull B2C" bar | `_laB2CHealth` (auth) | warning | decided not to copy | `b2c-sync-model.md` Open 3 |
| B2C bookings to check | `_laB2CIssues` (auth) | warning | built | `GET /v1/b2c/issues` |
| B2C channel from `b2cChannel` or the note | `laB2CChannel` (core) | computed | missing | [data] |
| B2C display code with "-N" | `bkV2DisplayCode` (app) | numbering | missing | [ux] |
| A B2C booking opens price-fixed; `b2cOverride` kept for the sync | `bkV2EditBooking`, `bkV2B2CDiff` (app) | auto-change | decided not to copy | push, not pull (`b2c-sync-model.md`) |

## Misc

| Rule | Legacy (file) | Kind | Status | Here / note |
|---|---|---|---|---|
| Attachments ≤ 6 MB, images downscaled, any type | `bkV2AttachUpload` (app) | refusal | built differently | jpeg/png/pdf only (README "Attachments") |
| Doc check status; first write `pending`; history | `docCheckStatus`, `docCheckSetStatus` (app) | computed | built | `doc_check_status` |
| OCR pre-check matches and auto-ticks | `docCheckRunPre` (app) | computed | built differently | matching in the browser (C2) |
| Real Thai heads per trip (`t.nat`) | `bkV2BumpNat` (app) | computed | missing | [data] |
| Whole-state sync, graft, save guards, export, reset | `save`, `_laGraftLocalOnly`, `_laBlobUsable`, `exportHTML` (auth, core) | sweep | decided not to copy | `CLAUDE.md` out of scope |
| Live refresh by SSE and polling | `_laSoftRefresh`, `_laStartSSE` (auth) | auto-change | built differently | `GET /v1/changes`, `/stream`; vans, stops, areas, users, agents not in the feed |
| Duplicate audit of bookings, agents, boats, pier payments | `LA_DUP_SETS`, `laDupClean` (fleet) | sweep | built differently | ids unique |
| One-time hooks guarded by browser `localStorage` | `flLoad` `_app_hooks` (fleet) | sweep | decided not to copy | `legacy-replacement.md` "Not replaced" (Findings 6) |
| Admin-only System Log | `devlogAdd`, `devlogDelete` (app) | permission | missing | [ux] |
| B2C channels and campaigns screen | `renderB2C` (app) | computed | missing | looks like a mock-up [ux] |

## What was read

Every file was read function by function for rules. Large render-only functions were searched
for `alert`, `confirm`, guards, saves and § markers rather than read line by line:

- `app`: `bkV2RenderTab2` (By-trip board), `bkV2RenderLocks`, `renderDailyPFM` markup, `md*`
  overview tabs, `pmap*` drawing, `psuRender*`, `rtModalRender`, `agEditRender`, `ctRenewRender`,
  `_ctDocRenderPages`, `renderSalesBoard`, `renderContractTemplates`, `pckPayRender`, `tsCSS*`,
  `drPane*` markup, `renderVanBill`, `vanJobsOrderInner`, `ckRowHtml`, `pcSheetMain`,
  `renderPierOffice`, `renderPierAtt`, `renderPierLic`, `pjCard`, `renderPrPo`, rep slide builders.
- `core`: `renderDash` after its data part, `renderCal`, `renderBoats`, `bop2RenderShell`,
  `renderSettings`.
- `fleet`: `flRenderProjects`, `flRenderMaint`, `flRenderCostAnalytics`, `renderFuelIntel`,
  `flRenderInsights`, `flRenderInventory`, the `fd*` planning board (decided out), and the ~60
  one-off `flLoad` hooks (read by header).
- `eng`: the safety detail and replace-wizard step renders, the documents matrix.

Not settled, worth a check before building: how the import maps legacy v1-shape bookings; whether
any FOC-approved bookings are stuck pending in legacy data; whether Boat Operation slots typed
`charter` without a booking exist; the two upgrade rows (a test would settle them).
