import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';

process.env.AUTH_JWT_SECRET = 'invoices-test-secret';
const { buildApp } = await import('../src/app.js');
const { OperationsStore } = await import('../src/domain/operations.js');
const { blankAgent, seedUser, testStore, tokenFor } = await import('./users-helper.js');
const { invoiceAmounts } = await import('../src/domain/invoices.js');

// Invoices and payments (todo/money-model.md slice 1), on whichever store DATABASE_URL selects. Other
// files write in parallel on PostgreSQL, so this one names its agents, users and days its own.
const store = testStore();
const agents = {
  inv_a1: { pay_type: 'invoice', vat_mode: 'include', credit_days: 15, credit_limit: 10000 },
  inv_a2: { pay_type: 'proforma', vat_mode: 'exclude', credit_days: null, credit_limit: null },
  inv_a3: { pay_type: 'invoice', vat_mode: 'none', credit_days: null, credit_limit: 3000 },
} as const;
if (store instanceof OperationsStore) {
  store.seedAgents({ agents: Object.entries(agents).map(([id, fields]) => ({ ...blankAgent(id, null), ...fields })) });
} else {
  const { Pool } = await import('pg');
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const [id, f] of Object.entries(agents)) {
    await db.query(`INSERT INTO agents (id, name, pay_type, vat_mode, credit_days, credit_limit) VALUES ($1, $1, $2, $3, $4, $5)
      ON CONFLICT (id) DO UPDATE SET pay_type = $2, vat_mode = $3, credit_days = $4, credit_limit = $5`, [id, f.pay_type, f.vat_mode, f.credit_days, f.credit_limit]);
  }
  await db.end();
}
const app = buildApp({ store });
after(async () => app.close());
await seedUser(store, { username: 'inv-admin', role: 'admin' });
await seedUser(store, { username: 'inv-acct', edit_areas: ['accounting'] });
await seedUser(store, { username: 'inv-ops', edit_areas: ['operations'] });
const admin = await tokenFor(app, 'inv-admin');
const acct = await tokenFor(app, 'inv-acct');
const ops = await tokenFor(app, 'inv-ops');
const send = (method: InjectOptions['method'], url: string, payload?: object, headers: Record<string, string> = admin) =>
  app.inject({ method, url, headers, ...(payload ? { payload } : {}) });

let n = 0;
const run = Date.now().toString(36);
/** A booking at the price sent: a B2C id keeps it (CLAUDE.md, "Temporary exceptions"). */
async function booking(agent: string, total: number, date = '2056-02-01'): Promise<{ id: string }> {
  await send('POST', '/operations/deployments', { boat_id: `inv-boat-${date}`, route_id: 'r1', service_date: date, capacity: 40 });
  const created = await send('POST', '/v1/bookings', { agent_id: agent, external_id: `b2c_inv_${run}_${++n}`, total, route_id: 'r1', service_date: date, pax: 1 });
  assert.equal(created.statusCode, 201, created.body);
  return created.json();
}
const issue = (agent: string, ids: string[], extra: object = {}, headers = acct) => send('POST', '/v1/invoices', { agent_id: agent, booking_ids: ids, ...extra }, headers);

test('VAT and discounts are worked out as legacy does', () => {
  assert.deepEqual(invoiceAmounts([{ amount: 5600, discount: null }], 'include', 0.07), { subtotal: 5600, net_amount: 5234, vat_amount: 366, total: 5600 });
  assert.deepEqual(invoiceAmounts([{ amount: 1000, discount: null }], 'exclude', 0.07), { subtotal: 1000, net_amount: 1000, vat_amount: 70, total: 1070 });
  assert.deepEqual(invoiceAmounts([{ amount: 1000, discount: 1500 }], 'none', 0.07), { subtotal: 0, net_amount: 0, vat_amount: 0, total: 0 }, 'never more than all of it');
});

test('an invoice is issued by the server: lines, VAT, number, due date; a booking is on one live invoice', async () => {
  const b = await booking('inv_a1', 5600);
  const res = await issue('inv_a1', [b.id], { ref: 'PO-1', total: 1 });
  assert.equal(res.statusCode, 201, res.body);
  const inv = res.json();
  assert.match(inv.number, /^INV-\d{4}-\d{4}$/);
  assert.deepEqual([inv.kind, inv.vat_mode, inv.subtotal, inv.net_amount, inv.vat_amount, inv.total, inv.status, inv.balance], ['booking', 'include', 5600, 5234, 366, 5600, 'issued', 5600]);
  assert.deepEqual(inv.lines.map((l: { booking_id: string; amount: number }) => [l.booking_id, l.amount]), [[b.id, 5600]]);
  assert.equal(inv.ref, 'PO-1');
  assert.equal(Date.parse(inv.due_at) - Date.parse(inv.issued_at), 15 * 86_400_000, 'the agent\'s credit days');

  const read = (await send('GET', `/v1/bookings/${b.id}`)).json();
  assert.deepEqual([read.invoice.number, read.invoice.status, read.payment_state], [inv.number, 'issued', 'invoiced']);
  const history = (await send('GET', `/v1/bookings/${b.id}/history`)).json().history;
  assert.ok(history.some((h: { text: string }) => h.text === `Invoice ${inv.number} issued · ฿5,600 (incl. VAT)`));

  const again = await issue('inv_a1', [b.id]);
  assert.deepEqual([again.statusCode, again.json().code], [409, 'booking_already_invoiced']);
  const other = await issue('inv_a2', [b.id]);
  assert.deepEqual([other.statusCode, other.json().code], [400, 'booking_not_agents']);
  const next = await issue('inv_a1', [(await booking('inv_a1', 100)).id]);
  const [m, k] = [inv.number.slice(0, 9), Number(inv.number.slice(9))];
  assert.equal(next.json().number.slice(0, 9), m);
  assert.ok(Number(next.json().number.slice(9)) > k, 'numbered after');
});

