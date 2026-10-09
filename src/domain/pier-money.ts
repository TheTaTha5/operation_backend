/**
 * Pier money (todo/money-model.md slice 3, decided 2026-10-09; migration 111): legacy's pier check-in
 * money (`pckMoney`, `pckPaySave`, `pckPaysFor`, `pckNoSlip`), its on-tour sales (`SB_EXTRAS`,
 * `bkV2ExtraSave`, `bkV2ExtraCollect`), and the settlement legacy never built: the pier's cash handed
 * over to accounts at day close, and sellers' commissions paid out. Pure, so both stores decide
 * identically: a route reads what a rule needs, asks it, and writes what it answers.
 *
 * Money is kept to the satang here (legacy §pierDecimal: a card machine's 5% of 750 is 37.50).
 */
import { refuse, type HistoryLine } from './booking-actions.js';
import type { AttachmentRef } from './attachments.js';
import { holdsSeats } from './booking-status.js';
import { todayInThailand } from './calendar.js';
import { upgradeView, type Upgrade } from './upgrades.js';

const bad = (message: string): never => refuse(message, 400);
/** Legacy `pckN`: to the satang, without float noise. */
export const money = (n: number): number => Math.round(n * 100 + (n < 0 ? -1e-9 : 1e-9)) / 100;
const sum = (values: readonly number[]): number => money(values.reduce((s, v) => s + v, 0));
/** Legacy `pckNum`: "2,000", or "1,995.50". */
export const thb = (n: number): string => money(n).toLocaleString('en-US', { minimumFractionDigits: money(n) % 1 ? 2 : 0, maximumFractionDigits: 2 });
const fileRef = (files: ReadonlyMap<string, AttachmentRef>, id: string): AttachmentRef => files.get(id) ?? { id, name: id, mime: 'application/octet-stream', size: 0 };
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (s: string): boolean => ISO_DAY.test(s) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
export const dayOf = (value: unknown, name: string): string => (typeof value === 'string' && isDay(value) ? value : bad(`${name} must be a YYYY-MM-DD date`));
const text = (value: unknown, name: string): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return bad(`${name} must be text`);
  return value.trim() || null;
};
const amountOf = (value: unknown, name: string, { positive = false } = {}): number => {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || (positive && n <= 0)) return bad(`${name} must be a number${positive ? ' above 0' : ', 0 or more'}`);
  return money(n);
};
const flag = (value: unknown, name: string): boolean => {
  if (value === undefined || value === null || value === false || value === 'false') return false;
  if (value === true || value === 'true') return true;
  return bad(`${name} must be true or false`);
};
export const slipIdsOf = (value: unknown, name = 'slip_ids'): string[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return bad(`${name} must be a list of attachment ids`);
  return value.map((v, i) => {
    const id = typeof v === 'string' ? v : v !== null && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string' ? (v as { id: string }).id : undefined;
    return id || bad(`${name}[${i}] must be an attachment id`);
  });
};

/** What a rule needs of a booking. */
export type MoneyBooking = {
  id: string; version: number; status: string; agent_id?: string; voucher_ref?: string; lead_pax?: string; total?: number;
  cash_on_tour_amount?: number; cash_on_tour_currency?: string; cash_on_tour_handling?: string; cash_on_tour_note?: string;
  payment_paid?: number; payment_paid_status?: string; payment_deposit?: number; payment_balance?: number; payment_method?: string;
  trips: readonly { id: string; route_id: string; service_date: string; ovn_leg: boolean; subtotal?: number; pax_total: number }[];
  upgrades: readonly Upgrade[];
};
export const tripDates = (b: Pick<MoneyBooking, 'trips'>): string[] => [...new Set(b.trips.map((t) => t.service_date))].sort();
/** A trip date of the booking, else `409 not_on_trip`. */
export function assertOnTrip(b: Pick<MoneyBooking, 'id' | 'trips'>, date: string): void {
  if (!b.trips.some((t) => t.service_date === date)) refuse(`Booking ${b.id} does not travel on ${date} (its days: ${tripDates(b).join(', ') || 'none'})`, 409, 'not_on_trip');
}
export function assertLive(b: Pick<MoneyBooking, 'id' | 'status'>): void {
  if (!holdsSeats(b.status)) refuse(`Booking ${b.id} is ${b.status}`, 409, 'booking_cancelled');
}

// ── Pier payments (legacy bk.pierPayments) ───────────────────────────────────────────────────────

