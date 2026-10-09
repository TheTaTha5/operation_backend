/**
 * Promo contracts written here (todo/contracts-model.md, "Design — promo writes"): legacy's promo form
 * (`ctOpenAddPromo`, `ctSaveAddPromo`), its void (`ctVoidContract`), the badge (`_ctContractStatus`)
 * and the "buy N get one free" counter (`laPromoStat`), all in allotment_v2/js/08-app.js. How a promo
 * prices is `priceBooking`'s and does not change here. Pure, so both stores decide alike.
 */
import { refuse } from './booking-actions.js';
import { isIsoDate } from './calendar.js';
import { SEAT_RELEASING_STATUSES } from './booking-status.js';
import { assertKnownKeys } from './server-owned.js';
import { contractView, type Contract, type ContractPeriod, type ContractSeatPrice } from './contracts.js';
import type { RateType } from './rate-types.js';
import type { Booking } from './operations.js';

const bad = (message: string): never => refuse(message, 400);

/** Legacy `LA_PROMO_ZONES`: the zones an own-price promo can price. */
export const PROMO_ZONES = ['PK', 'KL', 'NoTransfer'] as const;
export const PRICE_MODES = ['rate', 'own', 'discount'] as const;
/** Legacy `LA_PROMO_BASIS`: what "buy N" counts, adults and children or adults only. */
export const BONUS_BASES = ['adchd', 'ad'] as const;
type PriceMode = typeof PRICE_MODES[number];
type BonusBasis = typeof BONUS_BASES[number];

/** The promo form, as legacy's modal holds it. */
export type PromoForm = {
  price_mode: PriceMode; rate_type_id: string | null; seat_prices: ContractSeatPrice[];
  discount: { mode: 'pct' | 'amt'; value: number } | null; bonus: { buy: number; basis: BonusBasis } | null;
  active_from: string; active_to: string; book_from: string | null; book_to: string | null;
  route_ids: string[]; priority: number; note: string | null;
};
/** The confirms legacy asked, sent as flags (`409` until they are). */
export type PromoFlags = { unpriced_anyway: boolean; sold_anyway: boolean };

const FORM_FIELDS = ['price_mode', 'rate_type_id', 'seat_prices', 'discount', 'bonus', 'active_from', 'active_to', 'book_from', 'book_to', 'route_ids', 'priority', 'note'] as const;
const FLAG_FIELDS = ['unpriced_anyway', 'sold_anyway'] as const;
/** What a `PATCH` may echo but not change, and where to change it instead. */
export const PROMO_SERVER_OWNED: Record<string, string> = {
  id: 'the server makes it', agent_id: 'a promotion stays with its agent', kind: 'only promotions are written here',
  status: 'POST /v1/contracts/{id}/void', version: 'the server sets it from the first travel date', created_date: 'the server sets it',
  created_by: 'the server sets it', doc_id: 'POST /v1/agents/{id}/documents', voided_at: 'POST /v1/contracts/{id}/void',
  voided_by: 'POST /v1/contracts/{id}/void', program_periods: 'send route_ids and the dates', book_window: 'send book_from/book_to',
  state: 'the server computes it', bonus_progress: 'the server computes it',
};

const day = (value: unknown, name: string): string => (typeof value === 'string' && isIsoDate(value) ? value : bad(`${name} must be a date (YYYY-MM-DD)`));
const optionalDay = (value: unknown, name: string): string | null => (value === null || value === '' ? null : day(value, name));
const flag = (value: unknown, name: string): boolean => (value === undefined ? false : typeof value === 'boolean' ? value : bad(`${name} must be true or false`));

