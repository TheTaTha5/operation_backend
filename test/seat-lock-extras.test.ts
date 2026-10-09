import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { todayInThailand } from '../src/domain/calendar.js';
import { seedAgents, testStore } from './users-helper.js';

// Seat-lock extras (todo/seat-lock-extras-model.md, decided 2026-10-09), on whichever store
// DATABASE_URL selects. Other files write in parallel on PostgreSQL, so every boat, agent and day
// here is this file's own (`sx-`, 2061).
const store = testStore();
const app = buildApp({ store });
after(async () => app.close());
before(async () => seedAgents(store, [], { 'sx-a1': null, 'sx-a2': null }));

const send = (method: InjectOptions['method'], url: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}) });
const deploy = (boat: string, route: string, date: string, capacity: number) => send('POST', '/operations/deployments', { boat_id: boat, route_id: route, service_date: date, capacity });
const available = async (route: string, date: string) => (await send('GET', `/v1/availability?route_id=${route}&date=${date}`)).json();
const lock = async (id: string) => (await send('GET', `/v1/seat-locks/${id}`)).json();
const log = async (url: string) => ((await send('GET', url)).json().events as { type: string; qty: number | null; note: string | null; booking_id: string | null; trip_date: string | null }[]);
const shift = (date: string, days: number) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const refused = (response: { statusCode: number; json: () => { code?: string } }, status: number, code?: string, why = '') => {
  assert.equal(response.statusCode, status, `${why}: ${JSON.stringify(response.json())}`);
  if (code) assert.equal(response.json().code, code, why);
};

test('the holder: an agent lock needs a real agent and serves that agent\'s bookings only', async () => {
  const date = '2061-01-05';
  await deploy('sx-h', 'r1', date, 30);
  refused(await send('POST', '/v1/seat-locks', { route_id: 'r1', service_date: date, pax: 2, agent_id: 'sx-nobody' }), 400, undefined, 'an unknown agent');
  refused(await send('POST', '/v1/seat-locks', { route_id: 'r1', service_date: date, pax: 2, holder_type: 'agent' }), 400, undefined, 'an agent lock with no agent');
  refused(await send('POST', '/v1/seat-locks', { route_id: 'r1', service_date: date, pax: 2, holder_type: 'office', agent_id: 'sx-a1' }), 400, undefined, 'an office lock naming an agent');
  refused(await send('POST', '/v1/seat-locks', { route_id: 'r1', service_date: date, pax: 2, holder_type: 'partner' }), 400, undefined, 'a holder type that does not exist');

  const mine = (await send('POST', '/v1/seat-locks', { route_id: 'r1', service_date: date, pax: 4, agent_id: 'sx-a1' })).json();
  assert.deepEqual([mine.holder_type, mine.agent_id], ['agent', 'sx-a1'], 'agent_id alone makes an agent lock');
  const office = (await send('POST', '/v1/seat-locks', { route_id: 'r1', service_date: date, pax: 2 })).json();
  assert.deepEqual([office.holder_type, office.agent_id], ['office', null], 'no holder is the office, legacy\'s default');

  const book = (agent: string | undefined, draws: Record<string, number>) =>
    send('POST', '/v1/bookings', { ...(agent ? { agent_id: agent } : {}), trips: [{ route_id: 'r1', date, pax: 1, lock_draws: draws }] });
  refused(await book('sx-a2', { [mine.id]: 1 }), 400, 'lock_other_agent', 'another agent');
  refused(await book(undefined, { [mine.id]: 1 }), 400, 'lock_other_agent', 'a booking with no agent');
  assert.equal((await book('sx-a1', { [mine.id]: 1 })).statusCode, 201, 'its own agent');
  assert.equal((await book('sx-a2', { [office.id]: 1 })).statusCode, 201, 'an office lock serves anyone');

  refused(await send('PATCH', `/v1/seat-locks/${mine.id}`, { agent_id: 'sx-a2' }), 409, 'lock_drawn', 'the holder is frozen once a seat is drawn');
  const moved = await send('PATCH', `/v1/seat-locks/${office.id}`, { holder_type: 'global' });
  refused(moved, 409, 'lock_drawn', 'the office lock is drawn too');
});

