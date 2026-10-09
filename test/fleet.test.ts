import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';

process.env.AUTH_JWT_SECRET = 'fleet-test-secret';
const { buildApp } = await import('../src/app.js');
const { createStore } = await import('../src/routes/operations.js');
const { todayInThailand } = await import('../src/domain/calendar.js');
const { seedUser, tokenFor } = await import('./users-helper.js');

// Fleet maintenance, part A (todo/fleet-maintenance-model.md, decided 2026-10-09), through the API on
// whichever store DATABASE_URL selects: boat availability and the deployment guard, plan ahead,
// engines/gearboxes/propellers, incidents and maintenance jobs. Numbers are this file's own (9xxx).
const store = createStore();
const app = buildApp({ store });
after(async () => app.close());
await seedUser(store, { username: 'fleet-admin', role: 'admin' });
await seedUser(store, { username: 'fleet-ops', role: 'staff', edit_areas: ['operations'] });
await seedUser(store, { username: 'fleet-mech', role: 'staff', edit_areas: ['fleet'] });
const admin = await tokenFor(app, 'fleet-admin');
const ops = await tokenFor(app, 'fleet-ops');
const mech = await tokenFor(app, 'fleet-mech');
const send = (method: InjectOptions['method'], url: string, payload?: object, headers: Record<string, string> = admin) =>
  app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
const today = todayInThailand();
const addDays = (date: string, n: number) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const ok = async (method: InjectOptions['method'], url: string, payload?: object, headers?: Record<string, string>) => {
  const res = await send(method, url, payload, headers);
  assert.ok(res.statusCode < 300, `${method} ${url}: ${res.statusCode} ${res.body}`);
  return res.statusCode === 204 ? undefined : res.json();
};
const refused = async (method: InjectOptions['method'], url: string, payload: object | undefined, status: number, code?: string) => {
  const res = await send(method, url, payload);
  assert.equal(res.statusCode, status, `${method} ${url}: ${res.body}`);
  if (code) assert.equal(res.json().code, code, res.body);
  return res.json();
};
let boatSeq = 0;
const newBoat = async (extra: object = {}) => ok('POST', '/v1/boats', { name: `Fleet Test ${Date.now()}-${boatSeq++}`, pier: 'tublamu', capacity: 30, license_pax: 32, ...extra });
const newEngine = async (boatId: string | null, pos = 'Port', extra: object = {}) =>
  ok('POST', '/v1/fleet/engines', { brand: 'Honda', model: 'BF250D', serial: `SER-${Date.now()}-${boatSeq++}`, ...(boatId ? { boat_id: boatId, pos } : {}), ...extra });
let noSeq = 9000;
const mj = () => `MJ-${noSeq++}`;
const inc = () => `INC-${noSeq++}`;

test('a boat held by a started job is not ready: deploying it needs deploy_anyway, and closing the job frees it', async () => {
  const boat = await newBoat();
  const engine = await newEngine(boat.id);
  const day = addDays(today, 30);
  const [job] = (await ok('POST', '/v1/fleet/jobs', { no: mj(), boat_id: boat.id, title: 'Water pump', type: 'corrective', assets: [{ type: 'engine', asset_id: engine.id }] })).jobs;
  assert.deepEqual([job.status, job.boat_status, job.set_fixing], ['pending', 'fixing', true], 'corrective holds the boat as fixing');
  // Pending work holds nothing yet.
  assert.equal((await ok('GET', `/v1/fleet/availability?boat_id=${boat.id}&from=${day}`)).days[0].status, 'available');

  const started = await ok('POST', `/v1/fleet/jobs/${job.id}/start`, {});
  assert.equal(started.status, 'inprogress');
  const a = (await ok('GET', `/v1/fleet/availability?boat_id=${boat.id}&from=${day}`)).days[0];
  assert.deepEqual([a.status, a.stored_status, a.blocked_by.map((b: { no: string }) => b.no)], ['fixing', 'fixing', [job.no]], 'the start wrote the log too');
  assert.equal((await ok('GET', `/v1/fleet/engines/${engine.id}`)).status, 'fixing');
  const view = await ok('GET', `/v1/boats/${boat.id}`);
  assert.deepEqual([view.status_effective, view.blocked_by[0].no], ['fixing', job.no]);

  const refusedDeploy = await refused('POST', '/operations/deployments', { boat_id: boat.id, route_id: 'r1', service_date: day, capacity: 20 }, 409, 'boat_not_ready');
  assert.match(refusedDeploy.message, /not ready on .*fixing.*deploy_anyway/);
  await refused('POST', '/operations/deployments', { boat_id: boat.id, route_id: 'r1', service_date: day, capacity: 20, deploy_anyway: 'maybe' }, 400);
  const forced = await ok('POST', '/operations/deployments', { boat_id: boat.id, route_id: 'r1', service_date: day, capacity: 20, deploy_anyway: true });
  assert.deepEqual([forced.warnings[0].code, forced.warnings[0].blocked_by[0].no], ['boat_not_ready', job.no]);
  // Same route again (a capacity change): not a new deployment, not asked.
  assert.equal((await send('POST', '/operations/deployments', { boat_id: boat.id, route_id: 'r1', service_date: day, capacity: 22 })).statusCode, 201);
  await refused('POST', '/operations/deployments', { boat_id: boat.id, route_id: 'r2', service_date: day, capacity: 20 }, 409, 'boat_not_ready');

  const closed = await ok('POST', `/v1/fleet/jobs/${job.id}/close`, { outcome: 'success', note: 'pump replaced' });
  assert.deepEqual([closed.status, closed.outcome, closed.end_date, closed.boat_status_after], ['done', 'success', today, 'available']);
  assert.equal((await ok('GET', `/v1/fleet/availability?boat_id=${boat.id}&from=${day}`)).days[0].status, 'available');
  assert.equal((await ok('GET', `/v1/fleet/engines/${engine.id}`)).status, 'ready');
  assert.equal((await send('POST', '/operations/deployments', { boat_id: boat.id, route_id: 'r2', service_date: addDays(day, 1), capacity: 20 })).statusCode, 201);
  await refused('POST', `/v1/fleet/jobs/${job.id}/close`, {}, 409, 'job_done');
  await refused('DELETE', `/v1/fleet/jobs/${job.id}`, undefined, 409, 'job_done');
});

