/**
 * Purchase memos (legacy `fleet_memos`, `05-fleet.js` `flSaveMemo`, `flAdvanceMemo`, `flSaveApprove`,
 * `flSaveReceive`, `memoShortClose`, `flCancelMemo`; todo/fleet-maintenance-model.md, "Design — part
 * B"). Pure, so both stores decide identically.
 *
 * Copied from legacy (decision 3): any `fleet` editor approves, naming the approver in a typed box;
 * "ordered" and "paid" flip the status and keep what legacy's columns hold. Kept here where legacy
 * loses them: the history, the receipt rounds, the cancel reason, the short close, each line's
 * received quantity. Fixed (decision 6): a cancel after receipt takes back the stock it brought.
 */
import {
  assertKnown, bad, bool, conflict, isoDate, newFleetId, nonNegative, number, parseWarehouse, record, required, round2, text, WAREHOUSES, warehouseName,
} from './fleet-common.js';
import { movement, pickByName, sameName, type Ctx, type Movement, type NewMovement, type StockItem } from './fleet-stock.js';

export const MEMO_TYPES = ['parts', 'labor', 'mixed'] as const;
export type MemoType = typeof MEMO_TYPES[number];
export const MEMO_STATUSES = ['pending_approval', 'approved', 'ordered', 'received', 'paid', 'cancelled'] as const;
export type MemoStatus = typeof MEMO_STATUSES[number];
/** Legacy's categories for a memo with no boat. */
export const GENERAL_CATEGORIES = ['Office', 'Marketing', 'Pier', 'Vehicle', 'Staff', 'License', 'Other'] as const;

export type LineSnapshot = { cost: number | null; primary_location: string | null; qty_at_selection: number | null };
export type MemoLine = {
  id: string; name: string; qty: number; price: number; discount_pct: number; category: 'parts' | 'labor' | null; part_no: string | null; unit: string;
  item_id: string | null; from_inventory: boolean; received_qty: number; snapshot: LineSnapshot | null;
};
export type ShortClose = { date: string; by: string | null; missing: { name: string; left: number; unit: string }[]; cut: number };
export type Memo = {
  id: string; no: string; title: string; boat_id: string | null; memo_type: MemoType; scope: string | null; general_category: string | null;
  proposer: string | null; from: string | null; to: string | null; cc: string | null; ref_note: string | null; supplier: string | null; note: string | null;
  memo_date: string; job_id: string | null; project_id: string | null;
  status: MemoStatus; current_step: number; vat_enabled: boolean; vat_rate: number; discount_pct: number; discount_amt: number;
  subtotal: number; discount: number; after_discount: number; vat: number; amount: number; ordered_amount: number | null;
  approved_by: string | null; approved_date: string | null; approve_note: string | null; approved_login: string | null;
  ordered_date: string | null; ordered_by: string | null; received_date: string | null; received_by: string | null;
  received_warehouse: string | null; received_summary: string | null; paid_date: string | null; paid_by: string | null; paid_via: string | null;
  short_closed: ShortClose | null; cancel_reason: string | null; cancelled_by: string | null; cancelled_at: string | null;
  created_at: string; created_by: string | null; updated_at: string; lines: MemoLine[];
};
export type MemoHistoryType = 'create' | 'edit' | 'approve' | 'order' | 'receive' | 'short_close' | 'pay' | 'cancel';
export type MemoHistory = { memo_id: string; type: MemoHistoryType; at: string; by: string | null; note: string | null };
export type ReceiptLine = { line_id: string; name: string; qty: number; unit: string };
export type MemoReceipt = { id: string; memo_id: string; date: string; by: string | null; warehouse: string; note: string | null; lines: ReceiptLine[]; created_at: string };

// ── Rules shared by the screens (legacy `_memoIsPart`, `memoRecvState`, `_memoTotals`) ──

/** A parts line goes into stock; a labor line does not. A line with no category takes the memo's type. */
export const isPart = (line: Pick<MemoLine, 'category'>, memo: Pick<Memo, 'memo_type'>): boolean => (line.category ?? memo.memo_type ?? 'parts') !== 'labor';
export const lineLeft = (line: Pick<MemoLine, 'qty' | 'received_qty'>): number => Math.max(0, round2(line.qty - line.received_qty));
/** Labor-only memos skip ordering and receiving (legacy `flAdvanceMemo`). */
export const laborOnly = (m: Pick<Memo, 'memo_type' | 'lines'>): boolean =>
  m.memo_type === 'labor' || (m.memo_type === 'mixed' && !m.lines.some((l) => (l.category ?? 'parts') === 'parts'));

export function receiveState(m: Pick<Memo, 'memo_type' | 'lines'>): { n: number; done: number; left: number; any: boolean; full: boolean } {
  const parts = m.lines.filter((l) => isPart(l, m));
  const done = parts.filter((l) => lineLeft(l) <= 0).length;
  return { n: parts.length, done, left: parts.length - done, any: parts.some((l) => l.received_qty > 0), full: parts.length > 0 && done === parts.length };
}

