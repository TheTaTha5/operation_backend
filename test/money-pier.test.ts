import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';

process.env.AUTH_JWT_SECRET = 'money-pier-test-secret';
const { buildApp } = await import('../src/app.js');
const { OperationsStore } = await import('../src/domain/operations.js');
const { blankAgent, seedUser, testStore, tokenFor } = await import('./users-helper.js');
const { pierMoney } = await import('../src/domain/pier-money.js');

// Pier money (todo/money-model.md slice 3), on whichever store DATABASE_URL selects. Other files write
// in parallel on PostgreSQL, so this one names its agents, users and days its own.
const store = testStore();
if (store instanceof OperationsStore) store.seedAgents({ agents: [{ ...blankAgent('pm_a1', null), pay_type: 'invoice' }, { ...blankAgent('a_b2c', null), pay_type: 'cot' }] });
else {
  const { Pool } = await import('pg');
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  await db.query(`INSERT INTO agents (id, name, pay_type) VALUES ('pm_a1', 'pm_a1', 'invoice') ON CONFLICT (id) DO UPDATE SET pay_type = 'invoice'`);
  await db.query(`INSERT INTO agents (id, name, pay_type) VALUES ('a_b2c', 'a_b2c', 'cot') ON CONFLICT (id) DO NOTHING`);
  await db.end();
}
const app = buildApp({ store });
after(async () => app.close());
await seedUser(store, { username: 'pm-admin', role: 'admin' });
await seedUser(store, { username: 'pm-pier', edit_areas: ['pier'] });
await seedUser(store, { username: 'pm-ops', edit_areas: ['operations'] });
await seedUser(store, { username: 'pm-acct', edit_areas: ['accounting'] });
await seedUser(store, { username: 'pm-lk', agent_id: 'a_b2c' });
const admin = await tokenFor(app, 'pm-admin');
const pier = await tokenFor(app, 'pm-pier');
const ops = await tokenFor(app, 'pm-ops');
const acct = await tokenFor(app, 'pm-acct');
const lk = await tokenFor(app, 'pm-lk');
/** A booking write sends the version it read (If-Match is required of a login), unless told not to. */
const send = async (method: InjectOptions['method'], url: string, payload?: object, headers: Record<string, string> = admin, version = true) => {
  const booking = method !== 'GET' && version && /^\/v1\/bookings\/[^/?]+/.exec(url);
  const v = booking ? (await app.inject({ method: 'GET', url: booking[0], headers: admin })).json().version : undefined;
  return app.inject({ method, url, headers: { ...headers, ...(v ? { 'if-match': `"${v}"` } : {}) }, ...(payload ? { payload } : {}) });
};
const run = Date.now().toString(36);
let n = 0;
async function booking(date: string, extra: object = {}): Promise<{ id: string; version: number }> {
  await send('POST', '/operations/deployments', { boat_id: `pm-boat-${date}`, route_id: 'r1', service_date: date, capacity: 40 });
  const created = await send('POST', '/v1/bookings', { agent_id: 'pm_a1', external_id: `b2c_pm_${run}_${++n}`, total: 5600, route_id: 'r1', service_date: date, pax: 2, ...extra });
  assert.equal(created.statusCode, 201, created.body);
  return created.json();
}
const money = async (id: string, date: string) => (await send('GET', `/v1/bookings/${id}/pier-money?date=${date}`)).json();
const historyOf = async (id: string): Promise<string[]> => (await send('GET', `/v1/bookings/${id}/history`)).json().history.map((h: { text: string }) => h.text);

