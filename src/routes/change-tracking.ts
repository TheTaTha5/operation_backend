/**
 * Records what each write changed (todo/change-feed-model.md, migration 044), in the write's own
 * transaction. The store reaches the routes wrapped: its `transaction` notes, at the start, the state
 * of what the request is about to change, and before commit compares it with what is there now. The
 * request says what it is about to change by its route: a booking's, a seat lock's, a deployment's or a
 * route calendar's path. A new endpoint under one of those paths is recorded without being told.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyRequest } from 'fastify';
import { actorOf } from '../domain/booking-actions.js';
import { bookingDays, mergeChanges, type ChangeInput } from '../domain/changes.js';
import type { Booking } from '../domain/operations.js';
import { bookingHoldsSeats } from '../domain/booking-approvals.js';
import { SeatLockService, lockIdsIn } from '../domain/seat-lock-service.js';
import { drawChanges, eventAt, type NewLockEvent } from '../domain/seat-locks.js';
import type { Store } from './operations.js';

type Context = { request: FastifyRequest; depth: number };
export const changeContext = new AsyncLocalStorage<Context>();

type Snapshot = {
  bookings: Map<string, Booking | undefined>;
  /** The bookings' invoices and their payments, to see which a write created or changed. */
  invoices: Map<string, string>;
  /** The van parts of every booking on a van group's route and day, to see which a group write changed. */
  vanDay?: { date: string; routeId: string; parts: Map<string, string> };
  deployment?: { route_id: string } | undefined;
};

const params = (r: FastifyRequest) => (r.params ?? {}) as Record<string, string>;
const body = (r: FastifyRequest) => (r.body && typeof r.body === 'object' ? r.body : {}) as Record<string, unknown>;
const url = (r: FastifyRequest) => r.routeOptions?.url ?? '';
const partsOf = (b: Booking) => JSON.stringify(b.trips.map((t) => t.operations.van_parts));
/** Seats a booking draws from each lock, counted only while it holds seats (a cancel gives them all back). */
const drawsOf = (b: Booking | undefined): { draws: Map<string, number> } | undefined => {
  if (!b) return undefined;
  const draws = new Map<string, number>();
  if (bookingHoldsSeats(b)) for (const t of b.trips) for (const [id, qty] of Object.entries(t.lock_draws)) draws.set(id, (draws.get(id) ?? 0) + qty);
  return { draws };
};

/**
 * The lock log's `draw` and `return` lines for the bookings a write touched (legacy `bkV2DrawLock`,
 * `bkV2ReturnLock`, `resched-return`): what each lock gained or lost, from the booking before and
 * after. Written here because this is where both are known, whichever command changed the draws.
 */
async function drawEvents(store: Store, r: FastifyRequest, pairs: readonly { id: string; before?: Booking; after?: Booking }[], by: string | null): Promise<{ events: NewLockEvent[]; lockIds: string[] }> {
  const changes = pairs.flatMap((p) => drawChanges(drawsOf(p.before), drawsOf(p.after)).map((c) => ({ ...c, booking_id: p.id })));
  if (!changes.length) return { events: [], lockIds: [] };
  const rows = new Map((await store.lockRows({ ids: [...new Set(changes.map((c) => c.lock_id))] })).map((l) => [l.id, l]));
  const now = new Date();
  const why = url(r).split('/').pop() ?? '';
  const events = changes.filter((c) => rows.has(c.lock_id)).map((c) => {
    const lock = rows.get(c.lock_id)!;
    const type = c.delta > 0 ? 'draw' : why === 'reschedule' ? 'resched-return' : 'return';
    return eventAt(now, by, { lock_id: lock.id, group_id: lock.group_id, type, qty: Math.abs(c.delta), trip_date: lock.service_date, booking_id: c.booking_id,
      note: c.delta > 0 ? null : why === ':id' ? 'edit' : why });
  });
  return { events, lockIds: [...rows.keys()] };
}

async function bookingIdsBefore(store: Store, r: FastifyRequest): Promise<string[]> {
  const path = url(r);
  if (path.startsWith('/v1/bookings/:id')) return [params(r).id];
  if (path === '/v1/reconfirm/sent') return Array.isArray(body(r).booking_ids) ? (body(r).booking_ids as unknown[]).map(String) : [];
  if (path === '/v1/invoices' && r.method === 'POST') {
    const ids = body(r).booking_ids ?? body(r).bookingIds;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  }
  if (path.startsWith('/v1/invoices/:id')) {
    const invoice = await store.invoice(params(r).id);
    return invoice ? [...new Set(invoice.lines.map((l) => l.booking_id).filter((id): id is string => !!id))] : [];
  }
  if (path.startsWith('/operations/trip-ops/:trip_id')) {
    const found = await store.tripForDispatch(params(r).trip_id);
    return found ? [found.booking.id] : [];
  }
  return [];
}

async function vanDayOf(store: Store, r: FastifyRequest): Promise<{ date: string; routeId: string } | undefined> {
  if (!url(r).startsWith('/operations/van-groups')) return undefined;
  if (params(r).id) {
    const group = await store.vanGroup(params(r).id);
    return group && { date: group.service_date, routeId: group.route_id };
  }
  const b = body(r);
  const date = b.service_date ?? b.date;
  return typeof date === 'string' && typeof b.route_id === 'string' ? { date, routeId: b.route_id } : undefined;
}

