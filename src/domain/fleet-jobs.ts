/**
 * Incidents and maintenance jobs (todo/fleet-maintenance-model.md, part A, decided 2026-10-09).
 * Copied from legacy's Fleet → Incident and Maintenance screens and the job board (`05-fleet.js`):
 * `flSaveIncident`, `flConfirmSwap`, `flConfirmPropCascade`, `flSaveCreateJob`, `_flMaintStartProceed`,
 * `flStartGear*`, `flMaintClose`, `flMaintServiceReset`, `flSaveEditBoatStatus`, `flMaintAddAsset`,
 * `flMaintAddLog`, `flSplitExistingJob`, `flEngSplitIntoJobs`, `flBoard*`, `flMaintCalcCost`.
 *
 * A command works on a `FleetDraft`: the records it may touch, read by the route beforehand. It
 * changes copies and marks them; the route writes what is marked, in the same transaction. No I/O
 * here, so both stores decide identically.
 */
import { refuse } from './booking-actions.js';
import { closeOverlaps, copyBoat, entryIdMaker, realDate, type BoatRecord, type StatusEntry } from './catalogue.js';
import { coveringEntry, workOn, type OpenWork } from './fleet-availability.js';
import {
  assetLabel, copyAsset, logEntry, serviced, spareLabel, type AnyAsset, type AssetContext, type AssetKind, type AssetLogEntry, type Engine, type Gearbox, type Propeller,
} from './fleet-assets.js';

const bad = (message: string): never => refuse(message, 400);

// ── Shapes ──

export const DAMAGE_TYPES = ['engine', 'gearbox', 'propeller', 'hull', 'safety'] as const;
export type DamageType = typeof DAMAGE_TYPES[number];
export type DamagedAsset = { type: DamageType; asset_id: string | null; label: string | null; swapped: boolean; swapped_to: string | null; swapped_on: string | null };
/** A progress line (legacy `progressLog`): `created_on` is set when the line is dated other than the day it was written. */
export type ProgressLine = { date: string | null; text: string | null; by: string | null; created_on: string | null };
export type Incident = {
  id: string; no: string; boat_id: string; date: string; time: string | null; title: string; detail: string | null; remark: string | null;
  priority: number | null; severity: string | null; status: string; job_id: string | null; related_job_ids: string[];
  closed_on: string | null; quick_fix: boolean; resolved_on: string | null;
  damaged_assets: DamagedAsset[]; progress_log: ProgressLine[];
};
export type JobAsset = { type: DamageType; asset_id: string | null; label: string | null; detail: string | null; status: string | null; added_on: string | null };
export type JobPart = { id: string | null; inv_id: string | null; name: string | null; qty: number; unit: string | null; cost: number | null; location: string | null; date: string | null; late: boolean; late_by: string | null };
/** The job board's sub-steps (legacy `subs`). */
export type JobStep = { text: string; done: boolean; done_by: string | null; done_on: string | null };
export const JOB_TYPES = ['corrective', 'preventive', 'scheduled'] as const;
export const JOB_BOAT_STATUSES = ['available', 'fixing', 'unavailable'] as const;
/** The create form's reasons for an unavailable boat (`job-status-reason`). */
export const UNAVAILABLE_REASONS = ['engine_repair', 'donor', 'docs_expired', 'dry_dock', 'off_season', 'charter', 'scheduled_maint', 'other'] as const;
export const OUTCOMES = ['success', 'limited', 'rework', 'decommission', 'cancelled'] as const;
export type Outcome = typeof OUTCOMES[number];
export const LANES = ['decide', 'wait', 'doing', 'close'] as const;
export type Lane = typeof LANES[number];
export type Job = {
  id: string; no: string; boat_id: string; type: typeof JOB_TYPES[number]; title: string; detail: string | null; location: string | null;
  status: 'pending' | 'inprogress' | 'done'; start_date: string | null; end_date: string | null; incident_id: string | null;
  boat_status: typeof JOB_BOAT_STATUSES[number] | null; boat_status_reason: string | null; set_fixing: boolean;
  outcome: Outcome | null; close_note: string | null; awaiting_invoice: boolean; parent_project_id: string | null; legacy_cost: number | null;
  board_lane: Lane | null; owner: string | null; due_date: string | null; parked_on: string | null; pinned: boolean; pinned_on: string | null;
  assets: JobAsset[]; parts: JobPart[]; progress_log: ProgressLine[]; steps: JobStep[];
};

export const copyIncident = (i: Incident): Incident => ({
  ...i, related_job_ids: [...i.related_job_ids], damaged_assets: i.damaged_assets.map((a) => ({ ...a })), progress_log: i.progress_log.map((l) => ({ ...l })),
});
export const copyJob = (j: Job): Job => ({
  ...j, assets: j.assets.map((a) => ({ ...a })), parts: j.parts.map((p) => ({ ...p })), progress_log: j.progress_log.map((l) => ({ ...l })), steps: j.steps.map((s) => ({ ...s })),
});

// ── The draft a command works on ──

/** The records a command may change, as copies; `touched` says which to write back. */
export class FleetDraft implements AssetContext {
  readonly engines = new Map<string, Engine>();
  readonly gearboxes = new Map<string, Gearbox>();
  readonly propellers = new Map<string, Propeller>();
  readonly boats = new Map<string, BoatRecord>();
  readonly incidents = new Map<string, Incident>();
  readonly jobs = new Map<string, Job>();
  readonly touched = { engines: new Set<string>(), gearboxes: new Set<string>(), propellers: new Set<string>(), boats: new Set<string>(), incidents: new Set<string>(), jobs: new Set<string>() };
  /** The instant new ids are made from (status log entries). */
  readonly now: number;
  /**
   * `hoursOf` is an engine's hours (`engineHours` over its Daily Fleet Log meters; part B's meters, so
   * until then its `base_hours`).
   */
  constructor(
    readonly today: string,
    data: { engines?: readonly Engine[]; gearboxes?: readonly Gearbox[]; propellers?: readonly Propeller[]; boats?: readonly BoatRecord[]; incidents?: readonly Incident[]; jobs?: readonly Job[] },
    private readonly hoursOf: (engine: Engine) => number = (e) => e.base_hours,
    now = Date.now(),
  ) {
    for (const e of data.engines ?? []) this.engines.set(e.id, copyAsset(e));
    for (const g of data.gearboxes ?? []) this.gearboxes.set(g.id, copyAsset(g));
    for (const p of data.propellers ?? []) this.propellers.set(p.id, copyAsset(p));
    for (const b of data.boats ?? []) this.boats.set(b.id, copyBoat(b));
    for (const i of data.incidents ?? []) this.incidents.set(i.id, copyIncident(i));
    for (const j of data.jobs ?? []) this.jobs.set(j.id, copyJob(j));
    this.now = now;
  }
  /** A project's number for the lines a job under it writes (part B's projects; the id until the route sets it). */
  projectNoOf: (id: string) => string = (id) => id;
  boatName = (id: string): string => this.boats.get(id)?.name ?? id;
  engineHours = (id: string): number => {
    const e = this.engines.get(id);
    return e ? this.hoursOf(e) : 0;
  };
  put(kind: AssetKind, a: AnyAsset): void {
    if (kind === 'engine') { this.engines.set(a.id, a as Engine); this.touched.engines.add(a.id); }
    else if (kind === 'gearbox') { this.gearboxes.set(a.id, a as Gearbox); this.touched.gearboxes.add(a.id); }
    else { this.propellers.set(a.id, a as Propeller); this.touched.propellers.add(a.id); }
  }
  asset(kind: AssetKind, id: string): AnyAsset | undefined {
    return kind === 'engine' ? this.engines.get(id) : kind === 'gearbox' ? this.gearboxes.get(id) : this.propellers.get(id);
  }
  putBoat(b: BoatRecord): void { this.boats.set(b.id, b); this.touched.boats.add(b.id); }
  putIncident(i: Incident): void { this.incidents.set(i.id, i); this.touched.incidents.add(i.id); }
  putJob(j: Job): void { this.jobs.set(j.id, j); this.touched.jobs.add(j.id); }
  /** Changes an asset in place and marks it. */
  edit<K extends AssetKind>(kind: K, id: string, change: (a: AnyAsset & Record<string, unknown>) => void): void {
    const a = this.asset(kind, id);
    if (!a) return;
    change(a as AnyAsset & Record<string, unknown>);
    this.put(kind, a);
  }
  /** `flPushLog`: a job's line also goes onto its incident (the one it was made from, or that names it). */
  pushIncidentLog(job: Job, text: string, by = 'ระบบ', date = this.today): void {
    const inc = [...this.incidents.values()].find((i) => i.job_id === job.id || i.id === job.incident_id);
    if (!inc) return;
    inc.progress_log.push(line(date, text, by || 'ระบบ', this.today));
    this.putIncident(inc);
  }
}

const line = (date: string, text: string, by: string | null, today: string): ProgressLine => ({ date, text, by, created_on: date !== today ? today : null });
const money = (n: number): string => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
const text = (v: unknown, name: string): string | null => (v === undefined || v === null || v === '' ? null : typeof v === 'string' ? v.trim() || null : bad(`${name} must be text`));
const required = (v: unknown, name: string): string => text(v, name) ?? bad(`${name} is required`);
const bool = (v: unknown, name: string): boolean => (typeof v === 'boolean' ? v : bad(`${name} must be true or false`));
const optionalDate = (v: unknown, name: string): string | null => (v === undefined || v === null || v === '' ? null : realDate(v, name));
const refuseOwned = (body: Record<string, unknown>, owned: Record<string, string>): void => {
  for (const key of Object.keys(body)) if (key in owned) bad(`${key} cannot be set here; ${owned[key]}`);
};

// ── Numbers (decision 4: legacy's, from the client) ──

/** Legacy's next number: the highest of `PREFIX-NNN` plus one, three digits (`flSaveIncident`, `flSaveCreateJob`). */
export function nextNo(prefix: 'INC' | 'MJ', nos: readonly string[]): string {
  const max = nos.reduce((m, no) => Math.max(m, parseInt(no.replace(new RegExp(`^${prefix}-`), ''), 10) || 0), 0);
  return `${prefix}-${String(max + 1).padStart(3, '0')}`;
}

