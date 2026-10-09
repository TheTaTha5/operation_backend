import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Pool } from 'pg';
import type { InjectOptions } from 'fastify';
import type { Contract } from '../src/domain/contracts.js';
import { OperationsStore } from '../src/domain/operations.js';

// Promo contracts written through the API (todo/contracts-model.md, "Design — promo writes"), on
// whichever store DATABASE_URL selects, with logins on. Legacy's `ctSaveAddPromo` checks, its confirms
// as flags, the void, and that the quote prices from what was written.
process.env.AUTH_JWT_SECRET = 'promo-contracts-test-secret';
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
const call = (headers: Headers, method: InjectOptions['method'], url: string, payload?: object, extra: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { ...headers, ...extra }, ...(payload ? { payload } : {}) });
const ok = (res: { statusCode: number; body: string }, status = 200) => { assert.equal(res.statusCode, status, res.body); return JSON.parse(res.body || 'null'); };
const refused = (res: { statusCode: number; body: string }, status: number, code?: string) => {
  assert.equal(res.statusCode, status, res.body);
  if (code) assert.equal(JSON.parse(res.body).code, code, res.body);
  return JSON.parse(res.body).message as string;
};

type Ctx = { admin: Headers; agent: string; other: string; std: string; promoRate: string; s1: string; s2: string };
let ctx: Ctx | undefined;
/** Two agents (two salespeople) on a rate pricing r5 and r6 at PK, with those programmes. */
async function setup(): Promise<Ctx> {
  if (ctx) return ctx;
  const admin = await as(`pc.admin.${run}`, { role: 'admin' });
  const market = ok(await call(admin, 'POST', '/v1/markets', { id: `pc${run}`, name: `PC ${run}` }), 201).id;
  const s1 = ok(await call(admin, 'POST', '/v1/sales', { code: `P${run.slice(-1)}`.toUpperCase(), name: 'Promo One' }), 201).id;
  const s2 = ok(await call(admin, 'POST', '/v1/sales', { code: `Q${run.slice(-1)}`.toUpperCase(), name: 'Promo Two' }), 201).id;
  const std = ok(await call(admin, 'POST', '/v1/rate-types', { name: `PC std ${run}`, routes: [
    { route_id: 'r5', zones: { PK: { net: { ad_fr: 1000, ad_th: 800, chd_fr: 500 } }, KL: { net: { ad_fr: 1100 } } } },
    { route_id: 'r6', zones: { PK: { net: { ad_fr: 1200, ad_th: 900 } } } },
  ] }), 201).id;
  const promoRate = ok(await call(admin, 'POST', '/v1/rate-types', { name: `PC promo ${run}`, routes: [{ route_id: 'r5', zones: { PK: { net: { ad_fr: 700 } } } }] }), 201).id;
  const agent = async (name: string, sales: string) => {
    const a = ok(await call(admin, 'POST', '/v1/agents', {
      name, market_id: market, sales_id: sales, pay_type: 'proforma', vat_mode: 'include', rate_type_id: std, phone: '081',
      company: { legal_name: `${name} Co., Ltd.`, address: '1 Beach Rd' },
    }), 201);
    ok(await call(admin, 'PUT', `/v1/agents/${a.id}/programs`, { programs: ['r5', 'r6'] }));
    return a.id as string;
  };
  ctx = { admin, agent: await agent(`PC Agent ${run}`, s1), other: await agent(`PC Other ${run}`, s2), std, promoRate, s1, s2 };
  return ctx;
}
const own = (fields: object = {}) => ({
  price_mode: 'own', active_from: '2031-01-01', active_to: '2031-01-31', route_ids: ['r5'],
  seat_prices: [
    { route_id: 'r5', zone: 'PK', category: 'ad', residency: 'foreign', price: 600 },
    { route_id: 'r5', zone: 'PK', category: 'chd', residency: 'foreign', price: 300 },
    // Only a child price: legacy does not save the zone.
    { route_id: 'r5', zone: 'KL', category: 'chd', residency: 'foreign', price: 200 },
  ], ...fields,
});
const quote = async (h: Headers, agentId: string, date: string) =>
  ok(await call(h, 'POST', '/v1/quote', { agent_id: agentId, trips: [{ routeId: 'r5', date, zone: 'PK', pax: { ad_fr: 2 } }] }));

