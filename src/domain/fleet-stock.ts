/**
 * Stock: items, per-warehouse quantities and their movements, and consumables drawn for a boat
 * (todo/fleet-maintenance-model.md, "Design — part B"; legacy `05-fleet.js` inventory and
 * `flConsume*`). Pure, so both stores decide identically.
 *
 * Movements are append-only (decision 6): a quantity is the sum of an item's movements in a
 * warehouse, never a stored number a later write could overwrite (legacy `flSaveInvEdit`'s bug).
 * Undoing something appends the opposite movement; nothing is deleted.
 */
import {
  assertKnown, bad, bool, conflict, isoDate, newFleetId, nonNegative, notFound, number, parseWarehouse, positive, record, required, round2, text, warehouseName,
  WAREHOUSES, type WarehouseId,
} from './fleet-common.js';

export type StockItem = {
  id: string; name: string; part_no: string | null; category: string | null; supplier: string | null; unit: string;
  min_qty: number; cost: number; note: string | null; created_from: string | null; created_date: string | null;
  created_at: string; created_by: string | null; updated_at: string; deleted_at: string | null; deleted_by: string | null; merged_into: string | null;
};
/**
 * Legacy's history types, kept as they are, plus `return` (a voided consumable or a job part put
 * back), `reverse` (a cancelled memo's receipt) and `import` (the import's reconciliation).
 */
export const MOVEMENT_TYPES = ['register', 'receive', 'withdraw', 'transfer-out', 'transfer-in', 'edit', 'merge', 'adjust', 'adjust_out', 'in', 'return', 'reverse', 'import'] as const;
export type MovementType = typeof MOVEMENT_TYPES[number];
export type FieldChange = { field: string; from: string; to: string };
export type Movement = {
  id: string; seq: number; item_id: string; date: string; type: MovementType; warehouse: string | null; delta: number;
  note: string | null; by: string | null; memo_id: string | null; job_id: string | null; consumable_id: string | null;
  changes: FieldChange[] | null; created_at: string; created_by: string | null;
};
export type NewMovement = Omit<Movement, 'seq'>;

export const ITEM_CATEGORIES_HINT = ['general', 'engine', 'gearbox', 'propeller', 'hull'] as const;

// ── Keys and lookups (legacy §invKeyPartNo) ──

const norm = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();
export const sameName = (a: string | null | undefined, b: string | null | undefined): boolean => norm(a) === norm(b);
export const itemKey = (name: string, partNo: string | null): string => `${norm(name)}\u0000${norm(partNo)}`;
const live = (items: readonly StockItem[]) => items.filter((i) => i.deleted_at === null);

/** Legacy `_invPickByName`: the one live item of that name, or the one with that part number; else none. */
export function pickByName(items: readonly StockItem[], name: string, partNo: string | null): StockItem | undefined {
  const named = live(items).filter((i) => sameName(i.name, name));
  if (named.length === 1) return named[0];
  const pn = (partNo ?? '').trim();
  if (named.length > 1 && pn) {
    const exact = named.filter((i) => (i.part_no ?? '').trim() === pn);
    if (exact.length === 1) return exact[0];
  }
  return undefined;
}

/** Legacy `flSaveAddStock`'s refusals: the same name and part number; a reused name with no part number. */
export function assertItemUnique(items: readonly StockItem[], name: string, partNo: string | null, skipId?: string): void {
  const others = live(items).filter((i) => i.id !== skipId);
  const dup = others.find((i) => itemKey(i.name, i.part_no) === itemKey(name, partNo));
  if (dup) conflict(`${dup.name} · ${dup.part_no ?? '(no part number)'} is already in stock (${dup.id}). Receive into it, or give this one a different part number`, 'stock_item_exists', { item_id: dup.id });
  if (!(partNo ?? '').trim()) {
    const same = others.filter((i) => sameName(i.name, name));
    if (same.length) conflict(`The name ${name} is used by ${same.length} item(s); give a part number to tell them apart`, 'part_no_required', { item_ids: same.map((i) => i.id) });
  }
}

