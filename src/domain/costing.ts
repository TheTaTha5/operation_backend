/**
 * The cost model (todo/money-model.md, "Design: the rest of Money", decided 2026-10-10): legacy's
 * costing menu (`08-app.js` `ct*`, `CT_DEFAULT`, `ctCalc`, `ctBreakEven`, `ctRentOf`, `mv*`).
 *
 * Three layers, as legacy: the template (every cost line with its default prices), plans (a route's
 * design sheet with per-line overrides), and rented boats (a contract per boat). `calc` prices one
 * trip from them; Trip P&L (`trip-pl.ts`) feeds it the day's real heads and then replaces lines with
 * what was actually spent. The maths is legacy's, line for line, so the numbers match. Pure, so both
 * stores decide identically.
 */
import { assertKnown, bad, bool, isoDate, nonNegative, number, record, round2, text } from './fleet-common.js';

// ── Shapes ───────────────────────────────────────────────────────────────────────────────────────

export type PartKind = 'fix' | 'var' | 'step';
/**
 * One part of a cost line (legacy `{k, q, q4, u, u4, uTH, uCh, uChTH, fuel, per, mode, every, min, over, add}`).
 * - `fix`: qty × unit (× boats when `per` is `boat`); a `fuel` part's unit is the fuel price.
 * - `var`: per head, four unit prices (adult/child × foreign/Thai), each falling back to a wider one;
 *   a `fuel` part is qty litres × the fuel price × heads.
 * - `step`: `every` N heads one more (at least `min`), or `over` X heads `add` more; × unit.
 */
export type CostPart = {
  kind: PartKind; per?: 'boat'; qty?: number; qty_4en?: number; unit?: number; unit_4en?: number; unit_th?: number; unit_ch?: number; unit_ch_th?: number;
  fuel?: boolean; mode?: 'every' | 'over'; every?: number; min?: number; over?: number; add?: number;
};
export type PartOverride = Partial<Omit<CostPart, 'kind'>>;
export type CostLine = { id: string; group: string; label: string; vat: boolean; parts: CostPart[]; on_demand: boolean; on_demand_qty: number | null };
export type CostTemplate = { vat_rate: number; lines: CostLine[] };
export type StoredTemplate = CostTemplate & { updated_at: string; updated_by: string | null };

export type LineOverride = { off?: boolean; parts?: (PartOverride | null)[] };
export type GroupSetting = { off?: boolean; pct?: number };
export type OnDemand = { agent_qty?: number; agent_rev?: number; upsell_qty?: number; upsell_rev?: number };
export type Engines = '3EN' | '4EN';
export type CostPlan = {
  id: string; sort: number; name: string; route_key: string | null; note: string | null;
  engines: Engines; boats: number; capacity: number; pax: number; pax_th: number; price: number; price_child: number | null;
  child_pct: number; commission_pct: number; fuel_price: number; boat_id: string | null; rent_off: boolean;
  overrides: Record<string, LineOverride>; groups: Record<string, GroupSetting>; on_demand: Record<string, OnDemand>;
  itinerary: unknown[]; tiers: unknown[]; updated_at: string; updated_by: string | null;
};
export type BoatRent = {
  boat_id: string; rented: boolean; mode: 'lump' | 'seat'; amount: number; per_seat: number; days: number; days_off: number; trips_per_day: number;
  vat: boolean; note: string | null; from: string | null; to: string | null; fuel_pct: number | null; owner_pays: string[];
  updated_at: string; updated_by: string | null;
};
export type MealVenue = {
  id: string; name: string; place: string | null; price_adult: number; price_child: number; phone: string | null; eta: string | null; note: string | null; active: boolean;
};

// ── Legacy's default template (`CT_DEFAULT`, with `CT_OD_SEED` applied) ──────────────────────────

const L = (id: string, group: string, label: string, vat: boolean, parts: CostPart[], od: number | null = null): CostLine =>
  ({ id, group, label, vat, parts, on_demand: od !== null, on_demand_qty: od });
