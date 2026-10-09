import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';

// Where fleet part A (jobs, engines, availability) meets part B (stock, memos, Daily Log, projects):
// src/domain/fleet-seams.ts, through the API on whichever store DATABASE_URL selects.
process.env.AUTH_JWT_SECRET = 'fleet-seams-test-secret';
const { buildApp } = await import('../src/app.js');
const { seedUser, testStore, tokenFor } = await import('./users-helper.js');
const { todayInThailand } = await import('../src/domain/calendar.js');
const { planJobPartAdd } = await import('../src/domain/fleet-seams.js');
const store = testStore();
const app = buildApp({ store });
after(async () => app.close());

const run = Date.now().toString(36);
await seedUser(store, { username: `seam.admin.${run}`, role: 'admin' });
await seedUser(store, { username: `seam.fleet.${run}`, edit_areas: ['fleet'] });
const admin = await tokenFor(app, `seam.admin.${run}`);
const fleet = await tokenFor(app, `seam.fleet.${run}`);
const call = (h: { authorization: string }, method: InjectOptions['method'], url: string, payload?: object) => app.inject({ method, url, headers: h, ...(payload ? { payload } : {}) });
const ok = (res: { statusCode: number; body: string }, status = 200) => { assert.equal(res.statusCode, status, res.body); return JSON.parse(res.body || 'null'); };
const today = todayInThailand();
let seq = 0;
const no = (p: string) => `${p}-S${run}-${seq++}`;
const newBoat = async () => ok(await call(admin, 'POST', '/v1/boats', { name: `Seam ${run} ${seq++}`, pier: 'panwa', capacity: 30, license_pax: 32 }), 201);

test('a project in progress holds its boat; completing it frees the boat', async () => {
  const boat = await newBoat();
  const p = ok(await call(fleet, 'POST', '/v1/fleet/projects', { no: no('PRJ'), name: 'Drydock', boat_id: boat.id, type: 'drydock', plan_from: today }), 201);
  ok(await call(fleet, 'POST', `/v1/fleet/projects/${p.id}/start`, {}));
  let day = ok(await call(fleet, 'GET', `/v1/fleet/availability?boat_id=${boat.id}&from=${today}`)).days[0];
  assert.equal(day.status, 'unavailable');
  assert.deepEqual(day.blocked_by.map((b: { kind: string; no: string }) => [b.kind, b.no]), [['project', p.no]]);
  ok(await call(fleet, 'POST', `/v1/fleet/projects/${p.id}/hold`, { reason: 'รออะไหล่' }));
  assert.equal(ok(await call(fleet, 'GET', `/v1/fleet/availability?boat_id=${boat.id}&from=${today}`)).days[0].blocked_by.length, 1, 'on hold still holds');
  ok(await call(fleet, 'POST', `/v1/fleet/projects/${p.id}/resume`, {}));
  ok(await call(fleet, 'POST', `/v1/fleet/projects/${p.id}/complete`, { no_cost_reason: 'warranty' }));
  day = ok(await call(fleet, 'GET', `/v1/fleet/availability?boat_id=${boat.id}&from=${today}`)).days[0];
  assert.deepEqual([day.status, day.blocked_by.length], ['available', 0]);
});

test('engine hours read the Daily Fleet Log\'s meters', async () => {
  const boat = await newBoat();
  const engine = ok(await call(fleet, 'POST', '/v1/fleet/engines', { brand: 'Honda', model: 'BF250D', serial: `SEAM-${run}-${seq++}`, boat_id: boat.id, pos: 'Port', base_hours: 100 }), 201);
  assert.equal(engine.hours ?? ok(await call(fleet, 'GET', `/v1/fleet/engines/${engine.id}`)).hours, 100);
  ok(await call(fleet, 'PATCH', `/v1/fleet/daily-log/2301-01-01/boats/${boat.id}`, { meters: { normal: { [engine.id]: 1000 } } }));
  ok(await call(fleet, 'PATCH', `/v1/fleet/daily-log/2301-01-02/boats/${boat.id}`, { meters: { normal: { [engine.id]: 1012.5 } } }));
  assert.equal(ok(await call(fleet, 'GET', `/v1/fleet/engines/${engine.id}`)).hours, 112.5, '100 brought in + 12.5 run');
});

