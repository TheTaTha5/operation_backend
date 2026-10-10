/**
 * Fleet Insights (legacy `05-fleet.js` `flRenderInsights`) and the Fleet Report (`08-app.js`
 * `repFleetGather`, `repFleetSlides`), computed on read (todo/fleet-maintenance-model.md, "Design —
 * insights"). Pure: the routes gather rows, these decide every number, so both stores agree.
 *
 * Every figure reads the developer's definitions (2026-10-10): a job's cost is `jobCost`, dated by its
 * close date (`closedOn`); service due is hours since the last service against the engine's own
 * interval (`engineService`). Where legacy dated by the start date or counted by modulo, this differs.
 */
import { dayGap, round2 } from './fleet-common.js';
import { eachDate } from './calendar.js';
import { engineService } from './fleet-assets.js';
import { documentsView } from './fleet-certificates.js';
import { jobCost, type Incident, type Job, type LinkedMemo } from './fleet-jobs.js';
import type { Memo } from './fleet-memos.js';
import type { Project } from './fleet-projects.js';
import type { SafetyItem } from './fleet-safety.js';
import type { StockItem, StockView } from './fleet-stock.js';
import type { Meter } from './fleet-daily.js';
import type { BoatDocument } from './catalogue.js';
import { closedOn, jobDays, monthsEnding } from './fleet-reports.js';

const r0 = (n: number) => Math.round(n);
const monthOf = (d: string | null | undefined): string => String(d ?? '').slice(0, 7);
const avg = (list: readonly number[]): number | null => (list.length ? list.reduce((s, n) => s + n, 0) / list.length : null);
const isOpen = (j: Pick<Job, 'status'>) => j.status === 'pending' || j.status === 'inprogress';
const deltaPct = (cur: number, prev: number): number | null => (prev > 0 ? r0(((cur - prev) / prev) * 100) : null);

// ── Fleet Insights ──

export const INSIGHT_PERIODS = ['month', 'quarter', 'ytd', 'all'] as const;
export type InsightPeriod = typeof INSIGHT_PERIODS[number];
/** The period's first day (legacy `_insightsTimeFilter`); it runs to today. `all` has none. */
export function periodStart(period: InsightPeriod, today: string): string | null {
  const y = today.slice(0, 4), m = Number(today.slice(5, 7));
  if (period === 'month') return `${today.slice(0, 7)}-01`;
  if (period === 'quarter') return `${y}-${String(Math.floor((m - 1) / 3) * 3 + 1).padStart(2, '0')}-01`;
  if (period === 'ytd') return `${y}-01-01`;
  return null;
}

/** Legacy's purchase statuses that count as spent on the supplier chart (`APPROVED_STATUSES`). */
const BOUGHT = ['approved', 'ordered', 'received', 'paid'];
const COMPANY_RE = /\b(Marine|Mall|Co\.?\s*Ltd|Co\.|Ltd|Suzuki|Honda|Yamaha|Megazip|บจ\.|บริษัท|Hilltribe|Industries|Hardware|Parts|Service|Materials|Trading)\b/i;
const DOC_RE = /^(\d{2}\/\d{2}\/\d{4}|[A-Z]{2,3}[-\s]?\d{4,}|CO\d+|Tax Invoice|Invoice|IV\d+|SO\s?\d+|QT[-\s]?\d+)$/i;
/**
 * The supplier a memo is counted under (legacy `extractSupplier`): its own supplier; else the supplier
 * most of its stock items name; else the part of its reference note that reads as a company, or the
 * first that is not a date or document number; else `Other`.
 */
