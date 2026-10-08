import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';
import { Pool } from 'pg';
import { buildApp } from '../src/app.js';
import {
  chargeLabel, editedLine, parseCancelRequest, parsePartialCancelRequest, parseRescheduleRequest, planCancel, stampActor,
} from '../src/domain/booking-actions.js';
import { claimsMoreSeats, returnDrawsFirst, type StoredTrip } from '../src/domain/operations.js';

// ── The rules on their own ───────────────────────────────────────────────────────────────────────

test('a cancel body is the full form only when it has a category; the old {reason} body still works', () => {
  assert.deepEqual(parseCancelRequest({}), { kind: 'reason', reason: undefined });
  assert.deepEqual(parseCancelRequest({ reason: ' changed plan ' }), { kind: 'reason', reason: 'changed plan' });
  assert.deepEqual(parseCancelRequest({ category: 'sick' }), { kind: 'record', category: 'sick', charge_type: 'none' });
  assert.throws(() => parseCancelRequest({ category: 'weather' }), /category must be one of customer_cancel, no_show/);
  assert.throws(() => parseCancelRequest({ category: 'other' }), /note is required when category is other/);
  assert.throws(() => parseCancelRequest({ category: 'other', note: '   ' }), /note is required when category is other/);
  assert.throws(() => parseCancelRequest({ category: 'sick', charge_type: 'partial' }), /charge_amount must be greater than 0 for a partial charge/);
  assert.throws(() => parseCancelRequest({ category: 'sick', charge_type: 'partial', charge_amount: 0 }), /greater than 0/);
  assert.throws(() => parseCancelRequest({ category: 'sick', charge_type: 'some' }), /charge_type must be one of none, full, partial/);
  assert.equal((parseCancelRequest({ category: 'sick', charge_type: 'none', charge_amount: 900 }) as { charge_amount?: number }).charge_amount, undefined, 'ignored for none');
});

test('a full charge is the total plus fee items, and the reason text is legacy\'s', () => {
  const booking = { status: 'confirmed' as const, total: 4000, fee_items: [{ amount: 500 }] };
  const plan = planCancel(booking, { kind: 'record', category: 'customer_cancel', note: 'changed plan', charge_type: 'full' }, 'ops1');
  assert.equal(plan.record?.charge_amount, 4500);
  assert.equal(plan.record?.group, 'customer');
  assert.equal(plan.cancellation_reason, 'Customer cancelled / changed plan (ลูกค้ายกเลิกเอง / เปลี่ยนแผน) · changed plan');
  assert.equal(plan.history.text, 'Cancelled · Full charge ฿4,500 · Customer cancelled / changed plan (ลูกค้ายกเลิกเอง / เปลี่ยนแผน) · changed plan');
  assert.equal(chargeLabel('partial', 1500.4), 'Charge ฿1,500');
  assert.equal(chargeLabel('none', 0), 'No charge');
});

test('updated_by comes from the token, never the body', () => {
  assert.deepEqual(stampActor({ updated_by: 'mallory', lead_pax: 'A' }, 'ops1'), { updated_by: 'ops1', lead_pax: 'A' });
  assert.deepEqual(stampActor({ updated_by: 'mallory' }, undefined), {}, 'with auth off the column is left alone');
  assert.equal(editedLine('ops1', { trips: [], header: { total: 1, updated_by: 'ops1' } }, 'confirmed').text, 'Edited · trips, total');
  assert.equal(editedLine('ops1', { status: 'confirmed' }, 'quote').tag, 'Confirmed');
});