test('pending seats: short is asked about, split and all are kept apart, and confirm turns them into held seats', async () => {
  const date = '2061-01-06';
  await deploy('sx-p', 'r1', date, 10);
  const blocker = (await send('POST', '/v1/bookings', { route_id: 'r1', service_date: date, pax: 7 })).json();

  const short = await send('POST', '/v1/seat-locks', { route_id: 'r1', service_date: date, pax: 5 });
  refused(short, 409, 'seats_short', 'five asked, three free');
  assert.deepEqual(short.json().short, [{ service_date: date, free: 3, want: 5, short: 2 }]);
  assert.match(short.json().message, /3 free of 5 asked/);
  refused(await send('POST', '/v1/seat-locks', { route_id: 'r1', service_date: date, pax: 5, pending: 'some' }), 400, undefined, 'an unknown choice');

  const split = (await send('POST', '/v1/seat-locks', { route_id: 'r1', service_date: date, pax: 5, pending: 'split' })).json();
  assert.deepEqual([split.pax, split.pending_pax, split.held_pax, split.remaining_pax], [5, 2, 3, 3], 'lock what is free, the rest pending');
  assert.equal((await available('r1', date)).available_seats, 0, 'pending seats hold nothing');
  refused(await send('POST', '/v1/bookings', { trips: [{ route_id: 'r1', date, pax: 4, lock_draws: { [split.id]: 4 } }] }), 409, undefined, 'pending seats cannot be drawn');
  refused(await send('PATCH', `/v1/seat-locks/${split.id}`, { pending_pax: 0 }), 400, 'server_owned', 'pending_pax is the server\'s');

  const all = (await send('POST', '/v1/seat-locks', { route_id: 'r1', service_date: date, pax: 2, pending: 'all' })).json();
  assert.deepEqual([all.pending_pax, all.held_pax], [2, 0], 'all: the whole request waits');
  refused(await send('POST', `/v1/seat-locks/${all.id}/confirm-pending`), 409, 'no_free_seats', 'nothing free yet');
  refused(await send('PATCH', `/v1/seat-locks/${split.id}`, { pax: 6, pending: 'all' }), 400, undefined, '"all" is for a new lock');

  await send('POST', `/v1/bookings/${blocker.id}/cancel`, { category: 'sick' });
  const confirmed = (await send('POST', `/v1/seat-locks/${split.id}/confirm-pending`, { pax: 1 })).json();
  assert.deepEqual([confirmed.pending_pax, confirmed.held_pax], [1, 4], 'one asked, one confirmed');
  const rest = (await send('POST', `/v1/seat-locks/${split.id}/confirm-pending`)).json();
  assert.deepEqual([rest.pending_pax, rest.held_pax], [0, 5]);
  refused(await send('POST', `/v1/seat-locks/${split.id}/confirm-pending`), 409, 'nothing_pending');

  const events = await log(`/v1/seat-locks/${split.id}/log`);
  assert.deepEqual(events.map((e) => [e.type, e.qty]), [['create', 5], ['pend', 2], ['pend-confirm', 1], ['pend-confirm', 1]]);
  assert.equal(events[1].note, 'free 3 of 5', 'legacy\'s words');
});