test('a proforma agent\'s invoice is due now; exclude adds VAT on top', async () => {
  const inv = (await issue('inv_a2', [(await booking('inv_a2', 1000)).id])).json();
  assert.deepEqual([inv.subtotal, inv.vat_amount, inv.total, inv.due_at], [1000, 70, 1070, inv.issued_at]);
});

test('payments, overpayment, discounts and corrections', async () => {
  const b = await booking('inv_a1', 5600);
  const inv = (await issue('inv_a1', [b.id])).json();
  const url = `/v1/invoices/${inv.id}`;

  const discounted = await send('PUT', `${url}/discounts`, { lines: [{ seq: 0, discount: 600 }] }, acct);
  assert.equal(discounted.statusCode, 200, discounted.body);
  assert.deepEqual([discounted.json().subtotal, discounted.json().net_amount, discounted.json().vat_amount, discounted.json().total], [5000, 4673, 327, 5000]);
  assert.equal((await send('PUT', `${url}/discounts`, { lines: [{ seq: 9, discount: 1 }] }, acct)).statusCode, 400);

  const first = await send('POST', `${url}/payments`, { amount: 3000, method: 'transfer', paid_on: '2056-01-20' }, acct);
  assert.equal(first.statusCode, 201, first.body);
  assert.deepEqual([first.json().status, first.json().paid, first.json().balance], ['partial', 3000, 2000]);
  assert.equal((await send('GET', `/v1/bookings/${b.id}`)).json().payment_state, 'partial');
  const late = await send('PUT', `${url}/discounts`, { lines: [{ seq: 0, discount: 0 }] }, acct);
  assert.deepEqual([late.statusCode, late.json().code], [409, 'invoice_has_payments']);

  const over = await send('POST', `${url}/payments`, { amount: 2500, method: 'cash' }, acct);
  assert.deepEqual([over.statusCode, over.json().code], [409, 'overpayment']);
  assert.equal((await send('POST', `${url}/payments`, { amount: 0, method: 'cash' }, acct)).statusCode, 400);
  assert.equal((await send('POST', `${url}/payments`, { amount: 10, method: 'cheque' }, acct)).statusCode, 400);
  const paid = (await send('POST', `${url}/payments`, { amount: 2000, method: 'cash' }, acct)).json();
  assert.deepEqual([paid.status, paid.balance], ['paid', 0]);
  assert.equal((await send('GET', `/v1/bookings/${b.id}`)).json().payment_state, 'paid');

  const [p1, p2] = paid.payments;
  const fixed = await send('POST', `${url}/payment-corrections`, { payments: [{ id: p2.id, amount: 1500 }, { id: p1.id, deleted: true }], reason: 'typo' }, acct);
  assert.equal(fixed.statusCode, 200, fixed.body);
  assert.deepEqual([fixed.json().status, fixed.json().paid], ['partial', 1500]);
  assert.ok(fixed.json().payments.find((p: { id: string }) => p.id === p1.id).deleted_at, 'a deleted payment stays on record');
  const history = (await send('GET', `/v1/bookings/${b.id}/history`)).json().history;
  assert.ok(history.some((h: { text: string }) => h.text === 'Payment correction · edited THB 2,000 -> THB 1,500 · deleted THB 3,000 (transfer, 2056-01-20) · reason: typo'), JSON.stringify(history));
  const gone = await send('POST', `${url}/payment-corrections`, { payments: [{ id: p1.id, amount: 5 }] }, acct);
  assert.deepEqual([gone.statusCode, gone.json().code], [409, 'payment_deleted']);
  const listed = (await send('GET', `/v1/payments?agent_id=inv_a1`)).json().payments.map((p: { id: string }) => p.id);
  assert.ok(listed.includes(p2.id) && !listed.includes(p1.id), 'deleted ones only with deleted=true');
});

