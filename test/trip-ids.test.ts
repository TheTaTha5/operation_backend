import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { buildApp } from '../src/app.js';
import type { InjectOptions } from 'fastify';

const app = buildApp();
after(async () => app.close());

async function request(method: InjectOptions['method'], url: string, payload?: object) {
  return payload === undefined ? app.inject({ method, url }) : app.inject({ method, url, payload });
}

type Trip = { id: string; seq: number; service_date: string; pax_total: number };
const tripsOf = (response: { json(): unknown }): Trip[] => (response.json() as { trips: Trip[] }).trips;

// Day-of-operations rows hang off a trip's id, so every edit that keeps a trip must keep its id.
test('an amendment keeps the ids of the trips it keeps', async () => {
  const [first, second, third] = ['2032-05-01', '2032-05-02', '2032-05-03'];
  for (const date of [first, second, third]) await request('POST', '/operations/deployments', { boat_id: 'boat-trip-ids', route_id: 'r1', service_date: date, capacity: 20 });
  const created = await request('POST', '/v1/bookings', { trips: [{ route_id: 'r1', date: first, pax: 2 }, { route_id: 'r1', date: second, pax: 3 }] });
  assert.equal(created.statusCode, 201);
  const bookingId = (created.json() as { id: string }).id;
  const [a, b] = tripsOf(created);
  assert.notEqual(a.id, b.id);

  const headerOnly = await request('PATCH', `/v1/bookings/${bookingId}`, { hotel_name: 'Sea View' });
  assert.equal(headerOnly.statusCode, 200);
  assert.deepEqual(tripsOf(headerOnly).map((trip) => trip.id), [a.id, b.id], 'a header-only edit leaves the trips alone');

  const swapped = await request('PATCH', `/v1/bookings/${bookingId}`, { trips: [{ id: b.id, route_id: 'r1', date: second, pax: 3 }, { id: a.id, route_id: 'r1', date: first, pax: 2 }] });
  assert.equal(swapped.statusCode, 200, 'reordering does not collide on (booking_id, seq)');
  assert.deepEqual(tripsOf(swapped).map((trip) => [trip.id, trip.seq]), [[b.id, 0], [a.id, 1]]);

  const dropped = await request('PATCH', `/v1/bookings/${bookingId}`, { trips: [{ id: a.id, route_id: 'r1', date: first, pax: 4 }] });
  assert.equal(dropped.statusCode, 200);
  assert.deepEqual(tripsOf(dropped).map((trip) => [trip.id, trip.seq, trip.pax_total]), [[a.id, 0, 4]], 'the kept trip moves to the front with its id and new pax');

  const added = await request('PATCH', `/v1/bookings/${bookingId}`, { trips: [{ id: a.id, route_id: 'r1', date: first, pax: 4 }, { route_id: 'r1', date: third, pax: 1 }] });
  assert.equal(added.statusCode, 200);
  const [, fresh] = tripsOf(added);
  assert.ok(![a.id, b.id].includes(fresh.id), 'a new trip never reuses an id, including a removed one');
  assert.equal(fresh.service_date, third);
});

test('removing the first trip keeps the second trip\'s id', async () => {
  const [first, second] = ['2032-05-11', '2032-05-12'];
  for (const date of [first, second]) await request('POST', '/operations/deployments', { boat_id: 'boat-trip-ids', route_id: 'r1', service_date: date, capacity: 20 });
  const created = await request('POST', '/v1/bookings', { trips: [{ route_id: 'r1', date: first, pax: 2 }, { route_id: 'r1', date: second, pax: 2 }] });
  const bookingId = (created.json() as { id: string }).id;
  const [, kept] = tripsOf(created);

  const amended = await request('PATCH', `/v1/bookings/${bookingId}`, { trips: [{ id: kept.id, route_id: 'r1', date: second, pax: 2 }] });
  assert.equal(amended.statusCode, 200);
  assert.deepEqual(tripsOf(amended).map((trip) => [trip.id, trip.seq]), [[kept.id, 0]]);
  assert.equal((await request('GET', `/v1/availability?route_id=r1&date=${first}`)).json().booked_pax, 0, 'the removed trip released its seats');
});

