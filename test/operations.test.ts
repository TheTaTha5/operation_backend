import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { buildApp } from '../src/app.js';
import type { InjectOptions } from 'fastify';

const app = buildApp();
after(async () => app.close());

// Spreading into `inject` inline picks the chainable overload, whose result has no `.json()`. Naming
// the options object resolves it. This matters because `npm run check` now covers the tests, which
// is what catches one still importing a symbol that has since moved.
async function request(method: InjectOptions['method'], url: string, payload?: object) {
  return payload === undefined ? app.inject({ method, url }) : app.inject({ method, url, payload });
}

test('deployment capacity feeds availability, bookings, and manifest', async () => {
  const date = '2030-01-02';
  const deployment = await request('POST', '/operations/deployments', { boat_id: 'boat-1', route_id: 'r1', service_date: date, capacity: 10 });
  assert.equal(deployment.statusCode, 201);

  const availability = await request('GET', `/v1/availability?route_id=r1&date=${date}`);
  assert.deepEqual(availability.json(), { route_id: 'r1', service_date: date, deployed_capacity: 10, licensed_capacity: 10, booked_pax: 0, charter_pax: 0, locked_pax: 0, available_seats: 10 });

  const created = await request('POST', '/v1/bookings', { route_id: 'r1', service_date: date, pax: 6 });
  assert.equal(created.statusCode, 201);
  const booking = created.json() as { id: string };
  assert.equal((await request('POST', '/v1/bookings', { route_id: 'r1', service_date: date, pax: 5 })).statusCode, 409);

  assert.equal((await request('PATCH', `/v1/bookings/${booking.id}`, { pax: 5 })).statusCode, 200);
  assert.equal((await request('POST', `/v1/bookings/${booking.id}/partial-cancel`, { pax_to_cancel: 2 })).json().pax, 3);
  const manifest = await request('GET', `/v1/manifest?route_id=r1&date=${date}`);
  assert.equal(manifest.json().available_seats, 7);
  assert.equal((await request('POST', `/v1/bookings/${booking.id}/cancel`)).json().status, 'cancelled');
});

