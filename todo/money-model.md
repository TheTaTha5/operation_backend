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


## Design: slices 2, 3 and 4 (2026-10-09, built on `feat/money-pier-and-after-trip`)

Built to the decisions above without a second stop (the developer said build). Where legacy says
nothing, legacy's behaviour is the default and the choice is listed under **Flagged** at the end.

**Every booking command below** (`/v1/bookings/{id}/…`) needs `If-Match` (or `version`) from a login,
adds 1 to the booking's `version`, and lands on the change feed as a booking change, like every other
booking command. Rows answer the booking's `version` so a screen can send it back.

**Money:** NUMERIC(12,2). Pier payments and on-tour sales keep satang (legacy §pierDecimal); COT
decisions and no-show amounts are whole baht, as legacy rounds them (`_tsCotNum`, `tsSet`).

### Slice 2: Proforma (Daily PFM) — `src/domain/pfm.ts`, migration 110

| Field | Authority | Rule |
|---|---|---|
| in scope, `kind` | computed | `proforma`: the agent's `pay_type` is `proforma`. `prepay`: an `invoice` agent whose booking has a live `prepay` invoice. Cancelled, rejected and weather-cancelled bookings are out. |
| `travel_date` | computed | the booking's first trip date inside the asked range (legacy `_btDate`) |
| `cutoff_at` | computed | 18:00 Bangkok the day before the booking's **first** trip (decided) |
| `total`, `paid`, `balance` | computed | with an invoice: the invoice's `total`, what is paid on it (less refunds), its `balance`. Without: the booking's total + fee items − its COT deductions; nothing paid. A `prepay` row counts only what was paid (legacy `_got`). |
| `status` | computed | legacy's chip, first that fits: `hold`, `approved`, `paid`, `prepaid_part` (prepay), `alert` (past cutoff, unpaid, no decision), `awaiting` (invoiced), `no_invoice` |
| `decision` | validated | `approved` (with free-text `approver`) or `hold`; anyone with the area; refused unless the row is a proforma one, unpaid and past its cutoff (legacy shows the buttons only then) |
| `reminded_at` | computed | the last reminder |

```sql
CREATE TABLE booking_pfm_events (            -- legacy ops.pfm, every decision and reminder kept
  id BIGSERIAL PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('approved', 'hold', 'reminded')),
  approver TEXT,                              -- approved only: who extended, free text
  by TEXT, at TIMESTAMPTZ NOT NULL,
  CHECK ((kind = 'approved') = (approver IS NOT NULL)));
```

