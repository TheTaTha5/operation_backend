import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { createStore } from '../src/routes/operations.js';
import { SeatLockService } from '../src/domain/seat-lock-service.js';

// Whole-boat holds in the seat pool (migration 047), on whichever store DATABASE_URL selects. The
// holds are made through the store, rules unchecked, as the import makes them (one on a boat not
// deployed that day included); the API's commands are test/boat-hold-commands.test.ts.
const store = createStore();
const hold = (service_date: string, pax: number, boat_id: string) =>
  store.transaction(async () => new SeatLockService(store).create({ route_id: 'r1', service_date, pax, holder_type: 'office', agent_id: null, reason: null, expiry: null, boat_id }));
const app = buildApp({ store });
after(async () => app.close());
const send = (method: InjectOptions['method'], url: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}) });
const day = async (date: string) => (await send('GET', `/v1/availability?route_id=r1&from=${date}&to=${date}`)).json().days[0];

test('a hold takes its whole boat, as a charter does, whatever it promised', async () => {
  const date = '2059-02-01';
  await send('POST', '/operations/deployments', { boat_id: 'hb-held', route_id: 'r1', service_date: date, capacity: 38, license_pax: 47 });
  await send('POST', '/operations/deployments', { boat_id: 'hb-open', route_id: 'r1', service_date: date, capacity: 20, license_pax: 25 });
  const held = await hold(date, 30, 'hb-held');
  const read = (await send('GET', `/v1/seat-locks?route_id=r1&service_date=${date}`)).json();
  assert.equal(read.seat_locks.find((l: { id: string }) => l.id === held.id).boat_id, 'hb-held');

  const seats = await day(date);
  assert.deepEqual([seats.available_seats, seats.locked_pax, seats.licensed_free], [20, 0, 25], 'all 38 (and its 47 licensed) out; the hold holds nothing more');
  assert.equal(seats.deployments.find((b: { boat_id: string }) => b.boat_id === 'hb-held').chartered, true);

  const seat = (await send('POST', '/v1/bookings', { route_id: 'r1', service_date: date, pax: 5 })).json();
  const onHeld = await send('PATCH', `/operations/trip-ops/${seat.trips[0].id}`, { boat_id: 'hb-held' });
  assert.deepEqual([onHeld.statusCode, onHeld.json().code], [409, 'boat_chartered']);
  assert.equal((await send('PATCH', `/operations/trip-ops/${seat.trips[0].id}`, { boat_id: 'hb-open' })).statusCode, 200);

  const charter = await send('POST', '/v1/bookings', { trips: [{ route_id: 'r1', date, pax: { ad: 10 }, booking_mode: 'charter', charter_boat_id: 'hb-held' }] });
  assert.equal(charter.statusCode, 409);
  assert.match(charter.json().message, /held whole/);
  const big = await send('POST', '/v1/bookings', { route_id: 'r1', service_date: date, pax: 30 });
  assert.equal(big.statusCode, 409, 'past the open boat\'s licence: refused, not sent to approval');
});

test('a boat a hold takes stays on its route: it cannot be removed or moved (legacy opHoldOnly)', async () => {
  const date = '2059-02-03';
  await send('POST', '/operations/deployments', { boat_id: 'hb-keep', route_id: 'r1', service_date: date, capacity: 30 });
  await hold(date, 10, 'hb-keep');
  const removed = await send('DELETE', `/operations/deployments/${date}/hb-keep?remove_anyway=true`);
  assert.deepEqual([removed.statusCode, removed.json().code], [409, 'boat_held']);
  assert.match(removed.json().message, /Release the hold on the Seat Locks page first/);
  const moved = await send('POST', '/operations/deployments', { boat_id: 'hb-keep', route_id: 'r2', service_date: date, capacity: 30, remove_anyway: true });
  assert.deepEqual([moved.statusCode, moved.json().code], [409, 'boat_held']);
  const resized = await send('POST', '/operations/deployments', { boat_id: 'hb-keep', route_id: 'r1', service_date: date, capacity: 32 });
  assert.equal(resized.statusCode, 201, 'staying on its route is allowed');
  assert.equal((await send('POST', '/operations/deployments', { boat_id: 'hb-free', route_id: 'r1', service_date: date, capacity: 30 })).statusCode, 201);
  assert.equal((await send('DELETE', `/operations/deployments/${date}/hb-free`)).statusCode, 204, 'a boat no hold takes leaves');
});

test('a hold whose boat is not deployed holds its seats as a plain lock', async () => {
  const date = '2059-02-02';
  await send('POST', '/operations/deployments', { boat_id: 'hb-only', route_id: 'r1', service_date: date, capacity: 40 });
  await hold(date, 12, 'hb-elsewhere');
  const seats = await day(date);
  assert.deepEqual([seats.available_seats, seats.locked_pax], [28, 12]);
});