test('a trip sent without an id keeps the id of the stored trip on the same route and day', async () => {
  const [first, second, third] = ['2032-06-01', '2032-06-02', '2032-06-03'];
  for (const date of [first, second, third]) await request('POST', '/operations/deployments', { boat_id: 'boat-trip-ids', route_id: 'r1', service_date: date, capacity: 20 });
  const created = await request('POST', '/v1/bookings', { trips: [{ route_id: 'r1', date: first, pax: 2 }, { route_id: 'r1', date: second, pax: 2 }] });
  const bookingId = (created.json() as { id: string }).id;
  const [a, b] = tripsOf(created);

  const noIds = await request('PATCH', `/v1/bookings/${bookingId}`, { trips: [{ route_id: 'r1', date: second, pax: 3 }, { route_id: 'r1', date: first, pax: 2 }] });
  assert.equal(noIds.statusCode, 200, noIds.body);
  assert.deepEqual(tripsOf(noIds).map((t) => [t.id, t.service_date, t.pax_total]), [[b.id, second, 3], [a.id, first, 2]], 'matched by route and day, in any order');

  const moved = tripsOf(await request('PATCH', `/v1/bookings/${bookingId}`, { trips: [{ route_id: 'r1', date: third, pax: 3 }, { route_id: 'r1', date: first, pax: 2 }] }));
  assert.equal(moved[1].id, a.id);
  assert.ok(![a.id, b.id].includes(moved[0].id), 'without an id, a trip on a new day is a new trip');

  // An explicit id wins over the day match: the stored first-day trip is claimed by id and moved,
  // so the id-less trip on the first day is new rather than taking the same id twice.
  const claimed = tripsOf(await request('PATCH', `/v1/bookings/${bookingId}`, { trips: [{ id: a.id, route_id: 'r1', date: second, pax: 2 }, { route_id: 'r1', date: first, pax: 1 }] }));
  assert.equal(claimed[0].id, a.id);
  assert.notEqual(claimed[1].id, a.id);
});

test('single-departure edits keep the trip', async () => {
  const [date, moved] = ['2032-05-21', '2032-05-22'];
  for (const day of [date, moved]) await request('POST', '/operations/deployments', { boat_id: 'boat-trip-ids', route_id: 'r1', service_date: day, capacity: 20 });
  const created = await request('POST', '/v1/bookings', { route_id: 'r1', service_date: date, pax: 6 });
  const bookingId = (created.json() as { id: string }).id;
  const [trip] = tripsOf(created);

  assert.equal(tripsOf(await request('PATCH', `/v1/bookings/${bookingId}`, { pax: 5 }))[0].id, trip.id, 'changing pax');
  assert.equal(tripsOf(await request('POST', `/v1/bookings/${bookingId}/partial-cancel`, { pax_to_cancel: 1 }))[0].id, trip.id, 'partial-cancel');
  const rescheduled = await request('POST', `/v1/bookings/${bookingId}/reschedule`, { route_id: 'r1', service_date: moved });
  assert.equal(rescheduled.statusCode, 200);
  assert.deepEqual(tripsOf(rescheduled).map((t) => [t.id, t.service_date]), [[trip.id, moved]], 'moving the departure');
});

test('a trip id must name a trip of this booking, once', async () => {
  const date = '2032-05-31';
  await request('POST', '/operations/deployments', { boat_id: 'boat-trip-ids', route_id: 'r1', service_date: date, capacity: 20 });
  const mine = await request('POST', '/v1/bookings', { route_id: 'r1', service_date: date, pax: 1 });
  const other = await request('POST', '/v1/bookings', { route_id: 'r1', service_date: date, pax: 1 });
  const bookingId = (mine.json() as { id: string }).id;
  const [trip] = tripsOf(mine);
  const [foreign] = tripsOf(other);
  const patch = (trips: object[]) => request('PATCH', `/v1/bookings/${bookingId}`, { trips });

  assert.equal((await patch([{ id: 'trip_nope', route_id: 'r1', date, pax: 1 }])).statusCode, 400, 'unknown id');
  assert.equal((await patch([{ id: foreign.id, route_id: 'r1', date, pax: 1 }])).statusCode, 400, 'another booking\'s trip');
  assert.equal((await patch([{ id: trip.id, route_id: 'r1', date, pax: 1 }, { id: trip.id, route_id: 'r1', date, pax: 1 }])).statusCode, 400, 'the same id twice');
  assert.equal((await patch([{ id: 7, route_id: 'r1', date, pax: 1 }])).statusCode, 400, 'a malformed id is refused, not dropped');
  assert.equal((await request('POST', '/v1/bookings', { trips: [{ id: trip.id, route_id: 'r1', date, pax: 1 }] })).statusCode, 400, 'a new booking has no trips to name');
  assert.deepEqual(tripsOf(await request('GET', `/v1/bookings/${bookingId}`)).map((t) => t.id), [trip.id], 'a refused edit changed nothing');
});