export type Totals = Pick<Memo, 'subtotal' | 'discount' | 'after_discount' | 'vat' | 'amount'>;
/**
 * Legacy's formula: line gross = qty × price, less the line's discount %; then the memo's discount
 * (round(after-line × pct / 100) + a fixed amount); VAT at the rate, to the satang, when enabled.
 * `qtyOf` decides the quantity: the form counts an empty or 0 qty as 1 (`memoCalcTotal`), a short
 * close counts what was received (`_memoTotals`).
 */
export function memoTotals(m: Pick<Memo, 'lines' | 'discount_pct' | 'discount_amt' | 'vat_enabled' | 'vat_rate'>, qtyOf: (l: MemoLine) => number = (l) => l.qty || 1): Totals {
  let sub = 0; let lineDisc = 0;
  for (const l of m.lines) {
    const gross = qtyOf(l) * l.price;
    sub += gross;
    lineDisc += gross * (l.discount_pct / 100);
  }
  const memoDisc = Math.round((sub - lineDisc) * m.discount_pct / 100) + m.discount_amt;
  const discount = lineDisc + memoDisc;
  const after = Math.max(0, sub - discount);
  const vat = m.vat_enabled ? Math.round(after * m.vat_rate / 100 * 100) / 100 : 0;
  return { subtotal: round2(sub), discount: round2(discount), after_discount: round2(after), vat: round2(vat), amount: round2(after + vat) };
}

// ── Input ──

const ALIASES: Record<string, string> = {
  subject: 'title', boatId: 'boat_id', memoType: 'memo_type', generalCategory: 'general_category', refNote: 'ref_note', createdDate: 'memo_date', created_date: 'memo_date',
  date: 'memo_date', maintId: 'job_id', maint_id: 'job_id', projectId: 'project_id', vatEnabled: 'vat_enabled', vatRate: 'vat_rate', discountPct: 'discount_pct',
  discountAmt: 'discount_amt', items: 'lines',
};
const LINE_ALIASES: Record<string, string> = {
  partNo: 'part_no', invId: 'item_id', inv_id: 'item_id', fromInventory: 'from_inventory', discountPct: 'discount_pct', autoRegister: 'auto_register',
  inventorySnapshot: 'snapshot', recvQty: 'received_qty',
};
const unalias = (b: Record<string, unknown>, map: Record<string, string>) => Object.fromEntries(Object.entries(b).map(([k, v]) => [map[k] ?? k, v]));
const MEMO_FIELDS = ['no', 'title', 'boat_id', 'memo_type', 'scope', 'general_category', 'proposer', 'from', 'to', 'cc', 'ref_note', 'supplier', 'note', 'memo_date',
  'job_id', 'project_id', 'vat_enabled', 'vat_rate', 'discount_pct', 'discount_amt', 'lines'] as const;

export type LineInput = Omit<MemoLine, 'received_qty'> & { auto_register: boolean; existing: boolean };
type MemoInput = Partial<Omit<Memo, 'lines'>> & { lines?: LineInput[] };

function parseLines(value: unknown, memoType: MemoType, current: readonly MemoLine[]): LineInput[] {
  if (!Array.isArray(value)) bad('lines must be a list');
  const ids = new Set<string>();
  return (value as unknown[]).map((raw, i) => {
    const l = unalias(record(raw, `lines[${i}]`), LINE_ALIASES);
    assertKnown(l, ['id', 'name', 'qty', 'price', 'discount_pct', 'category', 'part_no', 'unit', 'item_id', 'from_inventory', 'auto_register', 'snapshot', 'received_qty', 'left', 'price_mismatch'], `lines[${i}]`);
    const id = text(l.id, `lines[${i}].id`);
    const was = id === null ? undefined : current.find((c) => c.id === id) ?? bad(`lines[${i}].id ${id} is not a line of this memo; leave id out for a new line`);
    if (id !== null) { if (ids.has(id)) bad(`lines names ${id} twice`); ids.add(id); }
    if (l.received_qty !== undefined && was && Number(l.received_qty) !== was.received_qty) bad(`lines[${i}].received_qty cannot be changed here: use POST /v1/fleet/memos/{id}/receive`);
    const category = l.category === undefined || l.category === null || l.category === '' ? null
      : l.category === 'labour' ? 'labor' : l.category === 'parts' || l.category === 'labor' ? l.category : bad(`lines[${i}].category must be parts or labor`);
    if (memoType !== 'mixed' && category !== null && category !== memoType) bad(`lines[${i}].category must be ${memoType} on a ${memoType} memo (or a mixed memo)`);
    const snap = l.snapshot === undefined || l.snapshot === null ? null : record(l.snapshot, `lines[${i}].snapshot`);
    return {
      id: id ?? newFleetId('ml'), name: required(l.name, `lines[${i}].name`), qty: nonNegative(l.qty, `lines[${i}].qty`) ?? 1,
      price: round2(nonNegative(l.price, `lines[${i}].price`) ?? 0),
      discount_pct: (() => { const d = nonNegative(l.discount_pct, `lines[${i}].discount_pct`) ?? 0; return d <= 100 ? d : bad(`lines[${i}].discount_pct must be 0 to 100`); })(),
      category: memoType === 'mixed' ? (category ?? 'parts') : memoType, part_no: text(l.part_no, `lines[${i}].part_no`), unit: text(l.unit, `lines[${i}].unit`) ?? 'ชิ้น',
      item_id: text(l.item_id, `lines[${i}].item_id`), from_inventory: bool(l.from_inventory, `lines[${i}].from_inventory`) ?? false,
      auto_register: bool(l.auto_register, `lines[${i}].auto_register`) ?? true,
      snapshot: snap && {
        cost: number(snap.cost, 'snapshot.cost'), primary_location: text(snap.primary_location ?? snap.primaryLocation, 'snapshot.primary_location'),
        qty_at_selection: number(snap.qty_at_selection ?? snap.qtyAtSelection, 'snapshot.qty_at_selection'),
      },
      existing: was !== undefined,
    };
  });
}

