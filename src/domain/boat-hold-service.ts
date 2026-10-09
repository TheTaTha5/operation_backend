/**
 * The whole-boat hold commands (todo/seat-lock-extras-model.md, "Design — whole-boat holds"; legacy
 * §bkLock), written once over the I/O both stores implement, as `seat-lock-service.ts` is. A hold is a
 * seat lock with `boat_id`: these make, edit and release one, list the boats one may take, and turn
 * one into the charter booking that replaces it. The rules are `boat-holds.ts`.
 *
 * Each command reads, decides, and only then writes, so the in-process store (which cannot roll back)
 * and PostgreSQL leave the same rows. Run each inside `store.transaction`.
 */
import { randomUUID } from 'node:crypto';
import { assertRoutesOpen, routeCalendar, todayInThailand, type Route } from './calendar.js';
import { deploymentNumbers, type BoatRecord } from './catalogue.js';
import type { Availability } from './fleet-availability.js';
import type { Booking, Deployment } from './operations.js';
import { nextHolder, SeatLockService, type SeatLockIO } from './seat-lock-service.js';
import { eventAt, refuseLock, type BoatDeal, type HolderType, type LockRow, type NewLockEvent, type SeatLock } from './seat-locks.js';
import {
  assertBigEnough, assertCanTake, assertHoldFields, blockedWhy, boatSeats, holdBlockers, holdEditNote,
  type HoldBlockers, type HoldDayFacts, type HoldFacts,
} from './boat-holds.js';

type Maybe<T> = T | Promise<T>;

/** What a store gives the hold commands: the seat-lock I/O, plus the day's boats and bookings. */
export interface BoatHoldIO extends SeatLockIO {
  listDeployments(from?: string, to?: string, routeId?: string): Maybe<Deployment[]>;
  createDeployment(input: Deployment): Maybe<Deployment>;
  /** Bookings with a trip that date, on any route. */
  bookingsOnDate(date: string): Maybe<Booking[]>;
  boatRecords(): Maybe<BoatRecord[]>;
}
/** Whether a catalogue boat can sail that day (`GET /v1/fleet/availability`'s answer). */
export type Readiness = (boat: BoatRecord, date: string) => Promise<Availability>;

export type NewHoldInput = {
  route_id: string; service_date: string; boat_id: string; pax: number; boat_deal: BoatDeal;
  holder_type: HolderType; agent_id: string | null; expiry: string | null; reason: string | null;
};
export type HoldChanges = {
  route_id?: string; service_date?: string; boat_id?: string; pax?: number; boat_deal?: BoatDeal;
  holder_type?: HolderType; agent_id?: string | null; expiry?: string | null; reason?: string | null;
  /** Legacy's "This hold names a specific boat … Continue?" answered yes. */
  change_boat_anyway?: boolean;
};
/** One line of legacy's boat list in the hold form (`bkV2BoatLockPickList`). */
export type BoatOption = {
  boat_id: string; name: string; capacity: number; pier: string | null;
  /** The boat the hold being edited already holds that day: always listed, always pickable. */
  own: boolean; ok: boolean; why: { code: string; message: string } | null;
  placed_route_id: string | null; blockers: HoldBlockers;
};
export type BoatOptions = { route_id: string; service_date: string; boats: BoatOption[] };

const bad = (message: string, code?: string): never => refuseLock(message, 400, code);
const conflict = (message: string, code: string): never => refuseLock(message, 409, code);

export class BoatHoldService {
  private readonly locks: SeatLockService;
  constructor(private readonly io: BoatHoldIO, private readonly readiness: Readiness, private readonly clock: () => Date = () => new Date()) {
    this.locks = new SeatLockService(io, clock);
  }

  private today(): string { return todayInThailand(this.clock()); }
  private async view(row: LockRow): Promise<SeatLock> { return (await this.locks.views([row]))[0]; }
  private event(by: string | undefined, line: Parameters<typeof eventAt>[2]): NewLockEvent { return eventAt(this.clock(), by, line); }
  private stamp(row: LockRow): LockRow { return { ...row, version: row.version + 1, updated_at: this.clock().toISOString() }; }

