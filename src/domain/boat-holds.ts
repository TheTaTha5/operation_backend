/**
 * Whole-boat hold rules both stores share (todo/seat-lock-extras-model.md, "Design — whole-boat
 * holds"): what stands in the way of holding a boat, the pick list's reasons, the fields a hold must
 * have, the `edit` log line, and what a conversion's booking must carry. Pure; the commands are
 * `boat-hold-service.ts`.
 *
 * Ported from legacy §bkLock (wt-lk-inbox allotment_v2/js/08-app.js): bkV2BoatLockBlockers,
 * bkV2BoatLockCanTake, bkV2BoatLockPickList, bkV2BoatLockSubmit, bkV2BoatLockEdit, bkV2BoatLockSwap,
 * bkV2BoatLockToCharter and bkV2BoatLockOnConvert.
 */
import { refuse } from './booking-actions.js';
import { bookingHoldsSeats } from './booking-approvals.js';
import { deploymentSeats, type DayState } from './capacity.js';
import { editNote, type BoatDeal, type LockRow } from './seat-locks.js';
import type { Booking, BookingTripInput, Deployment } from './operations.js';

export const BOAT_DEALS = ['fixed', 'any'] as const;
export const isBoatDeal = (value: unknown): value is BoatDeal => BOAT_DEALS.includes(value as BoatDeal);

/** A booking with passengers on the boat that day (legacy's blocker rows). */
export type HoldBooking = { booking_id: string; voucher_ref: string | null; agent_id: string | null; route_id: string; pax: number; from_lock: number };

/** Everything that stands between a hold and its boat on one date (legacy `bkV2BoatLockBlockers`). */
export type HoldBlockers = {
  /** A charter booking holding the boat that day, on any route. */
  charter_booking_id: string | null;
  /** Another active hold on the boat that day, on any route. */
  hold_id: string | null;
  /** The route the boat is deployed on that day, if any (legacy `placed`); `null` for the hold's own boat. */
  placed_route_id: string | null;
  /** Bookings holding seats with passengers placed on the boat that day, biggest first. */
  bookings: HoldBooking[];
  pax: number;
  /** Seats sold on the hold's route that day (seat passengers and charters with no known boat). */
  sold: number;
  /** What the route would be short of seats without this boat (only when the boat is deployed on it). */
  short: number;
};

/** What the blockers need of a day, gathered by the store. */
export type HoldDayFacts = {
  /** Bookings with a trip that date, on any route. */
  bookings: readonly Booking[];
  /** Deployments that date, on any route. */
  deployments: readonly Deployment[];
  /** Locks that date, on any route (only active holds count). */
  locks: readonly LockRow[];
  /** The hold's route that day. */
  day: DayState | undefined;
};

/**
 * Legacy `bkV2BoatLockBlockers`. `exceptId` is the hold being edited: the boat it already holds that
 * date (legacy `mine`) is not "placed" and does not count against the route's seats again.
 */
