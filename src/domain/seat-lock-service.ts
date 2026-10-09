/**
 * The seat-lock commands (todo/seat-lock-extras-model.md, decided 2026-10-09), written once over the
 * small I/O interface both stores implement. Every command reads what it needs, decides with the pure
 * rules in `seat-locks.ts`, and only then writes, so the in-process store (which cannot roll back)
 * and PostgreSQL leave the same rows behind. Run each inside `store.transaction`.
 *
 * Seats are weighed under the route-day's pool lock (`holdPool`), the same lock a booking's draw
 * takes, so a lock and a sale cannot both take the last seat.
 */
import { randomUUID } from 'node:crypto';
import { assertRoutesOpen, routeCalendar, todayInThailand, type Route, type RouteDayOverride, type RouteSeason } from './calendar.js';
import { freeForLock, type DayState } from './capacity.js';
import type { Exclusion } from './operations.js';
import {
  bulkDates, byCreated, editNote, eventAt, groupView, isHolding, lockTree, lockViews, pendingFor, pendNote, refuseLock, refuseShort, shortOn, treeLock,
  type GroupRow, type HolderType, type LockEvent, type LockQuery, type LockRow, type NewLockEvent, type PendingChoice, type SeatLock, type SeatLockGroup, type ShortDay, type TreeNumbers,
} from './seat-locks.js';

type Maybe<T> = T | Promise<T>;

/** What a store gives the commands. Both stores implement it; nothing here knows which one it has. */
export interface SeatLockIO {
  /** Serializes everything that weighs one route-day's seats (an advisory lock in PostgreSQL). */
  holdPool(routeId: string, date: string): Maybe<void>;
  day(routeId: string, date: string, exclude?: Exclusion): Maybe<DayState>;
  lockRows(q: LockQuery): Maybe<LockRow[]>;
  /** Seats drawn from each lock by bookings that hold seats. */
  lockDrawn(ids: readonly string[]): Maybe<Map<string, number>>;
  /** Inserts or replaces one lock row as given. */
  putLock(row: LockRow): Maybe<void>;
  lockGroupRows(q: { ids?: readonly string[]; routeId?: string; agentId?: string }): Maybe<GroupRow[]>;
  putLockGroup(row: GroupRow): Maybe<void>;
  addLockEvents(rows: readonly NewLockEvent[]): Maybe<void>;
  /** Oldest first. `groupId` gives the bulk lock's own lines and every line of its departures. */
  lockEvents(q: { lockId?: string; groupId?: string }): Maybe<LockEvent[]>;
  listRoutes(): Maybe<Route[]>;
  listSeasons(): Maybe<RouteSeason[]>;
  listDayOverrides(from?: string, to?: string): Maybe<RouteDayOverride[]>;
  agent(id: string): Maybe<unknown>;
}

export type NewLockInput = {
  route_id: string; service_date: string; pax: number; holder_type: HolderType; agent_id: string | null;
  reason: string | null; expiry: string | null; pending?: PendingChoice;
  /** A whole-boat hold: set by the import and tests only (its own design, todo/boat-holds-model.md). */
  boat_id?: string | null;
};
export type LockChanges = {
  pax?: number; holder_type?: HolderType; agent_id?: string | null; reason?: string | null; expiry?: string | null;
  route_id?: string; service_date?: string; sub_name?: string; pending?: PendingChoice;
};
export type NewGroupInput = {
  route_id: string; date_from: string; date_to: string; weekdays: number[]; pax: number; holder_type: HolderType; agent_id: string | null;
  reason: string | null; release_days_before: number | null; release_time: string | null; pending?: PendingChoice;
};
export type GroupChanges = {
  pax?: number; holder_type?: HolderType; agent_id?: string | null; reason?: string | null;
  release_days_before?: number | null; release_time?: string | null; pending?: PendingChoice;
};
export type SubGroupInput = { sub_name: string; pax: number; reason: string | null };
export type AddInput = { pax: number; note: string | null; pending?: PendingChoice };
export type GroupDetail = SeatLockGroup & { seat_locks: SeatLock[] };
export type OverdueRelease = { service_date: string; route_id: string | null; released: SeatLock[]; seats: number };

const bad = (message: string): never => refuseLock(message, 400);
const conflict = (message: string, code: string): never => refuseLock(message, 409, code);

/** The holder a write leaves: `agent_id` alone means an agent lock; `null` alone means office. */
function nextHolder(current: { holder_type: HolderType; agent_id: string | null }, changes: { holder_type?: HolderType; agent_id?: string | null }): { holder_type: HolderType; agent_id: string | null } {
  const holder_type = changes.holder_type
    ?? (changes.agent_id === undefined ? current.holder_type : changes.agent_id ? 'agent' : current.holder_type === 'agent' ? 'office' : current.holder_type);
  const agent_id = holder_type === 'agent' ? (changes.agent_id === undefined ? current.agent_id : changes.agent_id) : (changes.agent_id ?? null);
  if (holder_type !== 'agent' && agent_id) bad(`agent_id is for an agent lock (holder_type "agent"), not ${holder_type}`);
  if (holder_type === 'agent' && !agent_id) bad('An agent lock needs agent_id');
  return { holder_type, agent_id };
}

