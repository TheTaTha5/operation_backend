import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapLegacyWeather } from '../src/tools/legacy-weather.js';

// How legacy's sb_weather and the bookings' weatherresolve_* columns become rows
// (src/tools/legacy-weather.ts), on rows shaped as the legacy tables hold them.
const report = () => {
  const skipped: string[] = [], notes: string[] = [];
  return { skipped, notes, skip: (kind: string, id: string, reason: string) => skipped.push(`${kind} ${id}: ${reason}`), note: (what: string) => notes.push(what) };
};
const ctx = { prefix: 'lg_', routes: new Set(['r10', 'r12']), bookings: new Set(['lg_BK-1', 'lg_BK-2', 'lg_BK-3', 'lg_BK-4']) };
const closure = (id: string, routeid: string, date: string, extra: Record<string, unknown> = {}) =>
  ({ id, routeid, date, reason: 'weather', at: '2026-07-01T04:57:02.238Z', note: null, ...extra });
const tag = (id: string, event: string, status: string, extra: Record<string, unknown> = {}) => ({
  id, weatherresolve_event: event, weatherresolve_status: status, weatherresolve_notifiedat: null, weatherresolve_outcome: null,
  weatherresolve_resolvedat: null, weatherresolve_newdate: null, ...extra,
});

test('closures: legacy ids prefixed, a blank note is none, a route not here or a second closure of a trip is skipped', () => {
  const r = report();
  const out = mapLegacyWeather({
    closures: [closure('sb_weather:a', 'r10', '2026-07-02', { note: 'cancelled' }), closure('sb_weather:b', 'r12', '2026-07-02', { note: '' }),
      closure('sb_weather:c', 'r99', '2026-07-02'), closure('sb_weather:d', 'r10', '2026-07-02', { at: '2026-07-01T05:00:00.000Z' })],
    bookings: [],
  }, ctx, r);
  assert.deepEqual(out.closures, [
    { id: 'lg_sb_weather:a', route_id: 'r10', service_date: '2026-07-02', note: 'cancelled', closed_by: null, closed_at: '2026-07-01T04:57:02.238Z' },
    { id: 'lg_sb_weather:b', route_id: 'r12', service_date: '2026-07-02', note: null, closed_by: null, closed_at: '2026-07-01T04:57:02.238Z' },
  ]);
  assert.deepEqual(r.skipped, ['weather closure sb_weather:c: route r99 not in catalogue', 'weather closure sb_weather:d: a second closure of r10 2026-07-02']);
});

test('follow-ups: as legacy has them, the stale awaiting ones included; what does not fit is skipped or dropped', () => {
  const r = report();
  const out = mapLegacyWeather({
    closures: [closure('w1', 'r10', '2026-07-02')],
    bookings: [
      tag('BK-1', 'r10|2026-07-02', 'resolved', { weatherresolve_notifiedat: '2026-07-01T06:54:43.137Z', weatherresolve_outcome: 'reschedule',
        weatherresolve_resolvedat: '2026-07-01T06:54:49.248Z', weatherresolve_newdate: '2026-07-06' }),
      tag('BK-2', 'r10|2026-07-02', 'awaiting'),
      tag('BK-3', 'r10|2026-07-02', 'resolved', { weatherresolve_outcome: 'cancel', weatherresolve_newdate: '2026-07-09' }),
      tag('BK-4', 'r12|2026-07-03', 'awaiting'),
      tag('BK-9', 'r10|2026-07-02', 'awaiting'),
      { id: 'BK-5', weatherresolve_event: null },
    ],
  }, ctx, r);
  assert.deepEqual(out.cases.map((c) => [c.booking_id, c.status, c.outcome, c.new_date, c.notified_at, c.resolved_at]), [
    ['lg_BK-1', 'resolved', 'reschedule', '2026-07-06', '2026-07-01T06:54:43.137Z', '2026-07-01T06:54:49.248Z'],
    ['lg_BK-2', 'awaiting', null, null, null, null],
    ['lg_BK-3', 'resolved', 'cancel', null, null, null],
  ]);
  assert.ok(out.cases.every((c) => c.closure_id === 'lg_w1'));
  assert.deepEqual(r.skipped, ['weather follow-up BK-4: closure r12|2026-07-03 not imported (not in sb_weather)', 'weather follow-up BK-9: booking not imported']);
  assert.ok(r.notes.includes('weather follow-up new dates dropped: not a reschedule, or not a date'));
  assert.ok(r.notes.includes('weather follow-ups still awaiting (imported as they are)'));
});