export function holdBlockers(date: string, boatId: string, routeId: string, exceptId: string | null, facts: HoldDayFacts): HoldBlockers {
  const own = exceptId ? facts.locks.find((l) => l.id === exceptId) : undefined;
  const mine = !!own && own.status === 'active' && own.boat_id === boatId && own.service_date === date;
  const out: HoldBlockers = { charter_booking_id: null, hold_id: null, placed_route_id: null, bookings: [], pax: 0, sold: 0, short: 0 };
  const deployment = facts.deployments.find((d) => d.boat_id === boatId && d.service_date === date);
  if (!mine && deployment) out.placed_route_id = deployment.route_id;
  out.hold_id = facts.locks.find((l) => l.id !== exceptId && l.boat_id === boatId && l.service_date === date && l.status === 'active')?.id ?? null;
  const rows = new Map<string, HoldBooking>();
  for (const booking of [...facts.bookings].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!bookingHoldsSeats(booking)) continue;
    for (const trip of booking.trips) {
      if (trip.service_date !== date) continue;
      if (trip.booking_mode === 'charter' && trip.charter_boat_id === boatId) out.charter_booking_id ??= booking.id;
      const split = trip.operations.boat_splits.find((s) => s.boat_id === boatId);
      const pax = trip.operations.boat_id === boatId ? trip.pax_total : split ? split.ad + split.chd + split.inf + split.foc : 0;
      if (pax <= 0) continue;
      const row = rows.get(booking.id) ?? { booking_id: booking.id, voucher_ref: booking.voucher_ref ?? null, agent_id: booking.agent_id ?? null, route_id: trip.route_id, pax: 0, from_lock: 0 };
      row.pax += pax;
      rows.set(booking.id, row);
    }
  }
  for (const row of rows.values()) {
    const booking = facts.bookings.find((b) => b.id === row.booking_id)!;
    row.from_lock = booking.trips.filter((t) => t.service_date === date).reduce((sum, t) => sum + Object.values(t.lock_draws).reduce((s, q) => s + q, 0), 0);
  }
  out.bookings = [...rows.values()].sort((a, b) => b.pax - a.pax);
  out.pax = out.bookings.reduce((sum, r) => sum + r.pax, 0);
  // Legacy's `seatsConsumed` against `availableCapacity`: sold seats, locks not counted. The boat's
  // seats come off only when it is on this route (decided here: legacy also took them off a route the
  // boat was not on, refusing an extra boat on a sold-out day).
  const day = facts.day;
  if (day) {
    const open = day.boats.filter((b) => !b.chartered).reduce((sum, b) => sum + b.sellable, 0);
    out.sold = day.boats.length ? Math.max(0, open - day.available_seats - day.locked_pax) : day.booked_pax;
    const boat = day.boats.find((b) => b.boat_id === boatId && !b.chartered);
    if (!mine && boat && deployment?.route_id === routeId) out.short = Math.max(0, out.sold - (open - boat.sellable));
  }
  return out;
}

/** Legacy `bkV2BoatLockCanTake`. */
export const canTake = (b: HoldBlockers, routeId: string): boolean =>
  !(b.charter_booking_id || b.hold_id || (b.placed_route_id && b.placed_route_id !== routeId) || b.pax > 0 || b.short > 0);

/** A refusal that carries extra fields to the client (the plugin error handler sends `extra`). */
export function refuseWith(message: string, status: number, code: string, extra: object): never {
  const error = new Error(message) as Error & { statusCode: number; code: string; extra: object };
  error.statusCode = status;
  error.code = code;
  error.extra = extra;
  throw error;
}

/**
 * Why a boat cannot be held, or `null`. The pick list (`bkV2BoatLockPickList`) names a charter or a
 * hold before another route; the form's save (`bkV2BoatLockSubmit`) asks about another route first.
 */
export function blockedWhy(b: HoldBlockers, routeId: string, date: string, routeName: (id: string) => string, order: 'list' | 'save' = 'list'): { code: string; message: string } | null {
  const other = b.placed_route_id && b.placed_route_id !== routeId
    ? { code: 'boat_other_route', message: `That boat is already placed on ${routeName(b.placed_route_id)} for ${date}.\nA boat placed on another programme cannot be held here. Move it in Boat Operation first, or pick another boat.` }
    : null;
  if (order === 'save' && other) return other;
  if (b.charter_booking_id) return { code: 'boat_taken', message: `That boat is not free on ${date}: it is chartered (booking ${b.charter_booking_id})` };
  if (b.hold_id) return { code: 'boat_taken', message: `That boat is not free on ${date}: it is already held whole (seat lock ${b.hold_id})` };
  if (other) return other;
  if (b.pax > 0) return { code: 'boat_taken', message: `That boat is not free on ${date}: ${b.bookings.length} booking(s) (${b.pax} pax) are on it. Move them to another boat first` };
  if (b.short > 0) return { code: 'boat_taken', message: `That boat is not free on ${date}: the trip has sold ${b.sold} seats, and without this boat it would be ${b.short} short` };
  return null;
}

/** Refuses a boat the blockers keep from the hold: `409 boat_other_route` or `409 boat_taken`, with `blockers`. */
export function assertCanTake(b: HoldBlockers, routeId: string, date: string, routeName: (id: string) => string): void {
  const why = blockedWhy(b, routeId, date, routeName, 'save');
  if (why) refuseWith(why.message, 409, why.code, { blockers: b });
}

/** The seats a boat offers that day: its deployment's (after any override, the licence clamping), else the catalogue's. */
export function boatSeats(boatId: string, day: DayState | undefined, deployment: Deployment | undefined, catalogue: { capacity: number; license_pax: number | null } | undefined): number {
  const onRoute = day?.boats.find((b) => b.boat_id === boatId);
  if (onRoute) return onRoute.sellable;
  if (deployment) return deploymentSeats(deployment).sellable;
  return catalogue ? deploymentSeats({ capacity: catalogue.capacity, license_pax: catalogue.license_pax ?? undefined }).sellable : 0;
}

