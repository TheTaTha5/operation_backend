import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';

process.env.AUTH_JWT_SECRET = 'credit-test-secret';
const { buildApp } = await import('../src/app.js');
const { OperationsStore } = await import('../src/domain/operations.js');
const { blankAgent, seedUser, testStore, tokenFor } = await import('./users-helper.js');

// Deposits into an agent's credit and refund payouts (todo/money-model.md, "Design: the rest of
// Money"), on whichever store DATABASE_URL selects. Its own agents (cr_), users (cr-) and days (2065).
const store = testStore();
const agents = ['cr_a1', 'cr_a2'];
if (store instanceof OperationsStore) {
  store.seedAgents({ agents: agents.map((id) => ({ ...blankAgent(id, null), pay_type: 'invoice', vat_mode: 'none' })) });
} else {
  const { Pool } = await import('pg');
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const id of agents) await db.query(`INSERT INTO agents (id, name, pay_type, vat_mode) VALUES ($1, $1, 'invoice', 'none') ON CONFLICT (id) DO NOTHING`, [id]);
  await db.end();
}
const app = buildApp({ store });
after(async () => app.close());
await seedUser(store, { username: 'cr-admin', role: 'admin' });
await seedUser(store, { username: 'cr-acct', edit_areas: ['accounting'] });
await seedUser(store, { username: 'cr-ops', edit_areas: ['operations'] });
await seedUser(store, { username: 'cr-agent', agent_id: 'cr_a2' });
const admin = await tokenFor(app, 'cr-admin');
const acct = await tokenFor(app, 'cr-acct');
const ops = await tokenFor(app, 'cr-ops');
const agentLogin = await tokenFor(app, 'cr-agent');

const send = async (method: InjectOptions['method'], url: string, payload?: object, headers: Record<string, string> = admin) => {
  const booking = method !== 'GET' && /^\/v1\/bookings\/[^/]+/.exec(url);
  const version = booking ? (await app.inject({ method: 'GET', url: booking[0], headers: admin })).json().version : undefined;
  return app.inject({ method, url, headers, ...(payload || version ? { payload: { ...payload, ...(version ? { version } : {}) } } : {}) });
};
const ok = <T = Record<string, any>>(res: { statusCode: number; body: string; json: () => unknown }, status = 200): T => {
  assert.equal(res.statusCode, status, res.body);
  return res.json() as T;
};
const refused = (res: { statusCode: number; body: string; json: () => any }, status: number, code?: string) => {
  assert.equal(res.statusCode, status, res.body);
  if (code) assert.equal(res.json().code, code, res.body);
};
const run = Date.now().toString(36);
let n = 0;
async function booking(date: string, total: number, agent = 'cr_a1'): Promise<{ id: string }> {
  await send('POST', '/operations/deployments', { boat_id: `cr-boat-${date}`, route_id: 'r1', service_date: date, capacity: 40 });
  return ok(await send('POST', '/v1/bookings', { agent_id: agent, external_id: `b2c_cr_${run}_${++n}`, total, route_id: 'r1', service_date: date, pax: 2 }), 201);
}
async function invoice(bookingId: string, paid: number, agent = 'cr_a1'): Promise<{ id: string; number: string }> {
  const inv = ok<{ id: string; number: string }>(await send('POST', '/v1/invoices', { agent_id: agent, booking_ids: [bookingId] }), 201);
  if (paid) ok(await send('POST', `/v1/invoices/${inv.id}/payments`, { amount: paid, method: 'transfer' }), 201);
  return inv;
}
const balance = async (agent: string) => ok(await send('GET', `/v1/agents/${agent}/statement`)).credit_balance;

