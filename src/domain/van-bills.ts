/**
 * Partner van bills (todo/money-model.md slice 5, decided 2026-10-09; migration 120): legacy
 * `§vanBill` (`vbRows`, `§vbRetMerge`, `§vbPaxReal`, `vbRateOf`, `vbAgg`, `§vbMix`, `§vbSeen`,
 * `§vbNewRow`, `vbPullRates`) and Transfer Fleet's van rates (`vanRate`, `vanGroupKey`).
 *
 * A bill is per partner, month and ten-day period. Its rows are worked out on every read from the
 * bookings' van parts and check-ins; only what staff type is stored. Sent and paid are new: legacy
 * had no state. Pure, so both stores decide identically.
 */
import { randomUUID } from 'node:crypto';
import { refuse } from './booking-actions.js';
import { isIsoDate, todayInThailand } from './calendar.js';
import type { Booking, BookingTrip } from './operations.js';
import type { PickupArea } from './pickup-areas.js';
import { PAX_CATEGORIES } from './pax.js';
import { assertKnownKeys, withoutServerOwned } from './server-owned.js';
import { aboardCounts, bookedCounts } from './aboard.js';
import { partPax, type VanPartView } from './van-groups.js';
import type { Van } from './vans.js';

const bad = (message: string): never => refuse(message, 400);
const cents = (n: number): number => Math.round(n * 100) / 100;
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const RELEASED = new Set(['cancelled', 'rejected', 'cancelled_weather']);

// ── Codes, partners, periods ─────────────────────────────────────────────────────────────────────

/** Legacy `VB_CODE`: the short code a bill prints, by route id. A route not listed is `—`. */
const VB_CODE: Readonly<Record<string, string>> = {
  r7: 'PP', r8: 'PP', r9: 'PP', r10: 'PP', r11: 'PB', r12: 'MT', r1: 'SM', r2: 'SM', r3: 'SM', r4: 'SM', r5: 'SM', r6: 'SR',
};
export const VB_CODES = ['PP', 'PB', 'MT', 'SM', 'SR', '—'] as const;
export const codeOf = (routeId: string): string => VB_CODE[routeId] ?? '—';
/** Legacy `vbSupOf`: a partner van with no owner's name bills under this one. */
export const NO_PARTNER = '(ไม่ระบุผู้ให้บริการ)';
export const partnerOf = (van: Pick<Van, 'partner_name'>): string => van.partner_name?.trim() || NO_PARTNER;
/** Legacy `vbVans`: only partner vans bill (rented ones are paid by the day elsewhere). */
export const partnerVans = (vans: readonly Van[], partner: string): Van[] =>
  vans.filter((v) => v.ownership === 'partner' && partnerOf(v) === partner).sort((a, b) => cmp(a.id, b.id));
/** Every partner, by name in Thai order (legacy `vbSuppliers`). */
export const partnersOf = (vans: readonly Van[]): string[] =>
  [...new Set(vans.filter((v) => v.ownership === 'partner').map(partnerOf))].sort((a, b) => a.localeCompare(b, 'th'));

export type Period = 1 | 2 | 3;
export type BillAddress = { partner: string; month: string; period: Period };
/** Legacy `vbPeriod`: 1–10, 11–20, 21–end of month. */
export function billPeriod(month: string, period: Period): { from: string; to: string; label: string } {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const a = period === 1 ? 1 : period === 2 ? 11 : 21, b = period === 1 ? 10 : period === 2 ? 20 : last;
  const day = (d: number) => `${month}-${String(d).padStart(2, '0')}`;
  return { from: day(a), to: day(b), label: `${a}–${b}` };
}
export function parseMonthPeriod(month: unknown, period: unknown): { month: string; period: Period } {
  if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) bad('month must be YYYY-MM');
  const p = Number(period);
  if (period === undefined || period === null || period === '' || ![1, 2, 3].includes(p)) bad('period must be 1 (days 1–10), 2 (11–20) or 3 (21 to the end of the month)');
  return { month: month as string, period: p as Period };
}
export function parseBillAddress(params: Record<string, unknown>): BillAddress {
  const partner = typeof params.partner === 'string' ? params.partner.trim() : '';
  if (!partner) bad('partner is required');
  return { partner, ...parseMonthPeriod(params.month, params.period) };
}

// ── What is stored ───────────────────────────────────────────────────────────────────────────────

