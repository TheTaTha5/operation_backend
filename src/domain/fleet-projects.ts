/**
 * Fleet projects: drydock, overhaul, refit (legacy `fleet_projects`, `05-fleet.js` `flProj*`;
 * todo/fleet-maintenance-model.md, "Design — part B"). Pure, so both stores decide identically.
 *
 * The lifecycle, the bill gate (`flProjBillGate`), the health score (`flProjHealth`) and the boat
 * log entries a project writes are legacy's. Kept here where legacy loses them: when the work was
 * done, the bill note, a "no cost" close and when the bill was closed. A project's documents are
 * files in `/v1/attachments` (or a pasted link, as legacy allows).
 *
 * A project's child maintenance jobs are part A's: their cost, whether they are open, and closing
 * or unlinking them come through `ProjectJobs`, which answers nothing until the two are wired.
 */
import { assertKnown, bad, bool, conflict, dayGap, isoDate, newFleetId, nonNegative, notFound, record, required, round2, text } from './fleet-common.js';
import { entryIdMaker, type BoatRecord, type StatusEntry } from './catalogue.js';
import { SPENT, type Memo } from './fleet-memos.js';

export const PROJECT_TYPES = ['drydock', 'overhaul', 'refit', 'scheduled', 'other'] as const;
export const PROJECT_STATUSES = ['planned', 'inprogress', 'on_hold', 'awaiting_bill', 'completed', 'cancelled'] as const;
export type ProjectStatus = typeof PROJECT_STATUSES[number];
export const DOC_STATUSES = ['required', 'pending', 'received', 'verified'] as const;
/** Legacy `PROJ_PHASES`: each type's phases, in order. */
export const PROJECT_PHASES: Record<string, { k: string; label: string }[]> = {
  drydock: [{ k: 'planning', label: 'Planning' }, { k: 'liftout', label: 'Lift-out' }, { k: 'hull', label: 'Hull / Paint' }, { k: 'mechanical', label: 'Mechanical' }, { k: 'sea_trial', label: 'Sea Trial' }, { k: 'handover', label: 'Handover' }],
  overhaul: [{ k: 'planning', label: 'Planning' }, { k: 'disassembly', label: 'Disassembly' }, { k: 'install', label: 'Install' }, { k: 'test', label: 'Bench Test' }, { k: 'sea_trial', label: 'Sea Trial' }, { k: 'handover', label: 'Handover' }],
  refit: [{ k: 'planning', label: 'Planning' }, { k: 'strip', label: 'Strip-out' }, { k: 'rebuild', label: 'Rebuild' }, { k: 'finishing', label: 'Finishing' }, { k: 'handover', label: 'Handover' }],
  scheduled: [{ k: 'planning', label: 'Planning' }, { k: 'service', label: 'Service' }, { k: 'test', label: 'Test' }, { k: 'handover', label: 'Handover' }],
  other: [{ k: 'planning', label: 'Planning' }, { k: 'execute', label: 'Execute' }, { k: 'verify', label: 'Verify' }, { k: 'handover', label: 'Handover' }],
};
export const phasesFor = (type: string | null) => PROJECT_PHASES[type ?? ''] ?? PROJECT_PHASES.other;
/** The documents legacy suggests per type (`flProjRenderDocsTab`). */
export function requiredDocuments(type: string | null): string[] {
  if (type === 'drydock') return ['ใบเสนอราคา (Quotation)', 'Work Order', 'Hull Survey Report', 'ใบรับรอง Anode', 'Paint Certificate', 'Sea Trial Report', 'Final Invoice'];
  if (type === 'overhaul') return ['ใบเสนอราคา', 'Work Order', 'Engine Pre-test Report', 'Engine Post-install Report', 'Sea Trial Report', 'Final Invoice'];
  return ['ใบเสนอราคา', 'Work Order', 'Completion Report', 'Final Invoice'];
}

