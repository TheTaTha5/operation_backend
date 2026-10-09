import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';

process.env.AUTH_JWT_SECRET = 'money-reports-test-secret';
const { buildApp } = await import('../src/app.js');
const { OperationsStore } = await import('../src/domain/operations.js');
const { blankAgent, seedUser, testStore, tokenFor } = await import('./users-helper.js');
const { accountingDashboard, lastMonths, noCollect, saleList, tripAmount } = await import('../src/domain/money-reports.js');

// The money reports (todo/money-model.md slice 6), on whichever store DATABASE_URL selects. Other files
// write invoices in parallel on PostgreSQL, so whole-database figures are checked by what this file
// adds; days are in 2062 and agents named mr_.
const store = testStore();
const agents = {
  mr_a1: { pay_type: 'invoice', vat_mode: 'none', credit_days: 15, credit_limit: 50_000_000 },
  mr_a2: { pay_type: 'cot', vat_mode: 'none', credit_days: null, credit_limit: null },
} as const;
if (store instanceof OperationsStore) {
  store.seedCatalogue({ routes: [{ id: 'r10', name: 'Phi Phi Bamboo by Speedboat', pier: 'panwa' }, { id: 'r12', name: 'Whale', pier: 'panwa' }] });
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
await seedUser(store, { username: 'mr-admin', role: 'admin' });
await seedUser(store, { username: 'mr-agent', agent_id: 'mr_a1' });
await seedUser(store, { username: 'mr-ops', edit_areas: ['operations'] });
await seedUser(store, { username: 'mr-sales', edit_areas: ['sales'] });
const admin = await tokenFor(app, 'mr-admin');
const agentLogin = await tokenFor(app, 'mr-agent');
const ops = await tokenFor(app, 'mr-ops');
const salesLogin = await tokenFor(app, 'mr-sales');
const send = async (method: InjectOptions['method'], url: string, payload?: object, headers: Record<string, string> = admin) => {
  const booking = method !== 'GET' && /^\/v1\/bookings\/[^/]+/.exec(url);
  const version = booking ? (await app.inject({ method: 'GET', url: booking[0], headers: admin })).json().version : undefined;
  return app.inject({ method, url, headers, ...(payload || version ? { payload: { ...payload, ...(version ? { version } : {}) } } : {}) });
};
const ok = async (method: InjectOptions['method'], url: string, payload?: object, headers?: Record<string, string>) => {
  const res = await send(method, url, payload, headers);
  assert.ok(res.statusCode < 300, `${method} ${url}: ${res.statusCode} ${res.body}`);
  return res.json();
};
const run = Date.now().toString(36);
let n = 0;
/** A booking at the price sent: a B2C id keeps it (CLAUDE.md, "Temporary exceptions"). */
async function book(date: string, total: number, extra: object = {}, pax: Record<string, number> = { ad: 2 }, route = 'r10') {
  await ok('POST', '/operations/deployments', { boat_id: `mr-boat-${date}-${route}`, route_id: route, service_date: date, capacity: 80 });
  return ok('POST', '/v1/bookings', { external_id: `b2c_mr_${run}_${++n}`, total, trips: [{ route_id: route, date, pax, zone: 'PK' }], ...extra }) as Promise<{ id: string; trips: { id: string }[] }>;
}

test('aging, collections and top debtors are worked out as legacy does', () => {
  const now = new Date('2062-03-15T05:00:00Z');
  assert.deepEqual(lastMonths(now, 3), ['2062-01', '2062-02', '2062-03']);
  assert.deepEqual(lastMonths(new Date('2062-02-28T18:00:00Z'), 1), ['2062-03'], 'Bangkok\'s month, not UTC\'s');
  const inv = (id: string, agent: string, balance: number, due: string, status = 'issued') => ({ id, agent_id: agent, balance, due_at: due, status }) as never;
  const pay = (amount: number, paid_on: string, method = 'transfer', deleted_at: string | null = null) => ({ amount, paid_on, method, deleted_at }) as never;
  const d = accountingDashboard({
    invoices: [inv('i1', 'a', 100, '2062-03-20T00:00:00Z'), inv('i2', 'a', 200, '2062-03-01T00:00:00Z'), inv('i3', 'b', 300, '2062-01-20T00:00:00Z'),
      inv('i4', 'b', 400, '2061-12-01T00:00:00Z'), inv('i5', 'c', 999, '2061-01-01T00:00:00Z', 'void'), inv('i6', 'c', 0, '2061-01-01T00:00:00Z', 'paid')],
    payments: [pay(50, '2062-03-02'), pay(70, '2062-03-03', 'credit'), pay(80, '2062-02-10'), pay(90, '2062-03-04', 'cash', '2062-03-05')],
    agents: [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }], credit_exposure: 10, deposits_held: 20, now,
  });
  assert.deepEqual(d.aging, { not_due: 100, days_1_30: 200, days_31_60: 300, days_60_plus: 400 });
  assert.deepEqual([d.outstanding, d.overdue_invoices, d.paid_this_month], [1000, 3, 50], 'credit spent and deleted payments are not money received');
  assert.deepEqual(d.collections.slice(-2), [{ month: '2062-02', amount: 80 }, { month: '2062-03', amount: 50 }]);
  assert.deepEqual(d.top_outstanding, [{ agent_id: 'b', name: 'Beta', balance: 700 }, { agent_id: 'a', name: 'Alpha', balance: 300 }]);
  assert.equal(tripAmount({ trips: [{}, {}] as never, total: 900 }, { ovn_leg: false, subtotal: 400 }), 400, 'a multi-trip booking: the trip\'s own price');
  assert.equal(tripAmount({ trips: [{}] as never, total: 900 }, { ovn_leg: false, subtotal: 400 }), 900);
  assert.equal(tripAmount({ trips: [{}, {}] as never, total: 900 }, { ovn_leg: true, subtotal: 400 }), 0, 'an overnight return leg was paid on the way out');
});