/** Each invoice of these bookings, as one comparable string: the invoice and its payments. */
async function invoicePrints(store: Store, bookingIds: readonly string[]): Promise<Map<string, string>> {
  if (!bookingIds.length) return new Map();
  const invoices = await store.invoicesOfBookings(bookingIds);
  const payments = await store.paymentsOf(invoices.map((i) => i.id));
  return new Map(invoices.map((i) => [i.id, JSON.stringify([i, payments.filter((p) => p.invoice_id === i.id)])]));
}

async function snapshot(store: Store, r: FastifyRequest): Promise<Snapshot> {
  const bookings = new Map<string, Booking | undefined>();
  for (const id of await bookingIdsBefore(store, r)) bookings.set(id, await store.booking(id));
  const invoices = await invoicePrints(store, [...bookings.keys()]);
  const day = await vanDayOf(store, r);
  const vanDay = day && { ...day, parts: new Map((await store.bookingsOn(day.date, day.routeId)).map((b) => [b.id, partsOf(b)])) };
  let deployment: Snapshot['deployment'];
  if (url(r).startsWith('/operations/deployments')) {
    const date = String(params(r).service_date ?? body(r).service_date ?? ''), boat = String(params(r).boat_id ?? body(r).boat_id ?? '');
    deployment = (await store.listDeployments(date, date)).find((d) => d.boat_id === boat);
  }
  return { bookings, invoices, vanDay, deployment };
}

async function describe(store: Store, r: FastifyRequest, before: Snapshot, result: unknown): Promise<ChangeInput[]> {
  const path = url(r), by = actorOf(r.user as Parameters<typeof actorOf>[0]) ?? null;
  const out: ChangeInput[] = [];
  const pairs: { id: string; before?: Booking; after?: Booking }[] = [];
  const booking = async (id: string, created = false) => {
    const after = await store.booking(id);
    pairs.push({ id, before: before.bookings.get(id), after });
    if (after || before.bookings.get(id)) out.push({ kind: 'booking', entity_id: id, action: created ? 'created' : 'updated', route_days: bookingDays(before.bookings.get(id), after), changed_by: by });
  };
  if (path === '/v1/bookings' && r.method === 'POST') {
    const id = (result as { id?: string } | undefined)?.id;
    if (id) await booking(id, true);
  }
  for (const id of before.bookings.keys()) await booking(id);
  if (before.vanDay) {
    const { date, routeId, parts } = before.vanDay;
    for (const b of await store.bookingsOn(date, routeId)) {
      if (parts.get(b.id) !== partsOf(b)) out.push({ kind: 'booking', entity_id: b.id, action: 'updated', route_days: [{ route_id: routeId, service_date: date }], changed_by: by });
    }
  }
  // A booking's draws changed: the lock log gets its lines, and the locks count as changed.
  const draws = await drawEvents(store, r, pairs, by);
  if (draws.events.length) await store.addLockEvents(draws.events);
  // A lock write: the lock in the path and every lock the result names. A new lock is at version 1.
  const lockPath = path.startsWith('/v1/seat-locks') || path.startsWith('/v1/seat-lock-groups');
  const lockIds = new Set([...(path.startsWith('/v1/seat-locks/:id') ? [params(r).id] : []), ...(lockPath ? lockIdsIn(result) : []), ...draws.lockIds]);
  if (lockIds.size) {
    const creating = r.method === 'POST' && (path === '/v1/seat-locks' || path === '/v1/seat-lock-groups' || path.endsWith('/sub-groups'));
    for (const lock of await new SeatLockService(store).views(await store.lockRows({ ids: [...lockIds] }))) {
      out.push({ kind: 'seat_lock', entity_id: lock.id, action: creating && lock.version === 1 ? 'created' : 'updated', route_days: [{ route_id: lock.route_id, service_date: lock.service_date }], changed_by: by });
    }
  }
  if (path.startsWith('/operations/deployments')) {
    const date = String(params(r).service_date ?? body(r).service_date ?? ''), boat = String(params(r).boat_id ?? body(r).boat_id ?? '');
    const after = (await store.listDeployments(date, date)).find((d) => d.boat_id === boat);
    const routes = [before.deployment?.route_id, after?.route_id].filter((x): x is string => !!x);
    out.push({ kind: 'deployment', entity_id: `${date}:${boat}`, action: !after ? 'deleted' : before.deployment ? 'updated' : 'created',
      route_days: routes.map((route_id) => ({ route_id, service_date: date })), changed_by: by });
  }
  // An invoice a write issued or changed: by its own endpoints, or by a booking's cancel or restore.
  for (const [id, print] of await invoicePrints(store, [...before.bookings.keys()])) {
    const was = before.invoices.get(id);
    if (was !== print) out.push({ kind: 'invoice', entity_id: id, action: was === undefined ? 'created' : 'updated', route_days: null, changed_by: by });
  }
  if (path.startsWith('/v1/routes/:id/')) out.push({ kind: 'route', entity_id: params(r).id, action: 'updated', route_days: null, changed_by: by });
  return mergeChanges(out);
}

/** The store, its `transaction` recording what a write changed. A nested transaction records nothing extra. */
export function trackChanges(store: Store): Store {
  const transaction = async <T>(work: () => T | Promise<T>): Promise<T> => {
    const ctx = changeContext.getStore();
    if (!ctx || ctx.depth > 0 || ctx.request.method === 'GET') return store.transaction(work);
    return store.transaction(async () => {
      ctx.depth += 1;
      try {
        const before = await snapshot(store, ctx.request);
        const result = await work();
        const rows = await describe(store, ctx.request, before, result);
        if (rows.length) await store.recordChanges(rows);
        return result;
      } finally { ctx.depth -= 1; }
    });
  };
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === 'transaction') return transaction;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