export const PIER_METHODS = ['cash', 'transfer', 'card'] as const;
export type PierMethod = typeof PIER_METHODS[number];
export type StoredPierPayment = {
  id: string; booking_id: string; service_date: string; method: PierMethod; amount: number; fee: number; fee_pct: number | null;
  note: string | null; by: string | null; at: string; deleted_at: string | null; deleted_by: string | null; delete_reason: string | null;
  /** Attachment ids, in order. */
  slips: string[];
};
export type PierPaymentView = Omit<StoredPierPayment, 'slips'> & { slips: AttachmentRef[] };
export const pierPaymentView = (p: StoredPierPayment, files: ReadonlyMap<string, AttachmentRef>): PierPaymentView => ({ ...p, slips: p.slips.map((id) => fileRef(files, id)) });
export const livePier = (payments: readonly StoredPierPayment[], date?: string): StoredPierPayment[] =>
  payments.filter((p) => !p.deleted_at && (!date || p.service_date === date));

/** Legacy `pckMLabel`. */
const methodTh = (m: string): string => (m === 'cash' ? 'เงินสด' : m === 'transfer' ? 'โอนเงิน' : m === 'card' ? 'บัตรเครดิต' : m);
const methodOf = <T extends string>(value: unknown, list: readonly T[], name: string, fallback?: T): T =>
  value === undefined || value === null || value === '' ? (fallback ?? bad(`${name} is required: one of ${list.join(', ')}`))
    : (list as readonly unknown[]).includes(value) ? value as T : bad(`${name} must be one of ${list.join(', ')}`);

export type PierLine = { method: PierMethod; amount: number; fee: number; fee_pct: number | null; note: string | null; slips: string[] };
export type PierPaymentRequest = { service_date: string; lines: PierLine[]; overpay_anyway: boolean };

/**
 * A card's fee (legacy `pckLineFee`): a percentage of the amount, to the satang, or a fee in baht.
 * Any other method pays none, and saying one is refused.
 */
function cardFee(method: string, raw: Record<string, unknown>, label: string, maxPct = 100): { fee: number; fee_pct: number | null } {
  const pct = raw.fee_pct ?? raw.feePct, fee = raw.fee;
  const given = (v: unknown) => v !== undefined && v !== null && v !== '';
  if (method !== 'card') {
    if ((given(pct) && Number(pct) !== 0) || (given(fee) && Number(fee) !== 0)) bad(`${label}: only a card pays a fee`);
    return { fee: 0, fee_pct: null };
  }
  if (given(pct) && given(fee)) bad(`${label}: send fee_pct or fee, not both`);
  if (given(pct)) {
    const p = amountOf(pct, `${label}.fee_pct`);
    if (p > maxPct) bad(`${label}.fee_pct must be ${maxPct} or less`);
    return { fee: -1, fee_pct: p };
  }
  return { fee: given(fee) ? amountOf(fee, `${label}.fee`) : 0, fee_pct: null };
}

/** `POST /v1/bookings/{id}/pier-payments`. A line of 0 is dropped, as legacy drops it; none left is `400`. */
export function parsePierPayment(body: Record<string, unknown>): PierPaymentRequest {
  const service_date = dayOf(body.service_date ?? body.date, 'service_date');
  const raw = body.lines;
  if (!Array.isArray(raw) || raw.length === 0) bad('lines must list at least one { method, amount }');
  const lines: PierLine[] = [];
  (raw as unknown[]).forEach((item, i) => {
    const label = `lines[${i}]`;
    const r = item !== null && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : bad(`${label} must be an object`);
    const method = methodOf(r.method ?? r.m, PIER_METHODS, `${label}.method`, 'cash');
    const amount = amountOf(r.amount ?? r.amt ?? 0, `${label}.amount`);
    const { fee, fee_pct } = cardFee(method, r, label);
    if (amount <= 0) return;
    lines.push({ method, amount, fee: fee < 0 ? money(amount * fee_pct! / 100) : fee, fee_pct, note: text(r.note, `${label}.note`), slips: slipIdsOf(r.slip_ids ?? r.slips, `${label}.slip_ids`) });
  });
  if (!lines.length) bad('Enter an amount first: legacy says "ใส่จำนวนเงินก่อน"');
  return { service_date, lines, overpay_anyway: flag(body.overpay_anyway, 'overpay_anyway') };
}

/**
 * Legacy `pckPaySave`: one payment per line, all at the same instant, and one history line. More than
 * the booking still owes that day needs `overpay_anyway` (legacy's "บันทึกต่อไหม?").
 */
