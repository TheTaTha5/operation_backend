import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { buildApp } from '../src/app.js';
import { assertRoutesOpen, isLegacyB2C, routeCalendar, type RouteSeason } from '../src/domain/calendar.js';
import { assertDayFits, assertLockFits, capacityNumbers, dayCapacity, licenceShortfall, weighDay, type DayDemand } from '../src/domain/capacity.js';
import { OperationsStore, tripsToCheckOpen, type BookingTripInput, type StoredTrip } from '../src/domain/operations.js';

// Closed days, land routes and a marine day with no boat: `todo/route-calendar-rules-model.md`.

const refused = (work: () => unknown, statusCode: number, code: string | undefined, message?: RegExp): void => {
  assert.throws(work, (error: Error & { statusCode?: number; code?: string }) => {
    assert.equal(error.statusCode, statusCode);
    assert.equal(error.code, code);
    if (message) assert.match(error.message, message);
    return true;
  });
};

const season = (id: string, route_id: string, kind: 'open' | 'closed', from_date: string, to_date: string): RouteSeason => ({ id, route_id, kind, from_date, to_date });
const demand = (route_id: string, seat: number, extra: Partial<DayDemand> = {}): DayDemand =>
  ({ route_id, service_date: '2040-01-01', seat, draws: new Map(), charters: [], ...extra });

// ── The calendar check ──────────────────────────────────────────────────────────────────────────

test('a trip on a day its route does not run is refused with route_closed, naming the route and day', () => {
  const calendar = routeCalendar([season('s1', 'r7', 'open', '2026-01-01', '2026-12-31')], []);
  assert.doesNotThrow(() => assertRoutesOpen(calendar, [{ route_id: 'r7', service_date: '2026-06-01' }]));
  refused(() => assertRoutesOpen(calendar, [{ route_id: 'r7', service_date: '2027-01-04' }], new Map([['r7', 'Se La Va']])),
    409, 'route_closed', /^Route Se La Va \(r7\) does not run on 2027-01-04$/);
  refused(() => assertRoutesOpen(calendar, [{ route_id: 'r7', service_date: '2027-01-04' }, { route_id: 'r7', service_date: '2027-01-04' }]),
    409, 'route_closed', /^Route r7 does not run on 2027-01-04$/);
});

test('overlapping seasons: the one that starts first wins, whatever order the rows come in', () => {
  const early = season('b', 'r1', 'open', '2040-01-01', '2040-12-31');
  const late = season('a', 'r1', 'closed', '2040-06-01', '2040-06-30');
  for (const rows of [[early, late], [late, early]]) assert.equal(routeCalendar(rows, []).isOpen('r1', '2040-06-15'), true);
});

test('a save checks only the trips it adds or moves, and a legacy B2C booking none', () => {
  const trip = (id: string, route_id: string, service_date: string): StoredTrip =>
    ({ id, seq: 0, route_id, service_date, booking_mode: 'seat', pax: [], lock_draws: [], ovn_leg: false });
  const current = [trip('t1', 'r1', '2040-01-01'), trip('t2', 'r2', '2040-01-02')];
  const planned = [trip('t1', 'r1', '2040-01-01'), trip('t2', 'r2', '2040-01-05'), trip('t3', 'r3', '2040-01-06')];
  assert.deepEqual(tripsToCheckOpen('LOV-1', current, planned).map((t) => t.id), ['t2', 't3'], 'moved and added, not the untouched one');
  assert.deepEqual(tripsToCheckOpen(undefined, [], current).map((t) => t.id), ['t1', 't2'], 'a create checks every trip');
  assert.deepEqual(tripsToCheckOpen('b2c_LOV-1', current, planned), [], 'legacy B2C is saved anyway');
  assert.equal(isLegacyB2C('LOV-4190737'), false, "Love Kingdom's own bookings are not exempt");
});

// ── Land routes and a marine day with no boat ───────────────────────────────────────────────────