/** `flAssertUniqueNo`: a number already used is refused; duplicates legacy already has stay. */
export function assertNoFree(no: string, existing: readonly { id: string; no: string }[], self?: string): void {
  const dup = existing.find((x) => x.no === no && x.id !== self);
  if (dup) refuse(`Number ${no} is already used (${dup.id}): take the next free one`, 409, 'number_taken');
}

const numberOf = (v: unknown, name: string): string => {
  const no = required(v, name);
  return no.length <= 32 ? no : bad(`${name} must be at most 32 characters`);
};

// ── Labels ──

const TYPE_LABEL: Record<string, string> = { engine: 'Engine', gearbox: 'Gearbox', propeller: 'Propeller', hull: 'Hull', safety: 'Safety' };
const ASSET_KINDS_OF: Record<string, AssetKind | undefined> = { engine: 'engine', gearbox: 'gearbox', propeller: 'propeller' };

/** What a job calls a damaged asset (`labelFor`): the record's label when it still exists, else what was stored. */
function labelFor(d: FleetDraft, a: { type: DamageType; asset_id: string | null; label: string | null }): string {
  const kind = ASSET_KINDS_OF[a.type];
  const rec = kind && a.asset_id ? d.asset(kind, a.asset_id) : undefined;
  if (kind && rec) return assetLabel(kind, rec);
  return a.label || TYPE_LABEL[a.type] || 'Asset';
}

/** An incident's damaged assets as the form sends them: a part by id, labelled here; the hull (or safety gear) by its label. */
export function parseDamaged(value: unknown, d: FleetDraft): DamagedAsset[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return bad('damaged_assets must be a list of { type, asset_id } or { type: "hull", label }');
  return value.map((raw, i) => {
    const a = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : bad(`damaged_assets[${i}] must be an object`);
    const type = (DAMAGE_TYPES as readonly unknown[]).includes(a.type) ? a.type as DamageType : bad(`damaged_assets[${i}].type must be one of ${DAMAGE_TYPES.join(', ')}`);
    const kind = ASSET_KINDS_OF[type];
    if (kind) {
      const id = required(a.asset_id ?? a.id, `damaged_assets[${i}].asset_id`);
      const rec = d.asset(kind, id) ?? bad(`damaged_assets[${i}]: ${type} ${id} does not exist`);
      return { type, asset_id: id, label: assetLabel(kind, rec), swapped: false, swapped_to: null, swapped_on: null };
    }
    return { type, asset_id: null, label: required(a.label, `damaged_assets[${i}].label`), swapped: false, swapped_to: null, swapped_on: null };
  });
}

/** Incidents and jobs are for the company's own boats in service (the forms' boat lists). */
export function assertWorkBoat(boat: BoatRecord | undefined, boatId: string): BoatRecord {
  if (!boat) return bad(`boat_id ${boatId} is not a boat (GET /v1/boats)`);
  if (boat.ownership === 'charter') bad(`${boat.name} is a chartered boat: incidents and jobs are for the company's own boats`);
  if (boat.retired) bad(`${boat.name} is retired: restore it first`);
  return boat;
}

// ── Incidents ──

/** `flSaveIncident`: priority 4 and above is critical, 3 major, anything else minor. */
export const severityOf = (priority: number): string => (priority >= 4 ? 'critical' : priority >= 3 ? 'major' : 'minor');
const priorityOf = (v: unknown): number => {
  if (v === undefined || v === null || v === '' || v === 0) return 5;
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 5 ? v : bad('priority must be a whole number from 1 to 5');
};
/** Legacy `effStatus`: a resolved incident is resolved; otherwise its job says. */
export function shownStatus(i: Pick<Incident, 'status' | 'job_id'>, jobOf: (id: string) => Pick<Job, 'status'> | undefined): string {
  if (i.status === 'resolved') return 'resolved';
  const job = i.job_id ? jobOf(i.job_id) : undefined;
  if (!job) return 'open';
  return job.status === 'pending' ? 'pending' : job.status === 'inprogress' ? 'inprogress' : 'resolved';
}

const INCIDENT_OWNED: Record<string, string> = {
  id: 'an incident id is assigned by the server', status: 'it follows the incident\'s jobs (or a quick fix)', severity: 'it is computed from priority',
  job_id: 'create the job with POST /v1/fleet/jobs and incident_id', maint_id: 'create the job with POST /v1/fleet/jobs and incident_id',
  related_job_ids: 'it is set when jobs are made from the incident', closed_on: 'it is set when its last job closes', resolved_on: 'it is set by a quick fix',
  progress_log: 'use POST /v1/fleet/incidents/{id}/log', shown_status: 'it is computed', type: 'every incident is an incident',
};

/** `flSaveIncident` create: remark with its root cause and quick fix, the opening line, a quick fix closed at once. */
export function newIncident(d: FleetDraft, id: string, body: Record<string, unknown>, existing: readonly { id: string; no: string }[]): Incident {
  refuseOwned(body, INCIDENT_OWNED);
  const no = numberOf(body.no, 'no');
  assertNoFree(no, existing);
  const boatId = required(body.boat_id, 'boat_id');
  assertWorkBoat(d.boats.get(boatId), boatId);
  const date = realDate(body.date, 'date');
  const title = required(body.title, 'title');
  const detail = text(body.detail, 'detail'), remark = text(body.remark, 'remark'), cause = text(body.cause, 'cause');
  const quick = body.quick_fix === undefined ? false : bool(body.quick_fix, 'quick_fix');
  const priority = priorityOf(body.priority);
  const damaged = parseDamaged(body.damaged_assets, d);
  const labels = damaged.map((a) => a.label).join(', ');
  const remarkFinal = [cause ? `Root cause: ${cause}` : null, remark, quick ? 'Quick Fix · resolved same-day · no maintenance job' : null].filter(Boolean).join(' · ');
  const log: ProgressLine[] = [line(date, `เปิด Incident: ${title}${damaged.length ? ` · ความเสียหาย: ${labels}` : ''}`, remark || 'ระบบ', date)];
  if (quick) {
    const short = detail ? ` · ${detail.slice(0, 140)}${detail.length > 140 ? '…' : ''}` : '';
    log.push(line(date, `✓ ปิดทันที (Quick Fix)${cause ? ` · Root cause: ${cause}` : ''}${short}`, '', date));
    for (const a of damaged) {
      const kind = ASSET_KINDS_OF[a.type];
      if (kind && a.asset_id) d.edit(kind, a.asset_id, (rec) => { rec.log.push(logEntry({ date, type: 'quickfix', description: `Quick Fix · ${no} · ${title}`, engine_hours: 0 })); });
    }
  }
  const inc: Incident = {
    id, no, boat_id: boatId, date, time: text(body.time, 'time'), title, detail, remark: remarkFinal || null, priority, severity: severityOf(priority),
    status: quick ? 'resolved' : 'open', job_id: null, related_job_ids: [], closed_on: null, quick_fix: quick, resolved_on: quick ? date : null,
    damaged_assets: damaged, progress_log: log,
  };
  d.putIncident(inc);
  return inc;
}

/** The edit form (`flSaveIncident` edit): what it sends, severity again from priority, and legacy's "edited" line. */
export function editedIncident(d: FleetDraft, current: Incident, body: Record<string, unknown>, existing: readonly { id: string; no: string }[]): Incident {
  refuseOwned(body, { ...INCIDENT_OWNED, quick_fix: 'a quick fix is chosen when the incident is logged', cause: 'the root cause is written into the remark when the incident is logged' });
  const inc = copyIncident(current);
  if (body.no !== undefined) { inc.no = numberOf(body.no, 'no'); if (inc.no !== current.no) assertNoFree(inc.no, existing, current.id); }
  if (body.boat_id !== undefined) { inc.boat_id = required(body.boat_id, 'boat_id'); if (inc.boat_id !== current.boat_id) assertWorkBoat(d.boats.get(inc.boat_id), inc.boat_id); }
  if (body.date !== undefined) inc.date = realDate(body.date, 'date');
  if (body.time !== undefined) inc.time = text(body.time, 'time');
  if (body.title !== undefined) inc.title = required(body.title, 'title');
  if (body.detail !== undefined) inc.detail = text(body.detail, 'detail');
  if (body.remark !== undefined) inc.remark = text(body.remark, 'remark');
  if (body.priority !== undefined) { inc.priority = priorityOf(body.priority); inc.severity = severityOf(inc.priority); }
  // The form rebuilds the list from its ticks, so a swap's marks go with an edit, as in legacy.
  if (body.damaged_assets !== undefined) inc.damaged_assets = parseDamaged(body.damaged_assets, d);
  const labels = inc.damaged_assets.map((a) => a.label).join(', ');
  inc.progress_log.push(line(d.today, `✎ แก้ไขรายละเอียด${inc.damaged_assets.length ? ` · ความเสียหาย: ${labels}` : ''}`, inc.remark || 'ระบบ', d.today));
  d.putIncident(inc);
  return inc;
}

/** `flAddIncLog`: a line dated today. */
export function incidentLog(d: FleetDraft, current: Incident, body: Record<string, unknown>): Incident {
  const inc = copyIncident(current);
  inc.progress_log.push(line(d.today, required(body.text, 'text'), text(body.by, 'by') ?? '', d.today));
  d.putIncident(inc);
  return inc;
}

const PIER_SHORT: Record<string, string> = { 'pier:tublamu': 'Tub Lamu', 'pier:panwa': 'Visit Panwa', 'pier:ranong': 'Ranong', 'pier:central': 'คลังกลาง' };

/**
 * The quick swap from an incident (`flConfirmSwap`): a compatible spare (same brand of gearbox, same
 * size of propeller, kept at a pier or on this boat) takes the damaged part's place, which goes to
 * the shop. After a gearbox, each propeller on the old one is kept on the new one, stocked or sent
 * with it for repair (`flConfirmPropCascade`); one not named is kept, the dialog's default.
 */
