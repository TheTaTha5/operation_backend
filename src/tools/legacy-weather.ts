/**
 * Legacy's weather closures and their follow-ups as rows for migration 060
 * (todo/weather-closures-model.md). Pure, so `test/legacy-weather.test.ts` checks the mapping on
 * fixture rows; `import-legacy.ts` writes what this returns, replacing every closure it imported
 * before (their rows go with them).
 *
 * - `sb_weather` → `weather_closures`: legacy kept no user, so `closed_by` stays empty; a blank note
 *   is none. One open closure per trip, as legacy keeps one per route and date.
 * - `sb_bookings.weatherresolve_*` → `weather_cases`, found by `event` (`<route>|<date>`). Imported as
 *   legacy has them, the 3 stale `awaiting` ones included (decision 9). A booking with no tag has no
 *   row: here it is on the list while it is on the trip.
 */
import { CASE_OUTCOMES, CASE_STATUSES, type CaseOutcome, type CaseStatus } from '../domain/weather.js';
import type { Report } from './legacy-records.js';

type Row = Record<string, unknown>;
const str = (value: unknown): string => (value == null ? '' : String(value).trim());
const instant = (value: unknown): string | null => { const s = str(value); return s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : null; };
const isDay = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

export type WeatherContext = { prefix: string; routes: ReadonlySet<string>; bookings: ReadonlySet<string> };
export type WeatherRows = { closures: Row[]; cases: Row[] };

export function mapLegacyWeather(src: { closures: Row[]; bookings: Row[] }, ctx: WeatherContext, report: Report): WeatherRows {
  const out: WeatherRows = { closures: [], cases: [] };
  const byTrip = new Map<string, string>();
  for (const c of [...src.closures].sort((a, b) => (str(a.at) < str(b.at) ? -1 : str(a.at) > str(b.at) ? 1 : str(a.id) < str(b.id) ? -1 : 1))) {
    const legacyId = str(c.id), route = str(c.routeid), date = str(c.date);
    if (!ctx.routes.has(route)) { report.skip('weather closure', legacyId, `route ${route || '(blank)'} not in catalogue`); continue; }
    if (!isDay(date)) { report.skip('weather closure', legacyId, `bad date ${date || '(blank)'}`); continue; }
    const at = instant(c.at);
    if (!at) { report.skip('weather closure', legacyId, 'no readable time'); continue; }
    if (byTrip.has(`${route}|${date}`)) { report.skip('weather closure', legacyId, `a second closure of ${route} ${date}`); continue; }
    if (str(c.reason) && str(c.reason) !== 'weather') report.note(`weather closures with reason ${str(c.reason)} (imported as weather)`);
    const id = ctx.prefix + legacyId;
    byTrip.set(`${route}|${date}`, id);
    out.closures.push({ id, route_id: route, service_date: date, note: str(c.note) || null, closed_by: null, closed_at: at });
  }

  for (const b of src.bookings) {
    const event = str(b.weatherresolve_event);
    if (!event) continue;
    const bookingId = ctx.prefix + str(b.id);
    if (!ctx.bookings.has(bookingId)) { report.skip('weather follow-up', str(b.id), 'booking not imported'); continue; }
    const closureId = byTrip.get(event);
    if (!closureId) { report.skip('weather follow-up', str(b.id), `closure ${event} not imported (not in sb_weather)`); continue; }
    const status = str(b.weatherresolve_status) as CaseStatus;
    if (!(CASE_STATUSES as readonly string[]).includes(status)) { report.skip('weather follow-up', str(b.id), `status ${status || '(blank)'}`); continue; }
    let outcome = str(b.weatherresolve_outcome) as CaseOutcome | '';
    if (outcome && !(CASE_OUTCOMES as readonly string[]).includes(outcome)) { report.skip('weather follow-up', str(b.id), `outcome ${outcome}`); continue; }
    if (status === 'resolved' && !outcome) { report.skip('weather follow-up', str(b.id), 'resolved with no outcome'); continue; }
    if (status !== 'resolved' && outcome) { report.note('weather follow-up outcomes dropped: not resolved'); outcome = ''; }
    let newDate = str(b.weatherresolve_newdate) || null;
    if (newDate && (outcome !== 'reschedule' || !isDay(newDate))) { report.note('weather follow-up new dates dropped: not a reschedule, or not a date'); newDate = null; }
    if (status === 'awaiting') report.note('weather follow-ups still awaiting (imported as they are)');
    out.cases.push({
      closure_id: closureId, booking_id: bookingId, status, notified_at: instant(b.weatherresolve_notifiedat), notified_by: null,
      outcome: outcome || null, new_date: newDate, resolved_at: status === 'resolved' ? instant(b.weatherresolve_resolvedat) : null, resolved_by: null,
    });
  }
  return out;
}
