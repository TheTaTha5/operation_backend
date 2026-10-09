import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapLegacyFleet, type FleetSource } from '../src/tools/legacy-fleet.js';
import { plannedOverFromNote } from '../src/domain/fleet-availability.js';

// How legacy's fleet tables become records (src/tools/legacy-fleet.ts), on rows shaped as the legacy
// tables hold them (text everywhere, '' for blank).
const report = () => {
  const skipped: string[] = [], notes: string[] = [];
  return { skipped, notes, skip: (kind: string, id: string, reason: string) => skipped.push(`${kind} ${id}: ${reason}`), note: (what: string) => notes.push(what) };
};
const empty: FleetSource = {
  engines: [], engineLog: [], gearboxes: [], gearboxLog: [], propellers: [], propellerLog: [],
  incidents: [], incidentAssets: [], incidentLog: [], incidentJobs: [], jobs: [], jobAssets: [], jobParts: [], jobLog: [],
};
const boats = new Set(['b1', 'b2']);

test('assets: blanks are null, numbers read from text, links to what was not imported let go, histories in order', () => {
  const r = report();
  const out = mapLegacyFleet({
    ...empty,
    engines: [
      { id: 'e1', brand: 'Honda', model: 'BF250D', serial: 'BBNJ-1', hp: '250', boatid: 'b1', pos: 'Port', status: 'fixing', basehours: 0, serviceinterval: '100', buydate: '', note: '', sparelocation: null, price: null, lastservicehours: null, lastservicedate: null },
      { id: 'e2', brand: 'Honda', model: 'BF250D', serial: 'BBNJ-1', hp: null, boatid: 'b9', pos: '', status: 'ready', basehours: -3, serviceinterval: null, buydate: '2026-02-30', note: null, sparelocation: 'SAK Marine', price: null, lastservicehours: null, lastservicedate: null },
      { id: 'e3', status: 'sold' },
    ],
    engineLog: [
      { fleet_engines_id: 'e1', idx: 1, date: '2026-05-02', type: 'repair', desc: 'second', hours: 12.5, cost: 1500 },
      { fleet_engines_id: 'e1', idx: 0, date: '2026-05-01', type: 'install', desc: 'first', enginehours: 10 },
    ],
    gearboxes: [{ id: 'g1', engineid: 'e3', boatid: 'b1', status: 'spare', basehours: '0', installhours: 5433.4, sparelocation: 'shop:honda-phuket', lastservicedate: '2026-09-04', serviceinterval: null }],
    propellers: [
      { id: 'p1', gearboxid: 'g1', boatid: 'b1', diameter: 15.5, pitch: 17, size: '15.5×17', cost: '8500', status: 'active', engineid: null },
      { id: 'p2', gearboxid: 'g1', boatid: 'b1', status: 'damaged' },
    ],
  }, { boats }, r);
  const [e1, e2] = out.engines;
  assert.deepEqual([e1.hp, e1.service_interval, e1.buy_date, e1.note, e1.boat_id], [250, 100, null, null, 'b1']);
  assert.deepEqual(e1.log.map((l) => [l.date, l.description, l.hours, l.engine_hours, l.cost]), [['2026-05-01', 'first', null, 10, null], ['2026-05-02', 'second', 12.5, null, 1500]]);
  assert.deepEqual([e2.boat_id, e2.base_hours, e2.buy_date, e2.spare_location], [null, 0, null, 'SAK Marine']);
  assert.deepEqual(r.skipped, ['engine e3: status sold']);
  assert.equal(out.gearboxes[0].engine_id, null, 'its engine was skipped');
  assert.deepEqual([out.gearboxes[0].install_hours, out.gearboxes[0].last_service_date, out.gearboxes[0].service_interval], [5433.4, '2026-09-04', null]);
  assert.deepEqual(out.propellers.map((p) => [p.gearbox_id, p.status, p.cost]), [['g1', 'active', 8500], ['g1', 'damaged', null]]);
  for (const n of ['engine serial BBNJ-1 used 2 times (imported as is)', 'engines: boat b9 not in the catalogue, left off its boat', 'engines with negative base hours (imported as 0)',
    'engine buy dates: not a date, dropped', 'gearboxes on an engine not imported (left loose)', 'gearboxes carrying two propellers (twin props, imported as is)']) {
    assert.ok(r.notes.includes(n), `${n}\n${r.notes.join('\n')}`);
  }
});

