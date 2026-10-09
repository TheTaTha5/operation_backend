import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { InjectOptions } from 'fastify';

// Fleet maintenance, part B (todo/fleet-maintenance-model.md, "Design — part B") through the API, on
// whichever store DATABASE_URL selects, with logins on: who may write is part of the contract. Every
// computed or validated field is sent a wrong value somewhere below.
process.env.AUTH_JWT_SECRET = 'fleet-part-b-test-secret';
const { buildApp } = await import('../src/app.js');
const { seedUser, testStore, tokenFor } = await import('./users-helper.js');
const store = testStore();
const app = buildApp({ store });
after(async () => app.close());

type Headers = { authorization: string };
const run = Date.now().toString(36);
/** A year no other run of this file uses, so the Daily Log's day locks and prices start empty on a reused database. */
const Y = 2200 + Math.floor(Math.random() * 700);
const call = (headers: Headers, method: InjectOptions['method'], url: string, payload?: object) => app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
const ok = (res: { statusCode: number; body: string }, status = 200) => { assert.equal(res.statusCode, status, res.body); return JSON.parse(res.body || 'null'); };
const refused = (res: { statusCode: number; body: string }, status: number, code?: string) => {
  assert.equal(res.statusCode, status, res.body);
  if (code) assert.equal(JSON.parse(res.body).code, code, res.body);
  return JSON.parse(res.body);
};
const as = async (username: string, fields: object = {}): Promise<Headers> => { await seedUser(store, { username, ...fields }); return tokenFor(app, username); };

let admin: Headers; let fleet: Headers; let ops: Headers; let sales: Headers;
let panwaBoat = ''; let panwaBoat2 = ''; let tublamuBoat = '';
before(async () => {
  admin = await as(`fl.admin.${run}`, { role: 'admin' });
  fleet = await as(`fl.fleet.${run}`, { edit_areas: ['fleet'] });
  ops = await as(`fl.ops.${run}`, { edit_areas: ['operations'] });
  sales = await as(`fl.sales.${run}`, { edit_areas: ['sales'] });
  panwaBoat = ok(await call(admin, 'POST', '/v1/boats', { name: `Fleet P ${run}`, pier: 'panwa' }), 201).id;
  panwaBoat2 = ok(await call(admin, 'POST', '/v1/boats', { name: `Fleet P2 ${run}`, pier: 'panwa' }), 201).id;
  tublamuBoat = ok(await call(admin, 'POST', '/v1/boats', { name: `Fleet T ${run}`, pier: 'tublamu' }), 201).id;
});

const qtyAt = (item: { stocks: { warehouse: string; qty: number }[] }, w: string) => item.stocks.find((s) => s.warehouse === w)?.qty ?? 0;

