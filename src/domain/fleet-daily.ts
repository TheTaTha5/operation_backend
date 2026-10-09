/**
 * The Daily Fleet Log (legacy `fleet_daily`, `fleet_fuelprice`, `fleet_drlock` and the `fl_*` extras
 * in `app_meta`; `05-fleet.js` `flSaveFuel`, `flSavePaxActual`, `flSaveMeter`, `flSaveFuelPrice`,
 * `flDRSetLock`, `flWater*`, `flIssue*`, `flExtra*`, `flReq*`). Pure, so both stores decide identically.
 *
 * Decision 8: the day lock is enforced. "Save day" locks a pier's day and every write to it is
 * `409 day_locked` until "Edit" unlocks it; legacy only disabled the inputs. Decision 9: the extras
 * are kept, with no 120-day deletion.
 */
import {
  addDays, assertKnown, bad, conflict, dayGap, isoDate, newFleetId, nonNegative, notFound, number, parsePier, record, required, round2, text, PIER_IDS,
} from './fleet-common.js';

export type DailyBoat = { date: string; boat_id: string; fuel_litres: number | null; pax_actual: number | null; updated_at: string; updated_by: string | null };
export type Meter = { date: string; boat_id: string; trip_type: string; engine_id: string; reading: number | null };
export type FuelPrice = { date: string; key: string; price: number };
export type DayLock = { date: string; pier: string; locked_at: string; locked_by: string | null };
export type Water = { date: string; boat_id: string; open_reading: number | null; close_reading: number | null; by: string | null; at: string };
export type IssueItem = { id: string; name: string; unit: string | null; pier: string | null; off: boolean };
export type Issue = { date: string; boat_id: string; item_id: string; qty: number };
export type Extra = { id: string; date: string; boat_id: string; name: string; qty: number | null; unit: string | null };
export type DailyRequest = {
  id: string; date: string; pier: string; name: string; pax: number | null; fuel: number | null; price: number | null; engine_hours: number | null;
  water_open: number | null; water_close: number | null; issues: Record<string, number>;
};
export type DailyRows = {
  boats: DailyBoat[]; meters: Meter[]; prices: FuelPrice[]; locks: DayLock[]; water: Water[]; issues: Issue[]; extras: Extra[]; requests: DailyRequest[];
};
export type Ctx = { now: string; today: string; by: string | null };
export type BoatPier = { id: string; pier: string | null };

/**
 * The pier a boat's row sits under in the log, and whose day lock it follows: its pier that day
 * (`fleet-assignments.ts` `dailyPier`, legacy `_drPier`), which the route resolves into `BoatPier`.
 */
export const pierOfBoat = (boats: readonly BoatPier[], boatId: string): string | null => boats.find((b) => b.id === boatId)?.pier ?? null;

/** A boat's booked passengers on a day and how they spread over routes (legacy `flBoatBookingsFor`). */
export type Booked = { pax: number; routes: Record<string, number> };
type BookedInput = { status: string; trips: readonly { service_date: string; route_id: string; pax_total: number; operations: { boat_id: string | null } }[] };
const RELEASED = ['cancelled', 'rejected', 'cancelled_weather'];
/**
 * Legacy `flBoatBookingsFor` for every boat at once: bookings not cancelled, rejected or weather-cancelled,
 * their trips that day whose dispatch boat is the boat (a split across boats is not counted, as legacy
 * reads one boat), `pax_total` (FOC and infants in).
 */
export function bookedOn(bookings: readonly BookedInput[], date: string): Map<string, Booked> {
  const out = new Map<string, Booked>();
  for (const bk of bookings) {
    if (RELEASED.includes(bk.status)) continue;
    for (const t of bk.trips) {
      if (t.service_date !== date || !t.operations.boat_id) continue;
      const b = out.get(t.operations.boat_id) ?? { pax: 0, routes: {} };
      b.pax += t.pax_total;
      b.routes[t.route_id] = (b.routes[t.route_id] ?? 0) + t.pax_total;
      out.set(t.operations.boat_id, b);
    }
  }
  return out;
}

/**
 * Legacy `flPrevMeter`: an engine's latest reading above 0 on a day before `date`, on any boat or trip
 * type (0 and below are placeholders). Null when there is none.
 */
