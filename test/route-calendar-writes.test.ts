import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { applyCalendarChange, assertCloseAllowed, routeCalendar, todayInThailand } from '../src/domain/calendar.js';

// Settings → Programs as an API: `todo/route-calendar-rules-model.md`, section 4 and decision 7.
// Runs against whichever store DATABASE_URL picks. `test-calendar` has no seasons and is booked by no
// other test file (`test/setup.ts`); the in-process app has no catalogue, so it accepts any route id.

const app = buildApp();
after(async () => app.close());
const ROUTE = 'test-calendar';

async function request(method: InjectOptions['method'], url: string, payload?: object) {
  return payload === undefined ? app.inject({ method, url }) : app.inject({ method, url, payload });
}
const book = (date: string, voucher: string) =>
  request('POST', '/v1/bookings', { voucherRef: voucher, trips: [{ routeId: ROUTE, date, pax: { ad_fr: 2 } }] });

test('only a change that closes a day holding something is refused, and close_anyway overrides it', () => {
  const before = routeCalendar([], []);
  const next = applyCalendarChange([], [], { op: 'add-season', season: { id: 's1', route_id: 'r1', kind: 'open', from_date: '2040-01-01', to_date: '2040-12-31' } });
  const after = routeCalendar(next.seasons, next.overrides);
  // An open season closes every date outside it on a route that had none: legacy never checked this.
  assert.throws(() => assertCloseAllowed('r1', before, after, [{ service_date: '2041-02-01', booking_ref: 'BK-1' }], false),
    (error: Error & { statusCode?: number; code?: string }) => error.statusCode === 409 && error.code === 'bookings_on_closed_day' && /BK-1 on 2041-02-01/.test(error.message));
  assert.doesNotThrow(() => assertCloseAllowed('r1', before, after, [{ service_date: '2041-02-01', booking_ref: 'BK-1' }], true));
  assert.doesNotThrow(() => assertCloseAllowed('r1', before, after, [{ service_date: '2040-06-01', booking_ref: 'BK-2' }], false), 'a day that stays open');
  assert.match(todayInThailand(new Date('2026-10-08T18:30:00Z')), /^2026-10-09$/, 'service dates are Thai dates');
});

test('POST and DELETE seasons, PUT and DELETE days, with the impact check', async () => {
  // An open season for 2048 closes every other date on the route.
  const season = await request('POST', `/v1/routes/${ROUTE}/seasons`, { kind: 'open', from_date: '2048-01-01', to_date: '2048-12-31' });
  assert.equal(season.statusCode, 201, season.body);
  const { id, ...stored } = season.json() as Record<string, unknown>;
  assert.equal(typeof id, 'string');
  assert.deepEqual(stored, { route_id: ROUTE, kind: 'open', from_date: '2048-01-01', to_date: '2048-12-31' });

  const closed = await book('2049-01-05', 'CAL-0');
  assert.equal(closed.statusCode, 409);
  assert.equal(closed.json().code, 'route_closed');
  const booking = await book('2048-03-03', 'CAL-1');
  assert.equal(booking.statusCode, 201, booking.body);

  // Closing the booked day needs close_anyway; the booking stays, and its notes can still be edited.
  const refusedDay = await request('PUT', `/v1/routes/${ROUTE}/days/2048-03-03`, { kind: 'closed' });
  assert.equal(refusedDay.statusCode, 409);
  assert.equal(refusedDay.json().code, 'bookings_on_closed_day');
  assert.match(refusedDay.json().message, /1 booking \(CAL-1 on 2048-03-03\).*close_anyway/);
  const forced = await request('PUT', `/v1/routes/${ROUTE}/days/2048-03-03`, { kind: 'closed', close_anyway: true });
  assert.equal(forced.statusCode, 200, forced.body);
  assert.deepEqual(forced.json(), { route_id: ROUTE, service_date: '2048-03-03', kind: 'closed' });
  assert.equal((await request('PATCH', `/v1/bookings/${booking.json().id}`, { notes: 'still editable' })).statusCode, 200);
  assert.equal((await book('2048-03-03', 'CAL-2')).statusCode, 409, 'no new sale on the closed day');

  assert.equal((await request('DELETE', `/v1/routes/${ROUTE}/days/2048-03-03`)).statusCode, 204, 'reopening needs no check');
  assert.equal((await request('DELETE', `/v1/routes/${ROUTE}/days/2048-03-03`)).statusCode, 404, 'nothing left to remove');

  // Deleting an open season that holds a booking closes its days.
  const later = await request('POST', `/v1/routes/${ROUTE}/seasons`, { kind: 'open', from_date: '2050-01-01', to_date: '2050-12-31' });
  assert.equal((await book('2050-02-02', 'CAL-3')).statusCode, 201);
  const refusedDelete = await request('DELETE', `/v1/routes/${ROUTE}/seasons/${later.json().id}`);
  assert.equal(refusedDelete.statusCode, 409);
  assert.match(refusedDelete.json().message, /CAL-3 on 2050-02-02/);
  assert.equal((await request('DELETE', `/v1/routes/${ROUTE}/seasons/${later.json().id}?close_anyway=true`)).statusCode, 204);
  assert.equal((await request('DELETE', `/v1/routes/${ROUTE}/seasons/${later.json().id}`)).statusCode, 404);

  // Overlaps are allowed, as legacy allows them: the season that starts first decides.
  const overlap = await request('POST', `/v1/routes/${ROUTE}/seasons`, { kind: 'closed', from_date: '2048-06-01', to_date: '2048-06-30' });
  assert.equal(overlap.statusCode, 201);
  assert.equal((await book('2048-06-10', 'CAL-4')).statusCode, 201, 'the 2048 open season starts first');
});

test('GET /v1/routes carries each route\'s stored calendar', { skip: !process.env.DATABASE_URL && 'PostgreSQL only: the in-process app has no route catalogue' }, async () => {
  await request('PUT', `/v1/routes/${ROUTE}/days/2060-01-01`, { kind: 'open' });
  const route = (await request('GET', '/v1/routes')).json().routes.find((r: { id: string }) => r.id === ROUTE);
  assert.ok(route.seasons.every((s: Record<string, unknown>) => typeof s.id === 'string' && ['open', 'closed'].includes(String(s.kind)) && s.from_date && s.to_date));
  assert.ok(route.overrides.some((o: Record<string, unknown>) => o.service_date === '2060-01-01' && o.kind === 'open'));
  assert.equal((await request('POST', '/v1/routes/no-such-route/seasons', { kind: 'open', from_date: '2048-01-01', to_date: '2048-01-02' })).statusCode, 404);
});

test('calendar writes refuse a bad kind or bad dates', async () => {
  for (const body of [{ kind: 'maybe', from_date: '2048-01-01', to_date: '2048-01-02' }, { kind: 'open', from_date: '2048-01-02', to_date: '2048-01-01' }, { kind: 'open', from_date: '2048-02-30', to_date: '2048-03-01' }]) {
    assert.equal((await request('POST', `/v1/routes/${ROUTE}/seasons`, body)).statusCode, 400, JSON.stringify(body));
  }
  assert.equal((await request('PUT', `/v1/routes/${ROUTE}/days/2048-13-01`, { kind: 'closed' })).statusCode, 400);
  assert.equal((await request('PUT', `/v1/routes/${ROUTE}/days/2048-01-01`, { kind: 'closed', close_anyway: 'yes' })).statusCode, 400);
});
