/**
 * The change feed (todo/change-feed-model.md, approved 2026-10-09; migration 044): which records a
 * write changed, so a screen refetches only those instead of everything (legacy's whole-state reload,
 * which brought `/api/load` down on 2026-09-11). Pure, so both stores decide identically.
 */
import type { Booking } from './operations.js';

export const CHANGE_KINDS = ['booking', 'seat_lock', 'deployment', 'route', 'invoice'] as const;
export type ChangeKind = typeof CHANGE_KINDS[number];
export type RouteDay = { route_id: string; service_date: string };
export type ChangeInput = { kind: ChangeKind; entity_id: string; action: 'created' | 'updated' | 'deleted'; route_days: RouteDay[] | null; changed_by: string | null };
export type Change = ChangeInput & { version: number; changed_at: string };

const dayKey = (d: RouteDay) => `${d.route_id}|${d.service_date}`;
/** Route-days, each once, in a stable order. */
export const uniqueDays = (days: readonly RouteDay[]): RouteDay[] =>
  [...new Map(days.map((d) => [dayKey(d), { route_id: d.route_id, service_date: d.service_date }])).values()].sort((a, b) => (dayKey(a) < dayKey(b) ? -1 : 1));

/** A booking's days before and after a write: a moved trip frees one day and fills another. */
export const bookingDays = (...bookings: (Booking | undefined)[]): RouteDay[] =>
  uniqueDays(bookings.flatMap((b) => (b ? b.trips.map((t) => ({ route_id: t.route_id, service_date: t.service_date })) : [])));

/** One row per record a transaction changed: created beats updated, and the days add up. */
export function mergeChanges(inputs: readonly ChangeInput[]): ChangeInput[] {
  const out = new Map<string, ChangeInput>();
  for (const c of inputs) {
    const key = `${c.kind}|${c.entity_id}`;
    const was = out.get(key);
    if (!was) { out.set(key, { ...c, route_days: c.route_days && uniqueDays(c.route_days) }); continue; }
    const action = was.action === 'created' && c.action !== 'deleted' ? 'created' : c.action === 'deleted' ? 'deleted' : was.action === 'deleted' ? 'deleted' : c.action;
    const days = was.route_days || c.route_days ? uniqueDays([...(was.route_days ?? []), ...(c.route_days ?? [])]) : null;
    out.set(key, { ...was, action, route_days: days });
  }
  return [...out.values()];
}

export function parseSince(query: Record<string, unknown>): { since: number | undefined; limit: number } {
  const since = query.since === undefined || query.since === '' ? undefined : Number(query.since);
  if (since !== undefined && (!Number.isInteger(since) || since < 0)) throw Object.assign(new Error('since must be a whole number, 0 or more'), { statusCode: 400 });
  const limit = query.limit === undefined ? 500 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw Object.assign(new Error('limit must be a whole number from 1 to 1000'), { statusCode: 400 });
  return { since, limit };
}