export function prevMeters(meters: readonly Pick<Meter, 'engine_id' | 'date' | 'reading'>[]): (engineId: string, date: string) => number | null {
  const by = new Map<string, Map<string, number>>();
  for (const m of meters) {
    if (m.reading === null || m.reading <= 0) continue;
    const days = by.get(m.engine_id) ?? new Map<string, number>();
    days.set(m.date, Math.max(days.get(m.date) ?? 0, m.reading));
    by.set(m.engine_id, days);
  }
  const sorted = new Map([...by].map(([id, days]) => [id, [...days].sort((a, b) => a[0].localeCompare(b[0]))]));
  return (engineId, date) => {
    const list = sorted.get(engineId);
    if (!list) return null;
    let hit: number | null = null;
    for (const [d, v] of list) { if (d >= date) break; hit = v; }
    return hit;
  };
}

/** Legacy's one Daily Log anomaly: more than 20 litres per passenger that day. */
export const HIGH_FUEL_PER_PAX = 20;

/** `409 day_locked` while the pier's day is locked ("Save day"); "Edit" unlocks it. */
export function assertDayOpen(locks: readonly DayLock[], date: string, pier: string | null): void {
  if (pier === null) return;
  const lock = locks.find((l) => l.date === date && l.pier === pier);
  if (lock) conflict(`The ${pier} log for ${date} is saved and locked${lock.locked_by ? ` by ${lock.locked_by}` : ''}; unlock it first (POST /v1/fleet/daily-log/${date}/piers/${pier}/unlock)`, 'day_locked');
}

export function parseRange(q: Record<string, unknown>): { from: string; to: string } {
  const from = isoDate(q.from, 'from') ?? bad('from is required (YYYY-MM-DD)');
  const to = isoDate(q.to, 'to') ?? from;
  if (to < from) bad('to must not precede from');
  if (dayGap(from, to) > 92) bad('A range is at most 93 days');
  return { from, to };
}
export const parseDate = (value: string): string => isoDate(value, 'date') ?? bad('date must be YYYY-MM-DD');

// ── A boat's day: fuel, actual pax, engine meters ──

/**
 * `PATCH …/daily-log/{date}/boats/{boat_id}`. `fuel_litres` as legacy's `parseFloat(v)||null` (0 is
 * no fuel); `pax_actual` a whole number, 0 or more, null for the booked count; `meters`
 * `{trip_type: {engine_id: reading | null}}`, null clearing a reading. A meter that goes backwards
 * is not refused (legacy shows it red).
 */
export function parseBoatDay(raw: unknown): { fuel_litres?: number | null; pax_actual?: number | null; meters?: { trip_type: string; engine_id: string; reading: number | null }[] } {
  const b = Object.fromEntries(Object.entries(record(raw)).map(([k, v]) => [({ fuel: 'fuel_litres', paxActual: 'pax_actual', trips: 'meters' } as Record<string, string>)[k] ?? k, v]));
  assertKnown(b, ['fuel_litres', 'pax_actual', 'meters'], 'A boat\'s day');
  const out: ReturnType<typeof parseBoatDay> = {};
  if (b.fuel_litres !== undefined) { const f = nonNegative(b.fuel_litres, 'fuel_litres'); out.fuel_litres = f ? round2(f) : null; }
  if (b.pax_actual !== undefined) {
    const p = number(b.pax_actual, 'pax_actual');
    out.pax_actual = p === null ? null : Number.isInteger(p) ? Math.max(0, p) : bad('pax_actual must be a whole number');
  }
  if (b.meters !== undefined) {
    const m = record(b.meters, 'meters');
    out.meters = [];
    for (const [type, engines] of Object.entries(m)) {
      const e = record(engines, `meters.${type}`);
      const list = (e.engines !== undefined && Object.keys(e).length === 1 ? record(e.engines, `meters.${type}.engines`) : e);
      for (const [engine, reading] of Object.entries(list)) out.meters.push({ trip_type: type, engine_id: engine, reading: number(reading, `meters.${type}.${engine}`) });
    }
  }
  return out;
}

// ── Fuel price (legacy `flSaveFuelPrice`, `flFuelPriceEff`) ──

