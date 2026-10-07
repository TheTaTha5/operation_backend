/**
 * Rate types: the price lists agents are sold at.
 *
 * Both stores hold the same rows, one record per table row (`RateTypeRows`), and hand them here.
 * Everything the API says is decided in this file, once: how a request is read and refused, which
 * zones a route takes, how a request becomes rows, and how rows become the detail and the summary.
 * The in-process store has no database, so writing any of it as SQL would need a second copy
 * (CLAUDE.md, "Logic that both stores need goes in a pure function both call").
 *
 * Pricing a booking from these rows is a later slice (`todo/rate-types-model.md`, "Not this slice").
 */

/** A refusal in the existing `{ statusCode, error, message }` shape. */
const refuse = (message: string, statusCode: 400 | 404 | 409, code?: string): never => {
  const error = new Error(message) as Error & { statusCode: number; code?: string };
  error.statusCode = statusCode;
  if (code) error.code = code;
  throw error;
};
const badRequest = (message: string): never => refuse(message, 400);

// ── Vocabulary ───────────────────────────────────────────────────────────────────────────────────

/**
 * A seat price is keyed the way a booking's pax grid is (`src/domain/pax.ts`), so a quote is price
 * × pax key by key. A rate is always foreign or Thai; legacy prices an unsuffixed pax as foreign.
 */
export const RATE_PAX_KEYS = ['ad_fr', 'chd_fr', 'inf_fr', 'ad_th', 'chd_th', 'inf_th'] as const;
export type RatePaxKey = typeof RATE_PAX_KEYS[number];
type SeatCategory = 'ad' | 'chd' | 'inf';
type RateResidency = 'foreign' | 'thai';
const CELL: Record<RatePaxKey, { category: SeatCategory; residency: RateResidency }> = {
  ad_fr: { category: 'ad', residency: 'foreign' }, chd_fr: { category: 'chd', residency: 'foreign' }, inf_fr: { category: 'inf', residency: 'foreign' },
  ad_th: { category: 'ad', residency: 'thai' }, chd_th: { category: 'chd', residency: 'thai' }, inf_th: { category: 'inf', residency: 'thai' },
};
const keyOf = (category: string, residency: string): RatePaxKey => `${category}_${residency === 'thai' ? 'th' : 'fr'}` as RatePaxKey;

/** Only `net` is ever billed; `sell` and `min_sell` are printed on contracts. */
export const RATE_TIERS = ['net', 'sell', 'min_sell'] as const;
export type RateTier = typeof RATE_TIERS[number];
export const BOAT_TYPES = ['speedboat', 'catamaran', 'longtail'] as const;
export type BoatType = typeof BOAT_TYPES[number];
export const VEHICLES = ['sedan', 'van'] as const;
export type Vehicle = typeof VEHICLES[number];
export const NATIONALITY_SCOPES = ['both', 'thai', 'foreign'] as const;
export type NationalityScope = typeof NATIONALITY_SCOPES[number];
export const BUNDLE_MODES = ['free', 'paid'] as const;
export type BundleMode = typeof BUNDLE_MODES[number];
export const BUNDLE_APPLIES_TO = ['seat', 'charter', 'both'] as const;
export type BundleAppliesTo = typeof BUNDLE_APPLIES_TO[number];

const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === 'string' && (list as readonly string[]).includes(value);

/**
 * The pickup zones a route is priced by: Ranong's pier collects from `RN`, every other route —
 * land routes included, which are priced by the zone the guest is collected from — from `PK`, `KL`
 * or `NoTransfer`. Legacy's `rtZonesForRoute` and `b2c-catalog.js` `zonesFor`.
 */
export const zonesForRoute = (route: { pier?: string }): readonly string[] =>
  route.pier === 'ranong' ? ['RN', 'NoTransfer'] : ['PK', 'KL', 'NoTransfer'];

// ── Rows: what both stores hold ──────────────────────────────────────────────────────────────────

