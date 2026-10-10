import assert from 'node:assert/strict';
import { after, test } from 'node:test';

// What each login may do: legacy's edit areas, checked by the server on every write (legacy checked
// them only in the browser), the admin-only user screens, and a login tied to one agent.
process.env.AUTH_JWT_SECRET = 'permissions-test-secret';
const { buildApp } = await import('../src/app.js');
const { seedAgents, seedUser, testStore, tokenFor } = await import('./users-helper.js');
const store = testStore();
const app = buildApp({ store });
after(async () => app.close());

const as = async (username: string, fields: object = {}) => { await seedUser(store, { username, ...fields }); return tokenFor(app, username); };
const deploy = { boat_id: 'boat-perm', route_id: 'r1', service_date: '2041-01-05', capacity: 20 };
const booking = { route_id: 'r1', service_date: '2041-01-05', pax: 1 };

test('a login with no edit areas reads everything and writes nothing', async () => {
  for (const [name, fields] of [['perm.empty', { edit_areas: [] }], ['perm.noedit', { can_edit: false }]] as const) {
    const headers = await as(name, fields);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/routes', headers })).statusCode, 200);
    assert.equal((await app.inject({ method: 'HEAD', url: '/v1/routes', headers })).statusCode, 200, 'HEAD is a read');
    const write = await app.inject({ method: 'POST', url: '/v1/bookings', headers, payload: booking });
    assert.equal(write.statusCode, 403, name);
    assert.equal(write.json().message, 'Needs the operations area');
  }
});

test('each write needs its area, as legacy assigns them', async () => {
  const status = async (headers: { authorization: string }, method: 'POST' | 'PUT', url: string, payload: object) => (await app.inject({ method, url, headers, payload })).statusCode;
  const sales = await as('perm.sales', { edit_areas: ['sales'] });
  assert.equal(await status(sales, 'POST', '/v1/bookings', booking), 403);
  assert.notEqual(await status(sales, 'POST', '/v1/rate-types', {}), 403, 'rate types are sales');

  const fleet = await as('perm.fleet', { edit_areas: ['fleet'] });
  assert.equal(await status(fleet, 'POST', '/operations/deployments', deploy), 201, 'legacy deploys boats from Fleet Deployment too');
  assert.equal(await status(fleet, 'POST', '/v1/bookings', booking), 403);

  const config = await as('perm.config', { edit_areas: ['config'] });
  assert.notEqual(await status(config, 'PUT', '/v1/routes/r1/days/2041-01-06', { open: false }), 403, 'the calendar is config');
  assert.equal(await status(config, 'POST', '/operations/deployments', deploy), 403);

  const everything = await as('perm.legacyall', { edit_areas: null, can_edit: true });
  assert.equal(await status(everything, 'POST', '/v1/bookings', booking), 201, 'no list and can_edit: every area (legacy editInfo)');
});

test('van job orders: the sent tick, the group order and the Thai names are operations (legacy vanJobs*Persist)', async () => {
  const pier = await as('perm.vj.pier', { edit_areas: ['pier'] });
  const ops = await as('perm.vj.ops', { edit_areas: ['operations'] });
  const thai = { name: 'Perm Test Hotel', name_th: 'โรงแรม' };
  for (const [method, url, payload] of [
    ['PUT', '/operations/pickup-names-th', thai], ['PUT', '/operations/van-jobs/2041-01-07/vgrp_nowhere/sent', {}],
    ['PUT', '/operations/van-groups/order', { service_date: '2041-01-07', route_id: 'r1', zone: 'PK', group_ids: [] }],
  ] as const) {
    const refused = await app.inject({ method, url, headers: pier, payload });
    assert.deepEqual([refused.statusCode, refused.json().message], [403, 'Needs the operations area'], url);
    assert.notEqual((await app.inject({ method, url, headers: ops, payload })).statusCode, 403, url);
  }
  assert.equal((await app.inject({ method: 'GET', url: '/operations/van-jobs?date=2041-01-07', headers: pier })).statusCode, 200, 'reading is open');

  // The special request is a booking field: a logged-in write sends the version it read.
  await app.inject({ method: 'POST', url: '/operations/deployments', headers: ops, payload: { ...deploy, boat_id: 'boat-perm-vj', service_date: '2041-01-07' } });
  const created = (await app.inject({ method: 'POST', url: '/v1/bookings', headers: ops, payload: { ...booking, service_date: '2041-01-07' } })).json();
  const stale = await app.inject({ method: 'PATCH', url: `/v1/bookings/${created.id}`, headers: ops, payload: { job_note: 'x' } });
  assert.equal(stale.statusCode, 428, stale.body);
  const noted = await app.inject({ method: 'PATCH', url: `/v1/bookings/${created.id}`, headers: ops, payload: { job_note: 'ไม่ต้องส่งกลับ', version: created.version } });
  assert.equal(noted.statusCode, 200, noted.body);
  assert.equal(noted.json().special_request, 'ไม่ต้องส่งกลับ');
});