export class SeatLockService {
  constructor(private readonly io: SeatLockIO, private readonly clock: () => Date = () => new Date()) {}

  // ── Reads ──────────────────────────────────────────────────────────────────────────────────────

  /** `rows` with their numbers. Fetches whatever the trees need (a sub-group's parent, a parent's sub-groups). */
  async views(rows: readonly LockRow[]): Promise<SeatLock[]> {
    if (rows.length === 0) return [];
    const all = new Map(rows.map((r) => [r.id, r]));
    const parents = [...new Set(rows.filter((r) => r.parent_id && !all.has(r.parent_id)).map((r) => r.parent_id!))];
    if (parents.length) for (const r of await this.io.lockRows({ ids: parents })) all.set(r.id, r);
    const tops = [...all.values()].filter((r) => !r.parent_id).map((r) => r.id);
    if (tops.length) for (const r of await this.io.lockRows({ parentIds: tops })) all.set(r.id, r);
    const drawn = await this.io.lockDrawn([...all.keys()]);
    const groupIds = [...new Set([...all.values()].map((r) => r.group_id).filter((id): id is string => !!id))];
    const groups = new Map((groupIds.length ? await this.io.lockGroupRows({ ids: groupIds }) : []).map((g) => [g.id, g]));
    const views = lockViews([...all.values()], drawn, groups, this.clock());
    return rows.map((r) => views.get(r.id)!);
  }
  async list(q: LockQuery): Promise<SeatLock[]> { return this.views((await this.io.lockRows(q)).sort(byCreated)); }
  async lock(id: string): Promise<SeatLock | undefined> {
    const [row] = await this.io.lockRows({ ids: [id] });
    return row && (await this.views([row]))[0];
  }
  async log(id: string): Promise<LockEvent[] | undefined> {
    const [row] = await this.io.lockRows({ ids: [id] });
    return row && this.io.lockEvents({ lockId: id });
  }

  async group(id: string): Promise<GroupDetail | undefined> {
    const [group] = await this.io.lockGroupRows({ ids: [id] });
    if (!group) return undefined;
    const locks = await this.views((await this.io.lockRows({ groupId: id })).sort((a, b) => a.service_date.localeCompare(b.service_date) || (a.parent_id ? 1 : 0) - (b.parent_id ? 1 : 0) || byCreated(a, b)));
    return { ...groupView(group, locks, this.clock()), seat_locks: locks };
  }
  async groups(q: { routeId?: string; agentId?: string }): Promise<SeatLockGroup[]> {
    const groups = (await this.io.lockGroupRows(q)).sort(byCreated);
    const out: SeatLockGroup[] = [];
    for (const group of groups) out.push(groupView(group, await this.views(await this.io.lockRows({ groupId: group.id })), this.clock()));
    return out;
  }
  async groupLog(id: string): Promise<LockEvent[] | undefined> {
    const [group] = await this.io.lockGroupRows({ ids: [id] });
    return group && this.io.lockEvents({ groupId: id });
  }

  // ── Shared checks ──────────────────────────────────────────────────────────────────────────────

  private today(): string { return todayInThailand(this.clock()); }

  private async assertRoute(routeId: string): Promise<void> {
    const routes = await this.io.listRoutes();
    // An unseeded in-process store has no catalogue to check against, as for bookings.
    if (routes.length > 0 && !routes.some((r) => r.id === routeId)) bad(`Unknown route ${routeId} (GET /v1/routes)`);
  }
  private async calendar(from: string, to: string) {
    return routeCalendar(await this.io.listSeasons(), await this.io.listDayOverrides(from, to));
  }
  private async assertOpen(routeId: string, date: string): Promise<void> {
    const names = new Map((await this.io.listRoutes()).map((r) => [r.id, r.name]));
    assertRoutesOpen(await this.calendar(date, date), [{ route_id: routeId, service_date: date }], names);
  }
  /** Decision 8–9: an agent lock needs a real agent. */
  private async assertHolder(holder: { holder_type: HolderType; agent_id: string | null }): Promise<void> {
    if (holder.holder_type !== 'agent') return;
    if (!holder.agent_id || !(await this.io.agent(holder.agent_id))) bad(`agent_id ${holder.agent_id} is not an agent (GET /v1/agents)`);
  }
  private async load(id: string): Promise<LockRow | undefined> { return (await this.io.lockRows({ ids: [id] }))[0]; }
  private async tree(top: LockRow): Promise<{ kids: LockRow[]; drawn: Map<string, number>; numbers: TreeNumbers }> {
    const kids = (await this.io.lockRows({ parentIds: [top.id] })).sort(byCreated);
    const drawn = await this.io.lockDrawn([top.id, ...kids.map((k) => k.id)]);
    return { kids, drawn, numbers: lockTree(treeLock(top, drawn), kids.map((k) => treeLock(k, drawn))) };
  }
  /** What a top-level lock would still need on its day, against the seats free there; undefined when it fits. */
  private async short(row: LockRow, used: number, ownHeld: number): Promise<ShortDay | undefined> {
    if (row.service_date < this.today() || row.boat_id) return undefined;
    const day = await this.io.day(row.route_id, row.service_date);
    return shortOn(row.service_date, freeForLock(day, ownHeld), Math.max(0, row.pax - row.released_pax - used));
  }
  private stamp(row: LockRow): LockRow { return { ...row, version: row.version + 1, updated_at: this.clock().toISOString() }; }
  private event(by: string | undefined, line: Parameters<typeof eventAt>[2]): NewLockEvent { return eventAt(this.clock(), by, line); }
  private noBoat(row: LockRow): void {
    if (row.boat_id) refuseLock('A whole-boat hold takes its boat; only a full release applies to it here (todo/boat-holds-model.md)', 400, 'boat_hold');
  }

