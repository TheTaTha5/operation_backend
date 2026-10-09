/**
 * Fleet part B in PostgreSQL (migrations 140–143): `FleetRepo` over the store's own connection, so
 * every call runs in the request's transaction. Rows in, rows out; the rules are in the pure modules.
 * Dates are read as `::text` (CLAUDE.md), numerics converted with `Number`.
 */
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type { FleetRepo } from './fleet-store.js';
import type { Consumable, Movement, NewMovement, StockItem } from './fleet-stock.js';
import type { Memo, MemoHistory, MemoLine, MemoReceipt } from './fleet-memos.js';
import type { Project, ProjectLog } from './fleet-projects.js';
import type { DailyBoat, DailyRequest, DailyRows, DayLock, Extra, FuelPrice, Issue, IssueItem, Meter, Water } from './fleet-daily.js';
import type { SafetyItem, SafetyLog } from './fleet-safety.js';

type Db = () => Pool | PoolClient;
const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const iso = (v: unknown): string => (v as Date).toISOString();
const isoOrNull = (v: unknown): string | null => (v ? (v as Date).toISOString() : null);
const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

const ITEM_SELECT = `SELECT id, name, part_no, category, supplier, unit, min_qty, cost, note, created_from, created_date::text AS created_date, created_at, created_by,
  updated_at, deleted_at, deleted_by, merged_into FROM fleet_stock_items`;
const itemRow = (r: QueryResultRow): StockItem => ({
  id: r.id, name: r.name, part_no: s(r.part_no), category: s(r.category), supplier: s(r.supplier), unit: r.unit, min_qty: num(r.min_qty), cost: num(r.cost),
  note: s(r.note), created_from: s(r.created_from), created_date: s(r.created_date), created_at: iso(r.created_at), created_by: s(r.created_by),
  updated_at: iso(r.updated_at), deleted_at: isoOrNull(r.deleted_at), deleted_by: s(r.deleted_by), merged_into: s(r.merged_into),
});
const MOVE_SELECT = `SELECT seq, id, item_id, date::text AS date, type, warehouse, delta, note, by, memo_id, job_id, consumable_id, changes, created_at, created_by FROM fleet_stock_movements`;
const moveRow = (r: QueryResultRow): Movement => ({
  id: r.id, seq: num(r.seq), item_id: r.item_id, date: r.date, type: r.type, warehouse: s(r.warehouse), delta: num(r.delta), note: s(r.note), by: s(r.by),
  memo_id: s(r.memo_id), job_id: s(r.job_id), consumable_id: s(r.consumable_id), changes: r.changes ?? null, created_at: iso(r.created_at), created_by: s(r.created_by),
});
const CONS_SELECT = `SELECT id, date::text AS date, item_id, item_name, unit, qty, unit_cost, cost, warehouse, boat_id, engine_id, engine_label, drawn_by, note,
  created_at, created_by, voided_at, voided_by FROM fleet_consumables`;
const consRow = (r: QueryResultRow): Consumable => ({
  id: r.id, date: r.date, item_id: r.item_id, item_name: r.item_name, unit: r.unit, qty: num(r.qty), unit_cost: num(r.unit_cost), cost: num(r.cost),
  warehouse: r.warehouse, boat_id: r.boat_id, engine_id: s(r.engine_id), engine_label: s(r.engine_label), drawn_by: s(r.drawn_by), note: s(r.note),
  created_at: iso(r.created_at), created_by: s(r.created_by), voided_at: isoOrNull(r.voided_at), voided_by: s(r.voided_by),
});
const MEMO_SELECT = `SELECT id, no, title, boat_id, memo_type, scope, general_category, proposer, from_text, to_text, cc, ref_note, supplier, note, memo_date::text AS memo_date,
  job_id, project_id, status, current_step, vat_enabled, vat_rate, discount_pct, discount_amt, subtotal, discount, after_discount, vat, amount, ordered_amount,
  approved_by, approved_date::text AS approved_date, approve_note, approved_login, ordered_date::text AS ordered_date, ordered_by, received_date::text AS received_date,
  received_by, received_warehouse, received_summary, paid_date::text AS paid_date, paid_by, paid_via, short_closed, cancel_reason, cancelled_by, cancelled_at,
  created_at, created_by, updated_at FROM fleet_memos`;