/** One row per table. Absent values are null, never undefined, so the two stores compare equal. */
export type RateTypeRow = {
  id: string; code: string; name: string; note: string | null; color: string | null; owner_sales_id: string | null;
  valid_from: string | null; valid_to: string | null; active: boolean; nationality_scope: NationalityScope | null;
  transfer_unit: string | null; created_on: string | null; created_at: string; updated_at: string;
};
export type RateRouteRow = {
  rate_type_id: string; route_id: string; seq: number; travel_from: string | null; travel_to: string | null;
  longtail_bundle: BundleMode | null; longtail_bundle_adult: number | null; longtail_bundle_child: number | null;
  longtail_bundle_applies_to: BundleAppliesTo | null;
};
export type SeatPriceRow = { rate_type_id: string; route_id: string; zone: string; category: SeatCategory; residency: RateResidency; tier: RateTier; price: number };
export type CharterPriceRow = { rate_type_id: string; route_id: string; boat_type: string; starter_price: number | null; starter_includes: number | null; extra_per_pax: number | null };
export type LongtailPriceRow = { rate_type_id: string; route_id: string; join_adult: number | null; join_child: number | null; charter_price: number | null; charter_capacity: number | null };
export type TransferPriceRow = { rate_type_id: string; route_id: string; zone: string; vehicle: string; price: number };

/** One route's rows. */
export type RouteRows = { route: RateRouteRow; seat: SeatPriceRow[]; charter: CharterPriceRow[]; longtail: LongtailPriceRow[]; transfer: TransferPriceRow[] };
/** A whole rate type: its row and every row under it, in any order. */
export type RateTypeRows = { rate: RateTypeRow; routes: RateRouteRow[]; seat: SeatPriceRow[]; charter: CharterPriceRow[]; longtail: LongtailPriceRow[]; transfer: TransferPriceRow[] };

// ── The API's shapes ─────────────────────────────────────────────────────────────────────────────

type Grid = Partial<Record<RatePaxKey, number>>;
export type ZonePrices = Partial<Record<RateTier, Grid>>;
export type CharterPrice = { starter_price: number | null; starter_includes: number | null; extra_per_pax: number | null };
export type LongtailPrice = { join_adult: number | null; join_child: number | null; charter_price: number | null; charter_capacity: number | null };
export type LongtailBundle = { mode: BundleMode; adult: number | null; child: number | null; applies_to: BundleAppliesTo | null };

/** One covered route with every price on it. Maps list only what is set: a zone with no prices is not offered. */
export type RateRoute = {
  route_id: string; travel_from: string | null; travel_to: string | null; longtail_bundle: LongtailBundle | null;
  zones: Record<string, ZonePrices>; charter: Record<string, CharterPrice>; longtail: LongtailPrice | null;
  transfer: Record<string, Partial<Record<string, number>>>;
};

/** `GET /v1/rate-types`: the frontend's `ObRateTypeSummary`, plus `nationality_scope`. */
export type RateTypeSummary = {
  id: string; code: string; name: string; color: string | null; active: boolean; owner: string | null;
  valid_from: string | null; valid_to: string | null; nationality_scope: NationalityScope | null;
  priced_routes: string[]; route_validity: Record<string, { from: string | null; to: string | null }>;
};
export type RateType = RateTypeSummary & {
  note: string | null; transfer_unit: string | null; created_on: string | null; created_at: string; updated_at: string;
  routes: RateRoute[];
};

/** Routes in their order; a missing `seq` cannot happen, the id only breaks a tie both stores would otherwise order differently. */
const bySeq = (a: RateRouteRow, b: RateRouteRow) => a.seq - b.seq || (a.route_id < b.route_id ? -1 : 1);

export function rateRouteView(route: RateRouteRow, rows: Omit<RateTypeRows, 'rate' | 'routes'>): RateRoute {
  const mine = <T extends { route_id: string }>(list: readonly T[]) => list.filter((row) => row.route_id === route.route_id);
  const zones: Record<string, ZonePrices> = {};
  for (const row of mine(rows.seat)) {
    const zone = (zones[row.zone] ??= {});
    (zone[row.tier] ??= {})[keyOf(row.category, row.residency)] = row.price;
  }
  const charter: Record<string, CharterPrice> = {};
  for (const row of mine(rows.charter)) charter[row.boat_type] = { starter_price: row.starter_price, starter_includes: row.starter_includes, extra_per_pax: row.extra_per_pax };
  const transfer: Record<string, Partial<Record<string, number>>> = {};
  for (const row of mine(rows.transfer)) (transfer[row.zone] ??= {})[row.vehicle] = row.price;
  const longtail = mine(rows.longtail)[0];
  return {
    route_id: route.route_id, travel_from: route.travel_from, travel_to: route.travel_to,
    longtail_bundle: route.longtail_bundle === null ? null
      : { mode: route.longtail_bundle, adult: route.longtail_bundle_adult, child: route.longtail_bundle_child, applies_to: route.longtail_bundle_applies_to },
    zones, charter,
    longtail: longtail ? { join_adult: longtail.join_adult, join_child: longtail.join_child, charter_price: longtail.charter_price, charter_capacity: longtail.charter_capacity } : null,
    transfer,
  };
}

