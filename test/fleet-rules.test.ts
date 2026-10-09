import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoTotals, type MemoLine } from '../src/domain/fleet-memos.js';
import { effectiveFuelPrice } from '../src/domain/fleet-daily.js';
import { safetyState } from '../src/domain/fleet-safety.js';
import { billGate, projectHealth, type Project } from '../src/domain/fleet-projects.js';
import { balances, pickByName, planWithdraw, type StockItem } from '../src/domain/fleet-stock.js';

// The pure rules of fleet part B, replayed against legacy where legacy has an answer.

const line = (qty: number, price: number, d: number | null = null): MemoLine => ({
  id: 'l', name: 'x', qty, price, discount_pct: d ?? 0, category: 'parts', part_no: null, unit: 'ชิ้น', item_id: null, from_inventory: false, received_qty: 0, snapshot: null,
});
/** Real legacy memos (2026-10-09), with the totals legacy stored: subtotal, discount, VAT, amount. */
const LEGACY = [
  { no: 'MO-037', vat: true, rate: 7, pct: 0, amt: 0, lines: [[1, 192, 10], [1, 216, 10], [4, 1817, 10], [8, 59, 10], [4, 641, 10], [4, 50, 10], [1, 1270, 10], [7, 103, 10], [4, 89, 10], [4, 1570, 10], [1, 1270, 10], [1, 103, 10], [2, 2488, 10]], want: [25888, 2588.8, 1630.94, 24930.14] },
  { no: 'MO-049', vat: false, rate: 0, pct: 0, amt: 140, lines: [[2, 173], [1, 118], [1, 108], [10, 10], [10, 83], [14, 88, 0], [1, 208]], want: [2942, 140, 0, 2802] },
  { no: 'MO-059', vat: false, rate: 0, pct: 0, amt: 2116, lines: [[4, 5290], [4, 0], [1, 0], [2, 0], [8, 198.75]], want: [22750, 2116, 0, 20634] },
  { no: 'MO-138', vat: true, rate: 7, pct: 0, amt: 18640, lines: [[1, 165000], [1, 35000], [1, 26000], [1, 48000], [1, 9000], [1, 7800], [1, 25000], [1, 57000]], want: [372800, 18640, 24791.2, 378951.2] },
  { no: 'MO-150', vat: false, rate: 0, pct: 0, amt: 0, lines: [[1, 4500], [1, 3500], [1, 3200], [1, 3200]], want: [14400, 0, 0, 14400] },
  { no: 'MO-151', vat: true, rate: 7, pct: 0, amt: 0, lines: [[4, 724], [4, 3650], [8, 39], [4, 20]], want: [17888, 0, 1252.16, 19140.16] },
] as const;

test('memo totals: legacy\'s stored totals, recomputed', () => {
  for (const m of LEGACY) {
    const t = memoTotals({ lines: m.lines.map(([q, p, d]) => line(q, p, d ?? null)), discount_pct: m.pct, discount_amt: m.amt, vat_enabled: m.vat, vat_rate: m.rate });
    assert.deepEqual([t.subtotal, t.discount, t.vat, t.amount], [...m.want], m.no);
  }
});

test('effective fuel price: boat, pier, a sibling at the pier, the last 30 days, else 0', () => {
  const boats = [{ id: 'b1', pier: 'panwa' }, { id: 'b2', pier: 'panwa' }, { id: 'b3', pier: 'tublamu' }];
  const prices = [{ date: '2026-09-01', key: 'b2', price: 40 }, { date: '2026-09-02', key: 'panwa', price: 41 }, { date: '2026-09-02', key: 'b1', price: 42 }];
  assert.deepEqual(effectiveFuelPrice(prices, boats[0], boats, '2026-09-02'), { price: 42, src: 'boat', from: '2026-09-02' });
  assert.deepEqual(effectiveFuelPrice(prices, boats[1], boats, '2026-09-02'), { price: 41, src: 'pier', from: '2026-09-02' });
  assert.deepEqual(effectiveFuelPrice(prices, boats[0], boats, '2026-09-01'), { price: 40, src: 'sib', from: '2026-09-01' });
  assert.deepEqual(effectiveFuelPrice(prices, boats[1], boats, '2026-10-01'), { price: 41, src: 'back', from: '2026-09-02' });
  assert.deepEqual(effectiveFuelPrice(prices, boats[1], boats, '2026-10-03'), { price: 0, src: '', from: '' }, 'more than 30 days back');
  assert.deepEqual(effectiveFuelPrice(prices, boats[2], boats, '2026-09-02'), { price: 0, src: '', from: '' }, 'another pier\'s price is not used');
});