  // ── One lock ───────────────────────────────────────────────────────────────────────────────────

  async create(input: NewLockInput, by?: string): Promise<SeatLock> {
    await this.assertRoute(input.route_id);
    await this.assertHolder(input);
    await this.assertOpen(input.route_id, input.service_date);
    await this.io.holdPool(input.route_id, input.service_date);
    const now = this.clock().toISOString();
    let row: LockRow = {
      id: `lock_${randomUUID()}`, version: 1, route_id: input.route_id, service_date: input.service_date, pax: input.pax, pending_pax: 0, released_pax: 0,
      holder_type: input.holder_type, agent_id: input.agent_id, status: 'active', expiry: input.expiry, reason: input.reason,
      group_id: null, parent_id: null, sub_name: null, boat_id: input.boat_id ?? null, created_at: now, created_by: by ?? null, updated_at: now, released_at: null,
    };
    const short = await this.short(row, 0, 0);
    const events = [this.event(by, { lock_id: row.id, group_id: null, type: 'create', qty: input.pax })];
    if (short) {
      if (!input.pending) refuseShort(row.route_id, [short]);
      row = { ...row, pending_pax: pendingFor(short, input.pending) };
      events.push(this.event(by, { lock_id: row.id, group_id: null, type: 'pend', ...pendNote([short], input.pending) }));
    }
    await this.io.putLock(row);
    await this.io.addLockEvents(events);
    return (await this.views([row]))[0];
  }

  /** `PATCH`: client facts only. See the design note for what each field may do. */
  async amend(id: string, changes: LockChanges, by?: string): Promise<SeatLock | undefined> {
    const row = await this.load(id);
    if (!row) return undefined;
    if (changes.pending === 'all') bad('pending: "all" is for a new lock only; an edit keeps what is free and the rest pending ("split")');
    if (row.parent_id) return this.amendSubGroup(row, changes, by);
    if (changes.sub_name !== undefined) bad('sub_name belongs to a sub-group');
    const moving =(changes.route_id !== undefined && changes.route_id !== row.route_id) || (changes.service_date !== undefined && changes.service_date !== row.service_date);
    const holder = nextHolder(row, changes);
    const holderChanged = holder.holder_type !== row.holder_type || holder.agent_id !== row.agent_id;
    if (row.boat_id && ((changes.pax ?? row.pax) !== row.pax || moving)) this.noBoat(row);
    if (row.group_id) {
      if (moving) bad('A departure of a bulk lock cannot move; release it and lock the other day');
      if (holderChanged) bad(`A departure takes its bulk lock's holder: change seat-lock group ${row.group_id}`);
      if (changes.expiry) bad('A bulk lock has no expiry: its departures use the release cutoff');
    }
    if (holderChanged) await this.assertHolder(holder);
    const route_id = changes.route_id ?? row.route_id, service_date = changes.service_date ?? row.service_date;
    if (moving) {
      await this.assertRoute(route_id);
      await this.assertOpen(route_id, service_date);
      for (const [r, d] of [[row.route_id, row.service_date], [route_id, service_date]].sort((a, b) => `${a[0]} ${a[1]}`.localeCompare(`${b[0]} ${b[1]}`))) await this.io.holdPool(r, d);
    } else {
      await this.io.holdPool(row.route_id, row.service_date);
    }
    // Read under the pool lock: a draw on this lock takes the same lock, so these numbers are final.
    const { kids, drawn, numbers } = await this.tree(row);
    if ((moving || holderChanged) && numbers.used > 0) conflict('Seats of this lock are already drawn: its route, date and holder cannot change', 'lock_drawn');
    const pax = changes.pax ?? row.pax;
    const floor = row.released_pax + (drawn.get(row.id) ?? 0) + numbers.allocated;
    if (pax < floor) conflict(`Seats cannot go below ${floor} (${numbers.allocated > (drawn.get(row.id) ?? 0) ? 'already split into sub-groups' : 'already drawn'}${row.released_pax ? `, ${row.released_pax} released` : ''})`, 'below_floor');
    let next: LockRow = this.stamp({
      ...row, route_id, service_date, pax, ...holder,
      reason: changes.reason === undefined ? row.reason : changes.reason, expiry: changes.expiry === undefined ? row.expiry : changes.expiry,
    });
    // Lowering seats takes pending seats off first; a moved lock's pending seats meant the old day.
    if (moving) next.pending_pax = 0;
    else if (pax < row.pax) next.pending_pax = Math.max(0, row.pending_pax - (row.pax - pax));
    const events: NewLockEvent[] = [];
    if (pax > row.pax || moving) {
      const holding = isHolding(row, this.today());
      const short = await this.short(next, moving ? 0 : numbers.used, moving || !holding ? 0 : numbers.held);
      // Legacy asks only when the shortfall is more than what already waits (`_shortNew`).
      if (short && short.short > (moving ? 0 : numbers.pend)) {
        if (!changes.pending) refuseShort(next.route_id, [short]);
        next = { ...next, pending_pax: pendingFor(short, 'split') };
        events.push(this.event(by, { lock_id: row.id, group_id: row.group_id, type: 'pend', ...pendNote([short], 'split') }));
      }
    }
    const note = editNote(
      { pax: row.pax, route_id: row.route_id, service_date: row.service_date, holder_type: row.holder_type, agent_id: row.agent_id, expiry: row.expiry, reason: row.reason },
      { pax: next.pax, route_id: next.route_id, service_date: next.service_date, holder_type: next.holder_type, agent_id: next.agent_id, expiry: next.expiry, reason: next.reason });
    if (note) events.unshift(this.event(by, { lock_id: row.id, group_id: row.group_id, type: 'edit', note }));
    await this.io.putLock(next);
    // A sub-group lives on its parent's route, day and holder.
    if (moving || holderChanged) for (const kid of kids) await this.io.putLock(this.stamp({ ...kid, route_id, service_date, ...holder }));
    await this.io.addLockEvents(events);
    return (await this.views([next]))[0];
  }