export const DEFAULT_TEMPLATE: CostTemplate = {
  vat_rate: 7,
  lines: [
    L('park', 'ค่าธรรมเนียมอุทยานแห่งชาติ', 'ค่าเข้าอุทยาน', false, [{ kind: 'var', unit: 500, unit_th: 100 }]),
    L('meal', 'ค่าอาหารและเครื่องดื่ม', 'ค่าอาหารบนเกาะ', false, [{ kind: 'var', unit: 280 }]),
    L('meal2', 'ค่าอาหารและเครื่องดื่ม', 'อาหารเช้า / เย็น', false, [{ kind: 'var', unit: 100 }]),
    L('ob', 'ค่าอาหารและเครื่องดื่ม', 'ของบนเรือ', true, [{ kind: 'var', unit: 31 }]),
    L('snk', 'ค่าอาหารและเครื่องดื่ม', 'ขนมเปี๊ยะ', false, [{ kind: 'var', unit: 19 }]),
    L('fuel', 'ค่าเชื้อเพลิง', 'น้ำมันเรือ', true, [{ kind: 'fix', per: 'boat', qty: 360, qty_4en: 520, fuel: true }, { kind: 'var', qty: 0.4, fuel: true }]),
    L('guide', 'ค่าตอบแทนลูกเรือและไกด์', 'ไกด์', false, [{ kind: 'step', mode: 'every', every: 25, min: 1, unit: 1500 }]),
    L('cap', 'ค่าตอบแทนลูกเรือและไกด์', 'กัปตัน', false, [{ kind: 'fix', per: 'boat', qty: 1, unit: 900 }]),
    L('crew', 'ค่าตอบแทนลูกเรือและไกด์', 'เด็กเรือ', false, [{ kind: 'fix', per: 'boat', qty: 2, qty_4en: 3, unit: 500 }, { kind: 'step', mode: 'over', over: 40, add: 1, unit: 500 }]),
    L('pier', 'ค่าธรรมเนียมท่าเทียบเรือ', 'ค่าเรือเทียบท่า', true, [{ kind: 'fix', per: 'boat', qty: 1, unit: 400 }]),
    L('dep', 'ค่าใช้จ่ายดำเนินงานอื่น', 'ค่าเสื่อมเรือ', false, [{ kind: 'fix', per: 'boat', qty: 1, unit: 3000, unit_4en: 5000 }]),
    L('con', 'ค่าใช้จ่ายดำเนินงานอื่น', 'วัสดุสิ้นเปลือง', true, [{ kind: 'var', unit: 15 }]),
    L('ins', 'ค่าใช้จ่ายดำเนินงานอื่น', 'ประกันอุบัติเหตุลูกค้า', false, [{ kind: 'var', unit: 15 }]),
    L('gear', 'ค่าใช้จ่ายดำเนินงานอื่น', 'มาส์ก + ตีนกบ', true, [{ kind: 'var', unit: 10 }]),
    L('med', 'ค่าใช้จ่ายดำเนินงานอื่น', 'ยาเมาเรือ + เสื้อกันฝน', true, [{ kind: 'var', unit: 15 }]),
    L('van', 'ค่ารถรับส่ง', 'รถรับส่งโรงแรม', false, [{ kind: 'var', unit: 130 }], 100),
    L('ltj', 'ค่าเรือหางยาว', 'หางยาว · จอย (ต่อหัว)', false, [{ kind: 'var', unit: 0 }], 0),
    L('ltc', 'ค่าเรือหางยาว', 'หางยาว · เหมา (ต่อลำ)', false, [{ kind: 'fix', qty: 0, unit: 600 }], 0),
  ],
};
/** Legacy `CT_OD_SEED`: the lines priced per item ordered, and their default quantity. */
const OD_SEED: Record<string, number> = { van: 100, ltj: 0, ltc: 0 };
/** Legacy `CT_RENT_EX`: the lines a rented boat's owner pays by default. */
export const OWNER_PAYS_DEFAULT = ['dep', 'cap', 'crew'];

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/**
 * Legacy `ctTpl` + `ctTplFill` + `ctTplOdSeed`: the stored template, with every default line it lacks
 * added back unless it was deleted (`dropped`), and the on-demand seed on van and longtails. With
 * nothing stored, the default.
 */
export function effectiveTemplate(stored: CostTemplate | null, dropped: readonly string[] = []): CostTemplate {
  if (!stored || !stored.lines.length) return clone(DEFAULT_TEMPLATE);
  const t = clone({ vat_rate: stored.vat_rate, lines: stored.lines });
  const have = new Set(t.lines.map((l) => l.id));
  for (const d of DEFAULT_TEMPLATE.lines) if (!have.has(d.id) && !dropped.includes(d.id)) t.lines.push(clone(d));
  for (const l of t.lines) {
    if (!(l.id in OD_SEED)) continue;
    l.on_demand = true;
    if (l.on_demand_qty === null) l.on_demand_qty = OD_SEED[l.id];
  }
  return t;
}
/** The default lines a stored template does not carry: deleted on purpose (legacy `t.dropped`). */
export const droppedOf = (lines: readonly Pick<CostLine, 'id'>[]): string[] => DEFAULT_TEMPLATE.lines.map((l) => l.id).filter((id) => !lines.some((l) => l.id === id));

export const templateView = (stored: StoredTemplate | null) => {
  const dropped = stored ? droppedOf(stored.lines) : [];
  return { ...effectiveTemplate(stored, dropped), dropped, saved: !!stored, updated_at: stored?.updated_at ?? null, updated_by: stored?.updated_by ?? null };
};

// ── Parsing (legacy's short keys accepted) ───────────────────────────────────────────────────────