// ── Quantities ──

/** What an item holds in each warehouse: the sum of its movements. */
export function balances(movements: readonly Pick<Movement, 'warehouse' | 'delta'>[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of movements) if (m.warehouse !== null && m.delta !== 0) out.set(m.warehouse, round2((out.get(m.warehouse) ?? 0) + m.delta));
  return out;
}
export const qtyAt = (movements: readonly Pick<Movement, 'warehouse' | 'delta'>[], warehouse: string): number => balances(movements).get(warehouse) ?? 0;

export type StockView = StockItem & {
  stocks: { warehouse: string; warehouse_name: string | null; qty: number }[]; total_qty: number;
  primary_warehouse: string | null; primary_warehouse_name: string | null; below_min: boolean;
};
/** The item as read: its stock per warehouse, total, main warehouse (most stock, legacy `invSyncLegacy`), low flag. */
export function stockView(item: StockItem, movements: readonly Pick<Movement, 'warehouse' | 'delta'>[]): StockView {
  const b = balances(movements);
  const order = (w: string) => { const i = WAREHOUSES.findIndex((x) => x.id === w); return i < 0 ? 99 : i; };
  const stocks = [...b.entries()].filter(([, q]) => q !== 0).sort((x, y) => order(x[0]) - order(y[0]))
    .map(([warehouse, qty]) => ({ warehouse, warehouse_name: warehouseName(warehouse), qty }));
  const total = round2(stocks.reduce((s, x) => s + x.qty, 0));
  const primary = [...stocks].sort((x, y) => y.qty - x.qty)[0]?.warehouse ?? null;
  return { ...item, stocks, total_qty: total, primary_warehouse: primary, primary_warehouse_name: warehouseName(primary), below_min: total <= item.min_qty };
}

export function sortItems<T extends Pick<StockItem, 'name' | 'part_no' | 'id'>>(items: T[]): T[] {
  return items.sort((a, b) => a.name.localeCompare(b.name) || (a.part_no ?? '').localeCompare(b.part_no ?? '') || a.id.localeCompare(b.id));
}

export type ItemListQuery = { q?: string; category?: string; warehouse?: string; low?: boolean; deleted?: boolean };
export function parseItemListQuery(q: Record<string, unknown>): ItemListQuery {
  const out: ItemListQuery = {};
  if (typeof q.q === 'string' && q.q.trim()) out.q = q.q.trim().toLowerCase();
  if (typeof q.category === 'string' && q.category) out.category = q.category;
  if (q.warehouse !== undefined) out.warehouse = parseWarehouse(q.warehouse);
  if (q.low !== undefined) out.low = q.low === 'true' ? true : q.low === 'false' ? false : bad('low must be true or false');
  if (q.deleted !== undefined) out.deleted = q.deleted === 'true' ? true : q.deleted === 'false' ? false : bad('deleted must be true or false');
  return out;
}
export function matchesItem(v: StockView, q: ItemListQuery): boolean {
  if ((v.deleted_at !== null) !== (q.deleted ?? false)) return false;
  if (q.category !== undefined && v.category !== q.category) return false;
  if (q.warehouse !== undefined && !v.stocks.some((s) => s.warehouse === q.warehouse)) return false;
  if (q.low !== undefined && v.below_min !== q.low) return false;
  if (q.q !== undefined && !`${v.name} ${v.part_no ?? ''} ${v.supplier ?? ''} ${v.category ?? ''}`.toLowerCase().includes(q.q)) return false;
  return true;
}

// ── Movements ──