/** The fields of a create or an edit. `current` is the memo being edited (its lines keep their ids). */
export function parseMemoInput(raw: Record<string, unknown>, current?: Memo): MemoInput {
  const b = unalias(raw, ALIASES);
  assertKnown(b, MEMO_FIELDS, 'A memo');
  const out: MemoInput = {};
  if (!current) out.no = required(b.no, 'no', 'no is required: the memo number (MO-…), as legacy numbers it');
  else if (b.no !== undefined && text(b.no, 'no') !== current.no) bad('no cannot be changed: a memo keeps its number');
  if (!current || b.title !== undefined) out.title = required(b.title, 'title', 'title is required (เรื่อง)');
  const memoType = b.memo_type === undefined ? current?.memo_type ?? 'parts'
    : (MEMO_TYPES as readonly unknown[]).includes(b.memo_type) ? b.memo_type as MemoType : bad(`memo_type must be one of ${MEMO_TYPES.join(', ')}`);
  if (!current || b.memo_type !== undefined) out.memo_type = memoType;
  if (!current || b.scope !== undefined) {
    out.scope = b.scope === undefined || b.scope === null ? 'vessel' : b.scope === 'vessel' || b.scope === 'general' ? b.scope : bad('scope must be vessel or general');
  }
  for (const k of ['general_category', 'proposer', 'from', 'to', 'cc', 'ref_note', 'supplier', 'note', 'job_id', 'project_id', 'boat_id'] as const) {
    if (b[k] !== undefined) out[k] = text(b[k], k);
  }
  if (!current || b.memo_date !== undefined) { const d = isoDate(b.memo_date, 'memo_date'); if (d) out.memo_date = d; else if (current) bad('memo_date is required (YYYY-MM-DD)'); }
  if (b.vat_enabled !== undefined) out.vat_enabled = bool(b.vat_enabled, 'vat_enabled');
  if (b.vat_rate !== undefined) out.vat_rate = nonNegative(b.vat_rate, 'vat_rate') ?? 0;
  if (b.discount_pct !== undefined) { const d = nonNegative(b.discount_pct, 'discount_pct') ?? 0; out.discount_pct = d <= 100 ? d : bad('discount_pct must be 0 to 100'); }
  if (b.discount_amt !== undefined) out.discount_amt = round2(nonNegative(b.discount_amt, 'discount_amt') ?? 0);
  if (b.lines !== undefined) out.lines = parseLines(b.lines, memoType, current?.lines ?? []);
  else if (current && b.memo_type !== undefined && memoType !== 'mixed') out.lines = current.lines.map((l) => ({ ...l, category: memoType, auto_register: false, existing: true }));
  const scope = out.scope ?? current?.scope ?? 'vessel';
  const boat = out.boat_id !== undefined ? out.boat_id : current?.boat_id ?? null;
  if (scope === 'general' && boat !== null) bad('A general memo has no boat: leave boat_id out, or use scope vessel');
  return out;
}

