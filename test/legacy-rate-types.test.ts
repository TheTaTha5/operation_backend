import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapLegacyRateTypes, type LegacyRateTypeTables } from '../src/tools/legacy-rate-types.js';

// Fixture rows in the shape of legacy's `operation_schemas.sb_rate_types*` tables, including the
// cases the 2026-10-07 data check found on production.
const catalogue = new Map([['r4', { pier: 'tublamu' }], ['r5', { pier: 'panwa' }], ['r10', { pier: 'panwa' }], ['rn1', { pier: 'ranong' }]]);
const sales = new Set(['s01']);

const base = (): LegacyRateTypeTables => ({
  rates: [{
    id: 'rt003', code: 'NOK-STD', name: 'Standard 2026', note: '', color: '#1683C7', createddate: '2026-01-05', validfrom: '2026-01-01', validto: '2026-10-31',
    active: true, nationalityscope: 'fr', owner: 's01',
    pricetiers: JSON.stringify({ r4: { PK: { 'adult-fr': { sell: 3400, minSell: 3100 }, 'child-fr': { sell: 2400 } } } }),
  }],
  routes: [{ sb_rate_types_id: 'rt003', idx: 1, value: 'r5' }, { sb_rate_types_id: 'rt003', idx: 0, value: 'r4' }, { sb_rate_types_id: 'rt003', idx: 2, value: 'rn1' }],
  seat: [
    // KL also in the stray `kl` JSON column: production's copy always agrees, and it is not read.
    { sb_rate_types_id: 'rt003', key: 'r4', pk_adult_fr: '2900', pk_child_fr: '1900', pk_adult_thai: '1900', pk_child_thai: null, pk_infant_fr: '0', kl_adult_fr: '3100',
      notransfer_adult_fr: null, kl: '{"adult-fr":3100}' },
    { sb_rate_types_id: 'rt003', key: 'r5', pk_adult_fr: null, kl_adult_fr: null },
    { sb_rate_types_id: 'rt003', key: 'rn1', notransfer_adult_fr: '1500', notransfer_child_fr: '900' },
  ],
  charter: [{ sb_rate_types_id: 'rt003', key: 'r4', speedboat_starterprice: '45000', speedboat_starterincludes: '20', speedboat_extraperpax: '1500',
    catamaran_starterprice: null, catamaran_starterincludes: null, catamaran_extraperpax: null }],
  validity: [
    { sb_rate_types_id: 'rt003', key: 'r4', from: '2025-11-01', to: '2026-04-30' },
    { sb_rate_types_id: 'rt003', key: 'r5', from: '2026-05-15', to: '20207-05-15' },     // the production typo
    { sb_rate_types_id: 'rt003', key: 'r99', from: '2026-01-01', to: '2026-02-01' },     // a route outside routes[]
  ],
  bundles: [{ sb_rate_types_id: 'rt003', key: 'r5', longtail_mode: 'free', longtail_adult: null, longtail_child: null }],
  addons: [
    // The oldest flat shape: adult/child with no join or charter columns.
    { sb_rate_types_id: 'rt003', key: 'longtail', row_pk: 'lt1', unit: 'per pax', adult: '400', child: '300', join_adult: null, join_child: null, charter_price: null, charter_capacity: null },
    { sb_rate_types_id: 'rt003', key: 'privateTransfer', row_pk: 'pt1', unit: 'per trip' },
  ],
  byRoute: [{ sb_rate_types_addons_id: 'lt1', key: 'r5', join_adult: '450', join_child: '350', charter_price: '3500', charter_capacity: '8' }],
  applies: [{ sb_rate_types_addons_id: 'lt1', idx: 0, value: 'r4' }, { sb_rate_types_addons_id: 'lt1', idx: 1, value: 'r5' }],
  transfers: [{ routeId: 'r10', rows: [] }, { routeId: 'r4', rows: [{ sb_rate_types_addons_id: 'pt1', key: 'PK', sedan: '1200', van: '1800' }, { sb_rate_types_addons_id: 'pt1', key: 'KL', sedan: null, van: '2400' }] }],
});

test('the header maps legacy\'s values to this service\'s: fr is foreign, a blank owner is shared, the transfer unit is kept', () => {
  const out = mapLegacyRateTypes(base(), catalogue, sales);
  assert.deepEqual(out.rateTypes, [{
    id: 'rt003', code: 'NOK-STD', name: 'Standard 2026', note: null, color: '#1683C7', owner_sales_id: 's01', valid_from: '2026-01-01', valid_to: '2026-10-31',
    active: true, nationality_scope: 'foreign', transfer_unit: 'per trip', created_on: '2026-01-05',
  }]);
  assert.equal(out.notes.get('nationality_scope fr → foreign'), 1);
  const blank = mapLegacyRateTypes({ ...base(), rates: [{ ...base().rates[0], active: null, owner: 's404', nationalityscope: null }] }, catalogue, sales);
  assert.equal(blank.rateTypes[0].active, true, 'legacy reads a missing active as true');
  assert.equal(blank.rateTypes[0].owner_sales_id, null);
  assert.match(blank.issues.join('\n'), /owner s404 dropped: not a salesperson/);
  const inactive = mapLegacyRateTypes({ ...base(), rates: [{ ...base().rates[0], active: false }] }, catalogue, sales);
  assert.equal(inactive.rateTypes[0].active, false);
});

