import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { buildApp } from '../src/app.js';
import type { InjectOptions } from 'fastify';

const app = buildApp();
after(async () => app.close());

async function request(method: InjectOptions['method'], url: string, payload?: object) {
  return payload === undefined ? app.inject({ method, url }) : app.inject({ method, url, payload });
}

type Trip = Record<string, unknown> & { id: string; service_date: string };
const tripsOf = (response: { json(): unknown }): Trip[] => (response.json() as { trips: Trip[] }).trips;

const [out, back, later] = ['2033-02-01', '2033-02-03', '2033-02-05'];
const outbound = { routeId: 'r1', date: out, pax: 2, zone: 'PK', pickupTime: '08:30', ovn: 'return', ovnReturnDate: back };
const leg = { routeId: 'r1', date: back, pax: 2, zone: 'PK', ovnLeg: true, ovnOf: 0 };

test('a trip carries its zone, pickup time and overnight link, in both directions', async () => {
  for (const date of [out, back, later]) await request('POST', '/operations/deployments', { boat_id: 'boat-trip-fields', route_id: 'r1', service_date: date, capacity: 20 });
  const created = await request('POST', '/v1/bookings', { trips: [outbound, leg] });
  assert.equal(created.statusCode, 201, created.body);
  const [a, b] = tripsOf(created);
  assert.deepEqual(
    { zone: a.zone, pickup_time: a.pickup_time, ovn: a.ovn, ovn_return_date: a.ovn_return_date, ovn_leg: a.ovn_leg, ovn_of: a.ovn_of },
    { zone: 'PK', pickup_time: '08:30', ovn: 'return', ovn_return_date: back, ovn_leg: false, ovn_of: undefined },
  );
  assert.deepEqual({ ovn_leg: b.ovn_leg, ovn_of: b.ovn_of, ovn: b.ovn, pickup_time: b.pickup_time }, { ovn_leg: true, ovn_of: 0, ovn: undefined, pickup_time: undefined });
  assert.equal((await request('GET', `/v1/availability?route_id=r1&date=${back}`)).json().booked_pax, 2, 'the return leg holds seats on the return day');

  const bookingId = (created.json() as { id: string }).id;
  const headerOnly = tripsOf(await request('PATCH', `/v1/bookings/${bookingId}`, { hotel_name: 'Reef' }));
  assert.deepEqual(headerOnly.map((t) => [t.id, t.pickup_time, t.ovn_of]), [[a.id, '08:30', undefined], [b.id, undefined, 0]], 'a header edit keeps them');

  // Stored as the outbound's id, so reordering re-renders the index instead of breaking the link.
  const swapped = await request('PATCH', `/v1/bookings/${bookingId}`, { trips: [{ ...leg, id: b.id, ovnOf: 1 }, { ...outbound, id: a.id }] });
  assert.equal(swapped.statusCode, 200, swapped.body);
  assert.deepEqual(tripsOf(swapped).map((t) => [t.id, t.ovn_of]), [[b.id, 1], [a.id, undefined]]);
  assert.deepEqual(tripsOf(await request('GET', `/v1/bookings/${bookingId}`)).map((t) => t.ovn_of), [1, undefined]);

  // Blank is unset, the way legacy writes an empty field.
  const blank = tripsOf(await request('POST', '/v1/bookings', { trips: [{ routeId: 'r1', date: later, pax: 1, zone: '', pickupTime: '', ovn: null, ovnReturnDate: '', ovnLeg: false }] }))[0];
  assert.deepEqual([blank.zone, blank.pickup_time, blank.ovn, blank.ovn_return_date, blank.ovn_leg], [undefined, undefined, undefined, undefined, false]);
});

test('an itinerary is refused when it breaks the per-day or overnight rules', async () => {
  const refused = async (trips: object[], why: string) => {
    const response = await request('POST', '/v1/bookings', { trips });
    assert.equal(response.statusCode, 400, `${why}: ${response.body}`);
  };
  await refused([{ routeId: 'r1', date: out, pax: 1 }, { routeId: 'r1', date: out, pax: 1 }], 'two trips on one route and day');
  await refused([{ ...outbound, pickupTime: '8:30' }], 'pickup time is HH:MM');
  await refused([{ ...outbound, ovn: 'maybe' }], 'ovn is return or self');
  await refused([{ ...outbound, ovnReturnDate: undefined }], 'return needs a return date');
  await refused([{ ...outbound, ovn: 'self' }], 'only return takes a return date');
  await refused([{ ...outbound, ovnReturnDate: out }], 'the return date is after the trip');
  await refused([outbound, { ...leg, ovnOf: undefined }], 'a leg names its outbound');
  await refused([outbound, { ...leg, ovnOf: 1 }], 'not itself');
  await refused([outbound, { ...leg, ovnOf: 5 }], 'an index in the list');
  await refused([{ ...outbound, ovn: 'self', ovnReturnDate: undefined }, leg], 'the outbound must come back with us');
  await refused([outbound, { ...leg, date: later }], 'the leg is on the return date');
  await refused([outbound, { ...leg, routeId: 'r2' }], 'the leg is on the same route');
  await refused([outbound, { ...leg, ovn: 'return', ovnReturnDate: later }], 'a leg is not itself an outbound');
  await refused([outbound, { ...leg, bookingMode: 'charter', charterBoatId: 'boat-trip-fields' }], 'a leg is a seat trip');
  await refused([{ routeId: 'r1', date: out, pax: 1, ovnOf: 0 }], 'ovn_of only on a leg');
});

test('moving an overnight outbound past its return date is refused', async () => {
  for (const date of ['2033-03-01', '2033-03-04']) await request('POST', '/operations/deployments', { boat_id: 'boat-trip-fields', route_id: 'r1', service_date: date, capacity: 20 });
  const created = await request('POST', '/v1/bookings', { trips: [{ ...outbound, date: '2033-03-01', ovnReturnDate: '2033-03-03' }] });
  assert.equal(created.statusCode, 201, created.body);
  const bookingId = (created.json() as { id: string }).id;
  assert.equal((await request('POST', `/v1/bookings/${bookingId}/reschedule`, { route_id: 'r1', service_date: '2033-03-04' })).statusCode, 400);
});
