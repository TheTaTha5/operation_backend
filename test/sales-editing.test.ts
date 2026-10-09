import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Pool } from 'pg';
import type { InjectOptions } from 'fastify';
import type { Contract } from '../src/domain/contracts.js';
import { OperationsStore } from '../src/domain/operations.js';

// Sales editing (todo/sales-editing-model.md, decided 2026-10-09) through the API, on whichever store
// DATABASE_URL selects, with logins on: who may write, the sales scoping and the activity's `by` are
// part of the contract. Every computed or validated field is sent a wrong value somewhere below.
process.env.AUTH_JWT_SECRET = 'sales-editing-test-secret';
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
const call = (headers: Headers, method: InjectOptions['method'], url: string, payload?: object) => app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
const ok = (res: { statusCode: number; body: string }, status = 200) => { assert.equal(res.statusCode, status, res.body); return JSON.parse(res.body || 'null'); };
const refused = (res: { statusCode: number; body: string }, status: number, code?: string) => {
  assert.equal(res.statusCode, status, res.body);
  if (code) assert.equal(JSON.parse(res.body).code, code, res.body);
  return JSON.parse(res.body).message as string;
};

let admin: Headers;
let market = '';
let shared = '';
let sales = { s1: '', s2: '' };
/** A market, two salespeople and a shared rate type pricing r5 and r6: what an agent needs. */
async function basics(): Promise<void> {
  if (market) return;
  admin = await as(`se.admin.${run}`, { role: 'admin' });
  market = ok(await call(admin, 'POST', '/v1/markets', { id: `se${run}`, name: `SE ${run}`, color: '#123456', subs: ['DMC', ' ', 'dmc', 'OTA'] }), 201).id;
  const code = (n: number) => `${run.slice(-2)}${n}`.toUpperCase();
  sales = {
    s1: ok(await call(admin, 'POST', '/v1/sales', { code: code(1).toLowerCase(), name: 'Nok' }), 201).id,
    s2: ok(await call(admin, 'POST', '/v1/sales', { code: code(2), name: 'Joy' }), 201).id,
  };
  const rate = ok(await call(admin, 'POST', '/v1/rate-types', { name: `SE shared ${run}`, routes: [
    { route_id: 'r5', zones: { PK: { net: { ad_fr: 1000 } } } }, { route_id: 'r6', zones: { PK: { net: { ad_fr: 1200 } } } },
  ] }), 201);
  shared = rate.id;
}
const newAgent = (name: string, extra: object = {}) => ({
  name, market_id: market, pay_type: 'proforma', vat_mode: 'include', rate_type_id: shared, phone: '081',
  company: { legal_name: `${name} Co., Ltd.`, address: '1 Beach Rd' }, ...extra,
});
const createAgent = async (headers: Headers, name: string, extra: object = {}) => ok(await call(headers, 'POST', '/v1/agents', newAgent(name, extra)), 201);

test('markets and salespeople: config edits them, ids and codes are the server\'s rules', async () => {
  await basics();
  const markets = ok(await call(admin, 'GET', '/v1/markets')).markets;
  const mine = markets.find((m: { id: string }) => m.id === market);
  assert.deepEqual(mine.subs, ['DMC', 'OTA'], 'blanks and repeats dropped');
  refused(await call(admin, 'POST', '/v1/markets', { id: market, name: 'again' }), 409, 'exists');
  refused(await call(admin, 'POST', '/v1/markets', { id: 'Not Lower', name: 'x' }), 400);
  assert.deepEqual(ok(await call(admin, 'PATCH', `/v1/markets/${market}`, { subs: ['DMC', 'Moscow'] })).subs, ['DMC', 'Moscow']);
  refused(await call(admin, 'PATCH', `/v1/markets/${market}`, { id: 'other' }), 400);
  refused(await call(admin, 'PATCH', `/v1/markets/${market}`, { sort: 99 }), 400);
  const ids = ok(await call(admin, 'GET', '/v1/markets')).markets.map((m: { id: string }) => m.id);
  const reordered = ok(await call(admin, 'PUT', '/v1/markets/order', { ids: [market, ...ids.filter((id: string) => id !== market)] })).markets;
  assert.equal(reordered[0].id, market);
  refused(await call(admin, 'PUT', '/v1/markets/order', { ids: [...ids, market] }), 400);

  const people = ok(await call(admin, 'GET', '/v1/sales')).sales;
  const nok = people.find((p: { id: string }) => p.id === sales.s1);
  assert.equal(nok.code, `${run.slice(-2)}1`.toUpperCase(), 'code uppercased');
  assert.equal(nok.designation, 'Sales Executive', 'legacy\'s default');
  assert.equal(nok.has_signature, false);
  refused(await call(admin, 'POST', '/v1/sales', { code: nok.code.toLowerCase(), name: 'Clash' }), 409, 'code_taken');
  refused(await call(admin, 'POST', '/v1/sales', { code: 'ABCD', name: 'Long' }), 400);
  refused(await call(admin, 'POST', '/v1/sales', { code: 'ZZ' }), 400);
  refused(await call(admin, 'PATCH', `/v1/sales/${sales.s1}`, { signature: 'http://example.test/sig.png' }), 400);
  const sig = 'data:image/png;base64,iVBORw0KGgo=';
  ok(await call(admin, 'PATCH', `/v1/sales/${sales.s1}`, { signature: sig, full_name: 'Nok Somsri' }));
  assert.equal(ok(await call(admin, 'GET', `/v1/sales/${sales.s1}`)).signature, sig);
  assert.equal(ok(await call(admin, 'GET', '/v1/sales')).sales.find((p: { id: string }) => p.id === sales.s1).has_signature, true);

  const salesOnly = await as(`se.sales.${run}`, { edit_areas: ['sales'] });
  assert.equal(refused(await call(salesOnly, 'POST', '/v1/markets', { id: `x${run}`, name: 'x' }), 403), 'Needs the config area');
  refused(await call(salesOnly, 'PATCH', `/v1/sales/${sales.s1}`, { tel: '1' }), 403);
});

