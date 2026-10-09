import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { OperationsStore } from '../src/domain/operations.js';
import { effectiveZone, rebalanceParts, returnPool, type StoredVanPart, type VanOnDay } from '../src/domain/van-groups.js';
import type { Van } from '../src/domain/vans.js';
import { createStore } from '../src/routes/operations.js';

// Van parts and groups (todo/trip-ops-and-vans-model.md, slice A2), on whichever store DATABASE_URL
// selects. Route r1 comes from migration 006; the in-process store is seeded with it.
const store = createStore();
if (store instanceof OperationsStore) store.seedCatalogue({ routes: [{ id: 'r1', name: 'Tratato', pier: 'tublamu' }] });
const app = buildApp({ store });
after(async () => app.close());
const send = (method: InjectOptions['method'], url: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}) });
type Trip = { id: string; operations: { pickup_time_final: string | null; return_same_van: boolean; van_parts: { idx: number; ad: number; chd: number; group: { id: string; number: number } | null; sequence: number | null }[] } };

/** A day on r1 with a boat, and vans on the programme that day. */
async function day(date: string, vans: { capacity: number; on?: boolean }[]) {
  await send('POST', '/operations/deployments', { boat_id: `vg-boat-${date}`, route_id: 'r1', service_date: date, capacity: 60 });
  const ids: string[] = [];
  for (const v of vans) {
    const van = (await send('POST', '/operations/vans', { name: `Van ${date}`, capacity: v.capacity })).json();
    if (v.on !== false) assert.equal((await send('PUT', `/operations/van-days/${date}/${van.id}`, { route_ids: ['r1'] })).statusCode, 200);
    ids.push(van.id);
  }
  return ids;
}
async function booking(date: string, pax: object, zone = 'PK', extra: object = {}) {
  const created = await send('POST', '/v1/bookings', { trips: [{ route_id: 'r1', date, pax, zone, pickup_time: '07:00' }], ...extra });
  assert.equal(created.statusCode, 201, created.body);
  const b = created.json() as { id: string; trips: Trip[] };
  return { id: b.id, trip: b.trips[0].id };
}
const tripOf = async (bookingId: string): Promise<Trip> => (await send('GET', `/v1/bookings/${bookingId}`)).json().trips[0];
const groups = async (date: string) => (await send('GET', `/operations/van-groups?service_date=${date}&route_id=r1`)).json().groups as { id: string; number: number; pax: number; members: { trip_id: string; idx: number; sequence: number }[] }[];
const refused = (response: { statusCode: number; json(): { code?: string } }, status: number, code?: string) => {
  assert.equal(response.statusCode, status, JSON.stringify(response.json()));
  if (code) assert.equal(response.json().code, code);
};

test('a group takes parts of one zone in order, numbered across the day; its van must be on the programme and seat them', async () => {
  const date = '2048-03-01';
  const [big, small, elsewhere] = await day(date, [{ capacity: 12 }, { capacity: 4 }, { capacity: 20, on: false }]);
  const a = await booking(date, { ad: 3 }), b = await booking(date, { ad: 2, chd: 1 }), kl = await booking(date, { ad: 1 }, 'KL');

  const created = await send('POST', '/operations/van-groups', { service_date: date, route_id: 'r1', zone: 'PK', members: [{ trip_id: b.trip, idx: 0 }, { trip_id: a.trip }] });
  assert.equal(created.statusCode, 201, created.body);
  const g = created.json();
  assert.deepEqual([g.number, g.pax, g.van_id, g.members.map((m: { trip_id: string; sequence: number }) => [m.trip_id, m.sequence])], [1, 6, null, [[b.trip, 1], [a.trip, 2]]]);
  assert.deepEqual((await tripOf(a.id)).operations.van_parts.map((p) => [p.group?.number, p.sequence]), [[1, 2]], 'a booking read shows its group');
  const second = await send('POST', '/operations/van-groups', { service_date: date, route_id: 'r1', zone: 'KL', members: [{ trip_id: kl.trip }] });
  assert.equal(second.json().number, 2, 'one numbering per route and day, across zones');

  refused(await send('POST', '/operations/van-groups', { service_date: date, route_id: 'r1', zone: 'KL', members: [{ trip_id: a.trip }] }), 409, 'zone_mismatch');
  refused(await send('PATCH', `/operations/van-groups/${g.id}`, { van_id: elsewhere }), 409, 'van_not_in_pool');
  refused(await send('PATCH', `/operations/van-groups/${g.id}`, { van_id: small }), 409, 'van_over_capacity');
  const vanned = await send('PATCH', `/operations/van-groups/${g.id}`, { van_id: big, pickup_time: '06:40' });
  assert.equal(vanned.statusCode, 200, vanned.body);
  assert.deepEqual([vanned.json().van_id, vanned.json().capacity, vanned.json().pickup_time], [big, 12, '06:40']);
  assert.equal((await tripOf(b.id)).operations.pickup_time_final, '06:40', 'the group time is every member\'s final pickup');

  const round = await send('PATCH', `/operations/van-groups/${second.json().id}`, { van_id: big });
  refused(round, 409, 'van_in_other_group');
  assert.match((round.json() as unknown as { message: string }).message, /group 1 · 06:40/);
  assert.equal((await send('PATCH', `/operations/van-groups/${second.json().id}`, { van_id: big, allow_second_round: true })).statusCode, 200);

  const c = await booking(date, { ad: 7 });
  refused(await send('POST', `/operations/van-groups/${g.id}/members`, { members: [{ trip_id: c.trip }] }), 409, 'van_over_capacity');
  const d = await booking(date, { ad: 2 });
  const added = await send('POST', `/operations/van-groups/${g.id}/members`, { members: [{ trip_id: d.trip }] });
  assert.deepEqual(added.json().members.map((m: { sequence: number }) => m.sequence), [1, 2, 3], 'added after the last');
});

