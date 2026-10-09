/**
 * Seat-lock rules both stores share (todo/seat-lock-extras-model.md, decided 2026-10-09): what a lock
 * holds and may give, its pending seats, its sub-groups, expiry, the bulk-lock release cutoff, the
 * short-of-seats answer and the log's wording. Written once here, as CLAUDE.md asks, so the
 * in-process store and PostgreSQL cannot drift; the commands that use them are `seat-lock-service.ts`.
 *
 * Ported from legacy's Seat Locks tab (wt-lk-inbox allotment_v2/js/08-app.js): bkV2LockHeldRemaining,
 * bkV2LockDrawable, bkV2LockUnallocDrawable, bkV2LockSubShares (§lkPendSub), bkV2LockPendOn (§lkPend),
 * bkV2LockSubRoom, bkV2LockReleaseCutoff and bkV2LockOverdue (§lkNoAuto), bkV2LockExpireSweep, and
 * the `edit` and `pend` log notes.
 */
import { eachDate, todayInThailand } from './calendar.js';
import { refuse } from './booking-actions.js';

export const HOLDER_TYPES = ['agent', 'office', 'global'] as const;
export type HolderType = (typeof HOLDER_TYPES)[number];
export const isHolderType = (value: unknown): value is HolderType => HOLDER_TYPES.includes(value as HolderType);
/** `converted`: a whole-boat hold that became a charter booking (legacy `bkV2BoatLockOnConvert`). */
export type LockStatus = 'active' | 'released' | 'converted';
/** Legacy's labels: `depleted` is a lock with nothing left that sold something. */
export type LockState = 'active' | 'depleted' | 'expired' | 'released' | 'converted';
/** A whole-boat hold's deal: this boat (`fixed`), or any boat that seats the minimum (`any`). Legacy's reused `subName`. */
export type BoatDeal = 'fixed' | 'any';
/** The answer to "not enough free seats": lock what is free and keep the rest pending, or keep it all pending. */
export type PendingChoice = 'split' | 'all';

/** A lock as stored: a day lock, one departure of a bulk lock, or a sub-group. */
export type LockRow = {
  id: string;
  version: number;
  route_id: string;
  service_date: string;
  /** Seats asked for. A release never lowers it (decision 7): `released_pax` says what went back. */
  pax: number;
  /** Of `pax`, seats waiting for room. They hold nothing and cannot be drawn. A top-level lock only. */
  pending_pax: number;
  /** Of `pax`, seats given back by a release. */
  released_pax: number;
  holder_type: HolderType;
  agent_id: string | null;
  status: LockStatus;
  /** Past this day (Asia/Bangkok) the lock stops holding. A sub-group's is its parent's. */
  expiry: string | null;
  reason: string | null;
  /** The bulk lock this is one departure of. */
  group_id: string | null;
  /** Set on a sub-group: the lock its seats are carved from. */
  parent_id: string | null;
  sub_name: string | null;
  /** A whole-boat hold (migration 047): it takes this boat, as a charter does. */
  boat_id: string | null;
  /** A hold's deal (migration 180); `null` on any other lock. */
  boat_deal: BoatDeal | null;
  /** The charter booking a hold became (`status: converted`). */
  converted_booking_id: string | null;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  released_at: string | null;
};

/** A bulk lock: the request as it was made. Its seats live on one lock per departure. */
export type GroupRow = {
  id: string;
  version: number;
  route_id: string;
  holder_type: HolderType;
  agent_id: string | null;
  date_from: string;
  date_to: string;
  /** 0 = Sunday … 6 = Saturday; empty = every day the route runs. */
  weekdays: number[];
  /** Seats asked per departure, as last set for the whole bulk lock. */
  pax: number;
  release_days_before: number | null;
  release_time: string | null;
  reason: string | null;
  created_at: string;
  created_by: string | null;
  updated_at: string;
};

/** One line of a lock's log. A bulk lock's own lines have `group_id` and no `lock_id`. */
export type LockEvent = {
  id: number;
  lock_id: string | null;
  group_id: string | null;
  type: string;
  qty: number | null;
  trip_date: string | null;
  booking_id: string | null;
  note: string | null;
  /** The day (Asia/Bangkok) it happened. Legacy's lines all have one; many have no `at` or `by`. */
  day: string;
  at: string | null;
  by: string | null;
  /** Brought over from legacy's log. */
  imported: boolean;
};
export type NewLockEvent = Omit<LockEvent, 'id' | 'imported'>;

