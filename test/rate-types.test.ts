import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { OperationsStore } from '../src/domain/operations.js';
import {
  assertRateTypeUnused, assertRouteBlock, generateRateTypeCode, isPricedRoute, parseRateTypeCreate, parseRateTypePatch, parseRouteBlock,
  rateRouteView, rateTypeView, routeRows, selectRateTypes, zonesForRoute, type RateTypeRows,
} from '../src/domain/rate-types.js';

// The HTTP tests run against whichever store DATABASE_URL selects, so `npm test` and
// `DATABASE_URL=… npm test` exercise the same contract. Ids are unique to the run, because a
// PostgreSQL test database keeps every row an earlier run wrote.
const url = process.env.DATABASE_URL;
const app = buildApp();
after(async () => { await app.close(); });
const run = Date.now().toString(36);

async function request(method: InjectOptions['method'], path: string, payload?: object) {
  return payload === undefined ? app.inject({ method, url: path }) : app.inject({ method, url: path, payload });
}
const refused = (fn: () => unknown, status: number, pattern: RegExp) =>
  assert.throws(fn, (error: Error & { statusCode?: number }) => error.statusCode === status && pattern.test(error.message), `expected ${status} ${pattern}`);

/** Every kind of price on one route, including each one legacy's tables dropped on save. */
const fullBlock = {
  travel_from: '2025-11-01', travel_to: '2026-04-30',
  longtail_bundle: { mode: 'paid', adult: 300, child: 200, applies_to: 'charter' },
  zones: {
    PK: { net: { ad_fr: 2900, chd_fr: 1900, ad_th: 1900, chd_th: 1200, inf_fr: 0 }, sell: { ad_fr: 3400 }, min_sell: { ad_fr: 3100 } },
    KL: { net: { ad_fr: 3100.5, chd_fr: 2100 } },
  },
  charter: { speedboat: { starter_price: 45000, starter_includes: 20, extra_per_pax: 1500 }, longtail: { starter_price: 3500, starter_includes: 6, extra_per_pax: 0 } },
  longtail: { join_adult: 400, join_child: 300, charter_price: 3500, charter_capacity: 8 },
  transfer: { PK: { sedan: 1200, van: 1800 }, KL: { van: 2400 } },
};

// ── Pure: reading a request ──────────────────────────────────────────────────────────────────────

test('a route block is read whole, and comes back from its rows exactly as it went in', () => {
  const block = parseRouteBlock(fullBlock, '');
  const rows = routeRows('rt_x', 'r1', 0, block);
  assert.equal(rows.seat.length, 9, 'one row per price cell, across all three tiers');
  assert.deepEqual(rows.charter.map((c) => c.boat_type).sort(), ['longtail', 'speedboat'], 'a longtail charter is a row, not a dropped column');
  assert.equal(rows.route.longtail_bundle_applies_to, 'charter', 'applies_to is kept; legacy lost it');
  assert.deepEqual(rateRouteView(rows.route, rows), { route_id: 'r1', ...block }, 'rows → view loses nothing');
  assert.equal(block.zones.KL.net?.ad_fr, 3100.5, 'decimals survive; legacy\'s bigint columns rounded them');
});

test('a null price is not set, and an empty zone or tier is dropped rather than stored empty', () => {
  const block = parseRouteBlock({ zones: { PK: { net: { ad_fr: null, chd_fr: 900 }, sell: { ad_fr: null } }, KL: { net: {} } }, transfer: { PK: { sedan: null } } }, '');
  assert.deepEqual(block.zones, { PK: { net: { chd_fr: 900 } } });
  assert.deepEqual(block.transfer, {});
  assert.equal(block.longtail_bundle, null);
  assert.equal(block.longtail, null);
});

