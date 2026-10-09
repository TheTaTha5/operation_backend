/**
 * Editing the catalogue: routes, their families, boats and a boat's seats for one day
 * (todo/catalogue-editing-model.md, decided 2026-10-09). Copied from legacy's Settings → Programs
 * (`openRouteModal`, `saveRoute`, `delRoute`, `stApplyRouteOrder`), its boat form (`saveBoat`,
 * `saveStatus`, `flRetireBoat`), its day-seats dialog (`boatCapSet`) and Love Kingdom's create
 * (`b2c-catalog.js`). Pure, so both stores and the routes decide identically: the stores gather rows
 * and write what these return.
 */
import { refuse } from './booking-actions.js';
import { isIsoDate, isIsoTime, type Route, type RouteKind, type RouteSeason } from './calendar.js';
import { charterCeiling, deploymentSeats } from './capacity.js';
import type { Boat, Deployment } from './operations.js';

const bad = (message: string): never => refuse(message, 400);

// ── Shared pieces ──

/** The three piers, legacy's `LA_PIER_ORDER`. A land route has none (or, from Love Kingdom, may have one). */
export const PIERS = ['tublamu', 'panwa', 'ranong'] as const;
/** What legacy writes as a status entry's `loc` when the boat form changes the status (`saveBoat`). */
export const PIER_LABEL: Record<string, string> = { tublamu: 'Tub Lamu Pier', panwa: 'Visit Panwa', ranong: 'Ranong Pier' };
/** A new route's colour, in turn (legacy `ROUTE_COLORS`). */
export const ROUTE_COLORS = ['#378ADD', '#3B6D11', '#E24B4A', '#7F77DD', '#BA7517', '#0F6E56', '#D4537E', '#888780'] as const;
/** The boat form's type list. Pricing reads it (a charter's price is per boat type). */
export const BOAT_TYPES = ['Catamaran', 'Speedboat', 'Big Boat', 'Longtail'] as const;
/** What a person picks; `retired` is set by the retire command only. */
export const PICKABLE_STATUSES = ['available', 'fixing', 'unavailable'] as const;
export type BoatStatus = typeof PICKABLE_STATUSES[number] | 'retired';

const COLOR = /^#[0-9a-fA-F]{6}$/;
const EXT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const FAMILY_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const unset = (value: unknown): boolean => value === undefined || value === null || value === '';
/** Trimmed text, `null` when blank. */
const text = (value: unknown, name: string): string | null => {
  if (unset(value)) return null;
  return typeof value === 'string' ? value.trim() || null : bad(`${name} must be a string`);
};
const required = (value: unknown, name: string): string => text(value, name) ?? bad(`${name} is required`);
const color = (value: unknown, name = 'color'): string | null => {
  const c = text(value, name);
  return c === null || COLOR.test(c) ? c : bad(`${name} must be a #rrggbb colour`);
};
/** A real calendar day: `2048-02-30` would otherwise roll into March. */
export const realDate = (value: unknown, name: string): string => {
  const day = typeof value === 'string' && isIsoDate(value) ? new Date(`${value}T00:00:00Z`) : undefined;
  return day && !Number.isNaN(day.getTime()) && day.toISOString().startsWith(value as string) ? value as string : bad(`${name} must be a YYYY-MM-DD date`);
};
const optionalDate = (value: unknown, name: string): string | null => (unset(value) ? null : realDate(value, name));
/** Refuses any key the caller may not set here, naming what to use instead. */
const refuseOwned = (body: Record<string, unknown>, owned: Record<string, string>): void => {
  for (const key of Object.keys(body)) if (key in owned) bad(`${key} cannot be set here; ${owned[key]}`);
};

/**
 * `<prefix><epoch ms>`, legacy's id for a new route (`'r' + Date.now()`) or boat (`LA_UID('b')`),
 * moved on a millisecond while it is taken (`nextRouteId` in `b2c-catalog.js`).
 */