test('the accounting dashboard and the agent statement', async () => {
  const b1 = await book('2062-01-10', 9_000_000, { agent_id: 'mr_a1' });
  const b2 = await book('2062-01-10', 4000, { agent_id: 'mr_a1' });
  const inv = await ok('POST', '/v1/invoices', { agent_id: 'mr_a1', booking_ids: [b1.id] });
  await ok('POST', `/v1/invoices/${inv.id}/payments`, { amount: 1_000_000, method: 'transfer' });
  const inv2 = await ok('POST', '/v1/invoices', { agent_id: 'mr_a1', booking_ids: [b2.id] });
  await ok('POST', `/v1/invoices/${inv2.id}/void`, { reason: 'test' });

  const dash = await ok('GET', '/v1/reports/accounting');
  assert.deepEqual(dash.top_outstanding[0], { agent_id: 'mr_a1', name: 'mr_a1', balance: 8_000_000 }, 'the biggest debtor here');
  assert.ok(dash.outstanding >= 8_000_000 && dash.aging.not_due >= 8_000_000, 'due in 15 days: not due yet');
  assert.ok(dash.paid_this_month >= 1_000_000 && dash.collections.length === 6);
  assert.ok(dash.credit_exposure >= 8_000_000 + 4000, 'unpaid bookings of invoice agents, the voided one\'s too');
  assert.equal((await send('GET', '/v1/reports/accounting', undefined, agentLogin)).statusCode, 403, 'a staff report');

  const st = await ok('GET', '/v1/agents/mr_a1/statement');
  assert.deepEqual([st.invoiced, st.paid, st.outstanding, st.pay_type], [9_000_000, 1_000_000, 8_000_000, 'invoice']);
  assert.deepEqual(st.invoices.map((i: { number: string; status: string }) => [i.number, i.status]), [[inv.number, 'partial']], 'live invoices only');
  assert.deepEqual([st.credit.used, st.credit.limit, st.credit_balance.available, st.credits], [9_004_000, 50_000_000, 0, []], "legacy agCreditState: an unpaid booking counts whole, part-paid or not");
  assert.equal((await send('GET', '/v1/agents/mr_a1/statement', undefined, agentLogin)).statusCode, 200, 'an agent reads its own');
  assert.equal((await send('GET', '/v1/agents/mr_a2/statement', undefined, agentLogin)).statusCode, 404, 'not another\'s');
  assert.equal((await send('GET', '/v1/agents/nobody_mr/statement')).statusCode, 404);
});

