import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { InjectOptions } from 'fastify';
import type { Incident, Job, JobPart } from '../src/domain/fleet-jobs.js';
import type { Memo } from '../src/domain/fleet-memos.js';
import type { Project } from '../src/domain/fleet-projects.js';
import type { StockView } from '../src/domain/fleet-stock.js';

// Fleet Insights and the Fleet Report (todo/fleet-maintenance-model.md, "Design — insights"), and the
// existing fleet reports brought onto the same definitions: a job's cost dated by its close date, and
// service due as hours since the last service against the engine's own interval. The figures are
// checked on small fixtures through the pure functions (the totals read every row, so a shared
// database would blur them), then through the API on whichever store DATABASE_URL selects.
process.env.AUTH_JWT_SECRET = 'fleet-insights-test-secret';
const { buildApp } = await import('../src/app.js');
const { seedUser, testStore, tokenFor } = await import('./users-helper.js');
const { todayInThailand } = await import('../src/domain/calendar.js');
const { addDays } = await import('../src/domain/fleet-common.js');
const { linkedMemos } = await import('../src/domain/fleet-seams.js');
const { fleetReport, insights, periodStart, previousRange, supplierOf } = await import('../src/domain/fleet-insights.js');
const { costReport, dashboard, upkeepReport } = await import('../src/domain/fleet-reports.js');
const store = testStore();
const app = buildApp({ store });
after(async () => app.close());

// ── Fixtures ──

const parts = (qty: number, cost: number): JobPart[] => [{ id: 'p', inv_id: null, name: 'Bolt', qty, unit: 'pc', cost, location: null, date: null, late: false, late_by: null }];
const job = (id: string, boat: string, f: Partial<Job>): Job => ({
  id, no: id.toUpperCase(), boat_id: boat, type: 'corrective', title: `Job ${id}`, detail: null, location: null, status: 'done', start_date: null, end_date: null,
  incident_id: null, boat_status: null, boat_status_reason: null, set_fixing: true, outcome: null, close_note: null, awaiting_invoice: false, parent_project_id: null,
  legacy_cost: null, board_lane: null, owner: null, due_date: null, parked_on: null, pinned: false, pinned_on: null, assets: [], parts: [], progress_log: [], steps: [], ...f,
});
const memo = (id: string, f: Partial<Memo>): Memo => ({
  id, no: id.toUpperCase(), title: id, boat_id: null, memo_type: 'parts', scope: null, ref_note: null, supplier: null, memo_date: '2030-01-01', job_id: null, project_id: null,
  status: 'paid', amount: 0, after_discount: 0, lines: [], ...f,
}) as unknown as Memo;
const incident = (id: string, boat: string, date: string, f: Partial<Incident> = {}): Incident => ({
  id, no: id.toUpperCase(), boat_id: boat, date, title: `Incident ${id}`, priority: null, severity: null, status: 'open', job_id: null, related_job_ids: [], ...f,
}) as unknown as Incident;
const company = { ownership: 'company', retired: false, documents: [] };

// ── The pure figures ──