test('stock: create, receive, transfer, adjust, edit, merge and delete; quantities come only from movements', async () => {
  refused(await call(sales, 'POST', '/v1/fleet/stock-items', { name: 'x' }), 403);
  const filter = ok(await call(fleet, 'POST', '/v1/fleet/stock-items', { name: `Oil filter ${run}`, partNo: `PN-${run}`, qty: 5, warehouse: 'คลัง Visit Panwa', cost: 120, minQty: 2 }), 201);
  assert.equal(filter.total_qty, 5);
  assert.equal(qtyAt(filter, 'panwa'), 5, 'legacy\'s label names the warehouse');
  assert.equal(filter.primary_warehouse, 'panwa');
  assert.equal(filter.below_min, false);
  assert.equal(filter.movements[0].type, 'register');

  refused(await call(fleet, 'POST', '/v1/fleet/stock-items', { name: ` oil FILTER ${run} `.replace('FILTER', 'filter'), part_no: `pn-${run}` }), 409, 'stock_item_exists');
  refused(await call(fleet, 'POST', '/v1/fleet/stock-items', { name: `Oil filter ${run}` }), 409, 'part_no_required');
  refused(await call(fleet, 'POST', '/v1/fleet/stock-items', { name: `Gasket ${run}`, qty: 3 }), 400);
  refused(await call(fleet, 'POST', '/v1/fleet/stock-items', { name: `Gasket ${run}`, qty: 3, warehouse: 'Visit panda' }), 400);

  let item = ok(await call(fleet, 'POST', `/v1/fleet/stock-items/${filter.id}/receive`, { warehouse: 'tublamu', qty: 4, note: 'hand' }));
  assert.equal(item.total_qty, 9);
  refused(await call(fleet, 'POST', `/v1/fleet/stock-items/${filter.id}/receive`, { warehouse: 'tublamu', qty: 0 }), 400);
  refused(await call(fleet, 'POST', `/v1/fleet/stock-items/${filter.id}/transfer`, { from: 'panwa', to: 'panwa', qty: 1 }), 400);
  const short = refused(await call(fleet, 'POST', `/v1/fleet/stock-items/${filter.id}/transfer`, { from: 'tublamu', to: 'ranong', qty: 5 }), 409, 'stock_short');
  assert.deepEqual(short.short, [{ item_id: filter.id, warehouse: 'tublamu', have: 4, asked: 5 }]);
  item = ok(await call(fleet, 'POST', `/v1/fleet/stock-items/${filter.id}/transfer`, { from: 'tublamu', to: 'ranong', qty: 3 }));
  assert.equal(qtyAt(item, 'tublamu'), 1);
  assert.equal(qtyAt(item, 'ranong'), 3);
  assert.deepEqual(item.movements.slice(-2).map((m: { type: string; delta: number }) => [m.type, m.delta]), [['transfer-out', -3], ['transfer-in', 3]]);

  // A hand count is an adjust movement; the quantity is never a field to overwrite.
  refused(await call(fleet, 'PATCH', `/v1/fleet/stock-items/${filter.id}`, { qty: 50 }), 400);
  refused(await call(fleet, 'PATCH', `/v1/fleet/stock-items/${filter.id}`, { total_qty: 50 }), 400);
  refused(await call(fleet, 'PATCH', `/v1/fleet/stock-items/${filter.id}`, { stocks: [] }), 400);
  ok(await call(fleet, 'PATCH', `/v1/fleet/stock-items/${filter.id}`, { total_qty: item.total_qty, note: 'echo is fine' }));
  item = ok(await call(fleet, 'POST', `/v1/fleet/stock-items/${filter.id}/adjust`, { warehouse: 'panwa', qty: 2 }));
  assert.equal(qtyAt(item, 'panwa'), 2);
  assert.deepEqual([item.movements.at(-1).type, item.movements.at(-1).delta], ['adjust', -3]);
  refused(await call(fleet, 'POST', `/v1/fleet/stock-items/${filter.id}/adjust`, { warehouse: 'panwa', qty: 2 }), 400);
  refused(await call(fleet, 'POST', `/v1/fleet/stock-items/${filter.id}/adjust`, { warehouse: 'panwa', qty: -1 }), 400);
  assert.equal(item.below_min, false);

  refused(await call(fleet, 'PATCH', `/v1/fleet/stock-items/${filter.id}`, { part_no: `PN2-${run}` }), 409, 'part_no_change');
  item = ok(await call(fleet, 'PATCH', `/v1/fleet/stock-items/${filter.id}`, { part_no: `PN2-${run}`, part_no_anyway: true, min_qty: 10 }));
  assert.equal(item.below_min, true, '6 in stock, minimum 10');
  const edit = item.movements.at(-1);
  assert.equal(edit.type, 'edit');
  assert.deepEqual(edit.changes.map((c: { field: string }) => c.field).sort(), ['min_qty', 'part_no']);

  // Merge a duplicate (legacy invDupMerge): its stock moves over, its row stays, marked merged.
  const twin = ok(await call(fleet, 'POST', '/v1/fleet/stock-items', { name: `Belt ${run}`, part_no: 'B1', qty: 2, warehouse: 'panwa' }), 201);
  refused(await call(fleet, 'POST', `/v1/fleet/stock-items/${filter.id}/merge`, { from_ids: [twin.id] }), 400, undefined);
  const other = ok(await call(fleet, 'POST', '/v1/fleet/stock-items', { name: `Belt3 ${run}`, part_no: 'B9' }), 201);
  refused(await call(fleet, 'PATCH', `/v1/fleet/stock-items/${other.id}`, { name: `Belt ${run}`, part_no: 'B1' }), 409, 'stock_item_exists');
  assert.equal(ok(await call(fleet, 'GET', `/v1/fleet/stock-items/${twin.id}`)).total_qty, 2, 'a refused merge moved nothing');

  // Delete hides the item and keeps its history; one holding stock is refused.
  refused(await call(fleet, 'DELETE', `/v1/fleet/stock-items/${twin.id}`), 409, 'stock_not_empty');
  ok(await call(fleet, 'POST', `/v1/fleet/stock-items/${twin.id}/adjust`, { warehouse: 'panwa', qty: 0 }));
  assert.equal((await call(fleet, 'DELETE', `/v1/fleet/stock-items/${twin.id}`)).statusCode, 204);
  const gone = ok(await call(fleet, 'GET', `/v1/fleet/stock-items/${twin.id}`));
  assert.ok(gone.deleted_at);
  assert.ok(gone.movements.length >= 2, 'history stays');
  const list = ok(await call(fleet, 'GET', `/v1/fleet/stock-items?q=${encodeURIComponent(run)}`)).items.map((i: { id: string }) => i.id);
  assert.ok(!list.includes(twin.id) && list.includes(filter.id));
  assert.ok(ok(await call(fleet, 'GET', `/v1/fleet/stock-items?deleted=true&q=${encodeURIComponent(run)}`)).items.some((i: { id: string }) => i.id === twin.id));
  refused(await call(fleet, 'POST', `/v1/fleet/stock-items/${twin.id}/receive`, { warehouse: 'panwa', qty: 1 }), 409, 'item_deleted');
});

test('stock: merging duplicates moves their stock and repoints memo lines', async () => {
  // Two items with the same name and part number, as legacy has: made by an import, here by a rename
  // around the check (the second takes a blank part number first, then the check is satisfied by ids).
  const a = ok(await call(fleet, 'POST', '/v1/fleet/stock-items', { name: `Anode ${run}`, part_no: 'AN-1', qty: 3, warehouse: 'panwa', cost: 50 }), 201);
  const b = ok(await call(fleet, 'POST', '/v1/fleet/stock-items', { name: `Anode x ${run}`, part_no: 'AN-1', qty: 2, warehouse: 'tublamu', supplier: 'Sup' }), 201);
  // Make b a true duplicate the way legacy data arrives: the API never creates one, so this goes through the store.
  const stored = await store.fleet.item(b.id);
  await store.transaction(async () => store.fleet.putItems([{ ...stored!, name: `Anode ${run}` }]));
  const memo = ok(await call(fleet, 'POST', '/v1/fleet/memos', { no: `MO-M${run}`, title: 'anodes', lines: [{ name: `Anode ${run}`, qty: 1, price: 50, item_id: b.id }] }), 201);
  const kept = ok(await call(fleet, 'POST', `/v1/fleet/stock-items/${a.id}/merge`, { from_ids: [b.id] }));
  assert.equal(kept.total_qty, 5);
  assert.equal(kept.supplier, 'Sup', 'a blank field takes the duplicate\'s');
  assert.ok(kept.movements.some((m: { item_id: string }) => m.item_id === b.id), 'the merged item\'s history is read with it');
  const dropped = ok(await call(fleet, 'GET', `/v1/fleet/stock-items/${b.id}`));
  assert.equal(dropped.merged_into, a.id);
  assert.equal(dropped.total_qty, 0);
  assert.equal(ok(await call(fleet, 'GET', `/v1/fleet/memos/${memo.id}`)).lines[0].item_id, a.id);
});

