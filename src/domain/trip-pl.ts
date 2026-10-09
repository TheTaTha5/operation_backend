/**
 * Trip P&L and the trip's actual costs (todo/money-model.md, "Design: the rest of Money", decided
 * 2026-10-10). Legacy computed it in the browser (`08-app.js` `pxTrip`, `pxDay`, `pxPax`, `pxLongtail`,
 * `pxUpsell`, `pxVanCost`, `pxClose`, `pxRan`, `bkLtState`, `pckMealSend`, `pckMealCount`, `drLtRate`).
 *
 * One boat's day: the heads on board and what they paid, priced by the cost model (`costing.ts`),
 * then line by line replaced by what was really spent: fuel from the Daily Fleet Log × the fuel price,
 * the meal order the pier sent, the vans that carried its passengers, the longtails ordered, the rent.
 * Closing freezes the money; a boat with nobody and no booking did not sail. Pure, so both stores
 * decide identically.
 */
import { refuse } from './booking-actions.js';
import type { Booking, BookingTrip, Deployment } from './operations.js';
import type { Route } from './calendar.js';
import type { Van } from './vans.js';
import { vanGroupKey, vanRate, type VanRate } from './van-bills.js';
import { saleTotal, tourSaleView, type StoredTourSale } from './pier-money.js';
import { aboardCounts, lostByType } from './aboard.js';
import { partPax } from './van-groups.js';
import { PAX_CATEGORIES } from './pax.js';
import type { EffectivePrice } from './fleet-daily.js';
import { dayRows, tripAmount, type DayRow } from './money-reports.js';
import {
  breakEven, calc, longtailRates, mealCost, planFor, vatShare, type CalcCtx, type CostPlan, type CostTemplate, type Engines, type MealVenue, type PlanLike, type RentBook,
} from './costing.js';
import { round2 } from './fleet-common.js';
import { copyActual, type TripActual } from './trip-actuals.js';

const RELEASED = new Set(['cancelled', 'rejected', 'cancelled_weather']);
const conflict = (message: string, code: string, extra?: object): never => {
  throw Object.assign(new Error(message), { statusCode: 409, code, ...(extra ? { extra } : {}) });
};

export { blankActual, copyActual, type Closed, type ClosedRow, type MealOrder, type TripActual } from './trip-actuals.js';

// ── Who is on the boat ───────────────────────────────────────────────────────────────────────────

/** Legacy `ckTripOn`: the booking's trip that day. */
export const tripOn = (b: Pick<Booking, 'trips'>, date: string): BookingTrip | undefined => b.trips.find((t) => t.service_date === date);
/**
 * How much of a trip a boat carries (legacy `O.boatId || t.charterBoatId`): its boat, else its charter
 * boat. A trip split over boats counts on each by its share of the heads (legacy had no split).
 */
export function boatShare(t: BookingTrip, boatId: string): number {
  const d = t.operations;
  if (d.boat_id) return d.boat_id === boatId ? 1 : 0;
  if (d.boat_splits.length) {
    const s = d.boat_splits.find((x) => x.boat_id === boatId);
    return s && t.pax_total > 0 ? (s.ad + s.chd + s.inf + s.foc) / t.pax_total : 0;
  }
  return t.charter_boat_id === boatId ? 1 : 0;
}
/** Legacy `pckVoidInfo`: everyone booked was lost (no-show or cancelled at the pier). */
export const isVoid = (t: BookingTrip): boolean => t.pax_total > 0 && PAX_CATEGORIES.every((k) => aboardCounts(t)[k] === 0);

/**
 * Legacy `pckOnBoard`: once the pier has counted (`actual_pax`), its count; otherwise booked less
 * everyone lost on the van and at the pier.
 */
export function onBoard(t: BookingTrip): number {
  const counted = t.operations.checkins.pier.filter((r) => r.actual_pax !== null);
  if (!counted.length) return Math.max(0, t.pax_total - lostByType(t.operations.checkins).total);
  // The pier's counts. Legacy read the main record only; the pier often counts a split booking whole
  // on it, so a part with no count of its own adds nothing.
  return counted.reduce((s, r) => s + Math.max(0, r.actual_pax!), 0);
}

/** The bookings on a boat that day (not cancelled), each with its trip and the boat's share of it. */
function onBoat(date: string, boatId: string, bookings: readonly Booking[]): { b: Booking; t: BookingTrip; share: number }[] {
  const out: { b: Booking; t: BookingTrip; share: number }[] = [];
  for (const b of [...bookings].sort((x, y) => (x.id < y.id ? -1 : 1))) {
    if (RELEASED.has(b.status)) continue;
    const t = tripOn(b, date);
    if (!t) continue;
    const share = boatShare(t, boatId);
    if (share > 0) out.push({ b, t, share });
  }
  return out;
}

export type TripPax = { ad: number; chd: number; inf: number; foc: number; total: number; th: number; fr: number; bookings: number; revenue: number };
/**
 * Legacy `pxPax`: heads on board by category, Thai and foreign for the park fee; the missing are
 * taken off every category in proportion (nobody knows who did not come). A booking with nobody on
 * board does not count; the revenue is each booking's trip amount (`tsTripAmount`).
 */