export type Ctx = { now: string; today: string; by: string | null };
const SIGN: Partial<Record<MovementType, 1 | -1>> = {
  receive: 1, in: 1, 'transfer-in': 1, return: 1, register: 1, withdraw: -1, 'transfer-out': -1, reverse: -1, adjust_out: -1,
};
/** A new movement; `qty` is the size and the type gives the direction (adjust, merge and import are signed). */
export function movement(ctx: Ctx, fields: { item_id: string; type: MovementType; warehouse: string | null; qty: number; date?: string | null; note?: string | null;
  by?: string | null; memo_id?: string | null; job_id?: string | null; consumable_id?: string | null; changes?: FieldChange[] | null; id?: string }): NewMovement {
  const sign = SIGN[fields.type] ?? 1;
  return {
    id: fields.id ?? newFleetId('mv'), item_id: fields.item_id, date: fields.date ?? ctx.today, type: fields.type, warehouse: fields.warehouse,
    delta: round2(sign * fields.qty), note: fields.note ?? null, by: fields.by ?? ctx.by, memo_id: fields.memo_id ?? null, job_id: fields.job_id ?? null,
    consumable_id: fields.consumable_id ?? null, changes: fields.changes ?? null, created_at: ctx.now, created_by: ctx.by,
  };
}

/** `409 stock_short` when `warehouse` holds less than `qty`, in legacy's words (`คลังนี้เหลือ N`). */
export function assertStock(item: Pick<StockItem, 'id' | 'name' | 'unit'>, movements: readonly Movement[], warehouse: string, qty: number): void {
  const have = qtyAt(movements, warehouse);
  if (qty > have) conflict(`${warehouseName(warehouse)} has only ${have} ${item.unit} of ${item.name} (asked ${qty})`, 'stock_short',
    { short: [{ item_id: item.id, warehouse, have, asked: qty }] });
}

const body = (value: unknown) => record(value);
const dateOf = (b: Record<string, unknown>) => isoDate(b.date, 'date');

/** `POST …/receive`, legacy `flSaveReceive` for one item: stock in at a warehouse. */
export function planReceive(item: StockItem, raw: unknown, ctx: Ctx): NewMovement {
  const b = body(raw);
  assertKnown(b, ['warehouse', 'qty', 'date', 'note'], 'A receipt');
  assertLive(item);
  const warehouse = parseWarehouse(b.warehouse);
  return movement(ctx, { item_id: item.id, type: 'receive', warehouse, qty: positive(b.qty, 'qty'), date: dateOf(b), note: text(b.note, 'note') });
}

/** `POST …/transfer`, legacy `flSaveTransfer`: refuses the same warehouse, and more than is there. */
export function planTransfer(item: StockItem, movements: readonly Movement[], raw: unknown, ctx: Ctx): NewMovement[] {
  const b = body(raw);
  assertKnown(b, ['from', 'to', 'qty', 'date', 'note'], 'A transfer');
  assertLive(item);
  const from = parseWarehouse(b.from, 'from');
  const to = parseWarehouse(b.to, 'to');
  if (from === to) bad('from and to must be different warehouses');
  const qty = positive(b.qty, 'qty');
  assertStock(item, movements, from, qty);
  const date = dateOf(b);
  const note = text(b.note, 'note');
  return [
    movement(ctx, { item_id: item.id, type: 'transfer-out', warehouse: from, qty, date, note: `ย้ายไป ${warehouseName(to)}${note ? ` · ${note}` : ''}` }),
    movement(ctx, { item_id: item.id, type: 'transfer-in', warehouse: to, qty, date, note: `ย้ายจาก ${warehouseName(from)}${note ? ` · ${note}` : ''}` }),
  ];
}

/** `POST …/adjust`: the quantity counted in a warehouse; the movement is the difference (decision 6). */
export function planAdjust(item: StockItem, movements: readonly Movement[], raw: unknown, ctx: Ctx): NewMovement {
  const b = body(raw);
  assertKnown(b, ['warehouse', 'qty', 'date', 'note'], 'An adjustment');
  assertLive(item);
  const warehouse = parseWarehouse(b.warehouse);
  const counted = nonNegative(b.qty, 'qty') ?? bad('qty is required: the quantity counted in the warehouse');
  const have = qtyAt(movements, warehouse);
  const delta = round2(counted - have);
  if (delta === 0) bad(`${warehouseName(warehouse)} already holds ${have} ${item.unit}`);
  return movement(ctx, { item_id: item.id, type: 'adjust', warehouse, qty: delta, date: dateOf(b), note: text(b.note, 'note') ?? `นับได้ ${counted} (เดิม ${have})` });
}