test('consumables: drawing below zero needs allow_negative; a void puts the stock back and keeps the record', async () => {
  const oil = ok(await call(fleet, 'POST', '/v1/fleet/stock-items', { name: `Marine oil ${run}`, unit: 'GA', qty: 2, warehouse: 'panwa', cost: 934.58 }), 201);
  refused(await call(fleet, 'POST', '/v1/fleet/consumables', { item_id: oil.id, warehouse: 'panwa', qty: 0, boat_id: panwaBoat }), 400);
  refused(await call(fleet, 'POST', '/v1/fleet/consumables', { item_id: oil.id, warehouse: 'panwa', qty: 1.5, boat_id: panwaBoat }), 400);
  refused(await call(fleet, 'POST', '/v1/fleet/consumables', { item_id: oil.id, warehouse: 'panwa', qty: 1 }), 400);
  refused(await call(fleet, 'POST', '/v1/fleet/consumables', { item_id: oil.id, warehouse: 'panwa', qty: 1, boat_id: 'b-nowhere' }), 400);
  refused(await call(fleet, 'POST', '/v1/fleet/consumables', { item_id: 'inv-nowhere', warehouse: 'panwa', qty: 1, boat_id: panwaBoat }), 404);
  refused(await call(fleet, 'POST', '/v1/fleet/consumables', { item_id: oil.id, warehouse: 'panwa', qty: 3, boat_id: panwaBoat }), 409, 'stock_short');
  const draw = ok(await call(fleet, 'POST', '/v1/fleet/consumables', {
    itemId: oil.id, location: 'คลัง Visit Panwa', qty: 2, boatId: panwaBoat, by: 'เลิศลักษณ์', note: 'เบิกไว้เติม', date: `${Y}-06-28`,
  }), 201);
  assert.deepEqual([draw.warehouse, draw.drawn_by, draw.cost], ['panwa', 'เลิศลักษณ์', 1869.16]);
  assert.equal(ok(await call(fleet, 'GET', `/v1/fleet/stock-items/${oil.id}`)).total_qty, 0);
});

test('consumables: cost is computed, never taken from the request', async () => {
  const oil = ok(await call(fleet, 'POST', '/v1/fleet/stock-items', { name: `Gear oil ${run}`, unit: 'L', qty: 2, warehouse: 'panwa', cost: 100.5 }), 201);
  refused(await call(fleet, 'POST', '/v1/fleet/consumables', { item_id: oil.id, warehouse: 'panwa', qty: 1, boat_id: panwaBoat, cost: 1 }), 400);
  const c = ok(await call(fleet, 'POST', '/v1/fleet/consumables', { item_id: oil.id, warehouse: 'panwa', qty: 3, boat_id: panwaBoat2, allow_negative: true, date: `${Y}-06-28`, by: 'Lert' }), 201);
  assert.equal(c.cost, 301.5);
  assert.equal(c.unit_cost, 100.5);
  assert.equal(c.item_name, `Gear oil ${run}`);
  let item = ok(await call(fleet, 'GET', `/v1/fleet/stock-items/${oil.id}`));
  assert.equal(qtyAt(item, 'panwa'), -1, 'consumables may go below zero after the confirm');
  const month = ok(await call(fleet, 'GET', `/v1/fleet/consumables?month=${Y}-06&boat_id=${panwaBoat2}`));
  assert.deepEqual(month.consumables.map((x: { id: string }) => x.id), [c.id]);
  assert.equal(month.total_cost, 301.5);
  assert.equal((await call(fleet, 'DELETE', `/v1/fleet/consumables/${c.id}`)).statusCode, 204);
  refused(await call(fleet, 'DELETE', `/v1/fleet/consumables/${c.id}`), 409, 'already_voided');
  item = ok(await call(fleet, 'GET', `/v1/fleet/stock-items/${oil.id}`));
  assert.equal(qtyAt(item, 'panwa'), 2);
  assert.deepEqual(item.movements.filter((m: { consumable_id: string | null }) => m.consumable_id === c.id).map((m: { type: string }) => m.type), ['withdraw', 'return'], 'nothing erased');
  assert.equal(ok(await call(fleet, 'GET', `/v1/fleet/consumables?month=${Y}-06&boat_id=${panwaBoat2}`)).consumables.length, 0);
  assert.equal(ok(await call(fleet, 'GET', `/v1/fleet/consumables?month=${Y}-06&boat_id=${panwaBoat2}&voided=true`)).consumables[0].voided_by, `fl.fleet.${run}`);
});