test('insights: the period, spend by close date, boat health, trend, suppliers, alerts and service due', () => {
  const today = '2030-05-20';
  assert.deepEqual([periodStart('month', today), periodStart('quarter', today), periodStart('ytd', today), periodStart('all', today), periodStart('quarter', '2030-12-31')],
    ['2030-05-01', '2030-04-01', '2030-01-01', null, '2030-10-01'], 'legacy started the month a day early east of UTC');
  const boats = [
    { id: 'b1', name: 'Alpha', pier: 'panwa', status: 'available', pier_today: 'panwa', ...company,
      documents: [{ name: 'ใบอนุญาตใช้เรือ', expires_on: '2030-05-30', renew_status: null }, { name: 'ใบอนุญาตใช้เรือ', expires_on: '2029-05-30', renew_status: 'done' as const }] },
    { id: 'b2', name: 'Bravo', pier: 'tublamu', status: 'fixing', pier_today: 'tublamu', ...company, documents: [{ name: 'ใบอนุญาต สิมิลัน', expires_on: '2030-06-30', renew_status: null }] },
    { id: 'b3', name: 'Charter', pier: 'panwa', status: 'available', pier_today: 'panwa', ...company, ownership: 'charter', documents: [{ name: 'ใบอนุญาตใช้เรือ', expires_on: '2030-01-01', renew_status: null }] },
    { id: 'b4', name: 'Retired', pier: 'panwa', status: 'available', pier_today: 'panwa', ...company, retired: true },
    { id: 'b5', name: 'Echo', pier: 'ranong', status: 'available', pier_today: 'shop', ...company },
  ];
  const jobs = [
    job('j1', 'b1', { start_date: '2030-04-25', end_date: '2030-05-03', parts: parts(2, 100) }),
    job('j2', 'b1', { type: 'preventive', start_date: '2030-05-02', end_date: '2030-05-10' }),
    job('j3', 'b2', { status: 'inprogress', start_date: '2030-04-01', parts: parts(1, 500) }),
    job('j4', 'b2', { status: 'pending', start_date: '2030-05-18' }),
    job('j5', 'b1', { start_date: '2030-03-01', end_date: '2030-04-15', parts: parts(3, 100) }),
    job('j6', 'b2', { start_date: '2030-05-01', end_date: '2030-05-05', awaiting_invoice: true }),
  ];
  const memos = [
    memo('m1', { job_id: 'j2', status: 'approved', amount: 1000, memo_type: 'labor', supplier: 'Honda Phuket', memo_date: '2030-05-02' }),
    memo('m2', { status: 'received', amount: 400, memo_date: '2030-05-05', lines: [{ item_id: 'i1' }, { item_id: 'i2' }, { item_id: null }] as never }),
    memo('m3', { status: 'paid', amount: 600, memo_date: '2030-05-06', ref_note: 'อ้างอิง IV123 · Andaman Marine Co.,Ltd IV998' }),
    memo('m4', { status: 'pending_approval', amount: 250, memo_date: '2030-05-07' }),
    memo('m5', { status: 'cancelled', amount: 99, memo_date: '2030-05-08' }),
    memo('m6', { status: 'paid', amount: 50, memo_date: '2030-03-01', supplier: 'Old' }),
  ];
  const incidents = [incident('i1', 'b2', '2030-05-03', { priority: 4 }), incident('i2', 'b2', '2030-05-04', { priority: 2 }), incident('i3', 'b1', '2030-04-10')];
  const engine = (id: string, boat: string | null, f: object) => ({ id, boat_id: boat, serial: `S-${id}`, model: 'BF250', brand: 'Honda', hours: 0, service_interval: 100, last_service_hours: null, base_hours: 0, ...f });
  const engines = [
    engine('e1', 'b1', { hours: 85 }), engine('e2', 'b2', { hours: 160, last_service_hours: 50 }), engine('e3', 'b1', { hours: 99, service_interval: null }),
    engine('e4', 'b1', { hours: 100, service_interval: 200 }), engine('e5', null, { hours: 99 }),
  ];
  const items = [{ id: 'i1', supplier: 'Marine Mart' }, { id: 'i2', supplier: 'Marine Mart' }];
  const input = { today, boats, jobs, incidents, memos, memosOf: linkedMemos(memos), items, engines };
  const r = insights({ ...input, period: 'month' });

  assert.deepEqual([r.from, r.to], ['2030-05-01', today]);
  assert.deepEqual(r.fleet, { company_boats: 3, available: 2, fixing: 1, unavailable: 0, piers: { tublamu: 1, panwa: 1, ranong: 0 } }, 'charter and retired left out; a boat at the shop is at no pier');
  assert.deepEqual(r.kpis, { incidents: 2, incidents_critical: 1, jobs_closed: 3, spent: 1200, average_per_job: 400, active_jobs: 2, pending_jobs: 1, open_cost: 500 },
    'j1 started in April but closed in May: May\'s (rule 1); the open job is not spend');
  assert.deepEqual(r.boats.map((b) => [b.boat_id, b.jobs, b.jobs_active, b.cost, b.open_cost, b.incidents, b.health]),
    [['b1', 2, 0, 1200, 0, 0, 'watch'], ['b2', 3, 2, 0, 500, 2, 'critical'], ['b5', 0, 0, 0, 0, 0, 'healthy']], 'jobs = closed in the period + open now (rule 4)');
  assert.deepEqual(r.alert_boat, { boat_id: 'b1', name: 'Alpha', jobs: 2, cost: 1200, incidents: 0 });
  assert.deepEqual(r.trend.months.map((m) => [m.month, m.cost, m.jobs, m.incidents]),
    [['2029-12', 0, 0, 0], ['2030-01', 0, 0, 0], ['2030-02', 0, 0, 0], ['2030-03', 0, 0, 0], ['2030-04', 300, 1, 1], ['2030-05', 1200, 3, 2]], 'by close month');
  assert.deepEqual([r.trend.cost_delta_pct, r.trend.incidents_delta_pct, r.trend.top_boat], [300, 100, { boat_id: 'b1', name: 'Alpha', cost: 1200, pct: 100 }]);
  assert.deepEqual(r.by_supplier, { memos: 3, suppliers: 3, amount: 2000, rows: [
    { supplier: 'Honda Phuket', amount: 1000, memos: 1 }, { supplier: 'Andaman Marine Co.,Ltd', amount: 600, memos: 1 }, { supplier: 'Marine Mart', amount: 400, memos: 1 },
  ] }, 'the memo\'s supplier, else its stock items\', else its reference note');
  assert.deepEqual(r.by_type, [{ type: 'corrective', cost: 200, jobs: 2 }, { type: 'preventive', cost: 1000, jobs: 1 }, { type: 'scheduled', cost: 0, jobs: 0 }]);
  assert.deepEqual(r.healthy, [{ boat_id: 'b5', name: 'Echo' }]);
  assert.deepEqual(r.service_due.map((e) => [e.engine_id, e.since, e.left, e.overdue]), [['e2', 110, -10, true], ['e1', 85, 15, false]],
    'since the last service against its own interval (rule 2): by modulo e2 would read 40 h left');
  assert.deepEqual(r.memos, { pending: 1, pending_amount: 250, pending_nos: ['M4'], received: 1, received_amount: 400, approval_rate: { total: 6, approved: 4, pending: 1, pct: 67 } });
  assert.deepEqual(r.awaiting_invoice, { count: 1, jobs: [{ job_id: 'j6', no: 'J6', boat_id: 'b2', boat_name: 'Bravo', title: 'Job j6', end_date: '2030-05-05', days_since: 15 }] });
  assert.deepEqual([r.documents.count, r.documents.expired, r.documents.critical, r.documents.warning], [2, 0, 1, 1], 'current rows only: the renewed 2029 row is not "expired"');
  assert.deepEqual(r.documents.items.map((d) => [d.boat_id, d.days_left, d.severity]), [['b1', 10, 'critical'], ['b2', 41, 'warning']]);
  assert.deepEqual(r.closing_speed, { jobs: 3, average_days: 8, jobs_before: 1, average_days_before: 46, change_pct: 83, improved: true }, 'start to close, both days counted (rule 3)');
  assert.deepEqual(r.recurring_incidents, [{ boat_id: 'b2', name: 'Bravo', incidents: 2, dates: ['2030-05-03', '2030-05-04'], titles: ['Incident i1', 'Incident i2'] }]);
  assert.deepEqual(r.long_running.map((j) => [j.job_id, j.days]), [['j3', 49]]);
  assert.deepEqual(r.cost_concentration, { boat_id: 'b1', name: 'Alpha', cost: 1200, total: 1200, pct: 100 });

  const all = insights({ ...input, period: 'all' });
  assert.deepEqual([all.from, all.kpis.jobs_closed, all.kpis.spent, all.kpis.incidents, all.boats[0].health], [null, 4, 1500, 3, 'critical']);
  assert.deepEqual(all.closing_speed, { jobs: 4, average_days: 17, jobs_before: 0, average_days_before: null, change_pct: null, improved: false }, 'nothing closed before "all time"');
  assert.deepEqual([insights({ ...input, period: 'quarter' }).kpis.spent, insights({ ...input, period: 'ytd' }).kpis.spent], [1500, 1500]);
  assert.equal(insights({ ...input, period: 'month', memos: memos.slice(0, 2) }).memos.approval_rate, null, 'fewer than 3 memos: no rate');

  assert.equal(supplierOf({ supplier: '  ', lines: [], ref_note: 'อ้างอิง QT-1234 · 12/05/2030 · Patong Hardware Shop' }, () => null), 'Patong Hardware Shop');
  assert.equal(supplierOf({ supplier: null, lines: [], ref_note: 'QT-1234 · ok' }, () => null), 'Other');
});