test('who cannot ride: a cancelled booking, a NoTransfer seat; a private van add-on picks one up in its zone', async () => {
  const date = '2048-03-02';
  await day(date, [{ capacity: 10 }]);
  const gone = await booking(date, { ad: 2 }), self = await booking(date, { ad: 2 }, 'NoTransfer');
  const privateVan = await booking(date, { ad: 2 }, 'NoTransfer', { add_ons: [{ type: 'transfer-r1-KL-van', amount: 0 }] });
  await send('POST', `/v1/bookings/${gone.id}/cancel`, { category: 'sick' });
  refused(await send('POST', '/operations/van-groups', { service_date: date, route_id: 'r1', zone: 'PK', members: [{ trip_id: gone.trip }] }), 409, 'cancelled');
  refused(await send('POST', '/operations/van-groups', { service_date: date, route_id: 'r1', zone: 'NoTransfer', members: [{ trip_id: self.trip }] }), 409, 'self_arrive');
  assert.equal((await send('POST', '/operations/van-groups', { service_date: date, route_id: 'r1', zone: 'KL', members: [{ trip_id: privateVan.trip }] })).statusCode, 201);
  assert.equal((await send('POST', '/operations/van-groups', { service_date: date, route_id: 'r1', zone: 'PK', members: [{ trip_id: 'trip_nowhere' }] })).statusCode, 400);
});

test('a trip split across vans: parts add up to its passengers, a pax change reshapes them, a move drops them and the emptied group hides', async () => {
  const date = '2048-03-03';
  await day(date, [{ capacity: 10 }]);
  const b = await booking(date, { ad: 4, chd: 2 });
  const g = (await send('POST', '/operations/van-groups', { service_date: date, route_id: 'r1', zone: 'PK', members: [{ trip_id: b.trip }] })).json();
  const ops = (body: object) => send('PATCH', `/operations/trip-ops/${b.trip}`, body);

  refused(await ops({ van_parts: [{ idx: 0, ad: 4 }, { idx: 1, chd: 1 }] }), 400);
  const split = await ops({ van_parts: [{ idx: 0, ad: 4, chd: 0, group_id: g.id, sequence: 1 }, { idx: 1, chd: 2 }] });
  assert.equal(split.statusCode, 200, split.body);
  assert.deepEqual(split.json().warnings, ['child_without_adult'], 'legacy warns, and lets it be');
  assert.deepEqual(split.json().trip.operations.van_parts.map((p: { idx: number; ad: number; chd: number; group: { id: string } | null }) => [p.idx, p.ad, p.chd, p.group?.id ?? null]),
    [[0, 4, 0, g.id], [1, 0, 2, null]]);

  const fewer = await send('PATCH', `/v1/bookings/${b.id}`, { trips: [{ id: b.trip, route_id: 'r1', date, pax: { ad: 4, chd: 1 }, zone: 'PK', pickup_time: '07:00' }] });
  assert.equal(fewer.statusCode, 200, fewer.body);
  assert.deepEqual(fewer.json().trips[0].operations.van_parts.map((p: { ad: number; chd: number }) => [p.ad, p.chd]), [[4, 0], [0, 1]], 'the split part shrinks once the main part has none');

  const moved = await send('PATCH', `/v1/bookings/${b.id}`, { trips: [{ id: b.trip, route_id: 'r1', date: '2048-03-04', pax: { ad: 4, chd: 1 }, zone: 'PK' }] });
  assert.equal(moved.statusCode, 200, moved.body);
  assert.deepEqual(moved.json().trips[0].operations.van_parts.map((p: { group: unknown }) => p.group), [null], 'arranged for the old day');
  assert.deepEqual(await groups(date), [], 'the emptied group is kept but not shown');
  const c = await booking(date, { ad: 1 });
  const next = await send('POST', '/operations/van-groups', { service_date: date, route_id: 'r1', zone: 'PK', members: [{ trip_id: c.trip }] });
  assert.equal(next.json().number, 2, 'it keeps its number');
  assert.equal((await send('POST', `/operations/van-groups/${g.id}/members`, { members: [{ trip_id: c.trip }] })).statusCode, 200, 'and can be filled again');
  assert.deepEqual((await groups(date)).map((x) => x.number), [1], 'shown again; group 2 is the emptied one now');
});

