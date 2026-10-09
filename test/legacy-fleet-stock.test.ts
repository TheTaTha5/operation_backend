import assert from 'node:assert/strict';
import { test } from 'node:test';
import { legacyWarehouse, mapDaily, mapMemos, mapProjects, mapSafety, mapStock } from '../src/tools/legacy-fleet-stock.js';

// The fleet import's mapping (src/tools/legacy-fleet-stock.ts), on rows shaped as legacy stores them.
const NOW = '2026-10-09T03:00:00.000Z';

test('the eight warehouse spellings map to the three', () => {
  for (const s of ['คลัง Visit Panwa', 'คลังVisit Panwa', 'คลัง VIsit Panwa', 'คลังVIsit Panwa', 'Visit Panwa', 'Visit panwa', 'Visit panda']) assert.equal(legacyWarehouse(s), 'panwa', s);
  assert.equal(legacyWarehouse('คลัง Tub La mu'), 'tublamu');
  assert.equal(legacyWarehouse('คลัง Ranong'), 'ranong');
  assert.equal(legacyWarehouse(''), null);
  assert.equal(legacyWarehouse('Somewhere'), null);
});

test('stock: history becomes movements; an import movement makes them add up to legacy\'s stock; receipts find their memo', () => {
  const out = mapStock({
    items: [{ id: 'i1', name: 'Oil', partno: '', unit: '', qty: 5, minqty: 2, cost: 100, location: 'คลังVisit Panwa', primarylocation: 'คลังVisit Panwa', createddate: '2026-05-01' }],
    stocks: [{ fleet_inventory_id: 'i1', location: 'คลังVisit Panwa', qty: 5 }],
    history: [
      { fleet_inventory_id: 'i1', idx: 0, row_pk: 'h:a', date: '2026-05-01', type: 'register', qty: 0 },
      { fleet_inventory_id: 'i1', idx: 1, row_pk: 'h:b', date: '2026-05-02', type: 'receive', qty: 4, location: '', note: 'จาก MO-001 · x' },
      { fleet_inventory_id: 'i1', idx: 2, row_pk: 'h:c', date: '2026-05-03', type: 'withdraw', qty: 1, location: 'Visit panda', jobid: 'mj1' },
      { fleet_inventory_id: 'i1', idx: 3, row_pk: 'h:d', date: '2026-05-04', type: 'edit', row: 1 },
    ],
    changes: [{ fleet_inventory_history_id: 'h:d', idx: 0, field: 'ชื่อรายการ', from: 'Oi', to: 'Oil' }],
    memoIdByNo: new Map([['MO-001', 'm1']]), consumableIds: new Set(),
  }, NOW, '2026-10-09');
  assert.equal(out.items[0].unit, 'ชิ้น');
  assert.deepEqual(out.movements.map((m) => [m.id, m.type, m.warehouse, m.delta, m.memo_id, m.job_id]), [
    ['lg_a', 'register', null, 0, null, null], ['lg_b', 'receive', 'panwa', 4, 'm1', null], ['lg_c', 'withdraw', 'panwa', -1, null, 'mj1'],
    ['lg_d', 'edit', null, 0, null, null], ['lg_import_i1_panwa', 'import', 'panwa', 2, null, null],
  ]);
  assert.deepEqual(out.movements[3].changes, [{ field: 'ชื่อรายการ', from: 'Oi', to: 'Oil' }]);
  assert.equal(out.notes['movements with no warehouse, given the item\'s main one'], 1);
  assert.equal(out.listed.filter((l) => l.kind === 'stock reconciled').length, 1);
});

test('memos: totals kept as stored, duplicates and odd totals listed; received lines count as received', () => {
  const memo = (id: string, no: string, extra: object = {}) => ({ id, no, title: 't', memotype: 'parts', status: 'received', currentstep: 4, createddate: '2026-05-01', vatenabled: true, vatrate: 7,
    discountpct: 0, discountamt: 0, subtotal: 100, discount: 0, afterdiscount: 100, vat: 7, amount: 107, boatid: 'b1', ...extra });
  const out = mapMemos({
    memos: [memo('m1', 'MO-077'), memo('m2', 'MO-077', { amount: 120, boatid: 'b-gone' }), memo('m3', 'MO-003', { status: 'weird' })],
    lines: [{ fleet_memos_id: 'm1', idx: 0, row_pk: 'l:1', name: 'x', qty: 1, price: 100, category: 'parts', invid: 'i-gone' },
      { fleet_memos_id: 'm2', idx: 0, row_pk: 'l:2', name: 'x', qty: 1, price: 100, category: 'parts' }],
    boats: new Set(['b1']), projects: new Set(), items: new Set(),
  }, NOW);
  assert.deepEqual(out.memos.map((m) => [m.id, m.amount, m.boat_id, m.lines[0].received_qty, m.lines[0].item_id]), [['m1', 107, 'b1', 1, null], ['m2', 120, null, 1, null]]);
  const kinds = out.listed.map((l) => `${l.kind}:${l.id}`);
  for (const k of ['duplicate memo number:MO-077', 'memo total:MO-077', 'memo:m3', 'memo:m2', 'memo line:MO-077 x']) assert.ok(kinds.includes(k), k);
});