const PART_ALIASES: Record<string, string> = { k: 'kind', q: 'qty', q4: 'qty_4en', u: 'unit', u4: 'unit_4en', uTH: 'unit_th', uCh: 'unit_ch', uChTH: 'unit_ch_th' };
const PART_NUMBERS = ['qty', 'qty_4en', 'unit', 'unit_4en', 'unit_th', 'unit_ch', 'unit_ch_th', 'every', 'min', 'over', 'add'] as const;
const PART_KEYS = ['kind', 'per', 'fuel', 'mode', ...PART_NUMBERS];
const aliased = (raw: Record<string, unknown>, aliases: Record<string, string>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) out[aliases[k] ?? k] = v;
  return out;
};
/** A part's optional fields: a number, a flag; `''` or null is "not set" (legacy's empty input). */
function partFields(b: Record<string, unknown>, at: string): PartOverride {
  const out: PartOverride = {};
  for (const k of PART_NUMBERS) {
    const n = number(b[k], `${at}.${k}`);
    if (n !== null) out[k] = n;
  }
  if (b.per !== undefined && b.per !== null && b.per !== '') { if (b.per !== 'boat') bad(`${at}.per must be boat (or left out: per trip)`); out.per = 'boat'; }
  if (b.mode !== undefined && b.mode !== null && b.mode !== '') { if (b.mode !== 'every' && b.mode !== 'over') bad(`${at}.mode must be every or over`); out.mode = b.mode as 'every' | 'over'; }
  if (b.fuel !== undefined && b.fuel !== null && b.fuel !== '') {
    const f = b.fuel === 1 ? true : b.fuel === 0 ? false : bool(b.fuel, `${at}.fuel`);
    if (f) out.fuel = true;
  }
  return out;
}
export function parsePart(raw: unknown, at: string): CostPart {
  const b = aliased(record(raw, at), PART_ALIASES);
  assertKnown(b, PART_KEYS, at);
  const kind = b.kind === 'fix' || b.kind === 'var' || b.kind === 'step' ? b.kind : bad(`${at}.kind must be fix, var or step`);
  const fields = partFields(b, at);
  if (kind === 'step' && fields.fuel) bad(`${at}: a step part cannot be fuel`);
  return { kind, ...fields };
}
function parseLine(raw: unknown, at: string): CostLine {
  const b = aliased(record(raw, at), { g: 'group', l: 'label', od: 'on_demand', odQ: 'on_demand_qty' });
  assertKnown(b, ['id', 'group', 'label', 'vat', 'parts', 'on_demand', 'on_demand_qty'], at);
  const id = text(b.id, `${at}.id`) ?? bad(`${at}.id is required`);
  if (!Array.isArray(b.parts) || !b.parts.length) bad(`${at}.parts must list at least one part`);
  const flag = (v: unknown, name: string): boolean => (v === 1 ? true : v === 0 ? false : bool(v, name) ?? false);
  const od = flag(b.on_demand, `${at}.on_demand`);
  return {
    id, group: text(b.group, `${at}.group`) ?? 'อื่นๆ', label: typeof b.label === 'string' ? b.label : bad(`${at}.label is required`),
    vat: flag(b.vat, `${at}.vat`), parts: (b.parts as unknown[]).map((p, i) => parsePart(p, `${at}.parts[${i}]`)),
    on_demand: od, on_demand_qty: od ? nonNegative(b.on_demand_qty, `${at}.on_demand_qty`) : null,
  };
}
/** `PUT /v1/costing/template`: the whole template (legacy `ctTplSave`). */
export function parseTemplate(raw: unknown): CostTemplate {
  const b = aliased(record(raw), { vatRate: 'vat_rate' });
  assertKnown(b, ['vat_rate', 'lines', 'dropped', 'saved', 'updated_at', 'updated_by'], 'The cost template');
  const vat = nonNegative(b.vat_rate, 'vat_rate') ?? bad('vat_rate is required (legacy 7)');
  if (!Array.isArray(b.lines) || !b.lines.length) bad('lines must list at least one cost line');
  const lines = (b.lines as unknown[]).map((l, i) => parseLine(l, `lines[${i}]`));
  const dup = lines.find((l, i) => lines.findIndex((x) => x.id === l.id) !== i);
  if (dup) bad(`lines: id ${dup.id} is used twice`);
  return { vat_rate: vat, lines };
}

function parseOverrides(raw: unknown): Record<string, LineOverride> {
  const out: Record<string, LineOverride> = {};
  for (const [id, v] of Object.entries(record(raw, 'overrides'))) {
    if (v === null) continue;
    const o = aliased(record(v, `overrides.${id}`), { p: 'parts' });
    assertKnown(o, ['off', 'parts'], `overrides.${id}`);
    const x: LineOverride = {};
    if (o.off === 1 || o.off === true) x.off = true; else if (o.off !== undefined && o.off !== 0 && o.off !== false && o.off !== null) bad(`overrides.${id}.off must be true or false`);
    if (o.parts !== undefined && o.parts !== null) {
      if (!Array.isArray(o.parts)) bad(`overrides.${id}.parts must be a list`);
      const parts = (o.parts as unknown[]).map((p, i) => {
        if (p === null || p === undefined) return null;
        const at = `overrides.${id}.parts[${i}]`;
        const pb = aliased(record(p, at), PART_ALIASES);
        assertKnown(pb, PART_KEYS.filter((k) => k !== 'kind'), at);
        const f = partFields(pb, at);
        return Object.keys(f).length ? f : null;
      });
      if (parts.some((p) => p !== null)) x.parts = parts;
    }
    out[id] = x;
  }
  return out;
}
function parseGroups(raw: unknown): Record<string, GroupSetting> {
  const out: Record<string, GroupSetting> = {};
  for (const [g, v] of Object.entries(record(raw, 'groups'))) {
    if (v === null) continue;
    const o = record(v, `groups.${g}`);
    assertKnown(o, ['off', 'pct'], `groups.${g}`);
    const x: GroupSetting = {};
    if (o.off === 1 || o.off === true) x.off = true;
    const pct = number(o.pct, `groups.${g}.pct`);
    if (pct !== null && pct !== 0) x.pct = pct;
    out[g] = x;
  }
  return out;
}
function parseOnDemand(raw: unknown): Record<string, OnDemand> {
  const out: Record<string, OnDemand> = {};
  for (const [id, v] of Object.entries(record(raw, 'on_demand'))) {
    if (v === null) continue;
    const o = aliased(record(v, `on_demand.${id}`), { aQ: 'agent_qty', aR: 'agent_rev', uQ: 'upsell_qty', uR: 'upsell_rev' });
    assertKnown(o, ['agent_qty', 'agent_rev', 'upsell_qty', 'upsell_rev'], `on_demand.${id}`);
    const x: OnDemand = {};
    for (const k of ['agent_qty', 'agent_rev', 'upsell_qty', 'upsell_rev'] as const) { const n = nonNegative(o[k], `on_demand.${id}.${k}`); if (n !== null) x[k] = n; }
    out[id] = x;
  }
  return out;
}
const list = (v: unknown, name: string): unknown[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : bad(`${name} must be a list`));

