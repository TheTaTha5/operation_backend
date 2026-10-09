# Money, modelled

**Status:** slice 1 (invoices and payments) is built: README → "Invoices and payments", migration 045,
`src/domain/invoices.ts`. Slices 2–6 are outlined below; each gets its own detail pass and approval.

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
- **Not here yet:** pier payments, on-tour sales, cash-on-tour decisions, no-show charge decisions,
  proforma decisions, van bills, money reports.

## What legacy does, in short (slices 2–6)

**Proforma (PFM)**
- **Who:** `proforma` agents, plus credit agents who have a prepay invoice.
- **Deadline:** 18:00 the day before the first trip.
- **When unpaid:** staff either approve travel or put it on hold. That decision is `ops.pfm`, which is lost
  on every legacy save. Hold blocks nothing, and anyone can approve.

**Pier payments (`bk.pierPayments`)**
- **Data:** 158 payments on 156 bookings.
  - Cash 122, ฿325,000.
  - Card 27, ฿63,323, plus ฿2,698 in fees.
  - Transfer 9, ฿13,990.
- **Card fee:** kept apart from `amount`. `amount` pays the debt, and `amount + fee` is what the card
  machine charged.
- **Split:** one payment can be split across methods.
- **Amount owed** (`pckMoney`): cash on tour + upgrades not collected + B2C balance + on-tour sales still
  to collect − pier payments for that date. It counts 0 on an overnight return leg.
- **Boarding:** the guard is a warning.
- **Accounting:** pier money is never posted to accounts, and the day-close step was never built.

**On-tour sales (`SB_EXTRAS`)**
- **Data:** 159 rows, ฿253,500 in total, 26 sellers.
- **Commission:** `commission = total − to_company`, ฿79,750 in all.
- **Methods:** cash, transfer, card (fee up to 5%) or `cot`. `cot` means it is collected at the pier
  later.
- **Lost by legacy:** satang (decimals) and `collectedAt`.
- `todo/legacy-replacement.md` called this the "add-on catalogue". It is not.

**Cash on tour (COT)**
- **The plan:** `cashOnTour` is set at booking. 307 `deduct` (฿984,646) and 61 `separate`. This is
  already here.
- **The decision after the trip** (`TS_COT`, per booking and date): `full`, `part`, `none`, `payout` or
  `nocol`, with `deduct` (taken off the agent's invoice) and `payout` (paid back to the agent).
  - 142 decisions. Only 138 of 354 active COT bookings have one.
  - deduct + payout above the COT amount is only a warning.
- **Invoice:** it ignores the decision, so the money is collected twice. `pfmCotWarn` only warns about it.

**No-show charge (`travel_sum`)**
- Per booking and date: `full`, `partial`, `none` or `postpone`, with `amount` and `note`.
- Data: full 68 (฿335,400), postpone 5, none 2, partial 1.
- It never creates an invoice. Postpone opens the reschedule screen.

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
| 2 | **Proforma** | who is in scope, the deadline, the travel/hold decision and who may make it |
| 3 | **Pier money** | pier payments, on-tour sales, the amount owed at the pier, fees, commission |
| 4 | **After the trip** | cash-on-tour decisions, no-show charge decisions, the invoice's COT deduction |
| 5 | **Partner van bills** | the rows, the amounts and the overview |
| 6 | **Reports** | the accounting dashboard, agent statement, Travel Summary totals, Daily Report and Trip P&L, as computed `GET`s |

Not in Money:
- **Pier petty cash** (`po_cash_*`): a cash box per pier, so it belongs with pier operations.
- **Fleet memos, fuel and maintenance cost:** these belong to Fleet.
- **Cost template and plans:** these belong to Reports (slice 6) or Fleet.
- **Market stats:** these are data, not money.


## Slices 2–6, outlined

**2. Proforma**
- `GET /v1/pfm?date=` lists the bookings in scope. For each it gives the deadline, the payment state and
  the decision.
- Commands:
  - `POST /v1/bookings/{id}/pfm/approve-travel` `{ approver }`;
  - `POST /v1/bookings/{id}/pfm/hold`;
  - `POST /v1/pfm/remind`.
- Table: `booking_pfm_decisions`, with every decision kept in history.
- Open: who may decide, and whether hold blocks check-in (open 2).

**3. Pier money**
- **Pier payments:**
  - table `booking_pier_payments`: id, booking, service_date, method, amount, fee, fee_pct, note, slips,
    by, at;
  - `POST /v1/bookings/{id}/pier-payments` takes lines split by method;
  - fee maths are the server's.
- **On-tour sales:**
  - table `booking_tour_sales`, from `SB_EXTRAS`;
  - `total`, `fee`, `customer_paid` and `commission` are computed;
  - `settle` comes from the method plus a `collect` command.
- **Amount owed:** `pier_owed` per trip date is computed (`pckMoney`) and shown on the check-in board.
- **Upgrades:** their `collected` field moves under the same rule.

**4. After the trip**
- **COT decisions:** `booking_cot_decisions`, per booking and date, with `mode`, `deduct`, `payout`, `ref`
  and slips. The rule is `deduct + payout ≤ COT amount` (a warning today).
- **No-show charges:** `booking_noshow_charges`, per booking and date, with `decision`, `amount` and
  `note`.
- **Invoice:** Open 1 decides whether the invoice subtracts the COT `deduct`.

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

- **COT deduction (slice 4):** the invoice subtracts the cash-on-tour `deduct` once the after-trip
  decision says so; legacy only warned. The design must handle an invoice already issued (PFM invoices
  are issued before travel): a minus line, or a credit, decided in slice 4's detail pass.
- **Proforma decisions (slice 2):** copy legacy: anyone may approve travel (free-text approver), and
  hold is a label that blocks nothing.
- **Settlement (slices 3 and 5):** build it with the slices: commission payouts, the pier cash
  hand-over at day close, and van bills sent and paid.

## Open

1. **Deposits and refunds.** The weather outcomes are built (migration 061, README "Weather closures,
   refund and credit"): a `refunds` row of kind `refund` (owed to the agent) or `credit` (the agent's
   balance, spent as a payment with method `credit`). Still open:
   - legacy's manual deposit ("รับมัดจำ", `acctDepositSubmit`): money received with no invoice. It fits
     as a `credit` with no invoice, which `refunds.invoice_id NOT NULL` does not allow yet;
   - paying a refund out (method, date, slip): legacy had no step either;
   - the agent statement's "Deposit held" (slice 6) reads `credit_balance`.
