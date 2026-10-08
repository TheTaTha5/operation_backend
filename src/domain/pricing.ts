/**
 * A booking's price, computed the way legacy computes it, bugs included (README "Quote",
 * decided 2026-10-09). Pure: both stores and `POST /v1/quote` call this one function, given the
 * booking and the catalogue it reads (rate types, the agent and its seasons, its contracts, boats).
 *
 * Legacy: wt-lk-inbox@658298d `08-app.js` `bkV2CalcQuote` → `_bkV2CalcQuoteRun`. Each step below
 * names the legacy function it copies. Bugs are copied on purpose and marked "legacy:".
 */
import type { PaxRow } from './pax.js';
import type { RateType } from './rate-types.js';
import type { Contract } from './contracts.js';
import type { BookingAdjustmentInput } from './booking-adjustments.js';
import { rateTypeFor, type RateSeason } from './rate-seasons.js';
import { refuse } from './booking-actions.js';

// ── Inputs ──

export type QuoteTrip = {
  route_id: string; service_date: string; booking_mode?: string; charter_boat_id?: string; zone?: string;
  ovn?: string; ovn_leg?: boolean; ovn_charge?: number;
  charter_price_mode?: 'rate' | 'manual'; charter_price_manual?: number;
  pax: readonly PaxRow[];
  /** On an edit that keeps the old rate: the rate this trip was sold at, when it is the same trip. */
  kept_rate_type_id?: string | null;
};
export type QuoteAddOn = { type: string; qty?: number; join_adults?: number; join_children?: number };
export type QuoteInput = {
  agent_id?: string; booking_date: string; trips: readonly QuoteTrip[]; add_ons: readonly QuoteAddOn[];
  adjustments: readonly BookingAdjustmentInput[];
  price_mode: 'rate' | 'manual'; manual_total?: number; rate_type_ref?: string | null;
  /** `kept`: an edit keeping the rate each trip was sold at; `agent`: today's (season, else agent). */
  rate: 'kept' | 'agent';
};
export type PricingAgent = { id: string; code: string | null; rate_type_id: string | null; rate_seasons: readonly RateSeason[] };
export type PricingCatalogue = {
  rateTypes: ReadonlyMap<string, RateType>;
  agent?: PricingAgent;
  /** The agent's contracts, main and promo. */
  contracts: readonly Contract[];
  /** Boat id → its type (`speedboat`, `catamaran`, …), for charter prices. */
  boatTypes: ReadonlyMap<string, string>;
};

// ── Output ──

export type QuoteWarning = { code: 'no_rate' | 'not_offered' | 'no_charter_price' | 'unknown_add_on'; trip?: number; add_on?: number; message: string };
export type QuoteTripPrice = { subtotal: number; rate_type_id: string | null; promo_id: string | null; rate_source: 'kept' | 'season' | 'agent' | 'booking' | null };
export type Quote = {
  price_mode: 'rate' | 'manual';
  seat: number; add_on: number;
  /** As legacy's `priceBreakdown`: negative. Legacy shows the FOC value and never subtracts it. */
  foc_discount: number; discount: number; extra: number; total: number;
  trips: QuoteTripPrice[];
  add_ons: { amount: number; counted: boolean }[];
  warnings: QuoteWarning[];
};

// ── Who may be priced by hand (legacy `bkV2ApplyAgentRules`) ──

const isCompany = (a?: PricingAgent) => !!a && (a.code === 'COMPANY' || a.id === 'a_company');
const isStaff = (a?: PricingAgent) => !!a && (a.code === 'STAFF' || a.id === 'a_staff');
const isWalkIn = (a?: PricingAgent) => !!a && (a.code === 'WALKIN' || a.id === 'a_walkin');

/**
 * The price mode a booking must have: company always by hand, staff inspection by hand at 0, staff
 * welfare and every agent by rate, a walk-in either. A mode sent that the rule contradicts is `400`.
 */
