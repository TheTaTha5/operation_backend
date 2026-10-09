import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';

process.env.AUTH_JWT_SECRET = 'weather-test-secret';
const { buildApp } = await import('../src/app.js');
const { OperationsStore } = await import('../src/domain/operations.js');
const { blankAgent, seedUser, testStore, tokenFor } = await import('./users-helper.js');

// Weather closures, their follow-up, and the refund and credit a weather cancel makes
// (todo/weather-closures-model.md), on whichever store DATABASE_URL selects. Other files write in
// parallel on PostgreSQL, so this one names its agents, users, boats and days its own (2063).
const store = testStore();
const agents = { wx_a1: 'include', wx_a2: 'none' } as const;
if (store instanceof OperationsStore) {
  store.seedAgents({ agents: Object.entries(agents).map(([id, vat]) => ({ ...blankAgent(id, null), pay_type: 'invoice', vat_mode: vat })) });
} else {
  const { Pool } = await import('pg');
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const [id, vat] of Object.entries(agents)) {
    await db.query(`INSERT INTO agents (id, name, pay_type, vat_mode) VALUES ($1, $1, 'invoice', $2) ON CONFLICT (id) DO UPDATE SET vat_mode = $2`, [id, vat]);
  }
  await db.end();
}
const app = buildApp({ store });
after(async () => app.close());
await seedUser(store, { username: 'wx-admin', role: 'admin' });
await seedUser(store, { username: 'wx-ops', edit_areas: ['operations'] });
await seedUser(store, { username: 'wx-sales', edit_areas: ['sales'] });
const admin = await tokenFor(app, 'wx-admin');
const ops = await tokenFor(app, 'wx-ops');
const sales = await tokenFor(app, 'wx-sales');

/** A write to a booking sends the version it read (If-Match is required of a login). */
const send = async (method: InjectOptions['method'], url: string, payload?: object, headers: Record<string, string> = admin) => {
  const booking = method !== 'GET' && /^\/v1\/bookings\/[^/]+/.exec(url);
  const version = booking ? (await app.inject({ method: 'GET', url: booking[0], headers: admin })).json().version : undefined;
  return app.inject({ method, url, headers, ...(payload || version ? { payload: { ...payload, ...(version ? { version } : {}) } } : {}) });
};
const ok = <T = Record<string, unknown>>(res: { statusCode: number; body: string; json: () => unknown }, status = 200): T => {
  assert.equal(res.statusCode, status, res.body);
  return res.json() as T;
};

let n = 0;
const run = Date.now().toString(36);
/** A booking at the price sent (a B2C id keeps it), on a route and day with a boat. */
async function booking(date: string, total = 1000, extra: object = {}, route = 'r1'): Promise<{ id: string; trips: { id: string }[] }> {
  await send('POST', '/operations/deployments', { boat_id: `wx-boat-${route}-${date}`, route_id: route, service_date: date, capacity: 40 });
  return ok(await send('POST', '/v1/bookings', { agent_id: 'wx_a1', external_id: `b2c_wx_${run}_${++n}`, total, route_id: route, service_date: date, pax: 2, ...extra }), 201);
}
const close = (route: string, date: string, note?: string, headers = ops) => send('POST', '/v1/weather-closures', { route_id: route, service_date: date, ...(note ? { note } : {}) }, headers);
type FollowUp = { booking_id: string; status: string; outcome: string | null; new_date: string | null; on_trip: boolean; refundable?: number; pax: number };
type Closure = { id: string; note: string | null; counts: Record<string, number>; pax: Record<string, number>; bookings: FollowUp[]; reopened_at: string | null };
const read = async (id: string): Promise<Closure> => ok<Closure>(await send('GET', `/v1/weather-closures/${id}`));
const entry = (c: Closure, bookingId: string): FollowUp | undefined => c.bookings.find((b) => b.booking_id === bookingId);
const history = async (id: string): Promise<{ kind: string; tag: string; text: string }[]> => ok<{ history: { kind: string; tag: string; text: string }[] }>(await send('GET', `/v1/bookings/${id}/history`)).history;

