import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';

process.env.AUTH_JWT_SECRET = 'costing-test-secret';
const { buildApp } = await import('../src/app.js');
const { OperationsStore } = await import('../src/domain/operations.js');
const { seedUser, testStore, tokenFor } = await import('./users-helper.js');
const { DEFAULT_TEMPLATE, breakEven, calc, effectiveTemplate, parseTemplate, rentBook, blankPlan } = await import('../src/domain/costing.js');
const { longtailState } = await import('../src/domain/trip-pl.js');

// The cost model, trip actuals and Trip P&L (todo/money-model.md, "Design: the rest of Money"), on
// whichever store DATABASE_URL selects. Other files write in parallel on PostgreSQL, so this one keeps
// to its own boats and days (2064) and its own users (cp-). It owns the cost template and the plans.
const store = testStore();
if (store instanceof OperationsStore) store.seedCatalogue({ routes: [{ id: 'r10', name: 'Phi Phi Bamboo by Speedboat', pier: 'panwa', times: ['08:30'] }] });
const app = buildApp({ store });
after(async () => app.close());
await seedUser(store, { username: 'cp-admin', role: 'admin' });
await seedUser(store, { username: 'cp-acct', edit_areas: ['accounting'] });
await seedUser(store, { username: 'cp-ops', edit_areas: ['operations'] });
await seedUser(store, { username: 'cp-fleet', edit_areas: ['fleet'] });
const admin = await tokenFor(app, 'cp-admin');
const acct = await tokenFor(app, 'cp-acct');
const ops = await tokenFor(app, 'cp-ops');
const fleet = await tokenFor(app, 'cp-fleet');

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
const R = 7 / 107;
const near = (a: number, b: number, why?: string) => assert.ok(Math.abs(a - b) < 0.01, `${why ?? ''} ${a} ≠ ${b}`);

test('ctCalc: the default template prices a 30-head trip as legacy does', () => {
  const T = effectiveTemplate(null);
  const none = rentBook([], []);
  const c = calc({ overrides: {}, groups: {}, on_demand: {} } as never, { eng: '3EN', boats: 1, fuel: 40, boat_id: null, date: null, pax: 30, pax_th: 0, pax_ch: 0 }, T, none);
  const row = (id: string) => c.rows.find((r) => r.id === id)!;
  // park 30×500, fuel 360×40 + 0.4×40×30, guide ceil(30/25)=2 × 1500, crew 2×500 (40 or fewer), van 100% of heads × 130.
  assert.deepEqual(['park', 'fuel', 'guide', 'crew', 'van', 'ltj', 'ltc'].map((id) => row(id).amount), [15000, 14880, 3000, 1000, 3900, 0, 0]);
  near(c.gross, 56630);
  near(c.vat_in, (930 + 14880 + 400 + 450 + 300 + 450) * R, 'VAT back on ob, fuel, pier, con, gear, med');
  const big = calc({ overrides: {}, groups: {}, on_demand: {} } as never, { eng: '4EN', boats: 1, fuel: 40, boat_id: null, date: null, pax: 45, pax_th: 0, pax_ch: 0 }, T, none);
  assert.deepEqual([big.rows.find((r) => r.id === 'crew')!.amount, big.rows.find((r) => r.id === 'dep')!.amount], [2000, 5000], '3 crew + 1 over 40, 4-engine depreciation');
  // Thai and child prices fall back to the wider one: 1 Thai adult, 1 foreign child, 4 foreign adults.
  const park = calc({ overrides: { park: { parts: [{ unit: 400, unit_th: 40 }] } }, groups: { 'ค่าอาหารและเครื่องดื่ม': { off: true } }, on_demand: {} } as never,
    { eng: '3EN', boats: 1, fuel: 0, boat_id: null, date: null, pax: 6, pax_th: 1, pax_ch: 1 }, T, none);
  assert.equal(park.rows.find((r) => r.id === 'park')!.amount, 4 * 400 + 40 + 400);
  assert.ok(!park.rows.some((r) => r.id === 'meal'), 'a group turned off');
});

