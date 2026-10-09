import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { OperationsStore } from '../src/domain/operations.js';
import { createStore } from '../src/routes/operations.js';

// Pickup areas and pickup times (todo/booking-extras-model.md §4), on whichever store DATABASE_URL
// selects. Route r1 comes from migration 006; the in-process store is seeded with it.
const store = createStore();
if (store instanceof OperationsStore) store.seedCatalogue({ routes: [{ id: 'r1', name: 'Tratato', pier: 'tublamu' }] });
const app = buildApp({ store });
after(async () => app.close());
const send = (method: InjectOptions['method'], url: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}) });
const newArea = async (name: string, zone: string, group: string) => {
  const r = await send('POST', '/v1/pickup-areas', { name, zone, time_group: group });
  assert.equal(r.statusCode, 201, r.body);
  return r.json() as { id: string; zone: string; active: boolean };
};
const newProfile = async (name: string, from: string | null, to: string | null, extra: object = {}) => {
  const r = await send('POST', '/v1/pickup-time-profiles', { name, from_date: from, to_date: to, ...extra });
  assert.equal(r.statusCode, 201, r.body);
  return r.json() as { id: string; times: unknown[] };
};
const cell = (profile: string, target: string, body: object) => send('PUT', `/v1/pickup-time-profiles/${profile}/times/r1/${target}`, body);
const lookup = (area: string, date: string) => send('GET', `/v1/pickup-time?route_id=r1&area_id=${area}&date=${date}`);

test('an area gets legacy\'s id, which never changes; deleting makes it inactive', async () => {
  const a = await newArea('Kata Noi Test', 'PK', 'T-KATA');
  assert.equal(a.id, 'pk-kata-noi-test');
  assert.equal((await newArea('Kata Noi Test', 'PK', 'T-KATA')).id, 'pk-kata-noi-test-2', 'a clash numbers on');
  const moved = await send('PATCH', `/v1/pickup-areas/${a.id}`, { zone: 'KL', name: 'Renamed' });
  assert.deepEqual([moved.json().id, moved.json().zone], [a.id, 'KL']);
  const gone = await send('DELETE', `/v1/pickup-areas/${a.id}`);
  assert.equal(gone.json().active, false);
  assert.ok(!(await send('GET', '/v1/pickup-areas?active=true')).json().areas.some((x: { id: string }) => x.id === a.id));
  for (const bad of [{ zone: 'PK', time_group: 'X' }, { name: 'X', zone: 'XX', time_group: 'X' }, { name: 'X', zone: 'PK' }]) {
    assert.equal((await send('POST', '/v1/pickup-areas', bad)).statusCode, 400, JSON.stringify(bad));
  }
});

test('legacy\'s lookup: the narrowest profile covering the date, the area then its time group, then the fallback', async () => {
  const area = await newArea('Lookup Bay', 'PK', 'T-LOOK');
  const wide = await newProfile('Wide 2052', '2052-01-01', '2052-12-31');
  const narrow = await newProfile('Narrow 2052', '2052-06-01', '2052-06-30');
  const fallback = await newProfile('Old table', null, null);
  assert.equal((await cell(wide.id, area.id, { pickup_time: '07:00', pickup_time_end: '07:15' })).statusCode, 200);
  assert.equal((await cell(narrow.id, 'T-LOOK', { pickup_time_end: '08:30', pickup_at_pier: true })).statusCode, 200, 'a time group, and a pier deadline');
  assert.equal((await cell(fallback.id, 'T-LOOK', { pickup_time: '06:00' })).statusCode, 200);

  assert.deepEqual((await lookup(area.id, '2052-03-01')).json(), { pickup_time: '07:00', pickup_time_end: '07:15', profile_id: wide.id, target: area.id });
  assert.deepEqual((await lookup(area.id, '2052-06-10')).json(), { pickup_time_end: '08:30', pickup_at_pier: true, profile_id: narrow.id, target: 'T-LOOK' }, 'the narrowest wins');
  assert.equal((await lookup(area.id, '2053-01-01')).json().profile_id, fallback.id, 'no profile covers it: the fallback');

  for (const bad of [{ pickup_time: '7am' }, { pickup_time: '08:00', pickup_time_end: '07:00' }, {}]) {
    assert.equal((await cell(wide.id, area.id, bad)).statusCode, 400, JSON.stringify(bad));
  }
  assert.equal((await cell(wide.id, 'nowhere', { pickup_time: '07:00' })).statusCode, 400);
  const clone = await newProfile('Clone 2053', '2053-01-01', '2053-12-31', { clone_from: wide.id });
  assert.equal(clone.times.length, (await send('GET', `/v1/pickup-time-profiles/${wide.id}`)).json().times.length, 'a clone copies the times');
  assert.equal((await send('DELETE', `/v1/pickup-time-profiles/${clone.id}`)).statusCode, 204);

  const sibling = await newArea('Lookup Bay East', 'PK', 'T-LOOK');
  assert.equal((await lookup(sibling.id, '2052-03-01')).json().pickup_time, '07:00', 'a new area takes its time group\'s times (legacy _psuInheritTimesForArea)');
});

test('a booking\'s area must exist; a trip sent without a pickup time or zone gets the area\'s', async () => {
  const area = await newArea('Booking Beach', 'KL', 'T-BOOK');
  const profile = await newProfile('Booking 2054', '2054-01-01', '2054-12-31');
  await cell(profile.id, area.id, { pickup_time: '06:40', pickup_time_end: '06:55' });
  const date = '2054-02-01';
  await send('POST', '/operations/deployments', { boat_id: 'pa-boat', route_id: 'r1', service_date: date, capacity: 40 });
  const unknown = await send('POST', '/v1/bookings', { route_id: 'r1', service_date: date, pax: 2, pickup_area_id: 'pk-nowhere' });
  assert.equal(unknown.statusCode, 400);
  assert.match(unknown.json().message, /pk-nowhere is not a pickup area/);

  const filled = await send('POST', '/v1/bookings', { pickup_area_id: area.id, trips: [{ route_id: 'r1', date, pax: 2 }] });
  assert.equal(filled.statusCode, 201, filled.body);
  const trip = filled.json().trips[0];
  assert.deepEqual([trip.pickup_time, trip.pickup_time_end, trip.zone], ['06:40', '06:55', 'KL']);
  const sent = await send('POST', '/v1/bookings', { pickup_area_id: area.id, trips: [{ route_id: 'r1', date, pax: 2, pickup_time: '09:00', zone: 'PK' }] });
  assert.deepEqual([sent.json().trips[0].pickup_time, sent.json().trips[0].zone], ['09:00', 'PK'], 'never overwritten (decision D1)');
});
