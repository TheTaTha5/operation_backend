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

**5. Partner van bills** and **6. Reports**: see "Design: slices 5 and 6" below.


## Decided (2026-10-09)

- **COT deduction (slice 4):** the invoice subtracts the cash-on-tour `deduct` once the after-trip
  decision says so; legacy only warned. The design must handle an invoice already issued (PFM invoices
  are issued before travel): a minus line, or a credit, decided in slice 4's detail pass.
- **Proforma decisions (slice 2):** copy legacy: anyone may approve travel (free-text approver), and
  hold is a label that blocks nothing.
- **Settlement (slices 3 and 5):** build it with the slices: commission payouts, the pier cash
  hand-over at day close, and van bills sent and paid.

## Design: slices 5 and 6 (2026-10-09)

Built on the developer's go-ahead of 2026-10-09 ("design the details, build end to end"). Every choice
made here without a legacy answer is listed under "Flagged".

### Slice 5: partner van bills (legacy `§vanBill`)

**What a bill is.** One per partner, month and ten-day period (1 = days 1–10, 2 = 11–20, 3 = 21–end),
legacy's key `partner|YYYY-MM|period`. The partner is a van's `partner_name`, trimmed (legacy
`vbSupOf`); a partner van with none is `(ไม่ระบุผู้ให้บริการ)`. Only `ownership: partner` vans bill.

**Fields and their authority.**

| Field | Kind | Rule |
|---|---|---|
| `partner`, `month`, `period` | client fact | the bill's address; `month` `YYYY-MM`, `period` 1–3 |
| `per_pax` | client fact | sale price per passenger for the whole period, ≥ 0 |
| `rate` | client fact | the old single default rate per van, ≥ 0 (legacy `st.rate`) |
| `route_rates` | client fact | default rate per van per route code (`PP`, `PB`, `MT`, `SM`, `SR`, `—`), ≥ 0 |
| `row_overrides` | client fact | per row key: `rate`, `ex`, `cut`, `per` (each ≥ 0 or absent); keys must be a current row or one already stored |
| `extra_lines` | client fact | hand-typed lines: `id`, `date`, `note`, `vans`, `pax`, `rate`, `ex`, `cut`, `per_pax` |
| `rows` and every amount | computed | from bookings, van parts and check-ins; never stored |
| `seen` | computed | the row keys when staff last saved with `mark_seen: true` (legacy `§vbSeen`) |
| `new_rows` | computed | rows not overridden and not in `seen` (legacy `§vbNewRow`) |
| `updated_at`, `updated_by` | computed | the login and time of the last change |
| `sent`, `paid` | validated | **new** (decided 2026-10-09): commands below |

**Rows** (legacy `vbRows`, `§vbRetMerge`, `§vbPaxReal`): for every booking not cancelled, rejected or
weather-cancelled, every trip in the period:
- **passengers aboard** = booked per category less those lost at check-in (legacy `ckLostByType` /
  `ckPaxLeft`): live no-show and on-site-cancel events of the van and pier records; a van no-show
  whose reason is `self_arrive` or `own_transfer`, or reinstated at the pier, is not lost; a pier
  `self_add` gives people back; events with no category breakdown come off adults.
- one **part** (whole trip): its group's van, the aboard counts by category. Several parts: each part's
  van, its share of the aboard total in proportion to its booked size, the remainder to the last, all
  shown as adults (legacy).
- one row per date + route + van; `pax` aboard, `booked_pax` booked, `bookings` count.
- **return leg**: a part's explicit return van (its own, else its group's) that is not
  `return_same_van`: if that van already has an outbound row that day and route, the passengers join
  it as `return_pax` (one run, not two); else it gets a return-only row (`key …~R`) with `pax` 0.
- `pickups` and `drops` (names, a drop `changed` when the booking set its own drop-off) are labels.
- **code** is legacy's fixed `VB_CODE` by route id (r7–r10 PP, r11 PB, r12 MT, r1–r5 SM, r6 SR, else `—`).

**Amounts** per row: `rate` = override `rate`, else `route_rates[code]`, else `rate`; `per_pax` =
override `per`, else `per_pax`; `bill = rate + ex − cut`; `sale = pax × per_pax`; `pl = sale − bill`.
Extra line: `bill = vans × rate + ex − cut`, `sale = pax × per_pax`. Totals add rows and lines;
`avg_pax_per_van` divides by outbound vans only. `by_code` groups vans by the same (rate, ex, cut)
(legacy `§vbMix`). Overview per partner: `trips`, `pax`, `missing_rate` (vans with no rate), `bill`,
`sale`, `pl`, `by_code`, the state; partners with no trip are left out (legacy `vbAgg`).

**Sent and paid (new).** `draft` → `sent` → `paid`.
- `POST …/send` stamps `sent.at/by` and `sent.bill` (the total then); re-sending re-stamps.
  `changed_since_sent` is `true` while the total differs from `sent.bill`.
- `POST …/pay` `{ via: transfer|cash|cheque, ref?, paid_on? }`: needs the bill sent (`409 bill_not_sent`);
  stamps `paid.at/by/on/via/ref/amount` (the total then).