test('a raise, a move and + seats are weighed too; lowering takes pending seats off first', async () => {
  const date = '2061-01-07', other = '2061-01-08';
  await deploy('sx-r', 'r1', date, 6);
  await deploy('sx-r2', 'r1', other, 6);
  const l = (await send('POST', '/v1/seat-locks', { route_id: 'r1', service_date: date, pax: 4 })).json();
  refused(await send('PATCH', `/v1/seat-locks/${l.id}`, { pax: 8 }), 409, 'seats_short', 'six seats on the boat');
  const raised = (await send('PATCH', `/v1/seat-locks/${l.id}`, { pax: 8, pending: 'split' })).json();
  assert.deepEqual([raised.pax, raised.pending_pax, raised.held_pax], [8, 2, 6]);
  const lowered = (await send('PATCH', `/v1/seat-locks/${l.id}`, { pax: 7 })).json();
  assert.deepEqual([lowered.pending_pax, lowered.held_pax], [1, 6], 'the seat taken off was a pending one');
  refused(await send('POST', `/v1/seat-locks/${l.id}/add`, { pax: 3 }), 409, 'seats_short', '+ seats asks the pool too');
  const added = (await send('POST', `/v1/seat-locks/${l.id}/add`, { pax: 3, note: 'late group', pending: 'split' })).json();
  assert.deepEqual([added.pax, added.pending_pax], [10, 4]);

  const movedTo = (await send('PATCH', `/v1/seat-locks/${l.id}`, { service_date: other, pax: 3 })).json();
  assert.deepEqual([movedTo.service_date, movedTo.pending_pax, movedTo.held_pax], [other, 0, 3], 'a move starts the pending seats again, on the new day');
  assert.equal((await available('r1', date)).locked_pax, 0, 'the old day is free again');
  const types = (await log(`/v1/seat-locks/${l.id}/log`)).map((e) => e.type);
  assert.deepEqual(types, ['create', 'edit', 'pend', 'edit', 'add', 'pend', 'edit']);
  const edit = (await log(`/v1/seat-locks/${l.id}/log`)).filter((e) => e.type === 'edit').at(-1)!;
  assert.equal(edit.note, `pax: 10 → 3 · service_date: ${date} → ${other}`, 'legacy\'s edit line: field: old → new');

  await send('POST', '/v1/bookings', { trips: [{ route_id: 'r1', date: other, pax: 2, lock_draws: { [l.id]: 2 } }] });
  refused(await send('PATCH', `/v1/seat-locks/${l.id}`, { service_date: date }), 409, 'lock_drawn', 'a drawn lock cannot move');
  refused(await send('PATCH', `/v1/seat-locks/${l.id}`, { pax: 1 }), 409, 'below_floor', 'nor shrink below its draws');
});

test('expiry: past its day a lock stops holding, worked out on read; today it still holds', async () => {
  const date = '2061-01-09';
  await deploy('sx-e', 'r1', date, 20);
  const today = todayInThailand();
  const expired = (await send('POST', '/v1/seat-locks', { route_id: 'r1', service_date: date, pax: 5, expiry: shift(today, -1) })).json();
  const holding = (await send('POST', '/v1/seat-locks', { route_id: 'r1', service_date: date, pax: 3, expiry: today })).json();
  assert.deepEqual([expired.holding, expired.state, expired.held_pax, expired.status], [false, 'expired', 0, 'active'], 'status is not rewritten; the state is read');
  assert.deepEqual([holding.holding, holding.state, holding.held_pax], [true, 'active', 3]);
  assert.equal((await available('r1', date)).locked_pax, 3, 'only the lock still holding counts');
  refused(await send('POST', '/v1/bookings', { trips: [{ route_id: 'r1', date, pax: 1, lock_draws: { [expired.id]: 1 } }] }), 400, undefined, 'an expired lock is drawn from no more');
  refused(await send('POST', '/v1/seat-locks', { route_id: 'r1', service_date: date, pax: 1, expiry: '2061-02-30' }), 400, undefined, 'not a date');
});