test('closing a trip: the bookings on it are the follow-up list; sales onto it are not refused; one open closure per trip', async () => {
  const date = '2063-01-05';
  const a = await booking(date);
  const before = await booking(date);
  ok(await send('POST', `/v1/bookings/${before.id}/cancel`, { reason: 'changed plan' }));
  await send('POST', '/operations/deployments', { boat_id: 'wx-charter-boat', route_id: 'r1', service_date: date, capacity: 20 });
  const charter = ok<{ id: string }>(await send('POST', '/v1/bookings', { agent_id: 'wx_a1', external_id: `b2c_wx_${run}_ch`, total: 9000,
    trips: [{ route_id: 'r1', date, booking_mode: 'charter', charter_boat_id: 'wx-charter-boat', pax: { ad: 6 } }] }), 201);

  assert.equal((await close('r1', date, undefined, sales)).statusCode, 403, 'needs the operations area');
  assert.equal((await send('POST', '/v1/weather-closures', { route_id: 'r1', service_date: date, closed_by: 'someone' }, ops)).statusCode, 400, 'closed_by is the login\'s');
  assert.equal((await send('POST', '/v1/weather-closures', { route_id: 'r1', service_date: '2063-02-30' }, ops)).statusCode, 400);
  const created = ok<Closure & { closed_by: string; route_id: string; service_date: string }>(await close('r1', date, 'high waves 3m'), 201);
  assert.deepEqual([created.route_id, created.service_date, created.note, created.closed_by], ['r1', date, 'high waves 3m', 'wx-ops']);
  assert.deepEqual(created.bookings.map((b) => b.booking_id).sort(), [a.id, charter.id].sort(), 'charters too; a cancelled booking is not on it');
  assert.deepEqual(created.counts, { awaiting: 2, notified: 0, resolved: 0 });
  assert.deepEqual(created.pax, { pending: 8, cancelled: 0, rescheduled: 0, total: 8 });
  assert.ok((await history(a.id)).some((h) => h.kind === 'weather' && h.tag === 'Weather' && / · 2063-01-05 cancelled due to weather$/.test(h.text)));

  const again = await close('r1', date);
  assert.deepEqual([again.statusCode, again.json().code], [409, 'already_closed']);
  assert.match(again.json().message, new RegExp(created.id));

  const late = await booking(date);
  assert.equal(entry(await read(created.id), late.id)?.status, 'awaiting', 'a sale onto the closed trip appears on read');
  const listed = ok<{ weather_closures: Closure[] }>(await send('GET', '/v1/weather-closures?from=2063-01-01&to=2063-01-31&route_id=r1')).weather_closures;
  assert.deepEqual(listed.map((c) => [c.id, c.counts.awaiting]), [[created.id, 3]]);
  assert.equal((listed[0] as Partial<Closure>).bookings, undefined, 'the list carries counts, not the bookings');

  const past = ok<Closure>(await close('r2', '2020-01-02'), 201);
  assert.equal(past.bookings.length, 0, 'a past date may be closed (decision 11)');
});

test('the note is the only thing PATCH changes', async () => {
  const c = ok<Closure & { route_id: string }>(await close('r2', '2063-01-06', 'rain'), 201);
  const patched = ok<Closure & { updated_by: string }>(await send('PATCH', `/v1/weather-closures/${c.id}`, { note: 'port closed', route_id: 'r2' }, ops));
  assert.deepEqual([patched.note, patched.updated_by], ['port closed', 'wx-ops'], 'an unchanged route_id is accepted');
  assert.equal((await send('PATCH', `/v1/weather-closures/${c.id}`, { route_id: 'r1' }, ops)).statusCode, 400);
  assert.equal((await send('PATCH', `/v1/weather-closures/${c.id}`, { closed_by: 'x' }, ops)).statusCode, 400);
  assert.equal((await send('PATCH', '/v1/weather-closures/wx_nope', { note: 'x' }, ops)).statusCode, 404);
});

test('notify, then resolve by reschedule: the new day is capacity-checked and the row records where it went', async () => {
  const date = '2063-01-07', next = '2063-01-08';
  const b = await booking(date);
  const c = ok<Closure>(await close('r1', date), 201);
  const url = `/v1/weather-closures/${c.id}/bookings/${b.id}/notify`;
  const notified = entry(ok<Closure>(await send('POST', url, {}, ops)), b.id)!;
  assert.equal(notified.status, 'notified');
  assert.deepEqual([(await send('POST', url, {}, ops)).statusCode, (await send('POST', url, {}, ops)).json().code], [409, 'wrong_status']);
  const stranger = await send('POST', `/v1/weather-closures/${c.id}/bookings/no-such-booking/notify`, {}, ops);
  assert.deepEqual([stranger.statusCode, stranger.json().code], [404, 'not_on_closed_trip']);
  assert.ok((await history(b.id)).some((h) => h.tag === 'Notify' && h.text === 'Notified agent · awaiting customer decision (reschedule/cancel)'));

  // A full new day is refused, as for any reschedule (legacy's weather move checked nothing).
  await send('POST', '/operations/deployments', { boat_id: 'wx-small', route_id: 'r1', service_date: next, capacity: 1 });
  const full = await send('POST', `/v1/bookings/${b.id}/reschedule`, { from_date: date, to_date: next, reason: 'weather' }, ops);
  assert.equal(full.statusCode, 409, full.body);
  assert.equal(entry(await read(c.id), b.id)?.status, 'notified', 'a refused reschedule resolves nothing');

  await send('POST', '/operations/deployments', { boat_id: 'wx-big', route_id: 'r1', service_date: '2063-01-09', capacity: 40 });
  ok(await send('POST', `/v1/bookings/${b.id}/reschedule`, { from_date: date, to_date: '2063-01-09', reason: 'weather' }, ops));
  const after = await read(c.id);
  assert.deepEqual(entry(after, b.id), { ...entry(after, b.id), status: 'resolved', outcome: 'reschedule', new_date: '2063-01-09', on_trip: false });
  assert.deepEqual(after.pax, { pending: 0, cancelled: 0, rescheduled: 2, total: 2 });
});