  private async amendSubGroup(row: LockRow, changes: LockChanges, by?: string): Promise<SeatLock> {
    const parent = (await this.load(row.parent_id!))!;
    // Echoed unchanged they are ignored, as a client sending the lock back would.
    for (const field of ['route_id', 'service_date', 'holder_type', 'agent_id', 'expiry'] as const) {
      if (changes[field] !== undefined && changes[field] !== parent[field]) bad(`A sub-group takes its parent's ${field}: change seat lock ${row.parent_id}`);
    }
    await this.io.holdPool(parent.route_id, parent.service_date);
    const { drawn, numbers } = await this.tree(parent);
    const pax = changes.pax ?? row.pax;
    const floor = row.released_pax + (drawn.get(row.id) ?? 0);
    if (pax < floor) conflict(`Seats cannot go below ${floor} (already drawn)`, 'below_floor');
    if (pax - row.pax > numbers.room) conflict(`Only ${numbers.room} seats of the parent lock are left to put in a sub-group`, 'no_room');
    const next = this.stamp({ ...row, pax, sub_name: changes.sub_name ?? row.sub_name, reason: changes.reason === undefined ? row.reason : changes.reason });
    const note = editNote({ pax: row.pax, sub_name: row.sub_name, reason: row.reason }, { pax: next.pax, sub_name: next.sub_name, reason: next.reason });
    await this.io.putLock(next);
    if (note) await this.io.addLockEvents([this.event(by, { lock_id: row.id, group_id: row.group_id, type: 'edit', note })]);
    return (await this.views([next]))[0];
  }

  /** Legacy "+ seats" (`bkV2LockAddSeats`): more seats, the lock active again if it was released. */
  async add(id: string, input: AddInput, by?: string): Promise<SeatLock | undefined> {
    const row = await this.load(id);
    if (!row) return undefined;
    this.noBoat(row);
    if (input.pending === 'all') bad('pending: "all" is for a new lock only; adding seats keeps what is free and the rest pending ("split")');
    const events: NewLockEvent[] = [this.event(by, { lock_id: row.id, group_id: row.group_id, type: 'add', qty: input.pax, note: input.note })];
    let next: LockRow;
    if (row.parent_id) {
      const parent = (await this.load(row.parent_id))!;
      await this.io.holdPool(parent.route_id, parent.service_date);
      const { numbers } = await this.tree(parent);
      if (input.pax > numbers.room) conflict(`Only ${numbers.room} seats of the parent lock are left to put in a sub-group`, 'no_room');
      next = this.stamp({ ...row, pax: row.pax + input.pax, status: 'active', released_at: null });
    } else {
      await this.io.holdPool(row.route_id, row.service_date);
      const { numbers } = await this.tree(row);
      next = this.stamp({ ...row, pax: row.pax + input.pax, status: 'active', released_at: null });
      const holding = isHolding(row, this.today());
      const short = await this.short(next, numbers.used, holding ? numbers.held : 0);
      if (short && short.short > (holding ? numbers.pend : 0)) {
        if (!input.pending) refuseShort(row.route_id, [short]);
        next = { ...next, pending_pax: pendingFor(short, 'split') };
        events.push(this.event(by, { lock_id: row.id, group_id: row.group_id, type: 'pend', ...pendNote([short], 'split') }));
      }
    }
    await this.io.putLock(next);
    await this.io.addLockEvents(events);
    return (await this.views([next]))[0];
  }