test('partial-cancel and reschedule bodies are checked field by field', () => {
  assert.deepEqual(parsePartialCancelRequest({ pax_to_cancel: 2 }), { kind: 'count', count: 2 }, 'the old body');
  assert.throws(() => parsePartialCancelRequest({ pax: { ad: 1 } }), /trip_id is required/);
  assert.throws(() => parsePartialCancelRequest({ trip_id: 't', pax: { ad: 0 }, category: 'sick' }), /pax must remove at least one passenger/);
  assert.throws(() => parsePartialCancelRequest({ trip_id: 't', pax: { xx: 1 }, category: 'sick' }), /pax\.xx is not a passenger category/);
  assert.throws(() => parsePartialCancelRequest({ trip_id: 't', pax: { ad: 2 }, category: 'sick', waived: { count: 1, amount: 0 } }), /charged\.count \+ waived\.count must equal the 2 passengers removed/);
  assert.throws(() => parsePartialCancelRequest({ trip_id: 't', pax: { ad: 1 }, category: 'sick', waived: { count: 1, amount: -5 } }), /waived\.amount must be a non-negative number/);

  assert.deepEqual(parseRescheduleRequest({ route_id: 'r1', service_date: '2037-01-02' }), { kind: 'move', route_id: 'r1', service_date: '2037-01-02' }, 'the old body');
  assert.throws(() => parseRescheduleRequest({ from_date: '2037-01-02', to_date: '2037-01-02', reason: 'x' }), /to_date must differ from from_date/);
  assert.throws(() => parseRescheduleRequest({ from_date: '2037-01-02', to_date: '2037-1-3', reason: 'x' }), /to_date must be a YYYY-MM-DD date/);
  assert.throws(() => parseRescheduleRequest({ from_date: '2037-01-02', to_date: '2037-01-03', reason: ' ' }), /reason is required/);
  assert.throws(() => parseRescheduleRequest({ from_date: '2037-01-02', to_date: '2037-01-03', reason: 'x', collect: 'cash' }), /collect must be invoice or separate/);
});

test('a partial cancel gives lock seats back first, lowest lock id first', () => {
  assert.deepEqual(returnDrawsFirst([{ lock_id: 'lock_b', qty: 2 }, { lock_id: 'lock_a', qty: 1 }], 2), [{ lock_id: 'lock_b', qty: 1 }]);
  assert.deepEqual(returnDrawsFirst([{ lock_id: 'lock_a', qty: 1 }], 3), [], 'more removed than drawn: the rest were general seats');
});

test('only an amendment that grows asks the pool for seats', () => {
  const trip = (over: Partial<StoredTrip> = {}): StoredTrip => ({
    id: 't1', seq: 0, route_id: 'r1', service_date: '2037-01-01', booking_mode: 'seat', ovn_leg: false,
    pax: [{ category: 'ad', residency: 'unknown', count: 4 }], lock_draws: [{ lock_id: 'l1', qty: 2 }], ...over,
  });
  const pax = (count: number) => [{ category: 'ad' as const, residency: 'unknown' as const, count }];
  assert.equal(claimsMoreSeats([trip()], [trip()]), false, 'unchanged');
  assert.equal(claimsMoreSeats([trip()], [trip({ pax: pax(3), lock_draws: [{ lock_id: 'l1', qty: 1 }] })]), false, 'fewer passengers, fewer lock seats');
  assert.equal(claimsMoreSeats([trip()], [trip({ pax: pax(5) })]), true, 'more passengers');
  assert.equal(claimsMoreSeats([trip()], [trip({ lock_draws: [] })]), true, 'the same passengers moved from the lock to general seats');
  assert.equal(claimsMoreSeats([trip()], [trip({ lock_draws: [{ lock_id: 'l2', qty: 1 }] })]), true, 'a lock it did not draw on');
  assert.equal(claimsMoreSeats([trip()], [trip({ service_date: '2037-01-02' })]), true, 'moved');
  assert.equal(claimsMoreSeats([trip()], [trip({ id: 't2' })]), true, 'a new trip');
  assert.equal(claimsMoreSeats([trip(), trip({ id: 't2' })], [trip()]), false, 'a trip removed');
});

// ── Through the API, against whichever store DATABASE_URL picks ──────────────────────────────────

const app = buildApp();
const url = process.env.DATABASE_URL;
const pool = url ? new Pool({ connectionString: url }) : undefined;
after(async () => { await app.close(); await pool?.end(); });

async function request(method: InjectOptions['method'], path: string, payload?: object) {
  return payload === undefined ? app.inject({ method, url: path }) : app.inject({ method, url: path, payload });
}
const deploy = (route: string, date: string, capacity: number, boat = `boat-act-${route}-${date}`) =>
  request('POST', '/operations/deployments', { boat_id: boat, route_id: route, service_date: date, capacity });
// B2C (agent a_b2c): its price stays as sent, so these tests can state the total the actions work from.
async function create(payload: object): Promise<Record<string, any>> {
  const response = await request('POST', '/v1/bookings', { agent_id: 'a_b2c', ...payload });
  assert.equal(response.statusCode, 201, response.body);
  return response.json();
}
const history = async (id: string) => (await request('GET', `/v1/bookings/${id}/history`)).json().history as { kind: string; tag: string; text: string; by: string | null }[];
const seatsLeft = async (route: string, date: string) => (await request('GET', `/v1/availability?route_id=${route}&date=${date}`)).json().available_seats as number;