test('the amount owed at the pier: cash on tour, upgrades and on-tour sales to collect, less what the pier took', async () => {
  const date = '2058-01-10';
  const b = await booking(date, { cashOnTour: { amount: 3000, handling: 'deduct' }, upgrades: [{ id: 'up_1', label: 'Longtail', sell_price: 1100, to_company: 770, collected: false }] });
  const m = await money(b.id, date);
  assert.deepEqual([m.cot, m.upgrades_due, m.gross, m.paid, m.due, m.got, m.cot_handling, m.term], [3000, 1100, 4100, 0, 4100, 0, 'deduct', 'invoice']);
  assert.equal((await send('GET', `/v1/bookings/${b.id}/pier-money?date=2058-01-11`)).json().code, 'not_on_trip');

  // Split across methods (legacy §paySplit); a line of 0 is dropped; a card's fee is apart from the amount.
  const noVersion = await send('POST', `/v1/bookings/${b.id}/pier-payments`, { service_date: date, lines: [{ method: 'cash', amount: 10 }] }, pier, false);
  assert.deepEqual([noVersion.statusCode, noVersion.json().code], [428, 'version_required']);
  const paid = await send('POST', `/v1/bookings/${b.id}/pier-payments`, { service_date: date, lines: [{ method: 'cash', amount: 2000 }, { method: 'card', amount: 1000, fee_pct: 3 }, { method: 'cash', amount: 0 }] }, pier);
  assert.equal(paid.statusCode, 201, paid.body);
  const after = paid.json();
  assert.deepEqual([after.paid, after.fees, after.due, after.got, after.no_slip, after.payments.length], [3000, 30, 1100, 3000, 1, 2]);
  assert.deepEqual(after.payments.map((p: { method: string; fee: number; fee_pct: number | null }) => [p.method, p.fee, p.fee_pct]), [['cash', 0, null], ['card', 30, 3]]);
  assert.equal((await historyOf(b.id)).at(-1), 'เก็บเงินหน้าท่า ฿3,000 · แบ่งจ่าย 2 วิธี (เงินสด ฿2,000 · บัตรเครดิต ฿1,000 +ธรรมเนียม ฿30)');
  assert.ok(after.version > b.version, 'the booking moves on');

  // Refusals.
  const over = await send('POST', `/v1/bookings/${b.id}/pier-payments`, { service_date: date, lines: [{ method: 'cash', amount: 2000 }] }, pier);
  assert.deepEqual([over.statusCode, over.json().code], [409, 'overpayment']);
  for (const [body, status, code] of [
    [{ service_date: date, lines: [{ method: 'cash', amount: 100, fee: 5 }] }, 400, undefined],
    [{ service_date: date, lines: [{ method: 'cash', amount: 0 }] }, 400, undefined],
    [{ service_date: date, lines: [{ method: 'cheque', amount: 10 }] }, 400, undefined],
    [{ service_date: '2058-01-12', lines: [{ method: 'cash', amount: 10 }] }, 409, 'not_on_trip'],
  ] as const) {
    const r = await send('POST', `/v1/bookings/${b.id}/pier-payments`, body, pier);
    assert.deepEqual([r.statusCode, r.json().code], [status, code], JSON.stringify(body));
  }
  assert.equal((await send('POST', `/v1/bookings/${b.id}/pier-payments`, { service_date: date, lines: [{ method: 'cash', amount: 10 }] }, acct)).statusCode, 201, 'accounting saves bookings too');
  assert.equal((await send('POST', `/v1/bookings/${b.id}/pier-payments`, { service_date: date, lines: [{ method: 'cash', amount: 10 }] }, lk)).statusCode, 403, 'not an agent\'s login');
  const anyway = await send('POST', `/v1/bookings/${b.id}/pier-payments`, { service_date: date, lines: [{ method: 'transfer', amount: 2000 }], overpay_anyway: true }, pier);
  assert.deepEqual([anyway.statusCode, anyway.json().due, anyway.json().no_slip], [201, 0, 2]);

  // A slip after the fact (legacy pckPayAddSlip); a deletion stays on record (decided, as invoice payments).
  const slip = (await send('POST', '/v1/attachments', { filename: 's.jpg', mime: 'image/jpeg', data_b64: Buffer.from('slip').toString('base64') }, pier)).json();
  const card = after.payments.find((p: { method: string }) => p.method === 'card');
  const slipped = await send('POST', `/v1/bookings/${b.id}/pier-payments/${card.id}/slips`, { slip_ids: [slip.id] }, pier);
  assert.equal(slipped.statusCode, 200, slipped.body);
  assert.equal(slipped.json().no_slip, 1);
  assert.equal((await send('DELETE', `/v1/attachments/${slip.id}`)).json().code, 'attachment_in_use');
  const removed = await send('DELETE', `/v1/bookings/${b.id}/pier-payments/${card.id}?reason=typo`, undefined, pier);
  assert.equal(removed.statusCode, 200, removed.body);
  assert.equal(removed.json().paid, 4010);
  assert.equal(removed.json().payments.find((p: { id: string }) => p.id === card.id).delete_reason, 'typo');
  assert.equal((await send('DELETE', `/v1/bookings/${b.id}/pier-payments/${card.id}`, undefined, pier)).json().code, 'payment_deleted');
});

