/**
 * Engines, gearboxes and propellers (todo/fleet-maintenance-model.md, part A, decided 2026-10-09).
 * Copied from legacy's Fleet → Asset screens (`05-fleet.js`): the forms (`flSaveEngine`,
 * `flSaveGearbox`, `flSavePropeller`), the equipment bay (`flEquipSwapDo`, `flEquipRemove`), moving a
 * spare (`flConfirmMove`), marking a service (`flEngMarkService`, `flGbMarkService`) and the computed
 * hours and service due (`flEngHours`, `flEngServiceState`, `flGbLifetimeHours`, `flGbServiceState`).
 * Pure: a route reads the assets a command touches, asks these, and writes what they answer.
 */
import { refuse } from './booking-actions.js';
import { realDate } from './catalogue.js';

const bad = (message: string): never => refuse(message, 400);

export const ASSET_KINDS = ['engine', 'gearbox', 'propeller'] as const;
export type AssetKind = typeof ASSET_KINDS[number];
/** The path segment of each kind: `/v1/fleet/engines`. */
export const ASSET_PATHS: Record<string, AssetKind> = { engines: 'engine', gearboxes: 'gearbox', propellers: 'propeller' };
export const ASSET_LIST_KEY: Record<AssetKind, string> = { engine: 'engines', gearbox: 'gearboxes', propeller: 'propellers' };

/** Engines and gearboxes: `limited` only by closing a job. Propellers: `damaged` only by a swap, `limited` by a job. */
export const ENGINE_STATUSES = ['ready', 'fixing', 'broken', 'spare', 'limited'] as const;
export const PROPELLER_STATUSES = ['active', 'fixing', 'broken', 'spare', 'damaged', 'limited'] as const;
/** What the forms' status pickers offer (`flStValues`, `flPropStValues`), the first being the default. */
export const PICKABLE: Record<AssetKind, readonly string[]> = {
  engine: ['ready', 'fixing', 'broken', 'spare'], gearbox: ['ready', 'fixing', 'broken', 'spare'], propeller: ['active', 'fixing', 'broken', 'spare'],
};
export type EngineStatus = typeof ENGINE_STATUSES[number];
export type PropellerStatus = typeof PROPELLER_STATUSES[number];

/** One line of an asset's history (legacy `*__log`), as each command writes it. */
export type AssetLogEntry = {
  date: string | null; type: string | null; description: string | null; detail: string | null; text: string | null;
  hours: number | null; engine_hours: number | null; used_hours: number | null; from_loc: string | null; to_loc: string | null;
  incident_id: string | null; outcome: string | null; cost: number | null; by: string | null;
};
export const logEntry = (e: Partial<AssetLogEntry>): AssetLogEntry => ({
  date: null, type: null, description: null, detail: null, text: null, hours: null, engine_hours: null, used_hours: null,
  from_loc: null, to_loc: null, incident_id: null, outcome: null, cost: null, by: null, ...e,
});

export type Engine = {
  id: string; brand: string | null; model: string | null; serial: string | null; hp: number | null;
  boat_id: string | null; pos: string | null; status: EngineStatus; base_hours: number; service_interval: number | null;
  buy_date: string | null; price: number | null; note: string | null; spare_location: string | null;
  last_service_hours: number | null; last_service_date: string | null;
  retired: boolean; retired_on: string | null; retired_reason: string | null;
  log: AssetLogEntry[];
};
export type Gearbox = {
  id: string; brand: string | null; model: string | null; model_suffix: string | null; serial: string | null;
  boat_id: string | null; engine_id: string | null; on_boat_id: string | null; on_boat_pos: string | null;
  status: EngineStatus; base_hours: number; install_hours: number | null; service_interval: number | null;
  last_service_hours: number | null; last_service_date: string | null; buy_date: string | null; note: string | null;
  spare_location: string | null; shaft_length: string | null; rotation: string | null; gear_ratio: string | null; oil_capacity: string | null;
  log: AssetLogEntry[];
};
export type Propeller = {
  id: string; brand: string | null; serial: string | null; old_serial: string | null;
  boat_id: string | null; gearbox_id: string | null; prop_pos: string | null;
  diameter: number | null; pitch: number | null; size: string | null; blades: string | null; material: string | null;
  rotation: string | null; hub_size: string | null; cupping: string | null; cost: number | null; install_hours: number | null;
  status: PropellerStatus; buy_date: string | null; note: string | null; spare_location: string | null;
  log: AssetLogEntry[];
};
export type AssetOf = { engine: Engine; gearbox: Gearbox; propeller: Propeller };
export type AnyAsset = Engine | Gearbox | Propeller;