export type PlanItem = { id: string; text: string; done: boolean; added_at: string | null; done_date: string | null };
export type ProjectDoc = {
  id: string; name: string; attachment_id: string | null; url: string | null; mime: string | null; size: number | null; note: string | null;
  type: 'photo' | null; phase: string | null; status: string; added_at: string | null; by: string | null;
};
export type VendorVisit = { id: string; vendor: string; role: string | null; date: string; by: string | null };
export type NoCost = { reason: string; by: string | null; at: string };
export type Project = {
  id: string; no: string; name: string; boat_id: string | null; type: string | null; vendor: string | null; plan_from: string | null; plan_to: string | null;
  original_plan_to: string | null; actual_from: string | null; actual_to: string | null; status: ProjectStatus; planned_budget: number; notes: string | null;
  phase: string | null; hold_reason: string | null; hold_since: string | null; cancel_reason: string | null; cancelled_on: string | null;
  work_done_on: string | null; bill_note: string | null; no_cost: NoCost | null; bill_closed_on: string | null;
  created_at: string; created_by: string | null; updated_at: string;
  plan: PlanItem[]; documents: ProjectDoc[]; vendor_visits: VendorVisit[];
};
export type ProjectLog = { project_id: string; date: string; text: string; by: string | null };

/** What part A's jobs tell a project: each child job's cost and whether it is still open. */
export type ProjectJobs = { jobs: { id: string; cost: number; open: boolean }[] };
export type Ctx = { now: string; today: string; by: string | null };
export type ProjectPlan = { project: Project; log: ProjectLog[]; boat?: BoatRecord };

const line = (p: Pick<Project, 'id'>, ctx: Ctx, textLine: string): ProjectLog => ({ project_id: p.id, date: ctx.today, text: textLine, by: ctx.by });
const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });

// ── Input ──

const ALIASES: Record<string, string> = { boatId: 'boat_id', planFrom: 'plan_from', planTo: 'plan_to', plannedBudget: 'planned_budget', budget: 'planned_budget' };
const unalias = (b: Record<string, unknown>) => Object.fromEntries(Object.entries(b).map(([k, v]) => [ALIASES[k] ?? k, v]));
const FIELDS = ['no', 'name', 'boat_id', 'type', 'vendor', 'plan_from', 'plan_to', 'planned_budget', 'notes', 'phase', 'bill_note'] as const;

/** What `PATCH` may not change, and what to use instead. */
export const PROJECT_SERVER_OWNED: Record<string, string> = {
  id: 'a project keeps its id', status: 'use the project commands (start, hold, resume, cancel, reopen, work-done, bill-back, complete)',
  original_plan_to: 'it is the plan end at creation, kept as the baseline', originalPlanTo: 'it is the baseline', actual_from: 'it is set by POST /v1/fleet/projects/{id}/start',
  actualFrom: 'it is set by start', actual_to: 'it is set by work-done or complete', actualTo: 'it is set by work-done or complete',
  hold_reason: 'use POST /v1/fleet/projects/{id}/hold', hold_since: 'use hold', cancel_reason: 'use POST /v1/fleet/projects/{id}/cancel', cancelled_on: 'use cancel',
  work_done_on: 'use POST /v1/fleet/projects/{id}/work-done', no_cost: 'use POST /v1/fleet/projects/{id}/complete with no_cost_reason', bill_closed_on: 'use complete',
  created_at: 'it is set at creation', created_by: 'it is set at creation', updated_at: 'it is set by every write', plan: 'use /v1/fleet/projects/{id}/plan',
  documents: 'use /v1/fleet/projects/{id}/documents', docs: 'use /v1/fleet/projects/{id}/documents', vendor_visits: 'use /v1/fleet/projects/{id}/vendor-visits',
  vendorVisits: 'use /v1/fleet/projects/{id}/vendor-visits', log: 'it is written by every change', cost: 'it is computed', cost_breakdown: 'it is computed',
  bill_gate: 'it is computed', health: 'it is computed', required_documents: 'it is computed', memos: 'it is computed', phase_index: 'it is computed', phases: 'it is computed',
};

