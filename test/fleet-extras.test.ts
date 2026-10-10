import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { InjectOptions } from 'fastify';

// Fleet maintenance, the extras (todo/fleet-maintenance-model.md, "Design — extras") through the API,
// on whichever store DATABASE_URL selects: pier assignments and the Daily Log's day pier, certificates,
// the safety replace wizard, log lines, the fuel budget and the reports. Every computed or validated
// field is sent a wrong value somewhere below.
process.env.AUTH_JWT_SECRET = 'fleet-extras-test-secret';
const { buildApp } = await import('../src/app.js');
const { seedUser, testStore, tokenFor } = await import('./users-helper.js');
const { todayInThailand } = await import('../src/domain/calendar.js');
const { addDays } = await import('../src/domain/fleet-common.js');
const store = testStore();
const app = buildApp({ store });
after(async () => app.close());

type Headers = { authorization: string };
const run = Date.now().toString(36);
/** A year no other run uses, so day locks, prices and monthly reports start empty on a reused database. */
const Y = 2200 + Math.floor(Math.random() * 700);
const today = todayInThailand();
const call = (headers: Headers, method: InjectOptions['method'], url: string, payload?: object) => app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
const ok = (res: { statusCode: number; body: string }, status = 200) => { assert.equal(res.statusCode, status, res.body); return JSON.parse(res.body || 'null'); };
const refused = (res: { statusCode: number; body: string }, status: number, code?: string) => {
  assert.equal(res.statusCode, status, res.body);
  if (code) assert.equal(JSON.parse(res.body).code, code, res.body);
  return JSON.parse(res.body);
};
const as = async (username: string, fields: object = {}): Promise<Headers> => { await seedUser(store, { username, ...fields }); return tokenFor(app, username); };
let seq = 0;
const no = (p: string) => `${p}-X${run}-${seq++}`;

let admin: Headers; let fleet: Headers; let config: Headers; let sales: Headers;
const newBoat = async (pier = 'tublamu', extra: object = {}) => ok(await call(admin, 'POST', '/v1/boats', { name: `Extra ${run} ${seq++}`, pier, capacity: 30, license_pax: 32, ...extra }), 201);
before(async () => {
  admin = await as(`fx.admin.${run}`, { role: 'admin' });
  fleet = await as(`fx.fleet.${run}`, { edit_areas: ['fleet'] });
  config = await as(`fx.config.${run}`, { edit_areas: ['config'] });
  sales = await as(`fx.sales.${run}`, { edit_areas: ['sales'] });
});

