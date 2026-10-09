/**
 * The pier office in PostgreSQL (migrations 170–171): `PierOfficeRepo` over the store's own
 * connection, so every call runs in the request's transaction. Rows in, rows out; the rules are in
 * `pier-cash.ts` and `pier-office.ts`. Dates are read as `::text` (CLAUDE.md), numerics with `Number`.
 */
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type { CashQuery, PierOfficeRepo } from './pier-office-store.js';
import { PARK_HEADS, type CashRow, type CashSettings, type LongtailCell, type ParkCell } from './pier-cash.js';
import type { AllLists, PierList, PierLists } from './pier-office.js';

type Db = () => Pool | PoolClient;
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const iso = (v: unknown): string => (v as Date).toISOString();
const isoOrNull = (v: unknown): string | null => (v ? (v as Date).toISOString() : null);
const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

const ROW_SELECT = `SELECT id, pier, cash_date::text AS date, kind, description, amount, time, source, created_at, created_by, deleted_at, deleted_by, delete_reason
  FROM pier_cash_rows`;
const cashRow = (r: QueryResultRow): CashRow => ({
  id: r.id, pier: r.pier, date: r.date, kind: r.kind, description: s(r.description), amount: Number(r.amount), time: s(r.time), source: r.source ?? null,
  created_at: iso(r.created_at), created_by: s(r.created_by), deleted_at: isoOrNull(r.deleted_at), deleted_by: s(r.deleted_by), delete_reason: s(r.delete_reason),
});
const LT_SELECT = `SELECT pier, cash_date::text AS date, boat_id, join_boats, charter_boats, amount, note, updated_at, updated_by FROM pier_cash_longtail`;
const ltRow = (r: QueryResultRow): LongtailCell => ({
  pier: r.pier, date: r.date, boat_id: r.boat_id, join_boats: numOrNull(r.join_boats), charter_boats: numOrNull(r.charter_boats), amount: numOrNull(r.amount),
  note: s(r.note), updated_at: iso(r.updated_at), updated_by: s(r.updated_by),
});
const PK_SELECT = `SELECT pier, cash_date::text AS date, boat_id, ${PARK_HEADS.join(', ')}, amount, dock, filled_from, updated_at, updated_by FROM pier_cash_park`;
const pkRow = (r: QueryResultRow): ParkCell => ({
  pier: r.pier, date: r.date, boat_id: r.boat_id, ...Object.fromEntries(PARK_HEADS.map((k) => [k, numOrNull(r[k])])) as Record<typeof PARK_HEADS[number], number | null>,
  amount: numOrNull(r.amount), dock: numOrNull(r.dock), filled_from: r.filled_from ?? null, updated_at: iso(r.updated_at), updated_by: s(r.updated_by),
});
const range = (q: CashQuery): { where: string; params: unknown[] } => {
  const params: unknown[] = [q.pier];
  let where = 'WHERE pier = $1';
  if (q.from) { params.push(q.from); where += ` AND cash_date >= $${params.length}`; }
  if (q.to) { params.push(q.to); where += ` AND cash_date <= $${params.length}`; }
  return { where, params };
};

/** Each list's table and columns; the API's field names are the column names. */
const TABLES: { [K in PierList]: { table: string; columns: (keyof PierLists[K] & string)[]; numeric?: string[] } } = {
  'item-kinds': { table: 'pier_item_kinds', columns: ['id', 'name', 'name_en', 'unit', 'color', 'sort', 'active'] },
  items: { table: 'pier_items', columns: ['id', 'pier', 'kind_id', 'label', 'total', 'active', 'note'] },
  'attendance-codes': { table: 'pier_attendance_codes', columns: ['id', 'code', 'label', 'color', 'bg', 'kind', 'sort', 'active'] },
  sections: { table: 'pier_sections', columns: ['id', 'pier', 'name', 'sort'] },
  staff: { table: 'pier_staff', columns: ['id', 'pier', 'nick', 'name', 'role', 'phone', 'active', 'default_code', 'section_id', 'note', 'sort'] },
  'license-types': { table: 'pier_license_types', columns: ['id', 'side', 'short', 'formal', 'per_boat', 'active'] },
  'license-classes': { table: 'pier_license_classes', columns: ['id', 'type_id', 'name', 'max_gt', 'max_bhp', 'sort'], numeric: ['max_gt', 'max_bhp'] },
};

export class PostgresPierOfficeRepo implements PierOfficeRepo {
  constructor(private readonly db: Db) {}
  private q(sql: string, params: unknown[] = []) { return this.db().query(sql, params); }

