import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { OperationsStore } from '../src/domain/operations.js';
import { createStore } from '../src/routes/operations.js';

// Alternate pickups (todo/trip-ops-and-vans-model.md, slice D), on whichever store DATABASE_URL
// selects. Route r1 comes from migration 006; the in-process store is seeded with it.
const store = createStore();
if (store instanceof OperationsStore) store.seedCatalogue({ routes: [{ id: 'r1', name: 'Tratato', pier: 'tublamu' }] });
const app = buildApp({ store });
after(async () => app.close());
const send = (method: InjectOptions['method'], url: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}) });
type Part = { idx: number; source: string; ad: number; chd: number; group: { id: string } | null; alt: { pick_hotel: string | null; drop_hotel: string | null; alt_who: string | null; pick_time: string | null } | null };
type Booking = { id: string; alt_pickups: { who: string; ad: number }[]; trips: { id: string; operations: { van_parts: Part[] } }[] };
const kata = { who: 'Mr B', ad: 1, area_id: 'pa_kata', area: 'Kata', zone: 'PK', place: 'Kata Palm' };
async function booking(date: string, extra: object, pax: object = { ad: 3, chd: 1 }) {
  await send('POST', '/operations/deployments', { boat_id: `alt-boat-${date}`, route_id: 'r1', service_date: date, capacity: 40 });
  const created = await send('POST', '/v1/bookings', { trips: [{ route_id: 'r1', date, pax, zone: 'PK' }], ...extra });
  assert.equal(created.statusCode, 201, created.body);
  return created.json() as Booking;
}
const partsOf = (b: Booking) => b.trips[0].operations.van_parts.map((p) => [p.idx, p.source, p.ad, p.chd, p.alt?.pick_hotel ?? p.alt?.drop_hotel ?? null]);
const patch = async (id: string, body: object) => {
  const r = await send('PATCH', `/v1/bookings/${id}`, body);
  assert.equal(r.statusCode, 200, r.body);
  return r.json() as Booking;
};

test('each alternate pickup becomes a van part; the main part keeps the rest, category by category', async () => {
  const b = await booking('2050-03-01', { alt_pickups: [kata] });
  assert.deepEqual(b.alt_pickups.map((a) => [a.who, a.ad]), [['Mr B', 1]]);
  assert.deepEqual(partsOf(b), [[0, 'main', 2, 1, null], [1, 'alt_pickup', 1, 0, 'Kata Palm']]);
  assert.equal(b.trips[0].operations.van_parts[1].alt!.alt_who, 'Mr B');

  const legacy = await booking('2050-03-01', { altPickups: [{ who: 'Ms C', qty: 2, areaId: 'pa_karon', place: 'Karon Inn', dropSame: true }] });
  assert.deepEqual(partsOf(legacy), [[0, 'main', 1, 1, null], [1, 'alt_pickup', 2, 0, 'Karon Inn']], 'legacy\'s spelling, and qty as adults');

  const fewer = await patch(b.id, { trips: [{ id: b.trips[0].id, route_id: 'r1', date: '2050-03-01', pax: { ad: 2, chd: 1 }, zone: 'PK' }] });
  assert.deepEqual(partsOf(fewer), [[0, 'main', 1, 1, null], [1, 'alt_pickup', 1, 0, 'Kata Palm']], 'rebuilt after a pax change');
  const none = await patch(b.id, { alt_pickups: [] });
  assert.deepEqual(partsOf(none), [[0, 'main', 2, 1, null]], 'folded back into one part');

  for (const bad of [{ alt_pickups: 'x' }, { alt_pickups: [{ ad: -1 }] }, { alt_pickups: [{ drop_same: 'no' }] }]) {
    assert.equal((await send('PATCH', `/v1/bookings/${b.id}`, bad)).statusCode, 400, JSON.stringify(bad));
  }
});

test('legacy\'s rules: a hand-made split is left alone; an entry taking everyone splits nothing; a drop-off-only entry rides with the main part', async () => {
  const date = '2050-03-02';
  const b = await booking(date, {});
  const manual = await send('PATCH', `/operations/trip-ops/${b.trips[0].id}`, { van_parts: [{ idx: 0, ad: 2, chd: 1 }, { idx: 1, ad: 1 }] });
  assert.equal(manual.statusCode, 200, manual.body);
  assert.deepEqual(partsOf(await patch(b.id, { alt_pickups: [kata] })), [[0, 'main', 2, 1, null], [1, 'manual', 1, 0, null]]);

  const all = await booking(date, { alt_pickups: [{ ...kata, ad: 3, chd: 1 }] });
  assert.deepEqual(partsOf(all), [[0, 'main', 3, 1, null]]);

  const van = (await send('POST', '/operations/vans', { name: 'Alt van', capacity: 10 })).json();
  await send('PUT', `/operations/van-days/${date}/${van.id}`, { route_ids: ['r1'] });
  const grouped = await booking(date, {});
  const group = (await send('POST', '/operations/van-groups', { service_date: date, route_id: 'r1', zone: 'PK', members: [{ trip_id: grouped.trips[0].id }], van_id: van.id })).json();
  const split = await patch(grouped.id, { alt_pickups: [kata, { who: 'Ms D', ad: 1, drop_same: false, drop_place: 'Old Town' }] });
  assert.deepEqual(split.trips[0].operations.van_parts.map((p) => [p.idx, p.group?.id ?? null]), [[0, group.id], [1, null], [2, group.id]],
    'the main part keeps its group; an own pickup starts ungrouped; a drop-off-only part rides with the main part');

  const timed = await send('PATCH', `/operations/van-groups/${group.id}`, { pickup_time: '06:30' });
  assert.equal(timed.statusCode, 200, timed.body);
  const after = (await send('GET', `/v1/bookings/${grouped.id}`)).json() as Booking & { trips: { operations: { pickup_time_final: string } }[] };
  assert.equal(after.trips[0].operations.pickup_time_final, '06:30', 'the group time is the trip\'s final pickup');
  const own = await send('PATCH', `/operations/trip-ops/${grouped.trips[0].id}`, {
    van_parts: after.trips[0].operations.van_parts.map((p) => ({ idx: p.idx, ad: p.ad, chd: p.chd, group_id: p.group?.id ?? null, ...(p.idx === 1 ? { pick_time: '06:10' } : {}) })),
  });
  assert.equal(own.statusCode, 200, own.body);
  assert.equal(own.json().trip.operations.van_parts[1].alt.pick_time, '06:10', 'an own pickup keeps its own time');
  const notOwn = await send('PATCH', `/operations/trip-ops/${grouped.trips[0].id}`, {
    van_parts: after.trips[0].operations.van_parts.map((p) => ({ idx: p.idx, ad: p.ad, chd: p.chd, ...(p.idx === 0 ? { pick_time: '06:10' } : {}) })),
  });
  assert.equal(notOwn.statusCode, 400, notOwn.body);
});
