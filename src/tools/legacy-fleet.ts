/**
 * Legacy fleet part B → this service's rows (todo/fleet-maintenance-model.md, "Design — part B",
 * decision 10). Pure: `import-fleet.ts` reads legacy, hands the rows here, and writes what comes back.
 *
 * - The eight spellings of the warehouses map to the three; everything else comes as it is and odd
 *   rows are listed (MO-077 and MO-117 twice, the PRJ-001…007 copies, duplicate stock items).
 * - A movement with no warehouse takes its item's main one. Where an item's movements do not add up
 *   to legacy's stock in a warehouse, an `import` movement makes them match (legacy's stock is what
 *   ops counted; its history has gaps), listed.
 * - A receipt names its memo only in its note (`จาก MO-123`); it is linked when that number is one
 *   memo's, so a later cancel can take the stock back.
 * - Memo totals are kept as legacy stored them (they were approved and paid as such); where the
 *   formula gives another amount the memo is listed.
 */
import { WAREHOUSES } from '../domain/fleet-common.js';
import type { Consumable, FieldChange, MovementType, NewMovement, StockItem } from '../domain/fleet-stock.js';
import { memoTotals, MEMO_STATUSES, type Memo, type MemoLine, type MemoStatus } from '../domain/fleet-memos.js';
import { DOC_STATUSES, PROJECT_STATUSES, type Project, type ProjectDoc, type ProjectLog, type ProjectStatus } from '../domain/fleet-projects.js';
import type { DailyBoat, DailyRequest, DayLock, Extra, FuelPrice, Issue, IssueItem, Meter, Water } from '../domain/fleet-daily.js';
import { INSPECTION_RESULTS, type Inspection, type SafetyItem, type SafetyLog } from '../domain/fleet-safety.js';

type Row = Record<string, unknown>;
export type Listed = { kind: string; id: string; reason: string };

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());
const opt = (v: unknown): string | null => str(v) || null;
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const numOrNull = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const day = (v: unknown): string | null => { const s = str(v).slice(0, 10); return ISO.test(s) ? s : null; };
/** A legacy date-only value as an instant: midnight in Thailand. */
const at = (d: string | null, fallback: string): string => (d ? `${d}T00:00:00+07:00` : fallback);
const json = (v: unknown): unknown => {
  let x = v;
  for (let i = 0; i < 2 && typeof x === 'string'; i++) { try { x = JSON.parse(x); } catch { return null; } }
  return x;
};
const rowId = (pk: unknown): string => `lg_${str(pk).split(':').pop()}`;

/** Legacy's warehouse labels, all eight spellings (`คลังVisit Panwa`, `Visit panda`, …), to the three. */
export function legacyWarehouse(label: unknown): string | null {
  const k = str(label).toLowerCase().replace(/คลัง/g, '').replace(/\s+/g, '');
  if (!k) return null;
  if (k === 'tublamu') return 'tublamu';
  if (k === 'visitpanwa' || k === 'visitpanda' || k === 'panwa') return 'panwa';
  if (k === 'ranong') return 'ranong';
  return null;
}

const HISTORY_SIGN: Record<string, 1 | -1 | 0 | 'signed'> = {
  register: 0, edit: 0, merge: 0, receive: 1, in: 1, 'transfer-in': 1, withdraw: -1, 'transfer-out': -1, adjust_out: -1, adjust: 'signed',
};