test('a weather cancel takes the booking off its invoice; refund and credit are what it paid', async () => {
  const date = '2063-01-10';
  const cancelOnly = await booking(date, 1000);
  const refunded = await booking(date, 3000);
  const credited = await booking(date, 2000);
  const c = ok<Closure>(await close('r1', date), 201);
  const invoice = async (id: string, paid: number) => {
    const inv = ok<{ id: string }>(await send('POST', '/v1/invoices', { agent_id: 'wx_a1', booking_ids: [id] }), 201);
    if (paid) ok(await send('POST', `/v1/invoices/${inv.id}/payments`, { amount: paid, method: 'transfer' }), 201);
    return inv.id;
  };
  const refundInvoice = await invoice(refunded.id, 3000);
  const creditInvoice = await invoice(credited.id, 1500);
  assert.equal(entry(await read(c.id), credited.id)?.refundable, 1500, 'what a refund or credit would be now');

  assert.equal((await send('POST', `/v1/bookings/${refunded.id}/cancel-weather`, { outcome: 'refund', amount: 1 }, ops)).statusCode, 400, 'the amount is the server\'s');
  assert.equal((await send('POST', `/v1/bookings/${refunded.id}/cancel-weather`, { outcome: 'voucher' }, ops)).statusCode, 400);
  const nothing = await send('POST', `/v1/bookings/${cancelOnly.id}/cancel-weather`, { outcome: 'credit' }, ops);
  assert.deepEqual([nothing.statusCode, nothing.json().code], [409, 'nothing_paid'], 'nothing paid, nothing to keep as credit');

  const plain = ok<{ status: string; refunds: unknown[] }>(await send('POST', `/v1/bookings/${cancelOnly.id}/cancel-weather`, { note: 'storm' }, ops));
  assert.deepEqual([plain.status, plain.refunds], ['cancelled_weather', []]);
  assert.ok((await history(cancelOnly.id)).some((h) => h.tag === 'Cancel' && h.text === 'Cancelled for weather · No refund · storm'));

  const r = ok<{ refunds: { kind: string; amount: number; invoice_id: string }[]; invoice: unknown; payment_state: string }>(
    await send('POST', `/v1/bookings/${refunded.id}/cancel-weather`, { outcome: 'refund' }, ops));
  assert.deepEqual(r.refunds.map((x) => [x.kind, x.amount, x.invoice_id]), [['refund', 3000, refundInvoice]]);
  assert.deepEqual([r.invoice, r.payment_state], [null, 'none'], 'off its invoice, as legacy\'s void leaves it');
  const inv = ok<{ status: string; paid: number; refunded: number; void_reason: string }>(await send('GET', `/v1/invoices/${refundInvoice}`));
  assert.deepEqual([inv.status, inv.paid, inv.refunded, inv.void_reason], ['void', 3000, 3000, 'weather'], 'a one-booking invoice is voided; the payment stays');
  assert.ok((await history(refunded.id)).some((h) => h.tag === 'Refund' && h.text === 'Cancelled for weather · Refund ฿3,000'));

  const k = ok<{ refunds: { kind: string; amount: number; agent_id: string }[] }>(await send('POST', `/v1/bookings/${credited.id}/cancel-weather`, { outcome: 'credit' }, ops));
  assert.deepEqual(k.refunds.map((x) => [x.kind, x.amount, x.agent_id]), [['credit', 1500, 'wx_a1']]);
  assert.equal(ok<{ credited: number }>(await send('GET', `/v1/invoices/${creditInvoice}`)).credited, 1500);

  const after = await read(c.id);
  assert.deepEqual([cancelOnly, refunded, credited].map((b) => entry(after, b.id)?.outcome), ['cancel', 'refund', 'credit']);
  assert.deepEqual(after.counts, { awaiting: 0, notified: 0, resolved: 3 });
  const listed = ok<{ refunds: { booking_id: string; invoice_number: string }[] }>(await send('GET', `/v1/refunds?booking_id=${refunded.id}`)).refunds;
  assert.equal(listed.length, 1);
  assert.match(listed[0].invoice_number, /^INV-/);
  assert.equal((await send('GET', '/v1/refunds?kind=voucher')).statusCode, 400);
  const sent = await send('PATCH', `/v1/invoices/${creditInvoice}`, { credited: 0 });
  assert.equal(sent.statusCode, 400, 'credited is the server\'s');
  assert.match(sent.json().message, /cancel-weather/);

  // Restored, the booking is off its old invoice and can be billed again, as after legacy's void.
  ok(await send('POST', `/v1/bookings/${refunded.id}/restore`, {}, ops));
  ok(await send('POST', '/v1/invoices', { agent_id: 'wx_a1', booking_ids: [refunded.id] }), 201);
  assert.equal(entry(await read(c.id), refunded.id)?.outcome, 'refund', 'its follow-up keeps the outcome');
});

