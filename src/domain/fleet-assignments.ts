/**
 * A boat's pier assignments (legacy `boats.assignments`, `05-fleet.js` `flSaveAssignment`,
 * `flCancelAssignment`; `04-data-core.js` `getActiveAssignment`, `getBoatCurrentPier`) and the pier a
 * boat works from on a day. Pure, so both stores decide identically (todo/fleet-maintenance-model.md,
 * "Design — extras" 1).
 */
import type { BoatRecord } from './catalogue.js';
import { coveringEntry } from './fleet-availability.js';
import { assertKnown, bad, conflict, isoDate, newFleetId, nonNegative, parsePier, record, round2, text } from './fleet-common.js';

export const ASSIGNMENT_TYPES = ['temporary', 'permanent'] as const;
export type Assignment = {
  id: string; boat_id: string; type: typeof ASSIGNMENT_TYPES[number]; from_pier: string; to_pier: string; start_date: string; end_date: string;
  reason: string | null; cost: number; cancelled: boolean; cancelled_at: string | null; cancelled_by: string | null;
  created_date: string; created_at: string; created_by: string | null;
};
export type AssignmentStatus = 'planned' | 'active' | 'completed' | 'cancelled';
type Ctx = { now: string; today: string; by: string | null };

/** Legacy's `flAutoUpdateAssignments` rule, read on every view (legacy never refreshed the stored one). */
export const assignmentStatus = (a: Pick<Assignment, 'cancelled' | 'start_date' | 'end_date'>, today: string): AssignmentStatus =>
  a.cancelled ? 'cancelled' : a.start_date <= today && a.end_date >= today ? 'active' : a.end_date < today ? 'completed' : 'planned';
export const assignmentView = (a: Assignment, today: string) => ({ ...a, status: assignmentStatus(a, today) });

/** Oldest first: legacy's array order, which decides between two covering one day. */
export const sortAssignments = (list: readonly Assignment[]): Assignment[] =>
  [...list].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));

/** The assignment covering `date` (legacy: the first not cancelled with `start <= date <= end`). */
export function coveringAssignment(list: readonly Assignment[], boatId: string, date: string): Assignment | undefined {
  return sortAssignments(list).find((a) => a.boat_id === boatId && !a.cancelled && a.start_date <= date && a.end_date >= date);
}

/** Legacy's boat panels: the active one, the planned ones (soonest first), the past ones (latest first). */
export function assignmentPanels(list: readonly Assignment[], boatId: string, today: string) {
  const live = sortAssignments(list).filter((a) => a.boat_id === boatId && !a.cancelled);
  const active = live.find((a) => a.start_date <= today && a.end_date >= today) ?? null;
  return {
    active: active && assignmentView(active, today),
    planned: live.filter((a) => a.start_date > today).sort((a, b) => a.start_date.localeCompare(b.start_date)).map((a) => assignmentView(a, today)),
    past: live.filter((a) => a.end_date < today).sort((a, b) => b.end_date.localeCompare(a.end_date)).map((a) => assignmentView(a, today)),
  };
}

/** The pier a status-log location names (legacy `getBoatCurrentPier`'s keyword step). */
export function pierOfLocation(loc: string | null): string | null {
  const l = (loc ?? '').toLowerCase();
  if (l.includes('panwa')) return 'panwa';
  if (l.includes('ranong') || l.includes('grand andaman') || l.includes('se la va')) return 'ranong';
  if (l.includes('tub') || l.includes('tublamu') || l.includes('tab lamu')) return 'tublamu';
  return null;
}

/**
 * The pier a boat works from on `date` (legacy `getBoatCurrentPier` without its shop step): the
 * assignment covering the day, else the pier its status entry that day names, else its home pier.
 */
export function pierOn(boat: Pick<BoatRecord, 'id' | 'pier' | 'status_log'>, date: string, assignments: readonly Assignment[]): string | null {
  const a = coveringAssignment(assignments, boat.id, date);
  if (a) return a.to_pier;
  return pierOfLocation(coveringEntry(boat.status_log, date)?.loc ?? null) ?? boat.pier;
}

/** The started job holding the boat at a shop (legacy's `'shop'` step, `getBoatShopLocation`): its location. */
export function shopOf(jobs: readonly { boat_id: string; status: string; location: string | null; boat_status: string | null; set_fixing: boolean }[], boatId: string, held: boolean): string | null {
  if (!held) return null;
  const j = jobs.find((m) => m.boat_id === boatId && m.status === 'inprogress' && (m.location ?? '').trim()
    && (m.boat_status ?? (m.set_fixing === false ? 'available' : 'fixing')) !== 'available');
  return j ? j.location!.trim() : null;
}

/** The Daily Fleet Log's pier for a boat (legacy `_drPier`): at the shop it is the home pier. */
export const dailyPier = (boat: Pick<BoatRecord, 'id' | 'pier' | 'status_log'>, date: string, assignments: readonly Assignment[], atShop: boolean): string | null =>
  (atShop ? boat.pier : pierOn(boat, date, assignments));

/**
 * `POST /v1/boats/{id}/assignments` (legacy `flSaveAssignment`). A permanent assignment active on the
 * day it is saved moves the boat's home pier (`boat_pier`); one starting later never does (legacy).
 */
export function planAssignment(boat: Pick<BoatRecord, 'id' | 'pier'>, raw: unknown, ctx: Ctx): { assignment: Assignment; boat_pier: string | null } {
  const b = Object.fromEntries(Object.entries(record(raw)).map(([k, v]) => [({ fromPier: 'from_pier', toPier: 'to_pier', startDate: 'start_date', endDate: 'end_date' } as Record<string, string>)[k] ?? k, v]));
  assertKnown(b, ['type', 'from_pier', 'to_pier', 'start_date', 'end_date', 'reason', 'cost'], 'An assignment');
  const type = b.type === undefined ? 'temporary' : (ASSIGNMENT_TYPES as readonly unknown[]).includes(b.type) ? b.type as Assignment['type'] : bad('type must be temporary or permanent');
  const from = parsePier(b.from_pier, 'from_pier');
  const to = parsePier(b.to_pier, 'to_pier');
  if (from === to) bad('from_pier and to_pier must differ (From และ To ต้องต่างกัน)');
  const start = isoDate(b.start_date, 'start_date');
  const end = isoDate(b.end_date, 'end_date');
  if (!start || !end) bad('start_date and end_date are required (กรุณาระบุวันเริ่ม-วันจบ)');
  if (end! < start!) bad('end_date must not precede start_date (วันจบต้องหลังวันเริ่ม)');
  const assignment: Assignment = {
    id: newFleetId('asn'), boat_id: boat.id, type, from_pier: from, to_pier: to, start_date: start!, end_date: end!,
    reason: text(b.reason, 'reason'), cost: round2(nonNegative(b.cost, 'cost') ?? 0), cancelled: false, cancelled_at: null, cancelled_by: null,
    created_date: ctx.today, created_at: ctx.now, created_by: ctx.by,
  };
  const movesHome = type === 'permanent' && assignmentStatus(assignment, ctx.today) === 'active';
  return { assignment, boat_pier: movesHome ? to : boat.pier };
}

/** `POST …/assignments/{id}/cancel` (legacy `flCancelAssignment`): kept, marked cancelled; a home pier it moved stays. */
export function planAssignmentCancel(a: Assignment, ctx: Ctx): Assignment {
  if (a.cancelled) conflict('This assignment is already cancelled', 'already_cancelled');
  return { ...a, cancelled: true, cancelled_at: ctx.now, cancelled_by: ctx.by };
}