export type StockInput = { items: Row[]; stocks: Row[]; history: Row[]; changes: Row[]; memoIdByNo: ReadonlyMap<string, string>; consumableIds: ReadonlySet<string> };
export function mapStock(input: StockInput, now: string, today: string) {
  const listed: Listed[] = [];
  const notes: Record<string, number> = {};
  const note = (k: string, n = 1) => { notes[k] = (notes[k] ?? 0) + n; };
  const items: StockItem[] = [];
  const movements: NewMovement[] = [];
  const keys = new Map<string, string[]>();
  const changesBy = new Map<string, FieldChange[]>();
  for (const c of [...input.changes].sort((a, b) => num(a.idx) - num(b.idx))) {
    const list = changesBy.get(str(c.fleet_inventory_history_id)) ?? [];
    list.push({ field: str(c.field), from: str(c.from), to: str(c.to) });
    changesBy.set(str(c.fleet_inventory_history_id), list);
  }
  for (const r of input.items) {
    const id = str(r.id);
    const created = day(r.createddate);
    const item: StockItem = {
      id, name: str(r.name), part_no: opt(r.partno), category: opt(r.category), supplier: opt(r.supplier), unit: str(r.unit) || 'ชิ้น',
      min_qty: Math.max(0, num(r.minqty)), cost: Math.max(0, round2(num(r.cost))), note: opt(r.note), created_from: opt(r.createdfrom), created_date: created,
      created_at: at(created, now), created_by: null, updated_at: now, deleted_at: null, deleted_by: null, merged_into: null,
    };
    if (!item.name) { listed.push({ kind: 'stock item', id, reason: 'no name: skipped' }); continue; }
    items.push(item);
    const key = `${item.name.toLowerCase()}\u0000${(item.part_no ?? '').toLowerCase()}`;
    keys.set(key, [...(keys.get(key) ?? []), id]);

    // What legacy holds per warehouse (its stocks[]; an item with none holds its qty where it says).
    const target = new Map<string, number>();
    const stockRows = input.stocks.filter((s) => str(s.fleet_inventory_id) === id);
    const main = legacyWarehouse(r.primarylocation) ?? legacyWarehouse(r.location) ?? 'tublamu';
    if (!stockRows.length && num(r.qty) !== 0) target.set(main, num(r.qty));
    for (const s of stockRows) {
      const w = legacyWarehouse(s.location);
      if (!w) { if (num(s.qty) !== 0) listed.push({ kind: 'stock', id, reason: `warehouse "${str(s.location)}" unknown: ${num(s.qty)} left out` }); continue; }
      if (str(s.location) !== WAREHOUSES.find((x) => x.id === w)!.name) note('stock rows with a warehouse spelling mapped');
      target.set(w, round2((target.get(w) ?? 0) + num(s.qty)));
    }

    const got = new Map<string, number>();
    for (const h of input.history.filter((x) => str(x.fleet_inventory_id) === id).sort((a, b) => num(a.idx) - num(b.idx))) {
      const type = str(h.type);
      const sign = HISTORY_SIGN[type];
      if (sign === undefined) { listed.push({ kind: 'movement', id: str(h.row_pk), reason: `type "${type}" unknown: skipped` }); continue; }
      const qty = num(h.qty);
      const delta = sign === 'signed' ? qty : sign * Math.abs(qty);
      let warehouse = legacyWarehouse(h.location);
      if (!warehouse && delta !== 0) { warehouse = main; note('movements with no warehouse, given the item\'s main one'); }
      const no = /MO-\d+/.exec(str(h.note))?.[0];
      const memo = type === 'receive' || type === 'in' ? (no ? input.memoIdByNo.get(no) ?? null : null) : null;
      if ((type === 'receive' || type === 'in') && no && !memo) note('receipts naming a memo number that is not one memo (left unlinked)');
      const consumable = opt(h.consumeid);
      movements.push({
        id: rowId(h.row_pk), item_id: id, date: day(h.date) ?? created ?? today, type: type as MovementType, warehouse: delta === 0 ? (warehouse ?? null) : warehouse,
        delta: round2(delta), note: opt(h.note), by: opt(h.by), memo_id: memo, job_id: opt(h.jobid),
        consumable_id: consumable && input.consumableIds.has(consumable) ? consumable : null,
        changes: type === 'edit' ? changesBy.get(str(h.row_pk)) ?? [] : null, created_at: at(day(h.date), now), created_by: null,
      });
      if (warehouse && delta !== 0) got.set(warehouse, round2((got.get(warehouse) ?? 0) + delta));
    }
    for (const w of new Set([...target.keys(), ...got.keys()])) {
      const diff = round2((target.get(w) ?? 0) - (got.get(w) ?? 0));
      if (diff === 0) continue;
      movements.push({
        id: `lg_import_${id}_${w}`, item_id: id, date: today, type: 'import', warehouse: w, delta: diff,
        note: `นำเข้าจากระบบเดิม: ยอดคงเหลือ ${target.get(w) ?? 0}, ประวัติรวมได้ ${got.get(w) ?? 0}`, by: null, memo_id: null, job_id: null, consumable_id: null, changes: null,
        created_at: now, created_by: null,
      });
      listed.push({ kind: 'stock reconciled', id, reason: `${w}: legacy holds ${target.get(w) ?? 0}, its history adds up to ${got.get(w) ?? 0}; import movement ${diff > 0 ? '+' : ''}${diff}` });
    }
  }
  for (const [, ids] of keys) if (ids.length > 1) listed.push({ kind: 'duplicate stock item', id: ids.join(', '), reason: 'same name and part number (merge with POST /v1/fleet/stock-items/{id}/merge)' });
  return { items, movements, listed, notes };
}

