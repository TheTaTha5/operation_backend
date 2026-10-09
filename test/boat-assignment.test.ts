import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';

process.env.AUTH_JWT_SECRET = 'boat-assignment-test-secret';
const { buildApp } = await import('../src/app.js');
const { seedUser, testStore, tokenFor } = await import('./users-helper.js');
const { OperationsStore } = await import('../src/domain/operations.js');

// Boat assignment rules (todo/boat-assignment-model.md, approved 2026-10-09), on whichever store
// DATABASE_URL selects: a boat carries its capacity + 2; past that only act-capunlock raises the day,
// never past the licence; a chartered boat takes no seat booking; a charter rides its charter boat.
const store = testStore();
// A day's capacity is raised on a catalogue boat (its row keys on the boat).
if (store instanceof OperationsStore) store.seedCatalogue({ boats: [{ id: 'ba-small', name: 'Small', capacity: 10, license_pax: 13 }] });
else {
  const { Pool } = await import('pg');
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  await db.query("INSERT INTO boats (id, name, capacity, license_pax) VALUES ('ba-small', 'Small', 10, 13) ON CONFLICT (id) DO NOTHING");
  await db.end();
}
const app = buildApp({ store });
after(async () => app.close());
await seedUser(store, { username: 'boat-admin', role: 'admin' });
await seedUser(store, { username: 'boat-ops', edit_areas: ['operations'] });
await seedUser(store, { username: 'boat-unlock', edit_areas: ['operations'], actions: ['act-capunlock'] });
const admin = await tokenFor(app, 'boat-admin');
const ops = await tokenFor(app, 'boat-ops');
const unlock = await tokenFor(app, 'boat-unlock');
const send = (method: InjectOptions['method'], url: string, payload?: object, headers: Record<string, string> = admin) =>
  app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
const book = async (date: string, pax: number, extra: object = {}) => {
  const res = await send('POST', '/v1/bookings', { trips: [{ route_id: 'r1', date, pax: { ad: pax }, ...extra }] });
  assert.equal(res.statusCode, 201, res.body);
  return res.json();
};
const assign = (tripId: string, body: object, headers = admin) => send('PATCH', `/operations/trip-ops/${tripId}`, body, headers);

test('a boat carries its capacity + 2; past that act-capunlock raises the day, never past the licence', async () => {
  const date = '2058-01-10';
  await send('POST', '/operations/deployments', { boat_id: 'ba-small', route_id: 'r1', service_date: date, capacity: 10, license_pax: 13 });
  await send('POST', '/operations/deployments', { boat_id: 'ba-big', route_id: 'r1', service_date: date, capacity: 40 });
  const [a, b, c, d] = [await book(date, 8), await book(date, 4), await book(date, 3), await book(date, 2)];
  assert.equal((await assign(a.trips[0].id, { boat_id: 'ba-small' })).statusCode, 200);
  assert.equal((await assign(b.trips[0].id, { boat_id: 'ba-small' })).statusCode, 200, '12 is capacity + 2');

  const full = await assign(c.trips[0].id, { boat_id: 'ba-small' }, ops);
  assert.deepEqual([full.statusCode, full.json().code], [409, 'boat_full']);
  assert.match(full.json().message, /would carry 15 .*capacity 10, at most 12/);
  const notAllowed = await assign(c.trips[0].id, { boat_id: 'ba-small', raise_capacity: { reason: 'agent overbooked' } }, ops);
  assert.deepEqual([notAllowed.statusCode, notAllowed.json().code], [403, 'forbidden']);
  assert.equal((await assign(c.trips[0].id, { boat_id: 'ba-small', raise_capacity: {} }, unlock)).statusCode, 400, 'a reason is required');
  const raised = await assign(c.trips[0].id, { boat_id: 'ba-small', raise_capacity: { reason: 'agent overbooked' } }, unlock);
  assert.equal(raised.statusCode, 200, raised.body);
  const seats = (await send('GET', `/v1/availability?route_id=r1&from=${date}&to=${date}`)).json().days[0];
  assert.equal(seats.deployments.find((x: { boat_id: string }) => x.boat_id === 'ba-small').capacity, 13, 'raised to min(licence, load)');

  const over = await assign(d.trips[0].id, { boat_id: 'ba-small', raise_capacity: { reason: 'more' } }, unlock);
  assert.deepEqual([over.statusCode, over.json().code], [409, 'over_licence'], '17 is past the licence + 2');
  assert.equal((await assign(a.trips[0].id, { pier_note: 'ok' }, ops)).statusCode, 200, 'a patch that sets no boat is not weighed');
  await send('POST', '/operations/deployments', { boat_id: 'ba-nocat', route_id: 'r1', service_date: date, capacity: 1 });
  const nocat = await assign(a.trips[0].id, { boat_id: 'ba-nocat', raise_capacity: { reason: 'x' } }, unlock);
  assert.deepEqual([nocat.statusCode, nocat.json().code], [409, 'boat_not_catalogued']);
});

test('a charter rides its charter boat, which takes no seat booking', async () => {
  const date = '2058-01-11';
  for (const boat of ['ba-ch-1', 'ba-ch-2', 'ba-seat']) await send('POST', '/operations/deployments', { boat_id: boat, route_id: 'r1', service_date: date, capacity: 30 });
  const charter = await book(date, 6, { booking_mode: 'charter', charter_boat_id: 'ba-ch-1' });
  assert.equal(charter.trips[0].operations.boat_id, 'ba-ch-1', 'put on its charter boat when booked');
  const other = await assign(charter.trips[0].id, { boat_id: 'ba-seat' });
  assert.equal(other.statusCode, 400);
  assert.match(other.json().message, /charter's boat is its charter_boat_id/);

  const seat = await book(date, 2);
  const onCharter = await assign(seat.trips[0].id, { boat_id: 'ba-ch-1' });
  assert.deepEqual([onCharter.statusCode, onCharter.json().code], [409, 'boat_chartered']);

  const moved = await send('PATCH', `/v1/bookings/${charter.id}`, { version: charter.version,
    trips: [{ id: charter.trips[0].id, route_id: 'r1', date, pax: { ad: 6 }, booking_mode: 'charter', charter_boat_id: 'ba-ch-2' }] });
  assert.equal(moved.statusCode, 200, moved.body);
  assert.equal(moved.json().trips[0].operations.boat_id, 'ba-ch-2', 'follows a new charter boat');
});
