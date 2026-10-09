/**
 * Weather closures and their follow-up (todo/weather-closures-model.md, decided 2026-10-09; migration
 * 060). Legacy `SB_WEATHER_CLOSURES` and `bk.weatherResolve` (`bkV2WeatherMarkConfirm`,
 * `bkV2WeatherUncancel`, `bkV2WeatherPanel`, `bkV2WeatherNotify`, `bkV2WeatherResolveOne` in
 * `08-app.js`; `bkV2WeatherCountsFor` in `04-data-core.js`), decided here. Pure, so both stores
 * decide identically.
 *
 * A closure refuses nothing (decision 1): it is a record that the trip did not run, and a to-do list.
 * The list is worked out on every read: the bookings on the closed trip, plus every booking with a row.
 * A row is written only when something happens to a booking: notified, resolved, or imported. Legacy
 * tagged bookings only when someone opened the panel, and kept a tag on a booking that had moved away.
 */
import { refuse, type HistoryLine } from './booking-actions.js';
import { SEAT_RELEASING_STATUSES, type BookingStatus } from './booking-status.js';
import type { Booking } from './operations.js';
import type { PaymentState } from './invoices.js';
import { WEATHER_CANCEL_OUTCOMES, type WeatherCancelOutcome } from './refunds.js';

const badRequest = (message: string): never => refuse(message, 400);

export type WeatherClosure = {
  id: string; route_id: string; service_date: string; note: string | null;
  closed_by: string | null; closed_at: string;
  /** The last note change. */
  updated_by: string | null; updated_at: string | null;
  /** Set by undo. A reopened closure is kept: the bookings it resolved keep their record. */
  reopened_by: string | null; reopened_at: string | null;
};

export const CASE_STATUSES = ['awaiting', 'notified', 'resolved'] as const;
export type CaseStatus = typeof CASE_STATUSES[number];
export const CASE_OUTCOMES = ['reschedule', 'refund', 'credit', 'cancel'] as const;
export type CaseOutcome = typeof CASE_OUTCOMES[number];

/** One booking's follow-up on one closure (legacy `bk.weatherResolve`). */
export type WeatherCase = {
  closure_id: string; booking_id: string; status: CaseStatus;
  notified_at: string | null; notified_by: string | null;
  outcome: CaseOutcome | null; new_date: string | null;
  resolved_at: string | null; resolved_by: string | null;
};
const blankCase = (closureId: string, bookingId: string): WeatherCase => ({
  closure_id: closureId, booking_id: bookingId, status: 'awaiting', notified_at: null, notified_by: null, outcome: null, new_date: null, resolved_at: null, resolved_by: null,
});

/** A row of the follow-up list, as legacy's panel shows it. */
export type FollowUp = Omit<WeatherCase, 'closure_id'> & {
  voucher_ref: string | null; agent_id: string | null; lead_pax: string | null; booking_status: BookingStatus; booking_mode: string | null;
  /** The booking's passengers on that route (legacy reads its trip on the route). */
  pax: number;
  /** Still holding a trip on the closed route and date; false once moved away or cancelled. */
  on_trip: boolean;
  payment_state: PaymentState;
  /** What a weather cancel would give back now (legacy's "Paid ฿x"). Only on a single closure's read. */
  refundable?: number;
};
export type ClosureCounts = { awaiting: number; notified: number; resolved: number };
export type ClosurePax = { pending: number; cancelled: number; rescheduled: number; total: number };
export type ClosureView = WeatherClosure & { counts: ClosureCounts; pax: ClosurePax; bookings?: FollowUp[] };

const RELEASED = SEAT_RELEASING_STATUSES as readonly string[];

/** On the closed trip: a trip on that route and date, its seats not given back. Charters too (decision 7). */
export const onTrip = (b: Pick<Booking, 'status' | 'trips'>, c: Pick<WeatherClosure, 'route_id' | 'service_date'>): boolean =>
  !RELEASED.includes(b.status) && b.trips.some((t) => t.route_id === c.route_id && t.service_date === c.service_date);

/**
 * The follow-up list (legacy `bkV2WeatherPanel`, without its "tag on open"): on an open closure, every
 * booking on the trip plus every booking with a row; on a reopened one, only the rows, which are the
 * resolved bookings undo kept. `bookings` must hold every booking on the trip and every row's booking.
 */
