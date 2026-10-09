import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';

process.env.AUTH_JWT_SECRET = 'pier-cash-test-secret';
const { buildApp } = await import('../src/app.js');
const { OperationsStore } = await import('../src/domain/operations.js');
const { seedUser, testStore, tokenFor, blankAgent } = await import('./users-helper.js');
const { thaiBahtText, thaiDate } = await import('../src/domain/pier-cash.js');

// Pier petty cash (todo/pier-office-model.md), on whichever store DATABASE_URL selects. Only this file
// writes petty cash, at Ranong, in 2089–2091. A day's opening counts every earlier day, so each test
// takes a year before the previous test's: what an earlier test wrote is later, never counted.
const store = testStore();
if (store instanceof OperationsStore) store.seedAgents({ agents: [{ ...blankAgent('a_b2c', null), pay_type: 'cot' }] });
else {
  const { Pool } = await import('pg');
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  await db.query(`INSERT INTO agents (id, name, pay_type) VALUES ('a_b2c', 'a_b2c', 'cot') ON CONFLICT (id) DO NOTHING`);
  await db.end();
}
const app = buildApp({ store });
after(async () => app.close());
await seedUser(store, { username: 'pc-admin', role: 'admin' });
await seedUser(store, { username: 'pc-pier', edit_areas: ['pier'] });
await seedUser(store, { username: 'pc-ops', edit_areas: ['operations'] });
await seedUser(store, { username: 'pc-acct', edit_areas: ['accounting'] });
await seedUser(store, { username: 'pc-lk', agent_id: 'a_b2c' });
const admin = await tokenFor(app, 'pc-admin');
const pier = await tokenFor(app, 'pc-pier');
const ops = await tokenFor(app, 'pc-ops');
const acct = await tokenFor(app, 'pc-acct');
const lk = await tokenFor(app, 'pc-lk');
const send = (method: InjectOptions['method'], url: string, payload?: object, headers: Record<string, string> = pier) =>
  app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
const ok = async (method: InjectOptions['method'], url: string, payload?: object, headers?: Record<string, string>) => {
  const r = await send(method, url, payload, headers);
  assert.ok(r.statusCode < 300, `${method} ${url}: ${r.statusCode} ${r.body}`);
  return r.json();
};
const refused = async (method: InjectOptions['method'], url: string, payload: object | undefined, status: number, match?: RegExp | string) => {
  const r = await send(method, url, payload);
  assert.equal(r.statusCode, status, `${method} ${url} ${JSON.stringify(payload)}: ${r.body}`);
  if (typeof match === 'string') assert.equal(r.json().code, match);
  else if (match) assert.match(r.json().message, match);
};

// A Ranong route and two boats, one deployed on it.
const run = Date.now().toString(36);
const route = (await ok('POST', '/v1/routes', { name: `Petty cash test ${run}`, pier: 'ranong', family_id: null }, admin)).route;
const boatA = (await ok('POST', '/v1/boats', { name: `PC Alpha ${run}`, pier: 'ranong', capacity: 30 }, admin)).id as string;
const boatB = (await ok('POST', '/v1/boats', { name: `PC Bravo ${run}`, pier: 'ranong', capacity: 30 }, admin)).id as string;
for (const date of ['2091-03-10', '2091-03-11', '2090-05-02']) {
  await ok('POST', '/operations/deployments', { boat_id: boatA, route_id: route.id, service_date: date, capacity: 30, deploy_anyway: true }, admin);
}