export function supplierOf(m: Pick<Memo, 'supplier' | 'lines' | 'ref_note'>, itemSupplier: (itemId: string) => string | null): string {
  if (m.supplier && m.supplier.trim()) return m.supplier.trim();
  const counts = new Map<string, number>();
  for (const l of m.lines) {
    const s = l.item_id ? itemSupplier(l.item_id) : null;
    if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const top = [...counts].sort((a, b) => b[1] - a[1])[0];
  if (top) return top[0];
  if (m.ref_note) {
    const parts = m.ref_note.split('·').map((s) => s.trim());
    for (const seg of parts) {
      if (COMPANY_RE.test(seg)) return seg.replace(/^อ้างอิง\s*/i, '').replace(/\s+(IV\S+|SO\S+|QT\S+|IN\S*|CO\d+|\d{2}\/\d{2}\/\d{4}).*$/i, '').trim();
    }
    for (const seg of parts) {
      const cleaned = seg.replace(/^อ้างอิง\s*/i, '').trim();
      if (!DOC_RE.test(cleaned) && cleaned.length > 3) return cleaned;
    }
  }
  return 'Other';
}

export type InsightBoat = {
  id: string; name: string; pier: string | null; ownership: string; retired: boolean;
  /** The effective status today (`availability`). */
  status: string;
  pier_today: string | null;
  documents: readonly BoatDocument[];
};
export type InsightEngine = {
  id: string; boat_id: string | null; serial: string | null; model: string | null; brand: string | null;
  hours: number; service_interval: number | null; last_service_hours: number | null; base_hours: number;
};
export type InsightsInput = {
  today: string; period: InsightPeriod;
  boats: readonly InsightBoat[]; jobs: readonly Job[]; incidents: readonly Incident[]; memos: readonly Memo[];
  memosOf: (jobId: string) => LinkedMemo[]; items: readonly Pick<StockItem, 'id' | 'supplier'>[]; engines: readonly InsightEngine[];
};

/** `GET /v1/fleet/insights?period=`: every figure legacy's Insights page draws. */
export function insights(input: InsightsInput) {
  const { today, period } = input;
  const from = periodStart(period, today);
  const inPeriod = (d: string | null | undefined): boolean => (from === null ? true : !!d && d >= from && d <= today);
  const costOf = new Map(input.jobs.map((j) => [j.id, jobCost(j.parts, input.memosOf(j.id)).cost]));
  const cost = (j: Job) => costOf.get(j.id) ?? 0;
  const boatById = new Map(input.boats.map((b) => [b.id, b]));
  const boatName = (id: string) => boatById.get(id)?.name ?? id;
  const company = input.boats.filter((b) => b.ownership !== 'charter' && !b.retired);

  // Rule 1: a period's jobs are those closed in it; a done job with no close date only in `all`.
  const closed = input.jobs.filter((j) => j.status === 'done' && (from === null || inPeriod(closedOn(j))));
  const open = input.jobs.filter(isOpen);
  const incs = input.incidents.filter((i) => inPeriod(i.date));
  const spent = closed.reduce((s, j) => s + cost(j), 0);

  // Per company boat. Rule 4: its jobs are those closed in the period plus those open now.
  const stats = company.map((b) => {
    const mineClosed = closed.filter((j) => j.boat_id === b.id), mineOpen = open.filter((j) => j.boat_id === b.id);
    return {
      boat_id: b.id, name: b.name, pier: b.pier, status: b.status,
      jobs: mineClosed.length + mineOpen.length, jobs_closed: mineClosed.length, jobs_active: mineOpen.length,
      cost: mineClosed.reduce((s, j) => s + cost(j), 0), open_cost: mineOpen.reduce((s, j) => s + cost(j), 0),
      incidents: incs.filter((i) => i.boat_id === b.id).length,
    };
  });
  const health = (s: { jobs: number; cost: number }) => (s.jobs >= 3 || s.cost >= 100000 ? 'critical' : s.jobs >= 1 ? 'watch' : 'healthy');
  const boats = stats.map((s) => ({ ...s, cost: round2(s.cost), open_cost: round2(s.open_cost), health: health(s) })).sort((a, b) => b.cost - a.cost);
  const alert = boats.find((s) => s.cost > 0 || s.jobs > 0);

  const piers: Record<string, number> = { tublamu: 0, panwa: 0, ranong: 0 };
  for (const b of company) if (b.pier_today && b.pier_today in piers) piers[b.pier_today] += 1;

  // The last six months: jobs' cost by close month (rule 1), incidents by date.
  const months = monthsEnding(today.slice(0, 7), 6).map((month) => {
    const list = input.jobs.filter((j) => monthOf(closedOn(j)) === month && closedOn(j) !== null);
    return { month, cost: round2(list.reduce((s, j) => s + cost(j), 0)), jobs: list.length, incidents: input.incidents.filter((i) => monthOf(i.date) === month).length };
  });
  const cur = months[5], prev = months[4];
  const monthTop = company.map((b) => ({
    boat_id: b.id, name: b.name, cost: input.jobs.filter((j) => j.boat_id === b.id && monthOf(closedOn(j)) === cur.month && closedOn(j) !== null).reduce((s, j) => s + cost(j), 0),
  })).filter((x) => x.cost > 0).sort((a, b) => b.cost - a.cost)[0];

  // Purchasing by supplier: memos, dated by the memo (a purchase, not a job's cost).
  const itemSupplier = new Map(input.items.map((i) => [i.id, i.supplier]));
  const bought = input.memos.filter((m) => BOUGHT.includes(m.status) && inPeriod(m.memo_date));
  const sup = new Map<string, { supplier: string; amount: number; memos: number }>();
  for (const m of bought) {
    const k = supplierOf(m, (id) => itemSupplier.get(id) ?? null);
    const g = sup.get(k) ?? { supplier: k, amount: 0, memos: 0 };
    g.amount += m.amount || 0; g.memos += 1;
    sup.set(k, g);
  }
  const bySupplier = [...sup.values()].map((g) => ({ ...g, amount: round2(g.amount) })).sort((a, b) => b.amount - a.amount || a.supplier.localeCompare(b.supplier));

  const byType = (['corrective', 'preventive', 'scheduled'] as const).map((type) => {
    const list = closed.filter((j) => j.type === type);
    return { type, cost: round2(list.reduce((s, j) => s + cost(j), 0)), jobs: list.length };
  });

  // Rule 2, legacy's "Upcoming" card: within 20 % of the interval, or overdue.
  const serviceDue = input.engines.filter((e) => e.boat_id && boatById.has(e.boat_id) && (e.service_interval ?? 0) > 0).map((e) => {
    const s = engineService(e, e.hours);
    return {
      engine_id: e.id, serial: e.serial, model: e.model, brand: e.brand, boat_id: e.boat_id!, boat_name: boatName(e.boat_id!),
      hours: round2(e.hours), since: round2(s.since), interval: s.interval, left: s.left!, overdue: s.overdue,
    };
  }).filter((e) => e.left <= e.interval * 0.2).sort((a, b) => a.left - b.left || a.engine_id.localeCompare(b.engine_id));

  const pending = input.memos.filter((m) => m.status === 'pending_approval');
  const received = input.memos.filter((m) => m.status === 'received');
  const approved = input.memos.filter((m) => BOUGHT.includes(m.status)).length;

  // Done jobs marked awaiting the invoice that no memo names yet (any memo status, legacy).
  const memoJobs = new Set(input.memos.map((m) => m.job_id).filter((x): x is string => !!x));
  const awaiting = input.jobs.filter((j) => j.status === 'done' && j.awaiting_invoice && !memoJobs.has(j.id)).map((j) => ({
    job_id: j.id, no: j.no, boat_id: j.boat_id, boat_name: boatName(j.boat_id), title: j.title, end_date: j.end_date, days_since: j.end_date ? dayGap(j.end_date, today) : 0,
  })).sort((a, b) => b.days_since - a.days_since);

  // Each type's current certificate on a company boat, expiring within 60 days or expired.
  const docs = company.flatMap((b) => documentsView(b.documents, today).filter((d) => d.current && d.days_left !== null && d.days_left <= 60).map((d) => ({
    boat_id: b.id, boat_name: b.name, name: d.name, doc_type: d.doc_type, expires_on: d.expires_on, days_left: d.days_left!,
    severity: d.days_left! < 0 ? 'expired' : d.days_left! <= 14 ? 'critical' : 'warning',
  }))).sort((a, b) => a.days_left - b.days_left || a.boat_name.localeCompare(b.boat_name));

  // Closing speed (rule 3): the period's closed jobs against those closed before it.
  const timed = input.jobs.filter((j) => jobDays(j) !== null);
  const recent = timed.filter((j) => inPeriod(j.end_date)), older = timed.filter((j) => !inPeriod(j.end_date));
  const recentAvg = avg(recent.map((j) => jobDays(j)!)), olderAvg = avg(older.map((j) => jobDays(j)!));
  const closingSpeed = timed.length >= 3 && recentAvg !== null ? {
    jobs: recent.length, average_days: r0(recentAvg), jobs_before: older.length, average_days_before: olderAvg === null ? null : r0(olderAvg),
    change_pct: olderAvg ? r0(Math.abs((recentAvg - olderAvg) / olderAvg) * 100) : null, improved: olderAvg !== null && recentAvg < olderAvg,
  } : null;

  const recurring = stats.filter((s) => s.incidents >= 2).map((s) => {
    const list = incs.filter((i) => i.boat_id === s.boat_id).sort((a, b) => a.date.localeCompare(b.date) || a.no.localeCompare(b.no));
    return { boat_id: s.boat_id, name: s.name, incidents: s.incidents, dates: list.slice(0, 5).map((i) => i.date), titles: list.slice(0, 5).map((i) => i.title) };
  }).sort((a, b) => b.incidents - a.incidents);

  const longRunning = input.jobs.filter((j) => j.status === 'inprogress' && j.start_date && dayGap(j.start_date, today) >= 14).map((j) => ({
    job_id: j.id, no: j.no, boat_id: j.boat_id, boat_name: boatName(j.boat_id), title: j.title, location: j.location, start_date: j.start_date, days: dayGap(j.start_date!, today),
  })).sort((a, b) => b.days - a.days);

  const top = boats[0];
  const concentration = top && spent > 0 && top.cost > spent * 0.5 ? { boat_id: top.boat_id, name: top.name, cost: top.cost, total: round2(spent), pct: r0((top.cost / spent) * 100) } : null;
  const healthy = stats.filter((s) => s.jobs === 0 && s.status === 'available').map((s) => ({ boat_id: s.boat_id, name: s.name }));

  return {
    period, from, to: today,
    fleet: {
      company_boats: company.length, available: company.filter((b) => b.status === 'available').length,
      fixing: company.filter((b) => b.status === 'fixing').length, unavailable: company.filter((b) => b.status === 'unavailable').length, piers,
    },
    kpis: {
      incidents: incs.length, incidents_critical: incs.filter((i) => (i.priority ?? 0) >= 4).length,
      jobs_closed: closed.length, spent: round2(spent), average_per_job: closed.length ? round2(spent / closed.length) : 0,
      active_jobs: open.length, pending_jobs: open.filter((j) => j.status === 'pending').length, open_cost: round2(open.reduce((s, j) => s + cost(j), 0)),
    },
    boats, alert_boat: alert ? { boat_id: alert.boat_id, name: alert.name, jobs: alert.jobs, cost: alert.cost, incidents: alert.incidents } : null,
    trend: {
      months, cost_delta_pct: deltaPct(cur.cost, prev.cost), incidents_delta_pct: deltaPct(cur.incidents, prev.incidents),
      top_boat: monthTop && cur.cost > 0 ? { boat_id: monthTop.boat_id, name: monthTop.name, cost: round2(monthTop.cost), pct: r0((monthTop.cost / cur.cost) * 100) } : null,
    },
    by_supplier: { memos: bought.length, suppliers: bySupplier.length, amount: round2(bought.reduce((s, m) => s + (m.amount || 0), 0)), rows: bySupplier },
    by_type: byType,
    healthy,
    service_due: serviceDue,
    memos: {
      pending: pending.length, pending_amount: round2(pending.reduce((s, m) => s + (m.amount || 0), 0)), pending_nos: pending.slice(0, 3).map((m) => m.no),
      received: received.length, received_amount: round2(received.reduce((s, m) => s + (m.amount || 0), 0)),
      approval_rate: input.memos.length >= 3 ? { total: input.memos.length, approved, pending: pending.length, pct: r0((approved / input.memos.length) * 100) } : null,
    },
    awaiting_invoice: { count: awaiting.length, jobs: awaiting },
    documents: {
      count: docs.length, expired: docs.filter((d) => d.severity === 'expired').length, critical: docs.filter((d) => d.severity === 'critical').length,
      warning: docs.filter((d) => d.severity === 'warning').length, items: docs,
    },
    closing_speed: closingSpeed,
    recurring_incidents: recurring,
    long_running: longRunning,
    cost_concentration: concentration,
  };
}

// ── The Fleet Report ──

/** At most a year and a day of days per report. */
export const MAX_REPORT_DAYS = 366;
/** The same number of days just before (legacy `repPrevRange`). */
export function previousRange(from: string, to: string): { from: string; to: string } {
  const n = dayGap(from, to) + 1;
  const end = new Date(Date.parse(`${from}T00:00:00Z`) - 86400000);
  const start = new Date(end.getTime() - (n - 1) * 86400000);
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

export type ReportBoat = { id: string; name: string; retired: boolean };
export type FleetReportInput = {
  from: string; to: string;
  boats: readonly ReportBoat[];
  /** The effective status of a boat on a day (`availability`, the dashboard's). */
  statusOn: (boatId: string, date: string) => string;
  jobs: readonly Job[]; incidents: readonly Incident[]; memos: readonly Memo[]; memosOf: (jobId: string) => LinkedMemo[];
  projects: readonly Project[];
  /** The Daily Log's meter readings from the previous range's first day to `to`. */
  meters: readonly Meter[];
  stock: readonly StockView[]; safety: readonly Pick<SafetyItem, 'next_pm'>[]; consumables: number;
};
/** Legacy's placeholder inspection date, still on items nobody set a cycle for (`repFleetGather`). */
const DEFAULT_PM = '2026-01-01';

type Count = { key: string; n: number };
const countBy = <T>(list: readonly T[], key: (x: T) => string): Count[] => {
  const out = new Map<string, number>();
  for (const x of list) out.set(key(x), (out.get(key(x)) ?? 0) + 1);
  return [...out].map(([k, n]) => ({ key: k, n })).sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));
};
const sumBy = <T>(list: readonly T[], key: (x: T) => string, amount: (x: T) => number) => {
  const out = new Map<string, { key: string; amount: number; n: number }>();
  for (const x of list) { const g = out.get(key(x)) ?? { key: key(x), amount: 0, n: 0 }; g.amount += amount(x); g.n += 1; out.set(key(x), g); }
  return [...out.values()].map((g) => ({ ...g, amount: round2(g.amount) })).sort((a, b) => b.amount - a.amount || a.key.localeCompare(b.key));
};

