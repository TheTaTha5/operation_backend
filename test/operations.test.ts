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
  assert.deepEqual(availability.json(), { route_id: 'r-1', service_date: date, deployed_capacity: 10, booked_pax: 0, locked_pax: 0, available_seats: 10 });

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