test('the ledger carries the balance from day to day; untimed rows last; below 0 is a warning, not a refusal', async () => {
  const day = '/v1/pier-cash/ranong/days/2091-03-10';
  await ok('POST', `${day}/rows`, { kind: 'in', description: 'เบิกเงินสดจากบัญชี', amount: 5000, time: '08:00' });
  await ok('POST', `${day}/rows`, { kind: 'out', description: 'น้ำแข็ง 4 ถุง', amount: '1,200', time: '14:30' });
  await ok('POST', `${day}/rows`, { kind: 'out', description: 'ไม่ใส่เวลา', amount: 300 });
  const added = await ok('POST', `${day}/rows`, { kind: 'in', amount: 100.5, time: '14:30' }, ops);
  assert.equal(added.row.created_by, 'pc-ops');
  assert.match(added.row.id, /^pc_/);
  const d1 = await ok('GET', day);
  assert.deepEqual([d1.opening, d1.in, d1.out, d1.net, d1.closing, d1.negative], [0, 5100.5, 1500, 3600.5, 3600.5, false]);
  assert.deepEqual(d1.rows.map((r: { kind: string; time: string | null; balance: number }) => [r.kind, r.time, r.balance]),
    [['in', '08:00', 5000], ['in', '14:30', 5100.5], ['out', '14:30', 3900.5], ['out', null, 3600.5]], 'by time, in before out, untimed last');

  await ok('POST', '/v1/pier-cash/ranong/days/2091-03-11/rows', { kind: 'out', description: 'ค่า Taxi', amount: 4000, time: '09:00' });
  const d2 = await ok('GET', '/v1/pier-cash/ranong/days/2091-03-11');
  assert.deepEqual([d2.opening, d2.out, d2.closing, d2.negative], [3600.5, 4000, -399.5, true], 'yesterday\'s balance is today\'s opening; below 0 only warns');

  const month = await ok('GET', '/v1/pier-cash/ranong/months/2091-03');
  assert.deepEqual(month.days.map((x: { date: string; opening: number; closing: number }) => [x.date, x.opening, x.closing]),
    [['2091-03-10', 0, 3600.5], ['2091-03-11', 3600.5, -399.5]]);
  assert.deepEqual([month.opening, month.closing, month.totals.in, month.totals.out], [0, -399.5, 5100.5, 5500]);
  assert.deepEqual((await ok('GET', '/v1/pier-cash/ranong/months/2091-04')).opening, -399.5, 'the next month opens with the balance carried');

  // Refusals: the amount is validated, the source is the server's, the path is checked.
  await refused('POST', `${day}/rows`, { kind: 'out', amount: 0 }, 400, /amount must be a number above 0/);
  await refused('POST', `${day}/rows`, { kind: 'out', amount: -5 }, 400, /above 0/);
  await refused('POST', `${day}/rows`, { kind: 'out' }, 400, /amount is required/);
  await refused('POST', `${day}/rows`, { kind: 'out', amount: 12.345 }, 400, /2 decimals/);
  await refused('POST', `${day}/rows`, { kind: 'out', amount: 10, time: '25:00' }, 400, /HH:MM/);
  await refused('POST', `${day}/rows`, { kind: 'owe', amount: 10 }, 400, /in or out/);
  await refused('POST', `${day}/rows`, { kind: 'out', amount: 10, source: 'park' }, 400, /pull/);
  await refused('POST', `${day}/rows`, { kind: 'out', amount: 10, txt: 'x' }, 400, /no field txt/);
  await refused('POST', '/v1/pier-cash/phuket/days/2091-03-10/rows', { kind: 'out', amount: 10 }, 400, /pier must be one of/);
  await refused('POST', '/v1/pier-cash/ranong/days/2091-02-30/rows', { kind: 'out', amount: 10 }, 400, /YYYY-MM-DD/);
  await refused('GET', '/v1/pier-cash/ranong/months/2091-13', undefined, 400, /YYYY-MM/);

  // Rights: legacy's poCanEdit (pier, or operations); accounting reads only; Love Kingdom's login sees nothing.
  assert.equal((await send('POST', `${day}/rows`, { kind: 'out', amount: 1 }, acct)).statusCode, 403);
  assert.equal((await send('GET', day, undefined, acct)).statusCode, 200);
  assert.equal((await send('GET', day, undefined, lk)).statusCode, 403);

  // A delete keeps the row, out of every total; a second one is refused.
  const gone = await ok('DELETE', `/v1/pier-cash/rows/${added.row.id}?reason=typo`);
  assert.deepEqual([gone.row.delete_reason, gone.row.deleted_by, gone.day.in, gone.day.closing], ['typo', 'pc-pier', 5000, 3500]);
  await refused('DELETE', `/v1/pier-cash/rows/${added.row.id}`, undefined, 409, 'row_deleted');
  await refused('DELETE', '/v1/pier-cash/rows/pc_nope', undefined, 404);
  const withDeleted = await ok('GET', `${day}?deleted=true`);
  assert.deepEqual([withDeleted.rows.length, withDeleted.deleted.map((r: { id: string }) => r.id)], [3, [added.row.id]]);
  assert.equal((await ok('GET', '/v1/pier-cash/ranong/days/2091-03-11')).opening, 3500, 'the next day\'s opening follows');
});