export function recordPierPayments(bookingId: string, req: PierPaymentRequest, due: number, ids: () => string, now: string, by: string | null):
  { payments: StoredPierPayment[]; history: HistoryLine } {
  const total = sum(req.lines.map((l) => l.amount));
  if (total > due + 0.005 && !req.overpay_anyway) {
    refuse(`Received ฿${thb(total)} is more than the ฿${thb(due)} still owed at the pier: send overpay_anyway to save anyway`, 409, 'overpayment');
  }
  const payments = req.lines.map((l): StoredPierPayment => ({
    id: ids(), booking_id: bookingId, service_date: req.service_date, method: l.method, amount: l.amount, fee: l.fee, fee_pct: l.fee_pct,
    note: l.note, by, at: now, deleted_at: null, deleted_by: null, delete_reason: null, slips: l.slips,
  }));
  const fees = sum(req.lines.map((l) => l.fee));
  const parts = req.lines.map((l) => `${methodTh(l.method)} ฿${thb(l.amount)}${l.fee > 0 ? ` +ธรรมเนียม ฿${thb(l.fee)}` : ''}`);
  const text = `เก็บเงินหน้าท่า ฿${thb(total)}${req.lines.length > 1 ? ` · แบ่งจ่าย ${req.lines.length} วิธี (${parts.join(' · ')})`
    : ` (${methodTh(req.lines[0].method)})${fees > 0 ? ` + ค่าธรรมเนียม ฿${thb(fees)}` : ''}`}`;
  return { payments, history: { by, kind: 'payment', tag: 'Pier', text } };
}

/** Legacy `pckPayDel`, kept with `deleted_*` instead of removed. */
export function deletePierPayment(p: StoredPierPayment, reason: string | null, now: string, by: string | null): { payment: StoredPierPayment; history: HistoryLine } {
  if (p.deleted_at) refuse(`Pier payment ${p.id} is already deleted`, 409, 'payment_deleted');
  return {
    payment: { ...p, deleted_at: now, deleted_by: by, delete_reason: reason },
    history: { by, kind: 'payment', tag: 'Pier', text: `ลบรายการเก็บเงินหน้าท่า ฿${thb(p.amount)} (${methodTh(p.method)}, ${p.service_date})${reason ? ` · ${reason}` : ''}` },
  };
}

// ── On-tour sales (legacy SB_EXTRAS) ─────────────────────────────────────────────────────────────

export const SALE_METHODS = ['cash', 'transfer', 'card', 'cot'] as const;
export type SaleMethod = typeof SALE_METHODS[number];
/** Legacy `bkV2ExtraSetPct`: a card fee above 5% is cut to 5; here it is refused. */
export const MAX_SALE_FEE_PCT = 5;
export type StoredTourSale = {
  id: string; booking_id: string; trip_date: string | null; service: string; qty: number; unit_price: number; to_company: number;
  seller: string | null; method: SaleMethod; fee_pct: number; fee: number;
  collected_at: string | null; collected_by: string | null; sold_at: string; sold_by: string | null;
  slips: string[];
};
export type TourSaleView = Omit<StoredTourSale, 'slips'> & {
  total: number; commission: number; customer_paid: number; settle: 'pending' | 'done'; slips: AttachmentRef[];
};
export const saleTotal = (s: Pick<StoredTourSale, 'qty' | 'unit_price'>): number => money(s.qty * s.unit_price);
/** Legacy `bkxExGot`: paid unless it is still to collect on the travel day. */
export const saleCollected = (s: Pick<StoredTourSale, 'method'>): boolean => s.method !== 'cot';
export const tourSaleView = (s: StoredTourSale, files: ReadonlyMap<string, AttachmentRef> = new Map()): TourSaleView => {
  const total = saleTotal(s);
  return { ...s, total, commission: money(Math.max(0, total - s.to_company)), customer_paid: money(total + s.fee), settle: saleCollected(s) ? 'done' : 'pending', slips: s.slips.map((id) => fileRef(files, id)) };
};

