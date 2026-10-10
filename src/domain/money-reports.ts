/**
 * The money reports (todo/money-model.md slice 6, decided 2026-10-09): computed on every read, nothing
 * stored. Legacy computed each in the browser:
 * - the accounting dashboard (`renderAccounting`, `acctDashboardHtml`);
 * - the agent statement (`acctStatementOpen`);
 * - Travel Summary's totals (`renderTravelSum`, `tsRows`, `tsSaleList`, `tsMoneyOf`);
 * - the Daily Report's money pane (`drData`, `drPaneFi`, `drVanReal`, `dr_cfg`).
 *
 * They read the pier's money and the decisions after the trip (Money slices 3 and 4, `pier-money.ts`,
 * `after-trip.ts`) through the same rules the pier screens use. Parts whose source is not here yet are
 * left out, not guessed: the longtail and other trip costs (the cost model, with Fleet). Pure, so both
 * stores decide identically.
 */
import { refuse } from './booking-actions.js';
import { todayInThailand } from './calendar.js';
import type { StoredAgent, Market } from './agents.js';
import type { CreditBalance } from './refunds.js';
import type { refundsToPay, StoredDeposit } from './credit.js';
type RefundsToPay = ReturnType<typeof refundsToPay>;
import type { Credit, InvoiceView, StoredPayment, StoredRefund } from './invoices.js';
import type { Booking, BookingTrip } from './operations.js';
import type { PickupArea } from './pickup-areas.js';
import type { Route } from './calendar.js';
import { PAX_CATEGORIES, parsePaxGrid } from './pax.js';
import { countsOf, partPax, type Counts } from './van-groups.js';
import type { Van } from './vans.js';
import { lostByType, summaryNoShow } from './aboard.js';
import { noRateSet, vanGroupKey, vanRate, type VanRate } from './van-bills.js';
import { livePier, pierMoney, saleCollected, saleTotal, tourSaleView, type MoneyBooking, type StoredPierPayment, type StoredTourSale } from './pier-money.js';
import type { StoredCotDecision, StoredNoshowCharge } from './after-trip.js';

const cents = (n: number): number => Math.round(n * 100) / 100;
const sum = (xs: readonly number[]): number => cents(xs.reduce((s, x) => s + x, 0));
const RELEASED = new Set(['cancelled', 'rejected', 'cancelled_weather']);
const DAY_MS = 86_400_000;

// ── Accounting dashboard ─────────────────────────────────────────────────────────────────────────

export type AccountingDashboard = {
  as_of: string; outstanding: number; paid_this_month: number; credit_exposure: number; overdue_invoices: number; deposits_held: number;
  /** Legacy `acctExtrasMonthTotal` ("Extras · cash · month"): every on-tour sale made this Bangkok month, whatever its method. */
  extras_this_month: number;
  aging: { not_due: number; days_1_30: number; days_31_60: number; days_60_plus: number };
  /** Refunds owed to agents and not paid out yet (todo/money-model.md, "Design: the rest of Money"). */
  refunds_to_pay: RefundsToPay;
  collections: { month: string; amount: number }[];
  top_outstanding: { agent_id: string | null; name: string | null; balance: number }[];
};
/** The last `n` Bangkok months, oldest first, ending with the month of `now`. */
export function lastMonths(now: Date, n: number): string[] {
  const [y, m] = todayInThailand(now).split('-').map(Number);
  return Array.from({ length: n }, (_, i) => { const d = new Date(Date.UTC(y, m - 1 - (n - 1 - i), 1)); return d.toISOString().slice(0, 7); });
}
/** Money received: a live payment that is not credit spent (legacy counted `type: 'payment'` only). */
const received = (p: StoredPayment): boolean => !p.deleted_at && p.method !== 'credit';

