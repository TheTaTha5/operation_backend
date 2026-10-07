/**
 * What the booking actions — cancel, restore, partial cancel, reschedule — record beyond the seat
 * change: who made it, why, and what it cost. Legacy stamps all of this on the booking document
 * (`bkV2CancelBooking`, `bkV2RestoreBooking`, `bkV2PartialCancel`, `bkV2RescheduleBooking` in
 * `allotment_v2/js/booking.js`), and staff and reports read it.
 *
 * Everything here is pure. The two stores differ only in where they put the results; the categories,
 * the labels, the charge arithmetic and the history wording are written once, so they cannot drift.
 * How the trips change for each action is `operations.ts`'s, next to `nextTrips`.
 */
import { holdsSeats, type BookingStatus } from './booking-status.js';
import { formatPaxGrid, parsePaxGrid, paxTotal, type PaxGrid, type PaxRow } from './pax.js';
import type { BookingChanges } from './operations.js';
import type { BookingHeader, BookingHeaderPatch } from './booking-header.js';
import {
  decideStatus, discountOf, focCountOf, pendingApproval, type ApprovalKind, type BookingApproval, type NewApproval,
} from './booking-approvals.js';

/** A refusal in the existing `{ statusCode, error, message }` shape. Fastify adds `code` when one is set. */
export const refuse = (message: string, statusCode: number, code?: string): never => {
  const error = new Error(message) as Error & { statusCode: number; code?: string };
  error.statusCode = statusCode;
  if (code) error.code = code;
  throw error;
};
const badRequest = (message: string): never => refuse(message, 400);

// ── Who ──────────────────────────────────────────────────────────────────────────────────────────

/** The token's user as legacy's `laBy()` names them: the username, else the subject. */
export const actorOf = (user: { username?: string; subject: string } | undefined): string | undefined => user?.username ?? user?.subject;

/**
 * An amendment's header with the authenticated user stamped on it. `updated_by` always comes from
 * the token, never from the body: a client could otherwise sign a change with someone else's name.
 * A create is stamped by `createHeader`, which also sets who created the booking and when.
 *
 * With authentication off (local development) there is no user, and `updated_by` is left alone.
 */
export function stampActor<T extends BookingHeaderPatch>(header: T | undefined, actor: string | undefined): T {
  const stamped = { ...(header ?? {}) } as T;
  delete stamped.updated_by;
  if (actor === undefined) return stamped;
  stamped.updated_by = actor;
  return stamped;
}

// ── History ──────────────────────────────────────────────────────────────────────────────────────

/** One line of a booking's history, as `GET /v1/bookings/:id/history` returns it. */
export type HistoryEntry = { at: string; by: string | null; kind: string; tag: string | null; text: string };
/** A line about to be written; the store supplies `at`. */
export type HistoryLine = Omit<HistoryEntry, 'at'>;

const line = (by: string | undefined, kind: string, tag: string, text: string): HistoryLine => ({ by: by ?? null, kind, tag, text });

export const createdLine = (by: string | undefined): HistoryLine => line(by, 'create', 'Created', 'Created');

/**
 * `Edited · trips, total`. The keys are the ones the amendment carried, in the order the caller can
 * recognise: itinerary, status, header columns, then the lists. A status moving to `confirmed` is
 * tagged `Confirmed` so the timeline shows the confirmation, as legacy does.
 */
export function editedLine(by: string | undefined, changes: BookingChanges, from: BookingStatus): HistoryLine {
  const keys: string[] = [];
  if (changes.trips) keys.push('trips');
  for (const key of ['route_id', 'service_date', 'pax', 'status'] as const) if (changes[key] !== undefined) keys.push(key);
  for (const key of Object.keys(changes.header ?? {})) if (key !== 'updated_by') keys.push(key);
  if (changes.passengers) keys.push('passengers');
  if (changes.add_ons) keys.push('add_ons');
  const confirmed = changes.status === 'confirmed' && from !== 'confirmed';
  return line(by, 'edit', confirmed ? 'Confirmed' : 'Edited', keys.length ? `Edited · ${keys.join(', ')}` : 'Edited');
}