export function tripPax(date: string, boatId: string, bookings: readonly Booking[]): TripPax {
  const o = { ad: 0, chd: 0, inf: 0, foc: 0, total: 0, th: 0, fr: 0, bookings: 0, revenue: 0 };
  for (const { b, t, share } of onBoat(date, boatId, bookings)) {
    if (isVoid(t)) continue;
    const tot = onBoard(t) * share;
    if (!tot) continue;
    o.bookings += 1;
    let bookedTot = 0, th = 0;
    for (const k of PAX_CATEGORIES) { bookedTot += (t.pax[k] ?? 0) + (t.pax[`${k}_fr`] ?? 0) + (t.pax[`${k}_th`] ?? 0); th += t.pax[`${k}_th`] ?? 0; }
    const ratio = bookedTot ? tot / bookedTot : 0;
    for (const k of PAX_CATEGORIES) o[k] += ((t.pax[k] ?? 0) + (t.pax[`${k}_fr`] ?? 0) + (t.pax[`${k}_th`] ?? 0)) * ratio;
    o.th += th * ratio; o.total += tot;
    o.revenue += tripAmount(b, t) * share;
  }
  for (const k of PAX_CATEGORIES) o[k] = Math.round(o[k]);
  o.th = Math.round(o.th); o.total = Math.round(o.total); o.fr = Math.max(0, o.total - o.th);
  return o;
}

// ── Longtails (legacy `bkLtState`, `pxLongtail`) ─────────────────────────────────────────────────

const LONGTAIL = /longtail|หางยาว/i;
const CHARTER = /เหมา|charter|private|ไพรเวท|ส่วนตัว/i;
/** Legacy `bkV2LtAddOnKind`. */
const ltKind = (type: string): 'join' | 'charter' | 'charter-pax' | '' => {
  const t = type.toLowerCase();
  if (!/^longtail-(charter|join)(-|$)/.test(t)) return '';
  if (t.startsWith('longtail-join')) return 'join';
  return /-\d+-\d+$/.test(t) ? 'charter-pax' : 'charter';
};
export type LtState = { mode: 'none' | 'charter' | 'join'; boats: number; join_booked: boolean; join_extra: number; join_pax: number | null; upgrades: number; upgrades_due: number };
/**
 * Legacy `bkLtState`: what longtail one booking needs that day: the voucher's add-ons (or a Longtail
 * bundle on its rate type), what was sold on tour, and a "join → charter" upgrade. `bundle` says
 * whether the booking's rate type bundles a longtail on this route for this kind of trip.
 */
export function longtailState(b: Booking, routeId: string, date: string, sales: readonly StoredTourSale[], bundle: boolean): LtState {
  let join = false, charter = false, charterQty = 0, joinPax: number | null = null;
  for (const a of b.add_ons) {
    const ty = a.type ?? '', lbl = a.label ?? '', k = ltKind(ty);
    if (k === 'charter') { charter = true; charterQty += a.qty || 1; }
    else if (k === 'charter-pax') charter = true;
    else if (k === 'join') { join = true; if (a.join_adults !== undefined || a.join_children !== undefined) joinPax = Math.max(0, (a.join_adults ?? 0) + (a.join_children ?? 0)); }
    else if (ty.startsWith('transfer-')) { /* a transfer */ }
    else if (LONGTAIL.test(ty) || LONGTAIL.test(lbl)) {
      if (CHARTER.test(`${ty} ${lbl}`)) { charter = true; charterQty += a.qty || 1; } else join = true;
    }
  }
  if (!join && !charter && bundle) join = true;
  if (charter) join = false;
  let xPax = 0, xBoat = 0;
  for (const s of sales) {
    if (s.booking_id !== b.id || !LONGTAIL.test(s.service)) continue;
    if (s.trip_date && s.trip_date !== date) continue;
    if (CHARTER.test(s.service)) xBoat += s.qty || 1; else xPax += s.qty || 1;
  }
  let up = 0, upDue = 0;
  for (const u of b.upgrades) if (LONGTAIL.test(u.label) && CHARTER.test(u.label)) { up += 1; if (!u.collected) upDue += 1; }
  const booked = charter ? charterQty || 1 : 0;
  const boats = Math.max(booked + xBoat, up > 0 ? 1 : 0);
  if (boats > 0) return { mode: 'charter', boats, join_booked: false, join_extra: 0, join_pax: null, upgrades: up, upgrades_due: upDue };
  if (join || xPax > 0) return { mode: 'join', boats: 0, join_booked: join, join_extra: xPax, join_pax: joinPax, upgrades: 0, upgrades_due: 0 };
  return { mode: 'none', boats: 0, join_booked: false, join_extra: 0, join_pax: null, upgrades: 0, upgrades_due: 0 };
}
/** Whether a booking's rate type bundles a longtail on a route, for a seat or a charter trip (legacy `_rtBundleAppliesTo`). */
export type BundleOf = (b: Booking, routeId: string, charterTrip: boolean) => boolean;
export const bundleApplies = (appliesTo: string | null | undefined, charterTrip: boolean): boolean => {
  const a = appliesTo || 'seat';
  return a === 'both' || (charterTrip ? a === 'charter' : a === 'seat');
};