/** One range's figures (legacy `repFleetGather`, on rules 1 and 3). */
function gather(input: FleetReportInput, from: string, to: string) {
  const days = [...eachDate(from, to)], nD = days.length;
  const inR = (d: string | null | undefined): boolean => !!d && d >= from && d <= to;
  const boatName = new Map(input.boats.map((b) => [b.id, b.name]));
  const nameOf = (id: string | null) => (id ? boatName.get(id) ?? id : null);

  // Availability: each boat not retired, day by day; a boat never available is idle and left out.
  const act = input.boats.filter((b) => !b.retired);
  const availableDays = new Map(act.map((b) => [b.id, days.filter((d) => input.statusOn(b.id, d) === 'available').length]));
  const idle = act.filter((b) => availableDays.get(b.id) === 0);
  const inService = act.filter((b) => availableDays.get(b.id)! > 0);
  const down = inService.map((b) => ({ boat_id: b.id, name: b.name, days: nD - availableDays.get(b.id)! })).filter((x) => x.days > 0)
    .map((x) => ({ ...x, available_pct: r0(((nD - x.days) / nD) * 100) })).sort((a, b) => b.days - a.days || a.name.localeCompare(b.name));
  const downDays = down.reduce((s, x) => s + x.days, 0);

  const incs = input.incidents.filter((i) => inR(i.date));
  const sev = countBy(incs, (i) => i.severity || '—');

  // Jobs (rules 1 and 3): closed and costed by their close date; opened by their start.
  const closed = input.jobs.filter((j) => inR(closedOn(j)));
  const costs = closed.map((j) => jobCost(j.parts, input.memosOf(j.id)).cost);
  const repairs = costs.reduce((s, c) => s + c, 0);
  const durations = closed.map(jobDays).filter((d): d is number => d !== null);
  const openList = input.jobs.filter((j) => j.status !== 'done' && j.start_date && j.start_date <= to).map((j) => ({
    job_id: j.id, no: j.no, title: j.title, boat_id: j.boat_id, boat_name: nameOf(j.boat_id), status: j.status, start_date: j.start_date!, age: dayGap(j.start_date!, to) + 1,
  })).sort((a, b) => b.age - a.age || a.no.localeCompare(b.no));

  // Engine hours: last − first reading above 0 per boat and engine in the range, every trip type.
  const reads = new Map<string, { boat_id: string; lo: number; hi: number; n: number }>();
  for (const m of input.meters) {
    if (!inR(m.date) || m.reading === null || !(m.reading > 0)) continue;
    const k = `${m.boat_id}|${m.engine_id}`;
    const r = reads.get(k);
    if (!r) reads.set(k, { boat_id: m.boat_id, lo: m.reading, hi: m.reading, n: 1 });
    else { r.lo = Math.min(r.lo, m.reading); r.hi = Math.max(r.hi, m.reading); r.n += 1; }
  }
  const hours = new Map<string, number>();
  for (const r of reads.values()) if (r.hi - r.lo > 0) hours.set(r.boat_id, (hours.get(r.boat_id) ?? 0) + (r.hi - r.lo));
  const engineTotal = [...hours.values()].reduce((s, h) => s + h, 0);

  // Projects overlapping the range; a cancelled one is left out (legacy counted it as active).
  const projects = input.projects.filter((p) => p.status !== 'cancelled').flatMap((p) => {
    const a = p.actual_from ?? p.plan_from, e = p.plan_to;
    if (!a || a > to) return [];
    if (e && e < from && p.status === 'completed') return [];
    const late = e && p.status !== 'completed' && e < to ? dayGap(e, to) : 0;
    return [{ project_id: p.id, no: p.no, name: p.name, boat_id: p.boat_id, boat_name: nameOf(p.boat_id), type: p.type, status: p.status, plan_to: e, late_days: late }];
  }).sort((a, b) => b.late_days - a.late_days || a.no.localeCompare(b.no));

  // Purchasing: memos dated in the range, not cancelled, after discount (before VAT), as legacy.
  const memos = input.memos.filter((m) => inR(m.memo_date) && m.status !== 'cancelled');
  const amt = (m: Memo) => m.after_discount || m.amount || 0;
  const purchasing = memos.reduce((s, m) => s + amt(m), 0);
  const pend = memos.filter((m) => m.status === 'pending_approval');
  // Total spend: repairs plus the memos no job's cost already holds.
  const unlinked = memos.filter((m) => !m.job_id).reduce((s, m) => s + amt(m), 0);

  return {
    from, to, days: nD,
    availability: {
      boats_registered: act.length, boats_in_service: inService.length, idle_boats: idle.map((b) => ({ boat_id: b.id, name: b.name })),
      down_days: downDays, availability_pct: inService.length * nD > 0 ? Math.max(0, r0((1 - downDays / (inService.length * nD)) * 100)) : 0, down_by_boat: down,
    },
    incidents: {
      count: incs.length, open: incs.filter((i) => i.status === 'open' || i.status === 'inprogress').length,
      serious: incs.filter((i) => i.severity === 'critical' || i.severity === 'major').length,
      by_severity: sev.map((x) => ({ severity: x.key, n: x.n })), by_boat: countBy(incs, (i) => i.boat_id).map((x) => ({ boat_id: x.key, name: nameOf(x.key), n: x.n })),
    },
    jobs: {
      closed: closed.length, opened: input.jobs.filter((j) => inR(j.start_date)).length, average_days: durations.length ? r0(avg(durations)!) : null,
      cost: round2(repairs), with_cost: costs.filter((c) => c > 0).length, open_list: openList,
    },
    spend: { repairs: round2(repairs), purchasing: round2(purchasing), total: round2(repairs + unlinked) },
    engine_hours: {
      total: round2(engineTotal), reads: [...reads.values()].reduce((s, r) => s + r.n, 0),
      by_boat: [...hours].map(([id, h]) => ({ boat_id: id, name: nameOf(id), hours: round2(h), per_day: nD ? Math.round((h / nD) * 10) / 10 : 0 })).sort((a, b) => b.hours - a.hours),
    },
    projects: { active: projects.filter((p) => p.status !== 'completed').length, completed: projects.filter((p) => p.status === 'completed').length, late: projects.filter((p) => p.late_days > 0).length, list: projects },
    memos: {
      count: memos.length, amount: round2(purchasing), pending: pend.length, pending_amount: round2(pend.reduce((s, m) => s + amt(m), 0)),
      by_supplier: sumBy(memos, (m) => m.supplier || '—', amt).map((g) => ({ supplier: g.key, amount: g.amount, memos: g.n })),
      by_type: sumBy(memos, (m) => m.memo_type || '—', amt).map((g) => ({ memo_type: g.key, amount: g.amount, memos: g.n })),
    },
  };
}