export type MemoInput = { memos: Row[]; lines: Row[]; boats: ReadonlySet<string>; projects: ReadonlySet<string>; items: ReadonlySet<string> };
export function mapMemos(input: MemoInput, now: string) {
  const listed: Listed[] = [];
  const memos: Memo[] = [];
  const count = new Map<string, number>();
  for (const r of input.memos) count.set(str(r.no), (count.get(str(r.no)) ?? 0) + 1);
  for (const [no, n] of count) if (n > 1) listed.push({ kind: 'duplicate memo number', id: no, reason: `used by ${n} memos; imported as they are` });
  for (const r of input.memos) {
    const id = str(r.id);
    const status = str(r.status) as MemoStatus;
    if (!(MEMO_STATUSES as readonly string[]).includes(status)) { listed.push({ kind: 'memo', id, reason: `status "${status}" unknown: skipped` }); continue; }
    const date = day(r.createddate);
    if (!date) { listed.push({ kind: 'memo', id, reason: 'no memo date: skipped' }); continue; }
    let boat = opt(r.boatid);
    if (boat && !input.boats.has(boat)) { listed.push({ kind: 'memo', id, reason: `boat ${boat} unknown: left out` }); boat = null; }
    let project = opt(r.projectid);
    if (project && !input.projects.has(project)) { listed.push({ kind: 'memo', id, reason: `project ${project} unknown: left out` }); project = null; }
    const memoType = (['parts', 'labor', 'mixed'] as const).find((t) => t === str(r.memotype)) ?? 'parts';
    const full = status === 'received' || status === 'paid';
    const lines: MemoLine[] = input.lines.filter((l) => str(l.fleet_memos_id) === id).sort((a, b) => num(a.idx) - num(b.idx)).map((l) => {
      let item = opt(l.invid);
      if (item && !input.items.has(item)) { listed.push({ kind: 'memo line', id: `${str(r.no)} ${str(l.name)}`, reason: `stock item ${item} unknown: left unlinked` }); item = null; }
      const category = str(l.category) === 'labor' || str(l.category) === 'labour' ? 'labor' : str(l.category) === 'parts' ? 'parts' : null;
      const qty = Math.max(0, num(l.qty));
      const isPart = (category ?? memoType) !== 'labor';
      const snap = numOrNull(l.inventorysnapshot_cost) !== null || opt(l.inventorysnapshot_primarylocation)
        ? { cost: numOrNull(l.inventorysnapshot_cost), primary_location: opt(l.inventorysnapshot_primarylocation), qty_at_selection: numOrNull(l.inventorysnapshot_qtyatselection) } : null;
      return {
        id: rowId(l.row_pk), name: str(l.name) || '(no name)', qty, price: Math.max(0, round2(num(l.price))), discount_pct: Math.min(100, Math.max(0, num(l.discountpct))),
        category, part_no: opt(l.partno), unit: str(l.unit) || 'ชิ้น', item_id: item, from_inventory: l.frominventory === true,
        received_qty: isPart && full ? qty : 0, snapshot: snap,
      };
    });
    const subtotal = round2(num(r.subtotal));
    const discount = round2(num(r.discount));
    const memo: Memo = {
      id, no: str(r.no), title: str(r.title) || '(no title)', boat_id: boat, memo_type: memoType, scope: str(r.scope) === 'vessel' || str(r.scope) === 'general' ? str(r.scope) : null,
      general_category: opt(r.generalcategory), proposer: opt(r.proposer), from: opt(r.from), to: opt(r.to), cc: opt(r.cc), ref_note: opt(r.refnote), supplier: opt(r.supplier),
      note: opt(r.note), memo_date: date, job_id: opt(r.maintid), project_id: project, status, current_step: Math.min(5, Math.max(1, num(r.currentstep) || 1)),
      vat_enabled: r.vatenabled !== false, vat_rate: Math.max(0, num(r.vatrate)), discount_pct: Math.min(100, Math.max(0, num(r.discountpct))), discount_amt: Math.max(0, round2(num(r.discountamt))),
      subtotal, discount, after_discount: r.afterdiscount === null || r.afterdiscount === undefined ? round2(Math.max(0, subtotal - discount)) : round2(num(r.afterdiscount)),
      vat: round2(num(r.vat)), amount: round2(num(r.amount)), ordered_amount: null,
      approved_by: opt(r.approvedby), approved_date: day(r.approveddate), approve_note: opt(r.approvenote), approved_login: null,
      ordered_date: day(r.ordereddate), ordered_by: opt(r.orderedby), received_date: day(r.receiveddate), received_by: opt(r.receivedby),
      received_warehouse: legacyWarehouse(r.receivedlocation), received_summary: opt(r.receivedsummary), paid_date: day(r.paiddate), paid_by: opt(r.paidby), paid_via: opt(r.paidvia),
      short_closed: null, cancel_reason: null, cancelled_by: null, cancelled_at: null, created_at: at(date, now), created_by: opt(r.proposer), updated_at: now, lines,
    };
    const again = memoTotals(memo);
    if (Math.abs(again.amount - memo.amount) > 0.01) listed.push({ kind: 'memo total', id: memo.no, reason: `legacy stored ฿${memo.amount}; the formula gives ฿${again.amount} (kept as stored)` });
    if (status === 'cancelled') listed.push({ kind: 'memo', id: memo.no, reason: 'cancelled with no reason (legacy did not keep it)' });
    memos.push(memo);
  }
  return { memos, listed };
}

