import assert from 'node:assert/strict';
import { test } from 'node:test';
import { legacyPickup } from '../src/tools/legacy-pickup.js';

// Every shape legacy's `pickuptime` and `ops_pickuptimefinal` hold on production (2026-10-08).
test('each legacy pickup text maps to a window without loss', () => {
  assert.deepEqual(legacyPickup('07:30-07:45'), { pickup_time: '07:30', pickup_time_end: '07:45' });
  assert.deepEqual(legacyPickup('Before 08:30 at pier'), { pickup_time_end: '08:30', pickup_at_pier: true });
  assert.deepEqual(legacyPickup('07:30'), { pickup_time: '07:30' });
  assert.deepEqual(legacyPickup('7:30'), { pickup_time: '07:30' });
  assert.deepEqual(legacyPickup('06.30'), { pickup_time: '06:30' });
  assert.deepEqual(legacyPickup('07:30:00'), { pickup_time: '07:30' });
  assert.deepEqual(legacyPickup('08.00 a.m.'), { pickup_time: '08:00' });
  assert.deepEqual(legacyPickup('08:20-'), { pickup_time: '08:20' }, 'a window with no end yet keeps its start');
});

test('an empty text is no pickup, and anything else is not guessed', () => {
  for (const empty of [null, undefined, '', '  ']) assert.deepEqual(legacyPickup(empty), {});
  assert.deepEqual(legacyPickup('1:30 p.m.'), { pickup_time: '13:30' });
  assert.deepEqual(legacyPickup('12:15 a.m.'), { pickup_time: '00:15' });
  for (const text of ['07:45-07:30', 'after lunch', '25:00', '13:00 p.m.', 'Before noon at pier']) assert.equal(legacyPickup(text), undefined, text);
});