test('effective status: the log a person keeps wins over work, a job run alongside holds nothing, a charter boat is ours only on its days', async () => {
  const boat = await newBoat();
  const day = addDays(today, 40);
  const [alongside] = (await ok('POST', '/v1/fleet/jobs', { no: mj(), boat_id: boat.id, title: 'Seats', type: 'preventive' })).jobs;
  assert.deepEqual([alongside.boat_status, alongside.set_fixing], ['available', false]);
  await ok('POST', `/v1/fleet/jobs/${alongside.id}/start`, {});
  assert.equal((await ok('GET', `/v1/fleet/availability?boat_id=${boat.id}&from=${day}`)).days[0].status, 'available');

  const [scheduled] = (await ok('POST', '/v1/fleet/jobs', { no: mj(), boat_id: boat.id, title: 'Annual drydock', type: 'scheduled', create_anyway: true, start_date: addDays(day, 5) })).jobs;
  assert.deepEqual([scheduled.boat_status, scheduled.boat_status_reason], ['unavailable', 'scheduled_maint']);
  await ok('POST', `/v1/fleet/jobs/${scheduled.id}/start`, {});
  const before = (await ok('GET', `/v1/fleet/availability?boat_id=${boat.id}&from=${addDays(day, 4)}&to=${addDays(day, 5)}`)).days;
  // The start wrote the boat's log from today, so the boat is unavailable on both days by its log; the work holds it only from its start date.
  assert.deepEqual(before.map((x: { blocked_by: unknown[] }) => x.blocked_by.length), [0, 1]);
  assert.deepEqual(before.map((x: { status: string }) => x.status), ['unavailable', 'unavailable']);

  // The boat form starts a log; a charter boat with no entry covering the day is not ours that day.
  const charter = await newBoat({ ownership: 'charter' });
  for (const e of charter.status_log) await ok('DELETE', `/v1/boats/${charter.id}/status-log/${e.id}`);
  const c = (await ok('GET', `/v1/fleet/availability?boat_id=${charter.id}&from=${day}`)).days[0];
  assert.deepEqual([c.status, c.not_chartered], ['unavailable', true]);
  const refusedCharter = await refused('POST', '/operations/deployments', { boat_id: charter.id, route_id: 'r1', service_date: day, capacity: 20 }, 409, 'boat_not_ready');
  assert.match(refusedCharter.message, /not chartered/);
  await refused('GET', `/v1/fleet/availability?from=${day}&to=${addDays(day, 80)}`, undefined, 400);
  await refused('GET', '/v1/fleet/availability?boat_id=b-nowhere', undefined, 404);
});