export function enforcedPriceMode(agent: PricingAgent | undefined, staffPurpose: string | undefined, requested: string | undefined, manualTotal: number | undefined):
  { price_mode: 'rate' | 'manual'; manual_total?: number } {
  if (requested !== undefined && requested !== 'rate' && requested !== 'manual') refuse('price_mode must be rate or manual', 400);
  const fixed = (mode: 'rate' | 'manual', why: string) => {
    if (requested !== undefined && requested !== mode) refuse(`price_mode must be ${mode}: ${why}`, 400);
    return mode;
  };
  if (isCompany(agent)) return { price_mode: fixed('manual', 'company bookings are priced by hand'), manual_total: manualTotal ?? 0 };
  if (isStaff(agent)) {
    if (staffPurpose === 'inspection') {
      fixed('manual', 'a staff inspection is free');
      if (manualTotal !== undefined && manualTotal !== 0) refuse('manual_total must be 0: a staff inspection is free', 400);
      return { price_mode: 'manual', manual_total: 0 };
    }
    return { price_mode: fixed('rate', 'staff welfare is priced at the staff rate') };
  }
  if (isWalkIn(agent)) return requested === 'manual' ? { price_mode: 'manual', manual_total: manualTotal ?? 0 } : { price_mode: 'rate' };
  return { price_mode: fixed('rate', 'only walk-in, company and staff bookings may be priced by hand') };
}

// ── Rates, as the price function reads them ──

type Cells = { ad_fr: number; chd_fr: number; ad_th: number; chd_th: number };
type Rate = { id: string; source: RateType; zones: (route: string) => Record<string, Cells> | undefined; promoId: string | null };
const cmpText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const cellsOf = (grid: Partial<Record<string, number>> | undefined): Cells =>
  ({ ad_fr: grid?.ad_fr ?? 0, chd_fr: grid?.chd_fr ?? 0, ad_th: grid?.ad_th ?? 0, chd_th: grid?.chd_th ?? 0 });
const routeOf = (rt: RateType, routeId: string) => rt.routes.find((r) => r.route_id === routeId);
const plainRate = (rt: RateType): Rate => ({
  id: rt.id, source: rt, promoId: null,
  zones: (routeId) => {
    const route = routeOf(rt, routeId);
    if (!route || Object.keys(route.zones).length === 0) return undefined;
    return Object.fromEntries(Object.entries(route.zones).map(([zone, tiers]) => [zone, cellsOf(tiers.net)]));
  },
});
/** No rate: what an own or discount promo is laid over when the trip has no base rate. */
const EMPTY_RATE = { id: '', routes: [] } as unknown as RateType;
/** A rate with one route's zones replaced (legacy `laPromoRate` own/discount: a copy of the base). */
const overlay = (base: Rate | null, routeId: string, zones: Record<string, Cells>, promoId: string): Rate => ({
  id: base?.id ?? '', source: base?.source ?? EMPTY_RATE, promoId,
  zones: (r) => (r === routeId ? zones : base?.zones(r)),
});

// ── Pax ──

type Pax = Record<string, number>;
const paxOf = (rows: readonly PaxRow[]): Pax => {
  const p: Pax = {};
  for (const row of rows) {
    const key = row.residency === 'foreign' ? `${row.category}_fr` : row.residency === 'thai' ? `${row.category}_th` : row.category;
    p[key] = (p[key] ?? 0) + row.count;
  }
  return p;
};
const n = (p: Pax, key: string) => p[key] ?? 0;
/** Every key of a category, bare and both residencies. */
const all = (p: Pax, category: string) => n(p, category) + n(p, `${category}_fr`) + n(p, `${category}_th`);

// ── The price ──