test('on a shared invoice only the cancelled booking\'s lines come off; only money the invoice no longer needs comes back', async () => {
  const date = '2063-01-11';
  const stays = await booking(date, 1000, { agent_id: 'wx_a2' });
  const goes = await booking(date, 1000, { agent_id: 'wx_a2' });
  const inv = ok<{ id: string }>(await send('POST', '/v1/invoices', { agent_id: 'wx_a2', booking_ids: [stays.id, goes.id] }), 201);
  ok(await send('POST', `/v1/invoices/${inv.id}/payments`, { amount: 1500, method: 'cash' }), 201);

  const done = ok<{ refunds: { amount: number }[] }>(await send('POST', `/v1/bookings/${goes.id}/cancel-weather`, { outcome: 'refund' }, ops));
  assert.deepEqual(done.refunds.map((x) => x.amount), [500], 'paid 1,500 against 2,000; the one still travelling needs 1,000');
  const after = ok<{ voided: boolean; total: number; status: string; balance: number; lines: { booking_id: string; removed_reason: string | null }[] }>(await send('GET', `/v1/invoices/${inv.id}`));
  assert.deepEqual([after.voided, after.total, after.status, after.balance], [false, 1000, 'paid', 0], 'never the whole invoice (legacy\'s bug 6)');
  assert.deepEqual(after.lines.map((l) => [l.booking_id, l.removed_reason]), [[stays.id, null], [goes.id, 'weather']]);
  const kept = ok<{ invoice: { id: string; status: string }; payment_state: string }>(await send('GET', `/v1/bookings/${stays.id}`));
  assert.deepEqual([kept.invoice.id, kept.invoice.status, kept.payment_state], [inv.id, 'paid', 'paid']);
  assert.equal(ok<{ invoice: unknown }>(await send('GET', `/v1/bookings/${goes.id}`)).invoice, null);
  // The refund no longer counts as paid: 1,000 more would be over the total.
  const over = await send('POST', `/v1/invoices/${inv.id}/payments`, { amount: 1, method: 'cash' });
  assert.deepEqual([over.statusCode, over.json().code], [409, 'overpayment']);
});

