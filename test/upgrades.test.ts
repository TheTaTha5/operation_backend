import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';

// Upgrades (todo/trip-ops-and-vans-model.md, slice E), on whichever store DATABASE_URL selects.
const app = buildApp();
after(async () => app.close());
const send = (method: InjectOptions['method'], url: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}) });
type Up = { id: string; label: string; sell_price: number; commission: number; fee: number | null; customer_paid: number | null; collected: boolean | null; settle: string; at: string };
type Booking = { id: string; version: number; total?: number; upgrades: Up[]; trips: { id: string; route_id: string; operations: { upgrade: { from_route_id: string; to_route_id: string; charge: number; upgrade_id: string | null } | null } }[] };
const deploy = (route: string, date: string, capacity = 30) => send('POST', '/operations/deployments', { boat_id: `upg-${route}-${date}`, route_id: route, service_date: date, capacity });
async function booking(date: string, extra: object = {}, pax: object = { ad: 2 }) {
  const created = await send('POST', '/v1/bookings', { route_id: 'r1', service_date: date, pax, ...extra });
  assert.equal(created.statusCode, 201, created.body);
  return created.json() as Booking;
}
const historyOf = async (id: string): Promise<string[]> => (await send('GET', `/v1/bookings/${id}/history`)).json().history.map((h: { text: string }) => h.text);
const sale = { id: 'up_1', label: 'Longtail · Join → เหมา (Charter)', sell_price: 2000, to_company: 1300, seller: 'BEST', method: 'card', fee_pct: 5 };

test('an on-tour sale: the server works out commission, fee and what the customer paid, and logs it as legacy', async () => {
  const date = '2050-04-01';
  await deploy('r1', date);
  const b = await booking(date, { upgrades: [{ ...sale, commission: 1, fee: 1, customer_paid: 1, at: '2000-01-01T00:00:00Z' }] });
  const u = b.upgrades[0];
  assert.deepEqual([u.commission, u.fee, u.customer_paid, u.settle], [700, 100, 2100, 'pending'], 'sent values are replaced');
  assert.notEqual(u.at, '2000-01-01T00:00:00.000Z');
  assert.ok((await historyOf(b.id)).includes('Upgrade · Longtail · Join → เหมา (Charter) · ขาย ฿2,000 · บริษัท ฿1,300 · คอม ฿700 · BEST'));

  const legacy = await send('PATCH', `/v1/bookings/${b.id}`, { upgrades: [{ id: 'up_1', label: sale.label, sellPrice: 1900, toCompany: 1330, method: 'cash', feePct: 5, collected: true, slips: [] }] });
  assert.equal(legacy.statusCode, 200, legacy.body);
  const edited = legacy.json().upgrades[0] as Up;
  assert.deepEqual([edited.commission, edited.fee, edited.customer_paid, edited.collected, edited.at], [570, 0, 1900, true, u.at], 'cash pays no fee; the sale keeps its time');
  assert.equal((await historyOf(b.id)).at(-1), 'Edited upgrade · Longtail · Join → เหมา (Charter) · ขาย ฿1,900 · คอม ฿570');

  for (const bad of [
    { upgrades: [{ label: 'X' }] }, { upgrades: [{ ...sale, fee_pct: 101 }] }, { upgrades: [sale, sale] },
    { upgrades: [{ ...sale, slips: [{ id: 'att_1' }] }] }, { upgrades: [{ ...sale, settle: 'maybe' }] },
  ]) {
    const refused = await send('PATCH', `/v1/bookings/${b.id}`, bad);
    assert.equal(refused.statusCode, 400, `${JSON.stringify(bad)}: ${refused.body}`);
  }
  assert.deepEqual((await send('PATCH', `/v1/bookings/${b.id}`, { upgrades: [] })).json().upgrades, []);
});