export function accountingDashboard(input: {
  invoices: readonly InvoiceView[]; payments: readonly StoredPayment[]; agents: readonly Pick<StoredAgent, 'id' | 'name'>[];
  credit_exposure: number; deposits_held: number; now: Date; refunds_to_pay?: RefundsToPay;
  /** On-tour sales; only those sold this month count. */
  sales?: readonly Pick<StoredTourSale, 'sold_at' | 'qty' | 'unit_price'>[];
}): AccountingDashboard {
  const { now } = input;
  const live = input.invoices.filter((i) => i.status !== 'void');
  const aging = { not_due: 0, days_1_30: 0, days_31_60: 0, days_60_plus: 0 };
  let overdue = 0;
  const byAgent = new Map<string | null, number>();
  for (const i of live) {
    if (!(i.balance > 0)) continue;
    const days = Math.floor((now.getTime() - Date.parse(i.due_at)) / DAY_MS);
    const bucket = days <= 0 ? 'not_due' : days <= 30 ? 'days_1_30' : days <= 60 ? 'days_31_60' : 'days_60_plus';
    aging[bucket] = cents(aging[bucket] + i.balance);
    if (Date.parse(i.due_at) < now.getTime()) overdue += 1;
    byAgent.set(i.agent_id, cents((byAgent.get(i.agent_id) ?? 0) + i.balance));
  }
  const months = lastMonths(now, 6);
  const collections = months.map((month) => ({ month, amount: sum(input.payments.filter((p) => received(p) && p.paid_on.slice(0, 7) === month).map((p) => p.amount)) }));
  const names = new Map(input.agents.map((a) => [a.id, a.name]));
  return {
    as_of: todayInThailand(now), outstanding: sum(live.map((i) => i.balance)), paid_this_month: collections[collections.length - 1].amount,
    credit_exposure: cents(input.credit_exposure), overdue_invoices: overdue, deposits_held: cents(input.deposits_held),
    refunds_to_pay: input.refunds_to_pay ?? { count: 0, amount: 0, items: [] },
    extras_this_month: sum((input.sales ?? []).filter((x) => todayInThailand(new Date(x.sold_at)).slice(0, 7) === months[months.length - 1]).map(saleTotal)), aging, collections,
    top_outstanding: [...byAgent].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, 5)
      .map(([id, balance]) => ({ agent_id: id, name: id ? names.get(id) ?? null : null, balance })),
  };
}

// ── Agent statement ──────────────────────────────────────────────────────────────────────────────

export type Statement = {
  agent_id: string; name: string; code: string | null; pay_type: string | null;
  invoiced: number; paid: number; outstanding: number; credit_balance: CreditBalance; credit: Credit;
  invoices: { id: string; number: string; kind: string; issued_at: string; due_at: string; total: number; paid: number; balance: number; status: string }[];
  credits: { id: string; invoice_id: string; invoice_number: string; booking_id: string | null; amount: number; reason: string; created_at: string }[];
  /** Money the agent paid with no invoice, in its credit balance (legacy "Deposits"); voided ones are not listed. */
  deposits: { id: string; amount: number; method: string; received_on: string; ref: string | null; note: string | null }[];
};
/** Legacy `acctStatementOpen`: live invoices; `paid` is net of what refunds and credits took back. */
export function agentStatement(agent: Pick<StoredAgent, 'id' | 'name' | 'code' | 'pay_type'>, invoices: readonly InvoiceView[], refunds: readonly StoredRefund[],
  balance: CreditBalance, credit: Credit, deposits: readonly StoredDeposit[] = []): Statement {
  const live = invoices.filter((i) => i.status !== 'void').sort((a, b) => (a.issued_at === b.issued_at ? (a.id < b.id ? 1 : -1) : a.issued_at < b.issued_at ? 1 : -1));
  const numbers = new Map(invoices.map((i) => [i.id, i.number]));
  const netPaid = (i: InvoiceView) => cents(i.paid - i.refunded - i.credited);
  return {
    agent_id: agent.id, name: agent.name, code: agent.code, pay_type: agent.pay_type,
    invoiced: sum(live.map((i) => i.total)), paid: sum(live.map(netPaid)), outstanding: sum(live.map((i) => i.balance)), credit_balance: balance, credit,
    invoices: live.map((i) => ({ id: i.id, number: i.number, kind: i.kind, issued_at: i.issued_at, due_at: i.due_at, total: i.total, paid: netPaid(i), balance: i.balance, status: i.status })),
    credits: refunds.filter((r) => r.kind === 'credit').map((r) => ({ id: r.id, invoice_id: r.invoice_id, invoice_number: numbers.get(r.invoice_id) ?? r.invoice_id, booking_id: r.booking_id, amount: r.amount, reason: r.reason, created_at: r.created_at })),
    deposits: deposits.filter((d) => !d.voided_at).map((d) => ({ id: d.id, amount: d.amount, method: d.method, received_on: d.received_on, ref: d.ref, note: d.note })),
  };
}