/** Legacy `ctBlankPlan`. */
export const blankPlan = (id: string, name: string, sort: number, now: string, by: string | null): CostPlan => ({
  id, sort, name, route_key: null, note: null, engines: '3EN', boats: 1, capacity: 65, pax: 20, pax_th: 0, price: 2500, price_child: null,
  child_pct: 0, commission_pct: 0, fuel_price: 45, boat_id: null, rent_off: false, overrides: {}, groups: {}, on_demand: {}, itinerary: [], tiers: [],
  updated_at: now, updated_by: by,
});
const PLAN_ALIASES: Record<string, string> = {
  famId: 'route_key', eng: 'engines', cap: 'capacity', paxTH: 'pax_th', priceCh: 'price_child', chPct: 'child_pct', comm: 'commission_pct', fuel: 'fuel_price',
  boatId: 'boat_id', rentOff: 'rent_off', ovr: 'overrides', grp: 'groups', od: 'on_demand', itin: 'itinerary',
};
const PLAN_COMPUTED: Record<string, string> = { seats: 'it is the pinned boat\'s seats, else capacity', calc: 'it is worked out from the template', break_even: 'it is worked out from the template' };
const PLAN_FIELDS = ['name', 'route_key', 'note', 'engines', 'boats', 'capacity', 'pax', 'pax_th', 'price', 'price_child', 'child_pct', 'commission_pct', 'fuel_price',
  'boat_id', 'rent_off', 'overrides', 'groups', 'on_demand', 'itinerary', 'tiers'];

/**
 * A plan's fields (`POST` / `PATCH /v1/costing/plans`): every one a client fact. `route_key` must be
 * a route or a route family, `boat_id` a boat; a computed field sent is `400` naming why.
 */
export function applyPlanFields(plan: CostPlan, raw: unknown, ctx: { routeKeys: ReadonlySet<string>; boats: ReadonlySet<string> }): CostPlan {
  const b = aliased(record(raw), PLAN_ALIASES);
  for (const [k, why] of Object.entries(PLAN_COMPUTED)) if (b[k] !== undefined) bad(`${k} is the server's: ${why}`);
  assertKnown(b, [...PLAN_FIELDS, 'id', 'sort', 'updated_at', 'updated_by'], 'A cost plan');
  if (b.id !== undefined && b.id !== plan.id) bad('id cannot change');
  const p = { ...plan };
  const whole = (k: string, min: number) => { const n = number(b[k], k); if (n === null) return bad(`${k} is required`); if (!Number.isInteger(n) || n < min) bad(`${k} must be a whole number, ${min} or more`); return n; };
  const money = (k: string, max?: number) => { const n = nonNegative(b[k], k) ?? 0; if (max !== undefined && n > max) bad(`${k} must be ${max} or less`); return round2(n); };
  if (b.name !== undefined) p.name = text(b.name, 'name') ?? bad('name is required');
  if (b.route_key !== undefined) {
    const k = text(b.route_key, 'route_key');
    if (k !== null && !ctx.routeKeys.has(k)) bad(`route_key ${k} is neither a route nor a route family`);
    p.route_key = k;
  }
  if (b.note !== undefined) p.note = text(b.note, 'note');
  if (b.engines !== undefined) p.engines = b.engines === '3EN' || b.engines === '4EN' ? b.engines : bad('engines must be 3EN or 4EN');
  if (b.boats !== undefined) p.boats = whole('boats', 1);
  if (b.capacity !== undefined) p.capacity = whole('capacity', 1);
  if (b.pax !== undefined) p.pax = whole('pax', 0);
  if (b.pax_th !== undefined) p.pax_th = whole('pax_th', 0);
  if (b.price !== undefined) p.price = money('price');
  if (b.price_child !== undefined) p.price_child = b.price_child === null || b.price_child === '' ? null : money('price_child');
  if (b.child_pct !== undefined) p.child_pct = money('child_pct', 100);
  if (b.commission_pct !== undefined) p.commission_pct = money('commission_pct', 100);
  if (b.fuel_price !== undefined) p.fuel_price = money('fuel_price');
  if (b.boat_id !== undefined) {
    const id = text(b.boat_id, 'boat_id');
    if (id !== null && !ctx.boats.has(id)) bad(`boat_id ${id} is not a boat`);
    p.boat_id = id;
  }
  if (b.rent_off !== undefined) p.rent_off = b.rent_off === 1 || b.rent_off === true ? true : b.rent_off === 0 || b.rent_off === false || b.rent_off === null ? false : bad('rent_off must be true or false');
  if (b.overrides !== undefined) p.overrides = b.overrides === null ? {} : parseOverrides(b.overrides);
  if (b.groups !== undefined) p.groups = b.groups === null ? {} : parseGroups(b.groups);
  if (b.on_demand !== undefined) p.on_demand = b.on_demand === null ? {} : parseOnDemand(b.on_demand);
  if (b.itinerary !== undefined) p.itinerary = list(b.itinerary, 'itinerary');
  if (b.tiers !== undefined) p.tiers = list(b.tiers, 'tiers');
  return p;
}

// ── Rented boats (legacy `boat_rent`, `ctRentOf`, `ctRentActiveOn`, `ctBoatFuelMul`) ─────────────