test('a route block refuses what would otherwise be dropped or mispriced, naming the path', () => {
  const at = 'routes[0]';
  refused(() => parseRouteBlock({ zones: { PK: { net: { ad_xx: 1 } } } }, at), 400, /^routes\[0\]\.zones\.PK\.net\.ad_xx is not a pax key/);
  refused(() => parseRouteBlock({ zones: { PK: { gross: { ad_fr: 1 } } } }, at), 400, /zones\.PK\.gross is not a price tier/);
  refused(() => parseRouteBlock({ zones: { PK: { net: { ad_fr: -1 } } } }, at), 400, /zones\.PK\.net\.ad_fr must be a number ≥ 0/);
  refused(() => parseRouteBlock({ zones: { PK: { net: { ad_fr: '2900' } } } }, at), 400, /must be a number ≥ 0/);
  refused(() => parseRouteBlock({ zones: { 'P K': { net: { ad_fr: 1 } } } }, at), 400, /is not a zone name/);
  refused(() => parseRouteBlock({ charter: { yacht: { starter_price: 1 } } }, at), 400, /charter\.yacht is not a boat type: use speedboat, catamaran, longtail/);
  refused(() => parseRouteBlock({ charter: { speedboat: { starter_includes: 0 } } }, at), 400, /starter_includes must be a whole number ≥ 1/);
  refused(() => parseRouteBlock({ transfer: { PK: { bus: 1 } } }, at), 400, /transfer\.PK\.bus is not a vehicle/);
  refused(() => parseRouteBlock({ longtail_bundle: { mode: 'sometimes' } }, at), 400, /longtail_bundle\.mode must be free or paid/);
  refused(() => parseRouteBlock({ longtail_bundle: { mode: 'paid', applies_to: 'boat' } }, at), 400, /applies_to must be seat, charter or both/);
  refused(() => parseRouteBlock({ longtail_bundle: { mode: 'free', adult: 100 } }, at), 400, /is free, so it has no adult or child price/);
  refused(() => parseRouteBlock({ travel_to: '20207-05-15' }, at), 400, /travel_to must be a real date/);
  refused(() => parseRouteBlock({ travel_from: '2026-02-31' }, at), 400, /travel_from must be a real date/);
  refused(() => parseRouteBlock({ travel_from: '2026-05-01', travel_to: '2026-04-01' }, at), 400, /travel_from must not be after travel_to/);
  refused(() => parseRouteBlock([], ''), 400, /^body must be an object$/);
});

test('a create needs a name, reads every header field, and refuses a route listed twice', () => {
  refused(() => parseRateTypeCreate({}), 400, /^name is required$/);
  refused(() => parseRateTypeCreate({ name: '  ' }), 400, /^name is required$/);
  refused(() => parseRateTypeCreate({ name: 'X', code: '' }), 400, /code must not be blank/);
  refused(() => parseRateTypeCreate({ name: 'X', id: 'has space' }), 400, /^id must be/);
  refused(() => parseRateTypeCreate({ name: 'X', valid_from: '2026-06-01', valid_to: '2026-01-01' }), 400, /valid_from must not be after valid_to/);
  refused(() => parseRateTypeCreate({ name: 'X', nationality_scope: 'fr' }), 400, /nationality_scope must be both, thai or foreign/);
  refused(() => parseRateTypeCreate({ name: 'X', active: 'yes' }), 400, /active must be true or false/);
  refused(() => parseRateTypeCreate({ name: 'X', routes: [{ route_id: 'r1' }, { route_id: 'r1' }] }), 400, /routes\[1\]\.route_id r1 is listed twice/);
  refused(() => parseRateTypeCreate({ name: 'X', routes: [{}] }), 400, /routes\[0\]\.route_id is required/);
  const created = parseRateTypeCreate({ name: ' Standard ', owner: '', note: null });
  assert.deepEqual(created.header, { name: 'Standard', note: null, color: null, owner: null, valid_from: null, valid_to: null, active: true, nationality_scope: null, transfer_unit: null },
    'trimmed; a blank owner is shared; active by default; id and code left for the store to generate');
});

test('a patch mentions only what it changes, and refuses the fields that cannot change', () => {
  assert.deepEqual(parseRateTypePatch({ note: null, active: false }), { note: null, active: false });
  refused(() => parseRateTypePatch({ code: 'NEW' }), 400, /code cannot be changed/);
  refused(() => parseRateTypePatch({ id: 'x' }), 400, /id cannot be changed/);
  refused(() => parseRateTypePatch({ name: null }), 400, /name cannot be cleared/);
  refused(() => parseRateTypePatch({ routes: [] }), 400, /PUT \/v1\/rate-types\/\{id\}\/routes\/\{route_id\}/);
});