// ── The day's bookings (legacy `tsRows`) ─────────────────────────────────────────────────────────

export type DayRow = { booking: Booking; trip: BookingTrip; booked: number; travelled: number; no_show: number; ns: number; cxl: number; ovn_back: boolean };
/** Every booking still on (not cancelled, rejected or weather-cancelled) with a trip that day: its first trip that day. */
export function dayRows(date: string, bookings: readonly Booking[]): DayRow[] {
  const seen = new Set<string>(), out: DayRow[] = [];
  for (const b of [...bookings].sort((x, y) => (x.id < y.id ? -1 : 1))) {
    if (seen.has(b.id) || RELEASED.has(b.status)) continue;
    const t = b.trips.find((x) => x.service_date === date);
    if (!t) continue;
    seen.add(b.id);
    const noShow = summaryNoShow(t), lost = lostByType(t.operations.checkins);
    out.push({ booking: b, trip: t, booked: t.pax_total, travelled: Math.max(0, t.pax_total - noShow), no_show: noShow, ns: lost.ns, cxl: lost.cxl, ovn_back: t.ovn_leg });
  }
  return out;
}

// ── Travel Summary totals ────────────────────────────────────────────────────────────────────────

/** The money a day's reports read beside its bookings (Money slices 3 and 4): on-tour sales, pier payments, the decisions after the trip. */
export type DayMoneyInput = {
  sales: readonly StoredTourSale[]; payments: readonly StoredPierPayment[];
  cot: readonly StoredCotDecision[]; noshow: readonly StoredNoshowCharge[];
};
export const NO_DAY_MONEY: DayMoneyInput = { sales: [], payments: [], cot: [], noshow: [] };
type ByMethod = { cash: number; transfer: number; card: number };
const byMethod = (by: Readonly<Record<string, number>>): ByMethod => ({ cash: cents(by.cash ?? 0), transfer: cents(by.transfer ?? 0), card: cents(by.card ?? 0) });

/**
 * Legacy `tsSaleList`: what was sold on the day, beside the booking: its on-tour sales of that day (one
 * with no day counts every day, legacy's older ones) and its upgrades (they have no day; legacy counts
 * them on every date the booking travels). A collected item counts by its method with its fee and
 * commission, and is "waiting for slip" when it is not cash and has none; the rest is still to collect.
 */
export function saleList(b: Pick<Booking, 'upgrades'>, date: string, sales: readonly StoredTourSale[]) {
  const by: Record<string, number> = { cash: 0, transfer: 0, card: 0 };
  let got = 0, due = 0, fee = 0, comm = 0, noSlip = 0, n = 0;
  const add = (amt: number, done: boolean, method: string, f: number, c: number, slips: number) => {
    n += 1;
    if (!done) { due += amt; return; }
    by[method] = (by[method] ?? 0) + amt; got += amt; fee += f; comm += c;
    if (method !== 'cash' && !slips) noSlip += 1;
  };
  for (const s of sales) {
    if (s.trip_date && s.trip_date !== date) continue;
    const amt = saleTotal(s);
    if (amt) add(amt, saleCollected(s), s.method, s.fee, tourSaleView(s).commission, s.slips.length);
  }
  for (const u of b.upgrades) if (u.sell_price) add(u.sell_price, !!u.collected, u.method || 'cash', u.fee ?? 0, u.commission, u.slips.length);
  return { by: byMethod(by), got: cents(got), due: cents(due), fee: cents(fee), comm: cents(comm), no_slip: noSlip, total: cents(got + due), n };
}

/**
 * Legacy `tsMoneyOf`: what the pier has to collect from one booking that day (`target`: its cash on tour,
 * Love Kingdom balance and upgrades still owed, less what a paid invoice already cleared, §tsInvPaid),
 * what it took (`paid`, live pier payments) and what is left (`due`). On-tour sales are not in `target`,
 * as legacy: their money is counted apart.
 */