/** Legacy `ctRentBlank` with §rentZero: a record made by editing another field is not a rented boat. */
export const blankRent = (boatId: string, now: string, by: string | null): BoatRent => ({
  boat_id: boatId, rented: false, mode: 'lump', amount: 0, per_seat: 0, days: 30, days_off: 2, trips_per_day: 1, vat: false, note: null,
  from: null, to: null, fuel_pct: null, owner_pays: [...OWNER_PAYS_DEFAULT], updated_at: now, updated_by: by,
});
const RENT_ALIASES: Record<string, string> = { on: 'rented', amt: 'amount', seat: 'per_seat', off: 'days_off', trips: 'trips_per_day', fuelMul: 'fuel_pct', ex: 'owner_pays' };
const RENT_COMPUTED = ['seats', 'total', 'run_days', 'per_day', 'per_trip', 'per_calendar_day'];
/** `PUT /v1/costing/boat-rents/{boat_id}`: the fields sent replace the stored ones (legacy `ctRentSet`). */
export function applyRentFields(rent: BoatRent, raw: unknown): BoatRent {
  const b = aliased(record(raw), RENT_ALIASES);
  const sent = RENT_COMPUTED.find((k) => b[k] !== undefined);
  if (sent) bad(`${sent} is the server's: it is worked out from the rent and the boat's seats`);
  assertKnown(b, ['rented', 'mode', 'amount', 'per_seat', 'days', 'days_off', 'trips_per_day', 'vat', 'note', 'from', 'to', 'fuel_pct', 'owner_pays', 'boat_id', 'updated_at', 'updated_by'], 'A boat rent');
  if (b.boat_id !== undefined && b.boat_id !== rent.boat_id) bad('boat_id is the path\'s');
  const r = { ...rent, owner_pays: [...rent.owner_pays] };
  const flag = (v: unknown, name: string): boolean => (v === 1 ? true : v === 0 ? false : bool(v, name) ?? false);
  const whole = (k: string, min: number) => { const n = number(b[k], k); if (n === null || !Number.isInteger(n) || n < min) bad(`${k} must be a whole number, ${min} or more`); return n as number; };
  if (b.rented !== undefined) r.rented = flag(b.rented, 'rented');
  if (b.mode !== undefined) r.mode = b.mode === 'lump' || b.mode === 'seat' ? b.mode : bad('mode must be lump (a monthly amount) or seat (per seat)');
  if (b.amount !== undefined) r.amount = round2(nonNegative(b.amount, 'amount') ?? 0);
  if (b.per_seat !== undefined) r.per_seat = round2(nonNegative(b.per_seat, 'per_seat') ?? 0);
  if (b.days !== undefined) r.days = whole('days', 1);
  if (b.days_off !== undefined) r.days_off = whole('days_off', 0);
  if (b.trips_per_day !== undefined) r.trips_per_day = whole('trips_per_day', 1);
  if (b.vat !== undefined) r.vat = flag(b.vat, 'vat');
  if (b.note !== undefined) r.note = text(b.note, 'note');
  if (b.from !== undefined) r.from = isoDate(b.from, 'from');
  if (b.to !== undefined) r.to = isoDate(b.to, 'to');
  if (r.from && r.to && r.to < r.from) bad('to must not precede from');
  if (b.fuel_pct !== undefined) { const f = number(b.fuel_pct, 'fuel_pct'); r.fuel_pct = f === null || f === 100 ? null : f > 0 ? round2(f) : bad('fuel_pct must be more than 0 (100 = as the template)'); }
  if (b.owner_pays !== undefined) {
    if (Array.isArray(b.owner_pays)) r.owner_pays = (b.owner_pays as unknown[]).map((x, i) => (typeof x === 'string' && x ? x : bad(`owner_pays[${i}] must be a line id`)));
    else r.owner_pays = Object.entries(record(b.owner_pays, 'owner_pays')).filter(([, v]) => v === 1 || v === true).map(([k]) => k);
  }
  return r;
}
export type RentCalc = {
  boat_id: string; name: string; seats: number; mode: 'lump' | 'seat'; total: number; days: number; days_off: number; run_days: number; trips_per_day: number;
  per_day: number; per_trip: number; per_calendar_day: number; vat: boolean; from: string | null; to: string | null; owner_pays: string[];
};
/** Legacy `_ctRentOfCalc`: null unless the boat is rented; the rent divided down to a trip. */
export function rentCalc(r: BoatRent | undefined, boat: { name: string; capacity: number } | undefined): RentCalc | null {
  if (!r || !r.rented) return null;
  const seats = Math.max(0, boat?.capacity ?? 0);
  const total = r.mode === 'seat' ? r.per_seat * seats : r.amount;
  const days = Math.max(1, r.days || 30);
  const off = Math.min(days - 1, Math.max(0, r.days_off));
  const run = days - off, trips = Math.max(1, r.trips_per_day || 1), perDay = total / run;
  return {
    boat_id: r.boat_id, name: boat?.name ?? r.boat_id, seats, mode: r.mode, total, days, days_off: off, run_days: run, trips_per_day: trips,
    per_day: perDay, per_trip: perDay / trips, per_calendar_day: total / days, vat: r.vat, from: r.from, to: r.to, owner_pays: [...r.owner_pays],
  };
}
/** Legacy `ctRentActiveOn`: inside the contract dates (either may be open); no date = a design sheet, always. */
export const rentActiveOn = (r: Pick<RentCalc, 'from' | 'to'>, date: string | null): boolean =>
  !date || ((!r.from || date >= r.from) && (!r.to || date <= r.to));
/** Legacy `ctBoatFuelMul`: the boat's fuel factor, rented or not. */
export const fuelFactor = (r: BoatRent | undefined): number => (r && r.fuel_pct && r.fuel_pct > 0 ? r.fuel_pct / 100 : 1);
export const rentView = (r: BoatRent, boat: { name: string; capacity: number } | undefined) => {
  const c = rentCalc({ ...r, rented: true }, boat);
  return { ...r, seats: c!.seats, total: round2(c!.total), run_days: c!.run_days, per_day: round2(c!.per_day), per_trip: round2(c!.per_trip), per_calendar_day: round2(c!.per_calendar_day) };
};

// ── Meal venues (legacy `MEAL_VENUES`, `mvAdd`, `mvSet`, `mvToggle`) ──────────────────────────────