/** The fields a client may send; the rest are the server's and are refused unless they repeat what it worked out. */
const SALE_OWNED: Record<string, string> = {
  total: 'it is qty × unit_price', commission: 'it is total − to_company', customer_paid: 'it is total + fee', fee: 'it follows from fee_pct',
  settle: 'use POST /v1/bookings/{id}/tour-sales/{sale_id}/collect', collected_at: 'use POST /v1/bookings/{id}/tour-sales/{sale_id}/collect',
  collected_by: 'use POST /v1/bookings/{id}/tour-sales/{sale_id}/collect', sold_at: 'it is when the sale was first saved', sold_by: 'it is who first saved it',
  booking_id: 'a sale stays on its booking', id: 'it is the sale\'s',
};
function assertSaleEcho(body: Record<string, unknown>, current: TourSaleView | undefined, proposed: TourSaleView): void {
  for (const [key, why] of Object.entries(SALE_OWNED)) {
    const sent = body[key];
    if (sent === undefined) continue;
    const stored = (proposed as unknown as Record<string, unknown>)[key] ?? (current as unknown as Record<string, unknown> | undefined)?.[key];
    const same = typeof stored === 'number' ? typeof sent === 'number' && Math.abs(sent - stored) < 0.005 : sent === stored || (sent === null && stored == null);
    if (!same) bad(`${key} cannot be set: ${why}`);
  }
}

export type TourSaleInput = Pick<StoredTourSale, 'trip_date' | 'service' | 'qty' | 'unit_price' | 'to_company' | 'seller' | 'method' | 'fee_pct' | 'slips'>;

/**
 * A new sale (`POST`) or the changes to one (`PATCH`, merged over it). Legacy `bkV2ExtraSave`: a price
 * is required ("ใส่ราคา"), `to_company` is at most the total, a card fee at most 5%, a `cot` sale has
 * no slip yet. `trip_date` defaults to the booking's first travel day (legacy `bkV2ExtraDayOf`).
 */
export function parseTourSale(body: Record<string, unknown>, booking: Pick<MoneyBooking, 'id' | 'trips'>, current?: StoredTourSale): TourSaleInput {
  const has = (...keys: string[]) => keys.some((k) => body[k] !== undefined);
  const get = (...keys: string[]) => keys.map((k) => body[k]).find((v) => v !== undefined);
  const service = has('service', 'name') ? text(get('service', 'name'), 'service') ?? bad('service must name what was sold') : current?.service ?? 'Extra';
  const qtyRaw = has('qty') ? get('qty') : current?.qty ?? 1;
  const qty = typeof qtyRaw === 'number' && Number.isInteger(qtyRaw) && qtyRaw >= 1 ? qtyRaw : bad('qty must be a whole number, 1 or more');
  const price = has('unit_price', 'unitPrice', 'price') ? amountOf(get('unit_price', 'unitPrice', 'price') ?? 0, 'unit_price') : current?.unit_price ?? 0;
  if (!(price > 0)) bad('unit_price is required: legacy says "ใส่ราคา"');
  const total = money(qty * price);
  const toCompany = has('to_company', 'toCompany') ? amountOf(get('to_company', 'toCompany') ?? 0, 'to_company') : current?.to_company ?? 0;
  if (toCompany > total + 0.005) bad(`to_company (฿${thb(toCompany)}) cannot be more than the sale's total (฿${thb(total)})`);
  const method = has('method') ? methodOf(get('method'), SALE_METHODS, 'method', 'cash') : current?.method ?? 'cash';
  const feeBody = has('fee_pct', 'feePct') ? body : { fee_pct: method === 'card' ? current?.fee_pct ?? 0 : 0 };
  const { fee_pct } = cardFee(method, { fee_pct: feeBody.fee_pct ?? feeBody.feePct }, 'sale', MAX_SALE_FEE_PCT);
  const tripDate = has('trip_date', 'tripDate') ? dayOf(get('trip_date', 'tripDate'), 'trip_date') : current?.trip_date ?? tripDates(booking)[0] ?? null;
  if (tripDate && (has('trip_date', 'tripDate') || !current)) assertOnTrip(booking, tripDate);
  const slips = method === 'cot' ? [] : has('slip_ids', 'slips') ? slipIdsOf(get('slip_ids', 'slips')) : current?.slips ?? [];
  return { trip_date: tripDate, service: service!, qty, unit_price: price, to_company: toCompany, seller: has('seller') ? text(get('seller'), 'seller') : current?.seller ?? null,
    method, fee_pct: fee_pct ?? 0, slips };
}

const saleLabel = (s: Pick<StoredTourSale, 'service' | 'qty'>): string => `${s.service}${s.qty > 1 ? ` ×${s.qty}` : ''}`;
/**
 * The sale to store and legacy's history line. A sale not `cot` is collected when saved; switching to
 * `cot` makes it owed again (legacy clears `collectedAt` and the slips).
 */