// ── Cancellation categories ──────────────────────────────────────────────────────────────────────

export type CancelGroup = 'customer' | 'operator' | 'other';

/**
 * Legacy's `BKV2_CANCEL_REASONS` (`08-app.js:8763`). The code is stable and reported on; `group` is
 * whose fault it was, derived here and never sent. `weather` is not on the list: a weather cancel is
 * its own flow (`cancelled_weather`).
 */
export const CANCEL_CATEGORIES = [
  { code: 'customer_cancel', en: 'Customer cancelled / changed plan', th: 'ลูกค้ายกเลิกเอง / เปลี่ยนแผน', group: 'customer' },
  { code: 'no_show', en: 'No-show', th: 'ไม่มาตามนัด', group: 'customer' },
  { code: 'sick', en: 'Sick / health', th: 'ป่วย / เหตุสุขภาพ', group: 'customer' },
  { code: 'flight_visa', en: 'Flight / visa / documents', th: 'ไฟลท์ / วีซ่า / เอกสาร', group: 'customer' },
  { code: 'agent_error', en: 'Agent error / double booking', th: 'เอเย่นต์จองผิด / จองซ้ำ', group: 'customer' },
  { code: 'operator', en: 'Operator (boat down / trip off)', th: 'ฝั่งเรา (เรือเสีย / ทริปไม่ออก)', group: 'operator' },
  { code: 'force_majeure', en: 'Force majeure', th: 'เหตุสุดวิสัย (ภัยพิบัติ/โรคระบาด)', group: 'operator' },
  { code: 'other', en: 'Other', th: 'อื่นๆ (ระบุใน note)', group: 'other' },
] as const satisfies readonly { code: string; en: string; th: string; group: CancelGroup }[];
export type CancelCategory = (typeof CANCEL_CATEGORIES)[number]['code'];

const CATEGORY = new Map<string, (typeof CANCEL_CATEGORIES)[number]>(CANCEL_CATEGORIES.map((c) => [c.code, c]));
export const isCancelCategory = (value: unknown): value is CancelCategory => typeof value === 'string' && CATEGORY.has(value);
export const cancelGroup = (code: CancelCategory): CancelGroup => CATEGORY.get(code)!.group;
/** `Sick / health (ป่วย / เหตุสุขภาพ)` — legacy's `bkV2CancelLabel`. */
export const cancelLabel = (code: CancelCategory): string => { const c = CATEGORY.get(code)!; return `${c.en} (${c.th})`; };

/**
 * A reason category and its note, as sent. The note is required for `other`, where the category
 * alone says nothing (`booking.js:13592`).
 */
function categoryAndNote(input: Record<string, unknown>): { category: CancelCategory; note?: string } {
  const category = input.category;
  if (!isCancelCategory(category)) badRequest(`category must be one of ${CANCEL_CATEGORIES.map((c) => c.code).join(', ')}`);
  const note = optionalText(input.note, 'note');
  if (category === 'other' && note === undefined) badRequest('note is required when category is other');
  return { category: category as CancelCategory, ...(note === undefined ? {} : { note }) };
}

// ── Money ────────────────────────────────────────────────────────────────────────────────────────

export type ChargeType = 'none' | 'full' | 'partial';
const CHARGE_TYPES: readonly ChargeType[] = ['none', 'full', 'partial'];

/** `฿4,000` the way legacy prints it: whole baht, thousands separated. */
export const baht = (amount: number): string => `฿${Math.round(amount).toLocaleString('en-US')}`;

/** `No charge`, `Full charge ฿4,000` or `Charge ฿500` (`booking.js:12321`). */
export const chargeLabel = (type: ChargeType, amount: number): string =>
  type === 'full' ? `Full charge ${baht(amount)}` : type === 'partial' ? `Charge ${baht(amount)}` : 'No charge';

