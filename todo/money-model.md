# Money, modelled

**Status:** built. Slice 1 (invoices and payments): README "Invoices and payments", migration 045.
Slices 2–4 (proforma, pier money, after the trip): README "Proforma (Daily PFM)", "Pier money",
"After the trip", migrations 110–112. Slices 5–6 (partner van bills, money reports): migration 120.
The rest (cost model and Trip P&L, refund payouts, deposits; decided 2026-10-10): README "Cost model
and Trip P&L", "Deposits and refund payouts", migrations 160–161, `src/domain/costing.ts`,
`trip-pl.ts`, `credit.ts`, `src/routes/costing.ts`, `credit.ts`, `npm run import:costing`. What is
left is under "Open"; what was decided without asking, or differs from legacy, under "Flagged".

**Not money, and corrections to `todo/legacy-replacement.md`**
- `sb_market_stats` and `sb_market_monthly` are imported Phuket arrival figures, not "computed from
  bookings".
- `report_agent_sales_7m_2026` is an imported spreadsheet that no code reads.
- `ts_cot` is the COT settlement, not commission.
- `travel_sum` is the no-show charge decision, not an approval.

Not in Money:
- **Pier petty cash** (`po_cash_*`): a cash box per pier, so it belongs with pier operations.
- **Fleet memos, fuel and maintenance cost:** these belong to Fleet.
- **Market stats:** these are data, not money.





## Decided (2026-10-09)

- **Settlement (slice 5):** van bills sent and paid (slice 3's commission payouts and pier hand-over
  are built).

## Decided (2026-10-10)

- **A reschedule fee on a booking already invoiced tops up that invoice** (corrected). The 2026-10-09
  build issued a separate VAT-free fee invoice and added no fee item, on the belief that legacy left
  the fee unbilled. That was wrong: legacy `bkV2RescheduleBooking` adds the fee item and, when the
  booking has a live invoice (`acctBookingInvoice`), adds a line `Reschedule fee · <from> → <to> ·
  <reason>` to it and raises its subtotal, net and total by the fee. Decided: copy legacy, with VAT
  worked out again by the invoice's own VAT mode (`invoices.ts withFeeLine`, as a discount does),
  since legacy's flat raise left VAT wrong on an `include` or `exclude` invoice. A paid invoice takes
  the fee and reads partial.
  - **The fee item is kept even when the invoice is topped up,** as legacy. The brief said to keep it
    only when the booking is not invoiced; kept here instead because nothing can bill it twice (the
    booking cannot go on a second invoice while the topped-up one is live, `409
    booking_already_invoiced`), and without it a void and re-issue, or a restore after a cancel, would
    drop the fee, and the `full` charge and credit `used` would leave it out. Test:
    `test/invoices.test.ts` "a reschedule fee is billed once". **Decided 2026-10-10: keep, as built.**
  - Fee invoices remain for cancellation charges only; `fee_type: "reschedule"` comes from the import.

## Slices 5 and 6: what is left

Built 2026-10-09 (branch `feat/money-van-bills-and-reports`, migration 120): README "Partner van
bills" and "Money reports", `src/domain/van-bills.ts`, `src/domain/money-reports.ts`,
`src/domain/aboard.ts`, `src/routes/money-reports.ts`, `src/tools/legacy-van-bills.ts`. Still open:

1. **Operations and Fleet reports** (`px*` beyond money) are not in Money.
2. **Van bills in the change feed:** not added (no kind `van_bill`). Add one if a screen needs live
   updates; append to `changes_kind_check` as migration 100 does.

## Flagged (slices 5–6, built 2026-10-09)

Decisions made here without asking, behaviour that differs from legacy, and side effects. Each
defaults to legacy unless it says otherwise.

**New behaviour**
- **Sent and paid on van bills** (decided 2026-10-09, details mine): draft → sent → paid; paying needs
  the bill sent (`409 bill_not_sent`); `paid_via` is `transfer`, `cash` or `cheque`; the total is frozen
  into `sent.bill` and `paid.amount`; `changed_since_sent` compares totals only. **A paid bill is
  locked** (`409 bill_paid` on edit, pull-rates, send, unsend) until `unpay`. Legacy had no state.