export const copyAsset = <T extends AnyAsset>(a: T): T => ({ ...a, log: a.log.map((l) => ({ ...l })) });

// ── The forms' fields ──

type FieldType = 'text' | 'number' | 'int' | 'date';
/** Each kind's client facts, as its form saves them. */
const FACTS: Record<AssetKind, Record<string, FieldType>> = {
  engine: {
    brand: 'text', model: 'text', serial: 'text', hp: 'number', buy_date: 'date', price: 'number', base_hours: 'number',
    service_interval: 'int', note: 'text', spare_location: 'text',
  },
  gearbox: {
    brand: 'text', model: 'text', model_suffix: 'text', serial: 'text', buy_date: 'date', base_hours: 'number', note: 'text',
    shaft_length: 'text', rotation: 'text', gear_ratio: 'text', oil_capacity: 'text', service_interval: 'int', last_service_date: 'date',
    spare_location: 'text',
  },
  propeller: {
    brand: 'text', serial: 'text', old_serial: 'text', diameter: 'number', pitch: 'number', size: 'text', blades: 'text', material: 'text',
    rotation: 'text', hub_size: 'text', cupping: 'text', cost: 'number', buy_date: 'date', note: 'text', spare_location: 'text', prop_pos: 'text',
  },
};
/** What a client may not set by `PATCH`, and where it is set instead. */
const OWNED: Record<AssetKind, Record<string, string>> = {
  engine: {
    id: 'an asset id is assigned by the server', status: 'use POST /v1/fleet/engines/{id}/status',
    boat_id: 'use POST /v1/fleet/engines/{id}/install, /remove or /swap', pos: 'use POST /v1/fleet/engines/{id}/install or /swap',
    last_service_hours: 'use POST /v1/fleet/engines/{id}/service', last_service_date: 'use POST /v1/fleet/engines/{id}/service',
    retired: 'it is set by closing a job as decommission', retired_on: 'it is set by closing a job as decommission', retired_reason: 'it is set by closing a job as decommission',
    log: 'the history is written by the commands', hours: 'it is computed', service: 'it is computed',
  },
  gearbox: {
    id: 'an asset id is assigned by the server', status: 'use POST /v1/fleet/gearboxes/{id}/status',
    engine_id: 'use POST /v1/fleet/gearboxes/{id}/install, /remove or /swap', boat_id: 'it follows the engine the gearbox is on',
    on_boat_id: 'it is set when a job start leaves the gearbox on the boat', on_boat_pos: 'it is set when a job start leaves the gearbox on the boat',
    install_hours: 'it is set by an install', last_service_hours: 'use POST /v1/fleet/gearboxes/{id}/service',
    log: 'the history is written by the commands', lifetime_hours: 'it is computed', service: 'it is computed',
  },
  propeller: {
    id: 'an asset id is assigned by the server', status: 'use POST /v1/fleet/propellers/{id}/status',
    gearbox_id: 'use POST /v1/fleet/propellers/{id}/install, /remove or /swap', boat_id: 'it follows the gearbox the propeller is on',
    install_hours: 'it is set by an install', log: 'the history is written by the commands',
  },
};
/** The install fields a create may carry, as each form's selects do. */
const LINKS: Record<AssetKind, readonly string[]> = { engine: ['boat_id', 'pos'], gearbox: ['engine_id'], propeller: ['gearbox_id'] };

const camelToSnake = (key: string): string => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
/** Legacy's camelCase spellings (`baseHours`, `spareLocation`, `hubSize`…) beside ours. */
function snakeKeys(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    const s = camelToSnake(k);
    if (s !== k && body[s] !== undefined) continue;
    out[s] = v;
  }
  return out;
}
const unset = (v: unknown): boolean => v === undefined || v === null || v === '';
const textOf = (v: unknown, name: string): string | null => (unset(v) ? null : typeof v === 'string' ? v.trim() || null : typeof v === 'number' ? String(v) : bad(`${name} must be text`));
const numberOf = (v: unknown, name: string): number | null => {
  if (unset(v)) return null;
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : bad(`${name} must be a number, 0 or more`);
};
const intOf = (v: unknown, name: string): number | null => {
  const n = numberOf(v, name);
  return n === null || (Number.isInteger(n) && n > 0) ? n : bad(`${name} must be a whole number above 0`);
};