/** A fee charged on top of the booking's own price. */
export type BookingFeeItem = { type: string; label: string | null; amount: number; at: string };

/**
 * What the agent owes: the booking's price plus its fee items. Legacy's `acctBookingTotal`
 * (`accounting.js:18`). `total` already includes add-ons, so they are not added again.
 */
export const amountOwed = (booking: { total?: number; fee_items: readonly { amount: number }[] }): number =>
  (booking.total ?? 0) + booking.fee_items.reduce((sum, item) => sum + item.amount, 0);

/** A charge request resolved to a number: `full` is everything owed, `none` is 0. */
export const chargeAmount = (charge: { charge_type: ChargeType; charge_amount?: number }, owed: number): number =>
  charge.charge_type === 'full' ? owed : charge.charge_type === 'partial' ? charge.charge_amount! : 0;

function charge(input: Record<string, unknown>): { charge_type: ChargeType; charge_amount?: number } {
  const type = input.charge_type ?? 'none';
  if (!CHARGE_TYPES.includes(type as ChargeType)) badRequest('charge_type must be one of none, full, partial');
  if (type !== 'partial') return { charge_type: type as ChargeType };
  const amount = input.charge_amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) badRequest('charge_amount must be greater than 0 for a partial charge');
  return { charge_type: 'partial', charge_amount: amount as number };
}

// ── Status rules ─────────────────────────────────────────────────────────────────────────────────

/**
 * A booking that has given its seats back, or has already sailed, is not cancelled, reduced or
 * rescheduled again (legacy `bkV2DetailCancel`, `bkV2DetailPartial`, `bkV2DetailReschedule`).
 */
export function assertOpen(status: BookingStatus, action: 'cancel' | 'partial cancel' | 'reschedule'): void {
  if (status === 'cancelled' || status === 'cancelled_weather') refuse(`Booking is already ${status === 'cancelled' ? 'cancelled' : 'cancelled for weather'}`, 409, 'already_cancelled');
  if (!holdsSeats(status) || status === 'completed') refuse(`Cannot ${action} a ${status} booking`, 409, 'booking_closed');
}

/** Only a booking that gave its seats back can be restored (`booking.js:12363`). */
export function assertRestorable(status: BookingStatus): void {
  if (holdsSeats(status)) refuse('Booking is not cancelled', 409, 'not_cancelled');
}

// ── Cancel ───────────────────────────────────────────────────────────────────────────────────────

export type BookingCancellation = {
  category: string; group: CancelGroup; note: string | null;
  charge_type: ChargeType; charge_amount: number; at: string; by: string | null;
};

/**
 * `{ reason }` — or no body — is what the route took before categories existed: it still sets the
 * free text and writes no cancellation record. Anything with a `category` is the full form.
 */
export type CancelRequest =
  | { kind: 'reason'; reason?: string }
  | { kind: 'record'; category: CancelCategory; note?: string; charge_type: ChargeType; charge_amount?: number };

export function parseCancelRequest(body: Record<string, unknown>): CancelRequest {
  if (body.category === undefined) return { kind: 'reason', reason: optionalText(body.reason, 'reason') };
  return { kind: 'record', ...categoryAndNote(body), ...charge(body) };
}

/** What a cancel writes: the status, the display text in `cancellation_reason`, the record and the history line. */
export type CancelPlan = { cancellation_reason: string | null; record?: Omit<BookingCancellation, 'at'>; history: HistoryLine };