test('pier assignments: validated, status computed, a permanent move active today changes the home pier, cancel is kept', async () => {
  const boat = await newBoat('tublamu');
  const base = `/v1/boats/${boat.id}/assignments`;
  const asn = { type: 'temporary', from_pier: 'tublamu', to_pier: 'panwa', start_date: addDays(today, -1), end_date: addDays(today, 5), reason: 'high season', cost: 1500 };
  refused(await call(sales, 'POST', base, asn), 403);
  refused(await call(fleet, 'POST', base, { ...asn, to_pier: 'tublamu' }), 400);
  refused(await call(fleet, 'POST', base, { ...asn, end_date: undefined }), 400);
  refused(await call(fleet, 'POST', base, { ...asn, end_date: addDays(today, -3) }), 400);
  refused(await call(fleet, 'POST', base, { ...asn, type: 'forever' }), 400);
  refused(await call(fleet, 'POST', base, { ...asn, to_pier: 'phuket' }), 400);
  refused(await call(fleet, 'POST', base, { ...asn, cost: -1 }), 400);
  refused(await call(fleet, 'POST', base, { ...asn, status: 'completed' }), 400, undefined);

  const made = ok(await call(fleet, 'POST', base, asn), 201);
  assert.deepEqual([made.assignment.status, made.assignment.cost, made.boat_pier], ['active', 1500, 'tublamu'], 'a temporary move keeps the home pier');
  const planned = ok(await call(config, 'POST', base, { ...asn, startDate: addDays(today, 30), endDate: addDays(today, 40) }), 201).assignment;
  assert.equal(planned.status, 'planned');

  let view = ok(await call(sales, 'GET', `/v1/boats/${boat.id}`));
  assert.deepEqual([view.pier, view.pier_today, view.at_shop], ['tublamu', 'panwa', null]);
  refused(await call(admin, 'PATCH', `/v1/boats/${boat.id}`, { pier_today: 'ranong' }), 400);
  const list = ok(await call(sales, 'GET', base));
  assert.equal(list.active.id, made.assignment.id);
  assert.deepEqual(list.planned.map((a: { id: string }) => a.id), [planned.id]);
  assert.equal(list.pier_today, 'panwa');

  const cancelled = ok(await call(fleet, 'POST', `${base}/${made.assignment.id}/cancel`, {}));
  assert.deepEqual([cancelled.status, cancelled.cancelled], ['cancelled', true]);
  refused(await call(fleet, 'POST', `${base}/${made.assignment.id}/cancel`, {}), 409, 'already_cancelled');
  refused(await call(fleet, 'POST', `${base}/nope/cancel`, {}), 404);
  view = ok(await call(sales, 'GET', `/v1/boats/${boat.id}`));
  assert.equal(view.pier_today, 'tublamu', 'a cancelled move no longer counts');
  assert.equal(ok(await call(sales, 'GET', base)).assignments.length, 2, 'the cancelled one is kept');

  const perm = ok(await call(fleet, 'POST', base, { ...asn, type: 'permanent', to_pier: 'ranong' }), 201);
  assert.equal(perm.boat_pier, 'ranong');
  assert.equal(ok(await call(sales, 'GET', `/v1/boats/${boat.id}`)).pier, 'ranong', 'legacy: a permanent move active today sets the home pier');
  ok(await call(fleet, 'POST', `${base}/${perm.assignment.id}/cancel`, {}));
  assert.equal(ok(await call(sales, 'GET', `/v1/boats/${boat.id}`)).pier, 'ranong', 'and cancelling does not set it back (legacy)');
});

test('the Daily Log groups and locks a boat by its pier that day, and flags what legacy flags', async () => {
  const boat = await newBoat('tublamu');
  const d1 = `${Y}-05-10`, d2 = `${Y}-05-11`;
  ok(await call(fleet, 'POST', `/v1/boats/${boat.id}/assignments`, { from_pier: 'tublamu', to_pier: 'panwa', start_date: `${Y}-05-01`, end_date: `${Y}-05-31` }), 201);
  ok(await call(fleet, 'PATCH', `/v1/fleet/daily-log/${d1}/boats/${boat.id}`, { fuel_litres: 300, pax_actual: 10, meters: { normal: { [`eng-${run}`]: 1000 } } }));
  let day = ok(await call(fleet, 'GET', `/v1/fleet/daily-log?from=${d1}`)).days[0];
  let row = day.boats.find((b: { boat_id: string }) => b.boat_id === boat.id);
  assert.equal(row.pier, 'panwa', 'the assignment, not the home pier');
  assert.deepEqual([row.pax, row.pax_booked, row.litres_per_pax], [10, 0, 30]);
  assert.deepEqual(row.flags.sort(), ['high_fuel_per_pax', 'price_missing']);
  assert.deepEqual(day.anomalies, [{ boat_id: boat.id, litres_per_pax: 30 }]);
  assert.equal(row.meter_deltas.normal[`eng-${run}`], null, 'no earlier reading');

  ok(await call(fleet, 'PUT', `/v1/fleet/daily-log/${d2}/fuel-prices`, { [boat.id]: 40 }));
  ok(await call(fleet, 'PATCH', `/v1/fleet/daily-log/${d2}/boats/${boat.id}`, { fuel_litres: 100, pax_actual: 20, meters: { normal: { [`eng-${run}`]: 990 } } }));
  ok(await call(fleet, 'PUT', `/v1/fleet/daily-log/${d2}/boats/${boat.id}/water`, { open: 50, close: 40 }));
  row = ok(await call(fleet, 'GET', `/v1/fleet/daily-log?from=${d2}`)).days[0].boats.find((b: { boat_id: string }) => b.boat_id === boat.id);
  assert.deepEqual(row.flags.sort(), ['meter_backwards', 'water_negative']);
  assert.equal(row.meter_deltas.normal[`eng-${run}`], -10);

  // Its day lock is the pier it works from that day.
  ok(await call(fleet, 'POST', `/v1/fleet/daily-log/${d2}/piers/tublamu/lock`, {}));
  ok(await call(fleet, 'PATCH', `/v1/fleet/daily-log/${d2}/boats/${boat.id}`, { fuel_litres: 110 }));
  ok(await call(fleet, 'POST', `/v1/fleet/daily-log/${d2}/piers/panwa/lock`, {}));
  refused(await call(fleet, 'PATCH', `/v1/fleet/daily-log/${d2}/boats/${boat.id}`, { fuel_litres: 120 }), 409, 'day_locked');
  refused(await call(fleet, 'PUT', `/v1/fleet/daily-log/${d2}/fuel-prices`, { [boat.id]: 41 }), 409, 'day_locked');
  ok(await call(fleet, 'POST', `/v1/fleet/daily-log/${d2}/piers/panwa/unlock`, {}));
});