// ── Pure: zones, codes, the summary ──────────────────────────────────────────────────────────────

test('a route takes the zones of its pier: Ranong collects from RN, every other route from PK, KL or NoTransfer', () => {
  assert.deepEqual(zonesForRoute({ pier: 'ranong' }), ['RN', 'NoTransfer']);
  assert.deepEqual(zonesForRoute({ pier: 'panwa' }), ['PK', 'KL', 'NoTransfer']);
  assert.deepEqual(zonesForRoute({}), ['PK', 'KL', 'NoTransfer'], 'a land route is priced by the zone the guest is collected from');
  const catalogue = new Map([['r5', { id: 'r5', pier: 'panwa' }], ['rn1', { id: 'rn1', pier: 'ranong' }]]);
  const rn = parseRouteBlock({ zones: { RN: { net: { ad_fr: 1500 } } } }, '');
  assertRouteBlock(rn, 'rn1', catalogue, '');
  refused(() => assertRouteBlock(rn, 'r5', catalogue, 'routes[2]'), 400, /^routes\[2\]\.zones\.RN does not apply to route r5 \(pier panwa\): use PK, KL, NoTransfer$/);
  refused(() => assertRouteBlock(parseRouteBlock({ transfer: { RN: { van: 1 } } }, ''), 'r5', catalogue, ''), 400, /^transfer\.RN does not apply/);
  refused(() => assertRouteBlock(rn, 'r99', catalogue, ''), 400, /^route r99 is not a route$/);
  refused(() => assertRouteBlock(rn, 'r99', catalogue, 'routes[0]'), 400, /^routes\[0\]\.route_id r99 is not a route$/);
  assertRouteBlock(rn, 'r5', undefined, '');   // no catalogue to check against: accepted, as bookings' routes are
});

test('a generated code is readable and unique', () => {
  assert.equal(generateRateTypeCode('Standard 2026', new Set()), 'STANDARD-2026');
  assert.equal(generateRateTypeCode('Standard 2026', new Set(['STANDARD-2026', 'STANDARD-2026-2'])), 'STANDARD-2026-3');
  assert.equal(generateRateTypeCode('ราคาพิเศษ', new Set()), 'RT', 'a name with no Latin letters still gets a code');
  assert.equal(generateRateTypeCode('A very long rate type name that goes on', new Set()), 'A-VERY-LONG-RATE-TYPE-NA');
});