export function nextCatalogueId(prefix: string, taken: ReadonlySet<string>, now: number): string {
  let n = now;
  while (taken.has(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

// ── Families (decision 8: an editable table) ──

export type RouteFamily = { id: string; name: string; color: string | null; sort: number };
/** Legacy's `_BKV2_FAMILIES`, which migration 070 seeds; the in-process store starts with them too. */
export const LEGACY_FAMILIES: readonly RouteFamily[] = [
  ['similan', 'Similan Islands', '#185fa5'], ['surin', 'Surin Islands', '#3B6D11'], ['phiphi', 'Phi Phi Bamboo', '#c0392b'],
  ['krabi', 'Krabi + Phang Nga', '#0F6E56'], ['whaleshark', 'Whale Shark Phi Phi Maiton', '#BA7517'], ['selava', 'Day Trip - Se La Va', '#BA7517'],
  ['nyaung', 'Day Trip - Nyaung Oo Phee Island', '#0F6E56'], ['transfer', 'Transfer', '#5B289A'], ['citytour', 'City Tour', '#7B4BB7'],
  ['activity', 'Activities', '#C77D1E'],
].map(([id, name, c], sort) => ({ id, name, color: c, sort }));
export const sortFamilies = (families: readonly RouteFamily[]): RouteFamily[] =>
  [...families].sort((a, b) => a.sort - b.sort || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((f) => ({ ...f }));

/** An id made from a name: `Island Hopping` → `island-hopping`, moved on while taken. */
export function familyIdFrom(name: string, taken: ReadonlySet<string>): string {
  const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28) || 'family';
  let id = base, n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  return id;
}

const sortOf = (value: unknown): number =>
  typeof value === 'number' && Number.isInteger(value) ? value : bad('sort must be a whole number');

/** `POST /v1/route-families`. */
export function parseNewFamily(body: Record<string, unknown>, taken: ReadonlySet<string>): RouteFamily {
  const name = required(body.name, 'name');
  const id = text(body.id, 'id');
  if (id !== null && !FAMILY_ID.test(id)) bad('id must be 1-32 characters of a-z, 0-9, - and _, starting with a letter or digit');
  if (id !== null && taken.has(id)) refuse(`Family ${id} already exists`, 409, 'family_exists');
  return { id: id ?? familyIdFrom(name, taken), name, color: color(body.color), sort: body.sort === undefined ? 0 : sortOf(body.sort) };
}

/** `PATCH /v1/route-families/{id}`: the id is permanent (routes refer to it). */
export function parseFamilyPatch(body: Record<string, unknown>): Partial<Omit<RouteFamily, 'id'>> {
  refuseOwned(body, { id: "a family's id is permanent; add a new family instead" });
  const patch: Partial<Omit<RouteFamily, 'id'>> = {};
  if (body.name !== undefined) patch.name = required(body.name, 'name');
  if (body.color !== undefined) patch.color = color(body.color);
  if (body.sort !== undefined) patch.sort = sortOf(body.sort);
  return patch;
}

export function assertFamilyUnused(id: string, routes: number): void {
  if (routes > 0) refuse(`Family ${id} is used by ${routes} route${routes === 1 ? '' : 's'}: move them to another family first`, 409, 'family_in_use');
}

// ── Routes ──

/** What a route form or Love Kingdom sets. `sort` and the calendar are not among them. */
export type RouteFields = {
  name: string; kind: RouteKind; pier: string | null; family_id: string | null; color: string | null;
  islands: string | null; ext_id: string | null; times: string[];
};
export type NewRoute = { fields: Omit<RouteFields, 'family_id' | 'color'> & { family_id?: string | null; color?: string | null }; seasons: Omit<RouteSeason, 'id' | 'route_id'>[] };

/** Legacy's spellings, accepted beside ours (`b2c-catalog.js`, the route form). */
const ROUTE_ALIASES: Record<string, string> = { externalId: 'ext_id', familyId: 'family_id', dailyCap: 'daily_cap', mealVenueId: 'meal_venue_id' };
const withAliases = (body: Record<string, unknown>, aliases: Record<string, string>): Record<string, unknown> => {
  const out = { ...body };
  for (const [alias, name] of Object.entries(aliases)) {
    if (out[alias] === undefined) continue;
    if (out[name] === undefined) out[name] = out[alias];
    delete out[alias];
  }
  return out;
};

/** `daily_cap`, `code`, `meal_venue_id` are not kept here (decision 7): an empty one is fine, a real one is said. */
function refuseUnkept(body: Record<string, unknown>): void {
  const cap = body.daily_cap;
  if (!unset(cap) && cap !== 0) bad('daily_cap is not kept here: a land route sells without a limit (decided 2026-10-09)');
  if (!unset(body.code)) bad('code is not kept here (decided 2026-10-09)');
  if (!unset(body.meal_venue_id)) bad('meal_venue_id is not kept here yet: it moves with costing (decided 2026-10-09)');
}

const timesOf = (value: unknown): string[] => {
  if (!Array.isArray(value)) return bad('times must be a list of HH:MM times');
  const times = value.map((t, i) => (unset(t) ? '' : typeof t === 'string' ? t.trim() : bad(`times[${i}] must be a HH:MM time`))).filter(Boolean);
  const wrong = times.find((t) => !isIsoTime(t));
  if (wrong !== undefined) bad(`times: "${wrong}" is not a 24-hour HH:MM time`);
  return times;
};

const kindOf = (value: unknown): RouteKind | undefined =>
  unset(value) ? undefined : value === 'marine' || value === 'land' ? value : bad('kind must be marine or land');
const pierOf = (value: unknown): string | null => {
  const pier = text(value, 'pier');
  return pier === null || (PIERS as readonly string[]).includes(pier) ? pier : bad(`pier must be one of ${PIERS.join(', ')}`);
};

/** A marine route sails from one of the piers; a land route may name one (Love Kingdom's transfers to a pier). */
function assertShape(kind: RouteKind, pier: string | null): void {
  if (kind === 'marine' && pier === null) bad(`pier is required for a marine route: one of ${PIERS.join(', ')}`);
}

/**
 * `POST /v1/routes`. `pier: "other"` is legacy's old land marker and still means land. An absent
 * `family_id` is left out for `guessFamily`; a sent `null` or `""` means "no family", as the form's
 * blank choice does.
 */
export function parseNewRoute(raw: Record<string, unknown>): NewRoute {
  const body = withAliases(raw, ROUTE_ALIASES);
  refuseOwned(body, { id: 'a route id is assigned by the server', sort: 'POST /v1/routes/order orders routes', overrides: 'PUT /v1/routes/{id}/days/{date}' });
  refuseUnkept(body);
  const name = required(body.name, 'name');
  let pier = body.pier === 'other' ? null : pierOf(body.pier);
  const kind = kindOf(body.kind) ?? (body.pier === 'other' ? 'land' : pier !== null ? 'marine' : bad('kind is required: marine or land (land is a programme with no boat, e.g. a transfer or a city tour)'));
  if (body.pier === 'other') pier = null;
  assertShape(kind, pier);
  const extId = text(body.ext_id, 'ext_id');
  if (extId !== null && !EXT_ID.test(extId)) bad('ext_id must be 1-64 characters of A-Z a-z 0-9 . _ : - and start with a letter or digit');
  const fields: NewRoute['fields'] = {
    name, kind, pier, islands: text(body.islands, 'islands'), ext_id: extId,
    // Both legacy paths start a new route at 08:00 (the form's first row; b2c's default).
    times: body.times === undefined ? ['08:00'] : timesOf(body.times),
  };
  if (body.family_id !== undefined) fields.family_id = text(body.family_id, 'family_id');
  if (body.color !== undefined) fields.color = color(body.color);
  return { fields, seasons: seasonsOf(body.seasons) };
}

/** Love Kingdom's `seasons` on create: `[{kind|type, from_date|from, to_date|to}]`, as `b2c-catalog.js` takes them. */
function seasonsOf(value: unknown): NewRoute['seasons'] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return bad('seasons must be a list of { kind, from_date, to_date }');
  return value.map((raw, i) => {
    const s = isRecord(raw) ? raw : bad(`seasons[${i}] must be an object`);
    const kind = s.kind ?? s.type ?? 'open';
    if (kind !== 'open' && kind !== 'closed') bad(`seasons[${i}].kind must be open or closed`);
    const from = realDate(s.from_date ?? s.from, `seasons[${i}].from_date`), to = realDate(s.to_date ?? s.to, `seasons[${i}].to_date`);
    if (to < from) bad(`seasons[${i}]: to_date must not precede from_date`);
    return { kind: kind as 'open' | 'closed', from_date: from, to_date: to };
  });
}

/** `PATCH /v1/routes/{id}`: client facts only; the rest is refused naming what to use. */
export function parseRoutePatch(raw: Record<string, unknown>): Partial<RouteFields> {
  const body = withAliases(raw, ROUTE_ALIASES);
  refuseOwned(body, {
    id: 'a route id is permanent', sort: 'use POST /v1/routes/order', seasons: 'use POST /v1/routes/{id}/seasons',
    overrides: 'use PUT /v1/routes/{id}/days/{date}', days: 'use PUT /v1/routes/{id}/days/{date}',
  });
  refuseUnkept(body);
  const patch: Partial<RouteFields> = {};
  if (body.name !== undefined) patch.name = required(body.name, 'name');
  if (body.kind !== undefined) patch.kind = kindOf(body.kind) ?? bad('kind must be marine or land');
  if (body.pier !== undefined) {
    if (body.pier === 'other') { patch.kind = 'land'; patch.pier = null; } else patch.pier = pierOf(body.pier);
  }
  if (body.family_id !== undefined) patch.family_id = text(body.family_id, 'family_id');
  if (body.color !== undefined) patch.color = color(body.color);
  if (body.islands !== undefined) patch.islands = text(body.islands, 'islands');
  if (body.ext_id !== undefined) {
    const extId = text(body.ext_id, 'ext_id');
    if (extId !== null && !EXT_ID.test(extId)) bad('ext_id must be 1-64 characters of A-Z a-z 0-9 . _ : - and start with a letter or digit');
    patch.ext_id = extId;
  }
  if (body.times !== undefined) patch.times = timesOf(body.times);
  return patch;
}

/** A stored route as the fields a form edits. */
export const routeFields = (r: Route): RouteFields => ({
  name: r.name, kind: r.kind ?? 'marine', pier: r.pier ?? null, family_id: r.family_id ?? null, color: r.color ?? null,
  islands: r.islands ?? null, ext_id: r.ext_id ?? null, times: [...(r.times ?? [])],
});

/** The route after a `PATCH`. Legacy lets a route switch pier or kind with bookings on it, and so does this. */
export function patchedRoute(current: Route, patch: Partial<RouteFields>): RouteFields {
  const next = { ...routeFields(current), ...patch };
  assertShape(next.kind, next.pier);
  return next;
}

/**
 * The family a route goes under when Love Kingdom does not say (`b2c-catalog.js`): a land route is a
 * transfer unless its name says City Tour; a marine one by legacy's name ladder, in its order
 * ("Whale Shark Phi Phi Maiton" holds both Whale and Phi Phi; the first match wins). Undefined: no guess.
 */
export function guessFamily(name: string, kind: RouteKind): string | undefined {
  if (kind === 'land') return /city\s*tour/i.test(name) ? 'citytour' : 'transfer';
  if (name.includes('Nyaung') || name.includes('Oo Phee')) return 'nyaung';
  if (name.includes('Se La Va') || name.includes('SeLaVa')) return 'selava';
  if (name.includes('Whale')) return 'whaleshark';
  if (name.includes('Similan')) return 'similan';
  if (name.includes('Surin')) return 'surin';
  if (name.includes('Phi Phi')) return 'phiphi';
  if (name.includes('Krabi') || name.includes('Phang Nga')) return 'krabi';
  return undefined;
}

/** `family_id` must name a family (or be null: no family, not on the Booking calendar). */
export function assertFamily(familyId: string | null, families: ReadonlySet<string>): void {
  if (familyId !== null && !families.has(familyId)) bad(`family_id ${familyId} is not a family (GET /v1/route-families lists them)`);
}

/** A new route's whole row: id, colour in turn when none is sent, and a place after the last. */
export function newRoute(input: NewRoute['fields'], family: string | null, existing: readonly Route[], now: number): Route & { sort: number } {
  const id = nextCatalogueId('r', new Set(existing.map((r) => r.id)), now);
  const sort = existing.reduce((max, r) => Math.max(max, r.sort ?? -1), -1) + 1;
  return compactRoute({ ...input, id, family_id: family, color: input.color ?? ROUTE_COLORS[existing.length % ROUTE_COLORS.length], sort });
}

/** A route with no `undefined` and no `null` fields, as both stores list one. */
export const compactRoute = (r: Omit<RouteFields, 'family_id' | 'color'> & { id: string; sort?: number | null; family_id?: string | null; color?: string | null }): Route & { sort: number } => {
  const out: Route = { id: r.id, name: r.name, kind: r.kind };
  if (r.ext_id) out.ext_id = r.ext_id;
  if (r.pier) out.pier = r.pier;
  if (r.family_id) out.family_id = r.family_id;
  if (r.color) out.color = r.color;
  if (r.islands) out.islands = r.islands;
  if (r.sort !== undefined && r.sort !== null) out.sort = r.sort;
  out.times = [...r.times];
  return out as Route & { sort: number };
};

/** Two routes may not share a Love Kingdom code. */
export const extIdTaken = (extId: string, owner: string): never => refuse(`ext_id ${extId} already belongs to route ${owner}`, 409, 'ext_id_taken');

/** b2c's warning: another route already carries this name. */
export function duplicateNameWarnings(name: string, routes: readonly Route[], self?: string): { code: string; message: string }[] {
  const clash = routes.find((r) => r.id !== self && r.name.trim().toLowerCase() === name.toLowerCase());
  return clash ? [{ code: 'duplicate_name', message: `Route ${clash.id} already has this name: staff will see two entries called "${name}"` }] : [];
}

/** What refers to a route, by kind; a route anything refers to cannot be deleted (decision 6). */
export type RouteUsage = {
  bookings: number; deployments: number; seat_locks: number; rate_types: number; agents: number; contracts: number;
  van_days: number; van_groups: number; van_stops: number; upgrades: number; pickup_times: number;
};
const USAGE_LABEL: Record<keyof RouteUsage, [string, string]> = {
  bookings: ['booking', 'bookings'], deployments: ['boat deployment', 'boat deployments'], seat_locks: ['seat lock', 'seat locks'],
  rate_types: ['rate type', 'rate types'], agents: ["agent's programme list", "agents' programme lists"], contracts: ['contract', 'contracts'],
  van_days: ['van day', 'van days'], van_groups: ['van group', 'van groups'], van_stops: ['van stop', 'van stops'],
  upgrades: ['upgrade', 'upgrades'], pickup_times: ['pickup time', 'pickup times'],
};
export function assertRouteUnused(route: { id: string; name: string }, usage: RouteUsage): void {
  const used = (Object.keys(USAGE_LABEL) as (keyof RouteUsage)[]).filter((k) => usage[k] > 0)
    .map((k) => `${usage[k]} ${USAGE_LABEL[k][usage[k] === 1 ? 0 : 1]}`);
  if (used.length) refuse(`Route ${route.name} (${route.id}) is used by ${used.join(', ')}: it can't be deleted`, 409, 'route_in_use');
}

/**
 * Legacy's drag within one pier (`stApplyRouteOrder`): `route_ids` must be every route of that group,
 * each once (`pier: null` = the routes with no pier, the land ones). They take the group's places in
 * the list in their new order, and every route is renumbered 0..n-1. Answers each route's new `sort`.
 */
export function routeOrder(routes: readonly Route[], body: Record<string, unknown>): Map<string, number> {
  const pier = body.pier === undefined ? bad('pier is required: tublamu, panwa, ranong, or null for the routes with no pier') : pierOf(body.pier);
  const ids = Array.isArray(body.route_ids) && body.route_ids.every((id) => typeof id === 'string') ? body.route_ids as string[] : bad('route_ids must be a list of route ids');
  // `routes` in the order the store lists them, which is the order the screen shows.
  const list = [...routes];
  const group = list.filter((r) => (r.pier ?? null) === pier);
  const want = new Set(group.map((r) => r.id));
  if (ids.length !== group.length || new Set(ids).size !== ids.length || ids.some((id) => !want.has(id))) {
    bad(`route_ids must list every route ${pier ? `at ${pier}` : 'with no pier'} once: ${group.map((r) => r.id).join(', ') || 'there are none'}`);
  }
  let k = 0;
  const next = list.map((r) => ((r.pier ?? null) === pier ? ids[k++] : r.id));
  return new Map(next.map((id, sort) => [id, sort]));
}

// ── Boats ──

export type BoatDocument = { name: string; expires_on: string | null; renew_status: 'processing' | 'done' | null };
export type StatusEntry = {
  id: string; status: BoatStatus; from_date: string; to_date: string | null; loc: string | null; province: string | null;
  loc_type: string | null; detail: string | null; note: string | null; reason: string | null; project_id: string | null;
};
/** Free-text fields of the boat form. */
export const BOAT_TEXT_FIELDS = ['name_th', 'brand', 'model', 'vessel_use', 'material', 'reg', 'callsign', 'imo', 'build_year', 'homeport_city', 'homeport', 'owner', 'owner_addr', 'note'] as const;
/** Measurements on the form: numbers, 0 or more. */
export const BOAT_MEASURES = ['gt', 'nt', 'dwt', 'loa', 'beam', 'depth', 'draft', 'lbp', 'bhp'] as const;
type TextField = typeof BOAT_TEXT_FIELDS[number];
type Measure = typeof BOAT_MEASURES[number];

/** Every field of a boat as stored, both stores' shape. */
export type BoatRecord = { [K in TextField]: string | null } & { [K in Measure]: number | null } & {
  id: string; name: string; type: string | null; pier: string | null; ownership: 'own' | 'charter'; color: string | null;
  engine_count: number | null; capacity: number; license_pax: number | null; crew: number | null; fish_crew: number | null;
  registered_persons: number | null;
  retired: boolean; retired_on: string | null; retired_reason: string | null; unretired_on: string | null;
  documents: BoatDocument[]; status_log: StatusEntry[];
  /** Set by every API write; null = still legacy's copy (`seed:boats` may refresh it). */
  updated_at: string | null;
};
export type BoatFields = Omit<BoatRecord, 'id' | 'retired' | 'retired_on' | 'retired_reason' | 'unretired_on' | 'documents' | 'status_log' | 'updated_at'>;

export const copyBoat = (b: BoatRecord): BoatRecord => ({ ...b, documents: b.documents.map((d) => ({ ...d })), status_log: b.status_log.map((e) => ({ ...e })) });
/** The selling fields the rest of the service reads (`Boat`), with nothing for a field not set. */
export const boatOf = (b: BoatRecord): Boat => ({
  id: b.id, name: b.name, capacity: b.capacity,
  ...(b.type !== null ? { type: b.type } : {}), ...(b.pier !== null ? { pier: b.pier } : {}),
  ...(b.license_pax !== null ? { license_pax: b.license_pax } : {}), ...(b.crew !== null ? { crew: b.crew } : {}),
});

/** A boat with only the selling fields (a seed, or legacy's import before 070), the rest blank. */
export function blankBoat(b: { id: string; name: string; capacity: number; type?: string | null; pier?: string | null; license_pax?: number | null; crew?: number | null }): BoatRecord {
  const blanks = Object.fromEntries([...BOAT_TEXT_FIELDS, ...BOAT_MEASURES].map((k) => [k, null])) as { [K in TextField | Measure]: null };
  return {
    ...blanks, id: b.id, name: b.name, type: b.type ?? null, pier: b.pier ?? null, ownership: 'own', color: null, engine_count: null,
    capacity: b.capacity, license_pax: b.license_pax ?? null, crew: b.crew ?? null, fish_crew: null, registered_persons: null,
    retired: false, retired_on: null, retired_reason: null, unretired_on: null, documents: [], status_log: [], updated_at: null,
  };
}

/** Legacy's spellings on the boat form, accepted beside ours. */
const BOAT_ALIASES: Record<string, string> = {
  cap: 'capacity', licensePax: 'license_pax', fishcrew: 'fish_crew', totalcap: 'registered_persons', nameTh: 'name_th', use: 'vessel_use',
  year: 'build_year', engineCount: 'engine_count', homeportCity: 'homeport_city', ownerAddr: 'owner_addr', docs: 'documents',
};
const BOAT_OWNED: Record<string, string> = {
  id: 'a boat id is assigned by the server', retired: 'use POST /v1/boats/{id}/retire or /restore', retired_on: 'use POST /v1/boats/{id}/retire',
  retired_reason: 'use POST /v1/boats/{id}/retire', unretired_on: 'use POST /v1/boats/{id}/restore', status_log: 'use POST /v1/boats/{id}/status-log',
  log: 'use POST /v1/boats/{id}/status-log', status_today: 'it is computed from the status log', charter_ceiling: 'it is computed from the licence',
  updated_at: 'it is the server\'s',
};

/** A positive whole number. */
const positive = (value: unknown, name: string): number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : bad(`${name} must be a whole number above 0`);
/** A whole number, or none: blank and 0 are "none", as legacy's `parseInt(…)||null`. */
const wholeOrNone = (value: unknown, name: string): number | null => {
  if (unset(value) || value === 0) return null;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : bad(`${name} must be a whole number, 0 or more`);
};
const measure = (value: unknown, name: string): number | null => {
  if (unset(value)) return null;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : bad(`${name} must be a number, 0 or more`);
};
const pickable = (value: unknown, name = 'status'): typeof PICKABLE_STATUSES[number] =>
  (PICKABLE_STATUSES as readonly unknown[]).includes(value) ? value as typeof PICKABLE_STATUSES[number] : bad(`${name} must be one of ${PICKABLE_STATUSES.join(', ')}`);

function documentsOf(value: unknown): BoatDocument[] {
  if (value === null) return [];
  if (!Array.isArray(value)) return bad('documents must be a list of { name, expires_on }');
  return value.map((raw, i) => {
    const d = isRecord(raw) ? raw : bad(`documents[${i}] must be an object`);
    const renew = d.renew_status ?? d.renewStatus;
    if (!unset(renew) && renew !== 'processing' && renew !== 'done') bad(`documents[${i}].renew_status must be processing, done or empty`);
    return { name: required(d.name, `documents[${i}].name`), expires_on: optionalDate(d.expires_on ?? d.exp, `documents[${i}].expires_on`), renew_status: unset(renew) ? null : renew as 'processing' | 'done' };
  });
}

export type BoatInput = { fields: Partial<BoatFields>; documents?: BoatDocument[]; status?: typeof PICKABLE_STATUSES[number] };

/**
 * The boat form (`saveBoat`) for `POST` (`create`) and `PATCH`. On create the form's defaults apply:
 * 40 seats, 4 engines, a company boat, and the total persons as licence + crew + fishing crew
 * (`fmCalcTotal`). `status` is the form's status pick.
 */
export function parseBoatInput(raw: Record<string, unknown>, mode: 'create' | 'patch'): BoatInput {
  const body = withAliases(raw, BOAT_ALIASES);
  refuseOwned(body, BOAT_OWNED);
  const has = (k: string) => body[k] !== undefined;
  const f: Partial<BoatFields> = {};
  if (mode === 'create' || has('name')) f.name = required(body.name, 'name');
  if (has('type')) {
    const type = text(body.type, 'type');
    if (type !== null && !(BOAT_TYPES as readonly string[]).includes(type)) bad(`type must be one of ${BOAT_TYPES.join(', ')}`);
    f.type = type;
  }
  if (mode === 'create' || has('pier')) f.pier = pierOf(body.pier) ?? bad(`pier is required: one of ${PIERS.join(', ')}`);
  if (has('ownership')) f.ownership = body.ownership === 'own' || body.ownership === 'charter' ? body.ownership : bad('ownership must be own or charter');
  else if (mode === 'create') f.ownership = 'own';
  if (has('color')) f.color = color(body.color);
  if (has('engine_count')) {
    const n = body.engine_count;
    f.engine_count = unset(n) ? null : typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 5 ? n : bad('engine_count must be 1 to 5');
  } else if (mode === 'create') f.engine_count = 4;
  // Legacy turns a blank capacity into 40; a capacity that is sent must be a real number of seats.
  if (has('capacity') && body.capacity !== null && body.capacity !== '') f.capacity = positive(body.capacity, 'capacity');
  else if (mode === 'create') f.capacity = 40;
  else if (has('capacity')) bad('capacity must be a whole number above 0');
  for (const k of ['license_pax', 'crew', 'fish_crew', 'registered_persons'] as const) if (has(k)) f[k] = wholeOrNone(body[k], k);
  if (mode === 'create' && !has('registered_persons')) f.registered_persons = (f.license_pax ?? 0) + (f.crew ?? 0) + (f.fish_crew ?? 0) || null;
  for (const k of BOAT_TEXT_FIELDS) if (has(k)) f[k] = text(body[k], k);
  for (const k of BOAT_MEASURES) if (has(k)) f[k] = measure(body[k], k);
  const out: BoatInput = { fields: f };
  if (has('documents')) out.documents = documentsOf(body.documents);
  if (has('status')) out.status = pickable(body.status);
  return out;
}

/** Warnings a saved boat carries: selling above the licence is legacy's to allow (decision 4), and said. */
export function boatWarnings(b: Pick<BoatRecord, 'capacity' | 'license_pax'>): { code: string; message: string }[] {
  return b.license_pax !== null && b.capacity > b.license_pax
    ? [{ code: 'capacity_above_licence', message: `Capacity ${b.capacity} is above the licence of ${b.license_pax}: at most ${b.license_pax} seats are sold a day` }]
    : [];
}

// ── The status log (`boats.log`) ──

const day = (date: string, delta: number): string => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
};

/**
 * Legacy `getStoredStatus`: of the entries covering `date`, the one starting latest; two starting the
 * same day, the one added later. None covers it: a company boat is available, a charter boat is not
 * (a charter's log lists the days it is ours, `§chWin`).
 */
export function storedStatus(log: readonly StatusEntry[], ownership: 'own' | 'charter', date: string): BoatStatus {
  const hit = log.map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.from_date < b.e.from_date ? 1 : a.e.from_date > b.e.from_date ? -1 : b.i - a.i))
    .find(({ e }) => e.from_date <= date && (e.to_date === null || e.to_date >= date));
  return hit ? hit.e.status : ownership === 'charter' ? 'unavailable' : 'available';
}

