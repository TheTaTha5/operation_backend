/**
 * Whether a boat can sail on a day (todo/fleet-maintenance-model.md, part A, decided 2026-10-09).
 * Copied from legacy's `boatEffStatus` and `boatJobBlock` (`04-data-core.js`): the status log a person
 * keeps, and the open work (maintenance jobs, projects) that still holds the boat, the stricter of the
 * two. Pure, so both stores, the deployment guard and the screens decide identically.
 */
import { refuse } from './booking-actions.js';
import type { BoatRecord, BoatStatus, StatusEntry } from './catalogue.js';

/** Work that holds a boat from `from` on (null: from the start), as `boatJobBlock` lists it. */
export type OpenWork = {
  kind: 'job' | 'project'; id: string; no: string; boat_id: string;
  status: 'fixing' | 'unavailable'; from: string | null; reason: string;
};
/** One piece of work holding the boat on the day asked about. */
export type Block = { kind: OpenWork['kind']; id: string; no: string; status: OpenWork['status']; reason: string };
export type Availability = {
  boat_id: string; service_date: string;
  /** What the day is: the stricter of the log and the work (`boatEffStatus`). */
  status: BoatStatus;
  /** The status log's own answer (`getStoredStatus`). */
  stored_status: BoatStatus;
  reason: string | null;
  /** A charter boat whose log does not cover the day: it is not ours that day (`§chWin`). */
  not_chartered: boolean;
  blocked_by: Block[];
  /** The work a person planned the boat ahead of, on the entry covering the day. */
  planned_over: string[] | null;
};

const RANK: Record<string, number> = { available: 0, fixing: 1, unavailable: 2, retired: 3 };
const rank = (status: string): number => RANK[status] ?? 0;

/** The job's hold on its boat (`boatJobBlock`): started, not run alongside the boat, not "available". */
export function jobWork(job: {
  id: string; no: string; boat_id: string; status: string; set_fixing: boolean; boat_status: string | null; boat_status_reason: string | null; start_date: string | null;
}): OpenWork | null {
  if (job.status !== 'inprogress' || job.set_fixing === false) return null;
  const status = job.boat_status ?? 'fixing';
  if (status === 'available') return null;
  return { kind: 'job', id: job.id, no: job.no, boat_id: job.boat_id, status: status as OpenWork['status'], from: job.start_date, reason: job.boat_status_reason ?? '' };
}

/**
 * The entry covering `date` (legacy `getStoredStatus`'s row): of those covering it, the one starting
 * latest; two starting the same day, the one added later.
 */
export function coveringEntry(log: readonly StatusEntry[], date: string): StatusEntry | undefined {
  return log.map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.from_date < b.e.from_date ? 1 : a.e.from_date > b.e.from_date ? -1 : b.i - a.i))
    .find(({ e }) => e.from_date <= date && (e.to_date === null || e.to_date >= date))?.e;
}

/**
 * The work holding `boatId` on `date` (`boatJobBlock`): the strictest status, every piece of work, and
 * the reason of the first that sets it. `skip` is what a planned-ahead entry names (`ovrJobs`).
 */
export function workOn(work: readonly OpenWork[], boatId: string, date: string, skip: readonly string[] | null = null): { status: 'available' | OpenWork['status']; blocked_by: Block[]; reason: string } {
  let status: 'available' | OpenWork['status'] = 'available';
  const blocked: Block[] = [];
  for (const w of work) {
    if (w.boat_id !== boatId) continue;
    if (w.from !== null && w.from > date) continue;
    if (skip && skip.includes(w.no)) continue;
    if (rank(w.status) > rank(status)) status = w.status;
    blocked.push({ kind: w.kind, id: w.id, no: w.no, status: w.status, reason: w.reason });
  }
  return { status, blocked_by: blocked, reason: blocked.find((b) => b.status === status)?.reason ?? '' };
}

/**
 * A boat on a day (`boatEffStatus`). Work decides only "can it sail": a log already saying fixing,
 * unavailable or retired is kept as the person wrote it, and a retired boat is its log's answer. The
 * work holding the boat is listed either way, as Boat Operation's pool lists the job numbers.
 */