  /** A known route that has boats (legacy `laIsLandRoute`). An unseeded in-process store knows none and takes any. */
  private async route(id: string): Promise<Route> {
    const routes = await this.io.listRoutes();
    const route = routes.find((r) => r.id === id);
    if (!route) return routes.length > 0 ? bad(`Unknown route ${id} (GET /v1/routes)`) : { id, name: id };
    if (route.kind === 'land') bad('A land programme has no boat to hold', 'land_route');
    return route;
  }
  private async routeName(id: string): Promise<(routeId: string) => string> {
    const names = new Map((await this.io.listRoutes()).map((r) => [r.id, r.name]));
    return (routeId) => names.get(routeId) ?? routeId ?? id;
  }
  private async assertOpen(routeId: string, date: string): Promise<void> {
    const names = new Map((await this.io.listRoutes()).map((r) => [r.id, r.name]));
    assertRoutesOpen(routeCalendar(await this.io.listSeasons(), await this.io.listDayOverrides(date, date)), [{ route_id: routeId, service_date: date }], names);
  }
  private async assertHolder(holder: { holder_type: HolderType; agent_id: string | null }): Promise<void> {
    if (holder.holder_type === 'agent' && (!holder.agent_id || !(await this.io.agent(holder.agent_id)))) bad(`agent_id ${holder.agent_id} is not an agent (GET /v1/agents)`);
  }
  private async holderName(h: { holder_type: HolderType; agent_id: string | null }): Promise<string> {
    if (h.holder_type !== 'agent' || !h.agent_id) return h.holder_type === 'global' ? 'everyone' : 'the office';
    const agent = await this.io.agent(h.agent_id) as { name?: string } | undefined;
    return agent?.name ?? h.agent_id;
  }
  private async facts(routeId: string, date: string): Promise<HoldDayFacts> {
    return {
      bookings: await this.io.bookingsOnDate(date), deployments: await this.io.listDeployments(date, date),
      locks: await this.io.lockRows({ serviceDate: date }), day: await this.io.day(routeId, date),
    };
  }
  private async boatName(id: string): Promise<string> { return (await this.io.boatRecords()).find((b) => b.id === id)?.name ?? id; }

  /** The boat, from the catalogue or (for a boat the catalogue lacks) its deployment that day. */
  private async boat(boatId: string, date: string, facts: HoldDayFacts): Promise<{ record?: BoatRecord; deployment?: Deployment; name: string }> {
    const record = (await this.io.boatRecords()).find((b) => b.id === boatId);
    const deployment = facts.deployments.find((d) => d.boat_id === boatId && d.service_date === date);
    if (!record && !deployment) bad(`Unknown boat ${boatId} (GET /v1/boats)`);
    if (record?.retired) conflict(`${record.name} is retired: restore it before holding it`, 'boat_retired');
    return { record, deployment, name: record?.name ?? boatId };
  }
  /** Legacy's list offers only the route's pier and boats ready that day; the boat already held is exempt. */
  private async assertPickable(record: BoatRecord | undefined, route: Route, date: string): Promise<void> {
    if (!record) return;
    if (route.pier && record.pier && record.pier !== route.pier) conflict(`${record.name} is at ${record.pier}; ${route.name} sails from ${route.pier}`, 'boat_other_pier');
    const ready = await this.readiness(record, date);
    if (ready.status !== 'available') conflict(`${record.name} is not ready on ${date}: ${ready.status}${ready.reason ? ` (${ready.reason})` : ''}`, 'boat_not_ready');
  }
  /** Legacy `bkV2BoatLockCanTake`, another route asked first as the form does. */
  private async assertFree(b: HoldBlockers, routeId: string, date: string): Promise<void> {
    assertCanTake(b, routeId, date, await this.routeName(routeId));
  }
  /**
   * Legacy writes the boat-board cell, placing the boat on the route when it was not on the board:
   * here, the boat's deployment that day. A boat the hold already holds moves with it to a new route.
   */
  private async place(routeId: string, date: string, boatId: string, record: BoatRecord | undefined, deployment: Deployment | undefined): Promise<void> {
    if (deployment?.route_id === routeId) return;
    if (deployment) { await this.io.createDeployment({ ...deployment, route_id: routeId }); return; }
    await this.io.createDeployment({ boat_id: boatId, route_id: routeId, service_date: date, ...deploymentNumbers(record!) });
  }

  // ── The commands ───────────────────────────────────────────────────────────────────────────────

