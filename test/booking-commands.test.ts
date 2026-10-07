import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { createHeader, planStatusCommand, stripServerOwned } from '../src/domain/booking-actions.js';

// The server decides a booking's status and who created and confirmed it (CLAUDE.md, "Authority").
// Every refusal here is tested with a wrong value, and the legacy integration's whole-booking echo
// must keep working. Runs against whichever store DATABASE_URL selects.
const app = buildApp();
after(async () => { await app.close(); });

async function request(method: InjectOptions['method'], url: string, payload?: object) {
  return payload === undefined ? app.inject({ method, url }) : app.inject({ method, url, payload });
}
const refused = (fn: () => unknown, status: number, pattern: RegExp) =>
  assert.throws(fn, (error: Error & { statusCode?: number }) => error.statusCode === status && pattern.test(error.message), `expected ${status} ${pattern}`);

let boat = 0;
/** A route-day with room, and a booking on it. */
async function booked(date: string, payload: object = {}) {
  await request('POST', '/operations/deployments', { boat_id: `boat-cmd-${++boat}`, route_id: 'r2', service_date: date, capacity: 20 });
  const created = await request('POST', '/v1/bookings', { trips: [{ routeId: 'r2', date, pax: { ad: 2 } }], ...payload });
  assert.equal(created.statusCode, 201, created.body);
  return created.json();
}
const seatsLeft = async (date: string) => (await request('GET', `/v1/availability?route_id=r2&date=${date}`)).json().available_seats;

// ── The rules, as pure functions ─────────────────────────────────────────────────────────────────

test('a PATCH may echo a server-owned value, never change it', () => {
  const stored = { status: 'confirmed' as const, booked_at: '2026-10-07T02:00:00.000Z', created_by: 'ops1', confirmed_at: '2026-10-07T02:00:00.000Z' };
  assert.deepEqual(stripServerOwned({ status: 'confirmed', header: { lead_pax: 'A', created_by: 'ops1', booked_at: '2026-10-07T09:00:00+07:00' } }, stored),
    { header: { lead_pax: 'A' } }, 'the same values, the same instant in another zone: accepted and dropped');
  assert.deepEqual(stripServerOwned({ header: { confirmed_by: null } }, stored), { header: {} }, 'empty against empty is the same');
  refused(() => stripServerOwned({ status: 'cancelled' }, stored), 400, /^status cannot be changed with PATCH: use POST \/v1\/bookings\/\{id\}\/confirm/);
  refused(() => stripServerOwned({ header: { created_by: 'mallory' } }, stored), 400, /^created_by cannot be changed with PATCH/);
  refused(() => stripServerOwned({ header: { booked_at: '2026-01-01T00:00:00Z' } }, stored), 400, /^booked_at cannot be changed/);
  refused(() => stripServerOwned({ header: { confirmed_by: 'mallory' } }, stored), 400, /^confirmed_by cannot be changed/);
});

test('a create stamps who and when, and refuses a body that claims them', () => {
  const now = '2026-10-07T03:00:00.000Z';
  // Who confirmed is stamped by the store, once it has decided the status (`confirmationStamp`).
  assert.deepEqual(createHeader({ lead_pax: 'A' }, 'ops1', now), { lead_pax: 'A', booked_at: now, created_by: 'ops1', updated_by: 'ops1' });
  assert.deepEqual(createHeader({}, undefined, now), { booked_at: now }, 'authentication off: no user to stamp');
  assert.equal(createHeader({ created_by: 'ops1' }, 'ops1', now).created_by, 'ops1', 'repeating the logged-in user is fine');
  refused(() => createHeader({ created_by: 'agent-desk' }, 'ops1', now), 400, /^created_by cannot be set: it is the logged-in user/);
  refused(() => createHeader({ booked_at: now }, 'ops1', now), 400, /^booked_at cannot be set/);
  refused(() => createHeader({ confirmed_by: 'boss' }, 'ops1', now), 400, /^confirmed_by cannot be set/);
});

