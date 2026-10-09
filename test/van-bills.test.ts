import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';

process.env.AUTH_JWT_SECRET = 'van-bills-test-secret';
const { buildApp } = await import('../src/app.js');
const { OperationsStore } = await import('../src/domain/operations.js');
const { seedUser, testStore, tokenFor } = await import('./users-helper.js');
const { billPeriod, codeOf, vanRate, priceRow, pullRates } = await import('../src/domain/van-bills.js');
const { lostByType, aboardCounts } = await import('../src/domain/aboard.js');

// Partner van bills (todo/money-model.md slice 5), on whichever store DATABASE_URL selects. Vans are
// shared across files on PostgreSQL, so every partner here is named for this run; days are in 2061.
const store = testStore();
if (store instanceof OperationsStore) {
  store.seedCatalogue({ routes: [{ id: 'r10', name: 'Phi Phi Bamboo by Speedboat', pier: 'panwa' }, { id: 'r12', name: 'Whale', pier: 'panwa' }] });
}
const app = buildApp({ store });
after(async () => app.close());
await seedUser(store, { username: 'vb-admin', role: 'admin' });
await seedUser(store, { username: 'vb-acct', edit_areas: ['accounting'] });
await seedUser(store, { username: 'vb-ops', edit_areas: ['operations'] });
const admin = await tokenFor(app, 'vb-admin');
const acct = await tokenFor(app, 'vb-acct');
const ops = await tokenFor(app, 'vb-ops');
const send = async (method: InjectOptions['method'], url: string, payload?: object, headers: Record<string, string> = admin) => {
  const booking = method !== 'GET' && /^\/v1\/bookings\/[^/]+/.exec(url);
  const version = booking ? (await app.inject({ method: 'GET', url: booking[0], headers: admin })).json().version : undefined;
  return app.inject({ method, url, headers, ...(payload || version ? { payload: { ...payload, ...(version ? { version } : {}) } } : {}) });
};
const ok = async (method: InjectOptions['method'], url: string, payload?: object, headers?: Record<string, string>) => {
  const res = await send(method, url, payload, headers);
  assert.ok(res.statusCode < 300, `${method} ${url}: ${res.statusCode} ${res.body}`);
  return res.statusCode === 204 ? undefined : res.json();
};
const run = Date.now().toString(36);

async function van(name: string, partner: string | null, date: string, routes = ['r10']) {
  const v = await ok('POST', '/operations/vans', { name, capacity: 12, ownership: partner ? 'partner' : 'own', ...(partner ? { partner_name: partner } : {}) });
  await ok('PUT', `/operations/van-days/${date}/${v.id}`, { route_ids: routes });
  return v as { id: string };
}
async function book(date: string, pax: Record<string, number>, extra: object = {}, route = 'r10') {
  await ok('POST', '/operations/deployments', { boat_id: `vb-boat-${date}-${route}`, route_id: route, service_date: date, capacity: 80 });
  return ok('POST', '/v1/bookings', { lead_pax: 'Guest', pickup_area: 'Patong', trips: [{ route_id: route, date, pax, zone: 'PK' }], ...extra }) as Promise<{ id: string; trips: { id: string }[] }>;
}
const group = async (date: string, tripIds: string[], vanId: string, route = 'r10') =>
  ok('POST', '/operations/van-groups', { service_date: date, route_id: route, zone: 'PK', members: tripIds.map((trip_id) => ({ trip_id })), van_id: vanId, allow_second_round: true }) as Promise<{ id: string }>;
const billUrl = (partner: string, month: string, period: number) => `/v1/van-bills/${encodeURIComponent(partner)}/${month}/${period}`;

test('periods, codes and van rates as legacy reads them', () => {
  assert.deepEqual(billPeriod('2061-02', 3), { from: '2061-02-21', to: '2061-02-28', label: '21–28' });
  assert.deepEqual(billPeriod('2061-03', 2), { from: '2061-03-11', to: '2061-03-20', label: '11–20' });
  assert.deepEqual(['r10', 'r11', 'r12', 'r3', 'r6', 'x'].map(codeOf), ['PP', 'PB', 'MT', 'SM', 'SR', '—']);
  const rates = [
    { group_key: 'p:A', route_id: 'r10', field: 'KL' as const, rate: 1600, updated_at: null, updated_by: null },
    { group_key: 'p:A', route_id: 'r10', field: 'base' as const, rate: 1500, updated_at: null, updated_by: null },
    { group_key: 'p:A', route_id: null, field: 'base' as const, rate: 1200, updated_at: null, updated_by: null },
  ];
  assert.deepEqual([vanRate(rates, 'p:A', 'r10', 'KL'), vanRate(rates, 'p:A', 'r10', 'PK'), vanRate(rates, 'p:A', 'r12', 'PK'), vanRate(rates, 'p:B', 'r10', 'PK'), vanRate(rates, 'own', 'r10', 'PK')],
    [1600, 1500, 1200, 1800, 900], 'zone, route base, group base, then the defaults');
});

