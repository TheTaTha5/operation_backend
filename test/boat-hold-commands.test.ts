import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { InjectOptions } from 'fastify';

process.env.AUTH_JWT_SECRET = 'boat-hold-commands-test-secret';
const { buildApp } = await import('../src/app.js');
const { OperationsStore } = await import('../src/domain/operations.js');
const { todayInThailand } = await import('../src/domain/calendar.js');
const { seedAgents, seedUser, testStore, tokenFor } = await import('./users-helper.js');

// Whole-boat holds made, edited, released and converted through the API (todo/seat-lock-extras-model.md,
// "Design — whole-boat holds"; legacy §bkLock), on whichever store DATABASE_URL selects. Other files
// write in parallel on PostgreSQL, so every boat, agent and day here is this file's own (`bh-`, 2065).
const store = testStore();
if (store instanceof OperationsStore) {
  store.seedCatalogue({ routes: [
    { id: 'r1', name: 'Early Tratato Similan Islands', pier: 'tublamu' }, { id: 'r2', name: 'Early Tiger Similan Islands', pier: 'tublamu' },
    { id: 'r7', name: 'Early OTA Phi Phi Bamboo', pier: 'panwa' }, { id: 'test-land', name: 'Test land transfer', kind: 'land' },
  ] });
}
const app = buildApp({ store });
after(async () => app.close());
let auth: Record<string, string> = {};
before(async () => {
  await seedAgents(store, [], { 'bh-a1': null, 'bh-a2': null });
  await seedUser(store, { username: 'bh-admin', role: 'admin' });
  auth = await tokenFor(app, 'bh-admin');
});

/** Response bodies, read loosely. */
type Json = any;
const send = (method: InjectOptions['method'], url: string, payload?: object, extra: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { ...auth, ...extra }, ...(payload ? { payload } : {}) });
const ok = async (method: InjectOptions['method'], url: string, payload?: object, status = 200, extra: Record<string, string> = {}): Promise<Json> => {
  const res = await send(method, url, payload, extra);
  assert.equal(res.statusCode, status, `${method} ${url}: ${res.body}`);
  return res.json();
};
const refused = async (method: InjectOptions['method'], url: string, payload: object | undefined, status: number, code?: string, extra: Record<string, string> = {}): Promise<Json> => {
  const res = await send(method, url, payload, extra);
  assert.equal(res.statusCode, status, `${method} ${url}: ${res.body}`);
  if (code) assert.equal(res.json().code, code, res.body);
  return res.json();
};
let seq = 0;
const boat = async (capacity: number, extra: object = {}): Promise<{ id: string; name: string }> =>
  ok('POST', '/v1/boats', { name: `BH ${Date.now()}-${seq++}`, pier: 'tublamu', capacity, license_pax: capacity + 7, ...extra }, 201);
const day = async (route: string, date: string) => (await ok('GET', `/v1/availability?route_id=${route}&from=${date}&to=${date}`)).days[0];
const deployedOn = async (date: string, boatId: string) => (await ok('GET', `/operations/deployments?from=${date}&to=${date}`)).deployments.find((d: Json) => d.boat_id === boatId);
const log = async (id: string) => (await ok('GET', `/v1/seat-locks/${id}/log`)).events as Json[];
const v = (lock: { version: number }) => ({ 'if-match': `"${lock.version}"` });
const hold = (body: object) => send('POST', '/v1/seat-locks', { route_id: 'r1', expiry: '2065-01-01', ...body });