export type RowOverride = { rate: number | null; ex: number | null; cut: number | null; per: number | null };
export type ExtraLine = { id: string; date: string | null; note: string | null; vans: number; pax: number; rate: number; ex: number; cut: number; per_pax: number };
export const PAID_VIA = ['transfer', 'cash', 'cheque'] as const;
export type PaidVia = typeof PAID_VIA[number];
export type StoredVanBill = BillAddress & {
  id: string; per_pax: number; rate: number;
  route_rates: Record<string, number>; row_overrides: Record<string, RowOverride>; extra_lines: ExtraLine[];
  seen: string[] | null; updated_at: string | null; updated_by: string | null;
  sent_at: string | null; sent_by: string | null; sent_bill: number | null;
  paid_at: string | null; paid_by: string | null; paid_on: string | null; paid_via: PaidVia | null; paid_ref: string | null; paid_amount: number | null;
};
export const copyBill = (b: StoredVanBill): StoredVanBill => ({
  ...b, route_rates: { ...b.route_rates }, row_overrides: Object.fromEntries(Object.entries(b.row_overrides).map(([k, v]) => [k, { ...v }])),
  extra_lines: b.extra_lines.map((x) => ({ ...x })), seen: b.seen && [...b.seen],
});
/** Legacy `vbStateOf`: reading a bill that was never saved never creates one. */
export const blankBill = (a: BillAddress): StoredVanBill => ({
  id: `vb_${randomUUID()}`, ...a, per_pax: 0, rate: 0, route_rates: {}, row_overrides: {}, extra_lines: [], seen: null, updated_at: null, updated_by: null,
  sent_at: null, sent_by: null, sent_bill: null, paid_at: null, paid_by: null, paid_on: null, paid_via: null, paid_ref: null, paid_amount: null,
});

// ── Rows ─────────────────────────────────────────────────────────────────────────────────────────

export type BillRow = {
  key: string; date: string; route_id: string; code: string; van_id: string; return_only: boolean;
  ad: number; chd: number; inf: number; foc: number; pax: number; booked_pax: number; bookings: number;
  return_pax: number; return_bookings: number; return_same_van: number;
  pickups: string[]; drops: { name: string; changed: boolean }[];
};
type Building = Omit<BillRow, 'key' | 'code' | 'pickups' | 'drops'> & { pickups: Set<string>; drops: Map<string, boolean> };
export type RowContext = { areas: ReadonlyMap<string, Pick<PickupArea, 'name'>> };

/** Legacy `vbRowKey`: a return-only run keeps its rate apart from the outbound one. */
export const rowKey = (r: Pick<BillRow, 'date' | 'route_id' | 'van_id' | 'return_only'>): string => `${r.date}~${r.route_id}~${r.van_id}${r.return_only ? '~R' : ''}`;
const ROW_KEY = /^\d{4}-\d{2}-\d{2}~[^~]+~[^~]+(~R)?$/;

const areaName = (ctx: RowContext, id: string | null | undefined): string => (id ? ctx.areas.get(id)?.name?.trim() ?? '' : '');
/** Legacy `vbPickName`: an alternate pickup's own area, else the booking's pickup area. */
const pickName = (ctx: RowContext, b: Booking, part: VanPartView | undefined): string =>
  (part?.alt ? areaName(ctx, part.alt.pick_area_id) : '') || (b.pickup_area ?? '').trim();
/** Legacy `vbDropInfo` / `bkDropOf`: where the van takes them back, and whether the booking chose it. */
function dropOf(ctx: RowContext, b: Booking, part: VanPartView | undefined): { name: string; changed: boolean } {
  let name = '';
  if (part?.alt && ((part.alt.drop_hotel ?? '').trim() || part.alt.drop_area_id)) name = areaName(ctx, part.alt.drop_area_id) || (part.alt.drop_hotel ?? '').trim();
  else if (b.dropoff_same === false) {
    name = areaName(ctx, b.dropoff_area_id) || (b.dropoff_area ?? '').trim() || (b.dropoff_hotel_name ?? '').trim();
  }
  const pick = pickName(ctx, b, part);
  return { name: name || pick, changed: !!name && name !== pick };
}

/**
 * Legacy `vbRows`: one row per day, route and van of the partner; out and back on the same van is one
 * run (§vbRetMerge). Passengers are those aboard (§vbPaxReal); a row stays at 0, the van still ran.
 */
