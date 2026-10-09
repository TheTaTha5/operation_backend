/**
 * Where fleet part A (assets, incidents, jobs) and part B (stock, memos, Daily Fleet Log, projects)
 * meet, wired after both merged (todo/fleet-maintenance-model.md, "Open (part A)" 1). Pure, so both
 * stores decide identically:
 *
 * - a project in progress or on hold holds its boat (`projectWork`, legacy `boatJobBlock`);
 * - an engine's hours read the Daily Fleet Log's meters (`meterHours`, legacy `flEngHours`);
 * - a job's cost counts its memos (`linkedMemos`, legacy `flMaintCalcCost`);
 * - a job's parts come out of stock and go back (`planJobPartAdd`/`planJobPartRemove`, legacy
 *   `flMaintAddPart`/`flMaintRemovePart`), as append-only movements;
 * - a project sees its child jobs (`projectJobs`) and closes or unlinks them (`flProjMarkComplete`,
 *   `flProjWorkDone`, `flProjCancel`).
 */
import { assertKnown, bad, bool, conflict, isoDate, newFleetId, notFound, positive, record, required, WAREHOUSES } from './fleet-common.js';
import { engineHours, type Engine, type MeterReading } from './fleet-assets.js';
import { jobCost, type Job, type JobPart, type LinkedMemo } from './fleet-jobs.js';
import type { OpenWork } from './fleet-availability.js';
import { assertStock, movement, type Ctx, type Movement, type NewMovement, type StockItem } from './fleet-stock.js';
import type { Memo } from './fleet-memos.js';
import type { Project, ProjectJobs } from './fleet-projects.js';
import type { Meter } from './fleet-daily.js';

/** A project holds its boat from its actual (else planned) start while in progress or on hold. */
export function projectWork(p: Pick<Project, 'id' | 'no' | 'boat_id' | 'status' | 'type' | 'actual_from' | 'plan_from'>): OpenWork | null {
  if (!p.boat_id || (p.status !== 'inprogress' && p.status !== 'on_hold')) return null;
  return { kind: 'project', id: p.id, no: p.no, boat_id: p.boat_id, status: 'unavailable', from: p.actual_from ?? p.plan_from, reason: p.type === 'drydock' ? 'dry_dock' : 'overhaul' };
}

/** Each engine's hours: what it came in with plus what its Daily Log meter ran (every trip type). */
export function meterHours(meters: readonly Pick<Meter, 'engine_id' | 'date' | 'reading'>[]): (e: Pick<Engine, 'id' | 'base_hours'>) => number {
  const by = new Map<string, MeterReading[]>();
  for (const m of meters) {
    if (m.reading === null) continue;
    const list = by.get(m.engine_id) ?? [];
    list.push({ date: m.date, reading: m.reading });
    by.set(m.engine_id, list);
  }
  return (e) => engineHours(e, by.get(e.id) ?? []);
}

/** The memos naming each job, in the shape a job's cost reads them. */
export function linkedMemos(memos: readonly Memo[]): (jobId: string) => LinkedMemo[] {
  const by = new Map<string, LinkedMemo[]>();
  for (const m of memos) {
    if (!m.job_id) continue;
    const list = by.get(m.job_id) ?? [];
    list.push({ status: m.status, memo_type: m.memo_type, amount: m.amount, item_names: m.lines.map((l) => l.name) });
    by.set(m.job_id, list);
  }
  return (id) => by.get(id) ?? [];
}

/** A project's child jobs (`parent_project_id`): their cost with memos, and whether still open. */
export function projectJobs(jobs: readonly Job[], memosOf: (jobId: string) => LinkedMemo[], projectId: string): ProjectJobs {
  return { jobs: jobs.filter((j) => j.parent_project_id === projectId).map((j) => ({ id: j.id, cost: jobCost(j.parts, memosOf(j.id)).cost, open: j.status !== 'done' })) };
}

const line = (today: string, text: string, by: string | null) => ({ date: today, text, by, created_on: null });

/** Closing a project closes its open child jobs (legacy cascade: done, end date, a line; no outcome). */
export function closedChildJobs(jobs: readonly Job[], projectNo: string, text: (no: string) => string, today: string): Job[] {
  return jobs.filter((j) => j.status !== 'done').map((j) => ({
    ...j, status: 'done' as const, end_date: j.end_date ?? today, progress_log: [...j.progress_log, line(today, text(projectNo), 'cascade')],
  }));
}
/** Cancelling a project with `unlink_jobs: true` lets its open child jobs go on alone (legacy's confirm). */
export function unlinkedChildJobs(jobs: readonly Job[], projectNo: string, today: string, by: string | null): Job[] {
  return jobs.filter((j) => j.status !== 'done').map((j) => ({
    ...j, parent_project_id: null, progress_log: [...j.progress_log, line(today, `Unlinked from cancelled project ${projectNo}`, by)],
  }));
}