test('create: legacy\'s form checks, then the hold takes its boat and places it on the route', async () => {
  const date = '2065-01-05';
  const b = await boat(38);
  const base = { service_date: date, boat_id: b.id, pax: 38, expiry: '2065-01-04' };
  assert.match((await refused('POST', '/v1/seat-locks', { route_id: 'r1', ...base, expiry: undefined }, 400)).message, /Expiry date is required/);
  assert.match((await refused('POST', '/v1/seat-locks', { route_id: 'r1', ...base, expiry: '2065-01-06' }, 400)).message, /on or before the travel date/);
  assert.match((await refused('POST', '/v1/seat-locks', { route_id: 'r1', ...base, pax: 0 }, 400)).message, /minimum seats promised/);
  await refused('POST', '/v1/seat-locks', { route_id: 'r1', ...base, boat_deal: 'maybe' }, 400);
  await refused('POST', '/v1/seat-locks', { route_id: 'r1', ...base, pending: 'split' }, 400);
  await refused('POST', '/v1/seat-locks', { route_id: 'r1', ...base, agent_id: 'bh-nobody' }, 400);
  await refused('POST', '/v1/seat-locks', { route_id: 'r1', ...base, boat_id: 'bh-no-such-boat' }, 400);
  assert.match((await refused('POST', '/v1/seat-locks', { route_id: 'test-land', ...base }, 400, 'land_route')).message, /land programme has no boat/);

  assert.equal(await deployedOn(date, b.id), undefined, 'not on the board yet');
  const made = await ok('POST', '/v1/seat-locks', { route_id: 'r1', ...base, agent_id: 'bh-a1', reason: 'Fam Trip' }, 201);
  assert.deepEqual([made.boat_id, made.boat_deal, made.pax, made.status, made.state, made.held_pax, made.converted_booking_id, made.holder_type, made.agent_id, made.created_by],
    [b.id, 'fixed', 38, 'active', 'active', null, null, 'agent', 'bh-a1', 'bh-admin']);
  assert.equal((await deployedOn(date, b.id)).route_id, 'r1', 'legacy writes the boat-board cell: the boat is placed on the route');
  const seats = await day('r1', date);
  assert.deepEqual([seats.deployments.find((x: Json) => x.boat_id === b.id).chartered, seats.locked_pax], [true, 0], 'taken whole, holding no seats besides');
  assert.deepEqual((await log(made.id)).map((e) => [e.type, e.qty, e.by]), [['create', 38, 'bh-admin']]);
  assert.ok((await ok('GET', `/v1/seat-locks?kind=boat&service_date=${date}`)).seat_locks.some((l: Json) => l.id === made.id));
  assert.ok(!(await ok('GET', `/v1/seat-locks?kind=seats&service_date=${date}`)).seat_locks.some((l: Json) => l.id === made.id));
  await refused('GET', '/v1/seat-locks?kind=whole', undefined, 400);

  // A hold whose expiry has passed still holds: it reads overdue (legacy never expires one by itself).
  const late = await ok('POST', '/v1/seat-locks', { route_id: 'r1', service_date: date, boat_id: (await boat(20)).id, pax: 20, expiry: '2020-01-01' }, 201);
  assert.deepEqual([late.holding, late.overdue, late.state], [true, true, 'active']);
});