export function billRows(input: { from: string; to: string; vans: readonly Van[]; bookings: readonly Booking[]; vanId?: string }, ctx: RowContext): BillRow[] {
  const ok = new Set(input.vans.filter((v) => !input.vanId || v.id === input.vanId).map((v) => v.id));
  const map = new Map<string, Building>();
  const pendRet: { date: string; route: string; van: string; pax: number; drop: { name: string; changed: boolean } }[] = [];
  const blank = (date: string, route: string, van: string, ret: boolean): Building => ({
    date, route_id: route, van_id: van, return_only: ret, ad: 0, chd: 0, inf: 0, foc: 0, pax: 0, booked_pax: 0, bookings: 0,
    return_pax: 0, return_bookings: 0, return_same_van: 0, pickups: new Set(), drops: new Map(),
  });
  const addDrop = (r: Building, d: { name: string; changed: boolean }) => { if (d.name) r.drops.set(d.name, (r.drops.get(d.name) ?? false) || d.changed); };
  const bookings = [...input.bookings].sort((a, b) => cmp(a.id, b.id));
  for (const b of bookings) {
    if (RELEASED.has(b.status)) continue;
    for (const t of b.trips) {
      const date = t.service_date;
      if (date < input.from || date > input.to) continue;
      const booked = bookedCounts(t), real = aboardCounts(t);
      const bkN = PAX_CATEGORIES.reduce((s, k) => s + booked[k], 0), rlN = PAX_CATEGORIES.reduce((s, k) => s + real[k], 0);
      const parts = t.operations.van_parts;
      const split = parts.length > 1;
      // Several vans on one booking: the people who did not come belong to the booking, so they come
      // off each van in proportion, the remainder on the last (legacy keeps the total exact).
      const legs = split ? parts.map((p) => ({ van: p.group?.van_id ?? null, pax: partPax(p) as number | null, part: p as VanPartView | undefined, real: 0 }))
        : [{ van: parts[0]?.group?.van_id ?? null, pax: null as number | null, part: parts[0] as VanPartView | undefined, real: 0 }];
      if (split) {
        const tb = legs.reduce((s, l) => s + (l.pax ?? 0), 0);
        let used = 0;
        legs.forEach((l, i) => { l.real = i === legs.length - 1 ? Math.max(0, rlN - used) : tb > 0 ? Math.round(((l.pax ?? 0) * rlN) / tb) : 0; used += l.real; });
      }
      const sameVan = t.operations.return_same_van;
      for (const l of legs) {
        if (!l.van || !ok.has(l.van)) continue;
        const key = `${date}~${t.route_id}~${l.van}`;
        const r = map.get(key) ?? map.set(key, blank(date, t.route_id, l.van, false)).get(key)!;
        if (l.pax !== null) { r.pax += l.real; r.ad += l.real; r.booked_pax += l.pax; }
        else { for (const k of PAX_CATEGORIES) r[k] += real[k]; r.pax += rlN; r.booked_pax += bkN; }
        r.bookings += 1;
        const pick = pickName(ctx, b, l.part);
        if (pick) r.pickups.add(pick);
        // §vbSameVan: back on the same van; no more people or money, only where it drops them.
        if (sameVan) { r.return_same_van += 1; addDrop(r, dropOf(ctx, b, l.part)); }
      }
      // §vbRetLeg: a van that brings them back is another run, unless it also took people out (§vbRetMerge).
      if (sameVan) continue;
      for (const p of split ? parts : [parts[0]]) {
        const back = p ? p.return_van_id ?? p.group?.return_van_id ?? null : null;
        if (!back || !ok.has(back)) continue;
        pendRet.push({ date, route: t.route_id, van: back, pax: rlN, drop: dropOf(ctx, b, p) });
      }
    }
  }
  for (const x of pendRet) {
    const base = `${x.date}~${x.route}~${x.van}`;
    const out = map.get(base);
    if (out) { out.return_pax += x.pax; out.return_bookings += 1; addDrop(out, x.drop); continue; }
    const key = `${base}~R`;
    const r = map.get(key) ?? map.set(key, blank(x.date, x.route, x.van, true)).get(key)!;
    r.return_pax += x.pax; r.bookings += 1;
    addDrop(r, x.drop);
  }
  return [...map.entries()].sort((a, b) => cmp(a[0], b[0])).map(([key, r]) => ({
    ...r, key, code: codeOf(r.route_id), pickups: [...r.pickups], drops: [...r.drops].map(([name, changed]) => ({ name, changed })),
  }));
}

// ── Amounts ──────────────────────────────────────────────────────────────────────────────────────

export type PricedRow = BillRow & { override: RowOverride | null; rate: number; ex: number; cut: number; per_pax: number; bill: number; sale: number; pl: number; new: boolean };
export type PricedLine = ExtraLine & { bill: number; sale: number };
export type Mix = { rate: number; ex: number; cut: number; per_van: number; vans: number; amount: number };
export type CodeTotals = { code: string; vans: number; pax: number; bill: number; ex: number; cut: number; mix: Mix[] };
export type BillTotals = {
  ad: number; chd: number; inf: number; foc: number; pax: number; booked_pax: number; vans: number; outbound_vans: number; avg_pax_per_van: number;
  ex: number; cut: number; bill: number; sale: number; pl: number;
};

/** Legacy `vbRateOf`: the code's own default, else the bill's single default. */
export const defaultRate = (bill: Pick<StoredVanBill, 'route_rates' | 'rate'>, code: string): number => bill.route_rates[code] ?? bill.rate;

