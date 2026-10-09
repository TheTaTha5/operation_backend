# Money, modelled

**Status:** slices 1–6 are built, except Trip P&L and the cost model, which wait for Fleet. Slice 1
(invoices and payments): README → "Invoices and payments", migration 045. Slices 2–4 (proforma, pier
money, after the trip): README → "Proforma (Daily PFM)", "Pier money", "After the trip", migrations
110–112. Slices 5–6 (partner van bills, money reports): migration 120, `src/routes/money-reports.ts`.

- **Source:** wt-lk-inbox `allotment_v2/js/08-app.js`, read on 2026-10-09:
  - accounting block `acctCreateInvoice`, `acctRecordPayment`, `acctInvoiceState`, `acctVoidInvoice` and
    `acctCreateFeeInvoice`;
  - Daily PFM `pfm*`;
  - pier check-in `pck*`;
  - Travel Summary `ts*`;
  - on-tour sales `bkV2Extra*`;
  - partner van bill `vb*`;
  - reports `px*`, `dr*`, `acct*`.
- **Data counts:** read-only, from `ORIGINAL_DATABASE_URL`, 2026-10-09.
- **Already here:**
  - `agents.pay_type`, `vat_mode`, `credit_days` and `credit_limit` (migration 017);
  - booking `cash_on_tour_*` and `payment_*` columns (migration 011);
  - `booking_fee_items`, from cancel and reschedule charges (migration 020; `amountOwed` in `src/domain/booking-actions.ts`);
  - upgrades with `customer_paid`, `commission` and slips (migrations 038 and 040);
  - the `attachments` table;
  - `npm run import:attachments`, which already copies the slips of `sb_payments`, `pierpayments`,
    `paymentslips`, `sb_extras` and `ts_cot`.
- **Not here yet:** Trip P&L and the cost model (they wait for Fleet's fuel and meals).

## What legacy does, in short (slices 5–6)

**Reports not built yet**
- Trip P&L with close/freeze (`trip_actuals.closed`, none closed yet).
- Operations and Fleet reports.

**Not money, and corrections to `todo/legacy-replacement.md`**
- `sb_market_stats` and `sb_market_monthly` are imported Phuket arrival figures, not "computed from
  bookings".
- `report_agent_sales_7m_2026` is an imported spreadsheet that no code reads.
- `ts_cot` is the COT settlement, not commission.
- `travel_sum` is the no-show charge decision, not an approval.

## The plan: six slices, each approved and built in turn

| # | Slice | What the server decides |
|---|---|---|
| 1 | **Invoices and payments** (built) | totals, VAT, number, due date, status, balance, the booking's payment state, credit used |
| 2 | **Proforma** (built) | who is in scope, the deadline, the travel/hold decision and who may make it |
| 3 | **Pier money** (built) | pier payments, on-tour sales, the amount owed at the pier, fees, commission |
| 4 | **After the trip** (built) | cash-on-tour decisions, no-show charge decisions, the invoice's COT deduction |
| 5 | **Partner van bills** (built) | the rows, the amounts and the overview |
| 6 | **Reports** (built but Trip P&L) | the accounting dashboard, agent statement, Travel Summary totals, Daily Report and Trip P&L, as computed `GET`s |

Not in Money:
- **Pier petty cash** (`po_cash_*`): a cash box per pier, so it belongs with pier operations.
- **Fleet memos, fuel and maintenance cost:** these belong to Fleet.
- **Cost template and plans:** these belong to Reports (slice 6) or Fleet.
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
    `test/invoices.test.ts` "a reschedule fee is billed once". Say if the fee item should go.
  - Fee invoices remain for cancellation charges only; `fee_type: "reschedule"` comes from the import.

## Slices 5 and 6: what is left

Built 2026-10-09 (branch `feat/money-van-bills-and-reports`, migration 120): README "Partner van
bills" and "Money reports", `src/domain/van-bills.ts`, `src/domain/money-reports.ts`,
`src/domain/aboard.ts`, `src/routes/money-reports.ts`, `src/tools/legacy-van-bills.ts`. Still open:

1. **Trip P&L with close/freeze, the longtail cost and the cost model** wait for Fleet (fuel, meals,
   `cost_plans`, `trip_actuals`). The Daily Report's `ltCost` and its "net before boat costs" line are
   left out until then.
2. **Operations and Fleet reports** (`px*` beyond money) are not in Money.
3. **Van bills in the change feed:** not added (no kind `van_bill`). Add one if a screen needs live
   updates; append to `changes_kind_check` as migration 100 does.

## Flagged

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

1. **Deposits and refunds.** The weather outcomes are built (migration 061, README "Weather closures,
   refund and credit"): a `refunds` row of kind `refund` (owed to the agent) or `credit` (the agent's
   balance, spent as a payment with method `credit`). Still open:
   - legacy's manual deposit ("รับมัดจำ", `acctDepositSubmit`): money received with no invoice. It fits
     as a `credit` with no invoice, which `refunds.invoice_id NOT NULL` does not allow yet;
   - paying a refund out (method, date, slip): legacy had no step either;
   - the agent statement's "Deposit held" (slice 6) reads `credit_balance`.

2. **An invoice left overpaid by a cash-on-tour deduction** (slice 4). A proforma agent pays before
   the trip, so a `deduct` decided afterwards leaves its invoice paid above the new total: the read
   says `overpaid` and the decision warns `invoice_overpaid`. Nothing turns that into a refund or the
   agent's credit yet (open 1's refund payout and a `credit` with no weather reason would). Until then
   accounting decides by hand.
3. **Love Kingdom's payment state** (`payment_paid`, `payment_paid_status`, `payment_deposit`,
   `payment_balance`) is stored as sent. Love Kingdom must send it on every update
   (`docs/love-kingdom-integration.md`), or the pier collects a stale balance.
4. **When legacy stops writing** `pierPayments`, `SB_EXTRAS`, `TS_COT` and `travel_sum`: until then the
   import replaces what was recorded here on imported bookings, as for invoices.

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
