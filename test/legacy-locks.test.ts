import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lockDays, lockRange, spansDays } from '../src/tools/legacy-locks.js';

// Fixture rows in the shape of legacy's `sb_seat_locks`.
const always = () => true;

test('a bulk lock holds seats on its weekdays, every date the route runs', () => {
  // 2026-11-01 is a Sunday; dow [2,4] is Tuesday and Thursday.
  const lock = { scope: 'bulk', status: 'active', qty: 30, datefrom: '2026-11-01', dateto: '2026-11-08', dow: '[2,4]' };
  assert.ok(spansDays(lock));
  assert.deepEqual(lockDays(lock, always), [
    { service_date: '2026-11-03', pax: 30, released: false },
    { service_date: '2026-11-05', pax: 30, released: false },
  ]);
  assert.deepEqual((lockDays(lock, (date) => date !== '2026-11-05') as { service_date: string }[]).map((d) => d.service_date), ['2026-11-03'],
    'a day the route does not run is not a round, as legacy counts them');
  assert.equal((lockDays({ ...lock, dow: '[]' }, always) as unknown[]).length, 8, 'no weekdays: every day');
});

test('pending seats reserve nothing, and a round released by hand comes in released', () => {
  const lock = { scope: 'bulk', status: 'active', qty: 10, datefrom: '2026-12-01', dateto: '2026-12-03', dow: '',
    pendby: '{"2026-12-01":4,"2026-12-03":10}', releaseddates: '["2026-12-02"]' };
  assert.deepEqual(lockDays(lock, always), [
    { service_date: '2026-12-01', pax: 6, released: false },
    { service_date: '2026-12-02', pax: 10, released: true },
  ], 'the 3rd has every seat pending: nothing to hold');
  assert.ok((lockDays({ ...lock, status: 'depleted' }, always) as { released: boolean }[]).every((d) => d.released), 'a lock no longer active holds nothing');
});

test('a month lock covers whole months; a lock with no range says so', () => {
  assert.deepEqual(lockRange({ scope: 'month', monthfrom: '2026-06', monthto: '2026-08' }), { from: '2026-06-01', to: '2026-08-31' });
  assert.deepEqual(lockRange({ scope: 'month', month: '2026-02' }), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(lockRange({ scope: 'bulk', datefrom: '2026-07-01' }), { from: '2026-07-01', to: '2026-07-01' });
  assert.equal(lockDays({ scope: 'bulk', status: 'released', qty: 0 }, always), 'no date range');
  assert.equal(lockDays({ scope: 'bulk', qty: 1, datefrom: '2026-07-02', dateto: '2026-07-01' }, always), 'range 2026-07-02..2026-07-01 ends before it starts');
  assert.ok(!spansDays({ scope: 'day' }));
});