/** `PUT …/daily-log/{date}/fuel-prices`: `{key: price | null}` where a key is a pier or a boat; null clears it. */
export function parsePrices(raw: unknown, boatIds: ReadonlySet<string>): { key: string; price: number | null }[] {
  const b = record(raw);
  const out: { key: string; price: number | null }[] = [];
  for (const [key, value] of Object.entries(b)) {
    if (!PIER_IDS.includes(key) && !boatIds.has(key)) bad(`${key} is neither a pier (${PIER_IDS.join(', ')}) nor a boat`);
    const p = nonNegative(value, key);
    out.push({ key, price: p === null ? null : round2(p) });
  }
  if (!out.length) bad('Send at least one price: {pier or boat id: ฿/L}');
  return out;
}

export type EffectivePrice = { price: number; src: 'boat' | 'pier' | 'sib' | 'back' | ''; from: string };
/**
 * Legacy `flFuelPriceEff`: the boat's price that day, else its pier's, else another boat's at the same
 * pier, else the latest of those within 30 days before, else 0.
 */
export function effectiveFuelPrice(prices: readonly FuelPrice[], boat: BoatPier, boats: readonly BoatPier[], date: string): EffectivePrice {
  const byDate = new Map<string, Map<string, number>>();
  for (const p of prices) { const m = byDate.get(p.date) ?? new Map<string, number>(); m.set(p.key, p.price); byDate.set(p.date, m); }
  const sibling = (m: Map<string, number>): number | undefined => {
    if (!boat.pier) return undefined;
    for (const [k, v] of m) if (k !== boat.id && boats.find((b) => b.id === k)?.pier === boat.pier) return v;
    return undefined;
  };
  const day = byDate.get(date);
  if (day) {
    if (day.has(boat.id)) return { price: day.get(boat.id)!, src: 'boat', from: date };
    if (boat.pier && day.has(boat.pier)) return { price: day.get(boat.pier)!, src: 'pier', from: date };
    const s = sibling(day);
    if (s !== undefined) return { price: s, src: 'sib', from: date };
  }
  for (const k of [...byDate.keys()].filter((k) => k < date).sort().reverse()) {
    if (dayGap(k, date) > 30) break;
    const m = byDate.get(k)!;
    if (m.has(boat.id)) return { price: m.get(boat.id)!, src: 'back', from: k };
    if (boat.pier && m.has(boat.pier)) return { price: m.get(boat.pier)!, src: 'back', from: k };
    const s = sibling(m);
    if (s !== undefined) return { price: s, src: 'back', from: k };
  }
  return { price: 0, src: '', from: '' };
}

// ── Water, issued items, extra items, outside requests ──

export function parseWater(raw: unknown): { open_reading: number | null; close_reading: number | null } {
  const b = Object.fromEntries(Object.entries(record(raw)).map(([k, v]) => [({ o: 'open', c: 'close', open_reading: 'open', close_reading: 'close' } as Record<string, string>)[k] ?? k, v]));
  assertKnown(b, ['open', 'close'], 'Water meter readings');
  return { open_reading: number(b.open, 'open'), close_reading: number(b.close, 'close') };
}
export const waterUsed = (w: Pick<Water, 'open_reading' | 'close_reading'>): number | null =>
  w.open_reading === null || w.close_reading === null ? null : Math.round((w.close_reading - w.open_reading) * 10) / 10;

/** `PUT …/issues`: `{item_id: qty | null}`; each item must be in the catalogue; null clears it. */
export function parseIssues(raw: unknown, items: readonly IssueItem[]): { item_id: string; qty: number | null }[] {
  const b = record(raw);
  return Object.entries(b).map(([id, v]) => {
    if (!items.some((i) => i.id === id)) bad(`${id} is not an issue item (GET /v1/fleet/issue-items)`);
    return { item_id: id, qty: number(v, id) };
  });
}

export function planExtra(raw: unknown, date: string, boatId: string, id?: string): Extra {
  const b = Object.fromEntries(Object.entries(record(raw)).map(([k, v]) => [({ n: 'name', q: 'qty', u: 'unit' } as Record<string, string>)[k] ?? k, v]));
  assertKnown(b, ['name', 'qty', 'unit'], 'An extra item');
  return { id: id ?? newFleetId('x'), date, boat_id: boatId, name: required(b.name, 'name'), qty: number(b.qty, 'qty'), unit: text(b.unit, 'unit') };
}

