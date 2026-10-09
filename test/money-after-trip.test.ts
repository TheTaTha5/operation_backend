import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';

process.env.AUTH_JWT_SECRET = 'money-after-trip-test-secret';
const { buildApp } = await import('../src/app.js');
const { OperationsStore } = await import('../src/domain/operations.js');
const { blankAgent, seedUser, testStore, tokenFor } = await import('./users-helper.js');
const { tripAmount } = await import('../src/domain/after-trip.js');

// After the trip (todo/money-model.md slice 4), on whichever store DATABASE_URL selects.
const store = testStore();
if (store instanceof OperationsStore) store.seedAgents({ agents: [{ ...blankAgent('at_a1', null), pay_type: 'invoice', vat_mode: 'include', credit_days: 30 }] });
else {
  const { Pool } = await import('pg');
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  await db.query(`INSERT INTO agents (id, name, pay_type, vat_mode, credit_days) VALUES ('at_a1', 'at_a1', 'invoice', 'include', 30)
    ON CONFLICT (id) DO UPDATE SET pay_type = 'invoice', vat_mode = 'include', credit_days = 30`);
  await db.end();
}
const app = buildApp({ store });
after(async () => app.close());
await seedUser(store, { username: 'at-admin', role: 'admin' });
await seedUser(store, { username: 'at-ops', edit_areas: ['operations'] });
await seedUser(store, { username: 'at-acct', edit_areas: ['accounting'] });
const admin = await tokenFor(app, 'at-admin');
const ops = await tokenFor(app, 'at-ops');
const acct = await tokenFor(app, 'at-acct');
const send = async (method: InjectOptions['method'], url: string, payload?: object, headers: Record<string, string> = ops, version = true) => {
  const booking = method !== 'GET' && version && /^\/v1\/bookings\/[^/?]+/.exec(url);
  const v = booking ? (await app.inject({ method: 'GET', url: booking[0], headers: admin })).json().version : undefined;
  return app.inject({ method, url, headers: { ...headers, ...(v ? { 'if-match': `"${v}"` } : {}) }, ...(payload ? { payload } : {}) });
};
const run = Date.now().toString(36);
let n = 0;
async function booking(date: string, extra: object = {}): Promise<{ id: string }> {
  await send('POST', '/operations/deployments', { boat_id: `at-boat-${date}`, route_id: 'r1', service_date: date, capacity: 40 }, admin);
  const created = await send('POST', '/v1/bookings', { agent_id: 'at_a1', external_id: `b2c_at_${run}_${++n}`, total: 5600, route_id: 'r1', service_date: date, pax: 2, ...extra }, admin);
  assert.equal(created.statusCode, 201, created.body);
  return created.json();
}
type Line = { amount: number; cot_date: string | null; removed_reason: string | null; label: string };

