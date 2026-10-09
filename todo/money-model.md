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

## Design: the rest of Money (decided 2026-10-10)

Four parts, all decided: (1) the cost model and Trip P&L, (2) a refund's payout, (3) deposits into
the agent's credit, (4) an overpaid invoice stays a manual matter (no change: the `overpaid` read
stays). Legacy, read 2026-10-10 (wt-lk-inbox `08-app.js` `ct*`, `mv*`, `px*`, `ta*`, `pckMeal*`,
`drLtRate`, `acctDeposit*`; `05-fleet.js` `flFuelPriceEff`). Legacy data, read-only, 2026-10-10:
`cost_template` 22 lines, `cost_plans` 10 plans, `boat_rent` 2 boats (one with a rent), 3 meal venues,
6 routes linked to a venue, 91 `trip_actuals` (90 meals sent, 36 notes, 2 overnight choices, none
closed, none "ran"), 1 `pier_job.mv` (`'-'`), 0 deposits (legacy never saved `sb_deposits`).

### What legacy does

- **Cost template** (`cost_template`, `CT_DEFAULT`, `ctTplFill`): a VAT rate and cost lines in groups.
  A line has parts: `fix` (per boat or per trip: qty × unit, or litres × the fuel price), `var` (per
  head, four prices: adult/child × foreign/Thai, each falling back to a wider one), `step` (guides:
  one per N heads, at least M; or +N crew over X heads). Lines marked `od` (van, longtail join and
  charter) are priced per item ordered, not per head. A default line missing from a stored template
  is added back unless it was deleted (`dropped`).
- **Cost plans** (`cost_plans`): a route's design sheet (boat count, engines, capacity, pax, Thai pax,
  price, child price and %, commission, fuel price, pinned boat) with per-line overrides (`ovr`: off,
  or part values), per-group settings (`grp`: off, ±%), on-demand quantities and revenue (`od`), an
  itinerary and price tiers. `ctCalc` prices the lines; `ctBreakEven` walks 1..seats for the first
  profitable head count. Trip P&L uses only a plan's `ovr`/`grp` (and its fuel price as a last resort).
- **Rented boats** (`boat_rent`, `ctRentOf`): per boat, a monthly rent (lump, or per seat × the boat's
  seats), days in the period, days off, trips a day, VAT, contract dates, a fuel % and the lines the
  owner pays (`ex`: depreciation, captain, crew). Per trip = rent ÷ (days − off) ÷ trips. Outside the
  contract dates, or with no rent, the boat costs as the company's own.
- **Meal venues** (`meal_venues`, `mv*`) and the route's venue (`routes.mealVenueId`); the pier job
  sheet can name another venue for one boat and day, or `-` for no meal (`pjOf().mv`).