/**
 * A job part taken out of a warehouse (legacy `flMaintAddPart`), for part A's jobs: refused beyond
 * the warehouse's stock (decision 7: job parts never go negative).
 */
export function planWithdraw(item: StockItem, movements: readonly Movement[], input: { warehouse: string; qty: number; job_id: string; note?: string | null; date?: string | null }, ctx: Ctx): NewMovement {
  assertLive(item);
  const warehouse = parseWarehouse(input.warehouse);
  const qty = positive(input.qty, 'qty');
  assertStock(item, movements, warehouse, qty);
  return movement(ctx, { item_id: item.id, type: 'withdraw', warehouse, qty, job_id: input.job_id, note: input.note ?? null, date: input.date ?? null });
}
/** A job part put back where it came from (legacy `flMaintRemovePart`). */
export function planReturn(item: StockItem, input: { warehouse: string; qty: number; job_id?: string | null; consumable_id?: string | null; note?: string | null }, ctx: Ctx): NewMovement {
  return movement(ctx, { item_id: item.id, type: 'return', warehouse: input.warehouse, qty: input.qty, job_id: input.job_id ?? null, consumable_id: input.consumable_id ?? null, note: input.note ?? null });
}

function assertLive(item: StockItem): void {
  if (item.merged_into) conflict(`${item.name} was merged into ${item.merged_into}; use that item`, 'item_merged');
  if (item.deleted_at) conflict(`${item.name} is deleted`, 'item_deleted');
}

// ── Items: create, edit, merge, delete ──

const ITEM_FIELDS = ['name', 'part_no', 'category', 'supplier', 'unit', 'min_qty', 'cost', 'note'] as const;
type ItemFields = Pick<StockItem, typeof ITEM_FIELDS[number]>;
/** Legacy's spellings on the item form, accepted beside ours. */
const ITEM_ALIASES: Record<string, string> = { partNo: 'part_no', minQty: 'min_qty' };
const unalias = (b: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(b).map(([k, v]) => [ITEM_ALIASES[k] ?? k, v]));

function itemFields(b: Record<string, unknown>, partial: boolean): Partial<ItemFields> {
  const out: Partial<ItemFields> = {};
  if (!partial || b.name !== undefined) out.name = required(b.name, 'name');
  if (b.part_no !== undefined) out.part_no = text(b.part_no, 'part_no');
  if (b.category !== undefined) out.category = text(b.category, 'category');
  if (b.supplier !== undefined) out.supplier = text(b.supplier, 'supplier');
  if (b.unit !== undefined) out.unit = text(b.unit, 'unit') ?? 'ชิ้น';
  if (b.min_qty !== undefined) out.min_qty = nonNegative(b.min_qty, 'min_qty') ?? 0;
  if (b.cost !== undefined) out.cost = round2(nonNegative(b.cost, 'cost') ?? 0);
  if (b.note !== undefined) out.note = text(b.note, 'note');
  return out;
}

/** `POST /v1/fleet/stock-items` (legacy `flSaveAddStock`). An opening quantity is a `register` movement in its warehouse. */
export function planItemCreate(items: readonly StockItem[], raw: unknown, ctx: Ctx): { item: StockItem; movements: NewMovement[] } {
  const b = unalias(body(raw));
  assertKnown(b, [...ITEM_FIELDS, 'qty', 'warehouse'], 'A stock item');
  const f = itemFields(b, false);
  assertItemUnique(items, f.name!, f.part_no ?? null);
  const qty = nonNegative(b.qty, 'qty') ?? 0;
  const warehouse = b.warehouse === undefined || b.warehouse === null ? null : parseWarehouse(b.warehouse);
  if (qty > 0 && warehouse === null) bad('warehouse is required with an opening qty');
  const item: StockItem = {
    id: newFleetId('inv'), name: f.name!, part_no: f.part_no ?? null, category: f.category ?? 'general', supplier: f.supplier ?? null, unit: f.unit ?? 'ชิ้น',
    min_qty: f.min_qty ?? 0, cost: f.cost ?? 0, note: f.note ?? null, created_from: null, created_date: ctx.today,
    created_at: ctx.now, created_by: ctx.by, updated_at: ctx.now, deleted_at: null, deleted_by: null, merged_into: null,
  };
  return { item, movements: [movement(ctx, { item_id: item.id, type: 'register', warehouse: qty > 0 ? warehouse : null, qty, note: 'ลงทะเบียนรายการ' })] };
}