function parseFields(raw: Record<string, unknown>, current?: Project): Partial<Project> {
  const b = unalias(raw);
  assertKnown(b, FIELDS, 'A project');
  const out: Partial<Project> = {};
  if (!current) out.no = required(b.no, 'no', 'no is required: the project number (PRJ-…), as legacy numbers it');
  else if (b.no !== undefined && text(b.no, 'no') !== current.no) bad('no cannot be changed: a project keeps its number');
  if (!current || b.name !== undefined) out.name = required(b.name, 'name', 'Project name is required');
  if (!current && !('boat_id' in b)) bad('boat_id is required: a boat, or null for a General (non-vessel) project');
  if (b.boat_id !== undefined) out.boat_id = text(b.boat_id, 'boat_id');
  if (!current || b.type !== undefined) {
    const t = b.type ?? 'drydock';
    out.type = (PROJECT_TYPES as readonly unknown[]).includes(t) ? t as string : bad(`type must be one of ${PROJECT_TYPES.join(', ')}`);
  }
  if (b.vendor !== undefined) out.vendor = text(b.vendor, 'vendor');
  if (!current || b.plan_from !== undefined) out.plan_from = isoDate(b.plan_from, 'plan_from') ?? bad('Planned start is required (plan_from)');
  if (b.plan_to !== undefined) out.plan_to = isoDate(b.plan_to, 'plan_to');
  if (b.planned_budget !== undefined) out.planned_budget = round2(nonNegative(b.planned_budget, 'planned_budget') ?? 0);
  if (b.notes !== undefined) out.notes = text(b.notes, 'notes');
  if (b.bill_note !== undefined) out.bill_note = text(b.bill_note, 'bill_note');
  const from = out.plan_from ?? current?.plan_from ?? null;
  const to = out.plan_to !== undefined ? out.plan_to : current?.plan_to ?? null;
  if (from && to && to < from) bad('Planned end must be after start');
  if (b.phase !== undefined) {
    const phase = text(b.phase, 'phase');
    const type = out.type ?? current?.type ?? null;
    if (phase !== null && !phasesFor(type).some((p) => p.k === phase)) bad(`phase must be one of ${phasesFor(type).map((p) => p.k).join(', ')}`);
    out.phase = phase;
  }
  return out;
}

/** `POST /v1/fleet/projects` (legacy `flProjSaveModal`): `planned`, numbered by the client, its plan end kept as the baseline. */
export function planProjectCreate(raw: Record<string, unknown>, ctx: Ctx): ProjectPlan {
  const f = parseFields(raw);
  const project: Project = {
    id: newFleetId('proj'), no: f.no!, name: f.name!, boat_id: f.boat_id ?? null, type: f.type ?? 'drydock', vendor: f.vendor ?? null, plan_from: f.plan_from!,
    plan_to: f.plan_to ?? null, original_plan_to: f.plan_to ?? null, actual_from: null, actual_to: null, status: 'planned', planned_budget: f.planned_budget ?? 0,
    notes: f.notes ?? null, phase: f.phase ?? null, hold_reason: null, hold_since: null, cancel_reason: null, cancelled_on: null, work_done_on: null,
    bill_note: f.bill_note ?? null, no_cost: null, bill_closed_on: null, created_at: ctx.now, created_by: ctx.by, updated_at: ctx.now,
    plan: [], documents: [], vendor_visits: [],
  };
  return { project, log: [line(project, ctx, '+ Project created')] };
}

/** `PATCH /v1/fleet/projects/{id}`: the form's fields and the phase, each change logged as legacy does. */
export function planProjectPatch(p: Project, raw: Record<string, unknown>, ctx: Ctx): ProjectPlan {
  const f = parseFields(raw, p);
  const next: Project = { ...p, ...f, updated_at: ctx.now };
  const log: ProjectLog[] = [];
  if (f.phase !== undefined && f.phase !== p.phase) {
    const label = (k: string | null) => (k ? phasesFor(next.type).find((x) => x.k === k)?.label ?? k : '(none)');
    log.push(line(p, ctx, `Phase: ${label(p.phase)} → ${label(next.phase)}`));
  }
  const formKeys = Object.keys(f).filter((k) => k !== 'phase' && k !== 'bill_note');
  if (formKeys.length) {
    const planChanged = p.plan_to !== next.plan_to;
    log.push(line(p, ctx, `Project edited${p.boat_id !== next.boat_id ? ' · boat changed' : ''}${planChanged ? ` · planTo ${p.plan_to ?? 'Open'} → ${next.plan_to ?? 'Open'}` : ''}`));
  }
  if (f.bill_note !== undefined && f.bill_note !== p.bill_note) log.push(line(p, ctx, `Bill note: ${f.bill_note ?? '(none)'}`));
  return { project: next, log };
}

// ── The boat log a project writes (legacy pushes these entries itself, with `projectId`) ──

