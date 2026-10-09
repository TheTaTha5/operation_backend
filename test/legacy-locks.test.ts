import assert from 'node:assert/strict';
import { test } from 'node:test';
import { departures, lockRange, mapLegacyLocks, spansDays } from '../src/tools/legacy-locks.js';

// How legacy's sb_seat_locks and its log become rows (src/tools/legacy-locks.ts), on rows shaped as
// the legacy tables hold them.
const always = () => true;
const report = () => {
  const skipped: string[] = [], notes: string[] = [];
  return { skipped, notes, skip: (kind: string, id: string, reason: string) => skipped.push(`${kind} ${id}: ${reason}`), note: (what: string) => notes.push(what) };
};
const ctx = { prefix: 'lg_', agents: new Set(['a10']), routes: new Set(['r1', 'r5']), isOpen: () => true, today: '2026-10-09', now: '2026-10-09T00:00:00.000Z' };
const day = (id: string, extra: Record<string, unknown> = {}) => ({
  id, scope: 'day', routeid: 'r1', date: '2026-11-01', holdertype: 'agent', holderid: 'a10', qty: 5, status: 'active', expiry: '2026-10-30',
  reason: '', createdat: '2026-10-01T03:00:00.000Z', createdby: 'RSVN02', ...extra,
});

test('a bulk lock holds seats on its weekdays, every date the route runs', () => {
  // 2026-11-01 is a Sunday; dow [2,4] is Tuesday and Thursday.
  const lock = { scope: 'bulk', status: 'active', qty: 30, datefrom: '2026-11-01', dateto: '2026-11-08', dow: '[2,4]' };
  assert.ok(spansDays(lock));
  assert.deepEqual(departures(lock, always), [
    { service_date: '2026-11-03', pending: 0, released: false },
    { service_date: '2026-11-05', pending: 0, released: false },
  ]);
  assert.deepEqual((departures(lock, (date: string) => date !== '2026-11-05') as { service_date: string }[]).map((d) => d.service_date), ['2026-11-03'],
    'a day the route does not run is not a round, as legacy counts them');
  assert.equal((departures({ ...lock, dow: '[]' }, always) as unknown[]).length, 8, 'no weekdays: every day');
});

test('a month lock covers whole months; a lock with no range says so', () => {
  assert.deepEqual(lockRange({ scope: 'month', monthfrom: '2026-06', monthto: '2026-08' }), { from: '2026-06-01', to: '2026-08-31' });
  assert.deepEqual(lockRange({ scope: 'month', month: '2026-02' }), { from: '2026-02-01', to: '2026-02-28' });
  assert.equal(departures({ scope: 'bulk', status: 'released', qty: 0 }, always), 'no date range');
  assert.equal(departures({ scope: 'bulk', qty: 1, datefrom: '2026-07-02', dateto: '2026-07-01' }, always), 'range 2026-07-02..2026-07-01 ends before it starts');
  assert.ok(!spansDays({ scope: 'day' }));
});

test('what was asked is kept: pax is qty plus what the release lines gave back', () => {
  const r = report();
  const out = mapLegacyLocks({
    locks: [day('lk1', { qty: 0, status: 'released' }), day('lk2', { qty: 0, status: 'released' })],
    log: [
      { sb_seat_locks_id: 'lk1', idx: 0, date: '2026-10-01', type: 'create', qty: 6, at: '2026-10-01T03:00:00.000Z', by: 'RSVN02' },
      { sb_seat_locks_id: 'lk1', idx: 1, date: '2026-10-02', type: 'release', qty: 6 },
    ],
  }, ctx, r);
  assert.deepEqual(out.locks.map((l) => [l.id, l.pax, l.released_pax, l.status]), [['lg_lk1', 6, 6, 'released']]);
  assert.deepEqual(r.skipped, ['seat lock lk2: no seats: qty 0 and nothing released']);
  assert.deepEqual(out.events.map((e) => [e.lock_id, e.type, e.qty, e.day, e.at, e.by, e.imported]), [
    ['lg_lk1', 'create', 6, '2026-10-01', '2026-10-01T03:00:00.000Z', 'RSVN02', true],
    ['lg_lk1', 'release', 6, '2026-10-02', null, null, true],
  ], 'a release line has no time or user in legacy, and none is made up');
});

test('holders: a free-text name becomes an office lock with the name in the reason; sub-groups follow their parent', () => {
  const r = report();
  const out = mapLegacyLocks({
    locks: [
      day('lk1', { holderid: 'GUIDE MAN', reason: 'Fam trip' }),
      day('lk2', { holdertype: 'office', holderid: null }),
      day('lk3', { qty: 6 }),
      { id: 'lk3a', parentid: 'lk3', subname: '@Chicky65', qty: 2, status: 'depleted', holdertype: 'agent', holderid: 'a10', reason: 'line', expiry: '2026-10-29', createdat: '2026-10-02T00:00:00.000Z' },
      { id: 'lkX', parentid: 'lk-gone', subname: 'A', qty: 1, status: 'active' },
    ],
    log: [],
  }, ctx, r);
  const byId = new Map(out.locks.map((l) => [l.id, l]));
  assert.deepEqual([byId.get('lg_lk1')!.holder_type, byId.get('lg_lk1')!.agent_id, byId.get('lg_lk1')!.reason], ['office', null, 'GUIDE MAN · Fam trip']);
  assert.deepEqual([byId.get('lg_lk2')!.holder_type, byId.get('lg_lk2')!.agent_id], ['office', null]);
  const kid = byId.get('lg_lk3a')!;
  assert.deepEqual([kid.parent_id, kid.sub_name, kid.holder_type, kid.agent_id, kid.status, kid.expiry, kid.reason, kid.pax],
    ['lg_lk3', '@Chicky65', 'agent', 'a10', 'released', null, 'line', 2], 'its own reason; its expiry is its parent\'s');
  assert.deepEqual(r.skipped, ['seat lock lkX: sub-group of lk-gone, which legacy no longer has']);
  assert.ok(r.notes.includes('free-text holders → office, the name kept in the reason'));
  assert.equal(out.lockAt.get('lk3a')!.days.get('2026-11-01'), 'lg_lk3a', 'a draw on the sub-group lands on it');
});