- **Reports refuse a login tied to an agent** (`403`); its own statement is allowed, another agent's
  is `404`; a salesperson sees only their agents' statements (as `GET /v1/agents/{id}`).
- **Permissions legacy did not have:** van rates (legacy `ctWrite`, no guard) need `accounting` or
  `fleet`; the daily report's settings (no guard) need `operations` or `accounting`. Van bills need
  `accounting`, as legacy.
- **The API addresses a bill by path** `/v1/van-bills/{partner}/{month}/{period}` (the outline had
  query parameters), and its inputs are a `PATCH` where a field sent replaces that whole field.

**Behaviour that differs from legacy**
- **Check-ins count on every slot** (van part), not only the trip's main record, for "aboard" (van
  bills) and "travelled" (Travel Summary). Same result for a trip that is not split; legacy missed the
  no-shows of split bookings.
- **`mark_seen` records every row of the period**; legacy's Save with a van filter recorded only that
  van's rows, so the others kept warning.
- **Collections and "paid this month" use Bangkok months and `paid_on`**; legacy sliced the record
  time in UTC and labelled each month one month early.
- **Statement `paid` is net** of what refunds and weather credits took back from an invoice, so
  `invoiced − paid = outstanding`.
- **Daily van cost uses every van part**, each with its own passengers, and **the trip's route**;
  legacy used the booking's main van only and the boat's deployment route (a trip with no boat yet
  fell to the group base rate).
- **Van rates are keyed to routes in the catalogue**: legacy cells for unknown routes are dropped at
  import (none today). A van's `costPerDay` is not modelled: every legacy van has it empty.
- **Amounts are refused when negative** (`400`); legacy's inputs stripped the sign. A client sends a
  deduction positive, as legacy stores it.

**Kept from legacy, probably bugs (not fixed)**
- A split booking's return leg adds the **whole booking's** passengers to `return_pax` once per part
  (display only; the sale is on the way out).
- A split booking's passengers on a van bill are all shown as **adults**.
- Travel Summary counts a booking's **upgrades on every date** it has a trip (they are booking-level).
- `pullRates` almost always "finds" a rate: with nothing set the partner default (฿1,800) is used and
  marked `generic`, so `409 no_van_rates` only fires when rates are explicitly 0.
- Credit `used` counts an unpaid booking whole, even when its invoice is part-paid (`agCreditState`).
- Travel Summary's `no_show` (events) and `travelled` (last count) are two different measures, as in
  legacy, so they need not add up.
- Travel Summary's `to_collect` leaves out on-tour sales still to collect (legacy `tsMoneyOf`: they are
  in `sales_due`), while the Daily Report's `due` counts them (legacy `pckMoney`), so the two differ.
- "Extras · cash · month" (`extras_this_month`) counts every on-tour sale, whatever its method, as
  legacy's `acctExtrasMonthTotal` does despite its label. It uses the Bangkok month of `sold_at`
  (legacy: the UTC month of the record time), as the collections do.

**Import**
- 26 of legacy's 31 `van_bill` rows; the 5 with the older four-part key are skipped (the outline's
  "6 of 26" was an older count). Blank bills (no inputs) are imported too.
- Bills are upserted on partner, month and period: legacy's inputs replace ours, **sent and paid
  survive a re-import**; a bill made here that legacy lacks is left alone. Van rates and `dr_cfg` are
  replaced whole on every run (legacy is master until Money moves): **a rate edited here is lost on
  the next import** until then.
- Rehearsal 2026-10-09, replaying legacy's `vbRows` and bill maths on legacy's own data: 24 of 26
  bills identical (rows, passengers, return passengers, bookings, bill, sale). The 2 others
  (โกอู๊ด and สตอ, 2026-08 period 3) each miss one r12 run on 2026-08-22: legacy's group 1 there had
  members on veh12 and veh17, and the van-group import leaves such a group with no van.