/** Reads the form's fields a body sends, and the flags. `create` requires what legacy's form always has. */
export function parsePromoBody(body: Record<string, unknown>, create: boolean): { fields: Partial<PromoForm>; flags: PromoFlags } {
  assertKnownKeys(body, [...FORM_FIELDS, ...FLAG_FIELDS, ...(create ? ['agent_id'] : [])], 'A promotion');
  const f: Partial<PromoForm> = {};
  if (body.price_mode !== undefined) {
    f.price_mode = (PRICE_MODES as readonly unknown[]).includes(body.price_mode) ? body.price_mode as PriceMode : bad('price_mode must be rate, own or discount');
  } else if (create) bad('price_mode is required: rate, own or discount');
  if (body.rate_type_id !== undefined) f.rate_type_id = body.rate_type_id === null || body.rate_type_id === '' ? null : typeof body.rate_type_id === 'string' ? body.rate_type_id : bad('rate_type_id must be text');
  if (body.seat_prices !== undefined) f.seat_prices = parseSeatPrices(body.seat_prices);
  if (body.discount !== undefined) f.discount = parseDiscount(body.discount);
  if (body.bonus !== undefined) f.bonus = parseBonus(body.bonus);
  for (const key of ['active_from', 'active_to'] as const) {
    if (body[key] !== undefined) f[key] = day(body[key], key);
    // Legacy: "ระบุช่วงวันเดินทาง".
    else if (create) bad('active_from and active_to are required: the travel dates the promotion covers');
  }
  for (const key of ['book_from', 'book_to'] as const) if (body[key] !== undefined) f[key] = optionalDay(body[key], key);
  if (body.route_ids !== undefined) {
    if (!Array.isArray(body.route_ids) || body.route_ids.some((r) => typeof r !== 'string' || r === '')) bad('route_ids must be a list of route ids');
    f.route_ids = [...new Set(body.route_ids as string[])];
  } else if (create) bad('route_ids is required: pick at least one route');
  if (body.priority !== undefined) {
    // Legacy's input has min 1 and reads a blank as 10.
    f.priority = body.priority === null ? 10 : Number.isInteger(body.priority) && (body.priority as number) >= 1 ? body.priority as number : bad('priority must be a whole number, 1 or more');
  }
  if (body.note !== undefined) f.note = body.note === null ? null : typeof body.note === 'string' ? body.note.trim() || null : bad('note must be text');
  return { fields: f, flags: { unpriced_anyway: flag(body.unpriced_anyway, 'unpriced_anyway'), sold_anyway: flag(body.sold_anyway, 'sold_anyway') } };
}

function parseSeatPrices(value: unknown): ContractSeatPrice[] {
  if (value === null) return [];
  if (!Array.isArray(value)) bad('seat_prices must be a list of { route_id, zone, category, residency, price }');
  const seen = new Set<string>();
  return (value as unknown[]).map((raw, i) => {
    const p = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : bad(`seat_prices[${i}] must be an object`);
    assertKnownKeys(p, ['route_id', 'zone', 'category', 'residency', 'price'], `seat_prices[${i}]`);
    const routeId = typeof p.route_id === 'string' && p.route_id ? p.route_id : bad(`seat_prices[${i}].route_id is required`);
    const zone = (PROMO_ZONES as readonly unknown[]).includes(p.zone) ? p.zone as string : bad(`seat_prices[${i}].zone must be one of ${PROMO_ZONES.join(', ')}`);
    const category = p.category === 'ad' || p.category === 'chd' ? p.category : bad(`seat_prices[${i}].category must be ad or chd`);
    const residency = p.residency === 'thai' || p.residency === 'foreign' ? p.residency : bad(`seat_prices[${i}].residency must be thai or foreign`);
    const price = typeof p.price === 'number' && Number.isFinite(p.price) && p.price >= 0 ? p.price : bad(`seat_prices[${i}].price must be a number, 0 or more`);
    const key = `${routeId}|${zone}|${category}|${residency}`;
    if (seen.has(key)) bad(`seat_prices[${i}] repeats ${routeId} ${zone} ${category} ${residency}`);
    seen.add(key);
    return { route_id: routeId, zone, category, residency, price };
  });
}
function parseDiscount(value: unknown): PromoForm['discount'] {
  if (value === null) return null;
  const d = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : bad('discount must be { mode, value }');
  assertKnownKeys(d, ['mode', 'value'], 'discount');
  const mode = d.mode === undefined ? 'pct' : d.mode === 'pct' || d.mode === 'amt' ? d.mode : bad('discount.mode must be pct or amt');
  const amount = typeof d.value === 'number' && Number.isFinite(d.value) ? d.value : bad('discount.value must be a number');
  return { mode, value: amount };
}
function parseBonus(value: unknown): PromoForm['bonus'] {
  if (value === null) return null;
  const b = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : bad('bonus must be { buy, basis } or null');
  assertKnownKeys(b, ['buy', 'free', 'basis'], 'bonus');
  // Legacy: "จำนวนที่ต้องซื้อต้องมากกว่า 0".
  const buy = Number.isInteger(b.buy) && (b.buy as number) >= 1 ? b.buy as number : bad('bonus.buy must be a whole number, 1 or more');
  if (b.free !== undefined && b.free !== 1) bad('bonus.free is always 1: buy N, get one free');
  const basis = b.basis === undefined ? 'adchd' : (BONUS_BASES as readonly unknown[]).includes(b.basis) ? b.basis as BonusBasis : bad('bonus.basis must be adchd or ad');
  return { buy, basis };
}