/** `GET /v1/fleet/reports/fleet?from=&to=`: the range, the same length before it, the stock now, and the data gaps. */
export function fleetReport(input: FleetReportInput) {
  const prev = previousRange(input.from, input.to);
  const current = gather(input, input.from, input.to);
  const items = input.stock.filter((i) => !i.deleted_at && !i.merged_into);
  const withMin = items.filter((i) => i.min_qty > 0);
  const mins = new Set(withMin.map((i) => i.min_qty));
  const zero = items.filter((i) => i.total_qty <= 0);
  const stock = {
    items: items.length, at_zero: zero.length, in_stock: items.length - zero.length, with_min: withMin.length, below_min: withMin.filter((i) => i.total_qty < i.min_qty).length,
    value: round2(items.reduce((s, i) => s + i.total_qty * i.cost, 0)), uniform_min: mins.size === 1 ? [...mins][0] : null,
    out: zero.map((i) => ({ item_id: i.id, name: i.name, part_no: i.part_no, category: i.category, warehouse: i.primary_warehouse, cost: i.cost }))
      .sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name)),
  };
  const gaps: { code: string; level: 'bad' | 'warn' | 'note'; [k: string]: unknown }[] = [];
  if (current.jobs.closed > 0 && current.jobs.with_cost < current.jobs.closed) gaps.push({ code: 'jobs_without_cost', level: 'warn', with_cost: current.jobs.with_cost, closed: current.jobs.closed });
  if (input.projects.length && !input.projects.some((p) => p.planned_budget > 0)) gaps.push({ code: 'no_project_budget', level: 'warn', projects: input.projects.length });
  const pm = input.safety.filter((s) => s.next_pm === DEFAULT_PM).length;
  if (pm > 0) gaps.push({ code: 'safety_default_pm', level: 'warn', items: pm, total: input.safety.length, date: DEFAULT_PM });
  if (input.consumables < 10) gaps.push({ code: 'few_consumables', level: 'bad', consumables: input.consumables });
  if (current.availability.idle_boats.length) gaps.push({ code: 'idle_boats', level: 'bad', idle: current.availability.idle_boats.length, registered: current.availability.boats_registered, boats: current.availability.idle_boats });
  if (stock.uniform_min !== null) gaps.push({ code: 'uniform_min', level: 'note', min_qty: stock.uniform_min });
  return { from: input.from, to: input.to, days: current.days, current, previous: gather(input, prev.from, prev.to), stock, data_gaps: gaps };
}