test('availability over a range answers every day as a single-date read would', async () => {
  const [first, empty, last] = ['2031-03-01', '2031-03-02', '2031-03-03'];
  await request('POST', '/operations/deployments', { boat_id: 'boat-range-1', route_id: 'r1', service_date: first, capacity: 10 });
  await request('POST', '/operations/deployments', { boat_id: 'boat-range-1', route_id: 'r1', service_date: last, capacity: 10 });
  await request('POST', '/operations/deployments', { boat_id: 'boat-range-2', route_id: 'r1', service_date: last, capacity: 5 });
  const booking = (await request('POST', '/v1/bookings', { route_id: 'r1', service_date: first, pax: 4 })).json() as { id: string };
  await request('POST', '/v1/seat-locks', { route_id: 'r1', service_date: last, pax: 2 });

  const range = await request('GET', `/v1/availability?route_id=r1&from=${first}&to=${last}`);
  assert.equal(range.statusCode, 200);
  const days = range.json().days as Record<string, unknown>[];
  assert.deepEqual(days.map((day) => [day.route_id, day.service_date]), [['r1', first], ['r1', empty], ['r1', last]], 'every day is present, in order');
  // `open` comes from the route's calendar, which differs between the seeded and unseeded catalogue.
  const { open: emptyOpen, ...emptyDay } = days[1];
  assert.equal(typeof emptyOpen, 'boolean');
  assert.deepEqual(emptyDay, { route_id: 'r1', service_date: empty, deployed_capacity: 0, licensed_capacity: 0, booked_pax: 0, charter_pax: 0, locked_pax: 0, available_seats: 0, deployments: [] }, 'a day with no deployment is zeros, not missing');
  assert.equal(days[0].available_seats, 6);
  assert.equal(days[2].available_seats, 13, 'two boats add up, less the lock');
  assert.deepEqual(days[2].deployments, [
    { boat_id: 'boat-range-1', capacity: 10, license_pax: null, chartered: false },
    { boat_id: 'boat-range-2', capacity: 5, license_pax: null, chartered: false },
  ]);
  for (const day of days) {
    const single = (await request('GET', `/v1/availability?route_id=r1&date=${day.service_date}`)).json();
    const { open, deployments, ...numbers } = day;
    assert.deepEqual(numbers, single, `${day.service_date} agrees with the single-date read`);
  }

  const editing = (await request('GET', `/v1/availability?route_id=r1&from=${first}&to=${last}&exclude_booking_id=${booking.id}`)).json();
  assert.equal(editing.days[0].available_seats, 10, 'the exclusion applies across the range');

  const everyRoute = await request('GET', `/v1/availability?from=${first}&to=${last}`);
  assert.equal(everyRoute.statusCode, 200, 'route_id is optional for a range');
  for (const day of everyRoute.json().days) assert.ok(day.route_id && day.service_date, 'each entry names its route and date');

  assert.equal((await request('GET', `/v1/availability?route_id=r1&from=${first}`)).statusCode, 400, 'from without to');
  assert.equal((await request('GET', `/v1/availability?route_id=r1&from=${first}&to=${last}&date=${first}`)).statusCode, 400, 'date and a range');
  assert.equal((await request('GET', `/v1/availability?route_id=r1&from=${last}&to=${first}`)).statusCode, 400, 'reversed');
  assert.equal((await request('GET', '/v1/availability?route_id=r1&from=2031-01-01&to=2033-01-01')).statusCode, 400, 'over the single-route cap');
  assert.equal((await request('GET', '/v1/availability?from=2031-01-01&to=2031-03-04')).statusCode, 400, 'over the all-routes cap');
  assert.equal((await request('GET', '/v1/availability?from=2031-01-01&to=2031-03-03')).statusCode, 200, 'at the all-routes cap');
  assert.equal((await request('GET', '/v1/availability?route_id=r1')).statusCode, 400, 'neither a date nor a range');
  assert.equal((await request('GET', `/v1/availability?date=${first}`)).statusCode, 400, 'a single date still needs route_id');
});

test('a charter takes its whole boat out of the seat pool', async () => {
  const date = '2031-04-01';
  await request('POST', '/operations/deployments', { boat_id: 'boat-ch-big', route_id: 'r2', service_date: date, capacity: 30, license_pax: 35 });
  await request('POST', '/operations/deployments', { boat_id: 'boat-ch-small', route_id: 'r2', service_date: date, capacity: 10 });
  const charter = (boat: string, pax: number) => request('POST', '/v1/bookings', { trips: [{ route_id: 'r2', date, booking_mode: 'charter', charter_boat_id: boat, pax }] });

  assert.equal((await request('POST', '/v1/bookings', { trips: [{ route_id: 'r2', date, booking_mode: 'charter', pax: 4 }] })).statusCode, 400, 'a charter must name its boat');
  assert.equal((await request('POST', '/v1/bookings', { route_id: 'r2', service_date: date, pax: 1, charter_boat_id: 'boat-ch-big' })).statusCode, 400, 'only a charter names a boat');
  assert.equal((await charter('boat-elsewhere', 4)).statusCode, 400, 'the boat must be deployed on that route and day');
  assert.equal((await charter('boat-ch-small', 11)).statusCode, 409, 'the charter must fit the boat it takes');

  // Eight seats sold, so the small boat cannot be taken: the big boat alone still covers them.
  const seats = (await request('POST', '/v1/bookings', { route_id: 'r2', service_date: date, pax: 8 })).json() as { id: string };
  const taken = await charter('boat-ch-small', 4);
  assert.equal(taken.statusCode, 201);
  assert.equal(taken.json().trips[0].charter_boat_id, 'boat-ch-small');

  const day = (await request('GET', `/v1/availability?route_id=r2&from=${date}&to=${date}`)).json().days[0];
  assert.equal(day.available_seats, 22, 'the small boat left whole, though the charter has only four aboard: 30 - 8');
  assert.equal(day.charter_pax, 4);
  assert.deepEqual(day.deployments.map((d: { boat_id: string; chartered: boolean }) => [d.boat_id, d.chartered]), [['boat-ch-big', false], ['boat-ch-small', true]], 'boats listed by id, the chartered one marked');

  assert.equal((await charter('boat-ch-small', 2)).statusCode, 409, 'a boat is chartered once');
  // Taking the big boat would leave the eight sold seats nowhere to sit.
  assert.equal((await charter('boat-ch-big', 20)).statusCode, 409, 'a charter may not strand seats already sold');
  await request('POST', `/v1/bookings/${seats.id}/cancel`);
  assert.equal((await charter('boat-ch-big', 35)).statusCode, 201, 'with the seats gone it may, filled to the licence');
  assert.equal((await request('GET', `/v1/availability?route_id=r2&date=${date}`)).json().available_seats, 0);
});