test('the Fleet Report: availability day by day, incidents, jobs by close date, spend, engine hours, projects, purchasing, stock, gaps', () => {
  assert.deepEqual(previousRange('2030-03-01', '2030-03-10'), { from: '2030-02-19', to: '2030-02-28' });
  assert.deepEqual(previousRange('2032-03-01', '2032-03-31'), { from: '2032-01-30', to: '2032-02-29' });
  const boats = [{ id: 'r1', name: 'Alpha', retired: false }, { id: 'r2', name: 'Bravo', retired: false }, { id: 'r3', name: 'Gone', retired: true }, { id: 'r4', name: 'Delta', retired: false }];
  const statusOn = (id: string, d: string) => (id === 'r2' ? 'unavailable' : id === 'r1' && d >= '2030-03-03' && d <= '2030-03-05' ? 'fixing' : 'available');
  const jobs = [
    job('k1', 'r1', { start_date: '2030-03-02', end_date: '2030-03-04', parts: parts(2, 100) }),
    job('k2', 'r1', { start_date: '2030-02-20', end_date: '2030-03-06' }),
    job('k3', 'r4', { start_date: '2030-03-08', end_date: '2030-03-12' }),
    job('k4', 'r4', { status: 'inprogress', start_date: '2030-03-09' }),
    job('k5', 'r1', { status: 'pending', start_date: '2030-02-01' }),
    job('k6', 'r4', { start_date: '2030-03-05', end_date: '2030-03-05' }),
  ];
  const memos = [
    memo('q1', { job_id: 'k2', status: 'approved', amount: 1000, after_discount: 1000, memo_type: 'labor', supplier: 'Honda', memo_date: '2030-03-03' }),
    memo('q2', { status: 'pending_approval', amount: 535, after_discount: 500, supplier: 'Acme', memo_date: '2030-03-04' }),
    memo('q3', { status: 'cancelled', amount: 99, after_discount: 99, memo_date: '2030-03-05' }),
    memo('q4', { status: 'paid', amount: 300, after_discount: 300, supplier: 'Acme', memo_date: '2030-02-25' }),
  ];
  const incidents = [
    incident('n1', 'r1', '2030-03-02', { severity: 'critical' }), incident('n2', 'r1', '2030-03-05', { severity: 'major', status: 'resolved' }),
    incident('n3', 'r4', '2030-03-09', { severity: 'low', status: 'inprogress' }), incident('n4', 'r4', '2030-02-25', { severity: 'low' }),
  ];
  const meter = (date: string, boat: string, engine: string, reading: number, trip = 'normal') => ({ date, boat_id: boat, trip_type: trip, engine_id: engine, reading });
  const meters = [
    meter('2030-03-01', 'r1', 'e1', 100), meter('2030-03-05', 'r1', 'e1', 130), meter('2030-03-10', 'r1', 'e1', 0), meter('2030-03-02', 'r1', 'e2', 50),
    meter('2030-03-01', 'r4', 'e3', 10, 'fast'), meter('2030-03-09', 'r4', 'e3', 22, 'fast'), meter('2030-02-20', 'r1', 'e1', 90),
  ];
  const project = (id: string, f: Partial<Project>) => ({ id, no: id.toUpperCase(), name: id, boat_id: 'r1', type: 'refit', plan_from: null, plan_to: null, actual_from: null, status: 'planned', planned_budget: 0, ...f }) as Project;
  const projects = [
    project('p1', { status: 'inprogress', actual_from: '2030-03-01', plan_to: '2030-03-05' }), project('p2', { status: 'completed', plan_from: '2030-02-01', plan_to: '2030-02-20' }),
    project('p3', { status: 'completed', actual_from: '2030-03-02', plan_to: '2030-03-08' }), project('p4', { status: 'cancelled', plan_from: '2030-03-01' }),
    project('p5', { plan_from: '2030-03-20', plan_to: '2030-03-30' }),
  ];
  const item = (id: string, total_qty: number, min_qty: number, cost: number, f: object = {}) =>
    ({ id, name: id, part_no: null, category: 'engine', cost, min_qty, total_qty, deleted_at: null, merged_into: null, primary_warehouse: 'panwa', ...f }) as unknown as StockView;
  const stock = [item('s1', 0, 5, 900), item('s2', 10, 5, 10), item('s3', -2, 0, 100), item('s4', 0, 5, 5000, { deleted_at: '2030-01-01T00:00:00Z' })];
  const r = fleetReport({
    from: '2030-03-01', to: '2030-03-10', boats, statusOn, jobs, incidents, memos, memosOf: linkedMemos(memos), projects, meters, stock,
    safety: [{ next_pm: '2026-01-01' }, { next_pm: '2026-01-01' }, { next_pm: '2030-06-01' }], consumables: 3,
  });
  const c = r.current;
  assert.deepEqual([r.days, c.from, r.previous.from, r.previous.to], [10, '2030-03-01', '2030-02-19', '2030-02-28']);
  assert.deepEqual(c.availability, {
    boats_registered: 3, boats_in_service: 2, idle_boats: [{ boat_id: 'r2', name: 'Bravo' }], down_days: 3, availability_pct: 85,
    down_by_boat: [{ boat_id: 'r1', name: 'Alpha', days: 3, available_pct: 70 }],
  }, 'a boat never available is left out of the rate (legacy), the retired one too');
  assert.deepEqual(c.incidents, {
    count: 3, open: 2, serious: 2, by_severity: [{ severity: 'critical', n: 1 }, { severity: 'low', n: 1 }, { severity: 'major', n: 1 }],
    by_boat: [{ boat_id: 'r1', name: 'Alpha', n: 2 }, { boat_id: 'r4', name: 'Delta', n: 1 }],
  });
  assert.deepEqual([c.jobs.closed, c.jobs.opened, c.jobs.average_days, c.jobs.cost, c.jobs.with_cost], [3, 4, 6, 1200, 2],
    'closed = k1, k2, k6 by close date (k2 opened in February); average (3 + 15 + 1) / 3');
  assert.deepEqual(c.jobs.open_list.map((j) => [j.job_id, j.age]), [['k5', 38], ['k4', 2]]);
  assert.deepEqual(c.spend, { repairs: 1200, purchasing: 1500, total: 1700 }, 'the job\'s memo q1 is in repairs once, not again in the total');
  assert.deepEqual(c.engine_hours, { total: 42, reads: 5, by_boat: [{ boat_id: 'r1', name: 'Alpha', hours: 30, per_day: 3 }, { boat_id: 'r4', name: 'Delta', hours: 12, per_day: 1.2 }] },
    'last − first per engine, every trip type; one reading runs nothing');
  assert.deepEqual([c.projects.active, c.projects.completed, c.projects.late, c.projects.list.map((p) => [p.project_id, p.late_days])], [1, 1, 1, [['p1', 5], ['p3', 0]]],
    'p2 ended before the range, p4 is cancelled, p5 starts after it');
  assert.deepEqual(c.memos, {
    count: 2, amount: 1500, pending: 1, pending_amount: 500, by_supplier: [{ supplier: 'Honda', amount: 1000, memos: 1 }, { supplier: 'Acme', amount: 500, memos: 1 }],
    by_type: [{ memo_type: 'labor', amount: 1000, memos: 1 }, { memo_type: 'parts', amount: 500, memos: 1 }],
  }, 'after discount, before VAT (legacy)');
  const p = r.previous;
  assert.deepEqual([p.availability.down_days, p.availability.availability_pct, p.jobs.closed, p.jobs.opened, p.jobs.open_list.map((j) => [j.job_id, j.age]), p.incidents.count, p.spend, p.engine_hours.total],
    [0, 100, 0, 1, [['k5', 28]], 1, { repairs: 0, purchasing: 300, total: 300 }, 0]);
  assert.deepEqual(r.stock, {
    items: 3, at_zero: 2, in_stock: 1, with_min: 2, below_min: 1, value: -100, uniform_min: 5,
    out: [{ item_id: 's1', name: 's1', part_no: null, category: 'engine', warehouse: 'panwa', cost: 900 }, { item_id: 's3', name: 's3', part_no: null, category: 'engine', warehouse: 'panwa', cost: 100 }],
  });
  assert.deepEqual(r.data_gaps.map((g) => g.code), ['jobs_without_cost', 'no_project_budget', 'safety_default_pm', 'few_consumables', 'idle_boats', 'uniform_min']);
  assert.deepEqual(r.data_gaps[0], { code: 'jobs_without_cost', level: 'warn', with_cost: 2, closed: 3 });
  assert.deepEqual(r.data_gaps[2], { code: 'safety_default_pm', level: 'warn', items: 2, total: 3, date: '2026-01-01' });
});

