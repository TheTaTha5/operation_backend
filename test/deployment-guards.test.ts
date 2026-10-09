import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';

process.env.AUTH_JWT_SECRET = 'deployment-guards-test-secret';
const { buildApp } = await import('../src/app.js');
const { OperationsStore } = await import('../src/domain/operations.js');
const { createStore } = await import('../src/routes/operations.js');
const { todayInThailand } = await import('../src/domain/calendar.js');
const { seedUser, tokenFor } = await import('./users-helper.js');

// Deployment guards (todo/deployment-guards-model.md, decided 2026-10-09), on whichever store
// DATABASE_URL selects. A catalogue boat checks license_pax: the in-process store is seeded with one.
const store = createStore();
if (store instanceof OperationsStore) store.seedCatalogue({ boats: [{ id: 'b-guard', name: 'Guard Star', capacity: 30, license_pax: 32 }] });
else {
  const { Pool } = await import('pg');
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  await db.query("INSERT INTO boats (id, name, capacity, license_pax) VALUES ('b-guard', 'Guard Star', 30, 32) ON CONFLICT (id) DO NOTHING");
  await db.end();
}
const app = buildApp({ store });
after(async () => app.close());
await seedUser(store, { username: 'guard-admin', role: 'admin' });
const admin = await tokenFor(app, 'guard-admin');
const send = (method: InjectOptions['method'], url: string, payload?: object, headers: Record<string, string> = admin) =>
  app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
const deploy = (boat: string, route: string, date: string, capacity = 20, extra: object = {}) =>
  send('POST', '/operations/deployments', { boat_id: boat, route_id: route, service_date: date, capacity, ...extra });

test('a boat with bookings on it leaves, or shrinks below them, only with remove_anyway', async () => {
  const date = '2051-01-01';
  assert.equal((await deploy('g-1', 'r1', date)).statusCode, 201);
  const b = (await send('POST', '/v1/bookings', { route_id: 'r1', service_date: date, pax: 3 })).json();
  assert.equal((await send('PATCH', `/operations/trip-ops/${b.trips[0].id}`, { boat_id: 'g-1' })).statusCode, 200);

  const shrink = await deploy('g-1', 'r1', date, 2);
  assert.deepEqual([shrink.statusCode, shrink.json().code], [409, 'seats_sold']);
  assert.match(shrink.json().message, /1 booking\(s\) \(3 pax\)/);
  const moved = await deploy('g-1', 'r2', date);
  assert.deepEqual([moved.statusCode, moved.json().code], [409, 'seats_sold'], 'moving to another route leaves this one');
  const shrunk = await deploy('g-1', 'r1', date, 2, { remove_anyway: true });
  assert.deepEqual([shrunk.statusCode, shrunk.json().warnings[0].code], [201, 'oversold']);
  assert.equal((await deploy('g-1', 'r1', date, 25)).statusCode, 201, 'growing needs nothing');

  const free = await deploy('g-2', 'r1', date);
  assert.equal(free.statusCode, 201);
  assert.equal((await send('DELETE', `/operations/deployments/${date}/g-2`)).statusCode, 204, 'nobody on it');
  assert.equal((await send('DELETE', `/operations/deployments/${date}/g-2`)).statusCode, 404);
  assert.equal((await send('DELETE', `/operations/deployments/${date}/g-1?remove_anyway=maybe`)).statusCode, 400);
});

test('a chartered boat stays; license_pax is the catalogue boat\'s', async () => {
  const date = '2051-01-02';
  await deploy('g-3', 'r1', date);
  const charter = await send('POST', '/v1/bookings', { trips: [{ route_id: 'r1', date, pax: 4, booking_mode: 'charter', charter_boat_id: 'g-3' }] });
  assert.equal(charter.statusCode, 201, charter.body);
  const refused = await send('DELETE', `/operations/deployments/${date}/g-3?remove_anyway=true`);
  assert.deepEqual([refused.statusCode, refused.json().code], [409, 'charter_boat']);
  assert.match(refused.json().message, /Cancel the charter booking first/);

  assert.equal((await deploy('b-guard', 'r1', date, 20, { license_pax: 40 })).statusCode, 400);
  assert.equal((await deploy('b-guard', 'r1', date, 20, { license_pax: 32 })).statusCode, 201);
});

test('a past date only for an admin', async () => {
  const past = '2020-01-01';
  await seedUser(store, { username: 'guard-staff', role: 'staff', edit_areas: ['operations'] });
  const staff = await tokenFor(app, 'guard-staff');
  const refused = await send('POST', '/operations/deployments', { boat_id: 'g-4', route_id: 'r1', service_date: past, capacity: 10 }, staff);
  assert.deepEqual([refused.statusCode, refused.json().code], [409, 'past_date']);
  assert.ok(past < todayInThailand());
  const corrected = await send('POST', '/operations/deployments', { boat_id: 'g-4', route_id: 'r1', service_date: past, capacity: 10 }, admin);
  assert.equal(corrected.statusCode, 201, corrected.body);
});
