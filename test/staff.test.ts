import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';
import { todayInThailand } from '../src/domain/calendar.js';

// Staff and their welfare quotas (todo/sales-editing-model.md, "Design — extras") through the API, on
// whichever store DATABASE_URL selects, logins on: the registry, the year's quota, what bookings use of
// it, and the booking form's guard (legacy `bkV2Save`).
process.env.AUTH_JWT_SECRET = 'staff-test-secret';
const { buildApp } = await import('../src/app.js');
const { seedAgents, seedUser, testStore, tokenFor } = await import('./users-helper.js');
const store = testStore();
const app = buildApp({ store });
after(async () => app.close());

type Headers = { authorization: string };
const run = Date.now().toString(36);
const as = async (username: string, fields: object = {}): Promise<Headers> => {
  await seedUser(store, { username, ...fields });
  return tokenFor(app, username);
};
const call = (headers: Headers, method: InjectOptions['method'], url: string, payload?: object, extra: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { ...headers, ...extra }, ...(payload ? { payload } : {}) });
const ok = (res: { statusCode: number; body: string }, status = 200) => { assert.equal(res.statusCode, status, res.body); return JSON.parse(res.body || 'null'); };
const refused = (res: { statusCode: number; body: string }, status: number, code?: string) => {
  assert.equal(res.statusCode, status, res.body);
  if (code) assert.equal(JSON.parse(res.body).code, code, res.body);
  return JSON.parse(res.body).message as string;
};
const thisYear = todayInThailand().slice(0, 4);
// A year no other test books in.
const Y = '2052';

let admin: Headers | undefined;
const login = async () => {
  if (admin) return admin;
  await seedAgents(store, [], { a_staff: null, [`st_agent_${run}`]: null });
  admin = await as(`st.admin.${run}`, { role: 'admin' });
  return admin;
};
type Member = { id: string; code: string; name: string; dept: string | null; active: boolean; quotas: Record<string, number>; quota: number; used: number; remaining: number };

test('the registry: legacy\'s ids and codes, a quota of 3 this year, fields edited, server-owned ones refused', async () => {
  const h = await login();
  const before = ok(await call(h, 'GET', '/v1/staff')).staff as Member[];
  const n = Math.max(0, ...before.map((s) => parseInt(s.id.slice(2), 10) || 0)) + 1;
  const nok = ok(await call(h, 'POST', '/v1/staff', { name: '  Khun Nok ', dept: 'Sales' }), 201) as Member;
  assert.deepEqual([nok.id, nok.code, nok.name, nok.dept, nok.active, nok.quotas, nok.quota, nok.used, nok.remaining],
    [`st${String(n).padStart(2, '0')}`, `EMP-${String(n).padStart(3, '0')}`, 'Khun Nok', 'Sales', true, { [thisYear]: 3 }, 3, 0, 3]);
  const blank = ok(await call(h, 'POST', '/v1/staff', {}), 201) as Member;
  assert.deepEqual([blank.id, blank.name], [`st${String(n + 1).padStart(2, '0')}`, ''], 'legacy adds a blank row and names it in place');
  refused(await call(h, 'POST', '/v1/staff', { name: 5 }), 400);
  refused(await call(h, 'POST', '/v1/staff', { active: 'yes' }), 400);
  refused(await call(h, 'POST', '/v1/staff', { id: 'st99' }), 400);

  const url = `/v1/staff/${nok.id}`;
  assert.deepEqual(ok(await call(h, 'PATCH', url, nok)), nok, 'echoing the read changes nothing');
  const edited = ok(await call(h, 'PATCH', url, { code: 'EMP-777', dept: null, active: false })) as Member;
  assert.deepEqual([edited.code, edited.dept, edited.active], ['EMP-777', null, false]);
  refused(await call(h, 'PATCH', url, { quotas: { [thisYear]: 9 } }), 400);
  refused(await call(h, 'PATCH', url, { used: 0, remaining: 99 }), 400);
  refused(await call(h, 'PATCH', url, { id: 'st00' }), 400);
  refused(await call(h, 'PATCH', url, { salary: 1 }), 400);
  refused(await call(h, 'PATCH', '/v1/staff/st_nobody', { name: 'x' }), 404);

  // A quota per year; a 0 is kept (no free seats that year).
  const quotas = ok(await call(h, 'PUT', `${url}/quotas/2031`, { free_seats: 0 })) as Member;
  assert.deepEqual(quotas.quotas, { [thisYear]: 3, 2031: 0 });
  assert.equal(quotas.quota, 0, 'the view is the year set');
  refused(await call(h, 'PUT', `${url}/quotas/2031`, { free_seats: -1 }), 400);
  refused(await call(h, 'PUT', `${url}/quotas/2031`, { free_seats: 1.5 }), 400);
  refused(await call(h, 'PUT', `${url}/quotas/1999`, { free_seats: 1 }), 400);
  refused(await call(h, 'PUT', `${url}/quotas/next`, { free_seats: 1 }), 400);
  refused(await call(h, 'GET', '/v1/staff?year=26'), 400);
  assert.equal((ok(await call(h, 'GET', '/v1/staff?year=2031')).staff as Member[]).find((s) => s.id === nok.id)!.quota, 0);

  ok(await call(h, 'DELETE', `/v1/staff/${blank.id}`), 204);
  refused(await call(h, 'GET', `/v1/staff/${blank.id}`), 404);

  const ops = await as(`st.ops.${run}`, { edit_areas: ['operations'] });
  refused(await call(ops, 'POST', '/v1/staff', { name: 'x' }), 403);
  assert.equal(ok(await call(ops, 'GET', `/v1/staff/${nok.id}`)).id, nok.id, 'any login reads');
  const sales = await as(`st.sales.${run}`, { edit_areas: ['sales'] });
  ok(await call(sales, 'PUT', `${url}/quotas/2031`, { free_seats: 1 }));
});