test('memos: totals are the server\'s; the steps, partial receipt, short close, payment and cancel follow legacy', async () => {
  const lines = [
    { name: `Impeller ${run}`, qty: 2, price: 1000, discount_pct: 10 },
    { name: 'ค่าแรง', qty: 0, price: 500, category: 'labor' },
  ];
  refused(await call(fleet, 'POST', '/v1/fleet/memos', { no: `MO-${run}`, title: 'x', memo_type: 'mixed', lines, amount: 1 }), 400);
  refused(await call(fleet, 'POST', '/v1/fleet/memos', { title: 'no number', lines }), 400);
  refused(await call(fleet, 'POST', '/v1/fleet/memos', { no: `MO-${run}`, title: 'x', memo_type: 'parts', lines }), 400, undefined);
  refused(await call(fleet, 'POST', '/v1/fleet/memos', { no: `MO-${run}`, title: 'x', scope: 'general', boat_id: panwaBoat }), 400);
  const memo = ok(await call(fleet, 'POST', '/v1/fleet/memos', {
    no: `MO-${run}`, subject: 'Impeller and labour', memo_type: 'mixed', boat_id: panwaBoat, supplier: `Sup ${run}`, discount_pct: 5, discount_amt: 10, items: lines,
  }), 201);
  // gross 2000 + 500 (a 0 qty counts as 1, as legacy's form) = 2500; line discount 200; memo discount
  // round(2300 × 5%) + 10 = 125; after 2175; VAT 7% = 152.25; total 2327.25.
  assert.deepEqual([memo.subtotal, memo.discount, memo.after_discount, memo.vat, memo.amount], [2500, 325, 2175, 152.25, 2327.25]);
  assert.equal(memo.status, 'pending_approval');
  assert.equal(memo.current_step, 1);
  assert.ok(memo.lines[0].item_id, 'a parts line with no item registers one');
  assert.equal(memo.lines[1].item_id, null, 'labor is never stock');
  assert.equal(memo.default_warehouse.warehouse, 'panwa', 'the boat\'s pier');
  assert.equal(memo.history[0].type, 'create');
  const registered = ok(await call(fleet, 'GET', `/v1/fleet/stock-items/${memo.lines[0].item_id}`));
  assert.equal(registered.created_from, `MO-${run}`);
  assert.equal(registered.total_qty, 0);
  refused(await call(fleet, 'POST', '/v1/fleet/memos', { no: `MO-${run}`, title: 'again' }), 409, 'memo_no_taken');

  refused(await call(fleet, 'PATCH', `/v1/fleet/memos/${memo.id}`, { status: 'paid' }), 400);
  refused(await call(fleet, 'PATCH', `/v1/fleet/memos/${memo.id}`, { amount: 5 }), 400);
  refused(await call(fleet, 'PATCH', `/v1/fleet/memos/${memo.id}`, { no: 'MO-999' }), 400);
  refused(await call(fleet, 'POST', `/v1/fleet/memos/${memo.id}/order`, {}), 409, 'memo_status');
  refused(await call(fleet, 'POST', `/v1/fleet/memos/${memo.id}/approve`, {}), 400);
  let m = ok(await call(fleet, 'POST', `/v1/fleet/memos/${memo.id}/approve`, { approvedBy: 'ANON', note: 'ok' }));
  assert.deepEqual([m.status, m.current_step, m.approved_by, m.approve_note, m.approved_login], ['approved', 2, 'ANON', 'ok', `fl.fleet.${run}`]);
  refused(await call(fleet, 'POST', `/v1/fleet/memos/${memo.id}/pay`, {}), 409, 'memo_status');
  m = ok(await call(fleet, 'POST', `/v1/fleet/memos/${memo.id}/order`, {}));
  assert.equal(m.status, 'ordered');
  const part = m.lines[0];
  refused(await call(fleet, 'POST', `/v1/fleet/memos/${memo.id}/receive`, { lines: [{ line_id: m.lines[1].id, qty: 1 }] }), 400);
  refused(await call(fleet, 'POST', `/v1/fleet/memos/${memo.id}/receive`, { lines: [{ line_id: part.id, qty: 0 }] }), 400);
  refused(await call(fleet, 'POST', `/v1/fleet/memos/${memo.id}/short-close`, {}), 409, 'nothing_received');
  m = ok(await call(fleet, 'POST', `/v1/fleet/memos/${memo.id}/receive`, { lines: [{ line_id: part.id, qty: 1 }], date: `${Y}-05-01` }));
  assert.deepEqual([m.status, m.current_step, m.lines[0].received_qty, m.receive_state.full], ['ordered', 3, 1, false]);
  assert.equal(m.receipts.length, 1);
  assert.equal(m.received_warehouse, 'panwa');
  let stock = ok(await call(fleet, 'GET', `/v1/fleet/stock-items/${part.item_id}`));
  assert.equal(qtyAt(stock, 'panwa'), 1);
  refused(await call(fleet, 'PATCH', `/v1/fleet/memos/${memo.id}`, { lines: [m.lines[1]] }), 409, 'line_received');
  refused(await call(fleet, 'PATCH', `/v1/fleet/memos/${memo.id}`, { lines: [{ ...m.lines[0], received_qty: 2 }, m.lines[1]] }), 400);

  // Short close: accept what came; the totals follow it and the old amount is kept.
  m = ok(await call(fleet, 'POST', `/v1/fleet/memos/${memo.id}/short-close`, {}));
  assert.equal(m.status, 'received');
  assert.equal(m.ordered_amount, 2327.25);
  // Legacy's _memoTotals counts the 0-qty labor line as 0 here (the form counted it as 1): gross 1000;
  // line discount 100; memo round(900 × 5%) + 10 = 55; after 845; VAT 59.15.
  assert.equal(m.amount, 904.15);
  assert.deepEqual(m.short_closed.missing, [{ name: `Impeller ${run}`, left: 1, unit: 'ชิ้น' }]);
  m = ok(await call(fleet, 'POST', `/v1/fleet/memos/${memo.id}/pay`, { paid_via: 'transfer' }));
  assert.deepEqual([m.status, m.current_step, m.paid_via], ['paid', 5, 'transfer']);
  refused(await call(fleet, 'PATCH', `/v1/fleet/memos/${memo.id}`, { note: 'late' }), 409, 'memo_paid');
  refused(await call(fleet, 'POST', `/v1/fleet/memos/${memo.id}/cancel`, { reason: 'x' }), 409, 'memo_paid');
  assert.deepEqual(m.history.map((h: { type: string }) => h.type), ['create', 'approve', 'order', 'receive', 'short_close', 'pay']);
  stock = ok(await call(fleet, 'GET', `/v1/fleet/stock-items/${part.item_id}`));
  assert.equal(stock.total_qty, 1);
});