test('cost, upkeep and the dashboard read the same definitions', () => {
  const today = '2030-05-20';
  const jobs = [
    job('a', 'b1', { start_date: '2030-04-25', end_date: '2030-05-03', parts: parts(2, 100), assets: [{ type: 'hull', asset_id: null, label: 'Bow', detail: null, status: null, added_on: null }] }),
    job('b', 'b1', { status: 'inprogress', start_date: '2030-03-01', parts: parts(1, 500) }),
    job('c', 'b1', { start_date: '2030-05-02', end_date: null, parts: parts(1, 50) }),
  ];
  const memosOf = linkedMemos([]);
  const boats = [{ id: 'b1', name: 'Alpha', pier: 'panwa', ownership: 'company', retired: false, capacity: 30 }];
  const month = costReport({ jobs, memos: [], memosOf, boats, today, period: 'month' });
  assert.deepEqual(month.rows.map((r) => [r.id, r.date, r.done, r.cost]), [['b', null, false, 500], ['a', '2030-05-03', true, 200]], 'in progress: no date, every period');
  assert.deepEqual([month.total, month.done, month.proc], [700, 200, 500]);
  assert.deepEqual(month.months.filter((m) => m.done || m.proc), [{ month: '2030-05', done: 200, proc: 0 }], 'a job in progress has no month (was March, its start)');
  assert.deepEqual(costReport({ jobs, memos: [], memosOf, boats, today, period: 'all' }).done, 250, 'a done job with no close date: only in "all"');
  assert.equal(costReport({ jobs, memos: [], memosOf, boats, today, period: 'last30' }).done, 200);

  assert.deepEqual(upkeepReport({ month: '2030-05', consumables: [], jobs, memosOf, boats }).boats, [{ boat_id: 'b1', name: 'Alpha', repairs: 200, consumables: 0, upkeep: 200 }], 'closed in May');
  assert.deepEqual(upkeepReport({ month: '2030-04', consumables: [], jobs, memosOf, boats }).boats, [], 'not April, its start');

  const engine = (id: string, f: object) => ({ id, boat_id: 'b1', model: 'BF250', brand: 'Honda', hours: 0, service_interval: 100, last_service_hours: null, base_hours: 0, ...f });
  const dash = dashboard({
    date: today, today, boats: boats.map((b) => ({ ...b, pier_on_date: 'panwa', blocked: false })), jobs, incidents: [], memos: [], memosOf,
    engines: [engine('e1', { hours: 75 }), engine('e2', { hours: 520, last_service_hours: 480 }), engine('e3', { hours: 160, last_service_hours: 50 }), engine('e4', { hours: 499, service_interval: null })],
    gearboxes: [], propellers: [], stock: [],
  });
  assert.deepEqual(dash.service_due.engines.map((e) => [e.engine_id, e.interval, e.since, e.remaining, e.pct, e.overdue, e.critical]),
    [['e3', 100, 110, -10, 100, true, true], ['e1', 100, 75, 25, 75, false, false]], 'e2 is 40 h past its service (legacy\'s 500 h modulo: 4 % of the way); e4 has no interval');
  assert.equal('interval' in dash.service_due, false);
  assert.deepEqual(dash.cost_trend.months.slice(-2), [{ month: '2030-04', cost: 0, jobs: 0 }, { month: '2030-05', cost: 200, jobs: 1 }], 'jobs closed each month');
});

