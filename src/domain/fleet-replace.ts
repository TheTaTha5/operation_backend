/**
 * The safety equipment replace wizard (legacy `06-engine-assign.js` `swapDocExecute`): one command
 * that logs a resolved incident, a done job, the purchase memo or the stock withdrawal, retires the old
 * item and installs the new one. Pure, so both stores decide identically (todo/fleet-maintenance-model.md,
 * "Design — extras" 3).
 */
import { assertKnown, bad, bool, conflict, isoDate, newFleetId, nonNegative, notFound, record, round2, text, WAREHOUSES } from './fleet-common.js';
import { assertNoFree, type Incident, type Job, type JobPart, type ProgressLine } from './fleet-jobs.js';
import { balances, movement, type Ctx, type Movement, type NewMovement, type StockItem } from './fleet-stock.js';
import { planMemoCreate, type MemoPlan } from './fleet-memos.js';
import { SAFETY_CATEGORIES, type SafetyItem, type SafetyLog } from './fleet-safety.js';

/** Legacy `SWAP_REASONS`. */
export const REPLACE_REASONS = {
  broken: { label: '🔧 Broken', severity: 'high' },
  expired: { label: '⏱ Expired', severity: 'medium' },
  upgrade: { label: '⬆ Upgrade', severity: 'low' },
  scheduled: { label: '📅 Scheduled PM', severity: 'low' },
  lost: { label: '⚠ Lost / Missing', severity: 'high' },
} as const;
type Reason = keyof typeof REPLACE_REASONS;

export type ReplaceContext = Ctx & {
  boat: { id: string; name: string; pier: string | null };
  /** The stock item picked (inventory mode) and its movements. */
  stock?: { item: StockItem | undefined; movements: readonly Movement[] };
  incidents: readonly { id: string; no: string }[];
  jobs: readonly { id: string; no: string }[];
  memoNoTaken: (no: string) => boolean;
  items: readonly StockItem[];
};
export type ReplacePlan = {
  incident: Incident; job: Job; memo: MemoPlan | null; items: StockItem[]; movements: NewMovement[];
  old_item: SafetyItem; new_item: SafetyItem; logs: SafetyLog[];
};

/** Legacy's `setMonth(+n)` on a date (an overflow rolls into the next month, as JS does). */
const addMonths = (date: string, months: number): string => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + months, d)).toISOString().slice(0, 10);
};
const noEmoji = (label: string): string => label.replace(/^[^\s]+\s/, '');
const no = (v: unknown, name: string, message: string): string => {
  const t = text(v, name) ?? bad(message);
  return t.length <= 32 ? t : bad(`${name} must be at most 32 characters`);
};

/**
 * `POST /v1/fleet/safety/{id}/replace`. Legacy's confirms become flags: `allow_negative` (no stock left)
 * and `serial_anyway` (no new serial). Numbers are the client's (decision 4).
 */