test('a rented boat inside its contract: the owner pays captain, crew and depreciation; the rent comes in', () => {
  const T = effectiveTemplate(null);
  const rents = rentBook([{ boat_id: 'rb', rented: true, mode: 'lump', amount: 28000, per_seat: 0, days: 30, days_off: 2, trips_per_day: 1, vat: false, note: null,
    from: '2064-01-01', to: '2064-12-31', fuel_pct: 80, owner_pays: ['dep', 'cap', 'crew'], updated_at: '', updated_by: null }], [{ id: 'rb', name: 'Rented', capacity: 40 }]);
  const pl = { overrides: {}, groups: {}, on_demand: {} } as never;
  const ctx = { eng: '3EN' as const, boats: 1, fuel: 40, boat_id: 'rb', pax: 30, pax_th: 0, pax_ch: 0 };
  const inside = calc(pl, { ...ctx, date: '2064-05-01' }, T, rents);
  assert.deepEqual(inside.rows.filter((r) => ['dep', 'cap', 'crew', 'rent'].includes(r.id)).map((r) => [r.id, r.amount]), [['rent', 1000]]);
  near(inside.rows.find((r) => r.id === 'fuel')!.amount, 14880 * 0.8, 'the boat burns 80%');
  const outside = calc(pl, { ...ctx, date: '2065-01-01' }, T, rents);
  assert.ok(outside.rows.some((r) => r.id === 'cap') && !outside.rows.some((r) => r.id === 'rent'), 'outside the contract it is our own boat');
  const plan = { ...blankPlan('p', 'x', 0, '', null), price: 1500, pax_th: 0 };
  assert.equal(breakEven(plan, 40, T, rentBook([], [])), null, 'at ฿1,500 the default costs never break even within 40 seats');
  const n = breakEven({ ...plan, price: 3000 }, 65, T, rentBook([], []));
  assert.ok(n !== null && n > 1 && n < 65);
});

test('the template: legacy default until saved; a saved one is replaced whole, shapes checked', async () => {
  const sent = parseTemplate({ vatRate: 7, lines: [{ id: 'x', g: 'G', l: 'L', vat: false, parts: [{ k: 'var', u: 10, uTH: '' }] }] });
  assert.deepEqual(sent.lines[0].parts, [{ kind: 'var', unit: 10 }], 'legacy short keys; an empty input is not set');
  refused(await send('PUT', '/v1/costing/template', { vat_rate: 7, lines: [{ id: 'a', label: 'a', parts: [{ kind: 'step', fuel: true }] }] }), 400);
  refused(await send('PUT', '/v1/costing/template', { vat_rate: 7, lines: [{ id: 'a', label: 'a', parts: [{ kind: 'var' }] }, { id: 'a', label: 'b', parts: [{ kind: 'var' }] }] }), 400);
  refused(await send('PUT', '/v1/costing/template', { vat_rate: 7, lines: [{ id: 'a', label: 'a', parts: [{ kind: 'flat' }] }] }), 400);
  refused(await send('PUT', '/v1/costing/template', { vat_rate: 7, lines: [{ id: 'a', label: 'a', parts: [{ kind: 'var' }] }] }, ops), 403);
  const t = ok(await send('PUT', '/v1/costing/template', { vat_rate: 7, lines: [
    { id: 'park', group: 'Park', label: 'Park', vat: false, parts: [{ kind: 'var', unit: 400, unit_th: 40 }] },
    { id: 'meal', group: 'Meal', label: 'Lunch', vat: false, parts: [{ kind: 'var', unit: 200 }] },
    { id: 'fuel', group: 'Fuel', label: 'Fuel', vat: true, parts: [{ kind: 'fix', per: 'boat', qty: 100, qty_4en: 150, fuel: true }] },
    { id: 'cap', group: 'Crew', label: 'Captain', vat: false, parts: [{ kind: 'fix', per: 'boat', qty: 1, unit: 900 }] },
    { id: 'van', group: 'Van', label: 'Van', vat: false, parts: [{ kind: 'var', unit: 130 }], on_demand: true, on_demand_qty: 100 },
    { id: 'ltj', group: 'Longtail', label: 'Join', vat: false, parts: [{ kind: 'var', unit: 150 }], on_demand: true, on_demand_qty: 0 },
    { id: 'ltc', group: 'Longtail', label: 'Charter', vat: false, parts: [{ kind: 'fix', qty: 0, unit: 1000 }], on_demand: true, on_demand_qty: 0 },
  ] }, acct));
  assert.equal(t.saved, true);
  assert.ok(t.dropped.includes('guide') && !t.lines.some((l: { id: string }) => l.id === 'guide'), 'a default line left out is dropped, not added back');
  assert.equal(DEFAULT_TEMPLATE.lines.length, 18);
});