test('sub-groups: carved from the parent\'s room, drawn by name, counted once in the pool', async () => {
  const date = '2061-01-10';
  await deploy('sx-s', 'r1', date, 40);
  const parent = (await send('POST', '/v1/seat-locks', { route_id: 'r1', service_date: date, pax: 10, agent_id: 'sx-a1', reason: 'Fam trip' })).json();
  const a = await send('POST', `/v1/seat-locks/${parent.id}/sub-groups`, { sub_name: 'A', pax: 4, reason: '@Chicky65' });
  assert.equal(a.statusCode, 201, a.body);
  const sub = a.json();
  assert.deepEqual([sub.parent_id, sub.sub_name, sub.agent_id, sub.reason, sub.held_pax, sub.remaining_pax], [parent.id, 'A', 'sx-a1', '@Chicky65', 0, 4]);
  refused(await send('POST', `/v1/seat-locks/${parent.id}/sub-groups`, { sub_name: 'B', pax: 7 }), 409, 'no_room', 'six left to split');
  refused(await send('POST', `/v1/seat-locks/${parent.id}/sub-groups`, { pax: 1 }), 400, undefined, 'a sub-group needs a name');
  refused(await send('POST', `/v1/seat-locks/${sub.id}/sub-groups`, { sub_name: 'A1', pax: 1 }), 400, undefined, 'one level only');
  refused(await send('PATCH', `/v1/seat-locks/${sub.id}`, { agent_id: 'sx-a2' }), 400, undefined, 'a sub-group takes its parent\'s holder');
  refused(await send('PATCH', `/v1/seat-locks/${sub.id}`, { pax: 11 }), 409, 'no_room', 'it grows only into the parent\'s room');

  assert.equal((await available('r1', date)).locked_pax, 10, 'the pool counts the parent alone');
  const viewed = await lock(parent.id);
  assert.deepEqual([viewed.allocated_pax, viewed.remaining_pax, viewed.sub_group_room, viewed.held_pax], [4, 6, 6, 10]);

  const drew = await send('POST', '/v1/bookings', { agent_id: 'sx-a1', trips: [{ route_id: 'r1', date, pax: 3, lock_draws: { [sub.id]: 3 } }] });
  assert.equal(drew.statusCode, 201, drew.body);
  refused(await send('POST', '/v1/bookings', { agent_id: 'sx-a1', trips: [{ route_id: 'r1', date, pax: 2, lock_draws: { [sub.id]: 2 } }] }), 409, undefined, 'A has one left');
  refused(await send('POST', '/v1/bookings', { agent_id: 'sx-a1', trips: [{ route_id: 'r1', date, pax: 7, lock_draws: { [parent.id]: 7 } }] }), 409, undefined, 'the parent gives only its six unsplit seats');
  const day = await available('r1', date);
  assert.deepEqual([day.booked_pax, day.locked_pax], [3, 7], 'drawn seats are held once: 10 asked, 3 sold');

  const back = (await send('POST', `/v1/seat-locks/${sub.id}/release`)).json();
  assert.deepEqual([back.status, back.pax, back.released_pax, back.drawn_pax], ['released', 4, 1, 3], 'the undrawn seat went back; what was asked is kept');
  const after = await lock(parent.id);
  assert.deepEqual([after.allocated_pax, after.remaining_pax, after.held_pax], [3, 7, 7], 'to the parent, not to the pool');
  assert.equal((await lock(sub.id)).expiry, parent.expiry, 'a sub-group\'s expiry is its parent\'s');
});

test('release keeps the seats asked and records the seats given back; release-departure takes the whole departure back', async () => {
  const date = '2061-01-11';
  await deploy('sx-rel', 'r1', date, 40);
  const l = (await send('POST', '/v1/seat-locks', { route_id: 'r1', service_date: date, pax: 10 })).json();
  await send('POST', '/v1/bookings', { trips: [{ route_id: 'r1', date, pax: 2, lock_draws: { [l.id]: 2 } }] });
  refused(await send('POST', `/v1/seat-locks/${l.id}/release`, { pax: 9 }), 409, 'below_floor', 'two of the ten are drawn');
  const part = (await send('POST', `/v1/seat-locks/${l.id}/release`, { pax: 3 })).json();
  assert.deepEqual([part.pax, part.released_pax, part.status, part.held_pax], [10, 3, 'active', 5]);
  refused(await send('PATCH', `/v1/seat-locks/${l.id}`, { released_pax: 0 }), 400, 'server_owned');
  const all = (await send('POST', `/v1/seat-locks/${l.id}/release`)).json();
  assert.deepEqual([all.released_pax, all.status, all.state], [8, 'released', 'depleted'], 'nothing left, something drawn: legacy says depleted');
  assert.equal((await send('POST', `/v1/seat-locks/${l.id}/release`)).json().version, all.version, 'releasing twice changes nothing');
  const again = (await send('POST', `/v1/seat-locks/${l.id}/add`, { pax: 2 })).json();
  assert.deepEqual([again.status, again.held_pax], ['active', 2], '+ seats brings a released lock back');

  const tree = (await send('POST', '/v1/seat-locks', { route_id: 'r1', service_date: date, pax: 6 })).json();
  const kid = (await send('POST', `/v1/seat-locks/${tree.id}/sub-groups`, { sub_name: 'B', pax: 2 })).json();
  refused(await send('POST', `/v1/seat-locks/${kid.id}/release-departure`), 400, undefined, 'a sub-group goes with its departure');
  const before = (await available('r1', date)).locked_pax;
  const gone = (await send('POST', `/v1/seat-locks/${tree.id}/release-departure`)).json();
  assert.deepEqual([gone.status, gone.held_pax], ['released', 0]);
  assert.equal((await available('r1', date)).locked_pax, before - 6, 'sub-group seats included');
  assert.equal((await lock(kid.id)).holding, false);
  const [round] = (await log(`/v1/seat-locks/${tree.id}/log`)).filter((e) => e.type === 'release-round');
  assert.deepEqual([round.qty, round.trip_date], [6, date]);
});