test('a deposit adds to the agent\'s credit; a credit payment spends it; a spent deposit cannot be voided', async () => {
  refused(await send('POST', '/v1/deposits', { agent_id: 'cr_a1', amount: 5000 }, ops), 403);
  refused(await send('POST', '/v1/deposits', { agent_id: 'cr_a1', amount: 0 }, acct), 400);
  refused(await send('POST', '/v1/deposits', { amount: 10 }, acct), 400);
  refused(await send('POST', '/v1/deposits', { agent_id: 'nobody', amount: 10 }, acct), 400);
  refused(await send('POST', '/v1/deposits', { agent_id: 'cr_a1', amount: 10, recorded_by: 'me' }, acct), 400, undefined);
  refused(await send('POST', '/v1/deposits', { agent_id: 'cr_a1', amount: 10, method: 'cheque' }, acct), 400);
  refused(await send('POST', '/v1/deposits', { agent_id: 'cr_a1', amount: 10, slip_ids: ['att_nowhere'] }, acct), 400);
  const before = await balance('cr_a1');
  const dep = ok(await send('POST', '/v1/deposits', { agentId: 'cr_a1', amount: 5000, method: 'cash', date: '2065-01-02', note: 'มัดจำ' }, acct), 201);
  assert.deepEqual([dep.amount, dep.method, dep.received_on, dep.recorded_by, dep.status], [5000, 'cash', '2065-01-02', 'cr-acct', 'live']);
  assert.equal(dep.credit_balance.deposited, before.deposited + 5000);

  const b = await booking('2065-01-05', 3000);
  const inv = await invoice(b.id, 0);
  refused(await send('POST', `/v1/invoices/${inv.id}/payments`, { amount: before.available + 6000, method: 'credit' }), 409, 'credit_short');
  ok(await send('POST', `/v1/invoices/${inv.id}/payments`, { amount: 3000, method: 'credit' }), 201);
  const after = await balance('cr_a1');
  assert.deepEqual([after.deposited - before.deposited, after.used - before.used, after.available - before.available], [5000, 3000, 2000]);

  // Voiding 5,000 would take the balance below 0 (2,000 left of it).
  refused(await send('POST', `/v1/deposits/${dep.id}/void`, {}, acct), 400);
  if (before.available < 3000) refused(await send('POST', `/v1/deposits/${dep.id}/void`, { reason: 'typo' }, acct), 409, 'deposit_spent');
  const small = ok(await send('POST', '/v1/deposits', { agent_id: 'cr_a1', amount: 1000 }, acct), 201);
  const voided = ok(await send('POST', `/v1/deposits/${small.id}/void`, { reason: 'typo' }, acct));
  assert.deepEqual([voided.status, voided.void_reason, voided.voided_by], ['void', 'typo', 'cr-acct']);
  refused(await send('POST', `/v1/deposits/${small.id}/void`, { reason: 'again' }, acct), 409, 'deposit_void');
  assert.deepEqual((await balance('cr_a1')).available, after.available, 'a voided deposit is out of the balance');

  const st = ok(await send('GET', '/v1/agents/cr_a1/statement'));
  assert.ok(st.deposits.some((d: { id: string }) => d.id === dep.id) && !st.deposits.some((d: { id: string }) => d.id === small.id), 'live deposits on the statement');
  const listed = ok(await send('GET', '/v1/deposits?agent_id=cr_a1&include_voided=true')).deposits.map((d: { id: string }) => d.id);
  assert.ok(listed.includes(dep.id) && listed.includes(small.id));
  assert.ok(!ok(await send('GET', '/v1/deposits?agent_id=cr_a1')).deposits.some((d: { id: string }) => d.id === small.id));
  const dash = ok(await send('GET', '/v1/reports/accounting'));
  assert.ok(dash.deposits_held >= after.available - before.available);
  // A login tied to an agent sees its own deposits only.
  const theirs = ok(await send('POST', '/v1/deposits', { agent_id: 'cr_a2', amount: 700 }, acct), 201);
  assert.deepEqual(ok(await send('GET', '/v1/deposits?agent_id=cr_a1', undefined, agentLogin)).deposits.map((d: { agent_id: string }) => d.agent_id).every((a: string) => a === 'cr_a2'), true);
  refused(await send('GET', `/v1/deposits/${dep.id}`, undefined, agentLogin), 404);
  ok(await send('GET', `/v1/deposits/${theirs.id}`, undefined, agentLogin));
  refused(await send('POST', '/v1/deposits', { agent_id: 'cr_a2', amount: 1 }, agentLogin), 403);
});

test('a refund owed is paid out once, shows on the dashboard until then; a credit is never paid out', async () => {
  const date = '2065-02-10';
  const refunded = await booking(date, 3000);
  const credited = await booking(date, 2000);
  await invoice(refunded.id, 3000);
  await invoice(credited.id, 2000);
  const r = ok<{ refunds: { id: string; kind: string }[] }>(await send('POST', `/v1/bookings/${refunded.id}/cancel-weather`, { outcome: 'refund' }, ops)).refunds[0];
  const c = ok<{ refunds: { id: string; kind: string }[] }>(await send('POST', `/v1/bookings/${credited.id}/cancel-weather`, { outcome: 'credit' }, ops)).refunds[0];
  let dash = ok(await send('GET', '/v1/reports/accounting'));
  assert.ok(dash.refunds_to_pay.items.some((x: { id: string; amount: number }) => x.id === r.id && x.amount === 3000));
  assert.ok(!dash.refunds_to_pay.items.some((x: { id: string }) => x.id === c.id), 'a credit is spent, not paid out');

  refused(await send('POST', `/v1/refunds/${r.id}/payout`, { method: 'transfer' }, ops), 403);
  refused(await send('POST', `/v1/refunds/${c.id}/payout`, { method: 'transfer' }, acct), 409, 'not_a_refund');
  refused(await send('POST', `/v1/refunds/${r.id}/payout`, { method: 'card' }, acct), 400);
  refused(await send('POST', `/v1/refunds/${r.id}/payout`, { method: 'transfer', paid_out_by: 'x' }, acct), 400);
  refused(await send('POST', '/v1/refunds/rf_nowhere/payout', { method: 'transfer' }, acct), 404);
  const paid = ok(await send('POST', `/v1/refunds/${r.id}/payout`, { method: 'transfer', date: '2065-02-12', ref: 'KBANK 1234' }, acct));
  assert.deepEqual([paid.payout.paid_on, paid.payout.method, paid.payout.ref, paid.payout.paid_out_by], ['2065-02-12', 'transfer', 'KBANK 1234', 'cr-acct']);
  refused(await send('POST', `/v1/refunds/${r.id}/payout`, { method: 'cash' }, acct), 409, 'refund_paid_out');
  dash = ok(await send('GET', '/v1/reports/accounting'));
  assert.ok(!dash.refunds_to_pay.items.some((x: { id: string }) => x.id === r.id));
  assert.ok(ok(await send('GET', `/v1/refunds?booking_id=${refunded.id}&paid_out=true`)).refunds.some((x: { id: string }) => x.id === r.id));
  assert.equal(ok(await send('GET', `/v1/refunds?booking_id=${refunded.id}&paid_out=false`)).refunds.length, 0);
  refused(await send('GET', '/v1/refunds?paid_out=maybe'), 400);
  const undone = ok(await send('DELETE', `/v1/refunds/${r.id}/payout`, undefined, acct));
  assert.equal(undone.payout, null);
  refused(await send('DELETE', `/v1/refunds/${r.id}/payout`, undefined, acct), 409, 'refund_not_paid_out');
  assert.ok(ok(await send('GET', '/v1/reports/accounting')).refunds_to_pay.items.some((x: { id: string }) => x.id === r.id));
});