test('the two sheets: cells the pier keys, computed totals refused, and pulling a day\'s totals into the ledger once', async () => {
  const date = '2090-05-02';
  const lt = (boat: string) => `/v1/pier-cash/ranong/days/${date}/longtail/${boat}`;
  const pk = (boat: string) => `/v1/pier-cash/ranong/days/${date}/park/${boat}`;
  const a = await ok('PATCH', lt(boatA), { join_boats: 3, charter_boats: 2, amount: 5000 });
  assert.deepEqual([a.cell.join_boats, a.cell.charter_boats, a.cell.used_boats, a.cell.amount, a.cell.updated_by], [3, 2, 5, 5000, 'pc-pier']);
  // Computed and validated fields: a wrong value is refused.
  await refused('PATCH', lt(boatA), { used_boats: 9 }, 400, /used_boats cannot be changed here/);
  await refused('PATCH', lt(boatA), { n: 9 }, 400, /n cannot be changed here/);
  await refused('PATCH', lt(boatA), { join_boats: -1 }, 400, /whole number/);
  await refused('PATCH', lt(boatA), { charter_boats: 1.5 }, 400, /whole number/);
  await refused('PATCH', lt(boatA), { amount: -1 }, 400, /0 or more/);
  await refused('PATCH', lt('b_nope'), { amount: 1 }, 404, /Boat b_nope not found/);
  assert.equal((await ok('PATCH', lt(boatA), { used_boats: 5, join_boats: 3 })).cell.used_boats, 5, 'an echoed computed value is accepted');
  // A note alone keeps a cell; clearing it removes the cell (legacy deletes an empty cell).
  assert.equal((await ok('PATCH', lt(boatB), { note: 'ลำเดียว' })).cell.note, 'ลำเดียว');
  assert.equal((await ok('PATCH', lt(boatB), { note: null })).cell, null);

  const p = await ok('PATCH', pk(boatA), { ad_th: 5, chd_th: 2, ad_fr: 57, amount: 17540, dock: 200, filled_from: 'nat' });
  assert.deepEqual([p.cell.heads, p.cell.amount, p.cell.dock, p.cell.filled_from, p.cell.inf_fr], [64, 17540, 200, 'nat', null]);
  await refused('PATCH', pk(boatA), { heads: 1 }, 400, /heads cannot be changed here/);
  await refused('PATCH', pk(boatA), { filled_from: 'guess' }, 400, /nat, price or null/);
  await refused('PATCH', pk(boatA), { ad_fr: 'many' }, 400, /whole number/);
  await ok('PATCH', pk(boatB), { dock: 100 });
  assert.equal((await ok('PATCH', pk(boatB), { dock: 0 })).cell, null, 'no head, no fee and no dock fee removes the cell');
  await ok('PATCH', pk(boatB), { ad_fr: 11, amount: 3400, dock: 100 });

  // The sheets list the deployed boat, and a boat that only has a cell.
  const sheet = await ok('GET', '/v1/pier-cash/ranong/months/2090-05/park');
  assert.equal(sheet.days.length, 1);
  assert.deepEqual(sheet.days[0].boats.map((b: { boat_id: string; route_id: string | null; cell: { heads: number } | null }) => [b.boat_id, b.route_id, b.cell?.heads]),
    [[boatA, route.id, 64], [boatB, null, 11]]);
  assert.deepEqual([sheet.totals.heads, sheet.totals.amount, sheet.totals.dock, sheet.totals.ad_fr], [75, 20940, 300, 68]);
  const lts = await ok('GET', `/v1/pier-cash/ranong/months/2090-05/longtail?date=${date}`);
  assert.deepEqual([lts.date, lts.days[0].boats.length, lts.totals.used_boats, lts.totals.amount], [date, 1, 5, 5000]);
  await refused('GET', '/v1/pier-cash/ranong/months/2090-05/longtail?date=2090-06-01', undefined, 400, /not in 2090-05/);

  // The ledger shows the sheets' figures as a reference until pulled.
  const before = await ok('GET', `/v1/pier-cash/ranong/days/${date}`);
  assert.deepEqual([before.out, before.reference, before.pulled, before.waiting], [0, { longtail: 5000, park: 20940, dock: 300, total: 26240 }, 0, 26240]);
  const pulled = await ok('POST', `/v1/pier-cash/ranong/days/${date}/pull`);
  assert.deepEqual(pulled.rows.map((r: { source: string; amount: number; description: string; kind: string }) => [r.source, r.kind, r.amount, r.description]), [
    ['longtail', 'out', 5000, 'ค่าเรือหางยาว (ดึงจากชีท)'], ['park', 'out', 20940, 'ค่าอุทยาน (ดึงจากชีท)'], ['dock', 'out', 300, 'ค่าจอดเรือ (ดึงจากชีท)'],
  ]);
  assert.deepEqual([pulled.day.out, pulled.day.pulled, pulled.day.waiting, pulled.day.closing], [26240, 26240, 0, -26240]);
  await refused('POST', `/v1/pier-cash/ranong/days/${date}/pull`, undefined, 409, 'nothing_to_pull');

  // A later change shows as waiting, but a category is pulled once (legacy); deleting the pulled row frees it.
  await ok('PATCH', lt(boatA), { amount: 6000 });
  const waiting = await ok('GET', `/v1/pier-cash/ranong/days/${date}`);
  assert.equal(waiting.waiting, 1000);
  await refused('POST', `/v1/pier-cash/ranong/days/${date}/pull`, undefined, 409, 'nothing_to_pull');
  const ltRow = pulled.rows.find((r: { source: string }) => r.source === 'longtail');
  await ok('DELETE', `/v1/pier-cash/rows/${ltRow.id}`);
  const again = await ok('POST', `/v1/pier-cash/ranong/days/${date}/pull`);
  assert.deepEqual(again.rows.map((r: { source: string; amount: number }) => [r.source, r.amount]), [['longtail', 6000]]);

  const month = await ok('GET', '/v1/pier-cash/ranong/months/2090-05');
  assert.deepEqual(month.days.map((x: { date: string; reference: { total: number }; waiting: number }) => [x.date, x.reference.total, x.waiting]), [[date, 27240, 0]]);
});