/** A lock as the API answers it: the stored row with its numbers worked out. */
export type SeatLock = LockRow & {
  /** Seats bookings that hold seats have drawn from this lock. */
  drawn_pax: number;
  /** What a booking may draw from it now. A parent's are its seats in no sub-group. */
  remaining_pax: number;
  /** What it keeps off general sale now. A sub-group's are its parent's (0); a whole-boat hold takes its boat instead (`null`). */
  held_pax: number | null;
  /** A top-level lock: seats split into sub-groups, and what a new sub-group may still take. */
  allocated_pax: number;
  sub_group_room: number;
  holding: boolean;
  state: LockState;
  /** A bulk lock's departure with a release cutoff: when it is due back. A warning only. */
  release_at: string | null;
  /** Past `release_at` and still holding (legacy §lkNoAuto); a whole-boat hold past its expiry. */
  overdue: boolean;
};

export type SeatLockGroup = GroupRow & {
  departures: number;
  departures_past: number;
  state: 'active' | 'expired' | 'released';
  held_pax: number;
  drawn_pax: number;
  pending_pax: number;
};

export type LockQuery = {
  ids?: readonly string[];
  routeId?: string;
  serviceDate?: string;
  from?: string;
  to?: string;
  groupId?: string;
  parentIds?: readonly string[];
  agentId?: string;
  /** `true`: whole-boat holds only; `false`: every other lock. */
  boat?: boolean;
};

/** One order for both stores: oldest first, then by id. A sub-group's share of pending seats follows it. */
export const byCreated = <T extends { created_at: string; id: string }>(a: T, b: T): number =>
  a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);

/** Whether a lock row matches a query: the in-process store's filter, the SQL's `WHERE`. */
export function matchesLock(row: LockRow, q: LockQuery): boolean {
  return (!q.ids || q.ids.includes(row.id)) && (!q.routeId || row.route_id === q.routeId)
    && (!q.serviceDate || row.service_date === q.serviceDate) && (!q.from || row.service_date >= q.from) && (!q.to || row.service_date <= q.to)
    && (!q.groupId || row.group_id === q.groupId) && (!q.parentIds || (row.parent_id !== null && q.parentIds.includes(row.parent_id)))
    && (!q.agentId || row.agent_id === q.agentId) && (q.boat === undefined || (row.boat_id !== null) === q.boat);
}

// ── Holding, expiry and the release cutoff ─────────────────────────────────────────────────────

/**
 * A top-level lock keeps its seats while it is active and its expiry has not passed: a lock that
 * expires today still holds all day, as legacy's `l.expiry < today` sweep has it. Worked out on read,
 * so nothing has to run at midnight (decision 2). A whole-boat hold never expires by itself (legacy
 * skips it in the sweep): past its expiry it is only `overdue`.
 */
export function isHolding(lock: Pick<LockRow, 'status' | 'expiry' | 'boat_id'>, today: string): boolean {
  return lock.status === 'active' && (lock.boat_id !== null || lock.expiry === null || lock.expiry >= today);
}