export function priceRow(row: BillRow, bill: StoredVanBill): PricedRow {
  const o = bill.row_overrides[row.key] ?? null;
  const rate = o?.rate ?? defaultRate(bill, row.code), ex = o?.ex ?? 0, cut = o?.cut ?? 0, per = o?.per ?? bill.per_pax;
  const amount = cents(rate + ex - cut), sale = cents(row.pax * per);
  // §vbNewRow: a row nobody typed on that appeared after the bill was saved. Without `seen` (bills
  // saved before legacy kept it) only return-only runs, the rows legacy had just started to see.
  const fresh = !!bill.updated_at && !o && (bill.seen ? !bill.seen.includes(row.key) : row.return_only);
  return { ...row, override: o && { ...o }, rate, ex, cut, per_pax: per, bill: amount, sale, pl: cents(sale - amount), new: fresh };
}
export const priceLine = (x: ExtraLine): PricedLine => ({ ...x, bill: cents(x.vans * x.rate + x.ex - x.cut), sale: cents(x.pax * x.per_pax) });

/** Legacy §vbMix: vans grouped by the same rate, extra and deduction, most vans first. */
function addMix(mix: Map<string, Mix>, rate: number, ex: number, cut: number, n: number): void {
  if (n <= 0) return;
  const k = `${rate}|${ex}|${cut}`;
  const m = mix.get(k) ?? mix.set(k, { rate, ex, cut, per_van: cents(rate + ex - cut), vans: 0, amount: 0 }).get(k)!;
  m.vans += n; m.amount = cents(m.per_van * m.vans);
}
const sortedMix = (mix: Map<string, Mix>): Mix[] => [...mix.values()].sort((a, b) => b.vans - a.vans || b.per_van - a.per_van);

export type BillView = BillAddress & {
  from: string; to: string; label: string; saved: boolean; van_id: string | null;
  vans: Pick<Van, 'id' | 'name' | 'plate' | 'capacity' | 'zone_base' | 'driver' | 'driver_phone' | 'active'>[];
  per_pax: number; rate: number; route_rates: Record<string, number>; row_overrides: Record<string, RowOverride>;
  codes: { code: string; rows: number; rate: number }[];
  rows: PricedRow[]; extra_lines: PricedLine[]; totals: BillTotals; by_code: CodeTotals[]; missing_rate: number;
  new_rows: string[]; seen: string[] | null; updated_at: string | null; updated_by: string | null;
  state: 'draft' | 'sent' | 'paid';
  sent: { at: string; by: string | null; bill: number; changed_since_sent: boolean } | null;
  paid: { at: string; by: string | null; on: string; via: PaidVia; ref: string | null; amount: number } | null;
};

/** Legacy `vbCodesIn`: the codes with work in the period, most runs first. */
export function codesIn(rows: readonly Pick<BillRow, 'code'>[]): { code: string; rows: number }[] {
  const out: { code: string; rows: number }[] = [];
  for (const r of rows) { const c = out.find((x) => x.code === r.code); if (c) c.rows += 1; else out.push({ code: r.code, rows: 1 }); }
  return out.sort((a, b) => b.rows - a.rows);
}

