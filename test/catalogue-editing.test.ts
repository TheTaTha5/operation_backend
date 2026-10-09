import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';

process.env.AUTH_JWT_SECRET = 'catalogue-editing-test-secret';
const { buildApp } = await import('../src/app.js');
const { OperationsStore } = await import('../src/domain/operations.js');
const { createStore } = await import('../src/routes/operations.js');
const { todayInThailand } = await import('../src/domain/calendar.js');
const { closeOverlaps, guessFamily, routeOrder, storedStatus, ROUTE_COLORS } = await import('../src/domain/catalogue.js');
const { writeNeed } = await import('../src/domain/users.js');
const { seedAgents, seedUser, tokenFor } = await import('./users-helper.js');

// Catalogue editing (todo/catalogue-editing-model.md, decided 2026-10-09), on whichever store
// DATABASE_URL selects. The in-process store gets r1 the way PostgreSQL's migration 006 gives it.
const store = createStore();
if (store instanceof OperationsStore) store.seedCatalogue({ routes: [{ id: 'r1', name: 'Early Tratato Similan Islands', pier: 'tublamu', family_id: 'similan' }] });
const app = buildApp({ store });
after(async () => app.close());
await seedAgents(store, [], { a_b2c: null });
await seedUser(store, { username: 'cat-admin', role: 'admin' });
await seedUser(store, { username: 'cat-config', edit_areas: ['config'] });
await seedUser(store, { username: 'cat-ops', edit_areas: ['operations'] });
await seedUser(store, { username: 'cat-unlock', edit_areas: ['operations'], actions: ['act-capunlock'] });
await seedUser(store, { username: 'cat-fleet', edit_areas: ['fleet'] });
await seedUser(store, { username: 'cat-lk', edit_areas: ['operations'], agent_id: 'a_b2c' });
const as = {
  admin: await tokenFor(app, 'cat-admin'), config: await tokenFor(app, 'cat-config'), ops: await tokenFor(app, 'cat-ops'),
  unlock: await tokenFor(app, 'cat-unlock'), fleet: await tokenFor(app, 'cat-fleet'), lk: await tokenFor(app, 'cat-lk'),
};
const send = (method: InjectOptions['method'], url: string, payload?: object, headers: Record<string, string> = as.admin) =>
  app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
/** Unique per run, so a rerun on one database never meets its own leftovers. */
const run = Date.now().toString(36);
const today = todayInThailand();

test('families: an editable table seeded with legacy\'s ten', async () => {
  const list = (await send('GET', '/v1/route-families')).json().families as { id: string }[];
  for (const id of ['similan', 'phiphi', 'transfer', 'citytour', 'activity']) assert.ok(list.some((f) => f.id === id), id);

  assert.equal((await send('POST', '/v1/route-families', { name: 'Island hop' }, as.ops)).statusCode, 403, 'config only');
  const made = await send('POST', '/v1/route-families', { name: `Island Hopping ${run}`, color: '#123456' }, as.config);
  assert.equal(made.statusCode, 201, made.body);
  assert.equal(made.json().id, `island-hopping-${run}`, 'an id made from the name');
  const taken = await send('POST', '/v1/route-families', { id: made.json().id, name: 'Again' });
  assert.deepEqual([taken.statusCode, taken.json().code], [409, 'family_exists']);
  assert.equal((await send('POST', '/v1/route-families', { name: 'x', color: 'red' })).statusCode, 400);
  assert.equal((await send('PATCH', `/v1/route-families/${made.json().id}`, { id: 'other' })).statusCode, 400, 'the id is permanent');
  const renamed = await send('PATCH', `/v1/route-families/${made.json().id}`, { name: 'Island hopping', sort: 20 });
  assert.deepEqual([renamed.statusCode, renamed.json().name, renamed.json().sort], [200, 'Island hopping', 20]);

  const route = (await send('POST', '/v1/routes', { name: `Hop ${run}`, pier: 'panwa', family_id: made.json().id })).json().route;
  const used = await send('DELETE', `/v1/route-families/${made.json().id}`);
  assert.deepEqual([used.statusCode, used.json().code], [409, 'family_in_use']);
  assert.equal((await send('PATCH', `/v1/routes/${route.id}`, { family_id: null })).statusCode, 200);
  assert.equal((await send('DELETE', `/v1/route-families/${made.json().id}`)).statusCode, 204);
  assert.equal((await send('DELETE', `/v1/route-families/${made.json().id}`)).statusCode, 404);
});