test('the log gets a draw and a return from every booking write, and a cancel returns every seat', async () => {
  const date = '2061-01-12';
  await deploy('sx-log', 'r1', date, 40);
  const l = (await send('POST', '/v1/seat-locks', { route_id: 'r1', service_date: date, pax: 6, agent_id: 'sx-a1' })).json();
  const b = (await send('POST', '/v1/bookings', { agent_id: 'sx-a1', trips: [{ route_id: 'r1', date, pax: 4, lock_draws: { [l.id]: 3 } }] })).json();
  await send('PATCH', `/v1/bookings/${b.id}`, { trips: [{ id: b.trips[0].id, route_id: 'r1', date, pax: 4, lock_draws: { [l.id]: 1 } }] });
  await send('POST', `/v1/bookings/${b.id}/cancel`, { category: 'sick' });
  const lines = (await log(`/v1/seat-locks/${l.id}/log`)).filter((e) => e.booking_id === b.id);
  assert.deepEqual(lines.map((e) => [e.type, e.qty, e.note, e.trip_date]), [['draw', 3, null, date], ['return', 2, 'edit', date], ['return', 1, 'cancel', date]]);
  refused(await send('GET', '/v1/seat-locks/sx-missing/log'), 404);
});

test('a bulk lock: one lock per running departure on the weekdays chosen, edited and released as one', async () => {
  const [from, to] = ['2061-02-01', '2061-02-28'];
  refused(await send('POST', '/v1/seat-lock-groups', { route_id: 'r2', date_from: from, pax: 3 }), 400, undefined, 'the last day is required (legacy §lkZero)');
  refused(await send('POST', '/v1/seat-lock-groups', { route_id: 'r2', date_from: to, date_to: from, pax: 3 }), 400, undefined, 'backwards');
  refused(await send('POST', '/v1/seat-lock-groups', { route_id: 'r2', date_from: '2061-02-01', date_to: '2061-02-01', weekdays: [1], pax: 3 }), 400, 'no_departure', 'a Tuesday with Mondays ticked');
  refused(await send('POST', '/v1/seat-lock-groups', { route_id: 'r2', date_from: from, date_to: to, weekdays: [9], pax: 3 }), 400, undefined, 'no ninth weekday');

  const made = await send('POST', '/v1/seat-lock-groups', { route_id: 'r2', date_from: from, date_to: to, weekdays: [2, 4], pax: 3, agent_id: 'sx-a2', reason: 'Tue/Thu', release_days_before: 1, release_time: '18:00' });
  assert.equal(made.statusCode, 201, made.body);
  const group = made.json();
  assert.equal(group.departures, 8, 'Tuesdays and Thursdays of February 2061');
  assert.ok(group.seat_locks.every((l: { group_id: string; agent_id: string; pax: number; service_date: string }) =>
    l.group_id === group.id && l.agent_id === 'sx-a2' && l.pax === 3 && [2, 4].includes(new Date(`${l.service_date}T00:00:00Z`).getUTCDay())));
  assert.equal(group.seat_locks[0].release_at, '2061-01-31T11:00:00.000Z', '1 day before at 18:00 Bangkok');
  assert.equal(group.seat_locks[0].overdue, false);

  refused(await send('PATCH', `/v1/seat-lock-groups/${group.id}`, { date_to: '2061-03-31' }), 400, 'server_owned', 'the range is not edited here');
  const edited = (await send('PATCH', `/v1/seat-lock-groups/${group.id}`, { pax: 5, reason: 'Tue/Thu, five' })).json();
  assert.ok(edited.seat_locks.every((l: { pax: number }) => l.pax === 5));
  const first = group.seat_locks[0];
  refused(await send('PATCH', `/v1/seat-locks/${first.id}`, { agent_id: 'sx-a1' }), 400, undefined, 'a departure takes its bulk lock\'s holder');
  refused(await send('PATCH', `/v1/seat-locks/${first.id}`, { expiry: '2061-01-30' }), 400, undefined, 'a departure has no expiry');

  const released = (await send('POST', `/v1/seat-lock-groups/${group.id}/release`, { pax: 2 })).json();
  assert.ok(released.seat_locks.every((l: { released_pax: number; held_pax: number }) => l.released_pax === 2 && l.held_pax === 3));
  const subs = (await send('POST', `/v1/seat-lock-groups/${group.id}/sub-groups`, { sub_name: 'Tukta', pax: 2 })).json();
  assert.equal(subs.seat_locks.filter((l: { sub_name: string | null }) => l.sub_name === 'Tukta').length, 8, 'one per departure');
  const lines = await log(`/v1/seat-lock-groups/${group.id}/log`);
  assert.deepEqual(lines.slice(0, 3).map((e) => e.type), ['create', 'edit', 'release']);
  assert.equal(lines[1].note, 'pax: 3 → 5 · reason: Tue/Thu → Tue/Thu, five');
  const listed = (await send('GET', '/v1/seat-lock-groups?agent_id=sx-a2')).json().seat_lock_groups;
  assert.deepEqual(listed.map((g: { id: string; held_pax: number }) => [g.id, g.held_pax]), [[group.id, 24]]);
});