// ── Through the API ──

type Headers = { authorization: string };
const run = Date.now().toString(36);
/** A year no other test file uses (fleet-extras uses 2200–2899), so the report's ranges hold only this file's rows. */
const Y = 3000 + Math.floor(Math.random() * 900);
const today = todayInThailand();
const call = (headers: Headers, method: InjectOptions['method'], url: string, payload?: object) => app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
const ok = (res: { statusCode: number; body: string }, status = 200) => { assert.equal(res.statusCode, status, res.body); return JSON.parse(res.body || 'null'); };
const refused = (res: { statusCode: number; body: string }, status: number) => { assert.equal(res.statusCode, status, res.body); return JSON.parse(res.body); };
const as = async (username: string, fields: object = {}): Promise<Headers> => { await seedUser(store, { username, ...fields }); return tokenFor(app, username); };
let seq = 0;
const no = (p: string) => `${p}-I${run}-${seq++}`;
let fleet: Headers; let sales: Headers; let agent: Headers; let admin: Headers;
before(async () => {
  admin = await as(`fi.admin.${run}`, { role: 'admin' });
  fleet = await as(`fi.fleet.${run}`, { edit_areas: ['fleet'] });
  sales = await as(`fi.sales.${run}`, { edit_areas: ['sales'] });
  agent = await as(`fi.agent.${run}`, { agent_id: 'a_b2c' });
});
const newBoat = async (pier = 'panwa', extra: object = {}) => ok(await call(admin, 'POST', '/v1/boats', { name: `Insight ${run} ${seq++}`, pier, capacity: 30, license_pax: 32, ...extra }), 201);
/** A job made through the API, then given its dates and status in the store (closing stamps today). */
const storedJob = async (boatId: string, f: Partial<Job> & { start_date: string }) => {
  const [made] = ok(await call(fleet, 'POST', '/v1/fleet/jobs', { no: no('MJ'), boat_id: boatId, title: 'Work', type: f.type ?? 'corrective', start_date: f.start_date, create_anyway: true }), 201).jobs;
  const stored = (await store.fleetJob(made.id))!;
  await store.putFleetJob({ ...stored, ...f });
  return { ...stored, ...f };
};