  /**
   * Legacy Release (`bkV2ReleaseLock`): `pax` undrawn seats back, all of them when absent. A parent
   * releases only its seats in no sub-group; a sub-group's go back to its parent. Pending seats go
   * first. With nothing left, the lock is `released`. `pax` is kept; `released_pax` grows.
   */
  async release(id: string, seats: number | undefined, by?: string): Promise<SeatLock | undefined> {
    const row = await this.load(id);
    if (!row) return undefined;
    if (row.boat_id) {
      if (seats !== undefined) this.noBoat(row);
      return this.releaseWhole(row, by, 'release');
    }
    const parent = row.parent_id ? (await this.load(row.parent_id))! : row;
    await this.io.holdPool(parent.route_id, parent.service_date);
    const { kids, drawn, numbers } = await this.tree(parent);
    const own = drawn.get(row.id) ?? 0;
    const releasable = row.status === 'released' ? 0 : Math.max(0, (row.parent_id ? row.pax - row.released_pax : numbers.unallocated) - own);
    if (seats !== undefined && seats > releasable) conflict(`Only ${releasable} seats of this lock can be released: the rest are drawn${row.parent_id ? '' : ' or in sub-groups'}`, 'below_floor');
    const n = seats ?? releasable;
    if (n === 0) return (await this.views([row]))[0];
    let next = this.stamp({ ...row, released_pax: row.released_pax + n, pending_pax: Math.max(0, row.pending_pax - n) });
    const left = next.pax - next.released_pax - own;
    const done = row.parent_id ? left <= 0 : left <= 0 && next.pending_pax === 0 && kids.length === 0;
    if (done) next = { ...next, status: 'released', released_at: this.clock().toISOString() };
    await this.io.putLock(next);
    await this.io.addLockEvents([this.event(by, { lock_id: row.id, group_id: row.group_id, type: 'release', qty: n })]);
    return (await this.views([next]))[0];
  }

  /**
   * Legacy "release this departure" (`bkV2LockReleaseRound`, §lkNoAuto): everything the lock holds
   * that day, sub-groups and pending seats included, back to the pool now.
   */
  async releaseDeparture(id: string, by?: string): Promise<SeatLock | undefined> {
    const row = await this.load(id);
    if (!row) return undefined;
    if (row.parent_id) bad(`A sub-group is released with its departure: release seat lock ${row.parent_id}`);
    return this.releaseWhole(row, by, 'release-round');
  }
  private async releaseWhole(row: LockRow, by: string | undefined, type: 'release' | 'release-round'): Promise<SeatLock> {
    if (row.status === 'released') return (await this.views([row]))[0];
    await this.io.holdPool(row.route_id, row.service_date);
    const { numbers } = await this.tree(row);
    const holding = isHolding(row, this.today());
    const seats = row.boat_id || !holding ? 0 : numbers.held;
    const now = this.clock().toISOString();
    const next = this.stamp({ ...row, status: 'released', released_at: now, pending_pax: 0, released_pax: Math.min(row.pax, Math.max(row.released_pax, row.pax - numbers.used)) });
    await this.io.putLock(next);
    await this.io.addLockEvents([this.event(by, {
      lock_id: row.id, group_id: row.group_id, type, qty: seats, trip_date: row.service_date,
      note: numbers.pend > 0 ? `${numbers.pend} pending ended` : null,
    })]);
    return (await this.views([next]))[0];
  }

  /** Legacy `bkV2LockReleaseOverdueGo`: every overdue lock of the day that still holds seats, at once. */
  async releaseOverdue(serviceDate: string, routeId: string | undefined, by?: string): Promise<OverdueRelease> {
    const tops = (await this.io.lockRows({ serviceDate, routeId })).filter((r) => !r.parent_id).sort(byCreated);
    const due = (await this.views(tops)).filter((l) => l.overdue && (l.held_pax ?? 0) > 0);
    const released: SeatLock[] = [];
    for (const lock of due) released.push((await this.releaseWhole((await this.load(lock.id))!, by, 'release-round')));
    return { service_date: serviceDate, route_id: routeId ?? null, released, seats: due.reduce((s, l) => s + (l.held_pax ?? 0), 0) };
  }