/** The bill as a read shows it: rows, lines, totals, the codes and the settlement state. */
export function billView(bill: StoredVanBill, rows: readonly BillRow[], vans: readonly Van[], opts: { saved: boolean; vanId?: string }): BillView {
  const priced = rows.map((r) => priceRow(r, bill));
  const lines = bill.extra_lines.map(priceLine);
  const T: BillTotals = { ad: 0, chd: 0, inf: 0, foc: 0, pax: 0, booked_pax: 0, vans: 0, outbound_vans: 0, avg_pax_per_van: 0, ex: 0, cut: 0, bill: 0, sale: 0, pl: 0 };
  const byCode = new Map<string, CodeTotals & { mixes: Map<string, Mix> }>();
  let missing = 0;
  for (const r of priced) {
    for (const k of PAX_CATEGORIES) T[k] += r[k];
    T.pax += r.pax; T.booked_pax += r.booked_pax; T.vans += 1; T.outbound_vans += r.return_only ? 0 : 1;
    T.ex += r.ex; T.cut += r.cut; T.bill += r.bill; T.sale += r.sale;
    if (!(r.rate > 0)) missing += 1;
    const c = byCode.get(r.code) ?? byCode.set(r.code, { code: r.code, vans: 0, pax: 0, bill: 0, ex: 0, cut: 0, mix: [], mixes: new Map() }).get(r.code)!;
    c.vans += 1; c.pax += r.pax; c.bill = cents(c.bill + r.bill); c.ex = cents(c.ex + r.ex); c.cut = cents(c.cut + r.cut);
    addMix(c.mixes, r.rate, r.ex, r.cut, 1);
  }
  for (const x of lines) {
    T.vans += x.vans; T.outbound_vans += x.vans; T.pax += x.pax; T.booked_pax += x.pax; T.ex += x.ex; T.cut += x.cut; T.bill += x.bill; T.sale += x.sale;
    if (!(x.rate > 0)) missing += x.vans;
  }
  for (const k of ['ex', 'cut', 'bill', 'sale'] as const) T[k] = cents(T[k]);
  T.pl = cents(T.sale - T.bill);
  T.avg_pax_per_van = T.outbound_vans ? Math.round((T.pax / T.outbound_vans) * 100) / 100 : 0;
  const state = bill.paid_at ? 'paid' : bill.sent_at ? 'sent' : 'draft';
  return {
    partner: bill.partner, month: bill.month, period: bill.period, ...billPeriod(bill.month, bill.period), saved: opts.saved, van_id: opts.vanId ?? null,
    vans: vans.map((v) => ({ id: v.id, name: v.name, plate: v.plate, capacity: v.capacity, zone_base: v.zone_base, driver: v.driver, driver_phone: v.driver_phone, active: v.active })),
    per_pax: bill.per_pax, rate: bill.rate, route_rates: { ...bill.route_rates }, row_overrides: copyBill(bill).row_overrides,
    codes: codesIn(priced).map((c) => ({ ...c, rate: defaultRate(bill, c.code) })),
    rows: priced, extra_lines: lines, totals: T,
    by_code: VB_CODES.filter((c) => byCode.has(c)).map((c) => { const { mixes, ...x } = byCode.get(c)!; return { ...x, mix: sortedMix(mixes) }; }),
    missing_rate: missing, new_rows: priced.filter((r) => r.new).map((r) => r.key), seen: bill.seen && [...bill.seen],
    updated_at: bill.updated_at, updated_by: bill.updated_by, state,
    sent: bill.sent_at ? { at: bill.sent_at, by: bill.sent_by, bill: bill.sent_bill ?? 0, changed_since_sent: cents(bill.sent_bill ?? 0) !== T.bill } : null,
    paid: bill.paid_at ? { at: bill.paid_at, by: bill.paid_by, on: bill.paid_on!, via: bill.paid_via!, ref: bill.paid_ref, amount: bill.paid_amount ?? 0 } : null,
  };
}

/** Legacy `vbAgg`: one line per partner with work in the period, most runs first. */
export type OverviewLine = {
  partner: string; van_ids: string[]; trips: number; pax: number; booked_pax: number; missing_rate: number;
  ex: number; cut: number; bill: number; sale: number; pl: number; by_code: CodeTotals[];
  state: BillView['state']; saved: boolean; updated_at: string | null; updated_by: string | null;
  sent: BillView['sent']; paid: BillView['paid'];
};
export function overviewLine(view: BillView): OverviewLine {
  return {
    partner: view.partner, van_ids: view.vans.map((v) => v.id), trips: view.totals.vans, pax: view.totals.pax, booked_pax: view.totals.booked_pax,
    missing_rate: view.missing_rate, ex: view.totals.ex, cut: view.totals.cut, bill: view.totals.bill, sale: view.totals.sale, pl: view.totals.pl,
    by_code: view.by_code, state: view.state, saved: view.saved, updated_at: view.updated_at, updated_by: view.updated_by, sent: view.sent, paid: view.paid,
  };
}
export const sortOverview = (lines: OverviewLine[]): OverviewLine[] =>
  lines.filter((l) => l.trips > 0).sort((a, b) => b.trips - a.trips || a.partner.localeCompare(b.partner, 'th'));

// ── Staff inputs ─────────────────────────────────────────────────────────────────────────────────

const amount = (v: unknown, name: string): number => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? cents(n) : bad(`${name} must be a number, 0 or more`);
};
const optAmount = (v: unknown, name: string): number | null => (v === undefined || v === null || v === '' ? null : amount(v, name));
const whole = (v: unknown, name: string, dflt: number): number => {
  if (v === undefined || v === null || v === '') return dflt;
  return Number.isInteger(v) && (v as number) >= 0 ? v as number : bad(`${name} must be a whole number, 0 or more`);
};