/**
 * Legacy `autoClosePrevLog`, before an entry `from..to` (`to` null = open-ended) is added: an entry
 * running into it ends the day before (keeping its part after `to` as a new entry), and one starting
 * inside it is cut to after `to`, or removed. `newId` names a split-off tail.
 */
export function closeOverlaps(log: readonly StatusEntry[], from: string, to: string | null, newId: () => string): StatusEntry[] {
  const out: StatusEntry[] = [];
  const tails: StatusEntry[] = [];
  for (const entry of log) {
    const e = { ...entry };
    if (e.from_date < from) {
      if (e.to_date === null || e.to_date >= from) {
        if (to !== null && (e.to_date === null || e.to_date > to)) tails.push({ ...e, id: newId(), from_date: day(to, 1), to_date: e.to_date });
        e.to_date = day(from, -1);
      }
      out.push(e);
    } else if (to === null || e.from_date <= to) {
      // Starts inside the new range: what runs past `to` is kept, the rest goes.
      if (to !== null && (e.to_date === null || e.to_date > to)) out.push({ ...e, from_date: day(to, 1) });
    } else out.push(e);
  }
  return [...out, ...tails];
}

/** An id for a new entry (`'sl' + Date.now()`), unique on this boat. */
export const entryIdMaker = (log: readonly StatusEntry[], now: number): (() => string) => {
  const taken = new Set(log.map((e) => e.id));
  return () => { const id = nextCatalogueId('sl', taken, now); taken.add(id); return id; };
};