const entry = (id: string, e: Omit<Partial<StatusEntry>, 'planned_over'> & Pick<StatusEntry, 'status' | 'from_date'>): StatusEntry => ({
  id, to_date: null, loc: null, province: null, loc_type: null, detail: null, note: null, reason: null, project_id: null, planned_over: null, ...e,
});
const nowMs = (ctx: Ctx) => Date.parse(ctx.now);
function boatUnavailable(boat: BoatRecord, p: Project, ctx: Ctx): BoatRecord {
  const id = entryIdMaker(boat.status_log, nowMs(ctx))();
  return { ...boat, status_log: [...boat.status_log.map((e) => ({ ...e })), entry(id, {
    status: 'unavailable', from_date: ctx.today, loc: p.vendor ?? '', note: `Project ${p.no} · ${p.name}`, reason: p.type === 'drydock' ? 'dry_dock' : 'overhaul', project_id: p.id,
  })] };
}
/** Ends this project's open entries today and adds an available one (complete, work done, cancel). */
function boatReturned(boat: BoatRecord, p: Project, ctx: Ctx, note: string, suffix?: string): BoatRecord {
  const log = boat.status_log.map((e) => (e.project_id === p.id && e.to_date === null ? { ...e, to_date: ctx.today, note: suffix ? `${e.note ?? ''}${suffix}` : e.note } : { ...e }));
  const id = entryIdMaker(log, nowMs(ctx))();
  return { ...boat, status_log: [...log, entry(id, { status: 'available', from_date: ctx.today, note })] };
}

// ── Commands (legacy flProjStart, Hold, Resume, Cancel, Reopen, WorkDone, BillBack, MarkComplete, BillClose) ──

const assertStatus = (p: Project, allowed: readonly ProjectStatus[], what: string): void => {
  if (!allowed.includes(p.status)) conflict(`Project ${p.no} is ${p.status}; it can be ${what} only when ${allowed.join(' or ')}`, 'project_status');
};
const reasonOf = (raw: unknown, what: string): string => {
  const b = record(raw ?? {});
  assertKnown(b, ['reason'], what);
  return required(b.reason, 'reason', 'Reason required');
};

export function planStart(p: Project, boat: BoatRecord | undefined, ctx: Ctx): ProjectPlan {
  assertStatus(p, ['planned'], 'started');
  const next: Project = { ...p, status: 'inprogress', actual_from: p.actual_from ?? ctx.today, updated_at: ctx.now };
  return { project: next, log: [line(p, ctx, '▶ Project started · boat status → unavailable')], ...(boat ? { boat: boatUnavailable(boat, next, ctx) } : {}) };
}

export function planHold(p: Project, raw: unknown, ctx: Ctx): ProjectPlan {
  assertStatus(p, ['inprogress'], 'put on hold');
  const reason = reasonOf(raw, 'A hold');
  return { project: { ...p, status: 'on_hold', hold_reason: reason, hold_since: ctx.today, updated_at: ctx.now }, log: [line(p, ctx, `⏸ Project on hold · ${reason}`)] };
}

export function planResume(p: Project, ctx: Ctx): ProjectPlan {
  assertStatus(p, ['on_hold'], 'resumed');
  return {
    project: { ...p, status: 'inprogress', hold_reason: null, hold_since: null, updated_at: ctx.now },
    log: [line(p, ctx, `▶ Resumed${p.hold_reason ? ` (was on hold: ${p.hold_reason})` : ''}`)],
  };
}

export function planCancel(p: Project, raw: unknown, boat: BoatRecord | undefined, ctx: Ctx): ProjectPlan {
  if (p.status === 'completed') conflict('Completed projects cannot be cancelled', 'project_status');
  if (p.status === 'cancelled') conflict('Already cancelled', 'already_cancelled');
  const reason = reasonOf(raw, 'A cancel');
  const wasRunning = p.status === 'inprogress' || p.status === 'on_hold';
  const next: Project = { ...p, status: 'cancelled', cancel_reason: reason, cancelled_on: ctx.today, updated_at: ctx.now };
  return {
    project: next, log: [line(p, ctx, `✕ Project cancelled · ${reason}`)],
    ...(wasRunning && boat ? { boat: boatReturned(boat, p, ctx, `Returned · Project ${p.no} cancelled`, ' · project cancelled') } : {}),
  };
}

export function planReopen(p: Project, ctx: Ctx): ProjectPlan {
  assertStatus(p, ['cancelled'], 'reopened');
  return { project: { ...p, status: 'planned', cancel_reason: null, cancelled_on: null, updated_at: ctx.now }, log: [line(p, ctx, '↻ Reopened (back to planned)')] };
}