test('the Fleet Report through the API: dated by close, availability from the status log and open work, validated range', async () => {
  const boat = await newBoat();
  const range = `from=${Y}-03-01&to=${Y}-03-31`;
  ok(await call(admin, 'POST', `/v1/boats/${boat.id}/status-log`, { status: 'fixing', from_date: `${Y}-03-10`, to_date: `${Y}-03-14`, province: 'Phuket', loc_type: 'pier', reason: 'engine_repair' }), 201);
  const j1 = await storedJob(boat.id, { start_date: `${Y}-03-02`, status: 'done', end_date: `${Y}-03-05`, parts: parts(2, 100) });
  const j2 = await storedJob(boat.id, { start_date: `${Y}-02-20`, status: 'done', end_date: `${Y}-03-20` });
  await storedJob(boat.id, { start_date: `${Y}-03-25`, status: 'done', end_date: `${Y}-04-02` });
  const j4 = await storedJob(boat.id, { start_date: `${Y}-03-28`, status: 'inprogress' });
  await storedJob(boat.id, { start_date: `${Y}-02-01`, status: 'done', end_date: `${Y}-02-10` });
  const m1 = ok(await call(fleet, 'POST', '/v1/fleet/memos', { no: no('MO'), title: 'Labour', memo_type: 'labor', vat_enabled: false, job_id: j2.id, supplier: `Honda ${run}`, memo_date: `${Y}-03-15`, lines: [{ name: 'ช่าง', qty: 1, price: 1000 }] }), 201);
  ok(await call(fleet, 'POST', `/v1/fleet/memos/${m1.id}/approve`, { approved_by: 'ANON' }));
  ok(await call(fleet, 'POST', '/v1/fleet/memos', { no: no('MO'), title: 'Rope', memo_type: 'parts', vat_enabled: false, boat_id: boat.id, supplier: `Acme ${run}`, memo_date: `${Y}-03-16`, lines: [{ name: 'Rope', qty: 1, price: 500, auto_register: false }] }), 201);
  ok(await call(fleet, 'POST', '/v1/fleet/incidents', { no: no('INC'), boat_id: boat.id, date: `${Y}-03-03`, title: 'Fire', priority: 5 }), 201);
  ok(await call(fleet, 'POST', '/v1/fleet/incidents', { no: no('INC'), boat_id: boat.id, date: `${Y}-03-04`, title: 'Scratch', priority: 1 }), 201);
  const eng = `eng-fi-${run}`;
  for (const [d, reading] of [['03-02', 100], ['03-20', 130]] as const) ok(await call(fleet, 'PATCH', `/v1/fleet/daily-log/${Y}-${d}/boats/${boat.id}`, { meters: { normal: { [eng]: reading } } }));
  ok(await call(fleet, 'PATCH', `/v1/fleet/daily-log/${Y}-03-21/boats/${boat.id}`, { meters: { normal: { [`${eng}-2`]: 50 } } }));
  const project = ok(await call(fleet, 'POST', '/v1/fleet/projects', { no: no('PRJ'), name: 'Refit', boat_id: boat.id, type: 'refit', plan_from: `${Y}-03-01`, plan_to: `${Y}-03-10` }), 201);

  refused(await call(sales, 'GET', '/v1/fleet/reports/fleet'), 400);
  refused(await call(sales, 'GET', `/v1/fleet/reports/fleet?from=${Y}-03-01`), 400);
  refused(await call(sales, 'GET', `/v1/fleet/reports/fleet?from=${Y}-02-30&to=${Y}-03-31`), 400);
  refused(await call(sales, 'GET', `/v1/fleet/reports/fleet?from=${Y}-03-31&to=${Y}-03-01`), 400);
  refused(await call(sales, 'GET', `/v1/fleet/reports/fleet?from=${Y}-01-01&to=${Y + 1}-01-02`), 400);
  refused(await call(agent, 'GET', `/v1/fleet/reports/fleet?${range}`), 403);

  const r = ok(await call(sales, 'GET', `/v1/fleet/reports/fleet?${range}`));
  const c = r.current;
  assert.deepEqual([r.days, r.previous.from, r.previous.to], [31, `${Y}-01-29`, `${Y}-02-28`]);
  assert.deepEqual(c.availability.down_by_boat.find((b: { boat_id: string }) => b.boat_id === boat.id), { boat_id: boat.id, name: boat.name, days: 9, available_pct: 71 },
    '5 days fixing by the log, and 4 held by the job in progress from the 28th');
  assert.deepEqual([c.incidents.count, c.incidents.open, c.incidents.serious, c.incidents.by_severity], [2, 2, 1, [{ severity: 'critical', n: 1 }, { severity: 'minor', n: 1 }]]);
  assert.deepEqual([c.jobs.closed, c.jobs.opened, c.jobs.average_days, c.jobs.cost, c.jobs.with_cost], [2, 3, 17, 1200, 2], 'j1 and j2 closed in March; j2 opened in February');
  assert.deepEqual(c.jobs.open_list.find((j: { job_id: string }) => j.job_id === j4.id).age, 4);
  assert.deepEqual(c.spend, { repairs: 1200, purchasing: 1500, total: 1700 });
  assert.deepEqual([c.memos.count, c.memos.pending_amount, c.memos.by_type], [2, 500, [{ memo_type: 'labor', amount: 1000, memos: 1 }, { memo_type: 'parts', amount: 500, memos: 1 }]]);
  assert.deepEqual(c.engine_hours, { total: 30, reads: 3, by_boat: [{ boat_id: boat.id, name: boat.name, hours: 30, per_day: 1 }] });
  assert.equal(c.projects.list.find((p: { project_id: string }) => p.project_id === project.id).late_days, 21);
  assert.deepEqual([r.previous.jobs.closed, r.previous.jobs.opened, r.previous.spend.repairs], [1, 2, 0], 'February: one closed (no cost), j2 and the February job opened');
  assert.equal(j1.parts[0].cost, 100);
  assert.ok(Array.isArray(r.data_gaps) && typeof r.stock.items === 'number');
});