/**
 * The boat form's status pick (`saveBoat`): a new boat starts its log with it; an edited boat gets a
 * new open-ended entry from today when it differs from today's stored status, after closing what it
 * overlaps. Its place is the boat's pier.
 */
export function withFormStatus(log: readonly StatusEntry[], ownership: 'own' | 'charter', pier: string | null, status: BoatStatus, today: string, now: number, created = false): StatusEntry[] {
  if (!created && storedStatus(log, ownership, today) === status) return log.map((e) => ({ ...e }));
  const newId = entryIdMaker(log, now);
  const closed = closeOverlaps(log, today, null, newId);
  return [...closed, entry({ id: newId(), status, from_date: today, loc: pier ? PIER_LABEL[pier] ?? pier : null })];
}

const entry = (e: Partial<StatusEntry> & Pick<StatusEntry, 'id' | 'status' | 'from_date'>): StatusEntry => ({
  to_date: null, loc: null, province: null, loc_type: null, detail: null, note: null, reason: null, project_id: null, ...e,
});

/** An entry's fields from `POST`/`PATCH /v1/boats/{id}/status-log`; an absent field is unchanged. */
export function parseStatusEntry(body: Record<string, unknown>): Partial<StatusEntry> {
  refuseOwned(body, { id: 'an entry id is assigned by the server', project_id: 'it is set by fleet maintenance' });
  const e: Partial<StatusEntry> = {};
  if (body.status !== undefined) e.status = pickable(body.status);
  if (body.from_date !== undefined) e.from_date = realDate(body.from_date, 'from_date');
  if (body.to_date !== undefined) e.to_date = optionalDate(body.to_date, 'to_date');
  for (const k of ['loc', 'province', 'loc_type', 'detail', 'note', 'reason'] as const) if (body[k] !== undefined) e[k] = text(body[k], k);
  return e;
}