export function quickSwap(d: FleetDraft, current: Incident, body: Record<string, unknown>): Incident {
  const type = body.asset_type === 'gearbox' || body.asset_type === 'propeller' ? body.asset_type : bad('asset_type must be gearbox or propeller');
  const assetId = required(body.asset_id, 'asset_id'), spareId = required(body.spare_id, 'spare_id');
  const listed = current.damaged_assets.find((a) => a.type === type && a.asset_id === assetId);
  if (!listed) bad(`${type} ${assetId} is not among the incident's damaged assets`);
  const damaged = (d.asset(type, assetId) ?? bad(`${type} ${assetId} does not exist`)) as Gearbox | Propeller;
  const spare = (d.asset(type, spareId) ?? bad(`${type} ${spareId} does not exist`)) as Gearbox | Propeller;
  const loc = spare.spare_location ?? '';
  const here = loc.startsWith('pier:') || loc === `boat:${current.boat_id}`;
  const fits = type === 'gearbox' ? spare.brand === damaged.brand : (spare as Propeller).size === (damaged as Propeller).size;
  if (spare.id === damaged.id || !here || !fits) {
    refuse(`${spare.serial ?? spare.id} can't replace ${damaged.serial ?? damaged.id}: a spare must be kept at a pier or on this boat, and be the same ${type === 'gearbox' ? 'brand' : 'size'}`, 409, 'spare_not_compatible');
  }
  const boatId = damaged.boat_id, boatName = boatId ? d.boatName(boatId) : '';
  let engineHours: number | null = null;
  if (type === 'gearbox') { const e = (damaged as Gearbox).engine_id; if (e && d.engines.has(e)) engineHours = d.engineHours(e); }
  else { const g = (damaged as Propeller).gearbox_id ? d.gearboxes.get((damaged as Propeller).gearbox_id!) : undefined; if (g?.engine_id && d.engines.has(g.engine_id)) engineHours = d.engineHours(g.engine_id); }
  const lastInstall = [...damaged.log].reverse().find((l) => l.type === 'install');
  const used = lastInstall && engineHours !== null ? Math.max(0, engineHours - (lastInstall.engine_hours ?? 0)) : null;
  type Loose = Record<string, unknown> & { log: AssetLogEntry[] };
  const dmg = copyAsset(damaged) as unknown as Loose;
  const spr = copyAsset(spare) as unknown as Loose;
  dmg.log.push(logEntry({ date: d.today, type: 'remove', description: `ถอดจาก ${boatName} (Incident ${current.no}) — สลับสแปร์ ${spare.serial ?? spare.id}`, engine_hours: engineHours, used_hours: used, incident_id: current.id }));
  dmg.log.push(logEntry({ date: d.today, type: 'transfer', description: 'ส่งซ่อม → อู่ Honda Phuket', incident_id: current.id }));
  const engine = type === 'gearbox' && (damaged as Gearbox).engine_id ? d.engines.get((damaged as Gearbox).engine_id!) : undefined;
  const pos = type === 'gearbox' ? engine?.pos || damaged.note || '' : (damaged as Propeller).prop_pos ? `· ${(damaged as Propeller).prop_pos}` : '';
  spr.log.push(logEntry({ date: d.today, type: 'install', description: `ติดตั้งบน ${boatName} ${pos} (Quick Swap จาก Incident ${current.no})`.replace(/\s+/g, ' ').trim(), engine_hours: engineHours, incident_id: current.id }));
  spr.boat_id = boatId;
  if (type === 'gearbox') spr.engine_id = (damaged as Gearbox).engine_id; else spr.gearbox_id = (damaged as Propeller).gearbox_id;
  spr.status = type === 'gearbox' ? 'ready' : 'active';
  spr.note = damaged.note;
  if (type === 'propeller' && (damaged as Propeller).prop_pos) spr.prop_pos = (damaged as Propeller).prop_pos;
  spr.spare_location = null;
  if (type === 'gearbox' && engineHours !== null) spr.base_hours = engineHours;
  if (type === 'propeller' && engineHours !== null) spr.install_hours = engineHours;
  dmg.boat_id = null;
  if (type === 'gearbox') dmg.engine_id = null; else dmg.gearbox_id = null;
  dmg.status = type === 'gearbox' ? 'fixing' : 'damaged';
  dmg.spare_location = 'shop:honda-phuket';
  dmg.note = `ส่งซ่อมจาก ${boatName}`;
  d.put(type, dmg as unknown as AnyAsset); d.put(type, spr as unknown as AnyAsset);

  const inc = copyIncident(current);
  const mark = inc.damaged_assets.find((a) => a.type === type && a.asset_id === assetId)!;
  mark.swapped = true; mark.swapped_to = spare.serial; mark.swapped_on = d.today;
  inc.progress_log.push(line(d.today, `เปลี่ยน${type === 'gearbox' ? 'เกียร์' : 'ใบจักร'} ${damaged.serial ?? damaged.id} → ${spare.serial ?? spare.id}`, 'ระบบ Quick Swap', d.today));

  if (type === 'gearbox') {
    const choices = parseCascade(body.propellers);
    const attached = [...d.propellers.values()].filter((p) => p.gearbox_id === damaged.id);
    for (const id of choices.keys()) if (!attached.some((p) => p.id === id)) bad(`propellers: ${id} is not on gearbox ${damaged.serial ?? damaged.id}`);
    const summary = { keep: 0, stock: 0, repair: 0 };
    const shop = (dmg.spare_location as string | null) ?? 'shop:honda-phuket';
    for (const p of attached) {
      const choice = choices.get(p.id) ?? { action: 'keep' as const, location: null };
      d.edit('propeller', p.id, (rec) => {
        const prop = rec as unknown as Propeller;
        if (choice.action === 'keep') {
          prop.gearbox_id = spare.id;
          prop.log.push(logEntry({ date: d.today, type: 'transfer', description: `ถอดจากเกียร์ ${damaged.serial ?? damaged.id} ใส่เข้าเกียร์ ${spare.serial ?? spare.id} (Quick Swap)`, engine_hours: engineHours, incident_id: current.id }));
        } else if (choice.action === 'stock') {
          const target = choice.location ?? 'pier:tublamu';
          const label = PIER_SHORT[target] ?? target;
          prop.boat_id = null; prop.gearbox_id = null; prop.status = 'spare'; prop.spare_location = target;
          prop.note = `ถอดจากเกียร์ ${damaged.serial ?? ''} เก็บที่ ${label}`;
          prop.log.push(logEntry({ date: d.today, type: 'remove', description: `ถอดจากเกียร์ ${damaged.serial ?? ''} → เก็บคลัง ${label}`, engine_hours: engineHours, incident_id: current.id }));
        } else {
          prop.boat_id = null; prop.gearbox_id = null; prop.status = 'fixing'; prop.spare_location = shop;
          prop.note = `ส่งซ่อมพร้อมเกียร์ ${damaged.serial ?? ''}`;
          prop.log.push(logEntry({ date: d.today, type: 'transfer', description: `ส่งซ่อม → ${shop.replace('shop:', '').replace(/-/g, ' ')} (ติดไปกับเกียร์ ${damaged.serial ?? ''})`, engine_hours: engineHours, incident_id: current.id }));
        }
      });
      summary[choice.action] += 1;
    }
    const parts = [
      summary.keep ? `🔄 ย้ายใบจักร ${summary.keep} ใบไปติด ${spare.serial ?? ''}` : null,
      summary.stock ? `📦 ถอดเก็บคลัง ${summary.stock} ใบ` : null,
      summary.repair ? `🔧 ส่งซ่อมพร้อมเกียร์ ${summary.repair} ใบ` : null,
    ].filter(Boolean);
    if (parts.length) inc.progress_log.push(line(d.today, `⚙️ จัดการใบจักรหลัง swap: ${parts.join(' · ')}`, 'ระบบ Quick Swap', d.today));
  }
  d.putIncident(inc);
  return inc;
}

function parseCascade(value: unknown): Map<string, { action: 'keep' | 'stock' | 'repair'; location: string | null }> {
  const out = new Map<string, { action: 'keep' | 'stock' | 'repair'; location: string | null }>();
  if (value === undefined || value === null) return out;
  if (!Array.isArray(value)) return bad('propellers must be a list of { id, action: keep|stock|repair, location? }');
  value.forEach((raw, i) => {
    const p = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : bad(`propellers[${i}] must be an object`);
    const action = p.action === 'keep' || p.action === 'stock' || p.action === 'repair' ? p.action : bad(`propellers[${i}].action must be keep, stock or repair`);
    out.set(required(p.id, `propellers[${i}].id`), { action, location: text(p.location, `propellers[${i}].location`) });
  });
  return out;
}

// ── Jobs: create ──

/** `_defaultBoatStatusForType`: corrective fixing, scheduled unavailable for scheduled maintenance, preventive available. */
export function defaultBoatStatus(type: Job['type']): { status: typeof JOB_BOAT_STATUSES[number]; reason: string | null } {
  if (type === 'scheduled') return { status: 'unavailable', reason: 'scheduled_maint' };
  if (type === 'preventive') return { status: 'available', reason: null };
  return { status: 'fixing', reason: null };
}
const setFixingOf = (status: string | null): boolean => status === 'fixing' || status === 'unavailable';
const jobType = (v: unknown): Job['type'] => ((JOB_TYPES as readonly unknown[]).includes(v) ? v as Job['type'] : bad(`type must be one of ${JOB_TYPES.join(', ')}`));
const boatStatusOf = (v: unknown): typeof JOB_BOAT_STATUSES[number] => ((JOB_BOAT_STATUSES as readonly unknown[]).includes(v) ? v as typeof JOB_BOAT_STATUSES[number] : bad(`boat_status must be one of ${JOB_BOAT_STATUSES.join(', ')}`));
const reasonOf = (v: unknown): string | null => {
  const r = text(v, 'boat_status_reason');
  return r === null || (UNAVAILABLE_REASONS as readonly string[]).includes(r) ? r : bad(`boat_status_reason must be one of ${UNAVAILABLE_REASONS.join(', ')}`);
};

const JOB_OWNED: Record<string, string> = {
  id: 'a job id is assigned by the server', status: 'use POST /v1/fleet/jobs/{id}/start or /close', end_date: 'it is set by /close', outcome: 'use POST /v1/fleet/jobs/{id}/close',
  close_note: 'use POST /v1/fleet/jobs/{id}/close', set_fixing: 'it follows boat_status', cost: 'it is computed from the job\'s parts and memos',
  legacy_cost: 'it is legacy\'s, imported', parts: 'parts are taken from stock (part B)', progress_log: 'use POST /v1/fleet/jobs/{id}/log',
  steps: 'use POST /v1/fleet/jobs/{id}/steps', lane: 'it is computed; set board_lane', silent_days: 'it is computed', blocks_boat: 'it is computed',
  pinned_on: 'it is set by pinned', parked_on: 'it is set by parked',
};