test('seats drawn from a lock are held once, not twice', async () => {
  const date = '2031-05-01';
  await request('POST', '/operations/deployments', { boat_id: 'boat-lock', route_id: 'r3', service_date: date, capacity: 20 });
  const lock = (await request('POST', '/v1/seat-locks', { route_id: 'r3', service_date: date, pax: 6, agent_id: 'agent-1' })).json() as { id: string; drawn_pax: number };
  assert.equal(lock.drawn_pax, 0);
  const available = async () => (await request('GET', `/v1/availability?route_id=r3&date=${date}`)).json();
  assert.equal((await available()).available_seats, 14);

  // Four passengers, three of them from the lock: the lock still holds three, the pool gives one.
  const drew = await request('POST', '/v1/bookings', { trips: [{ route_id: 'r3', date, pax: 4, lockDraws: { [lock.id]: 3 } }] });
  assert.equal(drew.statusCode, 201);
  assert.deepEqual(drew.json().trips[0].lock_draws, { [lock.id]: 3 });
  const after = await available();
  assert.equal(after.booked_pax, 4);
  assert.equal(after.locked_pax, 3, 'only the undrawn part of the lock is held');
  assert.equal(after.available_seats, 13, 'the drawn seats are not counted twice: 20 - 4 - 3');
  assert.equal((await request('GET', `/v1/seat-locks?route_id=r3&date=${date}`)).json().seat_locks[0].drawn_pax, 3);

  assert.equal((await request('POST', '/v1/bookings', { trips: [{ route_id: 'r3', date, pax: 4, lock_draws: { [lock.id]: 4 } }] })).statusCode, 409, 'the lock has three left');
  assert.equal((await request('POST', '/v1/bookings', { trips: [{ route_id: 'r3', date, pax: 2, lock_draws: { [lock.id]: 3 } }] })).statusCode, 400, 'draws cannot exceed the trip');
  assert.equal((await request('POST', '/v1/bookings', { trips: [{ route_id: 'r3', date, pax: 1, lock_draws: { 'lock-missing': 1 } }] })).statusCode, 400, 'an unknown lock');
  assert.equal((await request('PATCH', `/v1/seat-locks/${lock.id}`, { pax: 2 })).statusCode, 409, 'a lock cannot shrink below what has been drawn');
  assert.equal((await request('PATCH', `/v1/seat-locks/${lock.id}`, { pax: 3 })).statusCode, 200, 'down to exactly the draws is fine');
  assert.equal((await available()).available_seats, 16, 'and hands the undrawn seats back: 20 - 4');

  await request('POST', `/v1/bookings/${drew.json().id}/cancel`);
  const released = await available();
  assert.equal(released.locked_pax, 3, 'a cancelled booking returns its draws to the lock');
  assert.equal(released.available_seats, 17);
});