test('a land route has no seat pool: any number sells, and available_seats is null', () => {
  const day = dayCapacity([], [{ booking_mode: 'seat', pax: 40 }], [{ id: 'l1', pax: 10, drawn: 0 }], 'land');
  assert.deepEqual(capacityNumbers(day), {
    deployed_capacity: 0, licensed_capacity: 0, booked_pax: 40, charter_pax: 0, locked_pax: 10, available_seats: null, unlimited: true, unplaced_pax: 0, licensed_free: null,
  });
  assert.doesNotThrow(() => assertDayFits(day, demand('land', 500)));
  assert.equal(weighDay(day, demand('land', 500)), undefined, 'never over the allotment, so never waits for approval');
  assert.doesNotThrow(() => assertLockFits(day, 300, 0));
});

test('a marine day with no boat sells ungated, and says how many wait for a boat', () => {
  const day = dayCapacity([], [{ booking_mode: 'seat', pax: 12 }], [{ id: 'l1', pax: 5, drawn: 2 }]);
  assert.equal(day.available_seats, 0, 'not negative');
  assert.equal(capacityNumbers(day).unplaced_pax, 15, 'the 12 sold and the 3 still locked');
  assert.doesNotThrow(() => assertDayFits(day, demand('r1', 30)));
  assert.equal(weighDay(day, demand('r1', 30)), undefined);
  assert.equal(licenceShortfall(day, demand('r1', 30)), 0, 'no over-licence warning without a licence to be over');
  assert.doesNotThrow(() => assertLockFits(day, 20, 0), 'a lock too: legacy treats no boat as no limit (bookingV2LockFreeOn)');

  refused(() => assertDayFits(day, demand('r1', 4, { draws: new Map([['l1', 4]]) })), 409, undefined, /has 3 seats left/);
  refused(() => assertDayFits(day, demand('r1', 0, { charters: [{ boat_id: 'b1', pax: 10 }] })), 400, undefined, /not deployed/);
  assert.equal(capacityNumbers(dayCapacity([{ boat_id: 'b1', capacity: 10 }], [{ booking_mode: 'seat', pax: 4 }], [])).unplaced_pax, 0, 'with a boat, nothing is unplaced');
});

// ── Through the in-process store, with a seeded calendar ────────────────────────────────────────

const pax = (count: number): BookingTripInput['pax'] => [{ category: 'ad', residency: 'foreign', count }];
const tripIn = (route_id: string, service_date: string, count = 2): BookingTripInput => ({ route_id, service_date, pax: pax(count) });

function seeded(): OperationsStore {
  const store = new OperationsStore();
  store.seedCatalogue({
    routes: [{ id: 'r1', name: 'Phi Phi' }, { id: 'r2', name: 'Similan' }, { id: 'land1', name: 'Airport transfer', kind: 'land' }],
    seasons: [season('s1', 'r1', 'open', '2040-01-01', '2040-12-31'), season('s2', 'r2', 'open', '2040-01-01', '2040-12-31')],
    overrides: [{ route_id: 'r1', service_date: '2040-03-10', kind: 'closed' }],
  });
  store.createDeployment({ boat_id: 'b1', route_id: 'r1', service_date: '2040-03-01', capacity: 10 });
  return store;
}

test('the store refuses a new booking, an added or moved trip, a reschedule, a restore and a lock on a closed day', () => {
  const store = seeded();
  refused(() => store.createBooking({ trips: [tripIn('r1', '2040-03-10')] }), 409, 'route_closed', /Phi Phi \(r1\) does not run on 2040-03-10/);
  refused(() => store.createBooking({ trips: [tripIn('r1', '2041-01-01')] }), 409, 'route_closed', /2041-01-01/);
  refused(() => store.createLock({ route_id: 'r1', service_date: '2040-03-10', pax: 2 }), 409, 'route_closed');

  const booking = store.createBooking({ trips: [tripIn('r1', '2040-03-01')] });
  refused(() => store.amendBooking(booking.id, { trips: [{ ...tripIn('r1', '2040-03-10'), id: booking.trips[0].id }] }), 409, 'route_closed');
  refused(() => store.amendBooking(booking.id, { trips: [{ ...tripIn('r1', '2040-03-01'), id: booking.trips[0].id }, tripIn('r2', '2041-02-01')] }), 409, 'route_closed', /r2/);
  refused(() => store.rescheduleBooking(booking.id, { kind: 'record', from_date: '2040-03-01', to_date: '2040-03-10', reason: 'weather', charge_type: 'none', collect: 'separate' }), 409, 'route_closed');

  // The day closes after the sale: a notes edit still saves, and a restore does not.
  store.seedCatalogue({ overrides: [{ route_id: 'r1', service_date: '2040-03-01', kind: 'closed' }] });
  assert.equal(store.amendBooking(booking.id, { header: { notes: 'window seats' } })?.notes, 'window seats');
  store.cancelBooking(booking.id, { kind: 'reason' });
  refused(() => store.restoreBooking(booking.id), 409, 'route_closed');
});