const blankJob = (): Omit<Job, 'id' | 'no' | 'boat_id' | 'type' | 'title' | 'status'> => ({
  detail: null, location: null, start_date: null, end_date: null, incident_id: null, boat_status: null, boat_status_reason: null, set_fixing: true,
  outcome: null, close_note: null, awaiting_invoice: false, parent_project_id: null, legacy_cost: null, board_lane: null, owner: null, due_date: null,
  parked_on: null, pinned: false, pinned_on: null, assets: [], parts: [], progress_log: [], steps: [],
});

/**
 * The create form (`flSaveCreateJob`). One job, or with `per_asset` one job per damaged asset of its
 * incident (legacy's choice dialog, numbered by `nos`). The boat having an open job is legacy's
 * confirm (`create_anyway`). Answers the jobs made, first the one the incident links to.
 */
export function newJobs(d: FleetDraft, body: Record<string, unknown>, ids: () => string, existing: readonly { id: string; no: string }[], openOnBoat: readonly Job[]): Job[] {
  refuseOwned(body, JOB_OWNED);
  const boatId = required(body.boat_id, 'boat_id');
  const boat = assertWorkBoat(d.boats.get(boatId), boatId);
  const title = required(body.title, 'title');
  const type = body.type === undefined ? 'corrective' : jobType(body.type);
  const def = defaultBoatStatus(type);
  const boatStatus = body.boat_status === undefined ? def.status : boatStatusOf(body.boat_status);
  let reason = body.boat_status_reason === undefined ? (boatStatus === def.status ? def.reason : null) : reasonOf(body.boat_status_reason);
  if (boatStatus !== 'unavailable') reason = null;
  if (boatStatus === 'unavailable' && !reason) bad('boat_status_reason is required when the boat will be unavailable');
  const startDate = body.start_date === undefined || body.start_date === null || body.start_date === '' ? d.today : realDate(body.start_date, 'start_date');
  const anyway = body.create_anyway === undefined ? false : bool(body.create_anyway, 'create_anyway');
  const projectId = text(body.parent_project_id, 'parent_project_id');
  const common = {
    ...blankJob(), boat_id: boatId, type, detail: text(body.detail, 'detail'), location: text(body.location, 'location'), start_date: startDate,
    boat_status: boatStatus, boat_status_reason: reason, set_fixing: setFixingOf(boatStatus), parent_project_id: projectId, status: 'pending' as const,
  };
  let incident: Incident | undefined;
  if (body.incident_id !== undefined && body.incident_id !== null && body.incident_id !== '') {
    const incId = required(body.incident_id, 'incident_id');
    incident = d.incidents.get(incId) ?? bad(`incident_id ${incId} is not an incident`);
    if (incident.job_id && d.jobs.has(incident.job_id)) refuse(`Incident ${incident.no} already has job ${d.jobs.get(incident.job_id)!.no}`, 409, 'incident_linked');
    if (incident.boat_id !== boatId) bad(`Incident ${incident.no} is on another boat`);
  }
  if (openOnBoat.length && !anyway) {
    refuse(`${boat.name} already has open jobs: ${openOnBoat.map((m) => `${m.no} (${m.status === 'inprogress' ? 'In Progress' : 'Pending'})`).join(', ')}. Send create_anyway: true to add another`, 409, 'open_jobs');
  }
  const damaged = incident?.damaged_assets ?? [];
  const many = damaged.length > 1;
  const perAsset = body.per_asset === undefined ? undefined : bool(body.per_asset, 'per_asset');
  if (many && perAsset === undefined) bad(`per_asset is required: incident ${incident!.no} lists ${damaged.length} damaged assets. false makes one job, true one job per asset (numbered by nos)`);
  const taken = [...existing];

  if (many && perAsset) {
    const nos = Array.isArray(body.nos) ? body.nos.map((n, i) => numberOf(n, `nos[${i}]`)) : bad(`nos is required: one number per damaged asset (${damaged.length})`);
    if (nos.length !== damaged.length) bad(`nos must hold ${damaged.length} numbers, one per damaged asset`);
    if (new Set(nos).size !== nos.length) bad('nos must not repeat a number');
    for (const no of nos) assertNoFree(no, taken);
    const jobs = damaged.map((a, i): Job => ({
      ...common, id: ids(), no: nos[i], title: `${title} — ${TYPE_LABEL[a.type] ?? 'Asset'} ${labelFor(d, a)}`, incident_id: incident!.id,
      assets: [{ type: a.type, asset_id: a.asset_id, label: a.label || labelFor(d, a), detail: '', status: 'fixing', added_on: null }],
    }));
    const inc = d.incidents.get(incident!.id)!;
    inc.job_id = jobs[0].id; inc.related_job_ids = jobs.map((j) => j.id);
    inc.progress_log.push(line(d.today, `+ สร้าง ${jobs.length} jobs: ${jobs.map((j) => j.no).join(', ')}`, 'ระบบ', d.today));
    d.putIncident(inc);
    for (const j of jobs) { projectLine(j, d); d.putJob(j); }
    return jobs;
  }

  const no = numberOf(body.no, 'no');
  assertNoFree(no, taken);
  let assets: JobAsset[] = damaged.map((a) => ({ type: a.type, asset_id: a.asset_id, label: a.label ?? '', detail: '', status: 'fixing', added_on: null }));
  if (!incident && body.assets !== undefined) {
    // The preventive/scheduled form's ticks: what it checks follows the boat (ready if it stays available).
    const status = boatStatus === 'available' ? 'ready' : 'fixing';
    assets = parseDamaged(body.assets, d).map((a) => ({ type: a.type, asset_id: a.asset_id, label: a.label, detail: '', status, added_on: null }));
  }
  const job: Job = { ...common, id: ids(), no, title, incident_id: incident?.id ?? null, assets };
  projectLine(job, d);
  if (incident) {
    const inc = d.incidents.get(incident.id)!;
    inc.job_id = job.id;
    inc.progress_log.push(line(d.today, `+ สร้าง Job ${job.no} · ${job.title}${job.location ? ` → ${job.location}` : ''}`, 'ระบบ', d.today));
    d.putIncident(inc);
  }
  d.putJob(job);
  return [job];
}

/** A job made under a project says so (`_projCreateForId`); the project's own line is written by the route. */
function projectLine(job: Job, d: FleetDraft): void {
  if (job.parent_project_id) job.progress_log.push(line(d.today, `+ Created under project ${d.projectNoOf(job.parent_project_id)}`, 'user', d.today));
}

// ── Jobs: edit, board ──

export const LANE_TITLES: Record<Lane, string> = { decide: 'ต้องตัดสินใจ', wait: 'รออะไหล่ / ผู้รับเหมา', doing: 'กำลังทำ', close: 'รอปิด' };
const BOARD = 'บอร์ดงานเรือ';

/** `flBoardLog`: a board line onto the job and its incident. */
function boardLine(d: FleetDraft, job: Job, textLine: string): void {
  job.progress_log.push(line(d.today, textLine, BOARD, d.today));
  d.pushIncidentLog(job, textLine, BOARD, d.today);
}

/**
 * `PATCH /v1/fleet/jobs/{id}`: the detail's fields and the board's (owner, due date, lane, park, pin).
 * A board change writes the line legacy's board writes (`flBoardSaveCard`, `flBoardDrop`, `flBoardPark`).
 */
export function patchedJob(d: FleetDraft, current: Job, body: Record<string, unknown>, existing: readonly { id: string; no: string }[]): Job {
  refuseOwned(body, {
    ...JOB_OWNED, boat_id: "a job's boat is fixed: make a new job", incident_id: 'it is set when the job is made from the incident',
    boat_status: 'use POST /v1/fleet/jobs/{id}/boat-status', boat_status_reason: 'use POST /v1/fleet/jobs/{id}/boat-status', assets: 'use POST /v1/fleet/jobs/{id}/assets',
  });
  const job = copyJob(current);
  if (body.no !== undefined) { job.no = numberOf(body.no, 'no'); if (job.no !== current.no) assertNoFree(job.no, existing, current.id); }
  if (body.type !== undefined) job.type = jobType(body.type);
  if (body.title !== undefined) job.title = required(body.title, 'title');
  if (body.detail !== undefined) job.detail = text(body.detail, 'detail');
  if (body.location !== undefined) job.location = text(body.location, 'location');
  if (body.start_date !== undefined) job.start_date = optionalDate(body.start_date, 'start_date');
  if (body.parent_project_id !== undefined) job.parent_project_id = text(body.parent_project_id, 'parent_project_id');
  if (body.awaiting_invoice !== undefined) job.awaiting_invoice = bool(body.awaiting_invoice, 'awaiting_invoice');
  if (body.pinned !== undefined) { job.pinned = bool(body.pinned, 'pinned'); if (job.pinned !== current.pinned) job.pinned_on = job.pinned ? d.today : null; }
  const changes: string[] = [];
  if (body.owner !== undefined) { job.owner = text(body.owner, 'owner'); if (job.owner !== current.owner) changes.push(`ผู้รับผิดชอบ ${job.owner || '—'}`); }
  if (body.due_date !== undefined) { job.due_date = optionalDate(body.due_date, 'due_date'); if (job.due_date !== current.due_date) changes.push(`ตอบภายใน ${job.due_date || '—'}`); }
  if (changes.length) boardLine(d, job, changes.join(' · '));
  if (body.board_lane !== undefined) {
    job.board_lane = body.board_lane === null || body.board_lane === '' ? null : (LANES as readonly unknown[]).includes(body.board_lane) ? body.board_lane as Lane : bad(`board_lane must be one of ${LANES.join(', ')}, or null`);
    if (job.board_lane && job.board_lane !== current.board_lane) boardLine(d, job, `ย้ายไปเลน "${LANE_TITLES[job.board_lane]}"`);
  }
  if (body.parked !== undefined) {
    const parked = bool(body.parked, 'parked');
    if (parked && !current.parked_on) { job.parked_on = d.today; boardLine(d, job, 'พักไว้ · ยังไม่ถึงคิว'); }
    if (!parked) job.parked_on = null;
  }
  d.putJob(job);
  return job;
}

