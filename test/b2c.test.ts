import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bookingIssues, decideHeld, holdOrder, issuesSignature, parseHeldDecision, parseHeldStatus, parseUpdatedSince, sameHeldCreate, type CheckedBooking, type HeldInput } from '../src/domain/b2c.js';
import { b2cOrderOf, b2cSkipReason, parseB2CMode } from '../src/tools/legacy-b2c.js';

// The pure rules behind Love Kingdom's push (todo/b2c-sync-model.md): legacy's B2C checks, held
// orders, and which of legacy's B2C bookings the import still copies.

const booking = (fields: Partial<CheckedBooking> = {}): CheckedBooking => ({
  status: 'confirmed', lead_nationality: 'GB', passengers: [], trips: [{ service_date: '2046-01-01', booking_mode: 'seat', pax: { ad_fr: 2 } }], ...fields,
});
const codes = (b: CheckedBooking) => bookingIssues(b).map((i) => i.code);

test('a clean booking has no issues, and one that gave its seats back never has any (legacy B2C_DEAD)', () => {
  assert.deepEqual(bookingIssues(booking()), []);
  const messy = booking({ lead_nationality: 'Slovak', hotel_name: 'Somewhere' });
  assert.deepEqual(codes(messy), ['nat_unread', 'pickup_area']);
  for (const status of ['cancelled', 'rejected', 'cancelled_weather']) assert.deepEqual(bookingIssues({ ...messy, status }), [], status);
  assert.deepEqual(codes({ ...messy, status: 'pending_approval' }), ['nat_unread', 'pickup_area'], 'a waiting booking still needs a look');
});

test('a nationality is read when it is a two-letter code, as legacy writes them', () => {
  assert.deepEqual(codes(booking({ lead_nationality: 'th' })), []);
  assert.deepEqual(codes(booking({ lead_nationality: '' })), [], 'none given is not unread');
  assert.deepEqual(codes(booking({ lead_nationality: 'USA' })), ['nat_unread']);
  const issues = bookingIssues(booking({ passengers: [{ nationality: 'Qatari' }, { nationality: 'Qatari' }, { nationality: 'QA' }, { nationality: null }] }));
  assert.deepEqual(issues, [{ code: 'nat_unread', severity: 'warn', message: 'อ่านสัญชาติผู้โดยสารไม่ออก: "Qatari"' }], 'each unread text once');
});

test('nat_mix: Thai-priced seats while more known foreigners are aboard than the other seats', () => {
  const thai = (pax: Record<string, number>, nats: string[], lead = 'TH') =>
    codes(booking({ lead_nationality: lead, passengers: nats.map((nationality) => ({ nationality })), trips: [{ service_date: '2046-01-01', booking_mode: 'seat', pax }] }));
  assert.deepEqual(thai({ ad_th: 2 }, ['TH', 'TH']), [], 'a Thai party priced Thai');
  assert.deepEqual(thai({ ad_th: 1, ad_fr: 1 }, ['TH', 'GB']), [], 'the foreigner has a foreign seat');
  assert.deepEqual(thai({ ad_th: 1, ad: 1 }, ['TH', 'GB']), [], 'or an untiered one');
  assert.deepEqual(thai({ ad_th: 2 }, ['TH', 'GB']), ['nat_mix']);
  assert.deepEqual(thai({ ad_th: 2 }, ['TH', '']), [], 'an unknown nationality is not a foreigner');
  assert.deepEqual(thai({ ad_th: 2 }, [], 'GB'), ['nat_mix'], 'no passenger list: the lead');
  const charter = booking({ passengers: [{ nationality: 'GB' }], trips: [{ service_date: '2046-01-01', booking_mode: 'charter', pax: { ad_th: 2 } }] });
  assert.deepEqual(codes(charter), [], 'a charter is priced by the boat');
  const twoDays = booking({ passengers: [{ nationality: 'GB' }], trips: [
    { service_date: '2046-01-01', booking_mode: 'seat', pax: { ad_th: 1 } }, { service_date: '2046-01-02', booking_mode: 'seat', pax: { ad_th: 1 } }] });
  assert.deepEqual(codes(twoDays), ['nat_mix'], 'said once per booking');
});

test('money_parts: the parts sent must add up to the total within ฿1; none sent, nothing to check', () => {
  assert.deepEqual(codes(booking({ total: 4000 })), []);
  assert.deepEqual(codes(booking({ total: 4000, price_seat: 3600, price_addon: 800, price_discount: -400 })), []);
  assert.deepEqual(codes(booking({ total: 4000, price_seat: 3600, price_addon: 401, price_discount: -0.5 })), [], 'within ฿1');
  const off = bookingIssues(booking({ total: 4000, price_seat: 3600 }));
  assert.deepEqual(off, [{ code: 'money_parts', severity: 'warn', message: 'ยอดแยกรวมไม่เท่ายอดบรรทัด (3600 ≠ 4000)' }]);
});

test('pickup_area: a place given but no area matched, unless they come by themselves', () => {
  assert.deepEqual(codes(booking({ pickup_area: 'Kata', hotel_name: 'Hotel' })), ['pickup_area']);
  assert.match(bookingIssues(booking({ pickup_area: 'Kata', hotel_name: 'Hotel' }))[0].message, /"Kata"/, 'the area text first, as legacy');
  assert.deepEqual(codes(booking({ hotel_name: 'Hotel', pickup_area_id: 'ka-01' })), []);
  assert.deepEqual(codes(booking({ hotel_name: 'Hotel', pickup_self: true })), []);
});