**Side effects:** `OperationsStore` and `PostgresOperationsStore` gain van bill, van rate and daily
settings methods; `users.ts` `writeNeed` gains three paths; `routes/operations.ts` registers
`money-reports.ts`. No existing endpoint changes.

## Open

1. **Operations and Fleet reports** (`px*` beyond money: `pxAnalysis`'s agent contribution, the
   cost-structure fit) are not built. The Trip P&L serves trip, day and month figures; legacy's
   analysis tab can be computed from `GET /v1/reports/trip-pl` days, or added as an endpoint.
2. **Van bills in the change feed:** not added (no kind `van_bill`). Add one if a screen needs live
   updates; append to `changes_kind_check` as migration 100 does.
3. **Love Kingdom's payment state** (`payment_paid`, `payment_paid_status`, `payment_deposit`,
   `payment_balance`) is stored as sent. Love Kingdom must send it on every update
   (`docs/love-kingdom-integration.md`), or the pier collects a stale balance.
4. **When legacy stops writing** `pierPayments`, `SB_EXTRAS`, `TS_COT` and `travel_sum`: until then the
   import replaces what was recorded here on imported bookings, as for invoices.
5. **When legacy stops writing the cost model and trip actuals** (`cost_template`, `cost_plans`,
   `boat_rent`, `meal_venues`, `routes.mealVenueId`, `trip_actuals`, `pier_job.mv`): until then
   `import:costing` replaces the template, plans and rents made here, and legacy's meal orders replace
   ours on the same boat and day.
6. **Not ported from the costing screen:** the rent's idle cost and monthly fact sheet (`ctRentIdle`,
   `ctRentSpan`, `ctFactLong`, the high/low season table) and the profit chart. They are reads on the
   rent and plan figures served here; build them if the screen needs them from the server.

## Flagged (slices 2–4, built 2026-10-09 without a second stop)

Each is legacy's behaviour unless it says otherwise; say if one should change.

**Behaviour changes against legacy**
- **The invoice subtracts the COT `deduct`** (decided): a minus line per trip date (`invoice_lines.cot_date`)
  on the booking's live booking or prepay invoice, kept in step with the decision, VAT worked out
  again; added at issue for a booking not invoiced yet. It is allowed on a paid invoice (unlike a
  discount), which then reads `overpaid`. A minus line takes no discount. **Imported invoices get no
  minus lines**, so their totals stay legacy's; the rehearsal lists the invoiced bookings carrying a
  deduction.
- **Upgrades' `collected`** (decided "the same rule"): set on a new sale, then only by
  `POST …/upgrades/{id}/collect`; a `PATCH` that flips it is `400`. Legacy's edit dialog ticked it
  freely; the two existing tests that ticked it were changed.
- **PFM amounts are the invoice's** when there is one (legacy took the booking's total and the
  invoice's balance, which its own `bkV2PayOf` warns is wrong for deposits); without one, the
  booking's total and fees less its COT deductions.
- **The cutoff is from the booking's first trip** (decided); legacy used the first trip inside the
  viewed range.
- **A PFM decision may replace the other one** (hold, then extend); the same one twice is `409
  pfm_decided`. Legacy hid both buttons once decided. Every decision and reminder is kept.
- **Refused here, clamped or allowed in legacy:** `to_company` above the sale's total (legacy cut it
  to the total), a card fee above 5% on a sale (legacy cut it to 5), a fee on a non-card pier payment,
  a decision or payment on a day the booking does not travel, a pier payment or decision on a
  cancelled booking, a COT decision on a booking with no cash on tour.
- **A deleted pier payment stays** with `deleted_*` (legacy removed it), as invoice payments do.
- **Every booking command here moves the booking's `version` and needs `If-Match`** (the brief);
  remind does neither, as `/v1/reconfirm/sent`.

**New, with no legacy**
- **Pier hand-over:** per day and pier (`routes.pier`, `other` when none); `expected` computed by
  method and source; cash counted by the pier; accepted by accounting; one live per day and pier;
  void only before acceptance. A later payment is **not refused**: the read shows `changed`.
  Upgrades count on the day they were sold if the booking travels then, else its first travel day
  (legacy keeps no day on an upgrade).
