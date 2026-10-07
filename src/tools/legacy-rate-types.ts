/**
 * Legacy's rate types (`operation_schemas.sb_rate_types` and its 14 child tables) as rows for this
 * service's six rate type tables (migration 022). Pure, so `test/legacy-rate-types.test.ts` checks
 * every rule on fixture rows; `import-legacy.ts` reads the source and writes what this returns.
 *
 * Legacy's tables are wide: a column per zone × pax type, a table per route for transfers, the
 * Selling/Min-sell tiers as one JSON string. Here each becomes rows. A value that does not map is
 * left out and listed in `issues`, never guessed — the one malformed date legacy holds today
 * (`20207-05-15`) is imported as no date, not as a corrected one.
 *
 * Legacy can only hold some of what a rate type is (`todo/rate-types-model.md`): zones PK, KL and
 * NoTransfer, speedboat and catamaran charters, transfers on the routes it has a table for, and no
 * bundle `applies_to`. `LEGACY_HOLDS` names that scope, so the importer replaces exactly it and
 * leaves alone what was entered here by hand (RN prices, longtail charters, …).
 */
import { isRealDate, zonesForRoute } from '../domain/rate-types.js';

type Row = Record<string, unknown>;

/** The legacy tables, read whole. `transfers` holds one entry per `sb_rate_types__addons__<route>` table. */
export type LegacyRateTypeTables = {
  rates: Row[]; routes: Row[]; seat: Row[]; charter: Row[]; validity: Row[]; bundles: Row[];
  addons: Row[]; byRoute: Row[]; applies: Row[]; transfers: { routeId: string; rows: Row[] }[];
};

/** What legacy's tables can express; the importer replaces this and keeps everything else. */
export const LEGACY_HOLDS = {
  zones: ['PK', 'KL', 'NoTransfer'],
  boatTypes: ['speedboat', 'catamaran'],
} as const;

export type RateTypeImport = {
  rateTypes: Row[]; routes: Row[]; seat: Row[]; charter: Row[]; longtail: Row[]; transfer: Row[];
  /** Per rate type: a value dropped or changed, for the report. */
  issues: string[];
  /** How often each normalisation happened, for the report's notes. */
  notes: Map<string, number>;
};

const str = (value: unknown): string => (value == null ? '' : String(value).trim());
/** A legacy number column: null when blank; anything that is not a number ≥ 0 is dropped and listed. */
const amount = (value: unknown, issue: () => void): number | null => {
  if (value === null || value === undefined || str(value) === '') return null;
  const n = Number(value);
  if (Number.isFinite(n) && n >= 0) return n;
  issue();
  return null;
};

/** Legacy pax keys: `adult-thai` → category `ad`, residency `thai`. */
const PAX: Record<string, { category: string; residency: string }> = {
  'adult-thai': { category: 'ad', residency: 'thai' }, 'adult-fr': { category: 'ad', residency: 'foreign' },
  'child-thai': { category: 'chd', residency: 'thai' }, 'child-fr': { category: 'chd', residency: 'foreign' },
  'infant-thai': { category: 'inf', residency: 'thai' }, 'infant-fr': { category: 'inf', residency: 'foreign' },
};
/** The wide seat-rate columns: zone prefix as legacy lowercased it. */
const SEAT_COLUMN_ZONE: Record<string, string> = { pk: 'PK', kl: 'KL', notransfer: 'NoTransfer' };
const TIER: Record<string, string> = { sell: 'sell', minSell: 'min_sell' };

const groupBy = <T extends Row>(rows: readonly T[], key: string): Map<string, T[]> => {
  const out = new Map<string, T[]>();
  for (const row of rows) { const k = str(row[key]); (out.get(k) ?? out.set(k, []).get(k)!).push(row); }
  return out;
};