export function planTourSale(input: TourSaleInput, body: Record<string, unknown>, current: StoredTourSale | undefined, id: string, bookingId: string, now: string, by: string | null):
  { sale: StoredTourSale; history: HistoryLine } {
  const fee = input.method === 'card' ? money(saleTotal(input) * input.fee_pct / 100) : 0;
  const collected = input.method !== 'cot';
  const sale: StoredTourSale = {
    id: current?.id ?? id, booking_id: bookingId, ...input, fee_pct: input.method === 'card' ? input.fee_pct : 0, fee,
    collected_at: collected ? current?.collected_at ?? now : null, collected_by: collected ? (current?.collected_at ? current.collected_by : by) : null,
    sold_at: current?.sold_at ?? now, sold_by: current ? current.sold_by : by,
  };
  assertSaleEcho(body, current && tourSaleView(current), tourSaleView(sale));
  const v = tourSaleView(sale);
  const comm = v.commission ? ` · คอม ฿${thb(v.commission)}` : '';
  const text = current ? `Edited extra · ${saleLabel(sale)} · ฿${thb(v.total)}${comm}`
    : `Day-of extra · ${saleLabel(sale)} · ฿${thb(v.total)}${comm} (${sale.method}${fee ? ` · fee ฿${thb(fee)}` : ''})`;
  return { sale, history: { by, kind: 'extra', tag: 'Extra', text } };
}

/**
 * Legacy `bkV2ExtraCollect`: a sale left to collect on the travel day is collected, as cash by default
 * (legacy's button), or by transfer or card with its fee.
 */
export function collectTourSale(sale: StoredTourSale, body: Record<string, unknown>, now: string, by: string | null): { sale: StoredTourSale; history: HistoryLine } {
  if (saleCollected(sale)) refuse(`Sale ${sale.id} is already collected (${sale.method})`, 409, 'already_collected');
  const method = methodOf(body.method, PIER_METHODS, 'method', 'cash');
  const { fee_pct } = cardFee(method, body, 'collect', MAX_SALE_FEE_PCT);
  const pct = method === 'card' ? fee_pct ?? 0 : 0;
  const next: StoredTourSale = { ...sale, method, fee_pct: pct, fee: method === 'card' ? money(saleTotal(sale) * pct / 100) : 0, collected_at: now, collected_by: by,
    slips: slipIdsOf(body.slip_ids ?? body.slips) };
  return { sale: next, history: { by, kind: 'extra', tag: 'Extra', text: `Collected on tour · ${sale.service} · ฿${thb(saleTotal(sale))} (${method})` } };
}

// ── The amount owed at the pier (legacy pckMoney) ────────────────────────────────────────────────

export type PierMoney = {
  booking_id: string; version: number; voucher_ref: string | null; lead_pax: string | null; agent_id: string | null; route_id: string; service_date: string;
  overnight_return: boolean;
  cot: number; cot_currency: string; cot_handling: string | null; cot_note: string | null;
  upgrades_due: number; upgrades_got: number; b2c_balance: number; tour_sales_due: number; tour_sales_got: number;
  gross: number; paid: number; fees: number; due: number; got: number; no_slip: number;
  /** The booking's payment terms: Love Kingdom's own for its bookings (legacy §b2cPayOne), else the agent's pay type. */
  term: string | null; paid_status: string | null;
};

/**
 * What the pier still has to collect from one booking on one day, and what it already took (legacy
 * `pckMoney`). On an overnight return leg the booking's money was settled on the way out, so its cash
 * on tour, upgrades and B2C balance count 0 (legacy §ovnSettled). Sales of another day are not this
 * day's (legacy §extraDay); one with no day counts every day, as legacy's older ones do.
 */