test('passengers aboard: no-shows come off, a self-arrive no-show and a pier self-add do not', () => {
  const ev = (o: object) => ({ type: 'no_show', pax: 1, ad: null, chd: null, inf: null, foc: null, reason_code: null, note: null, at: null, by: null, ts: null, undone: null, tries: [], ...o });
  const rec = (slot: number, events: object[], extra: object = {}) => ({ slot, events, reinstate: null, self_add: null, ...extra }) as never;
  const lost = lostByType({ van: [rec(0, [ev({ chd: 1 }), ev({ reason_code: 'self_arrive' }), ev({ pax: 2 }), ev({ undone: { why: 'found' } })])], pier: [] });
  assert.deepEqual([lost.chd, lost.unalloc, lost.ns, lost.self_pier, lost.total], [1, 2, 3, 1, 3]);
  const trip = { pax: { ad: 4, chd: 1 }, operations: { checkins: { van: [rec(0, [ev({ chd: 1 }), ev({ pax: 2 })])], pier: [rec(0, [], { self_add: { pax: 1, ad: 1 } })] } } } as never;
  assert.deepEqual(aboardCounts(trip), { ad: 3, chd: 0, inf: 0, foc: 0 }, 'the unknown two come off adults; the pier gave one back');
  const row = { key: 'k', date: '2061-01-01', route_id: 'r10', code: 'PP', van_id: 'v', return_only: false, pax: 4 } as never;
  const bill = { per_pax: 200, rate: 1000, route_rates: { PP: 1500 }, row_overrides: { k: { rate: null, ex: 300, cut: 100, per: null } }, seen: null, updated_at: null } as never;
  const p = priceRow(row, bill);
  assert.deepEqual([p.rate, p.ex, p.cut, p.bill, p.sale, p.pl], [1500, 300, 100, 1700, 800, -900], 'bill = rate + ex − cut; sale = pax × per pax');
  const pulled = pullRates([{ ...(row as object), code: 'PP', route_id: 'r10' }] as never, [{ id: 'v', ownership: 'partner', partner_name: 'A', zone_base: 'PK' }] as never, [
    { group_key: 'p:A', route_id: null, field: 'base', rate: 1700, updated_at: null, updated_by: null }]);
  assert.deepEqual(pulled.got, [{ code: 'PP', rate: 1700, generic: true }], 'from the group base: marked to check');
});