export function followUps(closure: WeatherClosure, bookings: readonly Booking[], rows: readonly WeatherCase[], refundable?: ReadonlyMap<string, number>): FollowUp[] {
  const byId = new Map(bookings.map((b) => [b.id, b]));
  const rowOf = new Map(rows.filter((r) => r.closure_id === closure.id).map((r) => [r.booking_id, r]));
  const ids = new Set(rowOf.keys());
  if (closure.reopened_at === null) for (const b of bookings) if (onTrip(b, closure)) ids.add(b.id);
  return [...ids].sort().flatMap((id): FollowUp[] => {
    const b = byId.get(id);
    if (!b) return [];
    const { closure_id: _c, ...row } = rowOf.get(id) ?? blankCase(closure.id, id);
    const trip = b.trips.find((t) => t.route_id === closure.route_id && t.service_date === closure.service_date) ?? b.trips.find((t) => t.route_id === closure.route_id);
    return [{
      ...row, voucher_ref: b.voucher_ref ?? null, agent_id: b.agent_id ?? null, lead_pax: b.lead_pax ?? null, booking_status: b.status,
      booking_mode: trip?.booking_mode ?? b.booking_mode ?? null, pax: trip ? trip.pax_total : b.pax, on_trip: onTrip(b, closure), payment_state: b.payment_state,
      ...(refundable ? { refundable: refundable.get(id) ?? 0 } : {}),
    }];
  });
}

/** The panel's "To notify / Notified / Resolved" and the calendar's pax tally (`bkV2WeatherCountsFor`). */
export function closureView(closure: WeatherClosure, entries: readonly FollowUp[], withBookings: boolean): ClosureView {
  const counts: ClosureCounts = { awaiting: 0, notified: 0, resolved: 0 };
  const pax: ClosurePax = { pending: 0, cancelled: 0, rescheduled: 0, total: 0 };
  for (const e of entries) {
    counts[e.status] += 1;
    if (e.status !== 'resolved') pax.pending += e.pax;
    else if (e.outcome === 'reschedule') pax.rescheduled += e.pax;
    else pax.cancelled += e.pax;
    pax.total += e.pax;
  }
  return { ...closure, counts, pax, ...(withBookings ? { bookings: entries.map((e) => ({ ...e })) } : {}) };
}

// ── Requests ─────────────────────────────────────────────────────────────────────────────────────

const text = (value: unknown, name: string): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return badRequest(`${name} must be a string`);
  return value.trim() === '' ? null : value.trim();
};
const isoDay = (value: unknown, name: string): string => {
  const t = typeof value === 'string' ? value.trim() : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(t) && new Date(`${t}T00:00:00Z`).toISOString().startsWith(t) ? t : badRequest(`${name} must be a YYYY-MM-DD date`);
};
const flag = (value: unknown, name: string): boolean => {
  if (value === undefined || value === null || value === false || value === 'false') return false;
  if (value === true || value === 'true') return true;
  return badRequest(`${name} must be true or false`);
};

/** What the server sets on a closure, and what to do instead. */
const SERVER_SET: Record<string, string> = {
  id: 'it is the server\'s', closed_by: 'it is the logged-in user', closed_at: 'it is the time the trip was closed',
  updated_by: 'it is the user who last changed the note', updated_at: 'it is the time the note last changed',
  reopened_by: 'use POST /v1/weather-closures/{id}/undo', reopened_at: 'use POST /v1/weather-closures/{id}/undo',
  counts: 'it is worked out from the bookings', pax: 'it is worked out from the bookings', bookings: 'it is worked out from the bookings on the trip',
};

export type NewClosure = { route_id: string; service_date: string; note: string | null };
/** `POST /v1/weather-closures` (legacy's "Confirm cancel trip"). Past dates are allowed (decision 11). */
export function parseNewClosure(body: Record<string, unknown>): NewClosure {
  for (const [key, why] of Object.entries(SERVER_SET)) if (body[key] !== undefined && body[key] !== null) badRequest(`${key} cannot be sent: ${why}`);
  if (body.reason !== undefined && body.reason !== 'weather') badRequest('reason is always weather');
  const route = body.route_id ?? body.routeId;
  if (typeof route !== 'string' || !route) badRequest('route_id is required');
  return { route_id: route as string, service_date: isoDay(body.service_date ?? body.date, 'service_date'), note: text(body.note, 'note') };
}

