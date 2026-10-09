/**
 * Legacy's engines, gearboxes, propellers, incidents and maintenance jobs as this service's records
 * (todo/fleet-maintenance-model.md, part A; migration 130). Pure, so `test/legacy-fleet.test.ts`
 * checks the mapping on fixture rows; `import-fleet.ts` reads the source and writes what this returns.
 *
 * Imported as legacy has them (decided 2026-10-09) and listed: duplicate numbers, the incident linked
 * to a deleted job, the `inprogress` incident status and the `high` severity. A blank is null; a
 * date that is not a date is dropped and counted. A row that cannot be stored (no boat here, no
 * title, a status no column takes) is skipped with the reason, never guessed.
 */
import { ENGINE_STATUSES, PROPELLER_STATUSES, logEntry, type AssetLogEntry, type Engine, type Gearbox, type Propeller } from '../domain/fleet-assets.js';
import { DAMAGE_TYPES, JOB_BOAT_STATUSES, JOB_TYPES, OUTCOMES, type DamageType, type Incident, type Job, type ProgressLine } from '../domain/fleet-jobs.js';
import type { Report } from './legacy-records.js';
import type { Assignment } from '../domain/fleet-assignments.js';

type Row = Record<string, unknown>;
export type FleetSource = {
  engines: Row[]; engineLog: Row[]; gearboxes: Row[]; gearboxLog: Row[]; propellers: Row[]; propellerLog: Row[];
  incidents: Row[]; incidentAssets: Row[]; incidentLog: Row[]; incidentJobs: Row[];
  jobs: Row[]; jobAssets: Row[]; jobParts: Row[]; jobLog: Row[];
  /** `boats__assignments` (fleet extras), mapped by `mapLegacyAssignments`. */
  assignments?: Row[];
};
export type FleetRows = { engines: Engine[]; gearboxes: Gearbox[]; propellers: Propeller[]; incidents: Incident[]; jobs: Job[] };

const str = (v: unknown): string => (v == null ? '' : String(v).trim());
const text = (v: unknown): string | null => str(v) || null;
const num = (v: unknown): number | null => { const s = str(v); if (!s) return null; const n = Number(s); return Number.isFinite(n) ? n : null; };
const nonNegative = (v: unknown): number | null => { const n = num(v); return n !== null && n >= 0 ? n : null; };
const positiveInt = (v: unknown): number | null => { const n = num(v); return n !== null && Number.isInteger(n) && n > 0 ? n : null; };
const money = (v: unknown): number | null => { const n = nonNegative(v); return n === null ? null : Math.round(n * 100) / 100; };
const isDay = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
/** Groups child rows by their parent's id, each list in legacy's order (`idx`). */
const byParent = (rows: Row[], key: string): Map<string, Row[]> => {
  const out = new Map<string, Row[]>();
  for (const r of [...rows].sort((a, b) => Number(a.idx) - Number(b.idx))) {
    const k = str(r[key]);
    (out.get(k) ?? out.set(k, []).get(k)!).push(r);
  }
  return out;
};

