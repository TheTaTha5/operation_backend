/**
 * Legacy's seat locks, their sub-groups and their log as rows for migration 048
 * (todo/seat-lock-extras-model.md, decided 2026-10-09). Pure, so `test/legacy-locks.test.ts` checks
 * the mapping on fixture rows; `import-legacy.ts` writes what this returns.
 *
 * - A day lock is one lock, `lg_<id>`. A bulk (or older month) lock is a group `lg_<id>` plus one lock
 *   per departure, `lg_<id>_<date>`: the days in its range, on its weekdays, that the route runs
 *   (legacy `bkV2LockRange`, `bkV2LockDowOk`, `bkV2LockRounds`).
 * - A sub-group is a lock of its own with `parent_id` (no longer folded into its parent).
 * - What was asked is kept: legacy lowered `qty` on every release, so `pax` is `qty` plus the seats
 *   its `release` log lines gave back, and `released_pax` is those seats (decision 7).
 * - Pending seats come over as pending (`pendqty`, `pendby`), no longer subtracted.
 * - Holders: an agent legacy knows stays an agent lock; a name it does not (free text) becomes an
 *   office lock with the name first in the reason (decision 8–9). A sub-group takes its parent's.
 * - Status: only `active` holds. `expired` keeps its expiry, so it reads expired here, which is the
 *   same thing worked out on read; `depleted`, `released`, `converted` become `released`. A bulk
 *   departure legacy released by hand (`releaseddates`) comes in released.
 * - The log comes over line by line, `imported`: a bulk lock's onto its group, and onto the departure
 *   when the line names one (`tripdate`).
 */
import { eachDate, todayInThailand } from '../domain/calendar.js';
import type { Report } from './legacy-records.js';

type Row = Record<string, unknown>;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_MONTH = /^\d{4}-\d{2}$/;
const HH_MM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
/** Legacy caps a range at 800 days (`guard++<800`); so does this. */
const MAX_DAYS = 800;
const str = (value: unknown): string => (value == null ? '' : String(value).trim());
const int = (value: unknown): number => { const n = Number(value); return Number.isFinite(n) ? Math.trunc(n) : 0; };
const json = (value: unknown): unknown => { const s = str(value); if (!s) return undefined; try { return JSON.parse(s); } catch { return undefined; } };
const instant = (value: unknown): string | null => { const s = str(value); return s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : null; };
const isoDay = (value: unknown): string | null => { const s = str(value); return ISO_DAY.test(s) ? s : null; };

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

