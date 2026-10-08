import assert from 'node:assert/strict';
import { after, test } from 'node:test';

// Login against the users table (todo/login-permissions-model.md). The env is set before the app is
// imported, because the authenticator reads it once.
process.env.AUTH_REQUIRED = 'true';
process.env.AUTH_JWT_SECRET = 'auth-test-secret';
const { buildApp } = await import('../src/app.js');
const { seedUser, testStore, tokenFor } = await import('./users-helper.js');
const { Authenticator } = await import('../src/auth.js');
const store = testStore();
const app = buildApp({ store });
after(async () => app.close());

// Made by legacy's own `hashPw` (server.js), so this proves its stored hashes verify unchanged.
const LEGACY_HASH = '9fe873eaade5a417abacc7c31ad6e24f:18b02cb4cf0f46e5653880b7ef2bcc224db2e004aff22d85f64514253dec5a88';
const login = (username: string, password: string) => app.inject({ method: 'POST', url: '/v1/login', payload: { username, password } });

test('AUTH_REQUIRED without AUTH_JWT_SECRET stops the service at startup', () => {
  const secret = process.env.AUTH_JWT_SECRET;
  delete process.env.AUTH_JWT_SECRET;
  try { assert.throws(() => new Authenticator(), /AUTH_JWT_SECRET is required/); } finally { process.env.AUTH_JWT_SECRET = secret; }
});

test('a request without a token is refused; health stays public', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/v1/availability?route_id=r1&date=2030-01-01' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/api/health' })).statusCode, 200);
});

test('a legacy password logs in as it is, and the username ignores case', async () => {
  await seedUser(store, { username: 'auth.RSVN01', pass_hash: LEGACY_HASH, edit_areas: ['operations'] });
  const ok = await login('AUTH.rsvn01', 'Andaman#2026');
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().token_type, 'Bearer');
  assert.equal(ok.json().user.username, 'auth.RSVN01');
  assert.equal(ok.json().user.pass_hash, undefined, 'the hash never leaves the server');
  const me = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${ok.json().access_token}` } });
  assert.deepEqual([me.json().username, me.json().edit_areas, me.json().can_edit_any], ['auth.RSVN01', ['operations'], true]);

  const wrong = await login('auth.rsvn01', 'andaman#2026');
  assert.equal(wrong.statusCode, 401);
  assert.equal((await login('auth.nobody', 'x')).json().message, wrong.json().message, 'an unknown username reads the same as a wrong password');
});

test('logout, a disable and a password reset each end the sessions already issued', async () => {
  await seedUser(store, { username: 'auth.admin', role: 'admin' });
  const admin = await tokenFor(app, 'auth.admin');
  const staff = await seedUser(store, { username: 'auth.staff' });
  const read = (headers: { authorization: string }) => app.inject({ method: 'GET', url: '/v1/me', headers });

  const first = await tokenFor(app, 'auth.staff');
  assert.equal((await app.inject({ method: 'POST', url: '/v1/logout', headers: first })).statusCode, 204);
  assert.equal((await read(first)).statusCode, 401, 'signed out');
  const second = await tokenFor(app, 'auth.staff');
  assert.equal((await read(second)).statusCode, 200, 'a new login works');

  const reset = await app.inject({ method: 'POST', url: `/v1/users/${staff.id}/password`, headers: admin, payload: { password: 'new-pw' } });
  assert.equal(reset.statusCode, 200, reset.body);
  assert.equal((await read(second)).statusCode, 401, 'a reset ends it');
  assert.equal((await login('auth.staff', 'pw')).statusCode, 401, 'the old password is gone');
  const third = await tokenFor(app, 'auth.staff', 'new-pw');

  await app.inject({ method: 'PATCH', url: `/v1/users/${staff.id}`, headers: admin, payload: { disabled: true } });
  assert.equal((await read(third)).statusCode, 401, 'a disable ends it');
  assert.equal((await login('auth.staff', 'new-pw')).statusCode, 401, 'and refuses a new login');
});

test('a user changes their own password with the old one, and gets a fresh token', async () => {
  await seedUser(store, { username: 'auth.self', password: 'old' });
  const headers = await tokenFor(app, 'auth.self', 'old');
  const send = (payload: object) => app.inject({ method: 'POST', url: '/v1/me/password', headers, payload });
  assert.equal((await send({ old_password: 'wrong', new_password: 'next' })).statusCode, 403);
  const changed = await send({ old_password: 'old', new_password: 'next' });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${changed.json().access_token}` } })).statusCode, 200);
  assert.equal((await login('auth.self', 'next')).statusCode, 200);
});

test('15 failed logins in 3 minutes lock the username; other usernames are unaffected', async () => {
  await seedUser(store, { username: 'auth.locked' });
  for (let i = 0; i < 15; i++) assert.equal((await login('auth.locked', 'guess')).statusCode, 401);
  const locked = await login('auth.locked', 'pw');
  assert.equal(locked.statusCode, 429, 'even the right password waits');
  assert.match(locked.json().message, /try again in \d+ seconds/);
  await seedUser(store, { username: 'auth.other' });
  assert.equal((await login('auth.other', 'pw')).statusCode, 200);
});