/** `flMaintAddLog` (and the board's note): dated as sent, today by default; onto the incident too. New progress frees a lane dragged to decide or wait. */
export function jobLog(d: FleetDraft, current: Job, body: Record<string, unknown>): Job {
  const job = copyJob(current);
  const textLine = required(body.text, 'text');
  const by = text(body.by, 'by') ?? '';
  const date = optionalDate(body.date, 'date') ?? d.today;
  job.progress_log.push(line(date, textLine, by, d.today));
  d.pushIncidentLog(job, textLine, by, date);
  if (job.board_lane === 'decide' || job.board_lane === 'wait') job.board_lane = null;
  d.putJob(job);
  return job;
}

/** Legacy's step templates, guessed from the job's title (`FL_BOARD_SUB_TPL`). */
const STEP_TEMPLATES: { re: RegExp; steps: string[] }[] = [
  { re: /คาน|ขัดสี|ท้องเรือ|slipway/i, steps: ['จองคิวคาน', 'ลากเรือเข้าคาน', 'ขัดสี + ตรวจใต้ท้อง', 'ทาสีจริง', 'ลงน้ำ + ทดลองวิ่ง'] },
  { re: /เครื่อง|เกียร์|ใบจักร|ไดร์|engine|gear/i, steps: ['ถอดตรวจ', 'ประเมิน + ขออนุมัติ', 'สั่งอะไหล่', 'ประกอบกลับ', 'ทดลองเดินเครื่อง'] },
];
const DEFAULT_STEPS = ['ประเมินงาน', 'ขออนุมัติ', 'ลงมือทำ', 'ตรวจรับ'];
export const stepTemplate = (title: string): string[] => STEP_TEMPLATES.find((t) => t.re.test(title))?.steps ?? DEFAULT_STEPS;

/** The board's steps: add one, add the template's missing ones, tick or untick one, delete one. */
export function changedSteps(d: FleetDraft, current: Job, action: { add: string } | { template: true } | { index: number; done: boolean } | { index: number; remove: true }, by: string | null): Job {
  const job = copyJob(current);
  if ('add' in action) {
    job.steps.push({ text: action.add, done: false, done_by: null, done_on: null });
    boardLine(d, job, `+ ขั้นตอน: ${action.add}`);
  } else if ('template' in action) {
    const missing = stepTemplate(job.title).filter((t) => !job.steps.some((s) => s.text === t));
    if (!missing.length) refuse("The template's steps are all on the job already", 409, 'steps_present');
    for (const t of missing) job.steps.push({ text: t, done: false, done_by: null, done_on: null });
    boardLine(d, job, `+ แตกขั้นตอนจากแม่แบบ ${missing.length} ขั้น`);
  } else {
    const step = job.steps[action.index] ?? refuse('Step not found', 404);
    if ('remove' in action) {
      job.steps.splice(action.index, 1);
      boardLine(d, job, `− ขั้นตอน: ${step.text}`);
    } else {
      step.done = action.done;
      if (action.done) { step.done_on = d.today; if (by) step.done_by = by; } else step.done_on = null;
      boardLine(d, job, `${action.done ? '☑ ' : '☐ '}${step.text} · ขั้นตอน ${job.steps.filter((s) => s.done).length}/${job.steps.length}`);
      if (action.done && (job.board_lane === 'decide' || job.board_lane === 'wait')) job.board_lane = null;
    }
  }
  d.putJob(job);
  return job;
}

// ── Jobs: computed fields ──

/** A purchase memo linked to a job, as cost reads it (part B's memos). */
export type LinkedMemo = { status: string; memo_type: string; amount: number; item_names: string[] };
const costName = (s: string | null): string => String(s ?? '').toLowerCase().replace(/[\s,.\-_()/]/g, '');
/**
 * `flMaintCalcCost`: approved, received and paid memos, plus parts taken from stock that no parts memo
 * of the job already paid for (matched by name, `§costDoubleCount`).
 */
export function jobCost(parts: readonly JobPart[], memos: readonly LinkedMemo[]): { cost: number; parts_cost: number; memo_cost: number; parts_covered: number } {
  const counted = memos.filter((m) => ['paid', 'received', 'approved'].includes(m.status));
  const memoCost = counted.reduce((s, m) => s + (m.amount || 0), 0);
  const paid = new Set(counted.filter((m) => m.memo_type === 'parts').flatMap((m) => m.item_names.map(costName)).filter(Boolean));
  let partsCost = 0, covered = 0;
  for (const p of parts) {
    const amount = (p.qty || 0) * (p.cost || 0);
    if (paid.has(costName(p.name)) && costName(p.name)) covered += amount; else partsCost += amount;
  }
  const r = (n: number) => Math.round(n * 100) / 100;
  return { cost: r(partsCost + memoCost), parts_cost: r(partsCost), memo_cost: r(memoCost), parts_covered: r(covered) };
}

const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
/** `flBoardSilent`: days since the job's latest line (else since it was opened). */
export function silentDays(job: Pick<Job, 'start_date' | 'progress_log'>, today: string): number {
  let last = job.start_date ?? '';
  for (const l of job.progress_log) if (l.date && l.date > last) last = l.date;
  return last ? Math.max(0, daysBetween(last.slice(0, 10), today)) : 0;
}
/** Words that mean "waiting for parts or someone" in the latest line (`FL_BOARD_WAIT_RE`). */
const WAIT_RE = /รอ|สั่ง|อะไหล่|คาน|ผู้รับเหมา|อนุมัติ|เคลม|ประกัน|memo|order|quote/i;
/**
 * `flBoardLane`: a lane set by hand wins; a boat that can sail puts the job under "to close"; a line in
 * the last 30 days is "doing"; a last line about waiting is "wait"; the rest need a decision.
 */
export function jobLane(job: Pick<Job, 'board_lane' | 'start_date' | 'progress_log'>, blocksBoat: boolean, today: string): Lane {
  if (job.board_lane) return job.board_lane;
  if (!blocksBoat) return 'close';
  if (silentDays(job, today) <= 30) return 'doing';
  const last = job.progress_log.length ? job.progress_log[job.progress_log.length - 1].text ?? '' : '';
  return last && WAIT_RE.test(last) ? 'wait' : 'decide';
}

// ── Jobs: start ──