export function mapLegacyFleet(src: FleetSource, ctx: { boats: ReadonlySet<string> }, report: Report): FleetRows {
  /** A date, or null; one that is there but is not a date is counted. */
  const day = (v: unknown, what: string): string | null => {
    const s = str(v).slice(0, 10);
    if (!s) return null;
    if (isDay(s)) return s;
    report.note(`${what}: not a date, dropped`);
    return null;
  };
  const boat = (v: unknown, what: string): string | null => {
    const id = str(v);
    if (!id) return null;
    if (ctx.boats.has(id)) return id;
    report.note(`${what}: boat ${id} not in the catalogue, left off its boat`);
    return null;
  };
  const assetLog = (rows: Row[] | undefined, what: string): AssetLogEntry[] => (rows ?? []).map((l) => logEntry({
    date: day(l.date, `${what} history dates`), type: text(l.type), description: text(l.desc), detail: text(l.detail), text: text(l.text),
    hours: num(l.hours), engine_hours: num(l.enginehours), used_hours: num(l.usedhours), from_loc: text(l.fromloc), to_loc: text(l.toloc),
    incident_id: text(l.incidentid), outcome: text(l.outcome), cost: money(l.cost), by: text(l.by),
  }));
  const progress = (rows: Row[] | undefined, what: string): ProgressLine[] => (rows ?? []).map((l) => ({
    date: day(l.date, `${what} progress dates`), text: text(l.text), by: text(l.by), created_on: day(l.createdat, `${what} progress created dates`),
  }));
  const base = (v: unknown, what: string): number => {
    const n = num(v);
    if (n !== null && n < 0) report.note(`${what} with negative base hours (imported as 0)`);
    return n !== null && n >= 0 ? n : 0;
  };

  // ── Assets ──
  const engineLogs = byParent(src.engineLog, 'fleet_engines_id');
  const engines: Engine[] = [];
  for (const r of src.engines) {
    const id = str(r.id), status = str(r.status);
    if (!id) { report.skip('engine', '(blank)', 'no id'); continue; }
    if (!(ENGINE_STATUSES as readonly string[]).includes(status)) { report.skip('engine', id, `status ${status || '(blank)'}`); continue; }
    engines.push({
      id, brand: text(r.brand), model: text(r.model), serial: text(r.serial), hp: nonNegative(r.hp), boat_id: boat(r.boatid, 'engines'), pos: text(r.pos),
      status: status as Engine['status'], base_hours: base(r.basehours, 'engines'), service_interval: positiveInt(r.serviceinterval),
      buy_date: day(r.buydate, 'engine buy dates'), price: money(r.price), note: text(r.note), spare_location: text(r.sparelocation),
      last_service_hours: nonNegative(r.lastservicehours), last_service_date: day(r.lastservicedate, 'engine service dates'),
      retired: false, retired_on: null, retired_reason: null, log: assetLog(engineLogs.get(id), 'engine'),
    });
  }
  const serials = new Map<string, number>();
  for (const e of engines) if (e.serial) serials.set(e.serial, (serials.get(e.serial) ?? 0) + 1);
  for (const [serial, n] of serials) if (n > 1) report.note(`engine serial ${serial} used ${n} times (imported as is)`);
  const engineIds = new Set(engines.map((e) => e.id));

  const gearboxLogs = byParent(src.gearboxLog, 'fleet_gearboxes_id');
  const gearboxes: Gearbox[] = [];
  for (const r of src.gearboxes) {
    const id = str(r.id), status = str(r.status);
    if (!id) { report.skip('gearbox', '(blank)', 'no id'); continue; }
    if (!(ENGINE_STATUSES as readonly string[]).includes(status)) { report.skip('gearbox', id, `status ${status || '(blank)'}`); continue; }
    let engineId = text(r.engineid);
    if (engineId && !engineIds.has(engineId)) { report.note(`gearboxes on an engine not imported (left loose)`); engineId = null; }
    gearboxes.push({
      id, brand: text(r.brand), model: text(r.model), model_suffix: text(r.modelsuffix), serial: text(r.serial), boat_id: boat(r.boatid, 'gearboxes'),
      engine_id: engineId, on_boat_id: boat(r.onboatid, 'gearboxes left on a boat'), on_boat_pos: text(r.onboatpos), status: status as Gearbox['status'],
      base_hours: base(r.basehours, 'gearboxes'), install_hours: num(r.installhours), service_interval: positiveInt(r.serviceinterval), last_service_hours: null,
      last_service_date: day(r.lastservicedate, 'gearbox service dates'), buy_date: day(r.buydate, 'gearbox buy dates'), note: text(r.note),
      spare_location: text(r.sparelocation), shaft_length: text(r.shaftlength), rotation: text(r.rotation), gear_ratio: text(r.gearratio),
      oil_capacity: text(r.oilcapacity), log: assetLog(gearboxLogs.get(id), 'gearbox'),
    });
  }
  const gearboxIds = new Set(gearboxes.map((g) => g.id));

  const propellerLogs = byParent(src.propellerLog, 'fleet_propellers_id');
  const propellers: Propeller[] = [];
  const perGearbox = new Map<string, number>();
  for (const r of src.propellers) {
    const id = str(r.id), status = str(r.status);
    if (!id) { report.skip('propeller', '(blank)', 'no id'); continue; }
    if (!(PROPELLER_STATUSES as readonly string[]).includes(status)) { report.skip('propeller', id, `status ${status || '(blank)'}`); continue; }
    let gearboxId = text(r.gearboxid);
    if (gearboxId && !gearboxIds.has(gearboxId)) { report.note('propellers on a gearbox not imported (left loose)'); gearboxId = null; }
    if (gearboxId) perGearbox.set(gearboxId, (perGearbox.get(gearboxId) ?? 0) + 1);
    if (text(r.engineid)) report.note('propeller engineid dropped (a propeller hangs on its gearbox)');
    propellers.push({
      id, brand: text(r.brand), serial: text(r.serial), old_serial: text(r.oldserial), boat_id: boat(r.boatid, 'propellers'), gearbox_id: gearboxId,
      prop_pos: text(r.proppos), diameter: nonNegative(r.diameter), pitch: nonNegative(r.pitch), size: text(r.size), blades: text(r.blades),
      material: text(r.material), rotation: text(r.rotation), hub_size: text(r.hubsize), cupping: text(r.cupping), cost: money(r.cost), install_hours: null,
      status: status as Propeller['status'], buy_date: day(r.buydate, 'propeller buy dates'), note: text(r.note), spare_location: text(r.sparelocation),
      log: assetLog(propellerLogs.get(id), 'propeller'),
    });
  }
  for (const n of perGearbox.values()) if (n > 1) report.note('gearboxes carrying two propellers (twin props, imported as is)');

  // ── Incidents ──
  const legacyJobIds = new Set(src.jobs.map((j) => str(j.id)));
  const incidentAssets = byParent(src.incidentAssets, 'fleet_incidents_id');
  const incidentLogs = byParent(src.incidentLog, 'fleet_incidents_id');
  const incidentJobs = byParent(src.incidentJobs, 'fleet_incidents_id');
  const damageType = (v: unknown, what: string): DamageType | undefined => {
    const t = str(v);
    if ((DAMAGE_TYPES as readonly string[]).includes(t)) return t as DamageType;
    report.note(`${what} of type ${t || '(blank)'} dropped`);
    return undefined;
  };
  const incidents: Incident[] = [];
  for (const r of src.incidents) {
    const id = str(r.id), no = str(r.no), title = str(r.title), status = str(r.status), date = day(r.date, 'incident dates');
    if (!id) { report.skip('incident', '(blank)', 'no id'); continue; }
    if (!no) { report.skip('incident', id, 'no number'); continue; }
    if (!ctx.boats.has(str(r.boatid))) { report.skip('incident', id, `boat ${str(r.boatid) || '(blank)'} not in the catalogue`); continue; }
    if (!date) { report.skip('incident', id, 'no date'); continue; }
    if (!title) { report.skip('incident', id, 'no title'); continue; }
    if (!['open', 'resolved', 'closed', 'inprogress'].includes(status)) { report.skip('incident', id, `status ${status || '(blank)'}`); continue; }
    if (status === 'inprogress') report.note(`incident ${no}: status inprogress (not a value legacy writes; imported as is)`);
    const priority = positiveInt(r.priority);
    const severity = text(r.severity);
    if (severity && !['critical', 'major', 'minor'].includes(severity)) report.note(`incident ${no}: severity ${severity} (imported as is until edited)`);
    const jobId = text(r.maintid);
    if (jobId && !legacyJobIds.has(jobId)) report.note(`incident ${no}: linked to job ${jobId}, which legacy no longer has (kept)`);
    incidents.push({
      id, no, boat_id: str(r.boatid), date, time: text(r.time), title, detail: text(r.detail), remark: text(r.remark),
      priority: priority !== null && priority <= 5 ? priority : null, severity, status, job_id: jobId,
      related_job_ids: (incidentJobs.get(id) ?? []).map((x) => str(x.value)).filter(Boolean),
      closed_on: day(r.closeddate, 'incident closed dates'), quick_fix: r.quickfix === true, resolved_on: day(r.resolveddate, 'incident resolved dates'),
      damaged_assets: (incidentAssets.get(id) ?? []).flatMap((a) => {
        const type = damageType(a.type, 'incident damaged assets');
        if (!type) return [];
        return [{ type, asset_id: text(a.id) ?? text(a.engid) ?? text(a.gbid) ?? text(a.propid), label: text(a.label), swapped: a.swapped === true, swapped_to: text(a.swappedto), swapped_on: day(a.swappeddate, 'swap dates') }];
      }),
      progress_log: progress(incidentLogs.get(id), 'incident'),
    });
  }
  noteDuplicates(incidents, 'incident', report);

  // ── Jobs ──
  const jobAssets = byParent(src.jobAssets, 'fleet_maintenance_id');
  const jobParts = byParent(src.jobParts, 'fleet_maintenance_id');
  const jobLogs = byParent(src.jobLog, 'fleet_maintenance_id');
  const legacyIncidentIds = new Set(src.incidents.map((i) => str(i.id)));
  const jobs: Job[] = [];
  for (const r of src.jobs) {
    const id = str(r.id), no = str(r.no), title = str(r.title), status = str(r.status), type = str(r.type);
    if (!id) { report.skip('job', '(blank)', 'no id'); continue; }
    if (!no) { report.skip('job', id, 'no number'); continue; }
    if (!ctx.boats.has(str(r.boatid))) { report.skip('job', id, `boat ${str(r.boatid) || '(blank)'} not in the catalogue`); continue; }
    if (!title) { report.skip('job', id, 'no title'); continue; }
    if (!(JOB_TYPES as readonly string[]).includes(type)) { report.skip('job', id, `type ${type || '(blank)'}`); continue; }
    if (!['pending', 'inprogress', 'done'].includes(status)) { report.skip('job', id, `status ${status || '(blank)'}`); continue; }
    let endDate = day(r.enddate, 'job end dates');
    if (endDate && status !== 'done') { report.note('job end dates on a job not done, dropped'); endDate = null; }
    const boatStatus = str(r.boatstatus);
    const outcome = str(r.outcome);
    if (status === 'done' && !outcome) report.note('jobs done with no outcome (imported as is)');
    const incidentId = text(r.incidentid);
    if (incidentId && !legacyIncidentIds.has(incidentId)) report.note(`job ${no}: incident ${incidentId} not in legacy (kept)`);
    jobs.push({
      id, no, boat_id: str(r.boatid), type: type as Job['type'], title, detail: text(r.detail), location: text(r.location), status: status as Job['status'],
      start_date: day(r.startdate, 'job start dates'), end_date: endDate, incident_id: incidentId,
      boat_status: (JOB_BOAT_STATUSES as readonly string[]).includes(boatStatus) ? boatStatus as Job['boat_status'] : null,
      boat_status_reason: text(r.boatstatusreason),
      // Legacy reads a missing `setFixing` as holding the boat (`m.setFixing===false` is the only release).
      set_fixing: r.setfixing !== false,
      outcome: (OUTCOMES as readonly string[]).includes(outcome) ? outcome as Job['outcome'] : null,
      close_note: text(r.closenote), awaiting_invoice: r.awaitinginvoice === true, parent_project_id: text(r.parentprojectid), legacy_cost: money(r.cost),
      board_lane: null, owner: null, due_date: null, parked_on: null, pinned: false, pinned_on: null,
      assets: (jobAssets.get(id) ?? []).flatMap((a) => {
        const t = damageType(a.type, 'job assets');
        if (!t) return [];
        return [{ type: t, asset_id: text(a.engid) ?? text(a.gbid) ?? text(a.propid) ?? text(a.id), label: text(a.label), detail: text(a.detail), status: text(a.status), added_on: null }];
      }),
      parts: (jobParts.get(id) ?? []).map((p) => ({
        id: null, inv_id: text(p.invid), name: text(p.name), qty: nonNegative(p.qty) ?? 0, unit: text(p.unit), cost: money(p.cost), location: text(p.location),
        date: day(p.date, 'job part dates'), late: false, late_by: null,
      })),
      progress_log: progress(jobLogs.get(id), 'job'), steps: [],
    });
  }
  noteDuplicates(jobs, 'job', report);
  return { engines, gearboxes, propellers, incidents, jobs };
}