function parseField(type: FieldType, value: unknown, name: string): string | number | null {
  if (type === 'text') return textOf(value, name);
  if (type === 'number') return numberOf(value, name);
  if (type === 'int') return intOf(value, name);
  return unset(value) ? null : realDate(value, name);
}

export type AssetInput = { facts: Record<string, string | number | null>; status?: string; links: Record<string, string | null> };

/**
 * A form's save, for `POST` (`create`) or `PATCH`. As the forms save them: a blank `base_hours` is 0,
 * a blank service interval 100 (`parseInt(…)||100`), a blank propeller `cost` 0, and a propeller's
 * `size` is `diameter×pitch` when both are given. A create may set the status and the install fields
 * the form's selects set; a `PATCH` sends those to the commands.
 */
export function parseAssetInput(kind: AssetKind, raw: Record<string, unknown>, mode: 'create' | 'patch'): AssetInput {
  const body = snakeKeys(raw);
  for (const key of Object.keys(body)) {
    const owned = OWNED[kind][key];
    if (owned && !(mode === 'create' && (key === 'status' || LINKS[kind].includes(key)))) bad(`${key} cannot be set here; ${owned}`);
  }
  const facts: Record<string, string | number | null> = {};
  for (const [name, type] of Object.entries(FACTS[kind])) {
    if (body[name] === undefined) continue;
    facts[name] = parseField(type, body[name], name);
  }
  if ('base_hours' in facts && facts.base_hours === null) facts.base_hours = 0;
  if ('service_interval' in facts && facts.service_interval === null && kind !== 'propeller') facts.service_interval = 100;
  if (kind === 'propeller') {
    if ('cost' in facts && facts.cost === null) facts.cost = 0;
    const d = 'diameter' in facts ? facts.diameter : undefined, p = 'pitch' in facts ? facts.pitch : undefined;
    if (typeof d === 'number' && typeof p === 'number') facts.size = `${d}×${p}`;
  }
  if (mode === 'create') {
    if (facts.base_hours === undefined) facts.base_hours = 0;
    if (kind !== 'propeller' && facts.service_interval === undefined) facts.service_interval = 100;
    if (kind === 'propeller' && facts.cost === undefined) facts.cost = 0;
    if (kind === 'engine' && (!facts.model || !facts.serial)) bad('model and serial are required');
  }
  const out: AssetInput = { facts, links: {} };
  if (mode === 'create') {
    if (!unset(body.status)) out.status = pickable(kind, body.status);
    for (const key of LINKS[kind]) if (body[key] !== undefined) out.links[key] = textOf(body[key], key);
  }
  return out;
}

export function pickable(kind: AssetKind, value: unknown): string {
  const list = PICKABLE[kind];
  if (typeof value === 'string' && list.includes(value)) return value;
  if (value === 'limited') bad('limited is set by closing a job with the outcome limited');
  if (value === 'damaged' && kind === 'propeller') bad('damaged is set by a quick swap from an incident');
  return bad(`status must be one of ${list.join(', ')}`);
}

/** A new asset's whole row: the form's defaults, the first status of its picker. */
export function newAsset<K extends AssetKind>(kind: K, id: string, input: AssetInput): AssetOf[K] {
  const blank = Object.fromEntries(Object.keys(FACTS[kind]).map((k) => [k, null]));
  const common = { ...blank, ...input.facts, id, log: [] as AssetLogEntry[], status: input.status ?? PICKABLE[kind][0] };
  if (kind === 'engine') {
    return { ...common, boat_id: null, pos: null, last_service_hours: null, last_service_date: null, retired: false, retired_on: null, retired_reason: null } as unknown as AssetOf[K];
  }
  if (kind === 'gearbox') return { ...common, boat_id: null, engine_id: null, on_boat_id: null, on_boat_pos: null, install_hours: null, last_service_hours: null } as unknown as AssetOf[K];
  return { ...common, boat_id: null, gearbox_id: null, install_hours: null } as unknown as AssetOf[K];
}

/**
 * Where a spare is kept, after the form's status: an engine keeps it only while spare or fixing, a
 * gearbox while spare (or loose), a propeller while spare or fixing (or loose); anything on its parent
 * keeps none (`flSaveEngine`, `flSaveGearbox`, `flSavePropeller`).
 */
