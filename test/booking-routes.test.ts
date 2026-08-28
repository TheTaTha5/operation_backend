import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertKnownRoutes, unknownRoutes, type BookingTripInput } from '../src/domain/operations.js';

const trip = (route_id: string): BookingTripInput => ({ route_id, service_date: '2030-01-02', pax: [{ category: 'ad', residency: 'unknown', count: 1 }] });

test('a trip on a route the catalogue does not have is named, not just refused', () => {
  const known = new Set(['r1', 'r2']);
  assert.deepEqual(unknownRoutes(known, [trip('r1'), trip('r2')]), []);
  assert.deepEqual(unknownRoutes(known, [trip('r1'), trip('r99')]), ['r99']);
  assert.deepEqual(unknownRoutes(known, [trip('r98'), trip('r99'), trip('r98')]), ['r98', 'r99'], 'each unknown route once');
});

test('an unknown route is a 400 rather than the foreign key raising a 500', () => {
  // booking_trips_route_fk (migration 008) is the backstop. If it is what rejects the write, the
  // caller gets a 500 naming a constraint instead of a 400 naming the route they got wrong.
  assert.throws(() => assertKnownRoutes(new Set(['r1']), [trip('r7')]), (error: Error & { statusCode?: number }) => {
    assert.equal(error.statusCode, 400, 'a bad request, not a server fault');
    assert.match(error.message, /Unknown route: r7/, 'and it says which route');
    return true;
  });
  assert.doesNotThrow(() => assertKnownRoutes(new Set(['r1']), [trip('r1')]));
});