  /** Legacy `bkV2LockPendConfirm`: pending seats become held ones, as far as seats are free now. */
  async confirmPending(id: string, want: number | undefined, by?: string): Promise<SeatLock | undefined> {
    const row = await this.load(id);
    if (!row) return undefined;
    if (row.parent_id) bad(`Pending seats are on the parent lock: confirm seat lock ${row.parent_id}`);
    if (!isHolding(row, this.today())) conflict(`Seat lock ${row.id} is not holding seats`, 'not_holding');
    await this.io.holdPool(row.route_id, row.service_date);
    const { numbers } = await this.tree(row);
    if (numbers.pend <= 0) conflict('This lock has no pending seats', 'nothing_pending');
    const free = freeForLock(await this.io.day(row.route_id, row.service_date));
    const can = free === null ? numbers.pend : Math.min(numbers.pend, free);
    const n = Math.min(can, want ?? can);
    if (n <= 0) conflict('No free seats on this trip yet - the lock stays pending', 'no_free_seats');
    const next = this.stamp({ ...row, pending_pax: numbers.pend - n });
    await this.io.putLock(next);
    await this.io.addLockEvents([this.event(by, { lock_id: row.id, group_id: row.group_id, type: 'pend-confirm', qty: n, trip_date: row.service_date })]);
    return (await this.views([next]))[0];
  }

  /** Legacy `bkV2CreateSubLock`: a named slice of a lock's seats, out of its room (§lkOver, §lkPendSub). */
  async createSubGroup(parentId: string, input: SubGroupInput, by?: string): Promise<SeatLock | undefined> {
    const parent = await this.load(parentId);
    if (!parent) return undefined;
    const [kid] = await this.subGroups([parent], input, by);
    return kid;
  }
  private async subGroups(parents: readonly LockRow[], input: SubGroupInput, by?: string): Promise<SeatLock[]> {
    const plans: { parent: LockRow; kid: LockRow }[] = [];
    const short: string[] = [];
    let room = Infinity;
    for (const parent of parents) {
      if (parent.parent_id) bad('A sub-group cannot have sub-groups of its own');
      this.noBoat(parent);
      if (!isHolding(parent, this.today())) conflict(`Seat lock ${parent.id} is not holding seats`, 'not_holding');
      await this.io.holdPool(parent.route_id, parent.service_date);
      const { numbers } = await this.tree(parent);
      if (input.pax > numbers.room) { short.push(parent.service_date); room = Math.min(room, numbers.room); continue; }
      const now = this.clock().toISOString();
      plans.push({ parent, kid: {
        id: `lock_${randomUUID()}`, version: 1, route_id: parent.route_id, service_date: parent.service_date, pax: input.pax, pending_pax: 0, released_pax: 0,
        holder_type: parent.holder_type, agent_id: parent.agent_id, status: 'active', expiry: null, reason: input.reason,
        group_id: parent.group_id, parent_id: parent.id, sub_name: input.sub_name, boat_id: null, created_at: now, created_by: by ?? null, updated_at: now, released_at: null,
      } });
    }
    if (short.length) {
      conflict(parents.length === 1 ? `Only ${room} seats are left to put in a sub-group`
        : `Only ${room} seats are left to put in a sub-group on ${short.length} departure${short.length === 1 ? '' : 's'} (${short.slice(0, 6).join(', ')}${short.length > 6 ? ', …' : ''})`, 'no_room');
    }
    for (const { parent, kid } of plans) {
      // The parent's numbers changed, so a copy of it read before this is stale.
      await this.io.putLock(this.stamp(parent));
      await this.io.putLock(kid);
    }
    await this.io.addLockEvents(plans.map(({ kid }) => this.event(by, { lock_id: kid.id, group_id: kid.group_id, type: 'create', qty: kid.pax, note: `sub-group ${kid.sub_name}` })));
    return this.views(plans.map((p) => p.kid));
  }

  // ── Bulk locks ─────────────────────────────────────────────────────────────────────────────────

  /** Legacy's bulk lock: one lock per departure the route runs in the range, on the weekdays chosen. */
  async createGroup(input: NewGroupInput, by?: string): Promise<GroupDetail> {
    await this.assertRoute(input.route_id);
    await this.assertHolder(input);
    const calendar = await this.calendar(input.date_from, input.date_to);
    const dates = bulkDates(input.date_from, input.date_to, input.weekdays).filter((d) => calendar.isOpen(input.route_id, d));
    if (dates.length === 0) refuseLock('This lock covers no departure at all - check the date range and the weekdays you ticked', 400, 'no_departure');
    const now = this.clock().toISOString();
    const group: GroupRow = {
      id: `lkg_${randomUUID()}`, version: 1, route_id: input.route_id, holder_type: input.holder_type, agent_id: input.agent_id,
      date_from: input.date_from, date_to: input.date_to, weekdays: input.weekdays, pax: input.pax,
      release_days_before: input.release_days_before, release_time: input.release_time, reason: input.reason, created_at: now, created_by: by ?? null, updated_at: now,
    };
    const rows: LockRow[] = [];
    const shorts: ShortDay[] = [];
    for (const date of dates) {
      await this.io.holdPool(input.route_id, date);
      const row: LockRow = {
        id: `lock_${randomUUID()}`, version: 1, route_id: input.route_id, service_date: date, pax: input.pax, pending_pax: 0, released_pax: 0,
        holder_type: input.holder_type, agent_id: input.agent_id, status: 'active', expiry: null, reason: null,
        group_id: group.id, parent_id: null, sub_name: null, boat_id: null, created_at: now, created_by: by ?? null, updated_at: now, released_at: null,
      };
      const short = await this.short(row, 0, 0);
      if (short) { shorts.push(short); if (input.pending) row.pending_pax = pendingFor(short, input.pending); }
      rows.push(row);
    }
    if (shorts.length && !input.pending) refuseShort(input.route_id, shorts);
    const events = [this.event(by, { lock_id: null, group_id: group.id, type: 'create', qty: input.pax })];
    if (shorts.length) events.push(this.event(by, { lock_id: null, group_id: group.id, type: 'pend', ...pendNote(shorts, input.pending!) }));
    await this.io.putLockGroup(group);
    for (const row of rows) await this.io.putLock(row);
    await this.io.addLockEvents(events);
    return (await this.group(group.id))!;
  }

