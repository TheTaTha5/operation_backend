import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { OperationsStore } from '../src/domain/operations.js';
import { nextVanId, vanStatusOn, type VanStatusRange } from '../src/domain/vans.js';
import { createStore } from '../src/routes/operations.js';

// The van fleet and its month matrix (todo/trip-ops-and-vans-model.md, slice A3), on whichever store
// DATABASE_URL selects. Routes r1 and r2 come from migration 006; the in-process store is seeded.
const store = createStore();
if (store instanceof OperationsStore) store.seedCatalogue({ routes: [{ id: 'r1', name: 'Tratato', pier: 'tublamu' }, { id: 'r2', name: 'Tiger', pier: 'tublamu' }] });
const app = buildApp({ store });
after(async () => app.close());
const send = (method: InjectOptions['method'], url: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}) });
const newVan = async (fields: object = {}) => {
  const created = await send('POST', '/operations/vans', { name: 'Van T', capacity: 10, ...fields });
  assert.equal(created.statusCode, 201, created.body);
  return created.json() as { id: string; [key: string]: unknown };
};

test('a van is created with legacy\'s defaults and a legacy-style id, edited, and never deleted', async () => {
  const van = await newVan({ name: '  Van 3 ', plate: 'กข 1234', ownership: 'partner', partnerName: 'Somchai Co', color: '#0F6E56' });
  assert.match(van.id, /^veh\d{2,}$/);
  assert.deepEqual({ ...van, id: undefined }, {
    id: undefined, name: 'Van 3', plate: 'กข 1234', type: 'van', capacity: 10, ownership: 'partner', partner_name: 'Somchai Co', zone_base: 'PK',
    color: '#0f6e56', driver: null, driver_phone: null, active: true,
  });
  const own = await send('PATCH', `/operations/vans/${van.id}`, { ownership: 'own', zone_base: 'KL', active: false });
  assert.equal(own.statusCode, 200, own.body);
  assert.deepEqual([own.json().partner_name, own.json().zone_base, own.json().active], [null, 'KL', false], 'an own van has no partner (legacy vehFormSave)');
  assert.ok((await send('GET', '/operations/vans')).json().vans.some((v: { id: string }) => v.id === van.id));
  assert.equal((await send('DELETE', `/operations/vans/${van.id}`)).statusCode, 404, 'there is no delete');

  for (const [body, message] of [
    [{ capacity: 9 }, /name is required/], [{ name: 'X', capacity: 0 }, /capacity must be a whole number/],
    [{ name: 'X', ownership: 'leased' }, /ownership must be one of own, partner/], [{ name: 'X', color: 'red' }, /color must be #rrggbb/],
  ] as const) {
    const refused = await send('POST', '/operations/vans', body);
    assert.equal(refused.statusCode, 400, refused.body);
    assert.match(refused.json().message, message);
  }
  assert.equal((await send('PATCH', '/operations/vans/veh_nowhere', { name: 'X' })).statusCode, 404);
});

test('the month matrix: a van\'s programmes, its day status and driver, and what the day comes to', async () => {
  const van = await newVan();
  const [day, next] = ['2047-02-01', '2047-02-02'];
  const put = await send('PUT', `/operations/van-days/${day}/${van.id}`, { route_ids: ['r1', 'r2', 'r1'], driver: 'Somchai', phone: '081' });
  assert.equal(put.statusCode, 200, put.body);
  assert.deepEqual(put.json(), {
    van_id: van.id, service_date: day, route_ids: ['r1', 'r2'], status: null, driver: 'Somchai', driver_phone: '081', plate: null, sent_at: null,
    status_on: null, usable: true,
  });
  assert.equal((await send('PUT', `/operations/van-days/${day}/${van.id}`, { route_ids: ['nowhere'] })).statusCode, 400, 'an unknown route');
  assert.equal((await send('PUT', `/operations/van-days/${day}/veh_nowhere`, { driver: 'X' })).statusCode, 404);

  const off = await send('POST', `/operations/vans/${van.id}/status-ranges`, { status: 'maintenance', from_date: day, to_date: null, note: 'gearbox' });
  assert.equal(off.statusCode, 201, off.body);
  const matrix = await send('GET', `/operations/van-days?from=${day}&to=${next}`);
  assert.equal(matrix.statusCode, 200, matrix.body);
  const cells = matrix.json().days.filter((d: { van_id: string }) => d.van_id === van.id);
  assert.deepEqual(cells.map((d: { service_date: string; route_ids: string[]; status_on: string; usable: boolean }) => [d.service_date, d.route_ids, d.status_on, d.usable]),
    [[day, ['r1', 'r2'], 'maintenance', false], [next, [], 'maintenance', false]], 'an open-ended range covers every day after');
  assert.ok(matrix.json().status_ranges.some((r: { id: number }) => r.id === off.json().id));

  const available = await send('PUT', `/operations/van-days/${day}/${van.id}`, { status: 'available' });
  assert.deepEqual([available.json().status_on, available.json().usable, available.json().driver], ['available', true, 'Somchai'], 'the day\'s own status wins; the rest is kept');
  const cleared = await send('PUT', `/operations/van-days/${day}/${van.id}`, { route_ids: [], status: null, driver: null, driver_phone: null });
  assert.deepEqual([cleared.json().route_ids, cleared.json().status_on], [[], 'maintenance']);

  const edited = await send('PATCH', `/operations/vans/${van.id}/status-ranges/${off.json().id}`, { to_date: day });
  assert.equal(edited.statusCode, 200, edited.body);
  assert.equal((await send('GET', `/operations/van-days?from=${next}&to=${next}`)).json().days.find((d: { van_id: string }) => d.van_id === van.id).usable, true);
  assert.equal((await send('PATCH', `/operations/vans/${van.id}/status-ranges/${off.json().id}`, { to_date: '2047-01-01' })).statusCode, 400, 'to before from');
  assert.equal((await send('DELETE', `/operations/vans/${van.id}/status-ranges/${off.json().id}`)).statusCode, 204);
  assert.equal((await send('DELETE', `/operations/vans/${van.id}/status-ranges/${off.json().id}`)).statusCode, 404);
  assert.equal((await send('GET', `/operations/van-days?from=${day}&to=2047-06-01`)).statusCode, 400, 'a range of more than 93 days');
});

test('legacy rules: ids number on from the highest, and the latest range wins where they overlap', () => {
  assert.equal(nextVanId([]), 'veh01');
  assert.equal(nextVanId(['veh09', 'veh12abc', 'other']), 'veh13');
  const range = (id: number, status: VanStatusRange['status'], from: string, to: string | null): VanStatusRange => ({ id, van_id: 'v', status, from_date: from, to_date: to, note: null });
  const ranges = [range(2, 'off', '2047-01-01', '2047-01-10'), range(1, 'maintenance', '2047-01-05', null)];
  assert.equal(vanStatusOn(ranges, undefined, '2047-01-06'), 'off');
  assert.equal(vanStatusOn(ranges, undefined, '2047-01-11'), 'maintenance');
  assert.equal(vanStatusOn(ranges, undefined, '2046-12-31'), null);
});