test('a bulk departure past its release cutoff is overdue, holds on, and is released by hand', async () => {
  // A land route runs every day and sells ungated, so this does not depend on the season calendar.
  const today = todayInThailand();
  const group = (await send('POST', '/v1/seat-lock-groups', { route_id: 'test-land', date_from: shift(today, 1), date_to: shift(today, 1), pax: 4, release_days_before: 2, release_time: '09:00' })).json();
  const [departure] = group.seat_locks;
  assert.deepEqual([departure.overdue, departure.holding, departure.held_pax], [true, true, 4], 'a warning only: it still holds (§lkNoAuto)');
  const done = (await send('POST', '/v1/seat-locks/release-overdue', { service_date: shift(today, 1), route_id: 'test-land' })).json();
  assert.deepEqual(done.released.map((l: { id: string }) => l.id), [departure.id]);
  assert.equal(done.seats, 4);
  assert.deepEqual([(await lock(departure.id)).status, (await lock(departure.id)).overdue], ['released', false]);
  refused(await send('POST', '/v1/seat-locks/release-overdue', {}), 400, undefined, 'the day is required');
});

// ── The arithmetic alone (seat-locks.ts), against legacy's own examples ─────────────────────────

test('lockTree: pending seats on a parent are shared out in sub-group order, then to its unsplit seats (§lkPendSub)', async () => {
  const { lockTree } = await import('../src/domain/seat-locks.js');
  const node = (id: string, pax: number, drawn = 0, pending = 0, created_at = id) => ({ id, pax, drawn, pending, released: false, created_at });
  // 10 asked, 4 pending: 6 held. A (4) is served first, B (3) gets the last 2, the 3 unsplit wait.
  const tree = lockTree(node('p', 10, 0, 4), [node('b', 3, 0, 0, '2'), node('a', 4, 0, 0, '1')]);
  assert.deepEqual([tree.held, tree.pend, tree.allocated, tree.unallocated, tree.room], [6, 4, 7, 3, 3]);
  assert.deepEqual([tree.children.get('a'), tree.children.get('b'), tree.parent], [{ remaining: 4, pending: 0 }, { remaining: 2, pending: 1 }, { remaining: 0, pending: 3 }]);
  // No pending: each draws its own seats, never past what the parent holds (§lkOver).
  const sold = lockTree(node('p', 10, 5), [node('a', 4, 1)]);
  assert.deepEqual([sold.held, sold.room, sold.parent.remaining, sold.children.get('a')!.remaining], [4, 1, 1, 3]);
});