test('Travel Summary: who travelled, upgrade money, cash on tour, what is left to collect', async () => {
  const date = '2062-01-05';
  const a = await book(date, 3000, { agent_id: 'mr_a2', cash_on_tour_amount: 1000 }, { ad: 3 });
  const b = await book(date, 2000, {}, { ad: 2, chd: 1 });
  const c = await book(date, 1000, {}, { ad: 1 });
  await ok('PATCH', `/v1/bookings/${b.id}`, { upgrades: [
    { label: 'Longtail charter', sell_price: 500, to_company: 300, collected: true, method: 'cash' },
    { label: 'Snorkel', sell_price: 400, collected: false, method: 'cash' },
    { label: 'Kayak', sell_price: 1000, to_company: 1000, collected: true, method: 'card', fee_pct: 3 },
  ] });
  // One of a's three did not come; c did not come at all, and owes nothing.
  await ok('PUT', `/operations/trip-ops/${a.trips[0].id}/checkins/pier/0`, { expected: 3, actual_pax: 2, checked_in_at: '2062-01-05T01:00:00Z', events: [{ type: 'no_show', pax: 1, ad: 1 }] });
  await ok('PUT', `/operations/trip-ops/${c.trips[0].id}/checkins/van/0`, { expected: 1, actual_pax: 0, checked_in_at: '2062-01-05T00:00:00Z', events: [{ type: 'cxl', pax: 1, ad: 1 }] });
  const ts = await ok('GET', `/v1/reports/travel-summary?date=${date}`);
  assert.deepEqual([ts.bookings, ts.booked, ts.travelled, ts.no_show, ts.cxl], [3, 7, 5, 1, 1]);
  assert.deepEqual(ts.money, { cash: 500, transfer: 0, card: 1000, received: 1500, fees: 30, pier: { cash: 0, transfer: 0, card: 0, total: 0, fees: 0, no_slip: 0 },
    sales: 1900, sales_due: 400, sales_count: 3, commission: 200, sales_fees: 30, sales_by: { cash: 500, transfer: 0, card: 1000 }, sales_no_slip: 1, no_slip: 1,
    cash_on_tour: 1000, to_collect: 1400, to_collect_bookings: 2, due: 1400, net: 1500 });
  assert.deepEqual(ts.cot, { total: 1000, deduct: 0, payout: 0, not_collected: 0, not_collected_bookings: 0, undecided_bookings: 1 });
  assert.deepEqual(ts.noshow, { cases: 2, pending: 2, decided: 0, postponed: 0, charged: 0 }, 'a no-show on a and a cancel on c wait for a decision');
  assert.deepEqual(ts.collect_rows.map((r: { booking_id: string; target: number; due: number }) => [r.booking_id, r.target, r.due]), [[a.id, 1000, 1000], [b.id, 400, 400]].sort((x, y) => (x[0] < y[0] ? -1 : 1)));
  assert.equal((await send('GET', '/v1/reports/travel-summary?date=2062-1-5')).statusCode, 400);
});