/** Legacy `saveStatus`'s checks, on the entry as it will be saved. */
export function assertStatusEntry(e: Partial<StatusEntry>): asserts e is StatusEntry {
  if (e.status === undefined || e.status === 'retired') pickable(e.status);
  if (!e.from_date) bad('from_date is required');
  if (!e.to_date) bad('to_date is required');
  if (e.to_date! < e.from_date!) bad('to_date must not precede from_date');
  if (!e.province) bad('province is required');
  if (!e.loc_type) bad('loc_type is required');
  if (e.status === 'unavailable' && !e.reason) bad('reason is required when the boat is unavailable');
}

/** `POST /v1/boats/{id}/status-log`: the entry closes or trims what it overlaps first (`autoClosePrevLog`). */
export function addStatusEntry(log: readonly StatusEntry[], fields: Partial<StatusEntry>, now: number): { log: StatusEntry[]; entry: StatusEntry } {
  const newId = entryIdMaker(log, now);
  const added = entry({ ...fields, id: newId() } as StatusEntry);
  assertStatusEntry(added);
  return { log: [...closeOverlaps(log, added.from_date, added.to_date, newId), added], entry: added };
}

/** `PATCH /v1/boats/{id}/status-log/{entry_id}`: in place, nothing else moves (legacy `editStatus`). */
export function editStatusEntry(log: readonly StatusEntry[], id: string, fields: Partial<StatusEntry>): { log: StatusEntry[]; entry: StatusEntry } {
  const current = log.find((e) => e.id === id) ?? refuse('Status entry not found', 404);
  const edited = { ...current, ...fields };
  assertStatusEntry(edited);
  return { log: log.map((e) => (e.id === id ? edited : { ...e })), entry: edited };
}