export function planCancel(booking: { status: BookingStatus; total?: number; fee_items: readonly { amount: number }[] }, request: CancelRequest, by: string | undefined): CancelPlan {
  assertOpen(booking.status, 'cancel');
  if (request.kind === 'reason') {
    return { cancellation_reason: request.reason ?? null, history: line(by, 'cancel', 'Cancel', request.reason ? `Cancelled · ${request.reason}` : 'Cancelled') };
  }
  // The same display text legacy writes into its `cancelReason`, so every reader of the column keeps working.
  const reason = cancelLabel(request.category) + (request.note ? ` · ${request.note}` : '');
  const amount = chargeAmount(request, amountOwed(booking));
  return {
    cancellation_reason: reason,
    record: { category: request.category, group: cancelGroup(request.category), note: request.note ?? null, charge_type: request.charge_type, charge_amount: amount, by: by ?? null },
    history: line(by, 'cancel', 'Cancel', `Cancelled · ${chargeLabel(request.charge_type, amount)} · ${reason}`),
  };
}

// ── Restore ──────────────────────────────────────────────────────────────────────────────────────

/** A lock that could not give back every seat the booking had drawn from it before it was cancelled. */
export type LockShortWarning = { code: 'lock_short'; trip_id: string; lock_id: string; wanted: number; got: number };

export function restoredLine(by: string | undefined, warnings: readonly LockShortWarning[]): HistoryLine {
  const shorts = warnings.map((w) => ` · seat lock ${w.lock_id}: ${w.got}/${w.wanted} seats back`).join('');
  return line(by, 'edit', 'Confirmed', `Restored${shorts}`);
}

// ── Partial cancel ───────────────────────────────────────────────────────────────────────────────

export type Split = { count: number; amount: number };
export type BookingPartialCancel = {
  trip_id: string | null; service_date: string | null; pax_removed: PaxGrid; count: number;
  category: string | null; group: CancelGroup | null; note: string | null;
  charged: Split; waived: Split; at: string; by: string | null;
};

/**
 * `{ pax_to_cancel }` is the route's older body: a bare count off a single-trip, untiered booking,
 * lock seats kept. The full form names the trip, the passengers by key, why, and the money.
 */
export type PartialCancelRequest =
  | { kind: 'count'; count: number }
  | { kind: 'record'; trip_id: string; pax: PaxRow[]; category: CancelCategory; note?: string; charged: Split; waived: Split };

export function parsePartialCancelRequest(body: Record<string, unknown>): PartialCancelRequest {
  if (body.trip_id === undefined && (body.pax_to_cancel !== undefined || typeof body.pax === 'number')) {
    const count = body.pax_to_cancel ?? body.pax;
    if (typeof count !== 'number' || !Number.isInteger(count) || count <= 0) badRequest('pax_to_cancel must be a positive integer');
    return { kind: 'count', count: count as number };
  }
  const trip_id = typeof body.trip_id === 'string' && body.trip_id.length > 0 ? body.trip_id : badRequest('trip_id is required');
  const pax = body.pax === undefined ? badRequest('pax is required: the passengers to remove, by key') : parsePaxGrid(body.pax, 'pax');
  const removed = paxTotal(pax);
  if (removed === 0) badRequest('pax must remove at least one passenger');
  const charged = split(body.charged, 'charged');
  const waived = split(body.waived, 'waived');
  if (charged.count + waived.count !== removed) badRequest(`charged.count + waived.count must equal the ${removed} passengers removed`);
  return { kind: 'record', trip_id, pax, ...categoryAndNote(body), charged, waived };
}

function split(value: unknown, name: string): Split {
  if (value === undefined || value === null) return { count: 0, amount: 0 };
  if (typeof value !== 'object' || Array.isArray(value)) badRequest(`${name} must be an object of count and amount`);
  const { count = 0, amount = 0 } = value as Record<string, unknown>;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) badRequest(`${name}.count must be a non-negative integer`);
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) badRequest(`${name}.amount must be a non-negative number`);
  return { count: count as number, amount: amount as number };
}

/**
 * The booking's price after a partial cancel: the waived amount is refunded, the charged amount is
 * a fee the agent still pays and leaves `total` alone (`booking.js:13840`). A booking with no price
 * keeps none.
 */