export function pierMoney(b: MoneyBooking, date: string, sales: readonly StoredTourSale[], payments: readonly StoredPierPayment[], agentPayType: string | null): PierMoney {
  const trip = b.trips.find((t) => t.service_date === date);
  const ovnBack = !!trip?.ovn_leg;
  const cot = !ovnBack && (b.cash_on_tour_amount ?? 0) > 0 ? money(b.cash_on_tour_amount!) : 0;
  const day = sales.filter((s) => !(s.trip_date && s.trip_date !== date));
  const tourGot = sum(day.filter(saleCollected).map(saleTotal)), tourDue = sum(day.filter((s) => !saleCollected(s)).map(saleTotal));
  const ups = ovnBack ? [] : b.upgrades;
  const upDue = sum(ups.filter((u) => !u.collected).map((u) => u.sell_price)), upGot = sum(ups.filter((u) => u.collected).map((u) => u.sell_price));
  const balance = !ovnBack && (b.payment_balance ?? 0) > 0 ? money(b.payment_balance!) : 0;
  const live = livePier(payments, date);
  const paid = sum(live.map((p) => p.amount)), fees = sum(live.map((p) => p.fee));
  const gross = money(cot + upDue + balance + tourDue);
  const b2c = b.agent_id === 'a_b2c';
  return {
    booking_id: b.id, version: b.version, voucher_ref: b.voucher_ref ?? null, lead_pax: b.lead_pax ?? null, agent_id: b.agent_id ?? null,
    route_id: trip?.route_id ?? '', service_date: date, overnight_return: ovnBack,
    cot, cot_currency: b.cash_on_tour_currency ?? 'THB', cot_handling: b.cash_on_tour_handling ?? null, cot_note: b.cash_on_tour_note ?? null,
    upgrades_due: upDue, upgrades_got: upGot, b2c_balance: balance, tour_sales_due: tourDue, tour_sales_got: tourGot,
    gross, paid, fees, due: Math.max(0, money(gross - paid)), got: money(tourGot + upGot + paid),
    no_slip: live.filter((p) => p.method !== 'cash' && !p.slips.length).length,
    term: (b2c && b.payment_method) || agentPayType || null, paid_status: b2c && b.payment_paid_status ? b.payment_paid_status : null,
  };
}

// ── The pier's cash handed over at day close ─────────────────────────────────────────────────────

/** What a day's pier took, by method: pier payments, on-tour sales and upgrades collected. */
export type Takings = {
  cash: number; transfer: number; card: number; card_fees: number; pier_payments: number; tour_sales: number; upgrades: number; no_slip: number;
};
export const NO_TAKINGS: Takings = { cash: 0, transfer: 0, card: 0, card_fees: 0, pier_payments: 0, tour_sales: 0, upgrades: 0, no_slip: 0 };
/**
 * The day an upgrade belongs to. Legacy keeps none (`bk.upgrades` has no trip date): it is the day it
 * was sold when the booking travels that day, else the booking's first travel day.
 */
export function upgradeDay(b: Pick<MoneyBooking, 'trips'>, u: Pick<Upgrade, 'at'>): string | null {
  const sold = u.at ? todayInThailand(new Date(u.at)) : null;
  if (sold && b.trips.some((t) => t.service_date === sold)) return sold;
  return tripDates(b)[0] ?? sold;
}
/** `routes.pier`, or `other` (legacy `tsPierOf`). */
export const pierOf = (route: { pier?: string } | undefined): string => route?.pier || 'other';

/**
 * The day's takings at one pier. A booking counts at the pier of its trip that day. On-tour sales count
 * on their day (a `cot` one only once collected); upgrades have no day, so one counts on the day it was
 * sold (Bangkok), at the pier of the booking's trip that day.
 */
export function takings(date: string, pier: string, bookings: readonly { booking: MoneyBooking; sales: readonly StoredTourSale[]; payments: readonly StoredPierPayment[] }[],
  pierOfRoute: (routeId: string) => string): Takings {
  const t = { ...NO_TAKINGS };
  const add = (method: string, amount: number, fee = 0) => {
    if (method === 'cash') t.cash = money(t.cash + amount);
    else if (method === 'transfer') t.transfer = money(t.transfer + amount);
    else if (method === 'card') { t.card = money(t.card + amount); t.card_fees = money(t.card_fees + fee); }
  };
  for (const { booking, sales, payments } of bookings) {
    const trip = booking.trips.find((x) => x.service_date === date);
    if (!trip || pierOfRoute(trip.route_id) !== pier) continue;
    for (const p of livePier(payments, date)) { add(p.method, p.amount, p.fee); t.pier_payments = money(t.pier_payments + p.amount); if (p.method !== 'cash' && !p.slips.length) t.no_slip += 1; }
    for (const s of sales.filter((x) => x.trip_date === date && saleCollected(x))) { add(s.method, saleTotal(s), s.fee); t.tour_sales = money(t.tour_sales + saleTotal(s)); }
    for (const u of booking.upgrades.filter((x) => x.collected && upgradeDay(booking, x) === date)) {
      add(u.method ?? 'cash', u.sell_price, u.fee ?? 0); t.upgrades = money(t.upgrades + u.sell_price);
    }
  }
  return t;
}