export type TripLongtail = { charter: number; join: number; upgrades: number; upgrades_due: number };
/** Legacy `pxLongtail`: boats chartered, and join heads (on board, capped by the add-on's count), plus those sold on tour. */
export function tripLongtail(date: string, boatId: string, bookings: readonly Booking[], sales: readonly StoredTourSale[], bundle: BundleOf): TripLongtail {
  const o = { charter: 0, join: 0, upgrades: 0, upgrades_due: 0 };
  for (const { b, t, share } of onBoat(date, boatId, bookings)) {
    if (isVoid(t)) continue;
    const LT = longtailState(b, t.route_id, date, sales, bundle(b, t.route_id, t.booking_mode === 'charter'));
    if (LT.mode === 'none') continue;
    if (LT.mode === 'charter') { o.charter += LT.boats * share; o.upgrades += LT.upgrades * share; o.upgrades_due += LT.upgrades_due * share; continue; }
    const pax = onBoard(t) * share;
    const jb = LT.join_pax !== null ? Math.min(LT.join_pax * share, pax) : pax;
    o.join += (LT.join_booked ? jb : 0) + LT.join_extra * share;
  }
  return o;
}

// ── On-tour sales (legacy `pxUpsell`) ────────────────────────────────────────────────────────────

export type UpsellRow = { voucher: string; label: string; sell: number; company: number; commission: number; seller: string | null; collected: boolean; kind: 'upgrade' | 'sale' };
/**
 * Legacy `pxUpsell`: what was sold on the boat that day, at what the company keeps. Upgrades have no
 * day, so they count on the booking's first trip only; on-tour sales on their trip date.
 */
export function tripUpsell(date: string, boatId: string, bookings: readonly Booking[], sales: readonly StoredTourSale[]) {
  const rows: UpsellRow[] = [];
  let sell = 0, company = 0, comm = 0;
  for (const { b, share } of onBoat(date, boatId, bookings)) {
    const voucher = b.voucher_ref || b.id;
    if (!b.trips[0] || b.trips[0].service_date === date) {
      for (const u of b.upgrades) {
        rows.push({ voucher, label: u.label || 'อัพเกรด', sell: u.sell_price, company: u.to_company ?? 0, commission: u.commission, seller: u.seller, collected: !!u.collected, kind: 'upgrade' });
        sell += u.sell_price * share; company += (u.to_company ?? 0) * share; comm += u.commission * share;
      }
    }
    for (const s of sales) {
      if (s.booking_id !== b.id || s.trip_date !== date) continue;
      const v = tourSaleView(s);
      rows.push({ voucher, label: s.service || 'ขายเพิ่ม', sell: v.total, company: s.to_company, commission: v.commission, seller: s.seller, collected: v.settle === 'done', kind: 'sale' });
      sell += saleTotal(s) * share; company += s.to_company * share; comm += v.commission * share;
    }
  }
  return { rows, sell: Math.round(sell), company: Math.round(company), commission: Math.round(comm) };
}

// ── Vans (legacy `pxVanCost`, `vanDayCost`) ──────────────────────────────────────────────────────

export type VanShare = { van_id: string; name: string; day: number; share: number; zone: 'PK' | 'KL' };
/**
 * Legacy `pxVanCost`: each van that carried this boat's passengers costs its day rate (by the boat's
 * route and the dearer pickup zone) shared by heads: a van feeding two boats is split by who it took.
 */
export function tripVanCost(date: string, boatId: string, routeId: string, bookings: readonly Booking[], ctx: {
  vans: ReadonlyMap<string, Van>; rates: readonly VanRate[]; areas: ReadonlyMap<string, { zone?: string | null }>;
}): { total: number; vans: VanShare[] } {
  const all = new Map<string, number>(), mine = new Map<string, number>(), zone = new Map<string, 'PK' | 'KL'>();
  for (const b of [...bookings].sort((x, y) => (x.id < y.id ? -1 : 1))) {
    if (RELEASED.has(b.status)) continue;
    const t = tripOn(b, date);
    if (!t) continue;
    const share = boatShare(t, boatId), parts = t.operations.van_parts;
    for (const p of parts) {
      const van = t.ovn_leg ? p.return_van_id ?? p.group?.return_van_id ?? p.group?.van_id ?? null : p.group?.van_id ?? null;
      if (!van) continue;
      const pax = parts.length > 1 ? partPax(p) : t.pax_total;
      all.set(van, (all.get(van) ?? 0) + pax);
      if (!share) continue;
      mine.set(van, (mine.get(van) ?? 0) + pax * share);
      const z = b.pickup_area_id ? ctx.areas.get(b.pickup_area_id)?.zone ?? '' : '';
      if (z === 'KL') zone.set(van, 'KL'); else if (!zone.has(van)) zone.set(van, 'PK');
    }
  }
  let total = 0;
  const list: VanShare[] = [];
  for (const [id, pax] of [...mine].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const v = ctx.vans.get(id);
    if (!v) continue;
    const z = zone.get(id) ?? 'PK';
    const day = vanRate(ctx.rates, vanGroupKey(v), routeId || null, z);
    const share = (all.get(id) ?? 0) > 0 ? pax / all.get(id)! : 1;
    total += day * share;
    list.push({ van_id: id, name: v.name || id, day, share, zone: z });
  }
  return { total: Math.round(total), vans: list };
}