export const totalAfterRefund = (total: number | undefined, waived: Split): number | undefined =>
  total === undefined ? undefined : Math.max(0, total - waived.amount);

/** The record a full partial cancel writes, from the trip it came off and the request. */
export function partialCancelRecord(
  trip: { id: string; service_date: string }, request: Extract<PartialCancelRequest, { kind: 'record' }>, count: number, by: string | undefined,
): Omit<BookingPartialCancel, 'at'> {
  return {
    trip_id: trip.id, service_date: trip.service_date, pax_removed: formatPaxGrid(request.pax), count,
    category: request.category, group: cancelGroup(request.category), note: request.note ?? null,
    charged: { ...request.charged }, waived: { ...request.waived }, by: by ?? null,
  };
}

/** `Partial cancel · −2 pax · Sick / health (…) · charge 0 (฿0) · waive 2 (฿4,000)` (`booking.js:13894`). */
export function partialCancelLine(by: string | undefined, record: { count: number; category: string | null; note: string | null; charged: Split; waived: Split }): HistoryLine {
  const category = record.category && isCancelCategory(record.category) ? ` · ${cancelLabel(record.category)}` : '';
  const money = `charge ${record.charged.count} (${baht(record.charged.amount)}) · waive ${record.waived.count} (${baht(record.waived.amount)})`;
  return line(by, 'cancel', 'Cancel', `Partial cancel · −${record.count} pax${category} · ${money}${record.note ? ` · ${record.note}` : ''}`);
}

/** The older count-only body records no reason or money, but the change still gets its line. */
export const partialCountLine = (by: string | undefined, count: number): HistoryLine => line(by, 'cancel', 'Cancel', `Partial cancel · −${count} pax`);

// ── Reschedule ───────────────────────────────────────────────────────────────────────────────────

export type Collect = 'none' | 'invoice' | 'separate';
export type BookingReschedule = {
  from_date: string; to_date: string; reason: string | null;
  charge_type: ChargeType; charge_amount: number; collect: Collect; at: string; by: string | null;
};

/**
 * `{ route_id, service_date }` is the route's older body: move a single-trip booking anywhere.
 * The full form moves every trip on one day to another day and records why and what it cost.
 */
export type RescheduleRequest =
  | { kind: 'move'; route_id: string; service_date: string; pax?: number }
  | { kind: 'record'; from_date: string; to_date: string; reason: string; charge_type: ChargeType; charge_amount?: number; collect: 'invoice' | 'separate' };

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const isoDay = (value: unknown, name: string): string =>
  typeof value === 'string' && ISO_DAY.test(value) && !Number.isNaN(Date.parse(value)) ? value : badRequest(`${name} must be a YYYY-MM-DD date`);

export function parseRescheduleRequest(body: Record<string, unknown>): RescheduleRequest {
  if (body.from_date === undefined && (body.route_id !== undefined || body.service_date !== undefined || body.date !== undefined)) {
    const route_id = typeof body.route_id === 'string' && body.route_id ? body.route_id : badRequest('route_id is required');
    const service_date = body.service_date ?? body.date;
    if (typeof service_date !== 'string' || !service_date) badRequest('service_date is required');
    if (body.pax !== undefined && !(typeof body.pax === 'number' && Number.isInteger(body.pax) && body.pax > 0)) badRequest('pax must be a positive integer');
    return { kind: 'move', route_id, service_date: service_date as string, ...(body.pax === undefined ? {} : { pax: body.pax as number }) };
  }
  const from_date = isoDay(body.from_date, 'from_date');
  const to_date = isoDay(body.to_date, 'to_date');
  if (from_date === to_date) badRequest('to_date must differ from from_date');
  const reason = optionalText(body.reason, 'reason') ?? badRequest('reason is required');
  const collect = body.collect ?? 'invoice';
  if (collect !== 'invoice' && collect !== 'separate') badRequest('collect must be invoice or separate');
  return { kind: 'record', from_date, to_date, reason, ...charge(body), collect: collect as 'invoice' | 'separate' };
}

