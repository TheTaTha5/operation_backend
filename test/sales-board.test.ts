import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';
import { agentTrend, boardRange, monthEnd, monthShift } from '../src/domain/sales-board.js';

// The Sales Board (todo/sales-editing-model.md, "Design — extras"): targets, follow-up marks and the
// board legacy draws from them, through the API on whichever store DATABASE_URL selects, logins on.
process.env.AUTH_JWT_SECRET = 'sales-board-test-secret';
const { buildApp } = await import('../src/app.js');
const { seedUser, testStore, tokenFor } = await import('./users-helper.js');
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
const refused = (res: { statusCode: number; body: string }, status: number) => { assert.equal(res.statusCode, status, res.body); };

// Months no other test books in.
const M = '2051-06', P = '2051-05';
type Ctx = { admin: Headers; s1: string; s2: string; a1: string; a2: string; b1: string };
let ctx: Ctx | undefined;
async function setup(): Promise<Ctx> {
  if (ctx) return ctx;
  const admin = await as(`sb.admin.${run}`, { role: 'admin' });
  const market = ok(await call(admin, 'POST', '/v1/markets', { id: `sb${run}`, name: `SB ${run}` }), 201).id;
  const s1 = ok(await call(admin, 'POST', '/v1/sales', { code: `B${run.slice(-1)}`.toUpperCase(), name: 'Board One' }), 201).id;
  const s2 = ok(await call(admin, 'POST', '/v1/sales', { code: `C${run.slice(-1)}`.toUpperCase(), name: 'Board Two' }), 201).id;
  const rate = ok(await call(admin, 'POST', '/v1/rate-types', { name: `SB ${run}`, routes: [{ route_id: 'r5', zones: { PK: { net: { ad_fr: 1000 } } } }] }), 201).id;
  const agent = async (name: string, sales: string) => ok(await call(admin, 'POST', '/v1/agents', {
    name, market_id: market, sales_id: sales, pay_type: 'proforma', vat_mode: 'include', rate_type_id: rate, phone: '081',
    company: { legal_name: `${name} Co., Ltd.`, address: '1 Beach Rd' },
  }), 201).id as string;
  const c: Ctx = { admin, s1, s2, a1: await agent(`SB A1 ${run}`, s1), a2: await agent(`SB A2 ${run}`, s1), b1: await agent(`SB B1 ${run}`, s2) };
  const book = async (agentId: string, date: string, pax: Record<string, number>) =>
    ok(await call(admin, 'POST', '/v1/bookings', { agent_id: agentId, ...(pax.foc_fr ? { foc_reason: 'Board test' } : {}), trips: [{ routeId: 'r5', date, zone: 'PK', pax }] }), 201);
  // A1: 20 last month, 30 + 2 FOC + 1 infant this month (33 pax) → up. A2: 10 last month, none now → gone. B1: 3 now → new.
  await book(c.a1, `${P}-10`, { ad_fr: 20 });
  await book(c.a1, `${M}-03`, { ad_fr: 30, foc_fr: 2, inf_fr: 1 });
  await book(c.a2, `${P}-20`, { ad_fr: 10 });
  await book(c.b1, `${M}-28`, { ad_fr: 3 });
  // A cancelled booking counts nowhere.
  const cancelled = await book(c.b1, `${M}-15`, { ad_fr: 50 });
  ok(await call(admin, 'POST', `/v1/bookings/${cancelled.id}/cancel`, { reason: 'test' }, { 'if-match': `"${cancelled.version}"` }));
  ctx = c;
  return c;
}
type Row = { sales_id: string; pax: number; foc: number; target: number | null; target_pct: number | null; reached: boolean; streak: number; rank: number; previous_rank: number; bookings: number; agents: number; agents_with_sales: number };
type AgentRow = { agent_id: string; pax: number; previous_pax: number; foc: number; trend: { category: string; pct: number | null; change: number }; followed: boolean; feedback_collected: boolean };
const board = async (h: Headers, month = M) => ok(await call(h, 'GET', `/v1/sales-board?month=${month}`)) as { month: string; previous_month: string; sales: Row[]; agents: AgentRow[] };

test('legacy\'s month and trend rules', () => {
  assert.equal(monthShift('2026-01', -1), '2025-12');
  assert.equal(monthShift('2026-12', 1), '2027-01');
  assert.equal(monthEnd('2028-02'), '2028-02-29');
  assert.deepEqual(agentTrend(5, 0), { category: 'new', pct: null, change: 5 });
  assert.deepEqual(agentTrend(0, 7), { category: 'gone', pct: null, change: -7 });
  assert.deepEqual(agentTrend(40, 4), { category: 'flat', pct: null, change: 36 }, 'a base under 5 is a difference, never +900 %');
  assert.deepEqual(agentTrend(25, 20), { category: 'up', pct: 25, change: 5 });
  assert.deepEqual(agentTrend(16, 20), { category: 'down', pct: -20, change: -4 });
  assert.deepEqual(agentTrend(21, 20), { category: 'flat', pct: 5, change: 1 });
  const t = (month: string) => ({ sales_id: 's1', month, pax: 1, set_at: '', set_by: null });
  assert.deepEqual(boardRange('2026-06', [t('2026-06'), t('2026-05'), t('2026-04'), t('2026-01')]), { from: '2026-04-01', to: '2026-06-30' }, 'back as far as targets run unbroken');
  assert.deepEqual(boardRange('2026-06', []), { from: '2026-05-01', to: '2026-06-30' });
});