test('the user screens are admin only', async () => {
  const staff = await as('perm.staff', { edit_areas: ['operations'] });
  assert.equal((await app.inject({ method: 'GET', url: '/v1/users', headers: staff })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/users', headers: staff, payload: { username: 'x', password: 'y' } })).statusCode, 403);

  const admin = await as('perm.admin', { role: 'admin' });
  const send = (method: 'POST' | 'PATCH', url: string, payload: object) => app.inject({ method, url, headers: admin, payload });
  const created = await send('POST', '/v1/users', { username: 'perm.new', password: 'pw', editAreas: ['operations'], actions: ['act-approve'] });
  assert.equal(created.statusCode, 201, created.body);
  assert.deepEqual([created.json().edit_areas, created.json().actions, created.json().pass_hash], [['operations'], ['act-approve'], undefined]);
  assert.equal((await send('POST', '/v1/users', { username: 'PERM.NEW', password: 'pw' })).statusCode, 409, 'usernames ignore case');
  assert.equal((await send('POST', '/v1/users', { username: 'perm.bad', password: 'pw', actions: ['act-everything'] })).statusCode, 400);
  assert.equal((await send('POST', '/v1/users', { username: 'perm.bad', password: 'pw', sales_id: 'nobody' })).statusCode, 400);

  const id = created.json().id as number;
  const viaPatch = await send('PATCH', `/v1/users/${id}`, { password: 'sneaky' });
  assert.equal(viaPatch.statusCode, 400);
  assert.match(viaPatch.json().message, /POST \/v1\/users\/\{id\}\/password/);
  assert.equal((await send('PATCH', `/v1/users/${id}`, { edit_areas: ['sales'] })).json().edit_areas[0], 'sales');
  const self = (await app.inject({ method: 'GET', url: '/v1/me', headers: admin })).json().id;
  assert.equal((await send('PATCH', `/v1/users/${self}`, { disabled: true })).statusCode, 400, 'an admin cannot lock themselves out');
  assert.ok((await app.inject({ method: 'GET', url: '/v1/users', headers: admin })).json().users.some((u: { username: string }) => u.username === 'perm.new'));
});

test('a login tied to one agent books for it, sees only its bookings, and changes nothing else', async () => {
  await seedAgents(store, ['perm_s1'], { perm_a1: 'perm_s1', perm_a2: 'perm_s1' });
  const admin = await as('perm.admin2', { role: 'admin' });
  const other = await app.inject({ method: 'POST', url: '/v1/bookings', headers: admin, payload: { ...booking, agent_id: 'perm_a2' } });
  assert.equal(other.statusCode, 201, other.body);

  const lk = await as('perm.lk', { edit_areas: ['operations'], agent_id: 'perm_a1' });
  const own = await app.inject({ method: 'POST', url: '/v1/bookings', headers: lk, payload: booking });
  assert.equal(own.statusCode, 201, own.body);
  assert.equal(own.json().agent_id, 'perm_a1', 'the agent comes from the login');
  assert.equal((await app.inject({ method: 'POST', url: '/v1/bookings', headers: lk, payload: { ...booking, agent_id: 'perm_a2' } })).statusCode, 403);

  const listed = await app.inject({ method: 'GET', url: '/v1/bookings?agent_id=perm_a2', headers: lk });
  assert.ok(listed.json().bookings.every((b: { agent_id: string }) => b.agent_id === 'perm_a1'), 'whatever filter it asks for');
  assert.equal((await app.inject({ method: 'GET', url: `/v1/bookings/${other.json().id}`, headers: lk })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: `/v1/bookings/${other.json().id}/cancel`, headers: lk, payload: {} })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/seat-locks', headers: lk, payload: { route_id: 'r1', service_date: '2041-01-05', pax: 1 } })).statusCode, 403);
});

test('a login tied to one agent may not read the fleet', async () => {
  await seedAgents(store, ['perm_s2'], { perm_a3: 'perm_s2' });
  const lk = await as('perm.lk2', { edit_areas: ['operations'], agent_id: 'perm_a3' });
  const staff = await as('perm.fleetreader', { edit_areas: [] });
  for (const url of ['/v1/fleet/engines', '/v1/fleet/jobs', '/v1/fleet/stock-items', '/v1/fleet/insights']) {
    const refused = await app.inject({ method: 'GET', url, headers: lk });
    assert.equal(refused.statusCode, 403, url);
    assert.equal((await app.inject({ method: 'GET', url, headers: staff })).statusCode, 200, `${url}: any staff login reads it`);
  }
});