/**
 * The reschedule record, the fee item it adds, and its history line. The trip's price stands; a
 * charge is extra (`booking.js:13643`). Collected on the invoice it becomes a fee item; collected
 * separately it is kept on the record only. With no charge there is nothing to collect.
 */
export function planRescheduleRecord(
  booking: { total?: number; fee_items: readonly { amount: number }[] },
  request: Extract<RescheduleRequest, { kind: 'record' }>, by: string | undefined, locksReturned: number,
): { record: Omit<BookingReschedule, 'at'>; fee_item?: Omit<BookingFeeItem, 'at'>; history: HistoryLine } {
  const amount = chargeAmount(request, amountOwed(booking));
  const collect: Collect = amount > 0 ? request.collect : 'none';
  const route = `${request.from_date} → ${request.to_date}`;
  const collected = collect === 'invoice' ? ' · on booking invoice' : collect === 'separate' ? ' · paid separately' : '';
  const locks = locksReturned > 0 ? ` · ${locksReturned} lock seat${locksReturned === 1 ? '' : 's'} returned` : '';
  return {
    record: { from_date: request.from_date, to_date: request.to_date, reason: request.reason, charge_type: request.charge_type, charge_amount: amount, collect, by: by ?? null },
    ...(collect === 'invoice' ? { fee_item: { type: 'reschedule', label: `Reschedule fee · ${route} · ${request.reason}`, amount } } : {}),
    history: line(by, 'reschedule', 'Reschedule', `Rescheduled ${route} · ${chargeLabel(request.charge_type, amount)}${collected}${locks} · ${request.reason}`),
  };
}

/** The older body moves a trip without a reason; the history still says where it went. */
export const movedLine = (by: string | undefined, from: string, to: string): HistoryLine =>
  line(by, 'reschedule', 'Reschedule', `Rescheduled ${from} → ${to}`);

// ── Server-owned fields ──────────────────────────────────────────────────────────────────────────

/**
 * Values the server decides, never the request (CLAUDE.md, "Authority"). Who created a booking and
 * when, and who confirmed it and when, come from the login and the clock; the status moves only
 * through a command. `updated_by` is stamped by `stampActor`.
 */
export const SERVER_OWNED_HEADER = ['created_by', 'booked_at', 'confirmed_by', 'confirmed_at'] as const;
type OwnedField = typeof SERVER_OWNED_HEADER[number] | 'status';

/** What to do instead, for each refusal. */
const INSTEAD: Record<OwnedField, string> = {
  status: 'use POST /v1/bookings/{id}/confirm, /approve, /reject, /cancel, /cancel-weather or /restore',
  confirmed_by: 'it is stamped from the login by /confirm or /approve',
  confirmed_at: 'it is stamped by /confirm or /approve',
  created_by: 'it is the logged-in user who created the booking',
  booked_at: 'it is the time the booking was created',
};
const ownedRefusal = (field: OwnedField, verb: string): never => badRequest(`${field} cannot be ${verb}: ${INSTEAD[field]}`);

/** Two values of a server-owned field are the same claim: both empty, the same text, or the same instant. */
function sameValue(field: OwnedField, sent: unknown, stored: unknown): boolean {
  const empty = (v: unknown) => v === undefined || v === null || v === '';
  if (empty(sent) || empty(stored)) return empty(sent) && empty(stored);
  if (field === 'booked_at' || field === 'confirmed_at') {
    const a = Date.parse(String(sent)), b = Date.parse(String(stored));
    if (!Number.isNaN(a) && !Number.isNaN(b)) return a === b;
  }
  return String(sent).trim() === String(stored).trim();
}

/**
 * A `PATCH`'s changes with the server-owned values taken out.
 *
 * The transition rule: a client that sends the whole booking back — legacy's integration does, on
 * every save — echoes these values unchanged, and that is accepted and ignored. A *different* value
 * is a claim the client may not make, refused with `400` naming what to do instead.
 */