test('Fleet Insights through the API: a boat\'s jobs, cost, alerts, service due and certificates; period validated', async () => {
  const boat = await newBoat('panwa', { documents: [{ name: 'ใบอนุญาตใช้เรือ', expires_on: addDays(today, 10) }] });
  const item = ok(await call(fleet, 'POST', '/v1/fleet/stock-items', { name: `Seal ${run}`, part_no: `FI-${run}`, qty: 10, warehouse: 'panwa', cost: 100 }), 201);
  const [closed] = ok(await call(fleet, 'POST', '/v1/fleet/jobs', { no: no('MJ'), boat_id: boat.id, title: 'Seal', type: 'preventive', create_anyway: true }), 201).jobs;
  ok(await call(fleet, 'POST', `/v1/fleet/jobs/${closed.id}/parts`, { item_id: item.id, warehouse: 'panwa', qty: 3 }), 201);
  ok(await call(fleet, 'POST', `/v1/fleet/jobs/${closed.id}/start`, {}));
  ok(await call(fleet, 'POST', `/v1/fleet/jobs/${closed.id}/close`, { outcome: 'success', awaiting_invoice: true }));
  const [pending] = ok(await call(fleet, 'POST', '/v1/fleet/jobs', { no: no('MJ'), boat_id: boat.id, title: 'Paint', create_anyway: true }), 201).jobs;
  const long = await storedJob(boat.id, { start_date: addDays(today, -20), status: 'inprogress', set_fixing: false });
  for (const t of ['Bump', 'Leak']) ok(await call(fleet, 'POST', '/v1/fleet/incidents', { no: no('INC'), boat_id: boat.id, date: today, title: t, priority: 4 }), 201);
  const engine = ok(await call(fleet, 'POST', '/v1/fleet/engines', { brand: 'Honda', model: 'BF250D', serial: `FI-${run}`, boat_id: boat.id, pos: 'port', service_interval: 100 }), 201);
  for (const [d, reading] of [[-2, 10], [-1, 95]] as const) ok(await call(fleet, 'PATCH', `/v1/fleet/daily-log/${addDays(today, d)}/boats/${boat.id}`, { meters: { normal: { [engine.id]: reading } } }));

  refused(await call(sales, 'GET', '/v1/fleet/insights?period=week'), 400);
  refused(await call(agent, 'GET', '/v1/fleet/insights'), 403);
  const r = ok(await call(sales, 'GET', '/v1/fleet/insights'));
  assert.deepEqual([r.period, r.from, r.to], ['month', `${today.slice(0, 7)}-01`, today]);
  const mine = r.boats.find((b: { boat_id: string }) => b.boat_id === boat.id);
  assert.deepEqual([mine.jobs, mine.jobs_closed, mine.jobs_active, mine.cost, mine.incidents, mine.health], [3, 1, 2, 300, 2, 'critical'], 'closed this month + open now');
  assert.ok(!r.healthy.some((b: { boat_id: string }) => b.boat_id === boat.id));
  assert.deepEqual(r.awaiting_invoice.jobs.find((j: { job_id: string }) => j.job_id === closed.id)?.days_since, 0);
  assert.equal(r.long_running.find((j: { job_id: string }) => j.job_id === long.id)?.days, 20);
  assert.ok(!r.long_running.some((j: { job_id: string }) => j.job_id === pending.id), 'pending is not running');
  assert.deepEqual(r.recurring_incidents.find((x: { boat_id: string }) => x.boat_id === boat.id)?.incidents, 2);
  const due = r.service_due.find((e: { engine_id: string }) => e.engine_id === engine.id);
  assert.deepEqual([due?.since, due?.left, due?.interval, due?.overdue], [85, 15, 100, false], 'meter 10 → 95 since it came with 0 hours; due within 20 % of its 100 h');
  assert.deepEqual(r.documents.items.filter((d: { boat_id: string }) => d.boat_id === boat.id).map((d: { days_left: number; severity: string }) => [d.days_left, d.severity]), [[10, 'critical']]);
  assert.ok(r.kpis.jobs_closed >= 1 && r.kpis.spent >= 300 && r.kpis.active_jobs >= 2);
  for (const p of ['quarter', 'ytd', 'all']) assert.equal(ok(await call(sales, 'GET', `/v1/fleet/insights?period=${p}`)).period, p);
});