test('plan ahead: an available entry over open work is a confirm, and then that work stops holding the boat on those days', async () => {
  const boat = await newBoat();
  const [job] = (await ok('POST', '/v1/fleet/jobs', { no: mj(), boat_id: boat.id, title: 'Gearbox leak', type: 'corrective' })).jobs;
  await ok('POST', `/v1/fleet/jobs/${job.id}/start`, {});
  const from = addDays(today, 50), to = addDays(today, 55);
  const entry = { status: 'available', from_date: from, to_date: to, province: 'Phuket', loc_type: 'pier', note: 'season' };
  const asked = await refused('POST', `/v1/boats/${boat.id}/status-log`, entry, 409, 'open_work');
  assert.match(asked.message, new RegExp(`${job.no}.*plan_ahead: true`));
  await refused('POST', `/v1/boats/${boat.id}/status-log`, { ...entry, planned_over: ['MJ-1'] }, 400);
  const planned = await ok('POST', `/v1/boats/${boat.id}/status-log`, { ...entry, plan_ahead: true });
  assert.deepEqual(planned.planned_over, [job.no]);
  assert.equal(planned.note, `season · วางล่วงหน้าทั้งที่ยังมีงานค้าง · ${job.no}`, 'the mark legacy writes into the note');
  const days = (await ok('GET', `/v1/fleet/availability?boat_id=${boat.id}&from=${addDays(from, -1)}&to=${from}`)).days;
  assert.deepEqual(days.map((x: { status: string }) => x.status), ['fixing', 'available']);
  assert.deepEqual(days[1].planned_over, [job.no]);
  assert.equal((await send('POST', '/operations/deployments', { boat_id: boat.id, route_id: 'r1', service_date: from, capacity: 20 })).statusCode, 201);
  // Editing the entry asks again (read raw); to fixing it drops the plan.
  await refused('PATCH', `/v1/boats/${boat.id}/status-log/${planned.id}`, { note: 'season' }, 409, 'open_work');
  const edited = await ok('PATCH', `/v1/boats/${boat.id}/status-log/${planned.id}`, { status: 'fixing' });
  assert.equal(edited.planned_over, null);
  await ok('PATCH', `/v1/boats/${boat.id}/status-log/${planned.id}`, { status: 'available', plan_ahead: true });
  // A job started later writes its own entry from today, which (as legacy's autoClosePrevLog) removes the
  // entries starting after it: the plan goes, and both jobs hold the boat.
  const [later] = (await ok('POST', '/v1/fleet/jobs', { no: mj(), boat_id: boat.id, title: 'Hull crack', create_anyway: true })).jobs;
  await ok('POST', `/v1/fleet/jobs/${later.id}/start`, {});
  const held = (await ok('GET', `/v1/fleet/availability?boat_id=${boat.id}&from=${from}`)).days[0];
  assert.deepEqual([held.status, held.planned_over, held.blocked_by.map((b: { no: string }) => b.no).sort()], ['fixing', null, [job.no, later.no].sort()]);
});