test('the amount owed is the server\'s, as legacy pckMoney: an overnight return owes nothing of the booking\'s', () => {
  const base = { id: 'x', version: 1, status: 'confirmed', cash_on_tour_amount: 500, payment_balance: 300, upgrades: [], total: 0 };
  const out = { route_id: 'r1', service_date: '2058-02-01', ovn_leg: false, pax_total: 2, id: 't1' };
  const back = { route_id: 'r1', service_date: '2058-02-02', ovn_leg: true, pax_total: 2, id: 't2' };
  const sale = { id: 's', booking_id: 'x', trip_date: '2058-02-02', service: 'Longtail', qty: 1, unit_price: 650, to_company: 0, seller: null, method: 'cot' as const,
    fee_pct: 0, fee: 0, collected_at: null, collected_by: null, sold_at: '2058-01-01T00:00:00Z', sold_by: null, slips: [] };
  const m1 = pierMoney({ ...base, trips: [out, back] }, '2058-02-01', [sale], [], 'invoice');
  assert.deepEqual([m1.cot, m1.b2c_balance, m1.tour_sales_due, m1.due, m1.overnight_return], [500, 300, 0, 800, false], 'a sale of another day is not this day\'s');
  const m2 = pierMoney({ ...base, trips: [out, back] }, '2058-02-02', [sale], [], 'invoice');
  assert.deepEqual([m2.cot, m2.b2c_balance, m2.tour_sales_due, m2.due, m2.overnight_return], [0, 0, 650, 650, true]);
});

test('on-tour sales: the server works out total, commission, fee and what the customer paid; cot ones are owed until collected', async () => {
  const date = '2058-01-11';
  const b = await booking(date);
  const sale = { service: 'Longtail Join', qty: 2, unit_price: 650, to_company: 910, seller: 'BEST', method: 'card', fee_pct: 3 };
  const created = await send('POST', `/v1/bookings/${b.id}/tour-sales`, sale, ops);
  assert.equal(created.statusCode, 201, created.body);
  const s = created.json();
  assert.deepEqual([s.total, s.commission, s.fee, s.customer_paid, s.settle, s.trip_date, s.sold_by], [1300, 390, 39, 1339, 'done', date, 'pm-ops']);
  assert.equal((await historyOf(b.id)).at(-1), 'Day-of extra · Longtail Join ×2 · ฿1,300 · คอม ฿390 (card · fee ฿39)');
  for (const bad of [{ ...sale, total: 1 }, { ...sale, commission: 5 }, { ...sale, fee_pct: 6 }, { ...sale, to_company: 1301 }, { ...sale, unit_price: 0 }, { ...sale, method: 'cash', fee_pct: 3 }, { ...sale, trip_date: '2058-01-12' }]) {
    const r = await send('POST', `/v1/bookings/${b.id}/tour-sales`, bad, ops);
    assert.ok([400, 409].includes(r.statusCode), `${JSON.stringify(bad)}: ${r.body}`);
  }
  assert.equal((await send('POST', `/v1/bookings/${b.id}/tour-sales`, sale, pier)).statusCode, 403, 'on-tour sales are operations\' (sbExtrasPersist)');

  const later = (await send('POST', `/v1/bookings/${b.id}/tour-sales`, { service: 'Snorkel gear', unit_price: 150, method: 'cot', seller: 'BEST' }, ops)).json();
  assert.deepEqual([later.settle, later.collected_at, later.fee], ['pending', null, 0]);
  assert.deepEqual([(await money(b.id, date)).tour_sales_due, (await money(b.id, date)).tour_sales_got], [150, 1300]);
  const collected = await send('POST', `/v1/bookings/${b.id}/tour-sales/${later.id}/collect`, {}, ops);
  assert.deepEqual([collected.statusCode, collected.json().settle, collected.json().method], [200, 'done', 'cash']);
  assert.equal((await historyOf(b.id)).at(-1), 'Collected on tour · Snorkel gear · ฿150 (cash)');
  assert.equal((await send('POST', `/v1/bookings/${b.id}/tour-sales/${later.id}/collect`, {}, ops)).json().code, 'already_collected');
  const edited = await send('PATCH', `/v1/bookings/${b.id}/tour-sales/${later.id}`, { method: 'cot' }, ops);
  assert.deepEqual([edited.json().settle, edited.json().collected_at], ['pending', null], 'back to cot is owed again, as legacy');
  assert.equal((await send('PATCH', `/v1/bookings/${b.id}/tour-sales/${later.id}`, { settle: 'done' }, ops)).statusCode, 400, 'settle is the server\'s');
  assert.equal((await send('DELETE', `/v1/bookings/${b.id}/tour-sales/${later.id}`, undefined, ops)).statusCode, 204);
  assert.equal((await send('GET', `/v1/bookings/${b.id}/tour-sales`)).json().tour_sales.length, 1);
});