export function collectOf(b: Booking, date: string, sales: readonly StoredTourSale[], payments: readonly StoredPierPayment[]) {
  const M = pierMoney(b as MoneyBooking, date, sales, payments, null);
  const by: Record<string, number> = {};
  for (const p of livePier(payments, date)) by[p.method] = (by[p.method] ?? 0) + p.amount;
  const billed = b.invoice?.status === 'paid' ? cents(M.cot + M.b2c_balance) : 0;
  const target = Math.max(0, cents(M.cot + M.b2c_balance + M.upgrades_due - billed));
  return { M, by: byMethod(by), billed, target, paid: M.paid, due: Math.max(0, cents(target - M.paid)) };
}

/** Legacy `tsNoCollect` (§tsCxlNoCount): nobody travelled and nothing was taken: shown, not counted as owed. Money already taken is a refund's matter (§paid). */
export const noCollect = (r: Pick<DayRow, 'travelled' | 'cxl' | 'ns' | 'no_show'>, paid: number): boolean =>
  !(paid > 0) && r.travelled <= 0 && (r.cxl > 0 || r.ns > 0 || r.no_show > 0);

export type CollectRow = {
  booking_id: string; voucher_ref: string | null; route_id: string;
  cot: number; b2c_balance: number; upgrades_due: number; billed: number; target: number; paid: number; due: number;
  /** Legacy `tsNoCollect`: not counted in `to_collect` and `due`; `cxl` when cancelled at the pier, else `no_show`. */
  not_counted: 'cxl' | 'no_show' | null;
  received: ByMethod; fees: number; no_slip: number;
  sales: { total: number; got: number; due: number; count: number; commission: number; fees: number; no_slip: number };
};
export type TravelSummary = {
  date: string; bookings: number; booked: number; travelled: number; no_show: number; cxl: number;
  money: {
    /** Taken that day by method: pier payments, and on-tour sales and upgrades collected (legacy `sumCash`, `sumTf`, `sumCard`). */
    cash: number; transfer: number; card: number; received: number;
    /** Card fees: the pier's and the sales'. The bank keeps them; they are not income. */
    fees: number;
    pier: ByMethod & { total: number; fees: number; no_slip: number };
    sales: number; sales_due: number; sales_count: number; commission: number; sales_fees: number; sales_by: ByMethod; sales_no_slip: number;
    /** Non-cash money with no slip yet, pier payments and sales (legacy "ขาดสลิป"). */
    no_slip: number;
    cash_on_tour: number; to_collect: number; to_collect_bookings: number; due: number;
    /** `received − cot.payout` (legacy `sumNet`, §tsCommOut: commission is not taken off here). */
    net: number;
  };
  cot: { total: number; deduct: number; payout: number; not_collected: number; not_collected_bookings: number; undecided_bookings: number };
  noshow: { cases: number; pending: number; decided: number; postponed: number; charged: number };
  collect_rows: CollectRow[];
};

/**
 * Legacy `renderTravelSum`'s figures. The collect rows (§tsSaleCol) are the bookings with something to
 * collect, something taken or something sold. A no-show case (§tsIssueReal) is a booking someone did not
 * travel on, or one already decided.
 */