/** Fields a read shows that the server works out: sent back unchanged they are accepted, changed they are refused. */
const BILL_OWNED: Record<string, string> = {
  partner: 'the bill is addressed by its path', month: 'the bill is addressed by its path', period: 'the bill is addressed by its path',
  from: 'it follows from month and period', to: 'it follows from month and period', label: 'it follows from month and period',
  saved: 'it is worked out', van_id: 'use ?van_id= on GET', vans: 'edit the van (PATCH /operations/vans/{id})',
  codes: 'set route_rates', rows: 'rows are worked out from the bookings; set row_overrides', totals: 'it is worked out', by_code: 'it is worked out',
  missing_rate: 'it is worked out', new_rows: 'send mark_seen: true', seen: 'send mark_seen: true', updated_at: 'it is stamped', updated_by: 'it is stamped',
  state: 'use POST …/send, …/pay, …/unsend or …/unpay', sent: 'use POST …/send or …/unsend', paid: 'use POST …/pay or …/unpay',
};
const INPUT_FIELDS = ['per_pax', 'rate', 'route_rates', 'row_overrides', 'extra_lines', 'mark_seen'] as const;
export type BillPatch = Partial<Pick<StoredVanBill, 'per_pax' | 'rate' | 'route_rates' | 'row_overrides' | 'extra_lines'>> & { mark_seen: boolean };

function parseOverride(v: unknown, at: string): RowOverride | null {
  if (v === null) return null;
  if (!isObject(v)) bad(`${at} must be an object of rate, ex, cut and per`);
  assertKnownKeys(v as Record<string, unknown>, ['rate', 'ex', 'cut', 'per'], at);
  const o = v as Record<string, unknown>;
  const out = { rate: optAmount(o.rate, `${at}.rate`), ex: optAmount(o.ex, `${at}.ex`), cut: optAmount(o.cut, `${at}.cut`), per: optAmount(o.per, `${at}.per`) };
  return Object.values(out).some((x) => x !== null) ? out : null;
}
function parseLine(v: unknown, i: number, ids: Set<string>): ExtraLine {
  const at = `extra_lines[${i}]`;
  if (!isObject(v)) bad(`${at} must be an object`);
  const x = v as Record<string, unknown>;
  // A line read back carries its worked-out bill and sale: accepted, and worked out again.
  assertKnownKeys(x, ['id', 'date', 'note', 'vans', 'pax', 'rate', 'ex', 'cut', 'per_pax', 'bill', 'sale'], at);
  const id = x.id === undefined || x.id === null || x.id === '' ? `x${randomUUID().slice(0, 8)}` : typeof x.id === 'string' ? x.id : bad(`${at}.id must be text`);
  if (ids.has(id)) bad(`${at}.id ${id} is used twice`);
  ids.add(id);
  const date = x.date === undefined || x.date === null || x.date === '' ? null : typeof x.date === 'string' && isIsoDate(x.date) ? x.date : bad(`${at}.date must be YYYY-MM-DD`);
  const note = x.note === undefined || x.note === null ? null : typeof x.note === 'string' ? x.note.trim() || null : bad(`${at}.note must be text`);
  return {
    id, date, note, vans: whole(x.vans, `${at}.vans`, 1), pax: whole(x.pax, `${at}.pax`, 0),
    rate: optAmount(x.rate, `${at}.rate`) ?? 0, ex: optAmount(x.ex, `${at}.ex`) ?? 0, cut: optAmount(x.cut, `${at}.cut`) ?? 0, per_pax: optAmount(x.per_pax, `${at}.per_pax`) ?? 0,
  };
}

/**
 * A `PATCH`'s staff inputs. A field sent replaces that whole field (the client sends the map or list
 * it holds); a field not sent is kept. An override for a row that is neither in the period now nor
 * already stored is `400`.
 */
export function parseBillPatch(body: Record<string, unknown>, current: BillView): BillPatch {
  const rest = withoutServerOwned(body, current as unknown as Record<string, unknown>, BILL_OWNED);
  assertKnownKeys(rest, INPUT_FIELDS, 'A van bill');
  const out: BillPatch = { mark_seen: rest.mark_seen === true };
  if (rest.mark_seen !== undefined && typeof rest.mark_seen !== 'boolean') bad('mark_seen must be true or false');
  if (rest.per_pax !== undefined) out.per_pax = optAmount(rest.per_pax, 'per_pax') ?? 0;
  if (rest.rate !== undefined) out.rate = optAmount(rest.rate, 'rate') ?? 0;
  if (rest.route_rates !== undefined) {
    if (rest.route_rates !== null && !isObject(rest.route_rates)) bad('route_rates must be an object of code → rate');
    out.route_rates = {};
    for (const [code, v] of Object.entries((rest.route_rates ?? {}) as Record<string, unknown>)) {
      if (!(VB_CODES as readonly string[]).includes(code)) bad(`route_rates: ${code} is not a code (${VB_CODES.join(', ')})`);
      const r = optAmount(v, `route_rates.${code}`);
      if (r !== null) out.route_rates[code] = r;
    }
  }
  if (rest.row_overrides !== undefined) {
    if (rest.row_overrides !== null && !isObject(rest.row_overrides)) bad('row_overrides must be an object of row key → { rate, ex, cut, per }');
    const known = new Set([...current.rows.map((r) => r.key), ...Object.keys(current.row_overrides)]);
    out.row_overrides = {};
    for (const [key, v] of Object.entries((rest.row_overrides ?? {}) as Record<string, unknown>)) {
      if (!ROW_KEY.test(key)) bad(`row_overrides: ${key} is not a row key (date~route~van, ~R for a return-only run)`);
      if (!known.has(key)) bad(`row_overrides: there is no row ${key} on this bill`);
      const o = parseOverride(v, `row_overrides.${key}`);
      if (o) out.row_overrides[key] = o;
    }
  }
  if (rest.extra_lines !== undefined) {
    if (rest.extra_lines !== null && !Array.isArray(rest.extra_lines)) bad('extra_lines must be a list');
    const ids = new Set<string>();
    out.extra_lines = ((rest.extra_lines ?? []) as unknown[]).map((x, i) => parseLine(x, i, ids));
  }
  return out;
}

