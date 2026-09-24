import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertDayFits, assertLockFits, dayCapacity, deploymentSeats, type DayDemand } from '../src/domain/capacity.js';

test('a boat sells its capacity, not its licence', () => {
  // b13 Oceanus: the company sells 38 of a registered 45 passengers.
  assert.deepEqual(deploymentSeats({ capacity: 38, license_pax: 45 }), { sellable: 38, licensed: 45 });
});

test('the licence caps a capacity that claims more than the boat may carry', () => {
  assert.deepEqual(deploymentSeats({ capacity: 60, license_pax: 45 }), { sellable: 45, licensed: 45 });
});

test('a boat with no licence on file falls back to its capacity, never to zero', () => {
  // Tri Star 01 and 02 in Ranong carry no licence. Treating a missing licence as 0 would take two
  // boats out of service; treating it as unlimited would sell past a ceiling nobody recorded.
  assert.deepEqual(deploymentSeats({ capacity: 38 }), { sellable: 38, licensed: 38 });
  assert.deepEqual(deploymentSeats({ capacity: 38, override_capacity: 30 }), { sellable: 30, licensed: 30 });
});

test('a day override lowers the boat for that day', () => {
  assert.deepEqual(deploymentSeats({ capacity: 44, license_pax: 75, override_capacity: 40 }), { sellable: 40, licensed: 75 });
});

test('a day override may not raise a boat above its licence', () => {
  // b10 has a live override of 47 against a capacity of 44. Overrides are an operational lever, not
  // a way around the registration, so the licence still decides the ceiling.
  assert.deepEqual(deploymentSeats({ capacity: 44, license_pax: 45, override_capacity: 60 }), { sellable: 45, licensed: 45 });
});

test('crew seats are not reachable through any input', () => {
  // The bug this replaces: total_capacity was license_pax + crew (48 for a 45-passenger boat) and
  // the charter path used it as a ceiling. There is no longer any argument that produces 48.
  const limits = { capacity: 38, license_pax: 45 };
  assert.equal(deploymentSeats(limits).licensed, 45);
  assert.equal(deploymentSeats({ ...limits, override_capacity: 48 }).sellable, 45);
});

const two = [{ boat_id: 'big', capacity: 30, license_pax: 35 }, { boat_id: 'small', capacity: 10 }];
const demand = (d: Partial<DayDemand>): DayDemand => ({ route_id: 'r', service_date: '2031-01-01', seat: 0, draws: new Map(), charters: [], ...d });
const refusedWith = (status: number) => (error: Error & { statusCode?: number }) => error.statusCode === status;

test('a chartered boat leaves the pool whole, whatever it carries', () => {
  const day = dayCapacity(two, [{ booking_mode: 'charter', pax: 2, charter_boat_id: 'small' }, { booking_mode: 'seat', pax: 5 }], []);
  assert.equal(day.deployed_capacity, 40, 'what is deployed is still reported');
  assert.equal(day.charter_pax, 2);
  assert.equal(day.available_seats, 25, 'the small boat is gone, not just two of its seats: 30 - 5');
});

test('a charter with no known boat comes out of the pool by its passengers', () => {
  // Recorded before charter_boat_id, on a day with two boats: which boat it took cannot be known.
  assert.equal(dayCapacity(two, [{ booking_mode: 'charter', pax: 7 }], []).available_seats, 33);
  assert.equal(dayCapacity(two, [{ booking_mode: 'charter', pax: 7, charter_boat_id: 'gone' }], []).available_seats, 33, 'nor may a boat no longer deployed');
});

test('a lock holds only what has not been drawn from it', () => {
  const day = dayCapacity(two, [{ booking_mode: 'seat', pax: 4 }], [{ id: 'l1', pax: 6, drawn: 3 }, { id: 'l2', pax: 2, drawn: 5 }]);
  assert.equal(day.locked_pax, 3, 'l1 holds 3, and an overdrawn l2 holds none rather than a negative');
  assert.equal(day.available_seats, 33);
});

test('a sale is weighed by what it takes that is not already held', () => {
  const day = dayCapacity([{ boat_id: 'b', capacity: 10 }], [{ booking_mode: 'seat', pax: 5 }], [{ id: 'l1', pax: 5, drawn: 0 }]);
  assert.equal(day.available_seats, 0);
  assert.doesNotThrow(() => assertDayFits(day, demand({ seat: 3, draws: new Map([['l1', 3]]) })), 'drawn entirely from the lock needs no pool seat');
  assert.throws(() => assertDayFits(day, demand({ seat: 3, draws: new Map([['l1', 2]]) })), refusedWith(409), 'one seat short');
  assert.throws(() => assertDayFits(day, demand({ seat: 6, draws: new Map([['l1', 6]]) })), refusedWith(409), 'more than the lock has');
  assert.throws(() => assertDayFits(day, demand({ seat: 1, draws: new Map([['l9', 1]]) })), refusedWith(400), 'a lock not active that day');
});

test('a charter needs its boat deployed, free and big enough, and must not strand sold seats', () => {
  const day = dayCapacity(two, [{ booking_mode: 'seat', pax: 12 }], []);
  assert.throws(() => assertDayFits(day, demand({ charters: [{ boat_id: 'other', pax: 1 }] })), refusedWith(400));
  assert.throws(() => assertDayFits(day, demand({ charters: [{ boat_id: 'small', pax: 11 }] })), refusedWith(409), 'past its licence');
  assert.throws(() => assertDayFits(day, demand({ charters: [{ boat_id: 'big', pax: 1 }] })), refusedWith(409), 'twelve sold seats will not fit the small boat');
  assert.doesNotThrow(() => assertDayFits(day, demand({ charters: [{ boat_id: 'small', pax: 10 }] })));
  assert.throws(() => assertDayFits(day, demand({ charters: [{ boat_id: 'small', pax: 1 }, { boat_id: 'small', pax: 1 }] })), refusedWith(409), 'the same boat twice');
});

test('a lock resizes against the pool but never below its draws', () => {
  const full = dayCapacity([{ boat_id: 'b', capacity: 10 }], [{ booking_mode: 'seat', pax: 12 }], []);
  assert.throws(() => assertLockFits(full, 2, 3), refusedWith(409), 'below what is drawn');
  assert.doesNotThrow(() => assertLockFits(full, 3, 3), 'shrinking to the draws needs nothing, even on an oversold day');
  assert.throws(() => assertLockFits(full, 4, 3), refusedWith(409));
});
