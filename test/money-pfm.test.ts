import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';

process.env.AUTH_JWT_SECRET = 'money-pfm-test-secret';
const { buildApp } = await import('../src/app.js');
const { OperationsStore } = await import('../src/domain/operations.js');
const { blankAgent, seedUser, testStore, tokenFor } = await import('./users-helper.js');
const { todayInThailand } = await import('../src/domain/calendar.js');
const { pfmCutoff } = await import('../src/domain/pfm.js');

// Proforma, legacy's Daily PFM (todo/money-model.md slice 2), on whichever store DATABASE_URL selects.
const store = testStore();
const agents = { pfm_a1: { pay_type: 'proforma', vat_mode: 'none', sales_id: 'pfm_s1' }, pfm_a2: { pay_type: 'invoice', vat_mode: 'none', sales_id: null } } as const;
if (store instanceof OperationsStore) {
  store.seedAgents({
    sales: [{ id: 'pfm_s1', code: null, name: 'Nok', full_name: null, designation: null, email: null, tel: null, color: null, active: true }],
    agents: Object.entries(agents).map(([id, f]) => ({ ...blankAgent(id, f.sales_id), pay_type: f.pay_type, vat_mode: f.vat_mode })),
  });
} else {
  const { Pool } = await import('pg');
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  await db.query(`INSERT INTO sales_people (id, name) VALUES ('pfm_s1', 'Nok') ON CONFLICT (id) DO NOTHING`);
  for (const [id, f] of Object.entries(agents)) {
    await db.query(`INSERT INTO agents (id, name, pay_type, vat_mode, sales_id) VALUES ($1, $1, $2, $3, $4)
      ON CONFLICT (id) DO UPDATE SET pay_type = $2, vat_mode = $3, sales_id = $4`, [id, f.pay_type, f.vat_mode, f.sales_id]);
  }
  await db.end();
}
const app = buildApp({ store });
after(async () => app.close());
await seedUser(store, { username: 'pfm-admin', role: 'admin' });
await seedUser(store, { username: 'pfm-acct', edit_areas: ['accounting'] });
await seedUser(store, { username: 'pfm-pier', edit_areas: ['pier'] });
const admin = await tokenFor(app, 'pfm-admin');
const acct = await tokenFor(app, 'pfm-acct');
const pier = await tokenFor(app, 'pfm-pier');
const send = async (method: InjectOptions['method'], url: string, payload?: object, headers: Record<string, string> = admin, version = true) => {
  const booking = method !== 'GET' && version && /^\/v1\/bookings\/[^/?]+/.exec(url);
  const v = booking ? (await app.inject({ method: 'GET', url: booking[0], headers: admin })).json().version : undefined;
  return app.inject({ method, url, headers: { ...headers, ...(v ? { 'if-match': `"${v}"` } : {}) }, ...(payload ? { payload } : {}) });
};
const run = Date.now().toString(36);
let n = 0;
async function booking(agent: string, date: string, total = 5600, extra: object = {}): Promise<{ id: string }> {
  await send('POST', '/operations/deployments', { boat_id: `pfm-boat-${date}`, route_id: 'r1', service_date: date, capacity: 60 });
  const created = await send('POST', '/v1/bookings', { agent_id: agent, external_id: `b2c_pfm_${run}_${++n}`, total, route_id: 'r1', service_date: date, pax: 1, ...extra });
  assert.equal(created.statusCode, 201, created.body);
  return created.json();
}
type Row = { booking_id: string; kind: string; status: string; total: number; paid: number; balance: number; past_cutoff: boolean; cutoff_at: string; sales_name: string | null;
  decision: { decision: string; approver: string | null; by: string } | null; reminded_at: string | null; cot_deduct: number };
const rowsOn = async (date: string): Promise<Row[]> => (await send('GET', `/v1/pfm?date=${date}`)).json().rows;
const rowOf = async (date: string, id: string): Promise<Row> => (await rowsOn(date)).find((r) => r.booking_id === id)!;
const today = todayInThailand();
const future = '2059-03-01';

test('the cutoff is 18:00 Bangkok the day before the first trip', () => {
  assert.equal(pfmCutoff('2026-10-12'), '2026-10-11T11:00:00.000Z');
});