/** A paid bill is settled: change nothing until the payment is undone. */
export function assertEditable(bill: StoredVanBill): void {
  if (bill.paid_at) refuse(`The bill of ${bill.partner} for ${bill.month} period ${bill.period} is paid: undo the payment first (POST …/unpay)`, 409, 'bill_paid');
}
export function applyPatch(bill: StoredVanBill, patch: BillPatch, rowKeys: readonly string[], now: string, by: string | null): StoredVanBill {
  assertEditable(bill);
  const { mark_seen, ...fields } = patch;
  const next = { ...copyBill(bill), ...fields, updated_at: now, updated_by: by };
  // §vbSeen: saving says "I have seen these rows", so a row appearing later is pointed out.
  if (mark_seen) next.seen = [...rowKeys];
  return next;
}

// ── Sent and paid (new, decided 2026-10-09) ──────────────────────────────────────────────────────

export function send(bill: StoredVanBill, total: number, now: string, by: string | null): StoredVanBill {
  assertEditable(bill);
  return { ...copyBill(bill), sent_at: now, sent_by: by, sent_bill: total };
}
export function unsend(bill: StoredVanBill): StoredVanBill {
  assertEditable(bill);
  if (!bill.sent_at) refuse('The bill has not been sent', 409, 'bill_not_sent');
  return { ...copyBill(bill), sent_at: null, sent_by: null, sent_bill: null };
}
export type PayInput = { via: PaidVia; ref: string | null; paid_on: string };
export function parsePay(body: Record<string, unknown>, now: Date): PayInput {
  assertKnownKeys(body, ['via', 'ref', 'paid_on'], 'A van bill payment');
  const via = (PAID_VIA as readonly unknown[]).includes(body.via) ? body.via as PaidVia : bad(`via must be one of ${PAID_VIA.join(', ')}`);
  const ref = body.ref === undefined || body.ref === null ? null : typeof body.ref === 'string' ? body.ref.trim() || null : bad('ref must be text');
  const on = body.paid_on === undefined || body.paid_on === null || body.paid_on === '' ? todayInThailand(now)
    : typeof body.paid_on === 'string' && isIsoDate(body.paid_on) ? body.paid_on : bad('paid_on must be YYYY-MM-DD');
  return { via: via!, ref, paid_on: on };
}
export function pay(bill: StoredVanBill, input: PayInput, total: number, now: string, by: string | null): StoredVanBill {
  assertEditable(bill);
  if (!bill.sent_at) refuse('Send the bill to the van owner before marking it paid (POST …/send)', 409, 'bill_not_sent');
  return { ...copyBill(bill), paid_at: now, paid_by: by, paid_on: input.paid_on, paid_via: input.via, paid_ref: input.ref, paid_amount: total };
}
export function unpay(bill: StoredVanBill): StoredVanBill {
  if (!bill.paid_at) refuse('The bill is not paid', 409, 'bill_not_paid');
  return { ...copyBill(bill), paid_at: null, paid_by: null, paid_on: null, paid_via: null, paid_ref: null, paid_amount: null };
}

// ── Van rates (Transfer Fleet, legacy `van_rates`) ───────────────────────────────────────────────

export type VanRateField = 'base' | 'PK' | 'KL';
export type VanRate = { group_key: string; route_id: string | null; field: VanRateField; rate: number; updated_at: string | null; updated_by: string | null };
/** Legacy `MV_VAN_DEF`: what a van costs a day when nothing is set. */
export const VAN_RATE_DEFAULT = { own: 900, partner: 1800 } as const;
/** Legacy `vanGroupKey`: own vans are one group; others by their owner's name. */
export const vanGroupKey = (v: Pick<Van, 'ownership' | 'partner_name'> | undefined): string =>
  !v || v.ownership === 'own' ? 'own' : `p:${v.partner_name?.trim() || '—'}`;