export function formSpareLocation(kind: AssetKind, status: string, linked: boolean, sent: string | null, current: string | null): string | null {
  if (kind === 'engine') return status === 'spare' || status === 'fixing' ? sent : null;
  if (kind === 'gearbox') return status === 'spare' ? sent : linked ? null : sent ?? current;
  return status === 'spare' || status === 'fixing' ? sent : linked ? null : sent ?? current;
}

// ── Hours and service due ──

/** A Daily Fleet Log meter reading for one engine (part B's data). */
export type MeterReading = { date: string; reading: number };
const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * `flEngHours`: the hours brought in (`base_hours`) plus what the meter ran since its first reading
 * (latest − first, skipping 0 and below). The meter travels with the engine, so it needs no boat.
 */
export function engineHours(e: Pick<Engine, 'base_hours'>, meters: readonly MeterReading[]): number {
  let first: MeterReading | undefined, last: MeterReading | undefined;
  for (const m of meters) {
    if (!(m.reading > 0)) continue;
    if (!last || m.date > last.date) last = m;
    if (!first || m.date < first.date) first = m;
  }
  return first && last ? round1(e.base_hours + (last.reading - first.reading)) : e.base_hours;
}

export type ServiceState = { current_hours: number; interval: number; base: number; since: number; next: number | null; left: number | null; pct: number; overdue: boolean };

/** `flEngServiceState`: counted from the last service (else the hours brought in); no interval, no countdown. */
export function engineService(e: Pick<Engine, 'service_interval' | 'last_service_hours' | 'base_hours'>, hours: number): ServiceState {
  const interval = e.service_interval ?? 0;
  const base = e.last_service_hours !== null ? e.last_service_hours : e.base_hours;
  const since = Math.max(0, hours - base);
  if (!interval) return { current_hours: hours, interval: 0, base, since, next: null, left: null, pct: 0, overdue: false };
  const left = round1(base + interval - hours);
  return { current_hours: hours, interval, base, since, next: base + interval, left, pct: Math.min(100, Math.max(0, (since / interval) * 100)), overdue: left < 0 };
}

/** Legacy's gear-oil interval when a gearbox has none (`GB_DEF_SVC_INTERVAL`). */
export const GEARBOX_DEFAULT_INTERVAL = 200;

/**
 * `flGbLifetimeHours`: hours used on earlier engines (the `remove` lines) plus the hours of the engine
 * it is on since it was fitted (`base_hours` is that engine's hours at fitting).
 */
export function gearboxLifetime(g: Pick<Gearbox, 'engine_id' | 'base_hours' | 'log'>, engineHoursOf: (id: string) => number | undefined): number {
  const eng = g.engine_id ? engineHoursOf(g.engine_id) : undefined;
  const current = eng === undefined ? 0 : Math.max(0, eng - g.base_hours);
  const before = g.log.filter((l) => l.type === 'remove').reduce((sum, l) => sum + (l.used_hours ?? 0), 0);
  return round1(before + current);
}

/** `flGbServiceState`: never serviced counts from now, so a new gearbox is not overdue at once. */
export function gearboxService(g: Pick<Gearbox, 'service_interval' | 'last_service_hours' | 'engine_id'>, life: number): ServiceState & { defaulted: boolean; attached: boolean } {
  const interval = g.service_interval ?? GEARBOX_DEFAULT_INTERVAL;
  const base = g.last_service_hours !== null ? g.last_service_hours : life;
  const since = Math.max(0, life - base);
  const left = round1(base + interval - life);
  return {
    current_hours: life, interval, base, since, next: base + interval, left, pct: Math.min(100, Math.max(0, (since / interval) * 100)), overdue: left < 0,
    defaulted: g.service_interval === null, attached: g.engine_id !== null,
  };
}

// ── Labels as legacy writes them into histories ──