export function travelSummary(date: string, bookings: readonly Booking[], money: DayMoneyInput = NO_DAY_MONEY): TravelSummary {
  const rows = dayRows(date, bookings);
  const of = <T extends { booking_id: string }>(list: readonly T[], id: string) => list.filter((x) => x.booking_id === id);
  const m = {
    cash: 0, transfer: 0, card: 0, received: 0, fees: 0, pier: { cash: 0, transfer: 0, card: 0, total: 0, fees: 0, no_slip: 0 },
    sales: 0, sales_due: 0, sales_count: 0, commission: 0, sales_fees: 0, sales_by: { cash: 0, transfer: 0, card: 0 }, sales_no_slip: 0, no_slip: 0,
    cash_on_tour: 0, to_collect: 0, to_collect_bookings: 0, due: 0, net: 0,
  };
  const cot = { total: 0, deduct: 0, payout: 0, not_collected: 0, not_collected_bookings: 0, undecided_bookings: 0 };
  const collect: CollectRow[] = [];
  for (const r of rows) {
    const b = r.booking, sales = of(money.sales, b.id), payments = of(money.payments, b.id);
    const S = saleList(b, date, sales), C = collectOf(b, date, sales, payments);
    if (!(C.target > 0 || C.paid > 0 || S.total > 0)) continue;
    const skip = noCollect(r, C.paid);
    for (const k of ['cash', 'transfer', 'card'] as const) { m[k] += C.by[k] + S.by[k]; m.pier[k] += C.by[k]; m.sales_by[k] += S.by[k]; }
    m.pier.total += C.paid; m.pier.fees += C.M.fees; m.pier.no_slip += C.M.no_slip;
    m.fees += C.M.fees + S.fee; m.sales_fees += S.fee; m.sales += S.total; m.sales_due += S.due; m.sales_count += S.n; m.commission += S.comm;
    m.sales_no_slip += S.no_slip; m.no_slip += C.M.no_slip + S.no_slip;
    if (!skip) { m.to_collect += C.target; m.due += C.due; m.to_collect_bookings += 1; }
    // §tsCashNet: the cash-on-tour decisions; one not decided yet, or deciding more than there was, is still open.
    if (C.M.cot > 0) {
      m.cash_on_tour += C.M.cot; cot.total += C.M.cot;
      const d = money.cot.find((x) => x.booking_id === b.id && x.service_date === date);
      if (!d) cot.undecided_bookings += 1;
      else if (d.mode === 'nocol') { cot.not_collected += C.M.cot; cot.not_collected_bookings += 1; }
      else if (d.deduct + d.payout > C.M.cot) cot.undecided_bookings += 1;
      else { cot.deduct += d.deduct; cot.payout += d.payout; }
    }
    collect.push({
      booking_id: b.id, voucher_ref: b.voucher_ref ?? null, route_id: r.trip.route_id,
      cot: C.M.cot, b2c_balance: C.M.b2c_balance, upgrades_due: C.M.upgrades_due, billed: C.billed, target: C.target, paid: C.paid, due: C.due,
      not_counted: skip ? (r.cxl > 0 ? 'cxl' : 'no_show') : null,
      received: byMethod({ cash: C.by.cash + S.by.cash, transfer: C.by.transfer + S.by.transfer, card: C.by.card + S.by.card }),
      fees: cents(C.M.fees + S.fee), no_slip: C.M.no_slip + S.no_slip,
      sales: { total: S.total, got: S.got, due: S.due, count: S.n, commission: S.comm, fees: S.fee, no_slip: S.no_slip },
    });
  }
  for (const k of ['cash', 'transfer', 'card', 'fees', 'sales', 'sales_due', 'commission', 'sales_fees', 'cash_on_tour', 'to_collect', 'due'] as const) m[k] = cents(m[k]);
  m.pier = { ...byMethod(m.pier), total: cents(m.pier.total), fees: cents(m.pier.fees), no_slip: m.pier.no_slip };
  m.sales_by = byMethod(m.sales_by);
  m.received = cents(m.cash + m.transfer + m.card);
  for (const k of ['total', 'deduct', 'payout', 'not_collected'] as const) cot[k] = cents(cot[k]);
  m.net = Math.max(0, cents(m.received - cot.payout));
  // §tsIssueReal: a case is a booking someone did not travel on, or one already decided; `charged` adds what the decided ones charge.
  const noshow = { cases: 0, pending: 0, decided: 0, postponed: 0, charged: 0 };
  for (const r of rows) {
    const d = money.noshow.find((x) => x.booking_id === r.booking.id && x.service_date === date);
    if (!(r.no_show > 0 || r.ns + r.cxl > 0 || d)) continue;
    noshow.cases += 1;
    if (!d) { noshow.pending += 1; continue; }
    noshow.decided += 1;
    if (d.decision === 'postpone') noshow.postponed += 1; else noshow.charged = cents(noshow.charged + d.amount);
  }
  return {
    date, bookings: rows.length, booked: rows.reduce((s, r) => s + r.booked, 0), travelled: rows.reduce((s, r) => s + r.travelled, 0),
    no_show: rows.reduce((s, r) => s + r.ns, 0), cxl: rows.reduce((s, r) => s + r.cxl, 0), money: m, cot, noshow, collect_rows: collect,
  };
}

// ── Daily Report: money ──────────────────────────────────────────────────────────────────────────