/** What `PATCH` may not change, and what to use instead. */
export const MEMO_SERVER_OWNED: Record<string, string> = {
  id: 'a memo keeps its id', status: 'use the memo commands (approve, order, receive, short-close, pay, cancel)', currentStep: 'use the memo commands', current_step: 'use the memo commands',
  subtotal: 'it is computed from the lines', discount: 'it is computed from the lines', afterDiscount: 'it is computed', after_discount: 'it is computed', vat: 'it is computed',
  amount: 'it is computed from the lines', ordered_amount: 'it is set by POST /v1/fleet/memos/{id}/short-close', orderedAmount: 'it is set by short-close',
  approved_by: 'use POST /v1/fleet/memos/{id}/approve', approvedBy: 'use approve', approved_date: 'use approve', approvedDate: 'use approve', approve_note: 'use approve',
  approveNote: 'use approve', approved_login: 'it is the login that approved', ordered_date: 'use POST /v1/fleet/memos/{id}/order', ordered_by: 'use order',
  received_date: 'use POST /v1/fleet/memos/{id}/receive', received_by: 'use receive', received_warehouse: 'use receive', receivedLocation: 'use receive', received_summary: 'use receive',
  paid_date: 'use POST /v1/fleet/memos/{id}/pay', paid_by: 'use pay', paid_via: 'use pay', short_closed: 'use short-close', shortClosed: 'use short-close',
  cancel_reason: 'use POST /v1/fleet/memos/{id}/cancel', cancelled_by: 'use cancel', cancelled_at: 'use cancel', created_at: 'it is set at creation', created_by: 'it is set at creation',
  updated_at: 'it is set by every write', history: 'it is written by every change', receipts: 'use receive', receive_state: 'it is computed', labor_only: 'it is computed',
  duplicate_no: 'it is computed', default_warehouse: 'it is computed', version: 'memos are not versioned',
};

export type MemoContext = Ctx & {
  items: readonly StockItem[];
  /** True when another memo already has this number. */
  noTaken: (no: string) => boolean;
};

/** Lines with no stock item register one, or link to the one live item of that name (legacy Phase 3). */
function autoRegister(memo: Memo, lines: readonly LineInput[], ctx: MemoContext): { lines: MemoLine[]; items: StockItem[]; movements: NewMovement[] } {
  const items: StockItem[] = [];
  const movements: NewMovement[] = [];
  const out = lines.map(({ auto_register, existing: _e, ...l }) => {
    const line: MemoLine = { ...l, received_qty: 0 };
    if (!isPart(line, memo) || line.item_id || !auto_register) return line;
    const hit = pickByName([...ctx.items, ...items], line.name, line.part_no);
    if (hit) return { ...line, item_id: hit.id, from_inventory: true };
    const item: StockItem = {
      id: newFleetId('inv'), name: line.name, part_no: line.part_no, category: 'general', supplier: memo.supplier, unit: line.unit, min_qty: 0, cost: line.price,
      note: `สร้างอัตโนมัติจาก Memo ${memo.no}`, created_from: memo.no, created_date: memo.memo_date, created_at: ctx.now, created_by: ctx.by, updated_at: ctx.now,
      deleted_at: null, deleted_by: null, merged_into: null,
    };
    items.push(item);
    movements.push(movement(ctx, { item_id: item.id, type: 'register', warehouse: null, qty: 0, date: memo.memo_date, by: 'ระบบ (auto)', note: `ลงทะเบียนรายการอัตโนมัติจาก Memo ${memo.no}` }));
    return { ...line, item_id: item.id, from_inventory: true };
  });
  return { lines: out, items, movements };
}

const history = (memo: Memo, type: MemoHistoryType, ctx: Ctx, note: string | null): MemoHistory => ({ memo_id: memo.id, type, at: ctx.now, by: ctx.by, note });
const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });

export type MemoPlan = { memo: Memo; items: StockItem[]; movements: NewMovement[]; history: MemoHistory[]; receipt?: MemoReceipt };

/** `POST /v1/fleet/memos` (legacy `flSaveMemo`): `pending_approval`, step 1, numbered by the client. */
export function planMemoCreate(raw: Record<string, unknown>, ctx: MemoContext): MemoPlan {
  const input = parseMemoInput(raw);
  if (ctx.noTaken(input.no!)) conflict(`Memo number ${input.no} is already used; take the next number`, 'memo_no_taken');
  const base: Memo = {
    id: newFleetId('memo'), no: input.no!, title: input.title!, boat_id: input.boat_id ?? null, memo_type: input.memo_type!, scope: input.scope ?? 'vessel',
    general_category: input.general_category ?? null, proposer: input.proposer ?? null, from: input.from ?? null, to: input.to ?? null, cc: input.cc ?? null,
    ref_note: input.ref_note ?? null, supplier: input.supplier ?? null, note: input.note ?? null, memo_date: input.memo_date ?? ctx.today,
    job_id: input.job_id ?? null, project_id: input.project_id ?? null, status: 'pending_approval', current_step: 1,
    vat_enabled: input.vat_enabled ?? true, vat_rate: input.vat_rate ?? (input.vat_enabled === false ? 0 : 7), discount_pct: input.discount_pct ?? 0, discount_amt: input.discount_amt ?? 0,
    subtotal: 0, discount: 0, after_discount: 0, vat: 0, amount: 0, ordered_amount: null,
    approved_by: null, approved_date: null, approve_note: null, approved_login: null, ordered_date: null, ordered_by: null, received_date: null, received_by: null,
    received_warehouse: null, received_summary: null, paid_date: null, paid_by: null, paid_via: null, short_closed: null, cancel_reason: null, cancelled_by: null, cancelled_at: null,
    created_at: ctx.now, created_by: ctx.by, updated_at: ctx.now, lines: [],
  };
  const reg = autoRegister(base, input.lines ?? [], ctx);
  const memo = { ...base, lines: reg.lines };
  Object.assign(memo, memoTotals(memo));
  return { memo, items: reg.items, movements: reg.movements, history: [history(memo, 'create', ctx, 'สร้าง memo')] };
}