test('a legacy B2C booking is saved on a closed day, as legacy saves it', () => {
  const store = seeded();
  const booking = store.createBooking({ external_id: 'b2c_LOV-1', trips: [tripIn('r1', '2040-03-10')] });
  assert.equal(booking.trips[0].service_date, '2040-03-10');
  refused(() => store.createBooking({ external_id: 'LOV-2', trips: [tripIn('r1', '2040-03-10')] }), 409, 'route_closed');
});

test('a land route and a marine day with no boat take bookings and locks without a seat check', () => {
  const store = seeded();
  assert.equal(store.createBooking({ trips: [tripIn('land1', '2040-03-05', 60)] }).status, 'confirmed', 'land: no boats, no limit');
  assert.equal(store.capacity('land1', '2040-03-05').available_seats, null);

  const lock = store.createLock({ route_id: 'r1', service_date: '2040-03-05', pax: 8 });
  const booking = store.createBooking({ trips: [{ ...tripIn('r1', '2040-03-05', 30), lock_draws: [{ lock_id: lock.id, qty: 5 }] }] });
  assert.equal(booking.status, 'confirmed', 'no boat yet: sold before boats are assigned');
  assert.deepEqual([store.capacity('r1', '2040-03-05').unplaced_pax, store.capacity('r1', '2040-03-05').available_seats], [33, 0], '30 sold, 3 still locked');

  refused(() => store.createBooking({ trips: [tripIn('r1', '2040-03-01', 11)] }), 409, undefined, /registered seats are full/);
});

// ── Through the API, against whichever store DATABASE_URL picks ─────────────────────────────────

const app = buildApp();
after(async () => app.close());

test('POST /v1/bookings and /v1/seat-locks sell a marine day before any boat is deployed', async () => {
  const date = '2046-02-03';
  const lock = await app.inject({ method: 'POST', url: '/v1/seat-locks', payload: { route_id: 'r5', service_date: date, pax: 4 } });
  assert.equal(lock.statusCode, 201, lock.body);
  const created = await app.inject({ method: 'POST', url: '/v1/bookings', payload: { trips: [{ routeId: 'r5', date, pax: { ad_fr: 3 } }] } });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().status, 'confirmed');
  const availability = (await app.inject({ method: 'GET', url: `/v1/availability?route_id=r5&date=${date}` })).json();
  assert.deepEqual([availability.available_seats, availability.unplaced_pax, availability.unlimited], [0, 7, false]);
});

test('a land route sells without boats, and reads as unlimited', { skip: !process.env.DATABASE_URL && 'PostgreSQL only: the in-process app has no catalogue to hold a land route' }, async () => {
  const date = '2046-02-04';
  const created = await app.inject({ method: 'POST', url: '/v1/bookings', payload: { trips: [{ routeId: 'test-land', date, pax: { ad_fr: 70 } }] } });
  assert.equal(created.statusCode, 201, created.body);
  const availability = (await app.inject({ method: 'GET', url: `/v1/availability?route_id=test-land&date=${date}` })).json();
  assert.deepEqual([availability.available_seats, availability.unlimited, availability.booked_pax], [null, true, 70]);
  const range = (await app.inject({ method: 'GET', url: `/v1/availability?route_id=test-land&from=${date}&to=${date}` })).json();
  assert.equal(range.days[0].available_seats, null, 'the range form answers the same');
});