/** "N days before the departure at HH:MM" (Asia/Bangkok, which keeps no daylight saving) as an ISO instant. */
export function releaseAt(serviceDate: string, rule: { release_days_before: number | null; release_time: string | null }): string | null {
  if (rule.release_days_before === null || rule.release_time === null) return null;
  const day = new Date(`${serviceDate}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - rule.release_days_before);
  return new Date(`${day.toISOString().slice(0, 10)}T${rule.release_time}:00+07:00`).toISOString();
}

/** Every date in `from..to` on one of `weekdays` (0 = Sunday … 6 = Saturday); empty means every day. */
export function bulkDates(from: string, to: string, weekdays: readonly number[]): string[] {
  const on = new Set(weekdays);
  return [...eachDate(from, to)].filter((date) => on.size === 0 || on.has(new Date(`${date}T00:00:00Z`).getUTCDay()));
}

// ── A lock and its sub-groups, in numbers ──────────────────────────────────────────────────────

/** A lock as the tree arithmetic needs it. `pax` is what it still has: asked, less released. */
export type TreeLock = { id: string; pax: number; pending: number; drawn: number; released: boolean; created_at: string };
export type TreeShare = { remaining: number; pending: number };
export type TreeNumbers = {
  /** Seats drawn from the lock and from every sub-group. */
  used: number;
  /** Pending seats that still count: never more than the lock has undrawn. */
  pend: number;
  /** What the lock keeps from the pool (legacy `bkV2LockPoolHold`). */
  held: number;
  /** Seats split into sub-groups, and the lock's seats in none. */
  allocated: number;
  unallocated: number;
  /** What a new sub-group, or a bigger one, may take (legacy `bkV2LockSubRoom`, §lkOver). */
  room: number;
  parent: TreeShare;
  children: Map<string, TreeShare>;
};

/**
 * A top-level lock and its sub-groups (legacy "A / B / C"), in numbers.
 *
 * Only the parent holds seats in the pool: what it has, less what was drawn from it and from every
 * sub-group, less its pending seats. A booking draws from a sub-group's own seats, or from the
 * parent's seats in no sub-group, never beyond what the parent holds. While the parent has pending
 * seats, what it holds is shared out in sub-group creation order and then to its unsplit seats; a
 * sub-group not reached is pending itself (§lkPendSub). A released sub-group gives nothing, but what
 * was drawn from it still counts against its parent.
 */
export function lockTree(parent: TreeLock, children: readonly TreeLock[]): TreeNumbers {
  const kids = [...children].sort(byCreated);
  const used = parent.drawn + kids.reduce((sum, c) => sum + c.drawn, 0);
  const pend = parent.pending > 0 ? Math.max(0, Math.min(parent.pending, parent.pax - used)) : 0;
  const held = Math.max(0, parent.pax - used - pend);
  const allocated = kids.reduce((sum, c) => sum + c.pax, 0);
  const unallocated = Math.max(0, parent.pax - allocated);
  const room = Math.max(0, unallocated - parent.drawn);
  const shares = new Map<string, TreeShare>();
  const own = (c: TreeLock) => (c.released ? 0 : Math.max(0, c.pax - c.drawn));
  let parentShare: TreeShare;
  if (pend > 0) {
    let left = held;
    for (const c of kids) {
      const rem = own(c), take = Math.min(rem, left);
      left -= take;
      shares.set(c.id, { remaining: take, pending: rem - take });
    }
    const urem = Math.max(0, unallocated - parent.drawn), take = Math.min(urem, left);
    parentShare = { remaining: take, pending: urem - take };
  } else {
    for (const c of kids) shares.set(c.id, { remaining: Math.min(own(c), held), pending: 0 });
    parentShare = { remaining: Math.max(0, Math.min(unallocated - parent.drawn, held)), pending: 0 };
  }
  return { used, pend, held, allocated, unallocated, room, parent: parentShare, children: shares };
}

/** A stored lock as a tree node. */
export const treeLock = (row: LockRow, drawn: ReadonlyMap<string, number>): TreeLock => ({
  id: row.id, pax: row.pax - row.released_pax, pending: row.pending_pax, drawn: drawn.get(row.id) ?? 0, released: row.status === 'released', created_at: row.created_at,
});

/** Children by parent id. */
export function childrenOf(rows: readonly LockRow[]): Map<string, LockRow[]> {
  const out = new Map<string, LockRow[]>();
  for (const row of rows) if (row.parent_id) out.set(row.parent_id, [...(out.get(row.parent_id) ?? []), row]);
  return out;
}

/**
 * The locks one route's day counts, for `dayCapacity`: every holding top-level lock and its
 * sub-groups. `exclude` leaves a lock and its sub-groups out (`exclude_lock_id`).
 */
export function poolLocks(rows: readonly LockRow[], drawn: ReadonlyMap<string, number>, today: string, exclude?: string) {
  const holding = new Set(rows.filter((r) => !r.parent_id && r.id !== exclude && isHolding(r, today)).map((r) => r.id));
  return rows
    .filter((r) => holding.has(r.parent_id ?? r.id))
    .sort(byCreated)
    .map((r) => ({
      id: r.id, pax: r.pax - r.released_pax, drawn: drawn.get(r.id) ?? 0, pending: r.pending_pax, released: r.status === 'released',
      created_at: r.created_at, holder_type: r.holder_type, ...(r.agent_id ? { agent_id: r.agent_id } : {}),
      ...(r.parent_id ? { parent_id: r.parent_id } : {}), ...(r.boat_id ? { boat_id: r.boat_id } : {}),
    }));
}

// ── The API's view ─────────────────────────────────────────────────────────────────────────────

/**
 * Every lock in `rows` with its numbers. `rows` must hold whole trees: a sub-group's parent and a
 * parent's sub-groups. `groups` gives a departure its release cutoff.
 */
export function lockViews(rows: readonly LockRow[], drawn: ReadonlyMap<string, number>, groups: ReadonlyMap<string, GroupRow>, now: Date): Map<string, SeatLock> {
  const today = todayInThailand(now);
  const kidsOf = childrenOf(rows);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = new Map<string, SeatLock>();
  const cutoff = (row: LockRow) => {
    const group = row.group_id ? groups.get(row.group_id) : undefined;
    return group ? releaseAt(row.service_date, group) : null;
  };
  for (const top of rows.filter((r) => !r.parent_id || !byId.has(r.parent_id))) {
    const kids = (kidsOf.get(top.id) ?? []).sort(byCreated);
    const tree = lockTree(treeLock(top, drawn), kids.map((k) => treeLock(k, drawn)));
    const holding = !top.parent_id && isHolding(top, today);
    const release_at = cutoff(top);
    const overdue = top.boat_id !== null
      ? top.status === 'active' && top.expiry !== null && top.expiry < today
      : holding && release_at !== null && now.getTime() >= Date.parse(release_at);
    const topState: LockState = top.status === 'converted' ? 'converted'
      : top.status === 'released' ? (tree.used > 0 ? 'depleted' : 'released')
      : !holding ? 'expired'
      : kids.length === 0 && tree.parent.remaining === 0 && tree.pend === 0 && tree.used > 0 ? 'depleted' : 'active';
    out.set(top.id, {
      ...top, pending_pax: tree.pend, drawn_pax: drawn.get(top.id) ?? 0,
      remaining_pax: holding ? tree.parent.remaining : 0,
      held_pax: top.boat_id !== null ? null : holding ? tree.held : 0,
      allocated_pax: tree.allocated, sub_group_room: holding ? tree.room : 0,
      holding, state: topState, release_at, overdue,
    });
    for (const kid of kids) {
      const share = tree.children.get(kid.id)!;
      const kidDrawn = drawn.get(kid.id) ?? 0;
      const kidHolding = holding && kid.status === 'active';
      const left = kid.pax - kid.released_pax - kidDrawn;
      const state: LockState = kid.status === 'released' ? (kidDrawn > 0 ? 'depleted' : 'released')
        : !holding ? (topState === 'expired' ? 'expired' : 'released')
        : left <= 0 && kidDrawn > 0 ? 'depleted' : 'active';
      out.set(kid.id, {
        ...kid, expiry: top.expiry, pending_pax: holding ? share.pending : 0, drawn_pax: kidDrawn,
        remaining_pax: kidHolding ? share.remaining : 0, held_pax: 0, allocated_pax: 0, sub_group_room: 0,
        holding: kidHolding, state, release_at, overdue: false,
      });
    }
  }
  return out;
}

/** A bulk lock with its totals, from its departures' views (sub-groups included or not). */
export function groupView(group: GroupRow, locks: readonly SeatLock[], now: Date): SeatLockGroup {
  const today = todayInThailand(now);
  const departures = locks.filter((l) => !l.parent_id);
  const sum = (pick: (l: SeatLock) => number) => departures.reduce((s, l) => s + pick(l), 0);
  const state = departures.length > 0 && departures.every((l) => l.status === 'released') ? 'released' : group.date_to < today ? 'expired' : 'active';
  return {
    ...group, departures: departures.length, departures_past: departures.filter((l) => l.service_date < today).length, state,
    held_pax: sum((l) => l.held_pax ?? 0), drawn_pax: locks.reduce((s, l) => s + l.drawn_pax, 0), pending_pax: sum((l) => l.pending_pax),
  };
}

// ── Short of seats and pending seats (legacy §lkPend) ──────────────────────────────────────────

/** A departure where the free seats do not cover what the lock still needs. */
export type ShortDay = { service_date: string; free: number; want: number; short: number };

/**
 * `free` is the day's available seats plus what this lock already holds there, or `null` on a day
 * sold ungated (a land route, a marine day with no boat yet), which never falls short: "or you could
 * never lock ahead" (legacy `bkV2LockFreeOn`). `want` is what the lock still needs: asked, less
 * released, less drawn.
 */
export function shortOn(serviceDate: string, free: number | null, want: number): ShortDay | undefined {
  if (free === null) return undefined;
  const f = Math.max(0, free);
  return want > f ? { service_date: serviceDate, free: f, want, short: want - f } : undefined;
}

/** The pending seats a choice sets on a short day: the shortfall, or everything still needed. */
export const pendingFor = (day: ShortDay, choice: PendingChoice): number => (choice === 'all' ? day.want : day.short);

/** `409 seats_short`, listing the days, unless the caller chose how to go on (legacy's "ที่นั่งว่างไม่พอ" dialog). */
export function refuseShort(routeId: string, days: readonly ShortDay[]): never {
  const one = days.length === 1 ? days[0] : undefined;
  const where = one ? `on ${routeId} ${one.service_date}: ${one.free} free of ${one.want} asked`
    : `on ${days.length} departures of ${routeId} (${days.slice(0, 6).map((d) => `${d.service_date}: ${d.free} of ${d.want}`).join(', ')}${days.length > 6 ? ', …' : ''})`;
  const error = new Error(`Not enough free seats ${where}. Send pending: "split" to lock what is free and keep the rest pending, or "all" to keep it all pending`) as Error & { statusCode: number; code: string; extra: object };
  error.statusCode = 409;
  error.code = 'seats_short';
  error.extra = { short: days };
  throw error;
}

/** Legacy's `pend` line: `free 0 of 2` for one departure, else the first six short days. */
export function pendNote(days: readonly ShortDay[], choice: PendingChoice): { qty: number; note: string; trip_date: string | null } {
  const n = (d: ShortDay) => pendingFor(d, choice);
  const qty = days.reduce((max, d) => Math.max(max, n(d)), 0);
  if (days.length === 1) return { qty, note: `free ${days[0].free} of ${days[0].want}`, trip_date: days[0].service_date };
  return { qty, trip_date: null, note: `${days.length} rounds short: ${days.slice(0, 6).map((d) => `${d.service_date.slice(5)} (${n(d)})`).join(', ')}${days.length > 6 ? ' ...' : ''}` };
}

// ── The log's words ────────────────────────────────────────────────────────────────────────────

/** Legacy's `edit` line: every changed field as `field: old → new`, joined by ` · `. Empty when nothing changed. */
export function editNote(before: Record<string, unknown>, after: Record<string, unknown>): string {
  const shown = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : Array.isArray(v) ? v.join(',') : String(v));
  return Object.keys(after).filter((k) => shown(before[k]) !== shown(after[k])).map((k) => `${k}: ${shown(before[k])} → ${shown(after[k])}`).join(' · ');
}

/** A log line written now. */
export const eventAt = (now: Date, by: string | null | undefined, line: Pick<NewLockEvent, 'lock_id' | 'group_id' | 'type'> & Partial<Pick<NewLockEvent, 'trip_date' | 'booking_id' | 'note' | 'qty'>>): NewLockEvent => ({
  qty: null, trip_date: null, booking_id: null, note: null, ...line, day: todayInThailand(now), at: now.toISOString(), by: by ?? null,
});

/**
 * The `draw` and `return` lines a booking write makes: the seats each lock gained or lost, from the
 * booking's draws before and after (legacy `bkV2DrawLock` / `bkV2ReturnLock`). A booking that no
 * longer holds seats (cancelled, rejected, waiting over the allotment) has drawn nothing, so a cancel
 * returns every seat it drew.
 */
export function drawChanges(
  before: { draws: ReadonlyMap<string, number> } | undefined, after: { draws: ReadonlyMap<string, number> } | undefined,
): { lock_id: string; delta: number }[] {
  const ids = new Set([...(before?.draws.keys() ?? []), ...(after?.draws.keys() ?? [])]);
  return [...ids].sort().map((lock_id) => ({ lock_id, delta: (after?.draws.get(lock_id) ?? 0) - (before?.draws.get(lock_id) ?? 0) })).filter((c) => c.delta !== 0);
}

/** `409`/`400` refusals with the codes the README lists. */
export const refuseLock = (message: string, status: 400 | 409, code?: string): never => refuse(message, status, code);