test('plans, rents and restaurants: client facts in, computed fields refused', async () => {
  const boat = ok(await send('POST', '/v1/boats', { name: `Costing ${run}`, pier: 'panwa', cap: 40, engineCount: 3 }), 201);
  refused(await send('POST', '/v1/costing/plans', { name: 'x', break_even: 3 }, acct), 400);
  refused(await send('POST', '/v1/costing/plans', { name: 'x', route_key: 'nowhere' }, acct), 400);
  refused(await send('POST', '/v1/costing/plans', { name: 'x', boat_id: 'nowhere' }, acct), 400);
  refused(await send('POST', '/v1/costing/plans', { name: 'x' }, ops), 403);
  const p = ok(await send('POST', '/v1/costing/plans', { name: 'Phi Phi', famId: 'r10', eng: '3EN', pax: 20, price: 1500, comm: 10, fuel: 40, ovr: { cap: { p: [{ u: 1000 }] } } }, acct), 201);
  assert.deepEqual([p.route_key, p.commission_pct, p.overrides, p.seats], ['r10', 10, { cap: { parts: [{ unit: 1000 }] } }, 65]);
  assert.equal(p.calc.pax, 20);
  assert.equal(typeof p.break_even, 'number');
  refused(await send('PATCH', `/v1/costing/plans/${p.id}`, { calc: {} }, acct), 400);
  refused(await send('PATCH', `/v1/costing/plans/${p.id}`, { child_pct: 120 }, acct), 400);
  const pinned = ok(await send('PATCH', `/v1/costing/plans/${p.id}`, { boat_id: boat.id }, acct));
  assert.equal(pinned.seats, 40, 'the pinned boat\'s seats');
  assert.equal(ok(await send('GET', `/v1/costing/plans/${p.id}?pax=30`)).calc.pax, 30);
  const copy = ok(await send('POST', '/v1/costing/plans', { copy_of: p.id, route_key: null }, acct), 201);
  assert.equal(copy.name, 'Phi Phi (คัดลอก)');
  refused(await send('DELETE', `/v1/costing/plans/${copy.id}`, undefined, acct), 204);

  // §rentZero: a record made by setting the fuel % is not a rented boat.
  const r1 = ok(await send('PUT', `/v1/costing/boat-rents/${boat.id}`, { fuelMul: 90 }, acct));
  const mine = r1.rents.find((r: { boat_id: string }) => r.boat_id === boat.id);
  assert.deepEqual([mine.rented, mine.fuel_pct, mine.owner_pays], [false, 90, ['dep', 'cap', 'crew']]);
  refused(await send('PUT', `/v1/costing/boat-rents/${boat.id}`, { per_trip: 5 }, acct), 400);
  const r2 = ok(await send('PUT', `/v1/costing/boat-rents/${boat.id}`, { mode: 'seat', seat: 1000, off: 0 }, acct)).rents.find((r: { boat_id: string }) => r.boat_id === boat.id);
  assert.deepEqual([r2.total, r2.per_day, r2.per_trip], [40000, 1333.33, 1333.33], '1,000 a seat × 40 seats over 30 days');
  assert.equal((await send('DELETE', `/v1/costing/boat-rents/${boat.id}`, undefined, acct)).statusCode, 204);
  refused(await send('PUT', '/v1/costing/boat-rents/nowhere', { rented: true }, acct), 404);

  const v = ok(await send('POST', '/v1/meal-venues', { name: `ต้นไทร ${run}`, priceAd: 210, priceCh: 105 }, acct), 201);
  assert.deepEqual([v.price_adult, v.price_child, v.active], [210, 105, true]);
  refused(await send('POST', '/v1/meal-venues', { name: 'x' }, ops), 403);
  refused(await send('PUT', '/v1/routes/r10/meal-venue', { meal_venue_id: 'nowhere' }, acct), 400);
  refused(await send('PUT', '/v1/routes/r10/meal-venue', { meal_venue_id: v.id }, ops), 403);
  assert.equal(ok(await send('PUT', '/v1/routes/r10/meal-venue', { meal_venue_id: v.id }, acct)).meal_venue_id, v.id);
  assert.equal(ok(await send('GET', '/v1/meal-venues')).routes.r10, v.id);
  const sent = await send('PATCH', '/v1/routes/r10', { meal_venue_id: v.id });
  assert.equal(sent.statusCode, 400, 'the route form does not set it');
  assert.match(sent.json().message, /PUT \/v1\/routes\/\{id\}\/meal-venue/);
  const off = ok(await send('PATCH', `/v1/meal-venues/${v.id}`, { active: false, price_adult: 220 }, acct));
  assert.deepEqual([off.active, off.price_adult], [false, 220]);
  ok(await send('PATCH', `/v1/meal-venues/${v.id}`, { active: true, price_adult: 210 }, acct));
});