export type DailySettings = { van_cost: number | null; van_quota: number | null; target_per_pax: number | null; updated_at: string | null; updated_by: string | null };
/** Legacy `drCfg`'s defaults, used while a value is not set. */
export const DAILY_DEFAULTS = { van_cost: 1200, van_quota: 6, target_per_pax: 130 } as const;
export const dailySettingsView = (s: DailySettings | undefined) => ({
  van_cost: s?.van_cost ?? DAILY_DEFAULTS.van_cost, van_quota: s?.van_quota ?? DAILY_DEFAULTS.van_quota, target_per_pax: s?.target_per_pax ?? DAILY_DEFAULTS.target_per_pax,
  set: { van_cost: s?.van_cost ?? null, van_quota: s?.van_quota ?? null, target_per_pax: s?.target_per_pax ?? null },
  updated_at: s?.updated_at ?? null, updated_by: s?.updated_by ?? null,
});
/** Legacy `drCfgSet`: a whole number; 0 or empty goes back to the default. */
export function parseDailySettings(body: Record<string, unknown>, current: DailySettings | undefined): Omit<DailySettings, 'updated_at' | 'updated_by'> {
  const known = ['van_cost', 'van_quota', 'target_per_pax', 'set', 'updated_at', 'updated_by'];
  const unknown = Object.keys(body).filter((k) => !known.includes(k));
  if (unknown.length) refuse(`Daily report settings have no field ${unknown.join(', ')}`, 400);
  const num = (k: 'van_cost' | 'van_quota' | 'target_per_pax'): number | null => {
    const v = body[k];
    if (v === undefined) return current?.[k] ?? null;
    if (v === null || v === '' || v === 0) return null;
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) refuse(`${k} must be a number, 0 or more (0 or null = the default)`, 400);
    return Math.round(n as number) || null;
  };
  return { van_cost: num('van_cost'), van_quota: num('van_quota'), target_per_pax: num('target_per_pax') };
}

/** Legacy `tsTripAmount`: the trip's own price on a multi-trip booking, else the booking's total; an overnight return leg is 0. */
export function tripAmount(b: Pick<Booking, 'trips' | 'total'>, t: Pick<BookingTrip, 'ovn_leg' | 'subtotal'>): number {
  if (t.ovn_leg) return 0;
  if (b.trips.length > 1 && (t.subtotal ?? 0) > 0) return t.subtotal!;
  return b.total ?? 0;
}
/** Legacy `drMarket`: the agent's market; a staff trip; no agent (walk-in); else not set. */
function marketOf(b: Booking, agents: ReadonlyMap<string, StoredAgent>, markets: ReadonlyMap<string, Market>): { id: string; name: string; color: string | null } {
  const ag = b.agent_id ? agents.get(b.agent_id) : undefined;
  const mid = ag?.market_id ?? '';
  const M = mid ? markets.get(mid) : undefined;
  if (M) return { id: M.id, name: M.name || M.id, color: M.color };
  if (mid) return { id: mid, name: mid, color: null };
  if (b.purpose === 'staff_welfare' || b.purpose === 'staff_inspection' || b.staff_id) return { id: 'staff', name: 'Staff / Internal', color: null };
  if (!b.agent_id) return { id: 'walkin', name: 'Walk-in / Direct', color: null };
  return { id: '_none', name: 'ยังไม่ระบุ Market', color: null };
}
/** Legacy `drData`'s pay channels, by the agent's pay type. */
const channelOf = (payType: string | null | undefined): 'invoice' | 'proforma' | 'cot' | 'transfer' | 'other' =>
  payType === 'invoice' || payType === 'credit' ? 'invoice' : payType === 'proforma' || payType === 'prepaid' ? 'proforma' : payType === 'cot' ? 'cot' : payType === 'bt' ? 'transfer' : 'other';