test('Travel Summary and the Daily Report read the pier money and the decisions after the trip', async () => {
  const date = '2062-01-06';
  const a = await book(date, 3000, { agent_id: 'mr_a2', cash_on_tour_amount: 1000 }, { ad: 3 });
  const b = await book(date, 2000, {}, { ad: 2 });
  const c = await book(date, 1000, {}, { ad: 1 });
  await ok('PATCH', `/v1/bookings/${b.id}`, { upgrades: [{ label: 'Snorkel', sell_price: 400, collected: false, method: 'cash' }] });
  // a paid part of its cash on tour at the pier, one transfer still without its slip.
  await ok('POST', `/v1/bookings/${a.id}/pier-payments`, { service_date: date, lines: [{ method: 'transfer', amount: 600 }, { method: 'cash', amount: 100 }] });
  const wrong = await ok('POST', `/v1/bookings/${a.id}/pier-payments`, { service_date: date, lines: [{ method: 'card', amount: 50, fee: 5 }] });
  await ok('DELETE', `/v1/bookings/${a.id}/pier-payments/${wrong.payments.find((p: { method: string }) => p.method === 'card').id}?reason=typo`);
  // b bought on tour: one paid by card (2%, no slip), one left to collect on the travel day.
  await ok('POST', `/v1/bookings/${b.id}/tour-sales`, { service: 'Kayak', qty: 2, unit_price: 250, to_company: 300, method: 'card', fee_pct: 2, seller: 'Nok' });
  await ok('POST', `/v1/bookings/${b.id}/tour-sales`, { service: 'Photos', qty: 1, unit_price: 300, method: 'cot' });
  // c did not come, but paid 200 at the pier: §paid, it counts.
  await ok('PUT', `/operations/trip-ops/${c.trips[0].id}/checkins/van/0`, { expected: 1, actual_pax: 0, checked_in_at: '2062-01-06T00:00:00Z', events: [{ type: 'no_show', pax: 1, ad: 1 }] });
  await ok('POST', `/v1/bookings/${c.id}/pier-payments`, { service_date: date, lines: [{ method: 'cash', amount: 200 }], overpay_anyway: true });
  await ok('PUT', `/v1/bookings/${a.id}/cot-decisions/${date}`, { mode: 'part', deduct: 400, payout: 600 });
  await ok('PUT', `/v1/bookings/${c.id}/noshow-charges/${date}`, { decision: 'full' });
  // A wrong value is refused, not counted: a full charge is the trip's price, the server's.
  assert.equal((await send('PUT', `/v1/bookings/${c.id}/noshow-charges/${date}`, { decision: 'full', amount: 1 })).statusCode, 400);

  let ts = await ok('GET', `/v1/reports/travel-summary?date=${date}`);
  assert.deepEqual(ts.money, { cash: 300, transfer: 600, card: 500, received: 1400, fees: 10, pier: { cash: 300, transfer: 600, card: 0, total: 900, fees: 0, no_slip: 1 },
    sales: 1200, sales_due: 700, sales_count: 3, commission: 200, sales_fees: 10, sales_by: { cash: 0, transfer: 0, card: 500 }, sales_no_slip: 1, no_slip: 2,
    cash_on_tour: 1000, to_collect: 1400, to_collect_bookings: 3, due: 700, net: 800 }, 'net is received less the cash-on-tour payout; a deleted payment counts nowhere');
  assert.deepEqual(ts.cot, { total: 1000, deduct: 400, payout: 600, not_collected: 0, not_collected_bookings: 0, undecided_bookings: 0 });
  assert.deepEqual(ts.noshow, { cases: 1, pending: 0, decided: 1, postponed: 0, charged: 1000 }, 'c is charged its trip\'s price');
  const row = (id: string) => ts.collect_rows.find((r: { booking_id: string }) => r.booking_id === id);
  assert.deepEqual([row(a.id).target, row(a.id).paid, row(a.id).due, row(a.id).no_slip], [1000, 700, 300, 1]);
  assert.deepEqual([row(c.id).target, row(c.id).paid, row(c.id).not_counted], [0, 200, null], 'paid before cancelling: a refund matter, still counted');

  // More than the cash on tour decided is not settled (legacy): it counts as undecided.
  await ok('PUT', `/v1/bookings/${a.id}/cot-decisions/${date}`, { mode: 'part', deduct: 900, payout: 600 });
  await ok('PUT', `/v1/bookings/${c.id}/noshow-charges/${date}`, { decision: 'postpone' });
  ts = await ok('GET', `/v1/reports/travel-summary?date=${date}`);
  assert.deepEqual([ts.cot.deduct, ts.cot.payout, ts.cot.undecided_bookings, ts.money.net], [0, 0, 1, 1400]);
  assert.deepEqual(ts.noshow, { cases: 1, pending: 0, decided: 1, postponed: 1, charged: 0 });
  await ok('PUT', `/v1/bookings/${a.id}/cot-decisions/${date}`, { mode: 'nocol', ref: 'did not pay' });
  ts = await ok('GET', `/v1/reports/travel-summary?date=${date}`);
  assert.deepEqual([ts.cot.not_collected, ts.cot.not_collected_bookings, ts.cot.undecided_bookings], [1000, 1, 0]);

  const dr = await ok('GET', `/v1/reports/daily?date=${date}`);
  assert.deepEqual([dr.due, dr.got, dr.no_slip, dr.extras, dr.upgrades.due], [1000, 900, 1, 800, 400], 'legacy pckMoney: the pier still owes 300 + 400 + 300');
  assert.deepEqual(dr.by_agent.map((x: { key: string; due: number }) => [x.key, x.due]).sort(), [['_walk-in', 700], ['mr_a2', 300]]);
  assert.equal((await send('GET', '/v1/reports/daily?date=2062-1-6')).statusCode, 400);

  const dash = await ok('GET', '/v1/reports/accounting');
  assert.ok(dash.extras_this_month >= 800, 'the two sales above were sold this month (whatever their trip day), the cot one too');
});

test('the report rules: tsSaleList by day, tsNoCollect\'s paid exception, extras by Bangkok month', () => {
  const sale = (trip_date: string | null, method: string, qty = 1, unit_price = 100, slips: string[] = []) =>
    ({ booking_id: 'b', trip_date, method, qty, unit_price, to_company: 0, fee: method === 'card' ? 3 : 0, slips }) as never;
  const S = saleList({ upgrades: [] }, '2062-05-01', [sale('2062-05-01', 'cash'), sale('2062-05-02', 'cash'), sale(null, 'transfer'), sale('2062-05-01', 'cot', 2), sale('2062-05-01', 'card', 1, 100, ['f1'])]);
  assert.deepEqual([S.got, S.due, S.n, S.by, S.fee, S.comm, S.no_slip], [300, 200, 4, { cash: 100, transfer: 100, card: 100 }, 3, 300, 1],
    'another day\'s sale is not this day\'s; one with no day counts; a cot sale is still due; a transfer with no slip waits for one');
  const nobody = { travelled: 0, cxl: 0, ns: 1, no_show: 1 };
  assert.deepEqual([noCollect(nobody, 0), noCollect(nobody, 50), noCollect({ ...nobody, travelled: 1 }, 0)], [true, false, false]);
  const d = accountingDashboard({ invoices: [], payments: [], agents: [], credit_exposure: 0, deposits_held: 0, now: new Date('2062-03-15T05:00:00Z'),
    sales: [{ sold_at: '2062-02-28T18:00:00Z', qty: 2, unit_price: 150 }, { sold_at: '2062-02-28T16:00:00Z', qty: 1, unit_price: 999 }, { sold_at: '2062-03-31T16:59:00Z', qty: 1, unit_price: 50 }] });
  assert.equal(d.extras_this_month, 350, 'Bangkok\'s month: 1 March 01:00 counts, 28 February 23:00 does not');
});