export function stripServerOwned(changes: BookingChanges, stored: Record<string, unknown> & { status: BookingStatus }): BookingChanges {
  const { status, ...rest } = changes;
  if (status !== undefined && status !== stored.status) ownedRefusal('status', 'changed with PATCH');
  if (!rest.header) return rest;
  const header = { ...rest.header } as Record<string, unknown>;
  for (const field of SERVER_OWNED_HEADER) {
    if (!(field in header)) continue;
    if (!sameValue(field, header[field], stored[field])) ownedRefusal(field, 'changed with PATCH');
    delete header[field];
  }
  return { ...rest, header: header as BookingHeaderPatch };
}

/**
 * The header a create stores: the caller's fields, plus who created it and when. A body naming any
 * server-set field is refused: `created_by` may only repeat the logged-in user. Who confirmed it is
 * stamped by the store once it has decided the status (`confirmationStamp`). With authentication
 * off (local development) there is no user, and the user columns stay empty.
 */
export function createHeader(header: BookingHeader, actor: string | undefined, now: string): BookingHeader {
  if (header.created_by !== undefined && header.created_by !== actor) ownedRefusal('created_by', 'set');
  for (const field of ['booked_at', 'confirmed_by', 'confirmed_at'] as const) if (header[field] !== undefined) ownedRefusal(field, 'set');
  const out: BookingHeader = { ...header, booked_at: now };
  delete out.updated_by;
  delete out.created_by;
  if (actor !== undefined) { out.created_by = actor; out.updated_by = actor; }
  return out;
}

/** The header columns a booking gets when it becomes `confirmed` for the first time. */
export const confirmationStamp = (actor: string | undefined, now: string): Pick<BookingHeader, 'confirmed_at' | 'confirmed_by'> =>
  (actor === undefined ? { confirmed_at: now } : { confirmed_at: now, confirmed_by: actor });

/** Statuses a booking can no longer be edited in (legacy `bkV2EditBooking`: "Cannot edit a … booking"). */
const CLOSED: readonly BookingStatus[] = ['cancelled', 'completed', 'rejected', 'cancelled_weather'];
export function assertEditable(status: BookingStatus): void {
  if (CLOSED.includes(status)) refuse(`Cannot edit a ${status} booking`, 409, 'booking_closed');
}

// ── Status commands ──────────────────────────────────────────────────────────────────────────────

/**
 * The commands that move a booking's status, besides `/cancel` and `/restore`. Each is a decision a
 * person makes; the server checks it is allowed from where the booking is, and records who made it.
 * The rules are legacy's (`bkV2ApproveBooking`, `bkV2RejectBooking`, `bkV2FocApprove`,
 * `bkV2FocReject`, `bkV2WeatherResolveOne`), except that the approver is the logged-in user, not a
 * typed name (legacy's FOC approval even hard-coded `RM`).
 */
export const STATUS_COMMANDS = ['confirm', 'approve', 'reject', 'cancel-weather'] as const;
export type StatusCommand = typeof STATUS_COMMANDS[number];
export type StatusCommandRequest = { note?: string };

export function parseStatusCommandRequest(body: Record<string, unknown>): StatusCommandRequest {
  const note = optionalText(body.note, 'note');
  return note === undefined ? {} : { note };
}

/**
 * What a command writes: the new status, whether it confirms, any cancellation text, and the history
 * lines. `decide` closes the pending approval of that kind (or records a decided one, for a booking
 * that never had a record — legacy's imported `pending_approval` bookings). `request` asks for new
 * approvals. `claims` says the booking starts holding seats it was not holding: an approval of an
 * over-allotment booking.
 */
export type StatusPlan = {
  status: BookingStatus; confirms: boolean; cancellation_reason?: string; history: HistoryLine[];
  decide?: { kind: ApprovalKind; status: 'approved' | 'rejected'; note: string | null };
  request: NewApproval[]; claims: boolean;
};