const rowsOf = (id: string, name: string, active: boolean, routes: [string, object][]): RateTypeRows => {
  const rows: RateTypeRows = {
    rate: { id, code: id.toUpperCase(), name, note: null, color: null, owner_sales_id: null, valid_from: null, valid_to: null, active, nationality_scope: null,
      transfer_unit: null, created_on: null, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' },
    routes: [], seat: [], charter: [], longtail: [], transfer: [],
  };
  routes.forEach(([routeId, block], seq) => {
    const r = routeRows(id, routeId, seq, parseRouteBlock(block, ''));
    rows.routes.push(r.route); rows.seat.push(...r.seat); rows.charter.push(...r.charter); rows.longtail.push(...r.longtail); rows.transfer.push(...r.transfer);
  });
  return rows;
};

test('a route is priced when some zone offers a net adult price above 0; both adults at 0 is not offered', () => {
  const view = rateTypeView(rowsOf('rt_p', 'P', true, [
    ['r1', { zones: { PK: { net: { ad_fr: 2900 } } } }],
    ['r2', { zones: { PK: { net: { ad_fr: 0, ad_th: 0, chd_fr: 500 } } } }],
    ['r3', { zones: { NoTransfer: { net: { ad_th: 1800 } } } }],
    ['r4', { zones: { PK: { sell: { ad_fr: 3000 } } }, travel_from: '2026-01-01' }],
  ]));
  assert.deepEqual(view.priced_routes, ['r1', 'r3'], 'in the rate\'s order; a sell tier alone does not price a route');
  assert.equal(isPricedRoute(view.routes[1]), false);
  assert.deepEqual(view.route_validity, { r4: { from: '2026-01-01', to: null } }, 'only routes with a travel window');
});

test('the list is active by default, A–Z by name ignoring case, and q matches code or name', () => {
  const all = [rowsOf('rt_b', 'beach', true, []), rowsOf('rt_a', 'Andaman', true, []), rowsOf('rt_c', 'Closed', false, [])];
  assert.deepEqual(selectRateTypes(all, { active: true }).map((r) => r.id), ['rt_a', 'rt_b']);
  assert.deepEqual(selectRateTypes(all, {}).map((r) => r.id), ['rt_a', 'rt_b', 'rt_c']);
  assert.deepEqual(selectRateTypes(all, { active: false }).map((r) => r.id), ['rt_c']);
  assert.deepEqual(selectRateTypes(all, { q: 'RT_B' }).map((r) => r.id), ['rt_b'], 'by code');
  assert.deepEqual(selectRateTypes(all, { q: 'andam' }).map((r) => r.id), ['rt_a'], 'by name');
  assert.deepEqual(Object.keys(selectRateTypes(all, {})[0]).sort(),
    ['active', 'code', 'color', 'id', 'name', 'nationality_scope', 'owner', 'priced_routes', 'route_validity', 'valid_from', 'valid_to'], 'the frontend\'s ObRateTypeSummary, plus nationality_scope');
});

test('a rate type in use is not deleted: the refusal says by whom and what to do instead', () => {
  assertRateTypeUnused('rt1', { agents: 0, bookings: 0 });
  refused(() => assertRateTypeUnused('rt1', { agents: 14, bookings: 1 }), 409, /^Rate type rt1 is used by 14 agents and 1 booking; deactivate it instead/);
});

// ── HTTP, against whichever store is running ─────────────────────────────────────────────────────

test('a rate type is created, read back whole, listed, and found by code', async () => {
  const id = `tag_rt_${run}_a`;
  const created = await request('POST', '/v1/rate-types', {
    id, code: `TAG-${run}-A`, name: `Tag ${run} Standard`, color: '#1683C7', valid_from: '2026-01-01', valid_to: '2026-12-31', nationality_scope: 'both',
    transfer_unit: 'per trip', routes: [{ route_id: 'r4', ...fullBlock }, { route_id: 'r5', zones: { PK: { net: { ad_fr: 0, ad_th: 0 } } } }],
  });
  assert.equal(created.statusCode, 201, created.body);
  const body = created.json();
  assert.equal(body.id, id);
  assert.deepEqual(body.routes.map((r: { route_id: string }) => r.route_id), ['r4', 'r5'], 'routes keep the order they were sent in');
  assert.deepEqual(body.routes[0], { route_id: 'r4', ...parseRouteBlock(fullBlock, '') });
  assert.deepEqual(body.priced_routes, ['r4'], 'r5 offers nothing: both adult prices are 0');
  assert.equal(body.active, true);
  assert.equal(body.owner, null, 'shared');

  const read = await request('GET', `/v1/rate-types/${id}`);
  assert.equal(read.statusCode, 200);
  assert.deepEqual(read.json(), body, 'GET answers what POST returned');

  const listed = (await request('GET', `/v1/rate-types?q=TAG-${run}-A`)).json().rate_types;
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0], {
    id, code: `TAG-${run}-A`, name: `Tag ${run} Standard`, color: '#1683C7', active: true, owner: null, valid_from: '2026-01-01', valid_to: '2026-12-31',
    nationality_scope: 'both', priced_routes: ['r4'], route_validity: { r4: { from: '2025-11-01', to: '2026-04-30' } },
  });
});