test('Daily Report money: revenue by route, market and channel; van cost from the van rates', async () => {
  const date = '2062-02-07';
  const partner = `MR van ${run}`;
  const v = await ok('POST', '/operations/vans', { name: 'MR-1', capacity: 12, ownership: 'partner', partner_name: partner });
  await ok('PUT', `/operations/van-days/${date}/${v.id}`, { route_ids: ['r10'] });
  const a = await book(date, 6000, { agent_id: 'mr_a1' }, { ad: 3 });
  const b = await book(date, 2000, {}, { ad: 1 });
  await book(date, 1500, {}, { ad: 1 }, 'r12');
  await ok('POST', '/operations/van-groups', { service_date: date, route_id: 'r10', zone: 'PK', members: [{ trip_id: a.trips[0].id }, { trip_id: b.trips[0].id }], van_id: v.id });

  let dr = await ok('GET', `/v1/reports/daily?date=${date}`);
  assert.deepEqual([dr.bookings, dr.pax.total, dr.paying_pax, dr.revenue, dr.revenue_per_pax], [3, 5, 5, 9500, 1900]);
  assert.deepEqual(dr.by_route.map((r: { route_id: string; pax: number; revenue: number }) => [r.route_id, r.pax, r.revenue]), [['r10', 4, 8000], ['r12', 1, 1500]]);
  assert.deepEqual(dr.by_market.map((m: { id: string; pax: number }) => [m.id, m.pax]), [['_none', 3], ['walkin', 2]]);
  assert.deepEqual(dr.by_channel, { invoice: 6000, proforma: 0, cot: 0, transfer: 0, other: 3500 });
  assert.deepEqual(dr.by_agent[0], { key: 'mr_a1', agent_id: 'mr_a1', name: 'mr_a1', market_id: '_none', pay_type: 'invoice', bookings: 1, ad: 3, chd: 0, inf: 0, foc: 0, pax: 3, revenue: 6000, due: 0, docs: { nofiles: 1 } });
  assert.deepEqual([dr.van_cost.total, dr.van_cost.estimated, dr.van_cost.vans, dr.van_cost.default_rate_vans], [1800, false, 1, 1], 'no rate set: the partner default');

  await ok('PUT', '/v1/van-rates', { group: `p:${partner}`, route_id: 'r10', field: 'PK', rate: 1650 });
  dr = await ok('GET', `/v1/reports/daily?date=${date}`);
  assert.deepEqual([dr.van_cost.total, dr.van_cost.default_rate_vans, dr.van_cost.by_van[v.id]], [1650, 0, 1650]);

  assert.equal((await send('PUT', '/v1/reports/daily/settings', { van_cost: 1700 }, salesLogin)).statusCode, 403);
  let s = await ok('PUT', '/v1/reports/daily/settings', { van_cost: 1700, van_quota: 0 }, ops);
  assert.deepEqual([s.van_cost, s.van_quota, s.target_per_pax, s.set.van_cost, s.set.van_quota, s.updated_by], [1700, 6, 130, 1700, null, 'mr-ops'], '0 goes back to the default');
  assert.equal((await send('PUT', '/v1/reports/daily/settings', { van_cost: -1 })).statusCode, 400);
  assert.equal((await send('PUT', '/v1/reports/daily/settings', { vanCost: 1 })).statusCode, 400);
  s = await ok('GET', '/v1/reports/daily/settings');
  assert.equal(s.van_cost, 1700);
  const empty = await ok('GET', '/v1/reports/daily?date=2062-02-08');
  assert.deepEqual([empty.bookings, empty.revenue, empty.van_cost.total, empty.van_cost.estimated], [0, 0, 0, true]);
});