export type DailyMoney = {
  date: string; bookings: number; pax: Counts & { total: number }; paying_pax: number; revenue: number; revenue_per_pax: number;
  by_route: { route_id: string; name: string; bookings: number; pax: number; revenue: number; per_pax: number; share_pct: number }[];
  by_market: { id: string; name: string; color: string | null; bookings: number; pax: number; revenue: number }[];
  by_channel: Record<'invoice' | 'proforma' | 'cot' | 'transfer' | 'other', number>;
  by_agent: { key: string; agent_id: string | null; name: string; market_id: string; pay_type: string | null; bookings: number; ad: number; chd: number; inf: number; foc: number; pax: number; revenue: number; due: number; docs: Record<string, number> }[];
  upgrades: { collected: number; due: number };
  /** Legacy `pckMoney` summed over the day: still to collect at the pier, taken there (pier payments), their payments waiting for a slip, and the day's on-tour sales. */
  due: number; got: number; no_slip: number; extras: number;
  van_cost: { total: number; estimated: boolean; vans: number; default_rate_vans: number; per_van_fallback: number; by_van: Record<string, number> };
};
const pct = (a: number, b: number): number => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);

/**
 * Legacy `drVanReal`: each van's day cost (the van rates, by route and pickup zone) shared over the
 * passengers it took; a van that took two routes' passengers is one day's cost split by heads. With
 * no van cost at all, legacy's fallback: the vans × `van_cost`.
 */
export function dailyVanCost(rows: readonly DayRow[], ctx: { vans: ReadonlyMap<string, Van>; rates: readonly VanRate[]; areas: ReadonlyMap<string, Pick<PickupArea, 'zone'>>; vanCost: number }): DailyMoney['van_cost'] {
  const all = new Map<string, number>();
  const cells = new Map<string, { van: string; route: string; pax: number; zone: string }>();
  const used = new Set<string>();
  for (const r of rows) {
    const parts = r.trip.operations.van_parts;
    // An overnight return leg rides its return van (legacy §ovnDaily).
    for (const p of parts) {
      const van = r.ovn_back ? p.return_van_id ?? p.group?.return_van_id ?? p.group?.van_id ?? null : p.group?.van_id ?? null;
      if (!van) continue;
      used.add(van);
      const pax = parts.length > 1 ? partPax(p) : r.booked;
      all.set(van, (all.get(van) ?? 0) + pax);
      const key = `${van}|${r.trip.route_id}`;
      const c = cells.get(key) ?? cells.set(key, { van, route: r.trip.route_id, pax: 0, zone: '' }).get(key)!;
      c.pax += pax;
      // One van picking up in two zones costs the dearer one: it drove furthest.
      const z = r.booking.pickup_area_id ? ctx.areas.get(r.booking.pickup_area_id)?.zone ?? '' : '';
      if (z === 'KL') c.zone = 'KL'; else if (!c.zone) c.zone = 'PK';
    }
  }
  const byVan: Record<string, number> = {};
  let total = 0;
  const defaulted = new Set<string>();
  for (const c of cells.values()) {
    const v = ctx.vans.get(c.van);
    if (!v) continue;
    const g = vanGroupKey(v);
    const day = vanRate(ctx.rates, g, c.route, c.zone || 'PK');
    const share = (all.get(c.van) ?? 0) > 0 ? c.pax / all.get(c.van)! : 1;
    byVan[c.van] = (byVan[c.van] ?? 0) + day * share;
    total += day * share;
    if (noRateSet(ctx.rates, g, c.route, c.zone || 'PK')) defaulted.add(c.van);
  }
  for (const k of Object.keys(byVan)) byVan[k] = Math.round(byVan[k]);
  total = Math.round(total);
  const estimated = !total;
  return { total: estimated ? used.size * ctx.vanCost : total, estimated, vans: used.size, default_rate_vans: defaulted.size, per_van_fallback: ctx.vanCost, by_van: byVan };
}

