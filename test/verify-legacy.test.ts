import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canonicalPickup, countDiff, legacyPax, legacyValue, same, samePickup, setDiff, targetPax, templateNames, unreadColumns,
} from '../src/tools/verify-legacy.js';

test('values compare by meaning, not by spelling', () => {
  assert.ok(same('', null, 'text'), 'blank and null are both no value');
  assert.ok(same(' Patong ', 'Patong', 'text'));
  assert.ok(!same('Patong', 'Kata', 'text'));
  assert.ok(same('4800', 4800, 'number'));
  assert.ok(same('4800.001', '4800', 'number'), 'a fraction of a satang is not a difference');
  assert.ok(!same('4800', '4801', 'number'));
  assert.ok(same(null, false, 'bool'), 'legacy writes no value or false for the same thing');
  assert.ok(same('t', true, 'bool'));
  assert.ok(!same(true, false, 'bool'));
  assert.ok(same('2026-09-28', new Date(2026, 8, 28), 'day'), 'a pg date arrives as local midnight');
  assert.ok(same('2026-09-28T06:15:01.913Z', new Date('2026-09-28T06:15:01.913Z'), 'instant'));
  assert.ok(!same('2026-09-28T06:15:01.913Z', '2026-09-28T06:15:02.913Z', 'instant'));
});

test('a header field reads the first legacy column that holds a value', () => {
  assert.equal(legacyValue({ focreason: '', focapproval_reason: 'Guide' }, ['focreason', 'focapproval_reason']), 'Guide');
  assert.equal(legacyValue({ focreason: 'TL' }, ['focreason', 'focapproval_reason']), 'TL');
  assert.equal(legacyValue({}, ['focreason']), undefined);
});

test('legacy pax columns become category/residency counts, as booking_trip_pax holds them', () => {
  const legacy = legacyPax({ pax_ad_fr: 2, pax_ad_th: '1', pax_chd_fr: 0, pax_foc: 1, pax_ad: null });
  assert.deepEqual([...legacy].sort(), [['ad/foreign', 2], ['ad/thai', 1], ['foc/unknown', 1]]);
  const here = targetPax([{ category: 'ad', residency: 'foreign', count: 2 }, { category: 'ad', residency: 'thai', count: 1 }, { category: 'foc', residency: 'unknown', count: 1 }]);
  assert.deepEqual(countDiff(legacy, here), []);
  assert.deepEqual(countDiff(legacy, targetPax([{ category: 'ad', residency: 'foreign', count: 3 }])),
    ['ad/foreign: 2 → 3', 'ad/thai: 1 → 0', 'foc/unknown: 1 → 0']);
});

test('pickup texts compare in one canonical form', () => {
  assert.equal(canonicalPickup('7:30'), '07:30');
  assert.equal(canonicalPickup('07.30'), '07:30');
  assert.equal(canonicalPickup('08.00 a.m.'), '08:00');
  assert.equal(canonicalPickup('07:30-07:45'), '07:30-07:45');
  assert.equal(canonicalPickup('before 8.30 at the pier'), 'Before 08:30 at pier');
  assert.equal(canonicalPickup(''), '');
  assert.equal(canonicalPickup('TBA'), undefined);
  // the three-field schema (feat/pickup-window)
  assert.ok(samePickup('07:30-07:45', '07:30', '07:45', false));
  assert.ok(samePickup('Before 08:30 at pier', null, '08:30', true));
  assert.ok(samePickup('08:20-', '08:20', null, false), 'an open window is its start');
  assert.ok(samePickup('', null, null, null));
  // the one-field schema (main before the window): a window that lost its end is a difference
  assert.ok(!samePickup('07:30-07:45', null, undefined, undefined));
  assert.ok(samePickup('7:30', '07:30', undefined, undefined));
});

test('set differences list what each side lacks', () => {
  assert.deepEqual(setDiff(['a', 'b', 'c'], ['b', 'c', 'd']), { missing: ['a'], extra: ['d'] });
});

test('a column with data counts as read only when the import code names it as a whole word', () => {
  const source = "const x = str(b.bookedat); read('SELECT pricebreakdown_seat FROM sb_bookings');";
  const columns = [
    { table: 'sb_bookings', column: 'bookedat', filled: 10 },
    { table: 'sb_bookings', column: 'pricebreakdown_seat', filled: 10 },
    { table: 'sb_bookings', column: 'pricebreakdown_total', filled: 10 },
    { table: 'sb_bookings', column: 'booked', filled: 10 },
    { table: 'sb_bookings', column: 'editlock_by', filled: 0 },
    { table: 'sb_bookings__trips', column: 'sb_bookings_id', filled: 10 },
  ];
  assert.deepEqual(unreadColumns(columns, source).map((c) => c.column), ['pricebreakdown_total', 'booked']);
});

test('names the import code builds count as read; messages and bare joins do not', () => {
  const source = 'n = int(trip[`pax_${category}${suffix}`]); x = row[`${boatType}_starterprice`]; issue(`${routeId} ${zone} dropped`); y = row[`${a}_${b}`];';
  assert.deepEqual(templateNames(source).map(String), ['/^pax_[a-z0-9_]*$/i', '/^[a-z0-9_]*_starterprice$/i']);
  const cols = ['pax_ad_th', 'speedboat_starterprice', 'pk_adult_fr', 'kl_child_thai', 'rn_adult_fr', 'travelfrom']
    .map((column) => ({ table: 't', column, filled: 1 }));
  assert.deepEqual(unreadColumns(cols, source).map((c) => c.column), ['rn_adult_fr', 'travelfrom'],
    'pk_/kl_ seat columns are COMPOSED_READS; rn_ is not, so it is reported');
});