/** Legacy `flProjWorkDone`: the work is finished, the bill has not come; the boat goes back to work. */
export function planWorkDone(p: Project, raw: unknown, boat: BoatRecord | undefined, jobs: ProjectJobs, ctx: Ctx): ProjectPlan {
  const b = record(raw ?? {});
  assertKnown(b, ['note'], 'Work done');
  assertStatus(p, ['inprogress'], 'marked work done');
  const open = jobs.jobs.filter((j) => j.open).length;
  const next: Project = { ...p, status: 'awaiting_bill', work_done_on: p.work_done_on ?? ctx.today, actual_to: p.actual_to ?? ctx.today, bill_note: text(b.note, 'note'), updated_at: ctx.now };
  return {
    project: next, log: [line(p, ctx, `✓ งานเสร็จ · ปิด MJ ${open} ใบ · เรือกลับไปวิ่ง · รอใบวางบิล`)],
    ...(boat ? { boat: boatReturned(boat, p, ctx, `Returned from Project ${p.no} · รอใบวางบิล`) } : {}),
  };
}

/** Legacy `flProjBillBack`: the work is not finished after all; the boat is taken out of service again. */
export function planBillBack(p: Project, boat: BoatRecord | undefined, ctx: Ctx): ProjectPlan {
  assertStatus(p, ['awaiting_bill'], 'taken back to work');
  const next: Project = { ...p, status: 'inprogress', work_done_on: null, actual_to: null, updated_at: ctx.now };
  let nextBoat: BoatRecord | undefined;
  if (boat) {
    const closed = { ...boat, status_log: boat.status_log.map((e) => (e.status === 'available' && e.to_date === null ? { ...e, to_date: ctx.today } : { ...e })) };
    nextBoat = boatUnavailable(closed, next, ctx);
  }
  return { project: next, log: [line(p, ctx, '▶ ดึงกลับมาทำต่อ · งานยังไม่จบ')], ...(nextBoat ? { boat: nextBoat } : {}) };
}

// ── The bill gate, cost and health ──

/** Legacy `flProjBillDoc`: the first non-photo document whose name looks like an invoice. */
export const billDocument = (p: Pick<Project, 'documents'>): ProjectDoc | undefined =>
  p.documents.find((d) => d.type !== 'photo' && /final invoice|ใบวางบิล|invoice|ใบแจ้งหนี้/.test(d.name.toLowerCase()));
/** Legacy `flProjCalcCost`: the sum of the child jobs' cost. */
export const projectCost = (jobs: ProjectJobs): number => round2(jobs.jobs.reduce((s, j) => s + j.cost, 0));
/** Legacy `flProjBillGate`: an invoice among the documents and a cost above ฿0, unless closed as "no cost". */
export function billGate(p: Pick<Project, 'no_cost' | 'documents'>, cost: number): { ok: boolean; missing: string[]; cost: number } {
  if (p.no_cost) return { ok: true, missing: [], cost: 0 };
  const missing: string[] = [];
  if (!billDocument(p)) missing.push('ยังไม่ได้แนบ Final Invoice ในเอกสาร');
  if (!(cost > 0)) missing.push('ต้นทุนที่ลงไว้ยังเป็น ฿0 · ลงยอดที่ MJ ลูก หรือ Project Memo');
  return { ok: !missing.length, missing, cost };
}

/**
 * `POST …/complete` (legacy `flProjMarkComplete` from in progress, `flProjBillClose` from awaiting
 * the bill). The bill gate must pass; `no_cost_reason` is legacy's "close with no cost", which needs
 * a reason and passes it.
 */