test('create: the boat must be free, on the route\'s pier, ready, and not placed on another route', async () => {
  const date = '2065-01-06';
  const elsewhere = await boat(30);
  await ok('POST', '/operations/deployments', { boat_id: elsewhere.id, route_id: 'r2', service_date: date, capacity: 30 }, 201);
  const other = await refused('POST', '/v1/seat-locks', { route_id: 'r1', service_date: date, boat_id: elsewhere.id, pax: 30, expiry: date }, 409, 'boat_other_route');
  assert.match(other.message, /already placed on Early Tiger Similan Islands/);
  assert.equal(other.blockers.placed_route_id, 'r2');

  const panwa = await boat(30, { pier: 'panwa' });
  await refused('POST', '/v1/seat-locks', { route_id: 'r1', service_date: date, boat_id: panwa.id, pax: 30, expiry: date }, 409, 'boat_other_pier');
  const fixing = await boat(30, { status: 'fixing' });
  await refused('POST', '/v1/seat-locks', { route_id: 'r1', service_date: date, boat_id: fixing.id, pax: 30, expiry: date }, 409, 'boat_not_ready');

  // Passengers placed on the boat: listed, so staff know which bookings to move (legacy's blocker table).
  const carrying = await boat(30);
  const spare = await boat(40);
  await ok('POST', '/operations/deployments', { boat_id: carrying.id, route_id: 'r1', service_date: date, capacity: 30 }, 201);
  await ok('POST', '/operations/deployments', { boat_id: spare.id, route_id: 'r1', service_date: date, capacity: 40 }, 201);
  const sold = await ok('POST', '/v1/bookings', { route_id: 'r1', service_date: date, pax: 6, voucher_ref: 'BH-V1' }, 201);
  await ok('PATCH', `/operations/trip-ops/${sold.trips[0].id}`, { boat_id: carrying.id });
  const taken = await refused('POST', '/v1/seat-locks', { route_id: 'r1', service_date: date, boat_id: carrying.id, pax: 30, expiry: date }, 409, 'boat_taken');
  assert.match(taken.message, /1 booking\(s\) \(6 pax\) are on it/);
  assert.deepEqual(taken.blockers.bookings.map((r: Json) => [r.booking_id, r.voucher_ref, r.pax]), [[sold.id, 'BH-V1', 6]]);

  // Another hold or a charter on the boat that day.
  const first = await ok('POST', '/v1/seat-locks', { route_id: 'r1', service_date: date, boat_id: spare.id, pax: 40, expiry: date }, 201);
  const again = await refused('POST', '/v1/seat-locks', { route_id: 'r1', service_date: date, boat_id: spare.id, pax: 40, expiry: date }, 409, 'boat_taken');
  assert.equal(again.blockers.hold_id, first.id);
  const chartered = await boat(30);
  await ok('POST', '/operations/deployments', { boat_id: chartered.id, route_id: 'r1', service_date: date, capacity: 30 }, 201);
  const charter = await ok('POST', '/v1/bookings', { trips: [{ route_id: 'r1', date, pax: { ad: 10 }, booking_mode: 'charter', charter_boat_id: chartered.id }] }, 201);
  assert.equal((await refused('POST', '/v1/seat-locks', { route_id: 'r1', service_date: date, boat_id: chartered.id, pax: 30, expiry: date }, 409, 'boat_taken')).blockers.charter_booking_id, charter.id);
});

test('create: a boat whose seats the day\'s sales need is refused; an "any" hold needs a boat that big', async () => {
  const date = '2065-01-07';
  const a = await boat(20), c = await boat(20);
  await ok('POST', '/operations/deployments', { boat_id: a.id, route_id: 'r1', service_date: date, capacity: 20 }, 201);
  await ok('POST', '/operations/deployments', { boat_id: c.id, route_id: 'r1', service_date: date, capacity: 20 }, 201);
  await ok('POST', '/v1/bookings', { route_id: 'r1', service_date: date, pax: 25 }, 201);
  const short = await refused('POST', '/v1/seat-locks', { route_id: 'r1', service_date: date, boat_id: a.id, pax: 20, expiry: date }, 409, 'boat_taken');
  assert.deepEqual([short.blockers.sold, short.blockers.short], [25, 5]);
  assert.match(short.message, /sold 25 seats, and without this boat it would be 5 short/);
  // An extra boat not yet on the route takes nothing from it (decided here; legacy took its seats off anyway).
  const extra = await boat(30);
  assert.equal((await send('POST', '/v1/seat-locks', { route_id: 'r1', service_date: date, boat_id: extra.id, pax: 30, expiry: date })).statusCode, 201);

  const small = await boat(34);
  const tooSmall = await refused('POST', '/v1/seat-locks', { route_id: 'r1', service_date: '2065-01-08', boat_id: small.id, pax: 40, boat_deal: 'any', expiry: '2065-01-08' }, 409, 'boat_too_small');
  assert.match(tooSmall.message, /fewer seats than the minimum promised/);
  const fixedSmall = await ok('POST', '/v1/seat-locks', { route_id: 'r1', service_date: '2065-01-08', boat_id: small.id, pax: 40, expiry: '2065-01-08' }, 201);
  assert.equal(fixedSmall.boat_deal, 'fixed', 'a fixed hold promises the boat itself, whatever its size');
});