test('engines, gearboxes and propellers: the forms\' fields, and every place or status change through a command', async () => {
  const boat = await newBoat();
  await refused('POST', '/v1/fleet/engines', { brand: 'Honda', serial: 'X' }, 400);
  await refused('POST', '/v1/fleet/engines', { model: 'BF250D', serial: 'X', status: 'limited' }, 400);
  const spareEngine = await ok('POST', '/v1/fleet/engines', { model: 'BF250D', serial: `S-${Date.now()}`, status: 'spare', spareLocation: 'อู่ซ่อม', baseHours: 1200 });
  assert.deepEqual([spareEngine.status, spareEngine.spare_location, spareEngine.service_interval, spareEngine.hours], ['spare', 'อู่ซ่อม', 100, 1200]);
  assert.deepEqual([spareEngine.service.next, spareEngine.service.left, spareEngine.service.overdue], [1300, 100, false]);
  await refused('PATCH', `/v1/fleet/engines/${spareEngine.id}`, { status: 'ready' }, 400);
  await refused('PATCH', `/v1/fleet/engines/${spareEngine.id}`, { hours: 5 }, 400);
  await refused('PATCH', `/v1/fleet/engines/${spareEngine.id}`, { boat_id: boat.id }, 400);
  assert.equal((await ok('PATCH', `/v1/fleet/engines/${spareEngine.id}`, { note: 'rebuilt', service_interval: '' })).service_interval, 100, 'blank interval is 100, as the form');

  const gearbox = await ok('POST', '/v1/fleet/gearboxes', { brand: 'Honda', model: 'BF250D Gearbox', serial: `G-${Date.now()}` });
  assert.deepEqual([gearbox.status, gearbox.service.interval, gearbox.service.defaulted, gearbox.lifetime_hours], ['ready', 100, false, 0]);
  await refused('POST', `/v1/fleet/gearboxes/${gearbox.id}/install`, { engine_id: spareEngine.id }, 409, 'engine_not_installed');
  const installed = await ok('POST', `/v1/fleet/engines/${spareEngine.id}/install`, { boat_id: boat.id, pos: 'Std' });
  assert.deepEqual([installed.boat_id, installed.pos, installed.status], [boat.id, 'Std', 'ready']);
  const onEngine = await ok('POST', `/v1/fleet/gearboxes/${gearbox.id}/install`, { engine_id: spareEngine.id });
  assert.deepEqual([onEngine.engine_id, onEngine.boat_id, onEngine.base_hours], [spareEngine.id, boat.id, 1200], 'counted from the engine\'s hours at fitting');
  const second = await ok('POST', '/v1/fleet/gearboxes', { serial: `G2-${Date.now()}` });
  await refused('POST', `/v1/fleet/gearboxes/${second.id}/install`, { engine_id: spareEngine.id }, 409, 'engine_has_gearbox');

  const prop = await ok('POST', '/v1/fleet/propellers', { brand: 'Solas', serial: `P-${Date.now()}`, diameter: 15.5, pitch: 17 });
  assert.deepEqual([prop.size, prop.status, prop.cost], ['15.5×17', 'active', 0]);
  await refused('POST', `/v1/fleet/propellers/${prop.id}/status`, { status: 'damaged' }, 400);
  await ok('POST', `/v1/fleet/propellers/${prop.id}/install`, { gearbox_id: gearbox.id, prop_pos: 'Std' });
  const prop2 = await ok('POST', '/v1/fleet/propellers', { serial: `P2-${Date.now()}` });
  await refused('POST', `/v1/fleet/propellers/${prop2.id}/install`, { gearbox_id: gearbox.id }, 409, 'gearbox_has_propeller');

  const moved = await ok('POST', `/v1/fleet/gearboxes/${second.id}/move`, { spare_location: 'shop:honda-phuket' });
  assert.deepEqual([moved.status, moved.log.at(-1).type, moved.log.at(-1).description], ['fixing', 'repair', 'ส่งซ่อม: ไม่ระบุ → อู่ Honda Phuket']);
  const back = await ok('POST', `/v1/fleet/gearboxes/${second.id}/move`, { spare_location: 'pier:panwa' });
  assert.deepEqual([back.status, back.log.at(-1).description], ['spare', 'รับกลับจากซ่อม: อู่ Honda Phuket → คลัง Visit Panwa']);

  await refused('POST', `/v1/fleet/engines/${spareEngine.id}/service`, { hours: -1 }, 400);
  const svc = await ok('POST', `/v1/fleet/engines/${spareEngine.id}/service`, { hours: 1250 });
  assert.deepEqual([svc.last_service_hours, svc.last_service_date, svc.service.next], [1250, today, 1350]);
  const status = await ok('POST', `/v1/fleet/engines/${spareEngine.id}/status`, { status: 'broken' });
  assert.equal(status.log.at(-1).description, 'Status: ready → broken');

  const other = await newEngine(boat.id, 'Port');
  const [x] = [await ok('POST', `/v1/fleet/engines/${spareEngine.id}/swap`, { with_id: other.id })];
  assert.equal(x.pos, 'Port');
  assert.equal((await ok('GET', `/v1/fleet/engines/${other.id}`)).pos, 'Std');
  const removed = await ok('POST', `/v1/fleet/propellers/${prop.id}/remove`, { spare_location: 'pier:tublamu' });
  assert.deepEqual([removed.gearbox_id, removed.spare_location], [null, 'pier:tublamu']);
  await refused('POST', `/v1/fleet/propellers/${prop.id}/remove`, {}, 409, 'not_installed');
  const listed = await ok('GET', `/v1/fleet/engines?boat_id=${boat.id}`);
  assert.equal(listed.engines.length, 2);
  assert.equal(listed.engines[0].log, undefined, 'the list leaves out histories');
  await refused('GET', '/v1/fleet/engines/e-none', undefined, 404);
});