/** Legacy's form checks (`bkV2BoatLockSubmit`, `bkV2BoatLockEdit`): `400` with its words. */
export function assertHoldFields(h: { service_date: string; expiry: string | null; pax: number }): void {
  if (!h.expiry) refuse('Expiry date is required for a whole-boat hold', 400);
  if (h.expiry! > h.service_date) refuse('Expiry must be on or before the travel date', 400);
  if (!(h.pax > 0)) refuse('Enter the minimum seats promised', 400);
}

/** An `any` hold promises a boat that big (`bkV2BoatLockSwap`, edit `small`). */
export function assertBigEnough(deal: BoatDeal, seats: number, min: number, boatName: string): void {
  if (deal === 'any' && seats < min) refuse(`That boat has fewer seats than the minimum promised: ${boatName} seats ${seats}, ${min} promised`, 409, 'boat_too_small');
}

/** Legacy's `edit` line: `route: r3 → r5 · boat: Oceanus → Verona · …`, its labels. */
export function holdEditNote(before: HoldFacts, after: HoldFacts): string {
  const shown = (h: HoldFacts) => ({ route: h.route_id, date: h.service_date, boat: h.boat_name, expiry: h.expiry, min: h.pax, deal: h.boat_deal, holder: `${h.holder_type}:${h.agent_id ?? ''}`, note: h.reason });
  return editNote(shown(before), shown(after));
}
export type HoldFacts = Pick<LockRow, 'route_id' | 'service_date' | 'expiry' | 'pax' | 'holder_type' | 'agent_id' | 'reason'> & { boat_deal: BoatDeal; boat_name: string };

// ── Converting a hold into a charter (legacy `bkV2BoatLockToCharter`, `bkV2BoatLockOnConvert`) ──

/**
 * The booking body with what legacy's prefilled form carries, where the caller left it out: the
 * holder's agent (an agent hold), and on the first trip (or the flat form) the hold's route and date,
 * a charter, and the held boat.
 */
export function convertBody(raw: Record<string, unknown>, hold: Pick<LockRow, 'route_id' | 'service_date' | 'boat_id' | 'holder_type' | 'agent_id'>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  if (hold.holder_type === 'agent' && hold.agent_id && out.agent_id === undefined && out.agentId === undefined) out.agent_id = hold.agent_id;
  const fill = (trip: Record<string, unknown>): Record<string, unknown> => ({
    ...trip,
    ...(trip.route_id === undefined ? { route_id: hold.route_id } : {}),
    ...(trip.service_date === undefined && trip.date === undefined ? { service_date: hold.service_date } : {}),
    ...(trip.booking_mode === undefined && trip.bookingMode === undefined ? { booking_mode: 'charter' } : {}),
    ...(trip.charter_boat_id === undefined && trip.charterBoatId === undefined ? { charter_boat_id: hold.boat_id } : {}),
  });
  if (Array.isArray(out.trips) && out.trips.length > 0) {
    const [first, ...rest] = out.trips as unknown[];
    out.trips = [first !== null && typeof first === 'object' && !Array.isArray(first) ? fill(first as Record<string, unknown>) : first, ...rest];
  } else if (out.trips === undefined) {
    Object.assign(out, fill(out));
  }
  return out;
}

/** The booking takes the boat from the hold only as a charter of it on its route and day, and not as a quote. */
export function assertConverts(trips: readonly BookingTripInput[], intent: string | undefined, hold: Pick<LockRow, 'route_id' | 'service_date' | 'boat_id'>): void {
  if (intent === 'quote') refuse('A quote does not take the boat: save the booking as confirmed to convert the hold (or save the quote on its own)', 400, 'hold_quote');
  const hit = trips.some((t) => t.booking_mode === 'charter' && t.charter_boat_id === hold.boat_id && t.route_id === hold.route_id && t.service_date === hold.service_date);
  if (!hit) refuse(`A hold converts into a charter of boat ${hold.boat_id} on ${hold.route_id} ${hold.service_date}: the booking has no such trip`, 400, 'hold_mismatch');
}
