import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatPaxGrid, holdsSeats, parsePaxGrid, paxRowsFromTotal, paxTotal, retargetPax } from '../src/domain/pax.js';

test('the frontend grid parses into category × residency cells', () => {
  assert.deepEqual(parsePaxGrid({ ad: 2, chd_fr: 1, foc_th: 3 }), [
    { category: 'ad', residency: 'unknown', count: 2 },
    { category: 'chd', residency: 'foreign', count: 1 },
    { category: 'foc', residency: 'thai', count: 3 },
  ]);
});

test('a cell with nobody in it is not a row', () => {
  assert.deepEqual(parsePaxGrid({ ad: 2, chd: 0, inf_fr: 0 }), [{ category: 'ad', residency: 'unknown', count: 2 }]);
  assert.deepEqual(parsePaxGrid({}), []);
});

test('parsing rejects what it cannot store rather than dropping it', () => {
  // Silently ignoring an unknown key is how a passenger disappears between the form and the boat.
  assert.throws(() => parsePaxGrid({ senior: 2 }), /not a passenger category/);
  assert.throws(() => parsePaxGrid({ ad_xx: 2 }), /not a passenger category/);
  assert.throws(() => parsePaxGrid({ ad: -1 }), /non-negative integer/);
  assert.throws(() => parsePaxGrid({ ad: 1.5 }), /non-negative integer/);
  assert.throws(() => parsePaxGrid({ ad: '2' }), /non-negative integer/);
  assert.throws(() => parsePaxGrid([]), /must be an object/);
});

test('a grid round-trips through storage unchanged', () => {
  const grid = { ad: 4, ad_fr: 2, chd_th: 1, inf: 1, foc_fr: 1 };
  assert.deepEqual(formatPaxGrid(parsePaxGrid(grid)), grid);
  assert.equal(paxTotal(parsePaxGrid(grid)), 9);
});

test('a bare count is one untiered adult cell', () => {
  assert.deepEqual(formatPaxGrid(paxRowsFromTotal(6)), { ad: 6 });
  assert.deepEqual(paxRowsFromTotal(0), []);
});

test('only statuses that occupy a seat count against the pool', () => {
  assert.equal(holdsSeats('confirmed'), true);
  assert.equal(holdsSeats('pending_approval'), true, 'saved over capacity, still holding the seats');
  assert.equal(holdsSeats('pending_foc'), true);
  assert.equal(holdsSeats('cancelled'), false);
  assert.equal(holdsSeats('draft'), false);
});

test('an untiered count moves to any new total', () => {
  const rows = parsePaxGrid({ ad_fr: 4 });
  assert.deepEqual(formatPaxGrid(retargetPax(rows, 2)), { ad_fr: 2 }, 'the tier it was booked at is kept');
  assert.deepEqual(formatPaxGrid(retargetPax(rows, 9)), { ad_fr: 9 });
  assert.deepEqual(formatPaxGrid(retargetPax(rows, 0)), {});
  assert.deepEqual(formatPaxGrid(retargetPax([], 3)), { ad: 3 }, 'a booking with no cells starts one');
});

test('a bare number cannot retarget a booking split across categories', () => {
  // Every rule for choosing whom to drop — largest cell, proportional, cheapest — is an invention,
  // and each one silently cancels the wrong passengers. Refusing is the only honest answer.
  const rows = parsePaxGrid({ ad: 4, chd: 2, inf: 1 });
  assert.throws(() => retargetPax(rows, 5), /send the pax grid/);
  assert.throws(() => retargetPax(rows, 9), /send the pax grid/);
  assert.deepEqual(formatPaxGrid(retargetPax(rows, 7)), { ad: 4, chd: 2, inf: 1 }, 'a no-op total is not a change');
});

test('retargeting never leaves a negative cell', () => {
  // The bug this replaces: partial-cancel drove a stored allocated_pax below zero and the two stores
  // disagreed about the result. There is no stored total left to corrupt.
  assert.throws(() => retargetPax(parsePaxGrid({ ad: 3 }), -1), /non-negative integer/);
  assert.throws(() => retargetPax(parsePaxGrid({ ad: 3 }), 1.5), /non-negative integer/);
});