test('incidents and jobs: as legacy has them, oddities listed; what cannot be stored is skipped', () => {
  const r = report();
  const inc = (id: string, no: string, extra: Record<string, unknown> = {}) => ({ id, no, boatid: 'b1', date: '2026-05-09', time: '', title: 'Seat broken', detail: '', remark: '', priority: '5', severity: 'critical', type: 'incident', status: 'closed', maintid: 'mj1', closeddate: '2026-06-22', quickfix: null, resolveddate: null, ...extra });
  const job = (id: string, no: string, extra: Record<string, unknown> = {}) => ({ id, no, boatid: 'b1', type: 'corrective', title: 'Replace seats', detail: '', location: '', status: 'done', startdate: '2026-05-09', enddate: '2026-06-22', cost: 16558.5, incidentid: 'i1', boatstatus: null, boatstatusreason: null, setfixing: false, outcome: 'success', parentprojectid: null, awaitinginvoice: null, closenote: null, ...extra });
  const out = mapLegacyFleet({
    ...empty,
    incidents: [
      inc('i1', 'INC-001'), inc('i2', 'INC-012', { status: 'inprogress', severity: 'high', priority: '4', maintid: 'mjgone' }), inc('i3', 'INC-012', { status: 'open', maintid: '' }),
      inc('i4', 'INC-004', { boatid: 'b7' }), inc('i5', 'INC-005', { status: 'lost' }),
    ],
    incidentAssets: [
      { fleet_incidents_id: 'i1', idx: 0, type: 'engine', id: 'e1', label: 'BBNJ-1 · Port', swapped: null },
      { fleet_incidents_id: 'i1', idx: 1, type: 'gearbox', id: null, gbid: 'g1', label: 'G1', swapped: true, swappedto: 'G9', swappeddate: '2026-05-10' },
      { fleet_incidents_id: 'i1', idx: 2, type: 'fender', label: 'x' },
    ],
    incidentLog: [{ fleet_incidents_id: 'i1', idx: 0, date: '2026-05-09', text: 'opened', by: 'ระบบ', createdat: null }],
    incidentJobs: [{ fleet_incidents_id: 'i1', idx: 0, value: 'mj1' }],
    jobs: [
      job('mj1', 'MJ-001'), job('mj2', 'MJ-002', { status: 'inprogress', enddate: '2026-07-01', setfixing: null, boatstatus: 'unavailable', boatstatusreason: 'dry_dock', outcome: null, cost: null }),
      job('mj3', 'MJ-003', { type: 'emergency' }),
    ],
    jobAssets: [{ fleet_maintenance_id: 'mj2', idx: 0, type: 'engine', engid: 'e1', label: 'BBNJ-1 · Port', detail: '', status: 'fixing', gbid: null, propid: null, id: null }],
    jobParts: [{ fleet_maintenance_id: 'mj1', idx: 0, invid: 'inv1', name: 'Seat', qty: '7', unit: 'ชุด', cost: 2365.5, location: 'คลัง Tub Lamu', date: '2026-06-01' }],
    jobLog: [{ fleet_maintenance_id: 'mj2', idx: 0, date: '2026-07-01', text: 'started', by: 'ระบบ', createdat: '2026-07-02' }],
  }, { boats }, r);
  assert.deepEqual(out.incidents.map((i) => [i.id, i.no, i.status, i.severity, i.job_id]), [
    ['i1', 'INC-001', 'closed', 'critical', 'mj1'], ['i2', 'INC-012', 'inprogress', 'high', 'mjgone'], ['i3', 'INC-012', 'open', 'critical', null],
  ]);
  const i1 = out.incidents[0];
  assert.deepEqual(i1.damaged_assets.map((a) => [a.type, a.asset_id, a.swapped, a.swapped_to, a.swapped_on]), [['engine', 'e1', false, null, null], ['gearbox', 'g1', true, 'G9', '2026-05-10']]);
  assert.deepEqual([i1.related_job_ids, i1.closed_on, i1.progress_log[0].text], [['mj1'], '2026-06-22', 'opened']);
  assert.deepEqual(r.skipped, ['incident i4: boat b7 not in the catalogue', 'incident i5: status lost', 'job mj3: type emergency']);
  for (const n of ['incident INC-012: status inprogress (not a value legacy writes; imported as is)', 'incident INC-012: severity high (imported as is until edited)',
    'incident INC-012: linked to job mjgone, which legacy no longer has (kept)', 'incident number INC-012 used 2 times (imported as is)',
    'incident damaged assets of type fender dropped', 'job end dates on a job not done, dropped']) {
    assert.ok(r.notes.includes(n), `${n}\n${r.notes.join('\n')}`);
  }
  const [mj1, mj2] = out.jobs;
  assert.deepEqual([mj1.legacy_cost, mj1.set_fixing, mj1.outcome, mj1.parts[0].qty, mj1.parts[0].cost], [16558.5, false, 'success', 7, 2365.5]);
  assert.deepEqual([mj2.end_date, mj2.set_fixing, mj2.boat_status, mj2.boat_status_reason, mj2.legacy_cost], [null, true, 'unavailable', 'dry_dock', null]);
  assert.deepEqual([mj2.assets[0].asset_id, mj2.progress_log[0].created_on], ['e1', '2026-07-02']);
});

test('a planned-ahead note gives its numbers, up to other text', () => {
  assert.deepEqual(plannedOverFromNote('วางล่วงหน้าทั้งที่ยังมีงานค้าง · MJ-008 · MJ-026 · PRJ-008'), ['MJ-008', 'MJ-026', 'PRJ-008']);
  assert.deepEqual(plannedOverFromNote('season · วางล่วงหน้าทั้งที่ยังมีงานค้าง · MJ-117 · back on the 3rd'), ['MJ-117']);
  assert.equal(plannedOverFromNote('Maintenance Job MJ-008'), null);
  assert.equal(plannedOverFromNote(null), null);
});