export type ProjectInput = { projects: Row[]; log: Row[]; plan: Row[]; boats: ReadonlySet<string>; attachments: ReadonlySet<string> };
export function mapProjects(input: ProjectInput, now: string) {
  const listed: Listed[] = [];
  const projects: Project[] = [];
  const logs: ProjectLog[] = [];
  const sig = new Map<string, string[]>();
  for (const r of input.projects) {
    const id = str(r.id);
    const status = str(r.status) as ProjectStatus;
    if (!(PROJECT_STATUSES as readonly string[]).includes(status)) { listed.push({ kind: 'project', id, reason: `status "${status}" unknown: skipped` }); continue; }
    let boat = opt(r.boatid);
    if (boat && !input.boats.has(boat)) { listed.push({ kind: 'project', id, reason: `boat ${boat} unknown: left out` }); boat = null; }
    const docsRaw = json(r.docs);
    const documents: ProjectDoc[] = (Array.isArray(docsRaw) ? docsRaw as Row[] : []).map((d, i) => {
      let att = opt(d.attId);
      if (att && !input.attachments.has(att)) { listed.push({ kind: 'project document', id: `${str(r.no)} ${str(d.name)}`, reason: `file ${att} not copied here (run import:attachments): kept as a link` }); att = null; }
      const status = (DOC_STATUSES as readonly string[]).includes(str(d.status)) ? str(d.status) : 'pending';
      return {
        id: str(d.id) || `doc${i}`, name: str(d.name) || '(document)', attachment_id: att, url: att ? null : opt(d.url), mime: opt(d.mime), size: numOrNull(d.size),
        note: opt(d.note), type: str(d.type) === 'photo' ? 'photo' : null, phase: opt(d.phase), status, added_at: day(d.addedAt), by: opt(d.by),
      };
    });
    const visitsRaw = json(r.vendorvisits);
    const created = day(r.createdat);
    const planFrom = day(r.planfrom);
    let planTo = day(r.planto);
    if (planFrom && planTo && planTo < planFrom) { listed.push({ kind: 'project', id, reason: `plan end ${planTo} before start ${planFrom}: end left out` }); planTo = null; }
    const p: Project = {
      id, no: str(r.no), name: str(r.name) || '(no name)', boat_id: boat, type: opt(r.type), vendor: opt(r.vendor), plan_from: planFrom, plan_to: planTo,
      original_plan_to: day(r.originalplanto), actual_from: day(r.actualfrom), actual_to: day(r.actualto), status, planned_budget: Math.max(0, num(r.plannedbudget)),
      notes: opt(r.notes), phase: opt(r.phase), hold_reason: opt(r.holdreason), hold_since: day(r.holdsince), cancel_reason: opt(r.cancelreason), cancelled_on: day(r.cancelledon),
      work_done_on: null, bill_note: null, no_cost: null, bill_closed_on: null, created_at: at(created, now), created_by: opt(r.createdby), updated_at: now,
      plan: input.plan.filter((x) => str(x.fleet_projects_id) === id).sort((a, b) => num(a.idx) - num(b.idx))
        .map((x, i) => ({ id: str(x.id) || `pl${i}`, text: str(x.text), done: x.done === true, added_at: day(x.addedat), done_date: day(x.donedate) })),
      documents,
      vendor_visits: (Array.isArray(visitsRaw) ? visitsRaw as Row[] : []).map((v, i) => ({ id: str(v.id) || `vv${i}`, vendor: str(v.vendor) || '(vendor)', role: opt(v.role), date: day(v.date) ?? created ?? now.slice(0, 10), by: opt(v.by) })),
    };
    if (p.type && !['drydock', 'overhaul', 'refit', 'scheduled', 'other'].includes(p.type)) listed.push({ kind: 'project', id: p.no, reason: `type "${p.type}" is not one of legacy's form types: kept as it is` });
    if (status === 'awaiting_bill') listed.push({ kind: 'project', id: p.no, reason: 'awaiting the bill: its work-done date and bill note were lost in legacy' });
    projects.push(p);
    logs.push(...input.log.filter((x) => str(x.fleet_projects_id) === id).sort((a, b) => num(a.idx) - num(b.idx))
      .map((x) => ({ project_id: id, date: day(x.date) ?? created ?? now.slice(0, 10), text: str(x.text), by: opt(x.by) })));
    const key = JSON.stringify([p.name, p.boat_id, p.vendor, p.plan_from, p.plan_to, p.status]);
    sig.set(key, [...(sig.get(key) ?? []), p.no]);
  }
  for (const [, nos] of sig) if (nos.length > 1) listed.push({ kind: 'project copies', id: nos.join(', '), reason: 'identical projects, imported as they are (ops are asked)' });
  return { projects, logs, listed };
}