test('order, disband and clearing the route\'s vans; a zone change leaves the group', async () => {
  const date = '2048-03-05';
  const [van] = await day(date, [{ capacity: 10 }]);
  const a = await booking(date, { ad: 1 }), b = await booking(date, { ad: 1 });
  const g = (await send('POST', '/operations/van-groups', { service_date: date, route_id: 'r1', zone: 'PK', members: [{ trip_id: a.trip }, { trip_id: b.trip }], van_id: van })).json();
  assert.equal(g.van_id, van);
  refused(await send('PUT', `/operations/van-groups/${g.id}/order`, { members: [{ trip_id: a.trip }] }), 400);
  const ordered = await send('PUT', `/operations/van-groups/${g.id}/order`, { members: [{ trip_id: b.trip }, { trip_id: a.trip }] });
  assert.deepEqual(ordered.json().members.map((m: { trip_id: string }) => m.trip_id), [b.trip, a.trip]);
  const cleared = await send('PUT', `/operations/van-groups/${g.id}/order`, { clear: true });
  assert.deepEqual(cleared.json().members.map((m: { sequence: unknown }) => m.sequence), [null, null]);

  const routeClear = await send('POST', '/operations/van-groups/clear', { service_date: date, route_id: 'r1' });
  assert.deepEqual(routeClear.json().groups.map((x: { van_id: unknown }) => x.van_id), [null], 'R14: the group stays, without its van');

  await send('PATCH', `/operations/van-groups/${g.id}`, { pickup_time: '06:30' });
  const rezoned = await send('PATCH', `/v1/bookings/${b.id}`, { trips: [{ id: b.trip, route_id: 'r1', date, pax: { ad: 1 }, zone: 'KL', pickup_time: '07:00' }] });
  assert.equal(rezoned.json().trips[0].operations.van_parts[0].group, null, 'a group holds one zone');

  assert.equal((await send('DELETE', `/operations/van-groups/${g.id}`)).statusCode, 204);
  const left = await tripOf(a.id);
  assert.deepEqual([left.operations.van_parts[0].group, left.operations.pickup_time_final], [null, '06:30'], 'R13: the final pickup stays');
  assert.equal((await send('DELETE', `/operations/van-groups/${g.id}`)).statusCode, 404);
});

test('rules: the main part takes a pax change; private vans; the return pool', () => {
  const part = (idx: number, ad: number, chd = 0): StoredVanPart => ({ idx, source: idx ? 'manual' : 'main', ad, chd, inf: 0, foc: 0, group_id: idx ? null : 'g', sequence: null, return_van_id: null, alt: null });
  assert.deepEqual(rebalanceParts([part(0, 2), part(1, 2)], [{ category: 'ad', residency: 'unknown', count: 6 }]).map((p) => p.ad), [4, 2]);
  assert.deepEqual(rebalanceParts([part(0, 2), part(1, 2), part(2, 1)], [{ category: 'ad', residency: 'unknown', count: 2 }]).map((p) => p.ad), [0, 2]);
  assert.equal(effectiveZone({ pickup_zone: 'PK', add_ons: [] }, { booking_mode: 'charter', zone: 'KL', route_id: 'r1' }), '__CHARTER__');
  assert.equal(effectiveZone({ pickup_zone: 'PK', add_ons: [] }, { booking_mode: 'seat', zone: undefined, route_id: 'r1' }), 'PK');
  assert.equal(effectiveZone({ add_ons: [{ type: 'transfer-r2-KL-van', seq: 0 }] }, { booking_mode: 'seat', zone: 'NoTransfer', route_id: 'r1' }), 'NoTransfer', 'another route\'s van');

  // Each van's zone that day comes from the matrix (vanZoneOn, tested in vans.test.ts).
  const van = (id: string, zone: 'PK' | 'KL', route_ids: string[], usable = true): VanOnDay => ({ van: { id } as Van, usable, route_ids, zone });
  const vans = [van('on', 'PK', ['r1']), van('kl', 'KL', []), van('klpier', 'KL', ['r9']), van('off', 'KL', [], false)];
  assert.deepEqual(returnPool(vans, 'r1', 'KL').map((v) => v.van.id), ['on', 'kl', 'klpier'], 'the outbound pool, plus usable vans in the zone that day');
  assert.deepEqual(returnPool(vans, 'r1', 'NoTransfer'), []);
  assert.deepEqual(returnPool(vans, 'r1', '__CHARTER__').map((v) => v.van.id), ['on', 'kl', 'klpier']);
});