/** The form a stored promo was saved from (legacy's modal filled for an edit). */
export function promoFormOf(c: Contract): PromoForm {
  const first = c.program_periods[0];
  return {
    price_mode: c.price_mode ?? 'rate', rate_type_id: c.rate_type_id, seat_prices: c.seat_prices.map((p) => ({ ...p })),
    discount: c.discount && { ...c.discount }, bonus: c.bonus && { buy: c.bonus.buy, basis: c.bonus.basis === 'ad' ? 'ad' : 'adchd' },
    active_from: c.active_from ?? first?.travel_from ?? '', active_to: c.active_to ?? first?.travel_to ?? '',
    book_from: c.book_window ? first?.book_from ?? null : null, book_to: c.book_window ? first?.book_to ?? null : null,
    route_ids: c.program_periods.map((p) => p.route_id), priority: c.priority, note: c.note,
  };
}

/** What a promo's checks read beyond the form. */
export type PromoContext = {
  /** Legacy `laPromoMainRt(agentId)`, no date: the first main contract's rate, else the agent's. */
  mainRate: RateType | undefined;
  /** Whether a rate type exists. */
  rateTypeExists: boolean;
  /** Routes the form offers: the agent's programmes, its main contracts' routes, the edited promo's own. */
  offeredRoutes: ReadonlySet<string>;
  routeName: (id: string) => string;
};

const adultPrices = (rate: RateType | undefined, routeId: string): number[] => {
  const route = rate?.routes.find((r) => r.route_id === routeId);
  return Object.values(route?.zones ?? {}).flatMap((tiers) => [tiers.net?.ad_th ?? 0, tiers.net?.ad_fr ?? 0]);
};
/** Legacy `laPromoHasRate` for a discount: the main rate prices the route at all. */
const mainPrices = (rate: RateType | undefined, routeId: string): boolean => Object.keys(rate?.routes.find((r) => r.route_id === routeId)?.zones ?? {}).length > 0;
const unpriced = (routes: readonly string[], ctx: PromoContext, why: string, flags: PromoFlags): void => {
  if (!routes.length || flags.unpriced_anyway) return;
  const names = routes.map(ctx.routeName).join(', ');
  refuse(`${routes.length} route${routes.length === 1 ? ' has' : 's have'} ${why} (${names}): ${routes.length === 1 ? 'it sells' : 'they sell'} at the standard rate. Send unpriced_anyway: true to save anyway.`, 409, 'routes_unpriced');
};

/**
 * Legacy `ctSaveAddPromo`'s checks on the whole form, in its order. Answers the form as it is saved:
 * an own-price promo keeps only zones with an adult price above 0, and a mode's fields are cleared
 * when another mode is chosen. `sent` is the body's own fields, which must fit the mode.
 */