test('incidents: the client numbers them, severity follows priority, a quick fix closes at once, and a quick swap fits a spare', async () => {
  const boat = await newBoat();
  const engine = await newEngine(boat.id, 'Port');
  const gb = await ok('POST', '/v1/fleet/gearboxes', { brand: 'Honda', serial: `GA-${Date.now()}`, note: 'Port' });
  await ok('POST', `/v1/fleet/gearboxes/${gb.id}/install`, { engine_id: engine.id });
  const propeller = await ok('POST', '/v1/fleet/propellers', { serial: `PA-${Date.now()}`, size: '15.5×17' });
  await ok('POST', `/v1/fleet/propellers/${propeller.id}/install`, { gearbox_id: gb.id });
  const spare = await ok('POST', '/v1/fleet/gearboxes', { brand: 'Honda', serial: `GS-${Date.now()}`, status: 'spare', spare_location: 'pier:tublamu' });
  const wrongBrand = await ok('POST', '/v1/fleet/gearboxes', { brand: 'Suzuki', serial: `GX-${Date.now()}`, status: 'spare', spare_location: 'pier:tublamu' });

  const no = inc();
  await refused('POST', '/v1/fleet/incidents', { boat_id: boat.id, date: today, title: 'No number' }, 400);
  await refused('POST', '/v1/fleet/incidents', { no, boat_id: boat.id, date: today, title: 'x', severity: 'minor' }, 400);
  await refused('POST', '/v1/fleet/incidents', { no, boat_id: boat.id, date: today, title: 'x', damaged_assets: [{ type: 'engine', asset_id: 'e-none' }] }, 400);
  const charter = await newBoat({ ownership: 'charter' });
  await refused('POST', '/v1/fleet/incidents', { no, boat_id: charter.id, date: today, title: 'x' }, 400);
  const created = await ok('POST', '/v1/fleet/incidents', {
    no, boat_id: boat.id, date: today, title: 'Gearbox noise', priority: 3, remark: 'Somchai', cause: 'wear',
    damaged_assets: [{ type: 'engine', asset_id: engine.id }, { type: 'gearbox', asset_id: gb.id }, { type: 'hull', label: 'scratch' }],
  });
  assert.deepEqual([created.severity, created.status, created.shown_status, created.remark], ['major', 'open', 'open', 'Root cause: wear · Somchai']);
  assert.equal(created.damaged_assets[0].label, `${engine.serial} · Port`, 'labelled by the server');
  assert.equal(created.progress_log[0].text, `เปิด Incident: Gearbox noise · ความเสียหาย: ${engine.serial} · Port, ${gb.serial} · Port, scratch`);
  await refused('POST', '/v1/fleet/incidents', { no, boat_id: boat.id, date: today, title: 'again' }, 409, 'number_taken');
  const list = await ok('GET', `/v1/fleet/incidents?boat_id=${boat.id}`);
  assert.equal(list.incidents.length, 1);
  assert.match(list.next_no, /^INC-\d{3,}$/);

  const edited = await ok('PATCH', `/v1/fleet/incidents/${created.id}`, { priority: 5 });
  assert.equal(edited.severity, 'critical');
  assert.match(edited.progress_log.at(-1).text, /^✎ แก้ไขรายละเอียด/);
  await refused('PATCH', `/v1/fleet/incidents/${created.id}`, { status: 'closed' }, 400);
  await refused('PATCH', `/v1/fleet/incidents/${created.id}`, { job_id: 'mj-x' }, 400);

  await refused('POST', `/v1/fleet/incidents/${created.id}/swap`, { asset_type: 'gearbox', asset_id: gb.id, spare_id: wrongBrand.id }, 409, 'spare_not_compatible');
  await refused('POST', `/v1/fleet/incidents/${created.id}/swap`, { asset_type: 'propeller', asset_id: propeller.id, spare_id: spare.id }, 400);
  const swapped = await ok('POST', `/v1/fleet/incidents/${created.id}/swap`, { asset_type: 'gearbox', asset_id: gb.id, spare_id: spare.id, propellers: [{ id: propeller.id, action: 'keep' }] });
  const mark = swapped.damaged_assets.find((a: { asset_id: string }) => a.asset_id === gb.id);
  assert.deepEqual([mark.swapped, mark.swapped_to], [true, spare.serial]);
  const [newGb, oldGb, prop] = [await ok('GET', `/v1/fleet/gearboxes/${spare.id}`), await ok('GET', `/v1/fleet/gearboxes/${gb.id}`), await ok('GET', `/v1/fleet/propellers/${propeller.id}`)];
  assert.deepEqual([newGb.engine_id, newGb.status, newGb.spare_location], [engine.id, 'ready', null]);
  assert.deepEqual([oldGb.engine_id, oldGb.status, oldGb.spare_location], [null, 'fixing', 'shop:honda-phuket']);
  assert.equal(prop.gearbox_id, spare.id, 'kept on the new gearbox');

  const quick = await ok('POST', '/v1/fleet/incidents', { no: inc(), boat_id: boat.id, date: today, title: 'Loose rope', priority: 2, quick_fix: true });
  assert.deepEqual([quick.status, quick.shown_status, quick.resolved_on, quick.severity, quick.quick_fix], ['resolved', 'resolved', today, 'minor', true]);
  await ok('POST', `/v1/fleet/incidents/${quick.id}/log`, { text: 'checked', by: 'Somchai' });
  assert.equal((await ok('GET', `/v1/fleet/incidents/${quick.id}`)).progress_log.at(-1).text, 'checked');
  assert.equal((await send('DELETE', `/v1/fleet/incidents/${quick.id}`)).statusCode, 204);
  await refused('GET', `/v1/fleet/incidents/${quick.id}`, undefined, 404);
});