test('memos: a labor memo goes approved → paid; a cancel after receipt takes its stock back', async () => {
  const labor = ok(await call(fleet, 'POST', '/v1/fleet/memos', { no: `MO-L${run}`, title: 'labor', memo_type: 'labor', vat_enabled: false, lines: [{ name: 'ช่าง', qty: 1, price: 800 }] }), 201);
  assert.deepEqual([labor.amount, labor.vat, labor.labor_only], [800, 0, true]);
  ok(await call(fleet, 'POST', `/v1/fleet/memos/${labor.id}/approve`, { approved_by: 'Anon' }));
  refused(await call(fleet, 'POST', `/v1/fleet/memos/${labor.id}/order`, {}), 409, 'memo_status');
  const paid = ok(await call(fleet, 'POST', `/v1/fleet/memos/${labor.id}/pay`, {}));
  assert.deepEqual([paid.status, paid.current_step], ['paid', 3]);

  const item = ok(await call(fleet, 'POST', '/v1/fleet/stock-items', { name: `Seal ${run}`, part_no: 'S1', cost: 40 }), 201);
  const memo = ok(await call(fleet, 'POST', '/v1/fleet/memos', { no: `MO-C${run}`, title: 'seals', boat_id: tublamuBoat, lines: [{ name: `Seal ${run}`, part_no: 'S1', qty: 4, price: 45, item_id: item.id }] }), 201);
  assert.equal(memo.lines[0].price_mismatch, true, 'priced differently from the stock cost');
  ok(await call(fleet, 'POST', `/v1/fleet/memos/${memo.id}/approve`, { approved_by: 'Anon' }));
  ok(await call(fleet, 'POST', `/v1/fleet/memos/${memo.id}/order`, {}));
  const got = ok(await call(fleet, 'POST', `/v1/fleet/memos/${memo.id}/receive`, { lines: [{ line_id: memo.lines[0].id, qty: 4 }] }));
  assert.deepEqual([got.status, got.current_step, got.received_warehouse], ['received', 4, 'tublamu']);
  // Two used for a job (part A's withdraw, here an adjust), then the memo is cancelled.
  ok(await call(fleet, 'POST', `/v1/fleet/stock-items/${item.id}/adjust`, { warehouse: 'tublamu', qty: 2 }));
  refused(await call(fleet, 'POST', `/v1/fleet/memos/${memo.id}/cancel`, {}), 400);
  const short = refused(await call(fleet, 'POST', `/v1/fleet/memos/${memo.id}/cancel`, { reason: 'wrong part' }), 409, 'stock_short');
  assert.deepEqual(short.short, [{ item_id: item.id, warehouse: 'tublamu', have: 2, asked: 4 }]);
  const cancelled = ok(await call(fleet, 'POST', `/v1/fleet/memos/${memo.id}/cancel`, { reason: 'wrong part', allow_negative: true }));
  assert.deepEqual([cancelled.status, cancelled.cancel_reason, cancelled.cancelled_by], ['cancelled', 'wrong part', `fl.fleet.${run}`]);
  const stock = ok(await call(fleet, 'GET', `/v1/fleet/stock-items/${item.id}`));
  assert.equal(qtyAt(stock, 'tublamu'), -2);
  assert.deepEqual(stock.movements.filter((x: { memo_id: string | null }) => x.memo_id === memo.id).map((x: { type: string; delta: number }) => [x.type, x.delta]), [['receive', 4], ['reverse', -4]]);
  refused(await call(fleet, 'POST', `/v1/fleet/memos/${memo.id}/cancel`, { reason: 'again' }), 409, 'already_cancelled');

  const list = ok(await call(fleet, 'GET', `/v1/fleet/memos?q=${encodeURIComponent(run)}&status=cancelled`)).memos;
  assert.deepEqual(list.map((x: { id: string }) => x.id), [memo.id]);
  const spend = ok(await call(fleet, 'GET', '/v1/fleet/reports/memo-spend'));
  assert.ok(spend.by_type.some((g: { key: string }) => g.key === 'labor'));
  refused(await call(fleet, 'GET', '/v1/fleet/reports/memo-spend?from=2026-02-01&to=2026-01-01'), 400);
});