  /** Legacy `bkV2BoatLockSubmit` → `bkV2CreateBoatLock`. */
  async create(input: NewHoldInput, by?: string): Promise<SeatLock> {
    assertHoldFields(input);
    const route = await this.route(input.route_id);
    await this.assertHolder(input);
    await this.assertOpen(route.id, input.service_date);
    await this.io.holdPool(route.id, input.service_date);
    const facts = await this.facts(route.id, input.service_date);
    const boat = await this.boat(input.boat_id, input.service_date, facts);
    await this.assertPickable(boat.record, route, input.service_date);
    await this.assertFree(holdBlockers(input.service_date, input.boat_id, route.id, null, facts), route.id, input.service_date);
    assertBigEnough(input.boat_deal, boatSeats(input.boat_id, facts.day, boat.deployment, boat.record), input.pax, boat.name);
    await this.place(route.id, input.service_date, input.boat_id, boat.record, boat.deployment);
    const now = this.clock().toISOString();
    const row: LockRow = {
      id: `lock_${randomUUID()}`, version: 1, route_id: route.id, service_date: input.service_date, pax: input.pax, pending_pax: 0, released_pax: 0,
      holder_type: input.holder_type, agent_id: input.agent_id, status: 'active', expiry: input.expiry, reason: input.reason,
      group_id: null, parent_id: null, sub_name: null, boat_id: input.boat_id, boat_deal: input.boat_deal, converted_booking_id: null,
      created_at: now, created_by: by ?? null, updated_at: now, released_at: null,
    };
    await this.io.putLock(row);
    await this.io.addLockEvents([this.event(by, { lock_id: row.id, group_id: null, type: 'create', qty: input.pax })]);
    return this.view(row);
  }

  private assertActive(row: LockRow): void {
    if (row.status === 'converted') conflict(`This hold became booking ${row.converted_booking_id}: cancel the booking to free the boat`, 'hold_converted');
    if (row.status !== 'active') conflict('This hold is released: make a new one', 'hold_not_active');
  }

  /** Legacy `bkV2BoatLockEdit` (and `bkV2BoatLockSwap`, the same edit with only the boat). */
  async amend(row: LockRow, changes: HoldChanges, by?: string): Promise<SeatLock> {
    this.assertActive(row);
    const holder = nextHolder(row, changes);
    const next = {
      route_id: changes.route_id ?? row.route_id, service_date: changes.service_date ?? row.service_date, boat_id: changes.boat_id ?? row.boat_id!,
      pax: changes.pax ?? row.pax, boat_deal: changes.boat_deal ?? row.boat_deal ?? 'fixed',
      expiry: changes.expiry === undefined ? row.expiry : changes.expiry, reason: changes.reason === undefined ? row.reason : changes.reason, ...holder,
    };
    assertHoldFields(next);
    const route = await this.route(next.route_id);
    if (holder.holder_type !== row.holder_type || holder.agent_id !== row.agent_id) await this.assertHolder(holder);
    const swapped = next.boat_id !== row.boat_id;
    const moved = swapped || next.service_date !== row.service_date;
    const rerouted = next.route_id !== row.route_id;
    if (moved || rerouted) await this.assertOpen(route.id, next.service_date);
    // Legacy asks before changing a promised boat: "The agent may already be selling that boat name".
    if (swapped && (row.boat_deal ?? 'fixed') === 'fixed' && !changes.change_boat_anyway) {
      conflict(`This hold names a specific boat for ${await this.holderName(row)}.\n\n${await this.boatName(row.boat_id!)} -> ${await this.boatName(next.boat_id)}\n\n`
        + 'The agent may already be selling that boat name. Tell them first, then send change_boat_anyway: true', 'fixed_boat');
    }
    for (const [r, d] of [[row.route_id, row.service_date], [next.route_id, next.service_date]].sort((a, b) => `${a[0]} ${a[1]}`.localeCompare(`${b[0]} ${b[1]}`))) await this.io.holdPool(r, d);
    const facts = await this.facts(route.id, next.service_date);
    const boat = await this.boat(next.boat_id, next.service_date, facts);
    if (moved) await this.assertPickable(boat.record, route, next.service_date);
    if (moved || rerouted) await this.assertFree(holdBlockers(next.service_date, next.boat_id, route.id, row.id, facts), route.id, next.service_date);
    assertBigEnough(next.boat_deal, boatSeats(next.boat_id, facts.day, boat.deployment, boat.record), next.pax, boat.name);
    const facts_ = (h: typeof next | LockRow, name: string): HoldFacts => ({ ...h, boat_deal: h.boat_deal ?? 'fixed', boat_name: name });
    const note = holdEditNote(facts_(row, await this.boatName(row.boat_id!)), facts_(next, boat.name));
    // Nothing changed: nothing written, as legacy (`changed: []`).
    if (!note) return this.view(row);
    if (moved || rerouted) await this.place(route.id, next.service_date, next.boat_id, boat.record, boat.deployment);
    const saved = this.stamp({ ...row, ...next });
    await this.io.putLock(saved);
    await this.io.addLockEvents([this.event(by, { lock_id: row.id, group_id: null, type: 'edit', note })]);
    return this.view(saved);
  }

