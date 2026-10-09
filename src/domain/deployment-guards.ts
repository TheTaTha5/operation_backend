/**
 * What may change about a deployment (a boat sailing a route on a date): todo/deployment-guards-model.md,
 * decided 2026-10-09. Legacy `bop2GuardPast`, `bop2UnassignBoat`, `bop2AssignBoat`. Pure: a route reads
 * the day and the bookings placed on the boat, and this decides.
 */
import { refuse } from './booking-actions.js';
import { SEAT_RELEASING_STATUSES } from './booking-status.js';
import type { Booking, Deployment } from './operations.js';

export type DeploymentWarning = { code: 'boat_pulled' | 'oversold'; route_id: string; service_date: string; boat_id: string; bookings: number; pax: number };

/** The bookings that hold seats and are placed on the boat on that route and day: on it whole, or in a split. */
export function placedOn(bookings: readonly Booking[], boatId: string, routeId: string, date: string): { bookings: number; pax: number; charter: string | null } {
  let count = 0, pax = 0, charter: string | null = null;
  for (const b of bookings) {
    if ((SEAT_RELEASING_STATUSES as readonly string[]).includes(b.status)) continue;
    for (const t of b.trips) {
      if (t.route_id !== routeId || t.service_date !== date) continue;
      if (t.booking_mode === 'charter' && t.charter_boat_id === boatId) charter = b.id;
      const whole = t.operations.boat_id === boatId;
      const split = t.operations.boat_splits.find((s) => s.boat_id === boatId);
      if (whole || split) { count += 1; pax += whole ? t.pax_total : split!.ad + split!.chd + split!.inf + split!.foc; }
    }
  }
  return { bookings: count, pax, charter };
}

/**
 * Checks a change to one boat's deployment on one date: `before` is what stands, `after` what is asked
 * (`undefined` = removed). Moving a boat to another route is a removal from the old route.
 * - A past date (Asia/Bangkok) only for an admin: `409 past_date`.
 * - A boat a charter holds can't leave its route: `409 charter_boat`; nor one a whole-boat hold takes: `409 boat_held`.
 * - A boat with bookings placed on it leaves, or shrinks below them, only with `remove_anyway`
 *   (legacy's confirm dialog): `409 seats_sold`. Then the answer warns `boat_pulled` (the bookings
 *   show it too) or `oversold`. Only bookings placed on that boat count, as in legacy (decided 2026-10-09).
 * - `license_pax` is the boat catalogue's: a different value is `400`.
 */
export function checkDeploymentChange(before: Deployment | undefined, after: Deployment | undefined, ctx: {
  today: string; admin: boolean; removeAnyway: boolean; boatName: string; catalogueLicense: number | undefined;
  placedBefore: { bookings: number; pax: number; charter: string | null };
  /** An active whole-boat hold that takes the boat on its route that day (legacy `opHoldOnly`). */
  heldBy?: string | null;
}): DeploymentWarning[] {
  const date = after?.service_date ?? before?.service_date;
  if (!date) return [];
  if (date < ctx.today && !ctx.admin) {
    refuse(`${date} is in the past: a deployment can't change. Past days are closed and reported; ask an admin to correct it`, 409, 'past_date');
  }
  if (after && ctx.catalogueLicense !== undefined && after.license_pax !== undefined && after.license_pax !== ctx.catalogueLicense) {
    refuse(`license_pax is the boat's own (${ctx.catalogueLicense}); change it in the boat catalogue`, 400);
  }
  if (!before) return [];
  const leaves = !after || after.route_id !== before.route_id;
  const { placedBefore: placed } = ctx;
  if (leaves && placed.charter) refuse('Cannot unassign - charter is active. Cancel the charter booking first.', 409, 'charter_boat');
  if (leaves && ctx.heldBy) refuse('Cannot unassign - this boat is held whole for an agent. Release the hold on the Seat Locks page first.', 409, 'boat_held');
  const shrinks = !leaves && after!.capacity < placed.pax;
  if ((leaves && placed.bookings > 0) || shrinks) {
    if (!ctx.removeAnyway) {
      refuse(`${ctx.boatName} has ${placed.bookings} booking(s) (${placed.pax} pax) on it that day. Send remove_anyway: true to go ahead; they will be flagged "boat pulled · re-plan"`, 409, 'seats_sold');
    }
    return [{ code: leaves ? 'boat_pulled' : 'oversold', route_id: before.route_id, service_date: before.service_date, boat_id: before.boat_id, bookings: placed.bookings, pax: placed.pax }];
  }
  return [];
}