test('jobs from an incident: one per asset on request, the incident follows its jobs and closes with the last', async () => {
  const boat = await newBoat();
  const e1 = await newEngine(boat.id, 'Port'), e2 = await newEngine(boat.id, 'Std');
  const incident = await ok('POST', '/v1/fleet/incidents', {
    no: inc(), boat_id: boat.id, date: today, title: 'Overheat', damaged_assets: [{ type: 'engine', asset_id: e1.id }, { type: 'engine', asset_id: e2.id }],
  });
  const base = { boat_id: boat.id, title: 'Overheat', incident_id: incident.id };
  await refused('POST', '/v1/fleet/jobs', { ...base, no: mj() }, 400);
  await refused('POST', '/v1/fleet/jobs', { ...base, per_asset: true, nos: [mj()] }, 400);
  const nos = [mj(), mj()];
  const made = (await ok('POST', '/v1/fleet/jobs', { ...base, per_asset: true, nos })).jobs;
  assert.deepEqual(made.map((j: { no: string }) => j.no).sort(), [...nos].sort());
  assert.ok(made.every((j: { assets: unknown[] }) => j.assets.length === 1));
  const linked = await ok('GET', `/v1/fleet/incidents/${incident.id}`);
  assert.equal(linked.related_job_ids.length, 2);
  assert.equal(linked.shown_status, 'pending');
  await refused('POST', '/v1/fleet/jobs', { ...base, no: mj(), per_asset: false, create_anyway: true }, 409, 'incident_linked');
  await refused('POST', '/v1/fleet/jobs', { no: mj(), boat_id: boat.id, title: 'Another' }, 409, 'open_jobs');
  await refused('POST', '/v1/fleet/jobs', { no: nos[0], boat_id: boat.id, title: 'Dup', create_anyway: true }, 409, 'number_taken');
  await refused('POST', '/v1/fleet/jobs', { no: mj(), boat_id: boat.id, title: 'Bad', create_anyway: true, boat_status: 'unavailable' }, 400);

  const [first, second] = [...made].sort((a: { no: string }, b: { no: string }) => (a.no < b.no ? -1 : 1));
  const linkedJob = made.find((j: { id: string }) => j.id === linked.job_id);
  await ok('POST', `/v1/fleet/jobs/${linkedJob.id}/start`, {});
  assert.equal((await ok('GET', `/v1/fleet/incidents/${incident.id}`)).shown_status, 'inprogress');
  await refused('POST', `/v1/fleet/jobs/${linkedJob.id}/start`, {}, 409, 'job_started');
  const otherJob = linkedJob.id === first.id ? second : first;
  await ok('POST', `/v1/fleet/jobs/${otherJob.id}/start`, {});

  // Closing one while the other still holds the boat keeps the boat fixing.
  const one = await ok('POST', `/v1/fleet/jobs/${linkedJob.id}/close`, { outcome: 'success' });
  assert.equal(one.boat_status_after, 'fixing');
  assert.equal((await ok('GET', `/v1/fleet/incidents/${incident.id}`)).status, 'open', 'one job still open');
  await refused('POST', `/v1/fleet/jobs/${otherJob.id}/close`, { outcome: 'great' }, 400);
  const two = await ok('POST', `/v1/fleet/jobs/${otherJob.id}/close`, { outcome: 'limited', note: 'runs at half' });
  assert.equal(two.boat_status_after, 'available');
  const closedIncident = await ok('GET', `/v1/fleet/incidents/${incident.id}`);
  assert.deepEqual([closedIncident.status, closedIncident.closed_on], ['closed', today]);
  assert.equal((await ok('GET', `/v1/fleet/engines/${otherJob.assets[0].asset_id}`)).status, 'limited');
  const log = closedIncident.progress_log.map((l: { text: string }) => l.text);
  assert.ok(log.some((t: string) => t.startsWith('✓ ปิด Incident')), log.join('\n'));
});