export function dailyMoney(date: string, bookings: readonly Booking[], money: Pick<DayMoneyInput, 'sales' | 'payments'>, ctx: {
  agents: readonly StoredAgent[]; markets: readonly Market[]; routes: readonly Pick<Route, 'id' | 'name'>[];
  vans: readonly Van[]; rates: readonly VanRate[]; areas: readonly PickupArea[]; settings: DailySettings | undefined;
}): DailyMoney {
  const rows = dayRows(date, bookings);
  const agents = new Map(ctx.agents.map((a) => [a.id, a])), markets = new Map(ctx.markets.map((m) => [m.id, m]));
  const routeName = new Map(ctx.routes.map((r) => [r.id, r.name]));
  const pax = { ad: 0, chd: 0, inf: 0, foc: 0, total: 0 };
  let rev = 0, ovnPax = 0, upGot = 0, upDue = 0, due = 0, got = 0, noSlip = 0, extras = 0;
  const routes = new Map<string, DailyMoney['by_route'][number]>();
  const mkts = new Map<string, DailyMoney['by_market'][number]>();
  const channel: DailyMoney['by_channel'] = { invoice: 0, proforma: 0, cot: 0, transfer: 0, other: 0 };
  const byAgent = new Map<string, DailyMoney['by_agent'][number]>();
  for (const r of rows) {
    const b = r.booking, t = r.trip, c = countsOf(parsePaxGrid(t.pax)), n = t.pax_total;
    for (const k of PAX_CATEGORIES) pax[k] += c[k];
    pax.total += n;
    if (r.ovn_back) ovnPax += n;
    const amt = tripAmount(b, t);
    rev += amt;
    const ro = routes.get(t.route_id) ?? routes.set(t.route_id, { route_id: t.route_id, name: routeName.get(t.route_id) ?? t.route_id, bookings: 0, pax: 0, revenue: 0, per_pax: 0, share_pct: 0 }).get(t.route_id)!;
    ro.bookings += 1; ro.pax += n; ro.revenue = cents(ro.revenue + amt);
    const m = marketOf(b, agents, markets);
    const mo = mkts.get(m.id) ?? mkts.set(m.id, { ...m, bookings: 0, pax: 0, revenue: 0 }).get(m.id)!;
    mo.bookings += 1; mo.pax += n; mo.revenue = cents(mo.revenue + amt);
    const ag = b.agent_id ? agents.get(b.agent_id) : undefined;
    channel[channelOf(ag?.pay_type)] = cents(channel[channelOf(ag?.pay_type)] + amt);
    const key = b.agent_id || '_walk-in';
    const a = byAgent.get(key) ?? byAgent.set(key, { key, agent_id: b.agent_id ?? null, name: ag ? ag.name || ag.code || key : b.agent_id ?? 'Walk-in',
      market_id: m.id, pay_type: ag?.pay_type ?? null, bookings: 0, ad: 0, chd: 0, inf: 0, foc: 0, pax: 0, revenue: 0, due: 0, docs: {} }).get(key)!;
    a.bookings += 1; for (const k of PAX_CATEGORIES) a[k] += c[k]; a.pax += n; a.revenue = cents(a.revenue + amt);
    a.docs[b.doc_check_status] = (a.docs[b.doc_check_status] ?? 0) + 1;
    // Legacy `pckMoney`: what the pier collects and took; an overnight return leg's was settled on the way out.
    const M = pierMoney(b as MoneyBooking, date, money.sales.filter((s) => s.booking_id === b.id), money.payments.filter((p) => p.booking_id === b.id), null);
    upGot += M.upgrades_got; upDue += M.upgrades_due;
    due += M.due; got += M.paid; noSlip += M.no_slip; extras += M.tour_sales_got + M.tour_sales_due;
    a.due = cents(a.due + M.due);
  }
  rev = cents(rev);
  for (const ro of routes.values()) { ro.per_pax = ro.pax ? cents(ro.revenue / ro.pax) : 0; ro.share_pct = pct(ro.revenue, rev); }
  const paying = Math.max(0, pax.total - ovnPax);
  const settings = dailySettingsView(ctx.settings);
  return {
    date, bookings: rows.length, pax, paying_pax: paying, revenue: rev, revenue_per_pax: paying ? cents(rev / paying) : 0,
    by_route: [...routes.values()].sort((a, b) => b.pax - a.pax),
    by_market: [...mkts.values()].sort((a, b) => b.pax - a.pax),
    by_channel: channel,
    by_agent: [...byAgent.values()].sort((a, b) => b.revenue - a.revenue),
    upgrades: { collected: cents(upGot), due: cents(upDue) },
    due: cents(due), got: cents(got), no_slip: noSlip, extras: cents(extras),
    van_cost: dailyVanCost(rows, { vans: new Map(ctx.vans.map((v) => [v.id, v])), rates: ctx.rates, areas: new Map(ctx.areas.map((a) => [a.id, a])), vanCost: settings.van_cost }),
  };
}