test('certificates: status computed from the expiry, the matrix shows the current row per type, renew as legacy', async () => {
  const docs = [
    { name: 'ใบอนุญาตใช้เรือ', expires_on: addDays(today, -5) },
    { name: 'ใบอนุญาตใช้เรือ', expires_on: addDays(today, -400), renew_status: 'done' },
    { name: 'ใบสำคัญรับรองการตรวจเรือ', expires_on: addDays(today, 200) },
    { name: 'ใบอนุญาต สิมิลัน', expires_on: addDays(today, 20) },
    { name: 'ใบอนุญาต พีพี', expires_on: addDays(today, 60), renew_status: 'processing' },
    { name: 'ใบอนุญาต อ่าวพังงา', expires_on: addDays(today, 89) },
    { name: 'Crew list', expires_on: null },
  ];
  const boat = await newBoat('panwa', { documents: docs });
  const read = ok(await call(sales, 'GET', `/v1/boats/${boat.id}/documents`)).documents;
  assert.deepEqual(read.map((d: { doc_type: string; status: string; current: boolean }) => [d.doc_type, d.status, d.current]), [
    ['lic', 'exp', true], ['lic', 'exp', false], ['inspect', 'ok', true], ['similan', 'warn30', true], ['pp', 'processing', true], ['phangnga', 'warn90', true], ['other', 'na', true],
  ]);
  assert.equal(read[0].days_left, -5);
  const matrix = ok(await call(sales, 'GET', '/v1/fleet/certificates'));
  const mine = matrix.boats.find((b: { boat_id: string }) => b.boat_id === boat.id);
  assert.deepEqual(Object.entries(mine.cells).map(([k, c]) => [k, (c as { status: string } | null)?.status ?? null]),
    [['lic', 'exp'], ['inspect', 'ok'], ['ins', null], ['similan', 'warn30'], ['surin', null], ['pp', 'processing'], ['phangnga', 'warn90'], ['tarn', null]]);
  assert.ok(matrix.expired_boats.includes(boat.id));
  assert.ok(matrix.issues.some((i: { boat_id: string; doc_type: string }) => i.boat_id === boat.id && i.doc_type === 'similan'));

  const renew = `/v1/boats/${boat.id}/documents/renew`;
  refused(await call(sales, 'POST', renew, { name: 'ใบอนุญาตใช้เรือ', state: 'ok', expires_on: addDays(today, 365) }), 403);
  refused(await call(fleet, 'POST', renew, { name: 'ใบอนุญาตใช้เรือ', state: 'ok' }), 400);
  refused(await call(fleet, 'POST', renew, { name: 'ใบอนุญาตใช้เรือ', state: 'renewed' }), 400);
  refused(await call(fleet, 'POST', renew, { name: 'ใบอนุญาตใช้เรือ', state: 'ok', expires_on: addDays(today, 365), status: 'ok' }), 400);
  let after = ok(await call(fleet, 'POST', renew, { name: 'ใบอนุญาตใช้เรือ', state: 'processing' })).documents;
  assert.deepEqual([after[1].renew_status, after[1].status], ['processing', 'processing'], 'the latest row of that name is marked');
  after = ok(await call(config, 'POST', renew, { name: 'ใบอนุญาตใช้เรือ', state: 'ok', expires_on: addDays(today, 365) })).documents;
  assert.equal(after.length, 8);
  assert.deepEqual(after.filter((d: { name: string }) => d.name === 'ใบอนุญาตใช้เรือ').map((d: { renew_status: string | null; status: string; current: boolean }) => [d.renew_status, d.status, d.current]),
    [[null, 'exp', false], ['done', 'exp', false], [null, 'ok', true]]);
  after = ok(await call(fleet, 'POST', renew, { name: 'ใบอนุญาต พีพี', state: 'exp' })).documents;
  assert.equal(after.find((d: { name: string }) => d.name === 'ใบอนุญาต พีพี').status, 'warn90');
  after = ok(await call(fleet, 'POST', renew, { name: 'ประกันภัยเรือ', state: 'processing', expires_on: addDays(today, 10) })).documents;
  assert.deepEqual([after.at(-1).doc_type, after.at(-1).status], ['ins', 'processing'], 'a name with no row gets one');
});

