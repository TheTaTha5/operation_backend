import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapLegacyPierOffice, type LegacyPierOffice } from '../src/tools/legacy-pier-office.js';

// How legacy's petty cash and Pier Office lists become rows (src/tools/legacy-pier-office.ts), on rows
// shaped as the legacy tables hold them.
const report = () => {
  const skipped: string[] = [], notes: string[] = [];
  return { skipped, notes, skip: (kind: string, id: string, reason: string) => skipped.push(`${kind} ${id}: ${reason}`), note: (what: string) => notes.push(what) };
};
const none: LegacyPierOffice = { cashRows: [], longtail: [], park: [], company: null, kinds: [], items: [], codes: [], sections: [], staff: [], licenseTypes: [], licenseClasses: [] };
const ctx = { boats: new Set(['b12', 'b13']), now: '2026-10-10T00:00:00.000Z' };

test('ledger rows: ids kept, txt/at/src renamed, a one-digit hour padded, a row with no amount above 0 skipped', () => {
  const r = report();
  const row = (id: string, extra: Record<string, unknown>) => ({ id, pier: 'panwa', date: '2026-10-08', kind: 'out', txt: 'ค่า Taxi', amt: '1200', at: '14:35', by: 'GSA.PK02',
    ts: '2026-10-08T07:36:11.188Z', src: '', ...extra });
  const out = mapLegacyPierOffice({ ...none, cashRows: [
    row('pc1', {}), row('pc2', { kind: 'in', txt: '', at: '7:48', ts: '' }), row('pc3', { src: 'pk' }), row('pc4', { amt: '0' }), row('pc5', { pier: 'phuket' }),
    row('pc6', { date: '2026-02-30' }), row('pc1', {}), row('pc7', { src: 'pk', ts: '2026-10-08T09:00:00.000Z' }), row('pc8', { kind: 'in', src: 'lt' }),
  ] }, ctx, r);
  assert.deepEqual(out.rows.map((x) => [x.id, x.kind, x.description, x.amount, x.time, x.source, x.created_by, x.created_at]), [
    ['pc1', 'out', 'ค่า Taxi', 1200, '14:35', null, 'GSA.PK02', '2026-10-08T07:36:11.188Z'],
    ['pc2', 'in', null, 1200, '07:48', null, 'GSA.PK02', ctx.now],
    ['pc3', 'out', 'ค่า Taxi', 1200, '14:35', 'park', 'GSA.PK02', '2026-10-08T07:36:11.188Z'],
    ['pc7', 'out', 'ค่า Taxi', 1200, '14:35', null, 'GSA.PK02', '2026-10-08T09:00:00.000Z'],
    ['pc8', 'in', 'ค่า Taxi', 1200, '14:35', null, 'GSA.PK02', '2026-10-08T07:36:11.188Z'],
  ]);
  assert.deepEqual(r.skipped, ['petty cash row pc4: amount 0', 'petty cash row pc5: pier "phuket"', 'petty cash row pc6: date "2026-02-30"', 'petty cash row pc1: id repeated']);
  assert.ok(r.notes.includes('pulled rows repeated on a day, kept as typed rows'), 'a category pulled twice is kept once');
  assert.ok(r.notes.includes('petty cash rows with no time stamp, stamped with the import time'));
});

test('sheet cells: a boat not in the catalogue is skipped, an empty cell dropped, the company name unquoted', () => {
  const r = report();
  const out = mapLegacyPierOffice({ ...none, company: '"เลิฟ ไอแลนด์"',
    longtail: [
      { id: 'panwa|2026-10-09|b12', pier: 'panwa', date: '2026-10-09', bid: 'b12', n: 5, nj: 3, nc: 2, amt: null, note: '', by: 'GSA.PK02', ts: '2026-10-09T09:06:51.597Z' },
      { pier: 'panwa', date: '2026-10-09', bid: 'b99', nj: 1, amt: 1000 },
      { pier: 'panwa', date: '2026-10-09', bid: 'b13', n: null, nj: null, nc: null, amt: null, note: '' },
    ],
    park: [
      { pier: 'panwa', date: '2026-10-08', bid: 'b12', ad_th: 5, chd_th: 2, inf_th: null, foc_th: null, ad_fr: 57, chd_fr: null, inf_fr: null, foc_fr: null, amt: 17540, dock: 200,
        by: 'GSA.PK01', ts: '2026-10-09T04:35:40.353Z', src: '' },
      { pier: 'panwa', date: '2026-10-08', bid: 'b13', ad_fr: 11, amt: 3400, dock: 100, src: 'nat' },
    ] }, ctx, r);
  assert.deepEqual(out.longtail.map((c) => [c.boat_id, c.join_boats, c.charter_boats, c.amount, c.note]), [['b12', 3, 2, null, null]]);
  assert.deepEqual(out.park.map((c) => [c.boat_id, c.ad_th, c.chd_th, c.ad_fr, c.inf_fr, c.amount, c.dock, c.filled_from]),
    [['b12', 5, 2, 57, null, 17540, 200, null], ['b13', null, null, 11, null, 3400, 100, 'nat']]);
  assert.equal(out.companyName, 'เลิฟ ไอแลนด์');
  assert.deepEqual(r.skipped, ['longtail cell panwa|2026-10-09|b99: boat b99 is not in the catalogue']);
  assert.ok(r.notes.includes('empty longtail cells dropped'));
});