/**
 * `PATCH /v1/weather-closures/{id}`: the note only (legacy's "Update note"). Anything the server sets,
 * or the trip itself, is refused unless it repeats what is stored.
 */
export function parseClosurePatch(body: Record<string, unknown>, current: ClosureView): { note?: string | null } {
  const fixed: Record<string, string> = { ...SERVER_SET, route_id: 'undo this closure and close the other trip', service_date: 'undo this closure and close the other trip' };
  for (const [key, why] of Object.entries(fixed)) {
    const sent = body[key];
    if (sent === undefined) continue;
    const stored = (current as unknown as Record<string, unknown>)[key];
    const same = typeof stored === 'object' && stored !== null ? JSON.stringify(sent) === JSON.stringify(stored) : (sent ?? null) === (stored ?? null);
    if (!same) badRequest(`${key} cannot be changed: ${why}`);
  }
  return body.note === undefined ? {} : { note: text(body.note, 'note') };
}

export const parseUndo = (body: Record<string, unknown>): { undo_anyway: boolean } => ({ undo_anyway: flag(body.undo_anyway, 'undo_anyway') });

/** `/cancel-weather`'s body: the note, and what to do with the money (default `cancel`, legacy "No refund"). */
export function parseWeatherCancel(body: Record<string, unknown>): { note?: string; outcome: WeatherCancelOutcome } {
  if (body.amount !== undefined) badRequest('amount cannot be sent: a refund or credit is what the booking paid that its invoice no longer needs, worked out by the server');
  const outcome = body.outcome ?? 'cancel';
  if (!(WEATHER_CANCEL_OUTCOMES as readonly unknown[]).includes(outcome)) badRequest(`outcome must be one of ${WEATHER_CANCEL_OUTCOMES.join(', ')}`);
  const note = text(body.note, 'note');
  return { ...(note === null ? {} : { note }), outcome: outcome as WeatherCancelOutcome };
}

export type ClosureListQuery = { from?: string; to?: string; route_id?: string; include_reopened: boolean };
export function parseClosureListQuery(query: Record<string, unknown>): ClosureListQuery {
  const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
  const from = str(query.from), to = str(query.to), route = str(query.route_id);
  return {
    ...(from === undefined ? {} : { from: isoDay(from, 'from') }), ...(to === undefined ? {} : { to: isoDay(to, 'to') }),
    ...(route === undefined ? {} : { route_id: route }), include_reopened: flag(query.include_reopened, 'include_reopened'),
  };
}
export const matchesClosureQuery = (c: WeatherClosure, q: Partial<ClosureListQuery>): boolean =>
  (!q.from || c.service_date >= q.from) && (!q.to || c.service_date <= q.to) && (!q.route_id || c.route_id === q.route_id) && (q.include_reopened || c.reopened_at === null);
/** By date, then route, then when it was closed. */
export const sortClosures = (list: readonly WeatherClosure[]): WeatherClosure[] =>
  [...list].sort((a, b) => a.service_date.localeCompare(b.service_date) || (a.route_id < b.route_id ? -1 : a.route_id > b.route_id ? 1 : 0) || a.closed_at.localeCompare(b.closed_at) || (a.id < b.id ? -1 : 1));

// ── Plans ────────────────────────────────────────────────────────────────────────────────────────

const line = (by: string | null, tag: string, textValue: string): HistoryLine => ({ by, kind: 'weather', tag, text: textValue });
/** Legacy `bkV2WeatherTagBookings`' line, on every booking on the trip when it is closed. */
export const closedLine = (by: string | null, routeName: string, date: string): HistoryLine => line(by, 'Weather', `Trip ${routeName} · ${date} cancelled due to weather`);
export const reopenedLine = (by: string | null, routeName: string, date: string): HistoryLine => line(by, 'Weather', `Trip ${routeName} · ${date} re-opened · weather cancellation undone`);
export const notifiedLine = (by: string | null): HistoryLine => line(by, 'Notify', 'Notified agent · awaiting customer decision (reschedule/cancel)');