test('the safety replace wizard: from stock or bought, one incident, one closed job, the old item replaced and a new one installed', async () => {
  const boat = await newBoat('panwa');
  const pump = ok(await call(fleet, 'POST', '/v1/fleet/safety', { boat_id: boat.id, category: 'bilge_pump', name: 'Bilge pump · aft', serial: 'BP-001', expiry_date: addDays(today, -1), location: 'aft engine room', note: '12V' }), 201);
  const item = ok(await call(fleet, 'POST', '/v1/fleet/stock-items', { name: `Bilge pump ${run}`, part_no: `BP-${run}`, qty: 2, warehouse: 'panwa', cost: 1800 }), 201);
  const url = `/v1/fleet/safety/${pump.id}/replace`;
  const body = { reason: 'broken', description: 'motor stuck', source: 'inventory', item_id: item.id, serial: 'BP-002', installer: 'Somchai', labour: 300, incident_no: no('INC'), job_no: no('MJ') };
  refused(await call(sales, 'POST', url, body), 403);
  refused(await call(fleet, 'POST', url, { ...body, item_id: undefined }), 400);
  refused(await call(fleet, 'POST', url, { ...body, incident_no: undefined }), 400);
  refused(await call(fleet, 'POST', url, { ...body, reason: 'bored' }), 400);
  refused(await call(fleet, 'POST', url, { ...body, serial: undefined }), 409, 'no_serial');
  refused(await call(fleet, 'POST', url, { ...body, cost: 9999 }), 400);

  const r = ok(await call(fleet, 'POST', url, body), 201);
  assert.deepEqual([r.incident.status, r.incident.priority, r.incident.severity, r.incident.job_id], ['resolved', 5, 'critical', r.job.id]);
  assert.equal(r.incident.progress_log.length, 4);
  assert.deepEqual([r.job.status, r.job.set_fixing, r.job.incident_id], ['done', false, r.incident.id]);
  const job = ok(await call(fleet, 'GET', `/v1/fleet/jobs/${r.job.id}`));
  assert.equal(job.cost, 2100, 'the part at its cost plus the labour, as legacy stored it');
  assert.equal(r.withdrawn_item.total_qty, 1);
  const moves = ok(await call(fleet, 'GET', `/v1/fleet/stock-items/${item.id}`)).movements;
  assert.deepEqual([moves.at(-1).type, moves.at(-1).warehouse, moves.at(-1).job_id], ['withdraw', 'panwa', r.job.id]);
  assert.deepEqual([r.old_item.status, r.old_item.state.label, r.old_item.log.at(-1).type], ['replaced', 'REPLACED', 'replace']);
  assert.match(r.old_item.log.at(-1).desc, /^Replaced via .* reason: Broken · new SN BP-002$/);
  assert.deepEqual([r.new_item.status, r.new_item.serial, r.new_item.install_date, r.new_item.last_inspect], ['active', 'BP-002', today, today]);
  assert.equal(r.new_item.expiry_date, pump.expiry_date, 'legacy copies the old expiry unless one is sent');
  assert.equal(r.new_item.inspections[0].result, 'pass');
  assert.equal(r.new_item.note, '12V · replaces BP-001');
  refused(await call(fleet, 'POST', url, { ...body, incident_no: no('INC'), job_no: no('MJ') }), 409, 'already_replaced');

  // Out of stock: legacy's confirm; numbers already used are refused.
  const empty = ok(await call(fleet, 'POST', '/v1/fleet/stock-items', { name: `Flare ${run}`, part_no: `FL-${run}` }), 201);
  const flare = ok(await call(fleet, 'POST', '/v1/fleet/safety', { boat_id: boat.id, category: 'flare', name: 'Flares' }), 201);
  const furl = `/v1/fleet/safety/${flare.id}/replace`;
  const fbody = { reason: 'expired', item_id: empty.id, serial_anyway: true, incident_no: no('INC'), job_no: no('MJ'), expiry_date: addDays(today, 700) };
  refused(await call(fleet, 'POST', furl, { ...fbody, incident_no: r.incident.no }), 409, 'number_taken');
  refused(await call(fleet, 'POST', furl, fbody), 409, 'stock_short');
  const f = ok(await call(fleet, 'POST', furl, { ...fbody, allow_negative: true }), 201);
  assert.equal(f.withdrawn_item.total_qty, -1);
  assert.deepEqual([f.incident.priority, f.incident.severity, f.new_item.expiry_date], [3, 'medium', addDays(today, 700)]);

  // Bought: a stock item and a pending memo; the job carries the price.
  const vhf = ok(await call(fleet, 'POST', '/v1/fleet/safety', { boat_id: boat.id, category: 'vhf', name: 'VHF', brand: 'Icom', serial: 'V1' }), 201);
  const burl = `/v1/fleet/safety/${vhf.id}/replace`;
  const bbody = { reason: 'upgrade', source: 'buy', price: 5000, supplier: 'Marine', serial: 'V2', incident_no: no('INC'), job_no: no('MJ'), memo_no: no('MO') };
  refused(await call(fleet, 'POST', burl, { ...bbody, brand: '' }), 400);
  refused(await call(fleet, 'POST', burl, { ...bbody, model: 'M330', memo_no: undefined }), 400);
  const b = ok(await call(fleet, 'POST', burl, { ...bbody, model: 'M330' }), 201);
  assert.deepEqual([b.memo.status, b.memo.job_id, b.memo.amount, b.memo.lines[0].item_id !== null], ['pending_approval', null, 5350, true]);
  assert.match(b.memo.ref_note, /^Replace VHF radio via /);
  assert.deepEqual([b.new_item.brand, b.new_item.model], ['Icom', 'M330']);
  assert.equal(ok(await call(fleet, 'GET', `/v1/fleet/jobs/${b.job.id}`)).cost, 5000);
  refused(await call(fleet, 'POST', `/v1/fleet/safety/${pump.id}/replace`, { ...bbody, model: 'x', memo_no: b.memo.no, incident_no: no('INC'), job_no: no('MJ') }), 409, 'already_replaced');
});