test('creating an agent: required fields, the code, the duplicate check, and legacy\'s defaults', async () => {
  await basics();
  const missing = refused(await call(admin, 'POST', '/v1/agents', { name: 'Half', market_id: market }), 400);
  assert.equal(missing, 'Missing: company.legal_name, company.address, rate_type_id, pay_type, vat_mode');
  refused(await call(admin, 'POST', '/v1/agents', { ...newAgent('X'), id: 'a_mine' }), 400);
  refused(await call(admin, 'POST', '/v1/agents', { ...newAgent('X'), contract_status: 'expired' }), 400);
  refused(await call(admin, 'POST', '/v1/agents', { ...newAgent('X'), rate_type_id: 'rt_nope' }), 400);
  refused(await call(admin, 'POST', '/v1/agents', { ...newAgent('X'), market_id: 'nowhere' }), 400);
  refused(await call(admin, 'POST', '/v1/agents', { ...newAgent('X'), pay_type: 'cheque' }), 400);
  refused(await call(admin, 'POST', '/v1/agents', { ...newAgent('X'), credit_balance: 500 }), 400);
  refused(await call(admin, 'POST', '/v1/agents', { ...newAgent('X'), shoe_size: 9 }), 400);

  const agent = await createAgent(admin, `Andaman Sun ${run}`, { sub_market: 'Phuket Hotels', sales_id: sales.s1, credit_days: 30, credit_limit: 5000, contact: 'K. Lek' });
  assert.match(agent.id, /^a[0-9a-z]+$/);
  assert.equal(agent.code, `ANDAMANS`, 'the name\'s first 8 letters and digits');
  assert.equal(agent.credit_limit, 0, 'credit cleared: not an invoice agent (legacy)');
  assert.equal(agent.credit_days, 0);
  assert.equal(agent.contract_status, 'active');
  assert.match(agent.contract_version, /^v\d{4}-1$/);
  assert.equal(agent.company.tel, '081', 'company tel defaults to the phone');
  assert.deepEqual(agent.signatory, { name: 'K. Lek', designation: 'Authorized Signatory', tel: '081', signed_date: null });
  assert.equal(agent.booking_channel.email, 'book@loveandaman.com');
  assert.deepEqual(agent.programs.map((p: { route_id: string }) => p.route_id), ['r5', 'r6'], 'filled from the rate (agProgFill)');
  assert.equal(agent.programs[0].book_from, agent.contract_start);
  assert.equal(agent.programs[0].book_to, agent.contract_end);
  assert.deepEqual(agent.contract_history, []);
  const log = ok(await call(admin, 'GET', `/v1/agents/${agent.id}/activity`)).activity;
  assert.deepEqual(log.map((l: { kind: string; by: string }) => [l.kind, l.by]), [['created', `se.admin.${run}`]]);
  assert.equal(log[0].text, `Agent created · rate type SE shared ${run} · programs ตามเรทอัตโนมัติ 2 เส้นทาง`);
  assert.ok(ok(await call(admin, 'GET', '/v1/markets')).markets.find((m: { id: string }) => m.id === market).subs.includes('Phuket Hotels'), 'a new sub-market joins its market');

  const invoiced = await createAgent(admin, `Invoice Co ${run}`, { pay_type: 'invoice', credit_days: 30, credit_limit: 5000, code: `INV${run}` });
  assert.deepEqual([invoiced.credit_days, invoiced.credit_limit], [30, 5000]);
  assert.equal(refused(await call(admin, 'POST', '/v1/agents', newAgent(`Other ${run}`, { code: `inv${run}` })), 409, 'code_taken'),
    `Code inv${run} is already agent Invoice Co ${run} (${invoiced.id})'s`, 'ignoring case');
  const dup = refused(await call(admin, 'POST', '/v1/agents', newAgent(`ANDAMAN-SUN ${run} Co., Ltd.`)), 409, 'possible_duplicate');
  assert.match(dup, /similar name exists: Andaman Sun/);
  const second = ok(await call(admin, 'POST', '/v1/agents', { ...newAgent(`Andaman Sunset ${run}`), create_anyway: true }), 201);
  assert.equal(second.code, 'ANDAMANS2', 'a generated code that clashes is numbered');
});