const VENUE_ALIASES: Record<string, string> = { priceAd: 'price_adult', priceCh: 'price_child', price_ad: 'price_adult', price_ch: 'price_child' };
/** A new venue: legacy's `mvAdd` defaults (฿280 adult, ฿180 child), any field sent replacing them. */
export function applyVenueFields(v: MealVenue, raw: unknown): MealVenue {
  const b = aliased(record(raw), VENUE_ALIASES);
  assertKnown(b, ['id', 'name', 'place', 'price_adult', 'price_child', 'phone', 'eta', 'note', 'active', 'sort'], 'A meal venue');
  if (b.id !== undefined && b.id !== v.id) bad('id cannot change');
  const out = { ...v };
  // Legacy `mvSet`: text is cut to 80 characters.
  const short = (k: string): string | null => { const t = text(b[k], k); return t === null ? null : t.slice(0, 80); };
  if (b.name !== undefined) out.name = short('name') ?? '';
  for (const k of ['place', 'phone', 'eta', 'note'] as const) if (b[k] !== undefined) out[k] = short(k);
  if (b.price_adult !== undefined) out.price_adult = round2(nonNegative(b.price_adult, 'price_adult') ?? 0);
  if (b.price_child !== undefined) out.price_child = round2(nonNegative(b.price_child, 'price_child') ?? 0);
  if (b.active !== undefined) out.active = bool(b.active, 'active') ?? true;
  return out;
}
export const blankVenue = (id: string): MealVenue => ({ id, name: '', place: null, price_adult: 280, price_child: 180, phone: null, eta: null, note: null, active: true });
/** Legacy `mvCost`: adults and children at the venue's prices; no venue, no amount. */
export const mealCost = (v: Pick<MealVenue, 'price_adult' | 'price_child'> | null, adults: number, children: number): number | null =>
  (v ? v.price_adult * adults + v.price_child * children : null);

// ── Pricing a trip (legacy `ctCalc`) ─────────────────────────────────────────────────────────────

/** What a plan contributes to pricing; Trip P&L passes a plan's overrides with the day's own figures. */
export type PlanLike = Pick<CostPlan, 'overrides' | 'groups' | 'on_demand' | 'price' | 'price_child' | 'commission_pct' | 'child_pct' | 'pax_th' | 'engines' | 'boats' | 'fuel_price' | 'boat_id' | 'rent_off'>;
/**
 * Legacy's `ctx`: engines, boats, ฿/L, the boat (for its rent and fuel factor), the day (for the
 * contract dates; null on a design sheet), heads (Thai and children), and what was ordered of the
 * on-demand lines (`od_qty`, Trip P&L's real longtails).
 */
export type CalcCtx = {
  eng: Engines; boats: number; fuel: number; boat_id: string | null; date: string | null; own_calc?: boolean;
  pax: number; pax_th: number; pax_ch: number; pax_ch_th?: number; od_qty?: Record<string, number>;
};
export type CostRow = { id: string; group: string; label: string; vat: boolean; amount: number; vat_amount: number; net: number; fixed: number; variable: number };
export type Calc = { gross: number; vat_in: number; net: number; fixed_net: number; var_net: number; rows: CostRow[]; rent: RentCalc | null };
/** Rented boats by id (`rentCalc`), and every boat's fuel factor. */
export type RentBook = { rent(boatId: string | null): RentCalc | null; fuel(boatId: string | null): number };
export const rentBook = (rents: readonly BoatRent[], boats: readonly { id: string; name: string; capacity: number }[]): RentBook => {
  const byId = new Map(rents.map((r) => [r.boat_id, r])), boat = new Map(boats.map((b) => [b.id, b]));
  return {
    rent: (id) => (id ? rentCalc(byId.get(id), boat.get(id)) : null),
    fuel: (id) => (id ? fuelFactor(byId.get(id)) : 1),
  };
};