// ── One boat's day (legacy `pxTrip`) ─────────────────────────────────────────────────────────────

export type BoatInfo = { id: string; name: string; pier: string | null; engine_count: number | null; capacity: number };
/** Everything a day's P&L reads, gathered by the route from both stores. */
export type PlDay = {
  date: string;
  deployments: readonly Deployment[];
  routes: ReadonlyMap<string, Route & { meal_venue_id?: string }>;
  boats: ReadonlyMap<string, BoatInfo>;
  bookings: readonly Booking[];
  sales: readonly StoredTourSale[];
  template: CostTemplate; plans: readonly CostPlan[]; rents: RentBook;
  venues: ReadonlyMap<string, MealVenue>;
  actuals: ReadonlyMap<string, TripActual>;
  /** Litres the Daily Fleet Log has for the boat that day, and its effective price (`flFuelPriceEff`). */
  fuelLitres(boatId: string): number | null;
  fuelPrice(boatId: string): EffectivePrice;
  vans: ReadonlyMap<string, Van>; rates: readonly VanRate[]; areas: ReadonlyMap<string, { zone?: string | null }>;
  bundle: BundleOf;
};
export type FuelPrice = { price: number; src: EffectivePrice['src'] | 'plan'; from: string };
export type Source = 'actual' | 'plan' | 'formula' | 'pending';
export type PlRow = {
  id: string; group: string; label: string; vat: boolean; estimate: number; actual: number | null; use: number; gross: number | null; source: Source; why: string;
};
export type TripPL = {
  date: string; boat_id: string; name: string; route_id: string; route_name: string | null; route_color: string | null; pier: string | null; departs: string;
  status: 'est' | 'part' | 'done' | 'nosail'; pax: TripPax; capacity: number;
  revenue_gross: number; upsell: ReturnType<typeof tripUpsell>; revenue: number; cost: number; profit: number; would_cost: number;
  no_sail: boolean; ran: boolean; closed: { at: string; by: string | null; pax: number } | null; actual_lines: number;
  fuel_price: FuelPrice; fuel_litres: number | null; plan: { id: string; name: string } | null; engines: Engines;
  longtail: TripLongtail; vans: VanShare[]; rows: PlRow[]; break_even: number | null;
  /** The day's revenue a head is under 30% of the day's average (legacy §revFlag): set on the day. */
  check_revenue: boolean;
};

const EMPTY_PLAN: Pick<PlanLike, 'overrides' | 'groups' | 'on_demand'> = { overrides: {}, groups: {}, on_demand: {} };
/** Legacy `flFuelSrcTxt`. */
export function fuelSourceText(fp: FuelPrice): string {
  if (!fp.price) return 'ยังไม่ได้ลงราคาน้ำมัน · ค่าน้ำมันคิดเป็น ฿0';
  if (fp.src === 'boat') return 'ราคาของลำนี้วันนี้';
  if (fp.src === 'pier') return 'ราคาของท่าวันนี้';
  if (fp.src === 'sib') return 'ราคาของลำอื่นที่ท่าเดียวกันวันนี้';
  if (fp.src === 'plan') return 'ไม่มีราคาจริงเลย · ใช้ราคาที่ตั้งไว้ในแผนต้นทุนของเส้นทางนี้';
  return `ยังไม่ได้ลงราคาวันนี้ · ใช้ราคาล่าสุด ${fp.from}`;
}
const baht = (n: number): string => `฿${Math.round(n || 0).toLocaleString('en-US')}`;
/** Legacy `mvForTrip`: the day's own restaurant first (`none` = no meal), else the route's. */
export function venueForTrip(a: Pick<TripActual, 'venue_id' | 'no_meal'> | undefined, route: { meal_venue_id?: string } | undefined, venues: ReadonlyMap<string, MealVenue>): MealVenue | null {
  if (a?.no_meal) return null;
  if (a?.venue_id) return venues.get(a.venue_id) ?? null;
  return route?.meal_venue_id ? venues.get(route.meal_venue_id) ?? null : null;
}
/** Legacy `pxIsOvr`: the route's plan changed this line. A group's ±% is not looked at, as legacy (it read `mul`, never set). */
const overridden = (plan: CostPlan | null, id: string, group: string): boolean => {
  if (!plan) return false;
  const o = plan.overrides[id];
  if (o && (o.off || (o.parts ?? []).some((p) => p && Object.keys(p).length))) return true;
  return !!plan.groups[group]?.off;
};