test('a sales-bound login sees, edits and creates only its own agents', async () => {
  await basics();
  const nok = await as(`se.nok.${run}`, { edit_areas: ['sales'], sales_id: sales.s1 });
  const theirs = await createAgent(admin, `Joy Travel ${run}`, { sales_id: sales.s2 });
  const mine = await createAgent(nok, `Nok Travel ${run}`);
  assert.equal(mine.sales_id, sales.s1, 'a new agent gets the caller\'s salesperson');
  refused(await call(nok, 'POST', '/v1/agents', newAgent(`Nok Two ${run}`, { sales_id: sales.s2 })), 403);
  const listed = ok(await call(nok, 'GET', '/v1/agents?active=all')).agents.map((a: { id: string }) => a.id);
  assert.ok(listed.includes(mine.id));
  assert.ok(!listed.includes(theirs.id), 'another salesperson\'s agent is not listed');
  assert.deepEqual(ok(await call(nok, 'GET', `/v1/agents?sales=${sales.s2}`)).agents, []);
  assert.equal(refused(await call(nok, 'GET', `/v1/agents/${theirs.id}`), 403), 'This agent belongs to another salesperson');
  refused(await call(nok, 'GET', `/v1/agents/${theirs.id}/activity`), 403);
  refused(await call(nok, 'PATCH', `/v1/agents/${theirs.id}`, { note: 'x' }), 403);
  refused(await call(nok, 'PATCH', `/v1/agents/${mine.id}`, { sales_id: sales.s2 }), 403, 'forbidden');
  ok(await call(nok, 'PATCH', `/v1/agents/${mine.id}`, { note: 'mine' }));
  assert.ok(ok(await call(admin, 'GET', '/v1/agents?active=all')).agents.some((a: { id: string }) => a.id === theirs.id), 'an admin sees every agent');
  const ops = await as(`se.ops.${run}`, { edit_areas: ['operations'] });
  refused(await call(ops, 'PATCH', `/v1/agents/${mine.id}`, { note: 'x' }), 403);
});

test('PATCH changes client facts; an echoed GET is accepted, a server-owned change names its command', async () => {
  await basics();
  const agent = await createAgent(admin, `Echo Tours ${run}`);
  const echoed = { ...agent, note: 'VIP', pay_type: 'invoice', credit_limit: 200000, company: { ...agent.company, address: '2 Hill Rd' } };
  const patched = ok(await call(admin, 'PATCH', `/v1/agents/${agent.id}`, echoed));
  assert.equal(patched.note, 'VIP');
  assert.equal(patched.credit_limit, 200000, 'an edit keeps credit (decision 8)');
  assert.equal(refused(await call(admin, 'PATCH', `/v1/agents/${agent.id}`, { rate_type_id: 'rt_other' }), 400), 'rate_type_id cannot be changed here: use PUT /v1/agents/{id}/rate-type');
  refused(await call(admin, 'PATCH', `/v1/agents/${agent.id}`, { programs: [] }), 400);
  refused(await call(admin, 'PATCH', `/v1/agents/${agent.id}`, { active: false }), 400);
  refused(await call(admin, 'PATCH', `/v1/agents/${agent.id}`, { contract_end: '2030-01-01' }), 400);
  refused(await call(admin, 'PATCH', `/v1/agents/${agent.id}`, { house: true }), 400);
  refused(await call(admin, 'PATCH', `/v1/agents/${agent.id}`, { credit_balance: 10 }), 400);
  refused(await call(admin, 'PATCH', `/v1/agents/${agent.id}`, { company: { legal_name: '' } }), 400);
  refused(await call(admin, 'PATCH', `/v1/agents/${agent.id}`, { company: { motto: 'x' } }), 400);
  refused(await call(admin, 'PATCH', `/v1/agents/${agent.id}`, { credit_days: -1 }), 400);
  refused(await call(admin, 'PATCH', `/v1/agents/${agent.id}`, { contract_template_id: 'ctt_none' }), 400);
  refused(await call(admin, 'PATCH', `/v1/agents/${agent.id}`, { code: 'ANDAMANS' }), 409, 'code_taken');
  ok(await call(admin, 'PATCH', `/v1/agents/${agent.id}`, { code: agent.code.toLowerCase(), sales_id: sales.s2, name: `Echo Travel ${run}`, sub_market: 'DMC', signatory: { signed_date: '2026-10-01' } }));
  const lines = ok(await call(admin, 'GET', `/v1/agents/${agent.id}/activity`)).activity.map((l: { kind: string; text: string }) => `${l.kind}: ${l.text}`);
  // One line per section changed, each signed by the login: the echo's credit, company and note
  // edits, then the second PATCH's salesperson, company, code and signatory.
  assert.ok(lines.includes('company: Company info updated'));
  assert.ok(lines.includes('sales: Salesperson: — → Joy'));
  assert.ok(lines.includes('credit: Profile · payment proforma→invoice · credit limit 0→200,000'));
  assert.ok(lines.includes(`company: Company · name "Echo Tours ${run}"→"Echo Travel ${run}" · sub "—"→"DMC"`));
  assert.ok(lines.includes(`edit: Code: ${agent.code} → ${agent.code.toLowerCase()}`));
  assert.ok(lines.includes('edit: Signatory updated'));
  assert.ok(lines.includes('note: Notes updated'));
});