test('a longtail: the voucher, a bundle, what was sold on tour, an upgrade', () => {
  const b = (add_ons: object[], upgrades: object[] = []) => ({ id: 'b', add_ons, upgrades }) as never;
  assert.deepEqual(longtailState(b([{ type: 'longtail-charter', qty: 2 }]), 'r', 'd', [], false).boats, 2);
  assert.equal(longtailState(b([{ type: 'longtail-charter-1-5' }]), 'r', 'd', [], false).boats, 1, 'extra heads in a chartered boat is still one boat');
  const j = longtailState(b([{ type: 'longtail-join', join_adults: 2, join_children: 1 }]), 'r', 'd', [], false);
  assert.deepEqual([j.mode, j.join_booked, j.join_pax], ['join', true, 3]);
  assert.equal(longtailState(b([]), 'r', 'd', [], true).mode, 'join', 'the rate type bundles one');
  const sales = [{ booking_id: 'b', service: 'Longtail Join', qty: 3, trip_date: 'd' }, { booking_id: 'b', service: 'Private longtail', qty: 1, trip_date: 'other' }] as never;
  assert.deepEqual(longtailState(b([]), 'r', 'd', sales, false).join_extra, 3);
  const up = longtailState(b([{ type: 'longtail-join' }], [{ label: 'Longtail · Join → เหมา (Charter)', collected: false }]), 'r', 'd', [], false);
  assert.deepEqual([up.mode, up.boats, up.upgrades_due], ['charter', 1, 1], 'an upgrade turns the join into one boat');
});