test('the pier hands its cash over at day close; accounts accept it; a later payment shows as a change', async () => {
  const date = '2058-01-12';
  const b = await booking(date, { cashOnTour: { amount: 2000, handling: 'deduct' } });
  await send('POST', `/v1/bookings/${b.id}/pier-payments`, { service_date: date, lines: [{ method: 'cash', amount: 1500 }, { method: 'card', amount: 500, fee: 25 }] }, pier);
  await send('POST', `/v1/bookings/${b.id}/tour-sales`, { service: 'Photos', unit_price: 300, method: 'cash', seller: 'MAY' }, ops);
  // The day's pier: route r1's, or `other` where the catalogue has none (the in-process store).
  const at = (await send('GET', '/v1/routes/r1')).json().pier || 'other';
  const preview = (await send('GET', `/v1/pier-handovers/preview?date=${date}&pier=${at}`, undefined, pier)).json();
  assert.deepEqual([preview.expected.cash, preview.expected.card, preview.expected.card_fees, preview.expected.tour_sales, preview.handover], [1800, 500, 25, 300, null]);
  assert.equal((await send('GET', `/v1/pier-handovers/preview?date=${date}&pier=${at}`, undefined, lk)).statusCode, 403);

  const handed = await send('POST', '/v1/pier-handovers', { service_date: date, pier: at, cash_counted: 1750, note: 'short 50' }, pier);
  assert.equal(handed.statusCode, 201, handed.body);
  const h = handed.json();
  assert.deepEqual([h.status, h.cash_difference, h.changed, h.handed_by], ['handed', -50, false, 'pm-pier']);
  assert.equal((await send('POST', '/v1/pier-handovers', { service_date: date, pier: at, cash_counted: 1800 }, pier)).json().code, 'already_handed_over');
  assert.equal((await send('POST', `/v1/pier-handovers/${h.id}/accept`, {}, ops)).statusCode, 403, 'accepting is accounting\'s');
  const accepted = await send('POST', `/v1/pier-handovers/${h.id}/accept`, { note: 'ok' }, acct);
  assert.deepEqual([accepted.statusCode, accepted.json().status, accepted.json().accepted_by], [200, 'accepted', 'pm-acct']);
  assert.equal((await send('POST', `/v1/pier-handovers/${h.id}/void`, {}, pier)).json().code, 'already_accepted');
  await send('POST', `/v1/bookings/${b.id}/pier-payments`, { service_date: date, lines: [{ method: 'cash', amount: 100 }], overpay_anyway: true }, pier);
  const read = (await send('GET', `/v1/pier-handovers/${h.id}`, undefined, acct)).json();
  assert.deepEqual([read.changed, read.expected.cash, read.expected_now.cash], [true, 1800, 1900], 'nothing refused at the pier: the change shows');
  const feed = (await send('GET', '/v1/changes?since=0&limit=1000')).json().changes as { kind: string; entity_id: string }[];
  assert.ok(feed.some((c) => c.kind === 'pier_handover' && c.entity_id === h.id));
});