test('a cash-on-tour decision: the server works out deduct and payout; deduct + payout over the COT is a warning', async () => {
  const date = '2060-05-01';
  const b = await booking(date, { cashOnTour: { amount: 1500, handling: 'deduct' } });
  const full = await send('PUT', `/v1/bookings/${b.id}/cot-decisions/${date}`, { mode: 'full', deduct: 1, ref: 'x' }, ops);
  assert.equal(full.statusCode, 400, 'a computed deduct sent different is refused');
  const decided = await send('PUT', `/v1/bookings/${b.id}/cot-decisions/${date}`, { mode: 'full', ref: 'KBank 123' }, ops);
  assert.equal(decided.statusCode, 200, decided.body);
  assert.deepEqual([decided.json().decision.deduct, decided.json().decision.payout, decided.json().decision.kept, decided.json().invoice, decided.json().warnings], [1500, 0, 0, null, []]);
  const payout = (await send('PUT', `/v1/bookings/${b.id}/cot-decisions/${date}`, { mode: 'payout' }, ops)).json();
  assert.deepEqual([payout.decision.deduct, payout.decision.payout, payout.decision.ref], [0, 1500, 'KBank 123'], 'the ref stays');
  const part = (await send('PUT', `/v1/bookings/${b.id}/cot-decisions/${date}`, { mode: 'part', deduct: 1200, payout: 600 }, ops)).json();
  assert.deepEqual([part.decision.over, part.warnings.map((w: { code: string }) => w.code)], [true, ['cot_over']], 'saved, with legacy\'s warning');
  const nocol = (await send('PUT', `/v1/bookings/${b.id}/cot-decisions/${date}`, { mode: 'nocol', ref: 'No-show 2 pax' }, ops)).json();
  assert.deepEqual([nocol.decision.deduct, nocol.decision.payout, nocol.decision.kept], [0, 0, 1500]);

  for (const [url, body, status, code] of [
    [`/v1/bookings/${b.id}/cot-decisions/2060-05-02`, { mode: 'full' }, 409, 'not_on_trip'],
    [`/v1/bookings/${b.id}/cot-decisions/${date}`, { mode: 'half' }, 400, undefined],
    [`/v1/bookings/${(await booking(date)).id}/cot-decisions/${date}`, { mode: 'full' }, 409, 'no_cash_on_tour'],
  ] as const) {
    const r = await send('PUT', url, body, ops);
    assert.deepEqual([r.statusCode, r.json().code], [status, code], `${url} ${JSON.stringify(body)}`);
  }
  assert.equal((await send('PUT', `/v1/bookings/${b.id}/cot-decisions/${date}`, { mode: 'full' }, acct)).statusCode, 403, 'operations\' (legacy laGuardEdit)');
  assert.equal((await send('PUT', `/v1/bookings/${b.id}/cot-decisions/${date}`, { mode: 'full' }, ops, false)).statusCode, 428);
});

test('the invoice subtracts the deduction: at issue, and as a minus line on one already issued, with VAT worked out again', async () => {
  const date = '2060-05-03';
  const b = await booking(date, { cashOnTour: { amount: 1500, handling: 'deduct' } });
  await send('PUT', `/v1/bookings/${b.id}/cot-decisions/${date}`, { mode: 'full' }, ops);
  const issued = await send('POST', '/v1/invoices', { agent_id: 'at_a1', booking_ids: [b.id] }, acct);
  assert.equal(issued.statusCode, 201, issued.body);
  const inv = issued.json();
  assert.deepEqual(inv.lines.map((l: Line) => [l.amount, l.cot_date]), [[5600, null], [-1500, date]]);
  assert.deepEqual([inv.subtotal, inv.net_amount, inv.vat_amount, inv.total], [4100, 3832, 268, 4100]);
  assert.equal((await send('PUT', `/v1/invoices/${inv.id}/discounts`, { lines: [{ seq: 1, discount: 100 }] }, acct)).statusCode, 400, 'a deduction takes no discount');

  // A changed decision changes the line; the booking's history says so.
  const part = await send('PUT', `/v1/bookings/${b.id}/cot-decisions/${date}`, { mode: 'part', deduct: 1000, payout: 500 }, ops);
  assert.deepEqual([part.json().invoice.total, part.json().invoice.lines.map((l: Line) => l.amount)], [4600, [5600, -1000]]);
  const history = (await send('GET', `/v1/bookings/${b.id}/history`)).json().history.map((h: { text: string }) => h.text);
  assert.equal(history.at(-1), `Invoice ${inv.number} · cash on tour deducted ฿1,000 · total ฿4,600`);

  // Paid in full, then the whole COT deducted: the invoice is overpaid, and the answer warns.
  await send('POST', `/v1/invoices/${inv.id}/payments`, { amount: 4600 }, acct);
  const more = (await send('PUT', `/v1/bookings/${b.id}/cot-decisions/${date}`, { mode: 'full' }, ops)).json();
  assert.deepEqual([more.invoice.total, more.invoice.status, more.invoice.overpaid, more.warnings.map((w: { code: string }) => w.code)], [4100, 'paid', 500, ['invoice_overpaid']]);

  // Cleared: the line is taken off and the total is the booking's again.
  const cleared = await send('DELETE', `/v1/bookings/${b.id}/cot-decisions/${date}`, undefined, ops);
  assert.equal(cleared.statusCode, 200, cleared.body);
  assert.deepEqual([cleared.json().decision, cleared.json().invoice.total, cleared.json().invoice.lines[1].removed_reason], [null, 5600, 'cot']);
  assert.equal((await send('DELETE', `/v1/bookings/${b.id}/cot-decisions/${date}`, undefined, ops)).statusCode, 404);
  const back = (await send('PUT', `/v1/bookings/${b.id}/cot-decisions/${date}`, { mode: 'full' }, ops)).json();
  assert.deepEqual([back.invoice.total, back.invoice.lines.length], [4100, 2], 'the same line comes back');
  const feed = (await send('GET', '/v1/changes?since=0&limit=1000', undefined, admin)).json().changes as { kind: string; entity_id: string }[];
  assert.ok(feed.some((c) => c.kind === 'invoice' && c.entity_id === inv.id), 'the invoice is on the change feed');
});