const memoRow = (r: QueryResultRow, lines: MemoLine[]): Memo => ({
  id: r.id, no: r.no, title: r.title, boat_id: s(r.boat_id), memo_type: r.memo_type, scope: s(r.scope), general_category: s(r.general_category), proposer: s(r.proposer),
  from: s(r.from_text), to: s(r.to_text), cc: s(r.cc), ref_note: s(r.ref_note), supplier: s(r.supplier), note: s(r.note), memo_date: r.memo_date, job_id: s(r.job_id),
  project_id: s(r.project_id), status: r.status, current_step: num(r.current_step), vat_enabled: r.vat_enabled, vat_rate: num(r.vat_rate), discount_pct: num(r.discount_pct),
  discount_amt: num(r.discount_amt), subtotal: num(r.subtotal), discount: num(r.discount), after_discount: num(r.after_discount), vat: num(r.vat), amount: num(r.amount),
  ordered_amount: numOrNull(r.ordered_amount), approved_by: s(r.approved_by), approved_date: s(r.approved_date), approve_note: s(r.approve_note), approved_login: s(r.approved_login),
  ordered_date: s(r.ordered_date), ordered_by: s(r.ordered_by), received_date: s(r.received_date), received_by: s(r.received_by), received_warehouse: s(r.received_warehouse),
  received_summary: s(r.received_summary), paid_date: s(r.paid_date), paid_by: s(r.paid_by), paid_via: s(r.paid_via), short_closed: r.short_closed ?? null,
  cancel_reason: s(r.cancel_reason), cancelled_by: s(r.cancelled_by), cancelled_at: isoOrNull(r.cancelled_at), created_at: iso(r.created_at), created_by: s(r.created_by),
  updated_at: iso(r.updated_at), lines,
});
const lineRow = (r: QueryResultRow): MemoLine => ({
  id: r.id, name: r.name, qty: num(r.qty), price: num(r.price), discount_pct: num(r.discount_pct), category: r.category ?? null, part_no: s(r.part_no), unit: r.unit,
  item_id: s(r.item_id), from_inventory: r.from_inventory, received_qty: num(r.received_qty), snapshot: r.snapshot ?? null,
});
const PROJECT_SELECT = `SELECT id, no, name, boat_id, type, vendor, plan_from::text AS plan_from, plan_to::text AS plan_to, original_plan_to::text AS original_plan_to,
  actual_from::text AS actual_from, actual_to::text AS actual_to, status, planned_budget, notes, phase, hold_reason, hold_since::text AS hold_since, cancel_reason,
  cancelled_on::text AS cancelled_on, work_done_on::text AS work_done_on, bill_note, no_cost, bill_closed_on::text AS bill_closed_on, created_at, created_by, updated_at
  FROM fleet_projects`;
const SAFETY_SELECT = `SELECT id, boat_id, category, name, brand, model, serial, qty, install_date::text AS install_date, expiry_date::text AS expiry_date, next_pm::text AS next_pm,
  last_inspect::text AS last_inspect, status, location, note, created_at, updated_at FROM fleet_safety_items`;

export class PostgresFleetRepo implements FleetRepo {
  constructor(private readonly db: Db) {}
  private q(sql: string, params: unknown[] = []) { return this.db().query(sql, params); }