test('a service-looking job asks whether to reset the service hours; decommission retires the engine', async () => {
  const boat = await newBoat();
  const engine = await newEngine(boat.id, 'Port', { base_hours: 480 });
  const gearbox = await ok('POST', '/v1/fleet/gearboxes', { serial: `GV-${Date.now()}` });
  await ok('POST', `/v1/fleet/gearboxes/${gearbox.id}/install`, { engine_id: engine.id });
  const [svc] = (await ok('POST', '/v1/fleet/jobs', { no: mj(), boat_id: boat.id, title: 'Oil change 500h', type: 'preventive', assets: [{ type: 'engine', asset_id: engine.id }] })).jobs;
  assert.equal(svc.assets[0].status, 'ready', 'a preventive job keeps the boat available, so its parts are only checked');
  await ok('POST', `/v1/fleet/jobs/${svc.id}/start`, {});
  await refused('POST', `/v1/fleet/jobs/${svc.id}/close`, { outcome: 'success' }, 409, 'reset_service_choice');
  const closed = await ok('POST', `/v1/fleet/jobs/${svc.id}/close`, { outcome: 'success', reset_service: true });
  assert.equal(closed.service_reset, 1);
  const serviced = await ok('GET', `/v1/fleet/engines/${engine.id}`);
  assert.deepEqual([serviced.last_service_hours, serviced.service.next], [480, 580]);

  const [dead] = (await ok('POST', '/v1/fleet/jobs', { no: mj(), boat_id: boat.id, title: 'Cracked block', assets: [{ type: 'engine', asset_id: engine.id }] })).jobs;
  await ok('POST', `/v1/fleet/jobs/${dead.id}/start`, { gear: 'stash', stash_location: 'pier:panwa' });
  const stashed = await ok('GET', `/v1/fleet/gearboxes/${gearbox.id}`);
  assert.deepEqual([stashed.engine_id, stashed.status, stashed.spare_location], [null, 'spare', 'pier:panwa']);
  await ok('POST', `/v1/fleet/jobs/${dead.id}/close`, { outcome: 'decommission', note: 'beyond repair' });
  const retired = await ok('GET', `/v1/fleet/engines/${engine.id}`);
  assert.deepEqual([retired.status, retired.retired, retired.retired_on, retired.retired_reason], ['broken', true, today, 'beyond repair']);
  await refused('POST', `/v1/fleet/jobs/${dead.id}/reset-service`, {}, 409, 'not_a_service');
});