export function mapLegacyRateTypes(t: LegacyRateTypeTables, catalogue: ReadonlyMap<string, { pier?: string }>, salesIds: ReadonlySet<string>): RateTypeImport {
  const out: RateTypeImport = { rateTypes: [], routes: [], seat: [], charter: [], longtail: [], transfer: [], issues: [], notes: new Map() };
  const note = (what: string) => out.notes.set(what, (out.notes.get(what) ?? 0) + 1);
  const routesOf = groupBy(t.routes, 'sb_rate_types_id');
  const seatOf = groupBy(t.seat, 'sb_rate_types_id');
  const charterOf = groupBy(t.charter, 'sb_rate_types_id');
  const validityOf = groupBy(t.validity, 'sb_rate_types_id');
  const bundlesOf = groupBy(t.bundles, 'sb_rate_types_id');
  const addonsOf = groupBy(t.addons, 'sb_rate_types_id');
  const byRouteOf = groupBy(t.byRoute, 'sb_rate_types_addons_id');
  const appliesOf = groupBy(t.applies, 'sb_rate_types_addons_id');
  const transfersOf = new Map(t.transfers.map(({ routeId, rows }) => [routeId, groupBy(rows, 'sb_rate_types_addons_id')]));

  for (const r of t.rates) {
    const id = str(r.id);
    if (!id) { out.issues.push(`${'(no id)'.padEnd(18)} skipped: no id`); continue; }
    const code = str(r.code);
    if (!code) { out.issues.push(`${id.padEnd(18)} skipped: no code, and an import matches on the code`); continue; }
    const issue = (what: string) => out.issues.push(`${id.padEnd(18)} ${what}`);
    const day = (value: unknown, what: string): string | null => {
      const s = str(value);
      if (!s) return null;
      if (isRealDate(s)) return s;
      issue(`${what} "${s}" dropped, not a real YYYY-MM-DD date`);
      return null;
    };

    let validFrom = day(r.validfrom, 'valid_from'), validTo = day(r.validto, 'valid_to');
    if (validFrom && validTo && validFrom > validTo) { issue(`validity ${validFrom}..${validTo} dropped: ends before it starts`); validFrom = validTo = null; }
    let owner: string | null = str(r.owner) || null;
    if (owner && !salesIds.has(owner)) { issue(`owner ${owner} dropped: not a salesperson, the rate is shared`); owner = null; }
    if (r.active === null || r.active === undefined) note('active blank → true, as legacy reads it');
    let scope: string | null = str(r.nationalityscope) || null;
    if (scope === 'fr') { scope = 'foreign'; note('nationality_scope fr → foreign'); }
    if (scope && !['both', 'thai', 'foreign'].includes(scope)) { issue(`nationality_scope "${scope}" dropped`); scope = null; }
    const addons = addonsOf.get(id) ?? [];
    const transferAddon = addons.find((a) => str(a.key) === 'privateTransfer');

    out.rateTypes.push({
      id, code, name: str(r.name) || code, note: str(r.note) || null, color: str(r.color) || null, owner_sales_id: owner,
      valid_from: validFrom, valid_to: validTo, active: r.active !== false, nationality_scope: scope,
      transfer_unit: transferAddon ? str(transferAddon.unit) || null : null, created_on: day(r.createddate, 'created_on'),
    });

    // ── Routes: legacy's routes[] order; a route outside the catalogue cannot hang prices ──
    const covered: string[] = [];
    for (const row of [...(routesOf.get(id) ?? [])].sort((a, b) => Number(a.idx) - Number(b.idx))) {
      const routeId = str(row.value);
      if (!routeId || covered.includes(routeId)) continue;
      if (!catalogue.has(routeId)) { issue(`route ${routeId} dropped: not in the route catalogue`); continue; }
      covered.push(routeId);
    }
    const isCovered = (routeId: string) => covered.includes(routeId);
    const validity = new Map((validityOf.get(id) ?? []).map((v) => [str(v.key), v]));
    const bundles = new Map((bundlesOf.get(id) ?? []).map((b) => [str(b.key), b]));
    for (const key of validity.keys()) if (!isCovered(key)) note('route validity dropped: route not in the rate\'s routes[]');
    for (const key of bundles.keys()) if (!isCovered(key)) note('route bundle dropped: route not in the rate\'s routes[]');

    covered.forEach((routeId, seq) => {
      const v = validity.get(routeId), b = bundles.get(routeId);
      let from = v ? day(v.from, `${routeId} travel_from`) : null, to = v ? day(v.to, `${routeId} travel_to`) : null;
      if (from && to && from > to) { issue(`${routeId} travel window ${from}..${to} dropped: ends before it starts`); from = to = null; }
      let mode: string | null = b ? str(b.longtail_mode) || null : null;
      if (mode && mode !== 'free' && mode !== 'paid') { issue(`${routeId} bundle mode "${mode}" dropped`); mode = null; }
      out.routes.push({
        rate_type_id: id, route_id: routeId, seq, travel_from: from, travel_to: to, longtail_bundle: mode,
        longtail_bundle_adult: mode ? amount(b!.longtail_adult, () => issue(`${routeId} bundle adult price dropped`)) : null,
        longtail_bundle_child: mode ? amount(b!.longtail_child, () => issue(`${routeId} bundle child price dropped`)) : null,
        longtail_bundle_applies_to: null,   // legacy never stored it
      });
    });

    // ── Seat prices: net from the wide columns; zones the route's pier cannot take are listed ──
    const offered = (routeId: string, zone: string) => zonesForRoute(catalogue.get(routeId) ?? {}).includes(zone);
    for (const row of seatOf.get(id) ?? []) {
      const routeId = str(row.key);
      if (!isCovered(routeId)) { note('seat prices dropped: route not in the rate\'s routes[]'); continue; }
      for (const [prefix, zone] of Object.entries(SEAT_COLUMN_ZONE)) {
        for (const [paxKey, cell] of Object.entries(PAX)) {
          const value = amount(row[`${prefix}_${paxKey.replace('-', '_')}`], () => issue(`${routeId} ${zone} ${paxKey} price dropped: not a number ≥ 0`));
          if (value === null) continue;
          if (!offered(routeId, zone)) { issue(`${routeId} ${zone} prices dropped: the route's pier does not take that zone`); break; }
          out.seat.push({ rate_type_id: id, route_id: routeId, zone, ...cell, tier: 'net', price: value });
        }
      }
    }

    // ── Selling / Min-sell tiers: one JSON string, {route: {zone: {paxKey: {sell, minSell}}}} ──
    const tiersText = str(r.pricetiers);
    if (tiersText && tiersText !== '{}' && tiersText !== 'null') {
      let tiers: Record<string, Record<string, Record<string, Record<string, unknown>>>> = {};
      try { tiers = JSON.parse(tiersText); } catch { issue('price tiers dropped: not JSON'); }
      for (const [routeId, zones] of Object.entries(tiers ?? {})) {
        if (!isCovered(routeId)) { note('price tiers dropped: route not in the rate\'s routes[]'); continue; }
        for (const [zone, cells] of Object.entries(zones ?? {})) {
          if (!offered(routeId, zone)) { issue(`${routeId} ${zone} tier prices dropped: the route's pier does not take that zone`); continue; }
          for (const [paxKey, byTier] of Object.entries(cells ?? {})) {
            const cell = PAX[paxKey];
            if (!cell) { issue(`${routeId} ${zone} tier key "${paxKey}" dropped`); continue; }
            for (const [tierKey, tier] of Object.entries(TIER)) {
              const value = amount(byTier?.[tierKey], () => issue(`${routeId} ${zone} ${paxKey} ${tier} dropped: not a number ≥ 0`));
              if (value !== null) out.seat.push({ rate_type_id: id, route_id: routeId, zone, ...cell, tier, price: value });
            }
          }
        }
      }
    }

    // ── Charter: speedboat and catamaran column sets, a row for each that has any value ──
    for (const row of charterOf.get(id) ?? []) {
      const routeId = str(row.key);
      if (!isCovered(routeId)) { note('charter prices dropped: route not in the rate\'s routes[]'); continue; }
      for (const boatType of LEGACY_HOLDS.boatTypes) {
        const bad = (what: string) => () => issue(`${routeId} ${boatType} ${what} dropped: not a number ≥ 0`);
        const starterPrice = amount(row[`${boatType}_starterprice`], bad('starter price'));
        let starterIncludes = amount(row[`${boatType}_starterincludes`], bad('starter includes'));
        const extraPerPax = amount(row[`${boatType}_extraperpax`], bad('extra per pax'));
        if (starterPrice === null && starterIncludes === null && extraPerPax === null) continue;
        if (starterIncludes !== null && (starterIncludes < 1 || !Number.isInteger(starterIncludes))) { issue(`${routeId} ${boatType} starter includes ${starterIncludes} dropped`); starterIncludes = null; }
        out.charter.push({ rate_type_id: id, route_id: routeId, boat_type: boatType, starter_price: starterPrice, starter_includes: starterIncludes, extra_per_pax: extraPerPax });
      }
    }

    // ── Longtail add-on: legacy's `_rtNormalizeLongtail` resolves its three shapes to a price per route ──
    const longtail = addons.find((a) => str(a.key) === 'longtail');
    if (longtail) {
      const rowPk = str(longtail.row_pk);
      const lp = (value: unknown, what: string) => amount(value, () => issue(`longtail ${what} dropped: not a number ≥ 0`));
      const price = (src: Row) => ({
        join_adult: lp(src.join_adult, 'join adult'), join_child: lp(src.join_child, 'join child'),
        charter_price: lp(src.charter_price, 'charter price'), charter_capacity: lp(src.charter_capacity, 'charter capacity'),
      });
      const byRoute = new Map((byRouteOf.get(rowPk) ?? []).map((b) => [str(b.key), price(b)]));
      let applies = (appliesOf.get(rowPk) ?? []).sort((a, b) => Number(a.idx) - Number(b.idx)).map((a) => str(a.value)).filter(Boolean);
      if (applies.length === 0) applies = [...byRoute.keys()];
      // The flat default: the newer join/charter columns, else the oldest adult/child shape.
      const flat = (longtail.join_adult ?? longtail.join_child ?? longtail.charter_price) != null ? price(longtail)
        : (longtail.adult ?? longtail.child) != null ? { ...price({}), join_adult: lp(longtail.adult, 'adult'), join_child: lp(longtail.child, 'child') }
          : null;
      if (flat && (longtail.adult ?? longtail.child) != null && (longtail.join_adult ?? longtail.join_child) == null) note('longtail old flat adult/child shape → join prices');
      for (const routeId of [...new Set(applies)]) {
        if (!isCovered(routeId)) { issue(`longtail price on ${routeId} dropped: route not in the rate's routes[]`); continue; }
        const p = byRoute.get(routeId) ?? flat;
        if (!p) { issue(`longtail on ${routeId} has no price, per route or flat: dropped`); continue; }
        out.longtail.push({ rate_type_id: id, route_id: routeId, ...p });
      }
    }

    // ── Private transfer: one legacy table per route, keyed by zone, a column per vehicle ──
    if (transferAddon) {
      const rowPk = str(transferAddon.row_pk);
      for (const [routeId, rowsByAddon] of transfersOf) {
        for (const row of rowsByAddon.get(rowPk) ?? []) {
          if (!isCovered(routeId)) { note('transfer prices dropped: route not in the rate\'s routes[]'); continue; }
          const zone = str(row.key);
          if (!offered(routeId, zone)) { issue(`${routeId} transfer zone ${zone} dropped: the route's pier does not take that zone`); continue; }
          for (const vehicle of ['sedan', 'van']) {
            const value = amount(row[vehicle], () => issue(`${routeId} ${zone} ${vehicle} transfer dropped: not a number ≥ 0`));
            if (value !== null) out.transfer.push({ rate_type_id: id, route_id: routeId, zone, vehicle, price: value });
          }
        }
      }
    }
  }
  return out;
}
