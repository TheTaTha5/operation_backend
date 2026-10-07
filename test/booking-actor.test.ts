import assert from 'node:assert/strict';
import { after, test } from 'node:test';

// A real token, so the actor comes from where it does in production. Password login is the
// service's own HS256 issuer; the env is set before the app is imported, as `auth.test.ts` does.
process.env.AUTH_JWT_SECRET = 'booking-actor-test-secret';
process.env.AUTH_PASSWORD_USERS = JSON.stringify([{ username: 'ops1', password: 'pw', groups: ['admin'] }]);
const { buildApp } = await import('../src/app.js');
const app = buildApp();
after(async () => app.close());

test('every write is signed by the token\'s user, whatever the body says', async () => {
  const login = await app.inject({ method: 'POST', url: '/v1/login', payload: { username: 'ops1', password: 'pw' } });
  assert.equal(login.statusCode, 200, login.body);
  const headers = { authorization: `Bearer ${login.json().access_token}` };
  const send = (method: 'POST' | 'PATCH' | 'GET', url: string, payload?: object) => app.inject({ method, url, headers, ...(payload ? { payload } : {}) });

  const date = '2037-04-01';
  await send('POST', '/operations/deployments', { boat_id: 'boat-actor', route_id: 'r1', service_date: date, capacity: 20 });
  const created = await send('POST', '/v1/bookings', { route_id: 'r1', service_date: date, pax: 2, updated_by: 'mallory' });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().updated_by, 'ops1', 'a body updated_by is ignored');
  assert.equal(created.json().created_by, 'ops1', 'created_by defaults to the token user');
  const id = created.json().id as string;

  const patched = await send('PATCH', `/v1/bookings/${id}`, { lead_pax: 'Somchai', updated_by: 'mallory' });
  assert.equal(patched.json().updated_by, 'ops1');
  const cancelled = await send('POST', `/v1/bookings/${id}/cancel`, { category: 'sick' });
  assert.equal(cancelled.json().cancellation.by, 'ops1');

  const history = (await send('GET', `/v1/bookings/${id}/history`)).json().history as { by: string; text: string }[];
  assert.deepEqual(history.map((line) => [line.by, line.text.split(' · ')[0]]), [['ops1', 'Created'], ['ops1', 'Edited'], ['ops1', 'Cancelled']]);
  assert.equal(history[1].text, 'Edited · lead_pax', 'the stamped updated_by is not reported as a change the caller made');

  const withCreator = await send('POST', '/v1/bookings', { route_id: 'r1', service_date: date, pax: 1, created_by: 'agent-desk' });
  assert.equal(withCreator.statusCode, 400, 'the creator is the logged-in user: naming someone else is refused');
  assert.match(withCreator.json().message, /^created_by cannot be set/);
  const echoing = await send('POST', '/v1/bookings', { route_id: 'r1', service_date: date, pax: 1, created_by: 'ops1' });
  assert.equal(echoing.statusCode, 201, 'repeating the logged-in user is accepted');
});

test('who confirmed and who approved come from the login, never a typed name', async () => {
  const login = await app.inject({ method: 'POST', url: '/v1/login', payload: { username: 'ops1', password: 'pw' } });
  const headers = { authorization: `Bearer ${login.json().access_token}` };
  const send = (method: 'POST' | 'GET', url: string, payload?: object) => app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
  const date = '2037-04-02';
  await send('POST', '/operations/deployments', { boat_id: 'boat-actor-2', route_id: 'r1', service_date: date, capacity: 20 });

  const confirmedOnCreate = (await send('POST', '/v1/bookings', { route_id: 'r1', service_date: date, pax: 1 })).json();
  assert.equal(confirmedOnCreate.confirmed_by, 'ops1', 'created as confirmed: stamped at once');
  assert.ok(confirmedOnCreate.confirmed_at);

  const quote = (await send('POST', '/v1/bookings', { route_id: 'r1', service_date: date, pax: 1, status: 'quote' })).json();
  assert.equal(quote.confirmed_by, undefined, 'a quote is not confirmed yet');
  const confirmed = (await send('POST', `/v1/bookings/${quote.id}/confirm`)).json();
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.confirmed_by, 'ops1');

  const waiting = (await send('POST', '/v1/bookings', { route_id: 'r1', service_date: date, pax: 1, status: 'pending_approval' })).json();
  const approved = (await send('POST', `/v1/bookings/${waiting.id}/approve`, { note: 'boss said yes', approved_by: 'mallory' })).json();
  assert.equal(approved.confirmed_by, 'ops1', 'a body cannot name the approver');
  const history = (await send('GET', `/v1/bookings/${waiting.id}/history`)).json().history as { by: string; text: string }[];
  assert.deepEqual(history.at(-1), { ...history.at(-1), by: 'ops1', text: 'Approved · booking confirmed · boss said yes' });
});