test('memo events and jobs under a project write legacy\'s log lines', async () => {
  const boat = await newBoat('panwa');
  const inc = ok(await call(fleet, 'POST', '/v1/fleet/incidents', { no: no('INC'), boat_id: boat.id, date: today, title: 'Leak' }), 201);
  const [job] = ok(await call(fleet, 'POST', '/v1/fleet/jobs', { no: no('MJ'), boat_id: boat.id, title: 'Fix leak', incident_id: inc.id }), 201).jobs;
  const memo = ok(await call(fleet, 'POST', '/v1/fleet/memos', { no: no('MO'), title: 'Sealant', memo_type: 'labor', vat_enabled: false, job_id: job.id, memo_date: today, lines: [{ name: 'ช่าง', qty: 1, price: 1200 }] }), 201);
  let j = ok(await call(fleet, 'GET', `/v1/fleet/jobs/${job.id}`));
  assert.equal(j.progress_log.at(-1).text, `📋 สร้าง Memo ${memo.no} · ฿1,200`);
  let i = ok(await call(fleet, 'GET', `/v1/fleet/incidents/${inc.id}`));
  assert.deepEqual([i.progress_log.at(-1).text, i.progress_log.at(-1).by], [`📋 สร้าง Memo ${memo.no} · Sealant · ฿1,200`, 'ระบบ']);
  ok(await call(fleet, 'PATCH', `/v1/fleet/memos/${memo.id}`, { lines: [{ id: memo.lines[0].id, name: 'ช่าง', qty: 1, price: 1500 }] }));
  i = ok(await call(fleet, 'GET', `/v1/fleet/incidents/${inc.id}`));
  assert.equal(i.progress_log.at(-1).text, `✏️ แก้ไข Memo ${memo.no} · ฿1,500`);
  ok(await call(fleet, 'POST', `/v1/fleet/memos/${memo.id}/cancel`, { reason: 'wrong shop' }));
  i = ok(await call(fleet, 'GET', `/v1/fleet/incidents/${inc.id}`));
  assert.equal(i.progress_log.at(-1).text, `🚫 ยกเลิก Memo ${memo.no} · wrong shop`);
  j = ok(await call(fleet, 'GET', `/v1/fleet/jobs/${job.id}`));
  assert.equal(j.progress_log.filter((l: { text: string }) => l.text.includes(memo.no)).length, 1, 'edit and cancel write the incident only (legacy)');

  const p = ok(await call(fleet, 'POST', '/v1/fleet/projects', { no: no('PRJ'), name: 'Refit', boat_id: boat.id, type: 'refit', plan_from: today }), 201);
  refused(await call(fleet, 'POST', '/v1/fleet/jobs', { no: no('MJ'), boat_id: boat.id, title: 'x', parent_project_id: 'prj_nope', create_anyway: true }), 400);
  const [kid] = ok(await call(fleet, 'POST', '/v1/fleet/jobs', { no: no('MJ'), boat_id: boat.id, title: 'Seats', type: 'scheduled', parent_project_id: p.id, create_anyway: true }), 201).jobs;
  assert.equal(kid.progress_log.at(-1).text, `+ Created under project ${p.no}`);
  const pm = ok(await call(fleet, 'POST', '/v1/fleet/memos', { no: no('MO'), title: 'Paint', memo_type: 'labor', vat_enabled: false, project_id: p.id, memo_date: today, lines: [{ name: 'ช่าง', qty: 1, price: 900 }] }), 201);
  let log = ok(await call(fleet, 'GET', `/v1/fleet/projects/${p.id}`)).log.map((l: { text: string }) => l.text);
  assert.ok(log.includes(`+ Created MJ ${kid.no} · Seats`));
  assert.ok(log.includes(`Memo ${pm.no} · Paint · ฿900 (Project overhead)`));
  refused(await call(fleet, 'PATCH', `/v1/fleet/jobs/${kid.id}`, { parent_project_id: 'prj_nope' }), 400);
  ok(await call(fleet, 'PATCH', `/v1/fleet/jobs/${kid.id}`, { parent_project_id: null }));
  log = ok(await call(fleet, 'GET', `/v1/fleet/projects/${p.id}`)).log.map((l: { text: string }) => l.text);
  assert.ok(log.includes(`− Unlinked MJ ${kid.no}`));
  j = ok(await call(fleet, 'PATCH', `/v1/fleet/jobs/${kid.id}`, { parent_project_id: p.id }));
  assert.equal(j.progress_log.at(-1).text, `🔗 Linked to project ${p.no} · Refit`);
});