/** What `PATCH` may not change, and what to use instead. */
export const ITEM_SERVER_OWNED: Record<string, string> = {
  id: 'an item keeps its id', qty: 'use POST /v1/fleet/stock-items/{id}/adjust (or receive, transfer)', totalQty: 'use POST /v1/fleet/stock-items/{id}/adjust',
  total_qty: 'use POST /v1/fleet/stock-items/{id}/adjust', stocks: 'use POST /v1/fleet/stock-items/{id}/adjust, receive or transfer',
  location: 'it is the warehouse holding the most; move stock with POST /v1/fleet/stock-items/{id}/transfer', primaryLocation: 'it is computed from the stock',
  primary_warehouse: 'it is computed from the stock', primary_warehouse_name: 'it is computed', warehouse: 'use the stock commands', below_min: 'it is computed',
  created_from: 'it is set when a memo registers the item', created_date: 'it is set at creation', created_at: 'it is set at creation', created_by: 'it is set at creation',
  updated_at: 'it is set by every write', deleted_at: 'use DELETE /v1/fleet/stock-items/{id}', deleted_by: 'use DELETE', merged_into: 'use POST /v1/fleet/stock-items/{id}/merge',
  movements: 'movements are appended by the stock commands',
};

/** `PATCH /v1/fleet/stock-items/{id}` (legacy `flSaveInvEdit`): the edit and an `edit` movement listing what changed. */
export function planItemPatch(item: StockItem, items: readonly StockItem[], raw: Record<string, unknown>, ctx: Ctx): { item: StockItem; movement: NewMovement | null } {
  assertLive(item);
  const b = unalias(raw);
  const anyway = bool(b.part_no_anyway, 'part_no_anyway') ?? false;
  delete b.part_no_anyway;
  assertKnown(b, ITEM_FIELDS, 'A stock item');
  const f = itemFields(b, true);
  const next: StockItem = { ...item, ...f };
  const changes: FieldChange[] = [];
  for (const k of ITEM_FIELDS) {
    const from = item[k] === null ? '' : String(item[k]);
    const to = next[k] === null ? '' : String(next[k]);
    if (from !== to) changes.push({ field: k, from, to });
  }
  if (!changes.length) return { item, movement: null };
  if (changes.some((c) => c.field === 'name' || c.field === 'part_no')) assertItemUnique(items, next.name, next.part_no, item.id);
  const pn = changes.find((c) => c.field === 'part_no');
  if (pn && !anyway) {
    conflict(`Changing the part number from ${pn.from || '(none)'} to ${pn.to || '(none)'} may break old memos that name it. Send part_no_anyway: true to go ahead`, 'part_no_change');
  }
  return { item: { ...next, updated_at: ctx.now }, movement: movement(ctx, { item_id: item.id, type: 'edit', warehouse: null, qty: 0, changes }) };
}

/**
 * `POST …/merge` (legacy `invDupMerge`): duplicates of one item (same name and part number) folded
 * into it. Their stock moves over with `merge` movements, their blank fields fill the kept item's
 * blanks, and they are marked `merged_into`. Their own movements stay theirs and are read with the
 * kept item.
 */