test('the receipt-substitute certificate: the day\'s out rows, or the ones picked, in Thai words; it needs the company name', async () => {
  const day = '/v1/pier-cash/ranong/days/2089-06-15';
  const r1 = (await ok('POST', `${day}/rows`, { kind: 'out', description: 'ค่า Taxi', amount: 1200, time: '09:00' })).row;
  await ok('POST', `${day}/rows`, { kind: 'out', description: 'น้ำดื่ม', amount: 21.5, time: '10:00' });
  await ok('POST', `${day}/rows`, { kind: 'in', description: 'เบิก', amount: 5000, time: '07:00' });
  await ok('PUT', '/v1/pier-cash/settings', { company_name: null });
  await refused('GET', `${day}/certificate`, undefined, 409, 'company_name_missing');
  assert.equal((await send('PUT', '/v1/pier-cash/settings', { company_name: 'x' }, acct)).statusCode, 403);
  await refused('PUT', '/v1/pier-cash/settings', { company: 'x' }, 400, /no field company/);
  assert.equal((await ok('PUT', '/v1/pier-cash/settings', { company_name: ' เลิฟ ไอแลนด์ ' })).company_name, 'เลิฟ ไอแลนด์');
  assert.equal((await ok('GET', '/v1/pier-cash/settings')).company_name, 'เลิฟ ไอแลนด์');

  const cert = await ok('GET', `${day}/certificate`);
  assert.deepEqual([cert.company_name, cert.date_th, cert.rows.length, cert.total, cert.total_text_th, cert.selected],
    ['เลิฟ ไอแลนด์', '15/06/2632', 2, 1221.5, 'หนึ่งพันสองร้อยยี่สิบเอ็ดบาทห้าสิบสตางค์', false]);
  const one = await ok('GET', `${day}/certificate?ids=${r1.id}`);
  assert.deepEqual([one.rows.map((r: { id: string }) => r.id), one.total_text_th, one.selected], [[r1.id], 'หนึ่งพันสองร้อยบาทถ้วน', true]);
  await refused('GET', `${day}/certificate?ids=pc_nope`, undefined, 400, /No rows selected/);
});

test('Thai baht words and Buddhist-era dates, as legacy prints them', () => {
  assert.equal(thaiBahtText(0), 'ศูนย์บาทถ้วน');
  assert.equal(thaiBahtText(11), 'สิบเอ็ดบาทถ้วน');
  assert.equal(thaiBahtText(21), 'ยี่สิบเอ็ดบาทถ้วน');
  assert.equal(thaiBahtText(101), 'หนึ่งร้อยเอ็ดบาทถ้วน');
  assert.equal(thaiBahtText(158978), 'หนึ่งแสนห้าหมื่นแปดพันเก้าร้อยเจ็ดสิบแปดบาทถ้วน');
  assert.equal(thaiBahtText(1000001), 'หนึ่งล้านหนึ่งบาทถ้วน', 'legacy: the group after ล้าน starts afresh');
  assert.equal(thaiBahtText(2500000), 'สองล้านห้าแสนบาทถ้วน');
  assert.equal(thaiBahtText(0.25), 'ยี่สิบห้าสตางค์');
  assert.equal(thaiDate('2026-10-09'), '09/10/2569');
});

test('a petty cash write is announced on the change feed', async () => {
  const v = (await ok('GET', '/v1/changes')).version;
  await ok('POST', '/v1/pier-cash/ranong/days/2088-01-05/rows', { kind: 'in', amount: 10 });
  await ok('PUT', '/v1/pier-cash/settings', { company_name: 'เลิฟ ไอแลนด์' });
  const changes = (await ok('GET', `/v1/changes?since=${v}`)).changes as { kind: string; entity_id: string }[];
  const mine = changes.filter((c) => c.kind === 'pier_cash').map((c) => c.entity_id);
  assert.ok(mine.includes('ranong:2088-01-05'), JSON.stringify(changes));
  assert.ok(mine.includes('settings'));
});