  /** The departures a bulk-lock write changes: every one not released, sub-groups aside. */
  private async departures(groupId: string): Promise<LockRow[]> {
    return (await this.io.lockRows({ groupId })).filter((r) => !r.parent_id).sort((a, b) => a.service_date.localeCompare(b.service_date));
  }

  async amendGroup(id: string, changes: GroupChanges, by?: string): Promise<GroupDetail | undefined> {
    const [group] = await this.io.lockGroupRows({ ids: [id] });
    if (!group) return undefined;
    if (changes.pending === 'all') bad('pending: "all" is for a new lock only; an edit keeps what is free and the rest pending ("split")');
    const all = await this.io.lockRows({ groupId: id });
    const holder = nextHolder(group, changes);
    const holderChanged = holder.holder_type !== group.holder_type || holder.agent_id !== group.agent_id;
    if (holderChanged) {
      const drawn = await this.io.lockDrawn(all.map((r) => r.id));
      if ([...drawn.values()].some((n) => n > 0)) conflict('Seats of this lock are already drawn: its holder cannot change', 'lock_drawn');
      await this.assertHolder(holder);
    }
    const writes: LockRow[] = [];
    const shorts: ShortDay[] = [];
    if (changes.pax !== undefined && changes.pax !== group.pax) {
      const below: string[] = [];
      let floorMax = 0;
      for (const row of (await this.departures(id)).filter((r) => r.status === 'active')) {
        await this.io.holdPool(row.route_id, row.service_date);
        const { drawn, numbers } = await this.tree(row);
        const floor = row.released_pax + (drawn.get(row.id) ?? 0) + numbers.allocated;
        if (changes.pax < floor) { below.push(row.service_date); floorMax = Math.max(floorMax, floor); continue; }
        let next = this.stamp({ ...row, pax: changes.pax });
        if (changes.pax < row.pax) next.pending_pax = Math.max(0, row.pending_pax - (row.pax - changes.pax));
        else {
          const holding = isHolding(row, this.today());
          const short = await this.short(next, numbers.used, holding ? numbers.held : 0);
          if (short && short.short > (holding ? numbers.pend : 0)) { shorts.push(short); next = { ...next, pending_pax: pendingFor(short, 'split') }; }
        }
        writes.push(next);
      }
      if (below.length) conflict(`Seats cannot go below ${floorMax} (already drawn on one round: ${below.slice(0, 6).join(', ')}${below.length > 6 ? ', …' : ''})`, 'below_floor');
      if (shorts.length && !changes.pending) refuseShort(group.route_id, shorts);
    }
    const next: GroupRow = {
      ...group, ...holder, version: group.version + 1, updated_at: this.clock().toISOString(),
      pax: changes.pax ?? group.pax, reason: changes.reason === undefined ? group.reason : changes.reason,
      release_days_before: changes.release_days_before === undefined ? group.release_days_before : changes.release_days_before,
      release_time: changes.release_time === undefined ? group.release_time : changes.release_time,
    };
    const note = editNote(
      { pax: group.pax, holder_type: group.holder_type, agent_id: group.agent_id, release_days_before: group.release_days_before, release_time: group.release_time, reason: group.reason },
      { pax: next.pax, holder_type: next.holder_type, agent_id: next.agent_id, release_days_before: next.release_days_before, release_time: next.release_time, reason: next.reason });
    const events: NewLockEvent[] = [];
    if (note) events.push(this.event(by, { lock_id: null, group_id: id, type: 'edit', note }));
    if (shorts.length) events.push(this.event(by, { lock_id: null, group_id: id, type: 'pend', ...pendNote(shorts, 'split') }));
    await this.io.putLockGroup(next);
    const written = new Map(writes.map((w) => [w.id, w]));
    if (holderChanged) for (const row of all) written.set(row.id, { ...(written.get(row.id) ?? this.stamp(row)), ...holder });
    for (const row of written.values()) await this.io.putLock(row);
    await this.io.addLockEvents(events);
    return this.group(id);
  }

