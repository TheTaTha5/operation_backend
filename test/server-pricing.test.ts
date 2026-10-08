import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { seedAgents, testStore } from './users-helper.js';

// Bookings priced by the server (README "Prices"), on whichever store DATABASE_URL selects.
const store = testStore();
const app = buildApp({ store });
after(async () => app.close());
const send = (method: InjectOptions['method'], url: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}) });
const run = Date.now().toString(36);
let rates: { std: string; winter: string } | undefined;
async function setup() {
  if (rates) return rates;
  await seedAgents(store, [], { sp_a1: null, a_walkin: null });
  const create = async (name: string, adFr: number) => {
    const r = await send('POST', '/v1/rate-types', { name: `SP ${run} ${name}`, routes: [{ route_id: 'r1', zones: { PK: { net: { ad_fr: adFr, ad_th: 800 } } }, transfer: { PK: { van: 1800 } } }] });
    assert.equal(r.statusCode, 201, r.body);
    return r.json().id as string;
  };
  rates = { std: await create('Std', 1000), winter: await create('Winter', 1200) };
  return rates;
}
const trip = (date: string, fields: object = {}) => ({ routeId: 'r1', date, zone: 'PK', pax: { ad_fr: 2 }, ...fields });

test('a booking is priced by the server; a price the client sends is replaced, and said', async () => {
  const { std } = await setup();
  const created = await send('POST', '/v1/bookings', {
    agent_id: 'sp_a1', rate_type_ref: std, total: 99, trips: [trip('2045-01-10', { ovn: 'self', ovnCharge: 300 })],
    addOns: [{ type: 'transfer-r1-PK-van', amount: 1 }], adjustments: [{ kind: 'discount', value: 100 }],
  });
  assert.equal(created.statusCode, 201, created.body);
  const b = created.json();
  assert.deepEqual([b.price_seat, b.price_addon, b.price_discount, b.price_extra, b.total], [2000, 1800, -100, 300, 4000]);
  assert.deepEqual([b.trips[0].subtotal, b.trips[0].rate_type_id, b.trips[0].ovn_charge, b.add_ons[0].amount], [2000, std, 300, 1800]);
  assert.deepEqual(b.price_warnings.map((w: { code: string; field: string; sent: number; used: number }) => [w.code, w.field, w.sent, w.used]), [['price_replaced', 'total', 99, 4000]]);
  assert.equal(b.status, 'pending_approval', 'the computed discount waits for approval');
});

test('an edit re-prices only when it changes what the price reads, keeping the rate each trip was sold at', async () => {
  const { std, winter } = await setup();
  const id = (await send('POST', '/v1/bookings', { agent_id: 'sp_a1', rate_type_ref: std, trips: [trip('2045-02-10')] })).json().id as string;
  await send('PUT', '/v1/agents/sp_a1/rate-seasons', { seasons: [{ rt: winter, from: '2044-11-01' }] });
  const named = await send('PATCH', `/v1/bookings/${id}`, { lead_pax: 'Somchai', total: 5 });
  assert.deepEqual([named.json().total, named.json().price_warnings[0].code], [2000, 'price_replaced'], 'a name change never moves the price');
  const more = await send('PATCH', `/v1/bookings/${id}`, { trips: [trip('2045-02-10', { pax: { ad_fr: 3 } })] });
  assert.deepEqual([more.json().total, more.json().trips[0].rate_type_id], [3000, std], 'the trip keeps the rate it was sold at');
  const today = await send('PATCH', `/v1/bookings/${id}`, { rate: 'agent' });
  assert.deepEqual([today.json().total, today.json().trips[0].rate_type_id], [3600, winter], 'rate "agent": today\'s season');
  await send('PUT', '/v1/agents/sp_a1/rate-seasons', { seasons: [] });
});

test('commands keep the price; only walk-in, company and staff may be priced by hand; B2C keeps what it sent', async () => {
  const { std } = await setup();
  const id = (await send('POST', '/v1/bookings', { agent_id: 'sp_a1', rate_type_ref: std, intent: 'quote', trips: [trip('2045-03-10')] })).json().id as string;
  assert.equal((await send('POST', `/v1/bookings/${id}/confirm`, {})).json().total, 2000);
  const manual = await send('POST', '/v1/bookings', { agent_id: 'sp_a1', price_mode: 'manual', manual_total: 50, trips: [trip('2045-03-11')] });
  assert.equal(manual.statusCode, 400);
  assert.match(manual.json().message, /only walk-in, company and staff bookings may be priced by hand/);
  const walkIn = await send('POST', '/v1/bookings', { agent_id: 'a_walkin', price_mode: 'manual', manual_total: 1500, trips: [trip('2045-03-12')] });
  assert.deepEqual([walkIn.statusCode, walkIn.json().total, walkIn.json().price_mode], [201, 1500, 'manual']);
  const b2c = await send('POST', '/v1/bookings', { agent_id: 'a_b2c', external_id: `LOV-${run}`, total: 4321, trips: [trip('2045-03-13')] });
  assert.deepEqual([b2c.json().total, b2c.json().price_warnings], [4321, undefined]);
});