- **Commission payouts:** per seller, items named, amount computed, only collected items, each once
  while live; method cash or transfer. A paid-out sale cannot change its commission or seller, nor be
  deleted (`409 commission_paid`). Upgrades' own `settle` field stays the client's, unused, as in
  legacy.
- Change kinds `pier_handover` and `commission_payout` (migration 111, appended to the CHECK).

**Rights** (`writeNeed`)
- PFM decisions and remind, upgrade collect: `operations` or `accounting` (legacy
  `acctPersistBookings`). Pier payments: `pier`, `operations` or `accounting` (legacy's pier screen
  is `ckCanEdit`, but saving goes through `acctPersistBookings`, so a pier-only login saved nothing in
  legacy). On-tour sales and the after-trip decisions: `operations` (`sbExtrasPersist`,
  `laGuardEdit('operations')`). Hand-over: `pier` or `operations`; accepting it and payouts:
  `accounting`.
- A login tied to an agent (Love Kingdom's) may not write any of the booking money above (`403`), and
  reads only its own bookings' PFM, pier money and after-trip rows; hand-overs and commissions not at
  all.

**Small choices**
- Pier payment lines of 0 are dropped silently (legacy); a card line with neither `fee_pct` nor `fee`
  pays no fee (legacy's dialog defaulted to 3%).
- `approver` defaults to the booking's salesperson (`sold_by`, else the agent's); with neither it is
  `400` (legacy stored "—").
- Collecting a sale or an upgrade takes cash by default (legacy's button); transfer and card with fee
  are allowed.
- A sale's history lines are legacy's; deleting a sale is not logged (legacy).
- No history line for COT or no-show decisions (legacy wrote none); the invoice change is logged.
- No-show `postpone` moves nothing: the client opens the reschedule, as legacy.
- PFM "Issue all" stays `POST /v1/invoices` per booking; legacy's chart buckets are not served (a
  client asks `GET /v1/pfm` per period).

**Import** (`legacy-pier-money.ts`)
- Pier payments and on-tour sales keep legacy's ids, `lg_`-prefixed; everything hangs off the
  imported bookings and is replaced with them.
- PFM decisions come from history lines (legacy never saved `ops.pfm`): reminders, extensions, holds.
- A `cot` sale legacy marked settled imports as cash, collected; a non-`cot` sale has no
  `collected_at` (legacy lost it). Legacy's whole-baht card fees are kept as they are.
- COT and no-show decisions import as legacy has them, including deduct + payout above the COT, on a
  booking whose COT was since removed, and on a day the booking no longer travels; legacy's `—`
  author is none.
- Love Kingdom's `paymentSnapshot` paid, status, deposit and balance now import onto the booking.

## Flagged (the rest of Money, built 2026-10-10 without a second stop)

Each is legacy's behaviour unless it says otherwise; say if one should change.

**Decisions made here**
- **Rights:** costing (template, plans, rents, restaurants, a route's restaurant) is `accounting`:
  legacy's costing menu sits under Accounting & Finance and its writes had no guard; a route's
  restaurant was saved with the catalogue. Close and "ran" are `accounting` (legacy). The meal
  order, note and overnight choices are `operations` (legacy); the day's restaurant is `pier` (legacy's
  pier job sheet) or `operations`. Deposits and payouts are `accounting`.
- **Close and "ran" are commands** (legacy toggled one button). `ran` on a boat with passengers or
  bookings is `409 trip_not_empty`, close on a boat that did not sail `409 trip_not_sailed`, and a
  boat with no deployment that day `404`: legacy only hid those buttons, so the screens behave the same.
- **No plan is made on a read:** legacy's `ctPlans` saved a blank "เส้นทางที่ 1" on first open; here the
  list is empty until one is created.
- **A saved template's `dropped`** is the default lines it lacks (legacy kept a list of deleted ids):
  a default line added to the code later does not appear in a template saved before. Production's
  template carries all 18. The unsaved default has the on-demand seed applied (legacy's first unsaved
  read did not, which priced a longtail charter at 0 instead of ฿600 a boat).
- **A deposit is part of one pool** per agent (legacy tracked which deposit each payment used). Void
  needs a reason and is refused below 0. Deposit methods are legacy's (transfer, cash, card); payout
  methods are mine (transfer, cash, cheque, as van bills), and a payout can be undone.
- **`deposits_held`** on the dashboard is every agent's credit left (weather credits and deposits, less
  credit spent), not deposits alone; legacy had deposits only, and never saved one.