test('every write appends one history line, oldest first', async () => {
  const [day, later] = ['2037-01-05', '2037-01-06'];
  await deploy('r1', day, 30); await deploy('r1', later, 30);
  const booking = await create({ route_id: 'r1', service_date: day, pax: { ad: 4 }, total: 8000 });
  const tripId = booking.trips[0].id as string;

  assert.equal((await request('PATCH', `/v1/bookings/${booking.id}`, { total: 9000, lead_pax: 'Somchai' })).statusCode, 200);
  assert.equal((await request('POST', `/v1/bookings/${booking.id}/partial-cancel`, { trip_id: tripId, pax: { ad: 1 }, category: 'sick', waived: { count: 1, amount: 2000 } })).statusCode, 200);
  assert.equal((await request('POST', `/v1/bookings/${booking.id}/reschedule`, { from_date: day, to_date: later, reason: 'customer request' })).statusCode, 200);
  assert.equal((await request('POST', `/v1/bookings/${booking.id}/cancel`, { category: 'no_show' })).statusCode, 200);
  assert.equal((await request('POST', `/v1/bookings/${booking.id}/restore`)).statusCode, 200);

  const lines = await history(booking.id);
  assert.deepEqual(lines.map((l) => [l.kind, l.tag]), [
    ['create', 'Created'], ['edit', 'Edited'], ['cancel', 'Cancel'], ['reschedule', 'Reschedule'], ['cancel', 'Cancel'], ['edit', 'Confirmed'],
  ]);
  assert.equal(lines[1].text, 'Edited · lead_pax, total');
  assert.equal(lines[2].text, 'Partial cancel · −1 pax · Sick / health (ป่วย / เหตุสุขภาพ) · charge 0 (฿0) · waive 1 (฿2,000)');
  assert.equal(lines[3].text, `Rescheduled ${day} → ${later} · No charge · customer request`);
  assert.equal(lines[5].text, 'Restored');
  assert.equal(lines[0].by, null, 'no token, no actor (auth is off in this file)');

  assert.equal((await request('GET', '/v1/bookings/booking_missing/history')).statusCode, 404);
});

test('cancel records the category and charge, and refuses a booking that is already closed', async () => {
  const day = '2037-01-08';
  await deploy('r1', day, 30);
  const booking = await create({ route_id: 'r1', service_date: day, pax: 2, total: 3000 });

  assert.equal((await request('POST', `/v1/bookings/${booking.id}/cancel`, { category: 'other' })).statusCode, 400, 'other needs a note');
  const cancelled = await request('POST', `/v1/bookings/${booking.id}/cancel`, { category: 'flight_visa', note: 'visa refused', charge_type: 'partial', charge_amount: 1500 });
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  const body = cancelled.json();
  assert.equal(body.status, 'cancelled');
  assert.equal(body.cancellation_reason, 'Flight / visa / documents (ไฟลท์ / วีซ่า / เอกสาร) · visa refused');
  const { at, ...record } = body.cancellation;
  assert.deepEqual(record, { category: 'flight_visa', group: 'customer', note: 'visa refused', charge_type: 'partial', charge_amount: 1500, by: null });
  assert.ok(!Number.isNaN(Date.parse(at)) && at.endsWith('Z'), 'an ISO instant, the same in both stores');
  assert.deepEqual((await request('GET', `/v1/bookings/${booking.id}`)).json().cancellation, body.cancellation, 'the read answers what the write stored');

  const again = await request('POST', `/v1/bookings/${booking.id}/cancel`, { category: 'no_show' });
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().message, 'Booking is already cancelled');

  // Reached through the commands that close a booking. (`completed` only comes from legacy's import.)
  for (const [status, discount, command] of [['cancelled_weather', 0, 'cancel-weather'], ['rejected', -500, 'reject']] as const) {
    const closed = await create({ route_id: 'r1', service_date: day, pax: 1, ...(discount ? { price_discount: discount } : {}) });
    assert.equal((await request('POST', `/v1/bookings/${closed.id}/${command}`)).json().status, status);
    assert.equal((await request('POST', `/v1/bookings/${closed.id}/cancel`, { category: 'no_show' })).statusCode, 409, status);
  }

  const old = await create({ route_id: 'r1', service_date: day, pax: 1 });
  const oldCancel = await request('POST', `/v1/bookings/${old.id}/cancel`, { reason: 'changed plan' });
  assert.equal(oldCancel.statusCode, 200);
  assert.equal(oldCancel.json().cancellation_reason, 'changed plan');
  assert.equal(oldCancel.json().cancellation, undefined, 'the old body writes no record');
});