test('Trip P&L: actuals replace the formula line by line; the meal order; close freezes; an empty boat did not sail', async () => {
  const date = '2064-03-10';
  const v0 = ok(await send('GET', '/v1/changes')).version;
  const boat = ok(await send('POST', '/v1/boats', { name: `Artemis ${run}`, pier: 'panwa', cap: 40, engineCount: 3 }), 201);
  const empty = ok(await send('POST', '/v1/boats', { name: `Empty ${run}`, pier: 'panwa', cap: 30, engineCount: 3 }), 201);
  ok(await send('POST', '/operations/deployments', { boat_id: boat.id, route_id: 'r10', service_date: date, capacity: 40 }), 201);
  ok(await send('POST', '/operations/deployments', { boat_id: empty.id, route_id: 'r10', service_date: date, capacity: 30 }), 201);
  const book = async (total: number, pax: object, add_ons: object[] = []) => {
    const b = ok(await send('POST', '/v1/bookings', { external_id: `b2c_cp_${run}_${++n}`, total, trips: [{ route_id: 'r10', date, pax, zone: 'PK' }], add_ons }), 201);
    const version = ok(await send('GET', `/v1/bookings/${b.id}`)).version;
    ok(await send('PATCH', `/operations/trip-ops/${b.trips[0].id}`, { boat_id: boat.id, version }));
    return b;
  };
  await book(6000, { ad_fr: 2, ad_th: 1, chd_fr: 1 }, [{ type: 'longtail-charter', label: 'Longtail charter', qty: 1 }]);
  const b2 = await book(3000, { ad: 2 }, [{ type: 'longtail-join', label: 'Longtail join' }]);
  ok(await send('PATCH', `/v1/fleet/daily-log/${date}/boats/${boat.id}`, { fuel_litres: 80 }, fleet));
  ok(await send('PUT', `/v1/fleet/daily-log/${date}/fuel-prices`, { panwa: 40 }, fleet));
  const venue = ok(await send('GET', '/v1/meal-venues')).routes.r10;
  assert.ok(venue, 'the route\'s restaurant, set above');

  let t = ok(await send('GET', `/v1/reports/trip-pl/${date}/${boat.id}`));
  const row = (id: string) => t.rows.find((r: { id: string }) => r.id === id);
  assert.deepEqual([t.pax.total, t.pax.th, t.pax.chd, t.pax.bookings, t.revenue_gross, t.status, t.plan?.name], [6, 1, 1, 2, 9000, 'part', 'Phi Phi']);
  assert.deepEqual([row('fuel').source, row('fuel').gross, row('fuel').why], ['actual', 3200, '80 ลิตร × ฿40']);
  near(row('fuel').use, 3200 * (1 - R), 'an actual with VAT is counted net');
  assert.deepEqual([row('meal').source, row('meal').use], ['pending', 1200], 'a venue is set but no order sent: formula, waiting');
  assert.deepEqual([row('cap').source, row('cap').use], ['plan', 1000], 'the route plan changed the captain');
  assert.deepEqual([row('park').source, row('park').use], ['formula', 4 * 400 + 40 + 400]);
  assert.deepEqual([row('van').use, row('ltc').use, row('ltc').source, row('ltj').use], [780, 1000, 'actual', 300], 'one boat chartered, two joined');

  // The pier sends the meal order: on-board heads at the venue's prices, frozen.
  refused(await send('POST', `/v1/trip-actuals/${date}/${boat.id}/meal-order`, {}, acct), 403);
  const pre = ok(await send('GET', `/v1/trip-actuals/${date}/${boat.id}`));
  assert.deepEqual([pre.meal_preview.adults, pre.meal_preview.children, pre.meal_preview.amount], [5, 1, 5 * 210 + 105]);
  const sentMeal = ok(await send('POST', `/v1/trip-actuals/${date}/${boat.id}/meal-order`, {}, ops));
  assert.deepEqual([sentMeal.meal.adults, sentMeal.meal.children, sentMeal.meal.amount, sentMeal.meal.by], [5, 1, 1155, 'cp-ops']);
  refused(await send('POST', `/v1/trip-actuals/${date}/${empty.id}/meal-order`, {}, ops), 409, 'nobody_aboard');
  ok(await send('PUT', `/v1/trip-actuals/${date}/${empty.id}/venue`, { venue: 'none' }, ops));
  refused(await send('POST', `/v1/trip-actuals/${date}/${empty.id}/meal-order`, {}, ops), 409, 'no_meal_venue');
  refused(await send('PUT', `/v1/trip-actuals/${date}/${empty.id}/venue`, { venue: 'nowhere' }, ops), 400);
  refused(await send('PUT', `/v1/trip-actuals/${date}/${boat.id}/meal-overnight/${b2.id}`, { include: 'in' }, ops), 400);
  const note = ok(await send('PUT', `/v1/trip-actuals/${date}/${boat.id}/meal-note`, { text: ' อัพเดท ' }, ops));
  assert.equal(note.meal_note.text, 'อัพเดท');

  t = ok(await send('GET', `/v1/reports/trip-pl/${date}/${boat.id}`));
  assert.deepEqual([row('meal').source, row('meal').gross], ['actual', 1155]);
  const cost = 4 * 400 + 40 + 400 + 1155 + 3200 * (1 - R) + 1000 + 780 + 300 + 1000;
  assert.deepEqual([t.revenue, t.cost, t.profit], [Math.round(9000 * (1 - R)), Math.round(cost), Math.round(9000 * (1 - R) - cost)]);
  assert.equal(t.break_even, 7, 'at its own ฿1,500 a head, as legacy\'s ctBreakEven walks it');

  // Close: the money stands still when the plan changes; reopen and it moves again.
  refused(await send('POST', `/v1/trip-actuals/${date}/${boat.id}/close`, {}, ops), 403);
  refused(await send('POST', `/v1/trip-actuals/${date}/${boat.id}/ran`, {}, acct), 409, 'trip_not_empty');
  const closed = ok(await send('POST', `/v1/trip-actuals/${date}/${boat.id}/close`, {}, acct));
  assert.deepEqual([closed.status, closed.closed.by, closed.cost], ['done', 'cp-acct', t.cost]);
  refused(await send('POST', `/v1/trip-actuals/${date}/${boat.id}/close`, {}, acct), 409, 'trip_closed');
  const plan = ok(await send('GET', '/v1/costing/plans')).plans.find((p: { name: string }) => p.name === 'Phi Phi');
  ok(await send('PATCH', `/v1/costing/plans/${plan.id}`, { overrides: { cap: { parts: [{ unit: 3000 }] } } }, acct));
  const frozen = ok(await send('GET', `/v1/reports/trip-pl/${date}/${boat.id}`));
  assert.deepEqual([frozen.cost, frozen.rows.find((r: { id: string }) => r.id === 'cap').use], [t.cost, 1000], 'frozen');
  const open = ok(await send('POST', `/v1/trip-actuals/${date}/${boat.id}/reopen`, {}, acct));
  assert.equal(open.cost, t.cost + 2000);
  refused(await send('POST', `/v1/trip-actuals/${date}/${boat.id}/reopen`, {}, acct), 409, 'trip_not_closed');
  ok(await send('PATCH', `/v1/costing/plans/${plan.id}`, { overrides: { cap: { parts: [{ unit: 1000 }] } } }, acct));

  // An empty boat did not sail: nothing is costed, unless accounting says it ran.
  let e = ok(await send('GET', `/v1/reports/trip-pl/${date}/${empty.id}`));
  assert.deepEqual([e.status, e.cost, e.no_sail], ['nosail', 0, true]);
  assert.ok(e.would_cost > 0);
  refused(await send('POST', `/v1/trip-actuals/${date}/${empty.id}/close`, {}, acct), 409, 'trip_not_sailed');
  e = ok(await send('POST', `/v1/trip-actuals/${date}/${empty.id}/ran`, {}, acct));
  assert.deepEqual([e.status, e.cost, e.ran], ['est', e.would_cost, true]);
  e = ok(await send('POST', `/v1/trip-actuals/${date}/${empty.id}/not-ran`, {}, acct));
  assert.equal(e.status, 'nosail');
  refused(await send('POST', `/v1/trip-actuals/2064-03-11/${empty.id}/ran`, {}, acct), 404);

  const day = ok(await send('GET', `/v1/reports/trip-pl?date=${date}&pier=panwa`));
  const mineIds = new Set([boat.id, empty.id]);
  assert.deepEqual(day.trips.filter((x: { boat_id: string }) => mineIds.has(x.boat_id)).length, 2);
  assert.ok(day.totals.trips >= 2 && day.by_group.length > 0);
  const month = ok(await send('GET', '/v1/reports/trip-pl/month?month=2026-01'));
  assert.equal(month.days.length, 31);
  refused(await send('GET', '/v1/reports/trip-pl/month?month=2026-13'), 400);

  // The Daily Report: the longtail cost at the route plan's prices, and what is left before boat costs.
  const daily = ok(await send('GET', `/v1/reports/daily?date=${date}`));
  assert.deepEqual([daily.longtail.charter_boats, daily.longtail.join_pax, daily.longtail.cost], [1, 2, 1000 + 2 * 150]);
  assert.equal(daily.known_cost, daily.van_cost.total + 1300);
  assert.equal(daily.net_before_boat_costs, daily.revenue - daily.known_cost + daily.extras);

  const actuals = ok(await send('GET', `/v1/trip-actuals?from=${date}`)).trip_actuals;
  assert.ok(actuals.some((a: { boat_id: string; meal: { amount: number } }) => a.boat_id === boat.id && a.meal.amount === 1155));
  const changes = ok(await send('GET', `/v1/changes?since=${v0}&limit=1000`)).changes as { kind: string; entity_id: string }[];
  assert.ok(changes.some((c) => c.kind === 'trip_actual' && c.entity_id === `${date}:${boat.id}`), 'the change feed names the boat\'s day');
});