/** `PATCH /v1/fleet/memos/{id}` (legacy `flSaveMemo`, edit mode): refused once paid; totals recomputed. */
export function planMemoPatch(memo: Memo, raw: Record<string, unknown>, ctx: Ctx): MemoPlan {
  if (memo.status === 'paid') conflict(`Memo ${memo.no} is paid and cannot be edited`, 'memo_paid');
  const input = parseMemoInput(raw, memo);
  const { lines: inputLines, ...fields } = input;
  const next: Memo = { ...memo, ...fields, updated_at: ctx.now } as Memo;
  if (inputLines) {
    const kept = new Set(inputLines.filter((l) => l.existing).map((l) => l.id));
    const gone = memo.lines.filter((l) => !kept.has(l.id) && l.received_qty > 0);
    if (gone.length) conflict(`Line ${gone.map((l) => l.name).join(', ')} has stock received and cannot be removed`, 'line_received');
    next.lines = inputLines.map(({ auto_register: _a, existing: _e, ...l }) => ({ ...l, received_qty: memo.lines.find((c) => c.id === l.id)?.received_qty ?? 0 }));
  }
  Object.assign(next, memoTotals(next));
  const ch: string[] = [];
  if (memo.title !== next.title) ch.push('เรื่อง');
  if (memo.amount !== next.amount) ch.push(`ยอด ฿${fmt(memo.amount)}→฿${fmt(next.amount)}`);
  if (memo.lines.length !== next.lines.length) ch.push(`รายการ ${memo.lines.length}→${next.lines.length}`);
  if ((memo.supplier ?? '') !== (next.supplier ?? '')) ch.push('supplier');
  if ((memo.note ?? '') !== (next.note ?? '')) ch.push('หมายเหตุ');
  return { memo: next, items: [], movements: [], history: [history(next, 'edit', ctx, `แก้ไข${ch.length ? `: ${ch.join(', ')}` : ''}`)] };
}

const assertStatus = (memo: Memo, allowed: readonly MemoStatus[], what: string): void => {
  if (!allowed.includes(memo.status)) conflict(`Memo ${memo.no} is ${memo.status}; it can be ${what} only when ${allowed.join(' or ')}`, 'memo_status');
};

/** `POST …/approve` (legacy `flSaveApprove`): a typed approver is required; the login is kept beside it. */
export function planApprove(memo: Memo, raw: unknown, ctx: Ctx): MemoPlan {
  const b = unalias(record(raw), { approvedBy: 'approved_by', by: 'approved_by', approvedDate: 'approved_date', date: 'approved_date', approveNote: 'note', approve_note: 'note' });
  assertKnown(b, ['approved_by', 'approved_date', 'note'], 'An approval');
  assertStatus(memo, ['pending_approval'], 'approved');
  const by = required(b.approved_by, 'approved_by', 'approved_by is required: who approved (กรุณาระบุชื่อผู้อนุมัติ)');
  const next: Memo = {
    ...memo, status: 'approved', current_step: 2, approved_by: by, approved_date: isoDate(b.approved_date, 'approved_date') ?? ctx.today,
    approve_note: text(b.note, 'note'), approved_login: ctx.by, updated_at: ctx.now,
  };
  return { memo: next, items: [], movements: [], history: [history(next, 'approve', ctx, `อนุมัติโดย ${by}${next.approve_note ? ` · ${next.approve_note}` : ''}`)] };
}

/** `POST …/order`: parts and mixed memos only; a labor memo goes from approved to paid. */
export function planOrder(memo: Memo, raw: unknown, ctx: Ctx): MemoPlan {
  const b = unalias(record(raw), { orderedDate: 'ordered_date', orderedBy: 'ordered_by' });
  assertKnown(b, ['ordered_date', 'ordered_by'], 'An order');
  assertStatus(memo, ['approved'], 'ordered');
  if (laborOnly(memo)) conflict(`Memo ${memo.no} is labor only: it goes from approved to paid`, 'memo_status');
  const next: Memo = { ...memo, status: 'ordered', current_step: 3, ordered_date: isoDate(b.ordered_date, 'ordered_date'), ordered_by: text(b.ordered_by, 'ordered_by'), updated_at: ctx.now };
  return { memo: next, items: [], movements: [], history: [history(next, 'order', ctx, 'สั่งซื้อ')] };
}