test('the fuel budget is stored per month; the fuel report reads it with the Daily Log', async () => {
  const month = `${Y}-04`;
  refused(await call(sales, 'PUT', `/v1/fleet/fuel-budgets/${month}`, { amount: 5000 }), 403);
  refused(await call(fleet, 'PUT', `/v1/fleet/fuel-budgets/${Y}-13`, { amount: 5000 }), 400);
  refused(await call(fleet, 'PUT', `/v1/fleet/fuel-budgets/${month}`, { amount: 0 }), 400);
  assert.deepEqual(ok(await call(fleet, 'PUT', `/v1/fleet/fuel-budgets/${month}`, { amount: 30000 })).amount, 30000);
  assert.ok(ok(await call(sales, 'GET', '/v1/fleet/fuel-budgets')).budgets.some((b: { month: string; amount: number }) => b.month === month && b.amount === 30000));

  const boat = await newBoat('panwa');
  for (const [d, fuel] of [['01', 100], ['02', 100], ['03', 100], ['04', 200]] as const) {
    ok(await call(fleet, 'PATCH', `/v1/fleet/daily-log/${month}-${d}/boats/${boat.id}`, { fuel_litres: fuel }));
  }
  ok(await call(fleet, 'PUT', `/v1/fleet/daily-log/${month}-01/fuel-prices`, { panwa: 40 }));
  refused(await call(sales, 'GET', `/v1/fleet/reports/fuel?month=${Y}-4`), 400);
  const r = ok(await call(sales, 'GET', `/v1/fleet/reports/fuel?month=${month}`));
  const mine = r.boats.find((b: { boat_id: string }) => b.boat_id === boat.id);
  assert.deepEqual([mine.days, mine.fuel, mine.cost, mine.missing], [4, 500, 4000, 0], 'only the 1st has a (pier) price: legacy reads no other day');
  assert.ok(r.price_missing);
  assert.deepEqual(r.anomalies.filter((a: { boat_id: string }) => a.boat_id === boat.id).map((a: { date: string; fuel: number; average: number; pct: number }) => [a.date, a.fuel, a.average, a.pct]),
    [[`${month}-04`, 200, 125, 60]]);
  assert.deepEqual([r.budget, r.days_in_month, r.elapsed], [30000, 30, 30]);
  assert.equal(r.trend.find((t: { boat_id: string }) => t.boat_id === boat.id).weeks[0].fuel, 500);
  ok(await call(fleet, 'PUT', `/v1/fleet/fuel-budgets/${month}`, { amount: null }));
  assert.equal(ok(await call(sales, 'GET', `/v1/fleet/reports/fuel?month=${month}`)).budget, null);
});