export type StoredHandover = {
  id: string; service_date: string; pier: string; expected: Takings; cash_counted: number; note: string | null; handed_by: string | null; handed_at: string;
  accepted_by: string | null; accepted_at: string | null; accept_note: string | null; voided_by: string | null; voided_at: string | null; void_reason: string | null;
};
export type HandoverView = StoredHandover & {
  status: 'handed' | 'accepted' | 'void'; cash_difference: number; expected_now: Takings; changed: boolean;
};
export const handoverView = (h: StoredHandover, now: Takings): HandoverView => ({
  ...h, status: h.voided_at ? 'void' : h.accepted_at ? 'accepted' : 'handed', cash_difference: money(h.cash_counted - h.expected.cash),
  expected_now: now, changed: JSON.stringify(now) !== JSON.stringify({ ...NO_TAKINGS, ...h.expected }),
});

export function parseHandover(body: Record<string, unknown>): { service_date: string; pier: string; cash_counted: number; note: string | null } {
  const pier = text(body.pier, 'pier') ?? bad('pier is required (the route\'s pier, or other)');
  return { service_date: dayOf(body.service_date ?? body.date, 'service_date'), pier: pier!, cash_counted: amountOf(body.cash_counted ?? 0, 'cash_counted'), note: text(body.note, 'note') };
}
/** One live hand-over per day and pier: void the earlier one to hand over again. */
export function planHandover(input: ReturnType<typeof parseHandover>, live: StoredHandover | undefined, expected: Takings, id: string, now: string, by: string | null): StoredHandover {
  if (live) refuse(`${input.pier} was already handed over for ${input.service_date} (${live.id}): void it to hand over again`, 409, 'already_handed_over');
  return { id, ...input, expected, handed_by: by, handed_at: now, accepted_by: null, accepted_at: null, accept_note: null, voided_by: null, voided_at: null, void_reason: null };
}
export function acceptHandover(h: StoredHandover, note: string | null, now: string, by: string | null): StoredHandover {
  if (h.voided_at) refuse(`Hand-over ${h.id} is void`, 409, 'handover_void');
  if (h.accepted_at) refuse(`Hand-over ${h.id} was already accepted by ${h.accepted_by ?? 'someone'}`, 409, 'already_accepted');
  return { ...h, accepted_by: by, accepted_at: now, accept_note: note };
}
export function voidHandover(h: StoredHandover, reason: string | null, now: string, by: string | null): StoredHandover {
  if (h.voided_at) refuse(`Hand-over ${h.id} is already void`, 409, 'handover_void');
  if (h.accepted_at) refuse(`Hand-over ${h.id} was accepted by accounts: it cannot be voided`, 409, 'already_accepted');
  return { ...h, voided_by: by, voided_at: now, void_reason: reason };
}
export const noteOf = (body: Record<string, unknown>, name: string): string | null => text(body[name], name);

// ── Commission payouts ───────────────────────────────────────────────────────────────────────────

export type CommissionKind = 'tour_sale' | 'upgrade';
export type CommissionItem = {
  kind: CommissionKind; id: string; booking_id: string; voucher_ref: string | null; label: string; date: string | null; seller: string | null;
  total: number; to_company: number; commission: number; collected: boolean; payout_id: string | null;
};
export type PayoutItem = { kind: CommissionKind; booking_id: string; item_id: string; amount: number };
export type StoredPayout = {
  id: string; seller: string; amount: number; method: 'cash' | 'transfer'; paid_on: string; ref: string | null; note: string | null;
  created_by: string | null; created_at: string; voided_by: string | null; voided_at: string | null; void_reason: string | null; items: PayoutItem[];
};
const itemKey = (kind: string, bookingId: string, id: string) => `${kind}|${bookingId}|${id}`;

/** Every commission of these bookings: their on-tour sales and upgrades, each with the live payout that paid it. */
export function commissionItems(bookings: readonly { booking: Pick<MoneyBooking, 'id' | 'voucher_ref' | 'upgrades' | 'trips'>; sales: readonly StoredTourSale[] }[], payouts: readonly StoredPayout[]): CommissionItem[] {
  const paid = new Map<string, string>();
  for (const p of payouts) if (!p.voided_at) for (const i of p.items) paid.set(itemKey(i.kind, i.booking_id, i.item_id), p.id);
  const out: CommissionItem[] = [];
  for (const { booking, sales } of bookings) {
    for (const s of sales) {
      const v = tourSaleView(s);
      out.push({ kind: 'tour_sale', id: s.id, booking_id: booking.id, voucher_ref: booking.voucher_ref ?? null, label: saleLabel(s), date: s.trip_date ?? s.sold_at.slice(0, 10), seller: s.seller,
        total: v.total, to_company: s.to_company, commission: v.commission, collected: saleCollected(s), payout_id: paid.get(itemKey('tour_sale', booking.id, s.id)) ?? null });
    }
    for (const u of booking.upgrades) {
      const v = upgradeView({ ...u, slips: [] });
      out.push({ kind: 'upgrade', id: u.id, booking_id: booking.id, voucher_ref: booking.voucher_ref ?? null, label: u.label, date: upgradeDay(booking, u), seller: u.seller,
        total: u.sell_price, to_company: u.to_company ?? 0, commission: v.commission, collected: !!u.collected, payout_id: paid.get(itemKey('upgrade', booking.id, u.id)) ?? null });
    }
  }
  return out.filter((i) => i.commission > 0);
}