/**
 * A route is priced when some zone offers it: a net adult price above 0, foreign or Thai. Both
 * adult prices at 0 is legacy's "not offered" (`bkV2TripSubtotal`), and so is a zone with no rows.
 * Legacy's `agRtRoutes` combined with that rule.
 */
export const isPricedRoute = (route: RateRoute): boolean =>
  Object.values(route.zones).some((zone) => (zone.net?.ad_fr ?? 0) > 0 || (zone.net?.ad_th ?? 0) > 0);

export function rateTypeView(rows: RateTypeRows): RateType {
  const routes = [...rows.routes].sort(bySeq).map((route) => rateRouteView(route, rows));
  const r = rows.rate;
  const route_validity: RateTypeSummary['route_validity'] = {};
  for (const route of routes) if (route.travel_from !== null || route.travel_to !== null) route_validity[route.route_id] = { from: route.travel_from, to: route.travel_to };
  return {
    id: r.id, code: r.code, name: r.name, color: r.color, active: r.active, owner: r.owner_sales_id,
    valid_from: r.valid_from, valid_to: r.valid_to, nationality_scope: r.nationality_scope,
    priced_routes: routes.filter(isPricedRoute).map((route) => route.route_id), route_validity,
    note: r.note, transfer_unit: r.transfer_unit, created_on: r.created_on, created_at: r.created_at, updated_at: r.updated_at,
    routes,
  };
}

export function rateTypeSummary(rows: RateTypeRows): RateTypeSummary {
  const { note: _n, transfer_unit: _t, created_on: _c, created_at: _ca, updated_at: _u, routes: _r, ...summary } = rateTypeView(rows);
  return summary;
}

/** `active: undefined` means both active and inactive. */
export type RateTypeListQuery = { active?: boolean; q?: string };

/** The rate types a list asks for, A–Z by name (case-insensitive), then id; `q` matches code or name. */
export function selectRateTypes(all: readonly RateTypeRows[], query: RateTypeListQuery): RateTypeSummary[] {
  const needle = query.q?.trim().toLowerCase();
  return all
    .filter(({ rate }) => (query.active === undefined || rate.active === query.active)
      && (!needle || rate.code.toLowerCase().includes(needle) || rate.name.toLowerCase().includes(needle)))
    .sort((a, b) => a.rate.name.localeCompare(b.rate.name, 'en', { sensitivity: 'base' }) || (a.rate.id < b.rate.id ? -1 : a.rate.id > b.rate.id ? 1 : 0))
    .map(rateTypeSummary);
}

// ── Reading a request ────────────────────────────────────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar date: the shape alone lets `2026-02-31` through, and legacy holds a `20207-05-15`. */
export const isRealDate = (value: unknown): value is string =>
  typeof value === 'string' && ISO_DATE.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

const record = (value: unknown, label: string): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : badRequest(`${label} must be an object`);
/** Absent, null or blank is "not set"; anything else must be a string. */
const optionalText = (value: unknown, label: string): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return badRequest(`${label} must be a string`);
  return value.trim() === '' ? null : value.trim();
};
const optionalDate = (value: unknown, label: string): string | null => {
  if (value === undefined || value === null || value === '') return null;
  return isRealDate(value) ? value : badRequest(`${label} must be a real date, YYYY-MM-DD`);
};
const price = (value: unknown, label: string): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : badRequest(`${label} must be a number ≥ 0`);
const optionalPrice = (value: unknown, label: string): number | null => (value === undefined || value === null ? null : price(value, label));
const optionalCount = (value: unknown, label: string, min: number): number | null => {
  if (value === undefined || value === null) return null;
  return typeof value === 'number' && Number.isInteger(value) && value >= min ? value : badRequest(`${label} must be a whole number ≥ ${min}`);
};
const assertOrder = (from: string | null, to: string | null, message: string): void => { if (from !== null && to !== null && from > to) badRequest(message); };