const cell = (rates: readonly VanRate[], g: string, route: string | null, field: VanRateField): number | undefined =>
  rates.find((r) => r.group_key === g && r.route_id === route && r.field === field)?.rate;
/** Legacy `vanRate`: the route's zone, the route's base, the group's base, else the default. */
export function vanRate(rates: readonly VanRate[], g: string, routeId: string | null, zone: string | null): number {
  const z: VanRateField = zone === 'KL' ? 'KL' : 'PK';
  return (routeId ? cell(rates, g, routeId, z) ?? cell(rates, g, routeId, 'base') : undefined) ?? cell(rates, g, null, 'base') ?? (g === 'own' ? VAN_RATE_DEFAULT.own : VAN_RATE_DEFAULT.partner);
}
/** No rate is set at any level for this group, route and zone: the default is in use (legacy `drVanReal` `noRate`). */
export const noRateSet = (rates: readonly VanRate[], g: string, routeId: string | null, zone: string | null): boolean =>
  (!routeId || (cell(rates, g, routeId, zone === 'KL' ? 'KL' : 'PK') === undefined && cell(rates, g, routeId, 'base') === undefined)) && cell(rates, g, null, 'base') === undefined;

/**
 * Legacy `vbPullRates`: per code with work, the first route of that code with a rate above 0 for the
 * partner's group, in the first van's zone. `generic` marks a code that fell back to the group's base
 * or the default ("check before billing").
 */
export function pullRates(rows: readonly BillRow[], vans: readonly Van[], rates: readonly VanRate[]): { route_rates: Record<string, number>; got: { code: string; rate: number; generic: boolean }[]; none: string[] } {
  const g = vanGroupKey(vans[0]), zone = vans[0]?.zone_base ?? 'PK';
  const got: { code: string; rate: number; generic: boolean }[] = [], none: string[] = [];
  for (const { code } of codesIn(rows)) {
    let v = 0, spec = false;
    for (const r of rows) {
      if (v || r.code !== code) continue;
      const x = vanRate(rates, g, r.route_id, zone);
      if (!(x > 0)) continue;
      v = x;
      spec = (cell(rates, g, r.route_id, zone === 'KL' ? 'KL' : 'PK') ?? 0) > 0;
    }
    if (v > 0) got.push({ code, rate: v, generic: !spec }); else none.push(code);
  }
  return { route_rates: Object.fromEntries(got.map((x) => [x.code, x.rate])), got, none };
}

export type VanRateInput = { group_key: string; route_id: string | null; field: VanRateField; rate: number | null };
/** Legacy `vanRateSet`: one cell; no route = the group's base; an empty rate clears the cell. */
export function parseVanRate(body: Record<string, unknown>, routes: ReadonlySet<string>): VanRateInput {
  assertKnownKeys(body, ['group', 'group_key', 'route_id', 'field', 'rate'], 'A van rate');
  const g = body.group ?? body.group_key;
  if (typeof g !== 'string' || !(g === 'own' || (g.startsWith('p:') && g.length > 2))) bad('group must be own or p:<partner name>');
  const route = body.route_id === undefined || body.route_id === null || body.route_id === '' ? null : typeof body.route_id === 'string' ? body.route_id : bad('route_id must be text');
  if (route && !routes.has(route)) bad(`route_id ${route} is not a route (GET /v1/routes)`);
  const field = route === null ? 'base' : body.field === undefined || body.field === null || body.field === '' ? 'base'
    : body.field === 'base' || body.field === 'PK' || body.field === 'KL' ? body.field : bad('field must be base, PK or KL');
  return { group_key: g as string, route_id: route, field: field as VanRateField, rate: optAmount(body.rate, 'rate') };
}
/** Legacy `vanGroups`: every group with an active van, own vans first, then by name. */
export function vanRateGroups(vans: readonly Van[]): { key: string; name: string; own: boolean; van_ids: string[] }[] {
  const by = new Map<string, string[]>();
  for (const v of [...vans].sort((a, b) => cmp(a.id, b.id))) { if (!v.active) continue; const k = vanGroupKey(v); by.set(k, [...(by.get(k) ?? []), v.id]); }
  const name = (k: string) => (k === 'own' ? 'รถของบริษัท' : k.slice(2) === '—' ? 'รถร่วม (ยังไม่ระบุเจ้าของ)' : k.slice(2));
  return [...by.keys()].sort((a, b) => (a === 'own') !== (b === 'own') ? (a === 'own' ? -1 : 1) : name(a).localeCompare(name(b), 'th'))
    .map((k) => ({ key: k, name: name(k), own: k === 'own', van_ids: by.get(k)! }));
}

/** A trip of one of these bookings on a day of the period; what a store reads to price a bill. */
export const inPeriod = (t: Pick<BookingTrip, 'service_date'>, from: string, to: string): boolean => t.service_date >= from && t.service_date <= to;
