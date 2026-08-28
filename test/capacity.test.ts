import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deploymentSeats } from '../src/domain/capacity.js';

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