/** Legacy's spare places (`SPARE_LOC_LABELS`, `flParseSpareLoc`); anything else is its own label. */
const SPARE_LABELS: Record<string, string> = {
  'pier:tublamu': 'คลัง Tub Lamu', 'pier:panwa': 'คลัง Visit Panwa', 'pier:central': 'คลังกลาง',
  'shop:honda-phuket': 'อู่ Honda Phuket', 'shop:suzuki-phuket': 'อู่ Suzuki Phuket', 'shop:prop-shop-phuket': 'ร้านใบจักร Phuket',
};
export function spareLabel(loc: string | null, boatName: (id: string) => string): string {
  if (!loc) return 'ไม่ระบุ';
  if (loc.startsWith('boat:')) return `บนเรือ ${boatName(loc.slice(5))}`;
  return SPARE_LABELS[loc] ?? loc;
}
/** What an incident or a job calls an asset (`flSaveIncident`): `serial · pos` for an engine, `serial · note` otherwise. */
export function assetLabel(kind: AssetKind, a: AnyAsset): string {
  if (kind === 'engine') return `${a.serial ?? ''} · ${(a as Engine).pos ?? ''}`;
  return `${a.serial ?? ''}${a.note ? ` · ${a.note}` : ''}`;
}

// ── Commands ──

export type AssetContext = { today: string; boatName: (id: string) => string; engineHours: (id: string) => number };

/** `flChangeEngStatus`: the new status, logged with the engine's hours. A spare gearbox or propeller leaves its parent (the forms' invariant). */
export function withStatus<T extends AnyAsset>(kind: AssetKind, a: T, status: string, note: string | null, ctx: AssetContext): T {
  const next = copyAsset(a) as T & Record<string, unknown>;
  const hours = kind === 'engine' ? ctx.engineHours(a.id) : null;
  next.log.push(logEntry({ date: ctx.today, type: 'status', description: `Status: ${a.status} → ${status}${note ? ` · ${note}` : ''}`, hours }));
  (next as Record<string, unknown>).status = status;
  if (status === 'spare' && kind === 'gearbox') next.engine_id = null;
  if (status === 'spare' && kind === 'propeller') next.gearbox_id = null;
  return next;
}

const SPARE_START: Record<AssetKind, string> = { engine: 'ready', gearbox: 'ready', propeller: 'active' };

/** An engine onto a boat at a position (the form, the equipment bay). A spare becomes ready. */
export function installedEngine(e: Engine, boatId: string, pos: string, ctx: AssetContext, jobNo?: string): Engine {
  const next = copyAsset(e);
  next.boat_id = boatId; next.pos = pos;
  if (next.status === 'spare') next.status = 'ready';
  next.log.push(logEntry({ date: ctx.today, type: 'install', description: `ติดตั้งที่ ${ctx.boatName(boatId)} ${pos}${jobNo ? ` · ${jobNo}` : ''}`, hours: ctx.engineHours(e.id) }));
  return next;
}

/** The gearbox form's list: an engine on a boat, carrying no other gearbox. */
export function assertGearboxFits(gearboxId: string, engine: Engine, others: readonly Gearbox[]): void {
  if (!engine.boat_id) refuse(`Engine ${engine.serial ?? engine.id} is not on a boat: a spare engine can't carry a gearbox`, 409, 'engine_not_installed');
  const taken = others.find((x) => x.id !== gearboxId && x.engine_id === engine.id);
  if (taken) refuse(`Engine ${engine.serial ?? engine.id} already has gearbox ${taken.serial ?? taken.id}: remove it first`, 409, 'engine_has_gearbox');
}
/** The propeller form's list: a gearbox on an engine, carrying no propeller yet. */
export function assertPropellerFits(propellerId: string, gearbox: Gearbox, others: readonly Propeller[]): void {
  if (!gearbox.engine_id) refuse(`Gearbox ${gearbox.serial ?? gearbox.id} is not on an engine: a spare gearbox can't carry a propeller`, 409, 'gearbox_not_installed');
  const taken = others.find((x) => x.id !== propellerId && x.gearbox_id === gearbox.id);
  if (taken) refuse(`Gearbox ${gearbox.serial ?? gearbox.id} already has propeller ${taken.serial ?? taken.id}: remove it first`, 409, 'gearbox_has_propeller');
}