// ── Retire and restore (decision 13; legacy `flRetireBoat`, `flUnretireBoat`) ──

export function retiredBoat(b: BoatRecord, future: readonly Pick<Deployment, 'service_date' | 'route_id'>[], reason: string | null, today: string, now: number): BoatRecord {
  if (b.retired) refuse(`${b.name} is already retired`, 409, 'already_retired');
  if (future.length) {
    const days = future.slice(0, 5).map((d) => `${d.service_date} (${d.route_id})`).join(', ');
    refuse(`${b.name} is deployed on ${future.length} day(s) from today: ${days}${future.length > 5 ? ', …' : ''}. Take it off them first`, 409, 'future_deployments');
  }
  const id = entryIdMaker(b.status_log, now)();
  return {
    ...copyBoat(b), retired: true, retired_on: today, retired_reason: reason,
    status_log: [...b.status_log.map((e) => ({ ...e })), entry({ id, status: 'retired', from_date: today, loc: '', note: `ปลดระวางเรือ${reason ? ` · ${reason}` : ''}` })],
  };
}

export function restoredBoat(b: BoatRecord, today: string, now: number): BoatRecord {
  if (!b.retired) refuse(`${b.name} is not retired`, 409, 'not_retired');
  const id = entryIdMaker(b.status_log, now)();
  return {
    ...copyBoat(b), retired: false, unretired_on: today,
    status_log: [...b.status_log.map((e) => ({ ...e })), entry({ id, status: 'available', from_date: today, loc: '', note: 'กู้คืนเรือกลับมาใช้งาน' })],
  };
}

