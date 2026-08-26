import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eachDate, routeCalendar, type RouteDayOverride, type RouteSeason } from '../src/domain/calendar.js';

const season = (route_id: string, kind: 'open' | 'closed', from_date: string, to_date: string): RouteSeason =>
  ({ id: `${route_id}-${from_date}-${kind}`, route_id, kind, from_date, to_date });
const override = (route_id: string, service_date: string, kind: 'open' | 'closed'): RouteDayOverride =>
  ({ route_id, service_date, kind });

test('a route with no seasons runs every day', () => {
  const calendar = routeCalendar([], []);
  assert.deepEqual(calendar.status('r1', '2026-08-26'), { open: true, source: 'no-seasons' });
});

test('the season containing the date decides it', () => {
  const calendar = routeCalendar([season('r5', 'open', '2025-10-15', '2026-05-15'), season('r5', 'closed', '2026-05-16', '2026-10-14')], []);
  assert.equal(calendar.isOpen('r5', '2026-01-01'), true);
  assert.equal(calendar.isOpen('r5', '2026-08-26'), false, 'mid-monsoon');
  assert.deepEqual(calendar.status('r5', '2026-05-15'), { open: true, source: 'season' }, 'boundaries are inclusive');
  assert.deepEqual(calendar.status('r5', '2026-05-16'), { open: false, source: 'season' });
});

test('declaring any open window closes every date outside all of them', () => {
  // The rule the legacy app had to add in July 2026: an open-season-only route advertised itself
  // year round because "no season covers this date" was being read as "open".
  const calendar = routeCalendar([season('r7', 'open', '2026-01-01', '2026-12-31')], []);
  assert.deepEqual(calendar.status('r7', '2026-06-01'), { open: true, source: 'season' });
  assert.deepEqual(calendar.status('r7', '2027-01-15'), { open: false, source: 'outside-season' });
  assert.deepEqual(calendar.status('r7', '2025-12-31'), { open: false, source: 'outside-season' }, 'before the window too');
});

test('a route declaring only closed windows runs outside them', () => {
  const calendar = routeCalendar([season('r9', 'closed', '2026-05-16', '2026-10-14')], []);
  assert.deepEqual(calendar.status('r9', '2026-07-01'), { open: false, source: 'season' });
  assert.deepEqual(calendar.status('r9', '2026-12-01'), { open: true, source: 'no-seasons' });
});

test('a day override beats the season in both directions', () => {
  const calendar = routeCalendar(
    [season('r11', 'open', '2026-01-01', '2026-12-31'), season('r12', 'closed', '2026-01-01', '2026-12-31')],
    [override('r11', '2026-06-01', 'closed'), override('r12', '2026-10-14', 'open')],
  );
  assert.deepEqual(calendar.status('r11', '2026-06-01'), { open: false, source: 'override' }, 'closes an open season');
  assert.deepEqual(calendar.status('r12', '2026-10-14'), { open: true, source: 'override' }, 'opens a closed season');
  assert.deepEqual(calendar.status('r11', '2026-06-02'), { open: true, source: 'season' }, 'only that one day');
});

test('an override on one route never leaks to another', () => {
  const calendar = routeCalendar([season('a', 'open', '2026-01-01', '2026-12-31'), season('b', 'open', '2026-01-01', '2026-12-31')], [override('a', '2026-06-01', 'closed')]);
  assert.equal(calendar.isOpen('a', '2026-06-01'), false);
  assert.equal(calendar.isOpen('b', '2026-06-01'), true);
});

test('an unknown route is open rather than an error', () => {
  const calendar = routeCalendar([season('r1', 'open', '2026-01-01', '2026-12-31')], []);
  assert.deepEqual(calendar.status('does-not-exist', '2026-06-01'), { open: true, source: 'no-seasons' });
});

test('range resolves every date inclusive of both ends', () => {
  const calendar = routeCalendar([season('r5', 'closed', '2026-05-16', '2026-10-14')], [override('r5', '2026-05-18', 'open')]);
  const days = calendar.range('r5', '2026-05-16', '2026-05-19');
  assert.deepEqual(Object.keys(days), ['2026-05-16', '2026-05-17', '2026-05-18', '2026-05-19']);
  assert.deepEqual(days['2026-05-18'], { open: true, source: 'override' });
  assert.equal(days['2026-05-17']?.open, false);
});

test('date stepping survives month, year and leap boundaries', () => {
  assert.deepEqual([...eachDate('2026-01-31', '2026-02-01')], ['2026-01-31', '2026-02-01']);
  assert.deepEqual([...eachDate('2026-12-31', '2027-01-01')], ['2026-12-31', '2027-01-01']);
  assert.deepEqual([...eachDate('2028-02-28', '2028-03-01')], ['2028-02-28', '2028-02-29', '2028-03-01'], 'leap year');
  assert.deepEqual([...eachDate('2026-08-26', '2026-08-26')], ['2026-08-26'], 'single day');
  assert.deepEqual([...eachDate('2026-08-27', '2026-08-26')], [], 'reversed range yields nothing');
  assert.equal([...eachDate('2026-01-01', '2026-12-31')].length, 365);
});