export function planRequest(raw: unknown, date: string, pier: string, items: readonly IssueItem[], id?: string): DailyRequest {
  const alias: Record<string, string> = { eng: 'engine_hours', wo: 'water_open', wc: 'water_close', iss: 'issues' };
  const b = Object.fromEntries(Object.entries(record(raw)).map(([k, v]) => [alias[k] ?? k, v]));
  assertKnown(b, ['name', 'pax', 'fuel', 'price', 'engine_hours', 'water_open', 'water_close', 'issues'], 'A request');
  const issues: Record<string, number> = {};
  if (b.issues !== undefined && b.issues !== null) {
    for (const { item_id, qty } of parseIssues(b.issues, items)) if (qty !== null) issues[item_id] = qty;
  }
  return {
    id: id ?? newFleetId('rq'), date, pier, name: required(b.name, 'name', 'name is required: who drew it (ชื่อผู้เบิก)'), pax: number(b.pax, 'pax'), fuel: number(b.fuel, 'fuel'),
    price: number(b.price, 'price'), engine_hours: number(b.engine_hours, 'engine_hours'), water_open: number(b.water_open, 'water_open'),
    water_close: number(b.water_close, 'water_close'), issues,
  };
}

/** `POST /v1/fleet/issue-items` (legacy `flIssueAddItem`): a name that exists, even turned off, is turned back on. */
export function planIssueItemAdd(items: readonly IssueItem[], raw: unknown): IssueItem {
  const b = record(raw);
  assertKnown(b, ['name', 'unit', 'pier'], 'An issue item');
  const name = required(b.name, 'name');
  const unit = text(b.unit, 'unit');
  const pier = b.pier === undefined || b.pier === null || b.pier === '' ? null : parsePier(b.pier);
  const hit = items.find((i) => i.name.trim() === name);
  if (hit) return { ...hit, off: false, unit: unit ?? hit.unit, pier };
  return { id: newFleetId('it'), name, unit, pier, off: false };
}
/** `PATCH /v1/fleet/issue-items/{id}`: rename, unit, pier, or `off` (hidden, never deleted, so old counts keep their name). */
export function planIssueItemPatch(items: readonly IssueItem[], id: string, raw: unknown): IssueItem {
  const item = items.find((i) => i.id === id) ?? notFound(`Issue item ${id} not found`);
  const b = record(raw);
  assertKnown(b, ['name', 'unit', 'pier', 'off'], 'An issue item');
  const next = { ...item };
  if (b.name !== undefined) next.name = required(b.name, 'name');
  if (b.unit !== undefined) next.unit = text(b.unit, 'unit');
  if (b.pier !== undefined) next.pier = b.pier === null || b.pier === '' ? null : parsePier(b.pier);
  if (b.off !== undefined) { if (typeof b.off !== 'boolean') bad('off must be true or false'); next.off = b.off as boolean; }
  return next;
}

// ── The read ──

/** What the read needs beyond the rows: each boat's pier that day, its booked pax, the engines' earlier meters. */
export type DailyContext = {
  pierOn: (boatId: string, date: string) => string | null;
  booked: (date: string) => ReadonlyMap<string, Booked>;
  prevMeter: (engineId: string, date: string) => number | null;
};
const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * `GET /v1/fleet/daily-log?from=&to=`: each day's boats, prices, locks and requests, with what the screen
 * computes. A boat's `pier` is its pier that day (its day lock); its `fuel_price` reads its home pier.
 * The flags are legacy `flRenderDR`'s: `high_fuel_per_pax` (the one anomaly it counts), a meter below
 * the engine's previous reading, a water meter that ran backwards, fuel with no price that day.
 */