test('safety state: the nearer of expiry and next PM', () => {
  const today = '2026-10-09';
  assert.equal(safetyState({ status: 'active', expiry_date: '2026-06-01', next_pm: null }, today).label, 'EXPIRED');
  assert.deepEqual(safetyState({ status: 'active', expiry_date: '2027-06-01', next_pm: '2026-10-30' }, today), { label: 'DUE', days: 21, type: 'pm' });
  assert.equal(safetyState({ status: 'active', expiry_date: '2026-12-01', next_pm: null }, today).label, 'SOON');
  assert.equal(safetyState({ status: 'active', expiry_date: null, next_pm: null }, today).label, 'OK_NO_PM');
  assert.equal(safetyState({ status: 'replaced', expiry_date: '2020-01-01', next_pm: null }, today).label, 'REPLACED');
});

test('project bill gate and health, as legacy computes them', () => {
  const doc = (name: string, type: 'photo' | null = null) => ({ id: 'd', name, attachment_id: null, url: null, mime: null, size: null, note: null, type, phase: null, status: 'pending', added_at: null, by: null });
  assert.deepEqual(billGate({ no_cost: null, documents: [doc('Final Invoice', 'photo')] }, 100).missing.length, 1, 'a photo named invoice is not the bill');
  assert.equal(billGate({ no_cost: null, documents: [doc('ใบวางบิล อู่')] }, 100).ok, true, 'a pending entry with no file passes, as legacy');
  assert.equal(billGate({ no_cost: { reason: 'warranty', by: null, at: '2026-10-09' }, documents: [] }, 0).ok, true);
  const p = { status: 'inprogress', planned_budget: 1000, plan_from: '2026-09-01', plan_to: '2026-09-11' } as Project;
  // Budget 150% → −40 (capped); 28 days over → −35 (capped); late with most jobs open → −15: 10.
  assert.deepEqual(projectHealth(p, 1500, { jobs: [{ id: 'j', cost: 1500, open: true }] }, '2026-10-09').score, 10);
  assert.equal(projectHealth({ ...p, status: 'on_hold' }, 0, { jobs: [] }, '2026-09-05').score, 90);
});

test('stock: legacy\'s name lookup, and a job part never goes below zero', () => {
  const item = (id: string, name: string, part_no: string | null, deleted = false): StockItem => ({
    id, name, part_no, category: null, supplier: null, unit: 'ชิ้น', min_qty: 0, cost: 0, note: null, created_from: null, created_date: null,
    created_at: '', created_by: null, updated_at: '', deleted_at: deleted ? 'x' : null, deleted_by: null, merged_into: null,
  });
  const items = [item('a', 'O-ring', 'P1'), item('b', 'o-ring ', 'P2'), item('c', 'Belt', null), item('d', 'Belt', null, true)];
  assert.equal(pickByName(items, 'O-RING', null), undefined, 'two of that name and no part number: no guess');
  assert.equal(pickByName(items, 'O-RING', 'P2')?.id, 'b');
  assert.equal(pickByName(items, 'belt', null)?.id, 'c', 'a deleted item is not picked');
  const moves = [{ warehouse: 'panwa', delta: 3 }, { warehouse: 'panwa', delta: -1 }, { warehouse: null, delta: 0 }];
  assert.deepEqual([...balances(moves)], [['panwa', 2]]);
  const ctx = { now: '2026-10-09T00:00:00.000Z', today: '2026-10-09', by: 'x' };
  const full = moves.map((m, i) => ({ id: `m${i}`, seq: i, item_id: 'a', date: '2026-10-09', type: 'receive' as const, note: null, by: null, memo_id: null, job_id: null, consumable_id: null, changes: null, created_at: '', created_by: null, ...m }));
  assert.throws(() => planWithdraw(items[0], full, { warehouse: 'panwa', qty: 3, job_id: 'mj1' }, ctx), /has only 2/);
  assert.equal(planWithdraw(items[0], full, { warehouse: 'panwa', qty: 2, job_id: 'mj1' }, ctx).delta, -2);
});