test('adding a promo: legacy\'s form checks, its confirm as a flag, what the server sets', async () => {
  const { admin, agent } = await setup();
  const add = (body: object) => call(admin, 'POST', '/v1/contracts', { agent_id: agent, ...body });
  refused(await add(own({ active_to: undefined })), 400);
  refused(await add(own({ active_from: '2031-02-01' })), 400);
  refused(await add(own({ active_from: '2031-02-30' })), 400);
  refused(await add(own({ book_from: '2031-01-10', book_to: '2031-01-05' })), 400);
  refused(await add(own({ book_from: '2031-02-10' })), 400, undefined);
  refused(await add(own({ route_ids: [] })), 400);
  assert.match(refused(await add(own({ route_ids: ['r5', 'r1'] })), 400), /not one of this agent's programmes/);
  refused(await add(own({ seat_prices: [{ route_id: 'r6', zone: 'PK', category: 'ad', residency: 'foreign', price: 1 }] })), 400);
  refused(await add(own({ seat_prices: [{ route_id: 'r5', zone: 'XX', category: 'ad', residency: 'foreign', price: 1 }] })), 400);
  refused(await add(own({ seat_prices: [{ route_id: 'r5', zone: 'PK', category: 'ad', residency: 'foreign', price: -1 }] })), 400);
  refused(await add(own({ seat_prices: [{ route_id: 'r5', zone: 'PK', category: 'chd', residency: 'foreign', price: 300 }] })), 400, undefined);
  refused(await add(own({ rate_type_id: 'rt_x' })), 400);
  refused(await add(own({ priority: 0 })), 400);
  refused(await add(own({ status: 'void' })), 400);
  refused(await call(admin, 'POST', '/v1/contracts', own()), 400);
  refused(await call(admin, 'POST', '/v1/contracts', { agent_id: 'nobody', ...own() }), 400);

  // r6 is picked but has no promo price: legacy's confirm.
  const twoRoutes = own({ route_ids: ['r5', 'r6'], note: '  New year  ' });
  assert.match(refused(await add(twoRoutes), 409, 'routes_unpriced'), /1 route has no promo price/);
  const promo = ok(await add({ ...twoRoutes, unpriced_anyway: true }), 201);
  assert.match(promo.id, /^ct/);
  assert.deepEqual([promo.kind, promo.status, promo.version, promo.priority, promo.note, promo.book_window, promo.created_by, promo.rate_type_id, promo.voided_at],
    ['promo', 'active', 'promo-2031-01-01', 10, 'New year', false, `pc.admin.${run}`, null, null]);
  assert.deepEqual(promo.program_periods.map((p: { route_id: string; book_from: string; book_to: string; travel_from: string }) => [p.route_id, p.book_from, p.book_to, p.travel_from]),
    [['r5', '2031-01-01', '2031-01-31', '2031-01-01'], ['r6', '2031-01-01', '2031-01-31', '2031-01-01']], 'no booking window: the travel dates');
  assert.deepEqual(promo.seat_prices.map((p: { zone: string; category: string }) => `${p.zone}/${p.category}`), ['PK/ad', 'PK/chd'], 'a zone without an adult price is not saved');
  assert.equal(promo.state, 'scheduled');
  assert.equal(promo.bonus_progress, null);

  const windowed = ok(await add(own({ book_from: '2030-12-01', bonus: { buy: 5 } })), 201);
  assert.equal(windowed.book_window, true);
  assert.deepEqual([windowed.program_periods[0].book_from, windowed.program_periods[0].book_to], ['2030-12-01', '2031-01-31'], 'a missing bound is the travel end');
  assert.deepEqual(windowed.bonus, { buy: 5, free: 1, basis: 'adchd' });
  refused(await add(own({ bonus: { buy: 0 } })), 400);
  refused(await add(own({ bonus: { buy: 3, free: 2 } })), 400);
  refused(await add(own({ bonus: { buy: 3, basis: 'chd' } })), 400);

  const activity = ok(await call(admin, 'GET', `/v1/agents/${agent}/activity`)).activity;
  assert.equal(activity[0].text, 'Promotion added · promo-2031-01-01');
  assert.equal(activity[1].text, 'Promotion added · New year');
});

test('rate and discount promos: legacy\'s limits on the discount, a rate that must exist', async () => {
  const { admin, agent, promoRate } = await setup();
  const add = (body: object) => call(admin, 'POST', '/v1/contracts', { agent_id: agent, active_from: '2032-01-01', active_to: '2032-01-31', route_ids: ['r5'], ...body });
  refused(await add({ price_mode: 'rate' }), 400);
  refused(await add({ price_mode: 'rate', rate_type_id: 'rt_nope' }), 400);
  refused(await add({ price_mode: 'cheap' }), 400);
  const rate = ok(await add({ price_mode: 'rate', rate_type_id: promoRate }), 201);
  assert.equal(rate.rate_type_id, promoRate);

  refused(await add({ price_mode: 'discount' }), 400);
  refused(await add({ price_mode: 'discount', discount: { mode: 'pct', value: 0 } }), 400);
  refused(await add({ price_mode: 'discount', discount: { mode: 'pct', value: 100 } }), 400);
  refused(await add({ price_mode: 'discount', discount: { mode: 'off', value: 5 } }), 400);
  // The main rate's cheapest adult price on r5 is 800 (Thai): an amount that large reads as "not sold".
  assert.match(refused(await add({ price_mode: 'discount', discount: { mode: 'amt', value: 800 } }), 400), /cheapest adult price on the main rate \(800\)/);
  refused(await add({ price_mode: 'discount', discount: { mode: 'amt', value: 100 }, seat_prices: [{ route_id: 'r5', zone: 'PK', category: 'ad', residency: 'foreign', price: 1 }] }), 400);
  const discount = ok(await add({ price_mode: 'discount', discount: { mode: 'amt', value: 799.5 }, note: 'Low season' }), 201);
  assert.deepEqual(discount.discount, { mode: 'amt', value: 799.5 });
  const activity = ok(await call(admin, 'GET', `/v1/agents/${agent}/activity`)).activity;
  assert.equal(activity[0].text, 'Promotion added · Low season · ลด 800 บาท/หัว');
});

test('the quote prices from a written promo; a void one no longer applies', async () => {
  const { admin, agent } = await setup();
  const before = await quote(admin, agent, '2033-03-10');
  assert.equal(before.total, 2000);
  const promo = ok(await call(admin, 'POST', '/v1/contracts', { agent_id: agent, ...own({ active_from: '2033-03-01', active_to: '2033-03-31', priority: 20 }) }), 201);
  const priced = await quote(admin, agent, '2033-03-10');
  assert.deepEqual([priced.total, priced.trips[0].promo_id], [1200, promo.id]);

  const voided = ok(await call(admin, 'POST', `/v1/contracts/${promo.id}/void`));
  assert.deepEqual([voided.status, voided.state, voided.voided_by], ['void', 'void', `pc.admin.${run}`]);
  assert.ok(voided.voided_at);
  refused(await call(admin, 'POST', `/v1/contracts/${promo.id}/void`), 409, 'contract_void');
  refused(await call(admin, 'PATCH', `/v1/contracts/${promo.id}`, { note: 'again' }), 409, 'contract_void');
  assert.equal((await quote(admin, agent, '2033-03-10')).total, 2000, 'back to the main rate');
  assert.equal(ok(await call(admin, 'GET', `/v1/agents/${agent}/activity`)).activity[0].text, 'Promotion void · promo-2033-03-01');
});

test('editing: the whole promo is checked again, server-owned fields refused, a sold promo asks first', async () => {
  const { admin, agent } = await setup();
  const promo = ok(await call(admin, 'POST', '/v1/contracts', { agent_id: agent, ...own({ active_from: '2034-05-01', active_to: '2034-05-31', bonus: { buy: 3, basis: 'ad' } }) }), 201);
  const url = `/v1/contracts/${promo.id}`;
  // Echoing what was read is accepted and changes nothing.
  const echoed = ok(await call(admin, 'PATCH', url, promo));
  assert.deepEqual(echoed, promo);
  refused(await call(admin, 'PATCH', url, { status: 'void' }), 400);
  refused(await call(admin, 'PATCH', url, { version: 'v9' }), 400);
  refused(await call(admin, 'PATCH', url, { agent_id: 'other' }), 400);
  refused(await call(admin, 'PATCH', url, { state: 'active' }), 400);
  refused(await call(admin, 'PATCH', url, { active_to: '2034-04-01' }), 400);
  refused(await call(admin, 'PATCH', url, { price_mode: 'rate' }), 400, undefined);

  const edited = ok(await call(admin, 'PATCH', url, { note: 'May deal', priority: 30 }));
  assert.deepEqual([edited.note, edited.priority, edited.version, edited.created_by], ['May deal', 30, 'promo-2034-05-01', `pc.admin.${run}`], 'version and creator kept');
  assert.equal(ok(await call(admin, 'GET', `/v1/agents/${agent}/activity`)).activity[0].text, 'Promotion edited · May deal');

  // Sold: a booking priced with it holds seats.
  const booked = await call(admin, 'POST', '/v1/bookings', { agent_id: agent, foc_reason: 'Promo bonus seat', trips: [{ routeId: 'r5', date: '2034-05-10', zone: 'PK', pax: { ad_fr: 3, chd_fr: 1, foc_fr: 1 } }] });
  assert.equal(booked.statusCode, 201, booked.body);
  assert.equal(booked.json().trips[0].promo_id, promo.id);
  assert.match(refused(await call(admin, 'PATCH', url, { note: 'June deal' }), 409, 'promo_sold'), /sold on 1 trip/);
  assert.equal(ok(await call(admin, 'PATCH', url, { note: 'June deal', sold_anyway: true })).note, 'June deal');

  // Buy 3 (adults only), get one free: 3 adults sold, 1 earned, 1 FOC in the booking used it.
  const read = ok(await call(admin, 'GET', url));
  assert.deepEqual(read.bonus_progress, { buy: 3, basis: 'ad', sold: 3, bookings: 1, earned: 1, used: 1, left: 0, over: 0, to_next: 0, pct: 0 });
  const listed = ok(await call(admin, 'GET', `/v1/contracts?agent_id=${agent}&kind=promo`)).contracts.find((c: { id: string }) => c.id === promo.id);
  assert.deepEqual(listed.bonus_progress, read.bonus_progress);
});

test('who may write promos: the sales area, a salesperson only for their own agents; a main contract is not edited here', async () => {
  const { admin, agent, other, s1, std } = await setup();
  const ops = await as(`pc.ops.${run}`, { edit_areas: ['operations'] });
  refused(await call(ops, 'POST', '/v1/contracts', { agent_id: agent, ...own() }), 403);
  const nok = await as(`pc.nok.${run}`, { edit_areas: ['sales'], sales_id: s1 });
  ok(await call(nok, 'POST', '/v1/contracts', { agent_id: agent, ...own() }), 201);
  refused(await call(nok, 'POST', '/v1/contracts', { agent_id: other, ...own() }), 403);
  const theirs = ok(await call(admin, 'POST', '/v1/contracts', { agent_id: other, ...own() }), 201);
  refused(await call(nok, 'PATCH', `/v1/contracts/${theirs.id}`, { note: 'mine now' }), 403);
  refused(await call(nok, 'POST', `/v1/contracts/${theirs.id}/void`), 403);

  const main: Contract = {
    id: `ct_main_pc_${run}`, agent_id: agent, kind: 'main', status: 'active', rate_type_id: std, active_from: '2025-10-01', active_to: '2026-09-30', priority: 0,
    version: 'v2025-1', price_mode: null, discount: null, bonus: null, book_window: false, created_date: '2025-10-01', created_by: 'migration', note: null, doc_id: null,
    voided_at: null, voided_by: null, program_periods: [], seat_prices: [],
  };
  if (store instanceof OperationsStore) store.seedContracts([...store.listContracts({}), main]);
  else {
    const db = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      await db.query('INSERT INTO contracts (id, agent_id, kind, status, rate_type_id, active_from, active_to, priority, version, book_window) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [main.id, main.agent_id, main.kind, main.status, main.rate_type_id, main.active_from, main.active_to, main.priority, main.version, main.book_window]);
    } finally { await db.end(); }
  }
  assert.match(refused(await call(admin, 'PATCH', `/v1/contracts/${main.id}`, { note: 'x' }), 400), /main contract follows its agent/);
  refused(await call(admin, 'POST', `/v1/contracts/${main.id}/void`), 400);
  refused(await call(admin, 'POST', '/v1/contracts/nope/void'), 404);
});