/** Legacy `flMemoWarehouse`: the boat's pier's warehouse, else Tub Lamu. */
export function defaultWarehouse(boat: { name: string; pier: string | null } | undefined): { warehouse: string; warehouse_name: string; why: string } {
  const hit = boat?.pier ? WAREHOUSES.find((w) => w.pier === boat.pier) : undefined;
  if (hit) return { warehouse: hit.id, warehouse_name: hit.name, why: `the home pier of ${boat!.name}` };
  return { warehouse: 'tublamu', warehouse_name: 'คลัง Tub Lamu', why: boat ? 'this memo\'s boat has no pier' : 'this memo has no boat' };
}

export type ReceiveContext = Ctx & { items: readonly StockItem[]; boat?: { name: string; pier: string | null } };

/**
 * `POST …/receive` (legacy `flSaveReceive`, memo mode): what came, line by line; partial rounds
 * allowed. Each parts line's stock goes into one warehouse: its linked item, else the one live item
 * of that name, else a new item. All in → `received`; else the memo stays `ordered`.
 */
export function planReceive(memo: Memo, raw: unknown, ctx: ReceiveContext): MemoPlan {
  const b = unalias(record(raw), { location: 'warehouse', items: 'lines' });
  assertKnown(b, ['warehouse', 'date', 'note', 'lines'], 'A receipt');
  assertStatus(memo, ['ordered'], 'received');
  const warehouse = b.warehouse === undefined || b.warehouse === null ? defaultWarehouse(ctx.boat).warehouse : parseWarehouse(b.warehouse);
  const date = isoDate(b.date, 'date') ?? ctx.today;
  const note = text(b.note, 'note');
  const parts = memo.lines.filter((l) => isPart(l, memo));
  const got = new Map<string, number>();
  if (parts.length) {
    if (!Array.isArray(b.lines)) bad('lines is required: [{line_id, qty}] for what came');
    for (const [i, raw] of (b.lines as unknown[]).entries()) {
      const r = unalias(record(raw, `lines[${i}]`), { id: 'line_id' });
      assertKnown(r, ['line_id', 'qty'], `lines[${i}]`);
      const id = required(r.line_id, `lines[${i}].line_id`);
      const line = memo.lines.find((l) => l.id === id) ?? bad(`lines[${i}].line_id ${id} is not a line of memo ${memo.no}`);
      if (!isPart(line, memo)) bad(`${line.name} is labor and is not received into stock`);
      if (got.has(id)) bad(`lines names ${id} twice`);
      got.set(id, nonNegative(r.qty, `lines[${i}].qty`) ?? 0);
    }
    if (![...got.values()].some((q) => q > 0)) bad('Nothing received: every qty is 0');
  }
  const items: StockItem[] = [];
  const movements: NewMovement[] = [];
  const receipt: MemoReceipt = { id: newFleetId('rc'), memo_id: memo.id, date, by: ctx.by, warehouse, note, lines: [], created_at: ctx.now };
  const lines = memo.lines.map((l) => {
    const qty = got.get(l.id) ?? 0;
    if (qty <= 0) return l;
    receipt.lines.push({ line_id: l.id, name: l.name, qty, unit: l.unit });
    const known = [...ctx.items, ...items];
    let target = l.item_id ? known.find((i) => i.id === l.item_id) : undefined;
    while (target?.merged_into) { const into: string = target.merged_into; target = known.find((i) => i.id === into); }
    // §invIdSafe: a link to an item of another name is a collided id; find it again by name.
    if (target && !sameName(target.name, l.name)) target = pickByName(known, l.name, l.part_no);
    if (!target && !l.item_id) target = pickByName(known, l.name, l.part_no);
    if (!target) {
      target = {
        id: newFleetId('inv'), name: l.name, part_no: l.part_no, category: 'อื่นๆ', supplier: memo.supplier, unit: l.unit, min_qty: 0, cost: l.price,
        note: `สร้างอัตโนมัติจาก ${memo.no}`, created_from: memo.no, created_date: date, created_at: ctx.now, created_by: ctx.by, updated_at: ctx.now,
        deleted_at: null, deleted_by: null, merged_into: null,
      };
      items.push(target);
    }
    movements.push(movement(ctx, { item_id: target.id, type: 'receive', warehouse, qty, date, memo_id: memo.id, note: `จาก ${memo.no}${note ? ` · ${note}` : ''} · @ ${warehouseName(warehouse)}` }));
    return { ...l, item_id: target.id, received_qty: round2(l.received_qty + qty) };
  });
  const next: Memo = { ...memo, lines, received_warehouse: warehouse, updated_at: ctx.now };
  const state = receiveState(next);
  if (state.full || !parts.length) Object.assign(next, { status: 'received', current_step: 4, received_date: date, received_by: ctx.by });
  const summary = receipt.lines.map((r) => `${r.name} ${r.qty} ${r.unit}`).join(', ');
  return {
    memo: next, items, movements, receipt: receipt.lines.length ? receipt : undefined,
    history: [history(next, 'receive', ctx, `รับของ @ ${warehouseName(warehouse)}${summary ? ` · ${summary}` : ''} · ${state.full || !parts.length ? 'ครบแล้ว' : `ครบ ${state.done}/${state.n} รายการ`}`)],
  };
}