test('status: expired keeps its expiry (it reads expired here), depleted is released, pending comes over', () => {
  const r = report();
  const out = mapLegacyLocks({
    locks: [
      day('lk1', { status: 'expired', expiry: '2026-10-08' }),
      day('lk2', { status: 'expired', expiry: '2026-10-09' }),
      day('lk3', { status: 'depleted' }),
      day('lk4', { qty: 4, pendqty: 3 }),
      { ...day('lk5', { scope: 'boat', boatid: 'b7', subname: 'fixed', status: 'active', expiry: '2026-10-01' }) },
    ],
    log: [],
  }, ctx, r);
  assert.deepEqual(out.locks.map((l) => [l.id, l.status, l.expiry, l.pending_pax, l.boat_id, l.sub_name]), [
    ['lg_lk1', 'active', '2026-10-08', 0, null, null],
    ['lg_lk2', 'released', '2026-10-09', 0, null, null],
    ['lg_lk3', 'released', '2026-10-30', 0, null, null],
    ['lg_lk4', 'active', '2026-10-30', 3, null, null],
    ['lg_lk5', 'active', '2026-10-01', 0, 'b7', null],
  ], 'a whole-boat hold never expires by itself; its fixed/any is not a sub-group name');
});

test('a whole-boat hold keeps its deal, and a converted one the booking its convert line names', () => {
  const r = report();
  const hold = (id: string, extra: Record<string, unknown>) => day(id, { scope: 'boat', boatid: 'b13', qty: 38, expiry: '2026-10-31', ...extra });
  const out = mapLegacyLocks({
    locks: [
      hold('lk6', { subname: 'fixed', status: 'converted' }),
      hold('lk7', { subname: 'any', status: 'active' }),
      hold('lk8', { subname: '', status: 'converted' }),
      hold('lk9', { subname: 'fixed', status: 'released' }),
    ],
    log: [
      { sb_seat_locks_id: 'lk6', idx: 0, date: '2026-10-01', type: 'create', qty: 38 },
      { sb_seat_locks_id: 'lk6', idx: 1, date: '2026-10-01', type: 'convert', bookingid: 'BK-26100035-N13I', note: 'เหมาลำ Oceanus' },
    ],
  }, ctx, r);
  assert.deepEqual(out.locks.map((l) => [l.id, l.status, l.boat_deal, l.converted_booking_id]), [
    ['lg_lk6', 'converted', 'fixed', 'lg_BK-26100035-N13I'],
    ['lg_lk7', 'active', 'any', null],
    ['lg_lk8', 'released', 'fixed', null],
    ['lg_lk9', 'released', 'fixed', null],
  ], 'legacy\'s missing subName means fixed; a converted hold with no convert line has no booking to name');
  assert.ok(r.notes.includes('converted holds naming no booking → released'));
  const plain = mapLegacyLocks({ locks: [day('lk10')], log: [] }, ctx, report()).locks[0];
  assert.deepEqual([plain.boat_deal, plain.converted_booking_id], [null, null]);
});

test('a bulk lock is a group with one lock per departure; its log goes to the group, and to the departure a line names', () => {
  const r = report();
  const bulk = { id: 'lkB', scope: 'bulk', routeid: 'r5', datefrom: '2026-11-01', dateto: '2026-11-08', dow: '[2,4]', qty: 28, status: 'active', holdertype: 'agent', holderid: 'a10',
    releasedaysbefore: '2', releasetime: '15:00', pendby: '{"2026-11-05":3}', releaseddates: '["2026-11-03"]', reason: 'Tue/Thu', createdat: '2026-10-01T00:00:00.000Z' };
  const out = mapLegacyLocks({
    locks: [bulk],
    log: [
      { sb_seat_locks_id: 'lkB', idx: 0, date: '2026-10-01', type: 'create', qty: 30 },
      { sb_seat_locks_id: 'lkB', idx: 1, date: '2026-10-02', type: 'release', qty: 2 },
      { sb_seat_locks_id: 'lkB', idx: 2, date: '2026-10-03', type: 'draw', qty: 2, tripdate: '2026-11-05', bookingid: 'BK-1' },
    ],
  }, ctx, r);
  assert.deepEqual(out.groups.map((g) => [g.id, g.route_id, g.date_from, g.date_to, g.weekdays, g.pax, g.release_days_before, g.release_time, g.agent_id, g.reason]),
    [['lg_lkB', 'r5', '2026-11-01', '2026-11-08', [2, 4], 30, 2, '15:00', 'a10', 'Tue/Thu']]);
  assert.deepEqual(out.locks.map((l) => [l.id, l.pax, l.released_pax, l.pending_pax, l.status, l.group_id]), [
    ['lg_lkB_2026-11-03', 30, 2, 0, 'released', 'lg_lkB'],
    ['lg_lkB_2026-11-05', 30, 2, 3, 'active', 'lg_lkB'],
  ], 'the round released by hand comes in released; pending stays pending');
  assert.deepEqual(out.events.map((e) => [e.group_id, e.lock_id, e.type]), [
    ['lg_lkB', null, 'create'], ['lg_lkB', null, 'release'], ['lg_lkB', 'lg_lkB_2026-11-05', 'draw'],
  ]);
});
