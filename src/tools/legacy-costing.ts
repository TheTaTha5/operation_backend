/**
 * Legacy's cost model and trip actuals, as rows for migration 160 (todo/money-model.md, "Design: the
 * rest of Money"). Pure, so `test/legacy-costing.test.ts` checks the mapping on fixture rows;
 * `import-costing.ts` writes what this returns.
 *
 * - `app_meta.cost_template` → the template, through the API's own parser (legacy's short keys).
 * - `app_meta.cost_plans` → plans, by the API's own rules; a route or boat not here is cleared, listed.
 * - `app_meta.boat_rent` → rents; a boat not here is skipped.
 * - `meal_venues` → venues; `routes.mealvenueid` → the route's venue.
 * - `trip_actuals` (key `date::boat`) → trip actuals: the meal order, its note, overnight choices
 *   (on imported `lg_` bookings), close and "ran" when legacy has them; `pier_job.mv` → the day's venue.
 *   A boat not here is skipped. Legacy's `—` author is none.
 */
import type { Report } from './legacy-records.js';
import { metaJson } from './legacy-van-bills.js';
import {
  applyPlanFields, applyRentFields, applyVenueFields, blankPlan, blankRent, blankVenue, parseTemplate, type BoatRent, type CostPlan, type CostTemplate, type MealVenue,
} from '../domain/costing.js';
import { blankActual, type TripActual } from '../domain/trip-actuals.js';

type Row = Record<string, unknown>;
const str = (value: unknown): string => (value == null ? '' : String(value).trim());
const isObject = (v: unknown): v is Row => v !== null && typeof v === 'object' && !Array.isArray(v);
const instant = (value: unknown): string | null => { const s = str(value); return s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : null; };
const isDay = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const who = (v: unknown): string | null => { const s = str(v); return s && s !== '—' ? s : null; };
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export type CostingSource = {
  meta: Row[];                 // app_meta rows { key, value }
  venues: Row[];               // meal_venues
  routes: Row[];               // routes { id, mealvenueid }
  actuals: Row[];              // trip_actuals { key, value }
  pierJobs: Row[];             // pier_job { key, value }
};
export type CostingHere = { routeKeys: ReadonlySet<string>; routes: ReadonlySet<string>; boats: ReadonlySet<string>; bookings: ReadonlySet<string>; prefix: string; now: string };
export type CostingOut = {
  template: CostTemplate | null; plans: CostPlan[]; rents: BoatRent[]; venues: MealVenue[];
  routeVenues: { route_id: string; venue_id: string | null }[]; actuals: TripActual[];
};

const metaOf = (src: CostingSource, key: string): unknown => metaJson(src.meta.find((m) => str(m.key) === key)?.value);

