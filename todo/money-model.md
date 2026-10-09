# Money, modelled

**Status:** slice 1 (invoices and payments) is built: README → "Invoices and payments", migration 045,
`src/domain/invoices.ts`. Slices 5 and 6 are built except what waits for slices 3–4 and Fleet (see
"Slices 5 and 6: what is left"). Slices 2–4 are outlined below; each gets its own detail pass.

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
  proforma decisions, Trip P&L.

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
| 2 | **Proforma** | who is in scope, the deadline, the travel/hold decision and who may make it |
| 3 | **Pier money** | pier payments, on-tour sales, the amount owed at the pier, fees, commission |
| 4 | **After the trip** | cash-on-tour decisions, no-show charge decisions, the invoice's COT deduction |
| 5 | **Partner van bills** (built) | the rows, the amounts and the overview |
| 6 | **Reports** (built but Trip P&L and the slice 3–4 parts) | the accounting dashboard, agent statement, Travel Summary totals, Daily Report and Trip P&L, as computed `GET`s |

Not in Money:
- **Pier petty cash** (`po_cash_*`): a cash box per pier, so it belongs with pier operations.
- **Fleet memos, fuel and maintenance cost:** these belong to Fleet.
- **Cost template and plans:** these belong to Reports (slice 6) or Fleet.
- **Market stats:** these are data, not money.


## Slices 2–4, outlined

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



## Decided (2026-10-09)

- **COT deduction (slice 4):** the invoice subtracts the cash-on-tour `deduct` once the after-trip
  decision says so; legacy only warned. The design must handle an invoice already issued (PFM invoices
  are issued before travel): a minus line, or a credit, decided in slice 4's detail pass.
- **Proforma decisions (slice 2):** copy legacy: anyone may approve travel (free-text approver), and
  hold is a label that blocks nothing.
- **Settlement (slices 3 and 5):** build it with the slices: commission payouts, the pier cash
  hand-over at day close, and van bills sent and paid.

## Slices 5 and 6: what is left

Built 2026-10-09 (branch `feat/money-van-bills-and-reports`, migration 120): README "Partner van
bills" and "Money reports", `src/domain/van-bills.ts`, `src/domain/money-reports.ts`,
`src/domain/aboard.ts`, `src/routes/money-reports.ts`, `src/tools/legacy-van-bills.ts`. Still open:

1. **Add the Money slices 3–4 sources to the reports once they are on `main`:**
   - Travel Summary: pier payments by method (and their fees, slips, "waiting for slip"), on-tour sales
     (`SB_EXTRAS`: by method, fee, commission, still to collect), the no-show charge decisions
     (pending count, charged total), the COT decisions (deduct, payout, not collected) and so
     `due = to_collect − pier paid` and `tsNoCollect`'s "paid > 0" exception.
   - Daily Report: `due`, `got`, `noSlip`, extras, and the per-agent `due` (`pckMoney`).
   - Accounting dashboard: "Extras · cash · month" (`acctExtrasMonthTotal`).
2. **Trip P&L with close/freeze, the longtail cost and the cost model** wait for Fleet (fuel, meals,
   `cost_plans`, `trip_actuals`). The Daily Report's `ltCost` and its "net before boat costs" line are
   left out until then.
3. **Operations and Fleet reports** (`px*` beyond money) are not in Money.
4. **Van bills in the change feed:** not added (no kind `van_bill`). Add one if a screen needs live
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
- B2C `paymentSnapshot.balance` is not stored here, so it is 0 in `to_collect`.

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
   - paying a refund out (method, date, slip): legacy had no step either.
