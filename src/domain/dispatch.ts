/**
 * Dispatch for one departure (slice A1 of todo/trip-ops-and-vans-model.md, migration 033): the boat a
 * trip goes on, or the boats it is split across, its final pickup time and the pier note. Legacy's
 * `bkV2AssignBoat`, `bkV2BoatSplitApply`, `bkV2SetPickupFinal`, `pckNoteSet`. Pure, so both stores
 * decide identically.
 */
import { refuse } from './booking-actions.js';
import { pickupFields, pickupProblem } from './pickup.js';
import type { PaxRow } from './pax.js';
import type { VanPartView } from './van-groups.js';
import type { CheckinView } from './checkin.js';
import type { TripUpgradeView } from './upgrades.js';

export type BoatSplit = { boat_id: string; ad: number; chd: number; inf: number; foc: number };
/** What a store keeps for one trip. */
export type StoredDispatch = {
  boat_id: string | null; boat_splits: BoatSplit[];
  pickup_time_final: string | null; pickup_time_final_end: string | null; pickup_final_at_pier: boolean;
  return_same_van: boolean;
  pier_note: { text: string; at: string; by: string | null } | null;
};
/** As a booking read shows it: `boat_pulled` when a boat it is on no longer sails on the trip's route that day, and who rides which van (`van-groups.ts`). */
export type TripDispatch = StoredDispatch & {
  boat_pulled: boolean; van_parts: VanPartView[]; checkins: { van: CheckinView[]; pier: CheckinView[] };
  /** The route upgrade in force on this trip (`upgrades.ts`), or null. */
  upgrade: TripUpgradeView | null;
};
export type DispatchPatch = Partial<{
  boat_id: string | null; boat_splits: BoatSplit[];
  pickup_time_final: string | null; pickup_time_final_end: string | null; pickup_final_at_pier: boolean;
  return_same_van: boolean; pier_note: string | null;
}>;

export const EMPTY_DISPATCH: StoredDispatch = {
  boat_id: null, boat_splits: [], pickup_time_final: null, pickup_time_final_end: null, pickup_final_at_pier: false, return_same_van: false, pier_note: null,
};
const copy = (d: StoredDispatch): StoredDispatch => ({ ...d, boat_splits: d.boat_splits.map((s) => ({ ...s })), pier_note: d.pier_note && { ...d.pier_note } });

export const dispatchView = (stored: StoredDispatch | undefined, deployedBoats: ReadonlySet<string>, vanParts: VanPartView[],
  checkins: TripDispatch['checkins'], upgrade: TripUpgradeView | null): TripDispatch => {
  const d = copy(stored ?? EMPTY_DISPATCH);
  const boats = d.boat_id ? [d.boat_id] : d.boat_splits.map((s) => s.boat_id);
  return { ...d, boat_pulled: boats.some((b) => !deployedBoats.has(b)), van_parts: vanParts, checkins, upgrade };
};

/** Legacy `bkOpsClear` when a trip moves to another route or day: everything goes but the pier note. */
export const clearedOnMove = (stored: StoredDispatch): StoredDispatch => ({ ...EMPTY_DISPATCH, pier_note: stored.pier_note && { ...stored.pier_note } });

// ── PATCH /operations/trip-ops/{trip_id} ──

const bad = (message: string): never => refuse(message, 400);
const count = (v: unknown, name: string): number => (v === undefined || v === null ? 0 : Number.isInteger(v) && (v as number) >= 0 ? v as number : bad(`${name} must be a whole number, 0 or more`));