test('programmes: one row per route, a bare route id keeps its window', async () => {
  await basics();
  const agent = await createAgent(admin, `Program Co ${run}`);
  refused(await call(admin, 'PUT', `/v1/agents/${agent.id}/programs`, { programs: ['r5', 'r5'] }), 400);
  refused(await call(admin, 'PUT', `/v1/agents/${agent.id}/programs`, { programs: [{ route_id: 'r5', book_from: '2027-02-01', book_to: '2027-01-01' }] }), 400);
  refused(await call(admin, 'PUT', `/v1/agents/${agent.id}/programs`, { programs: [{ route_id: 'r5', book_from: '1/2/2027' }] }), 400);
  const put = ok(await call(admin, 'PUT', `/v1/agents/${agent.id}/programs`, { programs: ['r6', { route_id: 'r3', note: 'High season' }] }));
  assert.deepEqual(put.programs, [
    { route_id: 'r6', book_from: agent.contract_start, book_to: agent.contract_end, note: null },
    { route_id: 'r3', book_from: null, book_to: null, note: 'High season' },
  ]);
  const log = ok(await call(admin, 'GET', `/v1/agents/${agent.id}/activity`)).activity;
  assert.equal(log[0].text, 'Programs / periods updated');
  ok(await call(admin, 'PUT', `/v1/agents/${agent.id}/programs`, { programs: ['r6'] }));
  assert.equal(ok(await call(admin, 'GET', `/v1/agents/${agent.id}/activity`)).activity[0].text, 'Programs updated (2 → 1 routes)');
});