| Method + path | Body | Answers | Area |
|---|---|---|---|
| `GET /v1/pfm?date=` or `?from=&to=` | — | `{ from, to, rows, totals }` | any login (an agent's login: its own) |
| `POST /v1/bookings/{id}/pfm/approve-travel` | `{ approver?, version }` | the row | operations or accounting |
| `POST /v1/bookings/{id}/pfm/hold` | `{ version }` | the row | operations or accounting |
| `POST /v1/pfm/remind` | `{ from, to }` or `{ date }` | `{ reminded: [booking ids] }` | operations or accounting |

```jsonc
// a row
{ "booking_id": "BK-1", "version": 4, "voucher_ref": "V-881", "agent_id": "a12", "agent_name": "Andaman Tours", "sales_name": "Nok",
  "kind": "proforma", "travel_date": "2026-10-12", "route_id": "r10", "pax": 4, "cutoff_at": "2026-10-11T11:00:00.000Z", "past_cutoff": true,
  "total": 5600, "paid": 0, "balance": 5600, "invoice": { "id": "inv_…", "number": "INV-2610-0012", "status": "issued" },
  "status": "alert", "decision": null, "reminded_at": "2026-10-11T02:00:00.000Z", "cot_deduct": 0 }
// totals: { "count": 12, "total": 61200, "paid": 40000, "unpaid": 21200, "collected_pct": 65, "alert": 2, "by_status": { "paid": 7, … } }
```

- **Refused** (`409`): `booking_cancelled`; `not_proforma` (a prepay row has no cutoff: legacy shows no
  button); `pfm_paid` (nothing owed); `before_cutoff`; `pfm_decided` (the same decision again). A
  decision may replace the other one (approve after hold): legacy hid the buttons once decided.
- `approver` defaults to the booking's salesperson (legacy `pfmSalesName`); with neither, `400`.
- **History**, legacy's words: `PFM unpaid · travel EXTENDED by Nok`, `PFM unpaid · put on hold`,
  `PFM payment reminder sent`.
- **Remind** logs on every proforma booking in the range that still owes (legacy `pfmRemindAll`, held
  and approved ones too) and answers which; none is `200` with `reminded: []`.
- **Hold blocks nothing** (decided). "Issue all" is `POST /v1/invoices` per booking.
- **Import:** legacy lost `ops.pfm` on every save, but its history lines say what was decided: 69
  reminders and 2 "travel EXTENDED by" become events (`lg_`-prefixed bookings, replaced on every run).

### Slice 3: Pier money — `src/domain/pier-money.ts`, migration 111

**Pier payments** (legacy `bk.pierPayments`, `pckPaySave`):

| Field | Authority | Rule |
|---|---|---|
| `service_date` | validated | one of the booking's trip dates |
| `method`, `amount`, `note`, `slip_ids` | client fact | `cash`/`transfer`/`card`; `amount > 0` (a line of 0 is dropped, as legacy drops it) |
| `fee_pct` or `fee` | client fact, card only | a fee on another method is `400` |
| `fee` | computed from `fee_pct` | `amount × fee_pct / 100` to the satang; never part of `amount` (amount pays the debt; amount + fee is the card machine's figure) |
| `id`, `by`, `at` | computed | |

```sql
CREATE TABLE booking_pier_payments (
  id TEXT PRIMARY KEY, booking_id TEXT NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  service_date DATE NOT NULL, method TEXT NOT NULL CHECK (method IN ('cash', 'transfer', 'card')),
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0), fee NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (fee >= 0),
  fee_pct NUMERIC(5,2) CHECK (fee_pct BETWEEN 0 AND 100), note TEXT, by TEXT, at TIMESTAMPTZ NOT NULL,
  deleted_at TIMESTAMPTZ, deleted_by TEXT, delete_reason TEXT,
  CHECK (method = 'card' OR (fee = 0 AND fee_pct IS NULL)));
CREATE TABLE booking_pier_payment_slips (payment_id … ON DELETE CASCADE, seq, attachment_id REFERENCES attachments, PK (payment_id, seq));
```

**On-tour sales** (legacy `SB_EXTRAS`, `bkV2ExtraSave`, `bkV2ExtraCollect`):

| Field | Authority | Rule |
|---|---|---|
| `service`, `qty` (≥ 1), `unit_price` (> 0), `to_company` (0 … total), `seller`, `slip_ids` | client fact | legacy says "ใส่ราคา" with no price |
| `method` | client fact | `cash`, `transfer`, `card`, or `cot` (sold now, collected on the travel day) |
| `fee_pct` | client fact | card only, at most 5 (legacy's cap) |
| `trip_date` | validated | one of the booking's trip dates; default its first (legacy `bkV2ExtraDayOf`) |
| `total` = qty × unit_price, `commission` = total − to_company, `fee`, `customer_paid` = total + fee | computed | `400` naming the field when sent different |
| `settle` | computed | `pending` while `method` is `cot`, `done` otherwise; `collect` turns a `cot` sale into cash |
| `collected_at`, `collected_by`, `sold_at`, `sold_by` | computed | |

```sql
CREATE TABLE booking_tour_sales (
  id TEXT PRIMARY KEY, booking_id TEXT NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  trip_date DATE, service TEXT NOT NULL, qty INTEGER NOT NULL CHECK (qty >= 1),
  unit_price NUMERIC(12,2) NOT NULL CHECK (unit_price > 0), to_company NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (to_company >= 0),
  seller TEXT, method TEXT NOT NULL CHECK (method IN ('cash', 'transfer', 'card', 'cot')),
  fee_pct NUMERIC(5,2) NOT NULL DEFAULT 0, fee NUMERIC(12,2) NOT NULL DEFAULT 0,   -- fee stored: legacy's are whole baht
  collected_at TIMESTAMPTZ, collected_by TEXT, sold_at TIMESTAMPTZ NOT NULL, sold_by TEXT,
  CHECK (to_company <= qty * unit_price), CHECK (method = 'card' OR fee = 0));
CREATE TABLE booking_tour_sale_slips (sale_id … ON DELETE CASCADE, seq, attachment_id, PK (sale_id, seq));
```

**Upgrades:** `collected` is no longer a free toggle (decided "the same rule"). A new upgrade may say
it; changing an existing one's `collected` in `PATCH` is `400` naming
`POST /v1/bookings/{id}/upgrades/{upgrade_id}/collect` (`{ method?, fee_pct?, slip_ids? }`, cash by
default, as legacy's collect button).

**The amount owed at the pier** (legacy `pckMoney`, computed, never stored), for one booking and day:
- `cot`: the booking's cash on tour, `upgrades_due`/`upgrades_got`: its upgrades not collected /
  collected, `b2c_balance`: what Love Kingdom says is still owed. All three are 0 on an overnight
  return leg (`overnight_return: true`, legacy §ovnSettled).
- `tour_sales_due`/`tour_sales_got`: its on-tour sales of that day (or with no day), `cot` ones due.
- `gross = cot + upgrades_due + b2c_balance + tour_sales_due`; `paid`/`fees`: its live pier payments
  that day; `due = max(0, gross − paid)`; `got = tour_sales_got + upgrades_got + paid`;
  `no_slip`: transfer and card payments without a slip.
- `b2c_balance` needs Love Kingdom's payment state on the booking: four new header fields, client
  facts, `payment_paid`, `payment_paid_status`, `payment_deposit`, `payment_balance` (legacy
  `paymentSnapshot.paid/paidStatus/deposit/balance`; 58 legacy bookings owe ฿514,079).

**Settlement** (decided: build it; legacy never had it):
- **Pier cash hand-over** at day close, per day and pier (`routes.pier`, `other` when none):
  expected amounts by method are computed from the day's pier payments, collected on-tour sales and
  upgrades sold that day; the pier staff send `cash_counted` and a note; `cash_difference` is
  computed; accounting accepts it. One live hand-over per day and pier (`409 already_handed_over`;
  void it to redo, never once accepted). A later pier payment for that day is **not refused**: the
  read shows `expected_now` beside what was handed over and `changed: true`.
- **Commission payouts:** a payout pays one seller the commission of on-tour sales and upgrades it
  names; the amount is computed. Refused: another seller's item (`400 seller_mismatch`), no
  commission, a `cot` sale not yet collected (`409 not_collected`), an item already on a live payout
  (`409 already_paid`). Void frees its items.

```sql
CREATE TABLE pier_handovers (id TEXT PRIMARY KEY, service_date DATE NOT NULL, pier TEXT NOT NULL,
  expected JSONB NOT NULL, cash_counted NUMERIC(12,2) NOT NULL CHECK (cash_counted >= 0), note TEXT,
  handed_by TEXT, handed_at TIMESTAMPTZ NOT NULL, accepted_by TEXT, accepted_at TIMESTAMPTZ, accept_note TEXT,
  voided_by TEXT, voided_at TIMESTAMPTZ, void_reason TEXT);
CREATE UNIQUE INDEX pier_handovers_live ON pier_handovers (service_date, pier) WHERE voided_at IS NULL;
CREATE TABLE commission_payouts (id TEXT PRIMARY KEY, seller TEXT NOT NULL, amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL CHECK (method IN ('cash', 'transfer')), paid_on DATE NOT NULL, ref TEXT, note TEXT,
  created_by TEXT, created_at TIMESTAMPTZ NOT NULL, voided_by TEXT, voided_at TIMESTAMPTZ, void_reason TEXT);
CREATE TABLE commission_payout_items (payout_id … ON DELETE CASCADE, kind TEXT CHECK (kind IN ('tour_sale', 'upgrade')),
  booking_id TEXT NOT NULL, item_id TEXT NOT NULL, amount NUMERIC(12,2) NOT NULL, PRIMARY KEY (payout_id, kind, booking_id, item_id));
-- change feed: 'pier_handover', 'commission_payout' appended to changes_kind_check
```

| Method + path | Body | Answers | Area |
|---|---|---|---|
| `GET /v1/pier-money?date=&route_id=&pier=` | — | `{ rows }`: every booking holding seats that day | any login |
| `GET /v1/bookings/{id}/pier-money?date=` | — | one row, with `payments` and `tour_sales` | any login |
| `POST /v1/bookings/{id}/pier-payments` | `{ service_date, lines: [{ method, amount, fee_pct? \| fee?, note?, slip_ids? }], overpay_anyway?, version }` | `201` the row | pier, operations or accounting |
| `POST /v1/bookings/{id}/pier-payments/{pid}/slips` | `{ slip_ids, version }` | the row | same |
| `DELETE /v1/bookings/{id}/pier-payments/{pid}?reason=` | `If-Match` | the row | same |
| `GET /v1/bookings/{id}/tour-sales` | — | `{ tour_sales }` | any login |
| `POST /v1/bookings/{id}/tour-sales` | the sale, `version` | `201` the sale | operations |
| `PATCH /v1/bookings/{id}/tour-sales/{sid}` | client facts, `version` | the sale | operations |
| `POST /v1/bookings/{id}/tour-sales/{sid}/collect` | `{ method?, fee_pct?, slip_ids?, version }` | the sale | operations |
| `DELETE /v1/bookings/{id}/tour-sales/{sid}` | `If-Match` | `204` | operations |
| `POST /v1/bookings/{id}/upgrades/{uid}/collect` | `{ method?, fee_pct?, slip_ids?, version }` | the booking | operations or accounting |
| `GET /v1/pier-handovers?from=&to=&pier=` / `GET …/{id}` / `GET /v1/pier-handovers/preview?date=&pier=` | — | hand-overs / the day's expected amounts | any login but an agent's |
| `POST /v1/pier-handovers` | `{ service_date, pier, cash_counted, note? }` | `201` | pier or operations |
| `POST /v1/pier-handovers/{id}/accept` / `…/void` | `{ note? }` / `{ reason? }` | the hand-over | accounting / pier or operations |
| `GET /v1/commissions?seller=&from=&to=&paid=` | — | `{ items, totals }` | any login but an agent's |
| `GET /v1/commission-payouts?seller=&from=&to=` / `POST` / `POST …/{id}/void` | `{ seller, items: [{ kind, booking_id, id }], method, paid_on?, ref?, note? }` | | accounting |

```jsonc
// GET /v1/bookings/BK-1/pier-money?date=2026-10-12
{ "booking_id": "BK-1", "version": 6, "service_date": "2026-10-12", "overnight_return": false,
  "cot": 3000, "cot_currency": "THB", "cot_handling": "deduct", "cot_note": null,
  "upgrades_due": 1100, "upgrades_got": 0, "b2c_balance": 0, "tour_sales_due": 0, "tour_sales_got": 650,
  "gross": 4100, "paid": 2000, "fees": 0, "due": 2100, "got": 2650, "no_slip": 0, "term": "invoice", "paid_status": null,
  "payments": [ { "id": "pp_…", "service_date": "2026-10-12", "method": "cash", "amount": 2000, "fee": 0, "fee_pct": null,
                  "note": null, "slips": [], "by": "GSA.PK01", "at": "…", "deleted_at": null } ],
  "tour_sales": [ /* as GET …/tour-sales */ ] }
```

- **Refused** for a pier payment: no line above 0 (`400`, legacy "ใส่จำนวนเงินก่อน"); a day that is not
  one of the booking's trips (`409 not_on_trip`); a cancelled booking (`409 booking_cancelled`); more
  than `due` (`409 overpayment` with both amounts; `overpay_anyway: true` is legacy's "บันทึกต่อไหม?").
- **Boarding:** nothing is refused for money owed (legacy `pckPayGuard` is a warning); the board
  reads `due`.
- **Deleting** a pier payment keeps it with `deleted_*` (as invoice payments, decided 2026-10-09);
  legacy deleted it outright.
- **History**, legacy's words: `เก็บเงินหน้าท่า ฿2,000 (เงินสด)`, `… · แบ่งจ่าย 2 วิธี (…)`,
  `Day-of extra · Longtail Join ×2 · ฿1,300 · คอม ฿390 (cash)`, `Edited extra · …`,
  `Collected on tour · Longtail Join · ฿1,300 (cash)`.

### Slice 4: After the trip — `src/domain/after-trip.ts`, migration 112

**Cash-on-tour decision** (legacy `TS_COT`, `tsCotPick`), per booking and trip date:

| Field | Authority | Rule |
|---|---|---|
| `mode` | client fact | `full`, `part`, `none`, `payout`, `nocol` |
| `deduct`, `payout` | computed except `part` | `full`: deduct = COT; `payout`: payout = COT; `none`/`nocol`: 0; `part`: client's (default deduct = COT). Whole baht. |
| `ref`, `slip_ids` | client fact | `nocol` keeps its reason in `ref`, as legacy does; slips survive a change of mode |
| `over` | computed | `deduct + payout > COT`: a warning (`cot_over`), as legacy |

Refused: no cash on tour on the booking (`409 no_cash_on_tour`), a day that is not one of its trips
(`409 not_on_trip`), `deduct`/`payout` sent with a mode that computes them and different (`400`).

**The invoice subtracts `deduct`** (decided). An invoice is frozen at issue, and a PFM invoice is
issued before the trip, so the deduction is a line of its own:
- the booking's live booking or prepay invoice gets one **minus line** per trip date with a deduction
  (`amount: −1500`, `cot_date`, label `Cash on tour deducted · 2026-10-12`); its totals and VAT are
  worked out again as a discount's are (`invoiceAmounts`). A changed decision changes that line; a
  cleared one (or deduct 0) takes it off (`removed_reason: 'cot'`). A fee invoice is never touched.
- a booking not yet invoiced gets the minus lines when it is invoiced (`invoiceLines`), and a voided
  invoice's next one gets them again.
- an invoice already paid can end up paid above its new total: the invoice reads `overpaid` (new,
  computed) and the decision answers a warning `invoice_overpaid`. Turning that into a refund or
  credit is accounting's (open item).
- the booking's history gets `Invoice INV-… · cash on tour deducted ฿1,500 · total ฿4,100`.

**No-show charge decision** (legacy `travel_sum`, `tsPick`), per booking and trip date: `decision`
`full` (amount = the trip's price, computed: legacy `tsTripAmount`, 0 on an overnight return leg, a
trip's own subtotal on a multi-trip booking, else the booking's total), `partial` (amount the
client's), `none` or `postpone` (amount 0); `note`. It creates no invoice and moves nothing
(`postpone` is a label; the screen opens the reschedule, as legacy).

```sql
CREATE TABLE booking_cot_decisions (booking_id … ON DELETE CASCADE, service_date DATE NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('full', 'part', 'none', 'payout', 'nocol')),
  deduct NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (deduct >= 0), payout NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (payout >= 0),
  ref TEXT, by TEXT, at TIMESTAMPTZ NOT NULL, PRIMARY KEY (booking_id, service_date));
CREATE TABLE booking_cot_decision_slips (booking_id, service_date, seq, attachment_id, FK to the decision ON DELETE CASCADE);
CREATE TABLE booking_noshow_charges (booking_id … ON DELETE CASCADE, service_date DATE NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('full', 'partial', 'none', 'postpone')),
  amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (amount >= 0), note TEXT, by TEXT, at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (booking_id, service_date));
ALTER TABLE invoice_lines ADD COLUMN cot_date DATE;   -- set on a cash-on-tour deduction line
```

| Method + path | Body | Answers | Area |
|---|---|---|---|
| `GET /v1/after-trip?date=` | — | `{ rows }`: each booking travelling that day, its COT and its trip amount, with both decisions | any login (an agent's: its own) |
| `GET /v1/bookings/{id}/after-trip` | — | `{ cot_decisions, noshow_charges }` | any login |
| `PUT /v1/bookings/{id}/cot-decisions/{date}` | `{ mode, deduct?, payout?, ref?, slip_ids?, version }` | `{ decision, invoice, warnings }` | operations |
| `DELETE /v1/bookings/{id}/cot-decisions/{date}` | `If-Match` | `{ decision: null, invoice, warnings }` | operations |
| `PUT /v1/bookings/{id}/noshow-charges/{date}` | `{ decision, amount?, note?, version }` | the decision | operations |
| `DELETE /v1/bookings/{id}/noshow-charges/{date}` | `If-Match` | `204` | operations |

### Import (`src/tools/legacy-pier-money.ts`, pure, with `test/legacy-pier-money.test.ts`)

| Legacy | Here | Notes |
|---|---|---|
| `sb_bookings.pierpayments` (158 on 156 bookings) | `booking_pier_payments` + slips | id kept; a slip not copied by `import:attachments` is dropped and counted |
| `sb_extras` (160) | `booking_tour_sales` + slips | `date` → `sold_at`; `settle` `done` on a non-`cot` sale has no `collected_at` (legacy lost it) |
| `ts_cot` (143) | `booking_cot_decisions` + slips | key `date::booking`; imported as legacy has them (2 over the COT, 4 on bookings whose COT was since removed) |
| `travel_sum` (76) | `booking_noshow_charges` | 8 sit on a day the booking no longer travels (rescheduled): kept |
| history `PFM …` lines | `booking_pfm_events` | 69 reminders, 2 approvals |
| `paymentsnapshot_paid/paidstatus/deposit/balance` | the four new header columns | |

Replaced on every run with the bookings (`ON DELETE CASCADE`), as invoices are: legacy stays master
for money until Money moves. Imported invoices get **no** COT minus lines: they keep legacy's
amounts, so totals match legacy; the run lists the invoiced bookings that carry a deduction.