export function planMerge(keep: StockItem, drops: readonly StockItem[], movementsOf: (id: string) => readonly Movement[], ctx: Ctx): { keep: StockItem; drops: StockItem[]; movements: NewMovement[] } {
  assertLive(keep);
  if (!drops.length) bad('from_ids must name at least one item to merge');
  const out: NewMovement[] = [];
  let kept = { ...keep };
  for (const d of drops) {
    if (d.id === keep.id) bad('An item cannot be merged into itself');
    assertLive(d);
    if (itemKey(d.name, d.part_no) !== itemKey(keep.name, keep.part_no)) bad(`${d.id} (${d.name} · ${d.part_no ?? '-'}) is not the same item: name and part number must match`);
    for (const [warehouse, qty] of balances(movementsOf(d.id))) {
      if (qty === 0) continue;
      out.push(movement(ctx, { item_id: d.id, type: 'merge', warehouse, qty: -qty, note: `รวมเข้ากับ ${keep.id}` }));
      out.push(movement(ctx, { item_id: keep.id, type: 'merge', warehouse, qty, note: `รวมจากรายการซ้ำ ${d.id}` }));
    }
    kept = {
      ...kept, part_no: kept.part_no ?? d.part_no, cost: kept.cost || d.cost, supplier: kept.supplier ?? d.supplier,
    };
  }
  out.push(movement(ctx, { item_id: keep.id, type: 'merge', warehouse: null, qty: 0, note: `รวมรายการซ้ำ ${drops.length} รายการเข้าด้วยกัน` }));
  return {
    keep: { ...kept, updated_at: ctx.now },
    drops: drops.map((d) => ({ ...d, merged_into: keep.id, deleted_at: ctx.now, deleted_by: ctx.by, updated_at: ctx.now })),
    movements: out,
  };
}

/** `DELETE …`: an item is marked deleted, never erased (decision 6); one still holding stock is refused. */
export function planItemDelete(item: StockItem, movements: readonly Movement[], ctx: Ctx): StockItem {
  assertLive(item);
  const held = [...balances(movements)].filter(([, q]) => q !== 0);
  if (held.length) conflict(`${item.name} still holds ${held.map(([w, q]) => `${q} at ${warehouseName(w)}`).join(', ')}; adjust it to 0 first`, 'stock_not_empty');
  return { ...item, deleted_at: ctx.now, deleted_by: ctx.by, updated_at: ctx.now };
}