  /** "+ seats" on every departure not released. */
  async addGroup(id: string, input: AddInput, by?: string): Promise<GroupDetail | undefined> {
    const [group] = await this.io.lockGroupRows({ ids: [id] });
    if (!group) return undefined;
    if (input.pending === 'all') bad('pending: "all" is for a new lock only; adding seats keeps what is free and the rest pending ("split")');
    const writes: LockRow[] = [];
    const shorts: ShortDay[] = [];
    for (const row of (await this.departures(id)).filter((r) => r.status === 'active')) {
      await this.io.holdPool(row.route_id, row.service_date);
      const { numbers } = await this.tree(row);
      let next = this.stamp({ ...row, pax: row.pax + input.pax });
      const holding = isHolding(row, this.today());
      const short = await this.short(next, numbers.used, holding ? numbers.held : 0);
      if (short && short.short > (holding ? numbers.pend : 0)) { shorts.push(short); next = { ...next, pending_pax: pendingFor(short, 'split') }; }
      writes.push(next);
    }
    if (shorts.length && !input.pending) refuseShort(group.route_id, shorts);
    await this.io.putLockGroup({ ...group, pax: group.pax + input.pax, version: group.version + 1, updated_at: this.clock().toISOString() });
    for (const row of writes) await this.io.putLock(row);
    const events = [this.event(by, { lock_id: null, group_id: id, type: 'add', qty: input.pax, note: input.note })];
    if (shorts.length) events.push(this.event(by, { lock_id: null, group_id: id, type: 'pend', ...pendNote(shorts, 'split') }));
    await this.io.addLockEvents(events);
    return this.group(id);
  }

  /**
   * Legacy Release on a bulk lock: the same `pax` off every departure not released, at most what the
   * busiest departure can give (legacy: its seats in no sub-group less the most drawn on one round).
   */
  async releaseGroup(id: string, seats: number | undefined, by?: string): Promise<GroupDetail | undefined> {
    const [group] = await this.io.lockGroupRows({ ids: [id] });
    if (!group) return undefined;
    const plans: { row: LockRow; own: number; kids: number; releasable: number }[] = [];
    for (const row of (await this.departures(id)).filter((r) => r.status === 'active')) {
      await this.io.holdPool(row.route_id, row.service_date);
      const { kids, drawn, numbers } = await this.tree(row);
      const own = drawn.get(row.id) ?? 0;
      plans.push({ row, own, kids: kids.length, releasable: Math.max(0, numbers.unallocated - own) });
    }
    const releasable = plans.length ? Math.min(...plans.map((p) => p.releasable)) : 0;
    if (seats !== undefined && seats > releasable) conflict(`Only ${releasable} seats per departure can be released: the rest are drawn or in sub-groups`, 'below_floor');
    const n = seats ?? releasable;
    if (n === 0) return this.group(id);
    const now = this.clock().toISOString();
    for (const { row, own, kids } of plans) {
      let next = this.stamp({ ...row, released_pax: row.released_pax + n, pending_pax: Math.max(0, row.pending_pax - n) });
      if (next.pax - next.released_pax - own <= 0 && next.pending_pax === 0 && kids === 0) next = { ...next, status: 'released', released_at: now };
      await this.io.putLock(next);
    }
    await this.io.putLockGroup({ ...group, version: group.version + 1, updated_at: now });
    await this.io.addLockEvents([this.event(by, { lock_id: null, group_id: id, type: 'release', qty: n })]);
    return this.group(id);
  }

  /** The same sub-group on every departure from today on that still holds; all or none. */
  async groupSubGroups(id: string, input: SubGroupInput, by?: string): Promise<GroupDetail | undefined> {
    const [group] = await this.io.lockGroupRows({ ids: [id] });
    if (!group) return undefined;
    const today = this.today();
    const parents = (await this.departures(id)).filter((r) => r.service_date >= today && isHolding(r, today));
    if (parents.length === 0) conflict('No departure of this bulk lock from today on still holds seats', 'not_holding');
    await this.subGroups(parents, input, by);
    await this.io.putLockGroup({ ...group, version: group.version + 1, updated_at: this.clock().toISOString() });
    return this.group(id);
  }
}

/** Every lock id a write's result names, for the change feed. */
export function lockIdsIn(result: unknown): string[] {
  if (!result || typeof result !== 'object') return [];
  const r = result as { id?: unknown; service_date?: unknown; seat_locks?: { id: string }[]; released?: { id: string }[] };
  return [
    ...(typeof r.id === 'string' && typeof r.service_date === 'string' ? [r.id] : []),
    ...(Array.isArray(r.seat_locks) ? r.seat_locks.map((l) => l.id) : []),
    ...(Array.isArray(r.released) ? r.released.map((l) => l.id) : []),
  ];
}
