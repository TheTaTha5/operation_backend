import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';

// Dispatch for one departure (todo/trip-ops-and-vans-model.md, slice A1), on whichever store
// DATABASE_URL selects.
const app = buildApp();
after(async () => app.close());
const send = (method: InjectOptions['method'], url: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}) });
const deploy = (boat: string, date: string) => send('POST', '/operations/deployments', { boat_id: boat, route_id: 'r1', service_date: date, capacity: 20 });
async function booking(date: string, pax: object = { ad: 4 }) {
  const created = await send('POST', '/v1/bookings', { route_id: 'r1', service_date: date, pax });
  assert.equal(created.statusCode, 201, created.body);
  return created.json() as { id: string; trips: { id: string; operations: Record<string, unknown> }[] };
}
const ops = (tripId: string, body: object) => send('PATCH', `/operations/trip-ops/${tripId}`, body);

test('every trip shows its dispatch, empty until set; a boat must sail that day', async () => {
  const day = '2046-01-05';
  await deploy('disp-a', day);
  const b = await booking(day);
  assert.deepEqual(b.trips[0].operations, {
    boat_id: null, boat_splits: [], boat_pulled: false, pickup_time_final: null, pickup_time_final_end: null,
    pickup_final_at_pier: false, return_same_van: false, pier_note: null,
    van_parts: [{ idx: 0, source: 'main', ad: 4, chd: 0, inf: 0, foc: 0, group: null, sequence: null, return_van_id: null, alt: null }],
    checkins: { van: [], pier: [] },
  });
  const tripId = b.trips[0].id;
  const set = await ops(tripId, { boat_id: 'disp-a', pickup_time_final: '06:40', pickup_time_final_end: '06:55', pier_note: 'Late, call guide' });
  assert.equal(set.statusCode, 200, set.body);
  const o = set.json().trip.operations;
  assert.deepEqual([o.boat_id, o.pickup_time_final, o.pickup_time_final_end, o.pier_note.text], ['disp-a', '06:40', '06:55', 'Late, call guide']);
  assert.ok(o.pier_note.at, 'the server stamps when');
  assert.equal((await send('GET', `/v1/bookings/${b.id}`)).json().trips[0].operations.boat_id, 'disp-a', 'the booking read carries it');

  const elsewhere = await ops(tripId, { boat_id: 'disp-nowhere' });
  assert.deepEqual([elsewhere.statusCode, elsewhere.json().code], [409, 'boat_not_deployed']);
  assert.equal((await ops(tripId, { pickup_time_final_end: '06:00' })).statusCode, 400, 'the end before the start');
  assert.equal((await ops(tripId, { boat_id: null })).json().trip.operations.boat_id, null, 'null clears');
  assert.equal((await ops('trip_nowhere', { boat_id: null })).statusCode, 404);
});

test('a split puts the trip\'s passengers on two boats or more; a change of passengers clears it', async () => {
  const day = '2046-01-06';
  await deploy('disp-b', day); await deploy('disp-c', day);
  const b = await booking(day, { ad: 4, chd: 1 });
  const tripId = b.trips[0].id;
  assert.equal((await ops(tripId, { boat_id: 'disp-b', boat_splits: [] })).statusCode, 400, 'one or the other');
  assert.equal((await ops(tripId, { boat_splits: [{ boat_id: 'disp-b', ad: 4 }] })).statusCode, 400, 'two boats or more');
  assert.equal((await ops(tripId, { boat_splits: [{ boat_id: 'disp-b', ad: 2 }, { boat_id: 'disp-c', ad: 2 }] })).statusCode, 400, 'the child is not on a boat');
  const split = await ops(tripId, { boat_splits: [{ boat_id: 'disp-b', ad: 2, chd: 1 }, { boat_id: 'disp-c', ad: 2 }] });
  assert.equal(split.statusCode, 200, split.body);
  assert.deepEqual(split.json().trip.operations.boat_splits.map((s: { boat_id: string }) => s.boat_id), ['disp-b', 'disp-c']);
  const more = await send('PATCH', `/v1/bookings/${b.id}`, { trips: [{ id: tripId, routeId: 'r1', date: day, pax: { ad: 5, chd: 1 } }] });
  assert.equal(more.statusCode, 200, more.body);
  assert.deepEqual(more.json().trips[0].operations.boat_splits, [], 'it no longer adds up');
});

test('a boat taken off the day shows as pulled; a moved trip keeps only its pier note; a cancelled booking is closed', async () => {
  const [day, later] = ['2046-01-07', '2046-01-09'];
  await deploy('disp-d', day); await deploy('disp-d', later);
  const b = await booking(day);
  const tripId = b.trips[0].id;
  await ops(tripId, { boat_id: 'disp-d', pier_note: 'meet at gate 2', return_same_van: true });
  await send('DELETE', `/operations/deployments/${day}/disp-d`);
  assert.equal((await send('GET', `/v1/bookings/${b.id}`)).json().trips[0].operations.boat_pulled, true);
  await deploy('disp-d', day);
  const moved = await send('POST', `/v1/bookings/${b.id}/reschedule`, { route_id: 'r1', service_date: later });
  assert.equal(moved.statusCode, 200, moved.body);
  const o = moved.json().trips[0].operations;
  assert.deepEqual([o.boat_id, o.return_same_van, o.pier_note?.text], [null, false, 'meet at gate 2'], 'legacy bkOpsClear keeps the pier note');
  await send('POST', `/v1/bookings/${b.id}/cancel`, { category: 'sick' });
  const closed = await ops(tripId, { boat_id: 'disp-d' });
  assert.deepEqual([closed.statusCode, closed.json().code], [409, 'cancelled']);
});