/** Legacy `ctVatR`: the VAT inside a VAT-inclusive amount, 7 / 107. */
export const vatShare = (t: Pick<CostTemplate, 'vat_rate'>): number => (t.vat_rate > 0 ? t.vat_rate / (100 + t.vat_rate) : 0);
const groupOf = (l: Pick<CostLine, 'group'>): string => l.group || 'อื่นๆ';
/** Legacy `ctLinesByGroup`: groups in the order they first appear, lines in order within each. */
export const linesByGroup = (t: CostTemplate): CostLine[] => {
  const groups = [...new Set(t.lines.map(groupOf))];
  return groups.flatMap((g) => t.lines.filter((l) => groupOf(l) === g));
};
const groupSetting = (pl: Pick<PlanLike, 'groups'>, g: string): GroupSetting => pl.groups?.[g] ?? {};
const groupMul = (pl: Pick<PlanLike, 'groups'>, g: string): number => 1 + (groupSetting(pl, g).pct ?? 0) / 100;
/** Legacy `ctEffLine`: the line with the plan's override laid over each part. */
export function effectiveLine(line: CostLine, pl: Pick<PlanLike, 'overrides'>): { off: boolean; parts: CostPart[] } {
  const o = pl.overrides?.[line.id] ?? {};
  return { off: !!o.off, parts: line.parts.map((p, i) => ({ ...p, ...(o.parts?.[i] ?? {}) })) };
}
/** Legacy `ctPaxSplit`: adults and children, foreign and Thai; children split as the boat's nationalities. */
export function paxSplit(ctx: Pick<CalcCtx, 'pax' | 'pax_th' | 'pax_ch' | 'pax_ch_th'>) {
  const pax = Math.max(0, ctx.pax);
  const th = Math.min(Math.max(0, ctx.pax_th), pax), ch = Math.min(Math.max(0, ctx.pax_ch), pax);
  let chTH = ctx.pax_ch_th !== undefined ? Math.min(Math.max(0, ctx.pax_ch_th), Math.min(ch, th)) : pax ? Math.round((ch * th) / pax) : 0;
  chTH = Math.min(chTH, ch, th);
  return { ad_th: Math.max(0, th - chTH), ad_fr: Math.max(0, pax - ch - (th - chTH)), ch_th: chTH, ch_fr: Math.max(0, ch - chTH) };
}
/** Legacy `ctPartAmt`. */
export function partAmount(p: CostPart, ctx: CalcCtx): number {
  if (p.kind === 'fix') {
    const q = ctx.eng === '4EN' && p.qty_4en !== undefined ? p.qty_4en : p.qty;
    const u = ctx.eng === '4EN' && p.unit_4en !== undefined ? p.unit_4en : p.unit;
    const unit = p.fuel ? ctx.fuel || 0 : u || 0;
    return (q || 0) * unit * (p.per === 'boat' ? ctx.boats || 1 : 1);
  }
  if (p.kind === 'var') {
    if (p.fuel) return (p.qty || 0) * (ctx.fuel || 0) * (ctx.pax || 0);
    const u = p.unit || 0;
    const uTH = p.unit_th ?? u, uCh = p.unit_ch ?? u, uChTH = p.unit_ch_th ?? (p.unit_ch !== undefined ? uCh : uTH);
    const S = paxSplit(ctx);
    return S.ad_fr * u + S.ad_th * uTH + S.ch_fr * uCh + S.ch_th * uChTH;
  }
  const n = p.mode === 'over' ? ((ctx.pax || 0) > (p.over || 0) ? p.add || 1 : 0) : Math.max(p.min || 0, Math.ceil((ctx.pax || 0) / Math.max(1, p.every || 1)));
  return n * (p.unit || 0);
}
/** Legacy `ctOdPct`: an on-demand line counted per head is a % of heads; per boat, a count. */
const odPerHead = (line: CostLine): boolean => line.parts[0]?.kind === 'var';
/** Legacy `ctOdCfg`. */
function onDemandOf(pl: Pick<PlanLike, 'on_demand'>, line: CostLine) {
  const c = pl.on_demand?.[line.id] ?? {};
  return { aq: c.agent_qty ?? line.on_demand_qty ?? 0, ar: c.agent_rev ?? 0, uq: c.upsell_qty ?? 0, ur: c.upsell_rev ?? 0 };
}
/** Legacy `ctOdQty`: what was really ordered first (Trip P&L), else the plan's expectation. */
function onDemandQty(pl: Pick<PlanLike, 'on_demand'>, line: CostLine, ctx: CalcCtx): number {
  const real = ctx.od_qty?.[line.id];
  if (real !== undefined && real !== null) return Math.max(0, real || 0);
  const c = onDemandOf(pl, line), q = c.aq + c.uq;
  return odPerHead(line) ? Math.round(((ctx.pax || 0) * q) / 100) : q;
}
/** Legacy `ctOdRev`: what the company keeps of the on-demand lines sold (design sheets only). */
function onDemandRevenue(pl: PlanLike, t: CostTemplate, ctx: CalcCtx): number {
  let r = 0;
  for (const line of t.lines) {
    if (!line.on_demand || groupSetting(pl, groupOf(line)).off || effectiveLine(line, pl).off) continue;
    const c = onDemandOf(pl, line), pct = odPerHead(line), pax = ctx.pax || 0;
    const aq = pct ? Math.round((pax * c.aq) / 100) : c.aq, uq = pct ? Math.round((pax * c.uq) / 100) : c.uq;
    r += aq * c.ar + uq * c.ur;
  }
  return r;
}

/**
 * Legacy `ctCalc`: every line of the template for this plan and this trip. A rented boat (inside its
 * contract, with a rent, unless the plan asks to cost it as our own) leaves out the lines its owner
 * pays and adds the rent as its own row. A fuel part is scaled by the boat's fuel factor.
 */
export function calc(pl: PlanLike, ctx: CalcCtx, t: CostTemplate, rents: RentBook): Calc {
  const R = vatShare(t);
  let RN = rents.rent(ctx.boat_id);
  if (RN && !rentActiveOn(RN, ctx.date)) RN = null;
  if (RN && !(RN.per_trip > 0)) RN = null;
  if (RN && ctx.own_calc) RN = null;
  const FM = rents.fuel(ctx.boat_id);
  const out: Calc = { gross: 0, vat_in: 0, net: 0, fixed_net: 0, var_net: 0, rows: [], rent: RN };
  for (const line of linesByGroup(t)) {
    const g = groupOf(line);
    if (RN && RN.owner_pays.includes(line.id)) continue;
    if (groupSetting(pl, g).off) continue;
    const eff = effectiveLine(line, pl);
    if (eff.off) continue;
    let amt = 0, fx = 0, vr = 0;
    if (line.on_demand) {
      const q = onDemandQty(pl, line, ctx);
      for (const p of eff.parts) { const a = (p.unit || 0) * q; amt += a; vr += a; }
    } else {
      for (const p of eff.parts) {
        let a = partAmount(p, ctx);
        if (p.fuel && FM !== 1) a *= FM;
        amt += a;
        if (p.kind === 'var') vr += a; else fx += a;
      }
    }
    const m = groupMul(pl, g);
    if (m !== 1) { amt *= m; fx *= m; vr *= m; }
    const v = line.vat ? amt * R : 0;
    out.gross += amt; out.vat_in += v;
    out.fixed_net += fx - (line.vat ? fx * R : 0);
    out.var_net += vr - (line.vat ? vr * R : 0);
    out.rows.push({ id: line.id, group: line.group, label: line.label, vat: line.vat, amount: amt, vat_amount: v, net: amt - v, fixed: fx, variable: vr });
  }
  if (RN && RN.per_trip > 0) {
    const ra = RN.per_trip, rv = RN.vat ? ra * R : 0;
    out.gross += ra; out.vat_in += rv; out.fixed_net += ra - rv;
    out.rows.push({ id: 'rent', group: 'ค่าเช่าเรือ', label: `ค่าเช่าเรือ · ${RN.name}`, vat: RN.vat, amount: ra, vat_amount: rv, net: ra - rv, fixed: ra, variable: 0 });
  }
  out.net = out.gross - out.vat_in;
  return out;
}

