import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { OperationsStore } from '../src/domain/operations.js';
import { emptyVanDay, nextVanId, vanStatusOn, vanZoneOn, type Van, type VanStatusRange, type VanZoneRange } from '../src/domain/vans.js';
import { createStore } from '../src/routes/operations.js';

// The van fleet and its month matrix (todo/trip-ops-and-vans-model.md slice A3, todo/van-extras-model.md),
// on whichever store DATABASE_URL selects. Routes r1 and r2 come from migration 006; the in-process
// store is seeded.
const store = createStore();
if (store instanceof OperationsStore) store.seedCatalogue({ routes: [{ id: 'r1', name: 'Early Tratato Similan Islands', pier: 'tublamu' }, { id: 'r2', name: 'Early Tiger Similan Islands', pier: 'tublamu' }] });
const app = buildApp({ store });
after(async () => app.close());
const send = (method: InjectOptions['method'], url: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}) });
const newVan = async (fields: object = {}) => {
  const created = await send('POST', '/operations/vans', { name: 'Van T', capacity: 10, ...fields });
  assert.equal(created.statusCode, 201, created.body);
  return created.json() as { id: string; [key: string]: unknown };
};
const logOf = async (id: string) => ((await send('GET', `/operations/vans/${id}/log`)).json().log as { kind: string; text: string }[]).map((l) => l.text);