test('a full cancel charge is the total plus the fee items', async () => {
  const [day, later] = ['2037-01-09', '2037-01-10'];
  await deploy('r1', day, 30); await deploy('r1', later, 30);
  const booking = await create({ route_id: 'r1', service_date: day, pax: 2, total: 3000 });
  const moved = await request('POST', `/v1/bookings/${booking.id}/reschedule`, { from_date: day, to_date: later, reason: 'storm', charge_type: 'partial', charge_amount: 500 });
  assert.equal(moved.statusCode, 200, moved.body);
  const cancelled = await request('POST', `/v1/bookings/${booking.id}/cancel`, { category: 'customer_cancel', charge_type: 'full' });
  assert.equal(cancelled.json().cancellation.charge_amount, 3500);
  assert.equal(cancelled.json().total, 3000, 'the price itself is untouched');
});

test('restore confirms a cancelled booking and clears its cancellation', async () => {
  const day = '2037-01-12';
  await deploy('r1', day, 30);
  const booking = await create({ route_id: 'r1', service_date: day, pax: 2 });
  const refused = await request('POST', `/v1/bookings/${booking.id}/restore`);
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().code, 'not_cancelled');

  await request('POST', `/v1/bookings/${booking.id}/cancel`, { category: 'sick' });
  const restored = await request('POST', `/v1/bookings/${booking.id}/restore`);
  assert.equal(restored.statusCode, 200, restored.body);
  assert.equal(restored.json().status, 'confirmed');
  assert.equal(restored.json().cancellation_reason, undefined);
  assert.equal(restored.json().cancellation, undefined);
  assert.deepEqual(restored.json().warnings, []);
  assert.equal(await seatsLeft('r1', day), 28, 'it holds its seats again');

  // A discount on a confirm waits for approval; rejecting that is the way to a rejected booking.
  const waiting = await create({ route_id: 'r1', service_date: day, pax: 1, price_discount: -500 });
  const rejected = (await request('POST', `/v1/bookings/${waiting.id}/reject`)).json();
  assert.equal(rejected.status, 'rejected');
  assert.equal((await request('POST', `/v1/bookings/${rejected.id}/restore`)).json().status, 'confirmed', 'rejected is restorable too, to confirmed');
});

test('restore redraws what a lock still has and takes the rest from general seats', async () => {
  const day = '2037-01-13';
  await deploy('r3', day, 10);
  const lock = (await request('POST', '/v1/seat-locks', { route_id: 'r3', service_date: day, pax: 4 })).json();
  const booking = await create({ trips: [{ route_id: 'r3', date: day, pax: 3, lock_draws: { [lock.id]: 3 } }] });
  await request('POST', `/v1/bookings/${booking.id}/cancel`, { category: 'sick' });
  await create({ trips: [{ route_id: 'r3', date: day, pax: 3, lock_draws: { [lock.id]: 3 } }] });

  const restored = await request('POST', `/v1/bookings/${booking.id}/restore`);
  assert.equal(restored.statusCode, 200, restored.body);
  assert.deepEqual(restored.json().warnings, [{ code: 'lock_short', trip_id: booking.trips[0].id, lock_id: lock.id, wanted: 3, got: 1 }]);
  assert.deepEqual(restored.json().trips[0].lock_draws, { [lock.id]: 1 });
  assert.equal(await seatsLeft('r3', day), 4, '10 - 6 booked; the lock has nothing left');
  assert.match((await history(booking.id)).at(-1)!.text, new RegExp(`^Restored · seat lock ${lock.id}: 1/3 seats back$`));
});