test('edit: legacy\'s form on an active hold, the version required, a fixed boat changed only when told', async () => {
  const date = '2065-01-09';
  const first = await boat(38), second = await boat(40), third = await boat(30);
  const h = await ok('POST', '/v1/seat-locks', { route_id: 'r1', service_date: date, boat_id: first.id, pax: 38, expiry: '2065-01-08' }, 201);
  await refused('PATCH', `/v1/seat-locks/${h.id}`, { reason: 'x' }, 428, 'version_required');
  await refused('PATCH', `/v1/seat-locks/${h.id}`, { expiry: null }, 400, undefined, v(h));
  await refused('PATCH', `/v1/seat-locks/${h.id}`, { expiry: '2065-01-10' }, 400, undefined, v(h));
  await refused('PATCH', `/v1/seat-locks/${h.id}`, { status: 'released' }, 400, 'server_owned', v(h));
  await refused('PATCH', `/v1/seat-locks/${h.id}`, { converted_booking_id: 'x' }, 400, 'server_owned', v(h));
  await refused('PATCH', `/v1/seat-locks/${h.id}`, { sub_name: 'A' }, 400, undefined, v(h));

  const same = await ok('PATCH', `/v1/seat-locks/${h.id}`, { reason: null, pax: 38 }, 200, v(h));
  assert.equal(same.version, h.version, 'nothing changed, nothing written');
  const noted = await ok('PATCH', `/v1/seat-locks/${h.id}`, { reason: 'โทรมาล็อก', agent_id: 'bh-a2' }, 200, v(h));
  assert.deepEqual([noted.reason, noted.holder_type, noted.agent_id], ['โทรมาล็อก', 'agent', 'bh-a2']);

  const fixed = await refused('PATCH', `/v1/seat-locks/${h.id}`, { boat_id: second.id }, 409, 'fixed_boat', v(noted));
  assert.match(fixed.message, /names a specific boat for bh-a2/);
  const swapped = await ok('PATCH', `/v1/seat-locks/${h.id}`, { boat_id: second.id, change_boat_anyway: true }, 200, v(noted));
  assert.equal(swapped.boat_id, second.id);
  const seats = await day('r1', date);
  const chartered = (id: string) => seats.deployments.find((x: Json) => x.boat_id === id)?.chartered;
  assert.deepEqual([chartered(first.id), chartered(second.id)], [false, true], 'the old boat stays on the route as a normal boat, the new one is taken');
  assert.match((await log(h.id)).at(-1)!.note, new RegExp(`boat: ${first.name} → ${second.name}`));

  // An "any" hold may go to any free boat that seats the minimum, without asking.
  const any = await ok('PATCH', `/v1/seat-locks/${h.id}`, { boat_deal: 'any' }, 200, v(swapped));
  await refused('PATCH', `/v1/seat-locks/${h.id}`, { boat_id: third.id }, 409, 'boat_too_small', v(any));
  // Moving the hold to another route takes its boat along: the deployment moves with it.
  const rerouted = await ok('PATCH', `/v1/seat-locks/${h.id}`, { route_id: 'r2' }, 200, v(any));
  assert.equal((await deployedOn(date, second.id)).route_id, 'r2');
  assert.match((await log(h.id)).at(-1)!.note, /route: r1 → r2/);
  // A move to a day the boat is placed elsewhere is refused like a create.
  await ok('POST', '/operations/deployments', { boat_id: second.id, route_id: 'r1', service_date: '2065-01-10', capacity: 40 }, 201);
  await refused('PATCH', `/v1/seat-locks/${h.id}`, { service_date: '2065-01-10', expiry: '2065-01-09' }, 409, 'boat_other_route', v(rerouted));
});