const STATUS_LABEL: Record<string, string> = { fixing: 'Fixing', unavailable: 'Unavailable', available: 'Available' };
const STASH_PLACES = ['pier:tublamu', 'pier:panwa', 'pier:central', 'shop:honda-phuket', 'shop:suzuki-phuket', 'shop:prop-shop-phuket'];
const nextDay = (date: string): string => { const t = new Date(`${date}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); };

/** The boat status a job holds its boat at (`m.boatStatus || (setFixing===false ? 'available' : 'fixing')`). */
export const jobBoatStatus = (job: Pick<Job, 'boat_status' | 'set_fixing'>): string => job.boat_status ?? (job.set_fixing === false ? 'available' : 'fixing');

/** Gearboxes and propellers still on the job's engines (`_flMountedGearProp`). */
function mountedOn(d: FleetDraft, job: Job): { gearboxes: Gearbox[]; propellers: Propeller[] } {
  const gbs: Gearbox[] = [], props: Propeller[] = [];
  for (const a of job.assets) {
    if (a.type !== 'engine' || !a.asset_id) continue;
    for (const g of d.gearboxes.values()) {
      if (g.engine_id !== a.asset_id || g.status === 'spare' || gbs.includes(g)) continue;
      gbs.push(g);
      for (const p of d.propellers.values()) if (p.gearbox_id === g.id && p.status !== 'spare' && !props.includes(p)) props.push(p);
    }
  }
  return { gearboxes: gbs, propellers: props };
}

/**
 * Start (`flMaintStart`, `_flMaintStartProceed`). With engines that still carry a gearbox and
 * propeller, legacy asks what to do with them: `keep` them on (the default), `stash` them as spares,
 * or `swap` the engine out and leave them on the boat for the replacement (`flStartGearSwap`; fit it
 * with `POST /v1/fleet/engines/{id}/install` and the `job_id`). Then the boat's log gets the job's
 * status (from tomorrow when the boat already sailed today), the parts are marked, and both logs say so.
 */
export function startedJob(d: FleetDraft, current: Job, body: Record<string, unknown>, ranToday: boolean): Job {
  if (current.status !== 'pending') refuse(`${current.no} is ${current.status === 'done' ? 'closed' : 'already started'}`, 409, current.status === 'done' ? 'job_done' : 'job_started');
  const gear = body.gear === undefined ? 'keep' : body.gear === 'keep' || body.gear === 'stash' || body.gear === 'swap' ? body.gear : bad('gear must be keep, stash or swap');
  const job = copyJob(current);
  const boat = d.boats.get(job.boat_id);
  const mounted = mountedOn(d, job);
  if (gear === 'stash' && (mounted.gearboxes.length || mounted.propellers.length)) {
    const place = body.stash_location === undefined ? 'pier:central' : required(body.stash_location, 'stash_location');
    if (!STASH_PLACES.includes(place)) bad(`stash_location must be one of ${STASH_PLACES.join(', ')}`);
    const label = spareLabel(place, d.boatName);
    for (const g of mounted.gearboxes) d.edit('gearbox', g.id, (rec) => stash(rec, true, place, label, job.no, d.today));
    for (const p of mounted.propellers) d.edit('propeller', p.id, (rec) => stash(rec, false, place, label, job.no, d.today));
    job.progress_log.push(line(d.today, `📦 ถอดเกียร์/ใบจักร ${mounted.gearboxes.length + mounted.propellers.length} ชิ้น ไปเก็บที่ ${label} (ตอนเริ่มซ่อม)`, 'ระบบ', d.today));
  }
  if (gear === 'swap') {
    const engines = job.assets.filter((a) => a.type === 'engine' && a.asset_id && d.engines.has(a.asset_id));
    for (const a of engines) {
      const e = d.engines.get(a.asset_id!)!;
      for (const g of [...d.gearboxes.values()].filter((x) => x.engine_id === e.id)) {
        d.edit('gearbox', g.id, (rec) => {
          rec.on_boat_id = job.boat_id; rec.on_boat_pos = e.pos; rec.engine_id = null;
          rec.log.push(logEntry({ date: d.today, type: 'detach', text: `คาเรือ รอเครื่อง · ${d.boatName(job.boat_id)} ${e.pos ?? ''} · ${job.no}` }));
        });
      }
      d.edit('engine', e.id, (rec) => {
        rec.boat_id = null; rec.status = 'fixing';
        rec.log.push(logEntry({ date: d.today, type: 'remove', text: `ถอดไปซ่อม · ${job.no}` }));
      });
    }
    job.progress_log.push(line(d.today, `▶ เริ่มซ่อม · ถอดเครื่อง ${engines.length} ตัว (เกียร์/ใบจักรคาเรือไว้ รอเครื่องใหม่)`, 'ระบบ', d.today));
  }

  job.status = 'inprogress';
  const target = jobBoatStatus(job);
  if (boat && target !== 'available') {
    const cur = coveringEntry(boat.status_log, d.today);
    const from = ranToday ? nextDay(d.today) : d.today;
    const newId = entryIdMaker(boat.status_log, d.now);
    const log = closeOverlaps(boat.status_log, d.today, null, newId);
    log.push(statusEntry(newId(), target as StatusEntry['status'], from, job.location || cur?.loc || '',
      `Maintenance Job ${job.no}${ranToday ? ` · วิ่งวันนี้แล้ว · เริ่มไม่พร้อม ${from}` : ''}`, job.boat_status_reason));
    d.putBoat({ ...boat, status_log: log });
  }
  const fixing = target === 'fixing';
  for (const a of job.assets) {
    if (!a.asset_id) continue;
    if (a.type === 'engine' && d.engines.has(a.asset_id)) {
      d.edit('engine', a.asset_id, (rec) => {
        rec.log.push(logEntry({ date: d.today, type: 'service-start', description: `▶ เริ่มซ่อม · ${job.no} · ${job.title}${job.location ? ` @ ${job.location}` : ''}`, detail: a.detail || job.detail || '', hours: d.engineHours(a.asset_id!) }));
        if (fixing) rec.status = 'fixing';
      });
    }
    for (const kind of ['gearbox', 'propeller'] as const) {
      if (a.type !== kind || !d.asset(kind, a.asset_id)) continue;
      d.edit(kind, a.asset_id, (rec) => {
        rec.log.push(logEntry({ date: d.today, type: 'service-start', description: `▶ เริ่มซ่อม · ${job.no} · ${job.title}`, detail: a.detail || '' }));
        if (fixing) rec.status = 'fixing';
      });
    }
  }
  const label = STATUS_LABEL[target] ?? target;
  d.pushIncidentLog(job, `▶ เริ่มงาน ${job.no} · ${job.title}${job.location ? ` → ${job.location}` : ''}${boat ? ` · ${boat.name} = ${label}` : ''}`);
  job.progress_log.push(line(d.today, `▶ Start Job · ${boat ? `${boat.name} = ${label}` : ''}${job.location ? ` → ${job.location}` : ''}`, 'ระบบ', d.today));
  d.putJob(job);
  return job;
}

function stash(rec: AnyAsset & Record<string, unknown>, isGearbox: boolean, place: string, label: string, jobNo: string, today: string): void {
  const origin = isGearbox ? (rec.note as string | null) || (rec.pos as string | null) || '' : (rec.note as string | null) || '';
  rec.status = 'spare'; rec.spare_location = place;
  if (isGearbox) { rec.engine_id = null; rec.on_boat_id = null; rec.on_boat_pos = null; } else rec.gearbox_id = null;
  rec.log.push(logEntry({ date: today, type: 'remove', description: `ถอดเก็บจาก Job ${jobNo}${origin ? ` · ${origin}` : ''} → ${label}` }));
}

const statusEntry = (id: string, status: StatusEntry['status'], from: string, loc: string, note: string, reason: string | null): StatusEntry => ({
  id, status, from_date: from, to_date: null, loc: loc || null, province: null, loc_type: null, detail: null, note, reason: reason || null, project_id: null, planned_over: null,
});

/**
 * Fitting an engine into a position a job start emptied (`flStartSwapInstall`): the engine's own
 * gearbox stays where the engine came from (or becomes a spare), and the gearbox waiting at that
 * position takes the engine.
 */
export function swapInstall(d: FleetDraft, job: Job, engineId: string, boatId: string, pos: string): Job {
  const eNew = d.engines.get(engineId)!;
  const srcBoat = eNew.boat_id, srcPos = eNew.pos;
  for (const g of [...d.gearboxes.values()].filter((x) => x.engine_id === eNew.id)) {
    d.edit('gearbox', g.id, (rec) => {
      if (srcBoat) { rec.on_boat_id = srcBoat; rec.on_boat_pos = srcPos; } else { rec.on_boat_id = null; rec.on_boat_pos = null; if (rec.status !== 'spare') rec.status = 'spare'; }
      rec.engine_id = null;
      rec.log.push(logEntry({ date: d.today, type: 'detach', text: srcBoat ? `คาเรือ ${d.boatName(srcBoat)} (เครื่องย้ายออก) · ${job.no}` : `ไปสแปร์ (เครื่องย้ายออก) · ${job.no}` }));
    });
  }
  d.edit('engine', eNew.id, (rec) => {
    rec.boat_id = boatId; rec.pos = pos;
    if (rec.status === 'spare') rec.status = 'ready';
    rec.log.push(logEntry({ date: d.today, type: 'install', text: `ติดตั้งที่ ${d.boatName(boatId)} ${pos} · ${job.no}` }));
  });
  for (const g of [...d.gearboxes.values()].filter((x) => x.on_boat_id === boatId && x.on_boat_pos === pos && !x.engine_id)) {
    d.edit('gearbox', g.id, (rec) => {
      rec.engine_id = eNew.id; rec.boat_id = boatId; rec.on_boat_id = null; rec.on_boat_pos = null;
      if (rec.status === 'spare') rec.status = 'ready';
      rec.log.push(logEntry({ date: d.today, type: 'attach', text: `เกาะเครื่องใหม่ ${eNew.serial ?? eNew.id} · ${job.no}` }));
    });
  }
  const next = copyJob(job);
  next.progress_log.push(line(d.today, `🔧 ใส่เครื่อง ${eNew.serial ?? eNew.id} แทนที่ ${pos}`, 'ระบบ', d.today));
  d.putJob(next);
  return next;
}

// ── Jobs: close ──

const CLOSE: Record<Outcome, { label: string; engine: string | null; gearbox: string | null; propeller: string | null; boat: 'available' | 'fixing'; icon: string; tag: string }> = {
  success: { label: 'สำเร็จ', engine: 'ready', gearbox: 'ready', propeller: 'active', boat: 'available', icon: '✓', tag: '' },
  limited: { label: 'ใช้งานจำกัด', engine: 'limited', gearbox: 'limited', propeller: 'limited', boat: 'available', icon: '⚠', tag: ' · ใช้งานจำกัด' },
  rework: { label: 'ต้องซ่อมซ้ำ', engine: 'fixing', gearbox: 'fixing', propeller: 'fixing', boat: 'fixing', icon: '↻', tag: ' · ต้องซ่อมซ้ำ' },
  decommission: { label: 'ปลดระวาง', engine: 'broken', gearbox: 'broken', propeller: 'broken', boat: 'available', icon: '✕', tag: ' · ปลดระวาง' },
  cancelled: { label: 'ยกเลิก', engine: null, gearbox: null, propeller: null, boat: 'available', icon: '⊘', tag: ' · ยกเลิก Job' },
};

/** `flMaintServiceReset`: a completed job that reads like a service (or is scheduled) with engines or gearboxes. */
export function looksLikeService(job: Pick<Job, 'type' | 'title' | 'detail' | 'assets'>): boolean {
  const words = `${job.title ?? ''} ${job.detail ?? ''}`;
  const service = job.type === 'scheduled' || /น้ำมัน|ถ่าย|เซอร์วิส|service|\boil\b|svc|เกียร์|gear/i.test(words);
  return service && job.assets.some((a) => (a.type === 'engine' || a.type === 'gearbox') && a.asset_id);
}

/** The service baseline reset on the job's engines and gearboxes, at their hours now. Answers how many. */
export function resetService(d: FleetDraft, job: Job, lifetimeOf: (g: Gearbox) => number): number {
  let n = 0;
  for (const id of new Set(job.assets.filter((a) => a.type === 'engine' && a.asset_id).map((a) => a.asset_id!))) {
    const e = d.engines.get(id);
    if (!e) continue;
    d.put('engine', serviced('engine', e, Math.round(d.engineHours(id) * 10) / 10, d, job.no)); n += 1;
  }
  for (const id of new Set(job.assets.filter((a) => a.type === 'gearbox' && a.asset_id).map((a) => a.asset_id!))) {
    const g = d.gearboxes.get(id);
    if (!g) continue;
    d.put('gearbox', serviced('gearbox', g, lifetimeOf(g), d, job.no)); n += 1;
  }
  return n;
}

/**
 * Close (`flMaintClose`) with an outcome that sets the parts and the boat (the table in the note).
 * The boat goes to the outcome's status unless other work still holds it (it keeps theirs); a job run
 * alongside the boat (`set_fixing: false`) leaves the boat's log alone. The incident closes once all
 * its jobs are done (not on a cancel). A job that reads like a service asks whether to reset the
 * service hours (`reset_service`, legacy's confirm).
 */
export function closedJob(d: FleetDraft, current: Job, body: Record<string, unknown>, ctx: {
  cost: number; otherWork: readonly OpenWork[]; incidentJobs: readonly Job[]; lifetimeOf: (g: Gearbox) => number;
}): { job: Job; boat_status_after: string | null; service_reset: number } {
  if (current.status === 'done') refuse(`${current.no} is already closed`, 409, 'job_done');
  const outcome = body.outcome === undefined ? 'success' : (OUTCOMES as readonly unknown[]).includes(body.outcome) ? body.outcome as Outcome : bad(`outcome must be one of ${OUTCOMES.join(', ')}`);
  const note = text(body.note, 'note') ?? '';
  const awaiting = body.awaiting_invoice === undefined ? false : bool(body.awaiting_invoice, 'awaiting_invoice');
  const offer = (outcome === 'success' || outcome === 'limited') && looksLikeService(current);
  const reset = body.reset_service === undefined ? undefined : bool(body.reset_service, 'reset_service');
  if (offer && reset === undefined) {
    refuse(`${current.no} reads like a service: send reset_service: true to restart the service hours of its engines and gearboxes from now, or false to leave them`, 409, 'reset_service_choice');
  }
  const job = copyJob(current);
  job.status = 'done'; job.end_date = d.today; job.outcome = outcome;
  if (note) job.close_note = note;
  if (awaiting) job.awaiting_invoice = true;
  const out = CLOSE[outcome];
  const noteTxt = note ? ` · "${note}"` : '';
  const boat = d.boats.get(job.boat_id);
  let after: string | null = null;
  if (boat) {
    const cur = coveringEntry(boat.status_log, d.today);
    if (job.set_fixing === false) {
      // Run alongside the boat: legacy meant to keep the boat as it is (its code cut the open entry; see the note).
      after = cur?.status ?? (boat.ownership === 'charter' ? 'unavailable' : 'available');
    } else {
      const held = workOn(ctx.otherWork.filter((w) => w.id !== job.id), boat.id, d.today);
      let status: string = out.boat, reason = '', noteLine = `ปิด Job ${job.no}${out.tag}`;
      if (held.blocked_by.length) {
        status = held.status; reason = held.reason;
        noteLine = `ปิด Job ${job.no}${out.tag} · ยังคงสถานะ ${STATUS_LABEL[status] ?? status} จาก ${held.blocked_by.map((b) => b.no).join(' · ')}`;
      }
      const newId = entryIdMaker(boat.status_log, d.now);
      const log = closeOverlaps(boat.status_log, d.today, null, newId);
      log.push(statusEntry(newId(), status as StatusEntry['status'], d.today, cur?.loc ?? '', noteLine, reason));
      d.putBoat({ ...boat, status_log: log });
      after = status;
    }
  }
  for (const a of job.assets) {
    if (a.type === 'engine' && a.asset_id && d.engines.has(a.asset_id)) {
      const eid = a.asset_id;
      d.edit('engine', eid, (rec) => {
        const e = rec as unknown as Engine;
        e.log.push(logEntry({
          date: d.today, type: outcome === 'cancelled' ? 'service-cancelled' : outcome === 'rework' ? 'rework' : 'repair',
          description: `${out.icon} ${out.label} · ${job.no} · ${job.title}${job.location ? ` @ ${job.location}` : ''}${noteTxt}`,
          detail: job.detail ?? '', cost: ctx.cost, hours: d.engineHours(eid), outcome,
        }));
        if (out.engine) e.status = out.engine as Engine['status']; else if (e.status === 'fixing') e.status = 'ready';
        if (outcome === 'decommission') { e.retired = true; e.retired_on = d.today; e.retired_reason = note || null; }
      });
      if (outcome === 'decommission') {
        for (const g of [...d.gearboxes.values()].filter((x) => x.engine_id === eid)) {
          d.edit('gearbox', g.id, (rec) => {
            rec.engine_id = null;
            rec.log.push(logEntry({ date: d.today, type: 'remove', description: `✕ ถอดออกจากเครื่องปลดระวาง · ${job.no} (${a.label ?? ''})` }));
          });
          for (const p of [...d.propellers.values()].filter((x) => x.gearbox_id === g.id)) {
            d.edit('propeller', p.id, (rec) => { rec.log.push(logEntry({ date: d.today, type: 'note', description: `เครื่องปลดระวาง · ${job.no} · เกียร์ถูกถอดออก` })); });
          }
        }
      }
    }
    if (a.type === 'gearbox') {
      // An old row names its gearbox by serial only.
      const gid = a.asset_id && d.gearboxes.has(a.asset_id) ? a.asset_id
        : !a.asset_id && a.label ? [...d.gearboxes.values()].find((g) => g.serial && (g.serial === a.label || a.label!.startsWith(g.serial)))?.id : undefined;
      if (gid) {
        const byId = !!a.asset_id;
        d.edit('gearbox', gid, (rec) => {
          const g = rec as unknown as Gearbox;
          if (byId) {
            const installH = g.engine_id && d.engines.has(g.engine_id) ? d.engineHours(g.engine_id) : 0;
            g.log.push(logEntry({ date: d.today, type: outcome === 'cancelled' ? 'service-cancelled' : outcome === 'rework' ? 'rework' : 'install', description: `${out.icon} ${out.label} · Job ${job.no}${noteTxt}`, engine_hours: installH, outcome }));
            if (outcome === 'success' || outcome === 'limited') g.install_hours = installH;
          } else {
            g.log.push(logEntry({ date: d.today, type: 'repair', description: `${out.icon} ${out.label} · ${job.no} · ${job.title}${noteTxt}`, cost: ctx.cost, outcome }));
          }
          if (out.gearbox) g.status = out.gearbox as Gearbox['status']; else if (g.status === 'fixing') g.status = 'ready';
        });
      }
    }
    if (a.type === 'propeller' && a.asset_id && d.propellers.has(a.asset_id)) {
      d.edit('propeller', a.asset_id, (rec) => {
        const p = rec as unknown as Propeller;
        p.log.push(logEntry({ date: d.today, type: outcome === 'cancelled' ? 'service-cancelled' : outcome === 'rework' ? 'rework' : 'install', description: `${out.icon} ${out.label} · Job ${job.no}${noteTxt}`, outcome }));
        if (out.propeller) p.status = out.propeller as Propeller['status']; else if (p.status === 'fixing') p.status = 'active';
      });
    }
  }
  const closing = `${out.icon} ปิด Job ${job.no} · ${out.label} · ฿${money(ctx.cost)}${noteTxt}${boat ? ` · ${boat.name} = ${out.boat}` : ''}`;
  d.pushIncidentLog(job, closing);
  job.progress_log.push(line(d.today, `${out.icon} ปิด Job · ${out.label} · ฿${money(ctx.cost)}${noteTxt}${boat ? ` · ${boat.name} = ${out.boat}` : ''}`, 'ระบบ', d.today));
  if (job.incident_id && outcome !== 'cancelled') {
    const inc = d.incidents.get(job.incident_id);
    if (inc && inc.status !== 'closed' && ctx.incidentJobs.every((x) => x.status === 'done' || x.id === job.id)) {
      inc.status = 'closed'; inc.closed_on = d.today;
      inc.progress_log.push(line(d.today, `✓ ปิด Incident · MJ ${job.no} ${out.label}${noteTxt}`, 'ระบบ', d.today));
      d.putIncident(inc);
    }
  }
  d.putJob(job);
  const serviceReset = offer && reset ? resetService(d, job, ctx.lifetimeOf) : 0;
  return { job, boat_status_after: after, service_reset: serviceReset };
}

// ── Jobs: the boat's status while the job runs ──

/**
 * `flSaveEditBoatStatus`: the job's boat status changes from a date. The boat's open entries this job
 * wrote end that day, and a new one starts (an `available` one says the boat is back).
 */
export function jobBoatStatusChange(d: FleetDraft, current: Job, body: Record<string, unknown>): Job {
  if (current.status === 'done') refuse(`${current.no} is closed`, 409, 'job_done');
  const status = body.status === undefined ? bad('status is required: available, fixing or unavailable') : boatStatusOf(body.status);
  const old = jobBoatStatus(current);
  if (status === old) bad(`The boat status is ${old} already`);
  const date = body.effective_date === undefined || body.effective_date === null || body.effective_date === '' ? bad('effective_date is required') : realDate(body.effective_date, 'effective_date');
  const reason = status === 'unavailable' ? reasonOf(body.reason) ?? bad('reason is required when the boat is unavailable') : null;
  const note = text(body.note, 'note');
  const job = copyJob(current);
  job.boat_status = status; job.boat_status_reason = reason; job.set_fixing = setFixingOf(status);
  const boat = d.boats.get(job.boat_id);
  if (boat) {
    const log = boat.status_log.map((e) => (e.to_date === null && e.note?.includes(job.no) ? { ...e, to_date: date < e.from_date ? e.from_date : date } : { ...e }));
    const newId = entryIdMaker(log, d.now)();
    log.push(status !== 'available'
      ? statusEntry(newId, status, date, job.location ?? '', `Maintenance Job ${job.no} (status changed)`, reason)
      : statusEntry(newId, 'available', date, '', `${job.no} · เรือกลับมาใช้งานได้${note ? ` · ${note}` : ''}`, null));
    d.putBoat({ ...boat, status_log: log });
  }
  const label: Record<string, string> = { available: '🟢 Available', fixing: '🟡 Fixing', unavailable: '🔴 Unavailable' };
  job.progress_log.push(line(date, `⚙️ เปลี่ยน Boat Status: ${label[old] ?? old} → ${label[status]}${reason ? ` · ${reason}` : ''}${note ? ` · "${note}"` : ''}`, 'ผู้ใช้', d.today));
  d.putJob(job);
  return job;
}

// ── Jobs: parts of the boat on the job ──

const ADD_LABEL: Record<string, string> = { gearbox: 'เกียร์', propeller: 'ใบจักร', hull: 'ตัวเรือ', safety: 'Safety' };

/** `flMaintAddAsset`: an engine, gearbox or propeller off for repair (fixing, logged with its hours), or the hull by a label. */
export function addedJobAsset(d: FleetDraft, current: Job, body: Record<string, unknown>): Job {
  if (current.status === 'done') refuse(`${current.no} is closed`, 409, 'job_done');
  const type = (DAMAGE_TYPES as readonly unknown[]).includes(body.type) ? body.type as DamageType : bad(`type must be one of ${DAMAGE_TYPES.join(', ')}`);
  const job = copyJob(current);
  let detail = text(body.detail, 'detail') ?? '';
  let label = '', assetId: string | null = null;
  const kind = ASSET_KINDS_OF[type];
  const id = text(body.asset_id, 'asset_id');
  if (type === 'engine' && !id) bad('asset_id is required for an engine');
  if (kind && id) {
    const rec = d.asset(kind, id) ?? bad(`${type} ${id} does not exist`);
    assetId = id;
    if (kind === 'engine') {
      const e = rec as Engine;
      const h = d.engineHours(e.id);
      label = `${e.serial ?? ''} · ${e.pos || 'Spare'}`;
      detail = detail || `${e.brand ?? ''} ${e.model ?? ''}`.trim();
      d.edit('engine', e.id, (r) => { r.log.push(logEntry({ date: d.today, type: 'status', description: `ถอดเพื่อซ่อม · Job ${job.no} · ${e.boat_id ? d.boatName(e.boat_id) : '?'} (${e.pos ?? ''})`, hours: h })); r.status = 'fixing'; });
      d.pushIncidentLog(job, `🔧 ถอดเครื่องยนต์ ${e.serial ?? ''} (${e.pos ?? ''}) → Fixing · ${h}h`);
      job.progress_log.push(line(d.today, `🔧 ถอดเครื่องยนต์ ${e.serial ?? ''} (${e.pos ?? ''}) → Fixing · เครื่อง ${h}h`, 'ระบบ', d.today));
    } else if (kind === 'gearbox') {
      const g = rec as Gearbox;
      const removeH = g.engine_id && d.engines.has(g.engine_id) ? d.engineHours(g.engine_id) : 0;
      const usedH = Math.max(0, removeH - (g.install_hours || g.base_hours || 0));
      label = g.serial ?? '';
      detail = detail || `${g.brand ?? ''} ${g.model ?? ''}${g.shaft_length ? ` · ${g.shaft_length}` : ''}${g.rotation ? ` · ${g.rotation}` : ''}`;
      d.edit('gearbox', g.id, (r) => { r.log.push(logEntry({ date: d.today, type: 'remove', description: `ถอดเพื่อซ่อม · Job ${job.no} · ${d.boatName(job.boat_id)}`, engine_hours: removeH, used_hours: usedH })); r.status = 'fixing'; });
      d.pushIncidentLog(job, `⚙️ ถอดเกียร์ ${g.serial ?? ''} → Fixing · เครื่อง ${removeH}h · เกียร์ใช้งาน ${usedH}h`);
      job.progress_log.push(line(d.today, `⚙️ ถอดเกียร์ ${g.serial ?? ''} · เครื่อง ${removeH}h · เกียร์ ${usedH}h`, 'ระบบ', d.today));
    } else {
      const p = rec as Propeller;
      label = p.serial ?? '';
      detail = detail || `${p.brand ?? ''} ${p.size ?? ''} · ${p.blades ?? ''} blade · ${p.material ?? ''}`;
      d.edit('propeller', p.id, (r) => { r.log.push(logEntry({ date: d.today, type: 'remove', description: `ถอดเพื่อซ่อม · Job ${job.no}` })); r.status = 'fixing'; });
      d.pushIncidentLog(job, `🌀 ถอดใบจักร ${p.serial ?? ''} → Fixing`);
      job.progress_log.push(line(d.today, `🌀 ถอดใบจักร ${p.serial ?? ''} → Fixing`, 'ระบบ', d.today));
    }
  } else {
    label = required(body.label, 'label');
    const lineText = `+ เพิ่ม ${ADD_LABEL[type] ?? type}: ${label}${detail ? ` — ${detail}` : ''}`;
    d.pushIncidentLog(job, lineText);
    job.progress_log.push(line(d.today, lineText, 'ระบบ', d.today));
  }
  job.assets.push({ type, asset_id: assetId, label, detail, status: 'fixing', added_on: d.today });
  d.putJob(job);
  return job;
}

/** `flMaintRemoveAsset`: off the job's list; an engine's history says so. */
export function removedJobAsset(d: FleetDraft, current: Job, index: number): Job {
  const job = copyJob(current);
  const a = job.assets[index] ?? refuse('Asset not found on this job', 404);
  if (a.type === 'engine' && a.asset_id && d.engines.has(a.asset_id)) {
    const h = d.engineHours(a.asset_id);
    d.edit('engine', a.asset_id, (r) => { r.log.push(logEntry({ date: d.today, type: 'status', description: `ถอดออกจาก Job ${job.no}`, hours: h })); });
    d.pushIncidentLog(job, `− ลบ asset: ${a.label ?? ''} ออกจาก Job`);
  }
  job.assets.splice(index, 1);
  d.putJob(job);
  return job;
}

// ── Jobs: split per engine ──

/**
 * One job per engine. `job_engines` (`flSplitExistingJob`): the job keeps its first engine and the
 * rest each get a new job. `boat_engines` (`flEngSplitIntoJobs`): every engine on the boat not on the
 * job yet gets one (the first joins this job when it has none). New jobs are numbered by `nos`.
 */
export function splitJob(d: FleetDraft, current: Job, body: Record<string, unknown>, ids: () => string, existing: readonly { id: string; no: string }[]): Job[] {
  const by = body.by === 'job_engines' || body.by === 'boat_engines' ? body.by : bad('by must be job_engines or boat_engines');
  const job = copyJob(current);
  const suffixOfEngine = (e: Engine | undefined, fallback: string) => (e ? `${e.serial ?? ''}${e.pos ? ` · ${e.pos}` : ''}` : fallback);
  type Plan = { suffix: string; asset: JobAsset };
  const plans: Plan[] = [];
  let baseTitle = job.title;
  if (by === 'job_engines') {
    const engines = job.assets.filter((a) => a.type === 'engine' && a.asset_id);
    if (engines.length < 2) refuse(`${job.no} has fewer than 2 engines: nothing to split`, 409, 'nothing_to_split');
    baseTitle = job.title.replace(/\s+—\s+.*$/, '');
    const keep = engines[0];
    job.assets = [keep, ...job.assets.filter((a) => !(a.type === 'engine' && a.asset_id))];
    const keepSuffix = suffixOfEngine(d.engines.get(keep.asset_id!), keep.label ?? 'Engine');
    job.title = `${baseTitle} — ${keepSuffix}`;
    job.progress_log.push(line(d.today, `+ Split job · this job = ${keepSuffix}`, 'ระบบ', d.today));
    for (const a of engines.slice(1)) {
      const suffix = suffixOfEngine(d.engines.get(a.asset_id!), a.label ?? 'Engine');
      plans.push({ suffix, asset: { type: 'engine', asset_id: a.asset_id, label: a.label || suffix, detail: a.detail || '', status: a.status || 'fixing', added_on: null } });
    }
  } else {
    const onJob = new Set(job.assets.filter((a) => a.type === 'engine' && a.asset_id).map((a) => a.asset_id));
    const toAdd = [...d.engines.values()].filter((e) => e.boat_id === job.boat_id && !onJob.has(e.id));
    if (!toAdd.length) refuse("Every engine on the boat is on the job already", 409, 'nothing_to_split');
    const asset = (e: Engine): JobAsset => ({ type: 'engine', asset_id: e.id, label: `${e.serial ?? ''} · ${e.pos ?? ''}`, detail: `${e.brand ?? ''} ${e.model ?? ''}`.trim(), status: 'fixing', added_on: null });
    toAdd.forEach((e, i) => {
      const suffix = suffixOfEngine(e, 'Engine');
      if (i === 0 && onJob.size === 0) {
        job.assets.push(asset(e));
        job.title = `${baseTitle} — ${suffix}`;
        job.progress_log.push(line(d.today, `+ Split per engine · this job = ${suffix}`, 'ระบบ', d.today));
        return;
      }
      plans.push({ suffix, asset: asset(e) });
    });
  }
  const nos = Array.isArray(body.nos) ? body.nos.map((n, i) => numberOf(n, `nos[${i}]`)) : bad(`nos is required: ${plans.length} number(s) for the new job(s)`);
  if (nos.length !== plans.length) bad(`nos must hold ${plans.length} number(s), one per new job`);
  if (new Set(nos).size !== nos.length) bad('nos must not repeat a number');
  for (const no of nos) assertNoFree(no, existing);
  const created = plans.map((p, i): Job => {
    const j: Job = {
      ...blankJob(), id: ids(), no: nos[i], boat_id: job.boat_id, type: job.type, title: `${baseTitle} — ${p.suffix}`, detail: job.detail ?? '', location: job.location ?? '',
      status: 'pending', start_date: job.start_date, incident_id: job.incident_id, assets: [p.asset], boat_status: job.boat_status ?? 'fixing',
      boat_status_reason: job.boat_status_reason, set_fixing: job.set_fixing, parent_project_id: job.parent_project_id,
      progress_log: [line(d.today, `+ Split from ${job.no} · ${p.suffix}`, 'ระบบ', d.today)],
    };
    projectLine(j, d);
    d.putJob(j);
    return j;
  });
  d.putJob(job);
  return [job, ...created];
}

// ── Lists, as both stores answer them ──

export type IncidentQuery = { ids?: readonly string[]; boatId?: string; jobId?: string };
export type JobQuery = { ids?: readonly string[]; boatId?: string; status?: Job['status']; incidentId?: string };
const cmp = (a: string | null, b: string | null): number => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1);
/** Newest first: by date, then number, then id. */
export const sortIncidents = (list: readonly Incident[]): Incident[] => [...list].sort((a, b) => cmp(b.date, a.date) || cmp(b.no, a.no) || cmp(a.id, b.id));
/** Newest first: by start date (none last), then number, then id. */
export const sortJobs = (list: readonly Job[]): Job[] =>
  [...list].sort((a, b) => (a.start_date === null ? 1 : 0) - (b.start_date === null ? 1 : 0) || cmp(b.start_date, a.start_date) || cmp(b.no, a.no) || cmp(a.id, b.id));
export const matchesIncident = (i: Incident, q: IncidentQuery): boolean =>
  (!q.ids || q.ids.includes(i.id)) && (q.boatId === undefined || i.boat_id === q.boatId) && (q.jobId === undefined || i.job_id === q.jobId);
export const matchesJob = (j: Job, q: JobQuery): boolean =>
  (!q.ids || q.ids.includes(j.id)) && (q.boatId === undefined || j.boat_id === q.boatId) && (q.status === undefined || j.status === q.status)
  && (q.incidentId === undefined || j.incident_id === q.incidentId);