- **Trip actuals** (`trip_actuals`, keyed `date::boat`): `meal` is written when the pier sends the
  meal order (`pckMealSend`: on-board heads, adults and children, × the venue's prices, frozen);
  `mealNote` (a note to the restaurant), `mealOvn` (per overnight return booking: meal `in` or `out`;
  the order is refused while one is undecided), `closed` (the frozen P&L), `ran` (sailed empty).
- **Trip P&L** (`pxTrip`, `pxDay`): every deployed boat of the day (optionally one pier), sorted by
  departure. Pax on board (`pckOnBoard`) of the bookings on the boat, Thai share for park fees;
  revenue = Σ trip amounts (`tsTripAmount`); the route's plan; fuel price `flFuelPriceEff`, else the
  plan's. `ctCalc` gives each line's estimate; actuals replace it line by line: fuel = litres from the
  Daily Fleet Log × price, meal = the order sent, van = each van's day rate shared by heads
  (`pxVanCost`), longtails = what was ordered (`bkLtState`), rent = the contract. Revenue net =
  (bookings + on-tour company share) × (1 − VAT/(100+VAT)). Each line is labelled actual (`r`),
  plan-overridden (`p`), formula (`f`) or pending meal order (`w`). Closing freezes rows, cost and
  revenue (`pxClose`, accounting); a boat with no pax and no booking did not sail and costs 0 unless
  marked "ran" (`pxRan`, accounting). Break-even per trip at its own average price.
- **Daily Report**: the longtail cost (`drLtRate`: the route plan's `ltc`/`ltj` unit, defaults
  charter ฿600) × boats chartered and join heads; "left before boat costs" = revenue − (van cost +
  longtail cost) + on-tour sales.
- **Deposits** (`acctCreateDeposit`, `acctApplyDeposit`): agent, amount, method, note; spent as a
  payment; "Deposit held" on the statement and dashboard. Never saved in production.

### Fields and authority

| Thing | Field | Kind |
|---|---|---|
| Template | `vat_rate`, `lines[]` (`id`, `group`, `label`, `vat`, `parts`, `on_demand`, `on_demand_qty`) | client fact (shape checked) |
| | `dropped` | **computed**: default line ids not in `lines` |
| Plan | `name`, `route_key`, `note`, `engines`, `boats`, `capacity`, `pax`, `pax_th`, `price`, `price_child`, `child_pct`, `commission_pct`, `fuel_price`, `boat_id`, `rent_off`, `overrides`, `groups`, `on_demand`, `itinerary`, `tiers` | client fact (`route_key` a route or family, `boat_id` a boat) |
| | `seats`, `calc`, `break_even` | **computed** |
| Boat rent | `rented`, `mode`, `amount`, `per_seat`, `days`, `days_off`, `trips_per_day`, `vat`, `note`, `from`, `to`, `fuel_pct`, `owner_pays` | client fact |
| | `seats`, `total`, `run_days`, `per_day`, `per_trip`, `per_calendar_day` | **computed** |
| Meal venue | `name`, `place`, `price_adult`, `price_child`, `phone`, `eta`, `note`, `active` | client fact |
| Route | `meal_venue_id` | client fact (an existing venue), set by its own command |
| Trip actual | `venue` (`null` = the route's, a venue id, or `none`) | client fact |
| | `meal_note`, `meal_overnight[booking]` (`in`/`out`) | client fact |
| | `meal` (venue, adults, children, prices, amount, at, by) | **computed** by `meal-order` |
| | `ran` | **validated**: only on a boat with no pax and no booking |
| | `closed` (revenue, cost, profit, pax, rows, at, by) | **computed** by `close`; **validated**: not on a boat that did not sail |
| Trip P&L | everything | **computed** (`GET`) |
| Refund payout | `paid_on`, `method`, `ref`, `slip_ids` | client fact; **validated**: a `refund` (not a credit), once |
| | `paid_out_by`, `recorded_at` | **computed** |
| Deposit | `agent_id`, `amount`, `method`, `received_on`, `ref`, `note`, `slip_ids` | client fact (agent exists, amount > 0) |
| | `voided_*` | **validated** by `void`: a reason; not when the balance would go below 0 |
| Credit balance | `credited`, `deposited`, `used`, `available` | **computed** |

### Migrations

`160_costing.sql`:

```sql
CREATE TABLE cost_settings (id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id), vat_rate NUMERIC(5,2) NOT NULL CHECK (vat_rate >= 0),
  updated_at TIMESTAMPTZ NOT NULL, updated_by TEXT);
CREATE TABLE cost_lines (id TEXT PRIMARY KEY, sort INTEGER NOT NULL, group_name TEXT NOT NULL, label TEXT NOT NULL,
  vat BOOLEAN NOT NULL, parts JSONB NOT NULL, on_demand BOOLEAN NOT NULL DEFAULT false, on_demand_qty NUMERIC(8,2));
CREATE TABLE cost_plans (id TEXT PRIMARY KEY, sort INTEGER NOT NULL, name TEXT NOT NULL, route_key TEXT, note TEXT,
  engines TEXT NOT NULL CHECK (engines IN ('3EN','4EN')), boats INTEGER NOT NULL CHECK (boats >= 1), capacity INTEGER NOT NULL CHECK (capacity >= 1),
  pax INTEGER NOT NULL CHECK (pax >= 0), pax_th INTEGER NOT NULL CHECK (pax_th >= 0), price NUMERIC(12,2) NOT NULL, price_child NUMERIC(12,2),
  child_pct NUMERIC(5,2) NOT NULL DEFAULT 0, commission_pct NUMERIC(5,2) NOT NULL DEFAULT 0, fuel_price NUMERIC(8,2) NOT NULL DEFAULT 0,
  boat_id TEXT REFERENCES boats (id), rent_off BOOLEAN NOT NULL DEFAULT false,
  overrides JSONB NOT NULL DEFAULT '{}', groups JSONB NOT NULL DEFAULT '{}', on_demand JSONB NOT NULL DEFAULT '{}',
  itinerary JSONB NOT NULL DEFAULT '[]', tiers JSONB NOT NULL DEFAULT '[]', updated_at TIMESTAMPTZ NOT NULL, updated_by TEXT);
CREATE TABLE boat_rents (boat_id TEXT PRIMARY KEY REFERENCES boats (id), rented BOOLEAN NOT NULL, mode TEXT NOT NULL CHECK (mode IN ('lump','seat')),
  amount NUMERIC(12,2) NOT NULL DEFAULT 0, per_seat NUMERIC(12,2) NOT NULL DEFAULT 0, days INTEGER NOT NULL CHECK (days >= 1),
  days_off INTEGER NOT NULL CHECK (days_off >= 0), trips_per_day INTEGER NOT NULL CHECK (trips_per_day >= 1), vat BOOLEAN NOT NULL,
  note TEXT, from_date DATE, to_date DATE, fuel_pct NUMERIC(6,2), owner_pays TEXT[] NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL, updated_by TEXT);
CREATE TABLE meal_venues (id TEXT PRIMARY KEY, sort BIGSERIAL, name TEXT NOT NULL DEFAULT '', place TEXT, price_adult NUMERIC(12,2) NOT NULL,
  price_child NUMERIC(12,2) NOT NULL, phone TEXT, eta TEXT, note TEXT, active BOOLEAN NOT NULL DEFAULT true);
ALTER TABLE routes ADD COLUMN meal_venue_id TEXT REFERENCES meal_venues (id);
CREATE TABLE trip_actuals (service_date DATE NOT NULL, boat_id TEXT NOT NULL REFERENCES boats (id),
  venue_id TEXT REFERENCES meal_venues (id), no_meal BOOLEAN NOT NULL DEFAULT false,
  meal_venue_id TEXT, meal_venue_name TEXT, meal_adults INTEGER, meal_children INTEGER, meal_price_adult NUMERIC(12,2),
  meal_price_child NUMERIC(12,2), meal_amount NUMERIC(12,2), meal_at TIMESTAMPTZ, meal_by TEXT,
  meal_note TEXT, meal_note_at TIMESTAMPTZ, meal_note_by TEXT,
  ran BOOLEAN NOT NULL DEFAULT false, ran_at TIMESTAMPTZ, ran_by TEXT,
  closed_at TIMESTAMPTZ, closed_by TEXT, closed_revenue NUMERIC(12,2), closed_cost NUMERIC(12,2), closed_profit NUMERIC(12,2),
  closed_pax INTEGER, closed_rows JSONB,
  PRIMARY KEY (service_date, boat_id), CHECK (NOT (no_meal AND venue_id IS NOT NULL)), CHECK ((closed_at IS NULL) = (closed_rows IS NULL)));
CREATE TABLE trip_meal_overnight (service_date DATE NOT NULL, boat_id TEXT NOT NULL, booking_id TEXT NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  include TEXT NOT NULL CHECK (include IN ('in','out')), PRIMARY KEY (service_date, boat_id, booking_id),
  FOREIGN KEY (service_date, boat_id) REFERENCES trip_actuals (service_date, boat_id) ON DELETE CASCADE);
-- + change kind 'trip_actual', appended to changes_kind_check as migration 100 does.
```

`161_deposits_and_payouts.sql`:

```sql
CREATE TABLE refund_payouts (refund_id TEXT PRIMARY KEY REFERENCES refunds (id), paid_on DATE NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('transfer','cash','cheque')), ref TEXT, paid_out_by TEXT, recorded_at TIMESTAMPTZ NOT NULL);
CREATE TABLE refund_payout_slips (refund_id TEXT NOT NULL REFERENCES refund_payouts (refund_id) ON DELETE CASCADE, seq INTEGER NOT NULL,
  attachment_id TEXT NOT NULL REFERENCES attachments (id), PRIMARY KEY (refund_id, seq));
CREATE TABLE deposits (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents (id), amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL CHECK (method IN ('transfer','cash','card')), received_on DATE NOT NULL, ref TEXT, note TEXT,
  recorded_by TEXT, recorded_at TIMESTAMPTZ NOT NULL, voided_at TIMESTAMPTZ, voided_by TEXT, void_reason TEXT,
  CHECK ((voided_at IS NULL) = (void_reason IS NULL)));
CREATE TABLE deposit_slips (deposit_id TEXT NOT NULL REFERENCES deposits (id) ON DELETE CASCADE, seq INTEGER NOT NULL,
  attachment_id TEXT NOT NULL REFERENCES attachments (id), PRIMARY KEY (deposit_id, seq));
-- + change kinds 'deposit' and 'refund'.
```

### Contract

All under Bearer login; writes as listed in `writeNeed`. Errors are `{ statusCode, error, message, code? }`.

**Cost model** (`accounting`, legacy's costing menu sits under Accounting & Finance and had no guard):
- `GET /v1/costing/template` → `{ vat_rate, lines: [{ id, group, label, vat, parts: [{ kind: 'fix'|'var'|'step', per?: 'boat', qty?, qty_4en?, unit?, unit_4en?, unit_th?, unit_ch?, unit_ch_th?, fuel?, mode?: 'every'|'over', every?, min?, over?, add? }], on_demand, on_demand_qty }], dropped, saved }`. With nothing stored, legacy's `CT_DEFAULT`.
- `PUT /v1/costing/template` `{ vat_rate, lines }` replaces it. Legacy's short keys (`k q q4 u u4 uTH uCh uChTH g l od odQ`) are accepted. `400` on a bad shape, a duplicate id, a `fuel` part that is a `step`.
- `GET /v1/costing/plans` → `{ plans: [plan + { seats, calc: { gross, vat_in, net, fixed_net, var_net, revenue, profit, rows[], rent }, break_even }] }`; `GET /v1/costing/plans/{id}?pax=` prices it at another head count.
- `POST /v1/costing/plans` (fields, or `{ copy_of }`) `201`; `PATCH /v1/costing/plans/{id}`; `DELETE` `204`. Computed fields sent are `400`.
- `GET /v1/costing/boat-rents`; `PUT /v1/costing/boat-rents/{boat_id}` (fields merge onto the stored one, or onto a blank that is **not** rented, §rentZero); `DELETE` `204`.
- `GET /v1/meal-venues` → `{ venues, routes: { route_id: venue_id } }`; `POST /v1/meal-venues` `201`; `PATCH /v1/meal-venues/{id}`.
- `PUT /v1/routes/{id}/meal-venue` `{ meal_venue_id | null }` → the route. Route reads show `meal_venue_id`; a route `PATCH` or create sending one is `400` naming this command.

**Trip actuals and Trip P&L**:
- `GET /v1/trip-actuals/{date}/{boat_id}` → the row as stored, plus `meal_preview` (what `meal-order` would send now: venue, adults, children, amount, `undecided_overnight`).
- `PUT …/venue` `{ venue: id | 'none' | null }` (`pier`, `operations`; legacy's pier job sheet).
- `POST …/meal-order` (`operations`) → the row. `409 no_meal_venue`, `409 overnight_meal_undecided` (lists the bookings), `409 nobody_aboard`.
- `PUT …/meal-note` `{ text }` (empty/null clears), `PUT …/meal-overnight/{booking_id}` `{ include: 'in'|'out'|null }` (`operations`); the booking must be an overnight return leg on that boat and day (`400`).
- `POST …/close`, `POST …/reopen`, `POST …/ran`, `POST …/not-ran` (`accounting`): `409 trip_closed`, `409 trip_not_closed`, `409 trip_not_sailed` (close a boat that did not sail), `409 trip_not_empty` (ran on a boat with passengers or bookings), `404` when the boat has no deployment that day.
- `GET /v1/reports/trip-pl?date=&pier=` → `{ date, pier, trips: [trip], totals: { trips, revenue, cost, profit, pax, bookings, loss_trips, capacity }, by_route: [...], by_group: [...] }`.
- `GET /v1/reports/trip-pl/{date}/{boat_id}` → one trip: `{ boat_id, name, route_id, route_name, departs, status: 'est'|'part'|'done'|'nosail', pax: { ad, chd, inf, foc, total, th, fr, bookings }, revenue_gross, upsell: { rows, sell, company, commission }, revenue, cost, profit, would_cost, ran, closed: { at, by, pax } | null, fuel_price: { price, src, from }, plan: { id, name } | null, longtail: { charter, join, upgrades, upgrades_due }, rows: [{ id, group, label, vat, estimate, actual, use, gross, source: 'actual'|'plan'|'formula'|'pending', why }], break_even, check_revenue }`.
- `GET /v1/reports/trip-pl/month?month=YYYY-MM&pier=` → each day's totals and the month's.
- Daily Report (`GET /v1/reports/daily`) gains `longtail: { charter_boats, join_pax, cost, by_route }`, `known_cost` and `net_before_boat_costs`.

**Credit**:
- `POST /v1/refunds/{id}/payout` `{ paid_on?, method, ref?, slip_ids? }` (`accounting`) → the refund with `payout`. `409 not_a_refund` (a credit), `409 refund_paid_out`. `DELETE /v1/refunds/{id}/payout` undoes it. `GET /v1/refunds?paid_out=true|false`.
- `GET /v1/deposits?agent_id=&include_voided=`; `POST /v1/deposits` `{ agent_id, amount, method, received_on?, ref?, note?, slip_ids? }` `201`; `GET /v1/deposits/{id}`; `POST /v1/deposits/{id}/void` `{ reason }` → `409 deposit_spent` when the agent's balance would go below 0, `409 deposit_void`.
- `credit_balance` everywhere becomes `{ credited, deposited, used, available }`; a `credit` payment spends it. Agent statement gains `deposits`; the accounting dashboard's `deposits_held` is the balances left, and it gains `refunds_to_pay: { count, amount, items }`.

Example, a trip row:

```json
{ "id": "fuel", "group": "ค่าเชื้อเพลิง", "label": "น้ำมันเรือ", "vat": true, "estimate": 13457.94,
  "actual": 15519.63, "use": 15519.63, "gross": 16606, "source": "actual", "why": "400 ลิตร × ฿41.515" }
```

### Import

`npm run import:costing` (`src/tools/import-costing.ts`, mapping `src/tools/legacy-costing.ts`):
template and plans and boat rents and venues are **replaced whole** (legacy is master until Money
moves); routes' venue links set; trip actuals upserted on date and boat (legacy's meal, note,
overnight choices; ours' close/ran survive a re-run); `pier_job.mv` becomes the trip's venue. Boats or
bookings not here are skipped and listed. Run after `import-legacy.ts` (overnight choices name
imported `lg_` bookings) and `seed:boats`.

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