export function priceBooking(input: QuoteInput, catalogue: PricingCatalogue): Quote {
  const warnings: QuoteWarning[] = [];
  const rt = (id: string | null | undefined) => (id ? catalogue.rateTypes.get(id) : undefined);
  const agent = catalogue.agent;
  const bookingRate = rt(input.rate_type_ref);

  /** Legacy `laMainRtFor`: the season covering the date, else the agent's rate; undefined when that rate is gone. */
  const mainRate = (date: string): { rate: RateType; source: 'season' | 'agent' } | undefined => {
    if (!agent) return undefined;
    const at = rateTypeFor(agent.rate_type_id, agent.rate_seasons, date);
    const found = rt(at.rate_type_id);
    return found && { rate: found, source: at.source };
  };
  /** Legacy `laPromoMainRt`: with a date and seasons, the seasonal rate; else the first main contract by id, else the agent's. */
  const promoMainRate = (date?: string): RateType | undefined => {
    if (!agent) return undefined;
    if (date && agent.rate_seasons.length) { const season = mainRate(date); if (season) return season.rate; }
    const main = [...catalogue.contracts].filter((c) => c.kind === 'main').sort((a, b) => (a.id < b.id ? -1 : 1))[0];
    return rt(main?.rate_type_id ?? agent.rate_type_id);
  };

  /** Legacy `bkV2GetRTForTrip` before the promo: kept, else today's main, else the booking's. */
  const baseFor = (trip: QuoteTrip): { rate: Rate | null; source: QuoteTripPrice['rate_source'] } => {
    if (input.rate === 'kept' && trip.kept_rate_type_id !== undefined) {
      const kept = rt(trip.kept_rate_type_id ?? input.rate_type_ref);
      if (kept) return { rate: plainRate(kept), source: 'kept' };
    }
    const main = mainRate(trip.service_date);
    if (main) return { rate: plainRate(main.rate), source: main.source };
    if (isCompany(agent)) return { rate: null, source: null };
    return bookingRate ? { rate: plainRate(bookingRate), source: 'booking' } : { rate: null, source: null };
  };

  /** Legacy `laPromoHasRate`. legacy: a discount promo is checked against the main rate without a date. */
  const promoHasRate = (c: Contract, routeId: string): boolean => {
    if (c.price_mode === 'own') return c.seat_prices.some((p) => p.route_id === routeId && p.price > 0);
    if (c.price_mode === 'discount') { const m = promoMainRate(); return !!(m && plainRate(m).zones(routeId)); }
    const r = rt(c.rate_type_id);
    const route = r && routeOf(r, routeId);
    return !!route && (Object.keys(route.zones).length > 0 || Object.keys(route.charter).length > 0);
  };
  /** Legacy `laPromoCovers`: the travel date, a period for the route, and the booking date when `book_window`. */
  const promoCovers = (c: Contract, routeId: string, date: string): boolean => {
    if (c.active_from && date < c.active_from) return false;
    if (c.active_to && date > c.active_to) return false;
    return c.program_periods.some((p) => p.route_id === routeId
      && !(p.travel_from && date < p.travel_from) && !(p.travel_to && date > p.travel_to)
      && (!c.book_window || (!!input.booking_date && !(input.booking_date < p.book_from) && !(input.booking_date > p.book_to))));
  };
  /** Legacy `laPromoFor` + `laPromoRate`: the winning promo's rate for this trip, or the base. */
  const withPromo = (base: Rate | null, trip: QuoteTrip): Rate | null => {
    if (!agent) return base;
    const hit = catalogue.contracts
      .filter((c) => c.kind === 'promo' && c.status === 'active' && promoCovers(c, trip.route_id, trip.service_date) && promoHasRate(c, trip.route_id))
      // The highest priority, then the latest start (legacy compares the dates as text).
      .sort((a, b) => (b.priority - a.priority) || cmpText(b.active_from ?? '', a.active_from ?? ''));
    const c = hit[0];
    if (!c) return base;
    if (c.price_mode === 'own') {
      const zones: Record<string, Cells> = { ...(base?.zones(trip.route_id) ?? {}) };
      const own = c.seat_prices.filter((p) => p.route_id === trip.route_id);
      for (const zone of new Set(own.map((p) => p.zone))) {
        const cell = (category: string, residency: string) => own.find((p) => p.zone === zone && p.category === category && p.residency === residency)?.price ?? 0;
        zones[zone] = { ad_fr: cell('ad', 'foreign'), chd_fr: cell('chd', 'foreign'), ad_th: cell('ad', 'thai'), chd_th: cell('chd', 'thai') };
      }
      return overlay(base, trip.route_id, zones, c.id);
    }
    if (c.price_mode === 'discount') {
      const main = promoMainRate(trip.service_date);
      const mz = main && plainRate(main).zones(trip.route_id);
      if (!mz || !c.discount || !(c.discount.value > 0)) return base;
      const { mode, value } = c.discount;
      const off = (v: number) => (v <= 0 ? v : Math.max(0, mode === 'amt' ? Math.round(v - value) : Math.round(v * (1 - value / 100))));
      const zones = Object.fromEntries(Object.entries(mz).map(([z, cells]) => [z, { ad_fr: off(cells.ad_fr), chd_fr: off(cells.chd_fr), ad_th: off(cells.ad_th), chd_th: off(cells.chd_th) }]));
      return overlay(base, trip.route_id, zones, c.id);
    }
    const promoRate = rt(c.rate_type_id);
    if (!promoRate) return base;
    if (base && promoRate.id === base.id) return base;
    return { ...plainRate(promoRate), promoId: c.id };
  };

  const bundleApplies = (bundle: { applies_to: string | null } | null | undefined, charter: boolean) => {
    if (!bundle) return false;
    const to = bundle.applies_to ?? 'seat';
    return to === 'both' || (charter ? to === 'charter' : to === 'seat');
  };

  // Steps 3 and 4: each trip's subtotal (legacy `_bkV2TripSubtotalRun`).
  let seat = 0, focValue = 0;
  const tripPrices: QuoteTripPrice[] = input.trips.map((trip, i) => {
    const base = baseFor(trip);
    const rate = trip.route_id && trip.service_date ? withPromo(base.rate, trip) : base.rate;
    const price: QuoteTripPrice = { subtotal: 0, rate_type_id: rate?.id || null, promo_id: rate?.promoId ?? null, rate_source: base.source };
    const p = paxOf(trip.pax);
    if (rate && trip.zone) {
      const cells = rate.zones(trip.route_id)?.[trip.zone];
      // legacy: the FOC value is counted on charters and return legs too, and never subtracted.
      if (cells) focValue += cells.ad_fr * (n(p, 'foc_fr') || n(p, 'foc')) + cells.ad_th * n(p, 'foc_th');
    }
    if (!rate) { warnings.push({ code: 'no_rate', trip: i, message: `trips[${i}] has no rate type to price it: ฿0` }); return price; }
    if (trip.ovn_leg) return price;
    const route = routeOf(rate.source, trip.route_id);
    const bundle = route?.longtail_bundle;
    if (trip.booking_mode === 'charter') {
      if (!trip.charter_boat_id) return price;
      const charter = route?.charter[(catalogue.boatTypes.get(trip.charter_boat_id) ?? '').toLowerCase()];
      const manual = Math.round(trip.charter_price_manual ?? 0);
      if (!charter) {
        if (trip.charter_price_mode === 'manual' && manual > 0) price.subtotal = manual;
        else warnings.push({ code: 'no_charter_price', trip: i, message: `trips[${i}]: no charter price for this boat on ${trip.route_id}: ฿0` });
        seat += price.subtotal;
        return price;
      }
      // legacy: extra passengers count infants and FOC.
      const extras = Math.max(0, all(p, 'ad') + all(p, 'chd') + all(p, 'inf') + all(p, 'foc') - (charter.starter_includes ?? 0));
      const bundled = bundle && bundle.mode === 'paid' && bundleApplies(bundle, true) ? (bundle.adult ?? 0) * all(p, 'ad') + (bundle.child ?? 0) * all(p, 'chd') : 0;
      price.subtotal = trip.charter_price_mode === 'manual' ? manual : (charter.starter_price ?? 0) + extras * (charter.extra_per_pax ?? 0) + bundled;
      seat += price.subtotal;
      return price;
    }
    const cells = trip.zone ? rate.zones(trip.route_id)?.[trip.zone] : undefined;
    // legacy: only both adult prices at 0 means "not offered"; a single 0 cell sells for ฿0.
    if (!cells || (cells.ad_fr === 0 && cells.ad_th === 0)) {
      warnings.push({ code: 'not_offered', trip: i, message: `trips[${i}]: ${trip.route_id} zone ${trip.zone ?? '(none)'} has no price: ฿0` });
      return price;
    }
    // legacy: a bare count is priced only when its foreign count is 0; infants are never charged.
    price.subtotal = cells.ad_fr * (n(p, 'ad_fr') || n(p, 'ad')) + cells.chd_fr * (n(p, 'chd_fr') || n(p, 'chd'))
      + cells.ad_th * n(p, 'ad_th') + cells.chd_th * n(p, 'chd_th');
    if (bundle && bundle.mode === 'paid' && bundleApplies(bundle, false)) price.subtotal += (bundle.adult ?? 0) * all(p, 'ad') + (bundle.child ?? 0) * all(p, 'chd');
    seat += price.subtotal;
    return price;
  });

  // Step 5: add-ons, from one rate for the whole booking (legacy `bkV2AddOnRT`): never a promo.
  const first = input.trips.find((t) => t.route_id && t.service_date);
  const addOnRate: RateType | undefined = isCompany(agent) ? undefined
    : first && input.rate === 'kept' && first.kept_rate_type_id !== undefined && rt(first.kept_rate_type_id ?? input.rate_type_ref)
      ? rt(first.kept_rate_type_id ?? input.rate_type_ref)
      : (first && mainRate(first.service_date)?.rate) ?? bookingRate;
  // legacy: a bundle of either mode on any trip's route skips the longtail join from the total.
  const anyBundled = !!addOnRate && input.trips.some((t) => t.route_id && bundleApplies(routeOf(addOnRate, t.route_id)?.longtail_bundle, t.booking_mode === 'charter'));
  const longtailTrips = (r: RateType) => input.trips.filter((t) => t.route_id && routeOf(r, t.route_id)?.longtail);
  const addOnPrice = (a: QuoteAddOn, index: number): number => {
    if (!addOnRate) return 0;
    if (a.type === 'longtail-join') {
      const trips = longtailTrips(addOnRate);
      const capA = trips.reduce((s, t) => s + all(paxOf(t.pax), 'ad'), 0), capC = trips.reduce((s, t) => s + all(paxOf(t.pax), 'chd'), 0);
      let restA = a.join_adults === undefined ? capA : Math.max(0, Math.min(a.join_adults, capA));
      let restC = a.join_children === undefined ? capC : Math.max(0, Math.min(a.join_children, capC));
      let total = 0;
      for (const t of trips) {
        const lt = routeOf(addOnRate, t.route_id)!.longtail!;
        const p = paxOf(t.pax);
        const adults = Math.min(restA, all(p, 'ad')), children = Math.min(restC, all(p, 'chd'));
        restA -= adults; restC -= children;
        total += (lt.join_adult ?? 0) * adults + (lt.join_child ?? 0) * children;
      }
      return total;
    }
    // legacy: a longtail charter is charged once per applicable trip, then × qty.
    if (a.type === 'longtail-charter') return longtailTrips(addOnRate).reduce((s, t) => s + (routeOf(addOnRate, t.route_id)!.longtail!.charter_price ?? 0), 0);
    if (a.type.startsWith('transfer-')) {
      const [, routeId, zone, vehicle] = a.type.split('-');
      return routeOf(addOnRate, routeId)?.transfer[zone]?.[vehicle] ?? 0;
    }
    warnings.push({ code: 'unknown_add_on', add_on: index, message: `add_ons[${index}]: ${a.type} has no price in the rate: ฿0` });
    return 0;
  };
  let addOn = 0;
  const addOnPrices = input.add_ons.map((a, i) => {
    const amount = addOnPrice(a, i) * (a.qty ?? 1);
    // legacy: the bundled join keeps its full amount on the add-on, but is left out of the total.
    const counted = !(a.type === 'longtail-join' && anyBundled);
    if (counted) addOn += amount;
    return { amount, counted };
  });

  // Step 1: priced by hand. legacy: adjustments and overnight charges are ignored.
  if (input.price_mode === 'manual') {
    const total = Math.max(0, input.manual_total ?? 0);
    // The rate engine's trip subtotals are kept, as legacy stores them; its warnings do not apply.
    return { price_mode: 'manual', seat: total, add_on: 0, foc_discount: 0, discount: 0, extra: 0, total, trips: tripPrices, add_ons: addOnPrices, warnings: [] };
  }

  // Step 6: adjustments and overnight charges.
  const base = seat + addOn;
  let discount = 0, extra = 0;
  for (const a of input.adjustments) {
    if (!(a.value > 0)) continue;
    if (a.kind === 'discount') discount += a.mode === 'percent' ? Math.round(base * a.value / 100) : Math.round(a.value);
    else extra += Math.round(a.value);
  }
  for (const t of input.trips) if (t.ovn) extra += Math.max(0, t.ovn_charge ?? 0);
  return {
    price_mode: 'rate', seat, add_on: addOn, foc_discount: focValue === 0 ? 0 : -focValue, discount: discount === 0 ? 0 : -discount, extra,
    total: Math.max(0, base - discount + extra), trips: tripPrices, add_ons: addOnPrices, warnings,
  };
}