/** A gearbox onto an engine (the equipment bay); its hours count from the engine's hours at fitting, as the quick swap does. */
export function installedGearbox(g: Gearbox, engine: Engine, others: readonly Gearbox[], ctx: AssetContext): Gearbox {
  assertGearboxFits(g.id, engine, others);
  const hours = ctx.engineHours(engine.id);
  const next = copyAsset(g);
  next.engine_id = engine.id; next.boat_id = engine.boat_id; next.on_boat_id = null; next.on_boat_pos = null; next.spare_location = null;
  // The quick swap's rule: the gearbox's hours count from the engine's hours at fitting.
  next.base_hours = hours; next.install_hours = hours;
  if (next.status === 'spare') next.status = SPARE_START.gearbox as Gearbox['status'];
  next.log.push(logEntry({ date: ctx.today, type: 'install', description: `ติดตั้งบน ${ctx.boatName(engine.boat_id!)} ${engine.pos ?? ''}`.trim(), engine_hours: hours }));
  return next;
}

/** A propeller onto a gearbox (the equipment bay). */
export function installedPropeller(p: Propeller, gearbox: Gearbox, others: readonly Propeller[], propPos: string | null | undefined, ctx: AssetContext): Propeller {
  assertPropellerFits(p.id, gearbox, others);
  const hours = ctx.engineHours(gearbox.engine_id!);
  const next = copyAsset(p);
  next.gearbox_id = gearbox.id; next.boat_id = gearbox.boat_id; next.spare_location = null; next.install_hours = hours;
  if (propPos !== undefined) next.prop_pos = propPos;
  if (next.status === 'spare') next.status = 'active';
  next.log.push(logEntry({ date: ctx.today, type: 'install', description: `ติดตั้งบน ${gearbox.boat_id ? ctx.boatName(gearbox.boat_id) : ''} · เกียร์ ${gearbox.serial ?? gearbox.id}`.trim(), engine_hours: hours }));
  return next;
}

/** `flEquipRemove`: off its boat, engine or gearbox, kept as a spare. Only a gearbox's status changes, as legacy. */
export function removedAsset<T extends AnyAsset>(kind: AssetKind, a: T, spareLocation: string | null | undefined, ctx: AssetContext): T {
  const next = copyAsset(a) as T & Record<string, unknown>;
  if (kind === 'engine') {
    const e = a as Engine;
    if (!e.boat_id) refuse(`Engine ${e.serial ?? e.id} is not on a boat`, 409, 'not_installed');
    next.log.push(logEntry({ date: ctx.today, type: 'remove', description: `ถอดจาก ${ctx.boatName(e.boat_id!)} ${e.pos ?? ''} → Spare`, by: 'Equip' }));
    next.boat_id = null;
  } else if (kind === 'gearbox') {
    if (!(a as Gearbox).engine_id && !(a as Gearbox).on_boat_id) refuse(`Gearbox ${a.serial ?? a.id} is not on an engine`, 409, 'not_installed');
    next.log.push(logEntry({ date: ctx.today, type: 'remove', description: 'ถอดเก็บเป็น Spare', by: 'Equip' }));
    next.engine_id = null; next.on_boat_id = null; next.on_boat_pos = null; next.boat_id = null; next.status = 'spare';
  } else {
    if (!(a as Propeller).gearbox_id) refuse(`Propeller ${a.serial ?? a.id} is not on a gearbox`, 409, 'not_installed');
    next.log.push(logEntry({ date: ctx.today, type: 'remove', description: 'ถอดเก็บเป็น Spare', by: 'Equip' }));
    next.gearbox_id = null; next.boat_id = null;
  }
  if (spareLocation !== undefined) next.spare_location = spareLocation;
  return next;
}

/**
 * `flConfirmMove`: a spare gearbox or propeller to another place. A shop means it is being repaired
 * (fixing), anywhere else it is a spare; into or out of a shop is logged as a repair.
 */
export function movedSpare<T extends Gearbox | Propeller>(a: T, to: string, note: string | null, ctx: AssetContext): T {
  const from = a.spare_location;
  if (from === to) return copyAsset(a);
  const next = copyAsset(a) as T & Record<string, unknown>;
  const label = (loc: string | null) => spareLabel(loc, ctx.boatName);
  let type = 'transfer', description = `ย้าย: ${label(from)} → ${label(to)}`;
  if (to.startsWith('shop:') && !from?.startsWith('shop:')) { type = 'repair'; description = `ส่งซ่อม: ${label(from)} → ${label(to)}`; }
  else if (from?.startsWith('shop:') && !to.startsWith('shop:')) { type = 'repair'; description = `รับกลับจากซ่อม: ${label(from)} → ${label(to)}`; }
  if (note && note !== a.note) description += ` · ${note}`;
  next.log.push(logEntry({ date: ctx.today, type, description, from_loc: from, to_loc: to }));
  next.spare_location = to;
  if (note) next.note = note;
  next.status = to.startsWith('shop:') ? 'fixing' : 'spare';
  return next;
}