/** A zone name as a key: short, no spaces, so it cannot be a typo'd sentence. Which zones a route takes is `zonesForRoute`. */
const ZONE = /^[A-Za-z][A-Za-z0-9_]{0,23}$/;
const zoneName = (zone: string, label: string): string => (ZONE.test(zone) ? zone : badRequest(`${label} is not a zone name`));

/** One route's prices, as `PUT /v1/rate-types/{id}/routes/{route_id}` and each `routes[]` entry carry them. */
export type RouteBlock = Omit<RateRoute, 'route_id'>;

/**
 * Reads one route's block. Prices are numbers ≥ 0; a `null` cell is "not set" and stored as no row.
 * Unknown keys inside a price map are refused, because each one is a price that would otherwise be
 * dropped without a word — the failure this whole table exists to end.
 */
export function parseRouteBlock(value: unknown, label: string): RouteBlock {
  const input = record(value, label || 'body');
  const at = (key: string) => (label ? `${label}.${key}` : key);

  const travel_from = optionalDate(input.travel_from, at('travel_from'));
  const travel_to = optionalDate(input.travel_to, at('travel_to'));
  assertOrder(travel_from, travel_to, `${at('travel_from')} must not be after travel_to`);

  let longtail_bundle: LongtailBundle | null = null;
  if (input.longtail_bundle !== undefined && input.longtail_bundle !== null) {
    const b = record(input.longtail_bundle, at('longtail_bundle'));
    if (!oneOf(BUNDLE_MODES, b.mode)) badRequest(`${at('longtail_bundle.mode')} must be free or paid`);
    const applies = b.applies_to === undefined || b.applies_to === null ? null
      : oneOf(BUNDLE_APPLIES_TO, b.applies_to) ? b.applies_to : badRequest(`${at('longtail_bundle.applies_to')} must be seat, charter or both`);
    const adult = optionalPrice(b.adult, at('longtail_bundle.adult'));
    const child = optionalPrice(b.child, at('longtail_bundle.child'));
    // Legacy zeroes the price when a bundle is switched to free (`rtSetBundleMode`).
    if (b.mode === 'free' && ((adult ?? 0) > 0 || (child ?? 0) > 0)) badRequest(`${at('longtail_bundle')} is free, so it has no adult or child price`);
    longtail_bundle = { mode: b.mode as BundleMode, adult, child, applies_to: applies };
  }

  const zones: Record<string, ZonePrices> = {};
  for (const [zone, tiersValue] of Object.entries(input.zones === undefined || input.zones === null ? {} : record(input.zones, at('zones')))) {
    const zoneLabel = at(`zones.${zone}`);
    zoneName(zone, zoneLabel);
    const tiers: ZonePrices = {};
    for (const [tier, gridValue] of Object.entries(record(tiersValue, zoneLabel))) {
      if (!oneOf(RATE_TIERS, tier)) badRequest(`${zoneLabel}.${tier} is not a price tier: use net, sell or min_sell`);
      const grid: Grid = {};
      for (const [key, cell] of Object.entries(record(gridValue, `${zoneLabel}.${tier}`))) {
        if (!oneOf(RATE_PAX_KEYS, key)) badRequest(`${zoneLabel}.${tier}.${key} is not a pax key: use ${RATE_PAX_KEYS.join(', ')}`);
        if (cell !== null) grid[key as RatePaxKey] = price(cell, `${zoneLabel}.${tier}.${key}`);
      }
      if (Object.keys(grid).length > 0) tiers[tier as RateTier] = grid;
    }
    if (Object.keys(tiers).length > 0) zones[zone] = tiers;
  }

  const charter: Record<string, CharterPrice> = {};
  for (const [boatType, rowValue] of Object.entries(input.charter === undefined || input.charter === null ? {} : record(input.charter, at('charter')))) {
    const rowLabel = at(`charter.${boatType}`);
    if (!oneOf(BOAT_TYPES, boatType)) badRequest(`${rowLabel} is not a boat type: use ${BOAT_TYPES.join(', ')}`);
    const row = record(rowValue, rowLabel);
    charter[boatType] = {
      starter_price: optionalPrice(row.starter_price, `${rowLabel}.starter_price`),
      starter_includes: optionalCount(row.starter_includes, `${rowLabel}.starter_includes`, 1),
      extra_per_pax: optionalPrice(row.extra_per_pax, `${rowLabel}.extra_per_pax`),
    };
  }

  let longtail: LongtailPrice | null = null;
  if (input.longtail !== undefined && input.longtail !== null) {
    const l = record(input.longtail, at('longtail'));
    longtail = {
      join_adult: optionalPrice(l.join_adult, at('longtail.join_adult')), join_child: optionalPrice(l.join_child, at('longtail.join_child')),
      charter_price: optionalPrice(l.charter_price, at('longtail.charter_price')),
      charter_capacity: optionalCount(l.charter_capacity, at('longtail.charter_capacity'), 0),
    };
  }

  const transfer: Record<string, Partial<Record<string, number>>> = {};
  for (const [zone, vehiclesValue] of Object.entries(input.transfer === undefined || input.transfer === null ? {} : record(input.transfer, at('transfer')))) {
    const zoneLabel = at(`transfer.${zone}`);
    zoneName(zone, zoneLabel);
    const vehicles: Partial<Record<string, number>> = {};
    for (const [vehicle, cell] of Object.entries(record(vehiclesValue, zoneLabel))) {
      if (!oneOf(VEHICLES, vehicle)) badRequest(`${zoneLabel}.${vehicle} is not a vehicle: use ${VEHICLES.join(', ')}`);
      if (cell !== null) vehicles[vehicle] = price(cell, `${zoneLabel}.${vehicle}`);
    }
    if (Object.keys(vehicles).length > 0) transfer[zone] = vehicles;
  }

  return { travel_from, travel_to, longtail_bundle, zones, charter, longtail, transfer };
}