  /** Legacy `bkV2BoatLockRelease`: the boat back in the pool at once. Its deployment stays, a normal boat now. */
  async release(row: LockRow, by?: string): Promise<SeatLock> {
    if (row.status === 'released') return this.view(row);
    this.assertActive(row);
    await this.io.holdPool(row.route_id, row.service_date);
    const saved = this.stamp({ ...row, status: 'released', released_at: this.clock().toISOString(), pending_pax: 0, released_pax: row.pax });
    await this.io.putLock(saved);
    await this.io.addLockEvents([this.event(by, { lock_id: row.id, group_id: null, type: 'release', trip_date: row.service_date, note: `manual · ${await this.boatName(row.boat_id!)}` })]);
    return this.view(saved);
  }

  /** The hold a conversion may take: an active whole-boat hold. */
  convertible(row: LockRow): void {
    if (!row.boat_id) bad('Only a whole-boat hold converts into a charter', 'not_a_hold');
    this.assertActive(row);
  }
  /** Legacy `bkV2BoatLockOnConvert`: the boat passes from the hold to the booking, in the booking's transaction. */
  async converted(row: LockRow, bookingId: string, by?: string): Promise<SeatLock> {
    const saved = this.stamp({ ...row, status: 'converted', converted_booking_id: bookingId, pending_pax: 0 });
    await this.io.putLock(saved);
    await this.io.addLockEvents([this.event(by, { lock_id: row.id, group_id: null, type: 'convert', booking_id: bookingId, trip_date: row.service_date, note: `เหมาลำ ${await this.boatName(row.boat_id!)}` })]);
    return this.view(saved);
  }

  /** Legacy `bkV2BoatLockPickList`: the boats of the route's pier, each with why it can't be held, if it can't. */
  async options(routeId: string, date: string, own?: LockRow): Promise<BoatOptions> {
    const route = await this.route(routeId);
    const facts = await this.facts(route.id, date);
    const name = await this.routeName(route.id);
    const boats: BoatOption[] = [];
    for (const record of await this.io.boatRecords()) {
      if (record.retired) continue;
      const isOwn = !!own && own.status === 'active' && own.boat_id === record.id && own.service_date === date;
      if (!isOwn && route.pier && record.pier && record.pier !== route.pier) continue;
      const blockers = holdBlockers(date, record.id, route.id, own?.id ?? null, facts);
      const ready = isOwn ? undefined : await this.readiness(record, date);
      const why = isOwn ? null
        : ready && ready.status !== 'available' ? { code: 'boat_not_ready', message: `Not ready on ${date}: ${ready.status}${ready.reason ? ` (${ready.reason})` : ''}` }
          : blockedWhy(blockers, route.id, date, name);
      const deployment = facts.deployments.find((d) => d.boat_id === record.id);
      boats.push({
        boat_id: record.id, name: record.name, capacity: boatSeats(record.id, facts.day, deployment, record), pier: record.pier,
        own: isOwn, ok: why === null, why, placed_route_id: deployment?.route_id ?? null, blockers,
      });
    }
    boats.sort((a, b) => Number(b.own) - Number(a.own) || Number(b.ok) - Number(a.ok) || b.capacity - a.capacity || a.boat_id.localeCompare(b.boat_id));
    return { route_id: route.id, service_date: date, boats };
  }
}