export function checkPromo(form: PromoForm, sent: Partial<PromoForm>, ctx: PromoContext, flags: PromoFlags): PromoForm {
  if (form.active_to < form.active_from) bad('active_to must not be before active_from');
  if (form.book_from && form.book_to && form.book_to < form.book_from) bad('book_to must not be before book_from');
  // Legacy fills a missing booking bound from the travel dates; that window must not run backwards either.
  if ((form.book_from ?? form.active_from) > (form.book_to ?? form.active_to)) bad('The booking window runs backwards: book_from is after the last travel date');
  if (!form.route_ids.length) bad('route_ids: pick at least one route');
  for (const id of form.route_ids) if (!ctx.offeredRoutes.has(id)) bad(`Route ${id} is not one of this agent's programmes or main contract routes`);
  const mode = form.price_mode;
  if (mode !== 'rate' && sent.rate_type_id) bad('rate_type_id is only for price_mode rate');
  if (mode !== 'own' && sent.seat_prices?.length) bad('seat_prices are only for price_mode own');
  if (mode !== 'discount' && sent.discount) bad('discount is only for price_mode discount');
  const out: PromoForm = { ...form, rate_type_id: mode === 'rate' ? form.rate_type_id : null, seat_prices: [], discount: mode === 'discount' ? form.discount : null };

  if (mode === 'rate') {
    if (!form.rate_type_id) bad('rate_type_id is required for price_mode rate (GET /v1/rate-types)');
    if (!ctx.rateTypeExists) bad(`Rate type ${form.rate_type_id} does not exist (GET /v1/rate-types)`);
  } else if (mode === 'own') {
    for (const p of form.seat_prices) if (!form.route_ids.includes(p.route_id)) bad(`seat_prices names route ${p.route_id}, which is not in route_ids`);
    // Legacy: a zone whose two adult prices are 0 is not sold in this promo, and is not saved.
    const sold = (p: ContractSeatPrice) => form.seat_prices.some((q) => q.route_id === p.route_id && q.zone === p.zone && q.category === 'ad' && q.price > 0);
    out.seat_prices = form.seat_prices.filter(sold);
    const covered = new Set(out.seat_prices.map((p) => p.route_id));
    if (!covered.size) bad('seat_prices: give at least one zone an adult price above 0');
    unpriced(form.route_ids.filter((r) => !covered.has(r)), ctx, 'no promo price', flags);
  } else {
    const d = form.discount ?? bad('discount is required for price_mode discount: { mode: pct | amt, value }');
    if (!(d.value > 0)) bad('discount.value must be above 0');
    if (d.mode === 'pct' && d.value >= 100) bad('A percentage discount must be below 100');
    if (d.mode === 'amt') {
      // Legacy: an amount at or above the cheapest adult price makes that price 0, which reads as "not sold".
      const lowest = Math.min(...form.route_ids.flatMap((r) => adultPrices(ctx.mainRate, r)).filter((v) => v > 0));
      if (Number.isFinite(lowest) && d.value >= lowest) {
        bad(`A discount of ${d.value} is at or above the cheapest adult price on the main rate (${lowest}): prices would become 0, which reads as not sold`);
      }
    }
    unpriced(form.route_ids.filter((r) => !mainPrices(ctx.mainRate, r)), ctx, 'no main-contract price to discount', flags);
  }
  return out;
}

/** The contract a checked form saves as; `base` carries what the form does not set (id, agent, version, status, created, document). */
export function promoFrom(form: PromoForm, base: Pick<Contract, 'id' | 'agent_id' | 'status' | 'version' | 'created_date' | 'created_by' | 'doc_id' | 'voided_at' | 'voided_by'>): Contract {
  const periods: ContractPeriod[] = form.route_ids.map((routeId) => ({
    route_id: routeId, book_from: form.book_from ?? form.active_from, book_to: form.book_to ?? form.active_to,
    travel_from: form.active_from, travel_to: form.active_to, note: null,
  }));
  return contractView({
    ...base, kind: 'promo', rate_type_id: form.rate_type_id, active_from: form.active_from, active_to: form.active_to, priority: form.priority,
    price_mode: form.price_mode, discount: form.discount, bonus: form.bonus && { buy: form.bonus.buy, free: 1, basis: form.bonus.basis },
    book_window: form.book_from !== null || form.book_to !== null, note: form.note, program_periods: periods, seat_prices: form.seat_prices,
  });
}

/** A new promo: legacy's version `promo-<first travel date>`, active, made today by this login. */
export const newPromoBase = (id: string, agentId: string, form: PromoForm, today: string, by: string | null) =>
  ({ id, agent_id: agentId, status: 'active' as const, version: `promo-${form.active_from}`, created_date: today, created_by: by, doc_id: null, voided_at: null, voided_by: null });

/** Same promo, as both stores hand it out (periods and prices in their order). */
export const samePromo = (a: Contract, b: Contract): boolean => JSON.stringify(contractView(a)) === JSON.stringify(contractView(b));