/** `POST …/short-close` (legacy `memoShortClose`): accept what came; the totals follow what was received. */
export function planShortClose(memo: Memo, ctx: Ctx): MemoPlan {
  assertStatus(memo, ['ordered'], 'short-closed');
  const state = receiveState(memo);
  if (state.full) conflict(`Memo ${memo.no} has everything; receive it instead`, 'memo_status');
  if (!state.any) conflict(`Nothing has been received on memo ${memo.no} yet`, 'nothing_received');
  if (memo.short_closed) conflict(`Memo ${memo.no} is already short-closed`, 'memo_status');
  const missing = memo.lines.filter((l) => isPart(l, memo) && lineLeft(l) > 0);
  const totals = memoTotals(memo, (l) => (isPart(l, memo) ? l.received_qty : l.qty));
  const old = memo.amount;
  const next: Memo = {
    ...memo, ...totals, ordered_amount: memo.ordered_amount ?? old, status: 'received', current_step: 4, received_date: memo.received_date ?? ctx.today,
    short_closed: { date: ctx.today, by: ctx.by, missing: missing.map((l) => ({ name: l.name, left: lineLeft(l), unit: l.unit })), cut: round2(old - totals.amount) },
    updated_at: ctx.now,
  };
  return { memo: next, items: [], movements: [], history: [history(next, 'short_close', ctx, `ปิดใบทั้งที่ของไม่ครบ · ลดยอด ฿${fmt(round2(old - totals.amount))}`)] };
}

/** `POST …/pay`: from received, or from approved for a labor-only memo. Legacy stores the date, who and how when given. */
export function planPay(memo: Memo, raw: unknown, ctx: Ctx): MemoPlan {
  const b = unalias(record(raw), { paidDate: 'paid_date', paidBy: 'paid_by', paidVia: 'paid_via' });
  assertKnown(b, ['paid_date', 'paid_by', 'paid_via'], 'A payment');
  assertStatus(memo, [laborOnly(memo) ? 'approved' : 'received'], 'paid');
  const next: Memo = {
    ...memo, status: 'paid', current_step: laborOnly(memo) ? 3 : 5, paid_date: isoDate(b.paid_date, 'paid_date'), paid_by: text(b.paid_by, 'paid_by'),
    paid_via: text(b.paid_via, 'paid_via'), updated_at: ctx.now,
  };
  return { memo: next, items: [], movements: [], history: [history(next, 'pay', ctx, 'จ่ายแล้ว')] };
}

/**
 * `POST …/cancel` (legacy `flCancelMemo`): a reason is required; a paid memo cannot be cancelled.
 * Stock this memo brought in is taken back out (`reverse`, decision 6). A warehouse that would go
 * below zero (the stock was used) is `409 stock_short` unless `allow_negative: true`.
 */
export function planCancel(memo: Memo, raw: unknown, ctx: Ctx & { memoMovements: readonly Movement[]; balanceOf: (itemId: string) => Map<string, number>; items: readonly StockItem[] }): MemoPlan {
  const b = record(raw);
  assertKnown(b, ['reason', 'allow_negative'], 'A cancel');
  if (memo.status === 'paid') conflict(`Memo ${memo.no} is paid and cannot be cancelled`, 'memo_paid');
  if (memo.status === 'cancelled') conflict(`Memo ${memo.no} is already cancelled`, 'already_cancelled');
  const reason = required(b.reason, 'reason', 'reason is required (เหตุผลในการยกเลิก)');
  const received = ctx.memoMovements.filter((m) => m.memo_id === memo.id && (m.type === 'receive' || m.type === 'reverse'));
  const net = new Map<string, { item_id: string; warehouse: string; qty: number }>();
  for (const m of received) {
    const key = `${m.item_id}|${m.warehouse}`;
    const was = net.get(key) ?? { item_id: m.item_id, warehouse: m.warehouse!, qty: 0 };
    net.set(key, { ...was, qty: round2(was.qty + m.delta) });
  }
  const back = [...net.values()].filter((x) => x.qty > 0);
  const short = back.map((x) => ({ ...x, have: ctx.balanceOf(x.item_id).get(x.warehouse) ?? 0 })).filter((x) => x.have < x.qty);
  if (short.length && !(bool(b.allow_negative, 'allow_negative') ?? false)) {
    const name = (id: string) => ctx.items.find((i) => i.id === id)?.name ?? id;
    conflict(`Cancelling memo ${memo.no} takes back stock that has been used: ${short.map((x) => `${name(x.item_id)} ${x.have} left at ${warehouseName(x.warehouse)}, ${x.qty} to take back`).join('; ')}. Send allow_negative: true to go below zero`,
      'stock_short', { short: short.map((x) => ({ item_id: x.item_id, warehouse: x.warehouse, have: x.have, asked: x.qty })) });
  }
  const movements = back.map((x) => movement(ctx, { item_id: x.item_id, type: 'reverse', warehouse: x.warehouse, qty: x.qty, memo_id: memo.id, note: `ยกเลิก ${memo.no} · ${reason}` }));
  const next: Memo = { ...memo, status: 'cancelled', cancel_reason: reason, cancelled_by: ctx.by, cancelled_at: ctx.now, updated_at: ctx.now };
  return { memo: next, items: [], movements, history: [history(next, 'cancel', ctx, reason)] };
}