export function parsePayout(body: Record<string, unknown>, today: string): { seller: string; items: { kind: CommissionKind; booking_id: string; id: string }[]; method: 'cash' | 'transfer'; paid_on: string; ref: string | null; note: string | null } {
  const seller = text(body.seller, 'seller') ?? bad('seller is required');
  const raw = body.items;
  if (!Array.isArray(raw) || raw.length === 0) bad('items must list at least one { kind, booking_id, id }');
  const items = (raw as unknown[]).map((x, i) => {
    const r = x !== null && typeof x === 'object' ? x as Record<string, unknown> : bad(`items[${i}] must be an object`);
    const kind = r.kind === 'tour_sale' || r.kind === 'upgrade' ? r.kind : bad(`items[${i}].kind must be tour_sale or upgrade`);
    return { kind: kind as CommissionKind, booking_id: text(r.booking_id, `items[${i}].booking_id`) ?? bad(`items[${i}].booking_id is required`), id: text(r.id, `items[${i}].id`) ?? bad(`items[${i}].id is required`) };
  });
  if (new Set(items.map((i) => itemKey(i.kind, i.booking_id, i.id))).size !== items.length) bad('items names an item twice');
  const method = methodOf(body.method, ['cash', 'transfer'] as const, 'method', 'cash');
  return { seller: seller!, items, method, paid_on: body.paid_on === undefined || body.paid_on === null ? today : dayOf(body.paid_on, 'paid_on'), ref: text(body.ref, 'ref'), note: text(body.note, 'note') };
}

/** The payout: the commission of each item named, each the seller's, collected, and not paid already. */
export function planPayout(input: ReturnType<typeof parsePayout>, known: readonly CommissionItem[], id: string, now: string, by: string | null): StoredPayout {
  const byKey = new Map(known.map((k) => [itemKey(k.kind, k.booking_id, k.id), k]));
  const items = input.items.map((i): PayoutItem => {
    const k = byKey.get(itemKey(i.kind, i.booking_id, i.id)) ?? bad(`${i.kind} ${i.id} on booking ${i.booking_id} has no commission to pay`);
    if ((k.seller ?? '') !== input.seller) bad(`${i.kind} ${i.id} was sold by ${k.seller ?? 'nobody'}, not ${input.seller}`);
    if (!k.collected) refuse(`${i.kind} ${i.id} is not collected yet: its commission is paid once the customer has paid`, 409, 'not_collected');
    if (k.payout_id) refuse(`${i.kind} ${i.id}'s commission was already paid (payout ${k.payout_id})`, 409, 'already_paid');
    return { kind: i.kind, booking_id: i.booking_id, item_id: i.id, amount: k.commission };
  });
  return { id, seller: input.seller, amount: sum(items.map((i) => i.amount)), method: input.method, paid_on: input.paid_on, ref: input.ref, note: input.note,
    created_by: by, created_at: now, voided_by: null, voided_at: null, void_reason: null, items };
}
export function voidPayout(p: StoredPayout, reason: string | null, now: string, by: string | null): StoredPayout {
  if (p.voided_at) refuse(`Payout ${p.id} is already void`, 409, 'payout_void');
  return { ...p, voided_by: by, voided_at: now, void_reason: reason };
}

/** `?from=&to=` (both optional), each a real day. */
export function parseRange(query: Record<string, unknown>, required = false): { from?: string; to?: string } {
  const get = (k: string) => (typeof query[k] === 'string' && query[k] !== '' ? query[k] as string : undefined);
  const date = get('date');
  const from = get('from') ?? date, to = get('to') ?? date;
  if (required && (!from || !to)) bad('date, or from and to, are required');
  if (from) dayOf(from, 'from');
  if (to) dayOf(to, 'to');
  if (from && to && to < from) bad('to must not be before from');
  return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
}
