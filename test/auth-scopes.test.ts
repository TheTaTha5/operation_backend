import assert from 'node:assert/strict';
import { after, test } from 'node:test';

// A user with only the read scope: what it may and may not do. The env is set before the app is
// imported, as `auth.test.ts` does.
process.env.AUTH_JWT_SECRET = 'auth-scopes-test-secret';
process.env.AUTH_PASSWORD_USERS = JSON.stringify([{ username: 'reader', password: 'pw', groups: ['booking:read'] }]);
const { buildApp } = await import('../src/app.js');
const app = buildApp();
after(async () => app.close());

test('a read-only token may GET and HEAD, never write', async () => {
  const login = await app.inject({ method: 'POST', url: '/v1/login', payload: { username: 'reader', password: 'pw' } });
  assert.equal(login.statusCode, 200, login.body);
  const headers = { authorization: `Bearer ${login.json().access_token}` };
  assert.equal((await app.inject({ method: 'GET', url: '/v1/routes', headers })).statusCode, 200);
  assert.equal((await app.inject({ method: 'HEAD', url: '/v1/routes', headers })).statusCode, 200, 'HEAD is a read');
  assert.equal((await app.inject({ method: 'POST', url: '/v1/bookings', headers, payload: { route_id: 'r1', service_date: '2030-01-01', pax: 1 } })).statusCode, 403);
});
