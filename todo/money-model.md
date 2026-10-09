# Money, modelled

**Status:** slices 1–4 are built. Slice 1 (invoices and payments): README → "Invoices and payments",
migration 045. Slices 2–4 (proforma, pier money, after the trip): README → "Proforma (Daily PFM)", "Pier
money", "After the trip", migrations 110–112, `src/domain/pfm.ts`, `pier-money.ts`, `after-trip.ts`. Slices
5–6 are outlined below; each gets its own detail pass and approval.

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
- **Not here yet:** van bills, money reports.

## What legacy does, in short (slices 5–6)

**Partner van bill (`VAN_BILL`)**
- **One bill:** per partner, per month, per ten-day period (1–10, 11–20, 21–end).
- **Rows** are computed from the bookings' van parts and check-ins: one row per day + route + van, and out
  and back count as one run.
- **Staff save:** `perPax`, a default `rate`, rates per route code, per-row `rate/ex/cut` overrides,
  extra lines, and `seen`.
- **Amounts:** `bill = rate + ex − cut`, `sale = pax × perPax` and `pl = sale − bill`.
- **Status:** none. There is no sent or paid state.
- **Data:** 26 bills from 5 partners, Aug–Oct. 6 use an older key that today's code never reads.

**Reports**
- Trip P&L with close/freeze (`trip_actuals.closed`, none closed yet).
- Daily Report.
- Travel Summary totals.
- Accounting dashboard: outstanding, aging, credit exposure, top debtors.
- Agent statement.
- Operations and Fleet reports.
- All are computed in the browser.

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
| 5 | **Partner van bills** | the rows, the amounts and the overview |
| 6 | **Reports** | the accounting dashboard, agent statement, Travel Summary totals, Daily Report and Trip P&L, as computed `GET`s |

Not in Money:
- **Pier petty cash** (`po_cash_*`): a cash box per pier, so it belongs with pier operations.
- **Fleet memos, fuel and maintenance cost:** these belong to Fleet.
- **Cost template and plans:** these belong to Reports (slice 6) or Fleet.
- **Market stats:** these are data, not money.


## Slices 5–6, outlined

**5. Partner van bills**
- `GET /v1/van-bills?partner=&month=&period=` computes the rows from van parts and check-ins.
- `PUT` saves the staff inputs: `per_pax`, `rate`, route rates, row overrides, extra lines and `seen`.
- `GET /v1/van-bills/overview?month=&period=` gives the overview.
- Tables: `van_bills`, `van_bill_route_rates`, `van_bill_row_overrides` and `van_bill_extra_lines`.
- The 6 old-key bills are not imported: legacy's own code no longer reads them.

**6. Reports**
- Computed `GET`s:
  - `/v1/reports/accounting`: outstanding, aging, credit exposure and top debtors;
  - `/v1/agents/{id}/statement`;
  - `/v1/reports/travel-summary?date=`;
  - `/v1/reports/daily?date=`.
- Trip P&L needs the cost model and fleet actuals, so it waits for Fleet.


## Decided (2026-10-09)

- **Settlement (slice 5):** van bills sent and paid (slice 3's commission payouts and pier hand-over
  are built).

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