test('routes keep legacy\'s order; validity outside routes[] and a typo\'d date are dropped and reported, never guessed', () => {
  const out = mapLegacyRateTypes(base(), catalogue, sales);
  assert.deepEqual(out.routes.map((r) => [r.route_id, r.seq]), [['r4', 0], ['r5', 1], ['rn1', 2]]);
  assert.deepEqual(out.routes.map((r) => [r.travel_from, r.travel_to]), [['2025-11-01', '2026-04-30'], ['2026-05-15', null], [null, null]]);
  assert.match(out.issues.join('\n'), /r5 travel_to "20207-05-15" dropped, not a real YYYY-MM-DD date/);
  assert.equal(out.notes.get('route validity dropped: route not in the rate\'s routes[]'), 1);
  assert.deepEqual(out.routes[1], { rate_type_id: 'rt003', route_id: 'r5', seq: 1, travel_from: '2026-05-15', travel_to: null,
    longtail_bundle: 'free', longtail_bundle_adult: null, longtail_bundle_child: null, longtail_bundle_applies_to: null });
  const unknown = mapLegacyRateTypes({ ...base(), routes: [...base().routes, { sb_rate_types_id: 'rt003', idx: 3, value: 'r_gone' }] }, catalogue, sales);
  assert.match(unknown.issues.join('\n'), /route r_gone dropped: not in the route catalogue/);
});

test('the wide seat columns become net rows, tiers become sell and min_sell rows, and the kl JSON copy is not read', () => {
  const seat = mapLegacyRateTypes(base(), catalogue, sales).seat.map((s) => `${s.route_id} ${s.zone} ${s.category}_${s.residency} ${s.tier} ${s.price}`).sort();
  assert.deepEqual(seat, [
    'r4 KL ad_foreign net 3100',
    'r4 PK ad_foreign min_sell 3100', 'r4 PK ad_foreign net 2900', 'r4 PK ad_foreign sell 3400',
    'r4 PK ad_thai net 1900', 'r4 PK chd_foreign net 1900', 'r4 PK chd_foreign sell 2400', 'r4 PK inf_foreign net 0',
    'rn1 NoTransfer ad_foreign net 1500', 'rn1 NoTransfer chd_foreign net 900',
  ], 'blank cells are no row; a zone with none (r5) is not offered');
});

test('a price in a zone the route\'s pier cannot take is dropped and reported', () => {
  const tables = base();
  tables.seat[2] = { ...tables.seat[2], pk_adult_fr: '1700' };   // PK on a Ranong route
  const out = mapLegacyRateTypes(tables, catalogue, sales);
  assert.match(out.issues.join('\n'), /rn1 PK prices dropped: the route's pier does not take that zone/);
  assert.equal(out.seat.some((s) => s.route_id === 'rn1' && s.zone === 'PK'), false);
});

test('charter rows come from each boat type\'s column set that has a value', () => {
  assert.deepEqual(mapLegacyRateTypes(base(), catalogue, sales).charter, [
    { rate_type_id: 'rt003', route_id: 'r4', boat_type: 'speedboat', starter_price: 45000, starter_includes: 20, extra_per_pax: 1500 },
  ], 'the catamaran columns are all blank: no row');
});

test('the longtail add-on resolves as legacy does: per-route price, else the flat one, on every applied route', () => {
  const out = mapLegacyRateTypes(base(), catalogue, sales);
  assert.deepEqual(out.longtail, [
    { rate_type_id: 'rt003', route_id: 'r4', join_adult: 400, join_child: 300, charter_price: null, charter_capacity: null },   // flat, old shape
    { rate_type_id: 'rt003', route_id: 'r5', join_adult: 450, join_child: 350, charter_price: 3500, charter_capacity: 8 },     // its own byRoute price
  ]);
  assert.equal(out.notes.get('longtail old flat adult/child shape → join prices'), 1);
  // No applies list: the routes with a per-route price are the applied ones (`_rtNormalizeLongtail`).
  const byRouteOnly = mapLegacyRateTypes({ ...base(), applies: [] }, catalogue, sales);
  assert.deepEqual(byRouteOnly.longtail.map((l) => l.route_id), ['r5']);
});

test('private transfers come from the per-route tables, keyed by zone, one row per vehicle with a price', () => {
  assert.deepEqual(mapLegacyRateTypes(base(), catalogue, sales).transfer.map((t) => `${t.route_id} ${t.zone} ${t.vehicle} ${t.price}`), [
    'r4 PK sedan 1200', 'r4 PK van 1800', 'r4 KL van 2400',
  ]);
});

test('bad values are dropped and listed, never imported or guessed', () => {
  const tables = base();
  tables.seat[0] = { ...tables.seat[0], pk_adult_fr: '-5', pk_child_fr: 'n/a' };
  tables.rates[0] = { ...tables.rates[0], validfrom: '2026-12-01', validto: '2026-01-01', pricetiers: '{broken' };
  const out = mapLegacyRateTypes(tables, catalogue, sales);
  const issues = out.issues.join('\n');
  assert.match(issues, /r4 PK adult-fr price dropped: not a number ≥ 0/);
  assert.match(issues, /r4 PK child-fr price dropped: not a number ≥ 0/);
  assert.match(issues, /validity 2026-12-01\.\.2026-01-01 dropped: ends before it starts/);
  assert.match(issues, /price tiers dropped: not JSON/);
  assert.equal(out.rateTypes[0].valid_from, null);
  assert.equal(out.seat.some((s) => Number(s.price) < 0), false);
  const noCode = mapLegacyRateTypes({ ...base(), rates: [{ ...base().rates[0], code: '' }] }, catalogue, sales);
  assert.equal(noCode.rateTypes.length, 0);
  assert.match(noCode.issues.join('\n'), /skipped: no code/);
});