/** A job part's warehouse, written as legacy's label (part A imports labels in all eight spellings). */
export function warehouseOfLabel(label: string | null): string | null {
  const k = (label ?? '').toLowerCase().replace(/คลัง/g, '').replace(/\s+/g, '');
  if (WAREHOUSES.some((w) => w.id === label)) return label;
  if (k === 'tublamu') return 'tublamu';
  if (k === 'visitpanwa' || k === 'visitpanda' || k === 'panwa') return 'panwa';
  if (k === 'ranong') return 'ranong';
  return null;
}
const nameOf = (id: string) => WAREHOUSES.find((w) => w.id === id)!.name;
const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });

/**
 * `POST /v1/fleet/jobs/{id}/parts` (legacy `flMaintAddPart`): take a part out of one warehouse for the
 * job. Refused: no item, no warehouse, more than the warehouse holds (`409 stock_short`; a job part
 * never goes below zero, decision 7). On a closed job it is a late edit: `late_anyway: true` (legacy's
 * confirm), and the part is marked late. A part already taken today from the same warehouse adds up.
 */
export function planJobPartAdd(job: Job, item: StockItem | undefined, movements: readonly Movement[], raw: unknown, ctx: Ctx): { job: Job; movement: NewMovement } {
  const b = record(raw);
  assertKnown(b, ['item_id', 'warehouse', 'qty', 'late_anyway', 'date'], 'A job part');
  required(b.item_id, 'item_id', 'item_id is required: pick a part from stock');
  if (!item) notFound(`Stock item ${String(b.item_id)} not found`);
  const warehouse = typeof b.warehouse === 'string' ? warehouseOfLabel(b.warehouse) ?? bad('warehouse must be tublamu, panwa or ranong') : bad('warehouse is required: pick a warehouse first');
  const qty = b.qty === undefined ? 1 : positive(b.qty, 'qty');
  const late = job.status === 'done';
  if (late && !(bool(b.late_anyway, 'late_anyway') ?? false)) conflict(`${job.no} is closed: adding a part is a late edit; send late_anyway: true`, 'job_closed');
  assertStock(item!, movements, warehouse, qty);
  const date = isoDate(b.date, 'date') ?? ctx.today;
  const label = nameOf(warehouse);
  const lateTag = late ? ' · ลงย้อนหลังหลังปิดงาน' : '';
  const parts: JobPart[] = job.parts.map((p) => ({ ...p }));
  const same = parts.find((p) => p.inv_id === item!.id && warehouseOfLabel(p.location) === warehouse && p.date === date && p.late === late);
  if (same) same.qty = Math.round((same.qty + qty) * 100) / 100;
  else parts.push({ id: newFleetId('p'), inv_id: item!.id, name: item!.name, qty, unit: item!.unit, cost: item!.cost, location: label, date, late, late_by: late ? ctx.by : null });
  const text = `📦 เบิก ${item!.name} ${qty} ${item!.unit} · ${label} (฿${fmt(qty * item!.cost)})${lateTag}`;
  return {
    job: { ...job, parts, progress_log: [...job.progress_log, line(ctx.today, text, late ? ctx.by : 'ระบบ')] },
    movement: movement(ctx, {
      item_id: item!.id, type: 'withdraw', warehouse, qty, date, job_id: job.id, by: 'ระบบ',
      note: `เบิกใช้งาน ${job.no} · ${job.title} · @ ${label}${late ? ' · ลงย้อนหลัง (งานปิดแล้ว)' : ''}`,
    }),
  };
}

/**
 * `DELETE /v1/fleet/jobs/{id}/parts/{idx}` (legacy `flMaintRemovePart`): the part goes back to the
 * warehouse it came from (a `return` movement). A part with no stock item (legacy's free text) only
 * comes off the job. On a closed job: `late_anyway=true`.
 */
export function planJobPartRemove(job: Job, idx: number, item: StockItem | undefined, lateAnyway: boolean, ctx: Ctx): { job: Job; movement: NewMovement | null } {
  const part = job.parts[idx] ?? notFound(`${job.no} has no part ${idx}`);
  const late = job.status === 'done';
  if (late && !lateAnyway) conflict(`${job.no} is closed: taking a part off is a late edit; send late_anyway=true`, 'job_closed');
  const warehouse = warehouseOfLabel(part.location) ?? 'tublamu';
  const tag = late ? ' · แก้ย้อนหลังหลังปิดงาน' : '';
  const mv = item && part.qty > 0
    ? movement(ctx, { item_id: item.id, type: 'return', warehouse, qty: part.qty, job_id: job.id, by: 'ระบบ', note: `คืนสต็อก (ยกเลิกเบิก ${job.no}) · @ ${nameOf(warehouse)}` })
    : null;
  return {
    job: {
      ...job, parts: job.parts.filter((_, i) => i !== idx),
      progress_log: [...job.progress_log, line(ctx.today, `↩ ยกเลิกเบิก ${part.name ?? ''} ${part.qty} ${part.unit ?? ''} (คืนสต็อก)${tag}`, 'ระบบ')],
    },
    movement: mv,
  };
}
