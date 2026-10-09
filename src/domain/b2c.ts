/**
 * Love Kingdom's push (todo/b2c-sync-model.md, decided 2026-10-09; migration 100). Pure, so both
 * stores and the routes decide identically.
 *
 * - **Held orders:** a write from Love Kingdom's login that is refused as bad input (`400`) is kept
 *   raw for ops instead of being lost, the way legacy's pull stored whatever it read and listed it.
 * - **Booking issues:** what is wrong in a B2C booking that *was* stored, ported from legacy's
 *   post-import checks (`b2c-map.js` `b2cCheckOrders`). Computed, never stored: a booking ops correct
 *   drops off the list by itself.
 */
import { createHash } from 'node:crypto';
import { refuse } from './booking-actions.js';
import { holdsSeats } from './booking-status.js';
import type { PaxGrid } from './pax.js';

/** Love Kingdom's agent: its service login books for it only (README "What each login may do"). */
export const B2C_AGENT = 'a_b2c';
/** The push login: a login tied to Love Kingdom's agent. Staff keying an `a_b2c` booking are not it. */
export const isB2CPush = (user: { agent_id: string | null } | undefined): boolean => user?.agent_id === B2C_AGENT;

// ── Held orders ──

export const HELD_ACTIONS = ['create', 'amend', 'cancel'] as const;
export type HeldAction = typeof HELD_ACTIONS[number];
export const HELD_STATUSES = ['open', 'resolved', 'dismissed'] as const;
export type HeldStatus = typeof HELD_STATUSES[number];

export type HeldOrder = {
  id: string;
  action: HeldAction;
  /** Love Kingdom's order id: the body's `external_id` on a create, the booking's on an amend or cancel. */
  external_id: string | null;
  /** The booking an amend or cancel was for. */
  booking_id: string | null;
  /** The body exactly as sent. */
  request: unknown;
  /** Why it could not be stored: the refusal's message. */
  problem: string;
  attempts: number;
  status: HeldStatus;
  received_at: string;
  last_received_at: string;
  received_by: string | null;
  decided_at: string | null;
  decided_by: string | null;
  note: string | null;
  /** The booking that settled it, when ops name one or Love Kingdom's resend created it. */
  resolved_booking_id: string | null;
};

/** What a refused write leaves to hold. */
export type HeldInput = Pick<HeldOrder, 'action' | 'external_id' | 'booking_id' | 'request' | 'problem' | 'received_by'>;

/**
 * The row to write for a refused write. A create retried while its order is still held (same
 * `external_id`, still open) is the same order: it replaces the request and problem and counts the
 * attempt, rather than listing the order twice.
 */
export function holdOrder(input: HeldInput, existing: HeldOrder | undefined, id: string, now: string): HeldOrder {
  if (existing) return { ...existing, request: input.request, problem: input.problem, received_by: input.received_by, attempts: existing.attempts + 1, last_received_at: now };
  return {
    id, ...input, attempts: 1, status: 'open', received_at: now, last_received_at: now,
    decided_at: null, decided_by: null, note: null, resolved_booking_id: null,
  };
}

/** `true` when a refused write's hold should merge into this one. */
export const sameHeldCreate = (held: HeldOrder, input: HeldInput): boolean =>
  input.action === 'create' && input.external_id !== null && held.action === 'create' && held.status === 'open' && held.external_id === input.external_id;

export type HeldDecision = { status: 'resolved' | 'dismissed'; note: string | null; resolved_booking_id: string | null };

/** `POST /v1/b2c/held-orders/{id}/resolve` and `/dismiss`. Only `resolve` names a booking. */
export function parseHeldDecision(command: 'resolve' | 'dismiss', body: unknown): HeldDecision {
  const input = body === undefined || body === null ? {} : typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : refuse('Request body must be an object', 400);
  const text = (value: unknown, name: string): string | null => {
    if (value === undefined || value === null || value === '') return null;
    return typeof value === 'string' ? value.trim() || null : refuse(`${name} must be a string`, 400);
  };
  const bookingId = text(input.booking_id ?? input.bookingId, 'booking_id');
  if (command === 'dismiss' && bookingId !== null) refuse('booking_id goes with resolve: a dismissed order was not booked', 400);
  return { status: command === 'resolve' ? 'resolved' : 'dismissed', note: text(input.note, 'note'), resolved_booking_id: bookingId };
}

/** Closes an open held order. A second decision is `409`: the order is already settled. */
export function decideHeld(held: HeldOrder, decision: HeldDecision, by: string | null, now: string): HeldOrder {
  if (held.status !== 'open') refuse(`Held order ${held.id} is already ${held.status}`, 409, 'wrong_status');
  return { ...held, status: decision.status, note: decision.note, resolved_booking_id: decision.resolved_booking_id, decided_by: by, decided_at: now };
}

/** `?status=` on the held-order list: `open` by default, `all` for every one. */
export function parseHeldStatus(value: unknown): HeldStatus | undefined {
  if (value === undefined || value === '') return 'open';
  if (value === 'all') return undefined;
  return (HELD_STATUSES as readonly unknown[]).includes(value) ? value as HeldStatus : refuse(`status must be one of ${HELD_STATUSES.join(', ')} or all`, 400);
}

/** Newest first, then by id, so both stores list them in one order. */
export const sortHeld = (orders: readonly HeldOrder[]): HeldOrder[] =>
  [...orders].sort((a, b) => b.last_received_at.localeCompare(a.last_received_at) || a.id.localeCompare(b.id));