export function planComplete(p: Project, raw: unknown, boat: BoatRecord | undefined, jobs: ProjectJobs, ctx: Ctx): ProjectPlan {
  const b = record(raw ?? {});
  assertKnown(b, ['no_cost_reason'], 'A completion');
  assertStatus(p, ['inprogress', 'awaiting_bill'], 'completed');
  let next: Project = { ...p };
  if (b.no_cost_reason !== undefined) {
    const reason = text(b.no_cost_reason, 'no_cost_reason') ?? bad('ปิดแบบไม่มีค่าใช้จ่าย ต้องเขียนเหตุผลไว้ในหมายเหตุ (no_cost_reason)');
    next = { ...next, no_cost: { reason, by: ctx.by, at: ctx.today }, bill_note: reason };
  }
  const gate = billGate(next, projectCost(jobs));
  if (!gate.ok) conflict(`Project ${p.no} cannot close yet: ${gate.missing.join(' · ')}`, 'bill_gate', { missing: gate.missing, cost: gate.cost });
  if (p.status === 'awaiting_bill') {
    return {
      project: { ...next, status: 'completed', actual_to: p.actual_to ?? ctx.today, bill_closed_on: ctx.today, updated_at: ctx.now },
      log: [line(p, ctx, `✓ ปิดบิล · ปิดโปรเจค · ต้นทุน ฿${fmt(gate.cost)}`)],
    };
  }
  const open = jobs.jobs.filter((j) => j.open).length;
  return {
    project: { ...next, status: 'completed', actual_to: p.actual_to ?? ctx.today, updated_at: ctx.now },
    log: [line(p, ctx, `✓ Project completed · cascade closed ${open} MJ(s) · boat → available`)],
    ...(boat ? { boat: boatReturned(boat, p, ctx, `Returned from Project ${p.no}`) } : {}),
  };
}

/** Legacy `flProjHealth`: 100 less penalties for budget, schedule, open jobs late in the plan, and a hold. */
export function projectHealth(p: Project, cost: number, jobs: ProjectJobs, today: string) {
  if (p.status === 'completed') return { key: 'completed', label: 'COMPLETED', score: 100 };
  if (p.status === 'cancelled') return { key: 'cancelled', label: 'CANCELLED', score: 0 };
  const budget = p.planned_budget || 0;
  const budgetPct = budget ? cost / budget * 100 : 0;
  let timePct = 0; let schedOver = 0;
  if (p.plan_from && p.plan_to) {
    const total = Math.max(1, dayGap(p.plan_from, p.plan_to));
    const elapsed = Math.max(0, dayGap(p.plan_from, today));
    timePct = Math.min(150, elapsed / total * 100);
    if (today > p.plan_to) schedOver = dayGap(p.plan_to, today);
  }
  const openRatio = jobs.jobs.length ? jobs.jobs.filter((j) => j.open).length / jobs.jobs.length : 0;
  let score = 100;
  if (budget && budgetPct > 100) score -= Math.min(40, (budgetPct - 100) * 1.5);
  if (budget && budgetPct >= 80 && budgetPct <= 100) score -= 5;
  if (schedOver > 0) score -= Math.min(35, schedOver * 2);
  if (timePct > 80 && openRatio > 0.5) score -= 15;
  if (p.status === 'on_hold') score -= 10;
  score = Math.max(0, Math.min(100, Math.round(score)));
  const [key, label] = score < 40 ? ['critical', 'CRITICAL'] : score < 70 ? ['atrisk', 'AT RISK'] : ['ontrack', 'ON TRACK'];
  return { key, label, score, budget_pct: round2(budgetPct), sched_over: schedOver, open_ratio: round2(openRatio) };
}

/** Legacy `flProjCostBreakdown`'s project-level part: the project's own memos by line category. */
export function projectMemoCost(memos: readonly Memo[]): { parts: number; labour: number; other: number; total: number } {
  let parts = 0; let labour = 0; let other = 0;
  for (const m of memos) {
    if (!SPENT.includes(m.status)) continue;
    if (!m.lines.length) { other += m.amount; continue; }
    for (const l of m.lines) {
      const sub = l.qty * l.price;
      if (l.category === 'labor') labour += sub; else if (l.category === 'parts') parts += sub; else other += sub;
    }
  }
  return { parts: round2(parts), labour: round2(labour), other: round2(other), total: round2(parts + labour + other) };
}

/** The project as read: cost, the bill gate, health, its phase and the documents still to get. */
export function projectView(p: Project, ctx: { jobs: ProjectJobs; memos: readonly Memo[]; today: string }) {
  const cost = projectCost(ctx.jobs);
  const phases = phasesFor(p.type);
  const phaseIndex = p.status === 'completed' ? phases.length - 1 : p.status === 'cancelled' ? -1
    : (p.phase ? phases.findIndex((x) => x.k === p.phase) : -1) >= 0 ? phases.findIndex((x) => x.k === p.phase) : p.status === 'inprogress' ? 1 : 0;
  const names = new Set(p.documents.filter((d) => d.type !== 'photo').map((d) => d.name.toLowerCase()));
  return {
    ...p,
    documents: p.documents.map((d) => ({ ...d, url: d.attachment_id ? `/v1/attachments/${encodeURIComponent(d.attachment_id)}` : d.url })),
    cost, cost_breakdown: { jobs: cost, project_memos: projectMemoCost(ctx.memos) }, bill_gate: billGate(p, cost),
    health: projectHealth(p, cost, ctx.jobs, ctx.today), phases, phase_index: phaseIndex,
    required_documents: requiredDocuments(p.type).filter((r) => !names.has(r.toLowerCase())),
    bill_days: p.status === 'awaiting_bill' && (p.work_done_on ?? p.actual_to) ? Math.max(0, dayGap((p.work_done_on ?? p.actual_to)!, ctx.today)) : 0,
  };
}