test('a credit is the agent\'s balance, spent as a payment with method credit', async () => {
  const date = '2063-01-12';
  const first = await booking(date, 2000, { agent_id: 'wx_a2' });
  const inv1 = ok<{ id: string }>(await send('POST', '/v1/invoices', { agent_id: 'wx_a2', booking_ids: [first.id] }), 201);
  ok(await send('POST', `/v1/invoices/${inv1.id}/payments`, { amount: 2000, method: 'transfer' }), 201);
  const before = ok<{ credit_balance: { available: number } }>(await send('GET', '/v1/agents/wx_a2')).credit_balance.available;
  ok(await send('POST', `/v1/bookings/${first.id}/cancel-weather`, { outcome: 'credit' }, ops));
  const balance = ok<{ credit_balance: { credited: number; used: number; available: number } }>(await send('GET', '/v1/agents/wx_a2')).credit_balance;
  assert.equal(balance.available, before + 2000);

  const later = await booking('2063-01-13', 3000, { agent_id: 'wx_a2' });
  const inv2 = ok<{ id: string }>(await send('POST', '/v1/invoices', { agent_id: 'wx_a2', booking_ids: [later.id] }), 201);
  const short = await send('POST', `/v1/invoices/${inv2.id}/payments`, { amount: balance.available + 1, method: 'credit' });
  assert.deepEqual([short.statusCode, short.json().code], [409, 'credit_short']);
  const paid = ok<{ paid: number; status: string; payments: { id: string; method: string }[] }>(await send('POST', `/v1/invoices/${inv2.id}/payments`, { amount: 2000, method: 'credit' }), 201);
  assert.deepEqual([paid.paid, paid.status], [2000, 'partial']);
  assert.equal(ok<{ credit_balance: { available: number } }>(await send('GET', '/v1/agents/wx_a2')).credit_balance.available, before);

  const pay = paid.payments.find((p) => p.method === 'credit')!;
  const edit = await send('POST', `/v1/invoices/${inv2.id}/payment-corrections`, { payments: [{ id: pay.id, amount: 100 }] });
  assert.deepEqual([edit.statusCode, edit.json().code], [409, 'credit_payment']);
  ok(await send('POST', `/v1/invoices/${inv2.id}/payment-corrections`, { payments: [{ id: pay.id, deleted: true }], reason: 'wrong invoice' }));
  assert.equal(ok<{ credit_balance: { available: number } }>(await send('GET', '/v1/agents/wx_a2')).credit_balance.available, before + 2000, 'a deleted credit payment gives it back');
});

test('undo asks first when bookings are resolved, keeps them, and puts the others back', async () => {
  const date = '2063-01-14';
  const open = await booking(date);
  const done = await booking(date);
  const c = ok<Closure>(await close('r1', date), 201);
  ok(await send('POST', `/v1/weather-closures/${c.id}/bookings/${open.id}/notify`, {}, ops));
  ok(await send('POST', `/v1/bookings/${done.id}/cancel-weather`, {}, ops));

  const asked = await send('POST', `/v1/weather-closures/${c.id}/undo`, {}, ops);
  assert.deepEqual([asked.statusCode, asked.json().code], [409, 'has_resolved']);
  assert.match(asked.json().message, new RegExp(`${done.id} · cancel`));
  const undone = ok<Closure>(await send('POST', `/v1/weather-closures/${c.id}/undo`, { undo_anyway: true }, ops));
  assert.ok(undone.reopened_at);
  assert.deepEqual(undone.bookings.map((b) => [b.booking_id, b.status]), [[done.id, 'resolved']], 'the resolved one stays; the notified one went back');
  assert.ok((await history(open.id)).some((h) => / · 2063-01-14 re-opened · weather cancellation undone$/.test(h.text)));
  assert.equal(ok<{ status: string }>(await send('GET', `/v1/bookings/${done.id}`)).status, 'cancelled_weather', 'undo does not touch a resolved booking');

  const reopened = await send('POST', `/v1/weather-closures/${c.id}/bookings/${open.id}/notify`, {}, ops);
  assert.deepEqual([reopened.statusCode, reopened.json().code], [409, 'closure_reopened']);
  assert.equal(ok<{ weather_closures: Closure[] }>(await send('GET', '/v1/weather-closures?from=2063-01-14&to=2063-01-14')).weather_closures.length, 0);
  assert.equal(ok<{ weather_closures: Closure[] }>(await send('GET', '/v1/weather-closures?from=2063-01-14&to=2063-01-14&include_reopened=true')).weather_closures.length, 1);
  const closedAgain = ok<Closure>(await close('r1', date), 201);
  assert.notEqual(closedAgain.id, c.id, 'the trip can be closed again');
  assert.equal(entry(closedAgain, open.id)?.status, 'awaiting', 'a fresh follow-up');
});

test('the change feed names the closure: its own writes, and a booking command that resolved it', async () => {
  const date = '2063-01-15';
  const b = await booking(date);
  const start = ok<{ version: number }>(await send('GET', '/v1/changes')).version;
  const c = ok<Closure>(await close('r1', date), 201);
  ok(await send('POST', `/v1/bookings/${b.id}/cancel-weather`, {}, ops));
  const changes = ok<{ changes: { kind: string; entity_id: string; action: string; route_days: unknown }[] }>(await send('GET', `/v1/changes?since=${start}`)).changes
    .filter((x) => x.entity_id === c.id || x.entity_id === b.id);
  assert.deepEqual(changes.map((x) => [x.kind, x.action]), [['weather_closure', 'created'], ['booking', 'updated'], ['weather_closure', 'updated']]);
  assert.deepEqual(changes[0].route_days, [{ route_id: 'r1', service_date: date }]);
});