test('a code and an id are generated when absent, and a taken one is refused with 409', async () => {
  const generated = await request('POST', '/v1/rate-types', { name: `Tag ${run} Gen` });
  assert.equal(generated.statusCode, 201, generated.body);
  assert.match(generated.json().id, /^rt_/);
  assert.equal(generated.json().code, `TAG-${run.toUpperCase()}-GEN`.slice(0, 24).replace(/-+$/, ''));
  const again = await request('POST', '/v1/rate-types', { name: `Tag ${run} Gen` });
  assert.equal(again.json().code, `${generated.json().code}-2`, 'the same name twice gets -2');

  const takenCode = await request('POST', '/v1/rate-types', { name: 'Dup', code: generated.json().code });
  assert.equal(takenCode.statusCode, 409);
  assert.match(takenCode.json().message, /code .* already exists/);
  assert.equal(takenCode.json().code, 'exists');
  const takenId = await request('POST', '/v1/rate-types', { name: 'Dup', id: generated.json().id });
  assert.equal(takenId.statusCode, 409);
});

test('PATCH changes only what it names; inactive rate types leave the default list', async () => {
  const id = `tag_rt_${run}_p`;
  assert.equal((await request('POST', '/v1/rate-types', { id, code: `TAG-${run}-P`, name: 'Before', note: 'keep me?', valid_to: '2026-06-30' })).statusCode, 201);
  const patched = await request('PATCH', `/v1/rate-types/${id}`, { name: 'After', note: null, active: false });
  assert.equal(patched.statusCode, 200, patched.body);
  assert.equal(patched.json().name, 'After');
  assert.equal(patched.json().note, null, 'null clears');
  assert.equal(patched.json().valid_to, '2026-06-30', 'unmentioned fields are left alone');
  assert.equal(patched.json().code, `TAG-${run}-P`);

  assert.equal((await request('GET', `/v1/rate-types?q=TAG-${run}-P`)).json().rate_types.length, 0, 'inactive: not in the default list');
  assert.equal((await request('GET', `/v1/rate-types?q=TAG-${run}-P&active=false`)).json().rate_types.length, 1);
  assert.equal((await request('GET', `/v1/rate-types?q=TAG-${run}-P&active=all`)).json().rate_types.length, 1);

  const reversed = await request('PATCH', `/v1/rate-types/${id}`, { valid_from: '2026-07-01' });
  assert.equal(reversed.statusCode, 400, 'the order is checked on the result: from would pass the stored to');
  assert.match(reversed.json().message, /valid_from must not be after valid_to/);
  assert.equal((await request('PATCH', `/v1/rate-types/${id}`, { code: 'X' })).statusCode, 400);
  assert.equal((await request('PATCH', '/v1/rate-types/no-such-rate', { name: 'X' })).statusCode, 404);
  assert.equal((await request('GET', '/v1/rate-types?active=maybe')).statusCode, 400);
});

test('PUT replaces one route\'s block whole; a new route goes last; DELETE takes a route off', async () => {
  const id = `tag_rt_${run}_r`;
  assert.equal((await request('POST', '/v1/rate-types', { id, code: `TAG-${run}-R`, name: 'Routes', routes: [{ route_id: 'r4', ...fullBlock }, { route_id: 'r5' }] })).statusCode, 201);

  const replaced = await request('PUT', `/v1/rate-types/${id}/routes/r4`, { zones: { KL: { net: { ad_fr: 999 } } } });
  assert.equal(replaced.statusCode, 200, replaced.body);
  const r4 = replaced.json().routes[0];
  assert.equal(r4.route_id, 'r4', 'a replaced route keeps its place');
  assert.deepEqual(r4.zones, { KL: { net: { ad_fr: 999 } } }, 'PK, the charters, the transfers and the bundle are gone: the block is replaced, not merged');
  assert.deepEqual(r4.charter, {});
  assert.equal(r4.longtail_bundle, null);

  const added = await request('PUT', `/v1/rate-types/${id}/routes/r6`, { route_id: 'r6', travel_from: '2026-01-01' });
  assert.equal(added.statusCode, 200, added.body);
  assert.deepEqual(added.json().routes.map((r: { route_id: string }) => r.route_id), ['r4', 'r5', 'r6']);

  assert.equal((await request('PUT', `/v1/rate-types/${id}/routes/r6`, { route_id: 'r7' })).statusCode, 400, 'a body naming another route');
  const bad = await request('PUT', `/v1/rate-types/${id}/routes/r6`, { zones: { PK: { net: { ad_fr: -5 } } } });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().message, 'zones.PK.net.ad_fr must be a number ≥ 0');
  assert.equal((await request('PUT', `/v1/rate-types/no-such-rate/routes/r4`, {})).statusCode, 404);

  assert.equal((await request('DELETE', `/v1/rate-types/${id}/routes/r5`)).statusCode, 204);
  assert.deepEqual((await request('GET', `/v1/rate-types/${id}`)).json().routes.map((r: { route_id: string }) => r.route_id), ['r4', 'r6']);
  const gone = await request('DELETE', `/v1/rate-types/${id}/routes/r5`);
  assert.equal(gone.statusCode, 404);
  assert.match(gone.json().message, /Route r5 is not on rate type/);
  assert.equal((await request('DELETE', '/v1/rate-types/no-such-rate/routes/r5')).statusCode, 404);
});

