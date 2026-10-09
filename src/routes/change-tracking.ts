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
import type { Store } from './operations.js';

type Context = { request: FastifyRequest; depth: number };
export const changeContext = new AsyncLocalStorage<Context>();

type Snapshot = {
  bookings: Map<string, Booking | undefined>;
  /** The van parts of every booking on a van group's route and day, to see which a group write changed. */
  vanDay?: { date: string; routeId: string; parts: Map<string, string> };
  deployment?: { route_id: string } | undefined;
};

const params = (r: FastifyRequest) => (r.params ?? {}) as Record<string, string>;
const body = (r: FastifyRequest) => (r.body && typeof r.body === 'object' ? r.body : {}) as Record<string, unknown>;
const url = (r: FastifyRequest) => r.routeOptions?.url ?? '';
const partsOf = (b: Booking) => JSON.stringify(b.trips.map((t) => t.operations.van_parts));

async function bookingIdsBefore(store: Store, r: FastifyRequest): Promise<string[]> {
  const path = url(r);
  if (path.startsWith('/v1/bookings/:id')) return [params(r).id];
  if (path === '/v1/reconfirm/sent') return Array.isArray(body(r).booking_ids) ? (body(r).booking_ids as unknown[]).map(String) : [];
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

async function snapshot(store: Store, r: FastifyRequest): Promise<Snapshot> {
  const bookings = new Map<string, Booking | undefined>();
  for (const id of await bookingIdsBefore(store, r)) bookings.set(id, await store.booking(id));
  const day = await vanDayOf(store, r);
  const vanDay = day && { ...day, parts: new Map((await store.bookingsOn(day.date, day.routeId)).map((b) => [b.id, partsOf(b)])) };
  let deployment: Snapshot['deployment'];
  if (url(r).startsWith('/operations/deployments')) {
    const date = String(params(r).service_date ?? body(r).service_date ?? ''), boat = String(params(r).boat_id ?? body(r).boat_id ?? '');
    deployment = (await store.listDeployments(date, date)).find((d) => d.boat_id === boat);
  }
  return { bookings, vanDay, deployment };
}

async function describe(store: Store, r: FastifyRequest, before: Snapshot, result: unknown): Promise<ChangeInput[]> {
  const path = url(r), by = actorOf(r.user as Parameters<typeof actorOf>[0]) ?? null;
  const out: ChangeInput[] = [];
  const booking = async (id: string, created = false) => {
    const after = await store.booking(id);
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
  if (path.startsWith('/v1/seat-locks')) {
    const id = params(r).id ?? (result as { id?: string } | undefined)?.id;
    const lock = id ? await store.lock(id) : undefined;
    if (lock) out.push({ kind: 'seat_lock', entity_id: lock.id, action: params(r).id ? 'updated' : 'created', route_days: [{ route_id: lock.route_id, service_date: lock.service_date }], changed_by: by });
  }
  if (path.startsWith('/operations/deployments')) {
    const date = String(params(r).service_date ?? body(r).service_date ?? ''), boat = String(params(r).boat_id ?? body(r).boat_id ?? '');
    const after = (await store.listDeployments(date, date)).find((d) => d.boat_id === boat);
    const routes = [before.deployment?.route_id, after?.route_id].filter((x): x is string => !!x);
    out.push({ kind: 'deployment', entity_id: `${date}:${boat}`, action: !after ? 'deleted' : before.deployment ? 'updated' : 'created',
      route_days: routes.map((route_id) => ({ route_id, service_date: date })), changed_by: by });
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