export type DailyInput = {
  boatDays: Row[]; trips: Row[]; prices: Row[]; locks: Row[]; meta: Record<string, unknown>; boats: ReadonlySet<string>;
};
export function mapDaily(input: DailyInput, now: string) {
  const listed: Listed[] = [];
  const known = (boat: string, what: string, key: string) => { if (input.boats.has(boat)) return true; listed.push({ kind: what, id: key, reason: `boat ${boat} unknown: skipped` }); return false; };
  const boats: DailyBoat[] = [];
  for (const r of input.boatDays) {
    const date = day(r.fleet_daily_id); const boat = str(r.key); const v = (json(r.value) ?? {}) as Row;
    if (!date || !known(boat, 'daily log', `${date}|${boat}`)) continue;
    const fuel = num(v.fuel) > 0 ? round2(num(v.fuel)) : null;
    const pax = numOrNull(v.paxActual);
    if (fuel === null && pax === null) continue;
    boats.push({ date, boat_id: boat, fuel_litres: fuel, pax_actual: pax === null ? null : Math.max(0, Math.round(pax)), updated_at: at(date, now), updated_by: null });
  }
  const meters: Meter[] = [];
  for (const r of input.trips) {
    const date = day(r.fleet_daily_id); const boat = str(r.boat); const v = (json(r.value) ?? {}) as Row;
    if (!date || !known(boat, 'meter', `${date}|${boat}`)) continue;
    for (const [engine, reading] of Object.entries((v.engines ?? {}) as Row)) {
      const n = numOrNull(reading);
      if (n !== null) meters.push({ date, boat_id: boat, trip_type: str(r.key) || 'normal', engine_id: engine, reading: n });
    }
  }
  const prices: FuelPrice[] = [];
  for (const r of input.prices) {
    const date = day(r.key); const v = (json(r.value) ?? {}) as Row;
    if (!date) continue;
    for (const [key, p] of Object.entries(v)) { const n = numOrNull(p); if (n !== null && n >= 0) prices.push({ date, key, price: round2(n) }); }
  }
  const locks: DayLock[] = [];
  for (const r of input.locks) {
    const date = day(r.key); const v = (json(r.value) ?? {}) as Row;
    if (!date) continue;
    for (const [pier, on] of Object.entries(v)) if (on === true) locks.push({ date, pier, locked_at: at(date, now), locked_by: null });
  }
  const catalogue = json(input.meta.fl_issue_items);
  const issueItems: IssueItem[] = (Array.isArray(catalogue) ? catalogue as Row[] : []).map((x) => ({ id: str(x.id), name: str(x.name), unit: opt(x.unit), pier: opt(x.pier), off: !!x.off }));
  const itemIds = new Set(issueItems.map((i) => i.id));
  const split = (key: string) => { const [d, b] = key.split('|'); return { date: day(d), other: str(b) }; };
  const issues: Issue[] = [];
  for (const [key, map] of Object.entries((json(input.meta.fl_issue) ?? {}) as Row)) {
    const { date, other: boat } = split(key);
    if (!date || !known(boat, 'issued items', key)) continue;
    for (const [item, qty] of Object.entries((map ?? {}) as Row)) {
      if (!itemIds.has(item)) { listed.push({ kind: 'issued item', id: `${key} ${item}`, reason: 'not in the item list: skipped' }); continue; }
      const n = numOrNull(qty);
      if (n !== null) issues.push({ date, boat_id: boat, item_id: item, qty: n });
    }
  }
  const water: Water[] = [];
  for (const [key, w] of Object.entries((json(input.meta.fl_water) ?? {}) as Row)) {
    const { date, other: boat } = split(key); const v = (w ?? {}) as Row;
    if (!date || !known(boat, 'water meter', key)) continue;
    const o = numOrNull(v.o); const c = numOrNull(v.c);
    if (o === null && c === null) continue;
    water.push({ date, boat_id: boat, open_reading: o, close_reading: c, by: opt(v.by), at: str(v.at) && !Number.isNaN(Date.parse(str(v.at))) ? str(v.at) : at(date, now) });
  }
  const extras: Extra[] = [];
  for (const [key, list] of Object.entries((json(input.meta.fl_extra) ?? {}) as Row)) {
    const { date, other: boat } = split(key);
    if (!date || !known(boat, 'extra item', key) || !Array.isArray(list)) continue;
    for (const x of list as Row[]) if (str(x.n)) extras.push({ id: `lg_${str(x.id)}`, date, boat_id: boat, name: str(x.n), qty: numOrNull(x.q), unit: opt(x.u) });
  }
  const requests: DailyRequest[] = [];
  for (const [key, list] of Object.entries((json(input.meta.fl_req) ?? {}) as Row)) {
    const { date, other: pier } = split(key);
    if (!date || !pier || !Array.isArray(list)) continue;
    for (const x of list as Row[]) {
      if (!str(x.name)) continue;
      const iss: Record<string, number> = {};
      for (const [k, q] of Object.entries((x.iss ?? {}) as Row)) { const n = numOrNull(q); if (n !== null && itemIds.has(k)) iss[k] = n; }
      requests.push({
        id: `lg_${str(x.id)}`, date, pier, name: str(x.name), pax: numOrNull(x.pax), fuel: numOrNull(x.fuel), price: numOrNull(x.price), engine_hours: numOrNull(x.eng),
        water_open: numOrNull(x.wo), water_close: numOrNull(x.wc), issues: iss,
      });
    }
  }
  return { boats, meters, prices, locks, issueItems, issues, water, extras, requests, listed };
}