// ── Reads ──

export type MemoListQuery = { status?: MemoStatus; boat_id?: string; job_id?: string; project_id?: string; q?: string; from?: string; to?: string };
export function parseMemoListQuery(q: Record<string, unknown>): MemoListQuery {
  const out: MemoListQuery = {};
  if (q.status !== undefined) out.status = (MEMO_STATUSES as readonly unknown[]).includes(q.status) ? q.status as MemoStatus : bad(`status must be one of ${MEMO_STATUSES.join(', ')}`);
  for (const k of ['boat_id', 'job_id', 'project_id'] as const) if (typeof q[k] === 'string' && q[k]) out[k] = q[k] as string;
  if (typeof q.q === 'string' && q.q.trim()) out.q = q.q.trim().toLowerCase();
  if (q.from !== undefined) out.from = isoDate(q.from, 'from')!;
  if (q.to !== undefined) out.to = isoDate(q.to, 'to')!;
  return out;
}
export function selectMemos(memos: readonly Memo[], q: MemoListQuery): Memo[] {
  return memos.filter((m) => (q.status === undefined || m.status === q.status) && (q.boat_id === undefined || m.boat_id === q.boat_id)
    && (q.job_id === undefined || m.job_id === q.job_id) && (q.project_id === undefined || m.project_id === q.project_id)
    && (q.from === undefined || m.memo_date >= q.from) && (q.to === undefined || m.memo_date <= q.to)
    && (q.q === undefined || `${m.no} ${m.title} ${m.supplier ?? ''}`.toLowerCase().includes(q.q)))
    .sort((a, b) => b.memo_date.localeCompare(a.memo_date) || b.no.localeCompare(a.no) || a.id.localeCompare(b.id));
}

/** The memo as read: what the screens compute from it. */
export function memoView(m: Memo, ctx: { items: ReadonlyMap<string, Pick<StockItem, 'cost'>>; duplicate: boolean }) {
  return {
    ...m,
    lines: m.lines.map((l) => {
      const cost = l.item_id ? ctx.items.get(l.item_id)?.cost : undefined;
      return { ...l, left: isPart(l, m) ? lineLeft(l) : 0, price_mismatch: cost !== undefined && Math.abs(l.price - cost) > 0.5 };
    }),
    receive_state: receiveState(m), labor_only: laborOnly(m), duplicate_no: ctx.duplicate,
  };
}

/** Each memo number used more than once (legacy's MO-077, MO-117), for the list. */
export const duplicateNos = (memos: readonly Pick<Memo, 'no'>[]): Set<string> => {
  const seen = new Map<string, number>();
  for (const m of memos) seen.set(m.no, (seen.get(m.no) ?? 0) + 1);
  return new Set([...seen].filter(([, n]) => n > 1).map(([no]) => no));
};

/** Memos that count as spend (legacy `flMaintCalcCost`'s `CNT`). */
export const SPENT: readonly MemoStatus[] = ['approved', 'received', 'paid'];

/**
 * `GET /v1/fleet/reports/memo-spend`: approved, received and paid memos by supplier, memo type,
 * scope (a general memo by its category) and boat, over memo dates `from..to`.
 */
export function memoSpend(memos: readonly Memo[], from: string | undefined, to: string | undefined) {
  const counted = memos.filter((m) => SPENT.includes(m.status) && (from === undefined || m.memo_date >= from) && (to === undefined || m.memo_date <= to));
  const group = (key: (m: Memo) => string) => {
    const out = new Map<string, { key: string; memos: number; amount: number }>();
    for (const m of counted) { const k = key(m); const g = out.get(k) ?? { key: k, memos: 0, amount: 0 }; out.set(k, { key: k, memos: g.memos + 1, amount: round2(g.amount + m.amount) }); }
    return [...out.values()].sort((a, b) => b.amount - a.amount || a.key.localeCompare(b.key));
  };
  return {
    from: from ?? null, to: to ?? null, memos: counted.length, amount: round2(counted.reduce((s, m) => s + m.amount, 0)),
    by_supplier: group((m) => m.supplier ?? '(none)'), by_type: group((m) => m.memo_type),
    by_scope: group((m) => (m.scope === 'general' ? `general:${m.general_category ?? '(none)'}` : 'vessel')), by_boat: group((m) => m.boat_id ?? '(none)'),
    by_status: group((m) => m.status),
  };
}