test('the route calendar endpoint validates its range', async () => {
  const catalogue = await request('GET', '/v1/routes');
  assert.equal(catalogue.statusCode, 200);
  assert.ok(Array.isArray(catalogue.json().routes), 'the catalogue is listable without a range');

  assert.equal((await request('GET', '/v1/routes?from=2026-08-01')).statusCode, 400, 'from without to');
  assert.equal((await request('GET', '/v1/routes?to=2026-08-31')).statusCode, 400, 'to without from');
  assert.equal((await request('GET', '/v1/routes?from=01-08-2026&to=2026-08-31')).statusCode, 400, 'not ISO');
  assert.equal((await request('GET', '/v1/routes?from=2026-08-31&to=2026-08-01')).statusCode, 400, 'reversed');
  assert.equal((await request('GET', '/v1/routes?from=2026-01-01&to=2028-01-01')).statusCode, 400, 'over the day cap');

  const month = await request('GET', '/v1/routes?from=2026-08-01&to=2026-08-31');
  assert.equal(month.statusCode, 200);
  assert.equal(month.json().from, '2026-08-01');
  for (const route of month.json().routes) {
    assert.equal(Object.keys(route.days).length, 31, `${route.id} resolves every day of the month`);
    assert.ok(typeof route.days['2026-08-26'].open === 'boolean');
    assert.ok(route.days['2026-08-26'].source, 'a day always says which rule decided it');
  }
});

test('a reservation being edited does not compete with its own seats', async () => {
  const date = '2030-01-04';
  await request('POST', '/operations/deployments', { boat_id: 'boat-3', route_id: 'r3', service_date: date, capacity: 20 });
  await request('POST', '/v1/bookings', { route_id: 'r3', service_date: date, pax: 8 });
  const mine = (await request('POST', '/v1/bookings', { route_id: 'r3', service_date: date, pax: 12 })).json() as { id: string };

  // The day is now sold out, so a plain read offers nothing...
  assert.equal((await request('GET', `/v1/availability?route_id=r3&date=${date}`)).json().available_seats, 0);
  // ...but the editor of the 12-pax booking is releasing those seats as it saves.
  const editing = await request('GET', `/v1/availability?route_id=r3&date=${date}&exclude_booking_id=${mine.id}`);
  assert.equal(editing.json().available_seats, 12);
  assert.equal(editing.json().booked_pax, 8);

  // Re-saving unchanged on a full day must work, and so must any amendment that fits the released seats.
  assert.equal((await request('PATCH', `/v1/bookings/${mine.id}`, { pax: 12 })).statusCode, 200);
  assert.equal((await request('PATCH', `/v1/bookings/${mine.id}`, { pax: 11 })).statusCode, 200);
  assert.equal((await request('PATCH', `/v1/bookings/${mine.id}`, { pax: 13 })).statusCode, 409);
  // A refused amendment must leave the original allocation intact rather than a half-applied zero.
  assert.equal((await request('GET', `/v1/availability?route_id=r3&date=${date}`)).json().booked_pax, 19);

  const lock = (await request('POST', '/v1/seat-locks', { route_id: 'r3', service_date: date, pax: 1 })).json() as { id: string; service_date: string };
  assert.equal(lock.service_date, date, 'a lock must report a plain ISO date, not a stringified Date');
  assert.equal((await request('PATCH', `/v1/seat-locks/${lock.id}`, { pax: 1 })).statusCode, 200);
  assert.equal((await request('PATCH', `/v1/seat-locks/${lock.id}`, { pax: 2 })).statusCode, 409);
});

test('seat locks reserve and release capacity', async () => {
  const date = '2030-01-03';
  await request('POST', '/operations/deployments', { boat_id: 'boat-2', route_id: 'r2', service_date: date, capacity: 2 });
  const create = await request('POST', '/v1/seat-locks', { route_id: 'r2', service_date: date, pax: 2, agent_id: 'agent-1' });
  assert.equal(create.statusCode, 201);
  const lock = create.json() as { id: string };
  assert.equal((await request('POST', '/v1/bookings', { route_id: 'r2', service_date: date, pax: 1 })).statusCode, 409);
  assert.equal((await request('POST', `/v1/seat-locks/${lock.id}/release`)).statusCode, 200);
  assert.equal((await request('POST', '/v1/bookings', { route_id: 'r2', service_date: date, pax: 1 })).statusCode, 201);
});