/**
 * Refuses a zone the route cannot take. `route` is undefined when the store has no catalogue to
 * look in — the in-process store unseeded — and then nothing is checked, as `assertRoutes` does.
 */
export function assertZonesForRoute(block: RouteBlock, route: { id: string; pier?: string } | undefined, label: string): void {
  if (!route) return;
  const allowed = zonesForRoute(route);
  const used = [...Object.keys(block.zones).map((z) => ['zones', z]), ...Object.keys(block.transfer).map((z) => ['transfer', z])];
  for (const [where, zone] of used) {
    if (!allowed.includes(zone)) {
      badRequest(`${label ? `${label}.` : ''}${where}.${zone} does not apply to route ${route.id}${route.pier ? ` (pier ${route.pier})` : ''}: use ${allowed.join(', ')}`);
    }
  }
}

/** What a store knows about a route: enough to say whether it exists and which zones it takes. */
export type CatalogueRoute = { id: string; pier?: string };

/**
 * Refuses a block on a route that is not in the catalogue, or a zone that route cannot take.
 * `catalogue` is undefined when the store has none to look in (the in-process store unseeded): then
 * any route is accepted, exactly as bookings' `assertRoutes` does. PostgreSQL always has one.
 */
export function assertRouteBlock(block: RouteBlock, routeId: string, catalogue: ReadonlyMap<string, CatalogueRoute> | undefined, label: string): void {
  if (!catalogue) return;
  const route = catalogue.get(routeId) ?? badRequest(`${label ? `${label}.route_id` : 'route'} ${routeId} is not a route`);
  assertZonesForRoute(block, route, label);
}

/** An owner must be a salesperson, when the store has salespeople to check against. */
export function assertOwner(owner: string | null | undefined, salesIds: ReadonlySet<string> | undefined): void {
  if (owner === null || owner === undefined || !salesIds) return;
  if (!salesIds.has(owner)) badRequest(`owner ${owner} is not a salesperson`);
}

/** The header fields a rate type is created with. `id` and `code` are generated when absent. */
export type RateTypeHeader = {
  id?: string; code?: string; name: string; note: string | null; color: string | null; owner: string | null;
  valid_from: string | null; valid_to: string | null; active: boolean; nationality_scope: NationalityScope | null; transfer_unit: string | null;
};
export type RateTypeCreate = { header: RateTypeHeader; routes: { route_id: string; block: RouteBlock }[] };

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const scope = (value: unknown, label: string): NationalityScope | null =>
  value === undefined || value === null ? null : oneOf(NATIONALITY_SCOPES, value) ? value : badRequest(`${label} must be both, thai or foreign`);