test('commissions are paid out to the seller: computed, each once, only once collected', async () => {
  const date = '2058-01-13';
  const b = await booking(date, { upgrades: [{ id: 'up_9', label: 'Charter', sell_price: 2000, to_company: 1300, seller: 'NOK', collected: true, method: 'cash' }] });
  const paidSale = (await send('POST', `/v1/bookings/${b.id}/tour-sales`, { service: 'Longtail', unit_price: 1000, to_company: 700, method: 'cash', seller: 'NOK' }, ops)).json();
  const owed = (await send('POST', `/v1/bookings/${b.id}/tour-sales`, { service: 'Lunch', unit_price: 250, to_company: 200, method: 'cot', seller: 'NOK' }, ops)).json();
  const list = (await send('GET', `/v1/commissions?from=${date}&to=${date}&seller=NOK`, undefined, acct)).json();
  assert.deepEqual(list.items.map((i: { kind: string; commission: number }) => [i.kind, i.commission]).sort(), [['tour_sale', 300], ['tour_sale', 50], ['upgrade', 700]].sort());
  assert.deepEqual(list.totals, [{ seller: 'NOK', commission: 1050, paid: 0, unpaid: 1050 }]);

  const items = [{ kind: 'tour_sale', booking_id: b.id, id: paidSale.id }, { kind: 'upgrade', booking_id: b.id, id: 'up_9' }];
  assert.equal((await send('POST', '/v1/commission-payouts', { seller: 'NOK', items, method: 'cash' }, ops)).statusCode, 403, 'payouts are accounting\'s');
  const payout = await send('POST', '/v1/commission-payouts', { seller: 'NOK', items, method: 'cash', amount: 1 }, acct);
  assert.equal(payout.statusCode, 201, payout.body);
  assert.deepEqual([payout.json().amount, payout.json().items.length], [1000, 2], 'the amount is the server\'s');
  assert.equal((await send('POST', '/v1/commission-payouts', { seller: 'NOK', items: [items[0]] }, acct)).json().code, 'already_paid');
  assert.equal((await send('POST', '/v1/commission-payouts', { seller: 'NOK', items: [{ kind: 'tour_sale', booking_id: b.id, id: owed.id }] }, acct)).json().code, 'not_collected');
  assert.equal((await send('POST', '/v1/commission-payouts', { seller: 'BEST', items: [{ kind: 'tour_sale', booking_id: b.id, id: owed.id }] }, acct)).statusCode, 400);
  assert.equal((await send('DELETE', `/v1/bookings/${b.id}/tour-sales/${paidSale.id}`, undefined, ops)).json().code, 'commission_paid');
  assert.deepEqual((await send('GET', `/v1/commissions?from=${date}&to=${date}&seller=NOK&paid=false`, undefined, acct)).json().items.map((i: { id: string }) => i.id), [owed.id]);
  const voided = await send('POST', `/v1/commission-payouts/${payout.json().id}/void`, { reason: 'wrong day' }, acct);
  assert.deepEqual([voided.statusCode, voided.json().void_reason], [200, 'wrong day']);
  assert.equal((await send('POST', '/v1/commission-payouts', { seller: 'NOK', items: [items[0]] }, acct)).statusCode, 201, 'a void payout frees its items');
});

test('the board reads every booking that day; an agent\'s login sees its own', async () => {
  const date = '2058-01-14';
  const b = await booking(date, { cashOnTour: { amount: 700 } });
  const rows = (await send('GET', `/v1/pier-money?date=${date}`)).json().rows as { booking_id: string; due: number }[];
  assert.deepEqual(rows.find((r) => r.booking_id === b.id)?.due, 700);
  assert.equal((await send('GET', `/v1/pier-money?date=${date}`, undefined, lk)).json().rows.length, 0);
});