test('the lists: references checked, staff with no order placed after the ordered ones in row order', () => {
  const r = report();
  const out = mapLegacyPierOffice({ ...none,
    kinds: [{ id: 'fin', name: 'ตีนกบ', unit: 'คู่', color: '#8c00ff', ord: 1, active: true, name_en: 'FINS' }, { id: 'pk_1', name: 'แพยาง', unit: 'อัน', color: 'pink', ord: null, active: null, name_en: null }],
    items: [{ id: 'pi_1', pier: 'panwa', kind: 'fin', label: 'S', total: 20, active: false, note: '' }, { id: 'pi_2', pier: 'panwa', kind: 'gone', label: 'x', total: 1 }],
    codes: [{ id: 'c_pp', code: 'PP', label: 'ทำงาน', color: '#20477E', bg: '#E9EFF7', kind: 'work', ord: 1, active: true },
      { id: 'c_n', code: 'N', label: 'เวรกลางคืน', color: '#FFFFFF', bg: '#1F2937', kind: 'night', ord: 12, active: true },
      { id: 'c_x', code: 'pp', label: '', color: '', bg: '', kind: 'odd', ord: 13 }],
    sections: [{ id: 'sc_1', pier: 'panwa', name: 'office', ord: 1 }],
    staff: [
      { id: 'ps_1', pier: 'panwa', nick: 'รัก', name: 'นางสาวนฤมน', role: 'Manager', phone: '', active: true, defcode: 'se', sect: 'sc_1', note: null, ord: 2 },
      { id: 'ps_2', pier: 'panwa', nick: '', name: 'นายสมชาย', active: false, sect: 'sc_x', ord: null },
      { id: 'ps_3', pier: 'tublamu', nick: 'เอ', name: '', ord: null },
      { id: 'ps_4', pier: 'tublamu', nick: 'บี', name: 'บี', ord: null },
    ],
    licenseTypes: [{ id: 'deck', side: 'deck', short: 'ใบกัปตัน', formal: 'x', perboat: 1, active: true }],
    licenseClasses: [{ id: 'deck1', typeid: 'deck', name: 'ชั้นหนึ่ง', maxgt: 500, maxbhp: null, ord: 1 }, { id: 'eng1', typeid: 'eng', name: 'ชั้นหนึ่ง', maxgt: null, maxbhp: 3000, ord: 1 }],
  }, ctx, r);
  const L = out.lists;
  assert.deepEqual(L['item-kinds'].map((k) => [k.id, k.color, k.sort, k.active]), [['fin', '#8c00ff', 1, true], ['pk_1', '#5F6C7B', 2, true]]);
  assert.deepEqual(L.items.map((i) => [i.id, i.active, i.note]), [['pi_1', false, null]]);
  assert.deepEqual(L['attendance-codes'].map((c) => [c.id, c.kind, c.bg]), [['c_pp', 'work', '#E9EFF7'], ['c_n', 'night', '#1F2937']]);
  assert.deepEqual(L.staff.map((s) => [s.id, s.nick, s.name, s.default_code, s.section_id, s.sort, s.active]), [
    ['ps_1', 'รัก', 'นางสาวนฤมน', 'SE', 'sc_1', 2, true], ['ps_2', 'นายสมชาย', 'นายสมชาย', null, null, 3, false],
    ['ps_3', 'เอ', 'เอ', null, null, 1, true], ['ps_4', 'บี', 'บี', null, null, 2, true],
  ]);
  assert.deepEqual(L['license-classes'].map((c) => c.id), ['deck1']);
  assert.deepEqual(r.skipped, ['item pi_2: kind gone is not a kind', 'roster code c_x: code pp repeated', 'licence class eng1: type eng is not a licence type']);
  assert.ok(r.notes.includes('staff in a group missing or of another pier, left unassigned'));
});