test('each command is allowed only from the statuses legacy allows it from', () => {
  const trips = [{ pax: [{ category: 'ad' as const, residency: 'unknown' as const, count: 2 }] }];
  const withFoc = [{ pax: [...trips[0].pax, { category: 'foc' as const, residency: 'foreign' as const, count: 1 }] }];
  assert.equal(planStatusCommand('confirm', { status: 'quote', trips }, {}, 'ops1').status, 'confirmed');
  assert.equal(planStatusCommand('confirm', { status: 'draft', trips: withFoc, foc_reason: 'guide' }, {}, 'ops1').status, 'pending_foc', 'free passengers wait for an FOC approval');
  assert.equal(planStatusCommand('approve', { status: 'pending_foc', trips: withFoc }, {}, 'ops1').history[0].text, 'FOC approved · 1 pax · booking confirmed');
  assert.equal(planStatusCommand('approve', { status: 'pending_approval', trips, confirmed_at: '2026-01-01T00:00:00Z' }, {}, 'ops1').confirms, false,
    'a booking confirmed before keeps its first confirmation');
  assert.equal(planStatusCommand('reject', { status: 'pending_approval', trips }, { note: 'no boat' }, 'ops1').history[0].text, 'Rejected · no boat');
  refused(() => planStatusCommand('confirm', { status: 'confirmed', trips }, {}, 'ops1'), 409, /^Cannot confirm a confirmed booking: confirm applies to draft, quote, pending$/);
  refused(() => planStatusCommand('approve', { status: 'quote', trips }, {}, 'ops1'), 409, /^Cannot approve a quote booking/);
  refused(() => planStatusCommand('reject', { status: 'confirmed', trips }, {}, 'ops1'), 409, /^Cannot reject a confirmed booking/);
  refused(() => planStatusCommand('cancel-weather', { status: 'cancelled', trips }, {}, 'ops1'), 409, /already cancelled/);
  refused(() => planStatusCommand('cancel-weather', { status: 'completed', trips }, {}, 'ops1'), 409, /Cannot cancel a completed booking/);
});

// ── Through the API ──────────────────────────────────────────────────────────────────────────────

test('legacy\'s whole-booking save still works: an echo of the stored values is accepted', async () => {
  const booking = await booked('2038-01-05', { leadPax: 'Somchai' });
  assert.ok(booking.booked_at, 'booked_at is stamped by the server');
  // Everything sent back as it was read, plus one real change.
  const echo = { status: booking.status, bookedAt: booking.booked_at, confirmedAt: booking.confirmed_at, createdBy: booking.created_by ?? null, leadPax: 'Somchai R.' };
  const saved = await request('PATCH', `/v1/bookings/${booking.id}`, echo);
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().lead_pax, 'Somchai R.');
  assert.equal(saved.json().booked_at, booking.booked_at, 'unchanged');
});

test('a PATCH that changes the status or a server-set field is refused, naming the command to use', async () => {
  const booking = await booked('2038-01-06');
  const status = await request('PATCH', `/v1/bookings/${booking.id}`, { status: 'pending_approval' });
  assert.equal(status.statusCode, 400);
  assert.match(status.json().message, /^status cannot be changed with PATCH: use POST \/v1\/bookings\/\{id\}\/confirm, \/approve, \/reject, \/cancel, \/cancel-weather or \/restore$/);
  assert.equal((await request('PATCH', `/v1/bookings/${booking.id}`, { confirmedBy: 'boss' })).statusCode, 400);
  assert.equal((await request('PATCH', `/v1/bookings/${booking.id}`, { bookedAt: '2020-01-01T00:00:00Z' })).statusCode, 400);
  assert.equal((await request('GET', `/v1/bookings/${booking.id}`)).json().status, 'confirmed', 'nothing changed');
});

test('a create refuses the fields the server sets', async () => {
  await request('POST', '/operations/deployments', { boat_id: 'boat-cmd-create', route_id: 'r2', service_date: '2038-01-07', capacity: 20 });
  const base = { trips: [{ routeId: 'r2', date: '2038-01-07', pax: { ad: 1 } }] };
  for (const [field, value] of [['bookedAt', '2026-10-07T03:00:00Z'], ['confirmedBy', 'boss'], ['confirmedAt', '2026-10-07T03:00:00Z'], ['createdBy', 'agent-desk']]) {
    const response = await request('POST', '/v1/bookings', { ...base, [field]: value });
    assert.equal(response.statusCode, 400, `${field}: ${response.body}`);
  }
  assert.equal((await request('POST', '/v1/bookings', { ...base, createdBy: '', confirmedAt: null })).statusCode, 201, 'empty values claim nothing');
});