/** A new closure; one open closure per trip (`409 already_closed`, naming it and the PATCH for its note). */
export function planClose(input: NewClosure, open: WeatherClosure | undefined, id: string, now: string, by: string | null): WeatherClosure {
  if (open) refuse(`${input.route_id} on ${input.service_date} is already closed for weather (${open.id}): change its note with PATCH /v1/weather-closures/${open.id}`, 409, 'already_closed');
  return { id, route_id: input.route_id, service_date: input.service_date, note: input.note, closed_by: by, closed_at: now, updated_by: null, updated_at: null, reopened_by: null, reopened_at: null };
}

export const assertOpenClosure = (c: WeatherClosure): void => {
  if (c.reopened_at !== null) refuse(`Weather closure ${c.id} (${c.route_id} ${c.service_date}) was re-opened on ${c.reopened_at}`, 409, 'closure_reopened');
};

/** `bkV2WeatherNotify`: awaiting → notified. A check mark that staff told the agent; nothing is sent. */
export function planNotify(closure: WeatherClosure, entries: readonly FollowUp[], bookingId: string, now: string, by: string | null): WeatherCase {
  assertOpenClosure(closure);
  const entry = entries.find((e) => e.booking_id === bookingId)
    ?? refuse(`Booking ${bookingId} is not on the closed trip (${closure.route_id} ${closure.service_date})`, 404, 'not_on_closed_trip');
  if (entry.status !== 'awaiting') refuse(`Booking ${bookingId} is already ${entry.status}`, 409, 'wrong_status');
  return { ...blankCase(closure.id, bookingId), status: 'notified', notified_at: now, notified_by: by };
}

/**
 * `bkV2WeatherUncancel`: the closure is reopened; the unresolved bookings go back to normal (their rows
 * go, each gets a history line); resolved ones stay as they are. With any resolved, legacy asked first:
 * here `409 has_resolved` lists them, and `undo_anyway: true` goes ahead.
 */
export function planUndo(closure: WeatherClosure, entries: readonly FollowUp[], undoAnyway: boolean, now: string, by: string | null):
  { closure: WeatherClosure; back: string[]; kept: string[] } {
  assertOpenClosure(closure);
  const back = entries.filter((e) => e.status !== 'resolved').map((e) => e.booking_id);
  const kept = entries.filter((e) => e.status === 'resolved');
  if (kept.length && !undoAnyway) {
    refuse(`Re-open ${closure.route_id} on ${closure.service_date}? ${back.length} booking(s) go back to normal; ${kept.length} already resolved stay as they are: `
      + `${kept.map((e) => `${e.booking_id} · ${e.outcome}`).join(', ')}. Send undo_anyway: true to re-open it`, 409, 'has_resolved');
  }
  return { closure: { ...closure, reopened_at: now, reopened_by: by }, back, kept: kept.map((e) => e.booking_id) };
}

/**
 * The rows a booking command resolves (decision 5): every open closure the booking was on before the
 * command and is not on after it (a reschedule away, a weather cancel). A weather cancel also resolves
 * the booking's other unresolved rows on open closures (`allOpenRows`), since the whole booking is off.
 * A row already resolved keeps its first outcome.
 */
export function resolvedRows(input: {
  before: Pick<Booking, 'id' | 'status' | 'trips'>; after: Pick<Booking, 'status' | 'trips'>; closures: readonly WeatherClosure[]; rows: readonly WeatherCase[];
  outcome: CaseOutcome; new_date: string | null; allOpenRows: boolean; now: string; by: string | null;
}): WeatherCase[] {
  const out: WeatherCase[] = [];
  for (const c of input.closures) {
    if (c.reopened_at !== null) continue;
    const row = input.rows.find((r) => r.closure_id === c.id && r.booking_id === input.before.id);
    if (row?.status === 'resolved') continue;
    const leaving = onTrip(input.before, c) && !onTrip(input.after, c);
    if (!leaving && !(input.allOpenRows && row)) continue;
    out.push({ ...(row ?? blankCase(c.id, input.before.id)), status: 'resolved', outcome: input.outcome,
      new_date: input.outcome === 'reschedule' ? input.new_date : null, resolved_at: input.now, resolved_by: input.by });
  }
  return out;
}