/** `flEngMarkService`, `flGbMarkService`: the hour reading becomes the service baseline. */
export function serviced<T extends Engine | Gearbox>(kind: 'engine' | 'gearbox', a: T, hours: number, ctx: AssetContext, jobNo?: string): T {
  const next = copyAsset(a);
  next.last_service_hours = hours; next.last_service_date = ctx.today;
  const what = kind === 'engine' ? 'Service / oil change' : 'Gear oil service';
  next.log.push(logEntry({ date: ctx.today, type: 'service', description: `${what}${jobNo ? ` · ${jobNo}` : ''} · baseline reset at ${hours}h`, hours }));
  return next;
}

export function parseHours(body: Record<string, unknown>): number {
  const h = body.hours;
  return typeof h === 'number' && Number.isFinite(h) && h >= 0 ? h : bad('hours must be a number, 0 or more');
}

/** `flEquipSwapDo`: two assets of a kind trade places; a gearbox left without an engine is a spare. */
export function swappedPair<T extends AnyAsset>(kind: AssetKind, a: T, b: T, ctx: AssetContext): [T, T] {
  if (a.id === b.id) bad('with_id must be another asset');
  const x = copyAsset(a) as T & Record<string, unknown>, y = copyAsset(b) as T & Record<string, unknown>;
  const where = (o: Record<string, unknown>) => (o.boat_id ? `${ctx.boatName(o.boat_id as string)}${o.pos ? ` · ${o.pos as string}` : ''}` : 'Spare');
  if (kind === 'engine') {
    [x.boat_id, y.boat_id] = [y.boat_id, x.boat_id];
    [x.pos, y.pos] = [y.pos, x.pos];
    x.log.push(logEntry({ date: ctx.today, type: 'swap', description: `สลับ → ${where(x)} (กับ ${b.serial ?? b.id})`, by: 'Equip' }));
    y.log.push(logEntry({ date: ctx.today, type: 'swap', description: `สลับ → ${where(y)} (กับ ${a.serial ?? a.id})`, by: 'Equip' }));
  } else if (kind === 'gearbox') {
    [x.engine_id, y.engine_id] = [y.engine_id, x.engine_id];
    [x.boat_id, y.boat_id] = [y.boat_id, x.boat_id];
    for (const g of [x, y]) g.status = g.engine_id ? (g.status === 'spare' ? 'ready' : g.status) : 'spare';
    x.log.push(logEntry({ date: ctx.today, type: 'swap', description: `สลับเกียร์ (กับ ${b.serial ?? b.id})`, by: 'Equip' }));
    y.log.push(logEntry({ date: ctx.today, type: 'swap', description: `สลับเกียร์ (กับ ${a.serial ?? a.id})`, by: 'Equip' }));
  } else {
    [x.gearbox_id, y.gearbox_id] = [y.gearbox_id, x.gearbox_id];
    [x.boat_id, y.boat_id] = [y.boat_id, x.boat_id];
    x.log.push(logEntry({ date: ctx.today, type: 'swap', description: `สลับใบจักร (กับ ${b.serial ?? b.id})`, by: 'Equip' }));
    y.log.push(logEntry({ date: ctx.today, type: 'swap', description: `สลับใบจักร (กับ ${a.serial ?? a.id})`, by: 'Equip' }));
  }
  return [x, y];
}

/** An id for a new asset, legacy's `LA_UID('e')` shape: the kind's letter and the time, moved on while taken. */
export function newAssetId(kind: AssetKind, taken: ReadonlySet<string>, now: number): string {
  const prefix = kind === 'engine' ? 'e' : kind === 'gearbox' ? 'g' : 'p';
  let n = now;
  while (taken.has(`${prefix}${n.toString(36)}`)) n += 1;
  return `${prefix}${n.toString(36)}`;
}

export type AssetQuery = { ids?: readonly string[]; boatId?: string };
/** By id, as both stores list them. */
export const sortAssets = <T extends AnyAsset>(list: readonly T[]): T[] => [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
export const matchesAsset = (a: AnyAsset, q: AssetQuery): boolean => (!q.ids || q.ids.includes(a.id)) && (q.boatId === undefined || a.boat_id === q.boatId);