test('projects: lifecycle, boat log, bill gate, documents with uploaded files', async () => {
  refused(await call(fleet, 'POST', '/v1/fleet/projects', { no: 'PRJ-x', name: 'x', plan_from: `${Y}-01-01` }), 400, undefined);
  refused(await call(fleet, 'POST', '/v1/fleet/projects', { no: 'PRJ-x', name: 'x', boat_id: null, plan_from: `${Y}-01-05`, plan_to: `${Y}-01-01` }), 400);
  refused(await call(fleet, 'POST', '/v1/fleet/projects', { no: 'PRJ-x', name: 'x', boat_id: 'b-nowhere', plan_from: `${Y}-01-01` }), 400);
  const p = ok(await call(fleet, 'POST', '/v1/fleet/projects', {
    no: `PRJ-${run}`, name: 'Annual Drydock', boatId: panwaBoat, type: 'drydock', vendor: 'Yard', planFrom: `${Y}-01-01`, planTo: `${Y}-01-20`, plannedBudget: 50000,
  }), 201);
  assert.deepEqual([p.status, p.original_plan_to, p.cost, p.bill_gate.ok], ['planned', `${Y}-01-20`, 0, false]);
  assert.ok(p.required_documents.includes('Final Invoice'));
  refused(await call(fleet, 'PATCH', `/v1/fleet/projects/${p.id}`, { status: 'completed' }), 400);
  refused(await call(fleet, 'PATCH', `/v1/fleet/projects/${p.id}`, { original_plan_to: `${Y}-02-01` }), 400);
  refused(await call(fleet, 'PATCH', `/v1/fleet/projects/${p.id}`, { phase: 'service' }), 400, undefined);
  let x = ok(await call(fleet, 'PATCH', `/v1/fleet/projects/${p.id}`, { plan_to: `${Y}-01-25`, phase: 'liftout' }));
  assert.equal(x.original_plan_to, `${Y}-01-20`, 'the baseline stays');
  assert.ok(x.log.some((l: { text: string }) => l.text === 'Phase: (none) → Lift-out'));

  refused(await call(fleet, 'POST', `/v1/fleet/projects/${p.id}/hold`, { reason: 'x' }), 409, 'project_status');
  x = ok(await call(fleet, 'POST', `/v1/fleet/projects/${p.id}/start`, {}));
  assert.equal(x.status, 'inprogress');
  let boat = ok(await call(fleet, 'GET', `/v1/boats/${panwaBoat}`));
  const entry = boat.status_log.find((e: { project_id: string | null }) => e.project_id === p.id);
  assert.deepEqual([entry.status, entry.reason, entry.to_date], ['unavailable', 'dry_dock', null]);
  refused(await call(fleet, 'POST', `/v1/fleet/projects/${p.id}/hold`, {}), 400);
  ok(await call(fleet, 'POST', `/v1/fleet/projects/${p.id}/hold`, { reason: 'รออะไหล่' }));
  x = ok(await call(fleet, 'POST', `/v1/fleet/projects/${p.id}/resume`, {}));
  assert.equal(x.hold_reason, null);

  // The bill gate: an invoice document and a cost; or a "no cost" close with a reason.
  const gate = refused(await call(fleet, 'POST', `/v1/fleet/projects/${p.id}/complete`, {}), 409, 'bill_gate');
  assert.equal(gate.missing.length, 2);
  refused(await call(fleet, 'POST', `/v1/fleet/projects/${p.id}/complete`, { no_cost_reason: ' ' }), 400);

  // Documents: fleet may upload now; a file a project names cannot be deleted from under it.
  const file = ok(await call(fleet, 'POST', '/v1/attachments', { filename: 'invoice.pdf', mime: 'application/pdf', data_b64: Buffer.from('%PDF-1.4 x').toString('base64') }), 201);
  refused(await call(fleet, 'POST', `/v1/fleet/projects/${p.id}/documents`, { attachment_id: 'att_nowhere' }), 400);
  x = ok(await call(fleet, 'POST', `/v1/fleet/projects/${p.id}/documents`, { name: 'Final Invoice', attachment_id: file.id }));
  const doc = x.documents[0];
  assert.deepEqual([doc.status, doc.url, doc.mime], ['received', `/v1/attachments/${file.id}`, 'application/pdf']);
  assert.ok(!x.required_documents.includes('Final Invoice'));
  refused(await call(fleet, 'DELETE', `/v1/attachments/${file.id}`), 409, 'attachment_in_use');
  const gate2 = refused(await call(fleet, 'POST', `/v1/fleet/projects/${p.id}/complete`, {}), 409, 'bill_gate');
  assert.equal(gate2.missing.length, 1, 'cost is still ฿0 (part A\'s jobs)');
  x = ok(await call(fleet, 'POST', `/v1/fleet/projects/${p.id}/documents`, { name: 'Work Order' }));
  const pending = x.documents.find((d: { name: string }) => d.name === 'Work Order');
  assert.equal(pending.status, 'pending');
  x = ok(await call(fleet, 'PATCH', `/v1/fleet/projects/${p.id}/documents/${pending.id}`, { status: 'verified' }));
  refused(await call(fleet, 'PATCH', `/v1/fleet/projects/${p.id}/documents/${pending.id}`, { status: 'lost' }), 400);
  refused(await call(fleet, 'PATCH', `/v1/fleet/projects/${p.id}/documents/nowhere`, { status: 'verified' }), 404);

  // Plan items and vendor visits.
  x = ok(await call(fleet, 'POST', `/v1/fleet/projects/${p.id}/plan`, { text: 'ทำสีใหม่' }));
  const item = x.plan[0];
  x = ok(await call(fleet, 'PATCH', `/v1/fleet/projects/${p.id}/plan/${item.id}`, { done: true }));
  assert.equal(x.plan[0].done, true);
  assert.ok(x.plan[0].done_date);
  x = ok(await call(fleet, 'POST', `/v1/fleet/projects/${p.id}/vendor-visits`, { vendor: 'Painter', role: 'quote' }));
  x = ok(await call(fleet, 'DELETE', `/v1/fleet/projects/${p.id}/vendor-visits/${x.vendor_visits[0].id}`));
  assert.equal(x.vendor_visits.length, 0);

  // Work done → awaiting the bill (boat back), bill-back (boat out again), then close with no cost.
  x = ok(await call(fleet, 'POST', `/v1/fleet/projects/${p.id}/work-done`, { note: 'อู่จะส่งบิล' }));
  assert.deepEqual([x.status, x.bill_note], ['awaiting_bill', 'อู่จะส่งบิล']);
  boat = ok(await call(fleet, 'GET', `/v1/boats/${panwaBoat}`));
  assert.equal(boat.status_log.at(-1).status, 'available');
  x = ok(await call(fleet, 'POST', `/v1/fleet/projects/${p.id}/bill-back`, {}));
  assert.equal(x.status, 'inprogress');
  boat = ok(await call(fleet, 'GET', `/v1/boats/${panwaBoat}`));
  assert.equal(boat.status_log.at(-1).status, 'unavailable');
  x = ok(await call(fleet, 'POST', `/v1/fleet/projects/${p.id}/complete`, { no_cost_reason: 'งานในประกัน' }));
  assert.deepEqual([x.status, x.no_cost.reason, x.bill_gate.ok, x.health.label], ['completed', 'งานในประกัน', true, 'COMPLETED']);
  boat = ok(await call(fleet, 'GET', `/v1/boats/${panwaBoat}`));
  assert.equal(boat.status_log.at(-1).status, 'available');
  assert.ok(boat.status_log.filter((e: { project_id: string | null }) => e.project_id === p.id).every((e: { to_date: string | null }) => e.to_date !== null));
  refused(await call(fleet, 'POST', `/v1/fleet/projects/${p.id}/cancel`, { reason: 'x' }), 409, 'project_status');

  // Taking the document off deletes its file, which nothing else names.
  x = ok(await call(fleet, 'DELETE', `/v1/fleet/projects/${p.id}/documents/${doc.id}`));
  assert.equal(x.documents.some((d: { id: string }) => d.id === doc.id), false);
  assert.equal((await call(fleet, 'GET', `/v1/attachments/${file.id}`)).statusCode, 404);

  // Cancel and reopen; a general project has no boat.
  const g = ok(await call(fleet, 'POST', '/v1/fleet/projects', { no: `PRJ-G${run}`, name: 'ขอเอกสาร', boat_id: null, type: 'other', plan_from: `${Y}-03-01` }), 201);
  ok(await call(fleet, 'POST', `/v1/fleet/projects/${g.id}/start`, {}));
  refused(await call(fleet, 'POST', `/v1/fleet/projects/${g.id}/cancel`, {}), 400);
  x = ok(await call(fleet, 'POST', `/v1/fleet/projects/${g.id}/cancel`, { reason: 'ไม่ทำแล้ว' }));
  assert.equal(x.status, 'cancelled');
  x = ok(await call(fleet, 'POST', `/v1/fleet/projects/${g.id}/reopen`, {}));
  assert.deepEqual([x.status, x.cancel_reason], ['planned', null]);
  const list = ok(await call(fleet, 'GET', '/v1/fleet/projects?status=planned')).projects.map((y: { id: string }) => y.id);
  assert.ok(list.includes(g.id) && !list.includes(p.id));
  refused(await call(sales, 'POST', `/v1/fleet/projects/${g.id}/start`, {}), 403);
});