test('restore is refused when general seats cannot take the rest either', async () => {
  const day = '2037-01-14';
  await deploy('r3', day, 6);
  const lock = (await request('POST', '/v1/seat-locks', { route_id: 'r3', service_date: day, pax: 3 })).json();
  const booking = await create({ trips: [{ route_id: 'r3', date: day, pax: 3, lock_draws: { [lock.id]: 3 } }] });
  await request('POST', `/v1/bookings/${booking.id}/cancel`, { category: 'sick' });
  await create({ trips: [{ route_id: 'r3', date: day, pax: 6, lock_draws: { [lock.id]: 3 } }] });
  const refused = await request('POST', `/v1/bookings/${booking.id}/restore`);
  assert.equal(refused.statusCode, 409);
  assert.equal((await request('GET', `/v1/bookings/${booking.id}`)).json().status, 'cancelled', 'nothing changed');
});

test('restoring a charter whose boat another charter now holds is refused', async () => {
  const day = '2037-01-15';
  await deploy('r2', day, 20, 'boat-act-charter');
  const charter = { trips: [{ route_id: 'r2', date: day, booking_mode: 'charter', charter_boat_id: 'boat-act-charter', pax: 6 }] };
  const first = await create(charter);
  await request('POST', `/v1/bookings/${first.id}/cancel`, { category: 'agent_error' });
  await create(charter);
  const refused = await request('POST', `/v1/bookings/${first.id}/restore`);
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().code, 'charter_boat_taken');
  assert.equal(refused.json().message, `Boat boat-act-charter is chartered by another booking on ${day}`);
});