const flag = (value: unknown, label: string): boolean => (typeof value === 'boolean' ? value : badRequest(`${label} must be true or false`));

export function parseRateTypeCreate(body: unknown): RateTypeCreate {
  const input = record(body, 'body');
  const name = optionalText(input.name, 'name') ?? badRequest('name is required');
  const id = input.id === undefined ? undefined : typeof input.id === 'string' && ID.test(input.id) ? input.id : badRequest('id must be letters, digits, _ . : or -, at most 64');
  const code = input.code === undefined ? undefined : optionalText(input.code, 'code') ?? badRequest('code must not be blank');
  const valid_from = optionalDate(input.valid_from, 'valid_from');
  const valid_to = optionalDate(input.valid_to, 'valid_to');
  assertOrder(valid_from, valid_to, 'valid_from must not be after valid_to');
  const routesValue = input.routes === undefined || input.routes === null ? [] : Array.isArray(input.routes) ? input.routes : badRequest('routes must be an array');
  const seen = new Set<string>();
  const routes = routesValue.map((value, index) => {
    const label = `routes[${index}]`;
    const entry = record(value, label);
    const routeId = typeof entry.route_id === 'string' && entry.route_id.length > 0 ? entry.route_id : badRequest(`${label}.route_id is required`);
    if (seen.has(routeId)) badRequest(`${label}.route_id ${routeId} is listed twice`);
    seen.add(routeId);
    return { route_id: routeId, block: parseRouteBlock(entry, label) };
  });
  return {
    header: {
      ...(id === undefined ? {} : { id }), ...(code === undefined ? {} : { code }),
      name, note: optionalText(input.note, 'note'), color: optionalText(input.color, 'color'), owner: optionalText(input.owner, 'owner'),
      valid_from, valid_to, active: input.active === undefined ? true : flag(input.active, 'active'),
      nationality_scope: scope(input.nationality_scope, 'nationality_scope'), transfer_unit: optionalText(input.transfer_unit, 'transfer_unit'),
    },
    routes,
  };
}

/** A `PATCH`: only the fields mentioned. `null` (or a blank string) clears a field that may be empty. */
export type RateTypePatch = Partial<Omit<RateTypeHeader, 'id' | 'code'>>;

export function parseRateTypePatch(body: unknown): RateTypePatch {
  const input = record(body, 'body');
  if ('id' in input) badRequest('id cannot be changed');
  if ('code' in input) badRequest('code cannot be changed: an import matches rate types on it');
  if ('routes' in input) badRequest('routes are changed one at a time with PUT /v1/rate-types/{id}/routes/{route_id}');
  const patch: RateTypePatch = {};
  if ('name' in input) patch.name = optionalText(input.name, 'name') ?? badRequest('name cannot be cleared');
  for (const key of ['note', 'color', 'owner', 'transfer_unit'] as const) if (key in input) patch[key] = optionalText(input[key], key);
  for (const key of ['valid_from', 'valid_to'] as const) if (key in input) patch[key] = optionalDate(input[key], key);
  if ('active' in input) patch.active = flag(input.active, 'active');
  if ('nationality_scope' in input) patch.nationality_scope = scope(input.nationality_scope, 'nationality_scope');
  return patch;
}

// ── Writing rows ─────────────────────────────────────────────────────────────────────────────────

/**
 * A readable code from the name, unique among `taken`: `Standard 2026` → `STANDARD-2026`, then
 * `-2`, `-3`… Legacy prefixes the salesperson's name (`_rtAutoCode`); that needs the caller's
 * salesperson in the token, which is not decided yet, so it is left out. A caller may send its own.
 */
export function generateRateTypeCode(name: string, taken: ReadonlySet<string>): string {
  const base = name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/, '') || 'RT';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

export function newRateTypeRow(header: RateTypeHeader, id: string, code: string, now: string): RateTypeRow {
  return {
    id, code, name: header.name, note: header.note, color: header.color, owner_sales_id: header.owner,
    valid_from: header.valid_from, valid_to: header.valid_to, active: header.active, nationality_scope: header.nationality_scope,
    transfer_unit: header.transfer_unit, created_on: null, created_at: now, updated_at: now,
  };
}

