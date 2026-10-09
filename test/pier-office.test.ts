import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';

process.env.AUTH_JWT_SECRET = 'pier-office-test-secret';
const { buildApp } = await import('../src/app.js');
const { OperationsStore } = await import('../src/domain/operations.js');
const { seedUser, testStore, tokenFor, blankAgent } = await import('./users-helper.js');
const { tint } = await import('../src/domain/pier-office.js');

// The Pier Office lists (todo/pier-office-model.md), on whichever store DATABASE_URL selects. Only
// this file touches them; its tests run in order, the first reading migration 171's seeds.
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
await seedUser(store, { username: 'po-pier', edit_areas: ['pier'] });
await seedUser(store, { username: 'po-ops', edit_areas: ['operations'] });
await seedUser(store, { username: 'po-acct', edit_areas: ['accounting'] });
await seedUser(store, { username: 'po-lk', agent_id: 'a_b2c' });
const pier = await tokenFor(app, 'po-pier');
const ops = await tokenFor(app, 'po-ops');
const acct = await tokenFor(app, 'po-acct');
const lk = await tokenFor(app, 'po-lk');
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
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

test('a fresh system starts from legacy\'s seeds', async () => {
  const lists = await ok('GET', '/v1/pier-office');
  assert.deepEqual(ids(lists.item_kinds), ['fin', 'mask', 'towel']);
  assert.equal(lists.attendance_codes.length, 11);
  assert.deepEqual(ids(lists.license_types), ['deck', 'eng']);
  assert.deepEqual(lists.license_classes.map((c: { id: string; max_gt: number | null; max_bhp: number | null }) => [c.id, c.max_gt, c.max_bhp]),
    [['deck1', 500, null], ['deck2', 60, null], ['eng1', null, 3000], ['eng2', null, 1000]]);
  assert.deepEqual([lists.items, lists.sections, lists.staff], [[], [], []]);
  assert.equal((await send('GET', '/v1/pier-office', undefined, acct)).statusCode, 200, 'any staff login reads');
  assert.equal((await send('GET', '/v1/pier-office', undefined, lk)).statusCode, 403, 'an agent\'s login does not');
});

test('equipment kinds and items: a label and a kind, a kind in use is not deleted, items are switched off', async () => {
  const blank = await ok('POST', '/v1/pier-office/item-kinds', {});
  assert.deepEqual([blank.name, blank.unit, blank.color, blank.sort, blank.active], ['', 'ชิ้น', '#5F6C7B', 4, true], 'legacy adds a blank kind last');
  assert.match(blank.id, /^pk_/);
  const vest = await ok('PATCH', `/v1/pier-office/item-kinds/${blank.id}`, { name: 'เสื้อชูชีพ', name_en: 'Life Jacket', unit: 'ตัว', color: '#ff8800' }, ops);
  assert.deepEqual([vest.name, vest.name_en, vest.unit], ['เสื้อชูชีพ', 'Life Jacket', 'ตัว']);
  await refused('PATCH', `/v1/pier-office/item-kinds/${blank.id}`, { name: 'x'.repeat(41) }, 400, /at most 40/);
  await refused('PATCH', `/v1/pier-office/item-kinds/${blank.id}`, { color: 'orange' }, 400, /colour/);
  await refused('PATCH', `/v1/pier-office/item-kinds/${blank.id}`, { sort: 1 }, 400, /item-kinds\/order/);
  await refused('POST', '/v1/pier-office/item-kinds', { id: 'mine' }, 400, /assigned by the server/);

  await refused('POST', '/v1/pier-office/items', { pier: 'panwa', kind_id: 'fin' }, 400, /label is required/);
  await refused('POST', '/v1/pier-office/items', { pier: 'panwa', kind_id: 'nope', label: 'x' }, 400, /kind_id must be an item kind/);
  await refused('POST', '/v1/pier-office/items', { pier: 'phuket', kind_id: 'fin', label: 'x' }, 400, /pier must be one of/);
  await refused('POST', '/v1/pier-office/items', { pier: 'panwa', kind_id: 'fin', label: 'x', total: -1 }, 400, /whole number/);
  const item = await ok('POST', '/v1/pier-office/items', { pier: 'panwa', kind_id: blank.id, label: 'S เด็ก', total: '48' });
  assert.deepEqual([item.total, item.active, item.note], [48, true, null]);
  await refused('PATCH', `/v1/pier-office/items/${item.id}`, { label: '  ' }, 400, /label cannot be blank/);
  assert.equal((await ok('PATCH', `/v1/pier-office/items/${item.id}`, { active: false })).active, false);
  await refused('DELETE', `/v1/pier-office/items/${item.id}`, undefined, 405, /switch one off/);
  await refused('DELETE', `/v1/pier-office/item-kinds/${blank.id}`, undefined, 409, 'kind_in_use');
  await ok('POST', '/v1/pier-office/items', { pier: 'tublamu', kind_id: 'fin', label: 'ตีนกบ · M (39-41)', total: 40 });
  assert.deepEqual((await ok('GET', '/v1/pier-office?pier=panwa')).items.map((i: { label: string }) => i.label), ['S เด็ก'], 'narrowed to a pier');

  // Order: every kind once.
  await refused('POST', '/v1/pier-office/item-kinds/order', { ids: ['fin', 'mask'] }, 400, /every one of item-kinds/);
  const order = await ok('POST', '/v1/pier-office/item-kinds/order', { ids: ['towel', blank.id, 'fin', 'mask'] });
  assert.deepEqual(ids(order.item_kinds), ['towel', blank.id, 'fin', 'mask']);
  await refused('POST', '/v1/pier-office/items/order', { ids: [] }, 405);
  // A kind with no items goes.
  const spare = await ok('POST', '/v1/pier-office/item-kinds', { name: 'แพยาง' });
  assert.deepEqual(await ok('DELETE', `/v1/pier-office/item-kinds/${spare.id}`), { deleted: spare.id, unassigned: [] });
});