test('a partial cancel takes named passengers off one trip of several, lock seats first', async () => {
  const [day1, day2] = ['2037-02-01', '2037-02-02'];
  await deploy('r3', day1, 20); await deploy('r3', day2, 20);
  const lock = (await request('POST', '/v1/seat-locks', { route_id: 'r3', service_date: day2, pax: 2 })).json();
  const booking = await create({ total: 10000, trips: [
    { route_id: 'r3', date: day1, pax: { ad_fr: 2 } },
    { route_id: 'r3', date: day2, pax: { ad_fr: 2, chd_th: 2 }, lock_draws: { [lock.id]: 2 } },
  ] });
  const second = booking.trips[1].id as string;
  const response = await request('POST', `/v1/bookings/${booking.id}/partial-cancel`, {
    trip_id: second, pax: { ad_fr: 1, chd_th: 1 }, category: 'sick', note: 'fever',
    charged: { count: 1, amount: 1500 }, waived: { count: 1, amount: 1200 },
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.deepEqual(body.trips.map((t: { pax: object }) => t.pax), [{ ad_fr: 2 }, { ad_fr: 1, chd_th: 1 }], 'only the named trip changed');
  assert.deepEqual(body.trips[1].lock_draws, {}, 'both removed seats went back to the lock');
  assert.equal(body.total, 8800, 'the waived amount is refunded; the charged amount is a fee and leaves total alone');
  const { at, ...record } = body.partial_cancels[0];
  assert.deepEqual(record, {
    trip_id: second, service_date: day2, pax_removed: { ad_fr: 1, chd_th: 1 }, count: 2, category: 'sick', group: 'customer', note: 'fever',
    charged: { count: 1, amount: 1500 }, waived: { count: 1, amount: 1200 }, by: null,
  });
  assert.ok(at.endsWith('Z'));
  assert.equal((await request('GET', `/v1/seat-locks?route_id=r3&date=${day2}`)).json().seat_locks[0].drawn_pax, 0);
  assert.equal((await history(booking.id)).at(-1)!.text, 'Partial cancel · −2 pax · Sick / health (ป่วย / เหตุสุขภาพ) · charge 1 (฿1,500) · waive 1 (฿1,200) · fever');
});

test('a partial cancel is refused when it would empty the trip or names what the trip does not hold', async () => {
  const day = '2037-02-03';
  await deploy('r3', day, 20);
  const booking = await create({ trips: [{ route_id: 'r3', date: day, pax: { ad: 2 } }] });
  const trip = booking.trips[0].id as string;
  const send = (body: object) => request('POST', `/v1/bookings/${booking.id}/partial-cancel`, { trip_id: trip, category: 'sick', ...body });
  const emptied = await send({ pax: { ad: 2 }, waived: { count: 2, amount: 0 } });
  assert.equal(emptied.statusCode, 400);
  assert.equal(emptied.json().message, 'trips[0] would have no passengers; cancel the booking instead');
  assert.equal((await send({ pax: { ad: 3 }, waived: { count: 3, amount: 0 } })).statusCode, 400);
  assert.equal((await send({ pax: { chd: 1 }, waived: { count: 1, amount: 0 } })).statusCode, 400);
  assert.equal((await send({ trip_id: 'trip_missing', pax: { ad: 1 }, waived: { count: 1, amount: 0 } })).statusCode, 404);
  await request('POST', `/v1/bookings/${booking.id}/cancel`, {});
  assert.equal((await send({ pax: { ad: 1 }, waived: { count: 1, amount: 0 } })).statusCode, 409, 'a cancelled booking');
});

test('taking passengers off an oversold day succeeds, by partial cancel and by PATCH', async () => {
  const day = '2037-02-04';
  await deploy('r3', day, 10, 'boat-act-oversold');
  const booking = await create({ trips: [{ route_id: 'r3', date: day, pax: { ad: 8 } }] });
  await deploy('r3', day, 4, 'boat-act-oversold');
  assert.equal(await seatsLeft('r3', day), -4, 'the day is now oversold, the way the import can bring it over');
  const trip = booking.trips[0].id as string;
  const partial = await request('POST', `/v1/bookings/${booking.id}/partial-cancel`, { trip_id: trip, pax: { ad: 1 }, category: 'operator', waived: { count: 1, amount: 0 } });
  assert.equal(partial.statusCode, 200, partial.body);
  const patched = await request('PATCH', `/v1/bookings/${booking.id}`, { trips: [{ id: trip, route_id: 'r3', date: day, pax: { ad: 6 } }] });
  assert.equal(patched.statusCode, 200, patched.body);
  assert.equal((await request('PATCH', `/v1/bookings/${booking.id}`, { trips: [{ id: trip, route_id: 'r3', date: day, pax: { ad: 7 } }] })).statusCode, 409, 'adding one back still needs room');
});

test('the old partial-cancel and reschedule bodies still work', async () => {
  const [day, later] = ['2037-02-05', '2037-02-06'];
  await deploy('r1', day, 20); await deploy('r1', later, 20);
  const booking = await create({ route_id: 'r1', service_date: day, pax: 4 });
  const reduced = await request('POST', `/v1/bookings/${booking.id}/partial-cancel`, { pax_to_cancel: 1 });
  assert.equal(reduced.statusCode, 200, reduced.body);
  assert.equal(reduced.json().pax, 3);
  assert.deepEqual(reduced.json().partial_cancels, [], 'no record without a reason');
  const moved = await request('POST', `/v1/bookings/${booking.id}/reschedule`, { route_id: 'r1', service_date: later });
  assert.equal(moved.statusCode, 200, moved.body);
  assert.equal(moved.json().service_date, later);
  assert.deepEqual((await history(booking.id)).slice(1).map((l) => l.text), ['Partial cancel · −1 pax', `Rescheduled ${day} → ${later}`]);
});

test('a reschedule moves every trip on from_date and none other, and returns its lock seats', async () => {
  const [d1, d2, to] = ['2037-03-01', '2037-03-02', '2037-03-05'];
  for (const date of [d1, d2, to]) { await deploy('r3', date, 20); await deploy('r4', date, 20); }
  const lock = (await request('POST', '/v1/seat-locks', { route_id: 'r3', service_date: d1, pax: 2 })).json();
  const booking = await create({ total: 6000, trips: [
    { route_id: 'r3', date: d1, pax: 2, lock_draws: { [lock.id]: 2 } },
    { route_id: 'r4', date: d1, pax: 2 },
    { route_id: 'r3', date: d2, pax: 2 },
  ] });
  const response = await request('POST', `/v1/bookings/${booking.id}/reschedule`, { from_date: d1, to_date: to, reason: 'customer request', charge_type: 'partial', charge_amount: 400, collect: 'separate' });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.deepEqual(body.trips.map((t: { route_id: string; service_date: string }) => [t.route_id, t.service_date]), [['r3', to], ['r4', to], ['r3', d2]]);
  assert.deepEqual(body.trips.map((t: { id: string }) => t.id), booking.trips.map((t: { id: string }) => t.id), 'the trips keep their ids');
  assert.deepEqual(body.trips[0].lock_draws, {}, 'the lock stays on the old day');
  assert.equal((await request('GET', `/v1/seat-locks?route_id=r3&date=${d1}`)).json().seat_locks[0].drawn_pax, 0);
  const { at, ...record } = body.reschedules[0];
  assert.deepEqual(record, { from_date: d1, to_date: to, reason: 'customer request', charge_type: 'partial', charge_amount: 400, collect: 'separate', by: null });
  assert.deepEqual(body.fee_items, [], 'collected separately: no fee item');
  assert.equal(body.total, 6000, 'the price stands');
  assert.equal((await history(booking.id)).at(-1)!.text, `Rescheduled ${d1} → ${to} · Charge ฿400 · paid separately · 2 lock seats returned · customer request`);

  assert.equal((await request('POST', `/v1/bookings/${booking.id}/reschedule`, { from_date: d1, to_date: to, reason: 'again' })).statusCode, 400, 'nothing left on that day');
});

test('a reschedule fee collected on the invoice becomes a fee item; a full day refuses the move', async () => {
  const [day, full, open] = ['2037-03-10', '2037-03-11', '2037-03-12'];
  await deploy('r1', day, 20); await deploy('r1', full, 2); await deploy('r1', open, 20);
  const booking = await create({ route_id: 'r1', service_date: day, pax: 3, total: 4500 });
  const refused = await request('POST', `/v1/bookings/${booking.id}/reschedule`, { from_date: day, to_date: full, reason: 'x' });
  assert.equal(refused.statusCode, 409);
  assert.equal((await request('GET', `/v1/bookings/${booking.id}`)).json().reschedules.length, 0, 'nothing recorded');

  const moved = await request('POST', `/v1/bookings/${booking.id}/reschedule`, { from_date: day, to_date: open, reason: 'storm', charge_type: 'full' });
  assert.equal(moved.statusCode, 200, moved.body);
  const [fee] = moved.json().fee_items;
  assert.deepEqual({ ...fee, at: undefined }, { type: 'reschedule', label: `Reschedule fee · ${day} → ${open} · storm`, amount: 4500, at: undefined });
  assert.equal(moved.json().reschedules[0].collect, 'invoice');
});

test('a charter keeps its boat when rescheduled', async () => {
  const [day, to] = ['2037-03-20', '2037-03-21'];
  await deploy('r2', day, 20, 'boat-act-move'); await deploy('r2', to, 20, 'boat-act-move');
  const booking = await create({ trips: [{ route_id: 'r2', date: day, booking_mode: 'charter', charter_boat_id: 'boat-act-move', pax: 8 }] });
  const moved = await request('POST', `/v1/bookings/${booking.id}/reschedule`, { from_date: day, to_date: to, reason: 'weather window' });
  assert.equal(moved.statusCode, 200, moved.body);
  assert.equal(moved.json().trips[0].charter_boat_id, 'boat-act-move');
  assert.equal(await seatsLeft('r2', day), 20, 'the old day has its boat back');
  assert.equal(await seatsLeft('r2', to), 0, 'the new day lost it');
});

test('a reschedule clears the moved trip\'s day-of-operations data', { skip: !url && 'PostgreSQL only: the in-process store holds no trip operations' }, async () => {
  const [day, to] = ['2037-03-25', '2037-03-26'];
  await deploy('r1', day, 20); await deploy('r1', to, 20);
  const booking = await create({ route_id: 'r1', service_date: day, pax: 2 });
  const trip = booking.trips[0].id as string;
  await pool!.query(`INSERT INTO booking_trip_operations (booking_trip_id, pickup_time_final) VALUES ($1, '07:15')`, [trip]);
  assert.equal((await request('POST', `/v1/bookings/${booking.id}/reschedule`, { from_date: day, to_date: to, reason: 'x' })).statusCode, 200);
  assert.equal((await pool!.query('SELECT count(*)::int AS n FROM booking_trip_operations WHERE booking_trip_id = $1', [trip])).rows[0].n, 0);
});

test('a reschedule or partial cancel is refused on a closed booking', async () => {
  // `completed` is closed too, but only legacy's import writes it: no command reaches it.
  const day = '2037-03-28';
  await deploy('r1', day, 20);
  const closed = await create({ route_id: 'r1', service_date: day, pax: 2 });
  await request('POST', `/v1/bookings/${closed.id}/cancel`, { category: 'sick' });
  assert.equal((await request('POST', `/v1/bookings/${closed.id}/reschedule`, { from_date: day, to_date: '2037-03-29', reason: 'x' })).statusCode, 409);
  assert.equal((await request('POST', `/v1/bookings/${closed.id}/partial-cancel`, { trip_id: closed.trips[0].id, pax: { ad: 1 }, category: 'sick', waived: { count: 1, amount: 0 } })).statusCode, 409);
});