/** The row after a patch. The validity order is checked on the result, since a patch may move one end. */
export function patchedRateTypeRow(row: RateTypeRow, patch: RateTypePatch, now: string): RateTypeRow {
  const next: RateTypeRow = { ...row, updated_at: now };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.note !== undefined) next.note = patch.note;
  if (patch.color !== undefined) next.color = patch.color;
  if (patch.owner !== undefined) next.owner_sales_id = patch.owner;
  if (patch.transfer_unit !== undefined) next.transfer_unit = patch.transfer_unit;
  if (patch.valid_from !== undefined) next.valid_from = patch.valid_from;
  if (patch.valid_to !== undefined) next.valid_to = patch.valid_to;
  if (patch.active !== undefined) next.active = patch.active;
  if (patch.nationality_scope !== undefined) next.nationality_scope = patch.nationality_scope;
  assertOrder(next.valid_from, next.valid_to, 'valid_from must not be after valid_to');
  return next;
}

/** One route's block as the rows that store it. */
export function routeRows(rateTypeId: string, routeId: string, seq: number, block: RouteBlock): RouteRows {
  const base = { rate_type_id: rateTypeId, route_id: routeId };
  const seat: SeatPriceRow[] = [];
  for (const [zone, tiers] of Object.entries(block.zones)) {
    for (const [tier, grid] of Object.entries(tiers) as [RateTier, Grid][]) {
      for (const [key, value] of Object.entries(grid) as [RatePaxKey, number][]) seat.push({ ...base, zone, ...CELL[key], tier, price: value });
    }
  }
  const transfer: TransferPriceRow[] = [];
  for (const [zone, vehicles] of Object.entries(block.transfer)) {
    for (const [vehicle, value] of Object.entries(vehicles)) if (value !== undefined) transfer.push({ ...base, zone, vehicle, price: value });
  }
  return {
    route: {
      ...base, seq, travel_from: block.travel_from, travel_to: block.travel_to,
      longtail_bundle: block.longtail_bundle?.mode ?? null, longtail_bundle_adult: block.longtail_bundle?.adult ?? null,
      longtail_bundle_child: block.longtail_bundle?.child ?? null, longtail_bundle_applies_to: block.longtail_bundle?.applies_to ?? null,
    },
    seat,
    charter: Object.entries(block.charter).map(([boat_type, c]) => ({ ...base, boat_type, ...c })),
    longtail: block.longtail ? [{ ...base, ...block.longtail }] : [],
    transfer,
  };
}

/** Adds one route's rows to a rate type held in memory, as the INSERTs add them to the tables. */
export function addRouteRows(rows: RateTypeRows, route: RouteRows): void {
  rows.routes.push(route.route);
  rows.seat.push(...route.seat);
  rows.charter.push(...route.charter);
  rows.longtail.push(...route.longtail);
  rows.transfer.push(...route.transfer);
}

/** Removes one route and every price under it, as the cascade from `rate_type_routes` does. */
export function removeRouteRows(rows: RateTypeRows, routeId: string): void {
  const keep = <T extends { route_id: string }>(list: T[]) => list.filter((row) => row.route_id !== routeId);
  rows.routes = keep(rows.routes);
  rows.seat = keep(rows.seat);
  rows.charter = keep(rows.charter);
  rows.longtail = keep(rows.longtail);
  rows.transfer = keep(rows.transfer);
}

/** The `seq` a route added to a rate takes: after every route it already has. */
export const nextRouteSeq = (routes: readonly { seq: number }[]): number => routes.reduce((max, route) => Math.max(max, route.seq + 1), 0);

/**
 * A rate type that an agent or a booking names is not deleted: legacy did, and left agents' seasons,
 * contracts and bookings pointing at nothing. The caller deactivates it instead.
 */
export function assertRateTypeUnused(id: string, used: { agents: number; bookings: number }): void {
  if (used.agents === 0 && used.bookings === 0) return;
  const parts = [used.agents && `${used.agents} agent${used.agents === 1 ? '' : 's'}`, used.bookings && `${used.bookings} booking${used.bookings === 1 ? '' : 's'}`].filter(Boolean);
  refuse(`Rate type ${id} is used by ${parts.join(' and ')}; deactivate it instead (PATCH {"active": false})`, 409, 'in_use');
}

export const rateTypeNotFound = (id: string): never => refuse(`Rate type ${id} not found`, 404);
export const rateTypeExists = (what: 'id' | 'code', value: string): never => refuse(`A rate type with ${what} ${value} already exists`, 409, 'exists');