test('a van is created with legacy\'s defaults and a legacy-style id, and edited', async () => {
  const van = await newVan({ name: '  Van 3 ', plate: 'กข 1234', ownership: 'partner', partnerName: 'Somchai Co', color: '#0F6E56' });
  assert.match(van.id, /^veh\d{2,}$/);
  assert.deepEqual({ ...van, id: undefined }, {
    id: undefined, name: 'Van 3', plate: 'กข 1234', type: 'van', capacity: 10, ownership: 'partner', partner_name: 'Somchai Co', zone_base: 'PK',
    color: '#0f6e56', driver: null, driver_phone: null, active: true, note: null,
  });
  const rented = await send('PATCH', `/operations/vans/${van.id}`, { ownership: 'rented', note: 'Khao Lak base' });
  assert.deepEqual([rented.json().ownership, rented.json().partner_name, rented.json().note], ['rented', 'Somchai Co', 'Khao Lak base'], 'a rented van keeps its lessor');
  const own = await send('PATCH', `/operations/vans/${van.id}`, { ownership: 'own', zone_base: 'KL', active: false });
  assert.equal(own.statusCode, 200, own.body);
  assert.deepEqual([own.json().partner_name, own.json().zone_base, own.json().active], [null, 'KL', false], 'an own van has no partner (legacy vehFormSave)');
  assert.ok((await send('GET', '/operations/vans')).json().vans.some((v: { id: string }) => v.id === van.id));

  for (const [body, message] of [
    [{ capacity: 9 }, /name is required/], [{ name: 'X', capacity: 0 }, /capacity must be a whole number/],
    [{ name: 'X', ownership: 'leased' }, /ownership must be one of own, rented, partner/], [{ name: 'X', color: 'red' }, /color must be #rrggbb/],
  ] as const) {
    const refused = await send('POST', '/operations/vans', body);
    assert.equal(refused.statusCode, 400, refused.body);
    assert.match(refused.json().message, message);
  }
  assert.equal((await send('PATCH', '/operations/vans/veh_nowhere', { name: 'X' })).statusCode, 404);
});

test('the log is the server\'s, in legacy\'s words, newest first', async () => {
  const van = await newVan({ driver: 'Somchai' });
  await send('PATCH', `/operations/vans/${van.id}`, { active: false, zone_base: 'KL', driver: null, color: '#112233', plate: 'not logged' });
  await send('PUT', `/operations/van-days/2047-03-01/${van.id}`, { route_ids: ['r1', 'r2'], status: 'maintenance', zone: 'PK', driver: 'not logged' });
  await send('PUT', `/operations/van-days/2047-03-01/${van.id}`, { route_ids: [] });
  await send('POST', `/operations/vans/${van.id}/status-ranges`, { status: 'off', from_date: '2047-03-05', to_date: '2047-03-07' });
  const range = (await send('POST', `/operations/vans/${van.id}/zone-ranges`, { zone: 'KL', from_date: '2047-04-01', to_date: '2047-04-30' })).json();
  await send('DELETE', `/operations/vans/${van.id}/zone-ranges/${range.id}`);
  assert.deepEqual((await logOf(van.id)).reverse(), [
    'เพิ่มรถใหม่', 'เปลี่ยนเป็น Inactive', 'ย้ายโซนหลัก PK → KL', 'เปลี่ยนคนขับ → —', 'เปลี่ยนสีประจำรถ → #112233',
    '2047-03-01 · เพิ่มเส้นทาง Early Tratato Similan Islands', '2047-03-01 · เพิ่มเส้นทาง Early Tiger Similan Islands', '2047-03-01 · ซ่อม', '2047-03-01 · โซน PK',
    '2047-03-01 · ล้างเส้นทาง', 'หยุด 2047-03-05→2047-03-07', 'สลับโซน KL · 2047-04-01→2047-04-30', 'ลบช่วงสลับโซน KL 2047-04-01',
  ]);
  assert.equal((await send('GET', `/operations/vans/${van.id}/log?limit=2`)).json().log.length, 2);
  assert.equal((await send('GET', `/operations/vans/${van.id}/log?limit=0`)).statusCode, 400);
});

test('the month matrix: a van\'s programmes, its day status, zone and driver, and what the day comes to', async () => {
  const van = await newVan();
  const [day, next] = ['2047-02-01', '2047-02-02'];
  const put = await send('PUT', `/operations/van-days/${day}/${van.id}`, { route_ids: ['r1', 'r2', 'r1'], driver: 'Somchai', phone: '081' });
  assert.equal(put.statusCode, 200, put.body);
  assert.deepEqual(put.json(), {
    van_id: van.id, service_date: day, route_ids: ['r1', 'r2'], status: null, zone: null, driver: 'Somchai', driver_phone: '081', plate: null, sent_at: null,
    status_on: null, usable: true, zone_on: 'KL',
  }, 'r1 sails from Tap Lamu, so the van works from KL that day');
  assert.equal((await send('PUT', `/operations/van-days/${day}/${van.id}`, { route_ids: ['nowhere'] })).statusCode, 400, 'an unknown route');
  assert.equal((await send('PUT', `/operations/van-days/${day}/${van.id}`, { zone: 'NoTransfer' })).statusCode, 400);
  assert.equal((await send('PUT', `/operations/van-days/${day}/veh_nowhere`, { driver: 'X' })).statusCode, 404);

  const off = await send('POST', `/operations/vans/${van.id}/status-ranges`, { status: 'maintenance', from_date: day, to_date: null, note: 'gearbox' });
  assert.equal(off.statusCode, 201, off.body);
  const zone = await send('POST', `/operations/vans/${van.id}/zone-ranges`, { zone: 'KL', from_date: next });
  assert.equal(zone.statusCode, 201, zone.body);
  const matrix = await send('GET', `/operations/van-days?from=${day}&to=${next}`);
  assert.equal(matrix.statusCode, 200, matrix.body);
  const cells = matrix.json().days.filter((d: { van_id: string }) => d.van_id === van.id);
  assert.deepEqual(cells.map((d: { service_date: string; route_ids: string[]; status_on: string; usable: boolean; zone_on: string }) => [d.service_date, d.route_ids, d.status_on, d.usable, d.zone_on]),
    [[day, ['r1', 'r2'], 'maintenance', false, 'KL'], [next, [], 'maintenance', false, 'KL']], 'an open-ended range covers every day after');
  assert.ok(matrix.json().status_ranges.some((r: { id: number }) => r.id === off.json().id));
  assert.ok(matrix.json().zone_ranges.some((r: { id: number }) => r.id === zone.json().id));

  const available = await send('PUT', `/operations/van-days/${day}/${van.id}`, { status: 'available' });
  assert.deepEqual([available.json().status_on, available.json().usable, available.json().driver], ['available', true, 'Somchai'], 'the day\'s own status wins; the rest is kept');
  const cleared = await send('PUT', `/operations/van-days/${day}/${van.id}`, { route_ids: [], status: null, driver: null, driver_phone: null });
  assert.deepEqual([cleared.json().route_ids, cleared.json().status_on, cleared.json().zone_on], [[], 'maintenance', 'PK'], 'back to its base');

  const edited = await send('PATCH', `/operations/vans/${van.id}/status-ranges/${off.json().id}`, { to_date: day });
  assert.equal(edited.statusCode, 200, edited.body);
  assert.equal((await send('GET', `/operations/van-days?from=${next}&to=${next}`)).json().days.find((d: { van_id: string }) => d.van_id === van.id).usable, true);
  assert.equal((await send('PATCH', `/operations/vans/${van.id}/status-ranges/${off.json().id}`, { to_date: '2047-01-01' })).statusCode, 400, 'to before from');
  assert.equal((await send('PATCH', `/operations/vans/${van.id}/zone-ranges/${zone.json().id}`, { zone: 'XX' })).statusCode, 400);
  assert.equal((await send('DELETE', `/operations/vans/${van.id}/status-ranges/${off.json().id}`)).statusCode, 204);
  assert.equal((await send('DELETE', `/operations/vans/${van.id}/status-ranges/${off.json().id}`)).statusCode, 404);
  assert.equal((await send('GET', `/operations/van-days?from=${day}&to=2047-06-01`)).statusCode, 400, 'a range of more than 93 days');
});

test('a van nothing uses can be deleted, with its log and ranges; one in the matrix cannot', async () => {
  const spare = await newVan();
  await send('POST', `/operations/vans/${spare.id}/status-ranges`, { status: 'off', from_date: '2047-05-01' });
  assert.equal((await send('DELETE', `/operations/vans/${spare.id}`)).statusCode, 204);
  assert.equal((await send('GET', `/operations/vans/${spare.id}`)).statusCode, 404);
  assert.equal((await send('DELETE', `/operations/vans/${spare.id}`)).statusCode, 404);

  const busy = await newVan();
  await send('PUT', `/operations/van-days/2047-05-02/${busy.id}`, { route_ids: ['r1'] });
  const refused = await send('DELETE', `/operations/vans/${busy.id}`);
  assert.deepEqual([refused.statusCode, refused.json().code], [409, 'van_in_use']);
  assert.match(refused.json().message, /set it inactive instead/);
});

test('legacy rules: ids number on from the highest; the latest status range wins, the first zone range wins', () => {
  assert.equal(nextVanId([]), 'veh01');
  assert.equal(nextVanId(['veh09', 'veh12abc', 'other']), 'veh13');
  const range = (id: number, status: VanStatusRange['status'], from: string, to: string | null): VanStatusRange => ({ id, van_id: 'v', status, from_date: from, to_date: to, note: null });
  const ranges = [range(2, 'off', '2047-01-01', '2047-01-10'), range(1, 'maintenance', '2047-01-05', null)];
  assert.equal(vanStatusOn(ranges, undefined, '2047-01-06'), 'off');
  assert.equal(vanStatusOn(ranges, undefined, '2047-01-11'), 'maintenance');
  assert.equal(vanStatusOn(ranges, undefined, '2046-12-31'), null);

  const van = { id: 'v', zone_base: 'PK' } as Van, piers = new Map([['r1', 'tublamu'], ['r9', 'panwa']]);
  const zones: VanZoneRange[] = [{ id: 2, van_id: 'v', zone: 'PK', from_date: null, to_date: null }, { id: 1, van_id: 'v', zone: 'KL', from_date: '2047-01-01', to_date: null }];
  const day = { ...emptyVanDay('v', '2047-01-02'), zone: 'PK' as const };
  assert.equal(vanZoneOn(van, { ...day, route_ids: ['r1'] }, zones, piers, '2047-01-02'), 'KL', 'the route\'s pier first');
  assert.equal(vanZoneOn(van, day, zones, piers, '2047-01-02'), 'PK', 'then the day zone');
  assert.equal(vanZoneOn(van, undefined, zones, piers, '2047-01-02'), 'KL', 'then the first range added that covers it');
  assert.equal(vanZoneOn(van, undefined, [], piers, '2047-01-02'), 'PK', 'then the base');
});
