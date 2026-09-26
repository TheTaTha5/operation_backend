import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Pool } from 'pg';
import type { InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { OperationsStore } from '../src/domain/operations.js';
import { agentIncomplete, agentView, selectAgents, type AgentActivity, type Market, type SalesPerson, type StoredAgent } from '../src/domain/agents.js';

// Agents have no write endpoint yet, so PostgreSQL is filled here with SQL, the way the import fills
// it, and the in-process store is seeded with the same fixture. Every read is then asked of both and
// must answer identically: that comparison is what `DATABASE_URL=… npm test` is for.
const url = process.env.DATABASE_URL;
const app = buildApp();
const pool = url ? new Pool({ connectionString: url }) : undefined;
after(async () => { await app.close(); await pool?.end(); });

async function request(method: InjectOptions['method'], path: string, payload?: object) {
  return payload === undefined ? app.inject({ method, url: path }) : app.inject({ method, url: path, payload });
}

const markets: Market[] = [
  { id: 'tag_mkt_ru', name: 'Russia', color: '#c33', sort: 2, subs: ['Moscow', 'Siberia'] },
  { id: 'tag_mkt_th', name: 'Thailand', color: null, sort: 1, subs: [] },
];
const sales: SalesPerson[] = [
  { id: 'tag_s1', code: 'NU', name: 'Nuch', full_name: 'Nuchanart S.', designation: 'Sales', email: 'nu@example.test', tel: null, color: '#0a0', active: true },
];
const blankAgent = (id: string, name: string): StoredAgent => ({
  id, code: null, name, market_id: null, sub_market: null, sales_id: null, color: null, pay_type: null, vat_mode: 'none',
  credit_days: null, credit_limit: null, contact: null, email: null, phone: null, note: null, rate_type_id: null, contract_template_id: null,
  contract_status: null, contract_version: null, contract_start: null, contract_end: null,
  legal_name: null, tax_id: null, tat_license: null, address: null, company_tel: null, hotline: null, fax: null, website: null,
  signatory_name: null, signatory_designation: null, signatory_tel: null, signatory_signed_date: null,
  booking_method: null, booking_cutoff: null, booking_cancel_policy: null, booking_email: null, booking_phone: null,
  house: false, active: true, created_at: '2026-01-02T03:04:05.000Z', updated_at: '2026-01-02T03:04:05.000Z', programs: [],
});
const agents: StoredAgent[] = [
  {
    ...blankAgent('tag_a1', 'sun Tour'), code: 'SUNTOUR', market_id: 'tag_mkt_ru', sub_market: 'Moscow', sales_id: 'tag_s1', pay_type: 'invoice', vat_mode: 'exclude',
    credit_days: 30, credit_limit: 200000.5, email: 'ops@sun.test', rate_type_id: 'rt007', contract_status: 'active', contract_start: '2025-10-01', contract_end: '2026-12-31',
    legal_name: 'Sun Tour Co., Ltd.', tax_id: '0105551234567', company_tel: '+66 2 000 0000', signatory_name: 'K. Somchai', signatory_signed_date: '2025-10-05',
    booking_method: 'email', booking_email: 'book@sun.test',
    programs: [{ route_id: 'r4', book_from: '2025-10-01', book_to: '2026-09-30', note: 'High season' }, { route_id: 'r1', book_from: null, book_to: null, note: null }],
  },
  // No code and a lowercase-first name: search must not throw, and the sort must ignore case.
  { ...blankAgent('tag_a2', 'Andaman Holidays'), market_id: 'tag_mkt_th', pay_type: 'cot', phone: '081' },
  { ...blankAgent('tag_a3', 'Walk-in / Direct'), code: 'WALKIN', house: true, active: false },
];
const activity: Record<string, AgentActivity[]> = {
  tag_a1: [
    { at: '2026-03-01T08:00:00.000Z', by: 'nu', kind: 'created', text: 'Agent created' },
    { at: '2026-03-02T08:00:00.000Z', by: null, kind: 'rate', text: 'Rate rt001 → rt007' },
    { at: '2026-03-02T08:00:00.000Z', by: 'nu', kind: 'sales', text: 'Sales owner set' },
  ],
};

const memory = new OperationsStore();
memory.seedAgents({ markets, sales, agents, activity });

/** The fixture as SQL, in the shape `import-legacy.ts` writes. Rerunnable: it clears its own rows first. */
async function seedPostgres(db: Pool): Promise<void> {
  await db.query(`DELETE FROM agents WHERE id LIKE 'tag\\_%'`);
  await db.query(`DELETE FROM sales_people WHERE id LIKE 'tag\\_%'`);
  await db.query(`DELETE FROM markets WHERE id LIKE 'tag\\_%'`);
  for (const m of markets) {
    await db.query('INSERT INTO markets (id, name, color, sort) VALUES ($1,$2,$3,$4)', [m.id, m.name, m.color, m.sort]);
    for (const [idx, name] of m.subs.entries()) await db.query('INSERT INTO market_subs (market_id, idx, name) VALUES ($1,$2,$3)', [m.id, idx, name]);
  }
  for (const s of sales) {
    await db.query('INSERT INTO sales_people (id, code, name, full_name, designation, email, tel, color, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [s.id, s.code, s.name, s.full_name, s.designation, s.email, s.tel, s.color, s.active]);
  }
  for (const a of agents) {
    const { programs, ...columns } = a;
    const names = Object.keys(columns);
    await db.query(`INSERT INTO agents (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(columns));
    for (const [idx, p] of programs.entries()) {
      await db.query('INSERT INTO agent_programs (agent_id, route_id, idx, book_from, book_to, note) VALUES ($1,$2,$3,$4,$5,$6)', [a.id, p.route_id, idx, p.book_from, p.book_to, p.note]);
    }
  }
  for (const [agentId, entries] of Object.entries(activity)) {
    for (const e of entries) await db.query('INSERT INTO agent_activity (agent_id, at, by, kind, text) VALUES ($1,$2,$3,$4,$5)', [agentId, e.at, e.by, e.kind, e.text]);
  }
}
const seeded = pool ? seedPostgres(pool) : Promise.resolve();

test('an agent is incomplete in legacy\'s terms, and contact is any one of email, phone or contact', () => {
  assert.deepEqual(agentIncomplete(agents[0]), [], 'the full agent is complete');
  assert.deepEqual(agentIncomplete(agents[1]), ['sales', 'rate_type', 'programs'], 'a phone number is enough contact');
  assert.deepEqual(agentIncomplete({ ...agents[1], phone: '  ' }), ['sales', 'rate_type', 'programs', 'contact'], 'whitespace is not contact');
  assert.deepEqual(agentIncomplete(agents[2]), ['market', 'sales', 'pay_type', 'rate_type', 'programs', 'contact']);
});

test('the agent list searches the fields legacy searches, sorts A–Z ignoring case, and survives a missing code', () => {
  const names = (q: Parameters<typeof selectAgents>[3]) => selectAgents(agents, markets, sales, q).map((a) => a.id);
  assert.deepEqual(names({}), ['tag_a2', 'tag_a1', 'tag_a3'], 'Andaman, sun, Walk-in: case does not reorder');
  assert.deepEqual(names({ active: true }), ['tag_a2', 'tag_a1']);
  assert.deepEqual(names({ q: 'suntour' }), ['tag_a1'], 'by code');
  assert.deepEqual(names({ q: 'MOSCOW' }), ['tag_a1'], 'by sub-market, case-insensitively');
  assert.deepEqual(names({ q: 'thai' }), ['tag_a2'], 'by market name');
  assert.deepEqual(names({ q: 'nuch' }), ['tag_a1'], 'by salesperson name');
  assert.deepEqual(names({ marketId: 'tag_mkt_ru', salesId: 'tag_s1' }), ['tag_a1']);
});

test('the detail groups company, signatory and booking channel, and keeps tax_id', () => {
  const view = agentView(agents[0]);
  assert.equal(view.company.tax_id, '0105551234567');
  assert.equal(view.company.tel, '+66 2 000 0000');
  assert.deepEqual(view.signatory, { name: 'K. Somchai', designation: null, tel: null, signed_date: '2025-10-05' });
  assert.equal(view.booking_channel.email, 'book@sun.test');
  assert.equal('legal_name' in view, false, 'grouped fields are not repeated at the top level');
});

test('both stores answer every agent read identically', { skip: !url && 'PostgreSQL only: compares the stores' }, async () => {
  await seeded;
  const get = async (path: string) => { const response = await request('GET', path); assert.equal(response.statusCode, 200, `${path}: ${response.body}`); return response.json(); };
  const mine = <T extends { id: string }>(rows: T[]) => rows.filter((row) => row.id.startsWith('tag_'));

  assert.deepEqual(mine((await get('/v1/markets')).markets), memory.listMarkets(), 'markets, with their subs in order');
  assert.deepEqual(mine((await get('/v1/sales')).sales), memory.listSalesPeople());
  for (const query of ['', '?active=all', '?active=false', '?q=moscow', '?market=tag_mkt_ru', '?sales=tag_s1']) {
    const params = new URLSearchParams(query);
    const active = params.get('active');
    const expected = memory.listAgents({
      active: active === 'all' ? undefined : active !== 'false',
      q: params.get('q') ?? undefined, marketId: params.get('market') ?? undefined, salesId: params.get('sales') ?? undefined,
    });
    assert.deepEqual(mine((await get(`/v1/agents${query}`)).agents), expected, `GET /v1/agents${query}`);
  }
  for (const agent of agents) assert.deepEqual(await get(`/v1/agents/${agent.id}`), memory.agent(agent.id), `detail of ${agent.id}`);
  assert.deepEqual((await get('/v1/agents/tag_a1/activity')).activity, memory.agentActivity('tag_a1', 50));
  assert.deepEqual((await get('/v1/agents/tag_a2/activity')).activity, [], 'no activity is an empty log');
});

test('the in-process store answers from its seed', () => {
  const summary = memory.listAgents({ active: true }).find((a) => a.id === 'tag_a1');
  assert.deepEqual(summary?.program_route_ids, ['r4', 'r1'], 'programmes keep their order');
  assert.equal(summary?.credit_limit, 200000.5);
  assert.deepEqual(memory.listMarkets().map((m) => m.id), ['tag_mkt_th', 'tag_mkt_ru'], 'by sort');
  assert.deepEqual(memory.agentActivity('tag_a1', 2)?.map((e) => e.kind), ['sales', 'rate'], 'newest first; a tie keeps the later-written entry first');
  assert.equal(memory.agentActivity('nobody', 50), undefined);
});

test('agent reads refuse what they cannot answer', async () => {
  assert.equal((await request('GET', '/v1/agents/no-such-agent')).statusCode, 404);
  assert.equal((await request('GET', '/v1/agents/no-such-agent/activity')).statusCode, 404);
  assert.equal((await request('GET', '/v1/agents?active=maybe')).statusCode, 400);
  assert.equal((await request('GET', '/v1/agents/tag_a1/activity?limit=0')).statusCode, 400);
  const list = await request('GET', '/v1/agents');
  assert.equal(list.statusCode, 200);
  assert.ok(Array.isArray(list.json().agents));
});

test('the booking list filters by agent and pages newest first', async () => {
  const date = '2035-05-05';
  await request('POST', '/operations/deployments', { boat_id: 'boat-agent-list', route_id: 'r1', service_date: date, capacity: 30 });
  const agentId = `tag_bk_${Date.now()}`;
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const created = await request('POST', '/v1/bookings', { route_id: 'r1', service_date: date, pax: 1, agent_id: agentId });
    assert.equal(created.statusCode, 201, created.body);
    ids.push(created.json().id);
  }
  await request('POST', '/v1/bookings', { route_id: 'r1', service_date: date, pax: 1, agent_id: 'someone-else' });

  // Bookings made in the same millisecond tie on created_at and are ordered by id, so the expected
  // order is read from the default list rather than assumed from the order they were made in.
  const idsOf = (page: { bookings: { id: string }[] }) => page.bookings.map((b) => b.id);
  const ascending = (await request('GET', `/v1/bookings?agent_id=${agentId}`)).json();
  assert.deepEqual([...idsOf(ascending)].sort(), [...ids].sort(), 'only this agent\'s bookings');
  const newestFirst = [...idsOf(ascending)].reverse();

  const first = (await request('GET', `/v1/bookings?agent_id=${agentId}&order=desc&limit=2`)).json();
  assert.deepEqual(idsOf(first), newestFirst.slice(0, 2), 'desc is exactly the default order reversed');
  const second = (await request('GET', `/v1/bookings?agent_id=${agentId}&order=desc&limit=2&cursor=${first.next_cursor}`)).json();
  assert.deepEqual(idsOf(second), newestFirst.slice(2), 'the cursor continues in the same direction');
  assert.equal(second.next_cursor, undefined);
  assert.equal((await request('GET', '/v1/bookings?order=sideways')).statusCode, 400);
});