export function parseProjectListQuery(q: Record<string, unknown>): { status?: ProjectStatus; boat_id?: string } {
  const out: { status?: ProjectStatus; boat_id?: string } = {};
  if (q.status !== undefined) out.status = (PROJECT_STATUSES as readonly unknown[]).includes(q.status) ? q.status as ProjectStatus : bad(`status must be one of ${PROJECT_STATUSES.join(', ')}`);
  if (typeof q.boat_id === 'string' && q.boat_id) out.boat_id = q.boat_id;
  return out;
}
export const sortProjects = <T extends Pick<Project, 'no' | 'id'>>(list: T[]): T[] => list.sort((a, b) => a.no.localeCompare(b.no, 'en', { numeric: true }) || a.id.localeCompare(b.id));

// ── Plan items, documents, vendor visits (legacy flProjAddPlanItem…, flProjAddDoc…, flProjAddVendorVisit) ──

export function planPlanAdd(p: Project, raw: unknown, ctx: Ctx): ProjectPlan {
  const b = record(raw);
  assertKnown(b, ['text'], 'A plan item');
  const t = required(b.text, 'text');
  const item: PlanItem = { id: newFleetId('pl'), text: t, done: false, added_at: ctx.today, done_date: null };
  return { project: { ...p, plan: [...p.plan, item], updated_at: ctx.now }, log: [line(p, ctx, `+ Plan item: ${t}`)] };
}
export function planPlanSet(p: Project, itemId: string, raw: unknown, ctx: Ctx): ProjectPlan {
  const b = record(raw);
  assertKnown(b, ['done', 'text'], 'A plan item');
  const it = p.plan.find((x) => x.id === itemId) ?? notFound(`Plan item ${itemId} is not on project ${p.no}`);
  const done = bool(b.done, 'done') ?? it.done;
  const t = b.text === undefined ? it.text : required(b.text, 'text');
  const next: PlanItem = { ...it, text: t, done, done_date: done === it.done ? it.done_date : done ? ctx.today : null };
  const log = done !== it.done ? [line(p, ctx, `${done ? '✓' : '↺'} ${t}`)] : t !== it.text ? [line(p, ctx, `Plan item: ${it.text} → ${t}`)] : [];
  return { project: { ...p, plan: p.plan.map((x) => (x.id === itemId ? next : x)), updated_at: ctx.now }, log };
}
export function planPlanDelete(p: Project, itemId: string, ctx: Ctx): ProjectPlan {
  const it = p.plan.find((x) => x.id === itemId) ?? notFound(`Plan item ${itemId} is not on project ${p.no}`);
  return { project: { ...p, plan: p.plan.filter((x) => x.id !== itemId), updated_at: ctx.now }, log: [line(p, ctx, `- Plan item removed: ${it.text}`)] };
}

type FileRef = { id: string; name: string; mime: string; size: number };
/**
 * `POST …/documents`: a preset or named entry (no file: `pending`), a pasted link (`received`), or an
 * uploaded file by `attachment_id` (`received`); `type: photo` for the photo grid.
 */