test('cost, upkeep, dashboard and repair history read jobs, memos and draws', async () => {
  const boat = await newBoat('panwa');
  const item = ok(await call(fleet, 'POST', '/v1/fleet/stock-items', { name: `Gasket ${run}`, part_no: `G-${run}`, qty: 10, warehouse: 'panwa', cost: 100 }), 201);
  const [job] = ok(await call(fleet, 'POST', '/v1/fleet/jobs', { no: no('MJ'), boat_id: boat.id, title: 'Hull patch', type: 'corrective', assets: [{ type: 'hull', label: 'Bow' }] }), 201).jobs;
  ok(await call(fleet, 'POST', `/v1/fleet/jobs/${job.id}/parts`, { item_id: item.id, warehouse: 'panwa', qty: 3 }), 201);
  ok(await call(fleet, 'POST', `/v1/fleet/jobs/${job.id}/start`, {}));
  ok(await call(fleet, 'POST', `/v1/fleet/jobs/${job.id}/close`, { outcome: 'success' }));
  ok(await call(fleet, 'POST', '/v1/fleet/consumables', { item_id: item.id, warehouse: 'panwa', qty: 2, boat_id: boat.id, date: today }), 201);

  refused(await call(sales, 'GET', '/v1/fleet/reports/cost?period=week'), 400);
  const cost = ok(await call(sales, 'GET', '/v1/fleet/reports/cost?period=month'));
  const row = cost.rows.find((x: { id: string }) => x.id === job.id);
  assert.deepEqual([row.cost, row.cats, row.done], [300, ['hull'], true]);
  assert.equal(cost.boats.find((b: { boat_id: string }) => b.boat_id === boat.id).cats.hull, 300);
  assert.equal(cost.months.length, 12);

  refused(await call(sales, 'GET', '/v1/fleet/reports/upkeep?month=2026'), 400);
  const up = ok(await call(sales, 'GET', `/v1/fleet/reports/upkeep?month=${today.slice(0, 7)}`));
  assert.deepEqual(up.boats.find((b: { boat_id: string }) => b.boat_id === boat.id), { boat_id: boat.id, name: boat.name, repairs: 300, consumables: 200, upkeep: 500 });

  refused(await call(sales, 'GET', '/v1/fleet/dashboard?date=2026-02-30'), 400);
  const dash = ok(await call(sales, 'GET', '/v1/fleet/dashboard'));
  assert.equal(typeof dash.board.open, 'number');
  assert.ok(Object.keys(dash.board.lanes).every((k) => ['decide', 'wait', 'doing', 'close'].includes(k)));
  assert.ok(dash.piers.panwa >= 1);
  assert.ok(dash.service_due.engines.every((e: { interval: number }) => e.interval > 0), 'each engine against its own interval');

  refused(await call(sales, 'GET', '/v1/fleet/repair-history'), 400);
  refused(await call(sales, 'GET', '/v1/fleet/repair-history?boat_id=nope'), 404);
  const hist = ok(await call(sales, 'GET', `/v1/fleet/repair-history?boat_id=${boat.id}`)).repairs;
  assert.deepEqual(hist.map((h: { job_no: string; cost: number; outcome: string; date: string }) => [h.job_no, h.cost, h.outcome, h.date]), [[job.no, 300, 'success', today]]);
});