test('a job\'s cost counts its memos, and its parts come out of stock and go back', async () => {
  const boat = await newBoat();
  const [job] = ok(await call(fleet, 'POST', '/v1/fleet/jobs', { no: no('MJ'), boat_id: boat.id, title: 'Water pump', type: 'corrective' }), 201).jobs;
  const memo = ok(await call(fleet, 'POST', '/v1/fleet/memos', { no: no('MO'), title: 'labour', memo_type: 'labor', vat_enabled: false, job_id: job.id, lines: [{ name: 'ช่าง', qty: 1, price: 800 }] }), 201);
  assert.equal(ok(await call(fleet, 'GET', `/v1/fleet/jobs/${job.id}`)).memo_cost, 0, 'pending approval does not count');
  ok(await call(fleet, 'POST', `/v1/fleet/memos/${memo.id}/approve`, { approved_by: 'Anon' }));
  let view = ok(await call(fleet, 'GET', `/v1/fleet/jobs/${job.id}`));
  assert.deepEqual([view.memo_cost, view.cost], [800, 800]);

  const item = ok(await call(fleet, 'POST', '/v1/fleet/stock-items', { name: `Impeller ${run}`, part_no: 'IMP', qty: 3, warehouse: 'panwa', cost: 250 }), 201);
  assert.equal(ok(await call(fleet, 'POST', `/v1/fleet/jobs/${job.id}/parts`, { item_id: item.id, warehouse: 'panwa', qty: 5 }), 409).code, 'stock_short');
  ok(await call(fleet, 'POST', `/v1/fleet/jobs/${job.id}/parts`, { item_id: item.id, warehouse: 'tublamu', qty: 1 }), 409);
  ok(await call(fleet, 'POST', `/v1/fleet/jobs/${job.id}/parts`, { item_id: item.id, qty: 1 }), 400);
  let r = ok(await call(fleet, 'POST', `/v1/fleet/jobs/${job.id}/parts`, { item_id: item.id, warehouse: 'คลัง Visit Panwa', qty: 2 }), 201);
  assert.deepEqual(r.job.parts.map((p: { inv_id: string; qty: number; location: string; cost: number }) => [p.inv_id, p.qty, p.location, p.cost]), [[item.id, 2, 'คลัง Visit Panwa', 250]]);
  assert.equal(r.item.total_qty, 1);
  assert.deepEqual([r.item.movements.at(-1).type, r.item.movements.at(-1).job_id], ['withdraw', job.id]);
  view = ok(await call(fleet, 'GET', `/v1/fleet/jobs/${job.id}`));
  assert.deepEqual([view.parts_cost, view.cost], [500, 1300]);
  r = ok(await call(fleet, 'DELETE', `/v1/fleet/jobs/${job.id}/parts/0`));
  assert.deepEqual([r.job.parts.length, r.item.total_qty, r.item.movements.at(-1).type], [0, 3, 'return']);
  ok(await call(fleet, 'DELETE', `/v1/fleet/jobs/${job.id}/parts/0`), 404);
});

test('a project\'s cost is its child jobs\'; completing it closes them, and cancelling can unlink them', async () => {
  const boat = await newBoat();
  const p = ok(await call(fleet, 'POST', '/v1/fleet/projects', { no: no('PRJ'), name: 'Overhaul', boat_id: boat.id, type: 'overhaul', plan_from: today }), 201);
  const [job] = ok(await call(fleet, 'POST', '/v1/fleet/jobs', { no: no('MJ'), boat_id: boat.id, title: 'Engine', type: 'scheduled', parent_project_id: p.id, create_anyway: true }), 201).jobs;
  const item = ok(await call(fleet, 'POST', '/v1/fleet/stock-items', { name: `Piston ${run}`, part_no: 'PS', qty: 1, warehouse: 'panwa', cost: 4000 }), 201);
  ok(await call(fleet, 'POST', `/v1/fleet/jobs/${job.id}/parts`, { item_id: item.id, warehouse: 'panwa', qty: 1 }), 201);
  ok(await call(fleet, 'POST', `/v1/fleet/projects/${p.id}/start`, {}));
  const file = ok(await call(fleet, 'POST', '/v1/attachments', { filename: 'inv.pdf', mime: 'application/pdf', data_b64: Buffer.from('%PDF-1.4').toString('base64') }), 201);
  let x = ok(await call(fleet, 'POST', `/v1/fleet/projects/${p.id}/documents`, { name: 'Final Invoice', attachment_id: file.id }));
  assert.deepEqual([x.cost, x.bill_gate.ok], [4000, true]);
  x = ok(await call(fleet, 'POST', `/v1/fleet/projects/${p.id}/complete`, {}));
  assert.equal(x.status, 'completed');
  const closed = ok(await call(fleet, 'GET', `/v1/fleet/jobs/${job.id}`));
  assert.equal(closed.status, 'done');
  assert.ok(closed.progress_log.some((l: { text: string }) => l.text.includes('Auto-closed by parent project')));

  const q = ok(await call(fleet, 'POST', '/v1/fleet/projects', { no: no('PRJ'), name: 'Refit', boat_id: boat.id, type: 'refit', plan_from: today }), 201);
  const [kid] = ok(await call(fleet, 'POST', '/v1/fleet/jobs', { no: no('MJ'), boat_id: boat.id, title: 'Seats', type: 'scheduled', parent_project_id: q.id, create_anyway: true }), 201).jobs;
  x = ok(await call(fleet, 'POST', `/v1/fleet/projects/${q.id}/cancel`, { reason: 'later', unlink_jobs: true }));
  assert.ok(x.log.at(-1).text.endsWith('· 1 MJ unlinked'));
  assert.equal(ok(await call(fleet, 'GET', `/v1/fleet/jobs/${kid.id}`)).parent_project_id, null);
});

test('a closed job\'s part is a late edit (legacy\'s confirm)', () => {
  const job = { id: 'j', no: 'MJ-1', title: 't', status: 'done', parts: [], progress_log: [] } as never;
  const item = { id: 'i', name: 'x', unit: 'ชิ้น', cost: 1, merged_into: null, deleted_at: null } as never;
  const moves = [{ warehouse: 'panwa', delta: 5 }] as never;
  const ctx = { now: '2026-10-09T00:00:00.000Z', today: '2026-10-09', by: 'me' };
  assert.throws(() => planJobPartAdd(job, item, moves, { item_id: 'i', warehouse: 'panwa', qty: 1 }, ctx), /late edit/);
  const late = planJobPartAdd(job, item, moves, { item_id: 'i', warehouse: 'panwa', qty: 1, late_anyway: true }, ctx);
  assert.deepEqual([late.job.parts[0].late, late.job.parts[0].late_by], [true, 'me']);
});