test('PATCH changes the header and WHT only; void frees the booking and keeps its payments', async () => {
  const b = await booking('inv_a1', 2000);
  const inv = (await issue('inv_a1', [b.id])).json();
  const url = `/v1/invoices/${inv.id}`;
  const patched = await send('PATCH', url, { dear: 'Khun A', accept_at: '2056-01-05', wht_amount: 60, total: inv.total, number: inv.number }, acct);
  assert.equal(patched.statusCode, 200, patched.body);
  assert.deepEqual([patched.json().dear, patched.json().accept_at, patched.json().wht_amount, patched.json().payment_amount, patched.json().total], ['Khun A', '2056-01-05', 60, 1940, 2000]);
  const refused = await send('PATCH', url, { total: 1 }, acct);
  assert.equal(refused.statusCode, 400);
  assert.match(refused.json().message, /total cannot be changed/);

  await send('POST', `${url}/payments`, { amount: 1940, method: 'transfer' }, acct);
  assert.equal((await send('GET', url)).json().status, 'partial', 'WHT does not count towards paid (legacy)');
  const gone = await send('POST', `${url}/void`, { reason: 'wrong agent' }, acct);
  assert.deepEqual([gone.statusCode, gone.json().status, gone.json().balance, gone.json().payments.length], [200, 'void', 0, 1]);
  const read = (await send('GET', `/v1/bookings/${b.id}`)).json();
  assert.deepEqual([read.invoice, read.payment_state], [null, 'none']);
  const onVoid = await send('POST', `${url}/payments`, { amount: 10, method: 'cash' }, acct);
  assert.deepEqual([onVoid.statusCode, onVoid.json().code], [409, 'invoice_void']);
  assert.equal((await send('POST', `${url}/void`, {}, acct)).json().code, 'invoice_void');
  assert.equal((await issue('inv_a1', [b.id])).statusCode, 201, 'issued again');
});

test('cancel voids the invoice and bills its charge; restore voids the charge', async () => {
  const b = await booking('inv_a3', 4000);
  const inv = (await issue('inv_a3', [b.id])).json();
  const cancelled = await send('POST', `/v1/bookings/${b.id}/cancel`, { category: 'customer_cancel', charge_type: 'partial', charge_amount: 1200.4 });
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  assert.deepEqual([cancelled.json().invoice.kind, cancelled.json().invoice.fee_type, cancelled.json().invoice.total, cancelled.json().payment_state], ['fee', 'cancellation', 1200, 'invoiced']);
  assert.equal((await send('GET', `/v1/invoices/${inv.id}`)).json().status, 'void');
  const fee = (await send('GET', `/v1/invoices/${cancelled.json().invoice.id}`)).json();
  assert.deepEqual([fee.vat_amount, fee.lines[0].label], [0, 'Cancellation fee · Customer cancelled / changed plan (ลูกค้ายกเลิกเอง / เปลี่ยนแผน)'], 'as legacy labels it');

  const restored = await send('POST', `/v1/bookings/${b.id}/restore`);
  assert.equal(restored.statusCode, 200, restored.body);
  assert.deepEqual([restored.json().invoice, restored.json().payment_state], [null, 'none']);
});

test('the booking\'s invoice is the server\'s; a PATCH may only echo it', async () => {
  const b = await booking('inv_a1', 500);
  await issue('inv_a1', [b.id]);
  const refused = await send('PATCH', `/v1/bookings/${b.id}`, { payment_state: 'paid' });
  assert.equal(refused.statusCode, 400);
  assert.match(refused.json().message, /payment_state cannot be changed/);
  assert.equal((await send('PATCH', `/v1/bookings/${b.id}`, { paymentStatus: 'paid' })).statusCode, 400);
  assert.equal((await send('PATCH', `/v1/bookings/${b.id}`, { payment_state: 'invoiced', note: 'echo' })).statusCode, 200);
});

test('only accounting writes invoices; an agent\'s credit counts what it owes unpaid', async () => {
  const b = await booking('inv_a3', 2500);
  const denied = await issue('inv_a3', [b.id], {}, ops);
  assert.deepEqual([denied.statusCode, denied.json().code], [403, 'forbidden']);
  const credit = (await send('GET', '/v1/agents/inv_a3')).json().credit;
  assert.equal(credit.limit, 3000);
  assert.ok(credit.used >= 2500 && credit.over === credit.used > 3000);
  const inv = (await issue('inv_a3', [b.id])).json();
  await send('POST', `/v1/invoices/${inv.id}/payments`, { amount: 2500, method: 'cash' }, acct);
  assert.equal((await send('GET', '/v1/agents/inv_a3')).json().credit.used, credit.used - 2500, 'paid gives the credit back');
});

test('an invoice write is in the change feed, with its booking', async () => {
  const b = await booking('inv_a1', 700);
  const start = (await send('GET', '/v1/changes')).json().version;
  const inv = (await issue('inv_a1', [b.id])).json();
  await send('POST', `/v1/invoices/${inv.id}/payments`, { amount: 100, method: 'cash' }, acct);
  const changes = (await send('GET', `/v1/changes?since=${start}`)).json().changes as { kind: string; entity_id: string; action: string }[];
  assert.deepEqual(changes.filter((c) => c.entity_id === inv.id).map((c) => [c.kind, c.action]), [['invoice', 'created'], ['invoice', 'updated']]);
  assert.equal(changes.filter((c) => c.entity_id === b.id && c.kind === 'booking').length, 2);
});