export function tripPL(boatId: string, day: PlDay): TripPL {
  const { date } = day;
  const boat = day.boats.get(boatId) ?? { id: boatId, name: boatId, pier: null, engine_count: null, capacity: 0 };
  const dep = day.deployments.find((d) => d.boat_id === boatId);
  const rid = dep?.route_id ?? '';
  const route = day.routes.get(rid);
  const PX = tripPax(date, boatId, day.bookings);
  const A = day.actuals.get(boatId);
  const T = day.template, R = vatShare(T);
  const plan = planFor(day.plans, rid, route?.family_id);
  // §fuelEff: no price that day falls back to the nearest; last of all the plan's.
  let FP: FuelPrice = day.fuelPrice(boatId);
  if (!FP.price && plan && plan.fuel_price > 0) FP = { price: plan.fuel_price, src: 'plan', from: '' };
  const fuelPr = FP.price || 0;
  const LT = tripLongtail(date, boatId, day.bookings, day.sales, day.bundle);
  const eng: Engines = (boat.engine_count || 3) >= 4 ? '4EN' : '3EN';
  // Legacy `pxPlanFor` hands on the plan's overrides and groups only: its heads, prices and on-demand
  // expectations are for playing on the design sheet, and must not move yesterday's profit.
  const pl = plan ? { overrides: plan.overrides, groups: plan.groups, on_demand: {} } : EMPTY_PLAN;
  const ctx: CalcCtx = {
    eng, boats: 1, fuel: fuelPr, boat_id: boatId, date, od_qty: { ltj: LT.join, ltc: LT.charter },
    // §ctChd: infants count with children; no infant eats like an adult.
    pax: PX.total, pax_th: PX.th, pax_ch: Math.min(PX.total, PX.chd + PX.inf),
  };
  const C = calc(pl as PlanLike, ctx, T, day.rents);

  // What was really spent replaces the estimate, line by line.
  const act: Record<string, { amount: number; why: string }> = {};
  const litres = day.fuelLitres(boatId);
  if (litres && litres > 0 && fuelPr > 0) {
    act.fuel = { amount: Math.round(litres * fuelPr), why: `${litres} ลิตร × ฿${fuelPr}${FP.src === 'boat' || FP.src === 'pier' ? '' : ` · ${fuelSourceText(FP)}`}` };
  }
  if (A?.meal) {
    const m = A.meal;
    act.meal = { amount: Math.round(m.amount), why: `${m.venue_name} · ผู้ใหญ่ ${m.adults}×${m.price_adult}${m.children ? ` + เด็ก ${m.children}×${m.price_child}` : ''}` };
  }
  const VN = tripVanCost(date, boatId, rid, day.bookings, day);
  if (VN.vans.length) {
    act.van = { amount: VN.total, why: VN.vans.map((v) => `${v.name} ฿${Math.round(v.day)}${v.share < 0.999 ? ` ×${Math.round(v.share * 100)}%` : ''} (${v.zone})`).join(' · ') };
  }
  // A venue is set but the order is not sent yet: the line is still the formula, with the real one waiting.
  let mealWait: string | null = null;
  if (!act.meal) {
    const V = venueForTrip(A, route, day.venues);
    if (V) {
      const nCh = Math.min(PX.chd, PX.total), nAd = Math.max(0, PX.total - nCh - PX.inf);
      const exp = mealCost(V, nAd, nCh) ?? 0;
      mealWait = `ร้าน ${V.name} · ${nAd}×฿${V.price_adult}${nCh ? ` + เด็ก ${nCh}×฿${V.price_child}` : ''} = ${baht(exp)} · ยังไม่ได้ส่งรายการให้ร้าน`;
    }
  }
  let rows: PlRow[] = C.rows.map((r) => {
    const a = act[r.id];
    const est = r.net;
    const real = a ? a.amount - (r.vat ? a.amount * R : 0) : null;
    let src: Source = real !== null ? 'actual' : overridden(plan, r.id, r.group) ? 'plan' : 'formula';
    let why = a ? a.why : '';
    if (r.id === 'fuel' && real === null) {
      if (!fuelPr) why = 'ยังไม่ได้ลงราคาน้ำมัน · บรรทัดนี้จึงเป็น ฿0 ทั้งที่เรือวิ่งจริง';
      else if (FP.src === 'sib' || FP.src === 'back' || FP.src === 'plan') why = `${fuelSourceText(FP)} · ฿${fuelPr}/ลิตร`;
    }
    // §boatRent: the rent is the contract's number, not an estimate.
    if (r.id === 'rent' && real === null && C.rent) {
      src = 'actual';
      why = `${baht(C.rent.total)}/${C.rent.days} วัน · หยุด ${C.rent.days_off} → วิ่ง ${C.rent.run_days} วัน = ${baht(C.rent.per_day)}/วัน${C.rent.trips_per_day > 1 ? ` ÷ ${C.rent.trips_per_day} รอบ` : ''}`;
    }
    // §pxOd: the longtails are what was ordered, not an estimate.
    if (r.id === 'ltj' && real === null) { src = 'actual'; why = `จอยจริง ${round2(LT.join)} คน (ไม่ใช่ ${PX.total} หัวทั้งลำ)`; }
    if (r.id === 'ltc' && real === null) { src = 'actual'; why = `เหมาจริง ${round2(LT.charter)} ลำ`; }
    if (r.id === 'meal' && real === null && mealWait) { src = 'pending'; why = mealWait; }
    return { id: r.id, group: r.group, label: r.label, vat: r.vat, estimate: est, actual: real, use: real ?? est, gross: a ? a.amount : null, source: src, why };
  });
  let cost = rows.reduce((s, r) => s + r.use, 0);
  const revGross = PX.revenue;
  const UP = tripUpsell(date, boatId, day.bookings, day.sales);
  // On-tour money is not in the bookings' totals: only what the company keeps is added.
  let revNet = (revGross + UP.company) * (1 - R);
  // §pxFreeze: a closed trip's money stands still; its heads are still live.
  if (A?.closed) {
    const Z = new Map(A.closed.rows.map((x) => [x.id, x]));
    rows = rows.map((r) => { const z = Z.get(r.id); return z ? { ...r, actual: z.actual ? z.amount : r.actual, use: z.amount } : r; });
    cost = A.closed.cost; revNet = A.closed.revenue;
  }
  // §pxNoSail: on the board but nobody and no booking: it did not sail, unless marked as ran.
  const estCost = cost;
  const noSail = PX.total === 0 && PX.bookings === 0 && !A?.ran;
  if (noSail) { rows = rows.map((r) => ({ ...r, use: 0 })); cost = 0; }
  const nReal = rows.filter((r) => r.actual !== null).length;
  const status = noSail ? 'nosail' : A?.closed ? 'done' : nReal ? 'part' : 'est';
  const capacity = dep?.capacity ?? boat.capacity;
  const be = breakEven({
    ...EMPTY_PLAN, ...pl, engines: eng, boats: 1, fuel_price: fuelPr, pax_th: PX.th, boat_id: boatId, price: PX.total ? revGross / PX.total : 0,
    price_child: null, commission_pct: 0, child_pct: 0, rent_off: false,
  }, Math.max(1, capacity || 60), T, day.rents, date);
  return {
    date, boat_id: boatId, name: boat.name || boatId, route_id: rid, route_name: route?.name ?? null, route_color: route?.color ?? null, pier: route?.pier ?? null,
    departs: route?.times?.[0] ?? '', status, pax: PX, capacity,
    revenue_gross: Math.round(revGross), upsell: UP, revenue: Math.round(revNet), cost: Math.round(cost), profit: Math.round(revNet - cost), would_cost: Math.round(estCost),
    no_sail: noSail, ran: !!A?.ran, closed: A?.closed ? { at: A.closed.at, by: A.closed.by, pax: A.closed.pax } : null, actual_lines: nReal,
    fuel_price: FP, fuel_litres: litres, plan: plan && { id: plan.id, name: plan.name }, engines: eng, longtail: LT, vans: VN.vans,
    rows: rows.map((r) => ({ ...r, estimate: round2(r.estimate), actual: r.actual === null ? null : round2(r.actual), use: round2(r.use) })),
    break_even: be, check_revenue: false,
  };
}