/** Supplier suggestions (legacy `memoPopulateSupplierList`): every supplier on a memo or an item, once, sorted. */
export function supplierList(names: readonly (string | null)[]): string[] {
  const seen = new Map<string, string>();
  for (const n of names) { const t = (n ?? '').trim(); if (t && !seen.has(t)) seen.set(t, t); }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

// ── Consumables (legacy `flConsumeSubmit`, `flConsumeDelete`) ──

export type Consumable = {
  id: string; date: string; item_id: string; item_name: string; unit: string; qty: number; unit_cost: number; cost: number;
  warehouse: string; boat_id: string; engine_id: string | null; engine_label: string | null; drawn_by: string | null; note: string | null;
  created_at: string; created_by: string | null; voided_at: string | null; voided_by: string | null;
};

/**
 * `POST /v1/fleet/consumables`. Refused: no item, a quantity below 1 or not whole, no boat. Drawing
 * more than the warehouse holds is legacy's confirm, `allow_negative: true` (decision 7).
 */
export function planConsumable(item: StockItem | undefined, movements: readonly Movement[], raw: unknown, ctx: Ctx, boatExists: (id: string) => boolean): { consumable: Consumable; movement: NewMovement } {
  const b = body(raw);
  const alias: Record<string, string> = { itemId: 'item_id', boatId: 'boat_id', engineId: 'engine_id', engineLabel: 'engine_label', location: 'warehouse' };
  const x = Object.fromEntries(Object.entries(b).map(([k, v]) => [alias[k] ?? k, v]));
  assertKnown(x, ['item_id', 'warehouse', 'qty', 'boat_id', 'engine_id', 'engine_label', 'date', 'by', 'note', 'allow_negative'], 'A consumable');
  required(x.item_id, 'item_id', 'item_id is required: pick an item');
  if (!item) notFound(`Stock item ${String(x.item_id)} not found`);
  assertLive(item!);
  const qty = number(x.qty, 'qty');
  if (qty === null || qty < 1 || !Number.isInteger(qty)) bad('qty must be a whole number, at least 1');
  const boat = required(x.boat_id, 'boat_id', 'boat_id is required: pick a boat');
  if (!boatExists(boat)) bad(`boat_id ${boat} is not a boat (GET /v1/boats)`);
  const warehouse = parseWarehouse(x.warehouse);
  const have = qtyAt(movements, warehouse);
  if (qty! > have && !(bool(x.allow_negative, 'allow_negative') ?? false)) {
    conflict(`${warehouseName(warehouse)} has only ${have} ${item!.unit} of ${item!.name} (drawing ${qty}); send allow_negative: true to draw it below zero`, 'stock_short',
      { short: [{ item_id: item!.id, warehouse, have, asked: qty }] });
  }
  const id = newFleetId('cons');
  const date = isoDate(x.date, 'date') ?? ctx.today;
  const engineLabel = text(x.engine_label, 'engine_label');
  const note = text(x.note, 'note');
  const drawnBy = text(x.by, 'by');
  const consumable: Consumable = {
    id, date, item_id: item!.id, item_name: item!.name, unit: item!.unit, qty: qty!, unit_cost: item!.cost, cost: round2(qty! * item!.cost), warehouse,
    boat_id: boat, engine_id: text(x.engine_id, 'engine_id'), engine_label: engineLabel, drawn_by: drawnBy, note,
    created_at: ctx.now, created_by: ctx.by, voided_at: null, voided_by: null,
  };
  const mv = movement(ctx, {
    item_id: item!.id, type: 'withdraw', warehouse, qty: qty!, date, consumable_id: id, by: drawnBy ?? 'ระบบ',
    note: `เบิกของใช้/น้ำมัน → ${boat}${engineLabel ? ` · ${engineLabel}` : ''}${note ? ` · ${note}` : ''}`,
  });
  return { consumable, movement: mv };
}

/** Voiding a draw puts the stock back with a `return` movement; the record and its history stay (decision 6). */
export function planConsumableVoid(c: Consumable, ctx: Ctx): { consumable: Consumable; movement: NewMovement } {
  if (c.voided_at) conflict(`This draw was already voided on ${c.voided_at.slice(0, 10)}`, 'already_voided');
  return {
    consumable: { ...c, voided_at: ctx.now, voided_by: ctx.by },
    movement: movement(ctx, { item_id: c.item_id, type: 'return', warehouse: c.warehouse, qty: c.qty, consumable_id: c.id, note: `คืนของ (ยกเลิกการเบิก ${c.date})` }),
  };
}

export function parseConsumableQuery(q: Record<string, unknown>): { month?: string; boat_id?: string; voided?: boolean } {
  const out: { month?: string; boat_id?: string; voided?: boolean } = {};
  if (q.month !== undefined) out.month = typeof q.month === 'string' && /^\d{4}-\d{2}$/.test(q.month) ? q.month : bad('month must be YYYY-MM');
  if (typeof q.boat_id === 'string' && q.boat_id) out.boat_id = q.boat_id;
  if (q.voided !== undefined) out.voided = q.voided === 'true' ? true : q.voided === 'false' ? false : bad('voided must be true or false');
  return out;
}
export function selectConsumables(list: readonly Consumable[], q: { month?: string; boat_id?: string; voided?: boolean }): Consumable[] {
  return list.filter((c) => (q.month === undefined || c.date.slice(0, 7) === q.month) && (q.boat_id === undefined || c.boat_id === q.boat_id)
    && ((c.voided_at !== null) === (q.voided ?? false)))
    .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
}

export const parseMergeIds = (raw: unknown): string[] => {
  const b = body(raw);
  const ids = b.from_ids ?? b.fromIds;
  if (!Array.isArray(ids) || !ids.length || !ids.every((x) => typeof x === 'string' && x)) bad('from_ids must be a list of stock item ids');
  return [...new Set(ids as string[])];
};

export type { WarehouseId };
