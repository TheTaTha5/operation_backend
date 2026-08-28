import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BOOKING_STATUSES, holdsSeats, isBookingStatus, pendingApprovalHoldsSeats, SEAT_RELEASING_STATUSES } from '../src/domain/booking-status.js';
import { claimsSeats } from '../src/domain/operations.js';

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

test('a pending approval that is over capacity has not been granted its seats', () => {
  assert.equal(pendingApprovalHoldsSeats(), true, 'no approval record: legacy reads this as holding');
  assert.equal(pendingApprovalHoldsSeats({}), true);
  assert.equal(pendingApprovalHoldsSeats({ over_total: 0 }), true);
  assert.equal(pendingApprovalHoldsSeats({ over_total: 4 }), false, 'saved because it exceeded the pool');
});

test('an amendment is capacity-checked only when it asks for seats it is not holding', () => {
  assert.equal(claimsSeats('confirmed', 'confirmed', false), false, 'nothing moved');
  assert.equal(claimsSeats('confirmed', 'confirmed', true), true, 'the itinerary moved');
  assert.equal(claimsSeats('quote', 'confirmed', false), false, 'both hold seats already');
  assert.equal(claimsSeats('cancelled', 'confirmed', false), true, 'reinstating asks for its seats back');
  assert.equal(claimsSeats('confirmed', 'cancelled', true), false, 'releasing never needs room');
  assert.equal(claimsSeats('cancelled', 'rejected', true), false, 'still released');
});