const FROM: Record<StatusCommand, readonly BookingStatus[] | 'open'> = {
  confirm: ['draft', 'quote', 'pending'],
  approve: ['pending_approval', 'pending_foc'],
  reject: ['pending_approval', 'pending_foc'],
  'cancel-weather': 'open',
};

export function planStatusCommand(
  command: StatusCommand,
  booking: {
    status: BookingStatus; confirmed_at?: string; foc_reason?: string; price_discount?: number;
    approvals?: readonly BookingApproval[]; trips: readonly { pax: readonly PaxRow[] }[];
  },
  request: StatusCommandRequest, by: string | undefined,
): StatusPlan {
  const from = FROM[command];
  if (from === 'open') assertOpen(booking.status, 'cancel');
  else if (!from.includes(booking.status)) {
    refuse(`Cannot ${command} a ${booking.status} booking: ${command} applies to ${from.join(', ')}`, 409, 'wrong_status');
  }
  const note = request.note ? ` · ${request.note}` : '';
  const foc = focCountOf(booking.trips);
  // Who confirmed is stamped the first time a booking becomes confirmed, never overwritten (legacy).
  const confirming = (to: BookingStatus) => to === 'confirmed' && !booking.confirmed_at;

  if (command === 'confirm') {
    // The same decision as a create with intent `confirm`: FOC passengers wait for an FOC approval,
    // a discount for its approval. A draft, quote or pending booking already holds its seats, so the
    // allotment is not weighed again.
    const decision = decideStatus('confirm', { focCount: foc, focReason: booking.foc_reason, discount: discountOf(booking), overDays: [] }, by);
    const to = decision.status;
    const own = to === 'confirmed' ? [line(by, 'edit', 'Confirmed', `Confirmed${note}`)] : decision.history.map((h) => ({ ...h, text: `${h.text}${note}` }));
    return { status: to, confirms: confirming(to), history: own, request: decision.approvals, claims: false };
  }
  const kind: ApprovalKind = booking.status === 'pending_foc' ? 'foc' : 'approval';
  const tag = kind === 'foc' ? 'FOC' : 'Approval';
  if (command === 'approve') {
    // An approval remembers where the booking was going; with no record (legacy's imported
    // `pending_approval` bookings), confirmed, as legacy's `bkV2EnsureApproval` defaults it.
    const pending = pendingApproval(booking.approvals, kind);
    const to: BookingStatus = kind === 'foc' ? 'confirmed' : pending?.target_status ?? 'confirmed';
    const text = kind === 'foc' ? `FOC approved · ${foc} pax · booking ${to}` : to === 'confirmed' ? 'Approved · booking confirmed' : `Approved · now ${to}`;
    return {
      status: to, confirms: confirming(to), history: [line(by, 'confirm', tag, `${text}${note}`)],
      decide: { kind, status: 'approved', note: request.note ?? null }, request: [], claims: kind === 'approval' && Boolean(pending?.over_capacity),
    };
  }
  if (command === 'reject') {
    return {
      status: 'rejected', confirms: false, history: [line(by, 'cancel', tag, `${kind === 'foc' ? 'FOC rejected' : 'Rejected'}${note}`)],
      decide: { kind, status: 'rejected', note: request.note ?? null }, request: [], claims: false,
    };
  }
  return { status: 'cancelled_weather', confirms: false, cancellation_reason: 'weather', history: [line(by, 'weather', 'Weather', `Cancelled for weather${note}`)], request: [], claims: false };
}

// ── Shared parsing ───────────────────────────────────────────────────────────────────────────────

/** Trimmed text, or undefined when absent or blank. Present and not a string is refused. */
function optionalText(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') badRequest(`${name} must be a string`);
  const trimmed = (value as string).trim();
  return trimmed === '' ? undefined : trimmed;
}