export function planReplace(old: SafetyItem, raw: unknown, ctx: ReplaceContext): ReplacePlan {
  const b = record(raw);
  assertKnown(b, ['reason', 'description', 'date', 'source', 'item_id', 'warehouse', 'brand', 'model', 'supplier', 'price', 'serial', 'install_date', 'installer',
    'labour', 'incident_no', 'job_no', 'memo_no', 'expiry_date', 'allow_negative', 'serial_anyway'], 'A replacement');
  if (old.status === 'replaced') conflict(`${old.name} is already replaced`, 'already_replaced');
  const reasonKey = (b.reason === undefined ? 'broken' : b.reason) as Reason;
  if (!(reasonKey in REPLACE_REASONS)) bad(`reason must be one of ${Object.keys(REPLACE_REASONS).join(', ')}`);
  const reason = REPLACE_REASONS[reasonKey];
  const source = b.source === undefined ? 'inventory' : b.source === 'inventory' || b.source === 'buy' ? b.source : bad('source must be inventory or buy');
  const description = text(b.description, 'description');
  const date = isoDate(b.date, 'date') ?? ctx.today;
  const installDate = isoDate(b.install_date, 'install_date') ?? date;
  const installer = text(b.installer, 'installer');
  const labour = round2(nonNegative(b.labour, 'labour') ?? 0);
  const serial = text(b.serial, 'serial');
  const incNo = no(b.incident_no, 'incident_no', 'incident_no is required: the incident number (INC-…)');
  const mjNo = no(b.job_no, 'job_no', 'job_no is required: the job number (MJ-…)');
  assertNoFree(incNo, ctx.incidents);
  assertNoFree(mjNo, ctx.jobs);
  const cat = SAFETY_CATEGORIES[old.category as keyof typeof SAFETY_CATEGORIES] ?? { label: old.category };
  const boatName = ctx.boat.name;
  const pierWarehouse = ctx.boat.pier === 'panwa' ? 'panwa' : 'tublamu';
  const movements: NewMovement[] = [];
  const items: StockItem[] = [];
  const parts: JobPart[] = [];
  let memo: MemoPlan | null = null;
  let brand = old.brand, model = old.model;
  let partLine: string;

  if (source === 'inventory') {
    if (b.item_id === undefined || b.item_id === null || b.item_id === '') bad('item_id is required: pick a stock item, or send source: "buy" (Please pick an inventory item or switch to "Buy new")');
    const item = ctx.stock?.item ?? notFound(`Stock item ${String(b.item_id)} not found`);
    const stock = balances(ctx.stock!.movements);
    const warehouse = b.warehouse !== undefined && b.warehouse !== null && b.warehouse !== ''
      ? WAREHOUSES.find((w) => w.id === b.warehouse || w.name === b.warehouse)?.id ?? bad('warehouse must be one of tublamu, panwa, ranong')
      : (stock.get(pierWarehouse) ?? 0) >= 1 ? pierWarehouse
        : WAREHOUSES.find((w) => (stock.get(w.id) ?? 0) >= 1)?.id ?? WAREHOUSES.find((w) => stock.has(w.id))?.id ?? pierWarehouse;
    const have = stock.get(warehouse) ?? 0;
    if (have < 1 && !(bool(b.allow_negative, 'allow_negative') ?? false)) {
      conflict(`"${item.name}" has ${have} in stock at ${WAREHOUSES.find((w) => w.id === warehouse)!.name}: send allow_negative: true to proceed and go below zero`, 'stock_short',
        { short: [{ item_id: item.id, warehouse, have, asked: 1 }] });
    }
    const label = WAREHOUSES.find((w) => w.id === warehouse)!.name;
    movements.push(movement(ctx, { item_id: item.id, type: 'withdraw', warehouse, qty: 1, date, by: 'ระบบ', note: `Replace ${cat.label} on ${boatName} · ${mjNo}` }));
    parts.push({ id: newFleetId('p'), inv_id: item.id, name: item.name, qty: 1, unit: item.unit, cost: item.cost, location: label, date, late: false, late_by: null });
    partLine = `📦 เบิก ${item.name || 'parts'} จาก Inventory`;
  } else {
    // The wizard's fields start as the old item's (legacy `newBrand: it.brand`).
    brand = b.brand === undefined ? old.brand : text(b.brand, 'brand');
    model = b.model === undefined ? old.model : text(b.model, 'model');
    if (!brand && !model) bad('brand or model is required for a purchase (Please fill brand or model for new purchase)');
    const price = round2(nonNegative(b.price, 'price') ?? 0);
    const memoNo = no(b.memo_no, 'memo_no', 'memo_no is required: the purchase memo number (MO-…)');
    const name = `${brand ?? ''} ${model ?? ''}`.trim() || cat.label;
    const item: StockItem = {
      id: newFleetId('inv'), name, part_no: null, category: 'safety', supplier: text(b.supplier, 'supplier'), unit: 'ชิ้น', min_qty: 0, cost: price,
      note: `Auto-created via Replace wizard (${incNo})`, created_from: incNo, created_date: date, created_at: ctx.now, created_by: ctx.by, updated_at: ctx.now,
      deleted_at: null, deleted_by: null, merged_into: null,
    };
    items.push(item);
    movements.push(movement(ctx, { item_id: item.id, type: 'register', warehouse: pierWarehouse, qty: 0, date, by: 'ระบบ', note: `+ สร้างจาก Replace wizard · ${incNo}` }));
    memo = planMemoCreate({
      no: memoNo, title: `สั่งซื้อ ${cat.label} · ${brand ?? ''} ${model ?? ''}`.trim(), boat_id: old.boat_id, memo_type: 'parts', from: 'ท่าเรือภูเก็ต', to: 'กรรมการผู้จัดการ',
      cc: 'ผู้จัดการแผนกบัญชี', memo_date: date, vat_enabled: true, vat_rate: 7, ref_note: `Replace ${cat.label} via ${incNo} (${mjNo})`,
      lines: [{ name, qty: 1, price, part_no: null, item_id: item.id, unit: 'ชิ้น', from_inventory: true }],
    }, { ...ctx, items: [...ctx.items, item], noTaken: ctx.memoNoTaken });
    // The job carries the purchase at its price (legacy's stored cost); the memo is not linked, so nothing counts twice.
    parts.push({ id: newFleetId('p'), inv_id: null, name, qty: 1, unit: 'ชิ้น', cost: price, location: null, date, late: false, late_by: null });
    partLine = `📋 สร้าง Memo ${memoNo} · สั่งซื้อ ${brand ?? ''} ${model ?? ''}`.trim();
  }
  if (labour > 0) parts.push({ id: newFleetId('p'), inv_id: null, name: 'ค่าแรง', qty: 1, unit: null, cost: labour, location: null, date: installDate, late: false, late_by: null });
  if (!serial && !(bool(b.serial_anyway, 'serial_anyway') ?? false)) conflict('No serial number entered: send serial_anyway: true to proceed without one', 'no_serial');

  const line = (d: string, t: string): ProgressLine => ({ date: d, text: t, by: 'ระบบ', created_on: d !== ctx.today ? ctx.today : null });
  const incidentId = newFleetId('inc');
  const jobId = newFleetId('mj');
  const priority = reason.severity === 'high' ? 5 : reason.severity === 'medium' ? 3 : 2;
  const incident: Incident = {
    id: incidentId, no: incNo, boat_id: old.boat_id, date, time: null, title: `เปลี่ยน ${cat.label} · ${noEmoji(reason.label)}`,
    detail: description ?? `${reason.label} · ${cat.label} (${old.name})`, remark: `Safety item: ${old.name || cat.label} · SN ${old.serial || '—'}`,
    priority, severity: reason.severity === 'high' ? 'critical' : reason.severity, status: 'resolved', job_id: jobId, related_job_ids: [], closed_on: null,
    quick_fix: false, resolved_on: date,
    damaged_assets: [{ type: 'safety', asset_id: old.id, label: `${cat.label} · ${old.name}${old.serial ? ` · SN ${old.serial}` : ''}`, swapped: false, swapped_to: null, swapped_on: null }],
    progress_log: [
      line(date, `เปิด Incident จาก Replace wizard · ${reason.label} · ${cat.label}`),
      line(date, `+ สร้าง Job ${mjNo} · เปลี่ยน ${cat.label}`),
      line(date, memo ? `📋 สร้าง Memo ${memo.memo.no} · สั่งซื้อของใหม่` : '📦 เบิกจาก Inventory'),
      line(date, `✓ ติดตั้งของใหม่เสร็จ · SN ${serial || '—'} · ปิด Incident`),
    ],
  };
  const job: Job = {
    id: jobId, no: mjNo, boat_id: old.boat_id, type: 'corrective', title: `เปลี่ยน ${cat.label}${old.location ? ` · ${old.location}` : ''}`,
    detail: `Replace ${cat.label} via wizard · old SN ${old.serial || '—'} → new SN ${serial || '—'}${description ? ` · ${description}` : ''}`, location: old.location,
    status: 'done', start_date: date, end_date: installDate, incident_id: incidentId, boat_status: null, boat_status_reason: null, set_fixing: false, outcome: null,
    close_note: null, awaiting_invoice: false, parent_project_id: null, legacy_cost: null, board_lane: null, owner: null, due_date: null, parked_on: null,
    pinned: false, pinned_on: null,
    assets: [{ type: 'safety', asset_id: old.id, label: `${cat.label} · ${old.name}`, detail: '', status: null, added_on: null }],
    parts, steps: [],
    progress_log: [
      line(date, `+ เปิด Job ${mjNo} จาก ${incNo} · เปลี่ยน ${cat.label}`),
      line(date, partLine),
      line(installDate, `✓ ติดตั้งเสร็จ · ${installer ? `โดย ${installer}` : 'self-install'} · ปิดงาน`),
    ],
  };
  for (const m of movements) if (m.type === 'withdraw') m.job_id = jobId;

  const nextPm = addMonths(installDate, 1);
  const newItem: SafetyItem = {
    id: newFleetId('sf'), boat_id: old.boat_id, category: old.category, name: old.name, brand, model, serial, qty: old.qty || 1, install_date: installDate,
    expiry_date: b.expiry_date === undefined ? old.expiry_date : isoDate(b.expiry_date, 'expiry_date'), next_pm: nextPm, last_inspect: installDate, status: 'active',
    location: old.location, note: old.note ? `${old.note} · replaces ${old.serial || 'old item'}` : `Replaces ${old.serial || 'old item'}`, created_at: ctx.now, updated_at: ctx.now,
    inspections: [{ id: newFleetId('insp'), date: installDate, inspector: installer ?? 'ระบบ', result: 'pass', findings: 'Initial commissioning test · functional check ok', next_due: nextPm, created_at: ctx.now, created_by: ctx.by }],
  };
  return {
    incident, job, memo, items, movements,
    old_item: { ...old, status: 'replaced', updated_at: ctx.now }, new_item: newItem,
    logs: [
      { item_id: old.id, date, type: 'replace', desc: `Replaced via ${mjNo} (${incNo}) · reason: ${noEmoji(reason.label)} · new SN ${serial || '—'}` },
      { item_id: newItem.id, date: installDate, type: 'install', desc: `+ ติดตั้งใหม่จาก ${mjNo} · replaces SN ${old.serial || '—'}${installer ? ` · by ${installer}` : ''}` },
    ],
  };
}