test('a proforma booking past its cutoff and unpaid is an alert; staff extend travel or hold it, each kept', async () => {
  const a = await booking('pfm_a1', today);
  const row = await rowOf(today, a.id);
  assert.deepEqual([row.kind, row.status, row.total, row.balance, row.past_cutoff, row.sales_name], ['proforma', 'alert', 5600, 5600, true, 'Nok']);
  assert.equal((await send('POST', `/v1/bookings/${a.id}/pfm/approve-travel`, {}, admin, false)).statusCode, 428, 'a booking command needs If-Match');
  assert.equal((await send('POST', `/v1/bookings/${a.id}/pfm/approve-travel`, {}, pier)).statusCode, 403, 'operations or accounting');

  const approved = await send('POST', `/v1/bookings/${a.id}/pfm/approve-travel`, {}, acct);
  assert.equal(approved.statusCode, 200, approved.body);
  assert.deepEqual([approved.json().status, approved.json().decision.approver, approved.json().decision.by], ['approved', 'Nok', 'pfm-acct'], 'the booking\'s salesperson by default');
  assert.equal((await send('POST', `/v1/bookings/${a.id}/pfm/approve-travel`, { approver: 'P\'MAM' }, acct)).json().code, 'pfm_decided');
  const held = await send('POST', `/v1/bookings/${a.id}/pfm/hold`, {}, acct);
  assert.deepEqual([held.statusCode, held.json().status], [200, 'hold'], 'the other decision replaces it');
  const again = await send('POST', `/v1/bookings/${a.id}/pfm/approve-travel`, { approver: 'P\'MAM' }, acct);
  assert.deepEqual([again.json().status, again.json().decision.approver], ['approved', 'P\'MAM']);
  const history = (await send('GET', `/v1/bookings/${a.id}/history`)).json().history.map((h: { text: string }) => h.text);
  assert.deepEqual(history.filter((t: string) => t.startsWith('PFM')), ['PFM unpaid · travel EXTENDED by Nok', 'PFM unpaid · put on hold', 'PFM unpaid · travel EXTENDED by P\'MAM']);
});

test('refusals follow legacy\'s buttons: before the cutoff, paid, or paid ahead on its own invoice', async () => {
  const early = await booking('pfm_a1', future);
  const r1 = await send('POST', `/v1/bookings/${early.id}/pfm/hold`, {}, acct);
  assert.deepEqual([r1.statusCode, r1.json().code], [409, 'before_cutoff']);
  assert.equal((await rowOf(future, early.id)).status, 'no_invoice');

  const paid = await booking('pfm_a1', today, 1000);
  const inv = (await send('POST', '/v1/invoices', { agent_id: 'pfm_a1', booking_ids: [paid.id] }, acct)).json();
  assert.equal((await rowOf(today, paid.id)).status, 'alert', 'invoiced, unpaid, past the cutoff');
  await send('POST', '/v1/invoices', { agent_id: 'pfm_a1', booking_ids: [early.id] }, acct);
  assert.equal((await rowOf(future, early.id)).status, 'awaiting', 'invoiced, before the cutoff');
  await send('POST', `/v1/invoices/${inv.id}/payments`, { amount: 1000 }, acct);
  assert.deepEqual([(await rowOf(today, paid.id)).status, (await rowOf(today, paid.id)).balance], ['paid', 0]);
  assert.equal((await send('POST', `/v1/bookings/${paid.id}/pfm/hold`, {}, acct)).json().code, 'pfm_paid');

  // An invoice (credit) agent's booking paid ahead on its own prepay invoice (§pfmPrepay): only what was received counts.
  const pre = await booking('pfm_a2', today, 3000);
  assert.equal((await rowOf(today, pre.id)), undefined, 'not in scope until it has a prepay invoice');
  const pinv = (await send('POST', '/v1/invoices', { agent_id: 'pfm_a2', booking_ids: [pre.id], kind: 'prepay' }, acct)).json();
  await send('POST', `/v1/invoices/${pinv.id}/payments`, { amount: 1000 }, acct);
  const pr = await rowOf(today, pre.id);
  assert.deepEqual([pr.kind, pr.status, pr.total, pr.paid, pr.balance, pr.past_cutoff], ['prepay', 'prepaid_part', 1000, 1000, 0, false]);
  assert.equal((await send('POST', `/v1/bookings/${pre.id}/pfm/hold`, {}, acct)).json().code, 'not_proforma');

  const tallies = (await send('GET', `/v1/pfm?date=${today}`)).json().totals;
  assert.ok(tallies.count >= 3 && tallies.by_status.paid >= 1 && tallies.collected_pct >= 0);
});

test('remind logs on every proforma booking in the range that still owes; cash on tour deducted comes off its total', async () => {
  const day = '2059-03-02';
  const owes = await booking('pfm_a1', day, 4000, { cashOnTour: { amount: 1000, handling: 'deduct' } });
  const settled = await booking('pfm_a1', day, 500);
  const inv = (await send('POST', '/v1/invoices', { agent_id: 'pfm_a1', booking_ids: [settled.id] }, acct)).json();
  await send('POST', `/v1/invoices/${inv.id}/payments`, { amount: 500 }, acct);
  const reminded = await send('POST', '/v1/pfm/remind', { date: day }, acct);
  assert.equal(reminded.statusCode, 200, reminded.body);
  assert.deepEqual(reminded.json().reminded, [owes.id]);
  assert.ok((await rowOf(day, owes.id)).reminded_at);
  assert.equal((await send('GET', `/v1/bookings/${owes.id}/history`)).json().history.at(-1).text, 'PFM payment reminder sent');

  await send('PUT', `/v1/bookings/${owes.id}/cot-decisions/${day}`, { mode: 'full' });
  const row = await rowOf(day, owes.id);
  assert.deepEqual([row.total, row.balance, row.cot_deduct], [3000, 3000, 1000], 'the agent owes the tour less the cash taken on tour');
});