  async cashRows(q: CashQuery): Promise<CashRow[]> {
    const r = range(q);
    return (await this.q(`${ROW_SELECT} ${r.where}`, r.params)).rows.map(cashRow);
  }
  async cashRow(id: string): Promise<CashRow | undefined> { const r = (await this.q(`${ROW_SELECT} WHERE id = $1`, [id])).rows[0]; return r && cashRow(r); }
  async putCashRow(row: CashRow): Promise<void> {
    await this.q(`INSERT INTO pier_cash_rows (id, pier, cash_date, kind, description, amount, time, source, created_at, created_by, deleted_at, deleted_by, delete_reason)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (id) DO UPDATE SET description = EXCLUDED.description, deleted_at = EXCLUDED.deleted_at, deleted_by = EXCLUDED.deleted_by, delete_reason = EXCLUDED.delete_reason`,
    [row.id, row.pier, row.date, row.kind, row.description, row.amount, row.time, row.source, row.created_at, row.created_by, row.deleted_at, row.deleted_by, row.delete_reason]);
  }
  async longtail(q: CashQuery): Promise<LongtailCell[]> { const r = range(q); return (await this.q(`${LT_SELECT} ${r.where}`, r.params)).rows.map(ltRow); }
  async putLongtail(c: LongtailCell): Promise<void> {
    await this.q(`INSERT INTO pier_cash_longtail (pier, cash_date, boat_id, join_boats, charter_boats, amount, note, updated_at, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (pier, cash_date, boat_id) DO UPDATE SET join_boats = EXCLUDED.join_boats, charter_boats = EXCLUDED.charter_boats, amount = EXCLUDED.amount,
      note = EXCLUDED.note, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
    [c.pier, c.date, c.boat_id, c.join_boats, c.charter_boats, c.amount, c.note, c.updated_at, c.updated_by]);
  }
  async deleteLongtail(pier: string, date: string, boatId: string): Promise<void> {
    await this.q('DELETE FROM pier_cash_longtail WHERE pier = $1 AND cash_date = $2 AND boat_id = $3', [pier, date, boatId]);
  }
  async park(q: CashQuery): Promise<ParkCell[]> { const r = range(q); return (await this.q(`${PK_SELECT} ${r.where}`, r.params)).rows.map(pkRow); }
  async putPark(c: ParkCell): Promise<void> {
    const cols = ['pier', 'cash_date', 'boat_id', ...PARK_HEADS, 'amount', 'dock', 'filled_from', 'updated_at', 'updated_by'];
    const values = [c.pier, c.date, c.boat_id, ...PARK_HEADS.map((k) => c[k]), c.amount, c.dock, c.filled_from, c.updated_at, c.updated_by];
    await this.q(`INSERT INTO pier_cash_park (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
      ON CONFLICT (pier, cash_date, boat_id) DO UPDATE SET ${cols.slice(3).map((k) => `${k} = EXCLUDED.${k}`).join(', ')}`, values);
  }
  async deletePark(pier: string, date: string, boatId: string): Promise<void> {
    await this.q('DELETE FROM pier_cash_park WHERE pier = $1 AND cash_date = $2 AND boat_id = $3', [pier, date, boatId]);
  }
  async cashSettings(): Promise<CashSettings> {
    const r = (await this.q('SELECT company_name, updated_at, updated_by FROM pier_cash_settings WHERE id')).rows[0];
    return r ? { company_name: s(r.company_name), updated_at: isoOrNull(r.updated_at), updated_by: s(r.updated_by) } : { company_name: null, updated_at: null, updated_by: null };
  }
  async putCashSettings(x: CashSettings): Promise<void> {
    await this.q(`INSERT INTO pier_cash_settings (id, company_name, updated_at, updated_by) VALUES (true, $1, $2, $3)
      ON CONFLICT (id) DO UPDATE SET company_name = EXCLUDED.company_name, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
    [x.company_name, x.updated_at, x.updated_by]);
  }

  async lists(): Promise<AllLists> {
    const out = {} as Record<PierList, unknown[]>;
    for (const [list, spec] of Object.entries(TABLES) as [PierList, { table: string; columns: string[]; numeric?: string[] }][]) {
      const rows = (await this.q(`SELECT ${spec.columns.join(', ')} FROM ${spec.table}`)).rows;
      out[list] = rows.map((r) => Object.fromEntries(spec.columns.map((c) => [c, spec.numeric?.includes(c) ? numOrNull(r[c]) : r[c] ?? null])));
    }
    return out as AllLists;
  }
  async putListRows<K extends PierList>(list: K, rows: readonly PierLists[K][]): Promise<void> {
    const { table, columns } = TABLES[list] as { table: string; columns: string[] };
    for (const row of rows) {
      await this.q(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})
        ON CONFLICT (id) DO UPDATE SET ${columns.slice(1).map((c) => `${c} = EXCLUDED.${c}`).join(', ')}`,
      columns.map((c) => (row as Record<string, unknown>)[c] ?? null));
    }
  }
  async deleteListRow(list: PierList, id: string): Promise<void> {
    await this.q(`DELETE FROM ${TABLES[list].table} WHERE id = $1`, [id]);
  }
}