/** An absent field is unchanged, `null` clears it; `boat_splits` replaces the list. */
export function parseDispatchPatch(body: Record<string, unknown>): DispatchPatch {
  const patch: DispatchPatch = {};
  const has = (key: string) => body[key] !== undefined;
  if (has('boat_id') && has('boat_splits')) bad('Send boat_id or boat_splits, not both');
  if (has('boat_id')) patch.boat_id = body.boat_id === null || body.boat_id === '' ? null : typeof body.boat_id === 'string' ? body.boat_id : bad('boat_id must be a boat id');
  if (has('boat_splits')) {
    if (body.boat_splits === null) patch.boat_splits = [];
    else {
      if (!Array.isArray(body.boat_splits)) bad('boat_splits must be a list');
      patch.boat_splits = (body.boat_splits as unknown[]).map((raw, i) => {
        const s = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : bad(`boat_splits[${i}] must be an object`);
        const boat = s.boat_id ?? s.boatId;
        if (typeof boat !== 'string' || !boat) bad(`boat_splits[${i}].boat_id is required`);
        return { boat_id: boat as string, ad: count(s.ad, `boat_splits[${i}].ad`), chd: count(s.chd, `boat_splits[${i}].chd`), inf: count(s.inf, `boat_splits[${i}].inf`), foc: count(s.foc, `boat_splits[${i}].foc`) };
      });
      if (patch.boat_splits.length === 1) bad('A split needs two boats or more; send boat_id for one');
      if (new Set(patch.boat_splits.map((s) => s.boat_id)).size !== patch.boat_splits.length) bad('boat_splits names a boat twice');
    }
  }
  const text = (key: string): string | null | undefined => {
    if (!has(key)) return undefined;
    if (body[key] === null || body[key] === '') return null;
    return typeof body[key] === 'string' ? body[key] as string : bad(`${key} must be text`);
  };
  const start = text('pickup_time_final'), end = text('pickup_time_final_end');
  if (start !== undefined) patch.pickup_time_final = start;
  if (end !== undefined) patch.pickup_time_final_end = end;
  if (has('pickup_final_at_pier')) patch.pickup_final_at_pier = typeof body.pickup_final_at_pier === 'boolean' ? body.pickup_final_at_pier : bad('pickup_final_at_pier must be true or false');
  if (has('return_same_van')) patch.return_same_van = typeof body.return_same_van === 'boolean' ? body.return_same_van : bad('return_same_van must be true or false');
  const note = text('pier_note');
  if (note !== undefined) patch.pier_note = note === null ? null : note.trim() || null;
  return patch;
}

/**
 * The trip's dispatch after `patch`. Refuses a boat not deployed on the trip's route that day (`409
 * boat_not_deployed`; legacy obeys this on 3,742 of 3,743 assignments), and splits whose pax do not
 * add up to the trip's. The pier note is stamped with when and who.
 */
export function applyDispatch(current: StoredDispatch | undefined, patch: DispatchPatch,
  ctx: { pax: readonly PaxRow[]; deployedBoats: ReadonlySet<string>; now: string; by: string | null }): StoredDispatch {
  const next = copy(current ?? EMPTY_DISPATCH);
  if (patch.boat_id !== undefined) { next.boat_id = patch.boat_id; next.boat_splits = []; }
  if (patch.boat_splits !== undefined) { next.boat_splits = patch.boat_splits.map((s) => ({ ...s })); if (patch.boat_splits.length) next.boat_id = null; }
  for (const boat of [...(patch.boat_id ? [patch.boat_id] : []), ...(patch.boat_splits ?? []).map((s) => s.boat_id)]) {
    if (!ctx.deployedBoats.has(boat)) refuse(`Boat ${boat} is not deployed on this trip's route that day`, 409, 'boat_not_deployed');
  }
  if (patch.boat_splits?.length) {
    const want = (category: string) => ctx.pax.filter((r) => r.category === category).reduce((s, r) => s + r.count, 0);
    for (const category of ['ad', 'chd', 'inf', 'foc'] as const) {
      const got = patch.boat_splits.reduce((s, b) => s + b[category], 0);
      if (got !== want(category)) bad(`boat_splits put ${got} ${category} on boats, the trip has ${want(category)}`);
    }
  }
  if (patch.pickup_time_final !== undefined) next.pickup_time_final = patch.pickup_time_final;
  if (patch.pickup_time_final_end !== undefined) next.pickup_time_final_end = patch.pickup_time_final_end;
  if (patch.pickup_final_at_pier !== undefined) next.pickup_final_at_pier = patch.pickup_final_at_pier;
  const window = pickupFields({ pickup_time: next.pickup_time_final ?? undefined, pickup_time_end: next.pickup_time_final_end ?? undefined, pickup_at_pier: next.pickup_final_at_pier });
  const problem = pickupProblem(window);
  if (problem) bad(problem.replace(/pickup_time_end/g, 'pickup_time_final_end').replace(/pickup_time(?!_)/g, 'pickup_time_final').replace(/pickup_at_pier/g, 'pickup_final_at_pier'));
  if (patch.return_same_van !== undefined) next.return_same_van = patch.return_same_van;
  if (patch.pier_note !== undefined) next.pier_note = patch.pier_note === null ? null : { text: patch.pier_note, at: ctx.now, by: ctx.by };
  return next;
}

// ── Who may go on which boat (todo/boat-assignment-model.md, approved 2026-10-09) ──

/** A boat may be filled to its capacity that day plus this (legacy `BA_CAP_TOL`); past it the assignment is refused. */
export const BOAT_TOLERANCE = 2;
export type BoatOnDay = { boat_id: string; sellable: number; license_pax?: number; chartered: boolean };
export type CapacityRaise = { boat_id: string; capacity: number; reason: string };

