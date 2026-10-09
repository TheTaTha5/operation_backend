/**
 * Where the pier office keeps its rows (todo/pier-office-model.md; migrations 170–171): one interface,
 * two implementations, reached as `store.pierOfficeRepo` on either store. `MemoryPierOfficeRepo` is the
 * in-process one; `PostgresPierOfficeRepo` (pier-office-postgres.ts) runs inside the store's
 * transaction. The repositories only read and write rows: every decision is in `pier-cash.ts` and
 * `pier-office.ts`, and lists are sorted there, so the two behave identically.
 */
import type { CashRow, CashSettings, LongtailCell, ParkCell } from './pier-cash.js';
import { PIER_OFFICE_SEEDS, type AllLists, type PierList, type PierLists } from './pier-office.js';

type Maybe<T> = T | Promise<T>;
export type CashQuery = { pier: string; from?: string; to?: string };
export interface PierOfficeRepo {
  /** A pier's ledger rows (deleted ones too), dates inclusive. */
  cashRows(q: CashQuery): Maybe<CashRow[]>;
  cashRow(id: string): Maybe<CashRow | undefined>;
  putCashRow(row: CashRow): Maybe<void>;
  longtail(q: CashQuery): Maybe<LongtailCell[]>;
  putLongtail(cell: LongtailCell): Maybe<void>;
  deleteLongtail(pier: string, date: string, boatId: string): Maybe<void>;
  park(q: CashQuery): Maybe<ParkCell[]>;
  putPark(cell: ParkCell): Maybe<void>;
  deletePark(pier: string, date: string, boatId: string): Maybe<void>;
  cashSettings(): Maybe<CashSettings>;
  putCashSettings(s: CashSettings): Maybe<void>;

  lists(): Maybe<AllLists>;
  putListRows<K extends PierList>(list: K, rows: readonly PierLists[K][]): Maybe<void>;
  deleteListRow(list: PierList, id: string): Maybe<void>;
}

const inRange = (date: string, q: CashQuery): boolean => (!q.from || date >= q.from) && (!q.to || date <= q.to);
const cellKey = (pier: string, date: string, boatId: string): string => `${pier}|${date}|${boatId}`;
const copy = <T>(row: T): T => ({ ...row });

export class MemoryPierOfficeRepo implements PierOfficeRepo {
  private rows = new Map<string, CashRow>();
  private lt = new Map<string, LongtailCell>();
  private pk = new Map<string, ParkCell>();
  private settings: CashSettings = { company_name: null, updated_at: null, updated_by: null };
  private all: AllLists = {
    'item-kinds': PIER_OFFICE_SEEDS['item-kinds'].map(copy), items: [], 'attendance-codes': PIER_OFFICE_SEEDS['attendance-codes'].map(copy), sections: [], staff: [],
    'license-types': PIER_OFFICE_SEEDS['license-types'].map(copy), 'license-classes': PIER_OFFICE_SEEDS['license-classes'].map(copy),
  };

  cashRows(q: CashQuery): CashRow[] { return [...this.rows.values()].filter((r) => r.pier === q.pier && inRange(r.date, q)).map(copy); }
  cashRow(id: string): CashRow | undefined { const r = this.rows.get(id); return r && copy(r); }
  putCashRow(row: CashRow): void { this.rows.set(row.id, copy(row)); }
  longtail(q: CashQuery): LongtailCell[] { return [...this.lt.values()].filter((c) => c.pier === q.pier && inRange(c.date, q)).map(copy); }
  putLongtail(cell: LongtailCell): void { this.lt.set(cellKey(cell.pier, cell.date, cell.boat_id), copy(cell)); }
  deleteLongtail(pier: string, date: string, boatId: string): void { this.lt.delete(cellKey(pier, date, boatId)); }
  park(q: CashQuery): ParkCell[] { return [...this.pk.values()].filter((c) => c.pier === q.pier && inRange(c.date, q)).map(copy); }
  putPark(cell: ParkCell): void { this.pk.set(cellKey(cell.pier, cell.date, cell.boat_id), copy(cell)); }
  deletePark(pier: string, date: string, boatId: string): void { this.pk.delete(cellKey(pier, date, boatId)); }
  cashSettings(): CashSettings { return copy(this.settings); }
  putCashSettings(s: CashSettings): void { this.settings = copy(s); }

  lists(): AllLists {
    return Object.fromEntries(Object.entries(this.all).map(([k, rows]) => [k, (rows as object[]).map(copy)])) as AllLists;
  }
  putListRows<K extends PierList>(list: K, rows: readonly PierLists[K][]): void {
    const current = this.all[list] as PierLists[K][];
    for (const row of rows) {
      const at = current.findIndex((r) => r.id === row.id);
      if (at >= 0) current[at] = copy(row); else current.push(copy(row));
    }
  }
  deleteListRow(list: PierList, id: string): void {
    // As the schema's ON DELETE SET NULL: a deleted group leaves its people unassigned.
    if (list === 'sections') for (const s of this.all.staff) if (s.section_id === id) s.section_id = null;
    (this.all as Record<PierList, { id: string }[]>)[list] = this.all[list].filter((r) => r.id !== id);
  }
}