test('daily log: fuel, pax and meters per boat; prices with legacy\'s fallbacks; the day lock is enforced', async () => {
  const d1 = `${Y}-07-01`; const d2 = `${Y}-07-02`;
  refused(await call(ops, 'PATCH', `/v1/fleet/daily-log/${d1}/boats/${panwaBoat}`, { fuel_litres: 100 }), 403);
  refused(await call(fleet, 'PATCH', `/v1/fleet/daily-log/${d1}/boats/b-nowhere`, { fuel_litres: 100 }), 404);
  refused(await call(fleet, 'PATCH', `/v1/fleet/daily-log/2026-13-01/boats/${panwaBoat}`, { fuel_litres: 100 }), 400);
  refused(await call(fleet, 'PATCH', `/v1/fleet/daily-log/${d1}/boats/${panwaBoat}`, { pax_actual: 2.5 }), 400);
  let day = ok(await call(fleet, 'PATCH', `/v1/fleet/daily-log/${d1}/boats/${panwaBoat}`, { fuel: 518.1, paxActual: 40, trips: { normal: { engines: { e43: 4013, e44: 4217 } } } }));
  let row = day.boats.find((b: { boat_id: string }) => b.boat_id === panwaBoat);
  assert.deepEqual([row.fuel_litres, row.pax_actual, row.meters.normal.e43], [518.1, 40, 4013]);
  day = ok(await call(fleet, 'PATCH', `/v1/fleet/daily-log/${d1}/boats/${panwaBoat}`, { pax_actual: null, meters: { normal: { e44: null } } }));
  row = day.boats.find((b: { boat_id: string }) => b.boat_id === panwaBoat);
  assert.deepEqual([row.fuel_litres, row.pax_actual, Object.keys(row.meters.normal)], [518.1, null, ['e43']]);

  // Prices: a boat's own, else its pier's, else another boat's at the pier, else the last 30 days.
  refused(await call(fleet, 'PUT', `/v1/fleet/daily-log/${d1}/fuel-prices`, { nowhere: 40 }), 400);
  refused(await call(fleet, 'PUT', `/v1/fleet/daily-log/${d1}/fuel-prices`, { panwa: -1 }), 400);
  ok(await call(fleet, 'PUT', `/v1/fleet/daily-log/${d1}/fuel-prices`, { [panwaBoat2]: 41.18 }));
  day = ok(await call(fleet, 'PATCH', `/v1/fleet/daily-log/${d2}/boats/${panwaBoat}`, { fuel_litres: 300 }));
  assert.deepEqual(day.boats.find((b: { boat_id: string }) => b.boat_id === panwaBoat).fuel_price, { price: 41.18, src: 'back', from: d1 });
  const log = ok(await call(fleet, 'GET', `/v1/fleet/daily-log?from=${d1}&to=${d2}`));
  assert.deepEqual(log.days.find((x: { date: string }) => x.date === d1).boats.find((b: { boat_id: string }) => b.boat_id === panwaBoat).fuel_price, { price: 41.18, src: 'sib', from: d1 });
  ok(await call(fleet, 'PUT', `/v1/fleet/daily-log/${d2}/fuel-prices`, { panwa: 40.43 }));
  day = ok(await call(fleet, 'GET', `/v1/fleet/daily-log?from=${d2}`)).days[0];
  assert.deepEqual(day.boats.find((b: { boat_id: string }) => b.boat_id === panwaBoat).fuel_price, { price: 40.43, src: 'pier', from: d2 });
  refused(await call(fleet, 'GET', `/v1/fleet/daily-log?from=${Y}-01-01&to=${Y}-12-31`), 400);

  // Water, issued items, extras and outside requests: fleet or operations.
  const water = ok(await call(ops, 'PUT', `/v1/fleet/daily-log/${d1}/boats/${panwaBoat}/water`, { open: 4416269, close: 4417081 }));
  assert.equal(water.boats.find((b: { boat_id: string }) => b.boat_id === panwaBoat).water.used, 812);
  const cake = ok(await call(ops, 'POST', '/v1/fleet/issue-items', { name: `เค้ก ${run}`, unit: 'ชิ้น', pier: 'panwa' }), 201);
  ok(await call(ops, 'PATCH', `/v1/fleet/issue-items/${cake.id}`, { off: true }));
  const again = ok(await call(ops, 'POST', '/v1/fleet/issue-items', { name: `เค้ก ${run}` }), 201);
  assert.deepEqual([again.id, again.off], [cake.id, false], 'a name that exists is turned back on');
  refused(await call(ops, 'PUT', `/v1/fleet/daily-log/${d1}/boats/${panwaBoat}/issues`, { 'it-nowhere': 3 }), 400);
  day = ok(await call(ops, 'PUT', `/v1/fleet/daily-log/${d1}/boats/${panwaBoat}/issues`, { [cake.id]: 20 }));
  assert.deepEqual(day.boats.find((b: { boat_id: string }) => b.boat_id === panwaBoat).issues, { [cake.id]: 20 });
  day = ok(await call(ops, 'POST', `/v1/fleet/daily-log/${d1}/boats/${panwaBoat}/extras`, { n: 'น้ำเปล่า', q: 2, u: 'ลัง' }), 201);
  const extra = day.boats.find((b: { boat_id: string }) => b.boat_id === panwaBoat).extras[0];
  assert.deepEqual([extra.name, extra.qty, extra.unit], ['น้ำเปล่า', 2, 'ลัง']);
  day = ok(await call(ops, 'POST', `/v1/fleet/daily-log/${d1}/piers/panwa/requests`, { name: 'ดิงกี้', fuel: 20, price: 40.43, iss: { [cake.id]: 1 } }), 201);
  const req = day.requests.panwa[0];
  assert.deepEqual([req.name, req.fuel, req.issues], ['ดิงกี้', 20, { [cake.id]: 1 }]);
  refused(await call(ops, 'POST', `/v1/fleet/daily-log/${d1}/piers/nowhere/requests`, { name: 'x' }), 400);

  // Save day locks the pier's day: every write to it is refused until Edit unlocks it.
  refused(await call(ops, 'POST', `/v1/fleet/daily-log/${d1}/piers/panwa/lock`, {}), 403);
  day = ok(await call(fleet, 'POST', `/v1/fleet/daily-log/${d1}/piers/panwa/lock`, {}));
  assert.equal(day.locks.panwa.locked_by, `fl.fleet.${run}`);
  refused(await call(fleet, 'PATCH', `/v1/fleet/daily-log/${d1}/boats/${panwaBoat}`, { fuel_litres: 1 }), 409, 'day_locked');
  refused(await call(ops, 'PUT', `/v1/fleet/daily-log/${d1}/boats/${panwaBoat}/water`, { open: 1 }), 409, 'day_locked');
  refused(await call(ops, 'PUT', `/v1/fleet/daily-log/${d1}/boats/${panwaBoat2}/issues`, { [cake.id]: 1 }), 409, 'day_locked');
  refused(await call(ops, 'DELETE', `/v1/fleet/daily-log/${d1}/boats/${panwaBoat}/extras/${extra.id}`), 409, 'day_locked');
  refused(await call(ops, 'PUT', `/v1/fleet/daily-log/${d1}/piers/panwa/requests/${req.id}`, { name: 'x' }), 409, 'day_locked');
  refused(await call(fleet, 'PUT', `/v1/fleet/daily-log/${d1}/fuel-prices`, { panwa: 41 }), 409, 'day_locked');
  refused(await call(fleet, 'PUT', `/v1/fleet/daily-log/${d1}/fuel-prices`, { [panwaBoat]: 41 }), 409, 'day_locked');
  ok(await call(fleet, 'PATCH', `/v1/fleet/daily-log/${d1}/boats/${tublamuBoat}`, { fuel_litres: 10 }), 200);
  ok(await call(fleet, 'PUT', `/v1/fleet/daily-log/${d1}/fuel-prices`, { tublamu: 41 }));
  day = ok(await call(fleet, 'POST', `/v1/fleet/daily-log/${d1}/piers/panwa/unlock`, {}));
  assert.deepEqual(day.locks, {});
  day = ok(await call(ops, 'DELETE', `/v1/fleet/daily-log/${d1}/boats/${panwaBoat}/extras/${extra.id}`));
  assert.deepEqual(day.boats.find((b: { boat_id: string }) => b.boat_id === panwaBoat).extras, []);
  day = ok(await call(ops, 'DELETE', `/v1/fleet/daily-log/${d1}/piers/panwa/requests/${req.id}`));
  assert.deepEqual(day.requests, {});
});