/** Legacy's warning before editing a promo already sold (`ctSaveAddPromo`): trips that name it. */
export function assertEditable(c: Contract, soldTrips: number, flags: PromoFlags): void {
  if (c.kind !== 'promo') bad('Only a promotion is edited here: a main contract follows its agent (PUT /v1/agents/{id}/rate-type, POST /v1/agents/{id}/renew)');
  if (c.status === 'void') refuse('This promotion is void and cannot be edited', 409, 'contract_void');
  if (soldTrips > 0 && !flags.sold_anyway) {
    refuse(`This promotion has been sold on ${soldTrips} trip${soldTrips === 1 ? '' : 's'}. Their prices stay as sold; reports compare against the new terms. Send sold_anyway: true to save anyway.`, 409, 'promo_sold');
  }
}

/** Legacy `ctVoidContract`: a promo that is not void yet. */
export function planVoid(c: Contract, now: string, by: string | null): Contract {
  if (c.kind !== 'promo') bad('Only a promotion can be voided: a main contract follows its agent');
  if (c.status === 'void') refuse('This promotion is already void', 409, 'contract_void');
  return contractView({ ...c, status: 'void', voided_at: now, voided_by: by });
}

/** Legacy `laPromoDiscTxt`. */
const discountText = (c: Contract): string => {
  if (c.price_mode !== 'discount' || !c.discount) return '';
  return c.discount.mode === 'amt' ? `ลด ${Math.round(c.discount.value).toLocaleString('en-US')} บาท/หัว` : `ลด ${c.discount.value}%`;
};
/** Legacy `laPromoLabel`: the name bills and reports show. */
export const promoLabel = (c: Contract): string => [c.note || c.version || c.id, discountText(c)].filter(Boolean).join(' · ');
/** The agent's activity line for a promo write (legacy wrote none). */
export const promoActivityText = (what: 'added' | 'edited' | 'void', c: Contract): string => `Promotion ${what} · ${promoLabel(c)}`;

/** Legacy `_ctContractStatus`: the badge, from the status and today. */
export type ContractState = 'void' | 'expired' | 'scheduled' | 'active';
export function contractState(c: Contract, today: string): ContractState {
  if (c.status === 'void') return 'void';
  if (c.active_to && today > c.active_to) return 'expired';
  if (c.active_from && today < c.active_from) return 'scheduled';
  return 'active';
}

export type BonusProgress = { buy: number; basis: string; sold: number; bookings: number; earned: number; used: number; left: number; over: number; to_next: number; pct: number };
const count = (pax: Record<string, number>, category: string) => (pax[category] ?? 0) + (pax[`${category}_fr`] ?? 0) + (pax[`${category}_th`] ?? 0);
/**
 * Legacy `laPromoStat`: passengers sold under the promo's routes and dates across the agent's
 * bookings, the free seats earned, and the FOC seats in those bookings ("used", legacy's own guess:
 * any FOC counts). Counts only; nothing is added or blocked. Null without a bonus, and on a void promo.
 */
export function bonusProgress(c: Contract, bookings: readonly Booking[]): BonusProgress | null {
  if (!c.bonus || c.status === 'void' || c.kind !== 'promo') return null;
  const { buy } = c.bonus;
  const basis = c.bonus.basis ?? 'adchd';
  // Legacy keeps one period per route, the last one listed.
  const periods = new Map(c.program_periods.map((p) => [p.route_id, p]));
  let sold = 0, foc = 0;
  const seen = new Set<string>();
  for (const b of bookings) {
    if (b.agent_id !== c.agent_id || (SEAT_RELEASING_STATUSES as readonly string[]).includes(b.status)) continue;
    for (const t of b.trips) {
      const p = periods.get(t.route_id);
      if (!p) continue;
      if ((p.travel_from && t.service_date < p.travel_from) || (p.travel_to && t.service_date > p.travel_to)) continue;
      if (c.book_window) {
        const booked = b.booking_date ?? '';
        if (!booked || (p.book_from && booked < p.book_from) || (p.book_to && booked > p.book_to)) continue;
      }
      sold += count(t.pax, 'ad') + (basis === 'adchd' ? count(t.pax, 'chd') : 0);
      foc += count(t.pax, 'foc');
      seen.add(b.id);
    }
  }
  const earned = Math.floor(sold / buy);
  return {
    buy, basis, sold, bookings: seen.size, earned, used: foc, left: Math.max(0, earned - foc), over: Math.max(0, foc - earned),
    to_next: sold % buy === 0 && sold > 0 ? 0 : buy - (sold % buy), pct: Math.round(((sold % buy) / buy) * 100),
  };
}