test('a rate type a booking names is not deleted; an unused one is', async () => {
  const used = `tag_rt_${run}_used`;
  const unused = `tag_rt_${run}_free`;
  assert.equal((await request('POST', '/v1/rate-types', { id: used, code: `TAG-${run}-USED`, name: 'Used' })).statusCode, 201);
  assert.equal((await request('POST', '/v1/rate-types', { id: unused, code: `TAG-${run}-FREE`, name: 'Free' })).statusCode, 201);
  const date = '2036-03-03';
  await request('POST', '/operations/deployments', { boat_id: `boat-rt-${run}`, route_id: 'r4', service_date: date, capacity: 10 });
  const booking = await request('POST', '/v1/bookings', { route_id: 'r4', service_date: date, pax: 1, rate_type_ref: used });
  assert.equal(booking.statusCode, 201, booking.body);

  const refusal = await request('DELETE', `/v1/rate-types/${used}`);
  assert.equal(refusal.statusCode, 409);
  assert.equal(refusal.json().code, 'in_use');
  assert.match(refusal.json().message, /used by 1 booking; deactivate it instead/);
  assert.equal((await request('GET', `/v1/rate-types/${used}`)).statusCode, 200, 'still there');

  assert.equal((await request('DELETE', `/v1/rate-types/${unused}`)).statusCode, 204);
  assert.equal((await request('GET', `/v1/rate-types/${unused}`)).statusCode, 404);
  assert.equal((await request('DELETE', `/v1/rate-types/${unused}`)).statusCode, 404);
});

test('a create is refused whole, naming the path, before anything is written', async () => {
  const id = `tag_rt_${run}_bad`;
  const response = await request('POST', '/v1/rate-types', { id, name: 'Bad', routes: [{ route_id: 'r4' }, { route_id: 'r5', charter: { yacht: {} } }] });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().message, 'routes[1].charter.yacht is not a boat type: use speedboat, catamaran, longtail');
  assert.equal((await request('GET', `/v1/rate-types/${id}`)).statusCode, 404);
  assert.equal((await request('POST', '/v1/rate-types', [])).statusCode, 400);
});

// ── Catalogue checks, which need a catalogue: PostgreSQL, or a seeded in-process store ───────────