/** The weekdays a lock holds seats on (0 = Sunday); empty for every day. */
function weekdays(lock: Row): number[] {
  const dow = json(lock.dow);
  return Array.isArray(dow) ? [...new Set(dow.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b) : [];
}

/** The dates legacy released by hand: a list, or (older) a map with truthy values. */
function releasedDates(lock: Row): Set<string> {
  const value = json(lock.releaseddates);
  if (Array.isArray(value)) return new Set(value.map(str));
  if (value && typeof value === 'object') return new Set(Object.entries(value).filter(([, v]) => v).map(([k]) => k));
  return new Set();
}

export type Departure = { service_date: string; pending: number; released: boolean };

/**
 * One entry per departure of a lock that spans days: the date, its pending seats, and whether legacy
 * released that round by hand. `isOpen` is the route calendar's answer for the lock's route. A string
 * is why nothing can be made of the lock (no range, or a range past legacy's cap).
 */
export function departures(lock: Row, isOpen: (date: string) => boolean): Departure[] | string {
  const range = lockRange(lock);
  if (!range) return 'no date range';
  if (range.to < range.from) return `range ${range.from}..${range.to} ends before it starts`;
  const days = [...eachDate(range.from, range.to)];
  if (days.length > MAX_DAYS) return `range ${range.from}..${range.to} is longer than ${MAX_DAYS} days`;
  const dow = new Set(weekdays(lock)), released = releasedDates(lock);
  const pending = (json(lock.pendby) ?? {}) as Record<string, unknown>;
  return days
    .filter((date) => (dow.size === 0 || dow.has(new Date(`${date}T00:00:00Z`).getUTCDay())) && isOpen(date))
    .map((date) => ({ service_date: date, pending: Math.max(0, int(pending[date])), released: released.has(date) }));
}

export type LockContext = {
  prefix: string;
  /** Agents legacy knows, by id. */
  agents: ReadonlySet<string>;
  routes: ReadonlySet<string>;
  isOpen: (routeId: string, date: string) => boolean;
  /** Asia/Bangkok, for an `expired` lock whose expiry has not passed. */
  today: string;
  /** For a lock with no readable creation time. */
  now: string;
};
export type LockRows = {
  groups: Row[];
  locks: Row[];
  events: Row[];
  /** Legacy lock id (sub-groups included) → its route and the imported lock of each date. */
  lockAt: Map<string, { route: string; days: Map<string, string> }>;
};

/** Legacy statuses that hold seats: only `active`; `expired` is worked out from the expiry here. */
function statusOf(legacy: string, expiry: string | null, today: string, report: Report, what: string): 'active' | 'released' {
  if (legacy === 'active') return 'active';
  if (legacy === 'expired') {
    if (expiry && expiry < today) { report.note(`${what} expired → active with its expiry (reads expired)`); return 'active'; }
    report.note(`${what} expired with no expiry past → released`);
    return 'released';
  }
  report.note(`${what} ${legacy || '(blank)'} → released`);
  return 'released';
}

export function mapLegacyLocks(src: { locks: readonly Row[]; log: readonly Row[] }, ctx: LockContext, report: Report): LockRows {
  const out: LockRows = { groups: [], locks: [], events: [], lockAt: new Map() };
  const byId = new Map(src.locks.map((l) => [str(l.id), l]));
  const kidsOf = new Map<string, Row[]>();
  for (const l of src.locks) if (str(l.parentid)) kidsOf.set(str(l.parentid), [...(kidsOf.get(str(l.parentid)) ?? []), l]);
  const logOf = new Map<string, Row[]>();
  for (const e of [...src.log].sort((a, b) => str(a.sb_seat_locks_id).localeCompare(str(b.sb_seat_locks_id)) || int(a.idx) - int(b.idx))) {
    logOf.set(str(e.sb_seat_locks_id), [...(logOf.get(str(e.sb_seat_locks_id)) ?? []), e]);
  }
  /** Seats a lock's `release` lines gave back: legacy took them off `qty`. */
  const releasedOf = (id: string) => (logOf.get(id) ?? []).filter((e) => str(e.type) === 'release').reduce((sum, e) => sum + Math.max(0, int(e.qty)), 0);
  /** Where a legacy lock's log lines go: its lock, or its group and the departure the line names. */
  const logTarget = new Map<string, { lock?: string; group?: string; byDate?: Map<string, string> }>();

  const created = (l: Row) => ({ created_at: instant(l.createdat) ?? ctx.now, created_by: str(l.createdby) || null });
  for (const l of src.locks) {
    const id = str(l.id);
    if (str(l.parentid)) {
      if (!byId.has(str(l.parentid))) report.skip('seat lock', id, `sub-group of ${str(l.parentid)}, which legacy no longer has`);
      continue;
    }
    const routeId = str(l.routeid), scope = str(l.scope) || 'day';
    if (!ctx.routes.has(routeId)) { report.skip('seat lock', id, `route ${routeId || '(none)'} not in catalogue`); continue; }
    const released = releasedOf(id), qty = Math.max(0, int(l.qty)), pax = qty + released;
    if (pax <= 0) { report.skip('seat lock', id, 'no seats: qty 0 and nothing released'); continue; }

    // The holder. A name legacy does not know as an agent is kept, as an office lock's reason.
    let holderType = str(l.holdertype) || 'office', agentId: string | null = str(l.holderid) || null;
    let reason = str(l.reason) || null;
    if (holderType === 'agent' && agentId && !ctx.agents.has(agentId)) {
      report.note('free-text holders → office, the name kept in the reason');
      reason = reason ? `${agentId} · ${reason}` : agentId;
      holderType = 'office'; agentId = null;
    } else if (holderType === 'agent' && !agentId) { report.note('agent locks with no agent → office'); holderType = 'office'; }
    if (!['agent', 'office', 'global'].includes(holderType)) { report.note(`holder type ${holderType} → office`); holderType = 'office'; }
    if (holderType !== 'agent') agentId = null;
    const holder = { holder_type: holderType, agent_id: agentId };
    const days = new Map<string, string>();
    const lockRow = (row: Partial<Row>): Row => ({
      pending_pax: 0, released_pax: 0, expiry: null, reason: null, group_id: null, parent_id: null, sub_name: null, boat_id: null,
      released_at: null, version: 1, ...holder, ...created(l), updated_at: created(l).created_at, ...row,
    });

    if (spansDays(l)) {
      const rounds = departures(l, (date) => ctx.isOpen(routeId, date));
      if (typeof rounds === 'string') { report.skip('seat lock', id, `${scope} lock: ${rounds}`); continue; }
      if (rounds.length === 0) { report.skip('seat lock', id, `${scope} lock covers no day the route runs`); continue; }
      const range = lockRange(l)!;
      const groupId = ctx.prefix + id;
      const days_before = str(l.releasedaysbefore) === '' ? null : int(l.releasedaysbefore), time = str(l.releasetime);
      const cutoff = days_before !== null && days_before >= 0 && HH_MM.test(time) ? { release_days_before: days_before, release_time: time } : { release_days_before: null, release_time: null };
      if ((days_before !== null || time) && cutoff.release_time === null) report.note('bulk release cutoffs dropped: not "N days, HH:MM"');
      out.groups.push({ id: groupId, version: 1, route_id: routeId, ...holder, date_from: range.from, date_to: range.to, weekdays: weekdays(l), pax, ...cutoff, reason, ...created(l), updated_at: created(l).created_at });
      const status = str(l.status) === 'active' ? 'active' : 'released';
      report.note(`${scope} locks → a group and one lock per departure`);
      for (const round of rounds) {
        const lockId = `${groupId}_${round.service_date}`;
        const roundStatus = status === 'active' && !round.released ? 'active' : 'released';
        out.locks.push(lockRow({
          id: lockId, route_id: routeId, service_date: round.service_date, pax, released_pax: Math.min(released, pax),
          pending_pax: roundStatus === 'active' ? Math.min(round.pending, qty) : 0, status: roundStatus, group_id: groupId,
        }));
        days.set(round.service_date, lockId);
      }
      report.note(`${scope} lock departures written`);
      logTarget.set(id, { group: groupId, byDate: days });
    } else {
      const day = isoDay(l.date);
      if (!day) { report.skip('seat lock', id, str(l.date) ? `bad date ${str(l.date)}` : 'undated lock has no date'); continue; }
      const boatId = scope === 'boat' ? str(l.boatid) || null : null;
      const expiry = isoDay(l.expiry);
      // A whole-boat hold never expires by itself (legacy skips it in the sweep).
      const status = boatId ? (str(l.status) === 'active' ? 'active' : 'released') : statusOf(str(l.status), expiry, ctx.today, report, scope === 'boat' ? 'whole-boat holds' : 'locks');
      if (scope === 'boat') report.note(boatId ? 'whole-boat holds imported with their boat' : 'whole-boat holds with no boat (a plain lock)');
      const lockId = ctx.prefix + id;
      out.locks.push(lockRow({
        id: lockId, route_id: routeId, service_date: day, pax, released_pax: Math.min(released, pax), boat_id: boatId, expiry, reason,
        pending_pax: status === 'active' && !boatId ? Math.min(Math.max(0, int(l.pendqty)), qty) : 0, status,
      }));
      days.set(day, lockId);
      logTarget.set(id, { lock: lockId });
    }
    out.lockAt.set(id, { route: routeId, days });

    // Its sub-groups, on each of its days. Their own expiry is not kept: a sub-group's is its parent's (decision 10).
    for (const kid of kidsOf.get(id) ?? []) {
      const kidId = str(kid.id), kidReleased = releasedOf(kidId), kidQty = Math.max(0, int(kid.qty)), kidPax = kidQty + kidReleased;
      if (kidPax <= 0) { report.skip('seat lock', kidId, 'sub-group with no seats: qty 0 and nothing released'); continue; }
      if (isoDay(kid.expiry) && isoDay(kid.expiry) !== isoDay(l.expiry)) report.note('sub-group expiry dropped: a sub-group\'s is its parent\'s');
      const kidStatus = str(kid.status) === 'active' || str(kid.status) === 'expired' ? 'active' : 'released';
      report.note(`sub-groups ${str(kid.status) || '(blank)'} → ${kidStatus}`);
      const kidDays = new Map<string, string>();
      for (const [date, parentLockId] of days) {
        const kidLockId = spansDays(l) ? `${ctx.prefix}${kidId}_${date}` : ctx.prefix + kidId;
        out.locks.push({
          ...lockRow({}), ...created(kid), updated_at: created(kid).created_at,
          id: kidLockId, route_id: routeId, service_date: date, pax: kidPax, released_pax: Math.min(kidReleased, kidPax), status: kidStatus,
          reason: str(kid.reason) || null, group_id: spansDays(l) ? ctx.prefix + id : null, parent_id: parentLockId, sub_name: str(kid.subname) || 'ย่อย',
        });
        kidDays.set(date, kidLockId);
      }
      out.lockAt.set(kidId, { route: routeId, days: kidDays });
      logTarget.set(kidId, spansDays(l) ? { group: ctx.prefix + id, byDate: kidDays } : { lock: ctx.prefix + kidId });
      report.note('sub-groups imported as their own locks');
    }
  }

  // The log, line by line, in legacy's order.
  for (const [legacyId, lines] of logOf) {
    const target = logTarget.get(legacyId);
    if (!target) { report.note('log lines of locks not imported, dropped'); continue; }
    for (const e of lines) {
      const at = instant(e.at), tripDate = isoDay(e.tripdate);
      const day = isoDay(e.date) ?? (at ? todayInThailand(new Date(at)) : null);
      if (!day) { report.note('log lines with no day, dropped'); continue; }
      const lockId = target.lock ?? (tripDate ? target.byDate?.get(tripDate) ?? null : null);
      out.events.push({
        lock_id: lockId, group_id: target.group ?? null, type: str(e.type) || 'unknown', qty: str(e.qty) === '' ? null : int(e.qty),
        trip_date: tripDate, booking_id: str(e.bookingid) || null, note: str(e.note) || null, day, at, by: str(e.by) || null, imported: true,
      });
    }
  }
  return out;
}