export function mapLegacyCosting(src: CostingSource, here: CostingHere, report: Report): CostingOut {
  const out: CostingOut = { template: null, plans: [], rents: [], venues: [], routeVenues: [], actuals: [] };

  const tpl = metaOf(src, 'cost_template');
  if (isObject(tpl)) {
    try { out.template = parseTemplate(tpl); } catch (e) { report.skip('cost template', 'cost_template', message(e)); }
  }

  const plans = metaOf(src, 'cost_plans');
  for (const [i, raw] of (Array.isArray(plans) ? plans : []).entries()) {
    if (!isObject(raw)) continue;
    const id = str(raw.id) || `p_legacy_${i}`;
    const { id: _id, ...fields } = raw;
    const famId = str(fields.famId);
    if (famId && !here.routeKeys.has(famId)) { report.skip('plan route', id, `route ${famId} not here: the plan is kept without one`); fields.famId = ''; }
    const boat = str(fields.boatId);
    if (boat && !here.boats.has(boat)) { report.skip('plan boat', id, `boat ${boat} not here: the plan is kept without one`); fields.boatId = ''; }
    if (fields.priceCh === '') fields.priceCh = null;
    try {
      out.plans.push(applyPlanFields(blankPlan(id, str(raw.name) || 'แผนใหม่', i, here.now, null), fields, { routeKeys: here.routeKeys, boats: here.boats }));
    } catch (e) { report.skip('cost plan', id, message(e)); }
  }

  const rents = metaOf(src, 'boat_rent');
  for (const [boatId, raw] of Object.entries(isObject(rents) ? rents : {})) {
    if (!here.boats.has(boatId)) { report.skip('boat rent', boatId, 'boat not here'); continue; }
    if (!isObject(raw)) continue;
    const fields = { ...raw };
    for (const k of ['from', 'to']) if (fields[k] === '') fields[k] = null;
    try { out.rents.push(applyRentFields(blankRent(boatId, here.now, null), fields)); } catch (e) { report.skip('boat rent', boatId, message(e)); }
  }

  const venueIds = new Set<string>();
  for (const v of src.venues) {
    const id = str(v.id);
    if (!id) continue;
    try {
      out.venues.push(applyVenueFields(blankVenue(id), {
        name: str(v.name), place: v.place, price_adult: num(v.price_ad), price_child: num(v.price_ch), phone: v.phone, eta: v.eta, note: v.note, active: v.active !== false,
      }));
      venueIds.add(id);
    } catch (e) { report.skip('meal venue', id, message(e)); }
  }
  for (const r of src.routes) {
    const id = str(r.id), venue = str(r.mealvenueid);
    if (!here.routes.has(id)) { if (venue) report.skip('route venue', id, 'route not here'); continue; }
    if (venue && !venueIds.has(venue)) { report.skip('route venue', id, `venue ${venue} not in legacy's list`); continue; }
    out.routeVenues.push({ route_id: id, venue_id: venue || null });
  }

  // Trip actuals, then the pier job sheet's restaurant of the day on the same key.
  const byKey = new Map<string, TripActual>();
  const slot = (key: string, kind: string): TripActual | null => {
    const [date, boat] = key.split('::');
    if (!isDay(date ?? '') || !boat) { report.skip(kind, key, 'not a date::boat key'); return null; }
    if (!here.boats.has(boat)) { report.skip(kind, key, `boat ${boat} not here`); return null; }
    return byKey.get(key) ?? byKey.set(key, blankActual(date, boat)).get(key)!;
  };
  for (const row of src.actuals) {
    const key = str(row.key) || str(row.id);
    const v = metaJson(row.value);
    if (!isObject(v)) continue;
    const a = slot(key, 'trip actual');
    if (!a) continue;
    const m = v.meal;
    if (isObject(m) && m.amount !== null && m.amount !== undefined) {
      a.meal = {
        venue_id: str(m.venueId), venue_name: str(m.name), adults: Math.max(0, Math.round(num(m.ad))), children: Math.max(0, Math.round(num(m.chd))),
        price_adult: num(m.priceAd), price_child: num(m.priceCh), amount: num(m.amount), at: instant(m.at) ?? here.now, by: who(m.by),
      };
    }
    const note = v.mealNote;
    if (typeof note === 'string' && note.trim()) a.meal_note = { text: note.trim(), at: null, by: null };
    else if (isObject(note) && str(note.t)) a.meal_note = { text: str(note.t), at: instant(note.at), by: who(note.by) };
    if (isObject(v.mealOvn)) {
      for (const [bk, inc] of Object.entries(v.mealOvn)) {
        if (inc !== 'in' && inc !== 'out') continue;
        if (!here.bookings.has(here.prefix + bk)) { report.skip('overnight meal', `${key}/${bk}`, 'booking not imported'); continue; }
        a.meal_overnight[here.prefix + bk] = inc;
      }
    }
    if (v.ran) { a.ran = true; a.ran_at = null; a.ran_by = null; }
    const z = v.closed;
    if (isObject(z)) {
      a.closed = {
        at: instant(z.at) ?? here.now, by: who(z.by), revenue: num(z.rev), cost: num(z.cost), profit: num(z.profit), pax: Math.round(num(z.pax)),
        rows: (Array.isArray(z.rows) ? z.rows : []).filter(isObject).map((r) => ({ id: str(r.id), label: str(r.l), amount: num(r.amt), actual: !!r.real })),
      };
    }
  }
  for (const row of src.pierJobs) {
    const v = metaJson(row.value);
    const mv = isObject(v) ? str(v.mv) : '';
    if (!mv) continue;
    const a = slot(str(row.key) || str(row.id), 'day venue');
    if (!a) continue;
    if (mv === '-') { a.no_meal = true; a.venue_id = null; }
    else if (venueIds.has(mv)) a.venue_id = mv;
    else report.skip('day venue', str(row.key), `venue ${mv} not in legacy's list`);
  }
  out.actuals = [...byKey.values()].sort((x, y) => (x.service_date + x.boat_id < y.service_date + y.boat_id ? -1 : 1));
  return out;
}

/**
 * Upsert onto what is here: legacy's meal, note, overnight choices and day venue replace ours; close
 * and "ran" are legacy's only when legacy has them, so ours survive a re-run.
 */
export function mergeActual(mine: TripActual | undefined, theirs: TripActual): TripActual {
  if (!mine) return theirs;
  return {
    ...theirs,
    ran: theirs.ran || mine.ran, ran_at: theirs.ran ? theirs.ran_at : mine.ran_at, ran_by: theirs.ran ? theirs.ran_by : mine.ran_by,
    closed: theirs.closed ?? mine.closed,
  };
}