test('targets: set by a login not bound to a salesperson, a whole number, 0 clears', async () => {
  const { admin, s1 } = await setup();
  assert.deepEqual(ok(await call(admin, 'PUT', `/v1/sales/${s1}/targets/${M}`, { pax: 30 })), { sales_id: s1, month: M, pax: 30 });
  refused(await call(admin, 'PUT', `/v1/sales/${s1}/targets/${M}`, { pax: -1 }), 400);
  refused(await call(admin, 'PUT', `/v1/sales/${s1}/targets/${M}`, { pax: 1.5 }), 400);
  refused(await call(admin, 'PUT', `/v1/sales/${s1}/targets/${M}`, { pax: '30' }), 400);
  refused(await call(admin, 'PUT', `/v1/sales/${s1}/targets/2051-13`, { pax: 30 }), 400);
  refused(await call(admin, 'PUT', `/v1/sales/${s1}/targets/${M}`, { pax: 30, month: M }), 400);
  refused(await call(admin, 'PUT', `/v1/sales/nobody/targets/${M}`, { pax: 30 }), 404);
  const bound = await as(`sb.bound.${run}`, { edit_areas: ['sales'], sales_id: s1 });
  refused(await call(bound, 'PUT', `/v1/sales/${s1}/targets/${M}`, { pax: 1 }), 403);
  const ops = await as(`sb.ops.${run}`, { edit_areas: ['operations'] });
  refused(await call(ops, 'PUT', `/v1/sales/${s1}/targets/${M}`, { pax: 1 }), 403);
  ok(await call(admin, 'PUT', `/v1/sales/${s1}/targets/${P}`, { pax: 99 }));
  assert.equal(ok(await call(admin, 'PUT', `/v1/sales/${s1}/targets/${P}`, { pax: 0 })).pax, 0);
  assert.equal((await board(admin, P)).sales.find((r) => r.sales_id === s1)!.target, null, '0 cleared it');
});

test('the board: pax by trip month, the agent\'s salesperson, targets, streaks, ranks and trends', async () => {
  const { admin, s1, s2, a1, a2, b1 } = await setup();
  ok(await call(admin, 'PUT', `/v1/sales/${s1}/targets/${M}`, { pax: 30 }));
  ok(await call(admin, 'PUT', `/v1/sales/${s1}/targets/${P}`, { pax: 30 }));
  const b = await board(admin);
  assert.deepEqual([b.month, b.previous_month], [M, P]);
  const one = b.sales.find((r) => r.sales_id === s1)!, two = b.sales.find((r) => r.sales_id === s2)!;
  assert.deepEqual([one.pax, one.foc, one.target, one.target_pct, one.reached, one.bookings, one.agents, one.agents_with_sales], [33, 2, 30, 110, true, 1, 2, 1]);
  assert.equal(one.streak, 2, 'this month and last met (last: 20 + 10 = 30 of 30); the month before has no target');
  assert.deepEqual([two.pax, two.target, two.target_pct, two.reached, two.streak, two.bookings], [3, null, null, false, 0, 1], 'the cancelled 50 count nowhere');
  assert.ok(one.rank < two.rank);
  assert.ok(one.previous_rank < two.previous_rank);
  const row = (id: string) => b.agents.find((a) => a.agent_id === id)!;
  assert.deepEqual([row(a1).pax, row(a1).previous_pax, row(a1).foc, row(a1).trend.category, row(a1).trend.pct], [33, 20, 2, 'up', 65]);
  assert.deepEqual([row(a2).pax, row(a2).previous_pax, row(a2).trend.category], [0, 10, 'gone']);
  assert.deepEqual([row(b1).pax, row(b1).trend.category], [3, 'new']);
  refused(await call(admin, 'GET', '/v1/sales-board?month=June'), 400);
});

test('follow-up marks: set or cleared as sent, on the salesperson\'s own agents and board', async () => {
  const { admin, s1, s2, a1, b1 } = await setup();
  const url = `/v1/sales/${s1}/followups`;
  ok(await call(admin, 'PUT', url, { month: M, agent_id: a1, marked: true }));
  ok(await call(admin, 'PUT', url, { month: M, agent_id: a1, kind: 'foc', marked: true }));
  ok(await call(admin, 'PUT', url, { month: M, agent_id: a1, marked: true }), 200);
  let row = (await board(admin)).agents.find((a) => a.agent_id === a1)!;
  assert.deepEqual([row.followed, row.feedback_collected], [true, true]);
  refused(await call(admin, 'PUT', url, { month: M, agent_id: b1, marked: true }), 400);
  refused(await call(admin, 'PUT', url, { month: M, agent_id: a1 }), 400);
  refused(await call(admin, 'PUT', url, { month: M, agent_id: a1, kind: 'call', marked: true }), 400);
  refused(await call(admin, 'PUT', url, { month: '2051-6', agent_id: a1, marked: true }), 400);
  const two = await as(`sb.two.${run}`, { edit_areas: ['sales'], sales_id: s2 });
  refused(await call(two, 'PUT', url, { month: M, agent_id: a1, marked: false }), 403);
  ok(await call(admin, 'PUT', url, { month: M, agent_id: a1, kind: 'foc', marked: false }));
  row = (await board(admin)).agents.find((a) => a.agent_id === a1)!;
  assert.deepEqual([row.followed, row.feedback_collected], [true, false]);
  assert.equal((await board(admin, P)).agents.find((a) => a.agent_id === a1)!.followed, false, 'a mark is for its month');

  // A bound login sees the whole leaderboard, and only its own agents.
  const mine = await board(two);
  assert.ok(mine.sales.some((r) => r.sales_id === s1));
  assert.deepEqual(mine.agents.filter((a) => [a1, b1].includes(a.agent_id)).map((a) => a.agent_id), [b1]);
});
