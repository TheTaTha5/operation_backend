import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { buildApp } from '../src/app.js';

const app = buildApp();
after(async () => app.close());

test('source booking payload is normalized while retaining its booking data', async () => {
  const date = '2030-02-03';
  await app.inject({ method: 'POST', url: '/operations/deployments', payload: { boat_id: 'boat-source', route_id: 'r-source', service_date: date, capacity: 20 } });
  const response = await app.inject({
    method: 'POST', url: '/v1/bookings', payload: {
      id: 'BK-source-1', agentId: 'a_b2c', voucherRef: '007592',
      trips: [{ routeId: 'r-source', date, bookingMode: 'charter', pax: { ad_fr: 10, inf_fr: 1, foc_fr: 2 } }],
      passengers: [{ name: 'Example passenger' }],
    },
  });
  assert.equal(response.statusCode, 201);
  const created = response.json();
  assert.equal(created.trips.length, 1);
  assert.deepEqual(created.trips[0].pax, { ad_fr: 10, inf_fr: 1, foc_fr: 2 }, 'the grid is stored per departure and returned as the frontend writes it');
  assert.equal(created.trips[0].pax_total, 13);
  assert.equal(created.trips[0].route_id, 'r-source');
  assert.equal(created.trips[0].service_date, date, 'a trip reports a plain ISO date, not a stringified Date');
  assert.equal(created.trips[0].booking_mode, 'charter');
  assert.equal(created.pax, 13, 'the booking total is the sum across its trips');
  assert.equal(created.allocated_pax, 0, 'a charter draws on the charter ceiling, not the seat pool');
  assert.equal(created.route_id, 'r-source', 'single-departure clients still see a route and date');
  assert.equal(created.service_date, date);
  assert.equal(created.external_id, 'BK-source-1');
  assert.equal(created.booking_mode, 'charter');
  assert.equal(created.booking_data.passengers[0].name, 'Example passenger');
});

test('a booking spans several departures and is refused as a whole', async () => {
  const [first, second] = ['2030-03-01', '2030-03-02'];
  for (const service_date of [first, second]) {
    await app.inject({ method: 'POST', url: '/operations/deployments', payload: { boat_id: `boat-${service_date}`, route_id: 'r-multi', service_date, capacity: 10 } });
  }
  const created = await app.inject({
    method: 'POST', url: '/v1/bookings', payload: {
      agentId: 'a_b2c',
      trips: [{ routeId: 'r-multi', date: first, pax: { ad: 4 } }, { routeId: 'r-multi', date: second, pax: { ad: 3, chd_th: 1 } }],
    },
  });
  assert.equal(created.statusCode, 201);
  const booking = created.json();
  assert.equal(booking.trips.length, 2);
  assert.equal(booking.pax, 8, 'four on the first day, four on the second');
  assert.deepEqual(booking.trips.map((t: { seq: number }) => t.seq), [0, 1], 'trips keep the order they were sent in');

  const seatsOn = async (date: string) => (await app.inject({ method: 'GET', url: `/v1/availability?route_id=r-multi&date=${date}` })).json().available_seats;
  assert.equal(await seatsOn(first), 6);
  assert.equal(await seatsOn(second), 6);

  // The second day has room for 6, the first does not. The whole itinerary is refused, and neither
  // day may be left holding half a booking.
  const overflow = await app.inject({
    method: 'POST', url: '/v1/bookings', payload: {
      trips: [{ routeId: 'r-multi', date: first, pax: { ad: 7 } }, { routeId: 'r-multi', date: second, pax: { ad: 6 } }],
    },
  });
  assert.equal(overflow.statusCode, 409);
  assert.equal(await seatsOn(first), 6, 'the day that fit must not have been charged');
  assert.equal(await seatsOn(second), 6);

  // Two trips landing on the same departure are weighed together, not one at a time.
  const doubled = await app.inject({
    method: 'POST', url: '/v1/bookings', payload: {
      trips: [{ routeId: 'r-multi', date: first, pax: { ad: 4 } }, { routeId: 'r-multi', date: first, pax: { ad: 4 } }],
    },
  });
  assert.equal(doubled.statusCode, 409, 'eight seats against six remaining');

  // A bare count cannot say which day loses passengers.
  const ambiguous = await app.inject({ method: 'POST', url: `/v1/bookings/${booking.id}/partial-cancel`, payload: { pax_to_cancel: 1 } });
  assert.equal(ambiguous.statusCode, 400);

  // Replacing the itinerary releases the first day entirely.
  const amended = await app.inject({
    method: 'PATCH', url: `/v1/bookings/${booking.id}`,
    payload: { trips: [{ routeId: 'r-multi', date: second, pax: { ad: 2 } }] },
  });
  assert.equal(amended.statusCode, 200);
  assert.equal(amended.json().trips.length, 1);
  assert.equal(await seatsOn(first), 10, 'the vacated day is given back');
  assert.equal(await seatsOn(second), 8);
});

test('partial-cancelling a charter reduces the head count without touching the seat pool', async () => {
  // This crashed with a 500 before trips existed: a charter stored allocated_pax = 0, partial-cancel
  // decremented it, and CHECK (allocated_pax >= 0) rejected the write. The in-process store instead
  // set allocated_pax = pax and quietly turned the charter into a seat consumer. Nothing is stored
  // now — the seats a booking holds are read off its trips — so neither outcome is reachable.
  const date = '2030-04-10';
  await app.inject({ method: 'POST', url: '/operations/deployments', payload: { boat_id: 'boat-charter', route_id: 'r-charter', service_date: date, capacity: 38, license_pax: 45, total_capacity: 48 } });
  const created = await app.inject({ method: 'POST', url: '/v1/bookings', payload: { trips: [{ routeId: 'r-charter', date, bookingMode: 'charter', pax: 13 }] } });
  assert.equal(created.statusCode, 201);
  const id = created.json().id;
  assert.equal(created.json().allocated_pax, 0, 'a charter takes the boat, not seats from the pool');

  const cancelled = await app.inject({ method: 'POST', url: `/v1/bookings/${id}/partial-cancel`, payload: { pax_to_cancel: 2 } });
  assert.equal(cancelled.statusCode, 200);
  assert.equal(cancelled.json().pax, 11);
  assert.equal(cancelled.json().allocated_pax, 0, 'still not consuming seats');
  assert.equal(cancelled.json().trips[0].booking_mode, 'charter', 'and still a charter');

  const availability = (await app.inject({ method: 'GET', url: `/v1/availability?route_id=r-charter&date=${date}` })).json();
  assert.equal(availability.charter_pax, 11);
  assert.equal(availability.booked_pax, 0);
  assert.equal(availability.available_seats, 38, 'the seat pool never saw the charter');

  // Cancelling more passengers than are on the booking is a 400, not a negative count.
  assert.equal((await app.inject({ method: 'POST', url: `/v1/bookings/${id}/partial-cancel`, payload: { pax_to_cancel: 99 } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: `/v1/bookings/${id}` })).json().pax, 11, 'a refused cancel changes nothing');
});