test('projects: documents, plan and log come along; identical copies are listed', () => {
  const p = (id: string, no: string) => ({ id, no, name: 'Drydock', boatid: 'b7', type: 'drydock', vendor: 'Yard', planfrom: '2026-05-18', planto: '2026-05-24', status: 'completed', createdat: '2026-06-01',
    docs: JSON.stringify([{ id: 'ph_1', name: 'a.jpg', attId: 'att_1', mime: 'image/jpeg', size: 10, type: 'photo', status: 'received', addedAt: '2026-09-24', by: 'Admin.Pier' }]) });
  const out = mapProjects({ projects: [p('p1', 'PRJ-001'), p('p2', 'PRJ-002')], log: [{ fleet_projects_id: 'p1', idx: 0, date: '2026-06-01', text: '+ created', by: 'user' }],
    plan: [{ fleet_projects_id: 'p1', idx: 0, id: 'pl_1', text: 'paint', done: true, addedat: '2026-06-09', donedate: '2026-08-14' }], boats: new Set(['b7']), attachments: new Set(['att_1']) }, NOW);
  assert.equal(out.projects[0].documents[0].attachment_id, 'att_1');
  assert.equal(out.projects[0].plan[0].done_date, '2026-08-14');
  assert.equal(out.logs.length, 1);
  assert.ok(out.listed.some((l) => l.kind === 'project copies' && l.id === 'PRJ-001, PRJ-002'));
});

test('Daily Log: fuel 0 is no fuel, locks only where true, extras from app_meta', () => {
  const out = mapDaily({
    boatDays: [{ fleet_daily_id: '2026-10-07', key: 'b12', value: '{"fuel":518.1}' }, { fleet_daily_id: '2026-10-07', key: 'b13', value: '{"fuel":0}' }],
    trips: [{ fleet_daily_id: '2026-10-07', boat: 'b12', key: 'normal', value: '{"engines":{"e43":4013,"e44":null}}' }],
    prices: [{ key: '2026-10-07', value: '{"b13":41.18,"panwa":40}' }], locks: [{ key: '2026-06-05', value: '{"panwa":true}' }, { key: '2026-06-06', value: '{"panwa":false}' }],
    meta: {
      fl_issue_items: JSON.stringify(JSON.stringify([{ id: 'it1', name: 'น้ำ', unit: 'ลัง', pier: '' }])),
      fl_issue: JSON.stringify(JSON.stringify({ '2026-09-01|b13': { it1: 3, gone: 1 } })),
      fl_water: JSON.stringify(JSON.stringify({ '2026-09-01|b13': { o: 10, c: 20, by: '', at: '2026-09-05T07:39:20.975Z' } })),
      fl_req: JSON.stringify(JSON.stringify({ '2026-09-16|panwa': [{ id: 'rq1', name: 'HR', iss: { it1: 3 } }] })),
    },
    boats: new Set(['b12', 'b13']),
  }, NOW);
  assert.deepEqual(out.boats.map((b) => [b.boat_id, b.fuel_litres]), [['b12', 518.1]]);
  assert.deepEqual(out.meters.map((m) => m.engine_id), ['e43']);
  assert.equal(out.prices.length, 2);
  assert.deepEqual(out.locks.map((l) => l.date), ['2026-06-05']);
  assert.deepEqual(out.issues.map((i) => [i.item_id, i.qty]), [['it1', 3]]);
  assert.ok(out.listed.some((l) => l.kind === 'issued item'));
  assert.equal(out.water[0].close_reading, 20);
  assert.deepEqual(out.requests[0].issues, { it1: 3 });
});

test('safety: an inspection\'s by and note become inspector and findings', () => {
  const out = mapSafety({
    items: [{ id: 'sf1', boatid: 'b1', category: 'bilge_pump', name: 'Pump', qty: 1, installdate: '2024-06-01', status: 'active' }],
    inspections: [{ fleet_safety_id: 'sf1', idx: 0, id: 'insp1', date: '2026-05-19', result: 'pass', note: 'ok', by: 'ช่างแน็ค' }],
    log: [{ fleet_safety_id: 'sf1', idx: 0, date: '2024-06-01', type: 'install', desc: 'Initial installation' }], boats: new Set(['b1']),
  }, NOW);
  assert.deepEqual([out.items[0].inspections[0].inspector, out.items[0].inspections[0].findings], ['ช่างแน็ค', 'ok']);
  assert.equal(out.logs.length, 1);
});