/** Legacy `pxDay` + `pxDayAgg`: every deployed boat (optionally one pier's), by departure, with the day's totals. */
export function dayPL(day: PlDay, pier: string | null) {
  const trips = day.deployments
    .filter((d) => { const r = day.routes.get(d.route_id); return !!r && (!pier || (r.pier ?? '') === pier); })
    .map((d) => tripPL(d.boat_id, day))
    .sort((a, b) => (a.departs || '99').localeCompare(b.departs || '99') || a.boat_id.localeCompare(b.boat_id));
  const totals = { trips: trips.length, revenue: 0, cost: 0, profit: 0, pax: 0, bookings: 0, loss_trips: 0, capacity: 0, did_not_sail: 0 };
  const routes = new Map<string, { route_id: string; name: string | null; trips: number; pax: number; revenue: number; cost: number; profit: number; capacity: number; break_even_avg: number | null; be: number[] }>();
  const groups = new Map<string, number>();
  for (const t of trips) {
    totals.revenue += t.revenue; totals.cost += t.cost; totals.profit += t.profit; totals.pax += t.pax.total; totals.bookings += t.pax.bookings; totals.capacity += t.capacity;
    if (t.profit < 0) totals.loss_trips += 1;
    if (t.no_sail) totals.did_not_sail += 1;
    const r = routes.get(t.route_id) ?? routes.set(t.route_id, { route_id: t.route_id, name: t.route_name, trips: 0, pax: 0, revenue: 0, cost: 0, profit: 0, capacity: 0, break_even_avg: null, be: [] }).get(t.route_id)!;
    r.trips += 1; r.pax += t.pax.total; r.revenue += t.revenue; r.cost += t.cost; r.profit += t.profit; r.capacity += t.capacity;
    if (t.break_even) r.be.push(t.break_even);
    for (const row of t.rows) groups.set(row.group, (groups.get(row.group) ?? 0) + row.use);
  }
  // §revFlag: with two boats or more and ten heads, a boat far under the day's revenue a head is flagged.
  const avg = trips.length > 1 && totals.pax >= 10 ? totals.revenue / totals.pax : 0;
  for (const t of trips) t.check_revenue = avg > 0 && t.pax.total > 0 && t.revenue / t.pax.total < avg * 0.3;
  return {
    date: day.date, pier, trips, totals,
    by_route: [...routes.values()].map(({ be, ...r }) => ({ ...r, break_even_avg: be.length ? round2(be.reduce((s, x) => s + x, 0) / be.length) : null })),
    by_group: [...groups].map(([group, amount]) => ({ group, amount: round2(amount) })),
  };
}