- `POST …/unpay` and `POST …/unsend` take a step back (`unsend` on a paid bill: `409 bill_paid`).
- A paid bill refuses edits and `pull-rates` (`409 bill_paid`: "undo the payment first").

**Endpoints** (writes need `accounting`, as legacy `laGuardEdit('accounting')`; reads any login):

| Method + path | Does |
|---|---|
| `GET /v1/van-bills?month=&period=` | the overview: every partner with work in the period |
| `GET /v1/van-bills/{partner}/{month}/{period}?van_id=` | one bill; `van_id` shows one van's rows |
| `PATCH /v1/van-bills/{partner}/{month}/{period}` | the staff inputs; a field sent replaces that whole field; `mark_seen: true` |
| `POST …/pull-rates` | fills `route_rates` from the van rates (legacy `vbPullRates`) |
| `POST …/send`, `…/unsend`, `…/pay`, `…/unpay` | the settlement state |
| `GET /v1/van-rates`, `PUT /v1/van-rates` | Transfer Fleet's rate table (legacy `van_rates`) |

Errors: unknown partner `404`; a bad month or period `400`; a negative amount, unknown code or unknown
row key `400`; a computed field sent with a different value `400` naming the command.

```jsonc
// PATCH /v1/van-bills/Queen/2026-09/1
{ "per_pax": 200, "route_rates": { "PP": 1500 }, "row_overrides": { "2026-09-01~r10~veh15": { "ex": 200 } },
  "extra_lines": [ { "date": "2026-09-01", "note": "รถนอก", "vans": 1, "pax": 0, "rate": 700 } ], "mark_seen": true }
```

**Van rates** (legacy `vanRate`): `{ group, route_id, field, rate }` cells; `group` `own` or `p:<partner>`;
`route_id` null for the group's base; `field` `base`, `PK` or `KL`. Lookup: route + zone, route base,
group base, else 900 (own) / 1,800 (partner). `PUT` sets or (rate `null`) clears one cell. Writes:
`accounting` or `fleet`. `pull-rates` takes, per code with work, the first route with a rate > 0 for
the partner's group and first van's zone; `generic` lists codes that fell back to the group base.

**Schema** (migration 120): `van_bills` (id, partner, month, period UNIQUE, per_pax, rate, seen TEXT[],
updated_*, sent_at/by/bill, paid_at/by/on/via/ref/amount; paid needs sent), `van_bill_route_rates`
(bill, code, rate), `van_bill_row_overrides` (bill, row_key, rate, ex, cut, per; NULL = not set),
`van_bill_extra_lines` (bill, id, seq, line_date, note, vans, pax, rate, ex, cut, per_pax),
`van_rates` (group_key, route_id NULL = base, field, rate, UNIQUE NULLS NOT DISTINCT),
`daily_report_settings` (one row: van_cost, van_quota, target_per_pax, NULL = legacy default).

**Import.** `van_bill` rows with a 3-part key, upserted on (partner, month, period): inputs replaced,
sent/paid kept (they are ours). The 4-part old keys are skipped. `app_meta.van_rates` and `dr_cfg`
replaced whole. Mapping in `src/tools/legacy-van-bills.ts`.

### Slice 6: reports (computed `GET`s, nothing stored)

- `GET /v1/reports/accounting` (legacy `renderAccounting`, `acctDashboardHtml`): `outstanding`,
  `paid_this_month`, `credit_exposure` (Σ agents' credit `used`), `overdue_invoices`, `deposits_held`
  (Σ credit balances), `aging` {`not_due`, `days_1_30`, `days_31_60`, `days_60_plus`} by `due_at`,
  `collections` (6 Bangkok months, live non-credit payments by `paid_on`), `top_outstanding` (5 agents).
- `GET /v1/agents/{id}/statement` (legacy `acctStatementOpen`): `invoiced`, `paid` (net of refunds and
  credits), `outstanding`, `credit_balance`, `credit`, live `invoices` newest first, `credits`.
- `GET /v1/reports/travel-summary?date=` (legacy `renderTravelSum` totals): bookings, booked,
  travelled, no-show, on-site cancels; upgrade money by method, fees, sales, commission; cash on tour;
  `to_collect`.
- `GET /v1/reports/daily?date=` (legacy `drData` / `drPaneFi`): revenue, by route, market, pay
  channel and agent; van cost from the van rates (legacy `drVanReal`), else `van_cost` × vans.
- `GET`/`PUT /v1/reports/daily/settings` (legacy `dr_cfg`): `van_cost` 1,200, `van_quota` 6,
  `target_per_pax` 130 when unset.

Reports refuse a login tied to one agent (`403`); its statement is its own.

## Open

1. **Deposits and refunds.** The weather outcomes are built (migration 061, README "Weather closures,
   refund and credit"): a `refunds` row of kind `refund` (owed to the agent) or `credit` (the agent's
   balance, spent as a payment with method `credit`). Still open:
   - legacy's manual deposit ("รับมัดจำ", `acctDepositSubmit`): money received with no invoice. It fits
     as a `credit` with no invoice, which `refunds.invoice_id NOT NULL` does not allow yet;
   - paying a refund out (method, date, slip): legacy had no step either;
   - the agent statement's "Deposit held" (slice 6) reads `credit_balance`.