test('release: the boat goes back to the pool at once, its deployment stays; a pulled boat needs the hold released first', async () => {
  const date = '2065-01-11';
  const b = await boat(38);
  const h = await ok('POST', '/v1/seat-locks', { route_id: 'r1', service_date: date, boat_id: b.id, pax: 38, expiry: date }, 201);
  const pulled = await refused('DELETE', `/operations/deployments/${date}/${b.id}`, undefined, 409, 'boat_held');
  assert.match(pulled.message, /held whole for an agent\. Release the hold on the Seat Locks page first/);
  await refused('POST', '/operations/deployments', { boat_id: b.id, route_id: 'r2', service_date: date, capacity: 38 }, 409, 'boat_held');

  await refused('POST', `/v1/seat-locks/${h.id}/release`, { pax: 5 }, 400, 'boat_hold', v(h));
  await refused('POST', `/v1/seat-locks/${h.id}/release`, {}, 428);
  const released = await ok('POST', `/v1/seat-locks/${h.id}/release`, {}, 200, v(h));
  assert.deepEqual([released.status, released.state, released.holding], ['released', 'released', false]);
  assert.equal((await day('r1', date)).deployments.find((x: Json) => x.boat_id === b.id).chartered, false);
  assert.equal((await deployedOn(date, b.id)).route_id, 'r1', 'legacy turns the cell back to normal, never deletes it');
  assert.deepEqual((await log(h.id)).at(-1), { ...(await log(h.id)).at(-1), type: 'release', qty: null, note: `manual · ${b.name}` });
  assert.equal((await ok('POST', `/v1/seat-locks/${h.id}/release`, {}, 200, v(released))).version, released.version, 'again: nothing to do');
  await refused('PATCH', `/v1/seat-locks/${h.id}`, { reason: 'x' }, 409, 'hold_not_active', v(released));
  assert.equal((await send('DELETE', `/operations/deployments/${date}/${b.id}`)).statusCode, 204, 'released, the boat may go');
});

test('convert: a booking for the holder on the held boat, in one transaction; a refused booking leaves the hold', async () => {
  const date = '2065-01-12';
  const b = await boat(38);
  const h = await ok('POST', '/v1/seat-locks', { route_id: 'r1', service_date: date, boat_id: b.id, pax: 38, expiry: date, agent_id: 'bh-a1' }, 201);
  await refused('POST', `/v1/seat-locks/${h.id}/convert`, { trips: [{ pax: { ad: 30 } }] }, 428, 'version_required');
  await refused('POST', `/v1/seat-locks/${h.id}/convert`, { trips: [{ pax: { ad: 30 } }], intent: 'quote' }, 400, 'hold_quote', v(h));
  await refused('POST', `/v1/seat-locks/${h.id}/convert`, { trips: [{ pax: { ad: 30 }, booking_mode: 'seat', charter_boat_id: undefined }] }, 400, undefined, v(h));
  await refused('POST', `/v1/seat-locks/${h.id}/convert`, { route_id: 'r2', pax: 30 }, 400, 'hold_mismatch', v(h));
  // Over the boat's licence: the booking is refused, and the hold is as it was.
  await refused('POST', `/v1/seat-locks/${h.id}/convert`, { trips: [{ pax: { ad: 60 } }] }, 409, undefined, v(h));
  assert.equal((await ok('GET', `/v1/seat-locks/${h.id}`)).status, 'active');
  // Nobody else may charter the held boat.
  await refused('POST', '/v1/bookings', { trips: [{ route_id: 'r1', date, pax: { ad: 10 }, booking_mode: 'charter', charter_boat_id: b.id }] }, 409);

  const done = await ok('POST', `/v1/seat-locks/${h.id}/convert`, { trips: [{ pax: { ad: 30 } }], lead_pax: 'Mikhail' }, 201, v(h));
  const trip = done.booking.trips[0];
  assert.deepEqual([done.booking.agent_id, trip.route_id, trip.service_date, trip.booking_mode, trip.charter_boat_id, done.booking.status],
    ['bh-a1', 'r1', date, 'charter', b.id, 'confirmed'], 'prefilled from the hold, as legacy\'s form');
  assert.deepEqual([done.seat_lock.status, done.seat_lock.state, done.seat_lock.converted_booking_id, done.seat_lock.holding], ['converted', 'converted', done.booking.id, false]);
  const convertLine = (await log(h.id)).at(-1)!;
  assert.deepEqual([convertLine.type, convertLine.booking_id, convertLine.note], ['convert', done.booking.id, `เหมาลำ ${b.name}`]);
  const seats = await day('r1', date);
  assert.deepEqual([seats.deployments.find((x: Json) => x.boat_id === b.id).chartered, seats.charter_pax], [true, 30], 'the boat passed from the hold to the charter');

  const converted = done.seat_lock;
  await refused('POST', `/v1/seat-locks/${h.id}/convert`, { trips: [{ pax: { ad: 30 } }] }, 409, 'hold_converted', v(converted));
  await refused('POST', `/v1/seat-locks/${h.id}/release`, {}, 409, 'hold_converted', v(converted));
  await refused('PATCH', `/v1/seat-locks/${h.id}`, { reason: 'x' }, 409, 'hold_converted', v(converted));

  // Only a hold converts.
  const plain = await ok('POST', '/v1/seat-locks', { route_id: 'r1', service_date: '2065-01-13', pax: 2 }, 201);
  await refused('POST', `/v1/seat-locks/${plain.id}/convert`, { pax: 2 }, 400, 'not_a_hold', v(plain));
  await refused('PATCH', `/v1/seat-locks/${plain.id}`, { boat_id: b.id }, 400, 'server_owned', v(plain));
});