/** The `202` a held write answers. */
export const heldResponse = (held: HeldOrder) => ({
  code: 'held_for_review', message: `Not booked: ${held.problem}. Held for ops to review as ${held.id}`, held_order: held,
});

// ── Booking issues (legacy `b2cCheckOrders`) ──

export type IssueSeverity = 'warn' | 'info';
export type BookingIssue = { code: 'nat_unread' | 'nat_mix' | 'money_parts' | 'pickup_area'; severity: IssueSeverity; message: string };

/** What the checks read: a stored booking as the API shows it. */
export type CheckedBooking = {
  status: string;
  lead_nationality?: string | null;
  passengers: readonly { nationality?: string | null }[];
  trips: readonly { service_date: string; booking_mode: string; pax: PaxGrid }[];
  total?: number | null;
  price_seat?: number | null; price_addon?: number | null; price_foc_discount?: number | null; price_discount?: number | null; price_extra?: number | null;
  pickup_area_id?: string | null; pickup_self?: boolean | null; pickup_area?: string | null; hotel_name?: string | null;
};

const THAI = 'TH';
/** Legacy writes nationalities as two-letter codes (`TH`, `GB`: 98% of its B2C rows, 2026-10-09). */
const isCode = (value: string): boolean => /^[A-Za-z]{2}$/.test(value);
const filled = (value: string | null | undefined): string => (typeof value === 'string' ? value.trim() : '');
const PRICE_PARTS = ['price_seat', 'price_addon', 'price_foc_discount', 'price_discount', 'price_extra'] as const;

/**
 * The problems in one B2C booking, as legacy's issues panel lists them. A booking that gave its
 * seats back (cancelled, rejected) needs nothing from anyone, so it has none (legacy `B2C_DEAD`).
 */
export function bookingIssues(b: CheckedBooking): BookingIssue[] {
  if (!holdsSeats(b.status)) return [];
  const issues: BookingIssue[] = [];
  const lead = filled(b.lead_nationality);
  if (lead && !isCode(lead)) issues.push({ code: 'nat_unread', severity: 'warn', message: `อ่านสัญชาติผู้จองไม่ออก: "${lead}"` });
  const unread = [...new Set(b.passengers.map((p) => filled(p.nationality)).filter((n) => n && !isCode(n)))];
  if (unread.length) issues.push({ code: 'nat_unread', severity: 'warn', message: `อ่านสัญชาติผู้โดยสารไม่ออก: ${unread.map((n) => `"${n}"`).join(', ')}` });

  // Park fee: Thai-priced seats while more known foreigners are on board than the other seats can
  // hold, so the park page buys a Thai ticket for a foreigner. With no passenger list, the lead.
  const nationalities = b.passengers.length ? b.passengers.map((p) => filled(p.nationality)) : [lead];
  const foreigners = nationalities.filter((n) => n && isCode(n) && n.toUpperCase() !== THAI).length;
  for (const trip of b.trips) {
    if (trip.booking_mode === 'charter') continue;
    const heads = Object.values(trip.pax).reduce((sum, n) => sum + n, 0);
    const thai = Object.entries(trip.pax).filter(([key]) => key.endsWith('_th')).reduce((sum, [, n]) => sum + n, 0);
    if (thai > 0 && foreigners > heads - thai) {
      issues.push({ code: 'nat_mix', severity: 'warn', message: `ขายราคาคนไทย ${thai} ที่ แต่ในใบมีต่างชาติ ${foreigners} คน (${trip.service_date}) · หน้าค่าอุทยานจะนับเป็นคนไทยหมด · กรอกสัญชาติจริงในใบ` });
      break;
    }
  }

  // Money: the parts sent must add up to the total ops bill from.
  if (PRICE_PARTS.some((part) => b[part] !== undefined && b[part] !== null)) {
    const sum = PRICE_PARTS.reduce((total, part) => total + Number(b[part] ?? 0), 0);
    const total = Number(b.total ?? 0);
    if (Math.abs(sum - total) > 1) issues.push({ code: 'money_parts', severity: 'warn', message: `ยอดแยกรวมไม่เท่ายอดบรรทัด (${sum} ≠ ${total})` });
  }

  const place = filled(b.pickup_area) || filled(b.hotel_name);
  if (b.pickup_self !== true && !filled(b.pickup_area_id) && place) {
    issues.push({ code: 'pickup_area', severity: 'info', message: `จับคู่จุดรับไม่ได้: "${place}" · ต้องเลือกพื้นที่รับเอง` });
  }
  return issues;
}

/** One line of the issues panel: the issue and the booking it is on. */
export type PanelIssue = BookingIssue & { booking_id: string; external_id: string | null; service_date: string; lead_pax: string | null };

/**
 * Legacy's `issueSig`: a short hash of what needs a look, so a client can keep the panel dismissed
 * until the set changes (legacy keeps that in `localStorage`). Info lines do not change it.
 */
export function issuesSignature(held: readonly { id: string }[], issues: readonly PanelIssue[]): string {
  const keys = [...held.map((h) => `held:${h.id}`), ...issues.filter((i) => i.severity === 'warn').map((i) => `${i.booking_id}:${i.code}`)].sort();
  return createHash('sha1').update(keys.join('|')).digest('hex').slice(0, 12);
}

/** `?updated_since=` on the booking list: an instant, normalised to ISO so both stores compare the same text. */
export function parseUpdatedSince(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
  const time = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? Date.parse(value) : NaN;
  return Number.isNaN(time) ? refuse('updated_since must be an ISO instant, e.g. 2026-10-09T03:00:00Z', 400) : new Date(time).toISOString();
}