test('a job\'s boat status, its parts of the boat, its log, the board and splitting it per engine', async () => {
  const boat = await newBoat();
  const e1 = await newEngine(boat.id, 'Port'), e2 = await newEngine(boat.id, 'Std'), e3 = await newEngine(boat.id, 'Center');
  const [job] = (await ok('POST', '/v1/fleet/jobs', { no: mj(), boat_id: boat.id, title: 'Engine overhaul', assets: [{ type: 'engine', asset_id: e1.id }, { type: 'engine', asset_id: e2.id }] })).jobs;
  await refused('PATCH', `/v1/fleet/jobs/${job.id}`, { status: 'done' }, 400);
  await refused('PATCH', `/v1/fleet/jobs/${job.id}`, { cost: 100 }, 400);
  await refused('PATCH', `/v1/fleet/jobs/${job.id}`, { boat_status: 'available' }, 400);
  await refused('PATCH', `/v1/fleet/jobs/${job.id}`, { lane: 'doing' }, 400);
  await refused('PATCH', `/v1/fleet/jobs/${job.id}`, { board_lane: 'later' }, 400);
  const board = await ok('PATCH', `/v1/fleet/jobs/${job.id}`, { owner: 'Somchai', due_date: addDays(today, 7), pinned: true });
  assert.deepEqual([board.owner, board.pinned, board.pinned_on], ['Somchai', true, today]);
  assert.equal(board.progress_log.at(-1).text, `ผู้รับผิดชอบ Somchai · ตอบภายใน ${addDays(today, 7)}`);
  assert.equal(board.lane, 'close', 'its boat can still sail: the job waits to be closed');
  const lane = await ok('PATCH', `/v1/fleet/jobs/${job.id}`, { board_lane: 'wait' });
  assert.equal(lane.lane, 'wait');
  const logged = await ok('POST', `/v1/fleet/jobs/${job.id}/log`, { text: 'Parts ordered', by: 'Somchai' });
  assert.deepEqual([logged.board_lane, logged.progress_log.at(-1).text], [null, 'Parts ordered'], 'new progress frees a dragged lane');

  const steps = await ok('POST', `/v1/fleet/jobs/${job.id}/steps/template`, {});
  assert.deepEqual(steps.steps.map((s: { text: string }) => s.text), ['ถอดตรวจ', 'ประเมิน + ขออนุมัติ', 'สั่งอะไหล่', 'ประกอบกลับ', 'ทดลองเดินเครื่อง']);
  await refused('POST', `/v1/fleet/jobs/${job.id}/steps/template`, {}, 409, 'steps_present');
  const ticked = await ok('PATCH', `/v1/fleet/jobs/${job.id}/steps/0`, { done: true });
  assert.deepEqual([ticked.steps[0].done, ticked.steps[0].done_on, ticked.progress_log.at(-1).text], [true, today, '☑ ถอดตรวจ · ขั้นตอน 1/5']);
  await refused('PATCH', `/v1/fleet/jobs/${job.id}/steps/9`, { done: true }, 404);
  assert.equal((await ok('DELETE', `/v1/fleet/jobs/${job.id}/steps/4`)).steps.length, 4);

  const statusDay = addDays(today, 3);
  await refused('POST', `/v1/fleet/jobs/${job.id}/boat-status`, { status: 'fixing', effective_date: statusDay }, 400);
  await refused('POST', `/v1/fleet/jobs/${job.id}/boat-status`, { status: 'unavailable', effective_date: statusDay }, 400);
  const changed = await ok('POST', `/v1/fleet/jobs/${job.id}/boat-status`, { status: 'unavailable', reason: 'donor', effective_date: statusDay });
  assert.deepEqual([changed.boat_status, changed.boat_status_reason, changed.set_fixing], ['unavailable', 'donor', true]);
  const boatNow = await ok('GET', `/v1/boats/${boat.id}`);
  assert.deepEqual(boatNow.status_log.at(-1), { ...boatNow.status_log.at(-1), status: 'unavailable', from_date: statusDay, reason: 'donor' });

  const withHull = await ok('POST', `/v1/fleet/jobs/${job.id}/assets`, { type: 'hull', label: 'keel', detail: 'paint' });
  assert.equal(withHull.assets.at(-1).label, 'keel');
  await refused('POST', `/v1/fleet/jobs/${job.id}/assets`, { type: 'engine' }, 400);
  const withEngine = await ok('POST', `/v1/fleet/jobs/${job.id}/assets`, { type: 'engine', asset_id: e3.id });
  assert.equal(withEngine.assets.at(-1).label, `${e3.serial} · Center`);
  assert.equal((await ok('GET', `/v1/fleet/engines/${e3.id}`)).status, 'fixing');
  const fewer = await ok('DELETE', `/v1/fleet/jobs/${job.id}/assets/${withEngine.assets.length - 1}`);
  assert.equal(fewer.assets.length, withEngine.assets.length - 1);

  await refused('POST', `/v1/fleet/jobs/${job.id}/split`, { by: 'job_engines', nos: [] }, 400);
  const split = await ok('POST', `/v1/fleet/jobs/${job.id}/split`, { by: 'job_engines', nos: [mj()] });
  assert.equal(split.created.length, 1);
  assert.equal(split.assets.filter((a: { type: string }) => a.type === 'engine').length, 1);
  assert.equal(split.title, `Engine overhaul — ${e1.serial} · Port`);
  const twin = await ok('GET', `/v1/fleet/jobs/${split.created[0].id}`);
  assert.deepEqual([twin.title, twin.status, twin.boat_status], [`Engine overhaul — ${e2.serial} · Std`, 'pending', 'unavailable']);
  assert.equal((await send('DELETE', `/v1/fleet/jobs/${twin.id}`)).statusCode, 204);
  const listed = await ok('GET', `/v1/fleet/jobs?boat_id=${boat.id}`);
  assert.equal(listed.jobs.length, 1);
  assert.match(listed.next_no, /^MJ-\d{3,}$/);
});

test('fleet writes need the fleet area; a quick read needs only a login', async () => {
  const res = await send('POST', '/v1/fleet/engines', { model: 'BF', serial: `Q-${Date.now()}` }, ops);
  assert.deepEqual([res.statusCode, res.json().code], [403, 'forbidden']);
  assert.equal((await send('POST', '/v1/fleet/engines', { model: 'BF', serial: `Q-${Date.now()}` }, mech)).statusCode, 201);
  assert.equal((await send('GET', '/v1/fleet/jobs', undefined, ops)).statusCode, 200);
  assert.equal((await send('GET', '/v1/fleet/availability', undefined, ops)).statusCode, 200);
});