test('boat options: legacy\'s list, the route\'s pier only, each boat with why it cannot be held', async () => {
  const date = '2065-01-14';
  const free = await boat(50), busy = await boat(30), held = await boat(40), panwa = await boat(30, { pier: 'panwa' });
  await ok('POST', '/operations/deployments', { boat_id: busy.id, route_id: 'r2', service_date: date, capacity: 30 }, 201);
  const h = await ok('POST', '/v1/seat-locks', { route_id: 'r1', service_date: date, boat_id: held.id, pax: 40, expiry: date }, 201);
  const list = await ok('GET', `/v1/seat-locks/boat-options?route_id=r1&service_date=${date}`);
  const of = (l: Json, id: string) => l.boats.find((x: Json) => x.boat_id === id);
  assert.deepEqual([of(list, free.id).ok, of(list, free.id).why, of(list, free.id).capacity], [true, null, 50]);
  assert.deepEqual([of(list, busy.id).ok, of(list, busy.id).why.code, of(list, busy.id).placed_route_id], [false, 'boat_other_route', 'r2']);
  assert.deepEqual([of(list, held.id).ok, of(list, held.id).why.code], [false, 'boat_taken']);
  assert.equal(of(list, panwa.id), undefined, 'another pier is not listed');
  const editing = await ok('GET', `/v1/seat-locks/boat-options?route_id=r1&service_date=${date}&lock_id=${h.id}`);
  assert.deepEqual([editing.boats[0].boat_id, editing.boats[0].own, editing.boats[0].ok], [held.id, true, true], 'the hold\'s own boat first, and pickable');
  await refused('GET', `/v1/seat-locks/boat-options?route_id=test-land&service_date=${date}`, undefined, 400, 'land_route');
  assert.ok(todayInThailand() < date);
});

test('a hold write announces the hold, the deployment it placed, and a conversion\'s booking', async () => {
  const date = '2065-01-15';
  const b = await boat(30);
  const since = (await ok('GET', '/v1/changes')).version as number;
  const h = await ok('POST', '/v1/seat-locks', { route_id: 'r1', service_date: date, boat_id: b.id, pax: 30, expiry: date }, 201);
  const done = await ok('POST', `/v1/seat-locks/${h.id}/convert`, { trips: [{ pax: { ad: 12 } }] }, 201, v(h));
  const changes = (await ok('GET', `/v1/changes?since=${since}&limit=500`)).changes as Json[];
  const has = (kind: string, id: string, action: string) => changes.some((c) => c.kind === kind && c.entity_id === id && c.action === action);
  assert.ok(has('seat_lock', h.id, 'created'), 'the hold');
  assert.ok(has('deployment', `${date}:${b.id}`, 'created'), 'the boat it placed on the route');
  assert.ok(has('seat_lock', h.id, 'updated'), 'the conversion');
  assert.ok(has('booking', done.booking.id, 'created'), 'the charter it became');
});