test('the seeded in-process store checks routes, zones and owners as PostgreSQL does', () => {
  const store = new OperationsStore();
  store.seedCatalogue({ routes: [{ id: 'r5', name: 'Phi Phi', pier: 'panwa', kind: 'marine', times: [] }, { id: 'rn1', name: 'Ranong', pier: 'ranong', kind: 'marine', times: [] }] });
  store.seedAgents({ sales: [{ id: 's1', code: null, name: 'Nuch', full_name: null, designation: null, email: null, tel: null, color: null, active: true }] });
  refused(() => store.createRateType(parseRateTypeCreate({ name: 'X', routes: [{ route_id: 'r5', zones: { RN: { net: { ad_fr: 1 } } } }] })), 400, /routes\[0\]\.zones\.RN does not apply to route r5/);
  refused(() => store.createRateType(parseRateTypeCreate({ name: 'X', routes: [{ route_id: 'nowhere' }] })), 400, /routes\[0\]\.route_id nowhere is not a route/);
  refused(() => store.createRateType(parseRateTypeCreate({ name: 'X', owner: 'ghost' })), 400, /owner ghost is not a salesperson/);
  const ok = store.createRateType(parseRateTypeCreate({ name: 'Ranong', owner: 's1', routes: [{ route_id: 'rn1', zones: { RN: { net: { ad_fr: 1500 } } } }] }));
  assert.deepEqual(ok.priced_routes, ['rn1'], 'an RN price is stored and prices the route; legacy had nowhere to put it');
  refused(() => store.patchRateType(ok.id, parseRateTypePatch({ owner: 'ghost' })), 400, /owner ghost is not a salesperson/);
});

test('PostgreSQL refuses unknown routes, wrong zones and unknown owners with 400, never a 500', { skip: !url && 'PostgreSQL only: the in-process app store has no catalogue' }, async () => {
  const wrongZone = await request('POST', '/v1/rate-types', { name: 'X', routes: [{ route_id: 'r5', zones: { RN: { net: { ad_fr: 1 } } } }] });
  assert.equal(wrongZone.statusCode, 400);
  assert.match(wrongZone.json().message, /^routes\[0\]\.zones\.RN does not apply to route r5 \(pier \w+\): use PK, KL, NoTransfer$/);
  const ranong = await request('POST', '/v1/rate-types', { id: `tag_rt_${run}_rn`, code: `TAG-${run}-RN`, name: 'Ranong', routes: [{ route_id: 'r1784542898734', zones: { RN: { net: { ad_fr: 1500 } } } }] });
  assert.equal(ranong.statusCode, 201, ranong.body);
  assert.deepEqual(ranong.json().routes[0].zones, { RN: { net: { ad_fr: 1500 } } });
  assert.equal((await request('POST', '/v1/rate-types', { name: 'X', routes: [{ route_id: 'no-such-route' }] })).statusCode, 400);
  assert.equal((await request('PUT', `/v1/rate-types/tag_rt_${run}_rn/routes/no-such-route`, {})).statusCode, 400);
  const owner = await request('POST', '/v1/rate-types', { name: 'X', owner: 'no-such-salesperson' });
  assert.equal(owner.statusCode, 400);
  assert.match(owner.json().message, /owner no-such-salesperson is not a salesperson/);
});

test('both stores build the same rate type from the same request', { skip: !url && 'PostgreSQL only: compares the stores' }, async () => {
  const memory = new OperationsStore();
  const body = {
    id: `tag_rt_${run}_cmp`, code: `TAG-${run}-CMP`, name: 'Compare', owner: null, nationality_scope: 'foreign', valid_from: '2026-01-01',
    routes: [{ route_id: 'r4', ...fullBlock }, { route_id: 'r5', zones: { NoTransfer: { net: { ad_th: 1800 } } } }],
  };
  const fromPg = await request('POST', '/v1/rate-types', body);
  assert.equal(fromPg.statusCode, 201, fromPg.body);
  const fromMemory = memory.createRateType(parseRateTypeCreate(body));
  const withoutClock = ({ created_at: _c, updated_at: _u, ...rest }: Record<string, unknown>) => rest;
  assert.deepEqual(withoutClock(fromPg.json()), withoutClock(fromMemory as unknown as Record<string, unknown>));

  const putBody = { zones: { PK: { net: { ad_fr: 1 } } }, transfer: { KL: { sedan: 700 } } };
  const pgPut = await request('PUT', `/v1/rate-types/${body.id}/routes/r6`, putBody);
  const memPut = memory.putRateTypeRoute(body.id, 'r6', parseRouteBlock(putBody, ''));
  assert.deepEqual(withoutClock(pgPut.json()), withoutClock(memPut as unknown as Record<string, unknown>));
  assert.deepEqual((await request('GET', `/v1/rate-types?q=TAG-${run}-CMP`)).json().rate_types, memory.listRateTypes({ active: true }));
});
