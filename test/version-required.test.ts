import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';

process.env.AUTH_JWT_SECRET = 'version-required-test-secret';
const { buildApp } = await import('../src/app.js');
const { seedUser, testStore, tokenFor } = await import('./users-helper.js');

// If-Match is required of a login (decided 2026-10-09): a booking or seat-lock write without the
// version it read is refused, so it cannot overwrite a change it has not seen.
const store = testStore();
const app = buildApp({ store });
after(async () => app.close());
await seedUser(store, { username: 'vreq-admin', role: 'admin' });
const headers = await tokenFor(app, 'vreq-admin');
const send = (method: InjectOptions['method'], url: string, payload?: object, extra: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { ...headers, ...extra }, ...(payload ? { payload } : {}) });

test('a booking write without the version is 428; with it, it goes through', async () => {
  const date = '2057-03-01';
  await send('POST', '/operations/deployments', { boat_id: 'vreq-boat', route_id: 'r1', service_date: date, capacity: 30 });
  const created = await send('POST', '/v1/bookings', { route_id: 'r1', service_date: date, pax: 1 });
  assert.equal(created.statusCode, 201, 'creating needs no version');
  const { id, version } = created.json();

  for (const [method, url, body] of [['PATCH', `/v1/bookings/${id}`, { note: 'x' }], ['POST', `/v1/bookings/${id}/cancel`, {}]] as const) {
    const refused = await send(method, url, body);
    assert.deepEqual([refused.statusCode, refused.json().code], [428, 'version_required'], `${method} ${url}`);
    assert.match(refused.json().message, /If-Match/);
  }
  assert.equal((await send('PATCH', `/v1/bookings/${id}`, { note: 'x' }, { 'if-match': `"${version}"` })).statusCode, 200, 'the header');
  assert.equal((await send('PATCH', `/v1/bookings/${id}`, { note: 'y', version: version + 1 })).statusCode, 200, 'or the body');
  assert.equal((await send('PATCH', `/v1/bookings/${id}`, { note: 'z', version })).json().code, 'stale_version');
});

test('a seat-lock write without the version is 428', async () => {
  const lock = (await send('POST', '/v1/seat-locks', { route_id: 'r1', service_date: '2057-03-01', pax: 2 })).json();
  assert.equal((await send('POST', `/v1/seat-locks/${lock.id}/release`)).statusCode, 428);
  assert.equal((await send('POST', `/v1/seat-locks/${lock.id}/release`, { version: lock.version })).statusCode, 200);
});