test('roster codes: unique, their tint follows the colour; groups and staff', async () => {
  await refused('POST', '/v1/pier-office/attendance-codes', { code: 'pp' }, 409, 'code_taken');
  const ov = await ok('POST', '/v1/pier-office/attendance-codes', { code: 'OV', label: 'ค้างเกาะ', color: '#ff9300', kind: 'work' });
  assert.deepEqual([ov.bg, ov.sort], ['#fff4e6', 12], 'legacy paTint, as legacy\'s own OV row');
  await refused('PATCH', `/v1/pier-office/attendance-codes/${ov.id}`, { bg: '#000000' }, 400, /bg cannot be changed here/);
  assert.equal((await ok('PATCH', `/v1/pier-office/attendance-codes/${ov.id}`, { color: '#1F2937' })).bg, tint('#1F2937'));
  await refused('PATCH', `/v1/pier-office/attendance-codes/${ov.id}`, { kind: 'holiday' }, 400, /kind must be one of/);
  assert.equal((await ok('PATCH', `/v1/pier-office/attendance-codes/${ov.id}`, { kind: 'night' })).kind, 'night');
  await refused('PATCH', `/v1/pier-office/attendance-codes/${ov.id}`, { code: 'se' }, 409, 'code_taken');
  assert.deepEqual(await ok('DELETE', `/v1/pier-office/attendance-codes/${ov.id}`), { deleted: ov.id, unassigned: [] });

  const office = await ok('POST', '/v1/pier-office/sections', { pier: 'panwa', name: 'office' });
  const crew = await ok('POST', '/v1/pier-office/sections', { pier: 'panwa', name: 'CREW' });
  const tl = await ok('POST', '/v1/pier-office/sections', { pier: 'tublamu', name: 'TL' });
  assert.deepEqual([office.sort, crew.sort, tl.sort], [1, 2, 1], 'groups are ordered per pier');

  await refused('POST', '/v1/pier-office/staff', { pier: 'panwa' }, 400, /nick or name is required/);
  await refused('POST', '/v1/pier-office/staff', { pier: 'panwa', nick: 'x', section_id: tl.id }, 400, /tublamu's, not panwa's/);
  const rak = await ok('POST', '/v1/pier-office/staff', { pier: 'panwa', name: 'นางสาวนฤมน', role: 'Phuket Pier Manager', default_code: 'se', section_id: office.id });
  assert.deepEqual([rak.nick, rak.name, rak.default_code, rak.sort, rak.active], ['นางสาวนฤมน', 'นางสาวนฤมน', 'SE', 1, true], 'the nick copies the name; the code upper-cased');
  const sara = await ok('POST', '/v1/pier-office/staff', { pier: 'panwa', nick: 'ซาร่า', section_id: office.id });
  const ton = await ok('POST', '/v1/pier-office/staff', { pier: 'panwa', nick: 'ต้น', section_id: crew.id });
  assert.deepEqual([sara.sort, ton.sort], [2, 3]);
  await refused('PATCH', `/v1/pier-office/staff/${ton.id}`, { nick: '', name: '' }, 400, /nick or name/);
  await refused('PATCH', `/v1/pier-office/staff/${ton.id}`, { sort: 1 }, 400, /staff\/order/);
  // Into another group: last in it (legacy paStaffSect).
  const moved = await ok('PATCH', `/v1/pier-office/staff/${rak.id}`, { section_id: crew.id });
  assert.equal(moved.sort, 4);
  // Order: every one of the pier's staff once.
  await refused('POST', '/v1/pier-office/staff/order', { pier: 'panwa', ids: [rak.id] }, 400, /every one of panwa's staff/);
  const order = await ok('POST', '/v1/pier-office/staff/order', { pier: 'panwa', ids: [sara.id, rak.id, ton.id] });
  assert.deepEqual(order.staff.map((s: { id: string; sort: number }) => [s.id, s.sort]), [[sara.id, 1], [rak.id, 2], [ton.id, 3]]);
  // Another pier: the group goes, unless one of that pier is named.
  const away = await ok('PATCH', `/v1/pier-office/staff/${ton.id}`, { pier: 'tublamu' });
  assert.deepEqual([away.pier, away.section_id], ['tublamu', null]);

  // A group with people is deleted only when told to leave them unassigned (legacy's confirm).
  await refused('DELETE', `/v1/pier-office/sections/${crew.id}`, undefined, 409, 'section_in_use');
  const gone = await ok('DELETE', `/v1/pier-office/sections/${crew.id}?unassign_anyway=true`);
  assert.deepEqual(gone, { deleted: crew.id, unassigned: [rak.id] });
  const staff = (await ok('GET', '/v1/pier-office?pier=panwa')).staff as { id: string; section_id: string | null }[];
  assert.equal(staff.find((s) => s.id === rak.id)!.section_id, null);
  await refused('DELETE', `/v1/pier-office/staff/${rak.id}`, undefined, 405);
  await refused('PATCH', '/v1/pier-office/staff/ps_nope', { note: 'x' }, 404);
  await refused('PATCH', '/v1/pier-office/rosters/x', { note: 'x' }, 404, /No such list/);
});

test('licence types are edited, not added; classes carry the largest boat they allow', async () => {
  await refused('POST', '/v1/pier-office/license-types', { side: 'deck', short: 'x' }, 405);
  assert.equal((await ok('PATCH', '/v1/pier-office/license-types/deck', { per_boat: 2, formal: 'ประกาศนียบัตรนายท้ายเรือ' })).per_boat, 2);
  await refused('PATCH', '/v1/pier-office/license-types/deck', { side: 'eng' }, 400, /side cannot be changed here/);
  await refused('PATCH', '/v1/pier-office/license-types/deck', { per_boat: -1 }, 400, /whole number/);
  await refused('POST', '/v1/pier-office/license-classes', { type_id: 'pilot' }, 400, /type_id must be a licence type/);
  const third = await ok('POST', '/v1/pier-office/license-classes', { type_id: 'deck' });
  assert.deepEqual([third.name, third.max_gt, third.max_bhp, third.sort], ['ชั้นใหม่', null, null, 3]);
  await refused('PATCH', `/v1/pier-office/license-classes/${third.id}`, { max_gt: -5 }, 400, /no limit/);
  await refused('PATCH', `/v1/pier-office/license-classes/${third.id}`, { type_id: 'eng' }, 400, /type_id cannot be changed here/);
  assert.equal((await ok('PATCH', `/v1/pier-office/license-classes/${third.id}`, { max_gt: '30.5', name: 'ชั้นสาม' })).max_gt, 30.5);
  const listed = (await ok('GET', '/v1/pier-office')).license_classes.find((c: { id: string }) => c.id === third.id);
  assert.deepEqual([listed.max_gt, listed.name], [30.5, 'ชั้นสาม'], 'as stored');
  await ok('DELETE', `/v1/pier-office/license-classes/${third.id}`);
});

test('who may change the lists: pier or operations, as legacy\'s poCanEdit', async () => {
  assert.equal((await send('POST', '/v1/pier-office/sections', { pier: 'ranong', name: 'x' }, acct)).statusCode, 403);
  assert.equal((await send('POST', '/v1/pier-office/sections', { pier: 'ranong', name: 'x' }, lk)).statusCode, 403);
  assert.equal((await send('POST', '/v1/pier-office/sections', { pier: 'ranong', name: 'x' }, ops)).statusCode, 201);
  const v = (await ok('GET', '/v1/changes')).version;
  await ok('POST', '/v1/pier-office/sections', { pier: 'ranong', name: 'y' });
  const changes = (await ok('GET', `/v1/changes?since=${v}`)).changes as { kind: string; entity_id: string }[];
  assert.ok(changes.some((c) => c.kind === 'pier_office' && c.entity_id === 'sections'), JSON.stringify(changes));
});
