import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { buildApp } from '../src/app.js';

const app = buildApp();
after(async () => app.close());

async function request(method: string, url: string, payload?: unknown) {
  return app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
}

test('deployment capacity feeds availability, bookings, and manifest', async () => {
  const date = '2030-01-02';
  const deployment = await request('POST', '/operations/deployments', { boat_id: 'boat-1', route_id: 'r-1', service_date: date, capacity: 10 });
  assert.equal(deployment.statusCode, 201);

  const availability = await request('GET', `/v1/availability?route_id=r-1&date=${date}`);
  assert.deepEqual(availability.json(), { route_id: 'r-1', service_date: date, deployed_capacity: 10, total_capacity: 10, booked_pax: 0, charter_pax: 0, locked_pax: 0, available_seats: 10 });

  const created = await request('POST', '/v1/bookings', { route_id: 'r-1', service_date: date, pax: 6 });
  assert.equal(created.statusCode, 201);
  const booking = created.json() as { id: string };
  assert.equal((await request('POST', '/v1/bookings', { route_id: 'r-1', service_date: date, pax: 5 })).statusCode, 409);

  assert.equal((await request('PATCH', `/v1/bookings/${booking.id}`, { pax: 5 })).statusCode, 200);
  assert.equal((await request('POST', `/v1/bookings/${booking.id}/partial-cancel`, { pax_to_cancel: 2 })).json().pax, 3);
  const manifest = await request('GET', `/v1/manifest?route_id=r-1&date=${date}`);
  assert.equal(manifest.json().available_seats, 7);
  assert.equal((await request('POST', `/v1/bookings/${booking.id}/cancel`)).json().status, 'cancelled');
});

test('a reservation being edited does not compete with its own seats', async () => {
  const date = '2030-01-04';
  await request('POST', '/operations/deployments', { boat_id: 'boat-3', route_id: 'r-3', service_date: date, capacity: 20 });
  await request('POST', '/v1/bookings', { route_id: 'r-3', service_date: date, pax: 8 });
  const mine = (await request('POST', '/v1/bookings', { route_id: 'r-3', service_date: date, pax: 12 })).json() as { id: string };

  // The day is now sold out, so a plain read offers nothing...
  assert.equal((await request('GET', `/v1/availability?route_id=r-3&date=${date}`)).json().available_seats, 0);
  // ...but the editor of the 12-pax booking is releasing those seats as it saves.
  const editing = await request('GET', `/v1/availability?route_id=r-3&date=${date}&exclude_booking_id=${mine.id}`);
  assert.equal(editing.json().available_seats, 12);
  assert.equal(editing.json().booked_pax, 8);

  // Re-saving unchanged on a full day must work, and so must any amendment that fits the released seats.
  assert.equal((await request('PATCH', `/v1/bookings/${mine.id}`, { pax: 12 })).statusCode, 200);
  assert.equal((await request('PATCH', `/v1/bookings/${mine.id}`, { pax: 11 })).statusCode, 200);
  assert.equal((await request('PATCH', `/v1/bookings/${mine.id}`, { pax: 13 })).statusCode, 409);
  // A refused amendment must leave the original allocation intact rather than a half-applied zero.
  assert.equal((await request('GET', `/v1/availability?route_id=r-3&date=${date}`)).json().booked_pax, 19);

  const lock = (await request('POST', '/v1/seat-locks', { route_id: 'r-3', service_date: date, pax: 1 })).json() as { id: string; service_date: string };
  assert.equal(lock.service_date, date, 'a lock must report a plain ISO date, not a stringified Date');
  assert.equal((await request('PATCH', `/v1/seat-locks/${lock.id}`, { pax: 1 })).statusCode, 200);
  assert.equal((await request('PATCH', `/v1/seat-locks/${lock.id}`, { pax: 2 })).statusCode, 409);
});

test('seat locks reserve and release capacity', async () => {
  const date = '2030-01-03';
  await request('POST', '/operations/deployments', { boat_id: 'boat-2', route_id: 'r-2', service_date: date, capacity: 2 });
  const create = await request('POST', '/v1/seat-locks', { route_id: 'r-2', service_date: date, pax: 2, agent_id: 'agent-1' });
  assert.equal(create.statusCode, 201);
  const lock = create.json() as { id: string };
  assert.equal((await request('POST', '/v1/bookings', { route_id: 'r-2', service_date: date, pax: 1 })).statusCode, 409);
  assert.equal((await request('POST', `/v1/seat-locks/${lock.id}/release`)).statusCode, 200);
  assert.equal((await request('POST', '/v1/bookings', { route_id: 'r-2', service_date: date, pax: 1 })).statusCode, 201);
});