test('a no-show charge: full is the trip\'s price, partial the client\'s, none and postpone nothing; it bills nothing', async () => {
  const date = '2060-05-04';
  const b = await booking(date);
  const full = await send('PUT', `/v1/bookings/${b.id}/noshow-charges/${date}`, { decision: 'full', note: 'no-show 2' }, ops);
  assert.deepEqual([full.statusCode, full.json().amount, full.json().by], [200, 5600, 'at-ops']);
  for (const [body, status] of [[{ decision: 'full', amount: 100 }, 400], [{ decision: 'partial' }, 400], [{ decision: 'none', amount: 5 }, 400], [{ decision: 'maybe' }, 400]] as const) {
    assert.equal((await send('PUT', `/v1/bookings/${b.id}/noshow-charges/${date}`, body, ops)).statusCode, status, JSON.stringify(body));
  }
  assert.equal((await send('PUT', `/v1/bookings/${b.id}/noshow-charges/${date}`, { decision: 'partial', amount: '1,200.4' }, ops)).json().amount, 1200, 'whole baht, as legacy');
  assert.equal((await send('PUT', `/v1/bookings/${b.id}/noshow-charges/${date}`, { decision: 'postpone' }, ops)).json().amount, 0);
  assert.equal((await send('GET', `/v1/invoices?booking_id=${b.id}`, undefined, acct)).json().invoices.length, 0, 'no invoice');
  const day = (await send('GET', `/v1/after-trip?date=${date}`)).json().rows.find((r: { booking_id: string }) => r.booking_id === b.id);
  assert.deepEqual([day.trip_amount, day.noshow.decision, day.cot.amount], [5600, 'postpone', 0]);
  assert.equal((await send('DELETE', `/v1/bookings/${b.id}/noshow-charges/${date}`, undefined, ops)).statusCode, 204);
  assert.equal((await send('DELETE', `/v1/bookings/${b.id}/noshow-charges/${date}`, undefined, ops)).statusCode, 404);
  assert.equal((await send('PUT', `/v1/bookings/${b.id}/noshow-charges/2060-05-09`, { decision: 'none' }, ops)).json().code, 'not_on_trip');
});

test('legacy tsTripAmount: an overnight return leg has no price; a multi-trip booking\'s trip its own subtotal', () => {
  const trip = (d: string, extra = {}) => ({ id: d, route_id: 'r1', service_date: d, ovn_leg: false, pax_total: 1, ...extra });
  assert.equal(tripAmount({ total: 900, trips: [trip('2060-01-01')] }, '2060-01-01'), 900);
  assert.equal(tripAmount({ total: 900, trips: [trip('2060-01-01', { subtotal: 400 }), trip('2060-01-02', { subtotal: 500 })] }, '2060-01-02'), 500);
  assert.equal(tripAmount({ total: 900, trips: [trip('2060-01-01'), trip('2060-01-02', { ovn_leg: true })] }, '2060-01-02'), 0);
});