export function availability(boat: Pick<BoatRecord, 'id' | 'ownership' | 'retired' | 'status_log'>, date: string, work: readonly OpenWork[]): Availability {
  const entry = coveringEntry(boat.status_log, date);
  const stored: BoatStatus = entry ? entry.status : boat.ownership === 'charter' ? 'unavailable' : 'available';
  const plannedOver = entry && entry.status === 'available' ? entry.planned_over : null;
  const held = workOn(work, boat.id, date, plannedOver);
  const byWork = !boat.retired && rank(stored) === 0 && rank(held.status) > 0;
  return {
    boat_id: boat.id, service_date: date,
    status: byWork ? held.status : stored, stored_status: stored,
    reason: byWork ? held.reason || null : entry?.reason ?? null,
    not_chartered: !entry && boat.ownership === 'charter',
    blocked_by: held.blocked_by, planned_over: plannedOver ?? null,
  };
}

const describe = (a: Availability): string => {
  const nos = a.blocked_by.map((b) => b.no).join(', ');
  if (a.not_chartered) return 'it is not chartered that day';
  return `${a.status}${a.reason ? ` (${a.reason})` : ''}${nos ? `, held by ${nos}` : ''}`;
};

export type ReadinessWarning = { code: 'boat_not_ready'; boat_id: string; service_date: string; status: BoatStatus; not_chartered: boolean; blocked_by: Block[] };

/**
 * Deploying a boat that is not ready that day (decided 2026-10-09): legacy's Boat Operation only lists
 * it as N/A and its bulk forms skip it, so here it needs `deploy_anyway` and is then a warning.
 */
export function checkBoatReady(boatName: string, a: Availability, anyway: boolean): ReadinessWarning | undefined {
  if (a.status === 'available') return undefined;
  if (!anyway) refuse(`${boatName} is not ready on ${a.service_date}: ${describe(a)}. Send deploy_anyway: true to deploy it anyway`, 409, 'boat_not_ready');
  return { code: 'boat_not_ready', boat_id: a.boat_id, service_date: a.service_date, status: a.status, not_chartered: a.not_chartered, blocked_by: a.blocked_by };
}

// ── Planned ahead (legacy `saveStatus`, `§boatPlanAhead`) ──

/** What legacy writes into the note, since its sync drops a new field (`LA_PLAN_MARK`). */
export const PLAN_MARK = 'วางล่วงหน้าทั้งที่ยังมีงานค้าง · ';

/** The numbers a legacy note marks as planned over (`laRowPlanJobs`): `MJ-038 · PRJ-014`, up to other text. */
export function plannedOverFromNote(note: string | null): string[] | null {
  const n = note ?? '';
  const i = n.indexOf(PLAN_MARK);
  if (i < 0) return null;
  const out: string[] = [];
  for (const part of n.slice(i + PLAN_MARK.length).split(' · ')) {
    const t = part.trim();
    if (!/^[A-Za-z]{2,6}-\d+$/.test(t)) break;
    out.push(t);
  }
  return out.length ? out : null;
}

/**
 * An `available` entry saved while work still holds the boat on its first day: legacy asks, and going
 * ahead plans the boat ahead of that work for the entry's days (later work still holds it). Read raw,
 * ignoring what the boat was planned ahead of before (`§boatPlanAhead2`). Any other entry carries none.
 */
export function planAhead(entry: StatusEntry, boatName: string, boatId: string, work: readonly OpenWork[], confirmed: boolean): StatusEntry {
  if (entry.status !== 'available') return { ...entry, planned_over: null };
  const held = workOn(work, boatId, entry.from_date);
  if (!held.blocked_by.length) return { ...entry, planned_over: null };
  const nos = held.blocked_by.map((b) => b.no);
  if (!confirmed) {
    refuse(`${boatName} still has open work: ${nos.join(', ')}. If the boat really sails again, close that work instead. Send plan_ahead: true to plan the boat ahead from ${entry.from_date} to ${entry.to_date ?? 'open'}: that work stops holding it on those days, later work still does`, 409, 'open_work');
  }
  const mark = PLAN_MARK + nos.join(' · ');
  const note = entry.note ?? '';
  return { ...entry, planned_over: nos, note: note.includes(mark) ? note : note ? `${note} · ${mark}` : mark };
}