test('rules: the pier a boat works from, certificate thresholds, earlier meters, a memo bought into stock', async () => {
  const { pierOn, dailyPier, shopOf } = await import('../src/domain/fleet-assignments.js');
  const { docStatus, docType } = await import('../src/domain/fleet-certificates.js');
  const { prevMeters } = await import('../src/domain/fleet-daily.js');
  const { directShare } = await import('../src/domain/fleet-reports.js');
  const entry = (loc: string) => ({ id: 's', status: 'available', from_date: '2030-01-01', to_date: null, loc, province: null, loc_type: null, detail: null, note: null, reason: null, project_id: null, planned_over: null });
  const boat = { id: 'b1', pier: 'tublamu', status_log: [entry('Visit Panwa Pier · Phuket')] } as never;
  assert.equal(pierOn(boat, '2030-02-01', []), 'panwa', 'the status entry names a pier (legacy keyword step)');
  assert.equal(pierOn({ id: 'b1', pier: 'tublamu', status_log: [entry('Se La Va')] } as never, '2030-02-01', []), 'ranong');
  const a = (id: string, created: string, to: string) => ({ id, boat_id: 'b1', type: 'temporary', from_pier: 'tublamu', to_pier: to, start_date: '2030-01-01', end_date: '2030-12-31',
    reason: null, cost: 0, cancelled: false, cancelled_at: null, cancelled_by: null, created_date: '2030-01-01', created_at: created, created_by: null }) as never;
  assert.equal(pierOn(boat, '2030-02-01', [a('x2', '2030-01-02T00:00:00Z', 'ranong'), a('x1', '2030-01-01T00:00:00Z', 'tublamu')]), 'tublamu', 'the oldest covering assignment wins (legacy array order)');
  assert.equal(dailyPier(boat, '2030-02-01', [a('x2', '2030-01-02T00:00:00Z', 'ranong')], true), 'tublamu', 'at the shop: home');
  const jobs = [{ boat_id: 'b1', status: 'inprogress', location: ' Honda Phuket ', boat_status: null, set_fixing: true }];
  assert.deepEqual([shopOf(jobs, 'b1', true), shopOf(jobs, 'b1', false), shopOf([{ ...jobs[0], boat_status: 'available' }], 'b1', true)], ['Honda Phuket', null, null]);
  assert.deepEqual(['ใบอนุญาตใช้เรือ', 'ใบอนุญาต สุรินทร์', 'ประกันภัยเรือ', 'ใบสำคัญรับรองการตรวจเรือ', 'ใบอนุญาต ธารโบกขรณี', 'Crew'].map(docType), ['lic', 'surin', 'ins', 'inspect', 'tarn', 'other']);
  const s = (days: number) => docStatus({ expires_on: addDays('2030-01-01', days), renew_status: null }, '2030-01-01').status;
  assert.deepEqual([s(-1), s(0), s(29), s(30), s(89), s(90)], ['exp', 'warn30', 'warn30', 'warn90', 'warn90', 'ok']);
  assert.equal(docStatus({ expires_on: null, renew_status: 'processing' }, '2030-01-01').status, 'processing');
  const prev = prevMeters([{ engine_id: 'e', date: '2030-01-01', reading: 10 }, { engine_id: 'e', date: '2030-01-02', reading: 0 }, { engine_id: 'e', date: '2030-01-03', reading: 15 }]);
  assert.deepEqual([prev('e', '2030-01-01'), prev('e', '2030-01-03'), prev('e', '2030-01-04'), prev('x', '2030-01-04')], [null, 10, 15, null], 'a 0 is a placeholder');
  const line = (price: number, item: string | null) => ({ qty: 1, price, item_id: item }) as never;
  assert.deepEqual([directShare({ lines: [] }), directShare({ lines: [line(300, null), line(100, 'i')] }), directShare({ lines: [line(0, 'i')] })], [1, 0.75, 0]);
});
