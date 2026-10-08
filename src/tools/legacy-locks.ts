/**
 * Legacy's bulk and month seat locks as one lock per departure. Pure, so
 * `test/legacy-locks.test.ts` checks it on fixture rows; `import-legacy.ts` writes what it returns.
 *
 * A lock here is one route on one date. Legacy also has locks that span days (decided 2026-10-08,
 * the same split the legacy integration client makes since 2026-10-05):
 *
 * - `scope = 'bulk'`: `datefrom` … `dateto`, on the weekdays in `dow` (`[]` = every day);
 * - `scope = 'month'` (the older form): the whole months `monthfrom` … `monthto` (else `month`).
 *
 * Each becomes one lock per date the route runs that day, as legacy counts its rounds
 * (`bkV2LockRange`, `bkV2LockDowOk`, `bkV2LockRounds`, 08-app.js:2888-3270). Per date:
 *
 * - seats are `qty` less that date's pending seats (`pendby`), which legacy reserves nothing for
 *   (`bkV2LockPendOn`); a date left with none is not imported;
 * - released when legacy released that round by hand (`releaseddates`) or the whole lock is no
 *   longer active. Legacy does not release a round by itself (§lkNoAuto, 2026-09-29), and neither
 *   does this service, so `releasedaysbefore`/`releasetime` carry nothing over.
 */
import { eachDate } from '../domain/calendar.js';

type Row = Record<string, unknown>;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_MONTH = /^\d{4}-\d{2}$/;
/** Legacy caps a range at 800 days (`guard++<800`); so does this. */
const MAX_DAYS = 800;
const str = (value: unknown): string => (value == null ? '' : String(value).trim());
const json = (value: unknown): unknown => { const s = str(value); if (!s) return undefined; try { return JSON.parse(s); } catch { return undefined; } };

/** True for the locks legacy spreads over days (`bkV2LockSpansDays`). */
export const spansDays = (lock: Row): boolean => str(lock.scope) === 'bulk' || str(lock.scope) === 'month';

/** The first and last date of a lock's range, or undefined when it has none. */
export function lockRange(lock: Row): { from: string; to: string } | undefined {
  if (str(lock.scope) === 'month') {
    const from = str(lock.monthfrom) || str(lock.month), to = str(lock.monthto) || from;
    if (!ISO_MONTH.test(from) || !ISO_MONTH.test(to)) return undefined;
    const [y, m] = to.split('-').map(Number);
    const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
    return { from: `${from}-01`, to: `${to}-${String(last).padStart(2, '0')}` };
  }
  const from = str(lock.datefrom), to = str(lock.dateto) || from;
  return ISO_DAY.test(from) && ISO_DAY.test(to) ? { from, to } : undefined;
}

/** The weekdays a lock holds seats on (0 = Sunday), or undefined for every day. */
function weekdays(lock: Row): Set<number> | undefined {
  const dow = json(lock.dow);
  return Array.isArray(dow) && dow.length ? new Set(dow.map(Number)) : undefined;
}

/** The dates legacy released by hand: a list, or (older) a map with truthy values. */
function releasedDates(lock: Row): Set<string> {
  const value = json(lock.releaseddates);
  if (Array.isArray(value)) return new Set(value.map(str));
  if (value && typeof value === 'object') return new Set(Object.entries(value).filter(([, v]) => v).map(([k]) => k));
  return new Set();
}

export type LockDay = { service_date: string; pax: number; released: boolean };

/**
 * One entry per departure of a lock that spans days: the date, its seats and whether that round is
 * released. `isOpen` is the route calendar's answer for the lock's route. A string is why nothing
 * can be made of the lock (no range, or a range past legacy's cap).
 */
export function lockDays(lock: Row, isOpen: (date: string) => boolean): LockDay[] | string {
  const range = lockRange(lock);
  if (!range) return 'no date range';
  if (range.to < range.from) return `range ${range.from}..${range.to} ends before it starts`;
  const days = [...eachDate(range.from, range.to)];
  if (days.length > MAX_DAYS) return `range ${range.from}..${range.to} is longer than ${MAX_DAYS} days`;
  const dow = weekdays(lock), released = releasedDates(lock);
  const pending = (json(lock.pendby) ?? {}) as Record<string, unknown>;
  const qty = Math.max(0, Math.trunc(Number(lock.qty) || 0));
  const active = str(lock.status) === 'active';
  const out: LockDay[] = [];
  for (const date of days) {
    if (dow && !dow.has(new Date(`${date}T00:00:00Z`).getUTCDay())) continue;
    if (!isOpen(date)) continue;
    const pax = qty - Math.max(0, Math.trunc(Number(pending[date]) || 0));
    if (pax <= 0) continue;
    out.push({ service_date: date, pax, released: !active || released.has(date) });
  }
  return out;
}