export type SafetyInput = { items: Row[]; inspections: Row[]; log: Row[]; boats: ReadonlySet<string> };
export function mapSafety(input: SafetyInput, now: string) {
  const listed: Listed[] = [];
  const items: SafetyItem[] = [];
  const logs: SafetyLog[] = [];
  for (const r of input.items) {
    const id = str(r.id);
    if (!input.boats.has(str(r.boatid))) { listed.push({ kind: 'safety item', id, reason: `boat ${str(r.boatid)} unknown: skipped` }); continue; }
    const inspections: Inspection[] = input.inspections.filter((x) => str(x.fleet_safety_id) === id).sort((a, b) => num(a.idx) - num(b.idx)).flatMap((x) => {
      const d = day(x.date);
      const result = str(x.result) as Inspection['result'];
      if (!d || !(result in INSPECTION_RESULTS)) { listed.push({ kind: 'inspection', id: str(x.id), reason: 'no date or an unknown result: skipped' }); return []; }
      return [{ id: str(x.id) || rowId(x.row_pk), date: d, inspector: opt(x.by), result, findings: opt(x.note), next_due: null, created_at: at(d, now), created_by: null }];
    });
    items.push({
      id, boat_id: str(r.boatid), category: str(r.category), name: str(r.name) || '(no name)', brand: opt(r.brand), model: opt(r.model), serial: opt(r.serial),
      qty: Math.max(1, Math.round(num(r.qty)) || 1), install_date: day(r.installdate), expiry_date: day(r.expirydate), next_pm: day(r.nextpm), last_inspect: day(r.lastinspect),
      status: str(r.status) || 'active', location: opt(r.location), note: opt(r.note), created_at: at(day(r.installdate), now), updated_at: now, inspections,
    });
    logs.push(...input.log.filter((x) => str(x.fleet_safety_id) === id).sort((a, b) => num(a.idx) - num(b.idx))
      .map((x) => ({ item_id: id, date: day(x.date) ?? now.slice(0, 10), type: str(x.type) || 'note', desc: str(x.desc) })));
  }
  return { items, logs, listed };
}

export type ConsumableInput = { rows: Row[]; items: ReadonlySet<string>; boats: ReadonlySet<string> };
export function mapConsumables(input: ConsumableInput, now: string) {
  const listed: Listed[] = [];
  const out: Consumable[] = [];
  for (const r of input.rows) {
    const id = str(r.id); const date = day(r.date); const w = legacyWarehouse(r.location);
    if (!date || !input.items.has(str(r.itemid)) || !input.boats.has(str(r.boatid)) || !w || num(r.qty) <= 0) {
      listed.push({ kind: 'consumable', id, reason: 'missing date, item, boat, warehouse or quantity: skipped' }); continue;
    }
    out.push({
      id, date, item_id: str(r.itemid), item_name: str(r.itemname), unit: str(r.unit), qty: num(r.qty), unit_cost: round2(num(r.unitcost)), cost: round2(num(r.cost)),
      warehouse: w, boat_id: str(r.boatid), engine_id: opt(r.engineid), engine_label: opt(r.enginelabel), drawn_by: opt(r.by), note: opt(r.note),
      created_at: at(date, now), created_by: null, voided_at: null, voided_by: null,
    });
  }
  return { consumables: out, listed };
}