// ── Commands ─────────────────────────────────────────────────────────────────────────────────────

/** Legacy `pxClose`: the money of this moment, frozen. A boat that did not sail has nothing to freeze. */
export function closeTrip(t: TripPL, a: TripActual, now: string, by: string | null): TripActual {
  if (a.closed) conflict(`The P&L of ${t.name} on ${t.date} is already closed${a.closed.by ? ` by ${a.closed.by}` : ''}: reopen it first`, 'trip_closed');
  if (t.no_sail) conflict(`${t.name} did not sail on ${t.date} (no passenger, no booking): nothing to close`, 'trip_not_sailed');
  return { ...copyActual(a), closed: { at: now, by, revenue: t.revenue, cost: t.cost, profit: t.profit, pax: t.pax.total,
    rows: t.rows.map((r) => ({ id: r.id, label: r.label, amount: Math.round(r.use), actual: r.actual !== null })) } };
}
export function reopenTrip(a: TripActual): TripActual {
  if (!a.closed) conflict(`The P&L of ${a.boat_id} on ${a.service_date} is not closed`, 'trip_not_closed');
  return { ...copyActual(a), closed: null };
}
/** Legacy `pxRan`: offered only on a boat with nobody and no booking; costs it as if it sailed. */
export function markRan(t: TripPL, a: TripActual, now: string, by: string | null): TripActual {
  if (t.pax.total > 0 || t.pax.bookings > 0) conflict(`${t.name} carried ${t.pax.total} on ${t.date}: it sailed already`, 'trip_not_empty');
  return { ...copyActual(a), ran: true, ran_at: now, ran_by: by };
}
export const unmarkRan = (a: TripActual): TripActual => ({ ...copyActual(a), ran: false, ran_at: null, ran_by: null });

// ── The meal order (legacy `pckMealSend`, `pckMealCount`, `pckMealOvn*`) ─────────────────────────

export type MealPreview = {
  route_id: string; venue: { id: string; name: string; price_adult: number; price_child: number } | null;
  adults: number; children: number; infants: number; amount: number | null;
  undecided_overnight: { booking_id: string; lead: string | null; pax: number }[];
};
/** The route of the boat that day: its deployment's, else the first booking's on it (legacy `pckMealSend`). */
export function routeOfBoat(date: string, boatId: string, deployments: readonly Deployment[], bookings: readonly Booking[]): string {
  const dep = deployments.find((d) => d.boat_id === boatId);
  if (dep) return dep.route_id;
  return onBoat(date, boatId, bookings)[0]?.t.route_id ?? '';
}
/**
 * What the pier's meal order would send now: the day's restaurant, the heads that will eat (on board,
 * an overnight return leg only once marked `in`), at its prices. Infants do not order; children count
 * as children.
 */