test('the signature changes with the held orders and the warnings, not with info lines', () => {
  const warn = { booking_id: 'b1', external_id: null, service_date: '2046-01-01', lead_pax: null, code: 'nat_mix' as const, severity: 'warn' as const, message: 'x' };
  const info = { ...warn, code: 'pickup_area' as const, severity: 'info' as const };
  const base = issuesSignature([{ id: 'held_1' }], [warn]);
  assert.match(base, /^[0-9a-f]{12}$/);
  assert.equal(issuesSignature([{ id: 'held_1' }], [warn, info]), base);
  assert.equal(issuesSignature([{ id: 'held_1' }], [{ ...warn, message: 'other words' }]), base, 'the same issue in other words');
  assert.notEqual(issuesSignature([], [warn]), base);
  assert.notEqual(issuesSignature([{ id: 'held_1' }], []), base);
});

test('a held create retried while open is the same order; anything else is a new one', () => {
  const input: HeldInput = { action: 'create', external_id: 'LOV-1', booking_id: null, request: { a: 1 }, problem: 'Unknown route: r9', received_by: 'lk' };
  const first = holdOrder(input, undefined, 'held_1', '2046-01-01T00:00:00.000Z');
  assert.deepEqual([first.id, first.attempts, first.status, first.received_at, first.last_received_at], ['held_1', 1, 'open', '2046-01-01T00:00:00.000Z', '2046-01-01T00:00:00.000Z']);
  assert.ok(sameHeldCreate(first, input));
  const again = holdOrder({ ...input, request: { a: 2 }, problem: 'Unknown route: r8' }, first, 'held_2', '2046-01-01T00:05:00.000Z');
  assert.deepEqual([again.id, again.attempts, again.request, again.problem, again.received_at, again.last_received_at],
    ['held_1', 2, { a: 2 }, 'Unknown route: r8', '2046-01-01T00:00:00.000Z', '2046-01-01T00:05:00.000Z']);
  assert.ok(!sameHeldCreate(first, { ...input, external_id: null }), 'no order id: nothing to match');
  assert.ok(!sameHeldCreate(first, { ...input, action: 'amend' }), 'an amend is its own');
  assert.ok(!sameHeldCreate({ ...first, status: 'dismissed' }, input), 'a closed one is not reopened');
});

test('a held order is decided once, by the server\'s clock and the caller\'s login', () => {
  const held = holdOrder({ action: 'cancel', external_id: 'LOV-2', booking_id: 'b1', request: {}, problem: 'p', received_by: 'lk' }, undefined, 'held_9', '2046-01-01T00:00:00.000Z');
  const done = decideHeld(held, parseHeldDecision('resolve', { bookingId: 'b1', note: ' cancelled by hand ' }), 'ops1', '2046-01-02T00:00:00.000Z');
  assert.deepEqual([done.status, done.resolved_booking_id, done.note, done.decided_by, done.decided_at], ['resolved', 'b1', 'cancelled by hand', 'ops1', '2046-01-02T00:00:00.000Z']);
  assert.throws(() => decideHeld(done, parseHeldDecision('dismiss', {}), 'ops2', 'now'), { statusCode: 409, code: 'wrong_status' });
  assert.deepEqual(parseHeldDecision('dismiss', undefined), { status: 'dismissed', note: null, resolved_booking_id: null });
  assert.throws(() => parseHeldDecision('dismiss', { booking_id: 'b1' }), { statusCode: 400 });
  assert.throws(() => parseHeldDecision('resolve', []), { statusCode: 400 });
  assert.equal(parseHeldStatus(undefined), 'open');
  assert.equal(parseHeldStatus('all'), undefined);
  assert.throws(() => parseHeldStatus('closed'), { statusCode: 400 });
});

test('updated_since is an instant, normalised to ISO', () => {
  assert.equal(parseUpdatedSince(undefined), undefined);
  assert.equal(parseUpdatedSince('2026-10-09T10:00:00+07:00'), '2026-10-09T03:00:00.000Z');
  assert.equal(parseUpdatedSince('2026-10-09'), '2026-10-09T00:00:00.000Z', 'a date is its midnight UTC');
  for (const bad of ['yesterday', '1700000000', 'Fri Oct 09 2026', 7]) assert.throws(() => parseUpdatedSince(bad), { statusCode: 400 }, String(bad));
});

test('the import copies legacy\'s B2C bookings until told otherwise, and never the test orders', () => {
  assert.equal(parseB2CMode(['node', 'import']), 'all', 'today\'s behaviour by default');
  assert.equal(parseB2CMode(['--commit', '--b2c=pushed']), 'pushed');
  assert.equal(parseB2CMode(['--b2c=none']), 'none');
  assert.throws(() => parseB2CMode(['--b2c=skip']), /--b2c must be one of all, pushed, none/);
  assert.throws(() => parseB2CMode(['--b2c']), /--b2c must be one of/);

  assert.equal(b2cOrderOf('b2c_LOV-8161340_1'), 'LOV-8161340');
  assert.equal(b2cOrderOf('b2c_LOV-8161340_12'), 'LOV-8161340');
  assert.equal(b2cOrderOf('BK-1001'), undefined);

  const pushed = new Set(['LOV-1']);
  const reasons = (mode: 'all' | 'pushed' | 'none') => ['b2c_LOV-1_1', 'b2c_LOV-1_2', 'b2c_LOV-2_1', 'b2c_BK-002_1', 'BK-77', 'lg_x'].map((id) => b2cSkipReason(id, mode, pushed) !== undefined);
  assert.deepEqual(reasons('all'), [false, false, false, true, false, false]);
  assert.deepEqual(reasons('pushed'), [true, true, false, true, false, false], 'every line of a pushed order; the unpushed ones still come');
  assert.deepEqual(reasons('none'), [true, true, true, true, false, false]);
  assert.equal(b2cSkipReason('b2c_BK-001_1', 'all', pushed), 'B2C test bookings not imported (b2c_BK-…)');
});