test('a bill: rows from van parts and check-ins, out and back one run, staff inputs, totals', async () => {
  const partner = `VB ร่วม ${run}`, d1 = '2061-03-02', d2 = '2061-03-03';
  const A = await van('VB-A', partner, d1), B = await van('VB-B', partner, d1);
  await ok('PUT', `/operations/van-days/${d2}/${B.id}`, { route_ids: ['r10'] });
  const own = await van('VB-own', null, d2);
  const b1 = await book(d1, { ad: 3, chd: 1 });
  const b2 = await book(d1, { ad: 2 }, { pickup_area: 'Kata' });
  const b3 = await book(d1, { ad: 2 });
  const b4 = await book(d2, { ad: 2 });
  await group(d1, [b1.trips[0].id, b2.trips[0].id], A.id);
  const g3 = await group(d1, [b3.trips[0].id], B.id);
  await ok('PATCH', `/operations/van-groups/${g3.id}`, { return_van_id: A.id });
  const g4 = await group(d2, [b4.trips[0].id], own.id);
  await ok('PATCH', `/operations/van-groups/${g4.id}`, { return_van_id: B.id });
  // One adult of b1 did not come down; the van checked in 3 of 4.
  await ok('PUT', `/operations/trip-ops/${b1.trips[0].id}/checkins/van/0`, {
    expected: 4, actual_pax: 3, checked_in_at: '2061-03-01T23:40:00Z', events: [{ type: 'no_show', pax: 1, ad: 1, reason_code: 'not_down' }] });

  const url = billUrl(partner, '2061-03', 1);
  let bill = await ok('GET', url);
  assert.deepEqual(bill.rows.map((r: { key: string }) => r.key), [`${d1}~r10~${A.id}`, `${d1}~r10~${B.id}`, `${d2}~r10~${B.id}~R`]);
  const [ra, rb, rr] = bill.rows;
  assert.deepEqual([ra.ad, ra.chd, ra.pax, ra.booked_pax, ra.bookings, ra.return_pax, ra.return_bookings], [4, 1, 5, 6, 2, 2, 1], 'b3 comes back on A: one run');
  assert.deepEqual(ra.pickups.sort(), ['Kata', 'Patong']);
  assert.deepEqual([rb.pax, rr.pax, rr.return_pax, rr.return_only, rr.code], [2, 0, 2, true, 'PP'], 'a van that only brings people back sells nothing');
  assert.deepEqual([bill.state, bill.saved, bill.totals.bill], ['draft', false, 0]);

  bill = await ok('PATCH', url, { per_pax: 200, route_rates: { PP: 1500 }, row_overrides: { [rr.key]: { rate: 800 }, [ra.key]: { ex: 100, cut: 50 } },
    extra_lines: [{ date: d1, note: 'รถนอก', vans: 1, pax: 3, rate: 700, per_pax: 200 }], mark_seen: true }, acct);
  assert.deepEqual(bill.rows.map((r: { bill: number }) => r.bill), [1550, 1500, 800]);
  assert.deepEqual(bill.rows.map((r: { sale: number }) => r.sale), [1000, 400, 0]);
  assert.deepEqual([bill.extra_lines[0].bill, bill.extra_lines[0].sale], [700, 600]);
  assert.deepEqual([bill.totals.vans, bill.totals.outbound_vans, bill.totals.pax, bill.totals.bill, bill.totals.sale, bill.totals.pl, bill.totals.ex, bill.totals.cut],
    [4, 3, 10, 4550, 2000, -2550, 100, 50]);
  assert.equal(bill.missing_rate, 0);
  assert.deepEqual(bill.by_code[0].mix.map((m: { per_van: number; vans: number }) => [m.per_van, m.vans]), [[1550, 1], [1500, 1], [800, 1]]);
  assert.deepEqual([bill.saved, bill.new_rows, bill.seen.length, bill.updated_by], [true, [], 3, 'vb-acct']);

  // A booking added after the save is pointed out, not silently billed.
  const b5 = await book(d1, { ad: 1 });
  await ok('POST', `/operations/van-groups/${(await ok('GET', `/operations/van-groups?service_date=${d1}&route_id=r10`)).groups.find((g: { van_id: string }) => g.van_id === B.id).id}/members`, { members: [{ trip_id: b5.trips[0].id }] });
  bill = await ok('GET', url);
  assert.deepEqual(bill.new_rows, [], 'B already had a row; its count moved');
  assert.equal(bill.rows[1].pax, 3);
  const b6 = await book('2061-03-04', { ad: 1 });
  const C = await van('VB-C', partner, '2061-03-04');
  await group('2061-03-04', [b6.trips[0].id], C.id);
  assert.deepEqual((await ok('GET', url)).new_rows, [`2061-03-04~r10~${C.id}`]);
  assert.equal((await ok('GET', `${url}?van_id=${C.id}`)).rows.length, 1, 'one van\'s rows');
});

test('a bill refuses what the server works out, and wrong inputs', async () => {
  const partner = `VB bad ${run}`, d = '2061-04-02';
  const A = await van('VB-bad', partner, d);
  const b = await book(d, { ad: 2 });
  await group(d, [b.trips[0].id], A.id);
  const url = billUrl(partner, '2061-04', 1);
  const current = await ok('GET', url);
  const cases: [object, RegExp][] = [
    [{ totals: { ...current.totals, bill: 1 } }, /totals cannot be changed/],
    [{ rows: [] }, /rows cannot be changed/],
    [{ state: 'paid' }, /state cannot be changed here: use POST/],
    [{ seen: ['x'] }, /send mark_seen/],
    [{ per_pax: -1 }, /per_pax must be a number, 0 or more/],
    [{ route_rates: { XX: 1 } }, /XX is not a code/],
    [{ row_overrides: { '2061-04-03~r10~nope': { ex: 1 } } }, /no row/],
    [{ row_overrides: { [current.rows[0].key]: { tip: 1 } } }, /has no field tip/],
    [{ extra_lines: [{ vans: 1.5 }] }, /whole number/],
    [{ bill_total: 5 }, /has no field bill_total/],
  ];
  for (const [body, message] of cases) {
    const res = await send('PATCH', url, body);
    assert.equal(res.statusCode, 400, `${JSON.stringify(body)}: ${res.body}`);
    assert.match(res.json().message, message);
  }
  assert.equal((await send('PATCH', url, current)).statusCode, 200, 'the bill read back is accepted unchanged');
  assert.equal((await send('GET', billUrl(`nobody ${run}`, '2061-04', 1))).statusCode, 404);
  assert.equal((await send('GET', billUrl(partner, '2061-13', 1))).statusCode, 400);
  assert.equal((await send('GET', billUrl(partner, '2061-04', 4))).statusCode, 400);
  assert.equal((await send('PATCH', url, { per_pax: 1 }, ops)).statusCode, 403, 'van bills are accounting\'s');
});