test('a route upgrade moves the trip at its booked price; a charge is a sale to collect; undo takes both back', async () => {
  const date = '2050-04-02';
  await deploy('r1', date); await deploy('r2', date);
  const b = await booking(date);
  const trip = b.trips[0].id;
  const up = await send('POST', `/v1/bookings/${b.id}/upgrade`, { trip_id: trip, to_route_id: 'r2', reason: 'Trip cancelled', charge: 1500 });
  assert.equal(up.statusCode, 200, up.body);
  const moved = up.json() as Booking;
  assert.equal(moved.trips[0].route_id, 'r2');
  assert.equal(moved.total, b.total, 'the price stays as booked');
  const charge = moved.upgrades[0];
  assert.match(charge.label, /^Upgrade > /);
  assert.deepEqual([charge.sell_price, charge.customer_paid, charge.collected, charge.commission], [1500, 1500, false, 0]);
  assert.deepEqual(moved.trips[0].operations.upgrade && [moved.trips[0].operations.upgrade.from_route_id, moved.trips[0].operations.upgrade.upgrade_id], ['r1', charge.id]);
  assert.match((await historyOf(b.id)).at(-1)!, /^Upgrade route · .+ > .+ · Trip cancelled · \+THB 1,500$/);
  const again = await send('POST', `/v1/bookings/${b.id}/upgrade`, { trip_id: trip, to_route_id: 'r1', reason: 'x' });
  assert.deepEqual([again.statusCode, again.json().code], [409, 'already_upgraded']);

  const undone = await send('POST', `/v1/bookings/${b.id}/upgrade/undo`, { trip_id: trip });
  assert.equal(undone.statusCode, 200, undone.body);
  assert.deepEqual([undone.json().trips[0].route_id, undone.json().trips[0].operations.upgrade, undone.json().upgrades], ['r1', null, []], 'the uncollected charge goes');
  assert.match((await historyOf(b.id)).at(-1)!, /^Upgrade undone · back to /);
  assert.equal((await send('POST', `/v1/bookings/${b.id}/upgrade/undo`, { trip_id: trip })).json().code, 'not_upgraded');

  await send('POST', `/v1/bookings/${b.id}/upgrade`, { trip_id: trip, to_route_id: 'r2', reason: 'Again', charge: 800 });
  const withSale = (await send('GET', `/v1/bookings/${b.id}`)).json() as Booking;
  await send('PATCH', `/v1/bookings/${b.id}`, { upgrades: withSale.upgrades.map((u) => ({ ...u, collected: true })) });
  const kept = await send('POST', `/v1/bookings/${b.id}/upgrade/undo`, { trip_id: trip });
  assert.equal(kept.json().upgrades.length, 1, 'a collected charge stays on the booking');
});

test('legacy\'s refusals: a reason, a programme that sails that day, seats for everyone', async () => {
  const date = '2050-04-03';
  await deploy('r1', date); await deploy('r3', date, 1);
  const b = await booking(date);
  const trip = b.trips[0].id;
  const upgrade = (body: object) => send('POST', `/v1/bookings/${b.id}/upgrade`, { trip_id: trip, ...body });
  assert.match((await upgrade({ to_route_id: 'r3' })).json().message, /Enter a reason/);
  assert.equal((await upgrade({ to_route_id: 'r1', reason: 'x' })).statusCode, 400, 'already on that route');
  assert.equal((await upgrade({ to_route_id: 'r2', reason: 'x' })).json().code, 'route_not_sailing');
  const full = await upgrade({ to_route_id: 'r3', reason: 'x' });
  assert.deepEqual([full.statusCode, full.json().code], [409, 'not_enough_seats']);
  assert.match(full.json().message, /Needs 2, free 1/);
  assert.equal((await upgrade({ to_route_id: 'r3', reason: 'x', charge: -1 })).statusCode, 400);
  assert.equal((await send('POST', `/v1/bookings/${b.id}/upgrade`, { trip_id: 'trip_nowhere', to_route_id: 'r3', reason: 'x' })).statusCode, 400);
});
