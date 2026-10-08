import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { seedAgents, testStore } from './users-helper.js';

// POST /v1/quote on whichever store DATABASE_URL selects (README "Quote").
const store = testStore();
const app = buildApp({ store });
after(async () => app.close());
const send = (method: InjectOptions['method'], url: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}) });
const run = Date.now().toString(36);
let ids: { std: string; winter: string } | undefined;
async function setup() {
  if (ids) return ids;
  await seedAgents(store, [], { qt_a1: null });
  const create = async (name: string, adFr: number) => {
    const r = await send('POST', '/v1/rate-types', { name: `QT ${run} ${name}`, routes: [{ route_id: 'r1', zones: { PK: { net: { ad_fr: adFr, ad_th: 800, chd_fr: 600 } } } }] });
    assert.equal(r.statusCode, 201, r.body);
    return r.json().id as string;
  };
  ids = { std: await create('Std', 1000), winter: await create('Winter', 1200) };
  return ids;
}
const body = (fields: object = {}) => ({ agent_id: 'qt_a1', booking_date: '2044-01-01', trips: [{ routeId: 'r1', date: '2044-01-10', zone: 'PK', pax: { ad_fr: 2, chd_fr: 1 } }], ...fields });

test('a quote prices the booking it is sent, and saves nothing', async () => {
  const { std } = await setup();
  const q = await send('POST', '/v1/quote', body({ rate_type_ref: std, adjustments: [{ kind: 'discount', value: 200 }], trips: [{ routeId: 'r1', date: '2044-01-10', zone: 'PK', pax: { ad_fr: 2, chd_fr: 1 }, ovn: 'self', ovnCharge: 300 }] }));
  assert.equal(q.statusCode, 200, q.body);
  assert.deepEqual([q.json().seat, q.json().discount, q.json().extra, q.json().total, q.json().trips[0].rate_source], [2600, -200, 300, 2700, 'booking']);
  assert.equal((await send('GET', '/v1/bookings?agent_id=qt_a1')).json().bookings.length, 0);
});

test('an edit keeps the rate it was sold at; rate "agent" re-prices at today\'s', async () => {
  const { std, winter } = await setup();
  const created = await send('POST', '/v1/bookings', body({ rate_type_ref: std }));
  assert.equal(created.statusCode, 201, created.body);
  await send('PUT', '/v1/agents/qt_a1/rate-seasons', { seasons: [{ rt: winter, from: '2043-11-01' }] });
  const id = created.json().id as string;
  const kept = (await send('POST', '/v1/quote', body({ booking_id: id }))).json();
  assert.deepEqual([kept.seat, kept.trips[0].rate_source], [2600, 'kept']);
  const today = (await send('POST', '/v1/quote', body({ booking_id: id, rate: 'agent' }))).json();
  assert.deepEqual([today.seat, today.trips[0].rate_type_id, today.trips[0].rate_source], [3000, winter, 'season']);
  const newTrip = (await send('POST', '/v1/quote', body({ booking_id: id, trips: [{ routeId: 'r1', date: '2044-02-10', zone: 'PK', pax: { ad_fr: 1 } }] }))).json();
  assert.equal(newTrip.trips[0].rate_source, 'season', 'a trip that was not sold has no rate to keep');
  await send('PUT', '/v1/agents/qt_a1/rate-seasons', { seasons: [] });
});

test('a B2C booking answers the price Love Kingdom set', async () => {
  const created = await send('POST', '/v1/bookings', { ...body(), external_id: `b2c_${run}`, total: 4321, price_seat: 4000, price_addon: 321 });
  assert.equal(created.statusCode, 201, created.body);
  const q = (await send('POST', '/v1/quote', { booking_id: created.json().id })).json();
  assert.deepEqual([q.stored, q.total, q.seat, q.add_on], [true, 4321, 4000, 321]);
});

test('refused: an unknown agent, a hand price for an agent, a bad rate or charge', async () => {
  await setup();
  const refused = async (payload: object, message: RegExp) => {
    const r = await send('POST', '/v1/quote', payload);
    assert.equal(r.statusCode, 400, r.body);
    assert.match(r.json().message, message);
  };
  await refused(body({ agent_id: 'nobody' }), /agent_id nobody is not an agent/);
  await refused(body({ price_mode: 'manual', manual_total: 100 }), /only walk-in, company and staff bookings may be priced by hand/);
  await refused(body({ rate: 'yesterday' }), /rate must be kept or agent/);
  await refused(body({ trips: [{ routeId: 'r1', date: '2044-01-10', zone: 'PK', pax: { ad_fr: 1 }, ovnCharge: -5 }] }), /ovn_charge must be a number/);
  assert.equal((await send('POST', '/v1/quote', body({ booking_id: 'BK-none' }))).statusCode, 404);
});
