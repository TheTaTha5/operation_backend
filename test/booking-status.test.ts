import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BOOKING_STATUSES, holdsSeats, isBookingStatus, SEAT_RELEASING_STATUSES } from '../src/domain/booking-status.js';
import { bookingHoldsSeats, type BookingApproval } from '../src/domain/booking-approvals.js';
import { reweighs } from '../src/domain/operations.js';

test('the enum is what the frontend writes, not what happens to exist', () => {
  // Six of these appear in the legacy production data; a status the API refuses is a booking the
  // frontend cannot save, so the set comes from the writer.
  assert.equal(BOOKING_STATUSES.length, 10);
  for (const status of ['confirmed', 'cancelled', 'cancelled_weather', 'pending_approval', 'quote', 'rejected']) {
    assert.ok(isBookingStatus(status), `${status} is in live data and must be storable`);
  }
  assert.equal(isBookingStatus('shipped'), false);
  assert.equal(isBookingStatus(undefined), false);
});

test('seats are released by three statuses and held by every other', () => {
  assert.deepEqual([...SEAT_RELEASING_STATUSES], ['cancelled', 'rejected', 'cancelled_weather']);
  for (const status of SEAT_RELEASING_STATUSES) assert.equal(holdsSeats(status), false, status);
  for (const status of BOOKING_STATUSES.filter((s) => !SEAT_RELEASING_STATUSES.includes(s as never))) {
    assert.equal(holdsSeats(status), true, `${status} holds its seats`);
  }
});

test('an unclassified status holds its seats rather than releasing them', () => {
  // The direction of the list is the point. Over-holding is a day that looks fuller than it is and
  // someone asks; under-holding is two parties sold the same seat, at the pier, on the day.
  assert.equal(holdsSeats('some_status_added_next_year'), true);
});

const waiting = (over_capacity: boolean, status: BookingApproval['status'] = 'pending'): BookingApproval => ({
  kind: 'approval', status, reason: over_capacity ? 'over_capacity' : 'discount', over_capacity, over_total: over_capacity ? 4 : null, discount: over_capacity ? null : 500, foc_count: null,
  target_status: 'confirmed', requested_by: null, requested_at: '2026-10-07T00:00:00.000Z', decided_by: null, decided_at: null, note: null, days: [],
});

test('a pending approval that is over the allotment has not been granted its seats', () => {
  assert.equal(bookingHoldsSeats({ status: 'pending_approval' }), true, 'no approval record: legacy reads this as holding');
  assert.equal(bookingHoldsSeats({ status: 'pending_approval', approvals: [waiting(false)] }), true, 'waiting only for a discount');
  assert.equal(bookingHoldsSeats({ status: 'pending_approval', approvals: [waiting(true)] }), false, 'saved because it exceeded the allotment');
  assert.equal(bookingHoldsSeats({ status: 'pending_approval', approvals: [waiting(true, 'replaced')] }), true, 'a replaced request no longer counts');
  assert.equal(bookingHoldsSeats({ status: 'confirmed', approvals: [waiting(true)] }), true, 'only a pending_approval booking waits');
  assert.equal(bookingHoldsSeats({ status: 'cancelled' }), false);
});

test('an amendment is weighed again only when it asks for seats it is not holding', () => {
  const moved = { trips: [] };
  assert.equal(reweighs({ status: 'confirmed' }, {}, false), false, 'nothing more asked for');
  assert.equal(reweighs({ status: 'confirmed' }, moved, true), true, 'more seats, or seats on another day');
  assert.equal(reweighs({ status: 'pending_approval', approvals: [waiting(true)] }, { header: {} }, false), false, 'a header edit leaves the request alone');
  assert.equal(reweighs({ status: 'pending_approval', approvals: [waiting(true)] }, { pax: 2 }, false), true, 'fewer seats may fit now');
});