  // ── Stock ──
  async items(): Promise<StockItem[]> { return (await this.q(ITEM_SELECT)).rows.map(itemRow); }
  async item(id: string): Promise<StockItem | undefined> { const r = (await this.q(`${ITEM_SELECT} WHERE id = $1`, [id])).rows[0]; return r && itemRow(r); }
  async putItems(items: readonly StockItem[]): Promise<void> {
    for (const i of items) {
      await this.q(`INSERT INTO fleet_stock_items (id, name, part_no, category, supplier, unit, min_qty, cost, note, created_from, created_date, created_at, created_by,
        updated_at, deleted_at, deleted_by, merged_into) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, part_no = EXCLUDED.part_no, category = EXCLUDED.category, supplier = EXCLUDED.supplier, unit = EXCLUDED.unit,
        min_qty = EXCLUDED.min_qty, cost = EXCLUDED.cost, note = EXCLUDED.note, updated_at = EXCLUDED.updated_at, deleted_at = EXCLUDED.deleted_at,
        deleted_by = EXCLUDED.deleted_by, merged_into = EXCLUDED.merged_into`,
      [i.id, i.name, i.part_no, i.category, i.supplier, i.unit, i.min_qty, i.cost, i.note, i.created_from, i.created_date, i.created_at, i.created_by, i.updated_at,
        i.deleted_at, i.deleted_by, i.merged_into]);
    }
  }
  async movements(q: { itemIds?: readonly string[]; memoId?: string } = {}): Promise<Movement[]> {
    const where: string[] = []; const params: unknown[] = [];
    if (q.itemIds) { params.push([...q.itemIds]); where.push(`item_id = ANY($${params.length})`); }
    if (q.memoId !== undefined) { params.push(q.memoId); where.push(`memo_id = $${params.length}`); }
    return (await this.q(`${MOVE_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY seq`, params)).rows.map(moveRow);
  }
  async addMovements(rows: readonly NewMovement[]): Promise<void> {
    for (const m of rows) {
      await this.q(`INSERT INTO fleet_stock_movements (id, item_id, date, type, warehouse, delta, note, by, memo_id, job_id, consumable_id, changes, created_at, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [m.id, m.item_id, m.date, m.type, m.warehouse, m.delta, m.note, m.by, m.memo_id, m.job_id, m.consumable_id, m.changes === null ? null : JSON.stringify(m.changes), m.created_at, m.created_by]);
    }
  }
  async repointMemoLines(from: readonly string[], to: string): Promise<void> { await this.q('UPDATE fleet_memo_lines SET item_id = $2 WHERE item_id = ANY($1)', [[...from], to]); }

  // ── Consumables ──
  async consumables(): Promise<Consumable[]> { return (await this.q(CONS_SELECT)).rows.map(consRow); }
  async consumable(id: string): Promise<Consumable | undefined> { const r = (await this.q(`${CONS_SELECT} WHERE id = $1`, [id])).rows[0]; return r && consRow(r); }
  async putConsumable(c: Consumable): Promise<void> {
    await this.q(`INSERT INTO fleet_consumables (id, date, item_id, item_name, unit, qty, unit_cost, cost, warehouse, boat_id, engine_id, engine_label, drawn_by, note,
      created_at, created_by, voided_at, voided_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      ON CONFLICT (id) DO UPDATE SET voided_at = EXCLUDED.voided_at, voided_by = EXCLUDED.voided_by`,
    [c.id, c.date, c.item_id, c.item_name, c.unit, c.qty, c.unit_cost, c.cost, c.warehouse, c.boat_id, c.engine_id, c.engine_label, c.drawn_by, c.note,
      c.created_at, c.created_by, c.voided_at, c.voided_by]);
  }

  // ── Memos ──
  private async withLines(rows: QueryResultRow[]): Promise<Memo[]> {
    if (!rows.length) return [];
    const lines = (await this.q('SELECT * FROM fleet_memo_lines WHERE memo_id = ANY($1) ORDER BY memo_id, seq', [rows.map((r) => r.id)])).rows;
    const by = new Map<string, MemoLine[]>();
    for (const l of lines) { const list = by.get(l.memo_id) ?? []; list.push(lineRow(l)); by.set(l.memo_id, list); }
    return rows.map((r) => memoRow(r, by.get(r.id) ?? []));
  }
  async memos(): Promise<Memo[]> { return this.withLines((await this.q(MEMO_SELECT)).rows); }
  async memo(id: string): Promise<Memo | undefined> { return (await this.withLines((await this.q(`${MEMO_SELECT} WHERE id = $1`, [id])).rows))[0]; }
  async putMemo(m: Memo): Promise<void> {
    await this.q(`INSERT INTO fleet_memos (id, no, title, boat_id, memo_type, scope, general_category, proposer, from_text, to_text, cc, ref_note, supplier, note, memo_date,
      job_id, project_id, status, current_step, vat_enabled, vat_rate, discount_pct, discount_amt, subtotal, discount, after_discount, vat, amount, ordered_amount,
      approved_by, approved_date, approve_note, approved_login, ordered_date, ordered_by, received_date, received_by, received_warehouse, received_summary,
      paid_date, paid_by, paid_via, short_closed, cancel_reason, cancelled_by, cancelled_at, created_at, created_by, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,
        $40,$41,$42,$43,$44,$45,$46,$47,$48,$49)
      ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, boat_id = EXCLUDED.boat_id, memo_type = EXCLUDED.memo_type, scope = EXCLUDED.scope,
        general_category = EXCLUDED.general_category, proposer = EXCLUDED.proposer, from_text = EXCLUDED.from_text, to_text = EXCLUDED.to_text, cc = EXCLUDED.cc,
        ref_note = EXCLUDED.ref_note, supplier = EXCLUDED.supplier, note = EXCLUDED.note, memo_date = EXCLUDED.memo_date, job_id = EXCLUDED.job_id,
        project_id = EXCLUDED.project_id, status = EXCLUDED.status, current_step = EXCLUDED.current_step, vat_enabled = EXCLUDED.vat_enabled, vat_rate = EXCLUDED.vat_rate,
        discount_pct = EXCLUDED.discount_pct, discount_amt = EXCLUDED.discount_amt, subtotal = EXCLUDED.subtotal, discount = EXCLUDED.discount,
        after_discount = EXCLUDED.after_discount, vat = EXCLUDED.vat, amount = EXCLUDED.amount, ordered_amount = EXCLUDED.ordered_amount,
        approved_by = EXCLUDED.approved_by, approved_date = EXCLUDED.approved_date, approve_note = EXCLUDED.approve_note, approved_login = EXCLUDED.approved_login,
        ordered_date = EXCLUDED.ordered_date, ordered_by = EXCLUDED.ordered_by, received_date = EXCLUDED.received_date, received_by = EXCLUDED.received_by,
        received_warehouse = EXCLUDED.received_warehouse, received_summary = EXCLUDED.received_summary, paid_date = EXCLUDED.paid_date, paid_by = EXCLUDED.paid_by,
        paid_via = EXCLUDED.paid_via, short_closed = EXCLUDED.short_closed, cancel_reason = EXCLUDED.cancel_reason, cancelled_by = EXCLUDED.cancelled_by,
        cancelled_at = EXCLUDED.cancelled_at, updated_at = EXCLUDED.updated_at`,
    [m.id, m.no, m.title, m.boat_id, m.memo_type, m.scope, m.general_category, m.proposer, m.from, m.to, m.cc, m.ref_note, m.supplier, m.note, m.memo_date,
      m.job_id, m.project_id, m.status, m.current_step, m.vat_enabled, m.vat_rate, m.discount_pct, m.discount_amt, m.subtotal, m.discount, m.after_discount, m.vat, m.amount,
      m.ordered_amount, m.approved_by, m.approved_date, m.approve_note, m.approved_login, m.ordered_date, m.ordered_by, m.received_date, m.received_by,
      m.received_warehouse, m.received_summary, m.paid_date, m.paid_by, m.paid_via, m.short_closed === null ? null : JSON.stringify(m.short_closed),
      m.cancel_reason, m.cancelled_by, m.cancelled_at, m.created_at, m.created_by, m.updated_at]);
    await this.q('DELETE FROM fleet_memo_lines WHERE memo_id = $1', [m.id]);
    for (const [seq, l] of m.lines.entries()) {
      await this.q(`INSERT INTO fleet_memo_lines (id, memo_id, seq, name, qty, price, discount_pct, category, part_no, unit, item_id, from_inventory, received_qty, snapshot)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [l.id, m.id, seq, l.name, l.qty, l.price, l.discount_pct, l.category, l.part_no, l.unit, l.item_id, l.from_inventory, l.received_qty,
        l.snapshot === null ? null : JSON.stringify(l.snapshot)]);
    }
  }
  async memoHistory(id: string): Promise<MemoHistory[]> {
    return (await this.q('SELECT memo_id, type, at, by, note FROM fleet_memo_history WHERE memo_id = $1 ORDER BY id', [id])).rows
      .map((r) => ({ memo_id: r.memo_id, type: r.type, at: iso(r.at), by: s(r.by), note: s(r.note) }));
  }
  async addMemoHistory(rows: readonly MemoHistory[]): Promise<void> {
    for (const h of rows) await this.q('INSERT INTO fleet_memo_history (memo_id, type, at, by, note) VALUES ($1,$2,$3,$4,$5)', [h.memo_id, h.type, h.at, h.by, h.note]);
  }
  async memoReceipts(id: string): Promise<MemoReceipt[]> {
    return (await this.q('SELECT id, memo_id, date::text AS date, by, warehouse, note, lines, created_at FROM fleet_memo_receipts WHERE memo_id = $1 ORDER BY created_at, id', [id])).rows
      .map((r) => ({ id: r.id, memo_id: r.memo_id, date: r.date, by: s(r.by), warehouse: r.warehouse, note: s(r.note), lines: r.lines, created_at: iso(r.created_at) }));
  }
  async addMemoReceipt(r: MemoReceipt): Promise<void> {
    await this.q('INSERT INTO fleet_memo_receipts (id, memo_id, date, by, warehouse, note, lines, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [r.id, r.memo_id, r.date, r.by, r.warehouse, r.note, JSON.stringify(r.lines), r.created_at]);
  }

  // ── Projects ──
  private async withChildren(rows: QueryResultRow[]): Promise<Project[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const plan = (await this.q('SELECT project_id, id, text, done, added_at::text AS added_at, done_date::text AS done_date FROM fleet_project_plan WHERE project_id = ANY($1) ORDER BY seq', [ids])).rows;
    const docs = (await this.q(`SELECT project_id, id, name, attachment_id, url, mime, size, note, type, phase, status, added_at::text AS added_at, by
      FROM fleet_project_documents WHERE project_id = ANY($1) ORDER BY seq`, [ids])).rows;
    const visits = (await this.q('SELECT project_id, id, vendor, role, date::text AS date, by FROM fleet_project_vendor_visits WHERE project_id = ANY($1) ORDER BY seq', [ids])).rows;
    return rows.map((r) => ({
      id: r.id, no: r.no, name: r.name, boat_id: s(r.boat_id), type: s(r.type), vendor: s(r.vendor), plan_from: s(r.plan_from), plan_to: s(r.plan_to),
      original_plan_to: s(r.original_plan_to), actual_from: s(r.actual_from), actual_to: s(r.actual_to), status: r.status, planned_budget: num(r.planned_budget),
      notes: s(r.notes), phase: s(r.phase), hold_reason: s(r.hold_reason), hold_since: s(r.hold_since), cancel_reason: s(r.cancel_reason), cancelled_on: s(r.cancelled_on),
      work_done_on: s(r.work_done_on), bill_note: s(r.bill_note), no_cost: r.no_cost ?? null, bill_closed_on: s(r.bill_closed_on), created_at: iso(r.created_at),
      created_by: s(r.created_by), updated_at: iso(r.updated_at),
      plan: plan.filter((x) => x.project_id === r.id).map((x) => ({ id: x.id, text: x.text, done: x.done, added_at: s(x.added_at), done_date: s(x.done_date) })),
      documents: docs.filter((x) => x.project_id === r.id).map((x) => ({
        id: x.id, name: x.name, attachment_id: s(x.attachment_id), url: s(x.url), mime: s(x.mime), size: numOrNull(x.size), note: s(x.note), type: x.type ?? null,
        phase: s(x.phase), status: x.status, added_at: s(x.added_at), by: s(x.by),
      })),
      vendor_visits: visits.filter((x) => x.project_id === r.id).map((x) => ({ id: x.id, vendor: x.vendor, role: s(x.role), date: x.date, by: s(x.by) })),
    }));
  }
  async projects(): Promise<Project[]> { return this.withChildren((await this.q(PROJECT_SELECT)).rows); }
  async project(id: string): Promise<Project | undefined> { return (await this.withChildren((await this.q(`${PROJECT_SELECT} WHERE id = $1`, [id])).rows))[0]; }
  async putProject(p: Project): Promise<void> {
    await this.q(`INSERT INTO fleet_projects (id, no, name, boat_id, type, vendor, plan_from, plan_to, original_plan_to, actual_from, actual_to, status, planned_budget, notes,
      phase, hold_reason, hold_since, cancel_reason, cancelled_on, work_done_on, bill_note, no_cost, bill_closed_on, created_at, created_by, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, boat_id = EXCLUDED.boat_id, type = EXCLUDED.type, vendor = EXCLUDED.vendor, plan_from = EXCLUDED.plan_from,
        plan_to = EXCLUDED.plan_to, actual_from = EXCLUDED.actual_from, actual_to = EXCLUDED.actual_to, status = EXCLUDED.status, planned_budget = EXCLUDED.planned_budget,
        notes = EXCLUDED.notes, phase = EXCLUDED.phase, hold_reason = EXCLUDED.hold_reason, hold_since = EXCLUDED.hold_since, cancel_reason = EXCLUDED.cancel_reason,
        cancelled_on = EXCLUDED.cancelled_on, work_done_on = EXCLUDED.work_done_on, bill_note = EXCLUDED.bill_note, no_cost = EXCLUDED.no_cost,
        bill_closed_on = EXCLUDED.bill_closed_on, updated_at = EXCLUDED.updated_at`,
    [p.id, p.no, p.name, p.boat_id, p.type, p.vendor, p.plan_from, p.plan_to, p.original_plan_to, p.actual_from, p.actual_to, p.status, p.planned_budget, p.notes,
      p.phase, p.hold_reason, p.hold_since, p.cancel_reason, p.cancelled_on, p.work_done_on, p.bill_note, p.no_cost === null ? null : JSON.stringify(p.no_cost),
      p.bill_closed_on, p.created_at, p.created_by, p.updated_at]);
    await this.q('DELETE FROM fleet_project_plan WHERE project_id = $1', [p.id]);
    for (const [seq, x] of p.plan.entries()) {
      await this.q('INSERT INTO fleet_project_plan (project_id, id, seq, text, done, added_at, done_date) VALUES ($1,$2,$3,$4,$5,$6,$7)', [p.id, x.id, seq, x.text, x.done, x.added_at, x.done_date]);
    }
    await this.q('DELETE FROM fleet_project_documents WHERE project_id = $1', [p.id]);
    for (const [seq, d] of p.documents.entries()) {
      await this.q(`INSERT INTO fleet_project_documents (project_id, id, seq, name, attachment_id, url, mime, size, note, type, phase, status, added_at, by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [p.id, d.id, seq, d.name, d.attachment_id, d.url, d.mime, d.size, d.note, d.type, d.phase, d.status, d.added_at, d.by]);
    }
    await this.q('DELETE FROM fleet_project_vendor_visits WHERE project_id = $1', [p.id]);
    for (const [seq, v] of p.vendor_visits.entries()) {
      await this.q('INSERT INTO fleet_project_vendor_visits (project_id, id, seq, vendor, role, date, by) VALUES ($1,$2,$3,$4,$5,$6,$7)', [p.id, v.id, seq, v.vendor, v.role, v.date, v.by]);
    }
  }
  async projectLog(id: string): Promise<ProjectLog[]> {
    return (await this.q('SELECT project_id, date::text AS date, text, by FROM fleet_project_log WHERE project_id = $1 ORDER BY id', [id])).rows
      .map((r) => ({ project_id: r.project_id, date: r.date, text: r.text, by: s(r.by) }));
  }
  async addProjectLog(rows: readonly ProjectLog[]): Promise<void> {
    for (const l of rows) await this.q('INSERT INTO fleet_project_log (project_id, date, text, by) VALUES ($1,$2,$3,$4)', [l.project_id, l.date, l.text, l.by]);
  }
  async attachmentProjects(attachmentId: string): Promise<string[]> {
    return (await this.q('SELECT DISTINCT project_id FROM fleet_project_documents WHERE attachment_id = $1 ORDER BY project_id', [attachmentId])).rows.map((r) => r.project_id);
  }
  async engineMeters(): Promise<Meter[]> {
    return (await this.q('SELECT date::text AS date, boat_id, trip_type, engine_id, reading FROM fleet_daily_meters ORDER BY date, boat_id, trip_type, engine_id')).rows
      .map((r): Meter => ({ date: r.date, boat_id: r.boat_id, trip_type: r.trip_type, engine_id: r.engine_id, reading: num(r.reading) }));
  }

  // ── Daily Fleet Log ──
  async daily(from: string, to: string): Promise<DailyRows> {
    const range = [from, to];
    const boats = (await this.q('SELECT date::text AS date, boat_id, fuel_litres, pax_actual, updated_at, updated_by FROM fleet_daily_boats WHERE date BETWEEN $1 AND $2 ORDER BY date, boat_id', range)).rows
      .map((r): DailyBoat => ({ date: r.date, boat_id: r.boat_id, fuel_litres: numOrNull(r.fuel_litres), pax_actual: numOrNull(r.pax_actual), updated_at: iso(r.updated_at), updated_by: s(r.updated_by) }));
    const meters = (await this.q('SELECT date::text AS date, boat_id, trip_type, engine_id, reading FROM fleet_daily_meters WHERE date BETWEEN $1 AND $2 ORDER BY date, boat_id, trip_type, engine_id', range)).rows
      .map((r): Meter => ({ date: r.date, boat_id: r.boat_id, trip_type: r.trip_type, engine_id: r.engine_id, reading: num(r.reading) }));
    const locks = (await this.q('SELECT date::text AS date, pier, locked_at, locked_by FROM fleet_daily_locks WHERE date BETWEEN $1 AND $2 ORDER BY date, pier', range)).rows
      .map((r): DayLock => ({ date: r.date, pier: r.pier, locked_at: iso(r.locked_at), locked_by: s(r.locked_by) }));
    const water = (await this.q('SELECT date::text AS date, boat_id, open_reading, close_reading, by, at FROM fleet_water_meters WHERE date BETWEEN $1 AND $2 ORDER BY date, boat_id', range)).rows
      .map((r): Water => ({ date: r.date, boat_id: r.boat_id, open_reading: numOrNull(r.open_reading), close_reading: numOrNull(r.close_reading), by: s(r.by), at: iso(r.at) }));
    const issues = (await this.q('SELECT date::text AS date, boat_id, item_id, qty FROM fleet_issues WHERE date BETWEEN $1 AND $2 ORDER BY date, boat_id, item_id', range)).rows
      .map((r): Issue => ({ date: r.date, boat_id: r.boat_id, item_id: r.item_id, qty: num(r.qty) }));
    const extras = (await this.q('SELECT id, date::text AS date, boat_id, name, qty, unit FROM fleet_daily_extras WHERE date BETWEEN $1 AND $2 ORDER BY seq', range)).rows
      .map((r): Extra => ({ id: r.id, date: r.date, boat_id: r.boat_id, name: r.name, qty: numOrNull(r.qty), unit: s(r.unit) }));
    const requests = (await this.q(`SELECT id, date::text AS date, pier, name, pax, fuel, price, engine_hours, water_open, water_close, issues FROM fleet_daily_requests
      WHERE date BETWEEN $1 AND $2 ORDER BY seq`, range)).rows.map(requestRow);
    return { boats, meters, prices: await this.fuelPrices(from, to), locks, water, issues, extras, requests };
  }
  async fuelPrices(from: string, to: string): Promise<FuelPrice[]> {
    return (await this.q('SELECT date::text AS date, key, price FROM fleet_fuel_prices WHERE date BETWEEN $1 AND $2 ORDER BY date, key', [from, to])).rows
      .map((r) => ({ date: r.date, key: r.key, price: num(r.price) }));
  }
  async putDailyBoat(r: DailyBoat): Promise<void> {
    if (r.fuel_litres === null && r.pax_actual === null) { await this.q('DELETE FROM fleet_daily_boats WHERE date = $1 AND boat_id = $2', [r.date, r.boat_id]); return; }
    await this.q(`INSERT INTO fleet_daily_boats (date, boat_id, fuel_litres, pax_actual, updated_at, updated_by) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (date, boat_id) DO UPDATE SET fuel_litres = EXCLUDED.fuel_litres, pax_actual = EXCLUDED.pax_actual, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
    [r.date, r.boat_id, r.fuel_litres, r.pax_actual, r.updated_at, r.updated_by]);
  }
  async putMeter(r: Omit<Meter, 'reading'> & { reading: number | null }): Promise<void> {
    if (r.reading === null) { await this.q('DELETE FROM fleet_daily_meters WHERE date = $1 AND boat_id = $2 AND trip_type = $3 AND engine_id = $4', [r.date, r.boat_id, r.trip_type, r.engine_id]); return; }
    await this.q(`INSERT INTO fleet_daily_meters (date, boat_id, trip_type, engine_id, reading) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (date, boat_id, trip_type, engine_id) DO UPDATE SET reading = EXCLUDED.reading`, [r.date, r.boat_id, r.trip_type, r.engine_id, r.reading]);
  }
  async putFuelPrice(date: string, key: string, price: number | null): Promise<void> {
    if (price === null) { await this.q('DELETE FROM fleet_fuel_prices WHERE date = $1 AND key = $2', [date, key]); return; }
    await this.q('INSERT INTO fleet_fuel_prices (date, key, price) VALUES ($1,$2,$3) ON CONFLICT (date, key) DO UPDATE SET price = EXCLUDED.price', [date, key, price]);
  }
  async putLock(l: DayLock): Promise<void> {
    await this.q('INSERT INTO fleet_daily_locks (date, pier, locked_at, locked_by) VALUES ($1,$2,$3,$4) ON CONFLICT (date, pier) DO NOTHING', [l.date, l.pier, l.locked_at, l.locked_by]);
  }
  async deleteLock(date: string, pier: string): Promise<boolean> { return ((await this.q('DELETE FROM fleet_daily_locks WHERE date = $1 AND pier = $2', [date, pier])).rowCount ?? 0) > 0; }
  async putWater(r: Water): Promise<void> {
    if (r.open_reading === null && r.close_reading === null) { await this.q('DELETE FROM fleet_water_meters WHERE date = $1 AND boat_id = $2', [r.date, r.boat_id]); return; }
    await this.q(`INSERT INTO fleet_water_meters (date, boat_id, open_reading, close_reading, by, at) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (date, boat_id) DO UPDATE SET open_reading = EXCLUDED.open_reading, close_reading = EXCLUDED.close_reading, by = EXCLUDED.by, at = EXCLUDED.at`,
    [r.date, r.boat_id, r.open_reading, r.close_reading, r.by, r.at]);
  }
  async putIssue(r: Omit<Issue, 'qty'> & { qty: number | null }): Promise<void> {
    if (r.qty === null) { await this.q('DELETE FROM fleet_issues WHERE date = $1 AND boat_id = $2 AND item_id = $3', [r.date, r.boat_id, r.item_id]); return; }
    await this.q('INSERT INTO fleet_issues (date, boat_id, item_id, qty) VALUES ($1,$2,$3,$4) ON CONFLICT (date, boat_id, item_id) DO UPDATE SET qty = EXCLUDED.qty',
      [r.date, r.boat_id, r.item_id, r.qty]);
  }
  async extra(id: string): Promise<Extra | undefined> {
    const r = (await this.q('SELECT id, date::text AS date, boat_id, name, qty, unit FROM fleet_daily_extras WHERE id = $1', [id])).rows[0];
    return r && { id: r.id, date: r.date, boat_id: r.boat_id, name: r.name, qty: numOrNull(r.qty), unit: s(r.unit) };
  }
  async putExtra(x: Extra): Promise<void> {
    await this.q(`INSERT INTO fleet_daily_extras (id, date, boat_id, name, qty, unit) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, qty = EXCLUDED.qty, unit = EXCLUDED.unit`, [x.id, x.date, x.boat_id, x.name, x.qty, x.unit]);
  }
  async deleteExtra(id: string): Promise<void> { await this.q('DELETE FROM fleet_daily_extras WHERE id = $1', [id]); }
  async request(id: string): Promise<DailyRequest | undefined> {
    const r = (await this.q(`SELECT id, date::text AS date, pier, name, pax, fuel, price, engine_hours, water_open, water_close, issues FROM fleet_daily_requests WHERE id = $1`, [id])).rows[0];
    return r && requestRow(r);
  }
  async putRequest(x: DailyRequest): Promise<void> {
    await this.q(`INSERT INTO fleet_daily_requests (id, date, pier, name, pax, fuel, price, engine_hours, water_open, water_close, issues) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, pax = EXCLUDED.pax, fuel = EXCLUDED.fuel, price = EXCLUDED.price, engine_hours = EXCLUDED.engine_hours,
        water_open = EXCLUDED.water_open, water_close = EXCLUDED.water_close, issues = EXCLUDED.issues`,
    [x.id, x.date, x.pier, x.name, x.pax, x.fuel, x.price, x.engine_hours, x.water_open, x.water_close, JSON.stringify(x.issues)]);
  }
  async deleteRequest(id: string): Promise<void> { await this.q('DELETE FROM fleet_daily_requests WHERE id = $1', [id]); }
  async issueItems(): Promise<IssueItem[]> {
    return (await this.q('SELECT id, name, unit, pier, off FROM fleet_issue_items ORDER BY sort')).rows.map((r) => ({ id: r.id, name: r.name, unit: s(r.unit), pier: s(r.pier), off: r.off }));
  }
  async putIssueItem(i: IssueItem): Promise<void> {
    await this.q(`INSERT INTO fleet_issue_items (id, name, unit, pier, off) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, unit = EXCLUDED.unit, pier = EXCLUDED.pier, off = EXCLUDED.off`, [i.id, i.name, i.unit, i.pier, i.off]);
  }

  // ── Safety ──
  private async withInspections(rows: QueryResultRow[]): Promise<SafetyItem[]> {
    if (!rows.length) return [];
    const insp = (await this.q(`SELECT id, item_id, date::text AS date, inspector, result, findings, next_due::text AS next_due, created_at, created_by
      FROM fleet_safety_inspections WHERE item_id = ANY($1) ORDER BY created_at, id`, [rows.map((r) => r.id)])).rows;
    return rows.map((r) => ({
      id: r.id, boat_id: r.boat_id, category: r.category, name: r.name, brand: s(r.brand), model: s(r.model), serial: s(r.serial), qty: num(r.qty),
      install_date: s(r.install_date), expiry_date: s(r.expiry_date), next_pm: s(r.next_pm), last_inspect: s(r.last_inspect), status: r.status, location: s(r.location),
      note: s(r.note), created_at: iso(r.created_at), updated_at: iso(r.updated_at),
      inspections: insp.filter((i) => i.item_id === r.id).map((i) => ({
        id: i.id, date: i.date, inspector: s(i.inspector), result: i.result, findings: s(i.findings), next_due: s(i.next_due), created_at: iso(i.created_at), created_by: s(i.created_by),
      })),
    }));
  }
  async safetyItems(): Promise<SafetyItem[]> { return this.withInspections((await this.q(SAFETY_SELECT)).rows); }
  async safetyItem(id: string): Promise<SafetyItem | undefined> { return (await this.withInspections((await this.q(`${SAFETY_SELECT} WHERE id = $1`, [id])).rows))[0]; }
  async putSafety(i: SafetyItem): Promise<void> {
    await this.q(`INSERT INTO fleet_safety_items (id, boat_id, category, name, brand, model, serial, qty, install_date, expiry_date, next_pm, last_inspect, status, location, note,
      created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      ON CONFLICT (id) DO UPDATE SET boat_id = EXCLUDED.boat_id, category = EXCLUDED.category, name = EXCLUDED.name, brand = EXCLUDED.brand, model = EXCLUDED.model,
        serial = EXCLUDED.serial, qty = EXCLUDED.qty, install_date = EXCLUDED.install_date, expiry_date = EXCLUDED.expiry_date, next_pm = EXCLUDED.next_pm,
        last_inspect = EXCLUDED.last_inspect, status = EXCLUDED.status, location = EXCLUDED.location, note = EXCLUDED.note, updated_at = EXCLUDED.updated_at`,
    [i.id, i.boat_id, i.category, i.name, i.brand, i.model, i.serial, i.qty, i.install_date, i.expiry_date, i.next_pm, i.last_inspect, i.status, i.location, i.note,
      i.created_at, i.updated_at]);
    await this.q('DELETE FROM fleet_safety_inspections WHERE item_id = $1', [i.id]);
    for (const x of i.inspections) {
      await this.q(`INSERT INTO fleet_safety_inspections (id, item_id, date, inspector, result, findings, next_due, created_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [x.id, i.id, x.date, x.inspector, x.result, x.findings, x.next_due, x.created_at, x.created_by]);
    }
  }
  async deleteSafety(id: string): Promise<void> { await this.q('DELETE FROM fleet_safety_items WHERE id = $1', [id]); }
  async safetyLog(id: string): Promise<SafetyLog[]> {
    return (await this.q('SELECT item_id, date::text AS date, type, "desc" FROM fleet_safety_log WHERE item_id = $1 ORDER BY id', [id])).rows
      .map((r) => ({ item_id: r.item_id, date: r.date, type: r.type, desc: r.desc }));
  }
  async addSafetyLog(rows: readonly SafetyLog[]): Promise<void> {
    for (const l of rows) await this.q('INSERT INTO fleet_safety_log (item_id, date, type, "desc") VALUES ($1,$2,$3,$4)', [l.item_id, l.date, l.type, l.desc]);
  }
}

const requestRow = (r: QueryResultRow): DailyRequest => ({
  id: r.id, date: r.date, pier: r.pier, name: r.name, pax: numOrNull(r.pax), fuel: numOrNull(r.fuel), price: numOrNull(r.price), engine_hours: numOrNull(r.engine_hours),
  water_open: numOrNull(r.water_open), water_close: numOrNull(r.water_close), issues: r.issues ?? {},
});