/** The boat as the API shows it: every stored field, the charter ceiling, and today's stored status. */
export const boatView = (b: BoatRecord, today: string) => ({
  ...copyBoat(b),
  charter_ceiling: charterCeiling({ capacity: b.capacity, license_pax: b.license_pax ?? undefined }),
  status_today: storedStatus(b.status_log, b.ownership, today),
});

// ── A capacity change reaches the boat's future deployments (decision 5) ──

export type DeploymentDay = {
  deployment: Deployment; override_capacity?: number;
  /** Passengers placed on the boat that day (`placedOn`, deployment guards). */
  placed: { bookings: number; pax: number; charter: string | null };
};
export type OversoldWarning = { code: 'oversold'; route_id: string; service_date: string; boat_id: string; bookings: number; pax: number; seats: number };
type Seats = { capacity: number; license_pax: number | null };
/** Whether a day loses seats (sellable or licensed) by the change: only those need their passengers weighed. */
export function seatsDrop(before: Seats, after: Seats, overrideCapacity: number | undefined): boolean {
  const seats = (s: Seats) => deploymentSeats({ capacity: s.capacity, license_pax: s.license_pax ?? undefined, override_capacity: overrideCapacity });
  const a = seats(before), b = seats(after);
  return b.sellable < a.sellable || b.licensed < a.licensed;
}