/** Each boat a trip's dispatch puts passengers on, with how many (`baAssignedPax`, a split counting its share). */
export function paxByBoat(d: Pick<StoredDispatch, 'boat_id' | 'boat_splits'>, tripPax: number): Map<string, number> {
  if (d.boat_id) return new Map([[d.boat_id, tripPax]]);
  return new Map(d.boat_splits.map((s) => [s.boat_id, s.ad + s.chd + s.inf + s.foc]));
}

/** `raise_capacity: { reason }` on the trip-ops `PATCH`: absent is undefined. */
export function parseRaise(value: unknown): { reason: string } | undefined {
  if (value === undefined || value === null) return undefined;
  const r = value !== null && typeof value === 'object' ? value as Record<string, unknown> : bad('raise_capacity must be { reason }');
  return typeof r.reason === 'string' && r.reason.trim() ? { reason: r.reason.trim() } : bad('raise_capacity.reason is required');
}

/**
 * Legacy `bkV2AssignBoat` and `§chOpsSync`, checked when a patch assigns a boat:
 * - a charter trip's boat is its charter boat, so nothing else may be set;
 * - a seat trip may not go on a boat chartered that day (`409 boat_chartered`);
 * - a boat may carry its capacity that day + 2. Past that, `409 boat_full`, unless the caller may
 *   raise the day's capacity (`act-capunlock` or admin) and sends `raise_capacity`: then the day's
 *   capacity becomes min(licence, the load), as legacy's dialog proposes. Past the licence + 2
 *   nothing helps (`409 over_licence`).
 * Answers the capacity raises to write before the assignment.
 */
export function checkBoatAssignment(input: {
  patch: DispatchPatch; next: StoredDispatch;
  trip: { booking_mode: string; charter_boat_id?: string; service_date: string; pax_total: number };
  boats: ReadonlyMap<string, BoatOnDay>;
  /** Passengers already on each boat that day, this trip left out. */
  others: ReadonlyMap<string, number>;
  raise: { reason: string } | undefined; mayRaise: boolean;
}): CapacityRaise[] {
  const { patch, trip } = input;
  if (patch.boat_id === undefined && patch.boat_splits === undefined) return [];
  if (trip.booking_mode === 'charter') {
    if (patch.boat_id !== undefined && patch.boat_id !== trip.charter_boat_id) {
      bad(`A charter's boat is its charter_boat_id (${trip.charter_boat_id ?? 'none'}): change it on the booking`);
    }
    return [];
  }
  const raises: CapacityRaise[] = [];
  for (const [boatId, mine] of paxByBoat(input.next, trip.pax_total)) {
    const boat = input.boats.get(boatId);
    if (!boat) continue;
    if (boat.chartered) refuse(`Boat ${boatId} is chartered or held whole on ${trip.service_date}: a seat booking can't go on it`, 409, 'boat_chartered');
    const load = (input.others.get(boatId) ?? 0) + mine;
    if (load <= boat.sellable + BOAT_TOLERANCE) continue;
    const at = `Boat ${boatId} would carry ${load} on ${trip.service_date} (capacity ${boat.sellable}, at most ${boat.sellable + BOAT_TOLERANCE})`;
    const lic = boat.license_pax;
    if (lic && load - BOAT_TOLERANCE > lic) refuse(`${at}; licensed seats ${lic}: assign another boat, or add a boat`, 409, 'over_licence');
    if (!input.raise) refuse(`${at}. Raising the day's capacity needs act-capunlock: send raise_capacity with a reason`, 409, 'boat_full');
    if (!input.mayRaise) refuse(`${at}. Raising the day's capacity needs an admin or the act-capunlock right`, 403, 'forbidden');
    raises.push({ boat_id: boatId, capacity: lic ? Math.min(lic, load) : load, reason: input.raise!.reason });
  }
  return raises;
}

/** `§chOpsSync`: a charter trip's boat follows its charter boat, unless it is split over boats. Undefined when nothing changes. */
export function charterSynced(trip: { booking_mode: string; charter_boat_id?: string }, d: StoredDispatch | undefined): StoredDispatch | undefined {
  if (trip.booking_mode !== 'charter' || !trip.charter_boat_id) return undefined;
  const current = d ?? EMPTY_DISPATCH;
  if (current.boat_splits.length || current.boat_id === trip.charter_boat_id) return undefined;
  return { ...copy(current), boat_id: trip.charter_boat_id };
}