export function planDocAdd(p: Project, raw: unknown, file: FileRef | undefined, ctx: Ctx): ProjectPlan {
  const b = unalias(record(raw));
  const x = Object.fromEntries(Object.entries(b).map(([k, v]) => [k === 'attId' ? 'attachment_id' : k, v]));
  assertKnown(x, ['name', 'attachment_id', 'url', 'note', 'type', 'phase', 'status'], 'A document');
  const type = x.type === undefined || x.type === null ? null : x.type === 'photo' ? 'photo' : bad('type must be photo, or left out for a document');
  const url = text(x.url, 'url');
  const name = text(x.name, 'name') ?? file?.name ?? (type === 'photo' ? `Photo · ${ctx.today}` : bad('Document name required'));
  const status = x.status === undefined ? (file || url || type === 'photo' ? 'received' : 'pending')
    : (DOC_STATUSES as readonly unknown[]).includes(x.status) ? x.status as string : bad(`status must be one of ${DOC_STATUSES.join(', ')}`);
  const doc: ProjectDoc = {
    id: newFleetId(type === 'photo' ? 'ph' : 'dc'), name, attachment_id: file?.id ?? null, url: file ? null : url, mime: file?.mime ?? null, size: file?.size ?? null,
    note: text(x.note, 'note'), type, phase: text(x.phase, 'phase') ?? (type === 'photo' ? p.phase ?? 'planning' : null), status, added_at: ctx.today, by: ctx.by,
  };
  const what = type === 'photo' ? `Photo added${doc.note ? `: ${doc.note}` : ''}` : file ? `+ Document: ${name} (file attached)` : `+ Document: ${name}`;
  return { project: { ...p, documents: [...p.documents, doc], updated_at: ctx.now }, log: [line(p, ctx, what)] };
}
/** `PATCH …/documents/{doc_id}`: its status, a file for a pending entry, its name or note. */
export function planDocSet(p: Project, docId: string, raw: unknown, file: FileRef | undefined, ctx: Ctx): ProjectPlan {
  const b = record(raw);
  const x = Object.fromEntries(Object.entries(b).map(([k, v]) => [k === 'attId' ? 'attachment_id' : k, v]));
  assertKnown(x, ['name', 'attachment_id', 'note', 'status', 'phase'], 'A document');
  const d = p.documents.find((y) => y.id === docId) ?? notFound(`Document ${docId} is not on project ${p.no}`);
  let next: ProjectDoc = { ...d };
  const log: ProjectLog[] = [];
  if (file) {
    next = { ...next, attachment_id: file.id, url: null, mime: file.mime, size: file.size, status: next.status === 'pending' || !next.status ? 'received' : next.status };
    log.push(line(p, ctx, `File attached to "${d.name}"`));
  }
  if (x.status !== undefined) {
    const status = (DOC_STATUSES as readonly unknown[]).includes(x.status) ? x.status as string : bad(`status must be one of ${DOC_STATUSES.join(', ')}`);
    if (status !== d.status) log.push(line(p, ctx, `Document "${d.name}" · ${d.status || 'pending'} → ${status}`));
    next.status = status;
  }
  if (x.name !== undefined) next.name = required(x.name, 'name');
  if (x.note !== undefined) next.note = text(x.note, 'note');
  if (x.phase !== undefined) next.phase = text(x.phase, 'phase');
  return { project: { ...p, documents: p.documents.map((y) => (y.id === docId ? next : y)), updated_at: ctx.now }, log };
}
export function planDocDelete(p: Project, docId: string, ctx: Ctx): ProjectPlan & { removed: ProjectDoc } {
  const d = p.documents.find((y) => y.id === docId) ?? notFound(`Document ${docId} is not on project ${p.no}`);
  return { project: { ...p, documents: p.documents.filter((y) => y.id !== docId), updated_at: ctx.now }, log: [line(p, ctx, `- Document removed: ${d.name}`)], removed: d };
}

export function planVisitAdd(p: Project, raw: unknown, ctx: Ctx): ProjectPlan {
  const b = record(raw);
  assertKnown(b, ['vendor', 'role', 'date'], 'A vendor visit');
  const vendor = required(b.vendor, 'vendor', 'Vendor / contractor name is required');
  const role = text(b.role, 'role');
  const visit: VendorVisit = { id: newFleetId('vv'), vendor, role, date: isoDate(b.date, 'date') ?? ctx.today, by: ctx.by };
  return { project: { ...p, vendor_visits: [...p.vendor_visits, visit], updated_at: ctx.now }, log: [line(p, ctx, `Vendor visit: ${vendor}${role ? ` · ${role}` : ''}`)] };
}
export function planVisitDelete(p: Project, visitId: string, ctx: Ctx): ProjectPlan {
  if (!p.vendor_visits.some((v) => v.id === visitId)) notFound(`Vendor visit ${visitId} is not on project ${p.no}`);
  return { project: { ...p, vendor_visits: p.vendor_visits.filter((v) => v.id !== visitId), updated_at: ctx.now }, log: [] };
}