test('a closed booking cannot be edited', async () => {
  const booking = await booked('2038-01-08');
  await request('POST', `/v1/bookings/${booking.id}/cancel`);
  const edit = await request('PATCH', `/v1/bookings/${booking.id}`, { notes: 'too late' });
  assert.equal(edit.statusCode, 409);
  assert.equal(edit.json().code, 'booking_closed');
});

test('confirm moves a quote to confirmed, or to pending_foc when it carries free passengers', async () => {
  const quote = await booked('2038-01-09', { intent: 'quote' });
  const confirmed = await request('POST', `/v1/bookings/${quote.id}/confirm`);
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  assert.equal(confirmed.json().status, 'confirmed');
  assert.ok(confirmed.json().confirmed_at, 'stamped');
  const again = await request('POST', `/v1/bookings/${quote.id}/confirm`);
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().code, 'wrong_status');

  await request('POST', '/operations/deployments', { boat_id: 'boat-cmd-foc', route_id: 'r2', service_date: '2038-01-10', capacity: 20 });
  const foc = (await request('POST', '/v1/bookings', { intent: 'quote', trips: [{ routeId: 'r2', date: '2038-01-10', pax: { ad: 2, foc: 1 } }] })).json();
  const unexplained = await request('POST', `/v1/bookings/${foc.id}/confirm`);
  assert.equal(unexplained.statusCode, 400, 'confirming free passengers needs a reason (legacy requires one)');
  assert.match(unexplained.json().message, /^foc_reason is required/);
  assert.equal((await request('PATCH', `/v1/bookings/${foc.id}`, { focReason: 'tour guide' })).statusCode, 200);
  const waiting = (await request('POST', `/v1/bookings/${foc.id}/confirm`)).json();
  assert.equal(waiting.status, 'pending_foc');
  assert.equal(waiting.confirmed_at, undefined, 'not confirmed yet');
  const approved = (await request('POST', `/v1/bookings/${foc.id}/approve`, { note: 'guide' })).json();
  assert.equal(approved.status, 'confirmed');
  const history = (await request('GET', `/v1/bookings/${foc.id}/history`)).json().history as { tag: string; text: string }[];
  assert.deepEqual(history.slice(-2).map((h) => [h.tag, h.text]), [['FOC', 'Waiting for FOC approval · 1 FOC pax'], ['FOC', 'FOC approved · 1 pax · booking confirmed · guide']]);
});

test('reject gives the seats back; approve does not apply to a confirmed booking', async () => {
  const date = '2038-01-11';
  const waiting = await booked(date, { price_discount: -500 });
  assert.equal(waiting.status, 'pending_approval', 'a discount waits for approval');
  assert.equal(await seatsLeft(date), 18, 'waiting only for a discount, it holds its seats');
  assert.equal((await request('POST', `/v1/bookings/${waiting.id}/approve`)).statusCode, 200);
  assert.equal((await request('POST', `/v1/bookings/${waiting.id}/approve`)).statusCode, 409, 'already confirmed');

  const other = await booked('2038-01-12', { price_discount: -500 });
  const rejected = await request('POST', `/v1/bookings/${other.id}/reject`, { note: 'over the boat' });
  assert.equal(rejected.json().status, 'rejected');
  assert.equal(await seatsLeft('2038-01-12'), 20, 'the seats are back');
});

test('cancel-weather releases the seats, records the reason, and /restore undoes it', async () => {
  const date = '2038-01-13';
  const booking = await booked(date);
  const cancelled = await request('POST', `/v1/bookings/${booking.id}/cancel-weather`, { note: 'storm warning' });
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  assert.equal(cancelled.json().status, 'cancelled_weather');
  assert.equal(cancelled.json().cancellation_reason, 'weather');
  assert.equal(await seatsLeft(date), 20);
  assert.equal((await request('POST', `/v1/bookings/${booking.id}/cancel-weather`)).statusCode, 409, 'already cancelled');

  const restored = await request('POST', `/v1/bookings/${booking.id}/restore`);
  assert.equal(restored.json().status, 'confirmed');
  assert.equal(restored.json().cancellation_reason, undefined);
  assert.equal(await seatsLeft(date), 18);
});

test('a command on an unknown booking is 404, and a bad note is 400', async () => {
  assert.equal((await request('POST', '/v1/bookings/no-such-booking/confirm')).statusCode, 404);
  const booking = await booked('2038-01-14', { intent: 'quote' });
  assert.equal((await request('POST', `/v1/bookings/${booking.id}/confirm`, { note: 42 })).statusCode, 400);
});