- **Change kinds** `trip_actual` (`{date}:{boat_id}`), `deposit` and `refund` (a payout).
- **The month report** is each day's totals to today (legacy `pxDaysOf`). It costs about 0.5 s a
  day on the rehearsal copy.

**Behaviour that differs from legacy**
- **A trip split over boats** counts on each by its share of heads (legacy had no split; none in data).
- **On board** sums the pier's counts of the trip's records (legacy read the main record only); the
  same on every imported trip.
- **Break-even's seats** are the deployment's capacity (legacy `boatCapFor`, the boat's seats with the
  day's override).
- **Vans** are each van part's, with the overnight return van, as the Daily Report's van cost
  (legacy: the booking's main van).
- **An upgrade's commission** is worked out (`sell_price − to_company`), as everywhere here; legacy
  read the stored one.

**Kept from legacy, probably bugs (not fixed)**
- A plan's group ±% does not mark its lines `plan` (legacy read `G.mul`, which is never set).
- The meal order takes the pier's no-show count off after everyone lost (`pckMealCount`:
  `expect − ck.noShow`): a no-show recorded both as a pier event and in the pier's count comes off
  twice.
- The Daily Report's join heads are the booked heads; the Trip P&L's are those on board, capped by
  the add-on's join count. The two differ when someone did not come.
- An upgrade counts on the booking's first trip only in the P&L's on-tour money, but a longtail
  charter upgrade counts on every day of the booking (legacy's "known limitation").
- A rented boat is charged its rent per trip run, so the rent of days it did not run is not on any
  trip (legacy shows it apart, `ctRentIdle`, not ported).

**Not ported**
- A trip's own Longtail bundle (`tr.bundle`, `tr.longtailManual`): legacy stores neither; the rate
  type's bundle is read.

**Import** (`legacy-costing.ts`)
- The template, plans and rents are replaced whole on every run (legacy is master): an edit made
  here is lost. Venues are upserted; a route's restaurant is set to legacy's.
- Overnight choices name imported `lg_` bookings, so a booking re-import (which deletes `lg_` bookings)
  takes them with it: run `import:costing` after every `import-legacy.ts`.
- A close or "ran" made here survives a re-run; legacy's `ran` has no who or when.
- Rehearsal 2026-10-10 (fresh database: routes, boats, `import-legacy --rate-types --sales`, fleet,
  fleet stock, then this): 22 lines, 10 plans (7 with a route, 1 with a boat), 2 rents, 3 venues,
  6 routes linked, 92 boat-days (90 meals ฿774,730 as legacy, 36 notes, 2 overnight choices, 1 day
  venue), nothing skipped; a re-run identical. Legacy's own `ctCalc` and `ctBreakEven`, extracted from
  `08-app.js` and run on each imported trip's inputs (2026-08-15 to 2026-10-09, 94 trips): all 1,778
  cost lines and every break-even equal; 83 fuel actuals equal litres × price; heads on board equal
  legacy's pier counts on 69 of 70 fully counted boat-days (the other has a booking cancelled at the
  van that legacy's `pckVoidInfo` drops too).

**Side effects:** both stores gain `moneyRepo` and `setRouteMealVenue`; routes read `meal_venue_id`;
`creditBalance` gains `deposited`; the route form's `meal_venue_id` refusal names the new command;
`writeNeed` gains the paths above; the Daily Report, accounting dashboard, statement and
`GET /v1/refunds` gain fields.