/** Legacy `ctChdAt`: children at n heads, the plan's %. */
const childrenAt = (pl: Pick<PlanLike, 'child_pct'>, n: number): number => (pl.child_pct > 0 ? Math.min(n, Math.round((n * Math.min(100, pl.child_pct)) / 100)) : 0);
/** Legacy `ctCtxAt`. `as_of` is the day a contract is checked against (Trip P&L's); a design sheet has none. */
export const ctxAt = (pl: PlanLike, n: number, asOf: string | null = null): CalcCtx => {
  const th = Math.min(Math.max(0, pl.pax_th || 0), n);
  return { eng: pl.engines, boats: Math.max(1, pl.boats || 1), fuel: pl.fuel_price || 0, boat_id: pl.boat_id || null, own_calc: pl.rent_off, date: asOf, pax: n, pax_th: th, pax_ch: childrenAt(pl, n) };
};
/** Legacy `ctProfitAt`: revenue less VAT and commission, plus the on-demand money kept, less the net cost. */
export function profitAt(pl: PlanLike, n: number, t: CostTemplate, rents: RentBook, asOf: string | null = null) {
  const R = vatShare(t), ctx = ctxAt(pl, n, asOf), c = calc(pl, ctx, t, rents);
  const pAd = pl.price || 0, pCh = pl.price_child ?? pAd;
  const ch = ctx.pax_ch, ad = Math.max(0, n - ch);
  const rev = (ad * pAd + ch * pCh) * (1 - R) * (1 - (pl.commission_pct || 0) / 100);
  const odR = onDemandRevenue(pl, t, ctx) * (1 - R);
  return { profit: rev + odR - c.net, revenue: rev + odR, revenue_tour: rev, revenue_on_demand: odR, calc: c, adults: ad, children: ch };
}
/** Legacy `ctBreakEven`: steps make a closed formula wrong, so walk 1..seats to the first profit. */
export function breakEven(pl: PlanLike, cap: number, t: CostTemplate, rents: RentBook, asOf: string | null = null): number | null {
  for (let n = 1; n <= cap; n++) if (profitAt(pl, n, t, rents, asOf).profit > 0) return n;
  return null;
}
/** Legacy `ctPlanSeats`: the pinned boat's seats, else the plan's capacity. */
export const planSeats = (pl: Pick<CostPlan, 'boat_id' | 'capacity'>, boats: ReadonlyMap<string, { capacity: number }>): number => {
  const b = pl.boat_id ? boats.get(pl.boat_id) : undefined;
  return b && b.capacity > 0 ? b.capacity : Math.max(1, pl.capacity || 65);
};

const r2 = (n: number): number => round2(n);
export const calcView = (c: Calc) => ({
  gross: r2(c.gross), vat_in: r2(c.vat_in), net: r2(c.net), fixed_net: r2(c.fixed_net), var_net: r2(c.var_net),
  rows: c.rows.map((x) => ({ ...x, amount: r2(x.amount), vat_amount: r2(x.vat_amount), net: r2(x.net), fixed: r2(x.fixed), variable: r2(x.variable) })),
  rent: c.rent && { ...c.rent, total: r2(c.rent.total), per_day: r2(c.rent.per_day), per_trip: r2(c.rent.per_trip), per_calendar_day: r2(c.rent.per_calendar_day) },
});
/** A plan as the costing screen reads it: priced at its own heads (or `pax`), with its break-even. */
export function planView(pl: CostPlan, t: CostTemplate, rents: RentBook, boats: ReadonlyMap<string, { capacity: number }>, pax?: number) {
  const seats = planSeats(pl, boats), n = pax ?? pl.pax;
  const p = profitAt(pl, n, t, rents);
  return {
    ...pl, seats,
    calc: { pax: n, ...calcView(p.calc), revenue: r2(p.revenue), revenue_tour: r2(p.revenue_tour), revenue_on_demand: r2(p.revenue_on_demand), profit: r2(p.profit), adults: p.adults, children: p.children },
    break_even: breakEven(pl, seats, t, rents),
  };
}

/**
 * Legacy `pxPlanFor`: the plan of a route (its own first, then one tied to its family, older plans).
 * Trip P&L uses only its overrides, groups and fuel price: a plan's heads and price are for playing.
 */
export function planFor(plans: readonly CostPlan[], routeId: string, familyId: string | null | undefined): CostPlan | null {
  if (!routeId) return null;
  const fid = familyId || routeId;
  return plans.find((p) => p.route_key === routeId) ?? plans.find((p) => p.route_key === fid) ?? null;
}

/**
 * Legacy `drLtRate`: the longtail prices of a route, from the template's `ltc` (per boat) and `ltj`
 * (per head) lines through the route's plan; a line turned off is 0; with no `ltc` line, ฿600.
 */
export function longtailRates(t: CostTemplate, plan: Pick<PlanLike, 'overrides' | 'groups'> | null): { charter: number; join: number } {
  const out = { charter: 600, join: 0 };
  const pl = plan ?? { overrides: {}, groups: {} };
  for (const line of t.lines) {
    if (line.id !== 'ltc' && line.id !== 'ltj') continue;
    const key = line.id === 'ltc' ? 'charter' : 'join';
    if (groupSetting(pl, groupOf(line)).off) { out[key] = 0; continue; }
    const eff = effectiveLine(line, pl);
    if (eff.off) { out[key] = 0; continue; }
    out[key] = eff.parts[0]?.unit || 0;
  }
  return out;
}