export function mealPreview(date: string, boatId: string, ctx: {
  deployments: readonly Deployment[]; bookings: readonly Booking[]; routes: ReadonlyMap<string, { meal_venue_id?: string }>; venues: ReadonlyMap<string, MealVenue>; actual: TripActual | undefined;
}): MealPreview {
  const rid = routeOfBoat(date, boatId, ctx.deployments, ctx.bookings);
  const V = venueForTrip(ctx.actual, ctx.routes.get(rid), ctx.venues);
  const inc = ctx.actual?.meal_overnight ?? {};
  let ad = 0, chd = 0, inf = 0;
  const undecided: MealPreview['undecided_overnight'] = [];
  for (const { b, t, share } of onBoat(date, boatId, ctx.bookings)) {
    if (isVoid(t)) continue;
    if (t.ovn_leg) {
      const pax = onBoard(t) * share;
      if (pax > 0 && !inc[b.id]) undecided.push({ booking_id: b.id, lead: b.lead_pax ?? null, pax: round2(pax) });
      if (inc[b.id] !== 'in') continue;
    }
    // Heads that will sit down: booked less the lost, less the pier's no-show once it checked in (legacy).
    const lost = lostByType(t.operations.checkins).total;
    const pierNoShow = t.operations.checkins.pier.filter((r) => r.checked_in_at).reduce((s, r) => s + (r.no_show ?? 0), 0);
    const tot = Math.max(0, t.pax_total - lost - pierNoShow) * share;
    const c = Math.min((t.pax.chd ?? 0) + (t.pax.chd_fr ?? 0) + (t.pax.chd_th ?? 0), tot);
    const i = Math.min((t.pax.inf ?? 0) + (t.pax.inf_fr ?? 0) + (t.pax.inf_th ?? 0), Math.max(0, tot - c));
    chd += c; inf += i; ad += Math.max(0, tot - c - i);
  }
  ad = Math.round(ad); chd = Math.round(chd); inf = Math.round(inf);
  const amount = mealCost(V, ad, chd);
  return {
    route_id: rid, venue: V && { id: V.id, name: V.name, price_adult: V.price_adult, price_child: V.price_child },
    adults: ad, children: chd, infants: inf, amount: amount === null ? null : Math.round(amount), undecided_overnight: undecided,
  };
}
/** `POST …/meal-order`: legacy's three refusals, then the order frozen with the venue's prices. */
export function sendMealOrder(p: MealPreview, a: TripActual, now: string, by: string | null): TripActual {
  if (!p.venue) conflict('ลำนี้ยังไม่มีร้านอาหาร · ตั้งร้านก่อนแล้วค่อยส่งรายการ', 'no_meal_venue');
  if (p.undecided_overnight.length) {
    conflict(`ยังไม่ได้ระบุว่ารับกลับจากเกาะรวมอาหารหรือไม่ ${p.undecided_overnight.length} ใบ`, 'overnight_meal_undecided', { bookings: p.undecided_overnight });
  }
  if (!(p.adults + p.children)) conflict('ลำนี้ยังไม่มีคนที่จะไปจริง · ไม่ต้องสั่งอาหาร', 'nobody_aboard');
  const v = p.venue!;
  return { ...copyActual(a), meal: { venue_id: v.id, venue_name: v.name, adults: p.adults, children: p.children, price_adult: v.price_adult, price_child: v.price_child, amount: p.amount ?? 0, at: now, by } };
}

/** `PUT …/meal-overnight/{booking_id}`: the booking must be an overnight return leg on this boat that day. */
export function setOvernightMeal(a: TripActual, booking: Booking, boatId: string, include: unknown): TripActual {
  const t = tripOn(booking, a.service_date);
  if (!t || !t.ovn_leg || !boatShare(t, boatId)) refuse(`Booking ${booking.id} is not an overnight return on ${boatId} on ${a.service_date}`, 400);
  if (include !== null && include !== 'in' && include !== 'out') refuse('include must be in, out or null', 400);
  const next = copyActual(a);
  if (include === null) delete next.meal_overnight[booking.id]; else next.meal_overnight[booking.id] = include as 'in' | 'out';
  return next;
}

// ── Daily Report: the longtail cost (legacy `drData` §drReal, `drLtRate`) ───────────────────────

/**
 * Longtail boats and join heads of the day, by route, at the route plan's prices. As legacy's Daily
 * Report: a join counts the booked heads (not the add-on's count, not who boarded), and an overnight
 * return leg's longtail was paid on the way out.
 */
export function dailyLongtail(date: string, bookings: readonly Booking[], ctx: {
  sales: readonly StoredTourSale[]; bundle: BundleOf; template: CostTemplate; plans: readonly CostPlan[]; routes: ReadonlyMap<string, Route>;
}) {
  const by = new Map<string, { charter: number; join: number }>();
  let charter = 0, join = 0;
  for (const r of dayRows(date, bookings) as DayRow[]) {
    const rid = r.trip.route_id;
    const LT = r.ovn_back ? null : longtailState(r.booking, rid, date, ctx.sales, ctx.bundle(r.booking, rid, r.trip.booking_mode === 'charter'));
    const x = by.get(rid) ?? by.set(rid, { charter: 0, join: 0 }).get(rid)!;
    if (!LT) continue;
    if (LT.mode === 'charter') { charter += LT.boats; x.charter += LT.boats; }
    else if (LT.mode === 'join') {
      if (LT.join_booked) { join += r.booked; x.join += r.booked; }
      if (LT.join_extra) { join += LT.join_extra; x.join += LT.join_extra; }
    }
  }
  let cost = 0;
  const byRoute = [...by].map(([rid, x]) => {
    const rates = longtailRates(ctx.template, planFor(ctx.plans, rid, ctx.routes.get(rid)?.family_id));
    const c = x.charter * rates.charter + x.join * rates.join;
    cost += c;
    return { route_id: rid, charter_boats: x.charter, join_pax: x.join, rate_charter: rates.charter, rate_join: rates.join, cost: round2(c) };
  });
  return { charter_boats: charter, join_pax: join, cost: Math.round(cost), by_route: byRoute.filter((r) => r.charter_boats || r.join_pax) };
}