/**
 * Weighs each future day of the boat with its new seats (a day override still wins; a chartered day
 * is weighed against the licence). A day whose seats drop below the passengers placed on it needs
 * `capacity_anyway` (`409 seats_sold`, like the deployment guards); with it, each is a warning.
 */
export function capacityChange(boatName: string, before: Seats, after: Seats, days: readonly DeploymentDay[], anyway: boolean): OversoldWarning[] {
  const limit = (s: Seats, d: DeploymentDay) => {
    const seats = deploymentSeats({ capacity: s.capacity, license_pax: s.license_pax ?? undefined, override_capacity: d.override_capacity });
    return d.placed.charter ? seats.licensed : seats.sellable;
  };
  const over = days.filter((d) => limit(after, d) < limit(before, d) && d.placed.pax > limit(after, d))
    .map((d): OversoldWarning => ({ code: 'oversold', route_id: d.deployment.route_id, service_date: d.deployment.service_date, boat_id: d.deployment.boat_id, bookings: d.placed.bookings, pax: d.placed.pax, seats: limit(after, d) }));
  if (over.length && !anyway) {
    const list = over.slice(0, 5).map((w) => `${w.service_date} (${w.route_id}: ${w.bookings} booking(s), ${w.pax} pax, ${w.seats} seats)`).join(', ');
    refuse(`${boatName} would carry more passengers than its seats on ${over.length} day(s): ${list}${over.length > 5 ? ', …' : ''}. Send capacity_anyway: true to go ahead`, 409, 'seats_sold');
  }
  return over;
}

/** The numbers a deployment copies from its boat. */
export const deploymentNumbers = (b: Pick<BoatRecord, 'capacity' | 'license_pax' | 'registered_persons'>): Pick<Deployment, 'capacity' | 'license_pax' | 'registered_persons'> => ({
  capacity: b.capacity, license_pax: b.license_pax ?? undefined, registered_persons: b.registered_persons ?? b.capacity,
});

// ── A boat's seats for one day (decision 10; legacy `boatCapSet`) ──

export type StoredOverride = { boat_id: string; service_date: string; capacity: number; reason: string | null; set_by: string | null; set_at: string | null };
export type OverrideDay = {
  boat_id: string; service_date: string;
  /** What the day sells from: the override clamped to the ceiling, else normal. */
  capacity: number; normal: number; ceiling: number; overridden: boolean;
  reason: string | null; set_by: string | null; set_at: string | null;
};

/** Normal: the day's deployment capacity, else the boat's. Ceiling: the licence, else the boat's capacity (`boatCapLicense`). */
export function overrideDay(boat: Pick<BoatRecord, 'id' | 'capacity' | 'license_pax'>, date: string, deployment: Pick<Deployment, 'capacity'> | undefined, stored: StoredOverride | undefined): OverrideDay {
  const normal = deployment?.capacity ?? boat.capacity;
  const ceiling = boat.license_pax ?? boat.capacity;
  const capacity = stored ? Math.min(stored.capacity, ceiling) : normal;
  return {
    boat_id: boat.id, service_date: date, capacity, normal, ceiling, overridden: !!stored && capacity !== normal,
    reason: stored?.reason ?? null, set_by: stored?.set_by ?? null, set_at: stored?.set_at ?? null,
  };
}

export function parseOverrideRequest(body: Record<string, unknown>): { capacity: number; reason: string | null } {
  const capacity = body.capacity;
  if (!(typeof capacity === 'number' && Number.isInteger(capacity) && capacity >= 0)) bad('capacity must be a whole number, 0 or more');
  return { capacity: capacity as number, reason: text(body.reason, 'reason') };
}

/** No past day can change (decision 10). */
export function assertNotPast(boatName: string, date: string, today: string): void {
  if (date < today) refuse(`${date} is in the past: ${boatName}'s seats for that day can't change`, 409, 'past_date');
}

/**
 * Legacy `_bcapSave`: over the licence is refused here (legacy clamped it); the normal number
 * removes the override; any other needs a reason; raising above normal and above what the day has
 * now needs `act-capunlock` or an admin. Answers what to write.
 */
export function planOverride(req: { capacity: number; reason: string | null }, day: OverrideDay, ctx: { boatName: string; mayRaise: boolean }): { remove: true } | { remove: false; capacity: number; reason: string } {
  if (req.capacity > day.ceiling) bad(`${ctx.boatName} is licensed for ${day.ceiling} passengers: the day's seats can't be more`);
  if (req.capacity === day.normal) return { remove: true };
  if (!req.reason) bad(`reason is required: say why ${day.service_date} differs from the normal ${day.normal} seats`);
  if (req.capacity > day.normal && req.capacity > day.capacity && !ctx.mayRaise) {
    refuse('Not allowed: raising a boat above its normal capacity needs the special permission "unlock boat capacity". Ask an admin or a user who has it.', 403, 'forbidden');
  }
  return { remove: false, capacity: req.capacity, reason: req.reason! };
}