test('the booking guard: a staff booking names a member; free seats over the year\'s quota ask first', async () => {
  const h = await login();
  const member = ok(await call(h, 'POST', '/v1/staff', { name: 'Captain Som', dept: 'Marine' }), 201) as Member;
  ok(await call(h, 'PUT', `/v1/staff/${member.id}/quotas/${Y}`, { free_seats: 2 }));
  // No zone: the staff agent here has no rate type, and a zone it has no rate for is refused (`no_rate`).
  const trip = (date: string, pax: Record<string, number>) => ({ routeId: 'r5', date, pax });
  const book = (body: object) => call(h, 'POST', '/v1/bookings', { agent_id: 'a_staff', foc_reason: 'Staff welfare', ...body });

  assert.match(refused(await book({ trips: [trip(`${Y}-02-01`, { ad_fr: 1 })] }), 400), /staff_id is required/);
  assert.match(refused(await book({ staff_id: 'st_nobody', trips: [trip(`${Y}-02-01`, { ad_fr: 1 })] }), 400), /not a staff member/);
  refused(await call(h, 'POST', '/v1/bookings', { agent_id: `st_agent_${run}`, staff_id: 'st_nobody', trips: [trip(`${Y}-02-01`, { ad_fr: 1 })] }), 400);

  const over = await book({ staff_id: member.id, staff_purpose: 'welfare', trips: [trip(`${Y}-02-01`, { ad_fr: 1, foc_fr: 3 })] });
  assert.match(refused(over, 409, 'over_quota'), /2052: 2 free seats left, 3 requested, over by 1/);
  refused(await book({ staff_id: member.id, quota_anyway: 'yes', trips: [trip(`${Y}-02-01`, { foc_fr: 3 })] }), 400);
  const welfare = ok(await book({ staff_id: member.id, staff_purpose: 'welfare', quota_anyway: true, trips: [trip(`${Y}-02-01`, { ad_fr: 1, foc_fr: 3 })] }), 201);
  // An inspection uses no quota.
  ok(await book({ staff_id: member.id, staff_purpose: 'inspection', trips: [trip(`${Y}-03-01`, { foc_fr: 5 })] }), 201);

  let row = (ok(await call(h, 'GET', `/v1/staff?year=${Y}`)).staff as Member[]).find((s) => s.id === member.id)!;
  assert.deepEqual([row.quota, row.used, row.remaining], [2, 3, -1]);
  const trips = ok(await call(h, 'GET', `/v1/staff/trips?year=${Y}`)).trips.filter((t: { staff_id: string }) => t.staff_id === member.id);
  assert.deepEqual(trips.map((t: { purpose: string; foc: number; head: number; paid: number }) => [t.purpose, t.foc, t.head, t.paid]), [['welfare', 3, 4, 1], ['inspection', 5, 5, 0]]);

  // An edit is checked without the booking's own seats: 1 free seat fits the 2.
  const v = (b: { version: number }) => ({ 'if-match': `"${b.version}"` });
  const fewer = ok(await call(h, 'PATCH', `/v1/bookings/${welfare.id}`, { trips: [trip(`${Y}-02-01`, { ad_fr: 3, foc_fr: 1 })] }, v(welfare)));
  // A name change reads none of what the guard reads.
  const named = ok(await call(h, 'PATCH', `/v1/bookings/${welfare.id}`, { lead_pax: 'Som' }, v(fewer)));
  refused(await call(h, 'PATCH', `/v1/bookings/${welfare.id}`, { trips: [trip(`${Y}-02-01`, { foc_fr: 4 })] }, v(named)), 409, 'over_quota');
  refused(await call(h, 'PATCH', `/v1/bookings/${welfare.id}`, { staff_id: null }, v(named)), 400);
  row = (ok(await call(h, 'GET', `/v1/staff?year=${Y}`)).staff as Member[]).find((s) => s.id === member.id)!;
  assert.deepEqual([row.used, row.remaining], [1, 1]);

  assert.match(refused(await call(h, 'DELETE', `/v1/staff/${member.id}`), 409, 'in_use'), /named on 2 bookings: make them inactive instead/);
});
