import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { buildApp } from '../src/app.js';
import type { InjectOptions } from 'fastify';

const app = buildApp();
after(async () => app.close());

async function request(method: InjectOptions['method'], url: string, payload?: object) {
  return payload === undefined ? app.inject({ method, url }) : app.inject({ method, url, payload });
}

test('the OpenAPI document describes the agent booking contract', async () => {
  const response = await request('GET', '/docs/json');
  assert.equal(response.statusCode, 200);
  const spec = response.json();
  const create = spec.paths['/v1/bookings'].post;
  assert.equal(create.summary, 'Create a booking');
  assert.deepEqual(create.security, [{ bearerAuth: [] }]);
  assert.ok(create.requestBody.content['application/json'].schema.properties.trips);
  assert.ok(create.responses['409']);
  assert.ok(spec.paths['/v1/availability'].get.parameters.some((p: { name: string }) => p.name === 'route_id'));
  assert.ok(spec.paths['/v1/seat-locks/{id}/release'].post);
});

// The schemas are documentation only. These pin the two ways a real Fastify schema would have
// changed behaviour: Ajv coercing a request, and the serializer dropping fields it does not list.
test('a documented body is not coerced: pax "6" is still refused by the hand-written parser', async () => {
  await request('POST', '/operations/deployments', { boat_id: 'boat-doc-1', route_id: 'r1', service_date: '2032-05-01', capacity: 10 });
  const response = await request('POST', '/v1/bookings', { trips: [{ routeId: 'r1', date: '2032-05-01', pax: '6' }] });
  assert.equal(response.statusCode, 400);
});

test('a documented response is sent whole, including fields the schema does not list', async () => {
  await request('POST', '/operations/deployments', { boat_id: 'boat-doc-2', route_id: 'r1', service_date: '2032-05-02', capacity: 10 });
  const created = await request('POST', '/v1/bookings', { trips: [{ routeId: 'r1', date: '2032-05-02', pax: { ad_fr: 2 } }], guides: { english: true }, roomNumber: '204' });
  assert.equal(created.statusCode, 201);
  const booking = created.json();
  assert.equal(booking.guide_english, true);
  assert.equal(booking.room_number, '204');
  assert.deepEqual(booking.reschedules, []);
});
