import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';

// Check-in (todo/trip-ops-and-vans-model.md, slice C), on whichever store DATABASE_URL selects.
const app = buildApp();
after(async () => app.close());
const send = (method: InjectOptions['method'], url: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}) });
type Checkin = { slot: number; expected: number; actual_pax: number; no_show: number; events: { pax: number; undone: unknown; tries: unknown[] }[]; updated_at: string };
async function trip(date: string, pax: object = { ad: 3 }) {
  await send('POST', '/operations/deployments', { boat_id: `ck-boat-${date}`, route_id: 'r1', service_date: date, capacity: 40 });
  const created = await send('POST', '/v1/bookings', { route_id: 'r1', service_date: date, pax });
  assert.equal(created.statusCode, 201, created.body);
  const b = created.json() as { id: string; trips: { id: string; operations: { checkins: unknown } }[] };
  assert.deepEqual(b.trips[0].operations.checkins, { van: [], pier: [] });
  return { booking: b.id, trip: b.trips[0].id };
}
const put = (tripId: string, kind: string, slot: number, body: object) => send('PUT', `/operations/trip-ops/${tripId}/checkins/${kind}/${slot}`, body);
const record = (response: { json(): { trip: { operations: { checkins: Record<string, Checkin[]> } } } }, kind = 'van') => response.json().trip.operations.checkins[kind][0];
const noShow = { type: 'no_show', pax: 1, ad: 1, reason_code: 'not_down', note: 'lobby empty', at: '06:40', by: 'Driver Somchai', ts: '2050-02-01T23:40:00Z' };

test('a record is written whole; no_show is the server\'s; nobody counts past the part\'s booking', async () => {
  const { trip: tripId } = await trip('2050-02-01');
  const written = await put(tripId, 'van', 0, { expected: 3, actual_pax: 2, no_show: 99, checked_in_at: '2050-02-01T23:45:00Z', checked_in_by: 'Somchai', reason_code: 'not_down', reason_at: '06:40', flow: 'standby' });
  assert.equal(written.statusCode, 200, written.body);
  const r = record(written);
  assert.deepEqual([r.slot, r.expected, r.actual_pax, r.no_show], [0, 3, 2, 1], 'no_show is expected − actual, whatever was sent');
  assert.ok(r.updated_at);

  for (const [kind, slot, body] of [
    ['van', 0, { actual_pax: 4 }], ['van', 0, { expected: 4 }], ['van', 0, { flow: 'asleep' }], ['van', 0, { reason_at: '6.40' }],
    ['van', 1, { actual_pax: 1 }], ['boat', 0, {}], ['van', 0, { events: [{ type: 'lost', pax: 1 }] }],
  ] as const) {
    const refused = await put(tripId, kind, slot, body);
    assert.equal(refused.statusCode, 400, `${kind}/${slot} ${JSON.stringify(body)}: ${refused.body}`);
  }
  assert.equal((await put('trip_nowhere', 'van', 0, {})).statusCode, 404);
  assert.equal((await put(tripId, 'pier', 0, { expected: 2, actual_pax: 2 })).json().trip.operations.checkins.pier.length, 1, 'the pier has its own record');
});

test('no-show events are kept: added to, marked undone once, never removed or changed', async () => {
  const { trip: tripId } = await trip('2050-02-02');
  const first = await put(tripId, 'van', 0, { expected: 3, actual_pax: 2, events: [noShow] });
  assert.equal(first.statusCode, 200, first.body);

  const removed = await put(tripId, 'van', 0, { expected: 3, actual_pax: 3, events: [] });
  assert.deepEqual([removed.statusCode, removed.json().code], [409, 'events_append_only']);
  const changed = await put(tripId, 'van', 0, { expected: 3, actual_pax: 1, events: [{ ...noShow, pax: 2 }] });
  assert.deepEqual([changed.statusCode, changed.json().code], [409, 'events_append_only']);

  const tried = await put(tripId, 'van', 0, { expected: 3, actual_pax: 2, events: [{ ...noShow, tries: [{ at: '06:50', by: 'Somchai', note: 'called again', ts: '2050-02-01T23:50:00Z' }] }] });
  assert.equal(tried.statusCode, 200, tried.body);
  assert.equal(record(tried).events[0].tries.length, 1);
  const untried = await put(tripId, 'van', 0, { expected: 3, actual_pax: 2, events: [noShow] });
  assert.deepEqual([untried.statusCode, untried.json().code], [409, 'events_append_only'], 'a try is kept too');

  const undo = { why: 'found', at: '06:55', by: 'Somchai', ts: '2050-02-01T23:55:00Z', note: 'was at the gate' };
  const tries = record(tried).events[0].tries;
  const found = await put(tripId, 'van', 0, { expected: 3, actual_pax: 3, events: [{ ...noShow, tries, undone: undo }, { ...noShow, type: 'cxl', ts: '2050-02-02T00:05:00Z' }] });
  assert.equal(found.statusCode, 200, found.body);
  assert.deepEqual(record(found).events.map((e) => e.undone !== null), [true, false]);
  const redone = await put(tripId, 'van', 0, { expected: 3, actual_pax: 2, events: [{ ...noShow, tries }, { ...noShow, type: 'cxl', ts: '2050-02-02T00:05:00Z' }] });
  assert.deepEqual([redone.statusCode, redone.json().code], [409, 'event_undone_is_final']);

  const cleared = await send('DELETE', `/operations/trip-ops/${tripId}/checkins/van/0`);
  assert.equal(cleared.statusCode, 200, cleared.body);
  assert.deepEqual(cleared.json().trip.operations.checkins.van, []);
  assert.equal((await send('DELETE', `/operations/trip-ops/${tripId}/checkins/van/0`)).statusCode, 404);
});

test('a split trip checks in per part; a moved trip loses its check-ins', async () => {
  const { booking, trip: tripId } = await trip('2050-02-03', { ad: 4 });
  const split = await send('PATCH', `/operations/trip-ops/${tripId}`, { van_parts: [{ idx: 0, ad: 3 }, { idx: 1, ad: 1 }] });
  assert.equal(split.statusCode, 200, split.body);
  assert.equal((await put(tripId, 'van', 1, { expected: 1, actual_pax: 2 })).statusCode, 400, 'part 1 booked 1');
  assert.equal((await put(tripId, 'van', 1, { expected: 1, actual_pax: 1 })).statusCode, 200);

  const moved = await send('POST', `/v1/bookings/${booking}/reschedule`, { route_id: 'r1', service_date: '2050-02-04' });
  assert.equal(moved.statusCode, 200, moved.body);
  assert.deepEqual(moved.json().trips[0].operations.checkins, { van: [], pier: [] }, 'legacy bkOpsClear');
});