test('safety equipment: required fields, computed state, inspections set the last and next check', async () => {
  refused(await call(fleet, 'POST', '/v1/fleet/safety', { boat_id: panwaBoat, category: 'parachute', name: 'x' }), 400);
  refused(await call(fleet, 'POST', '/v1/fleet/safety', { category: 'vhf', name: 'x' }), 400);
  refused(await call(fleet, 'POST', '/v1/fleet/safety', { boat_id: 'b-nowhere', category: 'vhf', name: 'x' }), 400);
  const kit = ok(await call(fleet, 'POST', '/v1/fleet/safety', { boatId: panwaBoat, category: 'first_aid', name: 'First aid kit', expiryDate: '2026-06-01', nextPM: '2099-01-01' }), 201);
  assert.equal(kit.state.label, 'EXPIRED');
  assert.equal(kit.state.type, 'expiry');
  refused(await call(fleet, 'PATCH', `/v1/fleet/safety/${kit.id}`, { state: { label: 'OK' } }), 400);
  let x = ok(await call(fleet, 'PATCH', `/v1/fleet/safety/${kit.id}`, { expiry_date: null }));
  assert.equal(x.state.label, 'OK');
  x = ok(await call(fleet, 'POST', `/v1/fleet/safety/${kit.id}/inspections`, { date: '2099-01-01', inspector: 'ช่างแน็ค', result: 'pass', findings: 'ok', next_due: '2099-02-01' }), 201);
  assert.deepEqual([x.last_inspect, x.next_pm], ['2099-01-01', '2099-02-01']);
  x = ok(await call(fleet, 'POST', `/v1/fleet/safety/${kit.id}/inspections`, { date: '2099-01-05', result: 'fail', next_due: '2099-01-06' }), 201);
  assert.deepEqual([x.last_inspect, x.next_pm], ['2099-01-01', '2099-02-01'], 'a fail is not a check');
  refused(await call(fleet, 'POST', `/v1/fleet/safety/${kit.id}/inspections`, { result: 'pass' }), 400);
  refused(await call(fleet, 'POST', `/v1/fleet/safety/${kit.id}/inspections`, { date: '2099-01-01', result: 'great' }), 400);
  const pass = x.inspections.find((i: { result: string }) => i.result === 'pass');
  x = ok(await call(fleet, 'DELETE', `/v1/fleet/safety/${kit.id}/inspections/${pass.id}`));
  assert.deepEqual([x.last_inspect, x.next_pm], [null, null]);
  assert.ok(x.log.some((l: { type: string }) => l.type === 'inspect'));
  assert.equal((await call(fleet, 'DELETE', `/v1/fleet/safety/${kit.id}`)).statusCode, 204);
  refused(await call(fleet, 'GET', `/v1/fleet/safety/${kit.id}`), 404);
  assert.ok(ok(await call(fleet, 'GET', '/v1/fleet/safety-categories')).categories.some((c: { id: string }) => c.id === 'epirb'));
});

test('PostgreSQL: movements are append-only in the schema too', { skip: !process.env.DATABASE_URL }, async () => {
  const { Pool } = await import('pg');
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const one = "(SELECT id FROM fleet_stock_movements WHERE id NOT LIKE 'lg\\_%' LIMIT 1)";
    await assert.rejects(db.query(`UPDATE fleet_stock_movements SET delta = delta + 1 WHERE id = ${one}`), /append-only/);
    await assert.rejects(db.query(`DELETE FROM fleet_stock_movements WHERE id = ${one}`), /append-only/);
  } finally { await db.end(); }
});