function noteDuplicates(rows: readonly { no: string }[], what: string, report: Report): void {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.no, (counts.get(r.no) ?? 0) + 1);
  for (const [no, n] of counts) if (n > 1) report.note(`${what} number ${no} used ${n} times (imported as is)`);
}

const PIERS = ['tublamu', 'panwa', 'ranong'];
/**
 * Legacy's pier assignments (`boats__assignments`, "Design — extras" 1) as `boat_assignments` rows.
 * Legacy's id is kept; its stored status is not (it is computed here) except `cancelled`. A row the
 * table cannot take (no boat here, a pier that is not one, the same pier twice, dates missing or
 * backwards) is skipped with the reason. Legacy kept no creator or time: the row's `createddate` at
 * midnight in Thailand, plus its place in the boat's list, keeps legacy's order (the first covering
 * one wins).
 */
export function mapLegacyAssignments(rows: readonly Row[], ctx: { boats: ReadonlySet<string> }, report: Report): Assignment[] {
  const out: Assignment[] = [];
  for (const r of [...rows].sort((a, b) => str(a.boats_id).localeCompare(str(b.boats_id)) || Number(a.idx) - Number(b.idx))) {
    const id = str(r.id) || `asn_${str(r.row_pk).split(':').pop()}`;
    const boat = str(r.boats_id), from = str(r.frompier), to = str(r.topier), start = str(r.startdate).slice(0, 10), end = str(r.enddate).slice(0, 10);
    const why = !ctx.boats.has(boat) ? `boat ${boat} is not here` : !PIERS.includes(from) || !PIERS.includes(to) ? `pier ${from} → ${to} is not one of ${PIERS.join(', ')}`
      : from === to ? 'the same pier at both ends' : !isDay(start) || !isDay(end) ? 'a date is missing' : end < start ? 'it ends before it starts' : null;
    if (why) { report.skip('assignment', id, why); continue; }
    const created = isDay(str(r.createddate).slice(0, 10)) ? str(r.createddate).slice(0, 10) : start;
    const type = str(r.type) === 'permanent' ? 'permanent' : 'temporary';
    if (str(r.type) !== type) report.note(`assignment type "${str(r.type)}" read as temporary`);
    out.push({
      id, boat_id: boat, type, from_pier: from, to_pier: to, start_date: start, end_date: end, reason: text(r.reason), cost: money(r.cost) ?? 0,
      cancelled: str(r.status) === 'cancelled', cancelled_at: null, cancelled_by: null, created_date: created,
      created_at: new Date(Date.parse(`${created}T00:00:00+07:00`) + Number(r.idx ?? 0) * 1000).toISOString(), created_by: null,
    });
  }
  return out;
}
