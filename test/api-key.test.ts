import assert from 'node:assert/strict';
import { after, test } from 'node:test';

// Love Kingdom's server reads availability with an `X-Api-Key`, as it does legacy's
// `/api/b2c/availability`. Authentication is on, so everything else still needs a Bearer token. The
// env is set before the app is imported, as `auth.test.ts` does.
process.env.AUTH_JWT_SECRET = 'api-key-test-secret';
process.env.AUTH_PASSWORD_USERS = JSON.stringify([{ username: 'ops', password: 'pw', groups: ['admin'] }]);
process.env.B2C_API_KEY = 'lk-test-key';
const { buildApp } = await import('../src/app.js');
const app = buildApp();
after(async () => app.close());

const key = { 'x-api-key': 'lk-test-key' };

test('the key reads availability, one day or a range', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/v1/availability?route_id=r1&date=2030-01-02', headers: key })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/availability?route_id=r1&from=2030-01-01&to=2030-01-31', headers: key })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/availability?route_id=r1&date=2030-01-02' })).statusCode, 401, 'no key and no token');
});

test('a wrong key is refused, not passed on to the Bearer check', async () => {
  const login = await app.inject({ method: 'POST', url: '/v1/login', payload: { username: 'ops', password: 'pw' } });
  const wrong = await app.inject({ method: 'GET', url: '/v1/availability?route_id=r1&date=2030-01-02', headers: { 'x-api-key': 'guess', authorization: `Bearer ${login.json().access_token}` } });
  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.json().message, 'Invalid X-Api-Key');
});

test('the key opens nothing but availability', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/v1/bookings', headers: key })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/routes', headers: key })).statusCode, 403);
  const book = await app.inject({ method: 'POST', url: '/v1/bookings', headers: key, payload: { trips: [{ routeId: 'r1', date: '2030-01-02', pax: 1 }] } });
  assert.equal(book.statusCode, 403, 'the key can never book');
});