test('a new route: the server picks its id, colour, place and (unsaid) family', async () => {
  const before = (await send('GET', '/v1/routes')).json().routes as { sort?: number }[];
  const res = await send('POST', '/v1/routes', { name: `Similan Islands by Yacht ${run}`, pier: 'tublamu', islands: 'เกาะ 4' }, as.config);
  assert.equal(res.statusCode, 201, res.body);
  const { created, route, warnings } = res.json();
  assert.equal(created, true);
  assert.match(route.id, /^r\d+$/);
  assert.equal(route.kind, 'marine');
  assert.equal(route.family_id, 'similan', 'guessed from the name, as Love Kingdom\'s create does');
  assert.ok((ROUTE_COLORS as readonly string[]).includes(route.color));
  assert.deepEqual(route.times, ['08:00']);
  assert.equal(route.sort, Math.max(-1, ...before.map((r) => r.sort ?? -1)) + 1, 'after the last');
  assert.deepEqual([route.seasons, route.overrides], [[], []]);
  assert.deepEqual(warnings, []);
  assert.equal((await send('GET', `/v1/routes/${route.id}`)).json().name, route.name);
  const twin = await send('POST', '/v1/routes', { name: route.name, pier: 'tublamu' });
  assert.equal(twin.json().warnings[0].code, 'duplicate_name');

  // Every server-owned or validated field refused with a wrong value.
  const refused = async (body: object, pattern: RegExp) => {
    const r = await send('POST', '/v1/routes', body);
    assert.equal(r.statusCode, 400, JSON.stringify(body));
    assert.match(r.json().message, pattern);
  };
  await refused({ id: 'r-mine', name: 'x', pier: 'panwa' }, /assigned by the server/);
  await refused({ sort: 3, name: 'x', pier: 'panwa' }, /routes\/order/);
  await refused({ name: 'x', pier: 'panwa', daily_cap: 20 }, /daily_cap is not kept here/);
  await refused({ name: 'x', pier: 'panwa', code: 'SIM' }, /code is not kept here/);
  await refused({ name: 'x', pier: 'panwa', meal_venue_id: 'mv1' }, /meal_venue_id/);
  await refused({ name: 'x', kind: 'marine' }, /pier is required/);
  await refused({ name: 'x', pier: 'phuket' }, /pier must be one of/);
  await refused({ name: 'x', kind: 'sea', pier: 'panwa' }, /kind must be marine or land/);
  await refused({ name: 'Sunset cruise', pier: 'panwa' }, /family_id is required/);
  await refused({ name: 'x', pier: 'panwa', family_id: 'nope' }, /not a family/);
  await refused({ name: 'x', pier: 'panwa', family_id: 'similan', times: ['7:30'] }, /HH:MM/);
  await refused({ name: '', pier: 'panwa' }, /name is required/);
  await refused({ name: 'x', pier: 'panwa', color: 'blue' }, /#rrggbb/);

  const blankCap = await send('POST', '/v1/routes', { name: `Night market ${run}`, pier: 'other', daily_cap: null, family_id: null, times: ['18:00', ''] });
  assert.equal(blankCap.statusCode, 201, blankCap.body);
  const land = blankCap.json().route;
  assert.deepEqual([land.kind, land.pier, land.family_id, land.times], ['land', undefined, undefined, ['18:00']], '"other" is land; null family is none; blank times dropped');
});

test('Love Kingdom creates its products as routes, once per ext_id', async () => {
  const ext = `PTP-${run}:VT-1`;
  const made = await send('POST', '/v1/routes', { externalId: ext, name: `Fantasea ${run}`, kind: 'land', seasons: [{ type: 'open', from: '2030-01-01', to: '2030-12-31' }] }, as.lk);
  assert.equal(made.statusCode, 201, made.body);
  const route = made.json().route;
  assert.deepEqual([route.ext_id, route.family_id, route.seasons.length], [ext, 'transfer', 1], 'a land route is a transfer unless named a city tour');
  const again = await send('POST', '/v1/routes', { ext_id: ext, name: 'Renamed', kind: 'land' }, as.lk);
  assert.deepEqual([again.statusCode, again.json().created, again.json().route.id, again.json().route.name], [200, false, route.id, route.name], 'nothing changes');
  assert.equal((await send('POST', '/v1/routes', { ext_id: `CT-${run}`, name: 'Phuket City Tour', kind: 'land' }, as.lk)).json().route.family_id, 'citytour');

  // Only the create: the service login edits nothing else in the catalogue.
  assert.equal((await send('PATCH', `/v1/routes/${route.id}`, { name: 'x' }, as.lk)).statusCode, 403);
  assert.equal((await send('DELETE', `/v1/routes/${route.id}`, undefined, as.lk)).statusCode, 403);
  assert.equal((await send('POST', '/v1/boats', { name: 'x', pier: 'panwa' }, as.lk)).statusCode, 403);
  assert.equal((await send('POST', '/v1/routes', { name: 'x', kind: 'land' }, as.ops)).statusCode, 403, 'a staff login needs config');

  const other = (await send('POST', '/v1/routes', { name: `Other ${run}`, kind: 'land', ext_id: `OT-${run}` })).json().route;
  const clash = await send('PATCH', `/v1/routes/${other.id}`, { ext_id: ext });
  assert.deepEqual([clash.statusCode, clash.json().code], [409, 'ext_id_taken']);
  assert.equal((await send('PATCH', `/v1/routes/${other.id}`, { ext_id: 'bad id!' })).statusCode, 400);
});

test('editing a route: client facts only', async () => {
  const route = (await send('POST', '/v1/routes', { name: `Krabi ${run}`, pier: 'panwa' })).json().route;
  assert.equal(route.family_id, 'krabi');
  const edited = await send('PATCH', `/v1/routes/${route.id}`, { name: `Krabi + Hong ${run}`, times: ['07:30', '09:00'], islands: 'Hong', color: '#00aa00' }, as.config);
  assert.equal(edited.statusCode, 200, edited.body);
  assert.deepEqual([edited.json().name, edited.json().times, edited.json().islands, edited.json().color], [`Krabi + Hong ${run}`, ['07:30', '09:00'], 'Hong', '#00aa00']);
  for (const [field, use] of [['sort', 'routes/order'], ['id', 'permanent'], ['seasons', 'seasons'], ['overrides', 'days']] as const) {
    const r = await send('PATCH', `/v1/routes/${route.id}`, { [field]: 1 });
    assert.equal(r.statusCode, 400, field);
    assert.match(r.json().message, new RegExp(use));
  }
  // Legacy lets a route move to land with bookings on it; a marine one keeps a pier.
  const toLand = await send('PATCH', `/v1/routes/${route.id}`, { kind: 'land', pier: null });
  assert.deepEqual([toLand.statusCode, toLand.json().kind, toLand.json().pier], [200, 'land', undefined]);
  assert.equal((await send('PATCH', `/v1/routes/${route.id}`, { kind: 'marine' })).statusCode, 400, 'a marine route needs a pier');
  assert.equal((await send('PATCH', '/v1/routes/r-none', { name: 'x' })).statusCode, 404);
  assert.equal((await send('PATCH', `/v1/routes/${route.id}`, { name: 'x' }, as.ops)).statusCode, 403);
});

test('a route anything refers to cannot be deleted', async () => {
  const route = (await send('POST', '/v1/routes', { name: `Surin ${run}`, pier: 'ranong', seasons: [{ kind: 'open', from_date: '2053-01-01', to_date: '2053-12-31' }] })).json().route;
  const booking = await send('POST', '/v1/bookings', { route_id: route.id, service_date: '2053-03-01', pax: 2 });
  assert.equal(booking.statusCode, 201, booking.body);
  assert.equal((await send('POST', '/operations/deployments', { boat_id: `bx-${run}`, route_id: route.id, service_date: '2053-03-01', capacity: 20 })).statusCode, 201);
  const refused = await send('DELETE', `/v1/routes/${route.id}`, undefined, as.config);
  assert.deepEqual([refused.statusCode, refused.json().code], [409, 'route_in_use']);
  assert.match(refused.json().message, /1 booking, 1 boat deployment: it can't be deleted/);

  const free = (await send('POST', '/v1/routes', { name: `Unused ${run}`, pier: 'ranong', family_id: null, seasons: [{ kind: 'open', from_date: '2053-01-01', to_date: '2053-02-01' }] })).json().route;
  assert.equal((await send('DELETE', `/v1/routes/${free.id}`)).statusCode, 204);
  assert.equal((await send('GET', `/v1/routes/${free.id}`)).statusCode, 404);
  assert.ok(!(await send('GET', '/v1/routes')).json().routes.some((r: { id: string }) => r.id === free.id), 'its calendar went with it');
});

test('reordering a pier group renumbers every route', async () => {
  for (const name of ['Ranong A', 'Ranong B']) assert.equal((await send('POST', '/v1/routes', { name: `${name} ${run}`, pier: 'ranong', family_id: null })).statusCode, 201);
  const before = (await send('GET', '/v1/routes')).json().routes as { id: string; pier?: string; sort?: number }[];
  const group = before.filter((r) => r.pier === 'ranong').map((r) => r.id);
  assert.ok(group.length >= 2);
  const reversed = [...group].reverse();
  assert.equal((await send('POST', '/v1/routes/order', { pier: 'ranong', route_ids: reversed.slice(1) })).statusCode, 400, 'every route of the group');
  assert.equal((await send('POST', '/v1/routes/order', { pier: 'ranong', route_ids: [...reversed.slice(1), 'r1'] })).statusCode, 400, 'only routes of the group');
  assert.equal((await send('POST', '/v1/routes/order', { pier: 'ranong', route_ids: reversed }, as.ops)).statusCode, 403);
  const res = await send('POST', '/v1/routes/order', { pier: 'ranong', route_ids: reversed }, as.config);
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().routes.map((r: { sort: number }) => r.sort), before.map((_, i) => i), 'renumbered 0..n-1');
  const after = (await send('GET', '/v1/routes')).json().routes as { id: string; pier?: string }[];
  assert.deepEqual(after.filter((r) => r.pier === 'ranong').map((r) => r.id), reversed);
  assert.deepEqual(after.filter((r) => r.pier !== 'ranong').map((r) => r.id), before.filter((r) => r.pier !== 'ranong').map((r) => r.id), 'other groups keep their order');
  // Land routes reorder too (legacy's drag found none, bug 7).
  const land = after.filter((r) => r.pier === undefined).map((r) => r.id);
  assert.equal((await send('POST', '/v1/routes/order', { pier: null, route_ids: [...land].reverse() })).statusCode, 200);
});

test('a new boat: the form\'s defaults, and every owned field refused', async () => {
  const res = await send('POST', '/v1/boats', { name: `Poseidon ${run}`, pier: 'tublamu' }, as.config);
  assert.equal(res.statusCode, 201, res.body);
  const boat = res.json();
  assert.match(boat.id, /^b\d+$/);
  assert.deepEqual([boat.capacity, boat.engine_count, boat.ownership, boat.retired, boat.status_today, boat.license_pax, boat.charter_ceiling], [40, 4, 'own', false, 'available', null, 40]);
  assert.deepEqual(boat.status_log.map((e: { status: string; from_date: string; to_date: null; loc: string }) => [e.status, e.from_date, e.to_date, e.loc]), [['available', today, null, 'Tub Lamu Pier']]);

  const full = await send('POST', '/v1/boats', {
    name: `Hermes ${run}`, nameTh: 'เฮอร์มีส', type: 'Speedboat', pier: 'panwa', cap: 56, licensePax: 70, crew: 5, fishcrew: 0, engineCount: 4,
    use: 'บรรทุกคนโดยสาร (เร็ว)', material: 'อลูมิเนียม', reg: '6051/0244/7', callsign: 'HSB7808', year: '2018', homeportCity: 'ภูเก็ต',
    gt: 22.33, nt: 15.18, loa: 18, beam: 4.2, depth: 1.2, lbp: 16, bhp: 186.5, owner: 'Love Island', homeport: 'ท่าการ ภูเก็ต', ownerAddr: '9/244',
    brand: 'Honda', model: 'BF250', note: 'n', color: '#dfa006', ownership: 'charter', status: 'fixing',
    docs: [{ name: 'ใบอนุญาตใช้เรือ', exp: '2027-03-09' }, { name: 'ใบอนุญาต สิมิลัน', exp: '2026-05-26', renewStatus: 'done' }],
  });
  assert.equal(full.statusCode, 201, full.body);
  const h = full.json();
  assert.deepEqual([h.name_th, h.vessel_use, h.build_year, h.homeport_city, h.owner_addr, h.brand, h.model, h.registered_persons, h.fish_crew, h.gt, h.ownership, h.status_today],
    ['เฮอร์มีส', 'บรรทุกคนโดยสาร (เร็ว)', '2018', 'ภูเก็ต', '9/244', 'Honda', 'BF250', 75, null, 22.33, 'charter', 'fixing']);
  assert.deepEqual(h.documents, [{ name: 'ใบอนุญาตใช้เรือ', expires_on: '2027-03-09', renew_status: null }, { name: 'ใบอนุญาต สิมิลัน', expires_on: '2026-05-26', renew_status: 'done' }]);
  assert.equal((await send('GET', `/v1/boats/${h.id}`)).json().reg, '6051/0244/7');
  assert.ok((await send('GET', '/v1/boats')).json().boats.some((b: { id: string }) => b.id === h.id));

  const refused = async (body: object, pattern: RegExp, url = '/v1/boats', method: InjectOptions['method'] = 'POST') => {
    const r = await send(method, url, body);
    assert.equal(r.statusCode, 400, JSON.stringify(body));
    assert.match(r.json().message, pattern);
  };
  const ok = { name: 'x', pier: 'panwa' };
  await refused({ ...ok, id: 'b-mine' }, /assigned by the server/);
  await refused({ ...ok, capacity: 0 }, /capacity must be a whole number above 0/);
  await refused({ ...ok, capacity: 12.5 }, /capacity/);
  await refused({ ...ok, type: 'Yacht' }, /type must be one of/);
  await refused({ name: 'x' }, /pier is required/);
  await refused({ ...ok, engine_count: 7 }, /engine_count must be 1 to 5/);
  await refused({ ...ok, retired: true }, /retire/);
  await refused({ ...ok, status_log: [] }, /status-log/);
  await refused({ ...ok, charter_ceiling: 99 }, /computed/);
  await refused({ ...ok, status: 'retired' }, /status must be one of available, fixing, unavailable/);
  await refused({ ...ok, ownership: 'partner' }, /own or charter/);
  await refused({ ...ok, gt: -1 }, /gt must be a number/);
  await refused({ ...ok, documents: [{ exp: '2027-01-01' }] }, /documents\[0\]\.name is required/);
  await refused({ ...ok, documents: [{ name: 'x', expires_on: '2027-02-30' }] }, /YYYY-MM-DD/);
  await refused({ retired_on: today }, /retire/, `/v1/boats/${h.id}`, 'PATCH');
  await refused({ status_today: 'fixing' }, /computed/, `/v1/boats/${h.id}`, 'PATCH');
  await refused({ capacity: null }, /capacity/, `/v1/boats/${h.id}`, 'PATCH');

  assert.equal((await send('POST', '/v1/boats', ok, as.fleet)).statusCode, 403, 'boat edits need config, as legacy');
  assert.equal((await send('PATCH', `/v1/boats/${h.id}`, { note: 'x' }, as.ops)).statusCode, 403);
  assert.equal((await send('PATCH', '/v1/boats/b-none', { note: 'x' })).statusCode, 404);
});

test('editing a boat: documents replaced, the status pick logged once', async () => {
  const boat = (await send('POST', '/v1/boats', { name: `Zeus ${run}`, pier: 'tublamu', documents: [{ name: 'A' }] })).json();
  const docs = await send('PATCH', `/v1/boats/${boat.id}`, { documents: [{ name: 'B', expires_on: '2028-01-01' }] }, as.config);
  assert.deepEqual(docs.json().documents, [{ name: 'B', expires_on: '2028-01-01', renew_status: null }]);
  const fixing = (await send('PATCH', `/v1/boats/${boat.id}`, { status: 'fixing' })).json();
  assert.equal(fixing.status_today, 'fixing');
  assert.equal(fixing.status_log.length, 1, 'today\'s available entry is replaced: it started today, inside the new one');
  assert.equal((await send('PATCH', `/v1/boats/${boat.id}`, { status: 'fixing', note: 'still' })).json().status_log.length, 1, 'the same status adds nothing');
  assert.equal((await send('PATCH', `/v1/boats/${boat.id}`, { name: '' })).statusCode, 400);
});

test('capacity above the licence is accepted, and sales stay capped at the licence', async () => {
  const res = await send('POST', '/v1/boats', { name: `Big ${run}`, pier: 'panwa', capacity: 50, license_pax: 45 });
  assert.equal(res.statusCode, 201, res.body);
  assert.deepEqual(res.json().warnings.map((w: { code: string }) => w.code), ['capacity_above_licence']);
  assert.equal((await send('POST', '/operations/deployments', { boat_id: res.json().id, route_id: 'r1', service_date: '2053-04-01', capacity: 50 })).statusCode, 201);
  const day = (await send('GET', '/v1/availability?route_id=r1&from=2053-04-01&to=2053-04-01')).json().days[0];
  assert.equal(day.deployments.find((d: { boat_id: string }) => d.boat_id === res.json().id).capacity, 45, 'deploymentSeats caps at the licence');
});

test('a capacity change reaches future deployments and asks before overselling a day', async () => {
  const boat = (await send('POST', '/v1/boats', { name: `Cap ${run}`, pier: 'tublamu', capacity: 30, license_pax: 40 })).json();
  const day = '2053-05-01', later = '2053-05-02', past = '2020-05-01';
  for (const date of [day, later, past]) assert.equal((await send('POST', '/operations/deployments', { boat_id: boat.id, route_id: 'r1', service_date: date, capacity: 30 })).statusCode, 201);
  const booking = (await send('POST', '/v1/bookings', { route_id: 'r1', service_date: day, pax: 25 })).json();
  assert.equal((await send('PATCH', `/operations/trip-ops/${booking.trips[0].id}`, { boat_id: boat.id })).statusCode, 200);

  const asked = await send('PATCH', `/v1/boats/${boat.id}`, { capacity: 20 }, as.config);
  assert.deepEqual([asked.statusCode, asked.json().code], [409, 'seats_sold']);
  assert.match(asked.json().message, new RegExp(`${day} \\(r1: 1 booking\\(s\\), 25 pax, 20 seats\\)`));
  assert.equal((await send('PATCH', `/v1/boats/${boat.id}`, { capacity: 20, capacity_anyway: 'maybe' })).statusCode, 400);
  const done = await send('PATCH', `/v1/boats/${boat.id}`, { capacity: 20, capacity_anyway: true });
  assert.equal(done.statusCode, 200, done.body);
  assert.deepEqual(done.json().warnings, [{ code: 'oversold', route_id: 'r1', service_date: day, boat_id: boat.id, bookings: 1, pax: 25, seats: 20 }]);
  assert.equal(done.json().deployments_updated, 2, 'today on, not the past');
  const deps = (await send('GET', '/operations/deployments?from=2020-01-01&to=2053-12-31')).json().deployments.filter((d: { boat_id: string }) => d.boat_id === boat.id);
  assert.deepEqual(deps.map((d: { service_date: string; capacity: number }) => [d.service_date, d.capacity]), [[past, 30], [day, 20], [later, 20]]);

  const version = (await send('GET', '/v1/changes')).json().version as number;
  const raised = await send('PATCH', `/v1/boats/${boat.id}`, { capacity: 35, license_pax: 38 });
  assert.deepEqual([raised.statusCode, raised.json().deployments_updated, raised.json().warnings], [200, 2, []], 'more seats need no question');
  const changes = (await send('GET', `/v1/changes?since=${version}&limit=1000`)).json().changes as { kind: string; entity_id: string; route_days: unknown }[];
  const mine = changes.filter((c) => c.kind === 'boat' && c.entity_id === boat.id);
  assert.ok(mine.some((c) => JSON.stringify(c.route_days) === JSON.stringify([{ route_id: 'r1', service_date: day }, { route_id: 'r1', service_date: later }])), 'the feed names the days whose seats moved');
});

test('retire and restore: refused while the boat is deployed from today on', async () => {
  const boat = (await send('POST', '/v1/boats', { name: `Old ${run}`, pier: 'ranong' })).json();
  const date = '2053-06-01';
  assert.equal((await send('POST', '/operations/deployments', { boat_id: boat.id, route_id: 'r1', service_date: date, capacity: 20 })).statusCode, 201);
  assert.equal((await send('POST', `/v1/boats/${boat.id}/retire`, {}, as.config)).statusCode, 403, 'legacy\'s fleet area');
  const busy = await send('POST', `/v1/boats/${boat.id}/retire`, { reason: 'sold' }, as.fleet);
  assert.deepEqual([busy.statusCode, busy.json().code], [409, 'future_deployments']);
  assert.match(busy.json().message, new RegExp(date));
  assert.equal((await send('DELETE', `/operations/deployments/${date}/${boat.id}`)).statusCode, 204);

  const retired = await send('POST', `/v1/boats/${boat.id}/retire`, { reason: 'sold' }, as.fleet);
  assert.equal(retired.statusCode, 200, retired.body);
  assert.deepEqual([retired.json().retired, retired.json().retired_on, retired.json().retired_reason, retired.json().status_today], [true, today, 'sold', 'retired']);
  const deploy = await send('POST', '/operations/deployments', { boat_id: boat.id, route_id: 'r1', service_date: date, capacity: 20 });
  assert.deepEqual([deploy.statusCode, deploy.json().code], [409, 'boat_retired']);
  assert.equal((await send('POST', `/v1/boats/${boat.id}/retire`)).json().code, 'already_retired');
  assert.equal((await send('PATCH', `/v1/boats/${boat.id}`, { retired: false })).statusCode, 400);

  const restored = await send('POST', `/v1/boats/${boat.id}/restore`, undefined, as.fleet);
  assert.deepEqual([restored.statusCode, restored.json().retired, restored.json().unretired_on, restored.json().status_today], [200, false, today, 'available']);
  assert.equal((await send('POST', `/v1/boats/${boat.id}/restore`)).json().code, 'not_retired');
});

test('the status timeline: legacy\'s checks, and an added range closes what it overlaps', async () => {
  const boat = (await send('POST', '/v1/boats', { name: `Log ${run}`, pier: 'panwa' })).json();
  const url = `/v1/boats/${boat.id}/status-log`;
  const base = { status: 'unavailable', from_date: '2053-07-10', to_date: '2053-07-20', province: 'Phuket', loc_type: 'Visit Panwa Pier', reason: 'dry_dock' };
  for (const [body, pattern] of [
    [{ ...base, to_date: undefined }, /to_date is required/], [{ ...base, reason: undefined }, /reason is required/],
    [{ ...base, province: '' }, /province is required/], [{ ...base, to_date: '2053-07-01' }, /must not precede/],
    [{ ...base, status: 'retired' }, /status must be one of/], [{ ...base, id: 'sl1' }, /assigned by the server/],
  ] as const) {
    const r = await send('POST', url, body);
    assert.equal(r.statusCode, 400, JSON.stringify(body));
    assert.match(r.json().message, pattern);
  }
  assert.equal((await send('POST', url, base, as.fleet)).statusCode, 403, 'the timeline saves with config in legacy');
  const added = await send('POST', url, base, as.config);
  assert.equal(added.statusCode, 201, added.body);
  const log = (await send('GET', `/v1/boats/${boat.id}`)).json().status_log as { id: string; status: string; from_date: string; to_date: string | null }[];
  assert.deepEqual(log.map((e) => [e.status, e.from_date, e.to_date]), [['available', today, '2053-07-09'], ['available', '2053-07-21', null], ['unavailable', '2053-07-10', '2053-07-20']],
    'the open entry ends the day before and resumes after; in legacy\'s order, the split-off part before the new entry');
  assert.equal(storedStatus(log as never, 'own', '2053-07-15'), 'unavailable');

  const edited = await send('PATCH', `${url}/${added.json().id}`, { status: 'fixing', reason: null });
  assert.deepEqual([edited.statusCode, edited.json().status, edited.json().from_date], [200, 'fixing', '2053-07-10']);
  assert.equal((await send('PATCH', `${url}/sl-none`, { note: 'x' })).statusCode, 404);
  assert.equal((await send('DELETE', `${url}/${added.json().id}`)).statusCode, 204);
  assert.equal((await send('DELETE', `${url}/${added.json().id}`)).statusCode, 404);
});

test('a boat\'s seats for one day: operations, a reason, the unlock right to raise, never past the licence', async () => {
  const boat = (await send('POST', '/v1/boats', { name: `Day ${run}`, pier: 'panwa', capacity: 30, license_pax: 40 })).json();
  const date = '2053-08-01', url = `/v1/boats/${boat.id}/capacity-overrides/${date}`;
  assert.equal((await send('POST', '/operations/deployments', { boat_id: boat.id, route_id: 'r1', service_date: date, capacity: 28 })).statusCode, 201);

  assert.equal((await send('PUT', url, { capacity: 35, reason: 'extra chairs' }, as.config)).statusCode, 403, 'operations');
  const noRight = await send('PUT', url, { capacity: 35, reason: 'extra chairs' }, as.ops);
  assert.equal(noRight.statusCode, 403);
  assert.match(noRight.json().message, /unlock boat capacity/);
  assert.match((await send('PUT', url, { capacity: 35 }, as.unlock)).json().message, /reason is required/);
  assert.match((await send('PUT', url, { capacity: 41, reason: 'x' }, as.unlock)).json().message, /licensed for 40/);
  assert.equal((await send('PUT', url, { capacity: -1, reason: 'x' }, as.unlock)).statusCode, 400);
  assert.equal((await send('PUT', url, { capacity: '35', reason: 'x' }, as.unlock)).statusCode, 400);

  const set = await send('PUT', url, { capacity: 35, reason: 'extra chairs' }, as.unlock);
  assert.equal(set.statusCode, 200, set.body);
  assert.deepEqual([set.json().capacity, set.json().normal, set.json().ceiling, set.json().overridden, set.json().set_by], [35, 28, 40, true, 'cat-unlock'],
    'normal is the day\'s deployment');
  const avail = (await send('GET', `/v1/availability?route_id=r1&from=${date}&to=${date}`)).json().days[0];
  assert.equal(avail.deployments.find((d: { boat_id: string }) => d.boat_id === boat.id).capacity, 35);
  assert.equal((await send('PUT', url, { capacity: 33, reason: 'keep a raise' }, as.ops)).statusCode, 200, 'keeping part of a raise someone else set');
  assert.equal((await send('PUT', url, { capacity: 20, reason: 'engine' }, as.ops)).json().capacity, 20, 'lowering needs only operations');
  const normal = await send('PUT', url, { capacity: 28 }, as.ops);
  assert.deepEqual([normal.json().overridden, normal.json().capacity], [false, 28], 'the normal number removes the override');
  assert.equal((await send('DELETE', url, undefined, as.ops)).statusCode, 404);

  await send('PUT', url, { capacity: 25, reason: 'weather' }, as.ops);
  assert.deepEqual((await send('GET', `/v1/boats/${boat.id}/capacity-overrides?from=2053-01-01`)).json().overrides.map((o: { service_date: string; capacity: number }) => [o.service_date, o.capacity]), [[date, 25]]);
  assert.equal((await send('DELETE', url, undefined, as.ops)).statusCode, 204);

  const past = await send('PUT', `/v1/boats/${boat.id}/capacity-overrides/2020-01-01`, { capacity: 25, reason: 'x' }, as.unlock);
  assert.deepEqual([past.statusCode, past.json().code], [409, 'past_date']);
  assert.equal((await send('DELETE', `/v1/boats/${boat.id}/capacity-overrides/2020-01-01`)).statusCode, 409);
  assert.equal((await send('PUT', `/v1/boats/${boat.id}/capacity-overrides/2053-02-30`, { capacity: 25, reason: 'x' })).statusCode, 400);
  assert.equal((await send('PUT', `/v1/boats/b-none/capacity-overrides/${date}`, { capacity: 25, reason: 'x' })).statusCode, 404);
  // Not deployed that day: normal is the boat's own capacity.
  assert.equal((await send('PUT', `/v1/boats/${boat.id}/capacity-overrides/2053-08-02`, { capacity: 25, reason: 'x' })).json().normal, 30);
});

test('pure rules: overlaps, stored status, family guesses, permissions', () => {
  const e = (id: string, from: string, to: string | null) => ({ id, status: 'available' as const, from_date: from, to_date: to, loc: null, province: null, loc_type: null, detail: null, note: null, reason: null, project_id: null, planned_over: null });
  let n = 0;
  const ids = () => `t${n++}`;
  // An entry spanning the new range is split around it; one inside it goes; one after it stays.
  assert.deepEqual(closeOverlaps([e('a', '2030-01-01', '2030-01-31'), e('b', '2030-01-12', '2030-01-14'), e('c', '2030-02-05', null)], '2030-01-10', '2030-01-20', ids)
    .map((x) => [x.id, x.from_date, x.to_date]), [['a', '2030-01-01', '2030-01-09'], ['c', '2030-02-05', null], ['t0', '2030-01-21', '2030-01-31']]);
  assert.deepEqual(closeOverlaps([e('d', '2030-01-15', null)], '2030-01-10', '2030-01-20', ids).map((x) => [x.from_date, x.to_date]), [['2030-01-21', null]], 'trimmed to after');
  assert.deepEqual(closeOverlaps([e('f', '2030-01-15', '2030-03-01')], '2030-01-10', null, ids), [], 'open-ended: whatever starts inside goes');
  assert.equal(storedStatus([], 'charter', '2030-01-01'), 'unavailable', 'a charter boat with no entry is not ours that day');
  assert.equal(storedStatus([], 'own', '2030-01-01'), 'available');
  assert.equal(storedStatus([{ ...e('x', '2030-01-01', null), status: 'fixing' }, e('y', '2030-01-01', null)], 'own', '2030-01-02'), 'available', 'same start: the later entry wins');
  assert.equal(guessFamily('Whale Shark Phi Phi Maiton Sunset', 'marine'), 'whaleshark', 'Whale before Phi Phi');
  assert.equal(guessFamily('Airport transfer', 'land'), 'transfer');
  assert.equal(guessFamily('Sunset cruise', 'marine'), undefined);
  assert.deepEqual([...routeOrder([{ id: 'a', name: 'a', pier: 'panwa' }, { id: 'b', name: 'b' }, { id: 'c', name: 'c', pier: 'panwa' }], { pier: 'panwa', route_ids: ['c', 'a'] })],
    [['c', 0], ['b', 1], ['a', 2]]);
  assert.deepEqual(writeNeed('/v1/boats/b1/capacity-overrides/2030-01-01'), { kind: 'area', areas: ['operations'] });
  assert.deepEqual(writeNeed('/v1/boats/b1/retire'), { kind: 'area', areas: ['fleet'] });
  assert.deepEqual(writeNeed('/v1/boats/b1/status-log'), { kind: 'area', areas: ['config'] });
  assert.deepEqual(writeNeed('/v1/routes'), { kind: 'area', areas: ['config'] });
  assert.deepEqual(writeNeed('/v1/route-families/x'), { kind: 'area', areas: ['config'] });
});