test('sent and paid (new): draft → sent → paid; a paid bill is locked', async () => {
  const partner = `VB pay ${run}`, d = '2061-05-12';
  const A = await van('VB-pay', partner, d);
  const b = await book(d, { ad: 4 });
  await group(d, [b.trips[0].id], A.id);
  const url = billUrl(partner, '2061-05', 2);
  await ok('PATCH', url, { route_rates: { PP: 1500 } });
  const early = await send('POST', `${url}/pay`, { via: 'transfer' });
  assert.deepEqual([early.statusCode, early.json().code], [409, 'bill_not_sent']);
  let bill = await ok('POST', `${url}/send`, {}, acct);
  assert.deepEqual([bill.state, bill.sent.bill, bill.sent.by, bill.sent.changed_since_sent], ['sent', 1500, 'vb-acct', false]);
  bill = await ok('PATCH', url, { row_overrides: { [bill.rows[0].key]: { ex: 200 } } });
  assert.deepEqual([bill.totals.bill, bill.sent.changed_since_sent], [1700, true], 'changed since it was sent');
  assert.equal((await send('POST', `${url}/pay`, { via: 'bitcoin' })).statusCode, 400);
  bill = await ok('POST', `${url}/pay`, { via: 'transfer', ref: 'TX-9', paid_on: '2061-05-25' });
  assert.deepEqual([bill.state, bill.paid.amount, bill.paid.on, bill.paid.via, bill.paid.ref], ['paid', 1700, '2061-05-25', 'transfer', 'TX-9']);
  for (const [method, path, body] of [['PATCH', url, { per_pax: 1 }], ['POST', `${url}/unsend`, {}], ['POST', `${url}/send`, {}], ['POST', `${url}/pull-rates`, {}]] as const) {
    const res = await send(method, path, body);
    assert.deepEqual([res.statusCode, res.json().code], [409, 'bill_paid'], path);
  }
  bill = await ok('POST', `${url}/unpay`);
  assert.deepEqual([bill.state, bill.paid], ['sent', null]);
  assert.equal((await send('POST', `${url}/unpay`)).json().code, 'bill_not_paid');
  bill = await ok('POST', `${url}/unsend`);
  assert.equal(bill.state, 'draft');

  const overview = await ok('GET', '/v1/van-bills?month=2061-05&period=2');
  const line = overview.partners.find((p: { partner: string }) => p.partner === partner);
  assert.deepEqual([line.trips, line.pax, line.bill, line.state, line.van_ids], [1, 4, 1700, 'draft', [A.id]]);
  assert.equal((await send('GET', '/v1/van-bills?month=2061-05')).statusCode, 400);
});

test('van rates: one cell at a time; pull-rates fills a bill\'s route rates from them', async () => {
  const partner = `VB rate ${run}`, d = '2061-06-01';
  const A = await van('VB-rate', partner, d);
  const b = await book(d, { ad: 2 });
  await group(d, [b.trips[0].id], A.id);
  const g = `p:${partner}`;
  assert.equal((await send('PUT', '/v1/van-rates', { group: g, route_id: 'r10', field: 'PK', rate: 1650 }, ops)).statusCode, 403);
  let rates = await ok('PUT', '/v1/van-rates', { group: g, route_id: 'r10', field: 'PK', rate: 1650 }, acct);
  assert.ok(rates.rates.some((r: { group_key: string; rate: number }) => r.group_key === g && r.rate === 1650));
  assert.ok(rates.groups.some((x: { key: string; van_ids: string[] }) => x.key === g && x.van_ids.includes(A.id)));
  assert.equal((await send('PUT', '/v1/van-rates', { group: 'nobody', rate: 1 })).statusCode, 400);
  assert.equal((await send('PUT', '/v1/van-rates', { group: g, route_id: 'nowhere', rate: 1 })).statusCode, 400);
  const bill = await ok('POST', `${billUrl(partner, '2061-06', 1)}/pull-rates`);
  assert.deepEqual([bill.route_rates, bill.pulled.got, bill.totals.bill], [{ PP: 1650 }, [{ code: 'PP', rate: 1650, generic: false }], 1650]);
  rates = await ok('PUT', '/v1/van-rates', { group: g, route_id: 'r10', field: 'PK', rate: null });
  assert.ok(!rates.rates.some((r: { group_key: string }) => r.group_key === g), 'cleared');
});