export function dailyLogView(range: { from: string; to: string }, rows: DailyRows, allPrices: readonly FuelPrice[], boats: readonly BoatPier[], issueItems: readonly IssueItem[], ctx: DailyContext) {
  const days: unknown[] = [];
  for (let date = range.from; date <= range.to; date = addDays(date, 1)) {
    const ids = new Set<string>();
    for (const r of [...rows.boats, ...rows.meters, ...rows.water, ...rows.issues, ...rows.extras]) if (r.date === date) ids.add(r.boat_id);
    const booked = ctx.booked(date);
    const dayPrices = new Map(rows.prices.filter((p) => p.date === date).map((p) => [p.key, p.price]));
    const anomalies: { boat_id: string; litres_per_pax: number }[] = [];
    const boatsOfDay = [...ids].sort().map((boat_id) => {
      const d = rows.boats.find((r) => r.date === date && r.boat_id === boat_id);
      const meters: Record<string, Record<string, number | null>> = {};
      const deltas: Record<string, Record<string, number | null>> = {};
      for (const m of rows.meters.filter((r) => r.date === date && r.boat_id === boat_id)) {
        (meters[m.trip_type] ??= {})[m.engine_id] = m.reading;
        const prev = m.reading === null ? null : ctx.prevMeter(m.engine_id, date);
        (deltas[m.trip_type] ??= {})[m.engine_id] = m.reading === null || prev === null ? null : round1(m.reading - prev);
      }
      const w = rows.water.find((r) => r.date === date && r.boat_id === boat_id);
      const issues = Object.fromEntries(rows.issues.filter((r) => r.date === date && r.boat_id === boat_id).map((r) => [r.item_id, r.qty]));
      const boat = boats.find((b) => b.id === boat_id) ?? { id: boat_id, pier: null };
      const fuel = d?.fuel_litres ?? null;
      const paxBooked = booked.get(boat_id)?.pax ?? 0;
      const pax = d?.pax_actual ?? paxBooked;
      const lpp = fuel && pax > 0 ? round1(fuel / pax) : null;
      const used = w ? waterUsed(w) : null;
      const flags: string[] = [];
      if (fuel && pax > 0 && fuel / pax > HIGH_FUEL_PER_PAX) { flags.push('high_fuel_per_pax'); anomalies.push({ boat_id, litres_per_pax: lpp! }); }
      if (Object.values(deltas).some((e) => Object.values(e).some((x) => x !== null && x < 0))) flags.push('meter_backwards');
      if (used !== null && used < 0) flags.push('water_negative');
      if (fuel && !dayPrices.has(boat_id) && !(boat.pier && dayPrices.has(boat.pier))) flags.push('price_missing');
      return {
        boat_id, pier: ctx.pierOn(boat_id, date) ?? boat.pier, fuel_litres: fuel, pax_actual: d?.pax_actual ?? null, pax_booked: paxBooked, pax, litres_per_pax: lpp,
        meters, meter_deltas: deltas,
        water: w ? { open: w.open_reading, close: w.close_reading, used, by: w.by, at: w.at } : null,
        issues, extras: rows.extras.filter((r) => r.date === date && r.boat_id === boat_id).map(({ date: _d, boat_id: _b, ...x }) => x),
        fuel_price: effectiveFuelPrice(allPrices, boat, boats, date), flags,
      };
    });
    const prices = Object.fromEntries([...dayPrices].sort((a, b) => a[0].localeCompare(b[0])));
    const locks = Object.fromEntries(rows.locks.filter((l) => l.date === date).sort((a, b) => a.pier.localeCompare(b.pier))
      .map((l) => [l.pier, { locked_at: l.locked_at, locked_by: l.locked_by }]));
    const requests: Record<string, unknown[]> = {};
    for (const r of rows.requests.filter((x) => x.date === date)) (requests[r.pier] ??= []).push((({ date: _d, pier: _p, ...x }) => x)(r));
    if (boatsOfDay.length || Object.keys(prices).length || Object.keys(locks).length || Object.keys(requests).length) {
      // The footer's sums (legacy): fuel of the boats logged, pax of every boat logged or booked that day.
      const totalFuel = round2(boatsOfDay.reduce((s, b) => s + (b.fuel_litres ?? 0), 0));
      const totalPax = boatsOfDay.reduce((s, b) => s + b.pax, 0) + [...booked].filter(([id]) => !ids.has(id)).reduce((s, [, x]) => s + x.pax, 0);
      days.push({
        date, boats: boatsOfDay, fuel_prices: prices, locks, requests,
        totals: { fuel: totalFuel, pax: totalPax, litres_per_pax: totalPax > 0 ? round2(totalFuel / totalPax) : null }, anomalies,
      });
    }
  }
  return { from: range.from, to: range.to, days, issue_items: issueItems };
}