/** A main contract and an expired one for the agent, as import-contracts writes them. */
async function seedContracts(agentId: string, rateTypeId: string): Promise<void> {
  const base: Omit<Contract, 'id' | 'status'> = {
    agent_id: agentId, kind: 'main', rate_type_id: rateTypeId, active_from: '2025-10-01', active_to: '2026-09-30', priority: 0, version: 'v2025-1',
    price_mode: null, discount: null, bonus: null, book_window: false, created_date: '2025-10-01', created_by: 'migration', note: null, doc_id: null, program_periods: [], seat_prices: [],
  };
  const rows: Contract[] = [{ ...base, id: `ct_main_${agentId}`, status: 'active' }, { ...base, id: `ct_hist_${agentId}`, status: 'expired' }];
  if (store instanceof OperationsStore) { store.seedContracts([...store.listContracts({}), ...rows]); return; }
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    for (const c of rows) {
      await db.query(`INSERT INTO contracts (id, agent_id, kind, status, rate_type_id, active_from, active_to, priority, version, book_window) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [c.id, c.agent_id, c.kind, c.status, c.rate_type_id, c.active_from, c.active_to, c.priority, c.version, c.book_window]);
    }
  } finally { await db.end(); }
}

test('a rate type change refills the programmes, syncs the main contract, and asks before dropping', async () => {
  await basics();
  const agent = await createAgent(admin, `Rate Change ${run}`, { sales_id: sales.s1 });
  await seedContracts(agent.id, shared);
  const r6only = ok(await call(admin, 'POST', '/v1/rate-types', { name: `SE r6 ${run}`, routes: [{ route_id: 'r6', zones: { KL: { net: { ad_th: 900 } } } }, { route_id: 'r3', zones: { PK: { net: { ad_fr: 500 } } } }] }), 201);
  const owned = ok(await call(admin, 'POST', '/v1/rate-types', { name: `SE Joy only ${run}`, owner: sales.s2 }), 201);
  refused(await call(admin, 'PUT', `/v1/agents/${agent.id}/rate-type`, { rate_type_id: owned.id }), 400);
  refused(await call(admin, 'PUT', `/v1/agents/${agent.id}/rate-type`, { rate_type_id: 'rt_nope' }), 400);
  refused(await call(admin, 'PUT', `/v1/agents/${agent.id}/rate-type`, {}), 400);
  refused(await call(admin, 'PUT', `/v1/agents/${agent.id}/rate-type`, { rate_type_id: r6only.id, drop_unpriced: 'yes' }), 400);
  const asked = refused(await call(admin, 'PUT', `/v1/agents/${agent.id}/rate-type`, { rate_type_id: r6only.id }), 409, 'unpriced_programs');
  assert.match(asked, /has no price for 1 programme\(s\)/);
  const kept = ok(await call(admin, 'PUT', `/v1/agents/${agent.id}/rate-type`, { rate_type_id: r6only.id, drop_unpriced: false }));
  assert.equal(kept.rate_type_id, r6only.id);
  assert.deepEqual(kept.programs.map((p: { route_id: string }) => p.route_id), ['r5', 'r6', 'r3'], 'r3 joins, r5 kept');
  const contracts = ok(await call(admin, 'GET', `/v1/contracts?agent_id=${agent.id}`)).contracts;
  assert.deepEqual(contracts.map((c: { id: string; rate_type_id: string }) => [c.id, c.rate_type_id]).sort(),
    [[`ct_hist_${agent.id}`, shared], [`ct_main_${agent.id}`, r6only.id]], 'the active main follows; the expired one keeps its rate');
  const log = ok(await call(admin, 'GET', `/v1/agents/${agent.id}/activity`)).activity.map((l: { kind: string; text: string }) => [l.kind, l.text]);
  assert.deepEqual(log.slice(0, 3).map((l: string[]) => l[0]), ['programs', 'contract', 'rate']);
  assert.equal(log[1][1], 'สัญญา MAIN 1 ใบ · Rate Type ตามไปด้วย (เปลี่ยน Rate Type)');
  assert.equal(log[2][1], `Rate type: SE shared ${run} (SE-SHARED-${run.toUpperCase()}) → SE r6 ${run} (SE-R6-${run.toUpperCase()})`, 'legacy _rtNm: name (code)');
  assert.match(log[0][1], /^Programs ตามเรทอัตโนมัติ · \+1 /);

  const back = ok(await call(admin, 'PUT', `/v1/agents/${agent.id}/rate-type`, { rate_type_id: shared, drop_unpriced: true }));
  assert.deepEqual(back.programs.map((p: { route_id: string }) => p.route_id), ['r5', 'r6'], 'r3 dropped when told to');
  const same = ok(await call(admin, 'PUT', `/v1/agents/${agent.id}/rate-type`, { rate_type_id: shared }));
  assert.equal(same.updated_at, back.updated_at, 'the same rate changes nothing');
});

test('renewal archives the contract, moves the programme windows, and clears what is not carried', async () => {
  await basics();
  const agent = await createAgent(admin, `Renew Co ${run}`, { signatory: { name: 'K. A', signed_date: '2026-10-01' } });
  refused(await call(admin, 'POST', `/v1/agents/${agent.id}/renew`, { version: 'v2027-1', start: '2027-10-01', end: '2027-10-01' }), 400);
  refused(await call(admin, 'POST', `/v1/agents/${agent.id}/renew`, { start: '2027-10-01', end: '2028-09-30' }), 400);
  refused(await call(admin, 'POST', `/v1/agents/${agent.id}/renew`, { version: 'v2027-1', start: '2027-10-01', end: '2028-09-30', carry: { prices: 'no' } }), 400);
  const start = agent.contract_start as string;
  const nextStart = `${Number(start.slice(0, 4)) + 1}${start.slice(4)}`;
  const shiftDays = Math.round((Date.parse(nextStart) - Date.parse(start)) / 86_400_000);
  const renewed = ok(await call(admin, 'POST', `/v1/agents/${agent.id}/renew`, { version: 'v2099-1', start: nextStart, end: '2099-12-31', carry: { booking: false, signatory: false } }));
  assert.deepEqual([renewed.contract_version, renewed.contract_start, renewed.contract_end, renewed.contract_status], ['v2099-1', nextStart, '2099-12-31', 'active']);
  const shifted = new Date(Date.parse(`${agent.programs[0].book_from}T00:00:00Z`) + shiftDays * 86_400_000).toISOString().slice(0, 10);
  assert.equal(renewed.programs[0].book_from, shifted, 'the window moves as far as the start did');
  assert.deepEqual(renewed.booking_channel, { method: null, cutoff: null, cancel_policy: null, email: null, phone: null });
  assert.equal(renewed.signatory.signed_date, null, 'pending re-sign');
  assert.equal(renewed.signatory.name, 'K. A');
  assert.equal(renewed.contract_history.length, 1);
  const archived = renewed.contract_history[0];
  assert.deepEqual([archived.version, archived.contract_start, archived.rate_type_id, archived.programs.length, archived.signatory.signed_date, archived.archived_by],
    [agent.contract_version, start, shared, 2, '2026-10-01', `se.admin.${run}`]);
  assert.equal(ok(await call(admin, 'GET', `/v1/agents/${agent.id}/activity`)).activity[0].text, `Contract renewed · ${agent.contract_version} → v2099-1 · ${nextStart} → 2099-12-31`);
});

test('deactivate, activate, a booking for an inactive agent, and the admin-only delete', async () => {
  await basics();
  const agent = await createAgent(admin, `Sleepy Co ${run}`);
  assert.equal(ok(await call(admin, 'POST', `/v1/agents/${agent.id}/deactivate`)).active, false);
  ok(await call(admin, 'POST', `/v1/agents/${agent.id}/deactivate`));
  const log = ok(await call(admin, 'GET', `/v1/agents/${agent.id}/activity`)).activity;
  assert.deepEqual(log.slice(0, 2).map((l: { text: string }) => l.text), ['Agent deactivated', 'Agent created · rate type SE shared ' + run + ' · programs ตามเรทอัตโนมัติ 2 เส้นทาง'], 'twice writes one line');
  assert.ok(!ok(await call(admin, 'GET', '/v1/agents')).agents.some((a: { id: string }) => a.id === agent.id), 'the list shows active agents by default');
  const booking = { agent_id: agent.id, trips: [{ routeId: 'r3', date: '2041-05-01', pax: { ad: 1 } }] };
  assert.match(refused(await call(admin, 'POST', '/v1/bookings', booking), 409, 'agent_inactive'), /is inactive; activate it or choose another agent/);
  ok(await call(admin, 'POST', `/v1/agents/${agent.id}/activate`));
  ok(await call(admin, 'POST', '/v1/bookings', booking), 201);

  const editor = await as(`se.editor.${run}`, { edit_areas: ['sales'] });
  assert.equal(refused(await call(editor, 'DELETE', `/v1/agents/${agent.id}`), 403), 'Only an admin can delete an agent profile');
  assert.match(refused(await call(admin, 'DELETE', `/v1/agents/${agent.id}`), 409, 'in_use'), /1 bookings name it\. Deactivate it instead/);
  const unused = await createAgent(admin, `Gone Co ${run}`);
  assert.equal((await call(admin, 'DELETE', `/v1/agents/${unused.id}`)).statusCode, 204);
  refused(await call(admin, 'GET', `/v1/agents/${unused.id}`), 404);
});

test('contract templates: one default, unique codes, copies of the default, and a delete that unbinds', async () => {
  await basics();
  const before = ok(await call(admin, 'GET', '/v1/contract-templates')).contract_templates;
  const first = ok(await call(admin, 'POST', '/v1/contract-templates', { name: `Std ${run}`, code: `CT-${run}`, sections: { cover: true, pricing: false },
    text: { en: { childRateTitle: 'Children', notRecItems: ['Infants'] }, th: {} }, accent_hex: '#1A2B43' }), 201);
  if (before.length === 0) assert.equal(first.is_default, true, 'the first template is the default');
  ok(await call(admin, 'POST', `/v1/contract-templates/${first.id}/default`));
  const copy = ok(await call(admin, 'POST', '/v1/contract-templates', {}), 201);
  assert.equal(copy.name, 'Template ใหม่');
  assert.match(copy.code, /^CT-\d{2,}$/, 'the next free CT-NN');
  assert.deepEqual([copy.is_default, copy.sections, copy.text, copy.accent_hex], [false, first.sections, first.text, '#1A2B43'], 'a copy of the default');
  refused(await call(admin, 'POST', '/v1/contract-templates', { code: `ct-${run}` }), 409, 'code_taken');
  refused(await call(admin, 'POST', '/v1/contract-templates', { is_default: true }), 400);
  refused(await call(admin, 'PATCH', `/v1/contract-templates/${copy.id}`, { accent_hex: 'navy' }), 400);
  refused(await call(admin, 'PATCH', `/v1/contract-templates/${copy.id}`, { sections: { cover: 'yes' } }), 400);
  refused(await call(admin, 'PATCH', `/v1/contract-templates/${copy.id}`, { text: { en: { x: 5 } } }), 400);
  assert.equal(refused(await call(admin, 'PATCH', `/v1/contract-templates/${copy.id}`, { is_default: true }), 400), 'is_default cannot be changed here: use POST /v1/contract-templates/{id}/default');
  refused(await call(admin, 'PATCH', `/v1/contract-templates/${first.id}`, { active: false }), 409, 'default_template');
  refused(await call(admin, 'DELETE', `/v1/contract-templates/${first.id}`), 409, 'default_template');
  const renamed = ok(await call(admin, 'PATCH', `/v1/contract-templates/${copy.id}`, { ...copy, name: 'Russian market', active: false }));
  assert.deepEqual([renamed.name, renamed.active], ['Russian market', false]);

  const agent = await createAgent(admin, `Template Co ${run}`, { contract_template_id: copy.id });
  assert.equal(agent.contract_template_id, copy.id);
  assert.equal(agent.contract_template_effective_id, first.id, 'bound to an inactive template: the default prints (ctTmplForAgent)');
  assert.equal(ok(await call(admin, 'GET', `/v1/contract-templates/${copy.id}`)).agents, 1);
  assert.equal((await call(admin, 'DELETE', `/v1/contract-templates/${copy.id}`)).statusCode, 204);
  const after = ok(await call(admin, 'GET', `/v1/agents/${agent.id}`));
  assert.equal(after.contract_template_id, null, 'unbound');
  assert.equal(ok(await call(admin, 'GET', `/v1/agents/${agent.id}/activity`)).activity[0].text, 'Contract template: Russian market → ค่าตั้งต้น');
});

test('an issued contract document is frozen, linked to its contract, and logged', async () => {
  await basics();
  const agent = await createAgent(admin, `Docs Co ${run}`);
  await seedContracts(agent.id, shared);
  const other = await createAgent(admin, `Docs Other ${run}`);
  await seedContracts(other.id, shared);
  const templates = ok(await call(admin, 'GET', '/v1/contract-templates')).contract_templates;
  const template = templates[0];
  const content = { sections: { cover: true }, tmplText: { en: { childRateTitle: 'Children' } }, overrides: {}, customClauses: ['No pets'] };
  refused(await call(admin, 'POST', `/v1/agents/${agent.id}/documents`, { lang: 'de', content }), 400);
  refused(await call(admin, 'POST', `/v1/agents/${agent.id}/documents`, { lang: 'en' }), 400);
  refused(await call(admin, 'POST', `/v1/agents/${agent.id}/documents`, { lang: 'en', content, version: 'v1' }), 400);
  refused(await call(admin, 'POST', `/v1/agents/${agent.id}/documents`, { lang: 'en', content, contract_id: `ct_main_${other.id}` }), 400);
  refused(await call(admin, 'POST', `/v1/agents/${agent.id}/documents`, { lang: 'en', content, template_id: 'ctt_none' }), 400);
  const doc = ok(await call(admin, 'POST', `/v1/agents/${agent.id}/documents`, { lang: 'th', content, contract_id: `ct_main_${agent.id}`, template_id: template?.id, page_count: 6 }), 201);
  assert.match(doc.id, /^gc_/);
  assert.equal(doc.version, agent.contract_version);
  assert.equal(doc.generated_by, `se.admin.${run}`);
  assert.equal(doc.template_name, template?.name ?? null);
  assert.equal(doc.rate_type_name, `SE shared ${run}`);
  assert.deepEqual(doc.content, content);
  assert.equal(ok(await call(admin, 'GET', `/v1/contracts/ct_main_${agent.id}`)).doc_id, doc.id, 'the contract is stamped');
  const listed = ok(await call(admin, 'GET', `/v1/agents/${agent.id}/documents`)).documents;
  assert.deepEqual(listed.map((d: { id: string; content?: unknown }) => [d.id, d.content]), [[doc.id, undefined]], 'summaries, without the content');
  assert.deepEqual(ok(await call(admin, 'GET', `/v1/contract-documents/${doc.id}`)).content, content);
  assert.equal(ok(await call(admin, 'GET', `/v1/agents/${agent.id}/activity`)).activity[0].text, `Contract generated · ${agent.contract_version} · TH`);
  assert.equal((await call(admin, 'DELETE', `/v1/contract-documents/${doc.id}`)).statusCode, 204);
  assert.equal(ok(await call(admin, 'GET', `/v1/contracts/ct_main_${agent.id}`)).doc_id, null);
  refused(await call(admin, 'GET', `/v1/contract-documents/${doc.id}`), 404);
});

test('a salesperson\'s delete unassigns their agents; a market with agents stays', async () => {
  await basics();
  const temp = ok(await call(admin, 'POST', '/v1/sales', { code: 'Q' + run.slice(-1).toUpperCase(), name: 'Temp' }), 201);
  const agent = await createAgent(admin, `Orphan Co ${run}`, { sales_id: temp.id });
  assert.equal((await call(admin, 'DELETE', `/v1/sales/${temp.id}`)).statusCode, 204);
  assert.equal(ok(await call(admin, 'GET', `/v1/agents/${agent.id}`)).sales_id, null);
  assert.equal(ok(await call(admin, 'GET', `/v1/agents/${agent.id}/activity`)).activity[0].text, 'Salesperson: Temp → —');
  await as(`se.bound.${run}`, { sales_id: sales.s2 });
  refused(await call(admin, 'DELETE', `/v1/sales/${sales.s2}`), 409, 'in_use');
  refused(await call(admin, 'DELETE', `/v1/markets/${market}`), 409, 'in_use');
});

test('the add-on catalogue: services with variants and prices, under sales', async () => {
  await basics();
  refused(await call(admin, 'POST', '/v1/addon-services', { name: 'Kayak', type: 'canoe' }), 400);
  refused(await call(admin, 'POST', '/v1/addon-services', { type: 'boat' }), 400);
  refused(await call(admin, 'POST', '/v1/addon-services', { name: 'Kayak', type: 'boat', variants: [{ name: 'Single', selling: -1 }] }), 400);
  refused(await call(admin, 'POST', '/v1/addon-services', { name: 'Kayak', type: 'boat', id: 'aos_mine' }), 400);
  const svc = ok(await call(admin, 'POST', '/v1/addon-services', { name: `Long-tail ${run}`, type: 'boat', description: 'Pileh Lagoon',
    variants: [{ name: 'Join Long-tail', unit: 'per person', selling: 280, net: 180 }, { id: 'v_private', name: 'Private Long-tail', selling: 1400 }] }), 201);
  assert.match(svc.id, /^aos_/);
  assert.match(svc.variants[0].id, /^v_/);
  assert.deepEqual(svc.variants[1], { id: 'v_private', name: 'Private Long-tail', unit: null, selling: 1400, net: null });
  const patched = ok(await call(admin, 'PATCH', `/v1/addon-services/${svc.id}`, { variants: [{ id: 'v_private', name: 'Private', selling: 1500, net: 1200 }], active: false }));
  assert.deepEqual([patched.variants.length, patched.variants[0].net, patched.active], [1, 1200, false]);
  assert.ok(ok(await call(admin, 'GET', '/v1/addon-services?active=false')).addon_services.some((s: { id: string }) => s.id === svc.id));
  assert.ok(!ok(await call(admin, 'GET', '/v1/addon-services?active=true')).addon_services.some((s: { id: string }) => s.id === svc.id));
  const ops = await as(`se.ops2.${run}`, { edit_areas: ['operations'] });
  refused(await call(ops, 'PATCH', `/v1/addon-services/${svc.id}`, { name: 'x' }), 403);
  assert.equal((await call(admin, 'DELETE', `/v1/addon-services/${svc.id}`)).statusCode, 204);
  refused(await call(admin, 'GET', `/v1/addon-services/${svc.id}`), 404);
});

test('nationalities: the server\'s list and legacy\'s clean-and-match rule, under operations', async () => {
  await basics();
  const list = ok(await call(admin, 'GET', '/v1/nationalities')).nationalities;
  assert.deepEqual(list[0], { code: 'TH', name: 'Thai', custom: false });
  assert.deepEqual(list[list.length - 1], { code: 'OTHER', name: 'Other', custom: false });
  const { BUILTIN_NATIONALITIES } = await import('../src/domain/nationalities.js');
  assert.deepEqual(list.filter((n: { custom: boolean }) => !n.custom).map((n: { code: string; name: string }) => [n.code, n.name]), BUILTIN_NATIONALITIES,
    'migration 092 seeds what the in-process store holds');
  assert.deepEqual(ok(await call(admin, 'POST', '/v1/nationalities', { name: 'german' })), { code: 'DE', name: 'German', custom: false, created: false });
  assert.equal(ok(await call(admin, 'POST', '/v1/nationalities', { name: 'de' })).code, 'DE', 'a code matches too');
  refused(await call(admin, 'POST', '/v1/nationalities', { name: ' Q. ' }), 400);
  refused(await call(admin, 'POST', '/v1/nationalities', {}), 400);
  const name = `Zq${run.replace(/[^a-z]/g, '')}ian`;
  const made = await call(admin, 'POST', '/v1/nationalities', { name: `${name} · ZQX` });
  const n = JSON.parse(made.body);
  assert.ok(made.statusCode === 201 || made.statusCode === 200, made.body);
  assert.equal(n.name, name, 'the label suffix is cleaned off');
  assert.match(n.code, /^ZQ[A-Z]\d*$/);
  assert.deepEqual(ok(await call(admin, 'POST', '/v1/nationalities', { name: `(${name.toUpperCase()})` })), { ...n, created: false });
  const listed = ok(await call(admin, 'GET', '/v1/nationalities')).nationalities;
  assert.equal(listed[listed.length - 1].code, 'OTHER', 'custom ones before Other');
  const salesOnly = await as(`se.sales2.${run}`, { edit_areas: ['sales'] });
  refused(await call(salesOnly, 'POST', '/v1/nationalities', { name: 'Atlantean' }), 403);
});

test('insurance: ages and reviews on the passengers, set by the command, kept across an edit', async () => {
  await basics();
  const ops = await as(`se.pier.${run}`, { edit_areas: ['operations'] });
  const created = ok(await call(admin, 'POST', '/v1/bookings', { trips: [{ routeId: 'r3', date: '2041-05-02', pax: { ad: 3 } }], leadPax: 'Ann Lead',
    passengers: [{ name: 'Bob One' }, { name: 'Cy Two' }] }), 201);
  const put = (body: object, version: number) => call(ops, 'PUT', `/v1/bookings/${created.id}/insurance`, { ...body, version });
  refused(await call(ops, 'PUT', `/v1/bookings/${created.id}/insurance`, { passengers: [{ passenger: 'lead', age: 30 }] }), 428, 'version_required');
  refused(await put({ passengers: [{ passenger: 5, age: 30 }] }, created.version), 400);
  refused(await put({ passengers: [{ passenger: 'lead', age: -1 }] }, created.version), 400);
  refused(await put({ passengers: [{ passenger: 'lead', age: 'old' }] }, created.version), 400);
  refused(await put({ passengers: [{ passenger: 0, reviewed: 'yes' }] }, created.version), 400);
  refused(await put({ passengers: [] }, created.version), 400);
  const salesOnly = await as(`se.sales3.${run}`, { edit_areas: ['sales'] });
  refused(await call(salesOnly, 'PUT', `/v1/bookings/${created.id}/insurance`, { passengers: [{ passenger: 'lead', age: 30 }], version: created.version }), 403);

  const done = ok(await put({ passengers: [{ passenger: 'lead', age: '47', reviewed: true }, { passenger: 0, age: 2.5 }, { passenger: 1, reviewed: true }] }, created.version));
  assert.equal(done.lead_age, 47, 'legacy\'s text age read as a number');
  assert.equal(done.lead_insurance_reviewed_by, `se.pier.${run}`);
  assert.ok(done.lead_insurance_reviewed_at);
  assert.equal(done.passengers[0].age, 2.5, 'fractional ages allowed');
  assert.equal(done.passengers[0].insurance_reviewed_at, undefined);
  assert.equal(done.passengers[1].insurance_reviewed_by, `se.pier.${run}`);
  assert.equal(done.version, created.version + 1);
  const history = ok(await call(admin, 'GET', `/v1/bookings/${created.id}/history`)).history;
  assert.equal(history[history.length - 1].text, 'Insurance · lead age 47 reviewed · #0 age 2.5 · #1 reviewed');

  refused(await call(admin, 'PATCH', `/v1/bookings/${created.id}`, { version: done.version, lead_age: 50 }), 400);
  refused(await call(admin, 'PATCH', `/v1/bookings/${created.id}`, { version: done.version, passengers: [{ name: 'Bob One', age: 3 }, { name: 'Cy Two' }] }), 400);
  // An echo is fine; a renamed passenger at a position loses what was the other person's.
  const edited = ok(await call(admin, 'PATCH', `/v1/bookings/${created.id}`, { version: done.version, lead_age: 47,
    passengers: [{ name: 'Bob One', age: 2.5 }, { name: 'Dee Three' }] }));
  assert.equal(edited.passengers[0].age, 2.5, 'same passenger, same position: kept');
  assert.equal(edited.passengers[1].insurance_reviewed_by, undefined, 'another passenger at that position: dropped (legacy bug 12)');
  assert.equal(edited.lead_age, 47);
  const cleared = ok(await put({ passengers: [{ passenger: 'lead', age: null, reviewed: false }] }, edited.version));
  assert.equal(cleared.lead_age, undefined);
  assert.equal(cleared.lead_insurance_reviewed_by, undefined);
});
